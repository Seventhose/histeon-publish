import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { designFileTokens } from "../src/design-file.js";
import { importDesignTokens, readDesignTokens } from "../src/design-tokens.js";
import { readDesignZip } from "../src/design-zip.js";
import { figFileEntry, figFileName, figTokenFiles, readFigLibrary } from "../src/fig-file.js";
import { decodeKiwi, isFigKiwi, readFigContainer, readKiwiSchema } from "../src/fig-kiwi.js";
import { DEFINITIONS, HAS_ZSTD, container, fill, guid, messageBytes, rgb, sampleCanvas, sampleNodes, schemaBytes, solid, textStyle, under, value, variable, zip } from "./fig-writer.js";

describe("contenitore e schema di canvas.fig", () => {
  it("legge firma, versione, schema e messaggio, con deflate e con zstd", () => {
    const data = { sentTimestamp: 2n ** 60n + 5n, pasteID: -7, offset: -(2n ** 40n), blob: [1, 2, 255], nodeChanges: [{ guid: guid(4_000_000_000, 7), type: "TEXT", name: "Perché → così", fontSize: 17.5, lineHeight: { value: -0.25, units: "PIXELS" }, visible: false }] };
    for (const zstd of HAS_ZSTD ? [false, true] : [false]) {
      const read = readFigContainer(container(schemaBytes(DEFINITIONS), messageBytes(DEFINITIONS, "Message", data), { zstd, version: 77 }));
      expect(read.version).toBe(77);
      const definitions = readKiwiSchema(read.schema);
      expect(definitions).toEqual(DEFINITIONS);
      const message = decodeKiwi(definitions, read.message, "Message");
      expect(message.sentTimestamp).toBe(2n ** 60n + 5n);
      expect(message.pasteID).toBe(-7);
      expect(message.offset).toBe(-(2n ** 40n));
      expect([...(message.blob as Uint8Array)]).toEqual([1, 2, 255]);
      const [first] = message.nodeChanges as Array<Record<string, unknown>>;
      expect(first).toMatchObject({ guid: { sessionID: 7, localID: 4_000_000_000 }, type: "TEXT", name: "Perché → così", fontSize: 17.5, lineHeight: { value: -0.25, units: "PIXELS" }, visible: false });
      // A field that was not written is not there, and an object has no prototype to reach.
      expect("styleType" in first!).toBe(false);
      expect(Object.getPrototypeOf(first)).toBeNull();
    }
  });

  it("un campo che si chiama __proto__ è un campo come gli altri", () => {
    const message = decodeKiwi(DEFINITIONS, messageBytes(DEFINITIONS, "Message", { ["__proto__"]: "x", nodeChanges: [] }), "Message");
    expect(Object.getPrototypeOf(message)).toBeNull();
    expect(Object.keys(message)).toEqual(["nodeChanges", "__proto__"]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("rifiuta ciò che non è un canvas.fig, ciò che è troncato e ciò che lo schema non spiega", () => {
    const schema = schemaBytes(DEFINITIONS);
    const message = messageBytes(DEFINITIONS, "Message", { nodeChanges: sampleNodes() });
    const good = container(schema, message);
    expect(isFigKiwi(good)).toBe(true);
    expect(isFigKiwi(Buffer.from("fig-jam."))).toBe(false);
    expect(() => readFigContainer(Buffer.from("PK\u0003\u0004 non sono un canvas"))).toThrow(/non comincia con la firma fig-kiwi/u);
    expect(() => readFigContainer(good.subarray(0, 40))).toThrow(/più lungo del file|mancano lo schema/u);
    expect(() => readFigContainer(good.subarray(0, 12))).toThrow(/mancano lo schema o i dati/u);
    const junk = Buffer.concat([good.subarray(0, 12), Buffer.from([4, 0, 0, 0, 1, 2, 3, 4, 4, 0, 0, 0, 9, 9, 9, 9])]);
    expect(() => readFigContainer(junk)).toThrow(/dati compressi sono rovinati/u);
    // A message cut in the middle, a field the schema does not have, a list longer than the data.
    expect(() => decodeKiwi(DEFINITIONS, message.subarray(0, message.length - 9), "Message")).toThrow(/Il file di Figma non si legge/u);
    expect(() => decodeKiwi(DEFINITIONS, Buffer.from([99, 0]), "Message")).toThrow(/un campo di «Message» non è nello schema/u);
    expect(() => decodeKiwi(DEFINITIONS, Buffer.from([1, 0xff, 0xff, 0xff, 0x7f]), "Message")).toThrow(/una lista è più lunga dei dati/u);
    expect(() => decodeKiwi(DEFINITIONS, message, "Messaggio")).toThrow(/lo schema non ha «Messaggio»/u);
    expect(() => readKiwiSchema(Buffer.from([1, 65, 0, 7, 0]))).toThrow(/definizione non valida/u);
    expect(() => readKiwiSchema(schemaBytes([{ name: "A", kind: "message", fields: [{ name: "b", type: 5, array: false, value: 1 }] }]))).toThrow(/un tipo che non ha/u);
    // Layers nested deeper than any file: refused, not followed until the stack ends.
    let deep: Record<string, unknown> = { name: "fondo" };
    for (let level = 0; level < 80; level += 1) deep = { children: [deep] };
    expect(() => decodeKiwi(DEFINITIONS, messageBytes(DEFINITIONS, "Message", { nodeChanges: [deep] }), "Message")).toThrow(/annidati oltre il limite/u);
  });
});

describe("libreria di un file .fig", () => {
  it("legge stili di colore, di testo e di effetto, le variabili coi loro modi, pagine e componenti", () => {
    const library = readFigLibrary(sampleCanvas(), "Kit di prova");
    expect(library).toMatchObject({ name: "Kit di prova", version: 101, grids: 1, components: 1, pages: [{ name: "Design", layers: 3 }], layers: 3 });
    expect(library.fills.map((style) => [[...style.path, style.name].join("/"), style.color && [style.color.r, style.color.g, style.color.b, style.color.alpha], style.uses])).toEqual([
      ["Brand/Primary", [103, 80, 164, 1], 1],
      ["Colors/White/20%", [255, 255, 255, 0.2], 0],
      // Two styles called «Yellow»: the one a layer uses (by the key of its library) stays.
      ["Yellow", [255, 189, 0, 1], 1],
      ["Sfondo sfumato", null, 0],
      ["Due riempimenti", null, 0],
    ]);
    expect(library.texts).toEqual([
      { name: "Large", path: ["Body"], uses: 0, fontFamily: "Roboto", fontStyle: "Regular", fontSizePx: 22, fontWeight: 400, lineHeight: { value: 1.3, unit: "ratio" } },
      { name: "Medium", path: ["Body"], uses: 0, fontFamily: "Roboto", fontStyle: "Regular", fontSizePx: 15, fontWeight: 400, lineHeight: { value: 27, unit: "px" } },
      // PERCENT 100 is the automatic line height; the weight comes from the name of the font style later.
      { name: "H1", path: ["Heading"], uses: 0, fontFamily: "Roboto Slab", fontStyle: "SemiBold", fontSizePx: 48, fontWeight: null, lineHeight: null },
      { name: "Etichetta", path: [], uses: 0, fontFamily: "Roboto", fontStyle: "Medium", fontSizePx: 12, fontWeight: null, lineHeight: null },
    ]);
    expect(library.effects).toEqual([{ name: "Card", path: ["Shadow"], uses: 0, other: ["BACKGROUND_BLUR"], shadows: [
      { x: 0, y: 4, blur: 12, spread: 0, color: { r: 0, g: 0, b: 0, alpha: 0.25 }, inset: false },
      { x: 0, y: 1, blur: 0, spread: 0, color: { r: 255, g: 255, b: 255, alpha: 0.5 }, inset: true },
    ] }]);
    expect(library.collections).toEqual([{ name: "Colori", modes: ["Light", "Dark", "Contrasto"] }, { name: "Misure", modes: ["Mode 1"] }, { name: "Caratteri", modes: ["Mode 1"] }]);
    expect(library.variables.map((item) => [item.name, item.collection, item.type, item.values])).toEqual([
      ["500", 0, "color", [{ color: { r: 29, g: 78, b: 216, alpha: 1 } }, { color: { r: 147, g: 197, b: 253, alpha: 1 } }, null]],
      // An alias by the key of the library and one by GUID lead to the same variable.
      ["Primary", 0, "color", [{ alias: 0 }, { alias: 0 }, null]],
      ["Card", 1, "number", [{ number: 12 }]],
      ["Gap", 1, "number", [{ number: 24 }]],
      ["Gap", 2, "number", [{ number: 8 }]],
      ["Plain", 2, "text", [{ text: "Source Sans 3" }]],
      ["Font", 2, "text", [{ alias: 5 }]],
      ["Mostra", 1, "boolean", [{ boolean: true }]],
    ]);
    expect(library.problems).toEqual([
      { token: "Etichetta", why: "interlinea in percentuale del carattere: non letta" },
      { token: "Orfana", why: "variabile senza la sua raccolta: non letta" },
      { token: "Yellow", why: "2 stili di colore con questo nome e 2 valori diversi: tenuto il più usato" },
    ]);
  });

  it("dà un file di insiemi che il lettore dei token capisce, col tema scuro, e dice ciò che resta fuori", () => {
    const { files, problems } = figTokenFiles(readFigLibrary(sampleCanvas(), "Kit di prova"));
    expect(files.map((file) => file.name)).toEqual(["Kit di prova: stili e variabili"]);
    const document = JSON.parse(files[0]!.text) as Record<string, unknown>;
    expect(document.$metadata).toEqual({ tokenSetOrder: ["Stili", "Colori", "Misure", "Caratteri", "Colori (Dark)"] });
    expect(document.$themes).toEqual([
      { id: "light", name: "Light", selectedTokenSets: { Stili: "enabled", Colori: "enabled", Misure: "enabled", Caratteri: "enabled" } },
      { id: "dark", name: "Dark", selectedTokenSets: { Stili: "enabled", Colori: "enabled", Misure: "enabled", Caratteri: "enabled", "Colori (Dark)": "enabled" } },
    ]);
    // «Gap» is in two collections: each keeps its own, under the name of its collection.
    expect(document.Misure).toEqual({ Radius: { Card: { $type: "borderRadius", $value: 12 } }, Misure: { Gap: { $type: "number", $value: 24 } } });
    // «Plain» has no scope: it is a font family because «Titoli/Font» points at it.
    expect(document.Caratteri).toEqual({ Caratteri: { Gap: { $type: "number", $value: 8 } }, Plain: { $type: "fontFamilies", $value: "Source Sans 3" }, Titoli: { Font: { $type: "fontFamilies", $value: "{Plain}" } } });
    expect(problems).toEqual([
      { token: "Sfondo sfumato", why: "stile di colore con sfumatura, immagine o più riempimenti: non è un token" },
      { token: "Due riempimenti", why: "stile di colore con sfumatura, immagine o più riempimenti: non è un token" },
      { token: "Shadow / Card", why: "effetti non convertiti: BACKGROUND_BLUR" },
      { token: "Colori", why: "raccolta di variabili: letto il modo «Light» e, per il tema scuro, «Dark»; non letti: «Contrasto»" },
      { token: "Mostra", why: "variabile vero o falso: non è un token di stile" },
    ]);

    const read = readDesignTokens(files);
    expect(read).toMatchObject({ dialect: "tokens-studio", dark: true, problems: [] });
    const dark = readDesignTokens(files, { scheme: "dark" });
    const result = importDesignTokens(read, { dark });
    // The variable «Primary» wins over the style «Brand/Primary»; the dark mode changes it.
    expect(result.report.mapped).toContainEqual({ param: "primary", token: "color.Primary", value: "#1d4ed8" });
    expect(result.design).toMatchObject({ dark_on: 1, radius: 12, text_max: 15, text_min: 15, text_leading: 1.8, heading_weight: 600 });
    expect(String(result.design.primary_dark)).toMatch(/^oklch\(|^#93c5fd$/u);
    expect(String(result.design.font_heading)).toContain("Roboto Slab");
    expect(result.siteTokens).toMatchObject({ "color-colors-white-20": "rgb(255 255 255 / 0.2)", "color-yellow": "#ffbd00", "misure-gap": "1.5rem", "caratteri-gap": "0.5rem" });
    expect(Object.values(result.siteTokens).join(" ")).toContain("rgb(0 0 0 / 0.25)");
    expect(result.report.textSizes.map((item) => item.token)).toContain("typography.Heading.H1");
    expect(Object.keys(result.siteTokens).filter((token) => token.startsWith("typography"))).toEqual([]);
    // What the light reading said is not said again for the dark one.
    expect(result.report.skipped.filter((item) => item.token.endsWith("(scuro)"))).toEqual([]);
  });

  it("un nome ostile non esce dal file dei token", () => {
    const nodes = [...sampleNodes(), fill("x;} body{display:none}/$extensions.{a}", [solid("#010203")]), textStyle("Rotto", "Inter; } * { color: red", "Regular", 14, { value: 1.4, units: "RAW" })];
    const canvas = container(schemaBytes(DEFINITIONS), messageBytes(DEFINITIONS, "Message", { nodeChanges: nodes }));
    const result = importDesignTokens(readDesignTokens(figTokenFiles(readFigLibrary(canvas, "x")).files));
    expect(Object.entries(result.siteTokens).flat().join(" ")).not.toMatch(/[{};]/u);
    expect(JSON.stringify(result.design)).not.toContain("color: red");
    for (const line of result.acss.css.split("\n").slice(1, -2)) expect(line).toMatch(/^ {2}--ds-[a-z0-9-]+: [^;{}]+;$/u);
  });
});

describe("un file .fig scelto come sorgente di token", () => {
  it("riconosce lo ZIP con canvas.fig e il canvas.fig da solo, dai byte", async () => {
    const canvas = sampleCanvas({ version: 77 });
    const archive = await zip({ "canvas.fig": canvas, "meta.json": JSON.stringify({ file_name: "Kit di prova" }), "thumbnail.png": Buffer.from([0x89, 0x50]), "images/abc": Buffer.alloc(64) });
    const read = await readDesignZip(archive, figFileEntry);
    expect([...read.files.keys()].sort()).toEqual(["canvas.fig", "meta.json"]);
    expect(figFileName(read.files.get("meta.json"))).toBe("Kit di prova");
    expect(figFileName(Buffer.from("{"))).toBe("");
    const tokens = await designFileTokens("rinominato.zip", archive);
    expect(tokens.kind).toBe("figma");
    expect(tokens.summary).toBe("Kit di prova: file .fig di Figma (formato 77), 5 stili di colore, 4 stili di testo, 1 stile di effetto, 8 variabili in 3 raccolte, 1 componente, 1 pagina. Pagine e componenti non si convertono qui.");
    expect(tokens.problems.map((problem) => problem.token)).toContain("Mostra");
    const alone = await designFileTokens("vecchio.fig", canvas);
    expect(alone).toMatchObject({ kind: "figma", files: [{ name: "vecchio: stili e variabili" }] });
  });

  it("dice in italiano che cosa non va, col nome del file", async () => {
    const empty = container(schemaBytes(DEFINITIONS), messageBytes(DEFINITIONS, "Message", { nodeChanges: sampleNodes().slice(0, 4) }));
    await expect(designFileTokens("vuoto.fig", await zip({ "canvas.fig": empty }))).rejects.toThrow("vuoto.fig: il file di Figma non ha stili né variabili.");
    await expect(designFileTokens("rotto.fig", await zip({ "canvas.fig": "non sono un canvas" }))).rejects.toThrow("rotto.fig: Il file di Figma non si legge: non comincia con la firma fig-kiwi.");
    const noDocument = container(schemaBytes(DEFINITIONS), messageBytes(DEFINITIONS, "Message", { nodeChanges: [] }));
    await expect(designFileTokens("senza.fig", noDocument)).rejects.toThrow("senza.fig: Il file di Figma non si legge: non contiene un documento.");
  });
});

/** The three files the user gave on 13 November 2026: kits of others, read where they are and never copied here. */
describe("file .fig veri (saltati se non ci sono)", () => {
  const folder = path.join(os.homedir(), "Scaricati");
  const real: Array<[string, { version: number; fills: number; texts: number; effects: number; variables: number; collections: number; components: number; pages: number; dark: boolean; fontHeading: string }]> = [
    ["1735620798351-Ceramic Plant Pot Website UI Kit.fig", { version: 77, fills: 39, texts: 77, effects: 1, variables: 59, collections: 11, components: 280, pages: 4, dark: true, fontHeading: "Gestura Display TRIAL" }],
    ["1760243399492-Neonspark - Digital Agency Website Template.fig", { version: 101, fills: 85, texts: 74, effects: 12, variables: 32, collections: 4, components: 152, pages: 3, dark: false, fontHeading: "Epilogue" }],
    ["1769060188363-Taskflow - AI Task Management SaaS Template.fig", { version: 101, fills: 36, texts: 13, effects: 1, variables: 2, collections: 1, components: 48, pages: 1, dark: false, fontHeading: "DM Sans" }],
  ];
  for (const [name, expected] of real) {
    const file = path.join(folder, name);
    it.skipIf(!existsSync(file) || !HAS_ZSTD)(name, async () => {
      const zipped = await readDesignZip(readFileSync(file), figFileEntry);
      const library = readFigLibrary(zipped.files.get("canvas.fig")!, figFileName(zipped.files.get("meta.json")));
      expect({ version: library.version, fills: library.fills.length, texts: library.texts.length, effects: library.effects.length, variables: library.variables.length, collections: library.collections.length, components: library.components, pages: library.pages.length })
        .toEqual({ version: expected.version, fills: expected.fills, texts: expected.texts, effects: expected.effects, variables: expected.variables, collections: expected.collections, components: expected.components, pages: expected.pages });
      expect(library.name).toBe(name.replace(/^\d+-|\.fig$/gu, ""));
      expect(library.pages.every((page) => page.layers > 0)).toBe(true);
      // Every alias of the file leads to a variable of the file.
      expect(library.variables.every((variable) => variable.values[0] !== null)).toBe(true);
      const { files } = figTokenFiles(library);
      const read = readDesignTokens(files);
      expect(read.dark).toBe(expected.dark);
      // No reference is left hanging, and every text variable that feeds a font or a weight was understood.
      expect(read.problems.filter((problem) => /rimanda|senza tipo/u.test(problem.why))).toEqual([]);
      const result = importDesignTokens(read, read.dark ? { dark: readDesignTokens(files, { scheme: "dark" }) } : {});
      expect(String(result.design.font_heading)).toContain(expected.fontHeading);
      expect(Number(result.design.text_max ?? 16)).toBeGreaterThanOrEqual(15);
      expect(result.report.textSizes.length).toBeGreaterThan(2);
      // No text style became a variable of the site: text sizes are steps of the scale.
      expect(Object.keys(result.siteTokens).filter((token) => token.startsWith("typography"))).toEqual([]);
    }, 60_000);
  }
});
