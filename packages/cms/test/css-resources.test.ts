import { describe, expect, it } from "vitest";
import { assertCssResourcesBundled, cssResourceReferences, rewriteCssAssetUrls, rewriteMappedCssAssetUrls, unbundledCssResources } from "../src/css-resources.js";

describe("riferimenti alle risorse CSS", () => {
  it("ignora commenti e stringhe normali, ma trova url() effettivi", () => {
    const references = cssResourceReferences(`/* url(fake.png) */ .x::before { content: "url(text.png)"; background: url("../images/a b.png"); }`);
    expect(references.map(({ value, kind, external }) => ({ value, kind, external }))).toEqual([{ value: "../images/a b.png", kind: "url", external: false }]);
  });

  it("distingue file locali, URL HTTPS e dati incorporati", () => {
    const references = cssResourceReferences(`@import "https://cdn.example.test/base.css"; @import url(./theme.css); @import url("https://cdn.example.test/other.css"); .x { src: url(data:font/woff2;base64,AAAA); mask: url(#icon); }`);
    expect(references.map(({ value, kind, external }) => ({ value, kind, external }))).toEqual([
      { value: "https://cdn.example.test/base.css", kind: "import", external: true },
      { value: "./theme.css", kind: "import", external: false },
      { value: "https://cdn.example.test/other.css", kind: "import", external: true },
      { value: "data:font/woff2;base64,AAAA", kind: "url", external: true },
      { value: "#icon", kind: "url", external: true },
    ]);
    expect(unbundledCssResources(`@import url(//cdn.example.test/x.css); .x{background:url(/media/local.png)}`).map(({ value, kind, external }) => ({ value, kind, external }))).toEqual([
      { value: "/media/local.png", kind: "url", external: false },
    ]);
    expect(() => assertCssResourcesBundled([{ label: "Import CSS", css: `@import url(./theme.css)`, assets: [{ reference: "./theme.css", assetId: "550e8400-e29b-41d4-a716-446655440000" }] }]))
      .toThrow(/import locali.*non sono supportati/u);
  });

  it("segnala il primo riferimento locale con nome del foglio e azione praticabile", () => {
    expect(() => assertCssResourcesBundled([{ label: "Core Framework", css: `.x{background:url(../img/pattern.webp)}` }]))
      .toThrow(/Core Framework.*\.\.\/img\/pattern\.webp.*rimuovi il riferimento/u);
    expect(() => assertCssResourcesBundled([{ label: "Tipografia", css: `@import url(https://fonts.example.test/css); .x{background:url(data:image/png;base64,AAAA)}` }]))
      .not.toThrow();
  });

  it("riscrive solo gli url() locali associati e conserva query e frammento", async () => {
    const css = `.brand{src:url('../fonts/brand.woff2?v=3#latin')}.remote{src:url(https://cdn.example.test/remote.woff2)}`;
    const resources = [{ reference: "../fonts/brand.woff2?v=3#latin", assetId: "550e8400-e29b-41d4-a716-446655440000" }];
    await expect(rewriteCssAssetUrls(css, resources, (id) => `/__cms-media/${id}`)).resolves.toBe(`.brand{src:url("/__cms-media/550e8400-e29b-41d4-a716-446655440000?v=3#latin")}.remote{src:url(https://cdn.example.test/remote.woff2)}`);
    expect(rewriteMappedCssAssetUrls(css, resources, (id) => `/__cms-media/project/${id}`)).toBe(`.brand{src:url("/__cms-media/project/550e8400-e29b-41d4-a716-446655440000?v=3#latin")}.remote{src:url(https://cdn.example.test/remote.woff2)}`);
  });
});
