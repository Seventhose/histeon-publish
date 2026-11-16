import { describe, expect, it } from "vitest";
import { analyseSelector, isUtilityName, propertyFamily } from "../src/utility-classes.js";
import { staticSiteProjectId, staticSiteToPrototype } from "../src/static-site-prototype.js";

const text = (value: string) => new TextEncoder().encode(value);

/** A one-page site with this body and this CSS, converted: its home markup, all its CSS and the notes. */
function convert(body: string, css: string, head = "") {
  const files = [
    { path: "index.html", bytes: text(`<!doctype html><html lang="it"><head><title>U</title><link rel="stylesheet" href="s.css">${head}</head><body>${body}</body></html>`) },
    { path: "s.css", bytes: text(css) },
  ];
  const prototype = staticSiteToPrototype({ projectId: staticSiteProjectId("utility"), name: "U", files });
  const home = /<template data-histos="page"[^>]*>([\s\S]*?)<\/template>/u.exec(prototype.html)?.[1] ?? "";
  const styles = [...prototype.html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gu)].map((match) => match[1]).join("\n");
  return { home, css: styles.replace(/\s+/gu, " "), notes: prototype.report.notes.join("\n") };
}

describe("classi utility → classi BEM (doc 18 §6.4)", () => {
  it("senza utility non scrive «0 classi utility convertite»: dice le classi nuove degli stili in linea (voce 109)", () => {
    const { notes } = convert('<section class="hero"><p style="color:red">Rosso</p></section>', ".hero{display:grid}");
    expect(notes).not.toMatch(/0 classi utility/u);
    expect(notes).toMatch(/1 classe BEM nuova per gli stili style="" portati nel CSS/u);
  });

  it("riconosce i nomi delle utility di Tailwind e Bootstrap, non le classi BEM né quelle di ACSS", () => {
    for (const name of ["p-4", "md:px-6", "hover:bg-emerald-700", "-mt-2", "text-[13px]", "d-md-flex", "mb-3", "fw-bold", "justify-content-between", "lg:grid-cols-3", "!p-2"]) expect(isUtilityName(name), name).toBe(true);
    for (const name of ["card", "card__title", "btn--primary", "text--l", "container", "row", "col-md-6", "hero"]) expect(isUtilityName(name), name).toBe(false);
  });

  it("legge specificità e richieste dell'ultima parte di un selettore", () => {
    expect(analyseSelector(".md\\:flex")?.simple).toEqual({ name: "md:flex", suffix: "" });
    expect(analyseSelector(".hover\\:bg-x:hover")?.simple).toEqual({ name: "hover:bg-x", suffix: ":hover" });
    expect(analyseSelector(".group:hover .group-hover\\:x")?.simple).toBeNull();
    expect(analyseSelector(".group:hover .group-hover\\:x")?.mentioned).toEqual(["group", "group-hover:x"]);
    expect(analyseSelector("#a .b > p:not(.c)::before")?.specificity).toEqual([1, 2, 2]);
    expect(analyseSelector(":where(.space-y-4 > *)")?.specificity).toEqual([0, 0, 0]);
    expect(analyseSelector("ns|a")).toBeNull();
    expect(propertyFamily("padding-inline")).toBe(propertyFamily("padding"));
    expect(propertyFamily("top")).toBe(propertyFamily("inset"));
    expect(propertyFamily("row-gap")).toBe(propertyFamily("gap"));
  });

  it("converte le utility in una classe per elemento, con @media e stati, nell'ordine dei fogli", () => {
    const { home, css, notes } = convert(
      '<section class="hero"><h1 class="text-4xl font-bold md:text-5xl">Ciao</h1><a href="#x" class="rounded-lg bg-emerald-600 hover:bg-emerald-700">Vai</a><a href="#y" class="rounded-lg bg-emerald-600 hover:bg-emerald-700">Anche</a></section>',
      ".hero{display:grid}.text-4xl{font-size:2.25rem}.font-bold{font-weight:700}.rounded-lg{border-radius:.5rem}.bg-emerald-600{background:#059669}.hover\\:bg-emerald-700:hover{background:#047857}@media (min-width:768px){.md\\:text-5xl{font-size:3rem}}",
    );
    expect(home).toContain('<h1 class="hero__title">Ciao</h1>');
    // Same utilities in the same block: one class.
    expect(home.match(/class="hero__link"/gu)?.length).toBe(2);
    expect(css).toMatch(/&__title \{ font-size: 2\.25rem; font-weight: 700; \}/u);
    expect(css).toMatch(/@media \(min-width:768px\) \{ &__title \{ font-size: 3rem; \}/u);
    expect(css).toMatch(/&__link \{ border-radius: \.5rem; background: #059669; \} &__link:hover \{ background: #047857; \}/u);
    expect(css).not.toMatch(/text-4xl|bg-emerald/u);
    expect(notes).toMatch(/6 classi utility convertite in 2 classi BEM, con il controllo di equivalenza del CSS/u);
  });

  it("tiene una utility quando la cascata cambierebbe: una regola dopo, di pari specificità, la vinceva", () => {
    const { home, notes } = convert('<div class="card p-4 font-bold">x</div>', ".font-bold{font-weight:700}.p-4{padding:1rem}.card{padding:2rem}");
    expect(home).toContain('class="card__box card p-4"');
    expect(notes).toMatch(/1 classi utility tenute come sono: la cascata cambierebbe/u);
  });

  it("converte quando la regola concorrente perde comunque o vince ancora: prima nel foglio, più debole, o più forte", () => {
    const { home } = convert('<main id="m"><p class="p-4 text-sm">x</p></main>', "p{padding:0;font-size:1rem}.card{padding:2rem}.p-4{padding:1rem}.text-sm{font-size:.875rem}#m p{font-size:2rem}");
    expect(home).toContain('<p class="m__text">x</p>');
  });

  it("tiene le utility nominate da selettori composti, dagli script o con !important", () => {
    const { home, notes } = convert(
      '<div class="group p-4"><span class="group-hover:underline mt-2 hidden">a</span><b class="m-1">b</b></div><script>el.classList.toggle("hidden")</script>',
      ".p-4{padding:1rem}.group:hover .group-hover\\:underline{text-decoration:underline}.mt-2{margin-top:.5rem}.hidden{display:none}.m-1{margin:.25rem!important}",
    );
    // `group` is no utility: it stays, and `p-4` becomes the element's own class.
    expect(home).toContain('class="group__box group"');
    expect(home).toMatch(/<span class="group__text group-hover:underline hidden">/u);
    expect(home).toContain('class="m-1"');
    expect(notes).toMatch(/3 classi utility tenute come sono/u);
    expect(notes).toMatch(/usate da selettori composti, nominate dagli script, con !important/u);
  });

  it("rispetta i layer: una regola fuori dai layer vince su una utility in un layer", () => {
    const layered = "@layer base, utilities;@layer base{p{margin:0}}@layer utilities{.mt-4{margin-top:1rem}.p-2{padding:.5rem}}div p{padding:0}";
    const { home } = convert('<div><p class="mt-4 p-2">x</p></div>', layered);
    // `div p` is unlayered: it beat `p-2` and still would beat the new class, so `p-2` stays; `mt-4` converts.
    expect(home).toMatch(/<p class="text p-2">/u);
    expect(home).not.toContain("mt-4");
  });

  it("legge il CSS annidato di Tailwind 4", () => {
    const { home, css } = convert('<a href="#a" class="hover:bg-sky-700">a</a>', "@layer utilities{.hover\\:bg-sky-700{&:hover{@media (hover:hover){background-color:#0369a1}}}}");
    expect(home).toContain('class="link"');
    expect(css).toMatch(/\.link:hover \{ background-color: #0369a1; \}|&:hover \{ background-color: #0369a1; \}/u);
  });

  it("toglie le utility senza regole, tranne quando Tailwind gira nel browser", () => {
    expect(convert('<p class="py-3 text-center">x</p>', "").home).toContain("<p>x</p>");
    const browser = convert('<p class="py-3 text-center">x</p>', "", '<script src="https://cdn.tailwindcss.com"></script>');
    expect(browser.home).toContain('class="py-3 text-center"');
    expect(browser.notes).toMatch(/Tailwind caricato come script/u);
  });

  it("porta style=\"\" nel CSS del selettore, tranne ciò che una regola più forte o uno stato toccano", () => {
    const { home, css, notes } = convert(
      '<section id="s" class="hero"><p class="px-4 hover:text-red-600" style="color:#222;margin:0;padding:1px">x</p></section>',
      ".hero{display:block}.px-4{padding-inline:1rem}.hover\\:text-red-600:hover{color:#dc2626}#s p{margin:2px}",
    );
    expect(home).toContain('<p class="hero__text" style="color: #222; margin: 0">x</p>');
    expect(css).toMatch(/&__text \{ padding-inline: 1rem; &:hover \{ color: #dc2626; \} padding: 1px; \}|padding: 1px/u);
    expect(notes).toMatch(/1 dichiarazioni di style="" portate nel CSS del selettore/u);
    expect(notes).toMatch(/2 dichiarazioni di style="" tenute nell'HTML/u);
  });

  it("resiste al CSS ostile: annidamento che esplode e nomi di classe che non sono identificatori", () => {
    const nested = `.p-4{padding:1rem}${"x{& &{".repeat(40)}color:red${"}}".repeat(40)}`;
    const started = Date.now();
    expect(convert('<div class="p-4">x</div>', nested).home).toContain('class="box"');
    expect(Date.now() - started).toBeLessThan(5_000);
    const { home, css } = convert('<div class="a{}b"><p class="p-4">x</p></div>', ".p-4{padding:1rem}");
    expect(home).toContain('<p class="text">x</p>');
    expect(css).not.toContain("a{}b__");
  });
});
