import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "@histos-publish/cms";
import { buildCmsProject, type CmsOperationsContext } from "../src/cms-api.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-build-skipped-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  await catalog.initialize();
  const opened = await catalog.createProject("Sito");
  const home = opened.store.listPages()[0]!;
  opened.store.updatePageMetadata(home.id, { title: home.title, slug: home.slug, status: "published" });
  const context = {
    catalog, dataDirectory: root, port: 1, registerPreview: () => undefined, registerBuild: () => undefined,
    prototypePreviews: { root: path.join(root, "previews"), track: () => undefined, folder: async () => null } as unknown as CmsOperationsContext["prototypePreviews"],
  } as CmsOperationsContext;
  return { root, opened, context };
}

const refused = '<!-- wp:xb/element {"uid":"abcdefgh1","tag":"p"} --><!-- wp:xb/text {"uid":"abcdefgh2","content":"\\u003ca href=\\u0022https://x.it/{a}\\u0022\\u003eLink\\u003c/a\\u003e"} /--><!-- /wp:xb/element -->';

describe("una pagina che non si può costruire", () => {
  it("resta fuori e lo si dice: il resto del sito esce", { timeout: 60_000 }, async () => {
    const { root, opened, context } = await project();
    const { store } = opened;
    const good = store.createPost({ title: "Buono", slug: "buono", status: "published" });
    const bad = store.createPost({ title: "Difettoso", slug: "difettoso", status: "published" });
    expect(store.saveDocument({ entityId: bad.id, expectedHead: store.getEntityById(bad.id)!.headRevision, content: refused }).status).toBe("saved");
    expect(good.id).toBeTruthy();
    const out = path.join(root, "out");
    const result = await buildCmsProject(context, opened, { throwaway: { directory: out }, keepGoing: true });
    expect(result.status).toBe("ready");
    const files = (await readdir(path.join(out, String(result.id)), { recursive: true })).map(String);
    expect(files.some((name) => name.includes("buono"))).toBe(true);
    expect(files.some((name) => name.includes("difettoso"))).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "cms-page-skipped", message: expect.stringContaining("«Difettoso» è rimasta fuori dal sito") }));
  });

  it("se a fallire sono tutte, il problema non è di una pagina e la costruzione si ferma", { timeout: 60_000 }, async () => {
    const { root, opened, context } = await project();
    const { store } = opened;
    for (let index = 0; index < 22; index++) {
      const post = store.createPost({ title: `P${index}`, slug: `p${index}`, status: "published" });
      store.saveDocument({ entityId: post.id, expectedHead: store.getEntityById(post.id)!.headRevision, content: refused });
    }
    await expect(buildCmsProject(context, opened, { throwaway: { directory: path.join(root, "out") }, keepGoing: true })).rejects.toThrow("href");
  });
});
