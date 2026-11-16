import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yazl from "yazl";
import { startFigmaMock, type FigmaMockHandle } from "../../cf-mock/src/figma.js";
import { HAS_ZSTD, sampleCanvas, zip } from "../../cms/test/fig-writer.js";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = promisify(execFile);

const light = {
  color: {
    $type: "color",
    brand: { primary: { $value: { colorSpace: "srgb", components: [0.114, 0.306, 0.847], alpha: 1, hex: "#1D4ED8" } } },
    button: { background: { $value: "{color.brand.primary}" } },
  },
  font: { size: { body: { $type: "number", $value: 17 }, caption: { $type: "number", $value: 13 } } },
};
const dark = { color: { $type: "color", brand: { primary: { $value: { colorSpace: "srgb", components: [0.576, 0.773, 0.992], alpha: 1, hex: "#93C5FD" } } } } };

describe("histos-publish tokens", () => {
  let folder = "";
  beforeAll(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), "histos-tokens-"));
    await writeFile(path.join(folder, "chiaro.json"), JSON.stringify(light));
    await writeFile(path.join(folder, "scuro.json"), JSON.stringify(dark));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("scrive i file per Histeon CSS e per Automatic.css in una cartella nuova e dice che cosa ha fatto", async () => {
    const output = path.join(folder, "uscita");
    const { stdout } = await run(process.execPath, [CLI, "tokens", path.join(folder, "chiaro.json"), "--dark", path.join(folder, "scuro.json"), "-o", output]);
    expect((await readdir(output)).sort()).toEqual(["acss-valori.json", "acss-variabili.css", "histos-css.json", "rapporto.txt", "variabili-sito.json"]);
    const design = JSON.parse(await readFile(path.join(output, "histos-css.json"), "utf8")) as { format: string; version: number; design: Record<string, unknown> };
    expect(design).toMatchObject({ format: "histos-css-design", version: 1, design: { text_max: 17, dark_on: 1 } });
    expect(String(design.design.primary)).toMatch(/^oklch\(/u);
    expect(JSON.parse(await readFile(path.join(output, "variabili-sito.json"), "utf8"))).toEqual({
      format: "histeon-variabili-sito",
      version: 1,
      variabili: { "color-button-background": "var(--xb-primary)" },
    });
    expect(await readFile(path.join(output, "acss-variabili.css"), "utf8")).toBe(":root {\n  --ds-color-button-background: var(--primary);\n}\n");
    // The names of the user's own file are printed, long as they are; a text size is a step, never a length.
    expect(stdout).toContain("--xb-site-color-button-background");
    expect(stdout).toContain("font.size.caption: 13 px → --xb-text-s");
    expect(stdout).not.toContain("[segreto rimosso]");
    expect(await readFile(path.join(output, "rapporto.txt"), "utf8")).toContain("Tema scuro acceso.");
  }, 30_000);

  it("non tocca una cartella che esiste e rifiuta un file che non è JSON, con codice 2", async () => {
    const output = path.join(folder, "uscita");
    const before = (await readdir(output)).sort();
    await expect(run(process.execPath, [CLI, "tokens", path.join(folder, "chiaro.json"), "-o", output])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("uscita esiste già") });
    expect((await readdir(output)).sort()).toEqual(before);
    await writeFile(path.join(folder, "rotto.json"), "{");
    await expect(run(process.execPath, [CLI, "tokens", path.join(folder, "rotto.json"), "-o", path.join(folder, "altra")])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("rotto.json: non è un file JSON.") });
    await expect(readdir(path.join(folder, "altra"))).rejects.toThrow();
    await expect(run(process.execPath, [CLI, "tokens", path.join(folder, "chiaro.json"), "-o", path.join(folder, "altra"), "--prefix", "x;}"])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("Prefisso") });
  }, 30_000);

  it("con --json stampa il design, le variabili e il rapporto", async () => {
    const { stdout } = await run(process.execPath, [CLI, "--json", "tokens", path.join(folder, "chiaro.json"), "-o", path.join(folder, "uscita-json")]);
    const result = JSON.parse(stdout) as { files: string[]; design: Record<string, unknown>; report: { read: number; textSizes: unknown[] } };
    expect(result.files).toContain("histos-css.json");
    expect(result.design.text_max).toBe(17);
    expect(result.report).toMatchObject({ read: 4 });
    expect(result.report.textSizes).toHaveLength(2);
  }, 30_000);

  it("legge la libreria di un file .penpot e rifiuta un archivio che non conosce", async () => {
    const file = "11111111-1111-4111-8111-111111111111";
    const entries: Record<string, unknown> = {
      "manifest.json": { type: "penpot/export-files", version: 1, generatedBy: "penpot/2.5.4", files: [{ id: file, name: "Kit di prova" }] },
      [`files/${file}/colors/22222222-2222-4222-8222-222222222222.json`]: { name: "Primary", path: "Primary", color: "#6750a4", opacity: 1 },
      [`files/${file}/colors/22222222-2222-4222-8222-222222222223.json`]: { name: "Sfumato", path: "", gradient: {}, opacity: 1 },
      [`files/${file}/typographies/33333333-3333-4333-8333-333333333333.json`]: { name: "Body Large", path: "Body", fontFamily: "Roboto", fontSize: "20", fontWeight: "400", lineHeight: "1.5" },
    };
    const archive = (content: Record<string, unknown>) => new Promise<Buffer>((resolve, reject) => {
      const zip = new yazl.ZipFile();
      for (const [name, data] of Object.entries(content)) zip.addBuffer(Buffer.from(JSON.stringify(data)), name);
      const chunks: Buffer[] = [];
      zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk)).on("end", () => resolve(Buffer.concat(chunks))).on("error", reject);
      zip.end();
    });
    await writeFile(path.join(folder, "kit.penpot"), await archive(entries));
    const output = path.join(folder, "uscita-penpot");
    const { stdout } = await run(process.execPath, [CLI, "tokens", path.join(folder, "kit.penpot"), "-o", output]);
    expect(stdout).toContain("Kit di prova: file Penpot (penpot/2.5.4), 2 colori e 1 tipografia della libreria");
    expect(stdout).toContain("• Sfumato: colore della libreria con sfumatura o immagine: non è un token");
    const design = JSON.parse(await readFile(path.join(output, "histos-css.json"), "utf8")) as { design: Record<string, unknown> };
    expect(design.design).toMatchObject({ text_max: 20 });
    expect(String(design.design.font_body)).toContain("Roboto");
    await writeFile(path.join(folder, "altro.zip"), await archive({ "leggimi.txt": "ciao" }));
    await expect(run(process.execPath, [CLI, "tokens", path.join(folder, "altro.zip"), "-o", path.join(folder, "uscita-zip")])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("altro.zip: Il file non è un'esportazione di Penpot") });
  }, 30_000);
});

// Not a real token: the shape of one, for the stand-in only. It is always given in the environment of the command,
// so that these tests never read the keyring of the machine.
const TOKEN = "figd_prova-NONVERO_0123456789abcdefABCDEF";
const KEY = "AbCdEfGhIjKlMnOpQrStUv";
const FIGMA_FILE = {
  file: {
    name: "Kit dell'API",
    document: { id: "0:0", type: "DOCUMENT", children: [{ id: "0:1", type: "CANVAS", name: "Home", children: [{ id: "5:1", type: "RECTANGLE", name: "Fondo", styles: { fill: "1:1" } }] }] },
    styles: { "1:1": { key: "a", name: "Colors/Primary", styleType: "FILL" }, "2:1": { key: "b", name: "Body/Base", styleType: "TEXT" } },
  },
  nodes: {
    "1:1": { document: { id: "1:1", type: "RECTANGLE", fills: [{ type: "SOLID", color: { r: 29 / 255, g: 78 / 255, b: 216 / 255, a: 1 } }] } },
    "2:1": { document: { id: "2:1", type: "TEXT", style: { fontFamily: "Inter", fontWeight: 400, fontSize: 19, lineHeightPercentFontSize: 150, lineHeightUnit: "FONT_SIZE_%" } } },
  },
};

describe("histos-publish tokens: file .fig e API di Figma", () => {
  let folder = "";
  let mock: FigmaMockHandle;
  let leaky: FigmaMockHandle;
  const withFigma = (origin: string, token = TOKEN) => ({ env: { ...process.env, HISTOS_FIGMA_API_BASE: origin, HISTOS_FIGMA_API_TOKEN: token } });
  beforeAll(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), "histos-tokens-figma-"));
    mock = await startFigmaMock({ token: TOKEN, files: { [KEY]: FIGMA_FILE } });
    leaky = await startFigmaMock({ token: `${TOKEN}-altro`, echoToken: true, files: { [KEY]: FIGMA_FILE } });
    await writeFile(path.join(folder, "chiaro.json"), JSON.stringify({ radius: { $type: "dimension", card: { $value: { value: 12, unit: "px" } } } }));
  });
  afterAll(async () => {
    await Promise.all([mock.close(), leaky.close()]);
    await rm(folder, { recursive: true, force: true });
  });

  it.skipIf(!HAS_ZSTD)("legge stili e variabili di un file .fig fatto a mano, senza rete", async () => {
    await writeFile(path.join(folder, "Kit.fig"), await zip({ "canvas.fig": sampleCanvas(), "meta.json": JSON.stringify({ file_name: "Kit di prova" }) }));
    const output = path.join(folder, "uscita-fig");
    const { stdout } = await run(process.execPath, [CLI, "tokens", path.join(folder, "Kit.fig"), "-o", output]);
    expect(stdout).toContain("Kit di prova: file .fig di Figma");
    // The first line of the report does not name the export of Penpot for a file of Figma.
    expect(stdout).toContain("(stili, colori e variabili presi dal design; ");
    expect(stdout).not.toContain("come li esporta Penpot");
    expect(await readdir(output)).toContain("histos-css.json");
    expect(await readFile(path.join(output, "rapporto.txt"), "utf8")).toContain("Kit di prova: file .fig di Figma");
    expect(mock.requests).toEqual([]);
  }, 30_000);

  it("con --figma legge il file dall'API, da solo o prima dei file, e non stampa il token", async () => {
    const output = path.join(folder, "uscita-api");
    const { stdout, stderr } = await run(process.execPath, [CLI, "tokens", "--figma", `https://www.figma.com/design/${KEY}/Kit?node-id=0-1`, "-o", output], withFigma(mock.origin));
    expect(stdout).toContain("Kit dell'API: file di Figma letto dall’API");
    expect(stdout).toContain("(stili, colori e variabili presi dal design; ");
    expect(stdout).toContain("• Variabili: ");
    const design = JSON.parse(await readFile(path.join(output, "histos-css.json"), "utf8")) as { design: Record<string, unknown> };
    expect(design.design).toMatchObject({ text_max: 19 });
    expect(String(design.design.primary)).toMatch(/^oklch\(/u);
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.requests.every((request) => request.token === TOKEN && request.credentialHeaders.length === 0)).toBe(true);
    const written = await Promise.all((await readdir(output)).map((name) => readFile(path.join(output, name), "utf8")));
    expect([stdout, stderr, ...written].join("\n")).not.toContain(TOKEN);

    // With files too: Figma first, then the files in their order.
    const both = path.join(folder, "uscita-api-e-file");
    const second = await run(process.execPath, [CLI, "--json", "tokens", path.join(folder, "chiaro.json"), "--figma", KEY, "-o", both], withFigma(mock.origin));
    const result = JSON.parse(second.stdout) as { design: Record<string, unknown>; report: { read: number } };
    expect(result.design).toMatchObject({ text_max: 19, radius: 12 });
    expect(second.stdout).not.toContain(TOKEN);
  }, 30_000);

  it("rifiuta un indirizzo che non è di Figma e una chiamata senza fonti; un rifiuto di Figma non ripete il token", async () => {
    await expect(run(process.execPath, [CLI, "tokens", "--figma", "https://example.test/design/x", "-o", path.join(folder, "no-1")], withFigma(mock.origin))).rejects.toMatchObject({ code: 2 });
    await expect(run(process.execPath, [CLI, "tokens", "-o", path.join(folder, "no-2")], withFigma(mock.origin))).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("oppure --figma") });
    // A file that is not read is said before Figma is asked.
    const before = mock.requests.length;
    await expect(run(process.execPath, [CLI, "tokens", path.join(folder, "manca.json"), "--figma", KEY, "-o", path.join(folder, "no-3")], withFigma(mock.origin))).rejects.toMatchObject({ code: 2 });
    expect(mock.requests.length).toBe(before);
    // A server that repeats the token in its error: the command takes it out, in the text and with --json.
    for (const flags of [[], ["--json"]]) {
      const refused = await run(process.execPath, [CLI, ...flags, "tokens", "--figma", KEY, "-o", path.join(folder, "no-4")], withFigma(leaky.origin)).catch((error: unknown) => error as { code: number; stdout: string; stderr: string });
      expect(refused).toMatchObject({ code: 4 });
      expect(`${refused.stdout}\n${refused.stderr}`).not.toContain(TOKEN);
      expect(`${refused.stdout}\n${refused.stderr}`).toContain("Figma");
    }
    for (const name of ["no-1", "no-2", "no-3", "no-4"]) await expect(readdir(path.join(folder, name))).rejects.toThrow();
  }, 30_000);

  it("figma-login verifica il token dell'ambiente senza salvarlo e senza stamparlo", async () => {
    const { stdout, stderr } = await run(process.execPath, [CLI, "--json", "figma-login"], withFigma(mock.origin));
    expect(JSON.parse(stdout)).toEqual({ valid: true, account: "Prova", source: "environment", saved: false });
    expect(`${stdout}\n${stderr}`).not.toContain(TOKEN);
    const refused = await run(process.execPath, [CLI, "figma-login"], withFigma(mock.origin, `${TOKEN}-sbagliato`)).catch((error: unknown) => error as { code: number; stdout: string; stderr: string });
    expect(refused).toMatchObject({ code: 4, stderr: expect.stringContaining("Figma non riconosce questo token.") });
    expect(`${refused.stdout}\n${refused.stderr}`).not.toContain(TOKEN);
    await expect(run(process.execPath, [CLI, "figma-login"], withFigma(mock.origin, "corto"))).rejects.toMatchObject({ code: 2 });
  }, 30_000);
});
