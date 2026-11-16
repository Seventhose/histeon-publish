import { describe, expect, it } from "vitest";
import { parsePrototype } from "../src/prototype-import.js";
import { capturedPageName, capturedSiteFiles, readRenderedCapture, RENDERED_CAPTURE_MAX_PAGES, RENDERED_CAPTURE_SCRIPT, renderedCaptureExpression, scriptRenderedSigns } from "../src/rendered-capture.js";
import { staticSiteProjectId, staticSiteToPrototype } from "../src/static-site-prototype.js";

// «Fotografa la proposta»: la parte che non dipende dal browser. Lo script gira in un browser nelle prove della CLI.
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes ?? new Uint8Array());
const page = (body: string, head = ""): string => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Trattoria</title>${head}</head><body>${body}</body></html>`;
const script = (bytes: number): string => `<script>/* ${"x".repeat(bytes)} */</script>`;

describe("RENDERED_CAPTURE_SCRIPT", () => {
  it("è una funzione sola, senza accenti gravi né segnaposto", () => {
    expect(RENDERED_CAPTURE_SCRIPT).not.toContain("`");
    expect(RENDERED_CAPTURE_SCRIPT).not.toContain("${");
    expect(typeof new Function(`return ${RENDERED_CAPTURE_SCRIPT}`)()).toBe("function");
  });

  it("l'espressione porta solo le opzioni note, con i loro limiti", () => {
    const expression = renderedCaptureExpression({ root: "document", rootSelector: "  .sito  ", remove: Array.from({ length: 30 }, (_, index) => `#via-${index}`), settleMs: 50, maxBytes: 10 ** 12 });
    const options = JSON.parse(expression.slice(expression.lastIndexOf("}))(") + 4, -1)) as Record<string, unknown>;
    expect(options.root).toBe("document");
    expect(options.rootSelector).toBe(".sito");
    expect(options.remove).toHaveLength(20);
    expect(options.settleMs).toBe(50);
    expect(options.maxBytes).toBe(100 * 1024 * 1024);
    expect(JSON.parse(renderedCaptureExpression().slice(renderedCaptureExpression().lastIndexOf("}))(") + 4, -1))).toEqual({ maxBytes: 100 * 1024 * 1024 });
  });
});

describe("readRenderedCapture", () => {
  it("legge una cattura e ripulisce titolo, frammento e note", () => {
    const capture = readRenderedCapture({ title: " Trattoria\n· Brace ", hash: "#p03/home", html: "<!doctype html><p>x</p>", notes: ["2 canvas diventati immagini ferme", 7, "", "x".repeat(900)], frame: true, height: 4210.4, altro: 1 });
    expect(capture).toEqual({ title: "Trattoria · Brace", hash: "#p03/home", html: "<!doctype html><p>x</p>", notes: ["2 canvas diventati immagini ferme", "x".repeat(300)], frame: true, height: 4210 });
  });

  it("rifiuta ciò che non è una cattura, con un messaggio per la persona", () => {
    expect(() => readRenderedCapture(null)).toThrow("La pagina non ha restituito la cattura.");
    expect(() => readRenderedCapture({ html: "   " })).toThrow("La pagina non ha restituito la cattura.");
    expect(() => readRenderedCapture({ html: 12 })).toThrow(TypeError);
    expect(() => readRenderedCapture({ error: "root-missing" }, { rootSelector: ".sito" })).toThrow("Il selettore «.sito» non trova niente nella pagina: la proposta non è stata catturata.");
    expect(() => readRenderedCapture({ error: "too-large" })).toThrow("La pagina catturata supera 100 MB.");
    expect(() => readRenderedCapture({ html: "x".repeat(2 * 1024 * 1024 + 1) }, { maxBytes: 2 * 1024 * 1024 })).toThrow("La pagina catturata supera 2 MB.");
  });
});

describe("scriptRenderedSigns", () => {
  it("riconosce un visore: riquadro senza indirizzo, corpo vuoto, modelli", () => {
    expect(scriptRenderedSigns(page(`<div id="app"></div><iframe title="Proposta"></iframe>${script(5000)}`)).reasons).toEqual(["la pagina ha un riquadro (iframe) che i suoi script riempiono", "il corpo della pagina è quasi vuoto: il contenuto lo scrivono gli script"]);
    expect(scriptRenderedSigns(page(`<div id="site"></div>${script(5000)}`))).toEqual({ scripted: true, reasons: ["il corpo della pagina è quasi vuoto: il contenuto lo scrivono gli script"] });
    const templates = `<p>${"Testo del visore. ".repeat(40)}</p>${"<template><p>Pagina</p></template>".repeat(4)}${script(5000)}`;
    expect(scriptRenderedSigns(page(templates)).reasons).toEqual(["la pagina tiene il contenuto in 4 modelli (template) che gli script copiano"]);
  });

  it("non scambia per un visore una pagina ferma", () => {
    const text = `<main><h1>Trattoria</h1><p>${"Cuciniamo alla brace dal 1962. ".repeat(30)}</p></main>`;
    expect(scriptRenderedSigns(page(text))).toEqual({ scripted: false, reasons: [] });
    // Uno script grosso in una pagina piena di testo (un menu, le statistiche) non la rende un visore.
    expect(scriptRenderedSigns(page(`${text}${script(9000)}`)).scripted).toBe(false);
    // Un corpo vuoto con uno script piccolo o uno script esterno non basta.
    expect(scriptRenderedSigns(page(`<div id="app"></div>${script(200)}<script src="app.js"></script>`)).scripted).toBe(false);
    // I dati in JSON non sono script; un riquadro con un indirizzo è un contenuto (una mappa).
    expect(scriptRenderedSigns(page(`${text}<iframe src="https://maps.example/x"></iframe><script type="application/json">${"1".repeat(9000)}</script>`)).scripted).toBe(false);
  });
});

describe("capturedPageName", () => {
  it("propone il nome dall'ultima parte del frammento, poi dal titolo", () => {
    expect(capturedPageName({ hash: "#p03/altro", title: "Trattoria", index: 0 })).toBe("Home");
    expect(capturedPageName({ hash: "#p03/product/facce-caso", index: 1 })).toBe("Facce caso");
    expect(capturedPageName({ hash: "#solo/c03/it/menu", index: 2 })).toBe("Menu");
    expect(capturedPageName({ hash: "#7", title: "  Chi   siamo ", index: 1 })).toBe("Chi siamo");
    expect(capturedPageName({ index: 3 })).toBe("Pagina 4");
  });
});

describe("capturedSiteFiles", () => {
  it("fa un sito statico: la prima pagina è la home, le altre una cartella col loro nome", () => {
    const site = capturedSiteFiles([
      { name: "Home", hash: "#p03/home", html: page("<h1>Home</h1>") },
      { name: "Il menù", hash: "#p03/menu", html: page("<h1>Menu</h1>") },
      { name: "Il menu", hash: "#p03/menu-2", html: page("<h1>Menu 2</h1>") },
      { name: "  ", hash: "", html: page("<h1>Senza nome</h1>") },
    ]);
    expect(site.files.map((file) => file.path)).toEqual(["index.html", "il-menu/index.html", "il-menu-2/index.html", "pagina-4/index.html"]);
    expect(site.pages.map((item) => [item.name, item.slug])).toEqual([["Home", ""], ["Il menù", "il-menu"], ["Il menu", "il-menu-2"], ["Pagina 4", "pagina-4"]]);
    expect(decode(site.files[1]?.bytes)).toContain("<h1>Menu</h1>");
    expect(site.notes[0]).toBe("proposta fotografata: 4 pagine (Home, Il menù, Il menu, Pagina 4)");
    expect(site.notes).toContain("gli script della proposta non sono nel sito: schede e menu da telefono tornano a rispondere con i comportamenti di Histeon dove si può; il resto (filtri, carrelli, moduli) è nell'elenco «da rifare»");
  });

  it("collega alle pagine fotografate i link che uno script del visore serviva", () => {
    const nav = '<nav><a href="#p21/home">Home</a> <a href="#/menu">Menu</a> <a href="#" data-go="product:ehi">Ehi</a> <a href="#" data-vai="contatti">Contatti</a> <a href="#fuori/altro">Altro</a> <a href="#">Su</a> <a href="#sezione">Sezione</a> <a href="https://example.org/#p21/home">Fuori</a> <button data-go="product:ehi">Compra</button></nav><section id="sezione"><p>x</p></section>';
    const site = capturedSiteFiles([
      { name: "Home", hash: "#p21/home", html: page(nav) },
      { name: "Menu", hash: "#solo/c03/it/menu", html: page(nav) },
      { name: "Ehi", hash: "#p03/product/ehi", html: page(nav) },
      { name: "Contatti", hash: "", html: page(nav) },
      { name: "Sezione", hash: "#p21/sezione", html: page("<p>La pagina col nome di un'ancora</p>") },
    ]);
    const home = decode(site.files[0]?.bytes);
    expect(home).toContain('<a href="./">Home</a>');
    expect(home).toContain('<a href="menu/">Menu</a>');
    expect(home).toContain('<a href="ehi/" data-go="product:ehi">Ehi</a>');
    expect(home).toContain('<a href="contatti/" data-vai="contatti">Contatti</a>');
    // Ciò che non nomina una pagina fotografata resta com'era; un'ancora della pagina non diventa un link a una pagina.
    expect(home).toContain('<a href="#fuori/altro">Altro</a>');
    expect(home).toContain('<a href="#">Su</a>');
    expect(home).toContain('<a href="#sezione">Sezione</a>');
    expect(home).toContain('<a href="https://example.org/#p21/home">Fuori</a>');
    expect(home).toContain('<button data-go="product:ehi">Compra</button>');
    const menu = decode(site.files[1]?.bytes);
    expect(menu).toContain('<a href="../">Home</a>');
    expect(menu).toContain('<a href="./">Menu</a>');
    expect(menu).toContain('<a href="../ehi/" data-go="product:ehi">Ehi</a>');
    expect(site.pages.map((item) => item.links)).toEqual([4, 4, 4, 4, 0]);
    expect(site.notes).toContain("16 link della proposta collegati alle pagine fotografate");
  });

  it("lascia stare un link che può voler dire due pagine", () => {
    const site = capturedSiteFiles([
      { name: "Home", hash: "#p01/home", html: page('<a href="#/menu">Menu</a> <a href="#p02/menu">Menu della due</a>') },
      { name: "Menu uno", hash: "#p01/menu", html: page("<p>1</p>") },
      { name: "Menu due", hash: "#p02/menu", html: page("<p>2</p>") },
    ]);
    const home = decode(site.files[0]?.bytes);
    expect(home).toContain('<a href="#/menu">Menu</a>');
    expect(home).toContain('<a href="menu-due/">Menu della due</a>');
  });

  it("rifiuta zero pagine e più del limite", () => {
    expect(() => capturedSiteFiles([])).toThrow("Serve almeno una pagina catturata.");
    expect(() => capturedSiteFiles(Array.from({ length: RENDERED_CAPTURE_MAX_PAGES + 1 }, (_, index) => ({ name: `P${index}`, hash: "", html: page("<p>x</p>") })))).toThrow("Una proposta porta al più 20 pagine.");
  });

  it("il sito catturato passa dalla conversione di sempre, con i link fra le pagine", () => {
    const site = capturedSiteFiles([
      { name: "Home", hash: "#p03/home", html: page('<main><h1>Trattoria</h1><p><a href="#p03/menu">Il menu</a></p></main>') },
      { name: "Menu", hash: "#p03/menu", html: page('<main><h1>Menu</h1><p><a href="#" data-go="home">Torna</a></p></main>') },
    ]);
    const result = staticSiteToPrototype({ projectId: staticSiteProjectId("prova-cattura"), name: "Trattoria", files: site.files });
    const parsed = parsePrototype(result.html);
    expect(parsed.documents.map((document) => document.attributes["data-slug"])).toEqual(["home", "menu"]);
    expect(parsed.documents[0]?.source).toContain('href="/menu/"');
    expect(parsed.documents[1]?.source).toContain('href="/"');
    expect(result.report.notes.join("\n")).not.toContain("rotta di uno script");
  });
});
