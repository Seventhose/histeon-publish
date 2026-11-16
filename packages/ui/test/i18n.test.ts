import { describe, expect, it } from "vitest";
import { translate } from "../src/lib/i18n.js";

describe("translate", () => {
  it("lascia com'è un valore con $ (percorsi e nomi dei progetti)", () => {
    expect(translate("it", "connector.firstMessageFor", { path: "/home/u/prezzi$$.html" })).toBe("Controlla «/home/u/prezzi$$.html» e importalo in Histeon Publish");
    expect(translate("it", "connector.firstMessageFor", { path: "a$&b$'c$`d.html" })).toBe("Controlla «a$&b$'c$`d.html» e importalo in Histeon Publish");
  });
});

describe("plural e stati (E13)", () => {
  it("sceglie singolare e plurale con le regole della lingua", async () => {
    const { plural } = await import("../src/lib/i18n.js");
    expect(plural("it", "count.posts", 1)).toBe("1 articolo");
    expect(plural("it", "count.posts", 2)).toBe("2 articoli");
    expect(plural("it", "count.posts", 0)).toBe("0 articoli");
    // One of each is said in the singular: «1 modelli» and «1 voci» were in the summary of the check.
    expect(plural("it", "count.templates", 1)).toBe("1 modello");
    expect(plural("it", "count.templates", 2)).toBe("2 modelli");
    expect(plural("it", "count.records", 1)).toBe("1 voce");
    expect(plural("it", "count.records", 3)).toBe("3 voci");
    // CLDR gives Italian "many" for a million: it falls back to the plural form.
    expect(plural("it", "count.components", 1_000_000)).toBe("1000000 componenti");
    expect(plural("en", "count.posts", 1)).toBe("1 post");
    expect(plural("en", "cms.trashConfirmBody", 3)).toContain("3 items");
    expect(plural("it", "cms.trashConfirmBody", 1)).toContain("un elemento");
  });

  it("dà a ogni stato un solo nome e un tono, e lascia com'è uno stato sconosciuto", async () => {
    const { stateLabel } = await import("../src/lib/i18n.js");
    expect(stateLabel("it", "cancelled")).toEqual({ label: "Annullata", tone: "neutral" });
    expect(stateLabel("en", "cancelled").label).toBe("Cancelled");
    expect(stateLabel("it", "published")).toEqual({ label: "Nel sito", tone: "ready" });
    expect(stateLabel("it", "draft").label).toBe("Bozza");
    expect(stateLabel("it", "failed").tone).toBe("failed");
    expect(stateLabel("it", "qualcosa")).toEqual({ label: "qualcosa", tone: "neutral" });
  });

  it("ha in inglese ogni chiave italiana", async () => {
    const { hasMessage } = await import("../src/lib/i18n.js");
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/lib/i18n.ts", import.meta.url), "utf8"));
    const [itBlock = "", enBlock = ""] = source.split(/\n {2}en: \{\n/u);
    const keys = (block: string) => new Set([...block.matchAll(/"([a-zA-Z0-9.-]+)": "/gu)].map((match) => match[1] ?? ""));
    const missing = [...keys(itBlock)].filter((key) => !keys(enBlock).has(key));
    expect(missing).toEqual([]);
    expect(hasMessage("en", "state.ready")).toBe(true);
  });

  it("non lascia «versione» o «modello» italiani nei testi inglesi", async () => {
    const { translate } = await import("../src/lib/i18n.js");
    const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/lib/i18n.ts", import.meta.url), "utf8"));
    const enBlock = source.split(/\n {2}en: \{\n/u)[1] ?? "";
    const italian = [...enBlock.matchAll(/"([a-zA-Z0-9.-]+)": "((?:[^"\\]|\\.)*)"/gu)]
      .filter((match) => /versione|versioni|modell[oi]/iu.test(match[2] ?? ""))
      .map((match) => match[1]);
    expect(enBlock.length).toBeGreaterThan(1000);
    expect(italian).toEqual([]);
    expect(translate("en", "cms.pageTemplate")).toBe("Page template");
    expect(translate("en", "cms.deploy")).toBe("Publish the version");
  });

  it("spiega in inglese ogni errore del controllo di un prototipo e del backup prima di un aggiornamento, non «Something went wrong» (11)", async () => {
    const { hasMessage, translate } = await import("../src/lib/i18n.js");
    const { readFile } = await import("node:fs/promises");
    // Every code the check answers with (prototype-check.ts: `"cms-…", status)`), and the backup's of an update.
    const check = await readFile(new URL("../../server/src/prototype-check.ts", import.meta.url), "utf8");
    const codes = new Set([...check.matchAll(/"(cms-[a-z-]+)", \d{3}\)/gu)].map((match) => match[1] ?? ""));
    for (const code of ["cms-backup-too-large", "cms-backup-unrestorable"]) codes.add(code);
    expect([...codes]).toEqual(expect.arrayContaining(["cms-backup-unrestorable", "cms-project-busy", "cms-project-changed", "cms-transfer-invalid"]));
    const missing = [...codes].filter((code) => !hasMessage("en", `error.${code}`) || !hasMessage("it", `error.${code}`));
    expect(missing).toEqual([]);
    expect(translate("en", "error.cms-backup-unrestorable")).toContain("damaged");
    expect(translate("en", "error.cms-project-busy")).toContain("try again");
  });

  it("dice come riparare un media danneggiato con le parole del builder, «Originale» nel menu della compressione (8)", async () => {
    const { translate } = await import("../src/lib/i18n.js");
    const { readFile, readdir } = await import("node:fs/promises");
    // The builder's own labels: its compression presets (mediaManager.ts PRESETS) and their English, through t().
    const editor = new URL("../../cms/vendor/histos/editor/", import.meta.url);
    expect(await readFile(new URL("src/lib/mediaManager.ts", editor), "utf8")).toContain("{ id: 'original', label: t('Originale')");
    const english: Record<string, string> = {};
    for (const name of await readdir(new URL("i18n/en/", editor))) Object.assign(english, JSON.parse(await readFile(new URL(`i18n/en/${name}`, editor), "utf8")) as Record<string, string>);
    expect(english.Originale).toBeTruthy();
    // In English the app shows this text, not the server's Italian one: it must say how to repair the file too.
    // Before: only «A file of the project is damaged … The technical details say which file.»
    const inEnglish = translate("en", "error.cms-backup-unrestorable");
    expect(inEnglish).toContain(`choosing “${english.Originale}” in the compression menu`);
    expect(inEnglish).toMatch(/uploading the same file again .* from the builder/u);
    expect(translate("it", "error.cms-backup-unrestorable")).toContain("carica di nuovo lo stesso file (la stessa immagine o lo stesso font) dal builder scegliendo «Originale» nel menu della compressione");
  });
});
