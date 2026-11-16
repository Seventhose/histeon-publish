import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAGE_KEY, PNG, siteCanvas, zip as figZip } from "../../cms/test/fig-writer.js";
import { siteEntries, zip } from "../../cms/test/penpot-writer.js";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = promisify(execFile);
const refused = (args: string[]) => run(process.execPath, [CLI, ...args]).then(() => ({ code: 0, stderr: "" }), (error: { code?: number; stderr?: string }) => ({ code: error.code ?? -1, stderr: error.stderr ?? "" }));

describe("histos-publish design", () => {
  let folder = "";
  let file = "";
  beforeAll(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), "histos-design-"));
    file = path.join(folder, "sito.penpot");
    await writeFile(file, await zip(siteEntries()));
  });
  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("senza --pagina elenca le pagine e i riquadri", async () => {
    const { stdout } = await run(process.execPath, [CLI, "design", file]);
    expect(stdout).toContain("Sito di prova (Penpot): una pagina.");
    expect(stdout).toContain("Pagina «Home»");
    expect(stdout).toMatch(/«Home» {2}1200 × 760 px, \d+ livelli/u);
    const json = JSON.parse((await run(process.execPath, [CLI, "--json", "design", file])).stdout) as { pages: Array<{ name: string; frames: unknown[] }> };
    expect(json.pages).toMatchObject([{ name: "Home", frames: [{ name: "Home", width: 1200 }] }]);
  }, 60_000);

  it("scrive il prototipo e il rapporto, con un id che non cambia, e il prototipo supera il controllo", async () => {
    const output = path.join(folder, "home.html");
    // The page has one frame: --riquadro is not needed.
    const { stdout } = await run(process.execPath, [CLI, "design", file, "--pagina", "Home", "-o", output]);
    expect(stdout).toContain("Prototipo scritto: home.html (id ");
    expect(stdout).toContain("Blocchi scritti: header, hero, cards, footer.");
    expect(stdout).toContain("Stili del file non usati: sito.penpot: il file Penpot non ha colori, tipografie né token nella libreria.");
    const html = await readFile(output, "utf8");
    const id = /"id":"([0-9a-f-]{36})"/u.exec(html)?.[1];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(await readFile(path.join(folder, "home.rapporto.txt"), "utf8")).toContain("riquadro «Home» (Penpot, 1200 px)");
    const check = await run(process.execPath, [CLI, "prototype", "check", output]);
    expect(check.stdout).toContain("Prototipo valido");
    // The same frame again: the same id; --id and --name choose them.
    const again = path.join(folder, "home-2.html");
    await run(process.execPath, [CLI, "design", file, "--pagina", "home", "--riquadro", "Home", "--senza-stili", "-o", again]);
    expect(/"id":"([0-9a-f-]{36})"/u.exec(await readFile(again, "utf8"))?.[1]).toBe(id);
    const chosen = path.join(folder, "home-3.html");
    const json = JSON.parse((await run(process.execPath, [CLI, "--json", "design", file, "--pagina", "Home", "--id", "3f6c2b1e-8a4d-4c7e-9b21-5d0e7a9c4f12", "--name", "Bottega", "-o", chosen])).stdout) as { id: string; details: { sections: string[] } };
    expect(json).toMatchObject({ id: "3f6c2b1e-8a4d-4c7e-9b21-5d0e7a9c4f12", details: { sections: ["header", "hero", "cards", "footer"] } });
    expect(await readFile(chosen, "utf8")).toContain("<title>Bottega</title>");
  }, 60_000);

  it("converte un riquadro di un file .fig fatto a mano, con le copie dei componenti e un livello fuori flusso", async () => {
    const fig = path.join(folder, "bottega.fig");
    await writeFile(fig, await figZip({ "canvas.fig": siteCanvas(), "meta.json": JSON.stringify({ file_name: "Bottega dei vasi" }), [`images/${IMAGE_KEY}`]: PNG }));
    const list = await run(process.execPath, [CLI, "design", fig]);
    expect(list.stdout).toContain("Bottega dei vasi (Figma): una pagina.");
    expect(list.stdout).toMatch(/«Home» {2}1440 × 900 px, \d+ livelli/u);
    const output = path.join(folder, "bottega.html");
    const { stdout } = await run(process.execPath, [CLI, "design", fig, "--pagina", "Sito", "--riquadro", "Home", "-o", output]);
    expect(stdout).toContain("riquadro «Home» (Figma, 1440 px)");
    expect(stdout).toContain("Blocchi scritti: header, hero, schede, disegni.");
    expect(stdout).toContain("Livelli fuori flusso, messi nella stessa cella di griglia del resto del loro riquadro");
    expect(stdout).toContain("Stili del file non usati: bottega.fig: il file di Figma non ha stili né variabili.");
    const html = await readFile(output, "utf8");
    // The copies of the card are written with what each one changes; the layer out of the flow shares a cell, without coordinates.
    expect(html).toContain("Vaso blu");
    expect(html).toContain("Compra");
    expect(html).toMatch(/\.hero \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/u);
    expect(html).not.toMatch(/position: absolute|inset:/u);
    const check = await run(process.execPath, [CLI, "prototype", "check", output]);
    expect(check.stdout).toContain("Prototipo valido");
  }, 60_000);

  it("rifiuta con codice 2 un file che non è di design, un riquadro che non c'è, un'uscita che esiste", async () => {
    const tokens = path.join(folder, "token.json");
    await writeFile(tokens, "{}");
    expect(await refused(["design", tokens])).toMatchObject({ code: 2, stderr: expect.stringContaining("serve un file .penpot o .fig") });
    expect(await refused(["design", file, "--pagina", "Home", "--riquadro", "Blog", "-o", path.join(folder, "blog.html")])).toMatchObject({ code: 2, stderr: expect.stringContaining("Nessun un riquadro si chiama «Blog»") });
    expect(await refused(["design", file, "--pagina", "Home"])).toMatchObject({ code: 2, stderr: expect.stringContaining("Indica con -o") });
    expect(await refused(["design", file, "--riquadro", "Home"])).toMatchObject({ code: 2, stderr: expect.stringContaining("serve anche --pagina") });
    expect(await refused(["design", file, "--pagina", "Home", "--id", "x", "-o", path.join(folder, "x.html")])).toMatchObject({ code: 2, stderr: expect.stringContaining("--id: serve un UUID") });
    const taken = path.join(folder, "occupato.html");
    await writeFile(taken, "mio");
    expect(await refused(["design", file, "--pagina", "Home", "-o", taken])).toMatchObject({ code: 2, stderr: expect.stringContaining("occupato.html esiste già") });
    expect(await readFile(taken, "utf8")).toBe("mio");
  }, 60_000);
});
