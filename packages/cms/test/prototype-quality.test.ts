import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { prototypeQualityWarnings } from "../src/prototype-quality.js";

const page = (slug: string, source: string, extra: Record<string, string> = {}) => ({ kind: "page", attributes: { "data-slug": slug, "data-title": slug, ...extra }, source });
const post = (slug: string, source: string, extra: Record<string, string> = {}) => ({ kind: "post", attributes: { "data-slug": slug, "data-title": slug, "data-excerpt": "Breve", ...extra }, source });
const template = (ref: string, source: string, extra: Record<string, string> = {}) => ({ kind: "template", attributes: { "data-ref": ref, ...extra }, source });
const component = (ref: string, source: string) => ({ kind: "component", attributes: { "data-ref": ref }, source });
const part = (ref: string, source: string) => ({ kind: "part", attributes: { "data-ref": ref }, source });
const check = (documents: Array<{ kind: string; attributes: Record<string, string>; source: string }>, content?: Record<string, unknown>) => prototypeQualityWarnings({ locale: "it-IT", documents, ...(content ? { content } : {}) });

describe("accessibilità e SEO all'import (D4)", () => {
  it("segnala alt mancanti, link vuoti, h1, livelli saltati, titoli uguali, articoli senza riassunto e lingua", () => {
    const warnings = prototypeQualityWarnings({
      documents: [
        page("home", '<h1>Home</h1><h3>Salto</h3><img src="asset:a"><img src="asset:b" alt=""><a href="/x/"></a><a href="/y/" aria-label="Vai"></a><a href="/z/"><img src="asset:c" alt="Logo"></a>'),
        page("chi-siamo", "<h2>Senza h1</h2><p>Testo</p>", { "data-title": "Home" }),
        page("doppio", "<h1>Uno</h1><h1>Due</h1>"),
        { kind: "post", attributes: { "data-slug": "notizia", "data-title": "Notizia" }, source: "<p>x</p>" },
        { kind: "component", attributes: { "data-ref": "card" }, source: "<article><img src={props.immagine}></article>" },
      ],
    });
    const text = warnings.join("\n");
    expect(text).toContain("il manifest non dice la lingua");
    expect(text).toMatch(/2 immagini senza alt \(in home, card\)/u);
    expect(text).toMatch(/1 link senza testo né aria-label \(in home\)/u);
    expect(text).toMatch(/2 pagine senza titolo h1 \(chi-siamo, notizia\)/u);
    expect(text).toMatch(/più di un h1 in doppio/u);
    expect(text).toMatch(/i titoli saltano un livello in home \(da h1 a h3\)/u);
    expect(text).toMatch(/pagine con lo stesso titolo \(home, chi-siamo\)/u);
    expect(text).toMatch(/un articolo senza riassunto/u);
  });

  it("segnala un link dentro un link: scritto così, con un componente che ha un link, o nello slot di un link (doc 17)", () => {
    const linked = (documents: Parameters<typeof check>[0]) => check(documents).filter((warning) => warning.startsWith("HTML:"));
    expect(linked([page("home", '<h1>Home</h1><a href="/a/">Uno <a href="/b/">due</a></a>')])).toEqual(["HTML: un link dentro un altro link (in home): il browser chiude il primo link prima del secondo e la pagina esce rotta. Togli il link interno, o fai del contenitore un elemento che non è un link."]);
    const card = component("card", '<article><h2><a href={props.url}>{props.titolo}</a></h2></article>');
    const box = component("box", '<a class="box" href={props.url}>{@slot}</a>');
    const wrapper = component("wrapper", "<div><Card url={props.url} titolo={props.titolo} /></div>");
    expect(linked([card, box, wrapper, page("home", '<h1>Home</h1><a href="/x/"><Card url="/y/" titolo="Y" /></a><a href="/z/"><Wrapper url="/y/" titolo="Y" /></a><Box url="/w/"><a href="/v/">V</a></Box>')])).toEqual([expect.stringMatching(/^HTML: 3 link dentro un altro link \(in home\)/u)]);
    // Next to each other, a link in a slot that is not inside one, a component without links: nothing to say.
    const plain = component("plain", "<div>{@slot}</div>");
    expect(linked([card, plain, page("home", '<h1>Home</h1><a href="/a/">A</a> <a href="/b/">B</a><Plain><a href="/c/">C</a></Plain><a href="/d/"><Plain>D</Plain></a><Card url="/e/" titolo="E" />')])).toEqual([]);
  });

  it("conta l'h1 del template della pagina e tace su un prototipo in ordine", () => {
    const warnings = prototypeQualityWarnings({
      locale: "it-IT",
      documents: [
        { kind: "template", attributes: { "data-ref": "site/page" }, source: "<main><h1>{page.title}</h1>{@slot}</main>" },
        page("home", "<h2>Sezione</h2><p>Testo</p>", { "data-template": "site/page" }),
        { kind: "post", attributes: { "data-slug": "notizia", "data-title": "Notizia", "data-excerpt": "Breve" }, source: "<h1>Notizia</h1>" },
      ],
    });
    expect(warnings).toEqual([]);
  });
});

describe("il template di ogni pagina come lo sceglie la build (A7)", () => {
  const h1 = (warnings: string[]) => warnings.filter((warning) => /h1/u.test(warning));

  it("un articolo senza data-template ha il template del ruolo single, o index", () => {
    // A7 trial: «una pagina senza titolo h1 (articolo-di-esempio)», whose h1 was in the single template.
    expect(h1(check([template("site/articolo", "<article><h1>{page.title}</h1>{@slot}</article>", { "data-role": "single" }), post("articolo-di-esempio", "<p>Testo</p>")]))).toEqual([]);
    expect(h1(check([template("site/tutto", "<main><h1>{page.title}</h1>{@slot}</main>", { "data-role": "index" }), post("notizia", "<p>Testo</p>")]))).toEqual([]);
    // Its own data-template comes first, as in the build.
    expect(h1(check([template("site/articolo", "<h1>{page.title}</h1>{@slot}", { "data-role": "single" }), template("site/nudo", "{@slot}"), post("notizia", "<p>x</p>", { "data-template": "site/nudo" })]))).toEqual(["Accessibilità e SEO: una pagina senza titolo h1 (notizia)."]);
  });

  it("una pagina senza data-template ha il template del ruolo page, o index", () => {
    expect(h1(check([template("site/page", "<main><h1>{page.title}</h1>{@slot}</main>", { "data-role": "page" }), page("home", "<p>Home</p>"), page("chi-siamo", "<p>Chi</p>")]))).toEqual([]);
    expect(h1(check([template("site/index", "<main><h1>{page.title}</h1>{@slot}</main>", { "data-role": "index" }), page("home", "<p>Home</p>"), page("chi-siamo", "<p>Chi</p>")]))).toEqual([]);
    expect(h1(check([template("site/page", "<main>{@slot}</main>", { "data-role": "page" }), page("home", "<h1>Home</h1>"), page("chi-siamo", "<p>Chi</p>")]))).toEqual(["Accessibilità e SEO: una pagina senza titolo h1 (chi-siamo)."]);
  });

  it("la home ha il template del ruolo front-page prima del suo data-template", () => {
    const front = template("site/home", "<main><h1>Benvenuti</h1>{@slot}</main>", { "data-role": "front-page" });
    expect(h1(check([front, template("site/page", "<main>{@slot}</main>"), page("home", "<p>Home</p>", { "data-template": "site/page" })]))).toEqual([]);
    // And so the h1 of its data-template does not count when the front-page template renders it.
    expect(h1(check([template("site/home", "<main>{@slot}</main>", { "data-role": "front-page" }), template("site/page", "<main><h1>{page.title}</h1>{@slot}</main>"), page("home", "<p>Home</p>", { "data-template": "site/page" })]))).toEqual(["Accessibilità e SEO: una pagina senza titolo h1 (home)."]);
    // The front-page role is the home's only: another page takes its own template.
    expect(h1(check([front, template("site/page", "<main>{@slot}</main>", { "data-role": "page" }), page("home", "<p>Home</p>"), page("chi-siamo", "<p>Chi</p>")]))).toEqual(["Accessibilità e SEO: una pagina senza titolo h1 (chi-siamo)."]);
  });

  it("le pagine che la build fa da un template solo: record, archivi, blog, 404", () => {
    const content = {
      types: [{ key: "opera", singleTemplate: "site/opera", archiveTemplate: "site/opere" }, { key: "evento" }],
      taxonomies: [{ key: "tema", types: ["opera"] }, { key: "category", types: ["post"] }],
      // Every term has its archive, as the build writes them (B1): the terms are declared, as a prototype must.
      terms: [{ taxonomy: "tema", slug: "notte", label: "Notte" }, { taxonomy: "category", slug: "news", label: "News" }],
      records: [{ type: "opera", slug: "ehi", terms: { tema: ["notte"] } }, { type: "evento", slug: "festa" }],
    };
    const bare = [
      template("site/opera", "<main>{@slot}</main>"),
      template("site/opere", "<main><h2>Opere</h2>{@slot}</main>"),
      template("site/archivio", "<main>{@slot}</main>", { "data-role": "archive" }),
      template("site/blog", "<main>{@slot}</main>", { "data-role": "home" }),
      template("site/categoria", "<main>{@slot}</main>", { "data-role": "category" }),
      template("site/non-trovato", "<main>{@slot}</main>", { "data-role": "404" }),
      page("home", "<h1>Home</h1>"),
      post("notizia", "<h1>Notizia</h1>", { "data-terms": '{"category":["news"]}' }),
    ];
    expect(h1(check(bare, content))).toEqual(["Accessibilità e SEO: 7 pagine senza titolo h1 (site/opera per i record di opera, site/opere per l'archivio di opera, site/archivio per l'archivio di evento, site/archivio per i termini di tema e altre 3)."]);
    // With their h1, nothing; without a template the build writes its own page (the records of evento have none).
    const titled = bare.map((document) => (document.kind === "template" ? { ...document, source: document.source.replace("<main>", "<main><h1>{page.title}</h1>").replace("<h2>Opere</h2>", "") } : document));
    expect(h1(check(titled, content))).toEqual([]);
    // A page with the type's address takes the place of its archive, as in the build.
    expect(h1(check([...bare.filter((document) => document.attributes["data-ref"] !== "site/archivio"), page("evento", "<h1>Eventi</h1>")], content)).join("\n")).not.toMatch(/archivio di evento/u);
  });
});

describe("titoli e section come si vedono, con componenti, parti e slot (A7)", () => {
  const sections = (warnings: string[]) => warnings.filter((warning) => /section/u.test(warning));

  it("l'h1 di un componente o di una parte conta, una volta per ramo di un {#if}", () => {
    expect(check([component("hero", "<section><h1>{props.titolo}</h1></section>"), page("home", '<Hero titolo="Ciao" /><h2>Poi</h2>')])).toEqual([]);
    expect(check([part("site/header", '<header><h1>Logo</h1></header>'), template("site/page", "<Site.Header /><main>{@slot}</main>"), page("home", "<h1>Home</h1>", { "data-template": "site/page" })])).toEqual(["Accessibilità e SEO: più di un h1 in home."]);
    expect(check([page("home", "{#if page.title}<h1>Uno</h1>{:else}<h1>Due</h1>{/if}<h2>Poi</h2>")])).toEqual([]);
    // What fills a slot renders where the slot is.
    expect(check([component("box", "<div><h2>Box</h2>{@slot}</div>"), page("home", "<h1>Home</h1><Box><h4>Dentro</h4></Box>")])).toEqual(["Accessibilità: i titoli saltano un livello in home (da h2 a h4)."]);
  });

  it("una section senza titolo né nome si segnala nel documento che la scrive, contata per documento", () => {
    // A7 trial: the manual asks for a title in every section, and the check said nothing.
    const warnings = check([
      component("card", "<section><p>{props.testo}</p></section><section><p>Due</p></section>"),
      page("home", '<h1>Home</h1><section><p>Senza titolo</p></section><Card testo="a" /><Card testo="b" />'),
    ]);
    expect(sections(warnings)).toEqual(["Accessibilità: 3 section senza titolo né aria-label (in card, home): dai a ogni section un titolo (h2–h6) o un aria-label, oppure usa un div."]);
    expect(sections(check([page("home", "<h1>Home</h1><section><p>Una</p></section>")]))).toEqual(["Accessibilità: una section senza titolo né aria-label (in home): dai a ogni section un titolo (h2–h6) o un aria-label, oppure usa un div."]);
  });

  it("una section ha un titolo anche da un componente, da un ramo, da aria-label o da aria-labelledby", () => {
    expect(sections(check([
      component("titolo", '<h2 class="titolo">{props.testo}</h2>'),
      page("home", [
        "<h1>Home</h1>",
        "<section><h2>Diretto</h2></section>",
        '<section aria-label="Orari"><p>x</p></section>',
        '<section aria-labelledby="t"><p id="t">x</p></section>',
        '<section><Titolo testo="Da un componente" /></section>',
        "<section>{#if page.title}<h2>{page.title}</h2>{/if}</section>",
        "<section>{#loop opere() as opera}<h3>{opera.title}</h3>{/loop}</section>",
        '<section><p role="heading" aria-level="2">x</p></section>',
        '<section aria-label=""><h2>Vuoto ma titolato</h2></section>',
      ].join("")),
    ]))).toEqual([]);
  });

  it("la section intorno a uno slot ha il titolo di quello che lo riempie", () => {
    const panel = component("pannello", "<section class=\"pannello\">{@slot}</section>");
    expect(sections(check([panel, page("home", "<h1>Home</h1><Pannello><h2>Titolo</h2><p>x</p></Pannello>")]))).toEqual([]);
    expect(sections(check([panel, page("home", "<h1>Home</h1><Pannello><p>x</p></Pannello><Pannello><h2>Ok</h2></Pannello>")]))).toEqual(["Accessibilità: una section senza titolo né aria-label (in home): dai a ogni section un titolo (h2–h6) o un aria-label, oppure usa un div."]);
    // Named slots, and a slot passed on to another component: the heading comes from whoever fills the last.
    const media = component("media", "<div>{@slot}<section>{@slot didascalia}</section></div>");
    const scheda = component("scheda", "<Media>{#slot didascalia}{@slot}{/slot}</Media>");
    expect(sections(check([media, scheda, page("home", "<h1>Home</h1><Scheda><h2>Con titolo</h2></Scheda>")]))).toEqual([]);
    expect(sections(check([media, scheda, page("home", "<h1>Home</h1><Scheda><p>Senza</p></Scheda>")]))).toEqual(["Accessibilità: una section senza titolo né aria-label (in home): dai a ogni section un titolo (h2–h6) o un aria-label, oppure usa un div."]);
  });

  it("la section di un template intorno a {@slot} ha il titolo della pagina, e nelle pagine che la build fa da sola non ne ha", () => {
    const frame = template("site/page", "<main><section>{@slot}</section></main>", { "data-role": "page" });
    expect(sections(check([frame, page("home", "<h1>Home</h1>")]))).toEqual([]);
    expect(sections(check([frame, page("home", "<h1>Home</h1>"), page("chi-siamo", "<p>Chi</p>")]))).toEqual(["Accessibilità: una section senza titolo né aria-label (in chi-siamo): dai a ogni section un titolo (h2–h6) o un aria-label, oppure usa un div."]);
    const index = template("site/index", "<main><h1>{page.title}</h1><section>{@slot}</section></main>", { "data-role": "index" });
    // The 404 takes the 404 role alone, as in the build: here there is none.
    expect(sections(check([index, page("home", "<h2>Home</h2>"), post("notizia", "<h2>x</h2>")]))).toEqual(["Accessibilità: una section senza titolo né aria-label (in site/index per il blog): dai a ogni section un titolo (h2–h6) o un aria-label, oppure usa un div."]);
  });

  it("i prototipi della prova A7 non hanno avvisi falsi", () => {
    // The documents of the two trial prototypes that the checks read, as the agents wrote them.
    const forno = [
      part("site/header", '<header class="site-header"><a class="site-header__brand" href="/">Forno Bellini</a><nav aria-label="Principale"><ul><li><a href="/prodotti/">Prodotti</a></li></ul></nav></header>'),
      component("product-card", '<article class="product-card"><h3 class="product-card__title"><a href={props.url}>{props.nome}</a></h3><p>€ {props.prezzo.number(2)}</p></article>'),
      template("site/home", "<Site.Header /><main class=\"page\">{@slot}</main>", { "data-role": "front-page" }),
      template("site/page", "<Site.Header /><main class=\"page\"><h1 class=\"page__title\">{page.title}</h1>{@slot}</main>"),
      template("site/prodotto", "<Site.Header /><main class=\"page\"><article class=\"product\"><h1>{page.title}</h1><p>{page.fields.descrizione}</p></article>{@slot}</main>"),
      template("site/prodotti", '<Site.Header /><main class="page"><h1 class="page__title">Prodotti</h1>{#if page.totalRecords}<section class="product-archive"><h2>Pane</h2><div class="product-list">{#loop prodotti_pane() as prodotto, i}<ProductCard nome={prodotto.title} url={prodotto.url} />{/loop}</div></section>{:else}<p>Nessun prodotto per ora.</p>{/if}{@slot}</main>'),
      template("site/blog", '<Site.Header /><main class="page"><h1 class="page__title">Blog</h1>{#loop articoli_recenti() as articolo, i}<article><h2><a href={articolo.url}>{articolo.title}</a></h2></article>{/loop}{@slot}</main>', { "data-role": "home" }),
      template("site/articolo", '<Site.Header /><main class="page"><article class="article"><h1>{page.title}</h1><div class="article__body">{@slot}</div></article></main>', { "data-role": "single" }),
      template("site/pagina-non-trovata", '<Site.Header /><main class="page"><section class="not-found"><h1>Pagina non trovata</h1><p><a href="/">Torna alla home</a></p></section>{@slot}</main>', { "data-role": "404" }),
      page("home", '<section class="hero"><h1 class="hero__title">Forno Bellini</h1><a href="/prodotti/">Vedi i prodotti</a></section><section class="home-featured"><h2>Prodotti in evidenza</h2><div>{#loop prodotti_in_evidenza() as prodotto, i}<ProductCard nome={prodotto.title} url={prodotto.url} />{/loop}</div></section><section class="hours"><h2>Orari di apertura</h2><table><caption>Orari</caption></table></section>', { "data-template": "site/home", "data-title": "Home" }),
      page("chi-siamo", '<section class="story"><h2 class="story__title">La nostra storia</h2><p>[testo da scrivere]</p></section>', { "data-template": "site/page", "data-title": "Chi siamo" }),
      post("articolo-di-esempio", "<p>[testo dell'articolo da scrivere]</p>", { "data-terms": '{"category":["news"]}', "data-title": "Articolo di esempio" }),
    ];
    const fornoContent = {
      types: [{ key: "prodotti", singleTemplate: "site/prodotto", archiveTemplate: "site/prodotti" }],
      taxonomies: [{ key: "categoria", types: ["prodotti"] }, { key: "category", types: ["post"] }],
      records: [{ type: "prodotti", slug: "pane-casereccio", status: "published", terms: { categoria: ["pane"] } }],
    };
    expect(check(forno, fornoContent)).toEqual([]);
    const museo = [
      part("site/header", '<header class="site-header"><p class="site-header__name"><a href="/">Museo Civico di Asolo</a></p><nav aria-label="Principale"><ul><li><a href="/">Inizio</a></li></ul></nav></header>'),
      component("event-card", '<article class="event-card"><p>{props.quando}</p><h3><a href={props.url}>{props.titolo}</a></h3></article>'),
      template("site/pagina", "<Site.Header />\n  <main class=\"site-main\">{@slot}</main>"),
      template("site/evento", '<Site.Header /><main class="site-main"><article class="event-single"><h1>{page.title}</h1><div><p>{page.fields.testo}</p>{@slot}</div></article></main>'),
      template("site/eventi", '<Site.Header /><main class="site-main"><h1 class="site-main__title">Eventi</h1><div class="event-list">{#loop tutti_eventi() as evento, i}<EventCard titolo={evento.title} url={evento.url} />{/loop}</div>{@slot}</main>'),
      template("site/pagina-non-trovata", '<Site.Header /><main class="site-main"><h1>Pagina non trovata</h1>{@slot}</main>', { "data-role": "404" }),
      page("home", '<section class="hero"><h1 class="hero__title text--xxl">Museo Civico di Asolo</h1></section><section class="home-events"><h2>Prossimi eventi</h2><div class="event-list">{#loop prossimi_eventi() as evento, i}<EventCard titolo={evento.title} url={evento.url} />{/loop}</div></section><section class="home-collection"><h2>In evidenza</h2>{#loop collezione_in_evidenza() as collezione}<article><h3>{collezione.title}</h3></article>{/loop}</section>', { "data-template": "site/pagina", "data-title": "Home" }),
      page("visita", '<h1 class="site-main__title">Visita</h1><section><h2 class="text--l">Orari di apertura</h2><table class="visit-table"><caption>Orari per giorno</caption></table></section><section><h2 class="text--l">Biglietti</h2></section>', { "data-template": "site/pagina", "data-title": "Visita" }),
    ];
    const museoContent = { types: [{ key: "evento", singleTemplate: "site/evento", archiveTemplate: "site/eventi" }, { key: "collezione" }], records: [{ type: "evento", slug: "evento-1" }, { type: "collezione", slug: "collezione-1" }] };
    // One true warning: the events archive renders the cards' h3 right under its h1.
    expect(check(museo, museoContent)).toEqual(["Accessibilità: i titoli saltano un livello in site/eventi per l'archivio di evento (da h1 a h3)."]);
  });
});

describe("l'import passa al controllo i contenuti, per le pagine fatte da un template", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("l'articolo dell'esempio ha l'h1 del template single, e l'archivio delle opere il suo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-quality-"));
    roots.push(root);
    const html = await readFile(new URL("fixtures/prototipo-esempio.html", import.meta.url), "utf8");
    const built = await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(root));
    // Before, the post without data-template was a page without h1 too: its h1 is in the single template.
    expect(built.report.warnings).toContain("Accessibilità e SEO: una pagina senza titolo h1 (contatti).");
    // The archive template of the example writes cards with an h3 right under its h1, as the home does.
    expect(built.report.warnings.join("\n")).toMatch(/i titoli saltano un livello in home \(da h1 a h3\), site\/opere per l'archivio di serie \(da h1 a h3\), site\/opere per l'archivio di opera \(da h1 a h3\)/u);
  });
});
