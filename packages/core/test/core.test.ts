import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBundle, collectCssUrls, createManifest, exportBundle, formatSrcsetCandidate, parseSiteConfig, parseSrcsetCandidates, pageFileForPath, readDirectorySource, readZipSource, rewriteCssUrls, safeBundlePath, scanFiles, assetHash, assetContentType } from "../src/index.js";
import vectors from "./fixtures/manifest-vectors.json" with { type: "json" };

const temporaryDirectories: string[] = [];
const temporaryBundles: string[] = [];

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(entries: Array<{ name: string; contents: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.contents.byteLength, 18);
    local.writeUInt32LE(entry.contents.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    localParts.push(local, name, entry.contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.contents.byteLength, 20);
    central.writeUInt32LE(entry.contents.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.byteLength + name.byteLength + entry.contents.byteLength;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function keepBundle(bundlePath: string | undefined): string {
  if (!bundlePath) throw new Error("La build non ha creato il bundle atteso.");
  temporaryBundles.push(bundlePath);
  return bundlePath;
}

afterEach(async () => {
  await Promise.all([...temporaryBundles.splice(0), ...temporaryDirectories.splice(0)].map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("percorsi e manifest", () => {
  it("applica le regole safe_path e mappa le pagine", () => {
    expect(safeBundlePath("/")).toBe(true);
    expect(safeBundlePath("/guide/")).toBe(true);
    expect(safeBundlePath("guide/")).toBe(false);
    expect(safeBundlePath("/a/../b")).toBe(false);
    expect(safeBundlePath("/a\\b")).toBe(false);
    expect(safeBundlePath("/index.php")).toBe(false);
    expect(pageFileForPath("/")).toBe("index.html");
    expect(pageFileForPath("/guide/")).toBe("guide/index.html");
  });

  it("senza tipo coincide con i vettori dell'algoritmo PHP di Histeon; il manifest aggiunge il tipo", () => {
    for (const vector of vectors) {
      const bytes = Buffer.from(vector.contentsBase64, "base64");
      expect(bytes.byteLength).toBe(vector.size);
      expect(assetHash(bytes, vector.extension)).toBe(vector.hash);
      expect(createManifest([{ path: vector.path, size: vector.size, bytes }])[`/${vector.path}`]).toEqual({
        hash: assetHash(bytes, vector.extension, assetContentType(vector.path)),
        size: vector.size,
      });
    }
  });

  it("codifica in URI i segmenti del manifest Cloudflare", () => {
    const bytes = Buffer.from("immagine");
    const manifest = createManifest([{ path: "immagini/città nuova.webp", size: bytes.byteLength, bytes }]);
    expect(Object.keys(manifest)).toEqual(["/immagini/citt%C3%A0%20nuova.webp"]);
    expect(manifest["/immagini/citt%C3%A0%20nuova.webp"]).toEqual({ hash: assetHash(bytes, "webp", "image/webp"), size: bytes.byteLength });
  });

  it("rifiuta campi di configurazione non previsti, inclusi i segreti", () => {
    expect(parseSiteConfig({ schemaVersion: 1, name: "Demo", source: { kind: "directory", path: "/tmp/demo" } }).name).toBe("Demo");
    expect(() => parseSiteConfig({ schemaVersion: 1, name: "Demo", source: { kind: "directory", path: "/tmp/demo" }, apiToken: "never-store" })).toThrow(/non valida/iu);
    // E6: a site that publishes a CMS project holds only the project's id, and has no build of its own.
    const project = "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10";
    expect(parseSiteConfig({ schemaVersion: 1, name: "Demo", source: { kind: "cms", path: project } }).source).toEqual({ kind: "cms", path: project });
    for (const source of [{ kind: "cms", path: "/tmp/demo" }, { kind: "cms", path: project, root: "/tmp" }]) expect(() => parseSiteConfig({ schemaVersion: 1, name: "Demo", source })).toThrow(/progetto Histeon CMS/u);
    expect(() => parseSiteConfig({ schemaVersion: 1, name: "Demo", source: { kind: "cms", path: project }, crawl: { render: true } })).toThrow(/progetto Histeon CMS/u);
  });
});

describe("parser CSS e srcset", () => {
  it("raccoglie e riscrive URL CSS inclusi gli import", () => {
    const css = '@import "./theme.css"; .hero { background: url("../img/a b.webp") }';
    expect(collectCssUrls(css)).toEqual(["../img/a b.webp", "./theme.css"]);
    expect(rewriteCssUrls(css, new Map([["./theme.css", "theme.css"], ["../img/a b.webp", "img/a%20b.webp"]]))).toContain('url("img/a%20b.webp")');
  });

  it("preserva i descrittori srcset e riscrive le URL", () => {
    const candidates = parseSrcsetCandidates("small.webp 480w, large.webp 960w");
    expect(candidates).toHaveLength(2);
    const firstCandidate = candidates[0];
    if (!firstCandidate) throw new Error("Manca il candidato srcset atteso.");
    expect(formatSrcsetCandidate(firstCandidate)).toBe("small.webp 480w");
  });
});

describe("scanner e bundle", () => {
  it("applica include ed exclude con globstar senza perdere file ammessi", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "docs", "guide"), { recursive: true });
    await mkdir(path.join(root, "docs", "private"), { recursive: true });
    await writeFile(path.join(root, "docs", "index.html"), "home");
    await writeFile(path.join(root, "docs", "guide", "index.html"), "guide");
    await writeFile(path.join(root, "docs", "private", "index.html"), "private");
    const result = await readDirectorySource(root, { include: ["docs/**/index.html"], exclude: ["docs/private/**"] });
    expect(result.files.map((file) => file.path)).toEqual(["docs/guide/index.html", "docs/index.html"]);
  });

  it("una cartella in git non blocca: .git e node_modules sono esclusi prima del controllo dei file privati", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, ".git", "objects"), { recursive: true });
    await writeFile(path.join(root, ".git", "config"), "[core]");
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "debug.log"), "log");
    await writeFile(path.join(root, "index.html"), "home");
    const result = await readDirectorySource(root);
    expect(result.files.map((file) => file.path)).toEqual(["index.html"]);
    expect(result.findings).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining([".git", "node_modules"]));
    // A private file outside the excludes still blocks.
    await writeFile(path.join(root, "backup.sql"), "dump");
    expect((await readDirectorySource(root)).findings).toContainEqual(expect.objectContaining({ code: "sensitive-file", file: "backup.sql" }));
  });

  it("blocca segreti senza copiarli nei finding", () => {
    const secret = "ghp_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const findings = scanFiles([{ path: "index.html", size: secret.length, contents: Buffer.from(`<p>${secret}</p>`) }]);
    expect(findings.some((finding) => finding.severity === "block")).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("blocca un nonce effettivo ma non la sola API che lo gestisce", () => {
    const sourceReference = 'function sendRequest() { return { "X-WP-Nonce": settings.nonce }; }';
    const token = 'window.wpApiSettings = { "nonce": "0123456789" };';
    const actualNonce = scanFiles([{ path: "index.js", size: token.length, contents: Buffer.from(token) }]);
    const referenceOnly = scanFiles([{ path: "assets/wp.js", size: sourceReference.length, contents: Buffer.from(sourceReference) }]);
    expect(actualNonce.some((finding) => finding.code === "wordpress-nonce" && finding.severity === "block")).toBe(true);
    expect(referenceOnly.some((finding) => finding.code === "wordpress-nonce")).toBe(false);
  });

  it("propaga annullamento e evento finale", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: string[] = [];
    await expect(buildBundle({
      source: { kind: "directory", path: "/tmp/non-usata" },
      signal: controller.signal,
      onEvent: (event) => events.push(event.type),
    })).rejects.toMatchObject({ code: "cancelled", exitCode: 6 });
    expect(events).toEqual(["cancelled"]);
  });

  it("blocca .env e impedisce l'esportazione", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "index.html"), "<!doctype html><h1>Demo</h1>");
    await writeFile(path.join(root, ".env"), "TOKEN=private-value");
    const bundle = await buildBundle({ source: { kind: "directory", path: root } });
    const bundlePath = keepBundle(bundle.bundlePath);
    expect(bundle.status).toBe("blocked");
    expect(bundle.findings.some((finding) => finding.code === "sensitive-file")).toBe(true);
    await expect(exportBundle(bundlePath, path.join(root, "out.zip"))).rejects.toMatchObject({ code: "scan-blocked", exitCode: 3 });
  });

  it("mantiene un manifest PWA della sorgente separato dai metadati del bundle", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "index.html"), "<!doctype html><h1>Demo</h1>");
    await writeFile(path.join(root, "manifest.json"), '{"name":"Demo"}');
    const result = await buildBundle({ source: { kind: "directory", path: root } });
    const bundlePath = keepBundle(result.bundlePath);
    expect(await readFile(path.join(bundlePath, "manifest.json"), "utf8")).toBe('{"name":"Demo"}');
    const internalManifest = JSON.parse(await readFile(path.join(bundlePath, ".histos-publish", "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(internalManifest["/manifest.json"]).toBeDefined();
  });

  it("include le risorse fuori dalla cartella del file solo entro la radice", async () => {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "proposte"));
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "proposte", "pagina.html"), '<img src="../assets/copertina.webp" srcset="../assets/copertina.webp 1x">');
    await writeFile(path.join(root, "assets", "copertina.webp"), Buffer.from([1, 2, 3]));
    const result = await buildBundle({ source: { kind: "html", path: path.join(root, "proposte", "pagina.html"), root } });
    const bundlePath = keepBundle(result.bundlePath);
    expect(result.status).toBe("ready");
    const output = await readFile(path.join(bundlePath, "index.html"), "utf8");
    expect(output).toContain("assets/copertina.webp");
    expect(await readFile(path.join(bundlePath, "assets", "copertina.webp"))).toEqual(Buffer.from([1, 2, 3]));
  });

  it("segnala una risorsa singola che esce dalla radice consentita", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "allowed");
    await mkdir(root);
    await writeFile(path.join(parent, "secret.webp"), Buffer.from([1]));
    await writeFile(path.join(root, "page.html"), '<img src="../secret.webp">');
    const result = await buildBundle({ source: { kind: "html", path: path.join(root, "page.html"), root } });
    keepBundle(result.bundlePath);
    expect(result.status).toBe("blocked");
    expect(result.findings.some((finding) => finding.code === "asset-outside-root")).toBe(true);
  });
});

describe("ZIP sicuri", () => {
  it("rifiuta zip-slip prima di leggere o estrarre il contenuto", async () => {
    const root = await temporaryDirectory();
    const zipPath = path.join(root, "unsafe.zip");
    const zipBytes = makeStoredZip([{ name: "../escape.txt", contents: Buffer.from("no") }, { name: "index.html", contents: Buffer.from("ok") }]);
    await writeFile(zipPath, zipBytes);
    await expect(readZipSource(zipPath)).rejects.toMatchObject({ code: "zip-invalid", exitCode: 2 });
  });

  it("dice il limite di dimensione davvero applicato, non sempre 512 MiB", async () => {
    const root = await temporaryDirectory();
    const zipPath = path.join(root, "grande.zip");
    await writeFile(zipPath, makeStoredZip([{ name: "index.html", contents: Buffer.alloc(3 * 1024 * 1024, 32) }]));
    await expect(readZipSource(zipPath, { maxBytes: 2 * 1024 * 1024 })).rejects.toMatchObject({ code: "zip-too-large", message: "Il contenuto estratto del ZIP supera il limite di 2 MiB." });
    await expect(readZipSource(zipPath, { maxBytes: 1000 })).rejects.toMatchObject({ code: "zip-too-large", message: "Il contenuto estratto del ZIP supera il limite di 1000 byte." });
  });
});

describe("Pagefind opt-in", () => {
  it("resta spento per default", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "index.html"), '<html lang="it"><body><h1>Ricerca locale</h1></body></html>');
    const result = await buildBundle({ source: { kind: "directory", path: root }, checkOnly: true });
    expect(result.pagefind).toBeUndefined();
    expect(Object.keys(result.manifest).some((file) => file.startsWith("/pagefind/"))).toBe(false);
  });

  it("genera UI e indice statici, escludendo 404 e pagine noindex", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "index.html"), '<!doctype html><html lang="it"><head><title>Ricerca</title></head><body><main><h1>Liturgia comune</h1><p>Caffè, accenti e ricerca locale.</p></main></body></html>');
    await writeFile(path.join(root, "riservato.html"), '<!doctype html><html lang="it"><head><meta name="robots" content="noindex,follow"></head><body><h1>CANARY-RISERVATO-742</h1></body></html>');
    await writeFile(path.join(root, "404.html"), '<!doctype html><html lang="it"><body><h1>CANARY-404-315</h1></body></html>');
    const result = await buildBundle({ source: { kind: "directory", path: root }, pagefind: true, checkOnly: true });
    expect(result.status).toBe("ready");
    expect(result.pagefind).toEqual({ enabled: true, indexedPages: 1 });
    expect(Object.keys(result.manifest)).toContain("/pagefind/pagefind-component-ui.js");
    expect(Object.keys(result.manifest)).toContain("/pagefind/pagefind-component-ui.css");
    expect(result.findings.some((finding) => finding.code === "pagefind-language-missing")).toBe(false);
    const original = await readFile(path.join(root, "index.html"));
    expect(result.manifest["/index.html"]).not.toEqual(createManifest([{ path: "index.html", size: original.byteLength, bytes: original }])["/index.html"]);
  });

  it("serializza build simultanee usando il servizio nativo Pagefind", async () => {
    const roots = await Promise.all([temporaryDirectory(), temporaryDirectory()]);
    await Promise.all(roots.map((root, index) => writeFile(path.join(root, "index.html"), `<html lang="it"><body><h1>Indice ${index}</h1></body></html>`)));
    const results = await Promise.all(roots.map((root) => buildBundle({ source: { kind: "directory", path: root }, pagefind: true, checkOnly: true })));
    expect(results.map((result) => result.pagefind?.indexedPages)).toEqual([1, 1]);
    expect(results.every((result) => Object.keys(result.manifest).some((item) => item.startsWith("/pagefind/")))).toBe(true);
  });
});

describe("Fluent Forms configurabile", () => {
  const config = {
    wordpress: {
      restUrl: "https://wp.example.test/wp-json/",
      fluentFormIds: [123],
      turnstileSiteKey: "site-key-test",
    },
  };

  it("collega gli ID configurati e prepara UI e route same-origin", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "index.html"), '<!doctype html><html lang="it"><head><title>Contatto</title></head><body><div class="fluentform fluentform_wrapper_123"><form id="fluentform_123" class="frm-fluent-form fluent_form_123" data-form_id="123" method="POST"><input type="hidden" name="__fluent_form_embded_post_id" value="8"><input type="hidden" name="_wp_http_referer" value="/contatti/"><label>Nome <input name="names[first_name]"></label><button class="ff-btn-submit" type="submit">Invia</button></form></div></body></html>');
    const result = await buildBundle({ source: { kind: "directory", path: root }, forms: config });
    keepBundle(result.bundlePath);
    const html = result.manifest["/index.html"];
    expect(result.forms).toMatchObject({ enabled: true, adapter: "wordpress-fluent-forms", fluentFormIds: [123], attachedForms: 1, unmatchedIds: [] });
    expect(html).toBeDefined();
    expect(Object.keys(result.manifest)).toContain("/xb-form-client.js");
    const bundlePath = result.bundlePath;
    if (!bundlePath) throw new Error("La build di prova non ha creato il bundle atteso.");
    const builtHtml = (await readFile(path.join(bundlePath, "index.html"))).toString();
    expect(builtHtml).toContain('action="/xb-form"');
    expect(builtHtml).toContain('data-histos-fluent-form="123"');
    expect(builtHtml).toContain('data-histos-turnstile-sitekey="site-key-test"');
    expect(builtHtml).toContain('data-histos-fluent-form="123"');
    expect(result.status).toBe("ready");
  });

  it("non collega upload, captcha preesistente o ID assenti", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "index.html"), '<html><body><form id="fluentform_123" class="frm-fluent-form fluent_form_123" data-form_id="123"><input type="file" name="allegato"></form></body></html>');
    const result = await buildBundle({ source: { kind: "directory", path: root }, forms: config, checkOnly: true });
    expect(result.forms).toMatchObject({ enabled: false, fluentFormIds: [], attachedForms: 0, unsupportedFiles: ["index.html"], unmatchedIds: [123] });
    expect(Object.keys(result.manifest)).not.toContain("/xb-form-client.js");
    expect(result.findings.some((finding) => finding.code === "fluent-forms-unsupported")).toBe(true);
  });

  it("rifiuta API REST HTTP o endpoint che non è /wp-json/", () => {
    expect(() => parseSiteConfig({ schemaVersion: 1, name: "Demo", source: { kind: "directory", path: "/tmp/demo" }, forms: { wordpress: { ...config.wordpress, restUrl: "http://wp.example.test/wp-json/" } } })).toThrow(/HTTPS/u);
    expect(() => parseSiteConfig({ schemaVersion: 1, name: "Demo", source: { kind: "directory", path: "/tmp/demo" }, forms: { wordpress: { ...config.wordpress, restUrl: "https://wp.example.test/wp-admin/" } } })).toThrow(/wp-json/u);
  });
});
