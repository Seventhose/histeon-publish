import { describe, expect, it } from "vitest";
import { staticSiteProjectId, staticSiteToPrototype } from "../src/static-site-prototype.js";
import { UTILITY_VISUAL_MAX_CHARS, UTILITY_VISUAL_PAGES, utilityVisualPairs, visualDocument } from "../src/utility-visual-check.js";

const text = (value: string) => new TextEncoder().encode(value);

function site(pages: Record<string, string>, css: string) {
  const files = Object.entries(pages).map(([path, body]) => ({ path, bytes: text(`<!doctype html><html lang="it"><head><title>${path}</title><link rel="stylesheet" href="s.css"></head><body>${body}</body></html>`) }));
  return staticSiteToPrototype({ projectId: staticSiteProjectId("visual"), name: "V", files: [...files, { path: "s.css", bytes: text(css) }] });
}

describe("controllo visivo della conversione delle utility (doc 23, voce 101)", () => {
  it("dà la pagina prima e dopo la conversione, con gli stessi fogli più le classi nuove", () => {
    const prototype = site({ "index.html": '<section class="hero"><h1 class="text-4xl font-bold">Ciao <b>&lt;tu&gt;</b></h1></section>' }, ".hero{display:grid}.text-4xl{font-size:2.25rem}.font-bold{font-weight:700}");
    expect(prototype.utilityVisual).toHaveLength(1);
    const [pair] = prototype.utilityVisual;
    expect(pair?.page).toBe("home");
    expect(pair?.before).toContain('<h1 class="text-4xl font-bold">Ciao <b>&lt;tu&gt;</b></h1>');
    expect(pair?.after).toContain('<h1 class="hero__title">Ciao <b>&lt;tu&gt;</b></h1>');
    expect(pair?.after).toMatch(/\.hero__title \{\s*font-size: 2\.25rem;\s*font-weight: 700;\s*\}/u);
    // Plain HTML for the browser, not the DSL's escapes; motion stopped on both sides.
    expect(pair?.before).not.toContain("\\{");
    for (const document of [pair?.before, pair?.after]) expect(document).toContain("animation:none!important");
  });

  it("niente da confrontare quando nessuna utility cambia", () => {
    expect(site({ "index.html": '<section class="hero"><h1 class="hero__title">Ciao</h1></section>' }, ".hero{display:grid}.hero__title{font-size:2rem}").utilityVisual).toEqual([]);
  });

  it("tiene solo le pagine cambiate, al massimo tre", () => {
    const pages: Record<string, string> = { "index.html": '<p class="note">Fermo</p>' };
    for (let index = 1; index <= 5; index++) pages[`p${index}.html`] = `<p class="font-bold">Pagina ${index}</p>`;
    const pairs = site(pages, ".note{color:red}.font-bold{font-weight:700}").utilityVisual;
    expect(pairs).toHaveLength(UTILITY_VISUAL_PAGES);
    expect(pairs.map((pair) => pair.page)).not.toContain("home");
  });

  it("un foglio non chiude il proprio <style>, e i documenti troppo grandi restano fuori", () => {
    expect(visualDocument("<p>x</p>", ["a::after{content:'</style><script>alert(1)</script>'}"])).not.toMatch(/<\/style><script>/u);
    const big = "a{color:red}".repeat(Math.ceil(UTILITY_VISUAL_MAX_CHARS / 12));
    expect(utilityVisualPairs([{ page: "home", body: "<p class=\"x\">a</p>" }], () => "<p class=\"y\">a</p>", [big], [big])).toEqual([]);
    expect(utilityVisualPairs([{ page: "home", body: "<p class=\"x\">a</p>" }], () => "<p class=\"y\">a</p>", ["p{}"], ["p{}"])).toHaveLength(1);
  });
});
