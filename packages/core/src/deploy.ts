import { assetContentType, assetExtension } from "./asset-types.js";
import { CloudflareApiError, KV_PERMISSION_HINT, type AssetUpload, type CloudflareClient, type CloudflareDeployment, type CloudflareDnsRecord, type CloudflareDomain, type CloudflareVersionMetadata, type CloudflareZone } from "./cloudflare.js";
import { HistosPublishError, throwIfAborted } from "./errors.js";
import { assetHash, createManifest } from "./manifest.js";
import { safeBundlePath } from "./paths.js";
import { scanFiles } from "./scanner.js";
import type { BundleFile, Finding, FormsBuildResult } from "./types.js";

export const DEFAULT_CLOUDFLARE_MAX_FILES = 20_000;
export const PAID_CLOUDFLARE_MAX_FILES = 100_000;
export const CLOUDFLARE_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const CLOUDFLARE_MAX_UPLOAD_REQUEST_BYTES = 40 * 1024 * 1024;
export const CLOUDFLARE_WORKER_SOURCE = `export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const pathname = new URL(request.url).pathname;
    if (response.ok && (pathname === "/" || pathname === "/index.html")) {
      const headers = new Headers(response.headers);
      headers.delete("Content-Disposition");
      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  }
};\n`;

export type DeployPhase = "preflight" | "session" | "upload" | "version" | "deploy";
export interface DeployEvent {
  type: "deploy-progress";
  phase: DeployPhase;
  completed?: number;
  total?: number;
}

export interface DeployBundleOptions {
  client: CloudflareClient;
  accountId: string;
  script: string;
  files: readonly BundleFile[];
  findings?: readonly Finding[];
  forms?: FormsBuildResult;
  turnstileSecret?: string;
  /** KV archives the site declares (`VOTI` or `VOTI=voti-logo`): Publish finds or creates their namespaces and binds them. */
  kv?: readonly string[];
  message?: string;
  maxFiles?: number;
  signal?: AbortSignal;
  onEvent?: (event: DeployEvent) => void;
}

export interface DeployBundleResult {
  versionId: string;
  deployment: CloudflareDeployment;
  files: number;
  uploaded: number;
  findings: Finding[];
}

function emit(options: DeployBundleOptions, event: DeployEvent): void {
  try { options.onEvent?.(event); } catch { /* Progress listeners must not break a deploy. */ }
}

function publishableFiles(files: readonly BundleFile[]): BundleFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (file.path === "_headers" || file.path === "_redirects" || file.path === SITE_WORKER_PATH) return false;
    const encoded = `/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    if (seen.has(encoded)) throw new HistosPublishError(`Percorso duplicato nel bundle: ${file.path}`, "cloudflare-manifest", 2);
    seen.add(encoded);
    return true;
  });
}

function validateHeaders(content: string): void {
  const lines = content.split(/\r?\n/u);
  let rules = 0;
  for (const line of lines) {
    if (line.length > 2000) throw new HistosPublishError("_headers supera il limite Cloudflare di 2.000 caratteri per riga.", "cloudflare-limit", 3);
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(line)) rules += 1;
  }
  if (rules > 100) throw new HistosPublishError("_headers supera il limite Cloudflare di 100 regole.", "cloudflare-limit", 3);
}

function validateRedirects(content: string): void {
  let staticRules = 0;
  let dynamicRules = 0;
  for (const line of content.split(/\r?\n/u)) {
    if (line.length > 1000) throw new HistosPublishError("_redirects supera il limite Cloudflare di 1.000 caratteri per regola.", "cloudflare-limit", 3);
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const source = trimmed.split(/\s+/u)[0] ?? "";
    if (source.includes("*") || /:[A-Za-z][A-Za-z0-9_]*/u.test(source)) dynamicRules += 1;
    else staticRules += 1;
  }
  if (staticRules > 2000 || dynamicRules > 100 || staticRules + dynamicRules > 2100) {
    throw new HistosPublishError("_redirects supera i limiti Cloudflare: 2.000 regole statiche, 100 dinamiche, 2.100 totali.", "cloudflare-limit", 3);
  }
}

function decodeSpecialFile(file: BundleFile | undefined, name: string): string | undefined {
  if (!file) return undefined;
  const content = file.bytes;
  if (!content) throw new HistosPublishError(`Contenuto mancante per ${name}.`, "cloudflare-manifest", 2);
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content)) throw new HistosPublishError(`${name} deve essere un file UTF-8 valido.`, "cloudflare-config", 3);
  return text;
}

/** The forms code shared by Publish's own Worker and the wrapper around a site's own Worker: everything but the export. */
function formsHandlerSource(forms: Pick<FormsBuildResult, "restUrl" | "fluentFormIds">): string {
  const config = JSON.stringify({ restUrl: forms.restUrl, ids: forms.fluentFormIds });
  return `const FORM_CONFIG = ${config};
const MAX_BODY = 32768;
const MAX_FIELDS = 50;
const MAX_VALUE = 5000;

function json(status, code) {
  return Response.json({ status: code }, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

async function readLimited(stream, limit) {
  if (!stream) return null;
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } catch { return null; }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}

function validFieldName(name) {
  return /^[A-Za-z0-9_-]{1,64}(?:\\[[A-Za-z0-9_-]{0,64}\\]){0,5}$/.test(name);
}

function collectFields(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const entries = Object.entries(input);
  if (entries.length > MAX_FIELDS) return null;
  const fields = [];
  let totalValues = 0;
  for (const [name, raw] of entries) {
    if (!validFieldName(name)) return null;
    if (name === "cf-turnstile-response" || name.startsWith("xb_")) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0 || values.length > MAX_FIELDS || !values.every((value) => typeof value === "string" && value.length <= MAX_VALUE)) return null;
    totalValues += values.length;
    if (totalValues > MAX_FIELDS) return null;
    fields.push([name, values]);
  }
  return fields;
}

async function handleForm(request, env) {
  const url = new URL(request.url);
  if (request.method !== "POST") return json(405, "error");
  if (request.headers.get("Origin") !== url.origin) return json(403, "error");
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) return json(415, "error");
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_BODY) return json(413, "error");
  const bodyText = await readLimited(request.body, MAX_BODY);
  if (bodyText === null) return json(413, "error");
  let body;
  try { body = JSON.parse(bodyText); } catch { return json(400, "error"); }
  if (!body || typeof body !== "object" || typeof body.form !== "string" || !/^\\d{1,10}$/.test(body.form) || !FORM_CONFIG.ids.includes(Number(body.form))) return json(400, "error");
  if (typeof body.turnstileToken !== "string" || body.turnstileToken.length < 1 || body.turnstileToken.length > 2048) return json(422, "invalid");
  const collected = collectFields(body.fields);
  if (!collected) return json(422, "invalid");
  if (!env.TURNSTILE_SECRET) return json(503, "error");
  let challenge;
  try {
    const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: body.turnstileToken }),
      signal: AbortSignal.timeout(5000)
    });
    if (!verify.ok || verify.status >= 300) return json(422, "invalid");
    const challengeText = await readLimited(verify.body, 8192);
    if (challengeText === null) return json(422, "invalid");
    challenge = JSON.parse(challengeText);
  } catch { return json(422, "invalid"); }
  if (challenge?.success !== true || typeof challenge.hostname !== "string" || challenge.hostname.toLowerCase() !== url.hostname.toLowerCase() || challenge.action !== "histos_form") return json(422, "invalid");
  const wordpressBase = new URL(FORM_CONFIG.restUrl);
  wordpressBase.pathname = wordpressBase.pathname.replace(/wp-json\\/?$/i, "");
  if (!wordpressBase.pathname.endsWith("/")) wordpressBase.pathname += "/";
  const upstreamUrl = new URL("wp-admin/admin-ajax.php", wordpressBase);
  const serializedFields = new URLSearchParams();
  for (const [name, values] of collected) {
    if (name === "cf-turnstile-response" || name.startsWith("xb_")) continue;
    for (const value of values) serializedFields.append(name, value);
  }
  const formData = new URLSearchParams({ action: "fluentform_submit", form_id: body.form, data: serializedFields.toString() });
  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method: "POST",
      redirect: "manual",
      headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: formData,
      signal: AbortSignal.timeout(8000)
    });
  } catch { return json(502, "error"); }
  if (upstream.status >= 300 || !upstream.ok) return upstream.status >= 400 && upstream.status < 500 ? json(422, "invalid") : json(502, "error");
  if (!(upstream.headers.get("Content-Type") || "").toLowerCase().includes("json")) return json(502, "error");
  const responseText = await readLimited(upstream.body, 8192);
  if (responseText === null) return json(502, "error");
  let result;
  try { result = JSON.parse(responseText); } catch { return json(502, "error"); }
  if (result?.success === true) return json(200, "sent");
  if (result?.success === false) return json(422, "invalid");
  return json(502, "error");
}
`;
}

export function createFormsWorkerSource(forms: Pick<FormsBuildResult, "restUrl" | "fluentFormIds">): string {
  return `${formsHandlerSource(forms)}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/xb-form") return handleForm(request, env);
    const response = await env.ASSETS.fetch(request);
    const pathname = new URL(request.url).pathname;
    if (response.ok && (pathname === "/" || pathname === "/index.html")) {
      const headers = new Headers(response.headers);
      headers.delete("Content-Disposition");
      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  }
};\n`;
}

/**
 * A site's own server code: `_worker.js` in the root of the site, the same convention as Cloudflare Pages. It is an ES
 * module with `export default { fetch(request, env, ctx) }`, in one file. It is never published as a public file:
 * Publish uploads it as a module of the Worker, next to its own `worker.js`, which imports it.
 */
export const SITE_WORKER_PATH = "_worker.js";
/** Cloudflare's Free plan allows 3 MB per Worker after compression; one uncompressed file within that is always safe. */
export const SITE_WORKER_MAX_BYTES = 3 * 1024 * 1024;
const KV_BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const KV_NAMESPACE_TITLE = /^[A-Za-z0-9_.-]{1,200}$/u;
const RESERVED_BINDING_NAMES = new Set(["ASSETS", "TURNSTILE_SECRET"]);
/** The title of the KV namespace Publish creates for a binding: one per Worker and name, found again by its title. */
export function kvNamespaceTitle(script: string, binding: string): string {
  return `${script}-${binding}`;
}

/**
 * One KV archive a site declares: `VOTI` (Publish's own namespace `<worker>-VOTI`) or `VOTI=voti-logo` (the namespace
 * with that title, an archive the account already has, created if missing).
 */
export interface KvDeclaration {
  binding: string;
  title?: string;
}

export function parseKvDeclaration(value: string): KvDeclaration {
  const text = value.trim();
  const [binding = "", title, ...rest] = text.split("=").map((part) => part.trim());
  if (!KV_BINDING_NAME.test(binding) || rest.length > 0 || (title !== undefined && !KV_NAMESPACE_TITLE.test(title))) {
    throw new HistosPublishError(`«${value}» non è un archivio KV valido: scrivi il nome usato nel codice (lettere, numeri e trattino basso, per esempio VOTI), oppure NOME=titolo per usare un archivio che esiste già (per esempio VOTI=voti-logo).`, "cloudflare-kv-invalid", 2);
  }
  if (RESERVED_BINDING_NAMES.has(binding.toUpperCase())) throw new HistosPublishError(`${binding} è un nome riservato da Histeon Publish: scegline un altro per l’archivio KV.`, "cloudflare-kv-invalid", 2);
  return title === undefined ? { binding } : { binding, title };
}

/** Checks the KV archives a site declares; returns them normalized (`NOME` or `NOME=titolo`), one per name. */
export function validateKvBindingNames(values: readonly string[]): string[] {
  const byBinding = new Map<string, string>();
  for (const value of values) {
    const declaration = parseKvDeclaration(value);
    const normalized = declaration.title === undefined ? declaration.binding : `${declaration.binding}=${declaration.title}`;
    const previous = byBinding.get(declaration.binding);
    if (previous !== undefined && previous !== normalized) throw new HistosPublishError(`L’archivio KV ${declaration.binding} è dichiarato due volte in modi diversi.`, "cloudflare-kv-invalid", 2);
    byBinding.set(declaration.binding, normalized);
  }
  if (byBinding.size > 20) throw new HistosPublishError("Un sito può collegare al massimo 20 archivi KV.", "cloudflare-kv-invalid", 2);
  return [...byBinding.values()];
}

/** KV methods: `env.NOME.get(` and the like make NOME a KV archive the code reads or writes. */
const KV_METHOD_USE = /\benv\s*(?:\?\.|\.)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\?\.|\.)\s*(?:get|put|list|delete|getWithMetadata)\s*\(/gu;
/** Methods of the other bindings with get/put/list/delete (R2, Durable Objects, D1, queues): such a name is not KV. */
const NOT_KV_METHOD_USE = /\benv\s*(?:\?\.|\.)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\?\.|\.)\s*(?:head|createMultipartUpload|resumeMultipartUpload|idFromName|idFromString|newUniqueId|getByName|jurisdiction|prepare|batch|exec|dump|send|sendBatch)\s*\(/gu;

/**
 * The KV archives a site's Worker code uses, read from the code itself: every `env.NOME.get/put/list/delete/
 * getWithMetadata(` (also `env?.NOME`, with spaces). Names that the code also calls with R2, Durable Object, D1 or
 * queue methods are left out, as are the names Publish reserves. Comments are read like code: a name that only
 * appears in a comment would still be bound, which costs nothing.
 */
export function kvBindingsInWorker(source: string): string[] {
  const notKv = new Set([...source.matchAll(NOT_KV_METHOD_USE)].map((match) => match[1] ?? ""));
  const names = new Set<string>();
  for (const match of source.matchAll(KV_METHOD_USE)) {
    const name = match[1] ?? "";
    if (!KV_BINDING_NAME.test(name) || RESERVED_BINDING_NAMES.has(name.toUpperCase()) || notKv.has(name)) continue;
    names.add(name);
  }
  return [...names].sort();
}

/**
 * The KV archives a publication binds: those the site declares, then those its Worker code uses and the site does
 * not declare (each on Publish's own `<worker>-NOME`). A declaration wins, so `VOTI=voti-logo` keeps its archive.
 */
export function kvBindingsForDeploy(declared: readonly string[], siteWorker?: string): string[] {
  const names = validateKvBindingNames(declared);
  if (siteWorker === undefined) return names;
  const bound = new Set(names.map((value) => parseKvDeclaration(value).binding));
  return validateKvBindingNames([...names, ...kvBindingsInWorker(siteWorker).filter((name) => !bound.has(name))]);
}

/**
 * The declaration Publish writes in a site's settings for a KV name found in its Worker code, `NOME=titolo`:
 * Publish's own `<worker>-NOME` when the account has it; otherwise the one archive whose title is the name or starts
 * with it and a dash (`VOTI` → `voti-logo`); otherwise `<worker>-NOME`, created at the first publication. Without a
 * Worker name it is just `NOME`.
 */
export function kvDeclarationForFound(binding: string, script: string | undefined, namespaces: ReadonlyArray<{ title: string }>): string {
  if (!script) return binding;
  const own = kvNamespaceTitle(script, binding);
  if (namespaces.some((namespace) => namespace.title === own)) return `${binding}=${own}`;
  const lower = binding.toLowerCase();
  const alike = namespaces.filter((namespace) => {
    const title = namespace.title.toLowerCase();
    return title === lower || title.startsWith(`${lower}-`) || title.startsWith(`${lower}_`);
  });
  const only = alike.length === 1 ? alike[0] : undefined;
  return only && KV_NAMESPACE_TITLE.test(only.title) ? `${binding}=${only.title}` : `${binding}=${own}`;
}

/**
 * A site's KV declarations after its Worker code was read: the declared ones as they are, then one for every name the
 * code uses and the site does not declare yet (`kvDeclarationForFound()`). Names typed by hand are never changed.
 */
export function addFoundKvDeclarations(declared: readonly string[], found: readonly string[], script: string | undefined, namespaces: ReadonlyArray<{ title: string }>): { kv: string[]; added: string[] } {
  const current = validateKvBindingNames(declared);
  const bound = new Set(current.map((value) => parseKvDeclaration(value).binding));
  const added = found.filter((name) => !bound.has(name)).map((name) => kvDeclarationForFound(name, script, namespaces));
  return { kv: added.length ? validateKvBindingNames([...current, ...added]) : current, added };
}

/** Reads and checks a site's own Worker code; returns it as text. */
export function validateSiteWorker(bytes: Buffer | Uint8Array, name = SITE_WORKER_PATH): string {
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength === 0) throw new HistosPublishError(`${name} è vuoto: il codice del Worker deve contenere export default { fetch }.`, "site-worker-invalid", 2);
  if (buffer.byteLength > SITE_WORKER_MAX_BYTES) throw new HistosPublishError(`${name} supera 3 MiB, il limite di un Worker Cloudflare del piano gratuito.`, "site-worker-invalid", 3);
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) throw new HistosPublishError(`${name} deve essere un file di testo UTF-8.`, "site-worker-invalid", 2);
  if (!/\bexport\s+default\b/u.test(text)) {
    throw new HistosPublishError(`${name} non è un modulo Worker: deve contenere export default { async fetch(request, env, ctx) { … } }.`, "site-worker-invalid", 2);
  }
  if (/(?:\bfrom\s*|\bimport\s*\(?\s*)["']\.{1,2}\//u.test(text)) {
    throw new HistosPublishError(`${name} importa altri file: il codice del Worker deve stare in un solo file.`, "site-worker-invalid", 2);
  }
  return text;
}

/**
 * Publish's main module when the site brings its own Worker. Every request reaches the site's code first
 * (`run_worker_first: true`); what it answers with a Response is the answer. When it returns nothing (undefined or
 * null) the request goes on to the site's static files, as it does when the code itself calls
 * `env.ASSETS.fetch(request)`. Fluent Forms, when the site has them, keep `/xb-form` before the site's code.
 */
export function createSiteWorkerWrapperSource(forms?: Pick<FormsBuildResult, "restUrl" | "fluentFormIds">): string {
  return `import * as site from "./${SITE_WORKER_PATH}";
${forms ? formsHandlerSource(forms) : ""}
const handler = site.default;

async function assetResponse(env, input, init) {
  const response = await env.ASSETS.fetch(input, init);
  const target = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const pathname = new URL(target, "https://assets.invalid").pathname;
  if (response.ok && (pathname === "/" || pathname === "/index.html")) {
    const headers = new Headers(response.headers);
    headers.delete("Content-Disposition");
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return response;
}

const worker = {
  async fetch(request, env, ctx) {
${forms ? '    if (new URL(request.url).pathname === "/xb-form") return handleForm(request, env);\n' : ""}    if (handler && typeof handler.fetch === "function") {
      const siteEnv = Object.assign({}, env, { ASSETS: { fetch: (input, init) => assetResponse(env, input, init) } });
      const response = await handler.fetch(request, siteEnv, ctx);
      if (response instanceof Response) return response;
      if (response !== undefined && response !== null) throw new TypeError("Il codice del sito deve restituire una Response oppure niente.");
    }
    return assetResponse(env, request);
  }
};
if (handler && typeof handler.scheduled === "function") worker.scheduled = (controller, env, ctx) => handler.scheduled(controller, env, ctx);
export default worker;
`;
}

function preflight(options: Pick<DeployBundleOptions, "files" | "findings" | "maxFiles" | "signal">): { files: BundleFile[]; findings: Finding[]; headers?: string; redirects?: string; siteWorker?: string } {
  throwIfAborted(options.signal);
  if (options.files.length === 0) throw new HistosPublishError("Il bundle non contiene file pubblicabili.", "cloudflare-empty-bundle", 3);
  const maxFiles = options.maxFiles ?? DEFAULT_CLOUDFLARE_MAX_FILES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > PAID_CLOUDFLARE_MAX_FILES) {
    throw new HistosPublishError("Il limite di file Cloudflare deve essere tra 1 e 100.000.", "cloudflare-config", 2);
  }
  if (options.files.length > maxFiles) {
    throw new HistosPublishError(`Il bundle contiene ${options.files.length} file, oltre il limite configurato di ${maxFiles}.`, "cloudflare-limit", 3);
  }
  for (const file of options.files) {
    if (!safeBundlePath(`/${file.path}`)) throw new HistosPublishError(`Percorso non sicuro nel bundle: ${file.path}`, "cloudflare-manifest", 3);
    if (!file.bytes) throw new HistosPublishError(`Contenuto mancante per ${file.path}.`, "cloudflare-manifest", 3);
    if (file.bytes.byteLength > CLOUDFLARE_MAX_FILE_BYTES) throw new HistosPublishError(`${file.path} supera il limite Cloudflare di 25 MiB per file.`, "cloudflare-limit", 3);
  }
  if (!options.files.some((file) => file.path === "index.html" && (file.bytes?.byteLength ?? 0) > 0)) {
    throw new HistosPublishError("Il bundle non contiene index.html nella cartella principale. Cloudflare non avrebbe una home da mostrare al dominio.", "cloudflare-home-missing", 3);
  }
  const headers = decodeSpecialFile(options.files.find((file) => file.path === "_headers"), "_headers");
  const redirects = decodeSpecialFile(options.files.find((file) => file.path === "_redirects"), "_redirects");
  if (headers !== undefined) validateHeaders(headers);
  if (redirects !== undefined) validateRedirects(redirects);
  const workerFile = options.files.find((file) => file.path === SITE_WORKER_PATH);
  const siteWorker = workerFile ? validateSiteWorker(workerFile.bytes ?? Buffer.alloc(0)) : undefined;
  const findings = [...(options.findings ?? []), ...scanFiles(options.files.map((file) => ({
    path: file.path,
    size: file.bytes?.byteLength ?? 0,
    contents: file.bytes ?? Buffer.alloc(0),
  })))];
  const blocked = findings.filter((finding) => finding.severity === "block");
  if (blocked.length > 0) {
    const rules = [...new Set(blocked.slice(0, 5).map((finding) => `${finding.code} (${finding.file})`))];
    throw new HistosPublishError(`La scansione ha trovato contenuti bloccanti: ${rules.join(", ")}.`, "scan-blocked", 3);
  }
  const regularFiles = publishableFiles(options.files);
  if (regularFiles.length === 0) throw new HistosPublishError("_headers e _redirects non sono sufficienti: manca almeno un file statico.", "cloudflare-empty-bundle", 3);
  return {
    files: regularFiles,
    findings,
    ...(headers === undefined ? {} : { headers }),
    ...(redirects === undefined ? {} : { redirects }),
    ...(siteWorker === undefined ? {} : { siteWorker }),
  };
}

function makeMetadata(jwt: string, message: string, special: { headers?: string; redirects?: string; siteWorker?: string }, forms?: FormsBuildResult, turnstileSecret?: string, kv: ReadonlyArray<{ name: string; namespaceId: string }> = []): CloudflareVersionMetadata {
  const enabledForms = forms?.enabled === true && forms.fluentFormIds.length > 0;
  const formsSecret = enabledForms ? turnstileSecret : undefined;
  if (enabledForms && (!formsSecret || formsSecret.length > 4096 || /[\r\n\0]/u.test(formsSecret))) {
    throw new HistosPublishError("Configura la chiave segreta Turnstile nel portachiavi locale prima di pubblicare i moduli.", "forms-secret-missing", 2);
  }
  if (enabledForms) {
    let restUrl: URL;
    try { restUrl = new URL(forms.restUrl); }
    catch { throw new HistosPublishError("L’URL REST WordPress salvato nella build non è valido.", "forms-config-invalid", 2); }
    if (restUrl.protocol !== "https:" || !restUrl.pathname.endsWith("/wp-json/")) {
      throw new HistosPublishError("L’URL REST WordPress salvato nella build non è valido.", "forms-config-invalid", 2);
    }
  }
  const workerFirstRoutes = ["/", "/index.html", ...(enabledForms ? ["/xb-form"] : [])];
  const assets: CloudflareVersionMetadata["assets"] = {
    jwt,
    config: {
      html_handling: "auto-trailing-slash",
      not_found_handling: "404-page",
      // A site's own Worker sees every request; without it only the home page (and the forms) reach Publish's Worker.
      run_worker_first: special.siteWorker === undefined ? workerFirstRoutes : true,
      ...(special.headers === undefined ? {} : { _headers: special.headers }),
      ...(special.redirects === undefined ? {} : { _redirects: special.redirects }),
    },
  };
  return {
    main_module: "worker.js",
    compatibility_date: "2026-10-21",
    assets,
    bindings: [
      { type: "assets", name: "ASSETS" },
      ...(enabledForms && formsSecret ? [{ type: "secret_text" as const, name: "TURNSTILE_SECRET", text: formsSecret }] : []),
      ...kv.map((binding) => ({ type: "kv_namespace" as const, name: binding.name, namespace_id: binding.namespaceId })),
    ],
    // Secrets and KV namespaces added in the Cloudflare dashboard survive every publication.
    keep_bindings: ["secret_text", "kv_namespace"],
    annotations: { "workers/message": truncateUtf8(message || "Histeon Publish deploy", 1000) },
  };
}

function truncateUtf8(value: string, maximum: number): string {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maximum) break;
    result += character;
  }
  return result;
}

export function planCloudflareManifest(files: readonly BundleFile[], maxFiles = DEFAULT_CLOUDFLARE_MAX_FILES): Record<string, { hash: string; size: number }> {
  const prepared = preflight({ files, maxFiles });
  return createManifest(prepared.files);
}

export async function deployBundle(options: DeployBundleOptions): Promise<DeployBundleResult> {
  const prepared = preflight(options);
  const forms = options.forms?.enabled && options.forms.fluentFormIds.length > 0 ? options.forms : undefined;
  if (forms && (!options.turnstileSecret || options.turnstileSecret.length > 4096 || /[\r\n\0]/u.test(options.turnstileSecret))) {
    throw new HistosPublishError("Configura la chiave segreta Turnstile nel portachiavi locale prima di pubblicare i moduli.", "forms-secret-missing", 2);
  }
  if (forms) {
    const secret = options.turnstileSecret;
    if (secret) options.client.registerSecret(secret);
  }
  // Declared archives first, then those the site's Worker code reads or writes (env.NOME.get/put/…).
  const kvNames = kvBindingsForDeploy(options.kv ?? [], prepared.siteWorker);
  emit(options, { type: "deploy-progress", phase: "preflight", completed: prepared.files.length, total: prepared.files.length });
  const manifest = createManifest(prepared.files);
  const byHash = new Map<string, AssetUpload>();
  for (const file of prepared.files) {
    const contents = file.bytes;
    if (!contents) continue;
    const contentType = assetContentType(file.path);
    byHash.set(assetHash(contents, assetExtension(file.path), contentType), { bytes: contents, contentType });
  }

  throwIfAborted(options.signal);
  // Before any upload: a token without the KV permission stops here, with nothing half done.
  const kv: Array<{ name: string; namespaceId: string }> = [];
  const declared = new Set(validateKvBindingNames(options.kv ?? []).map((value) => parseKvDeclaration(value).binding));
  for (const value of kvNames) {
    const declaration = parseKvDeclaration(value);
    const title = declaration.title ?? kvNamespaceTitle(options.script, declaration.binding);
    let namespace: { id: string };
    try {
      namespace = await options.client.ensureKvNamespace(options.accountId, title, options.signal);
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || (error.status !== 401 && error.status !== 403)) throw error;
      // Which archive, and why Publish wants it: the code uses it, or the site declares it.
      const why = declared.has(declaration.binding)
        ? `dichiarato nelle impostazioni del sito (si può anche togliere da lì)`
        : `usato dal codice del Worker (env.${declaration.binding})`;
      throw new CloudflareApiError(`Non posso collegare l’archivio KV ${declaration.binding} («${title}»), ${why}: il token Cloudflare non ha il permesso sugli archivi KV (Cloudflare ha risposto ${error.status}). ${KV_PERMISSION_HINT} Non è stato caricato nulla.`, error.status);
    }
    kv.push({ name: declaration.binding, namespaceId: namespace.id });
  }
  emit(options, { type: "deploy-progress", phase: "session" });
  const session = await options.client.createAssetUploadSession(options.accountId, options.script, manifest, options.signal);
  let completionJwt = session.jwt;
  let uploaded = 0;
  const totalToUpload = session.buckets.reduce((sum, bucket) => sum + bucket.length, 0);
  emit(options, { type: "deploy-progress", phase: "upload", completed: 0, total: totalToUpload });

  for (const bucket of session.buckets) {
    let chunk = new Map<string, AssetUpload>();
    let encodedBytes = 0;
    const flush = async (): Promise<void> => {
      if (chunk.size === 0) return;
      const result = await options.client.uploadAssetBucket(options.accountId, session.jwt, chunk, options.signal);
      if (result) completionJwt = result;
      uploaded += chunk.size;
      emit(options, { type: "deploy-progress", phase: "upload", completed: uploaded, total: totalToUpload });
      chunk = new Map<string, AssetUpload>();
      encodedBytes = 0;
    };
    for (const hash of bucket) {
      const upload = byHash.get(hash);
      if (!upload) throw new HistosPublishError("Cloudflare ha richiesto un asset che non è presente nel bundle.", "cloudflare-upload-state", 4);
      const size = Buffer.byteLength(upload.bytes.toString("base64"), "utf8");
      if (chunk.size > 0 && encodedBytes + size > CLOUDFLARE_MAX_UPLOAD_REQUEST_BYTES) await flush();
      chunk.set(hash, upload);
      encodedBytes += size;
      if (encodedBytes >= CLOUDFLARE_MAX_UPLOAD_REQUEST_BYTES) await flush();
    }
    await flush();
  }

  throwIfAborted(options.signal);
  emit(options, { type: "deploy-progress", phase: "version" });
  const metadata = makeMetadata(completionJwt, options.message ?? "", prepared, forms, options.turnstileSecret, kv);
  const workerSource = prepared.siteWorker !== undefined
    ? createSiteWorkerWrapperSource(forms)
    : forms ? createFormsWorkerSource(forms) : CLOUDFLARE_WORKER_SOURCE;
  const modules = prepared.siteWorker === undefined ? [] : [{ name: SITE_WORKER_PATH, source: prepared.siteWorker }];
  const versionId = await options.client.uploadVersion(options.accountId, options.script, metadata, workerSource, options.signal, modules);
  throwIfAborted(options.signal);
  emit(options, { type: "deploy-progress", phase: "deploy" });
  const deployment = await options.client.deployVersion(options.accountId, options.script, versionId, options.message ?? "Histeon Publish deploy", options.signal);
  return { versionId, deployment, files: options.files.length, uploaded, findings: prepared.findings };
}

export async function rollbackVersion(options: {
  client: CloudflareClient;
  accountId: string;
  script: string;
  deploymentOrVersionId: string;
  message?: string;
  signal?: AbortSignal;
}): Promise<CloudflareDeployment> {
  const deployments = await options.client.listDeployments(options.accountId, options.script, options.signal);
  const matchingDeployment = deployments.find((deployment) => deployment.id === options.deploymentOrVersionId);
  const versionId = matchingDeployment?.versions.find((version) => version.percentage > 0)?.version_id
    ?? deployments.flatMap((deployment) => deployment.versions).find((version) => version.version_id === options.deploymentOrVersionId)?.version_id;
  if (!versionId) throw new CloudflareApiError("La versione non è presente nei deployment recenti e non può essere ripristinata.", 404);
  return options.client.deployVersion(
    options.accountId,
    options.script,
    versionId,
    options.message ?? `Ripristino ${versionId}`,
    options.signal,
  );
}

export interface CustomDomainPlan {
  hostname: string;
  hostnames: string[];
  zone: CloudflareZone;
  cnameConflicts: CloudflareDnsRecord[];
  workerConflicts: Array<{ hostname: string; service: string }>;
}

export interface ApprovedCnameRecord {
  id: string;
  name: string;
  content: string;
  proxied: boolean;
}

function normalizeDomainHostname(value: string): string {
  const hostname = value.toLowerCase().replace(/\.$/u, "");
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/u.test(hostname)) {
    throw new HistosPublishError("Inserisci un dominio valido, senza https://, porta o percorso.", "cloudflare-domain-invalid", 2);
  }
  return hostname;
}

async function domainZone(client: CloudflareClient, accountId: string, hostname: string, signal?: AbortSignal): Promise<CloudflareZone> {
  const zones = await client.listZones(accountId, signal).catch((error: unknown) => {
    if (error instanceof CloudflareApiError && error.status === 403) {
      throw new CloudflareApiError("Per trovare la zona serve il permesso Zone Read sull’account Cloudflare.", 403);
    }
    throw error;
  });
  const zone = zones
    .filter((candidate) => candidate.status === undefined || candidate.status === "active")
    .filter((candidate) => hostname === candidate.name || hostname.endsWith(`.${candidate.name}`))
    .sort((left, right) => right.name.length - left.name.length)[0];
  if (!zone) throw new CloudflareApiError("Non trovo una zona attiva di questo account che contenga il dominio.", 404);
  return zone;
}

export async function inspectCustomDomain(options: {
  client: CloudflareClient;
  accountId: string;
  script: string;
  hostname: string;
  includeWww?: boolean;
  signal?: AbortSignal;
}): Promise<CustomDomainPlan> {
  const enteredHostname = normalizeDomainHostname(options.hostname.trim());
  await options.client.verifyWorkerScript(options.accountId, options.script, options.signal);
  const zone = await domainZone(options.client, options.accountId, enteredHostname, options.signal);
  const isApexPair = enteredHostname === zone.name || enteredHostname === `www.${zone.name}`;
  const hostnames = options.includeWww && isApexPair
    ? [zone.name, `www.${zone.name}`]
    : [enteredHostname];
  const [recordsByHost, workerDomains] = await Promise.all([
    Promise.all(hostnames.map((hostname) => options.client.listCnameRecords(zone.id, hostname, options.signal))),
    options.client.listWorkerDomains(options.accountId, hostnames, options.signal).catch((error: unknown) => {
      if (error instanceof CloudflareApiError && error.status === 403) {
        throw new CloudflareApiError("Cloudflare ha negato la lettura dei domini Worker. Questa API richiede Workers Scripts Read o Write con ambito account; per il collegamento automatico serve Write. La policy limitata al solo Worker non è bastata. Se non vuoi allargare i permessi, collega il dominio da Workers & Pages nel pannello Cloudflare.", 403);
      }
      throw error;
    }),
  ]);
  const cnameConflicts = recordsByHost.flat();
  const workerConflicts = workerDomains
    .filter((domain) => hostnames.includes(domain.hostname.toLowerCase()) && domain.service !== options.script)
    .map((domain) => ({ hostname: domain.hostname, service: domain.service }));
  return {
    hostname: options.includeWww && isApexPair ? zone.name : enteredHostname,
    hostnames,
    zone,
    cnameConflicts,
    workerConflicts,
  };
}

export async function attachCustomDomain(options: {
  client: CloudflareClient;
  accountId: string;
  script: string;
  hostname: string;
  includeWww?: boolean;
  replaceCnameRecords?: ApprovedCnameRecord[];
  signal?: AbortSignal;
}): Promise<{ hostname: string; hostnames: string[]; zone: CloudflareZone; replacedCnameRecords: Array<{ name: string; content: string; proxied?: boolean }> }> {
  const plan = await inspectCustomDomain(options);
  if (plan.workerConflicts.length > 0) {
    const conflict = plan.workerConflicts[0];
    throw new HistosPublishError(`${conflict?.hostname} è già collegato al Worker ${conflict?.service}. Scollegalo o scegli un altro hostname da Cloudflare.`, "cloudflare-domain-in-use", 4);
  }
  const actualConflicts = plan.cnameConflicts.map((record) => ({ id: record.id, name: record.name, content: record.content, proxied: record.proxied ?? false }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const approvedConflicts = [...(options.replaceCnameRecords ?? [])]
    .map((record) => ({ id: record.id, name: record.name, content: record.content, proxied: record.proxied }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (JSON.stringify(actualConflicts) !== JSON.stringify(approvedConflicts)) {
    throw new HistosPublishError("I record DNS sono cambiati dopo il controllo o non risultano approvati. Ricontrolla il dominio prima di confermare.", "cloudflare-domain-plan-stale", 2);
  }

  const workerDomains = await options.client.listWorkerDomains(options.accountId, plan.hostnames, options.signal);
  const alreadyAttached = new Set(workerDomains
    .filter((domain) => domain.service === options.script)
    .map((domain) => domain.hostname.toLowerCase()));
  const initialDomainIds = new Set(workerDomains.flatMap((domain) => domain.id ? [domain.id] : []));
  const deletedRecords: CloudflareDnsRecord[] = [];
  const newlyAttached: CloudflareDomain[] = [];
  try {
    for (const record of plan.cnameConflicts) {
      deletedRecords.push(record);
      await options.client.deleteDnsRecord(plan.zone.id, record.id, options.signal);
    }
    for (const hostname of plan.hostnames) {
      if (alreadyAttached.has(hostname)) continue;
      const attached = await options.client.attachDomain(options.accountId, hostname, options.script, plan.zone, options.signal);
      if (!attached.id) throw new CloudflareApiError("Cloudflare non ha restituito l’identificativo del dominio; non posso completare il collegamento in sicurezza.", 502);
      newlyAttached.push(attached);
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    const domainsToDetach = [...newlyAttached];
    const knownNewIds = new Set(newlyAttached.flatMap((domain) => domain.id ? [domain.id] : []));
    let domainsAfterFailure: CloudflareDomain[] | null = null;
    try { domainsAfterFailure = await options.client.listWorkerDomains(options.accountId, plan.hostnames); }
    catch { /* A confirmed attachment is also recorded below when its response arrived. */ }
    for (const domain of domainsAfterFailure ?? []) {
      if (domain.service === options.script && domain.id && !initialDomainIds.has(domain.id) && !knownNewIds.has(domain.id)) {
        domainsToDetach.push(domain);
        knownNewIds.add(domain.id);
      } else if (domain.service === options.script && !domain.id && !alreadyAttached.has(domain.hostname.toLowerCase())) {
        rollbackFailures.push(`scollegare ${domain.hostname}`);
      }
    }
    for (const attached of domainsToDetach.reverse()) {
      try {
        if (attached.id) await options.client.detachDomain(options.accountId, attached.id);
        else rollbackFailures.push(`scollegare ${attached.hostname}`);
      } catch {
        rollbackFailures.push(`scollegare ${attached.hostname}`);
      }
    }
    for (const record of deletedRecords.reverse()) {
      try { await options.client.restoreDnsRecord(plan.zone.id, record); }
      catch { rollbackFailures.push(`ripristinare ${record.name} → ${record.content}`); }
    }
    if (rollbackFailures.length > 0) {
      const original = error instanceof Error ? error.message : "errore Cloudflare";
      throw new HistosPublishError(`${original} Non è stato possibile completare il ripristino automatico: ${rollbackFailures.join(", ")}. Controlla la zona DNS e i domini Worker in Cloudflare.`, "cloudflare-domain-rollback", 6);
    }
    throw error;
  }
  return {
    hostname: plan.hostname,
    hostnames: plan.hostnames,
    zone: plan.zone,
    replacedCnameRecords: plan.cnameConflicts.map((record) => ({
      name: record.name,
      content: record.content,
      ...(record.proxied === undefined ? {} : { proxied: record.proxied }),
    })),
  };
}
