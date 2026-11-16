import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { renderCmsPage } from "../src/static-renderer.js";
import { staticSiteProjectId, staticSiteToPrototype, type StaticSiteFile } from "../src/static-site-prototype.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newCatalog(): Promise<CmsProjectCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-site-structure-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  await catalog.initialize();
  return catalog;
}

const PNG = (seed: number) => Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"), Buffer.from([seed])]);
const text = (value: string) => new TextEncoder().encode(value);

const header = (active: string) => `<header class="top"><a class="logo" href="/">Studio</a><nav><a href="/"${active === "home" ? ' class="active" aria-current="page"' : ""}>Home</a> <a href="/servizi.html"${active === "servizi" ? ' class="active"' : ""}>Servizi</a> <a href="/contatti.html"${active === "contatti" ? ' class="is-current"' : ""}>Contatti</a></nav></header>`;
const footer = '<footer class="bottom"><p>© 2026 Studio</p></footer>';
const card = (index: number, title: string) => `<article class="card"><img src="img/${index}.png" alt="${title}"><h3>${title}</h3><p>Descrizione di ${title} & altro</p><a class="more" href="/servizi.html#s${index}">Scopri</a></article>`;
const callout = (label: string) => `<aside class="callout"><h4>Hai domande?</h4><p>${label}</p></aside>`;
const page = (active: string, main: string) => text(`<!doctype html><html lang="it"><head><title>${active}</title></head><body>${header(active)}<main>${main}</main>${footer}</body></html>`);

function site(): StaticSiteFile[] {
  return [
    { path: "index.html", bytes: page("home", `<h1>Benvenuti</h1><section class="griglia">\n${card(1, "Restauro")}\n${card(2, "Cornici")}\n${card(3, "Doratura")}\n</section>${callout("Scrivici")}`) },
    { path: "servizi.html", bytes: page("servizi", `<h1>Servizi</h1>${callout("Chiamaci")}`) },
    { path: "contatti.html", bytes: page("contatti", `<h1>Contatti</h1>${callout("Vieni a trovarci")}`) },
    ...[1, 2, 3].map((index) => ({ path: `img/${index}.png`, bytes: PNG(index) })),
  ];
}

/** The visible text of a page, as a visitor reads it. */
const visible = (html: string) => html.replace(/<style[^>]*>[\s\S]*?<\/style>/gu, " ").replace(/<[^>]*>/gu, " ").replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code))).replaceAll("&amp;", "&").replace(/\s+/gu, " ").trim();

async function importAndRender(html: string): Promise<{ home: string; pages: number; records: number; components: number; parts: number }> {
  const parsed = parsePrototype(html);
  const built = await buildPrototypeProfile(parsed, await newCatalog());
  const imported = await (await newCatalog()).importStaticPageProfile(built.profile, built.files);
  try {
    const store = imported.store;
    const home = store.listPages().find((item) => item.slug === "home");
    if (!home) throw new Error("home missing");
    const rendered = await renderCmsPage({
      store,
      projectId: imported.project.id,
      content: store.getHead(home.id)?.content ?? "",
      templateRef: home.templateRef ?? null,
      page: { id: home.id, title: home.title, slug: home.slug, url: "/" },
      locale: "it-IT",
      resolveQuery: (presetId, args, locale) => store.content.resolveQueryPreset(presetId, args, locale),
    });
    const records = store.content.listTypes().reduce((total, type) => total + store.content.listRecords({ typeKey: type.key, status: "any", limit: 100, offset: 0 }).items.length, 0);
    return { home: rendered.html, pages: store.listPages().length, records, components: store.listComponents().filter((item) => ["card", "callout"].includes(item.ref)).length, parts: store.listTemplateParts().length };
  } finally {
    imported.store.close();
  }
}

describe("struttura di un sito convertito (B3)", () => {
  it("propone parti, componenti ed elenchi senza cambiare nulla finché non si sceglie", async () => {
    const flat = staticSiteToPrototype({ projectId: staticSiteProjectId("struttura"), name: "Studio", files: site() });
    expect(flat.structure.parts).toEqual(["header", "footer"]);
    expect(flat.structure.components.map((item) => item.ref).sort()).toEqual(["callout", "card"]);
    expect(flat.structure.lists).toEqual([{ type: "card", records: 3 }]);
    expect(flat.html).not.toMatch(/data-histos="(?:part|template|component)"|data-histos="content"/u);
    // The menu links get their own class (doc 18 §6.3); the active state stays as it was.
    expect(flat.html).toContain('class="top__link active" aria-current="page"');
  });

  it("testata e piè uguali diventano parti; la voce attiva si toglie; il testo resta lo stesso", async () => {
    const files = site();
    const flat = staticSiteToPrototype({ projectId: staticSiteProjectId("struttura"), name: "Studio", files });
    const parted = staticSiteToPrototype({ projectId: staticSiteProjectId("struttura"), name: "Studio", files, structure: { parts: true } });
    const parsed = parsePrototype(parted.html);
    expect(parsed.documents.filter((document) => document.kind === "part").map((document) => document.attributes["data-ref"])).toEqual(["site/header", "site/footer"]);
    expect(parsed.documents.filter((document) => document.kind === "page").every((document) => document.attributes["data-template"] === "site/page")).toBe(true);
    expect(parted.html).not.toMatch(/class="active"|is-current|aria-current/u);
    expect(parted.report.notes.join("\n")).toMatch(/testata e piè di pagina uguali su tutte le pagine/u);
    expect(parted.report.notes.join("\n")).toMatch(/voce attiva del menu/u);
    const before = await importAndRender(flat.html);
    const after = await importAndRender(parted.html);
    expect(after.parts).toBe(2);
    expect(visible(after.home)).toBe(visible(before.home));
  });

  it("i blocchi ripetuti diventano componenti con le loro prop; le immagini passano da uno slot", async () => {
    const files = site();
    const flat = staticSiteToPrototype({ projectId: staticSiteProjectId("struttura"), name: "Studio", files });
    const structured = staticSiteToPrototype({ projectId: staticSiteProjectId("struttura"), name: "Studio", files, structure: { parts: true, components: true } });
    expect(structured.html).toMatch(/<Card titolo="Restauro" testo="Descrizione di Restauro & altro" link="\/servizi\/#s1">\{#slot media\}<img src="asset:[a-z0-9-]+" alt="Restauro" width="1" height="1" data-histos-sized="width height">\{\/slot\}<\/Card>/u);
    expect(structured.html).toContain('<Callout testo="Scrivici" />');
    expect(structured.html).toContain('data-ref="card"');
    // Without lists the image is only a slot: no dynamic src, which WordPress refuses until transfer-markup W2.
    expect(structured.html).toContain('<article class="card">{@slot media}<h3>{props.titolo}</h3>');
    expect(structured.html).not.toContain("props.immagine");
    const before = await importAndRender(flat.html);
    const after = await importAndRender(structured.html);
    expect(after.components).toBe(2);
    expect(visible(after.home)).toBe(visible(before.home));
    expect(after.home.match(/<img/gu)?.length).toBe(before.home.match(/<img/gu)?.length);
  });

  it("tre schede di fila diventano un tipo di contenuto con record, query e loop", async () => {
    const files = site();
    const flat = staticSiteToPrototype({ projectId: staticSiteProjectId("struttura"), name: "Studio", files });
    const listed = staticSiteToPrototype({ projectId: staticSiteProjectId("struttura"), name: "Studio", files, structure: { parts: true, components: true, lists: true } });
    expect(listed.html).toContain('{#if props.immagine}<img width="1" height="1" data-histos-sized="width height" src={props.immagine} alt={props.immagine_alt}>{/if}{@slot media}');
    expect(listed.html).toContain("{#loop card_elenco() as item}<Card immagine={item.fields.immagine} immagine_alt={item.fields.immagine_alt} titolo={item.fields.titolo} testo={item.fields.testo} link={item.fields.link} />{/loop}");
    const content = parsePrototype(listed.html).content as { types: Array<{ key: string; fields: Array<{ key: string; type: string }> }>; records: Array<{ slug: string; values: Record<string, string> }> };
    expect(content.types[0]?.fields.map((field) => `${field.key}:${field.type}`)).toEqual(["immagine:asset", "immagine_alt:text", "titolo:text", "testo:text", "link:url"]);
    expect(content.records.map((record) => record.slug)).toEqual(["restauro", "cornici", "doratura"]);
    expect(listed.report.notes.join("\n")).toMatch(/1 elenco diventa un tipo di contenuto con 3 record/u);
    const before = await importAndRender(flat.html);
    const after = await importAndRender(listed.html);
    expect(after.records).toBe(3);
    expect(visible(after.home)).toBe(visible(before.home));
    expect(after.home.match(/<img/gu)?.length).toBe(before.home.match(/<img/gu)?.length);
  });

  it("lascia com'è un blocco i cui testi non possono essere prop (graffe, virgolette di due tipi)", () => {
    const files: StaticSiteFile[] = [
      { path: "index.html", bytes: text(`<!doctype html><html><body><main>${["Uno", 'Due "a" e \'b\'', "Tre"].map((label) => `<div class="riga"><b>${label}</b><i>x</i></div>`).join("")}</main></body></html>`) },
    ];
    const result = staticSiteToPrototype({ projectId: staticSiteProjectId("x"), name: "X", files, structure: { components: true, lists: true } });
    expect(result.structure.components).toEqual([]);
    expect(result.html).not.toContain("data-histos=\"component\"");
  });

  describe("casi limite dalla review", () => {
    const one = (body: string, extra: StaticSiteFile[] = []) => [{ path: "index.html", bytes: text(`<!doctype html><html lang="it"><head><title>T</title></head><body><main>${body}</main></body></html>`) }, ...extra];
    const convert = (files: StaticSiteFile[], structure = { parts: true, components: true, lists: true }) => staticSiteToPrototype({ projectId: staticSiteProjectId("limiti"), name: "Limiti", files, structure });
    const flatAndStructured = async (files: StaticSiteFile[]) => {
      const flat = await importAndRender(convert(files, { parts: false, components: false, lists: false }).html);
      const structured = convert(files);
      return { flat, structured, after: await importAndRender(structured.html) };
    };

    it("una classe come «a-3» o «h1» non diventa un tag HTML in maiuscolo", async () => {
      // «p-3» would be a utility without rules, and go (doc 18 §6.4): «a-3» is not one.
      const block = (title: string) => `<div class="a-3"><h3>${title}</h3><p>x ${title}</p></div><div class="h1"><b>${title}</b><i>y</i></div>`;
      const { flat, structured, after } = await flatAndStructured(one(["A", "B", "C"].map(block).join("")));
      expect(structured.html).toMatch(/<ABlocco titolo="A"/u);
      expect(structured.html).toMatch(/<H1Blocco /u);
      expect(visible(after.home)).toBe(visible(flat.home));
    });

    it("un blocco con più di 64 prop non è un componente; i blocchi dentro possono esserlo", async () => {
      const big = (index: number) => `<section class="griglia">${Array.from({ length: 33 }, (_, card) => `<article class="scheda"><h3>T${index}-${card}</h3><p>D${index}-${card}</p></article>`).join("")}</section>`;
      const { flat, structured, after } = await flatAndStructured(one([1, 2, 3].map(big).join("")));
      expect(structured.structure.components.map((item) => item.ref)).toEqual(["scheda"]);
      expect(visible(after.home)).toBe(visible(flat.home));
    });

    it("più di 30 elenchi e elenchi oltre 100 elementi restano componenti, senza perdere nulla", async () => {
      const cards = (prefix: string, count: number) => `<section>${Array.from({ length: count }, (_, card) => `<article class="scheda"><h3>${prefix}${card}</h3><p>x</p></article>`).join("")}</section>`;
      const many = one(Array.from({ length: 31 }, (_, list) => cards(`L${list}-`, 3)).join(""));
      const manyResult = await flatAndStructured(many);
      expect(manyResult.after.records).toBe(30 * 3);
      expect(manyResult.structured.report.notes.join("\n")).toContain("elenchi oltre i primi 30 lasciati come componenti");
      expect(visible(manyResult.after.home)).toBe(visible(manyResult.flat.home));
      const long = await flatAndStructured(one(cards("T", 150)));
      expect(long.after.records).toBe(0);
      expect(long.structured.report.notes.join("\n")).toMatch(/oltre 100 elementi resta fatto di componenti/u);
      expect(visible(long.after.home)).toBe(visible(long.flat.home));
    });

    it("le schede dentro un blocco che non è un componente tengono i loro testi", async () => {
      const box = (title: string) => `<section class="box"><h2>${title}</h2>${["x", "y", "z"].map((item) => `<article class="scheda"><h3>${title}${item}</h3><p>d</p></article>`).join("")}</section>`;
      const loose = ["a", "b", "c"].map((item) => `<article class="scheda"><h3>sciolta ${item}</h3><p>d</p></article>`).join("");
      const { flat, after } = await flatAndStructured(one(`${box("Uno")}${box("Due \"d\" e 'l'")}${box("Tre")}<div>${loose}</div>`));
      expect(visible(after.home)).toBe(visible(flat.home));
    });

    it("un elenco le cui immagini non possono diventare prop tiene le immagini", async () => {
      const png = (seed: number) => ({ path: `img/${seed}.png`, bytes: PNG(seed) });
      const card = (seed: number) => `<article class="scheda"><img src="img/${seed}.png" alt="L'opera &quot;${seed}&quot;"><h3>T${seed}</h3><p>d</p></article>`;
      const { flat, after } = await flatAndStructured(one(`<section>${[1, 2, 3].map(card).join("")}</section>`, [1, 2, 3].map(png)));
      expect(after.home.match(/<img/gu)?.length).toBe(flat.home.match(/<img/gu)?.length);
      expect(visible(after.home)).toBe(visible(flat.home));
    });

    it("le entità scritte come testo restano scritte così anche in una prop", async () => {
      const card = (year: number) => `<article class="scheda"><h3>&amp;copy; ${year}</h3><p>&amp;lt;b&amp;gt; ${year}</p></article>`;
      const { flat, after } = await flatAndStructured(one(`<div>${[2024, 2025, 2026].map(card).join("<hr>")}</div>`));
      expect(after.home).toContain("&amp;copy; 2024");
      expect(visible(after.home)).toBe(visible(flat.home));
    });

    it("una testata uguale su tutte le pagine tiene le sue classi e non parla di voce attiva", () => {
      const files: StaticSiteFile[] = ["index", "a", "b"].map((name) => ({ path: `${name}.html`, bytes: text(`<!doctype html><html><body><header class="top"><span class="lang selected">IT</span><nav><a href="index.html">Home</a></nav></header><main><h1>${name}</h1></main></body></html>`) }));
      const result = convert(files);
      expect(result.html).toContain('<span class="lang selected">IT</span>');
      expect(result.report.notes.join("\n")).not.toContain("voce attiva");
    });

    it("un testo che finisce con un backslash si importa e si vede uguale", async () => {
      const result = convert(one("<h1>Cartella C:\\</h1><p>a\\</p>"), { parts: false, components: false, lists: false });
      const rendered = await importAndRender(result.html);
      expect(visible(rendered.home)).toContain("Cartella C:\\ a\\");
    });

    it("senza scelte nessuna nota sulla struttura, e testate grandi o tanti elenchi non costano il quadrato", () => {
      const cards = Array.from({ length: 4_000 }, (_, list) => `<section>${["a", "b", "c"].map((item) => `<article class="scheda"><h3>${list}${item}</h3><p>x</p></article>`).join("")}</section>`).join("");
      let started = Date.now();
      const flat = staticSiteToPrototype({ projectId: staticSiteProjectId("x"), name: "X", files: one(cards) });
      expect(flat.report.notes.join("\n")).not.toMatch(/blocchi ripetuti oltre|elenchi oltre/u);
      const filler = "<p>riga</p>".repeat(20_000);
      const pages: StaticSiteFile[] = ["index", "due"].map((name) => ({ path: `${name}.html`, bytes: text(`<!doctype html><html><body><header class="t"><a href="index.html">H</a><b>x</b></header><main>${filler}</main><footer class="f"><p>F</p><b>y</b></footer></body></html>`) }));
      staticSiteToPrototype({ projectId: staticSiteProjectId("y"), name: "Y", files: pages, structure: { parts: true } });
      expect(Date.now() - started).toBeLessThan(20_000);
      started = Date.now();
      const sameTitles = `<section>${Array.from({ length: 100 }, () => '<article class="scheda"><h3>Uguale</h3><p>x</p></article>').join("")}</section>`;
      staticSiteToPrototype({ projectId: staticSiteProjectId("z"), name: "Z", files: one(sameTitles), structure: { parts: true, components: true, lists: true } });
      expect(Date.now() - started).toBeLessThan(10_000);
    }, 60_000);
  });
});
