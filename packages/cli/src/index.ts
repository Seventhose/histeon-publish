#!/usr/bin/env node
import { existsSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  CloudflareClient,
  SystemKeyringSecretStore,
  attachCustomDomain,
  buildBundle,
  loadBundleFiles,
  createPlaywrightRenderSession,
  createSiteConfig,
  deployBundle,
  detectOnlineSite,
  detectSource,
  exportBundle,
  inspectCustomDomain,
  planCloudflareManifest,
  readCloudflareToken,
  rollbackVersion,
  turnstileSecretAccount,
  parseSiteConfig,
  readDirectorySource,
  readZipSource,
} from "@histos-publish/core";
import type { BuildEvent, BuildResult, RenderPage, SiteConfig, SourceSpec } from "@histos-publish/core";
import { FIGMA_TOKEN_ACCOUNT, FIGMA_TOKEN_ENV, FigmaApiError, figmaClient, figmaFileKey, HistosPublishError, readFigmaToken, validFigmaToken } from "@histos-publish/core";
import { readRefineSettings, refineAsk, refineReportText, refineStaticSite, REFINE_HAIKU_KEY_ACCOUNT, REFINE_LOCAL_KEY_ACCOUNT } from "@histos-publish/server";
import { buildProposalsPage, checkPrototype, HISTOS_PUBLISH_VERSION, checkPrototypeBuild, exportPrototypeXbsite, generateAgentKey, PROPOSALS_MAX, PROTOTYPE_AI_MANUAL, prototypeKit, startAgent, startLocalServer, type PrototypeCheckResult } from "@histos-publish/server";
import { DESIGN_FILE_MAX, designFileTokens, figmaApiTokens, histosCssDesignFile, importDesignTokens, readDesignTokens, tokenImportText, type DesignFileTokens, type TokenFile } from "@histos-publish/server";
import { designFilePages, designFilePrototype, type DesignPageList } from "@histos-publish/server";
import { launchVerifyBrowser, playwrightPageProbe } from "./prototype-browser.js";
import { prototypePreviewText, prototypeRefused, prototypeVerifyText, refusalDetails } from "./prototype-output.js";
import { prototypeCaptureText, runPrototypeCapture, type CaptureCommandOptions } from "./prototype-capture.js";

const program = new Command();

/** A run long enough to be a token: hidden from what the CLI prints, unless a prototype refusal names it as a slug. */
const SECRET_RUN = /\b(?:Bearer\s+)?[A-Za-z0-9_-]{28,}\b/gu;
/** The tokens of known services, by their prefix: hidden everywhere, slug-shaped or not (xoxb-…). */
const SERVICE_TOKEN = /(?:sk_live_|sk_test_|ghp_|xox[baprs]-)[A-Za-z0-9_-]+/gu;
const UUID_INSIDE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
/** A run that is one UUID and nothing else: the identity of a document, a template, a record (doc 23, voce 198; the same rule as identityRun of the server's http.ts). */
const UUID_ALONE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** What says that the run after it is a credential: «token: …», «password=…», «X-Api-Key …», «Authorization: …». */
const CREDENTIAL_BEFORE = /(?:token|secret|segreto|password|passwd|parola\s+d.ordine|key|chiave|authorization|auth|credential\w*|credenzial\w*|bearer|basic)["'\s:=]{0,4}$/iu;
/** What says that the run after it names a Cloudflare Worker: «Worker “…”», «Worker …» (doc 23, voce 229). */
const WORKER_BEFORE = /\bworker\s*["'“«`]?$/iu;
/** A Cloudflare Worker name: lowercase letters, digits and hyphens, at most 63 characters. */
const WORKER_NAME = /^[a-z0-9-]{1,63}$/u;

/**
 * A UUID alone is an identity, not a secret (voce 198: «…not portable in [segreto rimosso]: url» lost the document
 * the site named). No secret of Publish or of its sites has that shape (keys and tickets are base64url or hex, the link
 * secret is 32 bytes of base64url), but a third-party key may: one right after a word that names a credential, or
 * after «Bearer», stays hidden. A Worker name right after «Worker» is an identity too (voce 229: «Worker
 * [segreto rimosso] has no deployments»), when it reads as a slug: a random run after that word stays hidden.
 */
function identityRun(run: string, offset: number, text: string): boolean {
  const before = text.slice(Math.max(0, offset - 32), offset);
  if (WORKER_BEFORE.test(before)) return WORKER_NAME.test(run) && slugLike(run);
  return UUID_ALONE.test(run) && !CREDENTIAL_BEFORE.test(before);
}

/**
 * A long run that reads as a page slug or a template ref of a prototype ("storia-della-nostra-associazione"), by the
 * rule the connector follows for an agent (slugLike of the server's http.ts; test/clean-text.test.ts keeps the two
 * equal): lowercase words, digits and hyphens, no UUID, and no word that reads as random (a long run of hex digits, a
 * long word with several digits).
 */
function slugLike(run: string): boolean {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(run) || UUID_INSIDE.test(run)) return false;
  return !run.split("-").some((word) => (word.length >= 16 && /^[0-9a-f]+$/u.test(word)) || (word.length >= 12 && (word.match(/[0-9]/gu)?.length ?? 0) >= 3));
}

/**
 * Text the CLI prints, with what looks like a token hidden. A refused prototype (`keepSlugs`) keeps its slugs and
 * template refs, as the connector keeps them for an agent (E4): they come from the user's own file, and hidden they
 * read as a security problem and lose the place to fix. Every other text hides every long run, since a lowercase
 * passphrase is slug-shaped too; a service token goes in any text.
 */
export function cleanText(value: string, keepSlugs = false): string {
  return value
    .replace(SECRET_RUN, (run: string, offset: number, text: string) => (identityRun(run, offset, text) || (keepSlugs && slugLike(run)) ? run : "[segreto rimosso]"))
    .replace(SERVICE_TOKEN, "[segreto rimosso]");
}

/** The refusals whose problems the importer listed (the server's PrototypeInvalidError): only they keep their slugs. */
const listedRefusals = new WeakSet<Error>();

/**
 * A refused prototype as the prototype commands report it (prototypeRefused), remembered when the importer listed its
 * problems: an error that only has the refusal's code (a failure of the parser itself) hides its long runs, as on the
 * server.
 */
function prototypeRefusal(error: HistosPublishError): HistosPublishError {
  const refused = prototypeRefused(error);
  if (Array.isArray((error as { issues?: unknown }).issues)) listedRefusals.add(refused);
  return refused;
}

function jsonMode(): boolean {
  return program.optsWithGlobals().json === true;
}

function jsonStreamMode(): boolean {
  return program.optsWithGlobals().jsonStream === true;
}

function print(value: unknown): void {
  if (jsonMode()) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${typeof value === "string" ? cleanText(value) : JSON.stringify(value, null, 2)}\n`);
}

function printEvent(event: BuildEvent): void {
  if (jsonStreamMode()) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (jsonMode()) return;
  if (event.type === "start") process.stdout.write(`Avvio build (${event.sourceKind}).\n`);
  if (event.type === "progress") {
    const phase = event.phase === "pagefind" ? "ricerca Pagefind" : event.phase === "forms" ? "moduli Fluent Forms" : event.phase;
    process.stdout.write(`  ${phase}: ${event.completed}${event.total === undefined ? "" : `/${event.total}`}\n`);
  }
  if (event.type === "finding") process.stdout.write(`  ${event.finding.severity === "block" ? "BLOCCO" : "Avviso"}: ${event.finding.file} — ${event.finding.message}\n`);
  if (event.type === "complete") process.stdout.write(`Build ${event.blocked ? "bloccata" : "pronta"}: ${event.files} file, ${event.bytes} byte.\n`);
}

function formatResult(result: BuildResult): Record<string, unknown> {
  return {
    status: result.status,
    sourceKind: result.sourceKind,
    bundlePath: result.bundlePath,
    files: result.files,
    pages: result.pages,
    assets: result.assets,
    totalBytes: result.totalBytes,
    skipped: result.skipped,
    findings: result.findings,
    manifest: result.manifest,
    report: result.report,
    redirects: result.redirects,
    pagefind: result.pagefind,
    forms: result.forms,
  };
}

async function loadSite(input?: string): Promise<{ config: SiteConfig; configPath?: string }> {
  if (input?.toLowerCase().endsWith(".json")) {
    const configPath = path.resolve(input);
    let raw: unknown;
    try { raw = JSON.parse(await readFile(configPath, "utf8")); }
    catch { throw new HistosPublishError("Il file di configurazione non è leggibile o contiene JSON non valido.", "config-invalid", 2); }
    return { config: parseSiteConfig(raw), configPath };
  }
  if (input) {
    const source = detectSource(input);
    const name = path.basename(source.path, path.extname(source.path)) || "Nuovo sito";
    return { config: createSiteConfig(name, source) };
  }
  const configPath = path.resolve("histos-publish.json");
  try {
    const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
    return { config: parseSiteConfig(raw), configPath };
  } catch {
    throw new HistosPublishError("Non trovo histos-publish.json. Passa una sorgente o crea la configurazione con init.", "config-missing", 2);
  }
}

function buildArguments(config: SiteConfig, outputDirectory?: string, checkOnly = false, crawlConsent?: string, renderPage?: RenderPage) {
  const cacheDirectory = config.source.kind === "url" ? crawlCacheDirectory(config.source.path) : undefined;
  return {
    source: config.source,
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(checkOnly ? { checkOnly: true } : {}),
    ...(config.include === undefined ? {} : { include: config.include }),
    ...(config.exclude === undefined ? {} : { exclude: config.exclude }),
    ...(config.crawl?.maxBytes === undefined ? {} : { maxBytes: config.crawl.maxBytes }),
    ...(config.crawl === undefined ? {} : { crawl: config.crawl }),
    ...(config.rewrite === undefined ? {} : { rewrite: config.rewrite }),
    ...(config.dynamic === undefined ? {} : { dynamic: config.dynamic }),
    ...(config.pagefind === undefined ? {} : { pagefind: config.pagefind }),
    ...(config.forms === undefined ? {} : { forms: config.forms }),
    ...(config.cloudflare?.workerModule === undefined ? {} : { workerPath: config.cloudflare.workerModule.path }),
    ...(cacheDirectory === undefined ? {} : { cacheDirectory }),
    ...(crawlConsent === undefined ? {} : { crawlConsent }),
    ...(renderPage === undefined ? {} : { renderPage }),
    onEvent: printEvent,
  };
}

async function buildConfigured(config: SiteConfig, options: { outputDirectory?: string; checkOnly?: boolean; crawlConsent?: string; render?: boolean } = {}) {
  const effectiveConfig: SiteConfig = options.render ? { ...config, crawl: { ...config.crawl, render: true } } : config;
  const shouldRender = effectiveConfig.source.kind === "url" && effectiveConfig.crawl?.render === true;
  const renderSession = shouldRender ? await createPlaywrightRenderSession() : undefined;
  try {
    return await buildBundle(buildArguments(effectiveConfig, options.outputDirectory, options.checkOnly, options.crawlConsent, renderSession?.renderPage));
  } finally { await renderSession?.close(); }
}

function crawlCacheDirectory(sourceUrl: string): string {
  const source = new URL(sourceUrl);
  const digest = createHash("sha256").update(source.origin).digest("hex");
  const root = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Local")
    : process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(root, "histos-publish", "crawls", digest);
}

function consentStorePath(): string {
  const root = process.platform === "win32"
    ? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(root, "histos-publish", "crawl-consents.json");
}

async function readConsentedOrigins(): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(consentStorePath(), "utf8"));
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return new Set(parsed);
  } catch { /* Missing or damaged consent data starts with no approved domains. */ }
  return new Set();
}

async function saveConsentedOrigin(origin: string): Promise<void> {
  const target = consentStorePath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const allowed = await readConsentedOrigins();
  allowed.add(origin);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify([...allowed].sort())}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

async function ensureCrawlConsent(config: SiteConfig, yes = false): Promise<string | undefined> {
  if (config.source.kind !== "url") return undefined;
  const origin = new URL(config.source.path).origin;
  const allowed = await readConsentedOrigins();
  if (allowed.has(origin)) return origin;
  if (yes) {
    await saveConsentedOrigin(origin);
    return origin;
  }
  if (jsonMode() || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new HistosPublishError(`Prima di avviare il crawl conferma ${origin}: ripeti il comando con --yes per autorizzarlo.`, "crawl-consent-required", 2);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try { answer = await prompt.question(`Histeon Publish leggerà le pagine e le risorse pubbliche di ${origin}. Consenti e salva la scelta sul computer? [s/N] `); }
  finally { prompt.close(); }
  if (!/^(?:s|si|sì|y|yes)$/iu.test(answer.trim())) throw new HistosPublishError("Lettura annullata: non è stato dato il consenso per il dominio.", "crawl-consent-required", 2);
  await saveConsentedOrigin(origin);
  return origin;
}

async function buildCommand(site: string | undefined, options: { out?: string; yes?: boolean; render?: boolean }, checkOnly = false): Promise<void> {
  const { config } = await loadSite(site);
  const crawlConsent = await ensureCrawlConsent(config, options.yes);
  const result = await buildConfigured(config, { ...(options.out === undefined ? {} : { outputDirectory: options.out }), checkOnly, ...(crawlConsent === undefined ? {} : { crawlConsent }), ...(options.render === undefined ? {} : { render: options.render }) });
  print(formatResult(result));
  if (result.status === "blocked") process.exitCode = 3;
}

function cloudflareSettings(config: SiteConfig): { accountId: string; script: string; maxFiles?: number } {
  const accountId = config.cloudflare?.accountId;
  const script = config.cloudflare?.script;
  if (!accountId || !script) {
    throw new HistosPublishError("Configura cloudflare.accountId e cloudflare.script nel file histos-publish.json.", "cloudflare-config", 2);
  }
  if (!/^[0-9a-f]{32}$/iu.test(accountId) || !/^[a-z0-9-]{1,63}$/u.test(script)) {
    throw new HistosPublishError("ID account o nome Worker non valido nella configurazione.", "cloudflare-config", 2);
  }
  return { accountId, script, ...(config.cloudflare?.maxFiles === undefined ? {} : { maxFiles: config.cloudflare.maxFiles }) };
}

function createCloudflareClient(token: string): CloudflareClient {
  const apiBase = process.env.HISTOS_CLOUDFLARE_API_BASE;
  return new CloudflareClient({ token, ...(apiBase === undefined ? {} : { apiBase }) });
}

async function cloudflareClientFromStore(): Promise<CloudflareClient> {
  const { token } = await readCloudflareToken();
  return createCloudflareClient(token);
}

async function confirmOperation(message: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (jsonMode() || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new HistosPublishError(`${message}\nIn un terminale interattivo conferma l’operazione oppure ripeti con --yes.`, "confirmation-required", 2);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try { answer = await prompt.question(`${message}\nProcedo? [s/N] `); }
  finally { prompt.close(); }
  if (!/^(?:s|si|sì|y|yes)$/iu.test(answer.trim())) throw new HistosPublishError("Operazione annullata.", "cancelled", 6);
}

async function promptSecret(label: string, variable = "HISTOS_CLOUDFLARE_API_TOKEN"): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY || typeof input.setRawMode !== "function") {
    throw new HistosPublishError(`Per inserire il token in modo nascosto serve un terminale interattivo. In alternativa imposta ${variable}.`, "interactive-terminal-required", 2);
  }
  process.stdout.write(label);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let secret = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(secret);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString().replace(/\r/g, "\n")) {
        if (character === "\u0003") {
          finish(new HistosPublishError("Inserimento annullato.", "cancelled", 6));
          return;
        }
        if (character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") secret = [...secret].slice(0, -1).join("");
        else if (character >= " " && character !== "\u007f") secret += character;
      }
    };
    input.on("data", onData);
  });
}

function printDeployEvent(event: { type: "deploy-progress"; phase: string; completed?: number; total?: number }): void {
  if (jsonStreamMode()) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }
  if (jsonMode()) return;
  const progress = event.completed === undefined ? "" : ` ${event.completed}${event.total === undefined ? "" : `/${event.total}`}`;
  process.stdout.write(`  ${event.phase}${progress}\n`);
}

async function deployCommand(site: string | undefined, options: { dryRun?: boolean; yes?: boolean; message?: string }): Promise<void> {
  const { config } = await loadSite(site);
  const target = cloudflareSettings(config);
  const crawlConsent = await ensureCrawlConsent(config, options.yes);
  const build = await buildConfigured(config, { ...(crawlConsent === undefined ? {} : { crawlConsent }) });
  if (build.status !== "ready" || !build.bundlePath) {
    print(formatResult(build));
    process.exitCode = 3;
    return;
  }
  const files = await loadBundleFiles(build.bundlePath);
  const manifest = planCloudflareManifest(files, target.maxFiles);
  if (options.dryRun) {
    print({ dryRun: true, cloudflareRequests: 0, accountId: target.accountId, script: target.script, files: files.length, manifestEntries: Object.keys(manifest).length, maxFiles: target.maxFiles ?? 20000 });
    return;
  }
  let turnstileSecret: string | undefined;
  if (build.forms?.enabled) {
    turnstileSecret = await new SystemKeyringSecretStore(undefined, "histos-publish", turnstileSecretAccount(target.script)).get() ?? undefined;
    if (!turnstileSecret) throw new HistosPublishError("Manca la chiave segreta Turnstile. Esegui `histos-publish turnstile-secret <config>` e riprova.", "forms-secret-missing", 2);
  }
  const warnings = build.findings.filter((finding) => finding.severity === "warn").length;
  await confirmOperation(`Pubblico ${config.name} su Cloudflare.\nAccount: ${target.accountId}\nWorker: ${target.script}\nFile: ${files.length}\nAvvisi: ${warnings}`, options.yes ?? false);
  const client = await cloudflareClientFromStore();
  const result = await deployBundle({
    client,
    accountId: target.accountId,
    script: target.script,
    files,
    findings: build.findings,
    ...(build.forms === undefined ? {} : { forms: build.forms }),
    ...(turnstileSecret === undefined ? {} : { turnstileSecret }),
    ...(options.message === undefined ? {} : { message: options.message }),
    ...(target.maxFiles === undefined ? {} : { maxFiles: target.maxFiles }),
    ...(config.cloudflare?.kv?.length ? { kv: config.cloudflare.kv } : {}),
    onEvent: printDeployEvent,
  });
  print({ status: "deployed", accountId: target.accountId, script: target.script, ...result });
}

program
  .name("histos-publish")
  .description("Prepara ed esporta bundle statici per Histeon Publish")
  .version(HISTOS_PUBLISH_VERSION)
  .option("--json", "stampa un solo oggetto JSON finale")
  .option("--json-stream", "stampa eventi NDJSON durante le operazioni")
  .addHelpText("after", "\nCodici di uscita: 0 ok · 1 errore · 2 uso/configurazione · 3 scansione bloccante · 4 Cloudflare · 5 sorgente non raggiungibile · 6 annullato\n");

program.command("init")
  .description("Crea histos-publish.json per una cartella, un file HTML o uno ZIP")
  .argument("[sorgente]", "cartella, file .html o .zip; se omesso usa la cartella corrente")
  .option("--name <nome>", "nome del sito")
  .option("--root <cartella>", "radice consentita per le risorse del file HTML")
  .option("--out <file>", "percorso del file JSON", "histos-publish.json")
  .action(async (sourceInput: string | undefined, options: { name?: string; root?: string; out: string }) => {
    const source: SourceSpec = sourceInput ? detectSource(sourceInput) : { kind: "directory", path: process.cwd() };
    if (options.root && source.kind === "html") source.root = path.resolve(options.root);
    const fallback = source.kind === "url" ? new URL(source.path).hostname : path.basename(source.path) || "Nuovo sito";
    const config = createSiteConfig(options.name ?? fallback, source);
    const output = path.resolve(options.out);
    try { await access(output); throw new HistosPublishError("Il file di configurazione esiste già; scegli un altro percorso.", "output-exists", 2); }
    catch (error) { if (error instanceof HistosPublishError) throw error; }
    await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
    print({ created: output, source: config.source, name: config.name });
  });

program.command("detect")
  .description("Riconosce la sorgente; per un URL legge robots.txt e la home, senza copiare le risorse")
  .argument("<url|percorso>")
  .option("--yes", "autorizza la lettura del dominio e salva il consenso")
  .action(async (input: string, options: { yes?: boolean }) => {
    const source = detectSource(input);
    if (source.kind !== "url") {
      print({ ...source, networkRequested: false });
      return;
    }
    const config = createSiteConfig(new URL(source.path).hostname, source);
    const crawlConsent = await ensureCrawlConsent(config, options.yes);
    const report = await detectOnlineSite({ sourceUrl: source.path, crawlConsent: crawlConsent ?? "" });
    print({ ...source, networkRequested: true, ...report });
  });

program.command("build")
  .description("Prepara un bundle e controlla la sorgente")
  .argument("[sito]", "file di configurazione JSON o sorgente diretta")
  .option("--out <cartella>", "cartella nuova dove salvare il bundle")
  .option("--yes", "autorizza la lettura del dominio e salva il consenso")
  .option("--render", "usa Chrome/Chromium di sistema per acquisire una pagina renderizzata da JavaScript")
  .action((site: string | undefined, options: { out?: string; yes?: boolean; render?: boolean }) => buildCommand(site, options));

program.command("check")
  .description("Esegue scanner e manifest senza scrivere un bundle")
  .argument("[sito]", "file di configurazione JSON o sorgente diretta")
  .option("--yes", "autorizza la lettura del dominio e salva il consenso")
  .action((site: string | undefined, options: { yes?: boolean }) => buildCommand(site, options, true));

program.command("export")
  .description("Esporta un bundle pronto come cartella o ZIP")
  .argument("[sito]", "file JSON o sorgente da creare")
  .argument("<destinazione>", "cartella nuova oppure file .zip")
  .option("--bundle <cartella>", "esporta un bundle già creato")
  .option("--yes", "autorizza la lettura del dominio e salva il consenso")
  .action(async (site: string | undefined, destination: string, options: { bundle?: string; yes?: boolean }) => {
    let bundlePath = options.bundle;
    if (!bundlePath) {
      const { config } = await loadSite(site);
      const crawlConsent = await ensureCrawlConsent(config, options.yes);
      const result = await buildConfigured(config, { ...(crawlConsent === undefined ? {} : { crawlConsent }) });
      if (result.status !== "ready" || !result.bundlePath) {
        process.exitCode = 3;
        print(formatResult(result));
        return;
      }
      bundlePath = result.bundlePath;
    }
    print(await exportBundle(bundlePath, destination));
  });

program.command("login")
  .description("Verifica il token Cloudflare e lo salva nel portachiavi di sistema")
  .action(async () => {
    const environmentToken = process.env.HISTOS_CLOUDFLARE_API_TOKEN?.trim();
    const token = environmentToken || await promptSecret("Token Cloudflare (non verrà mostrato): ");
    if (!token) throw new HistosPublishError("Token vuoto.", "cloudflare-auth-missing", 4);
    const client = createCloudflareClient(token);
    const verification = await client.verifyToken(process.env.HISTOS_CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
    if (environmentToken) {
      print({ valid: verification.status === "active", status: verification.status ?? "verified", source: "environment", saved: false });
      return;
    }
    await new SystemKeyringSecretStore().set(token);
    print({ valid: verification.status === "active", status: verification.status ?? "verified", source: "keyring", saved: true });
  });

program.command("logout")
  .description("Rimuove il token salvato nel portachiavi, senza modificare le variabili d’ambiente")
  .action(async () => {
    const store = new SystemKeyringSecretStore();
    const stored = await store.get();
    if (stored) await store.delete();
    print({ removed: Boolean(stored), environmentTokenConfigured: Boolean(process.env.HISTOS_CLOUDFLARE_API_TOKEN?.trim()) });
  });

program.command("turnstile-secret")
  .description("Salva o rimuove la chiave Turnstile nel portachiavi locale per il Worker configurato")
  .argument("[sito]", "file di configurazione JSON con cloudflare.script")
  .option("--remove", "rimuove la chiave salvata nel portachiavi locale")
  .action(async (site: string | undefined, options: { remove?: boolean }) => {
    const { config } = await loadSite(site);
    const target = cloudflareSettings(config);
    const store = new SystemKeyringSecretStore(undefined, "histos-publish", turnstileSecretAccount(target.script));
    if (options.remove) {
      const existing = await store.get();
      if (existing) await store.delete();
      print({ configured: false, removed: Boolean(existing), script: target.script });
      return;
    }
    const secret = await promptSecret("Chiave segreta Turnstile (non verrà mostrata): ");
    if (secret.length < 16 || secret.length > 4096 || /[\r\n\0]/u.test(secret)) throw new HistosPublishError("La chiave segreta Turnstile non supera i controlli di formato.", "forms-secret-invalid", 2);
    await store.set(secret);
    print({ configured: true, script: target.script, saved: true });
  });

program.command("whoami")
  .description("Verifica il token Cloudflare senza mostrarlo")
  .action(async () => {
    const { source } = await readCloudflareToken();
    const client = await cloudflareClientFromStore();
    const verification = await client.verifyToken(process.env.HISTOS_CLOUDFLARE_ACCOUNT_ID?.trim() || undefined);
    print({ valid: verification.status === "active", status: verification.status ?? "verified", tokenId: verification.id, source });
  });

program.command("deploy")
  .description("Pubblica su Cloudflare una versione del bundle")
  .argument("[sito]", "file di configurazione JSON o sorgente diretta")
  .option("--dry-run", "prepara e controlla il deploy senza richieste Cloudflare")
  .option("--yes", "conferma la pubblicazione")
  .option("-m, --message <testo>", "messaggio associato alla versione")
  .action((site: string | undefined, options: { dryRun?: boolean; yes?: boolean; message?: string }) => deployCommand(site, options));

program.command("deploys")
  .description("Mostra gli ultimi deployment Cloudflare")
  .argument("[sito]", "file di configurazione JSON o sorgente diretta")
  .action(async (site: string | undefined) => {
    const { config } = await loadSite(site);
    const target = cloudflareSettings(config);
    const client = await cloudflareClientFromStore();
    print({ accountId: target.accountId, script: target.script, deployments: await client.listDeployments(target.accountId, target.script) });
  });

program.command("rollback")
  .description("Ripristina un deployment o una versione recente di Cloudflare")
  .argument("[sito]", "file di configurazione JSON o sorgente diretta")
  .argument("<id>", "ID del deployment o della versione Cloudflare")
  .option("--yes", "conferma il ripristino")
  .action(async (site: string | undefined, id: string, options: { yes?: boolean }) => {
    const { config } = await loadSite(site);
    const target = cloudflareSettings(config);
    await confirmOperation(`Ripristino ${config.name} al deployment o alla versione ${id}.`, options.yes ?? false);
    const client = await cloudflareClientFromStore();
    print({ accountId: target.accountId, script: target.script, deployment: await rollbackVersion({ client, accountId: target.accountId, script: target.script, deploymentOrVersionId: id }) });
  });

program.command("domain")
  .description("Collega un dominio personalizzato al Worker del sito")
  .argument("[sito]", "file di configurazione JSON o sorgente diretta")
  .argument("<dominio>", "hostname completo, per esempio www.example.com")
  .option("--include-www", "collega anche www quando indichi il dominio principale")
  .option("--yes", "conferma la modifica DNS e la creazione del certificato")
  .action(async (site: string | undefined, hostname: string, options: { yes?: boolean; includeWww?: boolean }) => {
    const { config } = await loadSite(site);
    const target = cloudflareSettings(config);
    const client = await cloudflareClientFromStore();
    const plan = await inspectCustomDomain({ client, accountId: target.accountId, script: target.script, hostname, includeWww: options.includeWww === true });
    if (plan.workerConflicts.length > 0) {
      const conflict = plan.workerConflicts[0];
      throw new HistosPublishError(`${conflict?.hostname} è già collegato al Worker ${conflict?.service}.`, "cloudflare-domain-in-use", 4);
    }
    const replacements = plan.cnameConflicts.map((record) => `${record.name} → ${record.content}`).join(", ");
    const action = plan.cnameConflicts.length > 0
      ? `Sostituisco solo questi record CNAME: ${replacements}. `
      : "Non ho trovato CNAME incompatibili. ";
    await confirmOperation(`${action}Collego ${plan.hostnames.join(" e ")} al Worker ${target.script}. Cloudflare creerà i record DNS e i certificati HTTPS. I record email e gli altri hostname non saranno modificati.`, options.yes ?? false);
    print({ accountId: target.accountId, script: target.script, domain: await attachCustomDomain({
      client,
      accountId: target.accountId,
      script: target.script,
      hostname,
      includeWww: options.includeWww === true,
      replaceCnameRecords: plan.cnameConflicts.map((record) => ({ id: record.id, name: record.name, content: record.content, proxied: record.proxied ?? false })),
    }) });
  });

program.command("ui")
  .description("Avvia l’interfaccia nel browser locale")
  .option("--port <numero>", "porta locale; 0 sceglie una porta libera", "0")
  .option("--no-open", "non aprire automaticamente il browser")
  .action(async (options: { port: string; open: boolean }) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new HistosPublishError("La porta deve essere tra 0 e 65535.", "server-port-invalid", 2);
    // The AI connector stays off until the user turns it on in the interface; this only says where its client is.
    const clientScript = fileURLToPath(import.meta.resolve("@histos-publish/connector/client-script"));
    const server = await startLocalServer({ port, openBrowser: options.open, connector: { appVersion: program.version() ?? "dev", ...(existsSync(clientScript) ? { clientScript } : {}) } });
    print({ ready: true, address: `http://127.0.0.1:${server.port}/`, browserOpened: options.open });
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void server.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });

program.command("mcp")
  .description("Server MCP del connettore AI su stdio: collega un agente a Histeon Publish aperto con il connettore attivo")
  .option("--data-dir <cartella>", "cartella dati di Histeon Publish, se non è quella predefinita")
  .action(async (options: { dataDir?: string }) => {
    // stdout belongs to the MCP protocol from here on: nothing else may be printed.
    const { main } = await import("@histos-publish/connector");
    process.exitCode = await main(["mcp", ...(options.dataDir ? ["--data-dir", options.dataDir] : [])], { version: program.version() ?? "dev" });
  });

const prototypeCommand = program.command("prototype").description("Prototipi Histeon: un sito intero in un file HTML. Il formato è nel manuale: histos-publish prototype manual (per un agente AI collegato all'app: hp_manual)");

/** The report of a prototype check, readable in a terminal. */
function prototypeCheckText(result: PrototypeCheckResult): string {
  const { report } = result;
  const lines = [
    `Prototipo valido: «${report.project.name}» (${report.project.id}).`,
    `Contiene: ${Object.entries(report.counts).filter(([, value]) => value > 0).map(([key, value]) => `${key} ${value}`).join(", ") || "niente"}.`,
    result.outcome === "create" ? "L’import creerebbe un progetto nuovo." : result.outcome === "update" ? "L’import aggiornerebbe il progetto creato dallo stesso prototipo." : "Un progetto con questo id esiste già e non viene da questo prototipo: l’import verrebbe rifiutato.",
  ];
  // Only with --preview: the build, which here has no address to open.
  if (result.preview) lines.push(prototypePreviewText(result.preview));
  // Only with prototype verify: the pages opened in the browser.
  const opened = result.preview && result.preview.status !== "unavailable" ? prototypeVerifyText(result.preview.verify) : null;
  if (opened) lines.push(opened);
  // B6: which images get modern variants, measured by the build with --preview.
  if (report.images) lines.push(report.images.note);
  for (const item of report.ignored) lines.push(`Ignorato: ${item.what} — ${item.why}`);
  // Doc 23 item 240: a note says what the import did; only the rest asks for a change.
  for (const warning of report.warnings) lines.push(warning.startsWith("Nota: ") ? warning : `Avviso: ${warning}`);
  if (result.strict) lines.push(prototypeStrictText(result.strict));
  return lines.join("\n");
}

/** F1, with --severo: the verdict, then one line per problem, with its rule, its place, what it is and what to write instead. */
function prototypeStrictText(strict: NonNullable<PrototypeCheckResult["strict"]>): string {
  const { problems } = strict;
  const errors = problems.filter((problem) => problem.level === "errore").length;
  const notes = problems.length - errors;
  const head = strict.passed
    ? `Controllo severo: superato${notes ? ` (${notes === 1 ? "un avviso da guardare" : `${notes} avvisi da guardare`})` : ""}.`
    : `Controllo severo: ${problems.length === 1 ? "un problema" : `${problems.length} problemi`} (${errors === 1 ? "un errore" : `${errors} errori`}${notes ? `, ${notes === 1 ? "un avviso" : `${notes} avvisi`}` : ""}).`;
  const lines = problems.map((problem) => {
    const where = problem.document ? `${problem.document}${problem.line ? `, riga ${problem.line}` : ""}: ` : "";
    return `- ${problem.rule} (${problem.level}) ${where}${problem.message} Rimedio: ${problem.fix}`;
  });
  return [head, ...lines].join("\n");
}

/** A prototype file from the disk: a regular file of at most 32 MB, in UTF-8. */
async function readPrototypeFile(file: string): Promise<string> {
  const target = path.resolve(file);
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile()) throw new HistosPublishError(`${file}: il prototipo deve essere un file normale (non una cartella o un collegamento).`, "prototype-file-invalid", 2);
  if (info.size > 32 * 1024 * 1024) throw new HistosPublishError(`${file}: il prototipo supera i 32 MB.`, "prototype-file-invalid", 2);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(target));
  } catch {
    throw new HistosPublishError(`${file}: il prototipo non è testo UTF-8.`, "prototype-file-invalid", 2);
  }
}

prototypeCommand.command("manual")
  .description("Stampa il manuale per gli agenti AI che scrivono prototipi Histeon")
  .action(() => { process.stdout.write(PROTOTYPE_AI_MANUAL); });

// Doc 17 item 3. Not the top-level init, which writes histos-publish.json for a site to publish.
prototypeCommand.command("init")
  .summary("Crea un prototipo da cui partire, valido e senza avvisi, con un id nuovo")
  .description("Crea un prototipo da cui partire, valido e senza avvisi, con un id nuovo: il kit minimo del manuale (§1.3) o, con --sito, un sito intero con contenuti neutri (ogni vista, menu mobile, voce corrente, modulo, paginazione). Senza -o lo stampa. Non è histos-publish init, che crea histos-publish.json per un sito da pubblicare.")
  .option("--minimo", "il kit minimo del manuale (predefinito)")
  .option("--sito", "un sito intero con contenuti neutri")
  .option("--name <nome>", "il nome del progetto, nel manifest e nel <title>")
  .option("-o, --output <file>", "il file .html da creare (uno che esiste già non si sovrascrive)")
  .action(async (options: { minimo?: boolean; sito?: boolean; name?: string; output?: string }) => {
    if (options.minimo && options.sito) throw new HistosPublishError("Scegli un solo kit: --minimo o --sito.", "prototype-init-invalid", 2);
    const kind = options.sito ? "sito" : "minimo";
    let made: ReturnType<typeof prototypeKit>;
    try {
      made = prototypeKit(kind, options.name === undefined ? {} : { name: options.name });
    } catch (error) {
      throw new HistosPublishError(error instanceof Error ? error.message : "Nome non valido.", "prototype-init-invalid", 2);
    }
    if (!options.output) {
      if (jsonMode()) print({ kit: kind, id: made.id, html: made.html });
      else process.stdout.write(made.html);
      return;
    }
    const output = path.resolve(options.output);
    if (!/\.html?$/iu.test(output)) throw new HistosPublishError(`${path.basename(output)}: il prototipo è un file .html.`, "prototype-init-invalid", 2);
    // Names, not whole paths, as for proposals: a folder that looks like a token would be hidden in the message.
    if (await lstat(output).catch(() => null)) throw new HistosPublishError(`${path.basename(output)} esiste già in quella cartella: scegli un altro nome.`, "prototype-init-exists", 2);
    const folder = await stat(path.dirname(output)).catch(() => null);
    if (!folder?.isDirectory()) throw new HistosPublishError(folder ? `${path.basename(path.dirname(output))} non è una cartella.` : `La cartella ${path.basename(path.dirname(output))} non esiste.`, "prototype-init-invalid", 2);
    await writeFile(output, made.html, { flag: "wx", mode: 0o644 });
    if (jsonMode()) print({ kit: kind, id: made.id, output });
    else process.stdout.write(`Prototipo creato: ${output} (kit ${kind}, id ${made.id}).\nCambia name, <title>, design, contenuti e template con quelli veri, poi: histos-publish prototype check ${path.basename(output)}\n`);
  });

prototypeCommand.command("check")
  .summary("Controlla un prototipo come farebbe l’import, senza scrivere nulla")
  // --preview builds the site as the app's check does (checkPrototypeBuild), in a temporary folder, and serves nothing.
  .description("Controlla un prototipo come farebbe l’import, senza scrivere nulla. Senza --preview non costruisce il sito: un errore che ferma solo la build (per esempio una data che arriva dai dati in un’altra forma) lo trova --preview, che costruisce il sito come il controllo dell’app, in una cartella temporanea poi cancellata, e dà gli stessi errori e gli stessi avvisi. Qui non c’è un indirizzo di anteprima da aprire: lo dà il controllo dell’app o, per un agente collegato all’app, hp_check_prototype con preview: true.")
  .argument("<file>", "il file .html del prototipo")
  .option("--download", "scarica anche i media remoti (più lento, controlla che esistano)")
  .option("--preview", "costruisce anche il sito, come il controllo dell’app, senza un indirizzo di anteprima (più lento)")
  .option("--severo", "controllo severo: le regole delle guide (classi BEM, utility, stili in linea, testi segnaposto, schede a mano, loop senza {:else}, campi che non esistono) e ogni avviso diventano problemi con riga e rimedio; esce con 1 se c’è un errore")
  .action(async (file: string, options: { download?: boolean; preview?: boolean; severo?: boolean }) => {
    const html = await readPrototypeFile(file);
    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-"));
    try {
      const checked = { scratchRoot, download: options.download === true, ...(options.severo === true ? { strict: true } : {}) };
      const result = options.preview === true ? await checkPrototypeBuild(html, checked) : await checkPrototype(html, checked);
      if (jsonMode()) print(result);
      else process.stdout.write(`${prototypeCheckText(result)}\n`);
      // F1: a strict check with an error fails; a refused prototype stays exit code 2.
      if (result.strict && !result.strict.passed) process.exitCode = 1;
    } catch (error) {
      // Exit code 2, with every problem and its place for --json.
      if (error instanceof HistosPublishError && error.code === "cms-prototype-invalid") throw prototypeRefusal(error);
      throw error;
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

// Doc 17 item 4: check --preview with a browser (Playwright), as the app's check with its hidden window.
prototypeCommand.command("verify")
  .summary("Controlla un prototipo con la build e un browser: link interni, scorrimento orizzontale a 1440 e 390 px, accessibilità (axe)")
  .description("Controlla un prototipo come prototype check --preview (la build in una cartella temporanea poi cancellata, gli stessi errori e avvisi) e in più apre le pagine costruite in Chrome o Chromium a 1440 e 390 px: una pagina più larga della finestra (scorrimento orizzontale) e le regole WCAG 2.2 AA che axe-core trova violate diventano avvisi, come nel controllo dell’app. Apre al massimo 20 pagine, la pagina iniziale e le meno profonde. Il browser è quello del sistema (o HISTOS_PUBLISH_BROWSER) e raggiunge solo il server locale della build.")
  .argument("<file>", "il file .html del prototipo")
  .option("--download", "scarica anche i media remoti (più lento, controlla che esistano)")
  .option("--severo", "controllo severo: le regole delle guide e ogni avviso, anche di scorrimento, axe e link, diventano problemi con riga e rimedio; esce con 1 se c’è un errore")
  .action(async (file: string, options: { download?: boolean; severo?: boolean }) => {
    const html = await readPrototypeFile(file);
    const browser = await launchVerifyBrowser();
    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-"));
    try {
      const result = await checkPrototypeBuild(html, { scratchRoot, download: options.download === true, openPageProbe: playwrightPageProbe(browser), ...(options.severo === true ? { strict: true } : {}) });
      if (jsonMode()) print(result);
      else process.stdout.write(`${prototypeCheckText(result)}\n`);
      if (result.strict && !result.strict.passed) process.exitCode = 1;
    } catch (error) {
      if (error instanceof HistosPublishError && error.code === "cms-prototype-invalid") throw prototypeRefusal(error);
      throw error;
    } finally {
      await browser.close().catch(() => undefined);
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

// «Fotografa la proposta»: a proposal drawn by its scripts, captured page by page into a static site for the importer.
prototypeCommand.command("capture")
  .summary("Fotografa una proposta disegnata da script: le sue pagine come si vedono, senza script, in una cartella da importare")
  .description("Apre in Chrome o Chromium una proposta HTML che i suoi script disegnano (un visore con la proposta dentro), la lascia disegnare e copia ogni pagina com’è in quel momento, senza script. Scrive una cartella con un sito statico: index.html per la prima pagina e una cartella per ognuna delle altre, con i link fra le pagine fotografate. Le pagine si indicano col pezzo di indirizzo dopo # che il visore usa (--pagina '#p03/home'); senza --pagina fotografa il file come si apre. Il browser raggiunge solo il file della proposta: la rete resta chiusa. La cartella è HTML non fidato come ogni altro: l’importazione la ricontrolla per intero.")
  .argument("<file>", "il file .html della proposta")
  .requiredOption("--out <cartella>", "la cartella da creare (una che esiste già non si tocca)")
  .option("--pagina <frammento...>", "il frammento d’indirizzo di ogni pagina, la prima è la home; col nome davanti se serve: 'Menu=#p03/menu'")
  .option("--radice <selettore>", "la proposta è solo questa parte della pagina (un selettore CSS)")
  .option("--togli <selettore...>", "elementi del visore da lasciare fuori (selettori CSS)")
  .option("--documento", "la proposta è la pagina stessa, anche se ha un riquadro grande")
  .option("--larghezza <px>", "la larghezza della finestra in cui la proposta si disegna", "1280")
  .action(async (file: string, options: CaptureCommandOptions) => {
    const browser = await launchVerifyBrowser();
    try {
      const result = await runPrototypeCapture(file, options, playwrightPageProbe(browser));
      if (jsonMode()) print(result);
      else process.stdout.write(`${prototypeCaptureText(result)}\n`);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });

// Doc 23 item 238: from the prototype file to the .xbsite WordPress imports, with no project in the app.
prototypeCommand.command("export")
  .summary("Trasforma un prototipo nel pacchetto .xbsite da importare in WordPress, senza creare un progetto nell’app")
  .description("Trasforma un prototipo nel pacchetto .xbsite che Histeon in WordPress importa (Histeon → Release → Importa un file): lo stesso pacchetto che l’app esporterebbe per il progetto creato dall’import, con le stesse identità, ma senza creare nulla nell’app. Il lavoro si fa in una cartella temporanea poi cancellata. Un media remoto ferma l’export, come ferma l’import: con --download si scarica. Prima controlla il prototipo con histos-publish prototype verify.")
  .argument("<file>", "il file .html del prototipo")
  .option("-o, --output <file>", "il file .xbsite da creare (predefinito: accanto al prototipo, con lo stesso nome; uno che esiste già non si sovrascrive)")
  .option("--download", "scarica i media remoti (solo HTTPS pubblici)")
  .action(async (file: string, options: { output?: string; download?: boolean }) => {
    const html = await readPrototypeFile(file);
    const output = path.resolve(options.output ?? path.join(path.dirname(path.resolve(file)), `${path.basename(file).replace(/\.html?$/iu, "")}.xbsite`));
    if (!/\.xbsite$/iu.test(output)) throw new HistosPublishError(`${path.basename(output)}: il pacchetto è un file .xbsite.`, "prototype-export-invalid", 2);
    // Names, not whole paths, as for proposals: a folder that looks like a token would be hidden in the message.
    if (await lstat(output).catch(() => null)) throw new HistosPublishError(`${path.basename(output)} esiste già in quella cartella: scegli un altro nome con -o.`, "prototype-export-exists", 2);
    const folder = await stat(path.dirname(output)).catch(() => null);
    if (!folder?.isDirectory()) throw new HistosPublishError(folder ? `${path.basename(path.dirname(output))} non è una cartella.` : `La cartella ${path.basename(path.dirname(output))} non esiste.`, "prototype-export-invalid", 2);
    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-"));
    try {
      const { archive, report } = await exportPrototypeXbsite(html, { scratchRoot, download: options.download === true });
      await writeFile(output, archive, { flag: "wx", mode: 0o644 });
      const sha256 = createHash("sha256").update(archive).digest("hex");
      if (jsonMode()) print({ output, bytes: archive.length, sha256, project: report.project, counts: report.counts });
      else process.stdout.write(`Pacchetto creato: ${output} (${archive.length} byte, sha256 ${sha256.slice(0, 12)}…).\nProgetto «${report.project.name}» (${report.project.id}). In WordPress: Histeon → Release → Importa un file.\n`);
    } catch (error) {
      if (error instanceof HistosPublishError && error.code === "cms-prototype-invalid") throw prototypeRefusal(error);
      if (error instanceof HistosPublishError && error.exitCode > 6) throw new HistosPublishError(error.message, error.code, error.exitCode >= 400 && error.exitCode < 500 ? 2 : 1);
      throw error;
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

/** The key of the refinement's provider: the environment first, then the app's keyring entry; a local server may have none. */
async function refineKey(provider: "locale" | "haiku"): Promise<string | null> {
  const fromEnvironment = (provider === "haiku" ? process.env.ANTHROPIC_API_KEY : process.env.LLAMA_API_KEY)?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    return await new SystemKeyringSecretStore(undefined, "histos-publish", provider === "haiku" ? REFINE_HAIKU_KEY_ACCOUNT : REFINE_LOCAL_KEY_ACCOUNT).get();
  } catch {
    return null;
  }
}

/** A site to convert from the disk: a folder with index.html, a ZIP, or one HTML page (it becomes the home page). */
async function readSiteFiles(source: string): Promise<{ name: string; files: Array<{ path: string; bytes: Uint8Array }> }> {
  const target = path.resolve(source);
  const info = await stat(target).catch(() => null);
  if (!info) throw new HistosPublishError(`${path.basename(target)} non esiste.`, "source-missing", 5);
  const maxBytes = 128 * 1024 * 1024;
  if (info.isDirectory()) {
    const read = await readDirectorySource(target, { maxBytes });
    if (!read.files.some((file) => file.path === "index.html")) throw new HistosPublishError("La cartella non contiene index.html: indica la cartella principale del sito.", "import-index-missing", 2);
    return { name: path.basename(target), files: read.files.map((file) => ({ path: file.path, bytes: file.bytes })) };
  }
  if (/\.zip$/iu.test(target)) {
    const zip = await readZipSource(target, { maxBytes });
    return { name: path.basename(target).replace(/\.zip$/iu, ""), files: zip.files.map((file) => ({ path: file.path, bytes: file.bytes })) };
  }
  if (/\.html?$/iu.test(target)) return { name: path.basename(target).replace(/\.html?$/iu, ""), files: [{ path: "index.html", bytes: await readFile(target) }] };
  throw new HistosPublishError(`${path.basename(target)}: serve una cartella, uno ZIP o un file .html.`, "source-invalid", 2);
}

// Doc 27, G3: the names of a conversion refined by a model, from the terminal. Without --scrivi only the table.
prototypeCommand.command("rifinisci")
  .summary("Converte un sito HTML e fa proporre a un modello nomi più chiari per classi, componenti, campi e tipi")
  .description("Converte un sito HTML (cartella, ZIP o pagina) come l’importazione dell’app e chiede a un modello nomi più chiari per le classi, i componenti, i campi e i tipi che il convertitore inventa. Il modello sceglie soltanto nomi: non scrive mai HTML o CSS, e ogni nome passa le regole del convertitore. Senza --scrivi stampa la tabella prima → dopo; con --scrivi scrive anche il prototipo con tutti i nomi della tabella. I testi alternativi delle immagini sono solo suggerimenti: qui non si applicano. Fornitore locale: un server compatibile con le API di OpenAI (llama-server), chiave da LLAMA_API_KEY o dal portachiavi dell’app. Haiku: Claude Haiku 5.5, chiave da ANTHROPIC_API_KEY o dal portachiavi dell’app; costa crediti e manda ad Anthropic i testi brevi del sito. I media remoti non si scaricano: lo fa l’importazione nell’app.")
  .argument("<sorgente>", "la cartella del sito (con index.html), uno ZIP o un file .html")
  .option("--fornitore <nome>", "locale (llama-server) o haiku (Claude Haiku 5.5)", "locale")
  .option("--indirizzo <url>", "l’indirizzo del server locale", "http://127.0.0.1:18080")
  .option("--modello <nome>", "il nome del modello locale", "qwen3-8b")
  .option("--struttura", "converte anche parti, componenti e liste (danno i nomi di componenti, campi e tipi)")
  .option("--scrivi", "scrive anche il prototipo con tutti i nomi della tabella")
  .option("-o, --output <file>", "il prototipo da scrivere con --scrivi (predefinito: <nome>-prototipo.html accanto alla sorgente; uno che esiste già non si sovrascrive)")
  .action(async (source: string, options: { fornitore: string; indirizzo: string; modello: string; struttura?: boolean; scrivi?: boolean; output?: string }) => {
    if (options.fornitore !== "locale" && options.fornitore !== "haiku") throw new HistosPublishError("--fornitore è «locale» o «haiku».", "refine-provider-invalid", 2);
    const settings = readRefineSettings({ provider: options.fornitore, localUrl: options.indirizzo.replace(/\/+$/u, ""), localModel: options.modello });
    if (options.fornitore === "locale" && settings.localUrl !== options.indirizzo.replace(/\/+$/u, "")) throw new HistosPublishError("--indirizzo deve essere http:// o https://, senza utente, password, ? o #.", "refine-url-invalid", 2);
    if (options.fornitore === "locale" && settings.localModel !== options.modello) throw new HistosPublishError("--modello ha lettere, cifre e . _ : / - (al massimo 80).", "refine-model-invalid", 2);
    let output: string | null = null;
    if (options.scrivi) {
      output = path.resolve(options.output ?? path.join(path.dirname(path.resolve(source)), `${path.basename(path.resolve(source)).replace(/\.(?:html?|zip)$/iu, "")}-prototipo.html`));
      if (!/\.html?$/iu.test(output)) throw new HistosPublishError(`${path.basename(output)}: il prototipo è un file .html.`, "refine-output-invalid", 2);
      if (await lstat(output).catch(() => null)) throw new HistosPublishError(`${path.basename(output)} esiste già in quella cartella: scegli un altro nome con -o.`, "refine-output-exists", 2);
    } else if (options.output) throw new HistosPublishError("-o vale solo con --scrivi.", "refine-output-invalid", 2);
    const site = await readSiteFiles(source);
    let ask: ReturnType<typeof refineAsk>;
    try {
      ask = refineAsk(settings, await refineKey(settings.provider === "haiku" ? "haiku" : "locale"));
    } catch (error) {
      if (error instanceof HistosPublishError) throw new HistosPublishError(settings.provider === "haiku" ? "Manca la chiave API di Anthropic: impostala in ANTHROPIC_API_KEY o salvala nell’app (Agente AI)." : error.message, error.code, 2);
      throw error;
    }
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    try {
      const result = await refineStaticSite({ sourceKey: path.resolve(source), name: site.name, files: site.files, structure: options.struttura === true, settings, ask, write: options.scrivi === true, signal: controller.signal });
      if (output && result.prototype !== null) await writeFile(output, result.prototype, { flag: "wx", mode: 0o644 });
      if (jsonMode()) print({ ...result.report, ...(output ? { output, choicesRejected: result.choicesRejected } : {}) });
      else {
        const lines = [refineReportText(result.report)];
        if (output) lines.push("", `Prototipo scritto: ${output}${result.choicesRejected.length ? ` (${result.choicesRejected.length} nomi non applicati)` : ""}. Controllalo con: histos-publish prototype verify ${path.basename(output)}`);
        else if (result.report.rows.length) lines.push("", "Per scrivere il prototipo con questi nomi ripeti con --scrivi.");
        process.stdout.write(`${lines.join("\n")}\n`);
      }
      if (controller.signal.aborted) process.exitCode = 6;
    } finally {
      process.removeListener("SIGINT", stop);
    }
  });

prototypeCommand.command("proposals")
  .description("Crea la pagina delle proposte: più prototipi affiancati in un solo file HTML da mandare al cliente, che sceglie")
  .argument("<files...>", `i file .html dei prototipi, da 1 a ${PROPOSALS_MAX}`)
  .requiredOption("-o, --output <file>", "il file HTML da creare (uno che esiste già non si sovrascrive)")
  .option("--title <text>", "il titolo della pagina", "Proposte")
  .option("--contact <email>", "l’indirizzo a cui il cliente scrive la proposta scelta")
  .option("--download", "scarica i media remoti invece di mostrarli come segnaposto")
  .action(async (files: string[], options: { output: string; title: string; contact?: string; download?: boolean }) => {
    const output = path.resolve(options.output);
    // Names, not whole paths: a folder that looks like a token would be hidden in the message as a secret.
    if (await lstat(output).catch(() => null)) throw new HistosPublishError(`${path.basename(output)} esiste già in quella cartella: scegli un altro nome.`, "proposals-output-exists", 2);
    // Checked before the work, following links (on macOS /tmp is one): a missing folder would otherwise fail at the end.
    const folder = await stat(path.dirname(output)).catch(() => null);
    if (!folder?.isDirectory()) throw new HistosPublishError(folder ? `${path.basename(path.dirname(output))} non è una cartella.` : `La cartella ${path.basename(path.dirname(output))} non esiste.`, "proposals-output-invalid", 2);
    const inputs = [];
    for (const file of files) inputs.push({ file, html: await readPrototypeFile(file) });
    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "histos-proposals-"));
    try {
      const result = await buildProposalsPage(inputs, { scratchRoot, title: options.title, download: options.download === true, ...(options.contact ? { contact: options.contact } : {}) });
      await writeFile(output, result.html, { flag: "wx", mode: 0o644 });
      if (jsonMode()) print({ output, proposals: result.proposals, notes: result.notes });
      else {
        const lines = [`Pagina delle proposte: ${output}`];
        for (const proposal of result.proposals) lines.push(`• ${proposal.name}: ${proposal.pages === 1 ? "1 pagina" : `${proposal.pages} pagine`}, da ${proposal.file} (sha256 ${proposal.sha256.slice(0, 12)}…)`);
        for (const note of result.notes) lines.push(`Avviso: ${note}`);
        lines.push("La proposta scelta è già un prototipo: si importa così com’è, senza estrarre nulla.");
        process.stdout.write(`${lines.join("\n")}\n`);
      }
    } catch (error) {
      // A refused prototype keeps its problems for --json, as with check.
      if (error instanceof HistosPublishError && error.code === "cms-prototype-invalid") throw prototypeRefusal(error);
      // HTTP-like statuses are not exit codes (413 would exit with 157): a problem with the input is 2, anything else 1.
      if (error instanceof HistosPublishError && error.exitCode > 6) throw new HistosPublishError(error.message, error.code, error.exitCode >= 400 && error.exitCode < 500 ? 2 : 1);
      throw error;
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

/** A source of design tokens from the disk: a JSON of tokens (at most 8 MB, UTF-8), a whole .penpot file or a .fig file. */
async function readTokenFile(file: string): Promise<DesignFileTokens> {
  const target = path.resolve(file);
  const name = path.basename(target);
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile()) throw new HistosPublishError(`${name}: serve un file normale (non una cartella o un collegamento).`, "tokens-file-invalid", 2);
  if (info.size > DESIGN_FILE_MAX) throw new HistosPublishError(`${name}: il file supera ${DESIGN_FILE_MAX / 1024 / 1024} MB.`, "tokens-file-invalid", 2);
  try {
    return await designFileTokens(name, await readFile(target));
  } catch (error) {
    if (error instanceof TypeError) throw new HistosPublishError(error.message, "tokens-file-invalid", 2);
    throw error;
  }
}

/**
 * The styles and variables of a file of Figma, read from its REST API (note penpot-figma-a-histeon.md, phase 2). The
 * token comes from the environment or the keyring and is never printed; a bad address is the user's (exit 2), a
 * refusal of Figma keeps its exit code 4.
 */
async function readFigmaSource(address: string): Promise<DesignFileTokens> {
  let key: string;
  try {
    key = figmaFileKey(address);
  } catch (error) {
    throw new HistosPublishError(error instanceof Error ? error.message : "Indirizzo del file di Figma non valido.", "tokens-figma-invalid", 2);
  }
  const { token } = await readFigmaToken().catch((error: unknown) => {
    if (error instanceof HistosPublishError && error.code === "figma-auth-missing") throw new HistosPublishError(`Token di Figma assente. Salvalo con «histos-publish figma-login», nell’app, oppure imposta ${FIGMA_TOKEN_ENV}.`, "figma-auth-missing", 4);
    throw error;
  });
  try {
    return await figmaApiTokens(figmaClient(token), key);
  } catch (error) {
    if (error instanceof TypeError) throw new HistosPublishError(error.message, "tokens-file-invalid", 2);
    throw error;
  }
}

program.command("figma-login")
  .description("Verifica il token personale di Figma e lo salva nel portachiavi di sistema: serve a «tokens --figma»")
  .action(async () => {
    const environmentToken = process.env[FIGMA_TOKEN_ENV]?.trim();
    const token = (environmentToken || await promptSecret("Token personale di Figma (non verrà mostrato): ", FIGMA_TOKEN_ENV)).trim();
    if (!validFigmaToken(token)) throw new HistosPublishError("Il token di Figma non supera i controlli di formato.", "figma-token-invalid", 2);
    let handle: string;
    try {
      handle = (await figmaClient(token).me()).handle;
    } catch (error) {
      if (error instanceof FigmaApiError && error.status === 403) throw new HistosPublishError("Figma non riconosce questo token.", "figma-token-refused", 4);
      throw error;
    }
    if (environmentToken) {
      print({ valid: true, account: handle, source: "environment", saved: false });
      return;
    }
    await new SystemKeyringSecretStore(undefined, "histos-publish", FIGMA_TOKEN_ACCOUNT).set(token);
    print({ valid: true, account: handle, source: "keyring", saved: true });
  });

program.command("figma-logout")
  .description("Rimuove il token di Figma salvato nel portachiavi, senza modificare le variabili d’ambiente")
  .action(async () => {
    const store = new SystemKeyringSecretStore(undefined, "histos-publish", FIGMA_TOKEN_ACCOUNT);
    const stored = await store.get();
    if (stored) await store.delete();
    print({ removed: Boolean(stored), environmentTokenConfigured: Boolean(process.env[FIGMA_TOKEN_ENV]?.trim()) });
  });

// Note penpot-figma-a-histeon.md, phases 1 and 2: files need no network and no credentials; --figma reads from the API.
program.command("tokens")
  .summary("Porta i token di design esportati da Figma o Penpot in Histeon CSS e in Automatic.css")
  .description("Legge i token di design esportati da Figma (Variabili → Esporta modi: un file DTCG per modo) o da Penpot (Token → Esporta: un file con gli insiemi) e scrive in una cartella: histos-css.json, da aprire con «Importa» nel pannello Histeon CSS; variabili-sito.json, i token senza un parametro come variabili --xb-site-*; acss-valori.json e acss-variabili.css, per un sito con Automatic.css; rapporto.txt, con ciò che è stato convertito e ciò che no. Le misure di testo non diventano mai misure fisse: il rapporto dice il gradino più vicino. Coi soli file non usa la rete e non chiede credenziali; con --figma legge stili e variabili dal servizio di Figma, col token salvato da «figma-login».")
  .argument("[files...]", "i file .json dei token del tema chiaro, un file .penpot (colori, tipografie e token della sua libreria) o un file .fig di Figma (stili e variabili), nell’ordine in cui si applicano")
  .option("--figma <indirizzo>", "l’indirizzo o la chiave di un file di Figma, letto dalla sua API prima dei file")
  .option("--dark <files...>", "i file dei token del tema scuro (per Figma, il modo scuro esportato)")
  .requiredOption("-o, --output <cartella>", "la cartella da creare (una che esiste già non si tocca)")
  .option("--prefix <nome>", "il prefisso delle variabili scritte per Automatic.css", "ds")
  .action(async (files: string[], options: { figma?: string; dark?: string[]; output: string; prefix: string }) => {
    if (!files.length && options.figma === undefined) throw new HistosPublishError("Indica almeno un file di token o di design, oppure --figma con l’indirizzo di un file di Figma.", "tokens-file-invalid", 2);
    const output = path.resolve(options.output);
    // Names, not whole paths, as for proposals: a folder that looks like a token would be hidden in the message.
    if (await lstat(output).catch(() => null)) throw new HistosPublishError(`${path.basename(output)} esiste già: scegli un altro nome.`, "tokens-output-exists", 2);
    const parent = await stat(path.dirname(output)).catch(() => null);
    if (!parent?.isDirectory()) throw new HistosPublishError(parent ? `${path.basename(path.dirname(output))} non è una cartella.` : `La cartella ${path.basename(path.dirname(output))} non esiste.`, "tokens-output-invalid", 2);
    const sources: DesignFileTokens[] = [];
    const light: TokenFile[] = [];
    // The files first: a file that cannot be read is said before anything is asked to Figma.
    for (const file of files) sources.push(await readTokenFile(file));
    if (options.figma !== undefined) sources.unshift(await readFigmaSource(options.figma));
    for (const source of sources) light.push(...source.files);
    const dark: TokenFile[] = [];
    for (const file of options.dark ?? []) dark.push(...(await readTokenFile(file)).files);
    let result: ReturnType<typeof importDesignTokens>;
    try {
      const read = readDesignTokens(light);
      // A file of token sets can hold its dark theme: without --dark it is read from the same files.
      const darkRead = dark.length ? readDesignTokens(dark, { scheme: "dark" }) : read.dark ? readDesignTokens(light, { scheme: "dark" }) : null;
      result = importDesignTokens(read, { acssPrefix: options.prefix, ...(darkRead ? { dark: darkRead } : {}) });
    } catch (error) {
      if (error instanceof TypeError) throw new HistosPublishError(error.message, "tokens-invalid", 2);
      throw error;
    }
    // What a .penpot or a .fig file holds that is not a token is said with the rest that was left out.
    result.report.skipped.push(...sources.flatMap((source) => source.problems));
    const summaries = sources.map((source) => source.summary).filter(Boolean);
    const report = [...summaries, ...(summaries.length ? [""] : []), tokenImportText(result.report, { fromDesign: sources.some((source) => source.kind !== "tokens") })].join("\n");
    const written: Record<string, string> = {
      "histos-css.json": histosCssDesignFile(result.design),
      "acss-valori.json": `${JSON.stringify(result.acss.values, null, 2)}\n`,
      "rapporto.txt": `${report}\n`,
    };
    if (Object.keys(result.siteTokens).length) written["variabili-sito.json"] = `${JSON.stringify({ format: "histeon-variabili-sito", version: 1, variabili: result.siteTokens }, null, 2)}\n`;
    if (result.acss.css) written["acss-variabili.css"] = result.acss.css;
    await mkdir(output);
    for (const [name, text] of Object.entries(written)) await writeFile(path.join(output, name), text, { flag: "wx", mode: 0o644 });
    if (jsonMode()) print({ output, files: Object.keys(written), design: result.design, siteTokens: result.siteTokens, acss: result.acss.values, report: result.report });
    // The names are those of the user's own file: kept as slugs are kept for a refused prototype.
    else process.stdout.write(`${cleanText(`Scritti in ${path.basename(output)}: ${Object.keys(written).join(", ")}.\n\n${report}`, true)}\n`);
  });

/** The pages of a design file and the frames at the top of each, as lines for a terminal. */
function designPagesText(list: DesignPageList): string {
  const lines = [`${list.file} (${list.source === "penpot" ? "Penpot" : "Figma"}): ${list.pages.length === 1 ? "una pagina" : `${list.pages.length} pagine`}.`];
  for (const page of list.pages) {
    lines.push("", `Pagina «${page.name}»${page.frames.length ? "" : ": nessun riquadro"}`);
    for (const frame of page.frames) lines.push(`  «${frame.name}»  ${frame.width} × ${frame.height} px, ${frame.layers === 1 ? "un livello" : `${frame.layers} livelli`}`);
  }
  lines.push("", "Per convertire un riquadro: histos-publish design <file> --pagina <nome> --riquadro <nome> -o prototipo.html");
  return lines.join("\n");
}

// Note penpot-figma-a-histeon.md, phase 3: one frame of a .penpot or .fig file becomes a prototype.
program.command("design")
  .summary("Trasforma un riquadro di un file .penpot o .fig in un prototipo Histeon")
  .description("Legge un file .penpot (esportato da Penpot) o .fig (salvato da Figma), fuori rete e senza credenziali. Senza --pagina stampa le pagine del file e i riquadri in cima a ognuna. Con --pagina e --riquadro (un nome, una parte del nome o l’id) trasforma quel riquadro in un prototipo: sezioni, righe e colonne (dall’auto layout, o dedotte dalle posizioni: mai coordinate), testi sul gradino più vicino della scala (mai una misura fissa), immagini e icone. Scrive il prototipo e, accanto, il rapporto di che cosa è stato dedotto o lasciato fuori. Colori, caratteri e scala presi dagli stili dello stesso file diventano i parametri del design, salvo --senza-stili. L’id del prototipo viene da nome del file, pagina e riquadro: riconvertire lo stesso riquadro aggiorna lo stesso progetto. Poi: histos-publish prototype verify <prototipo>.")
  .argument("<file>", "il file .penpot o .fig")
  .option("--pagina <nome>", "la pagina del design")
  .option("--riquadro <nome>", "il riquadro da convertire (se la pagina ne ha uno solo, è quello)")
  .option("-o, --output <file>", "il file .html del prototipo da creare (uno che esiste già non si sovrascrive)")
  .option("--id <uuid>", "l’id del prototipo, per aggiornare un progetto che esiste")
  .option("--name <nome>", "il nome del progetto")
  .option("--senza-stili", "non leggere colori, caratteri e scala dagli stili del file")
  .option("--senza-componenti", "non riunire in componenti ciò che si ripete: ogni copia resta nel markup del suo blocco")
  .option("--senza-record", "le schede in fila restano usi del loro componente, senza record e loop")
  .option("--schede-uniformi", "le schede in fila prendono tutte lo stile della prima, così diventano record anche se il design mette ogni immagine a mano (cambia l’aspetto)")
  .action(async (file: string, options: { pagina?: string; riquadro?: string; output?: string; id?: string; name?: string; senzaStili?: boolean; senzaComponenti?: boolean; senzaRecord?: boolean; schedeUniformi?: boolean }) => {
    const target = path.resolve(file);
    const name = path.basename(target);
    const info = await lstat(target).catch(() => null);
    if (!info?.isFile()) throw new HistosPublishError(`${name}: serve un file normale (non una cartella o un collegamento).`, "design-file-invalid", 2);
    if (info.size > DESIGN_FILE_MAX) throw new HistosPublishError(`${name}: il file supera ${DESIGN_FILE_MAX / 1024 / 1024} MB.`, "design-file-invalid", 2);
    const bytes = await readFile(target);
    const refuse = (error: unknown): never => {
      if (error instanceof TypeError) throw new HistosPublishError(error.message, "design-file-invalid", 2);
      throw error;
    };
    const list = await designFilePages(name, bytes).catch(refuse);
    if (options.pagina === undefined) {
      if (options.riquadro !== undefined || options.output !== undefined) throw new HistosPublishError("Per convertire un riquadro serve anche --pagina.", "design-invalid", 2);
      if (jsonMode()) print(list);
      else process.stdout.write(`${cleanText(designPagesText(list), true)}\n`);
      return;
    }
    if (!options.output) throw new HistosPublishError("Indica con -o il file .html del prototipo da creare.", "design-invalid", 2);
    const output = path.resolve(options.output);
    if (!/\.html?$/iu.test(output)) throw new HistosPublishError(`${path.basename(output)}: il prototipo è un file .html.`, "design-invalid", 2);
    const reportPath = output.replace(/\.html?$/iu, ".rapporto.txt");
    for (const made of [output, reportPath]) if (await lstat(made).catch(() => null)) throw new HistosPublishError(`${path.basename(made)} esiste già in quella cartella: scegli un altro nome.`, "design-output-exists", 2);
    const folder = await stat(path.dirname(output)).catch(() => null);
    if (!folder?.isDirectory()) throw new HistosPublishError(folder ? `${path.basename(path.dirname(output))} non è una cartella.` : `La cartella ${path.basename(path.dirname(output))} non esiste.`, "design-invalid", 2);
    if (options.id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(options.id)) throw new HistosPublishError("--id: serve un UUID in minuscolo.", "design-invalid", 2);
    // A page with one frame needs no --riquadro; the reader says which frames there are otherwise.
    const listed = list.pages.filter((page) => page.id === options.pagina!.trim().toLowerCase() || page.name.trim().toLowerCase() === options.pagina!.trim().toLowerCase());
    const only = listed.length === 1 && listed[0]!.frames.length === 1 ? listed[0]!.frames[0]!.id : "";
    if (options.riquadro === undefined && !only) throw new HistosPublishError("La pagina ha più di un riquadro: indica quale con --riquadro. L’elenco: histos-publish design <file>", "design-invalid", 2);
    const made = await designFilePrototype(name, bytes, options.pagina, options.riquadro ?? only, { ...(options.id === undefined ? {} : { id: options.id }), ...(options.name === undefined ? {} : { name: options.name }), styles: options.senzaStili !== true, components: options.senzaComponenti !== true, records: options.senzaRecord !== true, uniform: options.schedeUniformi === true }).catch((error: unknown) => {
      if (error instanceof TypeError && error.message.startsWith("Il prototipo supererebbe")) throw new HistosPublishError(error.message, "design-too-large", 2);
      return refuse(error);
    });
    const { id, report } = made;
    await writeFile(output, made.html, { flag: "wx", mode: 0o644 });
    await writeFile(reportPath, `${report}\n`, { flag: "wx", mode: 0o644 });
    if (jsonMode()) print({ output, report: reportPath, id, details: made.details });
    // The names are those of the user's own file: kept as slugs are kept for a refused prototype.
    else process.stdout.write(`${cleanText(`Prototipo scritto: ${path.basename(output)} (id ${id}). Rapporto: ${path.basename(reportPath)}.\n\n${report}\n\nPoi: histos-publish prototype verify ${path.basename(output)}`, true)}\n`);
  });

program.command("agent")
  .description("Avvia l’agente Linux per pubblicare siti WordPress statici su Cloudflare")
  .requiredOption("--config <file>", "file JSON della configurazione agente")
  .action(async (options: { config: string }) => {
    const runtime = await startAgent(path.resolve(options.config));
    const stop = () => { void runtime.stop(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await runtime.closed;
  });

program.command("agent-key")
  .description("Crea una nuova chiave HMAC privata per l’agente")
  .requiredOption("--keys-file <file>", "file privato che contiene le chiavi HMAC")
  .requiredOption("--id <id>", "ID breve della nuova chiave, per esempio desktop-2026")
  .action(async (options: { keysFile: string; id: string }) => {
    const secret = await generateAgentKey(path.resolve(options.keysFile), options.id);
    process.stdout.write(`${JSON.stringify({ id: options.id, secret })}\n`);
  });

program.showHelpAfterError();

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const known = error instanceof HistosPublishError ? error : null;
    const message = known?.message ?? (error instanceof Error ? error.message : "Errore non identificato.");
    // A refused prototype keeps the slugs and template refs of the user's file, in the message and in each problem.
    const clean = (text: string) => cleanText(text, known !== null && listedRefusals.has(known));
    if (jsonMode()) process.stdout.write(`${JSON.stringify({ error: clean(message), code: known?.code ?? "error", ...refusalDetails(known, clean) })}\n`);
    else process.stderr.write(`${clean(message)}\n`);
    process.exitCode = known?.exitCode ?? 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
