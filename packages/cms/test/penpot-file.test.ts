import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yazl from "yazl";
import { importDesignTokens, readDesignTokens } from "../src/design-tokens.js";
import { readDesignZip } from "../src/design-zip.js";
import { penpotLibraryEntry, penpotTokenFiles, readPenpotLibrary } from "../src/penpot-file.js";

const FILE = "11111111-1111-4111-8111-111111111111";
const PAGE = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;

function zip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) archive.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
    const chunks: Buffer[] = [];
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on("error", reject);
    archive.end();
  });
}

/** A small export written by hand with the fields of a real one (Penpot 2.5, export version 3). */
function penpotEntries(extra: Record<string, string | Buffer> = {}): Record<string, string | Buffer> {
  const j = (data: unknown) => JSON.stringify(data);
  return {
    "manifest.json": j({ type: "penpot/export-files", version: 1, generatedBy: "penpot/2.5.4", files: [{ id: FILE, name: "Sito di prova", features: [] }], relations: [] }),
    [`files/${FILE}.json`]: j({ id: FILE, name: "Sito di prova", options: { componentsV2: true } }),
    [`files/${FILE}/colors/${id(1)}.json`]: j({ id: id(1), name: "Primary", path: "Primary", color: "#6750A4", opacity: 1 }),
    [`files/${FILE}/colors/${id(2)}.json`]: j({ id: id(2), name: "On Primary", path: "Primary", color: "#ffffff", opacity: 1 }),
    [`files/${FILE}/colors/${id(3)}.json`]: j({ id: id(3), name: "20%", path: "Remote / Static White", color: "#ffffff", opacity: 0.2 }),
    [`files/${FILE}/colors/${id(4)}.json`]: j({ id: id(4), name: "Color 1", path: "Gradient / Primary", color: "#000000", opacity: 1 }),
    [`files/${FILE}/colors/${id(5)}.json`]: j({ id: id(5), name: "Sfondo sfumato", path: "", gradient: { type: "linear", stops: [] }, opacity: 1 }),
    [`files/${FILE}/typographies/${id(6)}.json`]: j({ id: id(6), name: "Body Small", path: "Body", fontFamily: "Roboto", fontSize: "12", fontWeight: "400", lineHeight: "1.2", letterSpacing: "0.04", fontStyle: "normal", textTransform: "none" }),
    [`files/${FILE}/typographies/${id(7)}.json`]: j({ id: id(7), name: "Body Large", path: "Body", fontFamily: "Roboto", fontSize: "16", fontWeight: "400", lineHeight: "1.5", letterSpacing: "0", fontStyle: "normal", textTransform: "none" }),
    [`files/${FILE}/typographies/${id(8)}.json`]: j({ id: id(8), name: "Headline Large", path: "Headline", fontFamily: "Roboto Slab", fontSize: "32", fontWeight: "600", lineHeight: "1.2", letterSpacing: "0", fontStyle: "normal", textTransform: "none" }),
    [`files/${FILE}/typographies/${id(9)}.json`]: j({ id: id(9), name: "Rotta", path: "", fontSize: "12" }),
    [`files/${FILE}/components/${id(10)}.json`]: j({ id: id(10), name: "Card", path: "Blocchi / Card", mainInstanceId: id(20), mainInstancePage: PAGE }),
    [`files/${FILE}/pages/${PAGE}.json`]: j({ id: PAGE, name: "Home", index: 0 }),
    [`files/${FILE}/pages/${PAGE}/${id(20)}.json`]: j({ id: id(20), name: "Card", type: "frame" }),
    [`files/${FILE}/pages/${PAGE}/${id(21)}.json`]: j({ id: id(21), name: "Titolo", type: "text" }),
    "objects/aa/bb/immagine.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    ...extra,
  };
}

describe("archivio di un file di design", () => {
  it("apre solo le voci chieste ed elenca le altre", async () => {
    const archive = await zip(penpotEntries());
    const read = await readDesignZip(archive, penpotLibraryEntry);
    expect(read.names.length).toBe(Object.keys(penpotEntries()).length);
    expect(read.files.has("manifest.json")).toBe(true);
    expect(read.files.has(`files/${FILE}/colors/${id(1)}.json`)).toBe(true);
    // The shapes and the media are listed, not read.
    expect(read.files.has(`files/${FILE}/pages/${PAGE}/${id(20)}.json`)).toBe(false);
    expect(read.files.has("objects/aa/bb/immagine.png")).toBe(false);
    expect(read.names).toContainEqual({ name: "objects/aa/bb/immagine.png", size: 4 });
  });

  it("rifiuta ciò che non è uno ZIP e ciò che supera i limiti", async () => {
    await expect(readDesignZip(Buffer.from("non sono uno zip"), () => true)).rejects.toThrow(/non è un archivio ZIP/u);
    const archive = await zip(penpotEntries());
    await expect(readDesignZip(archive, () => true, { entries: 3 })).rejects.toThrow(/più di 3 file/u);
    await expect(readDesignZip(archive, () => true, { totalBytes: 100 })).rejects.toThrow(/troppo grande/u);
    await expect(readDesignZip(archive, () => true, { archiveBytes: 10 })).rejects.toThrow(/supera/u);
    // Over the limit, but not asked for: only listed.
    await expect(readDesignZip(archive, () => false, { totalBytes: 1 })).resolves.toMatchObject({ files: new Map() });
  });
});

describe("libreria di un file Penpot", () => {
  it("legge colori, tipografie, componenti e pagine", async () => {
    const library = readPenpotLibrary(await readDesignZip(await zip(penpotEntries()), penpotLibraryEntry));
    expect(library).toMatchObject({ name: "Sito di prova", generatedBy: "penpot/2.5.4", fromFigma: false, problems: [] });
    expect(library.colors).toContainEqual({ id: id(1), name: "Primary", path: ["Primary"], hex: "#6750a4", opacity: 1 });
    // «Remote» is the mark of the Figma exporter, not a group.
    expect(library.colors).toContainEqual({ id: id(3), name: "20%", path: ["Static White"], hex: "#ffffff", opacity: 0.2 });
    expect(library.colors.find((color) => color.id === id(5))?.hex).toBeNull();
    expect(library.typographies.find((item) => item.name === "Body Large")).toMatchObject({ fontFamily: "Roboto", fontSizePx: 16, fontWeight: 400, lineHeight: 1.5 });
    expect(library.components).toEqual([{ id: id(10), name: "Card", path: ["Blocchi", "Card"] }]);
    expect(library.pages).toEqual([{ id: PAGE, fileId: FILE, name: "Home", shapes: 2 }]);
    expect(library.tokens).toEqual([]);
  });

  it("dà file di token che il lettore dei token capisce, e dice ciò che resta fuori", async () => {
    const library = readPenpotLibrary(await readDesignZip(await zip(penpotEntries()), penpotLibraryEntry));
    const { files, problems } = penpotTokenFiles(library);
    expect(files.map((file) => file.name)).toEqual(["Sito di prova: libreria"]);
    expect(problems).toEqual([
      { token: "Sfondo sfumato", why: "colore della libreria con sfumatura o immagine: non è un token" },
      { token: "Rotta", why: "tipografia della libreria senza carattere o senza misura" },
    ]);
    const read = readDesignTokens(files);
    expect(read.problems).toEqual([]);
    const result = importDesignTokens(read);
    // The group «Primary» is not repeated before «Primary» and «On Primary».
    expect(result.report.mapped).toContainEqual({ param: "primary", token: "color.Primary", value: "#6750a4" });
    // The stop of a gradient is not the colour of the family.
    expect(result.report.mapped.filter((item) => item.param === "primary")).toHaveLength(1);
    expect(result.siteTokens).toMatchObject({ "color-on-primary": "#ffffff", "color-static-white-20": "rgb(255 255 255 / 0.2)", "color-gradient-primary-color-1": "#000000" });
    // Among the body styles, the one nearest 16 px is the running text, with its own leading.
    expect(result.design).toMatchObject({ text_max: 16, text_leading: 1.5, heading_weight: 600 });
    expect(String(result.design.font_heading)).toContain("Roboto Slab");
    expect(result.report.textSizes.map((item) => item.token)).toContain("typography.Headline Large");
    expect(JSON.stringify(result.siteTokens)).not.toMatch(/\d(?:\.\d+)?px/u);
  });

  it("passa tokens.json com'è quando ha token, e lo salta quando gli insiemi sono vuoti", async () => {
    const empty = { "Collection 1/Mode 1": {}, $themes: [], $metadata: { tokenSetOrder: ["Collection 1/Mode 1"] } };
    const full = { Globale: { raggio: { card: { $value: "12", $type: "borderRadius" } }, primary: { $value: "#112233", $type: "color" } }, $themes: [], $metadata: { tokenSetOrder: ["Globale"] } };
    const without = readPenpotLibrary(await readDesignZip(await zip(penpotEntries({ [`files/${FILE}/tokens.json`]: JSON.stringify(empty) })), penpotLibraryEntry));
    expect(without.tokens).toEqual([]);
    const withTokens = readPenpotLibrary(await readDesignZip(await zip(penpotEntries({ [`files/${FILE}/tokens.json`]: JSON.stringify(full) })), penpotLibraryEntry));
    expect(withTokens.tokens.map((file) => file.name)).toEqual(["Sito di prova: tokens.json"]);
    const { files } = penpotTokenFiles(withTokens);
    const result = importDesignTokens(readDesignTokens(files));
    // A token of the file wins over the library colour of the same family.
    expect(result.report.mapped).toContainEqual({ param: "primary", token: "primary", value: "#112233" });
    expect(result.design.radius).toBe(12);
  });

  it("rifiuta un archivio che non è di Penpot e segnala una voce rotta senza fermarsi", async () => {
    await expect(readDesignZip(await zip({ "canvas.fig": "x" }), penpotLibraryEntry).then(readPenpotLibrary)).rejects.toThrow(/non è un'esportazione di Penpot/u);
    const broken = readPenpotLibrary(await readDesignZip(await zip(penpotEntries({ [`files/${FILE}/colors/${id(30)}.json`]: "{" })), penpotLibraryEntry));
    expect(broken.problems).toEqual([{ token: `files/${FILE}/colors/${id(30)}.json`, why: "il file dell'archivio non è JSON leggibile" }]);
    expect(broken.colors).toHaveLength(5);
  });

  it("un nome ostile non esce dal file dei token", async () => {
    const hostile = penpotEntries({ [`files/${FILE}/colors/${id(31)}.json`]: JSON.stringify({ id: id(31), name: "x;} body{display:none}", path: "$extensions.{a}", color: "#010203", opacity: 1 }) });
    const { files } = penpotTokenFiles(readPenpotLibrary(await readDesignZip(await zip(hostile), penpotLibraryEntry)));
    const result = importDesignTokens(readDesignTokens(files));
    // The name became a slug of plain words; no character of it can close a rule.
    expect(Object.entries(result.siteTokens).flat().join(" ")).not.toMatch(/[{};]/u);
    for (const line of result.acss.css.split("\n").slice(1, -2)) expect(line).toMatch(/^ {2}--ds-[a-z0-9-]+: [^;{}]+;$/u);
  });
});

/** The three files the user gave on 13 November 2026: kits of others, read where they are and never copied here. */
describe("file Penpot veri (saltati se non ci sono)", () => {
  const folder = path.join(os.homedir(), "Scaricati");
  const real: Array<[string, { colors: number; typographies: number; components: number; pages: number; fromFigma: boolean; primary: string }]> = [
    ["Material Design 3.penpot", { colors: 30, typographies: 16, components: 382, pages: 6, fromFigma: false, primary: "#6750a4" }],
    ["Essential UI - Figma Ui Kit (Community).penpot", { colors: 29, typographies: 17, components: 236, pages: 3, fromFigma: true, primary: "#2091f9" }],
    ["Dashboard UI Kit - Dashboard, Free Admin Dashboard (Community).penpot", { colors: 13, typographies: 17, components: 0, pages: 4, fromFigma: true, primary: "" }],
  ];
  for (const [name, expected] of real) {
    const file = path.join(folder, name);
    it.skipIf(!existsSync(file))(name, async () => {
      const library = readPenpotLibrary(await readDesignZip(readFileSync(file), penpotLibraryEntry));
      expect({ colors: library.colors.length, typographies: library.typographies.length, components: library.components.length, pages: library.pages.length, fromFigma: library.fromFigma, problems: library.problems })
        .toEqual({ colors: expected.colors, typographies: expected.typographies, components: expected.components, pages: expected.pages, fromFigma: expected.fromFigma, problems: [] });
      expect(library.pages.every((page) => page.shapes > 0)).toBe(true);
      const { files } = penpotTokenFiles(library);
      const read = readDesignTokens(files);
      expect(read.problems).toEqual([]);
      const result = importDesignTokens(read);
      expect(result.report.mapped.find((item) => item.param === "primary")?.value ?? "").toBe(expected.primary);
      expect(Number(result.design.text_max ?? 16)).toBeGreaterThanOrEqual(16);
      expect(result.report.textSizes.length).toBeGreaterThan(10);
      expect(JSON.stringify(result.siteTokens)).not.toMatch(/\d(?:\.\d+)?px/u);
    });
  }
});
