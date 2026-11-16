import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asFontSheet, FONT_SHEET_ID, fontFamilies, withFamily, type FontSheet } from "../src/local-fonts.js";
import { createStaticPageProfile, decodeStaticPageArchive, encodeStaticPageProfileArchive } from "../src/page-transfer.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { renderCmsPage } from "../src/static-renderer.js";

/** The fonts of a project (the builder's «Font del sito» panel in Histeon Publish). */
const WOFF2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0, 0, 0, 0, 0]);
const face = (family: string, weight: string, style: string, file: string) => `@font-face {\n  font-family: "${family}";\n  font-style: ${style};\n  font-weight: ${weight};\n  font-display: swap;\n  src: url("histos-fonts/${file}") format("woff2");\n}`;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function catalog(): Promise<CmsProjectCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-fonts-"));
  roots.push(root);
  return new CmsProjectCatalog(root, { durable: false });
}

describe("font del progetto", () => {
  it("legge le famiglie, ne sostituisce una e toglie i media che nessuna regola nomina", () => {
    const sheet: FontSheet = { css: [face("Inter", "400", "normal", "inter-400.woff2"), face("Inter", "700", "normal", "inter-700.woff2"), face("Lora", "400", "italic", "lora-400i.woff2")].join("\n"), assets: [{ reference: "histos-fonts/inter-400.woff2", assetId: "a" }, { reference: "histos-fonts/inter-700.woff2", assetId: "b" }, { reference: "histos-fonts/lora-400i.woff2", assetId: "c" }] };
    expect(fontFamilies(sheet)).toEqual([{ family: "Inter", faces: [{ weight: "400", style: "normal" }, { weight: "700", style: "normal" }] }, { family: "Lora", faces: [{ weight: "400", style: "italic" }] }]);
    const withoutInter = withFamily(sheet, "Inter", []);
    expect(fontFamilies(withoutInter).map((item) => item.family)).toEqual(["Lora"]);
    expect(withoutInter?.assets).toEqual([{ reference: "histos-fonts/lora-400i.woff2", assetId: "c" }]);
    expect(withFamily(withoutInter, "Lora", [])).toBeNull();
  });

  it("un foglio ricevuto è dei font solo se ha soltanto regole @font-face verso i suoi media", () => {
    const ok = { id: FONT_SHEET_ID, css: face("Inter", "400", "normal", "x.woff2"), assets: [{ reference: "histos-fonts/x.woff2", assetId: "a" }] };
    expect(asFontSheet(ok)).not.toBeNull();
    expect(asFontSheet({ ...ok, id: "altro" })).toBeNull();
    expect(asFontSheet({ ...ok, css: `${ok.css}\nbody{color:red}` })).toBeNull();
    expect(asFontSheet({ ...ok, assets: [] })).toBeNull();
    expect(asFontSheet({ ...ok, css: ok.css.replace("histos-fonts/x.woff2", "https://altro.example/x.woff2") })).toBeNull();
  });

  it("stanno nel progetto fuori dagli stili, arrivano nella pagina e viaggiano col progetto", async () => {
    const origin = await catalog();
    const { project, store } = await origin.createProject("Font");
    const asset = store.saveAsset({ bytes: WOFF2, mimeType: "font/woff2", filename: "inter-400.woff2" });
    const stylesHead = store.getHead(store.getStyles()!.id)!.id;
    const revision = store.getProjectRevision();
    store.setFontSheet({ css: face("Inter", "400", "normal", "inter-400.woff2"), assets: [{ reference: "histos-fonts/inter-400.woff2", assetId: asset.id }] });
    // The editor's styles keep their revision: no conflict for a font added from the panel. The site changes.
    expect(store.getHead(store.getStyles()!.id)!.id).toBe(stylesHead);
    expect(store.getProjectRevision()).not.toBe(revision);
    expect(() => store.setFontSheet({ css: face("Inter", "400", "normal", "y.woff2"), assets: [{ reference: "histos-fonts/y.woff2", assetId: "00000000-0000-4000-8000-000000000000" }] })).toThrow(/media/u);

    const rendered = await renderCmsPage({ store, projectId: project.id, content: "", page: { id: "x", title: "Home", slug: "home", url: "/" }, mediaBase: "/__cms-media" });
    expect(rendered.globalCss).toContain(`font-family: "Inter"`);
    expect(rendered.globalCss).toContain(asset.id);

    const exported = await createStaticPageProfile(project, store);
    const styles = exported.profile.entities.find((entity) => entity.kind === "styles");
    expect(((styles?.payload.globals ?? []) as Array<{ id: string }>).map((sheet) => sheet.id)).toContain(FONT_SHEET_ID);
    const archive = await encodeStaticPageProfileArchive(exported.profile, exported.files);
    const decoded = await decodeStaticPageArchive(archive);
    const receiving = await catalog();
    const imported = await receiving.importStaticPageProfile(decoded.profile, decoded.files);
    try {
      expect(fontFamilies(imported.store.getFontSheet())).toEqual([{ family: "Inter", faces: [{ weight: "400", style: "normal" }] }]);
      const globals = JSON.parse(imported.store.getHead(imported.store.getStyles()!.id)!.content).globals as Array<{ id: string }>;
      expect(globals.map((sheet) => sheet.id)).not.toContain(FONT_SHEET_ID);
      const again = await createStaticPageProfile(imported.project, imported.store);
      expect(again.profile.entities.find((entity) => entity.kind === "styles")?.revisionHash).toBe(styles?.revisionHash);
    } finally {
      imported.store.close();
      store.close();
    }
  });
});
