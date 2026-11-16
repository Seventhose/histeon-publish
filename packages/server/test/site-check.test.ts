import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBuiltSite, readiness, readSavedReadiness, readinessFile, saveReadiness, summarizeBrowserCheck, type BrowserSummary } from "../src/site-check.js";

/** Il controllo del sito costruito: una coppia passa/fallisce per regola (alt, titolo, lingua, noindex, sitemap, peso). */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-site-check-"));
  roots.push(root);
  return root;
}

describe("testo alternativo delle immagini nel controllo del sito", () => {
  it("segnala solo l'immagine senza alt: alt vuoto è decorativo, alt con testo va bene", async () => {
    const root = await scratch();
    await writeFile(path.join(root, "index.html"), '<img src="/senza.png"><img src="/vuoto.png" alt=""><img src="/foto.png" alt="Foto">');
    const check = await checkBuiltSite(root);
    expect(check.missingAlt).toEqual([{ page: "/", image: "/senza.png" }]);
  });

  it("un attributo come data-alt non conta come alt", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "chi"), { recursive: true });
    await writeFile(path.join(root, "chi", "index.html"), '<img src="/dati.png" data-alt="x"><img src="/titolo.png" title="alt">');
    const check = await checkBuiltSite(root);
    expect(check.missingAlt).toEqual([
      { page: "/chi/", image: "/dati.png" },
      { page: "/chi/", image: "/titolo.png" },
    ]);
  });
});

/** Una pagina come quelle della build: titolo, lingua, descrizione. */
const page = (body = "", head = ""): string => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Pagina</title><meta name="description" content="Testo">${head}</head><body>${body}</body></html>`;
const redirect = (to: string): string => `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><link rel="canonical" href="${to}"><meta http-equiv="refresh" content="0; url=${to}"><a href="${to}">${to}</a>`;

async function site(files: Record<string, string | Buffer>): Promise<string> {
  const root = await scratch();
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

describe("titolo della pagina", () => {
  it("passa con un titolo; la pagina di un vecchio indirizzo e la 404 non contano", async () => {
    const check = await checkBuiltSite(await site({ "index.html": page(), "vecchio/index.html": redirect("/"), "404.html": "<html lang=\"it\"><title></title>" }));
    expect(check.noTitle).toEqual([]);
  });
  it("segnala la pagina senza <title> e quella con titolo vuoto", async () => {
    const check = await checkBuiltSite(await site({ "index.html": page().replace("<title>Pagina</title>", ""), "chi/index.html": page().replace("<title>Pagina</title>", "<title>  </title>") }));
    expect(check.noTitle.sort()).toEqual(["/", "/chi/"]);
  });
});

describe("lingua della pagina", () => {
  it("passa con lang su <html>; la pagina di un vecchio indirizzo non conta", async () => {
    const check = await checkBuiltSite(await site({ "index.html": page(), "vecchio/index.html": redirect("/") }));
    expect(check.noLang).toEqual([]);
  });
  it("segnala <html> senza lang o con lang vuoto, e non si fa ingannare da data-lang", async () => {
    const check = await checkBuiltSite(await site({ "index.html": page().replace(' lang="it"', ""), "a/index.html": page().replace(' lang="it"', ' lang=""'), "b/index.html": page().replace(' lang="it"', ' data-lang="it"') }));
    expect(check.noLang.sort()).toEqual(["/", "/a/", "/b/"]);
  });
});

describe("pagine chiuse ai motori di ricerca", () => {
  it("non elenca le pagine che la build chiude apposta: vecchi indirizzi e pagina di ricerca", async () => {
    const search = '<!doctype html><html lang="it"><head><meta name="robots" content="noindex"><title>Cerca</title></head><body data-pagefind-ignore><script type="module">await import("/pagefind/pagefind.js")</script></body></html>';
    const check = await checkBuiltSite(await site({ "index.html": page(), "vecchio/index.html": redirect("/"), "cerca/index.html": search }));
    expect(check.noindex).toEqual([]);
  });
  it("elenca una pagina con robots noindex, in qualunque ordine degli attributi", async () => {
    const check = await checkBuiltSite(await site({ "index.html": page("", '<meta name="robots" content="noindex">'), "chi/index.html": page("", "<meta content='noindex, nofollow' name='ROBOTS'>") }));
    expect(check.noindex.sort()).toEqual(["/", "/chi/"]);
  });
});

describe("pagine fuori dalla sitemap", () => {
  const sitemap = (paths: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((item) => `<url><loc>https://esempio.it${item}</loc></url>`).join("")}</urlset>\n`;
  it("passa quando la sitemap elenca ogni pagina aperta; 404, vecchi indirizzi e noindex non contano", async () => {
    const check = await checkBuiltSite(await site({
      "index.html": page(), "chi/index.html": page(), "404.html": page(), "vecchio/index.html": redirect("/"),
      "riservata/index.html": page("", '<meta name="robots" content="noindex">'), "sitemap.xml": sitemap(["/", "/chi/"]),
    }));
    expect(check.noSitemap).toBe(false);
    expect(check.notInSitemap).toEqual([]);
  });
  it("segnala la pagina aperta che la sitemap non elenca, e dice quando la sitemap manca", async () => {
    const files = { "index.html": page(), "chi/index.html": page() };
    const missing = await checkBuiltSite(await site({ ...files, "sitemap.xml": sitemap(["/"]) }));
    expect(missing.notInSitemap).toEqual(["/chi/"]);
    const none = await checkBuiltSite(await site(files));
    expect(none.noSitemap).toBe(true);
    expect(none.notInSitemap).toEqual([]);
  });
});

describe("peso delle pagine", () => {
  const kb = (size: number): Buffer => Buffer.alloc(size * 1024, 1);
  it("passa con una pagina leggera e non conta file di altri siti", async () => {
    const check = await checkBuiltSite(await site({ "index.html": page('<img src="/piccola.png" alt=""><img src="https://altro.it/enorme.png" alt="">'), "piccola.png": kb(20) }));
    expect(check.heavyPages).toEqual([]);
    expect(check.heavyPageCount).toBe(0);
  });
  it("somma HTML, fogli, script, font dei fogli e primo candidato di srcset; elenca le cinque più pesanti", async () => {
    const files: Record<string, string | Buffer> = {
      "stile.css": "@font-face{src:url(font/testo.woff2)}", "font/testo.woff2": kb(400), "app.js": kb(300),
      "foto.jpg": kb(700), "foto-grande.jpg": kb(4000), "comune.png": kb(200),
      // Solo un'immagine da 200 KiB: sotto la soglia.
      "leggera/index.html": page('<img src="/comune.png" alt="">'),
    };
    for (let index = 1; index <= 6; index++) {
      files[`p${index}/index.html`] = page(`<img srcset="/foto.jpg 1x, /foto-grande.jpg 2x" alt=""><img src="../comune.png" alt="">${"<p>x</p>".repeat(index * 100)}`, '<link rel="stylesheet" href="/stile.css"><script src="/app.js"></script>');
    }
    const check = await checkBuiltSite(await site(files));
    expect(check.heavyPageCount).toBe(6);
    expect(check.heavyPages.map((item) => item.page)).toEqual(["/p6/", "/p5/", "/p4/", "/p3/", "/p2/"]);
    // 400 + 300 + 700 + 200 KiB di file più l'HTML; foto-grande.jpg (secondo candidato) non conta.
    expect(check.heavyPages[0]!.kilobytes).toBeGreaterThan(1600);
    expect(check.heavyPages[0]!.kilobytes).toBeLessThan(1620);
  });
});

describe("«Pronto per andare online?»: il verdetto unico", () => {
  const sitemapOf = (paths: string[]): string => `<urlset>${paths.map((item) => `<url><loc>https://esempio.it${item}</loc></url>`).join("")}</urlset>`;
  const clean = { "index.html": page(), "sitemap.xml": sitemapOf(["/"]) };
  const browser = (extra: Partial<BrowserSummary> = {}): BrowserSummary => ({ checkedAt: "2026-11-13T08:00:00.000Z", opened: 1, axe: [], overflow: [], brokenImages: [], edges: [], failures: 0, ...extra });

  it("pronto solo senza niente da guardare e con l'accessibilità verificata nel browser", async () => {
    const check = await checkBuiltSite(await site(clean));
    const ready = readiness(check, browser());
    expect(ready.verdict).toBe("pronto");
    expect(ready.sections.map((section) => [section.id, section.title, section.state])).toEqual([
      ["links", "Collegamenti", "ok"], ["images", "Immagini", "ok"], ["search", "Motori di ricerca", "ok"], ["weight", "Peso", "ok"], ["accessibility", "Accessibilità", "ok"],
    ]);
    expect(ready.browserCheckedAt).toBe("2026-11-13T08:00:00.000Z");
  });

  it("mai pronto con l'accessibilità non verificata, né con una verifica che non ha aperto pagine", async () => {
    const check = await checkBuiltSite(await site(clean));
    for (const ready of [readiness(check, null), readiness(check, browser({ opened: 0, failures: 1 }))]) {
      expect(ready.verdict).toBe("da-guardare");
      expect(ready.sections.find((section) => section.id === "accessibility")?.state).toBe("unchecked");
    }
  });

  it("non pronto con un collegamento interno rotto o una pagina senza titolo", async () => {
    const broken = readiness(await checkBuiltSite(await site({ ...clean, "index.html": page('<a href="/manca/">x</a>') })), browser());
    expect(broken.verdict).toBe("non-pronto");
    expect(broken.sections[0]).toMatchObject({ id: "links", state: "error", items: [{ rule: "brokenLinks", level: "error", count: 1, pages: ["/"] }] });
    const untitled = readiness(await checkBuiltSite(await site({ ...clean, "index.html": page().replace("<title>Pagina</title>", "") })), browser());
    expect(untitled.verdict).toBe("non-pronto");
    expect(untitled.sections.find((section) => section.id === "search")?.items).toContainEqual({ rule: "noTitle", level: "error", count: 1, pages: ["/"] });
  });

  it("da guardare con soli avvisi: sitemap mancante, regole axe, pagina pesante", async () => {
    const noSitemap = readiness(await checkBuiltSite(await site({ "index.html": page() })), browser());
    expect(noSitemap.verdict).toBe("da-guardare");
    expect(noSitemap.sections.find((section) => section.id === "search")).toMatchObject({ state: "warning", items: [{ rule: "noSitemap", count: 1, pages: [] }] });
    const axe = readiness(await checkBuiltSite(await site(clean)), browser({ axe: [{ id: "color-contrast", count: 3, pages: ["/"] }] }));
    expect(axe.verdict).toBe("da-guardare");
    expect(axe.sections.find((section) => section.id === "accessibility")).toMatchObject({ state: "warning", items: [{ rule: "axe:color-contrast", level: "warning", count: 3, pages: ["/"] }] });
  });

  it("mai pronto con la verifica nel browser su una parte delle pagine: 20 su 60 è da guardare (M-P1)", async () => {
    const check = await checkBuiltSite(await site(clean));
    const partial = readiness(check, browser({ opened: 20, total: 60 }));
    expect(partial.verdict).toBe("da-guardare");
    expect(partial.sections.find((section) => section.id === "accessibility")).toMatchObject({ state: "warning", items: [{ rule: "browserPartial", level: "warning", count: 20, total: 60, pages: [] }] });
    // Tutte le pagine aperte, o un rapporto di prima senza il totale: come prima.
    expect(readiness(check, browser({ opened: 60, total: 60 })).verdict).toBe("pronto");
    expect(readiness(check, browser({ opened: 20 })).verdict).toBe("pronto");
    // Il riassunto tiene il totale della verifica (checkBuiltPages), mai uno più piccolo delle pagine aperte.
    const base = { overflow: [], axe: [], note: "Aperte nel browser 20 pagine su 60: la pagina iniziale e le meno profonde." };
    expect(summarizeBrowserCheck({ ...base, opened: 20, total: 60 }, "2026-11-13T09:00:00.000Z").total).toBe(60);
    expect(summarizeBrowserCheck({ ...base, opened: 20, total: 5 }, "2026-11-13T09:00:00.000Z")).not.toHaveProperty("total");
    expect(summarizeBrowserCheck({ ...base, opened: 20, total: Number.NaN }, "2026-11-13T09:00:00.000Z")).not.toHaveProperty("total");
  });

  it("riassume la verifica nel browser senza testi né elementi, e il rapporto salvato resta della sua versione", async () => {
    const summary = summarizeBrowserCheck({
      opened: 2, overflow: [{ page: "/", width: 390, scrollWidth: 500, elements: ["div.x"] }],
      axe: [{ id: "label", impact: "critical", help: "Etichette", helpUrl: "https://example.org", pages: ["/chi/"], targets: ["input"], count: 1 }],
      brokenImages: [{ page: "/chi/", images: ["/a.png"] }], failures: ["La pagina /x/ non si è aperta."],
    }, "2026-11-13T09:00:00.000Z");
    expect(summary).toEqual({ checkedAt: "2026-11-13T09:00:00.000Z", opened: 2, axe: [{ id: "label", count: 1, pages: ["/chi/"] }], overflow: ["/"], brokenImages: ["/chi/"], edges: [], failures: 1 });
    const parent = await scratch();
    const version = path.join(parent, "versione-1");
    await mkdir(version);
    const report = { checkedAt: summary.checkedAt, pages: 2, readiness: readiness(await checkBuiltSite(await site(clean)), summary), browser: summary };
    await saveReadiness(version, report);
    // Accanto alla versione, fuori dai file che vanno online.
    expect(path.dirname(readinessFile(version))).toBe(parent);
    expect(await readSavedReadiness(version)).toEqual({ version: "versione-1", ...report });
    await writeFile(path.join(parent, "versione-2.pronto.json"), JSON.stringify({ ...report, version: "versione-1" }));
    expect(await readSavedReadiness(path.join(parent, "versione-2"))).toBeNull();
    expect(await readSavedReadiness(path.join(parent, "versione-3"))).toBeNull();
  });
});
