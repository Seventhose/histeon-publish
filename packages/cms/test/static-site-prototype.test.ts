import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { validateTransferDocument } from "../src/page-transfer.js";
import { staticSiteProjectId, staticSiteToPrototype, type StaticSiteFile } from "../src/static-site-prototype.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newCatalog(): Promise<CmsProjectCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-site-prototype-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  await catalog.initialize();
  return catalog;
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const text = (value: string) => new TextEncoder().encode(value);

function site(): StaticSiteFile[] {
  return [
    {
      path: "index.html",
      bytes: text(`<!doctype html><html lang="it"><head><title>Studio Rossi</title><link rel="stylesheet" href="css/site.css"><link rel="stylesheet" href="https://fonts.example/css?family=X"><style>.hero{color:#123}</style><script>alert(1)</script></head>
<body><header class="top"><nav><a href="chi-siamo/">Chi siamo</a> <a href="/contatti.html#form">Contatti</a> <a href="https://example.org/">Fuori</a> <a href="javascript:alert(1)">X</a> <a href="mailto:info@rossi.example">Scrivici</a></nav></header>
<main><section class="hero" onclick="track()" data-track="x" style="padding:2rem"><h1>Benvenuti {da noi}</h1><p>Prezzi &amp; servizi <custom-tag>dentro</custom-tag></p>
<img src="img/logo.png" alt="Logo" width="120" height="40" loading="lazy"><img src="img/icona.svg" alt=""><img src="https://cdn.example/x.png" alt=""><img src="img/rotto.png" alt="">
<iframe src="https://video.example/"></iframe><form action="/x"><input name="q"></form><p style="background:url(img/logo.png)">Sfondo</p></section></main>
<footer><p>© 2026</p></footer></body></html>`),
    },
    { path: "chi-siamo/index.html", bytes: text('<!doctype html><html><head><title>Chi siamo</title><link rel="stylesheet" href="../css/site.css"></head><body><h1>Chi siamo</h1><p><a href="../index.html">Home</a></p></body></html>') },
    { path: "contatti.html", bytes: text("<!doctype html><html><head><title>Contatti</title></head><body><h1>Contatti</h1></body></html>") },
    { path: "404.html", bytes: text("<!doctype html><html><body>Non trovato</body></html>") },
    { path: "css/site.css", bytes: text('@import url("https://fonts.example/f.css");\n@import "base.css";\n.top{background:url("../img/logo.png") no-repeat}\n@font-face{font-family:F;src:url(../fonts/f.woff2) format("woff2")}\n.x{background:url(https://cdn.example/y.png)}') },
    { path: "css/base.css", bytes: text("body{margin:0}") },
    { path: "img/logo.png", bytes: PNG },
    { path: "img/rotto.png", bytes: text("non è un png") },
    { path: "img/icona.svg", bytes: text("<svg></svg>") },
    { path: "fonts/f.woff2", bytes: Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(16)]) },
    { path: ".histos-publish/manifest.json", bytes: text("{}") },
  ];
}

describe("sito statico → prototipo Histeon (B1)", () => {
  it("diventa un prototipo valido: pagine, link riscritti, media, CSS e niente contenuto attivo", async () => {
    const projectId = staticSiteProjectId("sito-1");
    expect(staticSiteProjectId("sito-1")).toBe(projectId);
    expect(projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    const { html, report } = staticSiteToPrototype({ projectId, name: "Studio Rossi", files: site() });
    expect(report).toMatchObject({ pages: 3, assets: 2, stylesheets: 1 });
    expect(report.notes.join("\n")).toMatch(/<script> tolto|<iframe> tolto/u);
    for (const expected of ["<iframe> tolto", "gestore di eventi portato nel JavaScript della pagina", "link non portabile tolto", "immagine SVG tolta", "immagine di un altro sito tolta", "immagine mancante o in un formato non supportato tolta", "pagina 404 non convertita", "@import esterno tolto", "foglio di stile esterno non convertito", "<custom-tag> sostituito dal suo contenuto", "stile in linea con risorse"]) {
      expect(report.notes.some((note) => note.includes(expected)), expected).toBe(true);
    }
    expect(html).not.toMatch(/<script>alert|onclick|javascript:|<iframe|cdn\.example|fonts\.example/u);

    const parsed = parsePrototype(html);
    expect(parsed.manifest).toMatchObject({ id: projectId, name: "Studio Rossi", framework: "none", locale: "it-IT" });
    expect(parsed.documents.map((document) => document.attributes["data-slug"])).toEqual(["home", "chi-siamo", "contatti"]);
    const home = parsed.documents[0]?.source ?? "";
    expect(home).toContain('href="/chi-siamo/"');
    expect(home).toContain('href="/contatti/#form"');
    expect(home).toContain('href="https://example.org/"');
    expect(home).toContain('href="mailto:info@rossi.example"');
    expect(home).toContain("Benvenuti \\{da noi\\}");
    expect(home).toContain('src="asset:logo"');
    // Doc 18 §6.5: the inline style becomes CSS of the element's own class.
    expect(home).not.toContain("style=");
    expect(home).toMatch(/<section data-histos-js="e[0-9a-f]{12}" class="hero__section hero"/u);
    expect(parsed.documents[1]?.source).toContain('href="/"');
    const css = parsed.globals.map((sheet) => sheet.css).join("\n");
    expect(css).toContain('url("asset:f")');
    expect(css).toContain("body{margin:0}");
    expect(css).not.toContain("cdn.example");
    // B4: class rules become one style per class; a class no page uses is gone.
    expect(parsed.selectors).toContain(".top {");
    expect(parsed.selectors).toContain('url("asset:logo")');
    expect(parsed.selectors).toContain(".hero {");
    expect(parsed.selectors).toMatch(/&__section \{\s*padding: 2rem;/u);
    expect(parsed.selectors).not.toContain(".x {");
    expect(report.notes.some((note) => /nessuna pagina usa tolt[ae]/u.test(note))).toBe(true);

    // The real check and import accept it.
    const built = await buildPrototypeProfile(parsed, await newCatalog());
    const target = await newCatalog();
    const imported = await target.importStaticPageProfile(built.profile, built.files);
    try {
      expect(imported.store.listPages().map((page) => page.slug).sort()).toEqual(["chi-siamo", "contatti", "home"]);
      expect(imported.store.listPages().find((page) => page.slug === "home")?.title).toBe("Studio Rossi");
    } finally {
      imported.store.close();
    }
  });

  it("ricorda i Google Fonts collegati e usa i font scaricati come media (B5)", async () => {
    const files: StaticSiteFile[] = [
      { path: "index.html", bytes: text('<!doctype html><html><head><title>F</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap"></head><body><p class="t">x</p></body></html>') },
    ];
    const first = staticSiteToPrototype({ projectId: staticSiteProjectId("f"), name: "F", files });
    expect(first.googleFonts).toEqual(["https://fonts.googleapis.com/css2?family=Inter&display=swap"]);
    expect(first.report.notes.join("\n")).toContain("Google Fonts collegati: si possono scaricare come media");
    const woff2 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(16)]);
    const second = staticSiteToPrototype({
      projectId: staticSiteProjectId("f"),
      name: "F",
      files: [...files, { path: "histos-fonts/inter-400-normal-latin.woff2", bytes: woff2 }, { path: "histos-fonts/google-fonts.css", bytes: text('@font-face { font-family: "Inter"; src: url("inter-400-normal-latin.woff2") format("woff2"); }') }],
      extraStylesheets: ["histos-fonts/google-fonts.css"],
    });
    const parsed = parsePrototype(second.html);
    expect(parsed.globals[0]?.css).toContain('url("asset:inter-400-normal-latin")');
    expect(second.report.notes.join("\n")).not.toContain("si possono scaricare");
    await buildPrototypeProfile(parsed, await newCatalog());
  });

  it("con Core Framework il prototipo resta senza framework Histeon e l'import lo accetta (doc 18 §6.4.1)", async () => {
    const files: StaticSiteFile[] = [
      { path: "index.html", bytes: text('<!doctype html><html><head><title>C</title><link rel="stylesheet" href="s.css"></head><body><h1 class="titolo">Ciao</h1></body></html>') },
      { path: "s.css", bytes: text(".titolo{color:#c83c28;font-size:23px;margin-block:26px}") },
    ];
    const core = staticSiteToPrototype({ projectId: staticSiteProjectId("core"), name: "C", files, framework: "core" });
    const parsed = parsePrototype(core.html);
    expect(parsed.manifest.framework).toBe("none");
    expect(parsed.manifest.design).toBeUndefined();
    expect(parsed.selectors).toMatch(/font-size:\s?var\(--text-l\)/u);
    expect(parsed.globals.find((sheet) => sheet.name === "Core Framework: variabili usate")?.css).toContain("--space-m: clamp(16px, calc(1.11vw + 12.4px), 28px);");
    const built = await buildPrototypeProfile(parsed, await newCatalog());
    expect(built.profile.entities.some((entity) => entity.kind === "styles")).toBe(true);
  });

  it("con i token (B4) usa la proposta come design del progetto e Histeon CSS", async () => {
    const files: StaticSiteFile[] = [
      { path: "index.html", bytes: text('<!doctype html><html><head><title>T</title><link rel="stylesheet" href="s.css"></head><body><h1 class="titolo">Ciao</h1><p class="testo">x</p></body></html>') },
      { path: "s.css", bytes: text('body{font-family:"Inter",sans-serif}h1{font-family:Georgia,serif}.titolo{color:#c83c28;font-size:52px}.testo{color:#c83c28;border-color:#1a5fb4}') },
    ];
    const plain = staticSiteToPrototype({ projectId: staticSiteProjectId("t"), name: "T", files });
    expect(plain.tokens).toBe(false);
    expect(plain.design).toEqual({ primary: "#c83c28", secondary: "#1a5fb4", font_body: '"Inter",sans-serif', font_heading: "Georgia,serif" });
    expect(parsePrototype(plain.html).manifest).toMatchObject({ framework: "none" });
    expect(plain.html).not.toContain("var(--xb-");

    const tokenized = staticSiteToPrototype({ projectId: staticSiteProjectId("t"), name: "T", files, tokens: true });
    const parsed = parsePrototype(tokenized.html);
    expect(parsed.manifest).toMatchObject({ framework: "histos-css", design: plain.design });
    expect(parsed.selectors).toMatch(/color:\s?var\(--xb-primary\)/u);
    expect(parsed.selectors).toMatch(/font-size:\s?var\(--xb-text-4xl\)/u);
    const built = await buildPrototypeProfile(parsed, await newCatalog());
    const imported = await (await newCatalog()).importStaticPageProfile(built.profile, built.files);
    try {
      const stylesId = imported.store.getStyles()?.id ?? "";
      const styles = JSON.parse(imported.store.getHead(stylesId)?.content ?? "{}") as { design?: Record<string, unknown> };
      expect(styles.design).toMatchObject({ primary: expect.stringContaining("oklch"), font_body: '"Inter",sans-serif' });
    } finally {
      imported.store.close();
    }
  });

  it("vuole una index.html e rifiuta un prototipo oltre il limite", () => {
    expect(() => staticSiteToPrototype({ projectId: staticSiteProjectId("x"), name: "X", files: [{ path: "a.html", bytes: text("<p>x</p>") }] })).toThrow(/index\.html/u);
    // One media over 15 MB is dropped (the importer would refuse it); many big ones exceed the prototype's limit.
    const huge = Buffer.concat([PNG, Buffer.alloc(16 * 1024 * 1024)]);
    const one = staticSiteToPrototype({ projectId: staticSiteProjectId("x"), name: "X", files: [{ path: "index.html", bytes: text('<img src="a.png" alt="">') }, { path: "a.png", bytes: huge }] });
    expect(one.report.assets).toBe(0);
    expect(one.report.notes.join("\n")).toContain("media oltre 15 MB tolto");
    const big = (index: number) => ({ path: `${index}.png`, bytes: Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024, index)]) });
    expect(() => staticSiteToPrototype({ projectId: staticSiteProjectId("x"), name: "X", files: [{ path: "index.html", bytes: text('<img src="1.png" alt=""><img src="2.png" alt=""><img src="3.png" alt="">') }, big(1), big(2), big(3)] })).toThrow(RangeError);
  });
});

describe("conversione di siti ostili o disordinati (review B1)", () => {
  const convert = (files: StaticSiteFile[]) => staticSiteToPrototype({ projectId: staticSiteProjectId("ostile"), name: "Ostile", files });
  const page = (body: string, head = "") => ({ path: "index.html", bytes: text(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`) });
  const importable = async (html: string) => {
    const parsed = parsePrototype(html);
    await buildPrototypeProfile(parsed, await newCatalog());
    return parsed;
  };

  it("non si blocca su url( senza fine né su @import a catena", () => {
    const started = Date.now();
    convert([page("<p>x</p>", `<style>.a{background:url(${" ".repeat(20_000)}}</style>`)]);
    convert([page("<p>x</p>", `<style>.a{b:${"url(".repeat(50_000)}}</style>`)]);
    // Five sheets, each importing the next 60 times: every file is inlined once per sheet.
    const chain: StaticSiteFile[] = [0, 1, 2, 3, 4].map((index) => ({ path: `c${index}.css`, bytes: text(`${`@import "c${index + 1}.css";\n`.repeat(60)}.c${index}{color:red}`) }));
    const result = convert([page('<p class="c0 c4">x</p>', '<link rel="stylesheet" href="c0.css">'), ...chain]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.report.notes.join("\n")).toContain("@import ripetuto tolto");
  });

  it("non cade su un % nei percorsi", () => {
    const result = convert([page('<a href="100%.html">Cento</a> <a href="caf%E9.html">Caffè</a> <img src="a%zz.png" alt=""> <a href="caf%C3%A9.html">Ok</a>'), { path: "café.html", bytes: text("<p>c</p>") }]);
    expect(result.html).toContain('href="/cafe/"');
    expect(result.report.notes.join("\n")).toContain("link non portabile tolto");
  });

  it("legge gli @import come regole: Google Fonts con ;, forma compatta, tra virgolette, nei commenti", async () => {
    const result = convert([
      page('<p class="a b c">x</p>', `<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');@import"base.css";@import 'more.css' screen;/* do not use @import here */ .a{color:red;margin:0} body{padding:0}</style>`),
      { path: "base.css", bytes: text(".b{color:blue}") },
      { path: "more.css", bytes: text(".c{color:green}") },
    ]);
    expect(result.googleFonts).toEqual(["https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap"]);
    const parsed = await importable(result.html);
    const css = [...parsed.globals.map((sheet) => sheet.css), parsed.selectors].join("\n");
    expect(css).toMatch(/padding:\s*0/u);
    expect(css).toMatch(/color:\s*blue/u);
    expect(css).toMatch(/@media screen[\s\S]*color:\s*green/u);
    expect(css).not.toMatch(/@import|\/\*/u);
  });

  it("non lascia passare risorse esterne scritte con escape, image-set o virgolette", async () => {
    const result = convert([page('<p class="a b c">x</p>', `<style>@\\69mport "https://t.example/d.css"; .a{background:u\\72l(https://t.example/a.png)} .b{background-image:image-set("https://t.example/b.png" 1x)} .c{background:url("https://t.example/c.png?'")}</style>`)]);
    expect(result.html).not.toContain("t.example");
    await importable(result.html);
  });

  it("toglie le regole @ con escape anche dopo il nome, e l'importer le rifiuta comunque (review B1, 2° giro)", async () => {
    for (const rule of ['@im\\70ort "https://evil.example/x.css";', '@impor\\74 "https://evil.example/x.css";', '@IM\\50ORT "https://evil.example/x.css";']) {
      const result = convert([page('<p class="a">x</p>', `<style>${rule} body{margin:0} .a{color:red}</style>`)]);
      expect(result.html, rule).not.toContain("evil.example");
      expect(result.report.notes.join("\n")).toContain("regola @ scritta con escape tolta");
      await importable(result.html);
    }
    const crafted = staticSiteToPrototype({ projectId: staticSiteProjectId("x"), name: "X", files: [page("<p>x</p>")] }).html
      .replace("</head>", '<style data-histos="global" data-name="Furbo">@im\\70ort "https://evil.example/x.css";</style></head>');
    await expect(importable(crafted)).rejects.toThrow(/scritte con escape/u);
  });

  it("non passa a parse5 pagine annidate senza fine e non legge più di 8 MB di CSS", () => {
    const deep = `${"<div>".repeat(100_000)}x${"</div>".repeat(100_000)}`;
    let started = Date.now();
    const result = convert([page('<p><a href="profonda.html">giù</a></p>'), { path: "profonda.html", bytes: text(deep) }]);
    // Minutes before the check; the bounds leave room for a loaded machine.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.report.pages).toBe(1);
    expect(result.report.notes.join("\n")).toContain("annidato oltre 1000 livelli non convertita: profonda.html");
    // The link to the page left out goes too.
    expect(result.html).not.toContain("/profonda/");
    expect(() => convert([{ path: "index.html", bytes: text(deep) }])).toThrow(/home \(index\.html\) ha markup annidato/u);
    // Unclosed "<a" by the thousand: the estimate stays linear.
    started = Date.now();
    convert([page(`<p>${"<a".repeat(200_000)}</p>`)]);
    expect(Date.now() - started).toBeLessThan(10_000);

    started = Date.now();
    const sheets = Array.from({ length: 6 }, (_, index) => ({ path: `s${index}.css`, bytes: text(`${".morta{color:red;margin:0}\n".repeat(70_000)}/* ${index} */`) }));
    const heavy = convert([page('<p class="viva">x</p>', sheets.map((sheet) => `<link rel="stylesheet" href="${sheet.path}">`).join("")), ...sheets]);
    // About 5 s alone; with the whole suite running beside it, 20 s was reached (2 November 2026).
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(heavy.report.notes.join("\n")).toContain("oltre 8 MB di CSS in tutto non convertito");
  }, 60_000);

  it("produce un prototipo che l'importer accetta anche per siti grandi e disordinati", async () => {
    const images: StaticSiteFile[] = Array.from({ length: 510 }, (_, index) => ({ path: `img/${index}.png`, bytes: Buffer.concat([PNG, Buffer.from(String(index))]) }));
    const deep = `${"<div>".repeat(200)}profondo${"</div>".repeat(200)}`;
    // Both cut to the same 63 characters, with a hyphen at the 58th: the second gets "-2", not "--2".
    const longName = `${"a".repeat(57)}-bbbbbbbbbb`;
    const result = convert([
      page(`${images.map((_, index) => `<img src="img/${index}.png" alt="">`).join("")}<p><a href="https://ex.org/?q={x}">Cerca</a> <abbr title="{x}">X</abbr> <time datetime="{d}">oggi</time></p>${deep}`),
      ...images,
      { path: `${longName}-uno.html`, bytes: text("<p>uno</p>") },
      { path: `${longName}-due.html`, bytes: text("<p>due</p>") },
    ]);
    expect(result.report.assets).toBe(500);
    expect(result.html).toContain("https://ex.org/?q=%7Bx%7D");
    const notes = result.report.notes.join("\n");
    expect(notes).toContain("media oltre i primi 500 tolto");
    expect(notes).toContain("markup annidato oltre 100 livelli ridotto al suo testo");
    expect(notes).toContain("graffe in un attributo sostituite con parentesi");
    const parsed = await importable(result.html);
    const slugs = parsed.documents.map((document) => String(document.attributes["data-slug"]));
    expect(slugs).toContain(`${"a".repeat(57)}-2`);
    expect(slugs.every((slug) => !slug.includes("--"))).toBe(true);
  });

  it("un sito con Automatic.css tiene le regole di ACSS come foglio di compatibilità e il rapporto lo dice (C2)", async () => {
    const acss = ":root{--primary:#c83c28;--primary-dark:#7a2418;--space-m:1.5rem;--section-space-l:6rem;--radius-m:.5rem}\n.text--l{font-size:1.4rem}.btn--primary{background:var(--primary);border-radius:var(--radius-m)}.bg--primary-dark{background:var(--primary-dark)}";
    const files: StaticSiteFile[] = [
      { path: "index.html", bytes: text('<!doctype html><html lang="it"><head><title>Acss</title><link rel="stylesheet" href="wp-content/uploads/automatic-css/automatic.css"></head><body><main><h1 class="text--l">Ciao</h1><a class="btn--primary" href="/x/">Vai</a><p class="pad--m card--featured">Senza regola</p></main></body></html>') },
      { path: "wp-content/uploads/automatic-css/automatic.css", bytes: text(acss) },
    ];
    const { html, report } = staticSiteToPrototype({ projectId: staticSiteProjectId("acss"), name: "Acss", files });
    const notes = report.notes.join("\n");
    expect(notes).toMatch(/Automatic\.css: 2 classi restano con la regola dei fogli del sito, che fanno da foglio di compatibilità \(btn--primary, text--l\); in Histeon CSS hanno un nome: text--l → xb-text-l/u);
    // A BEM modifier of the site's own block is not ACSS.
    expect(notes).toMatch(/Automatic\.css: una classe usata non ha una regola nei fogli del sito, forse il foglio di ACSS non è stato scaricato \(pad--m\)/u);
    // Nothing renamed: the site looks the same.
    expect(html).toContain('class="text--l"');
    expect(html).not.toContain("bg--primary-dark{");
    // The import reads the same names without a warning: they have their values and rules.
    const built = await buildPrototypeProfile(parsePrototype(html), await newCatalog());
    expect(built.report.warnings.join("\n")).not.toMatch(/Variabili senza valore|Classi ACSS senza regola: (?:btn|text)/u);
  });

  it("una classe ACSS che i fogli del sito nominano solo in un contesto, con uno stato o in :not() non ha una regola sua (C2)", () => {
    const acss = ":root{--primary:#c83c28;--primary-dark:#7a2418;--space-m:1.5rem;--section-space-l:6rem;--radius-m:.5rem}\n.text--l{font-size:1.4rem}.hero .btn--primary{font-weight:700}.link--primary:hover{color:red}main:not(.bg--primary-dark){margin:0}";
    const files: StaticSiteFile[] = [
      { path: "index.html", bytes: text('<!doctype html><html lang="it"><head><title>Acss</title><link rel="stylesheet" href="wp-content/uploads/automatic-css/automatic.css"></head><body><main class="hero"><h1 class="text--l">Ciao</h1><a class="btn--primary link--primary" href="/x/">Vai</a><p class="bg--primary-dark">Fondo</p></main></body></html>') },
      { path: "wp-content/uploads/automatic-css/automatic.css", bytes: text(acss) },
    ];
    const notes = staticSiteToPrototype({ projectId: staticSiteProjectId("acss-contesto"), name: "Acss", files }).report.notes.join("\n");
    // Before: any class a selector named counted as kept with the site's rule, and ACSS's missing sheet went unsaid.
    expect(notes).toMatch(/Automatic\.css: una classe resta con la regola dei fogli del sito, che fanno da foglio di compatibilità \(text--l\)/u);
    expect(notes).toMatch(/Automatic\.css: 3 classi usate non hanno una regola nei fogli del sito, forse il foglio di ACSS non è stato scaricato \(bg--primary-dark, btn--primary, link--primary\)/u);
  });

  it("i fogli del sito si leggono come il browser: [class~=…], un errore che tollera, una regola che scarta (C2)", () => {
    const notesFor = (css: string) => {
      const files: StaticSiteFile[] = [
        { path: "index.html", bytes: text('<!doctype html><html lang="it"><head><title>Acss</title><link rel="stylesheet" href="css/site.css"></head><body><main><h1 class="text--l">Ciao</h1><a class="btn--primary" href="/x/">Vai</a></main></body></html>') },
        { path: "css/site.css", bytes: text(css) },
      ];
      return staticSiteToPrototype({ projectId: staticSiteProjectId("acss-browser"), name: "Acss", files }).report.notes.join("\n");
    };
    // [class~="x"] is .x (before: attribute selectors named nothing, and btn--primary had "no rule").
    expect(notesFor('.text--l{font-size:1.4rem}\n[class~="btn--primary"]{background:red}')).toMatch(/Automatic\.css: 2 classi restano con la regola dei fogli del sito, che fanno da foglio di compatibilità \(btn--primary, text--l\)/u);
    // A string a newline ends: for the browser .btn--primary is a rule, for postcss part of the string (before: "no rule").
    const slip = notesFor('.text--l{font-size:1.4rem}\nmain{content:"x\n}\n.btn--primary{background:red}\n"}');
    expect(slip).toMatch(/Automatic\.css: 2 classi restano con la regola dei fogli del sito/u);
    expect(slip).toMatch(/Automatic\.css: CSS che la conversione non legge come il browser \(foglio css\/site\.css, riga \d+: una stringa va a capo senza chiudersi\): le classi che vi compaiono contano come regolate/u);
    expect(slip).not.toMatch(/non hanno una regola|non ha una regola/u);
    // A stray ";" after a rule the site's sheet keeps: the browser drops the next rule, so btn--primary has none (before: it had one).
    expect(notesFor('[class~="text--l"]{font-size:1.4rem};\n[class~="btn--primary"]{background:red}')).toMatch(/Automatic\.css: una classe usata non ha una regola nei fogli del sito, forse il foglio di ACSS non è stato scaricato \(btn--primary\)/u);
  });
});

describe("markup completo (doc 18 F2)", () => {
  it("un colore di un SVG scritto con un ripiego resta: la variabile se il sito la dichiara, altrimenti il ripiego", async () => {
    const page = `<!doctype html><html lang="it"><head><style>:root{--oro:#c49a3c}</style></head><body>
<svg viewBox="0 0 10 10" width="10"><g fill="var(--oro, #111111)"><path d="M0 0h4v4z"/></g><circle cx="5" cy="5" r="4" stroke="var(--assente, #c83c28)" fill="var(--assente, var(--oro, red))"/>
<rect width="2" height="2" fill="var(--assente, var(--altra))"/><path d="M1 1h2" stroke="var(--assente, url(javascript:x))"/></svg>
</body></html>`;
    const converted = staticSiteToPrototype({ projectId: "2d4c9b1a-0f3e-4a5b-8c7d-6e5f4a3b2c1d", name: "Ripiego", files: [{ path: "index.html", bytes: text(page) }] });
    const html = converted.html;
    expect(html).toContain('<g fill="var(--oro)">');
    expect(html).toContain('stroke="#c83c28"');
    expect(html).toMatch(/<circle [^>]*fill="var\(--oro\)"/u);
    // Neither the variable nor a fallback the import accepts: the attribute goes, as before, and the report says so.
    expect(html).toContain('<rect width="2" height="2"></rect>');
    expect(html).toContain('<path d="M1 1h2"></path>');
    expect(html).not.toContain("javascript");
    expect(converted.report.notes.some((item) => item.includes("attributo fill di <rect> tolto"))).toBe(true);
    expect(converted.report.notes.some((item) => item.includes("attributo stroke di <path> tolto"))).toBe(true);
    await buildPrototypeProfile(parsePrototype(html), await newCatalog());
  });

  it("tiene moduli, pulsanti, details, picture e SVG statico con le regole dell'import; toglie ciò che non passa", async () => {
    const page = `<!doctype html><html lang="it"><body>
<form class="contatti"><label for="n">Nome</label><input id="n" name="nome" required><input type="password" name="pw"><input type="file" name="f">
<select name="q"><option value="a">A</option></select><textarea name="t">Ciao</textarea><button type="submit" onclick="x()">Invia</button>
<form action="/altro" method="post"><input name="dentro"></form></form>
<details open><summary>Domanda</summary><p>Risposta</p></details>
<picture><source srcset="img/a.png 1x" type="image/png"><img src="img/a.png" alt="A" width="10" height="10"></picture>
<picture><source srcset="https://cdn.example/x.avif" type="image/avif"><img src="https://cdn.example/x.jpg" alt=""></picture>
<svg viewBox="0 0 10 10" width="10" xmlns="http://www.w3.org/2000/svg"><title>Logo</title><defs><linearGradient id="g"></linearGradient></defs><circle cx="5" cy="5" r="4" fill="red" onclick="y()"/><use href="#z"/></svg>
</body></html>`;
    const converted = staticSiteToPrototype({ projectId: "2d4c9b1a-0f3e-4a5b-8c7d-6e5f4a3b2c1d", name: "F2", files: [{ path: "index.html", bytes: text(page) }, { path: "img/a.png", bytes: PNG }] });
    const html = converted.html;
    expect(html).toMatch(/<form class="contatti" method="get" action="\/">/u);
    expect(html).toContain('<input id="n" name="nome" required="">');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="file"');
    expect(html).toContain('<select name="q"><option value="a">A</option></select>');
    // Doc 18 §6.6: an on* attribute becomes a listener in the page's JavaScript, found by a mark.
    expect(html).toMatch(/<button data-histos-js="e[0-9a-f]{12}" type="submit">Invia<\/button>/u);
    expect(html).not.toMatch(/ onclick=/u);
    expect(html).not.toContain('action="/altro"');
    expect(html).toContain('<input name="dentro">');
    expect(html).toContain("<details open=\"\"><summary>Domanda</summary>");
    expect(html).toMatch(/<picture><source srcset="asset:[a-z0-9-]+ 1x" type="image\/png"><img src="asset:/u);
    expect(html).not.toContain("cdn.example");
    expect(html).toMatch(/<svg viewBox="0 0 10 10" width="10"><title>Logo<\/title><defs><linearGradient id="g"><\/linearGradient><\/defs><circle (?:data-histos-js="e[0-9a-f]{12}" )?cx="5" cy="5" r="4" fill="red"><\/circle><\/svg>/u);
    // A form inside a form never reaches the conversion: the HTML parser drops the inner <form> tag itself.
    for (const note of ["campo di tipo password tolto", "campo di tipo file tolto", "<use> di un SVG tolto"]) {
      expect(converted.report.notes.some((item) => item.includes(note)), note).toBe(true);
    }
    await buildPrototypeProfile(parsePrototype(html), await newCatalog());
  });
});

describe("elementi in linea selezionabili (doc 18 §6.3)", () => {
  it("dà una classe ai link e agli span che il CSS stila o che non stanno in una frase; quelli di una frase restano nel testo", () => {
    const page = `<!doctype html><html lang="it"><head><style>a{color:red}.hero h1{font-size:3rem}.hero h1 em{color:red}.prezzo span{font-weight:700}.nav a[aria-current]{text-decoration:underline}</style></head><body>
<section class="hero"><h1>Pane <em>buono</em></h1><p>Fatto <strong>a mano</strong>, ogni <a href="#x">giorno</a>.</p></section>
<p class="prezzo"><span>4,50</span> € al kg</p>
<nav class="nav"><a href="/" aria-current="page">Home</a> <a href="#chi">Chi siamo</a></nav></body></html>`;
    const html = staticSiteToPrototype({ projectId: "5b3a1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name: "Inline", files: [{ path: "index.html", bytes: text(page) }] }).html;
    expect(html).toContain('<h1 class="hero__h1">Pane <em class="hero__em">buono</em></h1>');
    expect(html).toContain('<span class="prezzo__text">4,50</span>');
    expect(html).toContain('<a href="/" aria-current="page" class="nav__link">Home</a>');
    expect(html).toContain('<a href="#chi" class="nav__link">Chi siamo</a>');
    // In a sentence and styled by no rule of their own (`a { color }` styles every link): they stay part of the text.
    expect(html).toContain("Fatto <strong>a mano</strong>, ogni <a href=\"#x\">giorno</a>.");
  });

  it("un nome nuovo non prende una classe che il CSS del sito usa già per un altro elemento", () => {
    // `.piede__link` is the list: a link of the footer named `piede__link` would become a flex container too.
    const page = `<!doctype html><html lang="it"><head><style>.piede__link{display:flex;gap:1em}.piede__link a{color:red}.piede__colonna a{color:blue}</style></head><body>
<footer class="piede"><div class="piede__colonna"><ul><li><a href="#a">Uno</a></li></ul></div><ul class="piede__link"><li><a href="#b">Due</a></li></ul></footer></body></html>`;
    const html = staticSiteToPrototype({ projectId: "5b3a1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name: "Nomi", files: [{ path: "index.html", bytes: text(page) }] }).html;
    expect(html).toContain('<a href="#a" class="piede__link-2">Uno</a>');
    expect(html).toContain('<a href="#b" class="piede__link-2">Due</a>');
    expect(html).toContain('<ul class="piede__link">');
    expect(html).not.toContain('<a href="#a" class="piede__link">');
  });
});

describe("immagini e attributi data (doc 18 F2)", () => {
  it("dà le misure dal file alle immagini che non le hanno, aggiunge alt vuoto, tiene data-* salvo quelli dei framework di script", () => {
    const page = '<!doctype html><html><body><div class="tab" data-state="open" data-hx-get="/x" data-bind-text="y"><img src="img/a.png"></div></body></html>';
    const converted = staticSiteToPrototype({ projectId: "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d", name: "Img", files: [{ path: "index.html", bytes: text(page) }, { path: "img/a.png", bytes: PNG }] });
    expect(converted.html).toContain('<div class="tab" data-state="open"><img src="asset:a" width="1" height="1" data-histos-sized="width height" alt=""></div>');
    expect(converted.report.notes.join("\n")).toContain("immagine senza testo alternativo");
  });

  it("toglie, con una nota, i data-* che il trasferimento rifiuta perché librerie li leggono come codice (doc 23, voce 172)", () => {
    const page = '<!doctype html><html><body><div class="tab" data-state="open" data-text="$x" data-dojo-props="a:1" data-bs-parent="#f"><a href="/x" data-method="delete">X</a></div></body></html>';
    const converted = staticSiteToPrototype({ projectId: "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d", name: "Data", files: [{ path: "index.html", bytes: text(page) }] });
    expect(converted.html).toContain('<div class="tab" data-state="open" data-bs-parent="#f">');
    expect(converted.html).not.toMatch(/data-(?:text|dojo-props|method)=/u);
    expect(converted.report.notes).toEqual(expect.arrayContaining(["attributo data-text tolto", "attributo data-dojo-props tolto", "attributo data-method tolto"]));
  });
});

describe("fogli di stile di altri siti (doc 18 §6.2)", () => {
  it("chiede il CSS di un CDN, poi lo legge con i suoi font, risolti sul suo indirizzo", () => {
    const page = '<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.org/kit/style.css"></head><body><p class="kit">Ciao</p></body></html>';
    const input = { projectId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", name: "Cdn", files: [{ path: "index.html", bytes: text(page) }] };
    const first = staticSiteToPrototype(input);
    expect(first.remoteMedia).toEqual(["https://cdn.example.org/kit/style.css"]);
    const css = '@font-face{font-family:Kit;src:url(fonts/kit.woff2) format("woff2")}.kit{font-family:Kit;color:#123456}.unused{color:red}';
    const second = staticSiteToPrototype({ ...input, remoteMedia: new Map([["https://cdn.example.org/kit/style.css", text(css)]]) });
    expect(second.remoteMedia).toEqual(["https://cdn.example.org/kit/fonts/kit.woff2"]);
    expect(second.html).toContain("#123456");
    expect(second.html).not.toContain(".unused");
  });
});

describe("JavaScript del sito nella sezione JS delle pagine (doc 18 §6.6, F4)", () => {
  const page = `<!doctype html><html lang="it"><head><title>J</title><script src="https://cdn.example/lib.js"></script><script type="application/ld+json">{"@type":"Thing"}</script></head><body>
<button class="apri" onclick="apri(); return false">Apri</button>
<dialog id="d" class="finestra"><p>Ciao</p><button class="chiudi">Chiudi</button></dialog>
<div role="tabpanel" hidden tabindex="0">Nascosto</div>
<script src="js/sito.js"></script><script>function apri() { document.getElementById("d").showModal(); }</script>
</body></html>`;
  const files = (): StaticSiteFile[] => [{ path: "index.html", bytes: text(page) }, { path: "js/sito.js", bytes: text("window.sito = '</script><!--';") }];

  it("tiene gli script in ordine, porta on* in addEventListener, tiene il dialog nascosto con i suoi metodi", () => {
    const first = staticSiteToPrototype({ projectId: staticSiteProjectId("js"), name: "J", files: files() });
    expect(first.remoteMedia).toContain("https://cdn.example/lib.js");
    const converted = staticSiteToPrototype({ projectId: staticSiteProjectId("js"), name: "J", files: files(), remoteMedia: new Map([["https://cdn.example/lib.js", text("window.lib = 1;")]]) });
    const parsed = parsePrototype(converted.html);
    const script = parsed.scripts?.pages.home ?? "";
    // The dialog methods first, then the site's scripts in their order, then the handlers.
    const order = ["dialog.showModal = function", "window.lib = 1;", "window.sito = '</script><!--';", "function apri()", "addEventListener(\"click\""].map((piece) => script.indexOf(piece));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(script).not.toContain("@type");
    // The JSON part never closes its element early.
    expect(converted.html).not.toMatch(/<\/script><!--/u.source);
    const home = parsed.documents[0]?.source ?? "";
    expect(home).toMatch(/<button data-histos-js="(e[0-9a-f]{12})" class="apri">Apri<\/button>/u);
    expect(home).toMatch(/<div id="d" class="finestra" role="dialog" hidden="" data-histos-dialog="">/u);
    expect(home).toContain('<div role="tabpanel" hidden="" tabindex="0">Nascosto</div>');
    expect(converted.report.notes.join("\n")).toMatch(/script di tipo application\/ld\+json tolto/u);
    expect(converted.report.notes.join("\n")).toMatch(/5 script tenuti nella sezione JS delle pagine/u);
  });

  it("il prototipo porta gli script nel profilo con la loro capacità; chiavi sconosciute e testi troppo lunghi si fermano", async () => {
    const converted = staticSiteToPrototype({ projectId: staticSiteProjectId("js3"), name: "J", files: [{ path: "index.html", bytes: text('<!doctype html><html><head><title>J</title></head><body><p>x</p><script>window.uno = 1;</script></body></html>') }] });
    const built = await buildPrototypeProfile(parsePrototype(converted.html), await newCatalog());
    expect(built.profile.manifest.requiredCapabilities).toContain("documents:script:v1");
    expect(built.profile.entities.find((entity) => entity.kind === "document")?.payload.script).toContain("window.uno = 1;");
    expect(built.report.warnings.join("\n")).toMatch(/JavaScript: gira nel sito pubblicato e nell'anteprima isolata, mai nel builder/u);
    const withScripts = (json: string) => converted.html.replace(/<script data-histos="scripts" type="application\/json">[^<]*<\/script>/u, `<script data-histos="scripts" type="application/json">${json}</script>`);
    expect(() => parsePrototype(withScripts('{"pages":{"altra":"x"}}'))).toThrow(/pagina «?altra»? non c'è nel prototipo/u);
    expect(() => parsePrototype(withScripts('{"parti":{}}'))).toThrow(/sezione sconosciuta/u);
    expect(() => parsePrototype(withScripts(`{"pages":{"home":"${"x".repeat(100_001)}"}}`))).toThrow(/supera 100 kB/u);
  });

  it("toglie ciò che supera il limite di WordPress per documento, con una nota", () => {
    const big = `window.grande = "${"x".repeat(100_001)}";`;
    const converted = staticSiteToPrototype({ projectId: staticSiteProjectId("js2"), name: "J", files: [{ path: "index.html", bytes: text(`<!doctype html><html><head><title>J</title></head><body><p>x</p><script>${big}</script><script>window.piccolo = 1;</script></body></html>`) }] });
    const script = parsePrototype(converted.html).scripts?.pages.home ?? "";
    expect(script).toContain("window.piccolo = 1;");
    expect(script).not.toContain("window.grande");
    expect(converted.report.notes.join("\n")).toMatch(/script oltre 100 kB per pagina tolto/u);
  });
});


describe("regole sulle classi di <body> e <html> (V5.3a)", () => {
  const page = (bodyClass: string, heading: string) => text(`<!doctype html><html lang="it" class="js"><head><title>${heading}</title><link rel="stylesheet" href="tema.css"></head>
<body class="${bodyClass}"><header class="menu"><a href="/">Bottega</a></header><main><h1>${heading}</h1><p class="bottone">Scopri</p></main></body></html>`);
  const files = (): StaticSiteFile[] => [
    { path: "index.html", bytes: page("tema-base pagina-1", "Corsi") },
    { path: "chi-siamo.html", bytes: page("tema-base pagina-2", "Chi siamo") },
    { path: "tema.css", bytes: text(".tema-base{--marchio:#0a7d4f;color:#333;font-family:Georgia,serif}\n.tema-base .bottone{background:var(--marchio)}\nbody.tema-base h1,.altro h1{color:var(--marchio)}\n.pagina-1 h1{color:red}\n.js .menu{display:flex}\n.tema-base:not(.scuro) p{line-height:1.5}") },
  ];

  it("riscrive su body e html le regole delle classi che ogni pagina ha, così le variabili e i colori restano", async () => {
    const converted = staticSiteToPrototype({ projectId: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c40", name: "Classi del body", files: files(), framework: "none" });
    const { html, report } = converted;
    expect(html).toContain("body{--marchio:#0a7d4f;color:#333;font-family:Georgia,serif}");
    expect(html).toMatch(/body \.bottone\s*\{\s*background:var\(--marchio\)/u);
    expect(html).toContain("body h1");
    expect(html).toContain("html .menu");
    expect(html).toContain("body:not(.scuro) p");
    // A class of one page only would apply to every page once written on body: an element of that page takes it.
    expect(html).toContain(":where(body):has(.pagina-1) h1{color:red}");
    expect(html).not.toMatch(/\.tema-base|\.js\b/u);
    expect(report.notes.some((note) => /regole scritte sulle classi di <body> o <html> riscritte su body e html/u.test(note))).toBe(true);
    const built = await buildPrototypeProfile(parsePrototype(html), await newCatalog());
    expect(built.report.warnings.join("\n")).not.toMatch(/--marchio/u);
  });

  it("una classe che il body ha solo in alcune pagine passa a un elemento di quelle pagine, e le sue regole scelgono la pagina con :has()", async () => {
    const view = (bodyClass: string, heading: string, main = "main") => text(`<!doctype html><html lang="it"><head><title>${heading}</title><link rel="stylesheet" href="viste.css"></head>
<body class="${bodyClass}"><header class="testata"><a href="/">Bottega</a></header><${main} class="corpo"><h1>${heading}</h1><p class="foglio entra dentro">Testo</p></${main}><footer class="piede">Fine</footer></body></html>`);
    const css = ".foglio{transform:rotate(2deg)}\n.con-entrate .entra{opacity:0}\n.con-entrate .entra.dentro{opacity:1;transform:none}\n.vista-scheda{background:#eee}\nbody.vista-scheda .piede{padding-bottom:80px}\n@media (max-width:600px){.vista-scheda.con-entrate > .testata{display:none}}\n.vista-elenco:not(.scura) h1{color:red}\n.mai-usata h1{color:blue}";
    const { html, report } = staticSiteToPrototype({ projectId: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c43", name: "Viste", framework: "none", files: [
      { path: "index.html", bytes: view("vista-home con-entrate senza-regole", "Home") },
      { path: "scheda.html", bytes: view("vista-scheda con-entrate", "Scheda") },
      { path: "elenco.html", bytes: view("vista-elenco", "Elenco", "div") },
      { path: "viste.css", bytes: text(css) },
    ] });
    // Each rule keeps its weight: a class for the class, the tag where the site wrote the tag.
    expect(html).toContain(":where(body):has(.con-entrate) .entra{opacity:0}");
    expect(html).toContain(":where(body):has(.con-entrate) .entra.dentro{opacity:1;transform:none}");
    expect(html).toContain(":where(body):has(.vista-scheda){background:#eee}");
    expect(html).toContain("body:has(.vista-scheda) .piede{padding-bottom:80px}");
    expect(html).toContain(":where(body):has(.vista-scheda.con-entrate) > .testata{display:none}");
    expect(html).toContain(":where(body):has(.vista-elenco):not(.scura) h1{color:red}");
    expect(html).not.toMatch(/mai-usata|color:blue/u);
    // The mark is the page's <main>, else its first element that is not header, navigation or footer. It takes only
    // the classes a rule names; the header stays the same on every page.
    const pageOf = (slug: string) => new RegExp(`<template data-histos="page" data-slug="${slug}"[^>]*>([\\s\\S]*?)</template>`, "u").exec(html)?.[1] ?? "";
    expect(pageOf("home")).toContain('<main class="corpo con-entrate">');
    expect(pageOf("scheda")).toContain('<main class="corpo vista-scheda con-entrate">');
    expect(pageOf("elenco")).toContain('<div class="corpo vista-elenco">');
    for (const slug of ["home", "scheda", "elenco"]) expect(pageOf(slug)).toMatch(/^\s*<header class="testata">/u);
    expect(html).not.toMatch(/vista-home|senza-regole/u);
    expect(report.notes.some((note) => /3 classi che il <body> ha solo in alcune pagine sono passate a un elemento di quelle pagine \(con-entrate, vista-elenco, vista-scheda\): le loro regole scelgono la pagina con :has\(\)/u.test(note))).toBe(true);
    const built = await buildPrototypeProfile(parsePrototype(html), await newCatalog());
    expect(JSON.stringify(built.profile.entities.find((entity) => entity.kind === "styles")?.payload)).toContain(":where(body):has(.vista-scheda.con-entrate) > .testata");
    expect(built.report.warnings.join("\n")).not.toMatch(/:has|vista-|con-entrate/u);
  });

  it("una classe che ogni html ha vale su ogni pagina anche se solo qualche body la ripete", () => {
    const view = (bodyClass: string) => text(`<!doctype html><html class="chiaro"><head><style>.chiaro .testo{color:#123456}</style></head><body class="${bodyClass}"><main><p class="testo">Uno</p></main></body></html>`);
    const { html } = staticSiteToPrototype({ projectId: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c44", name: "Radici", framework: "none", files: [{ path: "index.html", bytes: view("chiaro") }, { path: "altra.html", bytes: view("") }] });
    expect(html).toMatch(/html \.testo\s*\{\s*color:#123456/u);
    expect(html).not.toContain(":has(");
  });

  it("lascia classe una classe del body che anche un elemento della pagina usa", () => {
    const own = text('<!doctype html><html><head><style>.scheda{--x:1px;border:var(--x) solid}</style></head><body class="scheda"><div class="scheda">Uno</div></body></html>');
    const { html } = staticSiteToPrototype({ projectId: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c41", name: "Classe doppia", files: [{ path: "index.html", bytes: own }], framework: "none" });
    expect(html).toMatch(/\.scheda\s*\{[^}]*--x:1px/u);
    expect(html).not.toMatch(/(?:^|\n)body\s*\{[^}]*--x/u);
  });
});

describe("il carattere del sito (V5.3b)", () => {
  it("un font locale entra come media nel suo @font-face e il corpo lo usa ancora, anche scritto con una variabile", async () => {
    const files: StaticSiteFile[] = [
      { path: "index.html", bytes: text('<!doctype html><html lang="it"><head><style>@font-face{font-family:Lettera;src:url("tema/fonts/lettera.woff2") format("woff2")}\n:root{--famiglia-testo:Lettera, sans-serif}\nbody{font-family:var(--famiglia-testo);color:#1d6b4a}</style></head><body><h1>Bottega</h1><p>Testo</p></body></html>') },
      { path: "tema/fonts/lettera.woff2", bytes: Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(16)]) },
    ];
    const { html, design } = staticSiteToPrototype({ projectId: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c42", name: "Carattere", files, framework: "histos-css" });
    expect(html).toContain('src:url("asset:lettera") format("woff2")');
    expect(html).toContain("font-family:var(--famiglia-testo)");
    expect(html).not.toContain("--xb-font-body");
    expect(design.font_body).toBeUndefined();
    const built = await buildPrototypeProfile(parsePrototype(html), await newCatalog());
    const styles = built.profile.entities.find((entity) => entity.kind === "styles");
    expect(JSON.stringify(styles?.payload)).toMatch(/@font-face\{font-family:Lettera;src:url\(\\"prototype-assets\/lettera\\"\)/u);
  });
});

describe("wbr e kbd nei testi", () => {
  it("restano nelle frasi fino al profilo, e fuori da una frase non rompono l'import", async () => {
    const files: StaticSiteFile[] = [
      {
        path: "index.html",
        bytes: text('<!doctype html><html lang="it"><head><title>W</title><style>.indirizzo{color:#333}.tasto{border:1px solid #333}.menu kbd{color:#c00}</style></head><body><main>'
          + '<p class="indirizzo">Vedi https://esempio.test/<wbr>una-pagina-lunga/ e premi <kbd>Ctrl</kbd>+<kbd class="tasto">S</kbd></p>'
          + '<div class="menu"><wbr><kbd>Esc</kbd></div></main></body></html>'),
      },
    ];
    const { html } = staticSiteToPrototype({ projectId: staticSiteProjectId("wbr"), name: "W", files });
    expect(html).toContain("https://esempio.test/<wbr>una-pagina-lunga/");
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain('<span class="tasto">S</span>');
    expect(html).toContain('<div class="menu"><wbr><kbd>Esc</kbd></div>');
    const built = await buildPrototypeProfile(parsePrototype(html), await newCatalog());
    const page = built.profile.entities.find((entity) => entity.kind === "document")?.payload as { content?: string } | undefined;
    // The text runs are JSON inside the block comments: `<` and `>` are written \u003c and \u003e there.
    const content = (page?.content ?? "").replace(/\\u003c/gu, "<").replace(/\\u003e/gu, ">");
    expect(content).toContain("https://esempio.test/<wbr>una-pagina-lunga/ e premi <kbd>Ctrl</kbd>+");
    expect(content).toContain('"tag":"span","attributes":{"class":"tasto"}');
    expect(content).toContain('"content":"<wbr><kbd>Esc</kbd>"');
    expect(() => validateTransferDocument(page?.content ?? "")).not.toThrow();
  });
});

describe("wbr e kbd fuori da un testo", () => {
  it("figli diretti di un contenitore, soli o in mezzo ad altri blocchi, passano l'import", async () => {
    const files: StaticSiteFile[] = [
      {
        path: "index.html",
        bytes: text('<!doctype html><html lang="it"><head><title>K</title><style>.solo kbd{color:#c00}.misto{gap:1rem}</style></head><body><main>'
          + '<div class="solo"><kbd>Esc</kbd></div>'
          + '<div class="vuoto"><wbr></div>'
          + '<section class="misto"><p>Prima</p><kbd>Tab</kbd><p>Dopo</p><wbr><h2>Titolo</h2><kbd class="tasto">Invio</kbd><ul><li>Voce</li></ul></section>'
          + '</main></body></html>'),
      },
    ];
    const { html } = staticSiteToPrototype({ projectId: staticSiteProjectId("kbd-blocchi"), name: "K", files });
    // inline-classes.ts: `kbd` is never given a class of its own (NEVER), even alone in a block and styled by `.solo kbd`.
    // As an INLINE tag with the role "key" it got one, and a `kbd` with a class is an element the transfer refuses.
    expect(html).toContain('<div class="solo"><kbd>Esc</kbd></div>');
    const built = await buildPrototypeProfile(parsePrototype(html), await newCatalog());
    const page = built.profile.entities.find((entity) => entity.kind === "document")?.payload as { content?: string } | undefined;
    const content = (page?.content ?? "").replace(/\\u003c/gu, "<").replace(/\\u003e/gu, ">");
    // Each one ends up inside a text run, never as an element block of its own.
    expect(content).toContain("<kbd>Esc</kbd>");
    expect(content).toContain("<kbd>Tab</kbd>");
    expect(content).toContain('"tag":"span","attributes":{"class":"tasto"}');
    expect(content).toContain('"tag":"div","attributes":{"class":"solo"}} --><!-- wp:xb/text {"uid":');
    expect(content).toMatch(/"content":"<kbd>Esc<\/kbd>"/u);
    expect(content).toMatch(/"attributes":\{"class":"vuoto"\}\} --><!-- wp:xb\/text \{"uid":"[a-z0-9]+","content":"<wbr>"\}/u);
    expect(content).toMatch(/"content":"Prima"\} \/--><!-- \/wp:xb\/element --><!-- wp:xb\/text \{"uid":"[a-z0-9]+","content":"<kbd>Tab<\/kbd>"\}/u);
    expect(content).toMatch(/"content":"Dopo"\} \/--><!-- \/wp:xb\/element --><!-- wp:xb\/text \{"uid":"[a-z0-9]+","content":"<wbr>"\}/u);
    expect(content).not.toMatch(/"tag":"(kbd|wbr)"/u);
    // The import's own check of the transfer accepts the page; the same tags as element blocks it would refuse.
    expect(() => validateTransferDocument(page?.content ?? "")).not.toThrow();
    expect(() => validateTransferDocument('<!-- wp:xb/element {"uid":"p0000000001a","tag":"kbd"} --><!-- wp:xb/text {"uid":"p0000000002b","content":"Esc"} /--><!-- /wp:xb/element -->')).toThrow(/<kbd> non è trasferibile/u);
    expect(() => validateTransferDocument('<!-- wp:xb/element {"uid":"p0000000003c","tag":"wbr"} /-->')).toThrow(/<wbr> non è trasferibile/u);
  });
});
