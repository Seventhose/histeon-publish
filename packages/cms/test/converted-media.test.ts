import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertedMediaHash, convertedMediaUrl, PROTOTYPE_MAX_BYTES } from "../src/prototype-media.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { staticSiteProjectId, staticSiteToPrototype } from "../src/static-site-prototype.js";

/** Doc 23 item 109: a converted site's media kept by the app, outside its prototype. */
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const text = (value: string) => new TextEncoder().encode(value);
/** A PNG of `size` bytes: the image, then padding after its end. */
const bigPng = (size: number, mark: number) => { const bytes = new Uint8Array(size); bytes.set(PNG); bytes[size - 1] = mark; return bytes; };
const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function catalog(): Promise<CmsProjectCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-converted-media-"));
  roots.push(root);
  return new CmsProjectCatalog(root, { durable: false });
}

/** A site with `count` images of `size` bytes each, every one different. */
function site(count: number, size: number) {
  const images = Array.from({ length: count }, (_, index) => ({ path: `img/foto-${index}.png`, bytes: bigPng(size, index + 1) }));
  const body = images.map((image) => `<img src="${image.path}" alt="Foto" width="1" height="1">`).join("");
  return [{ path: "index.html", bytes: text(`<!doctype html><html lang="it"><head><title>Grande</title></head><body><main class="galleria">${body}</main></body></html>`) }, ...images];
}

describe("media dei siti convertiti fuori dal prototipo (doc 23, voce 109)", () => {
  it("un sito oltre i 32 MB passa se l'app tiene i media, e si importa leggendoli da lì", async () => {
    const files = site(40, 1024 * 1024);
    expect(() => staticSiteToPrototype({ projectId: staticSiteProjectId("grande"), name: "Grande", files })).toThrow(/oltre il limite di 32 MB/u);
    const kept = new Map<string, Uint8Array>();
    const prototype = staticSiteToPrototype({ projectId: staticSiteProjectId("grande"), name: "Grande", files, holdMedia: (bytes, hash) => kept.set(hash, bytes) });
    expect(new TextEncoder().encode(prototype.html).length).toBeLessThan(PROTOTYPE_MAX_BYTES / 100);
    expect(kept.size).toBe(40);
    expect(prototype.html).toContain(convertedMediaUrl(hashOf(files[1]!.bytes)));
    expect(prototype.html).not.toContain("base64,");

    const built = await buildPrototypeProfile(parsePrototype(prototype.html), await catalog(), { convertedMedia: (hash) => kept.get(hash) ?? null });
    const assets = built.profile.entities.filter((entity) => entity.kind === "asset");
    expect(assets).toHaveLength(40);
  }, 60_000);

  it("senza l'app, con un'impronta sbagliata o un media mancante l'import si ferma e non scarica nulla", async () => {
    const files = site(2, 2048);
    const kept = new Map<string, Uint8Array>();
    const prototype = staticSiteToPrototype({ projectId: staticSiteProjectId("piccolo"), name: "Piccolo", files, holdMedia: (bytes, hash) => kept.set(hash, bytes) });
    const parsed = () => parsePrototype(prototype.html);
    let fetched = 0;
    const fetchAsset = async () => { fetched++; return PNG; };
    await expect(buildPrototypeProfile(parsed(), await catalog(), { fetchAsset })).rejects.toThrow(/converti di nuovo il sito/u);
    // Other bytes under the right hash are refused too.
    await expect(buildPrototypeProfile(parsed(), await catalog(), { fetchAsset, convertedMedia: () => PNG })).rejects.toThrow(/converti di nuovo il sito/u);
    const [first] = [...kept.keys()];
    await expect(buildPrototypeProfile(parsed(), await catalog(), { fetchAsset, convertedMedia: (hash) => (hash === first ? kept.get(hash)! : null) })).rejects.toThrow(/converti di nuovo il sito/u);
    expect(fetched).toBe(0);
  }, 60_000);

  it("riconosce solo il suo indirizzo, con un'impronta intera", () => {
    const hash = "a".repeat(64);
    expect(convertedMediaHash(convertedMediaUrl(hash))).toBe(hash);
    for (const url of [`https://media.histos.invalid/${"a".repeat(63)}`, `https://media.histos.invalid/${hash}/x`, `https://media.histos.invalid.example.com/${hash}`, `http://media.histos.invalid/${hash}`, `https://media.histos.invalid/${"A".repeat(64)}`]) expect(convertedMediaHash(url), url).toBeNull();
  });
});
