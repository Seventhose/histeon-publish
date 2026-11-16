import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "../src/project-repository.js";

/**
 * Review 7, group B1: a record saved without a locale is in the project's language (the store's render settings), not
 * always in Italian: on an English site it went to it-IT, outside the site's language and its archive.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-record-locale-"));
  roots.push(root);
  const opened = await new CmsProjectCatalog(root).createProject("Lingua");
  const saved = opened.store.content.saveType({ key: "opera", label: "Opere", fields: [] });
  expect(saved.status).toBe("saved");
  return opened.store;
}

function record<T extends { status: string }>(result: T) {
  if (result.status !== "saved") throw new Error(JSON.stringify(result));
  return (result as unknown as { record: { id: string; locale: string; headRevision: string } }).record;
}

describe("la lingua di un record salvato senza locale (B1)", () => {
  it("è quella del progetto, e un record la tiene se la si cambia dopo", async () => {
    const project = await store();
    project.setRenderSettings({ ...project.getRenderSettings(), locale: "en-US" });
    // Before: it-IT on an en-US project.
    const created = record(project.content.saveRecord({ typeKey: "opera", title: "Moon" }));
    expect(created.locale).toBe("en-US");
    expect(record(project.content.createRecord({ typeKey: "opera", title: "Sun" })).locale).toBe("en-US");
    project.setRenderSettings({ ...project.getRenderSettings(), locale: "de-DE" });
    expect(record(project.content.saveRecord({ id: created.id, typeKey: "opera", title: "Mond", expectedHead: created.headRevision })).locale).toBe("en-US");
    expect(record(project.content.saveRecord({ typeKey: "opera", title: "Stern" })).locale).toBe("de-DE");
    // A locale given is kept as given.
    expect(record(project.content.saveRecord({ typeKey: "opera", title: "Luna", locale: "it-IT" })).locale).toBe("it-IT");
  });

  it("una query risolta senza la lingua della pagina usa la stessa lingua del progetto, non it-IT", async () => {
    const project = await store();
    project.setRenderSettings({ ...project.getRenderSettings(), locale: "de-DE" });
    record(project.content.saveRecord({ typeKey: "opera", title: "Mond", status: "published", publishedAt: "2026-10-01T09:00:00Z" }));
    record(project.content.saveRecord({ typeKey: "opera", title: "Luna", locale: "it-IT", status: "published", publishedAt: "2026-10-01T09:00:00Z" }));
    expect(project.content.saveQueryPreset({ key: "opere", label: "Opere", typeKey: "opera", expectedHead: null }).status).toBe("saved");
    // Before: the default page language was it-IT, so the project's own record was missing and Luna came unprefixed.
    expect(project.content.resolveQueryPreset("opere").map((item) => [item.title, item.locale, item.url])).toEqual([["Mond", "de-DE", "/opera/mond/"]]);
    expect(project.content.previewQueryDefinition({ type: "posts", args: { post_type: "opera" } }).map((item) => [item.title, item.url])).toEqual([["Mond", "/opera/mond/"]]);
    // A page language given is used as given, with its own prefix for the other languages, and with the site's records
    // that have no version in it: a translated page does not stay empty.
    expect(project.content.resolveQueryPreset("opere", {}, "it-IT").map((item) => [item.title, item.url]).sort()).toEqual([["Luna", "/it-it/opera/luna/"], ["Mond", "/opera/mond/"]]);
  });

  it("senza impostazioni salvate è quella che il progetto usa, la lingua del computer", async () => {
    const project = await store();
    expect(record(project.content.saveRecord({ typeKey: "opera", title: "Moon" })).locale).toBe(project.getRenderSettings().locale);
  });
});
