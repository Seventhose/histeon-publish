import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stylesData } from "../src/histos-css.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { sectionLibrary } from "../src/section-library.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function exampleProject() {
  const catalogs = await Promise.all([0, 1].map(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-section-library-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    await catalog.initialize();
    return catalog;
  }));
  const html = await readFile(new URL("fixtures/prototipo-esempio.html", import.meta.url), "utf8");
  // A section that travels: classes, text and an image, plus a style of its class with a url().
  const extended = html.replace("</template>\n<template data-histos=\"page\"", "</template>\n<template data-histos=\"page\"").replace(/(<template data-histos="page" data-slug="home"[^>]*>)/u, '$1<section class="promo"><h2>Promo</h2><p>Testo della promo</p><img src="asset:ehi" alt="Ehi"></section>');
  const built = await buildPrototypeProfile(parsePrototype(extended), catalogs[0] as CmsProjectCatalog);
  const imported = await (catalogs[1] as CmsProjectCatalog).importStaticPageProfile(built.profile, built.files);
  const store = imported.store;
  const pages = store.listPages().map((page) => ({ title: page.title, slug: page.slug, content: store.getHead(page.id)?.content ?? "" }));
  const stylesHead = store.getHead(store.getStyles()?.id ?? "")?.content;
  const styles = [...(stylesHead ? stylesData(stylesHead).styles ?? [] : []).map((style) => ({ selector: style.selector, css: style.css })), { selector: ".promo", css: "padding: 2rem;\nbackground: url(\"prototype-assets/ehi\");" }];
  store.close();
  return { id: imported.project.id, name: imported.project.name, pages, styles };
}

describe("libreria di sezioni (D5)", () => {
  it("esporta le sezioni che viaggiano, senza media, componenti né dati del progetto, con id stabili", async () => {
    const project = await exampleProject();
    const first = sectionLibrary({ projectId: project.id, projectName: project.name, pages: project.pages, styles: project.styles, created: "2026-10-27T00:00:00.000Z" });
    const again = sectionLibrary({ projectId: project.id, projectName: project.name, pages: project.pages, styles: project.styles, created: "2026-10-28T00:00:00.000Z" });
    expect(first.sections).toBeGreaterThan(0);
    expect(again.file.sections.map((section) => section.id)).toEqual(first.file.sections.map((section) => section.id));
    expect(first.file).toMatchObject({ format: "xb-library", version: 1 });
    const promo = first.file.sections.find((section) => section.name.endsWith("section.promo"));
    expect(promo).toBeTruthy();
    const clip = JSON.parse(promo?.clip ?? "{}") as { xb: string; version: number; origin: string; markup: string; styles: Array<{ selector: string; css: string }> };
    expect(clip).toMatchObject({ xb: "clip", version: 1, origin: project.name });
    expect(clip.markup).toContain("Testo della promo");
    expect(clip.markup).not.toMatch(/"tag":"img"|histos-media|prototype-assets/u);
    expect(clip.styles).toEqual([{ selector: ".promo", css: "padding: 2rem;" }]);
    for (const section of first.file.sections) expect(section.clip).not.toMatch(/wp:xb\/component|wp:xb\/loop|histos-media/u);
    const notes = first.notes.join("\n");
    expect(notes).toMatch(/usa(?:no)? componenti/u);
    expect(notes).toMatch(/immagin[ei] tolt[ae]/u);
    expect(notes).toMatch(/senza le dichiarazioni con url\(\)/u);
    expect(first.file.hash).toBe(createHash("sha256").update(JSON.stringify(first.file.sections)).digest("hex"));
  });

  it("ha l'hash che WordPress ricalcola importando (json_encode con le stesse opzioni)", async () => {
    const php = spawnSync("php", ["-v"], { encoding: "utf8" });
    if (php.status !== 0) return;
    const project = await exampleProject();
    project.pages[0] = { ...(project.pages[0] as { title: string; slug: string; content: string }), title: "Riga separata «è» / x" };
    const { file } = sectionLibrary({ projectId: project.id, projectName: project.name, pages: project.pages, styles: project.styles, created: "2026-10-27T00:00:00.000Z" });
    const check = spawnSync("php", ["-r", '$d = json_decode(stream_get_contents(STDIN), true); echo hash_equals(hash("sha256", json_encode($d["sections"], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)), $d["hash"]) ? "ok" : "diverso";'], { input: JSON.stringify(file), encoding: "utf8" });
    expect(check.stdout).toBe("ok");
  });
});
