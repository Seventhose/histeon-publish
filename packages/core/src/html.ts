import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import * as parse5 from "parse5";
import { HistosPublishError, throwIfAborted } from "./errors.js";
import { isPathInside, normalizeRelativePath, relativeUrl } from "./paths.js";
import { collectCssUrls, rewriteCssUrls } from "./css.js";
import { parseSrcsetCandidates, rewriteSrcset } from "./srcset.js";
import type { Finding } from "./types.js";
import { DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_BYTES, type SourceFile } from "./filesystem.js";

interface HtmlAttribute { name: string; value: string }
interface HtmlNode {
  tagName?: string;
  nodeName?: string;
  attrs?: HtmlAttribute[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  value?: string;
}

export interface SingleHtmlResult {
  files: SourceFile[];
  skipped: string[];
  findings: Finding[];
}

function splitSuffix(raw: string): { pathname: string; suffix: string } {
  const index = raw.search(/[?#]/u);
  return index < 0 ? { pathname: raw, suffix: "" } : { pathname: raw.slice(0, index), suffix: raw.slice(index) };
}

function isExternalUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(value.trim());
}

function walk(node: HtmlNode, visit: (item: HtmlNode) => void): void {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function localReferencesInHtml(html: string): string[] {
  const document = parse5.parse(html) as unknown as HtmlNode;
  const references: string[] = [];
  walk(document, (node) => {
    const tag = node.tagName?.toLowerCase();
    for (const attribute of node.attrs ?? []) {
      const name = attribute.name.toLowerCase();
      const allowed = name === "src" || name === "poster" || name === "data-src" || name === "xlink:href" || (name === "href" && tag === "link");
      if (allowed && !isExternalUrl(attribute.value)) references.push(attribute.value);
      if (name === "srcset" && !isExternalUrl(attribute.value)) {
        for (const candidate of parseSrcsetCandidates(attribute.value)) if (!isExternalUrl(candidate.url)) references.push(candidate.url);
      }
      if (name === "style") references.push(...collectCssUrls(attribute.value).filter((url) => !isExternalUrl(url)));
    }
    if (tag === "style") {
      const text = (node.childNodes ?? []).map((child) => child.value ?? "").join("");
      references.push(...collectCssUrls(text).filter((url) => !isExternalUrl(url)));
    }
  });
  return [...new Set(references)];
}

function rewriteHtmlResources(html: string, replacements: ReadonlyMap<string, string>): string {
  const document = parse5.parse(html) as unknown as HtmlNode;
  walk(document, (node) => {
    const tag = node.tagName?.toLowerCase();
    for (const attribute of node.attrs ?? []) {
      const name = attribute.name.toLowerCase();
      if (name === "srcset") {
        attribute.value = rewriteSrcset(attribute.value, (url) => replacements.get(url) ?? url);
      } else if (name === "style") {
        attribute.value = rewriteCssUrls(attribute.value, replacements);
      } else if (name === "src" || name === "poster" || name === "data-src" || name === "xlink:href" || (name === "href" && tag === "link")) {
        attribute.value = replacements.get(attribute.value) ?? attribute.value;
      }
    }
    if (tag === "style") {
      for (const child of node.childNodes ?? []) {
        if (child.value !== undefined) child.value = rewriteCssUrls(child.value, replacements);
      }
    }
  });
  return parse5.serialize(document as never);
}

export async function buildSingleHtml(
  sourcePath: string,
  allowedRoot?: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<SingleHtmlResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const source = await realpath(sourcePath).catch(() => {
    throw new HistosPublishError("Il file HTML non esiste o non è accessibile.", "source-unreachable", 5);
  });
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile()) throw new HistosPublishError("La sorgente HTML non è un file regolare.", "source-invalid", 2);
  if (sourceStat.size > maxBytes) throw new HistosPublishError("Il file HTML supera il limite di dimensione consentito.", "source-too-large", 2);
  const root = await realpath(allowedRoot ?? path.dirname(source)).catch(() => {
    throw new HistosPublishError("La radice consentita non esiste o non è accessibile.", "source-invalid", 2);
  });
  if (!isPathInside(root, source)) throw new HistosPublishError("Il file HTML è fuori dalla radice consentita.", "source-outside-root", 2);
  const input = await readFile(source);
  throwIfAborted(options.signal);
  const html = input.toString("utf8");
  const findings: Finding[] = [];
  const skipped: string[] = [];
  const copied = new Map<string, SourceFile>();
  const replacementMap = new Map<string, string>();
  const queue: Array<{ raw: string; from: string }> = localReferencesInHtml(html).map((raw) => ({ raw, from: source }));
  const rootReal = root;
  let totalBytes = input.byteLength;

  while (queue.length > 0) {
    throwIfAborted(options.signal);
    if (copied.size >= DEFAULT_MAX_FILES) throw new HistosPublishError(`Il file HTML usa più di ${DEFAULT_MAX_FILES} risorse locali.`, "source-too-many-files", 2);
    const current = queue.shift();
    if (!current) continue;
    const raw = current.raw.trim();
    if (/^(?:file:|[A-Za-z]:[\\/])/iu.test(raw)) {
      findings.push({ code: "filesystem-url", severity: "block", file: "index.html", message: "L'HTML contiene un percorso assoluto del filesystem." });
      continue;
    }
    if (isExternalUrl(raw)) continue;
    const { pathname, suffix } = splitSuffix(raw);
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { decoded = pathname; }
    const base = decoded.startsWith("/") ? rootReal : path.dirname(current.from);
    const candidate = path.resolve(base, decoded);
    if (!isPathInside(rootReal, candidate)) {
      findings.push({ code: "asset-outside-root", severity: "block", file: "index.html", message: "Una risorsa esce dalla radice consentita." });
      continue;
    }
    const realAsset = await realpath(candidate).catch(() => null);
    if (!realAsset || !isPathInside(rootReal, realAsset)) {
      const label = path.relative(rootReal, candidate).split(path.sep).join("/") || pathname;
      skipped.push(label);
      findings.push({ code: "missing-local-asset", severity: "warn", file: "index.html", message: "Una risorsa locale referenziata non è stata trovata." });
      continue;
    }
    const stat = await lstat(realAsset);
    if (!stat.isFile()) {
      skipped.push(path.relative(rootReal, realAsset).split(path.sep).join("/"));
      findings.push({ code: "invalid-local-asset", severity: "block", file: "index.html", message: "Una risorsa referenziata non è un file regolare." });
      continue;
    }
    const relative = normalizeRelativePath(path.relative(rootReal, realAsset).split(path.sep).join("/"));
    if (!relative) {
      findings.push({ code: "unsafe-path", severity: "block", file: "index.html", message: "Una risorsa ha un nome non sicuro." });
      continue;
    }
    const outputPath = relative.path.startsWith("assets/") ? relative.path : `assets/${relative.path}`;
    const outputUrl = `${relativeUrl("index.html", outputPath)}${suffix}`;
    replacementMap.set(current.raw, outputUrl);
    replacementMap.set(raw, outputUrl);
    replacementMap.set(pathname, `${relativeUrl("index.html", outputPath)}`);

    if (copied.has(realAsset)) continue;
    if (totalBytes + stat.size > maxBytes) throw new HistosPublishError("Le risorse del file HTML superano il limite di dimensione consentito.", "source-too-large", 2);
    const bytes = await readFile(realAsset);
    totalBytes += bytes.byteLength;
    copied.set(realAsset, { path: outputPath, bytes, sourcePath: realAsset });
    if (path.extname(realAsset).toLowerCase() === ".css") {
      const css = bytes.toString("utf8");
      for (const url of collectCssUrls(css)) if (!isExternalUrl(url)) queue.push({ raw: url, from: realAsset });
    }
  }

  const rewrittenHtml = rewriteHtmlResources(html, replacementMap);
  const files: SourceFile[] = [{ path: "index.html", bytes: Buffer.from(rewrittenHtml, "utf8"), sourcePath: source }];
  files.push(...[...copied.values()].sort((left, right) => left.path.localeCompare(right.path, "en")));

  // Rewrite CSS references after the complete asset graph has been collected.
  const sourceToOutput = new Map<string, string>();
  for (const [sourceAsset, file] of copied) sourceToOutput.set(sourceAsset, file.path);
  for (const file of files) {
    throwIfAborted(options.signal);
    if (path.extname(file.path).toLowerCase() !== ".css") continue;
    const sourceAsset = file.sourcePath;
    if (!sourceAsset) continue;
    const cssReplacements = new Map<string, string>();
    for (const raw of collectCssUrls(file.bytes.toString("utf8"))) {
      if (isExternalUrl(raw)) continue;
      const { pathname, suffix } = splitSuffix(raw);
      let decoded = pathname;
      try { decoded = decodeURIComponent(pathname); } catch { /* Keep malformed percent escapes unchanged. */ }
      const sourceTarget = path.resolve(path.dirname(sourceAsset), decoded);
      const mapped = sourceToOutput.get(sourceTarget) ?? sourceToOutput.get(await realpath(sourceTarget).catch(() => ""));
      if (mapped) cssReplacements.set(raw, `${relativeUrl(file.path, mapped)}${suffix}`);
    }
    file.bytes = Buffer.from(rewriteCssUrls(file.bytes.toString("utf8"), cssReplacements), "utf8");
    file.size = file.bytes.byteLength;
  }
  if (files.reduce((total, file) => total + file.bytes.byteLength, 0) > maxBytes) {
    throw new HistosPublishError("Le risorse riscritte superano il limite di dimensione consentito.", "source-too-large", 2);
  }
  return { files, skipped: [...new Set(skipped)].sort(), findings };
}
