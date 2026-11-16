import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog, type CmsProjectStore } from "@histos-publish/cms";
import { parse, serializeXb } from "../../cms/.generated/histos-dsl/index.js";
import { buildCmsProject, importPrototypeHtml, type CmsOperationsContext } from "../src/cms-api.js";
import { ImportReports } from "../src/import-reports.js";
import { encodeImageInWorker, IMAGE_CODEC_VERSIONS, ImageVariantCache, type ImageVariantSummary } from "../src/image-variants.js";
import { avif, decodedAvif, decodedWebp, graphicPixels, jpeg, photoPixels, png, webp, withExifOrientation } from "./support/test-images.js";

/**
 * Queue B6: the modern image variants of a static build. Real images in every input format go through the worker,
 * become <picture> with JPEG XL, AVIF and WebP sources only where the page cannot change, and come from the cache on
 * the next build; the worker keeps its limits (pixels, size, time, memory, the header's size).
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-image-variants-"));
  roots.push(root);
  return root;
}

interface Project { root: string; catalog: CmsProjectCatalog; opened: { project: { id: string }; store: CmsProjectStore } }

async function project(): Promise<Project> {
  const root = await scratch();
  const catalog = new CmsProjectCatalog(path.join(root, "catalog"));
  const opened = await catalog.createProject("Immagini");
  const home = opened.store.listPages()[0]!;
  opened.store.updatePageMetadata(home.id, { title: home.title, slug: home.slug, status: "published" });
  return { root, catalog, opened };
}

function context(target: Project, extra: Partial<CmsOperationsContext> = {}): CmsOperationsContext {
  return { catalog: target.catalog, dataDirectory: target.root, port: 1, registerPreview: () => undefined, registerBuild: () => undefined, ...extra };
}

function saveHome(store: CmsProjectStore, source: string, css = ""): void {
  const home = store.listPages()[0]!;
  const result = store.saveDocument({ entityId: home.id, expectedHead: store.getHead(home.id)!.id, content: serializeXb(parse(source).blocks) });
  expect(result.status).toBe("saved");
  if (css) {
    const styles = store.getStyles()!;
    expect(store.saveDocument({ entityId: styles.id, expectedHead: store.getHead(styles.id)!.id, content: JSON.stringify({ styles: [], globals: [{ id: "base", css }] }) }).status).toBe("saved");
  }
}

/** Builds and returns the summary, the home page and every media file name with its bytes. */
async function build(target: Project, extra: Partial<CmsOperationsContext> = {}): Promise<{ images: ImageVariantSummary; html: string; media: Map<string, Buffer>; result: Record<string, unknown> }> {
  const directory = path.join(target.root, `out-${Math.random().toString(36).slice(2)}`);
  const result = await buildCmsProject(context(target, extra), target.opened, { throwaway: { directory } });
  const [folder] = await readdir(directory);
  const site = path.join(directory, folder!);
  const files = await readdir(site, { recursive: true });
  const index = files.find((name) => name === "index.html" || name.endsWith(`${path.sep}index.html`) && !name.includes(`${path.sep}blog${path.sep}`));
  const html = await readFile(path.join(site, files.includes("index.html") ? "index.html" : index!), "utf8");
  const media = new Map<string, Buffer>();
  for (const name of files) if (name.includes(`media${path.sep}`) && /\.\w+$/u.test(name)) media.set(path.basename(name), await readFile(path.join(site, name)));
  return { images: result.images as ImageVariantSummary, html, media, result };
}

const media = (target: Project, id: string) => `/__cms-media/${target.opened.project.id}/${id}`;

describe("varianti moderne nella build statica (B6)", () => {
  it("JPEG, PNG, WebP e AVIF diventano <picture> con JPEG XL, AVIF e WebP a più larghezze, mai ingrandite; il resto della pagina non cambia", { timeout: 120_000 }, async () => {
    const target = await project();
    const { store } = target.opened;
    const photo = photoPixels(1200, 800);
    const files = {
      jpeg: store.saveAsset({ bytes: await jpeg(photo), mimeType: "image/jpeg", filename: "foto.jpg" }),
      png: store.saveAsset({ bytes: await png(graphicPixels(640, 400)), mimeType: "image/png", filename: "grafica.png" }),
      webp: store.saveAsset({ bytes: await webp(photo, 92), mimeType: "image/webp", filename: "foto.webp" }),
      avif: store.saveAsset({ bytes: await avif(photo, 85), mimeType: "image/avif", filename: "foto.avif" }),
    };
    saveHome(store, `<main><h1>Foto</h1>
<img src="${media(target, files.jpeg.id)}" width="1200" height="800" alt="JPEG">
<img src="${media(target, files.png.id)}" width="640" height="400" alt="PNG" loading="lazy">
<p><img src="${media(target, files.webp.id)}" width="600" height="400" alt="WebP" sizes="(min-width: 60em) 50vw, 100vw"></p>
<img src="${media(target, files.avif.id)}" width="1200" height="800" alt="AVIF">
<img src="${media(target, files.jpeg.id)}" alt="senza misure">
<picture><source srcset="${media(target, files.webp.id)}" type="image/webp"><img src="${media(target, files.jpeg.id)}" width="1200" height="800" alt="dell'autore"></picture>
<div class="card"><img src="${media(target, files.jpeg.id)}" width="1200" height="800" alt="nella card"></div>
</main>`, ".card > img { border-radius: 1rem }");
    const { images, html, media: written } = await build(target);
    expect(images).toMatchObject({ enabled: true, images: 4, pictures: 4, encoded: 4, cached: 0 });
    // Every <picture> keeps the <img> exactly as the renderer wrote it, and adds the sources in the order browsers try them.
    const pictures = [...html.matchAll(/<picture style="display:contents">([\s\S]*?)<\/picture>/gu)].map((match) => match[1]!);
    expect(pictures).toHaveLength(4);
    const [first, second, third] = pictures;
    expect([...first!.matchAll(/<source type="([^"]+)"/gu)].map((match) => match[1])).toEqual(expect.arrayContaining(["image/avif", "image/webp"]));
    expect(first).toMatch(/<source type="image\/avif" srcset="\/media\/[0-9a-f]{64}\.avif 480w, \/media\/[0-9a-f]{64}\.avif 960w, \/media\/[0-9a-f]{64}\.avif 1200w" sizes="100vw" hidden>/u);
    expect(first).toMatch(/<img src="\/media\/[0-9a-f]{64}\.jpg" width="1200" height="800" alt="JPEG">$/u);
    // A PNG stays lossless: JPEG XL and WebP, no AVIF, at its own 640 px as the widest (never upscaled to 960).
    expect(second).not.toContain("image/avif");
    expect(second).toMatch(/<source type="image\/webp" srcset="\/media\/[0-9a-f]{64}\.webp 480w, \/media\/[0-9a-f]{64}\.webp 640w"/u);
    expect(second).toContain('loading="lazy"');
    // The author's sizes is the sources' sizes.
    expect(third).toContain('sizes="(min-width: 60em) 50vw, 100vw"');
    // Left as written: the image without sizes, the author's <picture>, the one whose CSS selects it as a child.
    expect(html).toMatch(/<img src="\/media\/[0-9a-f]{64}\.jpg" alt="senza misure">/u);
    expect(html).toMatch(/<picture><source [^>]*><img [^>]*alt="dell&#39;autore"><\/picture>/u);
    expect(html).toMatch(/<div class="card"><img [^>]*alt="nella card"><\/div>/u);
    expect(images.skipped.map((item) => item.reason)).toEqual(expect.arrayContaining(["senza width e height", "dentro un <picture> scritto dall'autore", "il CSS della pagina selezionerebbe altri elementi (.card > img)"]));
    // Each file named by its own content, served from media/, with the type its name says.
    for (const url of html.matchAll(/\/media\/([0-9a-f]{64}\.(?:jxl|avif|webp))/gu)) {
      const bytes = written.get(url[1]!);
      expect(bytes, url[1]).toBeDefined();
      if (url[1]!.endsWith(".jxl")) expect(bytes!.subarray(0, 2).equals(Buffer.from([0xff, 0x0a])) || bytes!.subarray(4, 8).toString("latin1") === "JXL ").toBe(true);
      if (url[1]!.endsWith(".avif")) expect(bytes!.subarray(4, 12).toString("latin1")).toBe("ftypavif");
      if (url[1]!.endsWith(".webp")) expect(bytes!.subarray(8, 12).toString("latin1")).toBe("WEBP");
    }
    // Every kept format is smaller at full width than the original: a modern browser downloads less.
    expect(images.variantBytes).toBeLessThan(images.originalBytes);
    expect(images.files).toBeGreaterThan(8);
  });

  it("la seconda build prende tutto dalla cache, con gli stessi file; un file della cache alterato si ricodifica", { timeout: 120_000 }, async () => {
    const target = await project();
    const { store } = target.opened;
    const file = store.saveAsset({ bytes: await jpeg(photoPixels(900, 600)), mimeType: "image/jpeg", filename: "foto.jpg" });
    saveHome(store, `<main><img src="${media(target, file.id)}" width="900" height="600" alt=""></main>`);
    const first = await build(target);
    expect(first.images).toMatchObject({ images: 1, encoded: 1, cached: 0 });
    const started = Date.now();
    const second = await build(target);
    expect(second.images).toMatchObject({ images: 1, encoded: 0, cached: 1 });
    expect(Date.now() - started).toBeLessThan(first.images.milliseconds + 5_000);
    expect(second.html).toBe(first.html);
    // A cache file changed on disk: its size or its hash no longer matches, the entry is encoded again.
    const cache = path.join(target.root, "histos-image-variants");
    const entries = (await readdir(cache, { recursive: true })).filter((name) => name.endsWith(".avif"));
    expect(entries.length).toBeGreaterThan(0);
    await writeFile(path.join(cache, entries[0]!), Buffer.from("non è un AVIF"));
    const third = await build(target);
    expect(third.images).toMatchObject({ images: 1, encoded: 1, cached: 0 });
    expect(third.html).toBe(first.html);
  });

  it("l'orientamento EXIF di un JPEG si applica ai pixel, come lo mostra il browser", { timeout: 60_000 }, async () => {
    const target = await project();
    const { store } = target.opened;
    // Stored 300×200 with a red top-left corner; orientation 6 shows it 200×300 with the red corner at the top right.
    const turned = withExifOrientation(await jpeg(photoPixels(300, 200, true), 95), 6);
    const file = store.saveAsset({ bytes: turned, mimeType: "image/jpeg", filename: "girata.jpg" });
    saveHome(store, `<main><img src="${media(target, file.id)}" width="200" height="300" alt=""></main>`);
    const { html, media: written, images } = await build(target);
    expect(images, JSON.stringify(images.skipped)).toMatchObject({ images: 1 });
    const webpUrl = /<source type="image\/webp" srcset="\/media\/([0-9a-f]{64}\.webp) 200w"/u.exec(html);
    expect(webpUrl).not.toBeNull();
    const pixels = await decodedWebp(written.get(webpUrl![1]!)!);
    expect([pixels.width, pixels.height]).toEqual([200, 300]);
    const at = (x: number, y: number) => [...pixels.data.subarray((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 3)];
    expect(at(195, 4)[0]).toBeGreaterThan(200);
    expect(at(195, 4)[1]).toBeLessThan(60);
    expect(at(4, 4)[0]).toBeLessThan(200);
    const avifUrl = /<source type="image\/avif" srcset="\/media\/([0-9a-f]{64}\.avif) 200w"/u.exec(html);
    const decoded = await decodedAvif(written.get(avifUrl![1]!)!);
    expect([decoded.width, decoded.height]).toEqual([200, 300]);
  });

  it("le varianti spente nelle impostazioni del progetto non toccano la build", { timeout: 60_000 }, async () => {
    const target = await project();
    const { store } = target.opened;
    const file = store.saveAsset({ bytes: await jpeg(photoPixels(400, 300)), mimeType: "image/jpeg", filename: "foto.jpg" });
    saveHome(store, `<main><img src="${media(target, file.id)}" width="400" height="300" alt=""></main>`);
    expect(store.getImageSettings()).toEqual({ variants: true, widths: [480, 960, 1600], quality: { avif: 60, jxl: 75, webp: 75 } });
    store.setImageSettings({ variants: false });
    const { images, html, media: written } = await build(target);
    expect(images).toMatchObject({ enabled: false, images: 0, files: 0 });
    expect(html).not.toContain("<picture");
    expect([...written.keys()]).toHaveLength(1);
    expect(() => store.setImageSettings({ widths: [10] })).toThrow(/da 1 a 6 numeri interi fra 64 e 2560/u);
    expect(() => store.setImageSettings({ quality: { avif: 0 } })).toThrow(/AVIF è un numero intero da 1 a 100/u);
  });

  it("senza tempo per le immagini la build non fallisce: le immagini restano originali e un avviso lo dice", { timeout: 60_000 }, async () => {
    const target = await project();
    const { store } = target.opened;
    const file = store.saveAsset({ bytes: await jpeg(photoPixels(1600, 1000)), mimeType: "image/jpeg", filename: "foto.jpg" });
    saveHome(store, `<main><img src="${media(target, file.id)}" width="1600" height="1000" alt=""></main>`);
    const { images, html, result } = await build(target, { buildLimits: { imageTimeoutMs: 1 } });
    expect(result.status).toBe("ready");
    expect(images.images).toBe(0);
    expect(html).not.toContain("<picture");
    expect(images.skipped[0]?.reason).toMatch(/^tempo scaduto/u);
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "cms-image-variants-incomplete", severity: "warn" })]));
  });

  it("il pacchetto pieno: le varianti si fermano dove il pacchetto non le prende più, mai la build", { timeout: 60_000 }, async () => {
    const target = await project();
    const { store } = target.opened;
    const file = store.saveAsset({ bytes: await jpeg(photoPixels(800, 500)), mimeType: "image/jpeg", filename: "foto.jpg" });
    saveHome(store, `<main><img src="${media(target, file.id)}" width="800" height="500" alt=""></main>`);
    const { images } = await build(target, { imageVariantLimits: { maxFileBytes: 32 * 1024 * 1024 } });
    expect(images.images).toBe(1);
    // The room the bundle has is what the build counts: the same image with no room left keeps its original.
    const { writeImageVariants } = await import("../src/image-variants.js");
    const root = await scratch();
    await rm(root, { recursive: true, force: true });
    const site = path.join(root, "site");
    await import("node:fs/promises").then(async (fs) => {
      await fs.mkdir(path.join(site, "media"), { recursive: true });
      const original = (await store.readAsset(file.id))!;
      await fs.writeFile(path.join(site, "media", `${original.metadata.sha256}.jpg`), original.bytes);
      await fs.writeFile(path.join(site, "index.html"), `<!doctype html><html><head><style>img{max-width:100%}</style></head><body><img src="/media/${original.metadata.sha256}.jpg" width="800" height="500" alt=""></body></html>`);
    });
    const full = await writeImageVariants({ staticRoot: site, settings: store.getImageSettings(), cacheDirectory: path.join(target.root, "histos-image-variants"), deadline: Date.now() + 60_000, signal: new AbortController().signal, room: { bytes: 1000, files: 100 } });
    expect(full).toMatchObject({ images: 0, files: 0, cached: 1 });
    expect(full.skipped).toEqual([{ reason: "il pacchetto della versione non ha più spazio", count: 1, examples: [expect.any(String)] }]);
    expect(await readFile(path.join(site, "index.html"), "utf8")).not.toContain("<picture");
  });
});

describe("il rapporto d'import e il controllo dicono quante immagini e quanto si risparmia (B6)", () => {
  it("l'import conta i file con le varianti e dice perché gli altri no; dopo una build la cache dà il risparmio", { timeout: 120_000 }, async () => {
    const root = await scratch();
    const catalog = new CmsProjectCatalog(path.join(root, "catalog"));
    const reports = new ImportReports();
    const ctx: CmsOperationsContext = { catalog, dataDirectory: root, port: 1, registerPreview: () => undefined, registerBuild: () => undefined, importReports: reports };
    const photo = await jpeg(photoPixels(800, 500));
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
    const html = `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>T</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"5d0c2a7e-1b2c-4d3e-8f40-5a6b7c8d9e0f","name":"Rapporto","framework":"none","locale":"it-IT"}</script>
<script type="application/json" data-histos="assets">[{"name":"foto","data":"data:image/jpeg;base64,${photo.toString("base64")}"},{"name":"animata","data":"data:image/gif;base64,${gif.toString("base64")}"}]</script>
</head><body><template data-histos="page" data-slug="home" data-title="Home"><main><h1>T</h1><img src="asset:foto" width="800" height="500" alt="Foto"><img src="asset:foto" width="400" height="250" alt="Piccola"><img src="asset:animata" width="1" height="1" alt=""><picture><source srcset="asset:foto" type="image/jpeg"><img src="asset:foto" width="800" height="500" alt="Dell'autore"></picture></main></template></body></html>`;
    const created = await importPrototypeHtml(ctx, html, { download: false, allowUpdate: false });
    const projectId = (created.body.project as { id: string }).id;
    const first = reports.get(projectId)!.images!;
    expect(first).toMatchObject({ files: 1, uses: 2, skipped: [{ asset: "animata", why: "GIF: resta com'è" }] });
    expect(first.note).toBe("Immagini moderne: un file (2 <img>) avrà varianti JPEG XL, AVIF e WebP alla versione, dove il CSS della pagina lo permette; il risparmio si misura alla versione. Restano come sono: animata (GIF: resta com'è).");
    const opened = (await catalog.openProject(projectId))!;
    const built = await buildCmsProject(ctx, opened, { throwaway: { directory: path.join(root, "out") } });
    opened.store.close();
    expect(built.imagesNote).toMatch(/^Immagini moderne: 1 immagine ha le varianti \(2 <picture>; [^)]+\)\. A piena larghezza un browser recente scarica \d+ KB invece di \d+ KB \(−\d+%\)/u);
    // The same prototype again: the cache has the file, the report says what it saves.
    await importPrototypeHtml(ctx, html, { download: false, allowUpdate: true });
    expect(reports.get(projectId)!.images!.note).toMatch(/il CSS della pagina lo permette; misurato: a piena larghezza un browser recente scarica \d+ KB invece di \d+ KB \(−\d+%\)\. Restano come sono: animata/u);
  });
});

describe("il codificatore nel worker e i suoi limiti (B6)", () => {
  const job = async (overrides: Record<string, unknown> = {}) => ({ bytes: await jpeg(photoPixels(640, 480)), format: "jpeg" as const, width: 640, height: 480, orientation: 1, lossless: false, widths: [480, 640], formats: ["jxl", "avif", "webp"] as Array<"jxl" | "avif" | "webp">, quality: { avif: 50, jxl: 70, webp: 75 }, ...overrides });

  it("codifica nei tre formati alle larghezze chieste, con le misure giuste", { timeout: 60_000 }, async () => {
    const result = await encodeImageInWorker(await job());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outputs.map((output) => `${output.format} ${output.width}×${output.height}`).sort()).toEqual(["avif 480×360", "avif 640×480", "jxl 480×360", "jxl 640×480", "webp 480×360", "webp 640×480"]);
  });

  it("rifiuta prima di decodificare un file oltre i megapixel (una bomba di decompressione) o oltre i byte", async () => {
    // The header says 100,000 × 100,000: nothing is decoded, no worker starts.
    await expect(encodeImageInWorker(await job({ width: 100_000, height: 100_000 }))).resolves.toEqual({ ok: false, error: "oltre 40 megapixel: non si decodifica" });
    await expect(encodeImageInWorker(await job(), { limits: { maxFileBytes: 100 } })).resolves.toEqual({ ok: false, error: "oltre 0 MB" });
  });

  it("le misure decodificate devono essere quelle dell'intestazione", { timeout: 30_000 }, async () => {
    await expect(encodeImageInWorker(await job({ width: 64, height: 48 }))).resolves.toEqual({ ok: false, error: "le misure decodificate non sono quelle dell'intestazione" });
  });

  it("il tempo e la memoria hanno un limite: il worker si ferma e la build va avanti", { timeout: 30_000 }, async () => {
    await expect(encodeImageInWorker(await job(), { timeoutMs: 1 })).resolves.toMatchObject({ ok: false, timeout: true });
    await expect(encodeImageInWorker(await job(), { limits: { maxWasmBytes: 8 * 1024 * 1024 } })).resolves.toEqual({ ok: false, error: "memoria del codificatore oltre 8 MiB" });
  });

  it("i worker aspettano il loro turno; un'attesa annullata lascia il posto a quella dopo", { timeout: 60_000 }, async () => {
    const limits = { concurrency: 1 };
    const [first, second, third] = [await job(), await job(), await job({ widths: [480] })];
    const running = encodeImageInWorker(first, { limits });
    const controller = new AbortController();
    const cancelled = encodeImageInWorker(second, { limits, signal: controller.signal });
    const next = encodeImageInWorker(third, { limits });
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    await expect(running).resolves.toMatchObject({ ok: true });
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it("un file che il decodificatore rifiuta dà il suo errore, non un'eccezione", { timeout: 30_000 }, async () => {
    const broken = Buffer.from(await jpeg(photoPixels(64, 48)));
    broken.fill(0, 200);
    const result = await encodeImageInWorker(await job({ bytes: broken, width: 64, height: 48, widths: [64] }));
    expect(result.ok).toBe(false);
  });

  it("la chiave della cache cambia con le versioni dei codec e le impostazioni", () => {
    const base = { sourceSha256: "a".repeat(64), widths: [480], formats: ["avif" as const], quality: { avif: 50, jxl: 70, webp: 75 }, lossless: false, orientation: 1 };
    expect(ImageVariantCache.key(base)).toMatch(/^[0-9a-f]{64}$/u);
    expect(ImageVariantCache.key({ ...base, quality: { ...base.quality, avif: 51 } })).not.toBe(ImageVariantCache.key(base));
    expect(ImageVariantCache.key({ ...base, widths: [480, 960] })).not.toBe(ImageVariantCache.key(base));
  });

  it("le versioni dei codec nella chiave della cache sono quelle installate", async () => {
    const versions = await Promise.all(["avif", "jxl", "webp", "jpeg", "png", "resize"].map(async (name) => `${name} ${JSON.parse(await readFile(path.join(import.meta.dirname, `../../../node_modules/@jsquash/${name}/package.json`), "utf8")).version}`));
    expect(IMAGE_CODEC_VERSIONS).toBe(`${versions.join(", ")}; options 1`);
  });

  it("la cache sotto il suo limite toglie le voci usate meno di recente", async () => {
    const root = await scratch();
    const cache = new ImageVariantCache(root, 1500);
    const key = (index: number) => ImageVariantCache.key({ sourceSha256: String(index).repeat(64).slice(0, 64), widths: [1], formats: ["webp"], quality: { avif: 1, jxl: 1, webp: 1 }, lossless: false, orientation: 1 });
    for (let index = 1; index <= 3; index++) {
      const bytes = Buffer.alloc(600, index);
      const sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
      await cache.put(key(index), { ok: true, files: [{ format: "webp", width: 1, height: 1, sha256, bytes: bytes.length }] }, new Map([[sha256, bytes]]));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await cache.get(key(1));
    await cache.prune();
    expect(await cache.get(key(1))).not.toBeNull();
    expect(await cache.get(key(2))).toBeNull();
  });
});
