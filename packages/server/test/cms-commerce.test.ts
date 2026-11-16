import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPrototypeProfile, CmsProjectCatalog, parsePrototype, type CmsProjectStore } from "@histos-publish/cms";
import { buildCmsProject, buildPrototypePreview, importPrototypeHtml, type CmsOperationsContext } from "../src/cms-api.js";
import { checkPrototype } from "../src/prototype-check.js";

/**
 * Queue C6 in the static build: a prototype's products are pages of the product type, their archive and their
 * categories, with `product` as WordPress gives it. The site shows prices and «aggiungi al carrello», which leads to the
 * product on the shop's WordPress site, or is left out without a shop. It never sells.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cms-commerce-"));
  roots.push(root);
  return root;
}

function context(target: { root: string; catalog: CmsProjectCatalog }): CmsOperationsContext {
  return {
    catalog: target.catalog, dataDirectory: target.root, port: 1, registerPreview: () => undefined, registerBuild: () => undefined,
    prototypePreviews: { root: path.join(target.root, "previews"), track: () => undefined, folder: async () => null } as unknown as CmsOperationsContext["prototypePreviews"],
  };
}

async function build(target: { root: string; catalog: CmsProjectCatalog }, opened: { project: { id: string }; store: CmsProjectStore }) {
  const out = path.join(target.root, `out-${Math.random().toString(36).slice(2)}`);
  const result = await buildCmsProject(context(target), opened, { throwaway: { directory: out } });
  expect(result.status).toBe("ready");
  const folder = path.join(out, String(result.id));
  const files = (await readdir(folder, { recursive: true })).filter((name) => name.endsWith(".html")).map((name) => `/${name.replace(/\\/gu, "/").replace(/index\.html$/u, "")}`).sort();
  return { files, page: (address: string) => readFile(path.join(folder, ...address.split("/").filter(Boolean), "index.html"), "utf8") };
}

const fixture = () => readFile(new URL("../../cms/test/fixtures/prototipo-negozio.html", import.meta.url), "utf8");
const euro = (value: number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(value);

describe("prodotti nella build statica (C6)", () => {
  it("si controlla con l'anteprima, si importa con il negozio e si costruisce: prodotti, archivio, categorie e carrello sul sito", async () => {
    const html = await fixture();
    const root = await scratch();
    const target = { root, catalog: new CmsProjectCatalog(path.join(root, "catalog")) };
    const checked = await checkPrototype(html, { scratchRoot: root, preview: (opened, signal) => buildPrototypePreview(context(target), opened, signal) });
    expect(checked).toMatchObject({ valid: true, outcome: "create", preview: { status: "ready" } });

    const imported = await importPrototypeHtml(context(target), html, { download: false });
    expect(imported.status).toBe(201);
    const opened = (await target.catalog.openProject("7c2e4a10-5b3d-4f6e-9a8b-1c2d3e4f5a6b"))!;
    expect(opened.store.getShopSettings()).toEqual({ url: "https://negozio.example", currency: "EUR" });
    const built = await build(target, opened);
    // The draft product has no page; the two published ones, the shop's archive and the categories have.
    expect(built.files).toEqual(expect.arrayContaining(["/product/tazza-blu/", "/product/piatto-grande/", "/product/", "/product_cat/cucina/", "/product_cat/cucina/tazze/", "/product_tag/ceramica/"]));
    expect(built.files).not.toContain("/product/ciotola/");

    const product = await built.page("/product/tazza-blu/");
    expect(product).toContain(`<p class="prezzo">${euro(19.5)}</p>`);
    expect(product).toContain('<p class="pieno">24</p>');
    expect(product).toContain('<p class="breve">Ceramica smaltata a mano &amp; cotta due volte.</p>');
    expect(product).toContain('<p class="sku">TZ-BLU</p>');
    expect(product).toMatch(/<img class="principale" src="\/media\/[0-9a-f]{64}\.png" alt="Tazza blu">/u);
    expect(product).toMatch(/<img class="galleria" src="\/media\/[0-9a-f]{64}\.png" alt="Tazza, retro">/u);
    expect(product).toContain('<a class="categoria" href="/product_cat/cucina/tazze/">Tazze</a>');
    expect(product).toContain('<a class="carrello" href="https://negozio.example/?product=tazza-blu">Aggiungi al carrello</a>');

    const archive = await built.page("/product/");
    expect(archive).toContain(`<a class="nome" href="/product/piatto-grande/">Piatto grande</a><span class="prezzo">${euro(40)}</span><a class="carrello" href="https://negozio.example/?product=piatto-grande">Leggi di più</a>`);
    expect(archive).toContain(`<a class="nome" href="/product/tazza-blu/">Tazza blu</a><span class="prezzo">${euro(19.5)}</span><span class="disponibile">sì</span>`);
    // A category's archive takes the type's template and lists its subcategories' products, as WordPress does.
    const category = await built.page("/product_cat/cucina/");
    expect(category).toContain("Tazza blu");
    expect(category).toContain("Piatto grande");
    expect(await built.page("/")).toContain(`<p class="vetrina">Tazza blu: ${euro(19.5)}</p>`);

    // Without a shop the links are left out, never pointed at a guess.
    opened.store.setShopSettings(null);
    const withoutShop = await build(target, opened);
    expect(await withoutShop.page("/product/tazza-blu/")).not.toContain('class="carrello"');
    opened.store.close();
  });

  it("un prodotto in un'altra lingua porta al suo slug di WordPress, con la lingua", async () => {
    const html = (await fixture()).replace('{ "type": "product", "slug": "ciotola", "title": "Ciotola", "status": "draft", "values": { "regular_price": 12 } }', '{ "type": "product", "slug": "blue-mug", "locale": "en-GB", "title": "Blue mug", "status": "published", "publishedAt": "2026-10-03T09:00:00Z", "values": { "regular_price": 24, "sku": "TZ-BLU-EN" } }');
    const root = await scratch();
    const result = await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(path.join(root, "build")));
    const target = { root, catalog: new CmsProjectCatalog(path.join(root, "catalog")) };
    const opened = await target.catalog.importStaticPageProfile(result.profile, result.files);
    opened.store.setShopSettings(result.shop);
    const built = await build(target, opened);
    expect(await built.page("/en-gb/product/blue-mug/")).toContain('<a class="carrello" href="https://negozio.example/?product=blue-mug-en-gb">Add to cart</a>');
    opened.store.close();
  });
});
