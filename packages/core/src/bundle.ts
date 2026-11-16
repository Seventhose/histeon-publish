import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createManifest } from "./manifest.js";
import { isServerExecutablePath, scanFiles } from "./scanner.js";
import { readDirectorySource } from "./filesystem.js";
import { readZipSource } from "./zip.js";
import { buildSingleHtml } from "./html.js";
import { crawlSite } from "./crawler.js";
import { addPagefind } from "./pagefind.js";
import { addFluentForms, FLUENT_FORMS_CLIENT_PATH } from "./forms.js";
import { HistosPublishError, throwIfAborted } from "./errors.js";
import { kvBindingsInWorker, SITE_WORKER_MAX_BYTES, SITE_WORKER_PATH, validateSiteWorker } from "./deploy.js";
import { isPathInside, normalizeRelativePath, safeBundlePath } from "./paths.js";
import type { BuildEvent, BuildOptions, BuildResult, BundleMeta, Finding, SourceKind } from "./types.js";
import type { SourceFile } from "./filesystem.js";

function emit(options: BuildOptions, event: BuildEvent): void {
  try { options.onEvent?.(event); } catch { /* Progress listeners must not break a build. */ }
}

export function detectSource(input: string): { kind: SourceKind; path: string } {
  const value = input.trim();
  if (/^https?:\/\//iu.test(value)) return { kind: "url", path: value };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) throw new HistosPublishError("Sono accettati solo URL http(s) o percorsi locali.", "source-invalid", 2);
  const extension = path.extname(value).toLowerCase();
  if (extension === ".html" || extension === ".htm") return { kind: "html", path: path.resolve(value) };
  if (extension === ".zip") return { kind: "zip", path: path.resolve(value) };
  return { kind: "directory", path: path.resolve(value) };
}

async function buildBundleInternal(options: BuildOptions): Promise<BuildResult> {
  throwIfAborted(options.signal);
  emit(options, { type: "start", sourceKind: options.source.kind });
  let sourceFiles: SourceFile[];
  let skipped: string[];
  let findings: Finding[];
  let report: BuildResult["report"];
  let redirects: BuildResult["redirects"];

  const maxBytes = options.maxBytes;
  const readOptions = {
    ...(options.include === undefined ? {} : { include: options.include }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  switch (options.source.kind) {
    case "directory": {
      const result = await readDirectorySource(options.source.path, readOptions);
      sourceFiles = result.files;
      skipped = result.skipped;
      findings = result.findings;
      break;
    }
    case "zip": {
      const result = await readZipSource(options.source.path, {
        ...(maxBytes === undefined ? {} : { maxBytes }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      sourceFiles = result.files;
      skipped = result.skipped;
      findings = result.findings;
      break;
    }
    case "html": {
      const result = await buildSingleHtml(options.source.path, options.source.root, {
        ...(maxBytes === undefined ? {} : { maxBytes }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      sourceFiles = result.files;
      skipped = result.skipped;
      findings = result.findings;
      break;
    }
    case "url":
    {
      const result = await crawlSite({
        sourceUrl: options.source.path,
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
        ...(options.include === undefined ? {} : { include: options.include }),
        ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
        ...(options.crawl === undefined ? {} : { crawl: options.crawl }),
        ...(options.rewrite === undefined ? {} : { rewrite: options.rewrite }),
        ...(options.dynamic === undefined ? {} : { dynamic: options.dynamic }),
        ...(maxBytes === undefined ? {} : { maxBytes }),
        ...(options.cacheDirectory === undefined ? {} : { cacheDirectory: options.cacheDirectory }),
        ...(options.crawlConsent === undefined ? {} : { crawlConsent: options.crawlConsent }),
        ...(options.renderPage === undefined ? {} : { renderPage: options.renderPage }),
        ...(options.privateOrigin === undefined ? {} : { privateOrigin: options.privateOrigin }),
        ...(options.strictOrigin === undefined ? {} : { strictOrigin: options.strictOrigin }),
        ...(options.originHeaders === undefined ? {} : { originHeaders: options.originHeaders }),
        ...(options.requireEcho === undefined ? {} : { requireEcho: options.requireEcho }),
        ...(options.seedPaths === undefined ? {} : { seedPaths: options.seedPaths }),
        ...(options.notFoundProbe === undefined ? {} : { notFoundProbe: options.notFoundProbe }),
        ...(options.blockNativeHistosForms === undefined ? {} : { blockNativeHistosForms: options.blockNativeHistosForms }),
        ...(options.forbiddenValues === undefined ? {} : { forbiddenValues: options.forbiddenValues }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      });
      sourceFiles = result.files;
      skipped = result.skipped;
      findings = result.findings;
      report = result.report;
      redirects = result.redirects;
      break;
    }
    case "cms":
      // The project builds itself from Histeon CMS: this site only receives its builds.
      throw new HistosPublishError("Questo sito pubblica un progetto Histeon CMS: crea la build dal progetto.", "source-cms", 2);
    default: {
      const unhandled: never = options.source.kind;
      throw new HistosPublishError(`Sorgente non supportata: ${String(unhandled)}`, "source-invalid", 2);
    }
  }

  throwIfAborted(options.signal);
  emit(options, { type: "progress", phase: "scan", completed: sourceFiles.length, total: sourceFiles.length });
  if (!sourceFiles.some((file) => file.path.toLowerCase() === "index.html")) {
    findings.push({ code: "missing-index", severity: "warn", file: "index.html", message: "La cartella non contiene index.html nella radice." });
  }
  const safeFiles: SourceFile[] = [];
  for (const file of sourceFiles) {
    if (file.path === ".histos-publish" || file.path.startsWith(".histos-publish/")) {
      findings.push({ code: "reserved-internal-path", severity: "block", file: file.path, message: "Il percorso è riservato ai metadati interni del bundle." });
      skipped.push(file.path);
      continue;
    }
    if (isServerExecutablePath(file.path)) {
      findings.push({ code: "server-executable-file", severity: "block", file: file.path, message: "Il bundle contiene un file eseguibile lato server." });
      skipped.push(file.path);
      continue;
    }
    const normalized = normalizeRelativePath(file.path);
    if (!normalized || normalized.path !== file.path || !safeBundlePath(`/${file.path}`)) {
      findings.push({ code: "unsafe-bundle-path", severity: "block", file: file.path, message: "Il percorso non può essere pubblicato in sicurezza." });
      skipped.push(file.path);
      continue;
    }
    safeFiles.push(file);
  }
  sourceFiles = safeFiles;
  let worker: BuildResult["worker"];
  const ownWorker = sourceFiles.find((file) => file.path === SITE_WORKER_PATH);
  if (options.workerPath !== undefined) {
    if (ownWorker) {
      throw new HistosPublishError(`I file del sito contengono già ${SITE_WORKER_PATH} e il sito ha anche un codice del Worker caricato a parte: tieni uno dei due.`, "site-worker-duplicate", 2);
    }
    let bytes: Buffer;
    try {
      const info = await stat(options.workerPath);
      if (!info.isFile() || info.size > SITE_WORKER_MAX_BYTES) throw new Error("size");
      bytes = await readFile(options.workerPath);
    } catch {
      throw new HistosPublishError("Il codice del Worker del sito non è leggibile o supera 3 MiB: caricalo di nuovo dalla pagina del sito.", "site-worker-missing", 2);
    }
    const kv = kvBindingsInWorker(validateSiteWorker(bytes));
    sourceFiles.push({ path: SITE_WORKER_PATH, bytes });
    worker = { origin: "file", bytes: bytes.byteLength, ...(kv.length ? { kv } : {}) };
  } else if (ownWorker) {
    const kv = kvBindingsInWorker(validateSiteWorker(ownWorker.bytes));
    worker = { origin: "source", bytes: ownWorker.bytes.byteLength, ...(kv.length ? { kv } : {}) };
  } else {
    const lookalike = sourceFiles.find((file) => file.path === "worker.js" && /\bexport\s+default\b/u.test(file.bytes.subarray(0, 512 * 1024).toString("utf8")));
    if (lookalike) {
      findings.push({ code: "worker-js-public", severity: "warn", file: lookalike.path, message: `worker.js sembra il codice di un Worker, ma verrà pubblicato come file pubblico. Per usarlo come codice del server rinominalo ${SITE_WORKER_PATH} oppure caricalo come codice del Worker nella pagina del sito.` });
    }
  }
  let forms: BuildResult["forms"];
  if (options.forms?.wordpress) {
    if (sourceFiles.some((file) => file.path.toLowerCase() === FLUENT_FORMS_CLIENT_PATH.toLowerCase())) {
      throw new HistosPublishError(`Il percorso ${FLUENT_FORMS_CLIENT_PATH} è riservato all’invio dei moduli. Rinomina il file sorgente e ripeti la build.`, "reserved-generated-path", 2);
    }
    emit(options, { type: "progress", phase: "forms", completed: 0, total: 1 });
    const transformed = await addFluentForms(sourceFiles, options.forms, options.signal);
    if (transformed) {
      sourceFiles = transformed.files;
      forms = transformed.report;
      findings.push(...transformed.findings);
      if (report) report.dynamicFeatures = report.dynamicFeatures.filter((feature) => !(feature.code === "fluent-forms" && transformed.linkedFiles.includes(feature.file)));
      emit(options, { type: "progress", phase: "forms", completed: 1, total: 1 });
    }
  }
  let pagefind: BuildResult["pagefind"];
  if (options.pagefind === true) {
    if (sourceFiles.some((file) => /^pagefind\//iu.test(file.path))) {
      throw new HistosPublishError("La cartella pagefind/ è riservata alla ricerca generata. Rinomina i file sorgente e ripeti la build.", "reserved-generated-path", 2);
    }
    const pages = sourceFiles.filter((file) => /\.html?$/iu.test(file.path)).length;
    emit(options, { type: "progress", phase: "pagefind", completed: 0, total: pages });
    const indexed = await addPagefind(sourceFiles, options.signal);
    sourceFiles = indexed.files;
    pagefind = { enabled: true, indexedPages: indexed.indexedPages };
    for (const file of indexed.missingLanguage) {
      findings.push({ code: "pagefind-language-missing", severity: "warn", file, message: "La pagina non dichiara la lingua HTML; Pagefind non può scegliere automaticamente la traduzione appropriata della ricerca." });
    }
    emit(options, { type: "progress", phase: "pagefind", completed: indexed.indexedPages, total: indexed.indexedPages });
  }
  findings.push(...scanFiles(sourceFiles.map((file) => ({ path: file.path, size: file.bytes.byteLength, contents: file.bytes }))));
  skipped = [...new Set(skipped)].sort();
  findings = [...new Map(findings.map((finding) => [`${finding.code}\u0000${finding.file}\u0000${finding.line ?? 0}`, finding])).values()]
    .sort((left, right) => left.file.localeCompare(right.file, "en") || left.code.localeCompare(right.code, "en"));
  findings.forEach((finding) => {
    emit(options, { type: "finding", finding });
  });
  const blocked = findings.some((finding) => finding.severity === "block");
  const manifest = createManifest(sourceFiles.map((file) => ({
    path: file.path,
    size: file.bytes.byteLength,
    bytes: file.bytes,
    ...(file.sourcePath === undefined ? {} : { sourcePath: file.sourcePath }),
  })));
  const totalBytes = sourceFiles.reduce((total, file) => total + file.bytes.byteLength, 0);
  let bundlePath: string | undefined;

  if (!options.checkOnly) {
    let sourceBoundary: string | undefined;
    if (options.source.kind === "directory") sourceBoundary = await realpath(options.source.path);
    else if (options.source.kind === "html") sourceBoundary = await realpath(options.source.root ?? path.dirname(options.source.path));
    else if (options.source.kind === "zip") sourceBoundary = await realpath(options.source.path);
    if (options.outputDirectory) {
      bundlePath = path.resolve(options.outputDirectory);
      if (sourceBoundary && (isPathInside(bundlePath, sourceBoundary) || isPathInside(sourceBoundary, bundlePath))) {
        throw new HistosPublishError("La cartella di output non può coincidere con la sorgente o trovarsi al suo interno.", "output-overlaps-source", 2);
      }
      try { await mkdir(bundlePath, { recursive: false }); }
      catch { throw new HistosPublishError("La cartella di output esiste già o non è scrivibile.", "output-exists", 2); }
    } else {
      bundlePath = await mkdtemp(path.join(os.tmpdir(), "histos-publish-"));
      if (sourceBoundary && (isPathInside(bundlePath, sourceBoundary) || isPathInside(sourceBoundary, bundlePath))) {
        await rm(bundlePath, { recursive: true, force: true });
        throw new HistosPublishError("La cartella temporanea si sovrappone alla sorgente; specifica una cartella di output esterna.", "output-overlaps-source", 2);
      }
    }
    try {
      for (const file of sourceFiles) {
        throwIfAborted(options.signal);
        const target = path.resolve(bundlePath, ...file.path.split("/"));
        if (!isPathInside(bundlePath, target)) throw new HistosPublishError("Il bundle contiene un percorso fuori dalla cartella di output.", "unsafe-output-path", 2);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.bytes, { flag: "wx" });
      }
      const pages = sourceFiles.filter((file) => /\.html?$/iu.test(file.path)).length;
      const meta: BundleMeta & { status: "ready" | "blocked" } = {
        schemaVersion: 1,
        sourceKind: options.source.kind,
        sourcePath: options.source.kind === "url" ? (() => { const source = new URL(options.source.path); source.search = ""; source.hash = ""; return source.href; })() : options.source.path,
        createdAt: new Date().toISOString(),
        pages,
        assets: sourceFiles.length - pages,
        files: sourceFiles.length,
        totalBytes,
        skipped,
        findings,
        ...(redirects === undefined ? {} : { redirects }),
        ...(report === undefined ? {} : { report }),
        ...(pagefind === undefined ? {} : { pagefind }),
        ...(forms === undefined ? {} : { forms }),
        ...(worker === undefined ? {} : { worker }),
        status: blocked ? "blocked" : "ready",
      };
      const metadataDirectory = path.join(bundlePath, ".histos-publish");
      await mkdir(metadataDirectory, { recursive: false });
      await writeFile(path.join(metadataDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      await writeFile(path.join(metadataDirectory, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { flag: "wx" });
      emit(options, { type: "progress", phase: "copy", completed: sourceFiles.length, total: sourceFiles.length });
    } catch (error) {
      await rm(bundlePath, { recursive: true, force: true });
      throw error;
    }
  }

  emit(options, { type: "complete", files: sourceFiles.length, bytes: totalBytes, blocked });
  return {
    status: blocked ? "blocked" : "ready",
    sourceKind: options.source.kind,
    ...(bundlePath === undefined ? {} : { bundlePath }),
    files: sourceFiles.length,
    pages: sourceFiles.filter((file) => /\.html?$/iu.test(file.path)).length,
    assets: sourceFiles.filter((file) => !/\.html?$/iu.test(file.path)).length,
    totalBytes,
    skipped,
    findings,
    manifest,
    ...(report === undefined ? {} : { report }),
    ...(redirects === undefined ? {} : { redirects }),
    ...(pagefind === undefined ? {} : { pagefind }),
    ...(forms === undefined ? {} : { forms }),
    ...(worker === undefined ? {} : { worker }),
  };
}

export async function buildBundle(options: BuildOptions): Promise<BuildResult> {
  try {
    return await buildBundleInternal(options);
  } catch (error) {
    if (error instanceof HistosPublishError && error.code === "cancelled") emit(options, { type: "cancelled" });
    throw error;
  }
}
