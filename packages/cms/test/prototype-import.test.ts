import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "parse5";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype, PrototypeError, sniffPrototypeMedia } from "../src/prototype-import.js";
import { profileUsesMediaLinks, profileUsesTransferMarkupV1, TRANSFER_MODIFIERS, TRANSFER_SVG_TAGS, TRANSFER_TAGS } from "../src/page-transfer.js";
import { PROTOTYPE_AI_MANUAL } from "../src/prototype-manual.generated.js";

const roots: string[] = [];
const example = readFileSync(new URL("./fixtures/prototipo-esempio.html", import.meta.url), "utf8");

async function newCatalog(): Promise<CmsProjectCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  await catalog.initialize();
  return catalog;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function importPrototype(html: string) {
  const built = await buildPrototypeProfile(parsePrototype(html), await newCatalog());
  const target = await newCatalog();
  const imported = await target.importStaticPageProfile(built.profile, built.files);
  return { ...built, ...imported };
}

describe("nomi d'archivio fuori dagli archivi (doc 17)", () => {
  const kit = /```html\n([\s\S]*?data-histos-prototype="1"[\s\S]*?)```/u.exec(PROTOTYPE_AI_MANUAL)![1]!;
  it("page.prevUrl in un template single e page.totalRecords nel template di un record: un avviso; negli archivi niente", async () => {
    const single = '<main><h1>{page.title}</h1><p>{page.publishedAt.date("j F Y")}</p>';
    const record = '<main><h1>{page.title}</h1><ul>';
    expect(kit).toContain(single);
    expect(kit).toContain(record);
    const html = kit.replace(single, `${single}{#if page.prevUrl}<a href={page.prevUrl}>Prima</a>{/if}{#if page.nextUrl}<a href={page.nextUrl}>Dopo</a>{/if}`).replace(record, '<main><h1>{page.title}</h1>{#if page.totalRecords}<p>Tanti</p>{/if}<ul>');
    const { report } = await buildPrototypeProfile(parsePrototype(html), await newCatalog());
    expect(report.warnings.filter((warning) => warning.includes("solo nei template d'archivio"))).toEqual([
      "template site/scrittore: page.totalRecords esiste solo nei template d'archivio, e questo template non lo è mai: qui vale sempre vuoto. Paginazione e conteggi vanno nel template d'archivio; per una lista vuota usa {:else} nel loop.",
      "template site/articolo: page.prevUrl, page.nextUrl esistono solo nei template d'archivio, e questo template non lo è mai: qui valgono sempre vuoto. Paginazione e conteggi vanno nel template d'archivio; per una lista vuota usa {:else} nel loop.",
    ]);
    // The kit's archive reads page.totalPages and page.pageLinks: nothing to say. A loop variable named page is not the page.
    const shadow = kit.replace(single, `${single}{#loop page.terms.category as page}<span>{page.totalPages}</span>{/loop}`);
    expect((await buildPrototypeProfile(parsePrototype(kit), await newCatalog())).report.warnings).toEqual([]);
    expect((await buildPrototypeProfile(parsePrototype(shadow), await newCatalog())).report.warnings.filter((warning) => warning.includes("solo nei template d'archivio"))).toEqual([]);
  });
});

describe("prototipo Histeon", () => {
  it("diventa un progetto con pagine, articoli, template con ruoli, contenuti, media e stili", async () => {
    const { report, project, store, profile } = await importPrototype(example);
    try {
      expect(project.id).toBe("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10");
      expect(project.name).toBe("Galleria");
      expect(report.counts).toMatchObject({ media: 2, parts: 1, components: 1, templates: 5, types: 2, taxonomies: 2, terms: 3, records: 2, queries: 2, pages: 2, posts: 1, styles: 2, globals: 1 });
      expect(report.ignored.map((item) => item.what)).toEqual(expect.arrayContaining(["script", "<p>"]));
      expect(report.ignored.some((item) => item.what.includes("fonts.googleapis.com"))).toBe(true);

      expect(store.listPages().map((page) => [page.slug, page.status, page.templateRef]).sort()).toEqual([["contatti", "draft", "site/page"], ["home", "published", "site/page"]]);
      const roles = Object.fromEntries(store.listTemplates().map((template) => [template.ref, template.role]));
      expect(roles).toEqual({ "site/page": null, "site/single": "single", "site/opera": null, "site/opere": "archive", "site/non-trovato": "404" });

      const post = store.listPosts()[0]!;
      expect(post).toMatchObject({ slug: "un-antico-sogno", status: "published", publishedAt: "2026-10-20T08:30:00Z", excerpt: "Un racconto breve." });
      expect(Object.values(store.getPostTerms(post.id)).flat().map((term) => term.slug)).toEqual(["racconti"]);

      const opera = store.content.listRecords({ typeKey: "opera", status: "published", limit: 10, offset: 0 }).items[0]!;
      expect(opera.values.prezzo).toBe(90);
      expect(typeof opera.values.immagine).toBe("string");
      expect(opera.terms.tema?.map((term) => term.slug).sort()).toEqual(["cani", "notte"]);
      expect(store.content.getTerm?.("tema", "cani")?.parentId ?? store.content.listTerms("tema").find((term) => term.slug === "cani")!.parentId).toBe(store.content.listTerms("tema").find((term) => term.slug === "notte")!.id);

      const home = store.getHead(store.listPages().find((page) => page.slug === "home")!.id)!;
      expect(home.content).toContain(`/__cms-media/${project.id}/`);
      expect(home.content).not.toContain("asset:");
      const styles = JSON.parse(store.getHead(store.getStyles()!.id)!.content) as { styles: Array<{ selector: string; css: string }>; globals: Array<{ css: string; assets?: unknown[] }>; design?: Record<string, unknown> };
      expect(styles.styles.map((style) => style.selector)).toEqual([".testata", ".opera"]);
      expect(styles.styles[0]!.css).toContain("@media");
      expect(styles.globals[0]!.css).toContain('url("prototype-assets/texture")');
      expect(styles.globals[0]!.assets).toHaveLength(1);
      expect(styles.design).toEqual({ primary: expect.any(String) });
      expect(profile.manifest.profile).toBe("histos-static-project-v4");
    } finally { store.close(); }
  });

  it("all'import porta nel selettore di ogni blocco usato le sue regole dei fogli globali, come «Nei selettori»", async () => {
    const html = `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>Card</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"5d2a7c1e-3b4f-4e6a-9c8d-1f2e3d4c5b6a","name":"Porting SCSS","framework":"none","locale":"it-IT"}</script>
<style data-histos="global" data-name="Base">
body { margin: 0; }
.card { padding: 1rem; }
.card:hover { color: red; }
.card__title { font-weight: 700; }
@media (width > 40em) { .card { padding: 2rem; } }
.card, .tile { border: 1px solid; }
.fantasma { color: blue; }
</style>
<style data-histos="selectors">
.hero { display: grid; }
</style>
</head><body><template data-histos="page" data-slug="home" data-title="Home"><main class="hero"><article class="card"><h2 class="card__title">Titolo</h2></article></main></template></body></html>`;
    const { report, store } = await importPrototype(html);
    try {
      const styles = JSON.parse(store.getHead(store.getStyles()!.id)!.content) as { styles: Array<{ selector: string; css: string }>; globals: Array<{ css: string }> };
      expect(report.counts.selectorRules).toBe(4);
      expect(styles.styles.map((style) => style.selector), "the new entry first, the existing one after").toEqual([".card", ".hero"]);
      const card = styles.styles[0]!.css;
      expect(card).toContain("padding: 1rem;");
      expect(card).toMatch(/&:hover\s*\{\s*color: red;?\s*\}/u);
      expect(card).toMatch(/&__title\s*\{\s*font-weight: 700;?\s*\}/u);
      expect(card).toMatch(/@media \(width > 40em\)\s*\{\s*padding: 2rem;?\s*\}/u);
      const sheet = styles.globals[0]!.css;
      expect(sheet).toContain("body { margin: 0; }");
      expect(sheet, "a rule shared with another block stays").toContain(".card, .tile");
      expect(sheet, "a block no document uses stays").toContain(".fantasma");
      expect(sheet).not.toContain(".card__title");
      expect(sheet).not.toContain(".card:hover");
    } finally {
      store.close();
    }
  });

  it("dà sempre gli stessi identificativi allo stesso file", async () => {
    const first = await buildPrototypeProfile(parsePrototype(example), await newCatalog());
    const second = await buildPrototypeProfile(parsePrototype(example), await newCatalog());
    const hashes = (profile: typeof first.profile) => Object.fromEntries(profile.entities.map((entity) => [entity.id, entity.revisionHash]));
    expect(hashes(second.profile)).toEqual(hashes(first.profile));
  });

  it("collega il file di un media con <a href=\"asset:…\"> e lo porta come identità del media (doc 23, voce 121)", async () => {
    const html = example.replace("<p>Scrivimi.</p>", '<p>Scrivimi.</p><a class="tessera" href="asset:ehi"><img src="asset:ehi" alt="Ehi" width="10" height="10"></a>');
    const { profile } = await buildPrototypeProfile(parsePrototype(html), await newCatalog());
    const asset = profile.entities.find((entity) => entity.kind === "asset")!;
    const links = profile.references.filter((reference) => reference.path === "attrs.attributes.href");
    expect(links).toEqual([expect.objectContaining({ targetId: asset.id, role: "media" })]);
    expect(profile.entities.some((entity) => typeof entity.payload.content === "string" && entity.payload.content.includes(`"href":"histos-media://${asset.id}"`))).toBe(true);
    expect(profileUsesMediaLinks(profile)).toBe(true);
  });

  it("dà all'articolo l'immagine in evidenza di data-image (doc 23, voce 119)", async () => {
    const { store, profile } = await importPrototype(example.replace('data-slug="un-antico-sogno"', 'data-slug="un-antico-sogno" data-image="asset:ehi"'));
    try {
      const post = store.listPosts().find((entry) => entry.slug === "un-antico-sogno")!;
      const asset = profile.entities.find((entity) => entity.kind === "asset" && String(entity.payload.title).startsWith("ehi."))!;
      expect(post.imageAssetId).toBe(asset.id);
      expect(profile.entities.find((entity) => entity.id === post.id)?.payload.image).toBe(asset.id);
    } finally {
      store.close();
    }
  });

  it("riconosce i media dai byte, non dal nome", () => {
    expect(sniffPrototypeMedia(Buffer.from("89504e470d0a1a0a", "hex"))).toBe("image/png");
    expect(sniffPrototypeMedia(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffPrototypeMedia(Buffer.from("wOF2abcd"))).toBe("font/woff2");
  });

  const chiSiamo = '<template data-histos="page" data-slug="chi-siamo" data-title="Chi siamo"><p>Chi</p></template>';
  const refusals: Array<[string, (html: string) => string, RegExp]> = [
    ["senza il segno del prototipo", (html) => html.replace(' data-histos-prototype="1"', ""), /non è un prototipo Histeon/u],
    ["senza pagina home", (html) => html.replace('data-slug="home"', 'data-slug="inizio"'), /data-slug="home"/u],
    ["con uno script in un documento", (html) => html.replace("<p>Scrivimi.</p>", "<p>Scrivimi.</p><script>alert(1)</script>"), /script|consentit|ammess|non valid/iu],
    ["con un gestore di eventi", (html) => html.replace("<p>Scrivimi.</p>", '<p onclick="alert(1)">Scrivimi.</p>'), /onclick|evento|eventi|non valid|ammess/iu],
    ["con un media non dichiarato", (html) => html.replace('<img src="asset:ehi" alt="Ehi">', '<img src="asset:sconosciuto" alt="Ehi">'), /asset:sconosciuto non è dichiarato/u],
    ["con asset: in una prop di componente", (html) => html.replace('<CardOpera titolo="Ehi" url="/opera/ehi/">', '<CardOpera titolo="Ehi" immagine="asset:ehi" url="/opera/ehi/">'), /prop immagine .* non resta portabile/u],
    ["con asset: in un attributo che non è un indirizzo di media", (html) => html.replace("<p>Scrivimi.</p>", '<p><a class="logo" href="/" data-file="asset:ehi">Logo</a></p>'), /in data-file non resterebbe portabile/u],
    ["con asset: in un link fatto di un indirizzo e di altro", (html) => html.replace("<p>Scrivimi.</p>", '<p><a class="logo" href="asset:ehi#x">Logo</a></p>'), /in href non resterebbe portabile/u],
    ["con asset: in un link del testo", (html) => html.replace("<p>Scrivimi.</p>", '<p><a href="asset:ehi">Logo</a></p>'), /in un link dentro il testo non resterebbe portabile/u],
    ["con asset: mescolato ad altri indirizzi in srcset", (html) => html.replace('<img src="asset:ehi" alt="Ehi">', '<img src="asset:ehi" srcset="asset:ehi 1x, https://example.com/ehi.png 2x" alt="Ehi">'), /in srcset ogni sorgente è asset:/u],
    ["con un campo password", (html) => html.replace("<p>Scrivimi.</p>", '<form action="/accesso/" method="post"><input type="password" name="p"></form>'), /type su <input> non è ammesso/u],
    ["con un modulo senza method", (html) => html.replace("<p>Scrivimi.</p>", '<form action="/cerca/"><input type="search" name="q"></form>'), /sia action .* sia method/u],
    ["con un'icona SVG che usa use", (html) => html.replace("<p>Scrivimi.</p>", '<svg viewBox="0 0 24 24"><use href="#icona"/></svg>'), /<use> non è trasferibile/u],
    ["con un SVG come media", (html) => html.replace(/"data": "data:image\/png;base64,[^"]+"(, "alt": "Ehi, con cornice")/u, `"data": "data:image/svg+xml;base64,${Buffer.from("<svg onload='alert(1)'/>").toString("base64")}"$1`), /SVG non è ammesso/u],
    ["con un media remoto senza scaricamento", (html) => html.replace(/"data": "data:image\/png;base64,[^"]+"(, "alt": "Ehi, con cornice")/u, '"url": "https://example.com/ehi.png"$1'), /scaricamento delle immagini remote non è attivo/u],
    ["con due template per lo stesso ruolo", (html) => html.replace('data-ref="site/non-trovato" data-title="Non trovato" data-role="404"', 'data-ref="site/non-trovato" data-title="Non trovato" data-role="single"'), /ruolo non valido o già usato/u],
    ["con @media fuori da una regola", (html) => html.replace(".opera {", "@media print { .x { color: red; } }\n.opera {"), /@media fuori da una regola/u],
    ["con @import nel CSS", (html) => html.replace(":root {", '@import url("x.css");\n:root {'), /@import non è ammesso/u],
    ["con un manifest sconosciuto", (html) => html.replace('"framework": "histos-css"', '"framework": "core-framework"'), /framework/u],
    ["con un'immagine dell'articolo non dichiarata", (html) => html.replace('data-slug="un-antico-sogno"', 'data-slug="un-antico-sogno" data-image="asset:sconosciuto"'), /data-image usa asset:sconosciuto, che non è fra i media dichiarati/u],
    ["con un'immagine dell'articolo che non è asset:", (html) => html.replace('data-slug="un-antico-sogno"', 'data-slug="un-antico-sogno" data-image="/foto.png"'), /data-image vuole asset:<nome>/u],
    ["con un data-histos sconosciuto", (html) => html.replace('data-histos="post"', 'data-histos="prodotto"'), /tipo di documento sconosciuto/u],
    // A second home is a repeated slug, not a page dropped with all it holds.
    ["con due pagine home", (html) => html.replace("</body>", '<template data-histos="page" data-slug="home" data-title="Home 2"><p>altra</p></template>\n</body>'), /^page home \(riga 98\): slug ripetuto\.$/u],
    // data-histos elements the import would not read stop it, with where they are, instead of vanishing.
    ["con una pagina dentro <main>", (html) => html.replace("</body>", '<main>\n<template data-histos="page" data-slug="chi-siamo" data-title="Chi siamo"><p>Chi</p></template></main>\n</body>'), /^<template data-histos="page"> \(riga 99\) è dentro <main> \(riga 98\): gli elementi con data-histos vanno direttamente in <head> o in <body>/u],
    ["con una pagina dentro un template senza data-histos", (html) => html.replace("</body>", '<template><template data-histos="page" data-slug="chi-siamo" data-title="Chi siamo"><p>Chi</p></template></template>\n</body>'), /^<template data-histos="page"> \(riga 98\) è dentro <template> \(riga 98\)/u],
    ["con un foglio globale dentro un <div>", (html) => html.replace("</body>", '<div><style data-histos="global">.x { color: red; }</style></div>\n</body>'), /^<style data-histos="global"> \(riga 98\) è dentro <div>/u],
    ["con un data-histos sconosciuto dentro un <div>", (html) => html.replace("</body>", '<div><section><p data-histos="bogus">x</p></section></div>\n</body>'), /^<p data-histos="bogus"> \(riga 98\) è dentro <div>/u],
    // The browser reads the content of these as text: a page written there would vanish with it, without a word.
    ...["noscript", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "style", "script"].map((tag): [string, (html: string) => string, RegExp] => [
      `con una pagina dentro <${tag}>`,
      (html) => html.replace("</body>", `<${tag}><template data-histos="page" data-slug="chi-siamo" data-title="Chi siamo"><p>Chi</p></template></${tag}>\n</body>`),
      new RegExp(`^<template data-histos="page"> \\(riga 98\\) per il browser è testo dentro <${tag}> \\(riga 98\\): gli elementi con data-histos vanno direttamente in <head> o in <body>`, "u"),
    ]),
    ["con una pagina dentro <plaintext>, che prende il resto del file", (html) => html.replace("</body>", '<plaintext>\n<template data-histos="page" data-slug="chi-siamo" data-title="Chi siamo"><p>Chi</p></template>\n</body>'), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <plaintext> \(riga 98\)/u],
    ["con uno script lasciato aperto prima delle pagine", (html) => html.replace("<body>", '<body>\n<script src="anteprima.js">'), /^<template data-histos="part"> \(riga 67\) per il browser è testo dentro <script> \(riga 65\)/u],
    // Closed by a later </script>, its text opens with markup, which no script does: it is read as markup.
    ["con uno script lasciato aperto che uno script più avanti chiude", (html) => html.replace("<body>", '<body>\n<script src="anteprima.js">').replace("</body>", '<script src="dopo.js"></script>\n</body>'), /^<template data-histos="part"> \(riga 67\) per il browser è testo dentro <script> \(riga 65\)/u],
    // Review 5: a <script> or <style> left open swallows everything up to a later one's end tag, whatever its text opens
    // with (a comment, text, code, the end of <head>): the verifier's five files, refused with both lines.
    ["con uno script lasciato aperto seguito da un commento, che uno script più avanti chiude", (html) => html.replace("<body>", '<body>\n<script src="anteprima.js">\n<!-- Testata e pagine -->').replace("</body>", '<script src="dopo.js"></script>\n</body>'), /^<template data-histos="part"> \(riga 68\) per il browser è testo dentro <script> \(riga 65\)/u],
    ["con l'ultimo script di <head> lasciato aperto, che uno script più avanti chiude", (html) => html.replace('<script>console.log("anteprima: non entra nel progetto")</script>', '<script src="anteprima.js">').replace("</body>", "<script>init()</script>\n</body>"), /^<template data-histos="part"> \(riga 66\) per il browser è testo dentro <script> \(riga 62\)/u],
    ["con uno script in linea lasciato aperto prima di una pagina", (html) => html.replace("</body>", `<script>\n  init();\n${chiSiamo}\n<script>more()</script>\n</body>`), /^<template data-histos="page"> \(riga 100\) per il browser è testo dentro <script> \(riga 98\)/u],
    ["con uno script src lasciato aperto e del testo prima di una pagina", (html) => html.replace("</body>", `<script src="a.js">\nChi siamo:\n${chiSiamo}\n<script src="b.js"></script>\n</body>`), /^<template data-histos="page"> \(riga 100\) per il browser è testo dentro <script> \(riga 98\)/u],
    ["con uno stile lasciato aperto e un commento CSS prima di una pagina", (html) => html.replace("</body>", `<style>\n/* anteprima */\n${chiSiamo}\n<style>p{}</style>\n</body>`), /^<template data-histos="page"> \(riga 100\) per il browser è testo dentro <style> \(riga 98\)/u],
    // Each sign by itself, with a tag that is no whole page: a <script src> holding text (the browser never runs it), a
    // start tag of its own kind, the end of <head> (a stray </script> closes it), a whole page.
    ["con uno script src che ha del testo, chiuso dal suo tag", (html) => html.replace("</body>", '<script src="anteprima.js">\nnota\n<template data-histos="page" data-slug="chi-siamo"></script>\n</body>'), /^<template data-histos="page"> \(riga 100\) per il browser è testo dentro <script> \(riga 98\)/u],
    ["con uno script che contiene l'inizio di un altro script", (html) => html.replace("</body>", '<script>\nx();\n<template data-histos="page" data-slug="chi-siamo">\n<script>y()</script>\n</body>'), /^<template data-histos="page"> \(riga 100\) per il browser è testo dentro <script> \(riga 98\)/u],
    ["con uno script di <head> lasciato aperto e un </script> isolato più avanti", (html) => html.replace('<script>console.log("anteprima: non entra nel progetto")</script>', "<script>").replace("</body>", "</script>\n</body>"), /^<template data-histos="part"> \(riga 66\) per il browser è testo dentro <script> \(riga 62\)/u],
    ["con una pagina intera in uno script, dopo un commento", (html) => html.replace("</body>", `<script>\n// anteprima\n${chiSiamo}\n</script>\n</body>`), /^<template data-histos="page"> \(riga 100\) per il browser è testo dentro <script> \(riga 98\)/u],
    // Review 6: a lone end tag in an HTML comment closes the text inside a page, or after a sheet, with no other sign:
    // a data-histos tag where markup writes one (first on its line, or right after a `>`) is itself the sign.
    ["con una pagina che un </script> in un commento HTML taglia", (html) => html.replace("</body>", `<script>\n  init();\n<template data-histos="page" data-slug="chi-siamo" data-title="Chi siamo"><p>Chi</p><!-- vecchio: </script> --></template>\n</body>`), /^<template data-histos="page"> \(riga 100\) per il browser è testo dentro <script> \(riga 98\)/u],
    ["con un foglio globale prima di un </script> in un commento HTML", (html) => html.replace("</body>", '<script>\n  init();\n<style data-histos="global" data-name="Extra">.extra{color:red}</style>\n<!-- </script> -->\n</body>'), /^<style data-histos="global"> \(riga 100\) per il browser è testo dentro <script> \(riga 98\)/u],
    ["con una parte del prototipo in uno stile lasciato aperto e un </style> isolato", (html) => html.replace("</body>", '<style>\n  p { margin: 0 }\n<script type="application/json" data-histos="content">{}</script>\n</style>\n</body>'), /^<script data-histos="content"> \(riga 100\) per il browser è testo dentro <style> \(riga 98\)/u],
    // A comparison in the code before the page reads, as markup, as a tag up to the page's `>`: a line that opens with a
    // start tag ends it, and the page is read.
    ["con un confronto in uno script lasciato aperto e una pagina che un </script> isolato taglia", (html) => html.replace("</body>", `<script>\n  if (i<pages.length) show();\n<template data-histos="page" data-slug="chi-siamo" data-title="Chi siamo">\n<p>Chi</p></script>\n</template>\n</body>`), /^<template data-histos="page"> \(riga 100\) per il browser è testo dentro <script> \(riga 98\)/u],
    // The trade-off (§2): in code, a line that starts with a data-histos tag (a template literal, a comment of many
    // lines) reads as markup.
    ["con un template literal che comincia una riga con un tag data-histos", (html) => html.replace("</body>", '<script>\nconst page = `\n<template data-histos="page" data-slug="x">`;\n</script>\n</body>'), /^<template data-histos="page"> \(riga 100\) per il browser è testo dentro <script> \(riga 98\)/u],
    // Review 7: on the same line as the code of a style or a script left open, where its CSS or JavaScript holds no tag
    // (the verifier's files that review 6 lost: after a declaration or a CSS comment, after `;`, after a comparison).
    ["con un foglio globale sulla stessa riga del CSS di uno stile lasciato aperto", (html) => html.replace("</body>", '<style media="print">\nbody { margin: 0 }<style data-histos="global" data-name="Extra">.extra{color:red}</style>\n</body>'), /^<style data-histos="global"> \(riga 99\) per il browser è testo dentro <style> \(riga 98\)/u],
    ["con un foglio globale dopo un commento CSS sulla stessa riga di uno stile lasciato aperto", (html) => html.replace("</body>", '<style media="print">\n/* <template data-histos="page"> riceve questo stile */ <style data-histos="global" data-name="Extra">.extra{color:red}</style>\n</body>'), /^<style data-histos="global"> \(riga 99\) per il browser è testo dentro <style> \(riga 98\)/u],
    ["con una pagina dopo il codice sulla stessa riga di uno script lasciato aperto", (html) => html.replace("</body>", `<script>\n  const help = 'I media vanno in <script type="application/json" data-histos="assets">'; ${chiSiamo.replace("</p>", "</p></script>")}\n</body>`), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <script> \(riga 98\)/u],
    ["con una pagina dopo un confronto sulla stessa riga di uno script lasciato aperto", (html) => html.replace("</body>", `<script>\n  for (let i = 0; i<pages.length; i++) show(pages[i]); ${chiSiamo}\n<script>more()</script>\n</body>`), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <script> \(riga 98\)/u],
    // Review 7: a part of the prototype left open takes what follows it up to the next end tag of its kind, pages and
    // parts in between, which would be stored as its CSS or JSON (the verifier's two files): a sign in its text stops it.
    ["con un foglio globale lasciato aperto prima di una pagina", (html) => html.replace("</body>", `<style data-histos="global" data-name="Extra">.extra{color:red}\n${chiSiamo}\n<style data-histos="global" data-name="Altro">.altro{color:blue}</style>\n</body>`), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 100: chiudilo dove finisce il suo CSS, altrimenti quel che sta in mezzo non entra nel progetto\.$/u],
    ["con un foglio globale lasciato aperto che uno stile dell'anteprima chiude", (html) => html.replace("</body>", `<style data-histos="global" data-name="Extra">.extra{color:red}\n${chiSiamo}\n<style>p{margin:0}</style>\n</body>`), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 100:/u],
    ["con un foglio globale lasciato aperto che prende solo uno stile dell'anteprima", (html) => html.replace("</body>", '<style data-histos="global" data-name="Extra">.extra{color:red}\n<style>p{margin:0}</style>\n</body>'), /^<style> \(riga 99\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 99:/u],
    ["con una pagina sulla stessa riga del CSS di un foglio globale lasciato aperto", (html) => html.replace("</body>", `<style data-histos="global" data-name="Extra">.extra { content: "a > b" } ${chiSiamo}\n<style>p{margin:0}</style>\n</body>`), /^<template data-histos="page"> \(riga 98\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 99:/u],
    ["con gli stili per selettore lasciati aperti prima di una pagina", (html) => html.replace('<style data-histos="global" data-name="Base">', `<style data-histos="selectors">.x { color: red; }\n${chiSiamo}\n<style data-histos="global" data-name="Base">`), /^<template data-histos="page"> \(riga 48\) per il browser è testo dentro <style data-histos="selectors"> \(riga 47\), che resta aperto fino al <\/style> di riga \d+: chiudilo dove finisce il suo CSS/u],
    ["con i contenuti lasciati aperti prima di una pagina", (html) => html.replace("</body>", `<script type="application/json" data-histos="content">{}\n${chiSiamo}\n<script>init()</script>\n</body>`), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <script data-histos="content"> \(riga 98\), che resta aperto fino al <\/script> di riga 100: chiudilo dove finisce il suo JSON, altrimenti quel che sta in mezzo non entra nel progetto\.$/u],
    ["con i contenuti lasciati aperti sulla stessa riga di una pagina", (html) => html.replace("</body>", `<script type="application/json" data-histos="content">{"types": []} ${chiSiamo}\n<script>init()</script>\n</body>`), /^<template data-histos="page"> \(riga 98\) per il browser è testo dentro <script data-histos="content"> \(riga 98\), che resta aperto fino al <\/script> di riga 99:/u],
    // Review 8 (the verifier's two files): a sheet left open whose own CSS ends inside a url( or a comment that a later
    // sheet's `)` or `*/` closes. In a part, a url() its line ends, and a comment that holds another `/*`, are read on as
    // CSS, and what stands after them is seen.
    ["con un foglio globale lasciato aperto dentro un url( prima di una pagina", (html) => html.replace("</body>", `<style data-histos="global" data-name="Extra">.extra{background:url(sfondo.png}\n${chiSiamo}\n<style data-histos="global" data-name="Altro">.altro{color:blue}</style>\n</body>`), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 100: chiudilo dove finisce il suo CSS/u],
    ["con un foglio globale lasciato aperto dentro un commento prima di una pagina", (html) => html.replace("</body>", `<style data-histos="global" data-name="Extra">.extra{color:red} /* da finire\n${chiSiamo}\n<style data-histos="global" data-name="Altro">/* Altro */ .altro{color:blue}</style>\n</body>`), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 100: chiudilo dove finisce il suo CSS/u],
    ["con un foglio globale lasciato aperto dentro un commento prima di un altro foglio", (html) => html.replace("</body>", '<style data-histos="global" data-name="Extra">.extra{color:red} /* da finire\n<style data-histos="global" data-name="Altro">/* Altro */ .altro{color:blue}</style>\n</body>'), /^<style data-histos="global"> \(riga 99\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 99:/u],
    ["con gli stili per selettore lasciati aperti dentro un url( prima di un foglio", (html) => html.replace('<style data-histos="global" data-name="Base">', '<style data-histos="selectors">.x { background: url(sfondo.png }\n<style data-histos="global" data-name="Base">'), /^<style data-histos="global"> \(riga 48\) per il browser è testo dentro <style data-histos="selectors"> \(riga 47\)/u],
    // A `<!--` in a part's CSS is a token CSS ignores, which hides nothing after it.
    // Review 9: what ends such a url( or comment is a later sheet's `)`, `*/` or `-->`: one that holds `data-histos` (and, a
    // comment, another of its kind after it) is read on as CSS.
    ["con un foglio globale lasciato aperto dentro un url( chiuso da un foglio dopo una pagina", (html) => html.replace("</body>", `<style data-histos="global" data-name="Extra">.extra{background:url(sfondo.png}\n${chiSiamo}\n<style data-histos="global" data-name="Altro">.altro{background:url(altro.png)}</style>\n</body>`), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 100:/u],
    ["con un foglio globale lasciato aperto dentro un url( chiuso dal foglio dopo", (html) => html.replace("</body>", '<style data-histos="global" data-name="Extra">.extra{background:url(sfondo.png}\n<style data-histos="global" data-name="Altro">.altro{background:url(altro.png)}</style>\n</body>'), /^<style data-histos="global"> \(riga 99\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 99:/u],
    ["con un foglio globale lasciato aperto dopo un <!-- che un commento HTML più avanti chiude", (html) => html.replace("</body>", `<style data-histos="global" data-name="Extra"><!-- .extra{color:red}\n${chiSiamo}\n<!-- testata -->\n<style>p{margin:0}</style>\n</body>`), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 101:/u],
    ["con un foglio globale lasciato aperto dentro un commento che una pagina chiude", (html) => html.replace("</body>", '<style data-histos="global" data-name="Extra">.extra{color:red} /* da finire\n<template data-histos="page" data-slug="chi-siamo" data-title="Chi siamo"><p>usa /* e */</p></template>\n<style>p{margin:0}</style>\n</body>'), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 100:/u],
    ["con un foglio globale lasciato aperto dopo un <!-- prima di una pagina", (html) => html.replace("</body>", `<style data-histos="global" data-name="Extra"><!-- .extra{color:red}\n${chiSiamo}\n<style>p{margin:0}</style>\n</body>`), /^<template data-histos="page"> \(riga 99\) per il browser è testo dentro <style data-histos="global"> \(riga 98\), che resta aperto fino al <\/style> di riga 100:/u],
    ["con un foglio dentro <noscript> in <head>", (html) => html.replace("</head>", '<noscript><style data-histos="global">.x { color: red; }</style></noscript>\n</head>'), /^<style data-histos="global"> \(riga 63\) per il browser è testo dentro <noscript> \(riga 63\)/u],
    ["con una pagina in una <textarea> dentro un <div>", (html) => html.replace("</body>", '<div>\n<textarea>\n<template data-histos="page" data-slug="chi-siamo">x</template></textarea></div>\n</body>'), /^<template data-histos="page"> \(riga 100\) per il browser è testo dentro <textarea> \(riga 99\)/u],
    ["con una pagina in un tag <head> che il body ignora", (html) => html.replace("</body>", 'testo <head data-histos="page"> altro\n</body>'), /^<head data-histos="page"> \(riga 98\) per il browser è testo dentro <body> \(riga 64\)/u],
    ["con un template dal data-histos vuoto", (html) => html.replace("</body>", '<template data-histos data-slug="x">x</template>\n</body>'), /^<template data-histos="">: tipo di documento sconosciuto/u],
    ["con uno stile dal data-histos vuoto", (html) => html.replace("</head>", "<style data-histos>.x { color: red; }</style>\n</head>"), /^<style data-histos="">: sezione sconosciuta/u],
    ["con un link con data-histos", (html) => html.replace("</head>", '<link data-histos="global" rel="stylesheet" href="x.css">\n</head>'), /^<link data-histos="global">: data-histos vale solo su script, style e template/u],
    ["con più di 5000 stili per selettore", (html) => html.replace(".opera {", `${Array.from({ length: 5_000 }, (_, index) => `.s${index} { color: red; }`).join("\n")}\n.opera {`), /^Stili per selettore: più di 5000 regole/u],
  ];
  it.each(refusals)("rifiuta un prototipo %s", async (_name, change, message) => {
    const changed = change(example);
    expect(changed).not.toBe(example);
    await expect(importPrototype(changed)).rejects.toThrow(message);
  });

  it("il testo che parla di data-histos dove il browser legge testo non ferma l'import", () => {
    const html = example.replace("</body>", [
      // Escaped, a <textarea> shows the tag as text, which is what it says.
      "<textarea>&lt;template data-histos=\"page\"&gt;</textarea>",
      // A preview script that looks for the templates names the attribute, never as a tag.
      "<script>document.querySelectorAll('template[data-histos=\"page\"]').forEach((item) => item.remove());</script>",
      "<noscript><p>Attiva JavaScript per l'anteprima.</p></noscript>",
      "<p>a < b e data-histos=\"page\"</p>",
      "</body>",
    ].join("\n"));
    expect(parsePrototype(html).ignored.map((item) => item.what)).toEqual(expect.arrayContaining(["<textarea>", "script", "<noscript>", "<p>"]));
  });

  // Text that is not a page never stops the import (§2). A <script> or <style> closed by its end tag is code: what its
  // comments, strings and comparisons say about tags is no page (review 3's verifier, the first three rows). In the
  // other elements the browser reads as text, only what the tokenizer would read as a start tag counts.
  const accepted: Array<[string, (html: string) => string]> = [
    ["con un confronto e un commento che nomina data-histos in uno script", (html) => html.replace("</head>", "<script>\nfor (let i = 0; i<pages.length; i++) {\n  // mostra ogni template data-histos della pagina\n  show(pages[i]);\n}\n</script>\n</head>")],
    ["con un tag con data-histos in una stringa di uno script", (html) => html.replace("</head>", "<script>console.warn('<template data-histos=\"page\"> senza data-slug');</script>\n</head>")],
    ["con un tag con data-histos in un commento di uno stile", (html) => html.replace("</head>", '<style>/* <template data-histos="page"> riceve questo stile in anteprima */ template { display: block }</style>\n</head>')],
    ["con un confronto seguito da un > in uno script", (html) => html.replace("</head>", "<script>\nfor (let i = 0; i<pages.length; i++) {\n  // mostra ogni template data-histos della pagina\n  if (i > 0) show(pages[i]);\n}\n</script>\n</head>")],
    ["con un confronto e data-histos in una <textarea>, senza tag", (html) => html.replace("</body>", "<textarea>i<pages.length; data-histos</textarea>\n</body>")],
    ["con una pagina commentata in <noscript>", (html) => html.replace("</body>", '<noscript><!-- <template data-histos="page" data-slug="x"></template> --><p>Attiva JavaScript.</p></noscript>\n</body>')],
    ["con un tag con data-histos in un commento di uno stile dentro <noscript>", (html) => html.replace("</body>", '<noscript><style>/* <template data-histos="page"> */ p { color: red }</style></noscript>\n</body>')],
    ["con data-histos in un tag di chiusura dentro <noscript>", (html) => html.replace("</body>", '<noscript><p>x</p data-histos="page"></noscript>\n</body>')],
    // Review 5: what tells a swallowed text, met in code with no data-histos tag, or a tag in code with none of it.
    ["con document.write di uno script e un selettore data-histos", (html) => html.replace("</head>", "<script>document.write('<script src=\"x.js\"><\\/script>'); document.querySelectorAll('template[data-histos=\"page\"]').forEach(show);</script>\n</head>")],
    ["con uno script src di soli spazi", (html) => html.replace("</head>", '<script src="anteprima.js">\n  \n</script>\n</head>')],
    ["con un commento che nomina il body e data-histos, senza tag", (html) => html.replace("</head>", "<script>\n// sposta ogni template data-histos nel body\n</script>\n</head>")],
    ["con un template data-histos e la sua chiusura in un commento HTML di uno script", (html) => html.replace("</head>", '<script><!-- <template data-histos="page"></template> --></script>\n</head>')],
    // Review 6 (the verifier's four files): a comment or a string that names a data-histos tag of the text's own
    // element, or a <body>, never starts its line with it, so it is no sign: accepted, as before review 5.
    ...[
      ["con un commento di uno script che nomina il tag del manifest", '<script>\n  // Anteprima: legge il manifest da <script type="application/json" data-histos="manifest"> qui sopra.\n  console.log("anteprima");\n</script>'],
      ["con una stringa di uno script che nomina il tag dei media", '<script>\n  const help = \'I media vanno in <script type="application/json" data-histos="assets">\';\n</script>'],
      ["con un commento di uno stile che nomina un foglio globale", '<style>\n  /* Anteprima soltanto: le regole vere stanno in <style data-histos="global" data-name="Base"> */\n  body { outline: 1px dashed red; }\n</style>'],
      ["con un commento di uno script che nomina una pagina e il body", '<script>\n  // Anteprima: copia ogni <template data-histos="page"> in un <body> di prova.\n</script>'],
      ["con un tag di script data-histos e un </head> in una riga di codice", '<script>\n  if (a > b) document.head.insertAdjacentHTML("beforeend", \'<script data-histos="content" type="application/json">{}<\\/script>\'); // prima di </head>\n</script>'],
      ["con un commento CSS che nomina uno stile data-histos e un <body>", '<style>/* <style data-histos="selectors"> vale per il <body> */ p { color: red }</style>'],
      // Review 7 (the verifier's files, refused by review 6): a `>` that ends no tag written where markup writes one
      // (`=>`, `->`, a CSS child combinator, a tag in a string) puts none after it there; nor does what the CSS or the
      // JavaScript holds in a string, a comment, a template literal or a regular expression, or a comparison.
      ["con un commento di uno script che nomina una pagina dopo =>", '<script>\n  // ogni pagina => <template data-histos="page"> diventa una pagina del CMS\n  console.log("anteprima");\n</script>'],
      ["con un commento di uno script che nomina il manifest dopo ->", '<script>\n  // manifest -> <script type="application/json" data-histos="manifest">\n  console.log("anteprima");\n</script>'],
      ["con una stringa di uno script che apre una pagina dopo un altro tag", '<script>\n  const demo = \'<main><template data-histos="page" data-slug="x">\';\n</script>'],
      ["con un commento CSS che nomina una pagina dopo un combinatore", '<style>\n  /* body > <template data-histos="page"> non ha stile: le regole vere stanno nel foglio globale */\n  body { outline: 1px dashed red; }\n</style>'],
      ["con una stringa CSS che nomina una pagina", '<style>\n  .x::before { content: "<template data-histos=\'page\'>"; } a > b { color: red }\n</style>'],
      ["con un template literal che nomina una pagina dopo un tag", '<script>\n  el.innerHTML = `<p>Anteprima</p> <template data-histos="page">`;\n</script>'],
      ["con un'espressione regolare che nomina una pagina", '<script>\n  if (/<template data-histos="page">/.test(html)) show(\'l\\\'opera\');\n</script>'],
      ["con un confronto in una media query e una pagina in un commento CSS", '<style>\n  @media (400px<width) { /* <template data-histos="page"> */ p { color: red } }\n</style>'],
      // Review 8 (the verifier's two files, refused by review 7): after the `)` of an `if`, `while`, `for` or `with` and
      // after a `}` that ends a block, a `/` opens a regular expression, as a JavaScript lexer reads it; after a `}` that
      // may end an object too (`case 1: {…}`), what the expression holds is only unsure.
      ["con un'espressione regolare che nomina una pagina dopo la condizione di un if", '<script>\n  if (ok) /<template data-histos="page">/.test(html) && warn();\n</script>'],
      ["con un'espressione regolare che nomina una pagina dopo un blocco", '<script>\n  function f() {}\n  /<template data-histos="page">/.test(document.body.innerHTML) && f();\n</script>'],
      ["con un'espressione regolare che nomina un foglio dopo un for", '<script>\n  for (const h of list) /<style data-histos="global">/.test(h) && n++;\n</script>'],
      ["con un'espressione regolare che nomina una pagina dopo un blocco di un case", '<script>\n  switch (x) { case 1: { go(); } /<template data-histos="page">/.test(h) && go(); }\n</script>'],
    ].map(([name, preview]): [string, (html: string) => string] => [name!, (html) => html.replace('<script>console.log("anteprima: non entra nel progetto")</script>', preview!)]),
  ];
  it.each(accepted)("accetta un prototipo %s", async (_name, change) => {
    const changed = change(example);
    expect(changed).not.toBe(example);
    const built = await buildPrototypeProfile(parsePrototype(changed), await newCatalog());
    expect(built.report.counts.pages).toBe(2);
  });

  it("i fogli globali e gli stili per selettore veri non si leggono mai come lasciati aperti (review 7)", () => {
    // CSS holds a tag only in a comment, a string or a url(): Histeon CSS, its tokens, the Core Framework sheet, and a
    // sheet with child combinators, strings and comments that name parts of the prototype, a media query comparing.
    const sheets = ["../assets/histos-css/histos.css", "../assets/histos-css/xb-tokens.css", "./fixtures/core-framework-css-1.1.0-default.min.css"].map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
    sheets.push('.a > .b { content: "<template data-histos=\'page\'>" }\n/* <style data-histos="global"> qui sopra,\n<template data-histos="page"> sotto */\n@media (400px<width) { .c > p { background: url(data:image/svg+xml,<svg><style>p</svg>) } }');
    // Review 8: a CSS `<!--` without its `-->` (a token CSS ignores, the verifier's two sheets), a comment that holds
    // another `/*`, a url() with spaces and markup in it, a url() over lines.
    sheets.push("<!--\n.a{color:red}\n", "/* vecchio */ <!-- .a{color:red}", "/* .old { color: red; } /* vecchio */\n.b { color: blue }", "/* vecchio /* <template data-histos=\"page\"> */ .c{}", ".d{background:url(data:image/svg+xml,<svg xmlns=%27http://www.w3.org/2000/svg%27><path d=%27M0 0%27/><style>a{}<%2Fstyle></svg>)}", ".e{background:url(\n  sfondo.png\n)}");
    // Review 9 (the verifier's, refused by review 8, accepted by base): a paired `<!-- … -->` hides what it holds like a
    // comment, a comment that holds another `/*` or a url() that holds a line feed hides what it holds as in base, when
    // no `data-histos` in them shows the sheet took in a later one.
    sheets.push("<!-- usato nel <body> -->\n.a{color:red}", "<!-- <template data-histos=\"page\"> -->\n.a{color:red}", "<!--\n<style data-histos=\"global\"> va qui\n-->\n.a{}", "/* nel <body> metti img/*.png */\n.a{}", "/* copia assets/*.svg nel <body> */\n.a{}", "/* immagini in img/*.png per <template data-histos=\"page\"> */\n.a{}", "/*/ <body> /*/\n.a{}", ".a{background:url(data:image/svg+xml;utf8,<svg>\n<style>.b{fill:red}<%2Fstyle><%2Fsvg>)}", ".a{background:url(a.png\n<body>)}", "/* data-histos: img/*.png */ .a{}");
    for (const css of sheets) {
      expect(parsePrototype(example.replace(/(<style data-histos="global" data-name="Base">)/u, (tag) => `${tag}\n${css}\n`)).globals[0]!.css).toContain(css);
      expect(parsePrototype(example.replace('<script>console.log("anteprima: non entra nel progetto")</script>', () => `<style>\n${css}\n</style>`)).documents.length).toBeGreaterThan(0);
      expect(parsePrototype(example.replace('<style data-histos="selectors">', () => `<style data-histos="selectors">\n${css}\n`)).selectors).toContain(css);
    }
  });

  it("script e stili: nessuna pagina persa in silenzio, nessun rifiuto per un commento o una stringa, come li legge il browser (review 6)", () => {
    // Generated files, checked against parse5 (scripting on, as the browser reads them): preview scripts and styles
    // whose comments and strings name data-histos tags of every kind, <body> and </head>, and, in most files, one
    // <script> or <style> left open, maybe ended by a lone end tag (alone, in an HTML comment, inside a page). Each
    // element is written on its own line, as a prototype is. A file that loses a real data-histos element must be
    // refused; one without a mistake must never be refused for text inside a script or a style.
    let seed = 20_261_106;
    const random = (count: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return (seed >>> 8) % count;
    };
    const pick = <T>(items: readonly T[]): T => items[random(items.length)]!;
    const js = [
      "init();", "for (let i = 0; i<pages.length; i++) show(pages[i]);", "if (a > b) go();",
      "// legge il manifest da <script type=\"application/json\" data-histos=\"manifest\"> qui sopra.",
      "// copia ogni <template data-histos=\"page\"> in un <body> di prova.", "/* <style data-histos=\"global\" data-name=\"Base\"> */",
      "const help = 'I media vanno in <script type=\"application/json\" data-histos=\"assets\">';", "console.warn('<template data-histos=\"page\"> senza data-slug');",
      "el.innerHTML = `\n  <p>Anteprima</p>\n`;", "document.write('<script src=\"x.js\"><\\/script>');", "// prima di </head>: <script data-histos=\"content\" type=\"application/json\">",
      "<!-- <template data-histos=\"page\"></template> -->",
      // Review 7: a tag after a `>` that ends no tag where markup writes one, in a comment, a string, a regular expression.
      "// ogni pagina => <template data-histos=\"page\"> diventa una pagina", "// manifest -> <script type=\"application/json\" data-histos=\"manifest\">",
      "const demo = '<main><template data-histos=\"page\" data-slug=\"x\">';", "if (/<style data-histos=\"global\">/.test(html)) show('l\\'opera');",
      // Review 8: a regular expression after the head of an `if` or after a block, and divisions after objects.
      "if (ok) /<template data-histos=\"page\">/.test(html) && warn();", "function f() {}\n  /<style data-histos=\"global\">/.test(s) && f();", "const o = {a: 1}; const h = (a + b) / 2 / c;",
    ];
    const css = [
      "body { margin: 0 }", "a > b { color: red }", "/* <template data-histos=\"page\"> riceve questo stile */", "/* le regole vere stanno in <style data-histos=\"global\" data-name=\"Base\"> */", "/* nel <body> */ p { color: blue }",
      "/* body > <template data-histos=\"page\"> */", ".x::before { content: \"<template data-histos='page'>\"; }",
    ];
    const code = (kind: string) => Array.from({ length: 1 + random(3) }, () => pick(kind === "script" ? js : css)).join("\n  ");
    const manifest = '<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"6b2f3c1e-1d3a-4c55-9a1b-2c3d4e5f6a7b","name":"R","framework":"none"}</script>';
    let refusedLosses = 0;
    let cleanAccepted = 0;
    for (let run = 0; run < 1_500; run++) {
      let count = 0;
      const real = () => {
        const id = `r${++count}`;
        return random(4) === 0 ? `<style data-histos="global" data-name="${id}">.${id}{color:red}</style>` : `<template data-histos="page" data-slug="${id}" data-title="P">${random(2) ? "<p>x</p>" : "\n  <main>\n    <p>x</p>\n  </main>\n"}</template>`;
      };
      const head = [manifest, ...Array.from({ length: random(3) }, real)];
      const body = ['<template data-histos="page" data-slug="home" data-title="H"><p>x</p></template>', ...Array.from({ length: 1 + random(4) }, real)];
      for (let index = random(3); index > 0; index--) {
        const list = random(2) ? head : body;
        list.splice(1 + random(list.length), 0, random(3) ? `<script>\n  ${code("script")}\n</script>` : `<style>\n  ${code("style")}\n</style>`);
      }
      const mistake = random(10) < 6;
      if (mistake) {
        const kind = random(3) ? "script" : "style";
        const list = random(3) ? body : head;
        list.splice(1 + random(list.length), 0, `${kind === "script" ? pick(["<script>", '<script src="a.js">', '<script type="module">']) : "<style>"}${random(2) ? `\n  ${code(kind)}` : ""}`);
        const lone = pick([`</${kind}>`, `<!-- </${kind}> -->`, `<!-- vecchio: </${kind}> -->`]);
        const where = random(3);
        if (where === 0) body.splice(random(body.length + 1), 0, lone);
        else if (where === 1) {
          const page = body.findIndex((item, index) => index > 0 && item.includes("<p>x</p>"));
          if (page > 0) body[page] = body[page]!.replace("<p>x</p>", `<p>x</p>${lone}`);
        }
      }
      const html = `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>R</title>\n${head.join("\n")}\n</head>\n<body>\n${body.join("\n")}\n</body></html>`;
      const written = [...html.matchAll(/data-(?:slug|name)="(r\d+|home)"/gu)].map((match) => match[1]!).concat("manifest");
      const seen = new Set<string>();
      const root = parse(html).childNodes.find((node) => node.nodeName === "html") as { childNodes: Array<{ childNodes?: Array<{ attrs?: Array<{ name: string; value: string }> }> }> };
      for (const part of root.childNodes) for (const child of part.childNodes ?? []) {
        const attributes = Object.fromEntries((child.attrs ?? []).map((attribute) => [attribute.name, attribute.value]));
        if (attributes["data-histos"] !== undefined) seen.add(attributes["data-histos"] === "manifest" ? "manifest" : attributes["data-slug"] ?? attributes["data-name"] ?? "");
      }
      const lost = written.some((id) => !seen.has(id));
      let refusal: string | undefined;
      try {
        parsePrototype(html);
      } catch (error) {
        refusal = (error as Error).message;
      }
      if (lost) {
        expect(refusal, html).toBeDefined();
        refusedLosses++;
      } else if (!mistake) {
        expect(refusal, html).toBeUndefined();
        cleanAccepted++;
      }
    }
    expect(refusedLosses).toBeGreaterThan(300);
    expect(cleanAccepted).toBeGreaterThan(400);
  }, 60_000);

  it("fogli data-histos lasciati aperti: nessuna pagina persa in silenzio, nessun rifiuto di un foglio chiuso, come li legge il browser (review 8, 9)", () => {
    // Generated files, checked against parse5: global sheets whose CSS holds comments and strings that name tags,
    // url()s with markup or spaces, CSS `<!--` and `-->`, comments that hold another `/*`; in most files one sheet left
    // open, its CSS maybe ending inside a comment, a url( or a string, before pages, sheets and markup. A file that loses
    // a real data-histos element must be refused; one without a mistake must never be. (Not here: a comment left open
    // whose `*/` or `-->` comes in a later sheet with no `/*` or `<!--` before it, `content: "*/"` or a lone CSS `-->`,
    // the limit §2 states.)
    let seed = 20_261_027;
    const random = (count: number) => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return (seed >>> 8) % count;
    };
    const pick = <T>(items: readonly T[]): T => items[random(items.length)]!;
    const css = [
      ".a{color:red}", "a > b { color: red }", "/* <template data-histos=\"page\"> riceve questo stile */", "/* le regole stanno in <style data-histos=\"global\"> */",
      "/*\n<style data-histos=\"global\"> contiene le regole generali\n*/", ".x::before { content: \"<template data-histos='page'>\" }",
      ".s{background:url(data:image/svg+xml,<svg xmlns=%27x%27><style>a{}<%2Fstyle><%2Fsvg>)}", ".u{background:url(\"a b.png\")}", ".v{background:url( a.png )}",
      "<!--", "<!-- .c{color:blue} -->", "/* .old{color:red} /* vecchio */", "/* L'opera */ .o{}", "@media (400px<width) { .m{} }", ".e\\<b{color:red}", "/* nel <body> */ p{}", ".r{content:'/*'}",
      // Review 9: closed sheets the review-8 rules refused (the verifier's), which a browser and base read as CSS.
      "<!-- usato nel <body> -->", "/* nel <body> metti img/*.png */", "/*/ <body> /*/", ".n{background:url(a.png\n<body>)}",
    ];
    const openEnds = ["/* da finire", ".z{background:url(sfondo.png}", ".z{content:\"it's}", "", ".z{color:red", "<!--"];
    const fillers = ["<!-- testata -->", "<p>Testo</p>", "<div>x</div>", "<script>init()</script>", "<style>p{margin:0}</style>", "<style>/* x */ p{}</style>"];
    const sheet = () => Array.from({ length: 1 + random(3) }, () => pick(css)).join(pick(["\n", " "]));
    const manifest = '<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"6b2f3c1e-1d3a-4c55-9a1b-2c3d4e5f6a7b","name":"R","framework":"none"}</script>';
    let refusedLosses = 0;
    let cleanAccepted = 0;
    for (let run = 0; run < 1_000; run++) {
      let count = 0;
      const real = () => {
        const id = `r${++count}`;
        const kind = random(4);
        if (kind < 2) return `<template data-histos="page" data-slug="${id}" data-title="P"><p>x</p></template>`;
        if (kind < 3) return `<template data-histos="page" data-slug="${id}" data-title="P">\n  <style>/* c */ p{}</style>\n  <p>x</p>\n</template>`;
        return `<style data-histos="global" data-name="${id}">${random(2) ? `/* ${id} */ ` : ""}.a${count}{color:red}</style>`;
      };
      const head = [manifest];
      const body = ['<template data-histos="page" data-slug="home" data-title="H"><p>x</p></template>'];
      for (let index = random(3); index > 0; index--) (random(2) ? head : body).push(real());
      for (let index = 1 + random(2); index > 0; index--) head.push(`<style data-histos="global" data-name="g${index}">${sheet()}</style>`);
      const mistake = random(10) < 6;
      if (mistake) {
        const list = random(2) ? head : body;
        const at = 1 + random(list.length);
        list.splice(at, 0, `<style data-histos="global" data-name="aperto">${sheet()}${pick(["\n", " "])}${pick(openEnds)}`);
        for (let index = 1 + random(3); index > 0; index--) list.splice(at + 1 + random(list.length - at), 0, random(4) ? real() : pick(fillers));
      }
      const html = `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>R</title>\n${head.join("\n")}\n</head>\n<body>\n${body.join("\n")}\n</body></html>`;
      const written = [...html.matchAll(/data-(?:slug|name)="([rg]\d+|home)"/gu)].map((match) => match[1]!).concat("manifest");
      const seen = new Set<string>();
      const root = parse(html).childNodes.find((node) => node.nodeName === "html") as { childNodes: Array<{ childNodes?: Array<{ attrs?: Array<{ name: string; value: string }> }> }> };
      for (const part of root.childNodes) for (const child of part.childNodes ?? []) {
        const attributes = Object.fromEntries((child.attrs ?? []).map((attribute) => [attribute.name, attribute.value]));
        if (attributes["data-histos"] !== undefined) seen.add(attributes["data-histos"] === "manifest" ? "manifest" : attributes["data-slug"] ?? attributes["data-name"] ?? "");
      }
      const lost = written.some((id) => !seen.has(id));
      let refusal: string | undefined;
      try {
        parsePrototype(html);
      } catch (error) {
        refusal = (error as Error).message;
      }
      if (lost) {
        expect(refusal, html).toBeDefined();
        refusedLosses++;
      } else if (!mistake) {
        expect(refusal, html).toBeUndefined();
        cleanAccepted++;
      }
    }
    expect(refusedLosses).toBeGreaterThan(300);
    expect(cleanAccepted).toBeGreaterThan(300);
  }, 60_000);

  it("un template senza data-histos resta fuori e lo dice, come ogni altro elemento ignorato", () => {
    const html = example.replace("</body>", "<template><p>bozza</p></template>\n</body>");
    expect(parsePrototype(html).ignored).toContainEqual({ what: "<template>", why: "senza data-histos: non entra nel progetto", line: 98 });
  });

  it("misura i fogli quando legge il file, prima che il build li analizzi", () => {
    // The build parses a sheet whole before it measures it, some hundred bytes per byte of CSS: a sheet near the 32 MB
    // of the file ended the process with an out-of-memory error no catch could stop.
    const global = (css: string, manifest = example) => manifest.replace(/(<style data-histos="global" data-name="Base">)/u, `$1\n${css}\n`);
    expect(() => parsePrototype(global(".a{b:c}".repeat(160_000)))).toThrow(/^Il foglio globale «Base» supera 1 MB di CSS: dividilo in più fogli\.$/u);
    const selectors = example.replace(".opera {", `${".a{b:c}".repeat(1_200_000)}\n.opera {`);
    expect(() => parsePrototype(selectors)).toThrow(/^Fogli globali e stili per selettore superano insieme 8 MiB di CSS/u);
    // As code points, as the transfer counts them: 600,000 emoji are 1.2 million UTF-16 units but fit.
    expect(() => parsePrototype(global(`/* ${"🎨".repeat(600_000)} */`))).not.toThrow();
    // An ACSS sheet to convert may shrink to 1 MB: it is measured exactly after the conversion, and here only past twice that.
    const acss = example.replace('"framework": "histos-css"', '"framework": "acss"');
    expect(() => parsePrototype(global(".a{color:var(--body-bg-color)}".repeat(50_000), acss))).not.toThrow();
    expect(() => parsePrototype(global(".a{b:c}".repeat(320_000), acss))).toThrow(/^Il foglio globale «Base» supera 1 MB di CSS/u);
  }, 120_000);

  it("gli stili per selettore hanno il limite del documento degli stili, 8 MiB con i fogli globali, e gli spazi non contano", async () => {
    // 4,000 distinct rules, 4.6 MB: within 5,000 rules and 1 MB a rule. Before, a cap of 4 MB "of the transfer format"
    // refused them, though the transfer has no such total and the store holds 8 MiB of styles.
    const rules = Array.from({ length: 4_000 }, (_, index) => `.r${index} { ${"color: red; ".repeat(95)} }`).join("\n");
    const many = await buildPrototypeProfile(parsePrototype(example.replace(".opera {", `${rules}\n.opera {`)), await newCatalog());
    expect(many.report.counts.styles).toBe(4_002);
    // Indentation is no part of a style: 12 MB of it around a few rules is no reason to refuse them.
    const indented = Array.from({ length: 1_000 }, (_, index) => `.i${index} {\n${" ".repeat(12_000)}color: red;\n}`).join("\n");
    expect((await buildPrototypeProfile(parsePrototype(example.replace(".opera {", `${indented}\n.opera {`)), await newCatalog())).report.counts.styles).toBe(1_002);
    // The global sheets share the document: 5 MB of them and 3.5 MB of rules stop as the file is read, by name, where
    // before the build read everything and the store refused a document "over 8 MiB".
    const globals = Array.from({ length: 5 }, (_, index) => `<style data-histos="global" data-name="G${index}">${".g{b:c}".repeat(145_000)}</style>`).join("\n");
    const shared = example.replace("</head>", `${globals}\n</head>`).replace(".opera {", `${".a{b:c}".repeat(500_000)}\n.opera {`);
    expect(() => parsePrototype(shared)).toThrow(/^Fogli globali e stili per selettore superano insieme 8 MiB di CSS: il progetto li tiene in un solo documento/u);
    // What fits as written but not once kept as JSON (an id and keys for each of 5,000 small rules) is measured exactly
    // before it is saved, and said the same way.
    const full = Array.from({ length: 8 }, (_, index) => `<style data-histos="global" data-name="F${index}">${".f{b:c}".repeat(147_000)}</style>`).join("\n");
    const small = Array.from({ length: 4_990 }, (_, index) => `.s${index}{a:b}`).join("");
    const exact = example.replace("</head>", `${full}\n</head>`).replace(".opera {", `${small}\n.opera {`);
    await expect(buildPrototypeProfile(parsePrototype(exact), await newCatalog())).rejects.toThrow(/^Fogli globali e stili per selettore superano insieme 8 MiB \(8,\d\d MiB come il progetto li salva\)/u);
  }, 120_000);

  it("un foglio che il documento degli stili terrebbe ma che costerebbe troppo analizzare si ferma prima di analizzarlo (review 4)", () => {
    // Within 8 MiB the parse of dense CSS held 1.4 to 2.6 GB, and of one long declaration up to 3.5 GB: each sheet is
    // now counted as the file is read, and stopped by name, with what to change.
    const selectors = (css: string) => example.replace(".opera {", `${css}\n.opera {`);
    const lineOf = (html: string, text: string) => html.split("\n").findIndex((row) => row.includes(text)) + 1;
    // A million comments in a rule (4 MB), or a million nested rules with a declaration each (3 MB): each node holds at
    // least 452 bytes, so they stop at the memory the parse would hold, with the sheet's line (review 6).
    const line = example.split("\n").findIndex((row) => row.includes('<style data-histos="selectors">')) + 1;
    for (const css of [`.z{${"/**/".repeat(1_000_000)}}`, `.z{${"&{b:c}".repeat(500_000)}}`]) {
      expect(() => parsePrototype(selectors(css))).toThrow(new RegExp(`^Gli stili per selettore, riga ${line}: analizzarlo terrebbe in memoria più di 384 MB fra regole, parole e parti, troppo: un foglio reale di 3 MB ne tiene meno di un terzo: va alleggerito\\.$`, "u"));
    }
    expect(() => parsePrototype(selectors(`.z{${"a:b c d e f g h i j;".repeat(210_000)}}`))).toThrow(/^Gli stili per selettore: più di 2\.000\.000 parole di CSS/u);
    expect(() => parsePrototype(selectors(`.z{a:b}${"\n".repeat(2_000_000)}`))).toThrow(/^Gli stili per selettore: più di 2\.000\.000 righe/u);
    // One declaration of 120,000 tokens, and an unclosed bracket, which makes the rest of the sheet one declaration.
    const long = selectors(`.z{a:${"x ".repeat(60_000)}}`);
    expect(() => parsePrototype(long)).toThrow(new RegExp(`^Gli stili per selettore, riga ${lineOf(long, ".z{a:")}: una dichiarazione, un selettore o un intervallo fra due regole di più di 100\\.000 parti, troppo lungo da analizzare`, "u"));
    const bracket = selectors(`.z{a:(${";".repeat(120_000)}}`);
    expect(() => parsePrototype(bracket)).toThrow(new RegExp(`^Gli stili per selettore, riga ${lineOf(bracket, ".z{a:(")}: una dichiarazione`, "u"));
    // A node that opens with `[` holds everything up to its `]`, `;` and braces included (review 5): 240,000 tokens in
    // nodes of 2,000 each were one declaration for postcss, which held 1.4 GB at 3.9 MB of them and 2 GB at 16 MB.
    const opening = selectors(`.z{[${`${": ".repeat(1_000)};`.repeat(120)}]:x}`);
    expect(() => parsePrototype(opening)).toThrow(new RegExp(`^Gli stili per selettore, riga ${lineOf(opening, ".z{[")}: una dichiarazione`, "u"));
    // More top-level rules than the transfer takes stop before their names are read, some 1.2 KB a rule.
    expect(() => parsePrototype(selectors("a{}".repeat(2_000_000)))).toThrow(/^Stili per selettore: più di 5000 regole/u);
  }, 120_000);

  it("un foglio dentro ogni limite ma che terrebbe troppa memoria si ferma prima di analizzarlo (review 6)", () => {
    // The verifier's shapes: 165 nodes of 99,980 tokens, a `:` and two spaces each (spaces count for nothing in the 8
    // MiB, and each two-space token is a string of its own), opening with `[` or as selectors. Within every earlier
    // bound, they ran out of a 700 MB heap and took 912 MB at 1 GB; what the parse holds is now counted, and they stop.
    const unit = ":  ".repeat(49_990);
    const shapes = {
      bracket: Array.from({ length: 165 }, (_, index) => `.r${index}{[${unit}]:x}`).join(""),
      split: `.z{${`[${unit}]:x;`.repeat(165)}}`,
      selectors: Array.from({ length: 165 }, () => `${unit}x{}`).join(""),
    };
    for (const [name, css] of Object.entries(shapes)) {
      const html = example.replace(".opera {", `${css}\n.opera {`);
      // The line where the sheet's text starts: its tag's.
      const line = html.split("\n").findIndex((row) => row.includes('<style data-histos="selectors">')) + 1;
      expect(() => parsePrototype(html), name).toThrow(new RegExp(`^Gli stili per selettore, riga ${line}: analizzarlo terrebbe in memoria più di 384 MB fra regole, parole e parti, troppo: un foglio reale di 3 MB ne tiene meno di un terzo: va alleggerito\\.$`, "u"));
    }
    // A global sheet past it is kept as written, not parsed, and reported, as one past any other bound: 2 MB of rules in
    // a prototype to convert from ACSS, which may shrink to 1 MB.
    const acss = example.replace('"framework": "histos-css"', '"framework": "acss"').replace(/(<style data-histos="global" data-name="Base">)/u, `$1\n${"a{}".repeat(690_000)}\n`);
    const sheetLine = acss.split("\n").findIndex((row) => row.includes('<style data-histos="global" data-name="Base">')) + 1;
    expect(parsePrototype(acss).globals[0]!.unparsed).toEqual({
      reason: `riga ${sheetLine}: analizzarlo terrebbe in memoria più di 384 MB fra regole, parole e parti, troppo`,
      message: `Il foglio globale «Base», riga ${sheetLine}: analizzarlo terrebbe in memoria più di 384 MB fra regole, parole e parti, troppo: un foglio reale di 3 MB ne tiene meno di un terzo: va alleggerito.`,
    });
  }, 120_000);

  it("il source map incorporato che chiude un foglio ne esce prima di analizzarlo, e il rapporto dice dov'era; altrove ferma il foglio (review 8, 9)", async () => {
    // postcss decodes and parses an inline source map (some 12 bytes a character), and on an error in the sheet reads
    // every mapping: 1.4 million alike in 8 MB took 67 s, then ran out of stack. Sass and Vite end the sheets they
    // compile with one, which a published site never uses: the one that ends a global sheet or the selector styles
    // (only spaces after it) is taken out before anything measures, parses or keeps them, a line feed in its place, and
    // the report names the sheet and the line. Review 7 refused such a sheet; review 8 took out every map, quadratic.
    const json = JSON.stringify({ version: 3, sources: ["stili.scss"], names: [], mappings: "AAAA;AACA" });
    const map = `/*# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(json).toString("base64")} */`;
    const atEnd = (html: string, global: string, selectors: string) => html.replace(/(<style data-histos="global" data-name="Base">[\s\S]*?)(<\/style>)/u, (_all, sheet: string, close: string) => `${sheet}${global}${close}`).replace(/(<style data-histos="selectors">[\s\S]*?)(<\/style>)/u, (_all, sheet: string, close: string) => `${sheet}${selectors}${close}`);
    const html = atEnd(example, `.a { color: red }\n/*\n  # sourceMappingURL=data:application/json,{} */\n  \n`, `${map}\n`);
    const rows = html.split("\n");
    const line = rows.findIndex((row) => row.includes(map)) + 1;
    const globalLine = rows.findIndex((row) => row === ".a { color: red }") + 2;
    const parsed = parsePrototype(html);
    expect(parsed.selectors).not.toContain("sourceMappingURL");
    expect(parsed.selectors).toMatch(/&:hover \{ outline: 1px solid currentColor; \}\n\}\n\n\n$/u);
    expect(parsed.globals[0]!.css).not.toContain("sourceMappingURL");
    expect(parsed.globals[0]!.css).toMatch(/\n\.a \{ color: red \}\n\n\n {2}\n$/u);
    const sheetWarning = `Il foglio globale «Base», riga ${globalLine}: tolto il source map incorporato (/*# sourceMappingURL=data:… */), che al sito pubblicato non serve.`;
    const selectorsWarning = `Gli stili per selettore, riga ${line}: tolto il source map incorporato (/*# sourceMappingURL=data:… */), che al sito pubblicato non serve.`;
    expect(parsed.warnings).toEqual([sheetWarning, selectorsWarning]);
    const built = await buildPrototypeProfile(parsed, await newCatalog());
    expect(built.report.warnings).toEqual(expect.arrayContaining([sheetWarning, selectorsWarning]));
    expect(JSON.stringify(built.profile)).not.toContain("sourceMappingURL");
    // Anywhere else it stops the sheet, with its line, as in review 7: in the middle, before another comment or rule, in
    // a string, and the first of two at the end (only the last leaves).
    const refused = (html: string, where: string) => {
      const row = html.split("\n").findIndex((text) => text.includes(map)) + 1;
      expect(() => parsePrototype(html), html).toThrow(new RegExp(`^${where}, riga ${row}: un source map incorporato \\(/\\*# sourceMappingURL=data:… \\*/\\), che l'analisi del CSS leggerebbe per intero: toglilo, al progetto non serve\\.$`, "u"));
    };
    refused(example.replace(".opera {", `${map}\n.opera {`), "Gli stili per selettore");
    refused(atEnd(example, `${map}\n.a{}\n`, ""), "Il foglio globale «Base»");
    refused(atEnd(example, `${map}\n/* fine */\n`, ""), "Il foglio globale «Base»");
    refused(atEnd(example, "", `.x::after { content: "${map}" }\n`), "Gli stili per selettore");
    refused(atEnd(example, "", `${map}\n${map}\n`), "Gli stili per selettore");
    // One that names a file next to the sheet postcss never reads (it has no file): it stays.
    const file = parsePrototype(atEnd(example, "", "/*# sourceMappingURL=stili.css.map */\n"));
    expect(file.selectors).toContain("stili.css.map");
    expect(file.warnings).toBeUndefined();
  });

  it("un «important» senza «!» in fondo a una dichiarazione lunga ferma il foglio prima di analizzarlo (review 7)", () => {
    // postcss takes back a value that ends with the word `important` one token at a time, copying all it took back
    // each time: 4,000 pieces of a word and 1,000 spaces took 7.7 s, 30 MB of them minutes.
    const important = example.replace(".opera {", `.lungo { color: ${`x${" ".repeat(1_000)}`.repeat(4_000)}important; }\n.opera {`);
    const importantLine = important.split("\n").findIndex((row) => row.startsWith(".lungo")) + 1;
    expect(() => parsePrototype(important)).toThrow(new RegExp(`^Gli stili per selettore, riga ${importantLine}: dichiarazioni lunghe che finiscono con «important» senza «!», che l'analisi rilegge da capo una parte alla volta, troppo lente da analizzare\\. Scrivi «!important», o togli «important»\\.$`, "u"));
    expect(parsePrototype(important.replace("important; }", "!important; }")).selectors).toContain("!important");
  });

  it("un foglio globale oltre i limiti dell'analisi entra com'è scritto, senza analizzarlo, e il rapporto lo dice (review 5)", async () => {
    // A `(` left open makes the rest of a sheet one declaration for postcss (the browser too loses the rest of it).
    // Past 100,000 parts a global sheet stopped the import, where before it was kept as written, unread: a global sheet
    // is parsed only for its names, so now it is not parsed at all, and the report says why.
    const rules = Array.from({ length: 3_000 }, (_, index) => `.blocco-${index} { display: flex; gap: 1rem; padding: 2rem 1.5rem; color: #333; margin: 0 auto; }`).join("\n");
    const broken = ".titolo { width: calc(100% - 2rem; }";
    const global = (html: string) => html.replace(/(<style data-histos="global" data-name="Base">)/u, `$1\n${broken}\n${rules}\n`);
    const html = global(example);
    const line = html.split("\n").findIndex((row) => row.includes(broken)) + 1;
    const reason = `riga ${line}: una dichiarazione, un selettore o un intervallo fra due regole di più di 100.000 parti, troppo lungo da analizzare`;
    expect(parsePrototype(html).globals[0]!.unparsed?.reason).toBe(reason);
    const { report, store } = await importPrototype(html);
    try {
      expect(report.warnings).toContain(`Il foglio globale «Base», ${reason}. Controlla che parentesi, virgolette e commenti siano chiusi. Il foglio entra nel progetto così com'è, ma l'import non ne legge le regole.`);
      const styles = JSON.parse(store.getHead(store.getStyles()!.id)!.content) as { globals: Array<{ css: string }> };
      expect(styles.globals[0]!.css).toContain(`${broken}\n.blocco-0 {`);
    } finally { store.close(); }
    // In a prototype to convert from ACSS too: read as a sheet postcss cannot read, its classes all count as defined.
    const acss = await buildPrototypeProfile(parsePrototype(global(example.replace('"framework": "histos-css"', '"framework": "acss"'))), await newCatalog());
    expect(acss.report.warnings.some((warning) => warning.startsWith(`CSS che l'import non legge come il browser: foglio Base, ${reason}.`))).toBe(true);
    // The selector styles cannot do without their parse: there the same sheet stops the import.
    const selectors = example.replace(".opera {", `${broken}\n${rules}\n.opera {`);
    expect(() => parsePrototype(selectors)).toThrow(new RegExp(`^Gli stili per selettore, riga ${selectors.split("\n").findIndex((row) => row.includes(broken)) + 1}: una dichiarazione`, "u"));
  }, 120_000);

  it("ogni problema dei media ha il suo posto nel file, e vengono tutti insieme (review 5)", async () => {
    const assets = (json: string) => example.replace(/(<script type="application\/json" data-histos="assets">)[\s\S]*?(<\/script>)/u, `$1\n${json}\n$2`);
    const png = /"data": "(data:image\/png;base64,[^"]+)"/u.exec(example)![1]!;
    const issuesOf = (attempt: () => unknown) => {
      try {
        attempt();
      } catch (error) {
        expect(error).toBeInstanceOf(PrototypeError);
        return (error as PrototypeError).issues;
      }
      throw new Error("non rifiutato");
    };
    // The list starts on line 11 of the file: each entry on its own line, two spaces in.
    const entries = [
      `{ "name": "ehi", "data": "${png}", "alt": "Ehi" }`,
      `{ "name": "Logo Grande", "data": "${png}" }`,
      `{ "name": "ehi", "url": "http://example.com/ehi.png" }`,
      `{ "name": "texture", "data": "${png}", "url": "https://example.com/t.png", "titolo": "x", "alt": 3 }`,
      `"foto"`,
    ];
    expect(issuesOf(() => parsePrototype(assets(`[\n  ${entries.join(",\n  ")}\n]`)))).toEqual([
      { document: "assets", line: 13, column: 3, message: "Media 2: nome mancante, non valido o ripetuto." },
      { document: "assets", line: 14, column: 3, message: "Media 3: nome mancante, non valido o ripetuto." },
      { document: "assets", line: 14, column: 3, message: "Media 3: url deve essere un indirizzo https://." },
      { document: "assets", line: 15, column: 3, message: "Media 4: campo sconosciuto titolo." },
      { document: "assets", line: 15, column: 3, message: "Media texture: serve esattamente uno tra url e data." },
      { document: "assets", line: 15, column: 3, message: "Media texture: alt: serve un testo di al massimo 1000 caratteri." },
      { document: "assets", line: 16, column: 3, message: "Media 5: serve un oggetto." },
    ]);
    // Entries on one line have their columns; a list that is not one is said where it starts.
    const first = `[{ "name": "ehi", "data": "${png}" }, `;
    expect(issuesOf(() => parsePrototype(assets(`${first}{ "name": "texture", "dati": "x" }]`)))).toEqual([
      { document: "assets", line: 11, column: first.length + 1, message: "Media 2: campo sconosciuto dati." },
      { document: "assets", line: 11, column: first.length + 1, message: "Media texture: serve esattamente uno tra url e data." },
    ]);
    expect(issuesOf(() => parsePrototype(assets(`{ "name": "ehi" }`)))).toEqual([{ document: "assets", line: 11, column: 1, message: "Media: serve un elenco di al massimo 500 voci." }]);
    // What the build finds in a media is said at its entry too: every remote one when downloads are off, a type that is
    // not allowed.
    const remote = assets(`[\n  { "name": "ehi", "url": "https://example.com/ehi.png" },\n  { "name": "texture", "url": "https://example.com/t.png" }\n]`);
    await expect(buildPrototypeProfile(parsePrototype(remote), await newCatalog())).rejects.toMatchObject({ issues: [
      { document: "assets", line: 12, column: 3, message: "Media ehi: è remoto e lo scaricamento delle immagini remote non è attivo." },
      { document: "assets", line: 13, column: 3, message: "Media texture: è remoto e lo scaricamento delle immagini remote non è attivo." },
    ] });
    const svg = assets(`[\n  { "name": "ehi", "data": "data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}" },\n  { "name": "texture", "data": "data:image/png;base64,====" }\n]`);
    await expect(buildPrototypeProfile(parsePrototype(svg), await newCatalog())).rejects.toMatchObject({ issues: [
      { document: "assets", line: 12, column: 3, message: "Media ehi: non è PNG, JPEG, GIF, WebP, AVIF, WOFF o WOFF2 (SVG non è ammesso)." },
      { document: "assets", line: 13, column: 3, message: "Media texture: data URI vuoto." },
    ] });
    // A download that gives no bytes (a 200 with no body) says so, at its entry: it has no data URI (review 6).
    const empty = assets(`[\n  { "name": "ehi", "data": "${png}" },\n  { "name": "texture", "url": "https://example.com/t.png" },\n  { "name": "vuoto", "data": "data:image/png;base64,====" }\n]`);
    await expect(buildPrototypeProfile(parsePrototype(empty), await newCatalog(), { fetchAsset: async () => new Uint8Array(0) })).rejects.toMatchObject({ issues: [
      { document: "assets", line: 13, column: 3, message: "Media texture: il download non ha dato byte." },
      { document: "assets", line: 14, column: 3, message: "Media vuoto: data URI vuoto." },
    ] });
  });

  it("gli stili per selettore di un prototipo ACSS da convertire si misurano convertiti, prima di analizzarli", async () => {
    const acss = example.replace('"framework": "histos-css"', '"framework": "acss"');
    // 9 MB as written: within twice the limit, the margin of a sheet the conversion may shorten, so the file is read
    // (in 4,500 rules of 72 declarations: within what a parse may hold, cssParseCost).
    const html = acss.replace(".opera {", `${`.a{${"background-color:rgb(1,2,3);".repeat(72)}}`.repeat(4_500)}\n.opera {`);
    const parsed = parsePrototype(html);
    // Unchanged by the conversion it is still over 8 MiB, and the build stops before it parses the sheet (parsed, the
    // repeated selector would be the first problem met).
    await expect(buildPrototypeProfile(parsed, await newCatalog())).rejects.toThrow(/^Fogli globali e stili per selettore superano insieme 8 MiB di CSS/u);
    expect(() => parsePrototype(acss.replace(".opera {", `${".a{b:c}".repeat(2_500_000)}\n.opera {`))).toThrow(/^Fogli globali e stili per selettore superano insieme 8 MiB/u);
  }, 120_000);

  it("la conversione ACSS non accorcia un riferimento di metà o più (il margine dei fogli da convertire)", () => {
    const map = JSON.parse(readFileSync(new URL("../assets/histos-css/acss-map.json", import.meta.url), "utf8")) as { tokens: Record<string, string> };
    for (const [histos, acss] of Object.entries(map.tokens)) {
      // The shortest reference the conversion renames is `var(--name` followed by `)` or `,`.
      expect(2 * (acss.length - histos.length), `${acss} → ${histos}`).toBeLessThan(`var(--${acss})`.length);
    }
  });

  it("un foglio ACSS si misura dopo la conversione: oltre 1 MB scritto può entrare, oltre 1 MB convertito no", async () => {
    const acss = (rule: string, times: number) => example.replace('"framework": "histos-css"', '"framework": "acss"').replace(/(<style data-histos="global" data-name="Base">)/u, `$1\n${rule.repeat(times)}\n`);
    // 1.06 MB as written, 0.77 MB once var(--body-bg-color) becomes var(--xb-bg).
    const fits = acss("p{color:var(--body-bg-color)}", 36_500);
    const built = await buildPrototypeProfile(parsePrototype(fits), await newCatalog());
    expect(built.report.counts.globals).toBe(1);
    // 1.3 MB as written, still 1.09 MB converted.
    const over = acss("p{color:var(--body-bg-color);margin:0 auto 0 auto}", 26_000);
    await expect(buildPrototypeProfile(parsePrototype(over), await newCatalog())).rejects.toThrow(/^Il foglio globale «Base» supera 1 MB di CSS/u);
  }, 120_000);

  it("scarica i media remoti solo con il fetcher del server", async () => {
    const remote = example.replace(/"data": "data:image\/png;base64,([^"]+)"(, "alt": "Ehi, con cornice")/u, '"url": "https://example.com/ehi.png"$2');
    const png = Buffer.from(/"data": "data:image\/png;base64,([^"]+)"/u.exec(example)![1]!, "base64");
    const requested: string[] = [];
    const built = await buildPrototypeProfile(parsePrototype(remote), await newCatalog(), { fetchAsset: async (url) => { requested.push(url); return png; } });
    expect(requested).toEqual(["https://example.com/ehi.png"]);
    expect(built.report.downloaded).toBe(1);
  });
  it("indica la riga del file per un errore di sintassi in un documento", async () => {
    const broken = example.replace("<p>Scrivimi.</p>", "<p>Scrivimi.</p>\n  {#if}");
    const line = broken.split("\n").findIndex((text) => text.includes("{#if}")) + 1;
    await expect(buildPrototypeProfile(parsePrototype(broken), await newCatalog())).rejects.toThrow(`page contatti, riga ${line}, colonna 3: Sintassi`);
  });

  it("una pagina oltre i 4 MB del formato di trasferimento si ferma con il suo nome, non con il rapporto dello schema", async () => {
    const huge = example.replace("<p>Scrivimi.</p>", `<p>${"testo ".repeat(720_000)}</p>`).replace(' data-status="draft"', "");
    await expect(buildPrototypeProfile(parsePrototype(huge), await newCatalog())).rejects.toThrow(/^La pagina contatti supera i 4 MB di contenuto/u);
    // Measured as the format measures it: an emoji is one character, so this page fits.
    const emoji = example.replace("<p>Scrivimi.</p>", `<p>${"🎨".repeat(1_100_000)}${"a".repeat(2_100_000)}</p>`).replace(' data-status="draft"', "");
    await expect(buildPrototypeProfile(parsePrototype(emoji), await newCatalog())).resolves.toBeDefined();
    // A component and a global sheet are named too.
    const component = example.replace(/(<template data-histos="component" data-ref="card-opera"[^>]*>)/u, `$1<p>${"testo ".repeat(720_000)}</p>`);
    await expect(buildPrototypeProfile(parsePrototype(component), await newCatalog())).rejects.toThrow(/^Il componente card-opera supera i 4 MB di contenuto: dividilo/u);
    // A sheet is measured as the file is read, before the build parses it.
    const sheet = example.replace(/(<style data-histos="global" data-name="Base">)/u, `$1\n.a { color: red; }\n${"/* commento */ .b{color:blue}".repeat(40_000)}\n`);
    expect(() => parsePrototype(sheet)).toThrow(/^Il foglio globale «Base» supera 1 MB di CSS/u);
  }, 120_000);

  it("nel controllo rapido usa un segnaposto per i media remoti e lo dice", async () => {
    const remote = example.replace(/"data": "data:image\/png;base64,[^"]+"(, "alt": "Ehi, con cornice")/u, '"url": "https://example.com/ehi.png"$1');
    const built = await buildPrototypeProfile(parsePrototype(remote), await newCatalog(), { remotePlaceholders: true });
    expect(built.report.placeholders).toEqual(["ehi"]);
    expect(built.report.warnings.some((warning) => warning.includes("non scaricati"))).toBe(true);
  });
  it("un endpoint di modulo scritto con entità è esterno nel rapporto, con l'avviso", async () => {
    const html = example.replace("<p>Scrivimi.</p>", '<form action="https&#58;//evil.example/raccolta" method="post"><input type="email" name="email" autocomplete="email"><button type="submit">Invia</button></form>');
    const { report, store } = await importPrototype(html);
    try {
      expect(report.forms).toEqual([{ document: "page contatti", method: "post", action: "https://evil.example/raccolta", external: true }]);
      expect(report.warnings).toContain("page contatti: il modulo invia i dati (POST) a evil.example.");
    } finally {
      store.close();
    }
  });
  it("porta icone SVG, moduli, pulsanti, picture e details, e il rapporto elenca i moduli", async () => {
    const icon = `<template data-histos="component" data-ref="ui/icona" data-title="Icona" data-props='{"label":{"type":"string","default":"Icona"}}'>
  <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewbox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" focusable="false"><title>{props.label}</title><path d="m21 21-4.3-4.3" pathlength="10"/></svg>
</template>
`;
    const contacts = [
      '<Ui.Icona label="Cerca"/><button type="button" aria-expanded="false">Menu</button>',
      '<form action="/cerca/" method="get" role="search"><label for="q">Cerca</label><input id="q" type="search" name="q"><button type="submit">Vai</button></form>',
      '<form action="https://newsletter.example.org/iscrizione" method="post"><input type="email" name="email" autocomplete="email" required><textarea name="note">Scrivi qui</textarea><button type="submit">Iscriviti</button></form>',
      '<picture><source type="image/png" srcset="asset:ehi 1x, asset:ehi 2x"><img src="asset:ehi" srcset="asset:ehi 2x" alt="Ehi"></picture>',
      '<details name="faq"><summary>Domanda</summary><p>Risposta</p></details>',
    ].join("");
    const html = example.replace('<template data-histos="page" data-slug="contatti"', `${icon}<template data-histos="page" data-slug="contatti"`).replace("<p>Scrivimi.</p>", contacts);
    const { report, project, store, profile } = await importPrototype(html);
    try {
      expect(report.counts.components).toBe(2);
      expect(profileUsesTransferMarkupV1(profile)).toBe(true);
      expect(report.forms).toEqual([
        { document: "page contatti", method: "get", action: "/cerca/", external: false },
        { document: "page contatti", method: "post", action: "https://newsletter.example.org/iscrizione", external: true },
      ]);
      expect(report.warnings).toContain("page contatti: il modulo invia i dati (POST) a newsletter.example.org.");
      const iconComponent = store.listComponents().find((component) => component.ref === "ui/icona")!;
      expect(iconComponent.content).toContain('"viewBox":"0 0 24 24"');
      expect(iconComponent.content).toContain('"pathLength":"10"');
      expect(iconComponent.content).not.toContain("xmlns");
      const page = store.getHead(store.listPages().find((item) => item.slug === "contatti")!.id)!;
      const ehi = /\/__cms-media\/[0-9a-f-]{36}\/[0-9a-f-]{36}/u.exec(page.content)?.[0];
      expect(ehi).toBe(`/__cms-media/${project.id}/${/\/__cms-media\/[0-9a-f-]{36}\/([0-9a-f-]{36})/u.exec(page.content)?.[1]}`);
      expect(page.content).toContain(`"srcset":"${ehi} 1x, ${ehi} 2x"`);
      expect(page.content).toContain('"verbatim":true');
    } finally { store.close(); }
  });

  it("il manuale per le AI è quello del file e dice gli stessi tag e modificatori del trasferimento", () => {
    expect(PROTOTYPE_AI_MANUAL).toBe(readFileSync(new URL("../assets/prototipo-ai.md", import.meta.url), "utf8"));
    const tagLine = /### 17\.2 Elementi ammessi oggi\n`([^`]+)`/u.exec(PROTOTYPE_AI_MANUAL)?.[1] ?? "";
    const tags = tagLine.split(/\s+/u).flatMap((tag) => tag === "h1–h6" ? ["h1", "h2", "h3", "h4", "h5", "h6"] : [tag]);
    expect(new Set(tags)).toEqual(new Set(TRANSFER_TAGS));
    const svgLine = /\*\*SVG in linea:\*\* `([^`]+)`/u.exec(PROTOTYPE_AI_MANUAL)?.[1] ?? "";
    expect(svgLine.split(/\s+/u)).toEqual([...TRANSFER_SVG_TAGS]);
    const modifierLine = /\*\*Modificatori:\*\* `([^`]+)`/u.exec(PROTOTYPE_AI_MANUAL)?.[1] ?? "";
    expect(new Set(modifierLine.split(/\s+/u))).toEqual(new Set(TRANSFER_MODIFIERS));
  });
});

describe("design del manifest e formato di trasferimento", () => {
  const withDesign = (design: string) => example.replace('"design": { "primary": "#c83c28" }', `"design": ${design}`);

  it("i ruoli dei colori (role_bg, role_heading, role_link) passano il formato di trasferimento e arrivano al progetto", async () => {
    const html = withDesign('{ "primary": "#c83c28", "role_bg": "neutral-50", "role_heading": "primary-950", "role_link": "primary", "heading_case": "uppercase", "btn_radius": "full" }');
    expect(html).toContain('"role_bg"');
    const { store } = await importPrototype(html);
    try {
      const styles = JSON.parse(store.getHead(store.getStyles()!.id)!.content) as { design?: Record<string, unknown> };
      expect(styles.design).toMatchObject({ role_bg: "neutral-50", role_heading: "primary-950", role_link: "primary", heading_case: "uppercase", btn_radius: "full" });
    } finally { store.close(); }
  });

  it("doc 28: le variabili del sito del manifest arrivano al progetto come variabili del sito, non come un foglio", async () => {
    const html = withDesign('{ "primary": "#c83c28" }, "siteTokens": { "testo-17": "17px", "testo-da-46-a-80": "clamp(46px, 5.4vw, 80px)" }')
      .replace("</head>", '<style data-histos="global" data-name="Misure">h1 { font-size: var(--xb-site-testo-da-46-a-80); } p { font-size: var(--xb-site-testo-17); }</style></head>');
    const { store, report } = await importPrototype(html);
    try {
      const styles = JSON.parse(store.getHead(store.getStyles()!.id)!.content) as { siteTokens?: Record<string, string>; globals?: Array<{ id?: string; css: string }> };
      expect(styles.siteTokens).toEqual({ "testo-17": "17px", "testo-da-46-a-80": "clamp(46px, 5.4vw, 80px)" });
      expect((styles.globals ?? []).some((sheet) => sheet.id === "histos-site-tokens" || sheet.css.includes("--xb-site-testo-17:"))).toBe(false);
      expect(report.warnings.join("\n")).not.toContain("Variabili senza valore");
    } finally { store.close(); }
  });

  it("doc 28: una variabile del sito non valida si ferma alla lettura del manifest, col suo nome", async () => {
    for (const [tokens, message] of [
      ['{ "testo-17": "17px; } body { display: none" }', "Manifest, siteTokens: --xb-site-testo-17: Solo valori CSS semplici: numeri, unità, colori, calc(), clamp(), var()."],
      ['{ "Testo 17": "17px" }', "Manifest, siteTokens: --xb-site-Testo 17: Nome: da 1 a 40 caratteri fra lettere minuscole, cifre e trattini singoli."],
      ['{ "sfondo": "url(https://example.org/x.png)" }', "Manifest, siteTokens: --xb-site-sfondo: Solo valori CSS semplici: numeri, unità, colori, calc(), clamp(), var()."],
    ] as const) {
      await expect(buildPrototypeProfile(parsePrototype(withDesign(`{ "primary": "#c83c28" }, "siteTokens": ${tokens}`)), await newCatalog())).rejects.toThrow(message);
    }
    expect(() => parsePrototype(withDesign('{ "primary": "#c83c28" }, "siteTokens": ["17px"]'))).toThrow(/Manifest: siteTokens/u);
  });

  it("una chiave sconosciuta del design si ferma alla lettura del manifest, col suo nome", async () => {
    const html = withDesign('{ "primary": "#c83c28", "role_sfondo": "neutral-50" }');
    await expect(buildPrototypeProfile(parsePrototype(html), await newCatalog())).rejects.toThrow("Manifest, design: Parametro sconosciuto: role_sfondo (i parametri ammessi sono nel §12 del manuale).");
    await expect(buildPrototypeProfile(parsePrototype(html), await newCatalog())).rejects.not.toThrow(/formato di trasferimento/u);
  });
});
