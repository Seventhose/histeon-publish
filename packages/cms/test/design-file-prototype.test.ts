import { describe, expect, it } from "vitest";
import { designFilePrototype, designPrototypeId } from "../src/design-file.js";
import { siteCanvas, zip as figZip } from "./fig-writer.js";
import { siteEntries, zip } from "./penpot-writer.js";

describe("designFilePrototype", () => {
  it("gives the same id for the same file name, page and frame, and another for another frame", () => {
    const id = designPrototypeId("sito.penpot", "Home", "Home");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(designPrototypeId("sito.penpot", "Home", "Home")).toBe(id);
    expect(designPrototypeId("sito.penpot", "Home", "Prezzi")).not.toBe(id);
    expect(designPrototypeId("altro.penpot", "Home", "Home")).not.toBe(id);
    // Two frames with the same name: the id of the frame in the design keeps their projects apart.
    expect(designPrototypeId("sito.penpot", "Home", "Home", "")).toBe(id);
    expect(designPrototypeId("sito.penpot", "Home", "Home", "1:2")).not.toBe(id);
    expect(designPrototypeId("sito.penpot", "Home", "Home", "1:2")).not.toBe(designPrototypeId("sito.penpot", "Home", "Home", "1:3"));
  });

  it("turns the only frame of a page into a prototype with its report, and takes the id and the name it is given", async () => {
    const bytes = await zip(siteEntries());
    const made = await designFilePrototype("sito.penpot", bytes, "home", "");
    expect(made.id).toBe(designPrototypeId("sito.penpot", "Home", "Home"));
    expect(made.html).toContain('data-histos-prototype="1"');
    expect(made.html).toContain(`"id":"${made.id}"`);
    expect(made.details).toMatchObject({ page: "Home", frame: "Home", source: "penpot", width: 1200 });
    expect(made.report).toContain("Blocchi scritti: header, hero, cards, footer.");
    expect(made.report.split("\n").at(-1)).toBe("Stili del file non usati: sito.penpot: il file Penpot non ha colori, tipografie né token nella libreria.");
    const chosen = await designFilePrototype("sito.penpot", bytes, "Home", "Home", { id: "3f6c2b1e-8a4d-4c7e-9b21-5d0e7a9c4f12", name: "Bottega", styles: false });
    expect(chosen.id).toBe("3f6c2b1e-8a4d-4c7e-9b21-5d0e7a9c4f12");
    expect(chosen.html).toContain("<title>Bottega</title>");
    expect(chosen.report).not.toContain("Stili del file");
  });

  it("refuses, with the name of the file, a page that is not there and a page whose frame is not chosen", async () => {
    await expect(designFilePrototype("sito.penpot", await zip(siteEntries()), "Blog", "")).rejects.toThrow(/^sito\.penpot: Nessun una pagina si chiama «Blog»\. Ci sono: «Home»/u);
    // The page «Sito» of the hand-made .fig has more than one frame at its top (the frame, the components).
    const fig = await figZip({ "canvas.fig": siteCanvas(), "meta.json": JSON.stringify({ file_name: "Bottega" }) });
    await expect(designFilePrototype("bottega.fig", fig, "Sito", "")).rejects.toThrow("La pagina «Sito» ha più di un riquadro: indica quale.");
    await expect(designFilePrototype("appunti.fig", new TextEncoder().encode("niente"), "Sito", "Home")).rejects.toBeInstanceOf(TypeError);
  });
});
