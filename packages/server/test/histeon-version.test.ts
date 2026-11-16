import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsRemoteCatalog, connectionHisteonNotice } from "../src/cms-remote.js";
import { compareHisteon, HISTEON_FEATURES, HISTEON_VERSION, histeonSiteNotice } from "../src/histeon-version.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Histeon sul sito più vecchio (doc 23, voce 175)", () => {
  it("la versione che Publish conosce è quella del builder fissato nello snapshot", () => {
    const upstream = readFileSync(path.resolve(import.meta.dirname, "../../cms/vendor/histos/UPSTREAM.md"), "utf8");
    const pinned = /^- Pinned commit: .*\bHisteon (\d+\.\d+\.\d+)\b/mu.exec(upstream)?.[1];
    expect(pinned).toBe(HISTEON_VERSION);
    // Nothing in the table is newer than what Publish knows.
    for (const feature of HISTEON_FEATURES) expect(compareHisteon(feature.since, HISTEON_VERSION)).toBeLessThanOrEqual(0);
  });

  it("confronta i tre numeri, non le stringhe", () => {
    expect(compareHisteon("0.5.10", "0.5.2")).toBeGreaterThan(0);
    expect(compareHisteon("0.4.9", "0.5.0")).toBeLessThan(0);
    expect(compareHisteon("0.5.2-dev", "0.5.2")).toBe(0);
  });

  it("un sito senza versione è la 0.5.1 o precedente; uno uguale o più nuovo non ha avviso", () => {
    const unknown = histeonSiteNotice(null);
    expect(unknown).toMatchObject({ site: null, known: HISTEON_VERSION });
    expect(unknown?.missing.map((feature) => feature.id)).toEqual(["site-environment", "post-image", "types-without-pages", "group-by", "media-links", "url-path", "loop-group", "terms-order", "front-page", "site-check", "field-order", "svg-text"]);
    expect(histeonSiteNotice("0.5.1")?.missing).toHaveLength(12);
    expect(histeonSiteNotice("0.5.3")?.missing.map((feature) => feature.id)).toEqual(["url-path", "loop-group", "terms-order", "front-page", "site-check", "field-order", "svg-text"]);
    expect(histeonSiteNotice("0.5.4")?.missing.map((feature) => feature.id)).toEqual(["loop-group", "terms-order", "front-page", "site-check", "field-order", "svg-text"]);
    // Doc 23, item 232: a 0.5.12 site lacks the order by a field, and the SVG drawings with text of 0.5.14.
    expect(histeonSiteNotice("0.5.12")?.missing.map((feature) => feature.id)).toEqual(["field-order", "svg-text"]);
    expect(histeonSiteNotice("0.5.13")?.missing.map((feature) => feature.id)).toEqual(["svg-text"]);
    expect(histeonSiteNotice("0.4.0")?.site).toBe("0.4.0");
    expect(histeonSiteNotice(HISTEON_VERSION)).toBeNull();
    expect(histeonSiteNotice(`${HISTEON_VERSION}-dev`)).toBeNull();
    expect(histeonSiteNotice("0.6.0")).toBeNull();
    // A later Publish that knows 0.6.0: a 0.5.2 site lacks only what came after it.
    expect(histeonSiteNotice("0.5.2", "0.6.0")).toMatchObject({ site: "0.5.2", known: "0.6.0" });
    expect(histeonSiteNotice("0.5.2", "0.6.0")?.missing.map((feature) => feature.id)).toEqual(["url-path", "loop-group", "terms-order", "front-page", "site-check", "field-order", "svg-text"]);
  });

  it("il catalogo ricorda la versione letta: assente prima della lettura, null se il sito non la dice", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "histos-histeon-version-"));
    roots.push(directory);
    const catalog = new CmsRemoteCatalog(directory);
    try {
      const id = "0b7d6c1e-5d38-4c3e-9f8a-2d4b6a1c9e01";
      catalog.add({ id, url: "https://esempio.it", siteId: "de7d1687-bf53-4b1e-8d96-43391da110f0", projectId: null, projectName: "Sito", profile: "histos-static-page-v1", read: true, write: true, publish: false });
      expect(catalog.get(id)?.siteHisteon).toBeUndefined();
      expect(connectionHisteonNotice(catalog.get(id)!)).toBeNull();
      catalog.updateRemote(id, { siteHisteon: null });
      expect(catalog.get(id)?.siteHisteon).toBeNull();
      expect(connectionHisteonNotice(catalog.get(id)!)).toMatchObject({ site: null });
      // Other updates leave it as it was.
      catalog.updateRemote(id, { lastSyncedAt: "2026-11-04T10:00:00.000Z" });
      expect(catalog.get(id)?.siteHisteon).toBeNull();
      catalog.updateRemote(id, { siteHisteon: HISTEON_VERSION });
      expect(catalog.get(id)?.siteHisteon).toBe(HISTEON_VERSION);
      expect(connectionHisteonNotice(catalog.get(id)!)).toBeNull();
    } finally {
      catalog.close();
    }
  });
});
