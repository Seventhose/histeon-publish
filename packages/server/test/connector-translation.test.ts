import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog, type CmsProjectStore } from "@histos-publish/cms";
import { parse, serializeXb } from "../../cms/.generated/histos-dsl/index.js";
import { ConnectorOperations, type ConnectorOperationsDeps } from "../src/connector-operations.js";

/** Translation through the closed list (doc 20 §7): texts only, drafts only, nothing online is touched. */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const context = { client: "test", signal: new AbortController().signal };

async function setup(): Promise<{ operations: ConnectorOperations; projectId: string; sourceId: string; reopen: () => Promise<CmsProjectStore> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-connector-translation-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  const { project, store } = await catalog.createProject("Tradurre");
  store.setRenderSettings({ locale: "it-IT", timeZone: "Europe/Rome" });
  store.setProjectLanguages([{ code: "en" }]);
  const page = store.createPage({ title: "Benvenuti", slug: "benvenuti", status: "published", content: serializeXb(parse('<h1 class="a">Ciao {page.title}</h1>').blocks) });
  store.setTranslationBrief("Sito di una libreria.");
  store.close();
  return { operations: new ConnectorOperations({ catalog } as unknown as ConnectorOperationsDeps), projectId: project.id, sourceId: page.id, reopen: async () => (await catalog.openProject(project.id))!.store };
}

describe("traduzione dal connettore", () => {
  it("legge il lavoro e salva testi in una bozza", async () => {
    const { operations, projectId, sourceId, reopen } = await setup();
    const brief = await operations.call("translationBrief", { projectId }, context);
    expect(brief.body).toMatchObject({ brief: "Sito di una libreria.", defaultLanguage: "it-IT" });
    const work = await operations.call("translationWork", { projectId, language: "en", state: "missing" }, context);
    expect(work.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: sourceId, state: "missing" })]));
    const source = await operations.call("translationSource", { projectId, sourceId, language: "en" }, context);
    const segments = source.body.segments as Array<{ id: string; text: string }>;
    const heading = segments.find((segment) => segment.text.startsWith("Ciao"))!;
    const saved = await operations.call("translationSave", { projectId, sourceId, language: "en", segments: JSON.stringify({ title: "Welcome", [heading.id]: "Hello {page.title}" }) }, context);
    expect(saved.body).toMatchObject({ status: "draft", left: 0 });
    const store = await reopen();
    const draft = store.getEntityById(saved.body.translationId as string)!;
    expect(draft).toMatchObject({ status: "draft", locale: "en", title: "Welcome" });
    expect(store.getHead(draft.id)!.content).toContain("Hello {page.title}");
    store.close();
  });

  it("rifiuta markup, espressioni nuove e versioni pubblicate", async () => {
    const { operations, projectId, sourceId, reopen } = await setup();
    const source = await operations.call("translationSource", { projectId, sourceId, language: "en" }, context);
    const heading = (source.body.segments as Array<{ id: string; text: string }>).find((segment) => segment.text.startsWith("Ciao"))!;
    await expect(operations.call("translationSave", { projectId, sourceId, language: "en", segments: JSON.stringify({ [heading.id]: "<img src=x onerror=alert(1)>{page.title}" }) }, context)).rejects.toThrow("tag");
    await expect(operations.call("translationSave", { projectId, sourceId, language: "en", segments: JSON.stringify({ [heading.id]: "Hello" }) }, context)).rejects.toThrow("espressioni");
    await expect(operations.call("translationSave", { projectId, sourceId, language: "en", segments: "non json" }, context)).rejects.toThrow("JSON");
    const saved = await operations.call("translationSave", { projectId, sourceId, language: "en", segments: JSON.stringify({ title: "One" }) }, context);
    let store = await reopen();
    store.updatePageMetadata(saved.body.translationId as string, { title: "One", slug: "benvenuti", status: "published" });
    store.close();
    await expect(operations.call("translationSave", { projectId, sourceId, language: "en", segments: JSON.stringify({ title: "Two" }) }, context)).rejects.toThrow("pubblicata");
    store = await reopen();
    expect(store.getEntityById(saved.body.translationId as string)).toMatchObject({ title: "One", status: "published" });
    store.close();
  });

  it("le stringhe arrivano come bozze e non toccano ciò che è pubblicato", async () => {
    const { operations, projectId, reopen } = await setup();
    await operations.call("translationSaveStrings", { projectId, language: "en", strings: JSON.stringify([{ source: "Cerca", translation: "Search", context: "manual" }]) }, context);
    let store = await reopen();
    expect(store.publishedStrings("en").size).toBe(0);
    store.saveStrings("en", [{ source: "Cerca", translation: "Find", context: "manual" }], "published");
    store.close();
    await expect(operations.call("translationSaveStrings", { projectId, language: "en", strings: JSON.stringify([{ source: "Cerca", translation: "Search", context: "manual" }]) }, context)).rejects.toThrow("pubblicata");
    store = await reopen();
    expect(store.publishedStrings("en").get("Cerca")).toBe("Find");
    store.close();
  });
});
