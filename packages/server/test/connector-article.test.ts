import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog, type CmsProjectStore } from "@histos-publish/cms";
import { parse, serializeXb } from "../../cms/.generated/histos-dsl/index.js";
import { ConnectorOperations, type ConnectorOperationsDeps } from "../src/connector-operations.js";

/** Doc 23 item 94: the agent reads an article and proposes a rewrite; nothing of the article changes. */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const context = { client: "test", signal: new AbortController().signal };

async function setup(): Promise<{ operations: ConnectorOperations; projectId: string; alias: number; pageAlias: number; reopen: () => Promise<CmsProjectStore> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-connector-article-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  const { project, store } = await catalog.createProject("Riscrivere");
  const post = store.createPost({ title: "Un viaggio", slug: "un-viaggio", status: "draft" });
  store.saveDocument({ entityId: post.id, expectedHead: store.getEntityById(post.id)!.headRevision, content: serializeXb(parse('<p>Siamo partiti presto.</p><section class="documenti" aria-label="Documenti allegati"><p>Allegato</p></section>').blocks) });
  const page = store.createPage({ title: "Chi siamo", slug: "chi-siamo", status: "published", content: serializeXb(parse("<p>Una libreria.</p>").blocks) });
  const alias = store.getEntityById(post.id)!.alias;
  store.close();
  return { operations: new ConnectorOperations({ catalog } as unknown as ConnectorOperationsDeps), projectId: project.id, alias, pageAlias: page.alias, reopen: async () => (await catalog.openProject(project.id))!.store };
}

describe("riscrittura di un articolo dal connettore", () => {
  it("legge i blocchi e propone senza scrivere l'articolo", async () => {
    const { operations, projectId, alias, reopen } = await setup();
    const read = await operations.call("articleRead", { projectId, alias }, context);
    const blocks = read.body.blocks as Array<Record<string, unknown>>;
    expect(read.body).toMatchObject({ kind: "post", title: "Un viaggio", proposalWaiting: false });
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "kept"]);
    // A kept block is named, never shown as markup.
    expect(blocks[1]).toEqual({ type: "kept", uid: blocks[1]!.uid, label: "Documenti allegati", summary: "Allegato" });
    const before = (await reopen());
    const head = before.getHead(before.getEntityByAlias(alias)!.id)!;
    before.close();

    const proposed = await operations.call("articlePropose", { projectId, alias, head: read.body.head, title: "Partenza all'alba", excerpt: "Si parte presto.", blocks: JSON.stringify([{ ...blocks[0], html: "Siamo partiti all'alba." }, blocks[1], { type: "heading", level: 2, html: "Il ritorno" }]), note: "Più vivo." }, context);
    expect(proposed.body).toMatchObject({ status: "proposed", blocks: 3, title: true, excerpt: true });
    const store = await reopen();
    const entity = store.getEntityByAlias(alias)!;
    expect(store.getHead(entity.id)).toEqual(head);
    expect(entity.title).toBe("Un viaggio");
    expect(store.getArticleProposal(entity.id)).toMatchObject({ head: head.id, title: "Partenza all'alba", excerpt: "Si parte presto.", note: "Più vivo." });
    store.close();
    expect((await operations.call("articleRead", { projectId, alias }, context)).body.proposalWaiting).toBe(true);
  });

  it("rifiuta un articolo cambiato, markup, JSON rotto e il riassunto di una pagina", async () => {
    const { operations, projectId, alias, pageAlias } = await setup();
    const read = await operations.call("articleRead", { projectId, alias }, context);
    await expect(operations.call("articlePropose", { projectId, alias, head: "vecchia", title: "X" }, context)).rejects.toThrow(/cambiato/u);
    await expect(operations.call("articlePropose", { projectId, alias, head: read.body.head, blocks: JSON.stringify([{ type: "paragraph", html: "<script>alert(1)</script>" }]) }, context)).rejects.toThrow(/formato non ammesso/u);
    await expect(operations.call("articlePropose", { projectId, alias, head: read.body.head, blocks: "non json" }, context)).rejects.toThrow(/JSON/u);
    const page = await operations.call("articleRead", { projectId, alias: pageAlias }, context);
    expect(page.body.kind).toBe("page");
    expect(page.body).not.toHaveProperty("excerpt");
    await expect(operations.call("articlePropose", { projectId, alias: pageAlias, head: page.body.head, excerpt: "No" }, context)).rejects.toThrow(/pagina/u);
    await expect(operations.call("articleRead", { projectId, alias: 9999 }, context)).rejects.toThrow(/non trovato/u);
  });
});
