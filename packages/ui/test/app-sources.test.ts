import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { hasMessage, translate } from "../src/lib/i18n.js";

/** The components have no DOM test here: what they must do is checked on their source. */
const source = (file: string) => readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
/** The body of a function of a component's script, up to its closing brace at the script's indentation. */
function body(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf("\n  }\n", start));
}

describe("testi in inglese", () => {
  it("le etichette dell'hosting passano da say(), mai in italiano fisso", async () => {
    const text = await source("app/SiteHostingFields.svelte");
    const fixed = [...text.matchAll(/class="field-label" for="[^"]+">([^<{][^<]*)<\/label>/gu)].map((match) => match[1]);
    // «Server» and «Password» are the same word in both languages.
    expect(fixed.filter((label) => label !== "Server" && label !== "Password")).toEqual([]);
    expect(text).not.toMatch(/placeholder="[^"]*esempio/u);
    expect(text).not.toMatch(/<option value="[^"]+">[^{<]*(consigliato|cifrato|Chiave)/u);
  });

  it("il ritorno a una versione precedente avvisa nelle due lingue e non si conferma due volte", async () => {
    const text = await source("app/SiteRollbackDialog.svelte");
    expect(text).not.toContain("Il traffico pubblico");
    expect(text).toContain('t("history.rollbackWarning")');
    expect(text).toMatch(/<button class="button dark" disabled=\{busy\} onclick=\{\(\) => void act\(confirmRollback\)\}>/u);
    expect(translate("en", "history.rollbackWarning")).toBe("Public traffic changes as soon as you confirm.");
  });

  it("i suggerimenti del nuovo sito sono tradotti", async () => {
    const text = await source("app/NewSiteScreen.svelte");
    expect(text).not.toContain('placeholder="32 caratteri esadecimali"');
    for (const key of ["new.accountPlaceholder", "new.siteNamePlaceholder", "new.workerNamePlaceholder"]) {
      expect(text).toContain(`t("${key}")`);
      expect(hasMessage("en", key)).toBe(true);
    }
  });
});

describe("parole dell'interfaccia", () => {
  it("i messaggi italiani dicono «versione», non «build»", async () => {
    const italian = /\b(?:la|una|prima|nuova) build\b/giu;
    expect((await source("App.svelte")).match(italian) ?? []).toEqual([]);
    expect((await source("lib/i18n.ts")).match(italian) ?? []).toEqual([]);
  });
});

describe("errori mostrati, non persi", () => {
  it("le copie e gli aggiornamenti mostrano l'errore di una chiamata rifiutata", async () => {
    const copies = await source("CopiesCard.svelte");
    expect(body(copies, "turnOff")).toMatch(/catch \(error\) \{ message = /u);
    expect(copies).toMatch(/\.catch\(\(error: unknown\) => \{ message = /u);
    const updates = await source("app/UpdatesCard.svelte");
    expect(body(updates, "run")).toContain("catch (error) { fail(error); }");
    expect(updates).toContain("bridge.status().then(read, fail)");
    expect(updates).toMatch(/\{#if failure\}<p [^>]*role="alert">\{failure\}<\/p>\{\/if\}/u);
  });

  it("la griglia dei media avvisa quando cartella, filtro o ritaglio non riescono", async () => {
    const text = await source("admin/MediaGrid.svelte");
    for (const name of ["setFolder", "showUnused", "saveCrop"]) expect(body(text, name), name).toMatch(/try \{[\s\S]*catch \(error\)/u);
  });

  it("un collegamento rifiutato nel campo ricco avvisa come nell'editor dell'articolo", async () => {
    const text = await source("admin/RichField.svelte");
    expect(body(text, "applyLink")).toMatch(/if \(linkRefused\) return;/u);
    expect(text).toContain('t("article.linkInvalid")');
  });

  it("nessun avviso vuoto", async () => {
    for (const file of ["admin/ContentDetail.svelte", "admin/LanguagesPanel.svelte"]) {
      expect(await source(file), file).not.toMatch(/\}, "\s*"\);/u);
    }
  });
});
