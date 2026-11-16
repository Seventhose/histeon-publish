import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "@histos-publish/cms";

/** Doc 21 §9: how long the site administration's index takes on a project of 5 000 contents. */

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("velocità dell'amministrazione", () => {
  it("legge l'indice di 5 000 contenuti entro i limiti", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-admin-speed-"));
    roots.push(root);
    const { store } = await new CmsProjectCatalog(root).createProject("Grande");
    store.content.saveType({ key: "opera", label: "Opere", fields: [{ key: "trama", label: "Trama", type: "text", required: false, public: true, multiple: false }] });
    for (let index = 0; index < 1500; index += 1) store.createPage({ title: `Pagina ${index}`, slug: `pagina-${index}`, status: "published" });
    for (let index = 0; index < 1500; index += 1) store.createPost({ title: `Articolo ${index}`, slug: `articolo-${index}`, status: "published" });
    for (let index = 0; index < 2000; index += 1) store.content.saveRecord({ typeKey: "opera", title: `Opera ${index}`, slug: `opera-${index}`, status: "published", values: { trama: "Testo" } });
    const started = performance.now();
    for (let run = 0; run < 10; run += 1) JSON.stringify(store.adminIndex());
    const milliseconds = (performance.now() - started) / 10;
    const bytes = JSON.stringify(store.adminIndex()).length;
    console.log(`indice di 5001 contenuti: ${milliseconds.toFixed(1)} ms, ${(bytes / 1024).toFixed(0)} KiB`);
    expect(store.adminIndex().pages.length + store.adminIndex().posts.length + store.adminIndex().records.length).toBeGreaterThanOrEqual(5000);
    expect(milliseconds).toBeLessThan(150);
    store.close();
  }, 120_000);
});
