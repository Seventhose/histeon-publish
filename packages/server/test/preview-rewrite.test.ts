import { describe, expect, it } from "vitest";
import { rewritePreviewCss, rewritePreviewHtml, rewriteRootUrl } from "../src/preview-rewrite.js";

const PREFIX = "/__preview/ticket_123/6f1c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f5a";

describe("anteprima: indirizzi dalla radice", () => {
  it("prefissa solo gli indirizzi che partono dalla radice del sito", () => {
    expect(rewriteRootUrl("/media/a.png", PREFIX)).toBe(`${PREFIX}/media/a.png`);
    expect(rewriteRootUrl("/", PREFIX)).toBe(`${PREFIX}/`);
    expect(rewriteRootUrl("  /opera/", PREFIX)).toBe(`  ${PREFIX}/opera/`);
    for (const kept of ["//cdn.example.test/x.png", "/\\evil.test", "https://example.test/", "opera/", "../media/a.png", "#contatti", "mailto:a@b.test", "data:image/png;base64,AA==", ""]) {
      expect(rewriteRootUrl(kept, PREFIX), kept).toBe(kept);
    }
  });

  it("riscrive gli attributi con un indirizzo, con ogni tipo di virgolette", () => {
    const html = `<a href="/opera/">Opere</a><img src='/media/a.png' alt="x"><a href=/blog/>Blog</a><video poster="/media/p.jpg"></video><form action="/cerca/"></form>`;
    expect(rewritePreviewHtml(html, PREFIX)).toBe(`<a href="${PREFIX}/opera/">Opere</a><img src='${PREFIX}/media/a.png' alt="x"><a href=${PREFIX}/blog/>Blog</a><video poster="${PREFIX}/media/p.jpg"></video><form action="${PREFIX}/cerca/"></form>`);
  });

  it("riscrive ogni candidato di srcset e lascia i descrittori", () => {
    expect(rewritePreviewHtml(`<img srcset="/media/a.png 1x, /media/b.png 2x, https://x.test/c.png 3x">`, PREFIX))
      .toBe(`<img srcset="${PREFIX}/media/a.png 1x, ${PREFIX}/media/b.png 2x, https://x.test/c.png 3x">`);
  });

  it("riscrive url() negli stili in linea, nei blocchi style e nei fogli CSS", () => {
    expect(rewritePreviewHtml(`<div style="background:url(/media/a.png)"></div>`, PREFIX)).toBe(`<div style="background:url(${PREFIX}/media/a.png)"></div>`);
    expect(rewritePreviewHtml(`<style>.hero{background-image:url("/media/a.png")} .x{background:url('/media/b.png')} .y{background:url(https://x.test/c.png)}</style>`, PREFIX))
      .toBe(`<style>.hero{background-image:url("${PREFIX}/media/a.png")} .x{background:url('${PREFIX}/media/b.png')} .y{background:url(https://x.test/c.png)}</style>`);
    expect(rewritePreviewCss(`@import "/base.css"; @font-face{src:url( /media/f.woff2 ) format("woff2")}`, PREFIX))
      .toBe(`@import "${PREFIX}/base.css"; @font-face{src:url( ${PREFIX}/media/f.woff2 ) format("woff2")}`);
  });

  it("non tocca testi, commenti, script e valori che non sono indirizzi", () => {
    const html = `<p>Scrivi a /contatti o vai su "/blog/"</p><!-- <img src="/media/a.png"> --><script>location.href = "/opera/"; const s = '<a href="/x">';</script><textarea><a href="/y"></textarea><input value="/z"><p title="/w">t</p>`;
    expect(rewritePreviewHtml(html, PREFIX)).toBe(html);
  });

  it("legge bene i tag con > tra virgolette, attributi senza valore e tag che si chiudono da soli", () => {
    const html = `<img alt="a > b" src="/media/a.png" loading=lazy><input disabled><br/><img src="/media/b.png"/>`;
    expect(rewritePreviewHtml(html, PREFIX)).toBe(`<img alt="a > b" src="${PREFIX}/media/a.png" loading=lazy><input disabled><br/><img src="${PREFIX}/media/b.png"/>`);
  });

  it("riscrive un meta refresh verso la radice", () => {
    expect(rewritePreviewHtml(`<meta http-equiv="refresh" content="0; url=/opera/">`, PREFIX)).toBe(`<meta http-equiv="refresh" content="0; url=${PREFIX}/opera/">`);
    expect(rewritePreviewHtml(`<meta name="description" content="0; url=/opera/">`, PREFIX)).toBe(`<meta name="description" content="0; url=/opera/">`);
  });

  it("lascia intatte le virgole dei data: URI in srcset e prefissa gli altri candidati", () => {
    const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    expect(rewritePreviewHtml(`<img srcset="${jpeg} 1x, /media/a.jpg 2x">`, PREFIX)).toBe(`<img srcset="${jpeg} 1x, ${PREFIX}/media/a.jpg 2x">`);
    expect(rewritePreviewHtml(`<img srcset="/img/a,b.png 1x">`, PREFIX)).toBe(`<img srcset="${PREFIX}/img/a,b.png 1x">`);
  });

  it("riscrive url() anche con le virgolette scritte come entità in un attributo style", () => {
    for (const quote of ["&quot;", "&#39;", "&#x27;", "&apos;"]) {
      expect(rewritePreviewHtml(`<div style="background:url(${quote}/media/a.jpg${quote})"></div>`, PREFIX), quote).toBe(`<div style="background:url(${quote}${PREFIX}/media/a.jpg${quote})"></div>`);
    }
    expect(rewritePreviewCss(`a{background:url(/\\evil.test/x) url(//cdn.test/x) url(data:image/png;base64,/9j/) url()}`, PREFIX)).toBe(`a{background:url(/\\evil.test/x) url(//cdn.test/x) url(data:image/png;base64,/9j/) url()}`);
  });

  it("riscrive ogni stringa di image-set() e i target tra virgolette di un meta refresh", () => {
    expect(rewritePreviewCss(`a{background-image:image-set("/a.avif" type("image/avif"), '/a.jpg' 1x)}`, PREFIX)).toBe(`a{background-image:image-set("${PREFIX}/a.avif" type("image/avif"), '${PREFIX}/a.jpg' 1x)}`);
    expect(rewritePreviewHtml(`<meta http-equiv="refresh" content="0; url='/opera/'">`, PREFIX)).toBe(`<meta http-equiv="refresh" content="0; url='${PREFIX}/opera/'">`);
  });

  it("un < isolato nel testo non nasconde il tag che segue", () => {
    expect(rewritePreviewHtml(`<p>3 < 5</p><img src="/media/a.png">`, PREFIX)).toBe(`<p>3 < 5</p><img src="${PREFIX}/media/a.png">`);
  });

  it("resta lineare su input costruiti apposta (nessun blocco del server)", () => {
    const cases = ["url(".repeat(400_000), `url(${" ".repeat(2_000_000)}x`, `url("${"url(".repeat(200_000)}`, `image-set(${"'x' ".repeat(200_000)}`, `<a ${"x ".repeat(500_000)}`, `<${"<".repeat(1_000_000)}`];
    for (const input of cases) {
      const started = performance.now();
      rewritePreviewCss(input, PREFIX);
      rewritePreviewHtml(`<style>${input}</style><div style="${input.replaceAll('"', "")}">${input}</div>`, PREFIX);
      expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(1_500);
    }
  });

  it("sopravvive a markup troncato senza perdere testo", () => {
    for (const html of [`<a href="/x`, `<p>testo <`, `<style>.a{background:url(/m.png)}`, `<!-- aperto`, `</div`, `<a`]) {
      const result = rewritePreviewHtml(html, PREFIX);
      expect(result.replaceAll(PREFIX, "").length, html).toBeGreaterThanOrEqual(html.length - 1);
    }
  });
});
