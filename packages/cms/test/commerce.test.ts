import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeJson, canonicalRevisionPayload, PRODUCT_CAPABILITY, productFields, validateStaticPageProfile, type StaticPageProfile } from "@histos-publish/histos-contract";
import { createHash } from "node:crypto";
import { normalizeShopSettings } from "../src/commerce.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype, PrototypeError } from "../src/prototype-import.js";
import { queryItemWithMedia } from "../src/static-renderer.js";

/**
 * Queue C6: a prototype's products are the shop's catalogue. The product type has WooCommerce's fields; the check, the
 * content model and the transfer keep its data as WooCommerce keeps it; the build reads `product` with the keys of the
 * builder's ProductNode, and links «aggiungi al carrello» to the shop's WordPress site, or leaves it out.
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

const fixture = () => readFile(new URL("fixtures/prototipo-negozio.html", import.meta.url), "utf8");

async function built(html: string) {
  return buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(path.join(await scratch(), "build")));
}

async function issues(html: string): Promise<string[]> {
  const error = await built(html).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(PrototypeError);
  return (error as PrototypeError).issues.map((issue) => issue.message);
}

function rehash(profile: StaticPageProfile): void {
  for (const entity of profile.entities) entity.revisionHash = createHash("sha256").update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, entity.payload), "utf8").digest("hex");
}

describe("prodotti dei prototipi (C6)", () => {
  it("i campi del prodotto sono quelli del builder (ProductProfileTest controlla lo stesso JSON canonico)", () => {
    expect(canonicalizeJson(productFields())).toBe('[{"key":"regular_price","label":"Prezzo","multiple":false,"public":true,"required":false,"type":"decimal"},{"key":"sale_price","label":"Prezzo scontato","multiple":false,"public":true,"required":false,"type":"decimal"},{"key":"sku","label":"SKU","multiple":false,"public":true,"required":false,"type":"text"},{"key":"stock_status","label":"Disponibilità","multiple":false,"options":["instock","outofstock","onbackorder"],"public":true,"required":false,"type":"enum"},{"key":"image","label":"Immagine","multiple":false,"public":true,"required":false,"type":"asset"},{"key":"gallery","label":"Galleria","multiple":true,"public":true,"required":false,"type":"asset"}]');
  });

  it("il tipo product prende i campi di WooCommerce, il trasferimento chiede commerce:products:v1 e il rapporto dice che il sito statico non vende", async () => {
    const result = await built(await fixture());
    const type = result.profile.entities.find((entity) => entity.kind === "content-type");
    expect(type?.payload).toMatchObject({ key: "product", label: "Prodotti", fields: productFields(), singleTemplateRef: "shop/prodotto", archiveTemplateRef: "shop/negozio" });
    expect(result.profile.manifest.requiredCapabilities).toContain(PRODUCT_CAPABILITY);
    expect(result.shop).toEqual({ url: "https://negozio.example", currency: "EUR" });
    expect(result.report.warnings.find((warning) => warning.startsWith("Prodotti:"))).toContain("porta alla pagina del prodotto su negozio.example");
    expect(() => validateStaticPageProfile(result.profile)).not.toThrow();

    // The transfer refuses what WooCommerce would not keep, and a profile that hides its products from the site.
    const mutate = (change: (profile: StaticPageProfile) => void): StaticPageProfile => {
      const copy = structuredClone(result.profile);
      change(copy);
      rehash(copy);
      return copy;
    };
    const record = (profile: StaticPageProfile, slug: string) => profile.entities.find((entity) => entity.kind === "content-record" && entity.payload.slug === slug)!;
    expect(() => validateStaticPageProfile(mutate((profile) => { profile.manifest.requiredCapabilities = profile.manifest.requiredCapabilities.filter((item) => item !== PRODUCT_CAPABILITY); }))).toThrow(/capability/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { (profile.entities.find((entity) => entity.kind === "content-type")!.payload.fields as unknown[]).pop(); }))).toThrow(/campi del prodotto/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { (record(profile, "tazza-blu").payload.values as Record<string, unknown>).sale_price = 30; }))).toThrow(/minore del prezzo pieno/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { (record(profile, "piatto-grande").payload.values as Record<string, unknown>).sku = "TZ-BLU"; }))).toThrow(/SKU TZ-BLU/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { record(profile, "tazza-blu").payload.excerpt = "<b>forte</b>"; }))).toThrow(/senza markup/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { (profile.entities.find((entity) => entity.kind === "taxonomy" && entity.payload.key === "product_tag")!.payload.types as string[]).splice(0, 1, "post"); }))).toThrow(/soltanto per i prodotti/u);
  });

  it("il controllo dice ogni problema dei prodotti alla sua voce", async () => {
    const html = (await fixture())
      .replace('"label": "Prodotti", "singleTemplate"', '"label": "Prodotti", "fields": [{ "key": "colore", "label": "Colore", "type": "text", "required": false, "public": true, "multiple": false }], "singleTemplate"')
      .replace('"sale_price": 19.5', '"sale_price": "19.5"')
      .replace('"sku": "PT-GRANDE"', '"sku": "TZ-BLU"')
      .replace('"excerpt": "Esaurito per ora."', '"excerpt": "Esaurito <em>per ora</em>."')
      .replace('{ "key": "product_tag", "label": "Tag prodotto", "types": ["product"] }', '{ "key": "product_tag", "label": "Tag prodotto", "types": ["product", "post"] }')
      .replace('"url": "https://negozio.example"', '"url": "http://negozio.example"');
    const messages = await issues(html);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining("il tipo product è il catalogo del negozio e ha già i suoi campi (regular_price, sale_price, sku, stock_status, image, gallery): togli fields."),
      expect.stringContaining("il campo sale_price vuole un numero."),
      expect.stringContaining("prodotto: sku «TZ-BLU» è già di un altro prodotto"),
      expect.stringContaining("prodotto: excerpt: la descrizione breve di un prodotto è testo, senza markup"),
      expect.stringContaining('product_tag vale solo per i prodotti: "types": ["product"].'),
      expect.stringContaining("shop.url comincia con https://"),
    ]));
    const sale = await issues((await fixture()).replace('"sale_price": 19.5', '"sale_price": 24'));
    expect(sale).toEqual([expect.stringContaining("sale_price: il prezzo scontato è minore del prezzo pieno")]);
    const reserved = await issues((await fixture()).replace('"types": [\n    { "key": "product"', '"types": [\n    { "key": "product_cat", "label": "X" },\n    { "key": "product"'));
    expect(reserved).toEqual(expect.arrayContaining([expect.stringContaining("la chiave «product_cat» è riservata alle categorie e ai tag dei prodotti")]));
  });

  it("il modello dei contenuti tiene i campi fissi e uno SKU per prodotto", async () => {
    const catalog = new CmsProjectCatalog(path.join(await scratch(), "catalog"));
    const { store } = await catalog.createProject("Negozio");
    expect(() => store.content.saveType({ key: "product", label: "Prodotti", fields: [] })).toThrow(/campi sono fissi/u);
    expect(store.content.saveType({ key: "product", label: "Prodotti", fields: productFields() }).status).toBe("saved");
    expect(() => store.content.saveType({ key: "product_cat", label: "X", fields: [] })).toThrow(/riservata/u);
    expect(() => store.content.saveTaxonomy({ key: "product_cat", label: "Categorie", types: [] })).toThrow(/soltanto per i prodotti/u);
    expect(store.content.createRecord({ typeKey: "product", title: "Tazza", values: { regular_price: 10, sku: "A1" } }).status).toBe("saved");
    expect(() => store.content.createRecord({ typeKey: "product", title: "Piatto", values: { regular_price: 10, sku: "A1" } })).toThrow(/SKU A1/u);
    expect(() => store.content.createRecord({ typeKey: "product", title: "Piatto", values: { regular_price: 10.123456 } })).toThrow(/al massimo 4 decimali/u);
    expect(() => store.content.createRecord({ typeKey: "product", title: "Piatto <b>", values: {} })).toThrow(/senza markup/u);
    store.close();
  });

  it("product nei loop e nella pagina del prodotto: le chiavi di ProductNode, il carrello sul sito WordPress o nessun link", async () => {
    const result = await built(await fixture());
    const catalog = new CmsProjectCatalog(path.join(await scratch(), "catalog"));
    const { project, store } = await catalog.importStaticPageProfile(result.profile, result.files);
    store.setShopSettings(result.shop);
    const record = store.content.listRecords({ typeKey: "product", status: "any", includePrivate: true, limit: 10 }).items.find((item) => item.slug === "tazza-blu")!;
    const item = queryItemWithMedia(record, store, project.id) as Record<string, Record<string, unknown>>;
    const image = store.listAssets().find((asset) => asset.alt === "Tazza blu")!;
    const back = store.listAssets().find((asset) => asset.alt === "Tazza, retro")!;
    expect(item.image).toEqual({ id: image.id, url: `/__cms-media/${project.id}/${image.id}`, alt: "Tazza blu", caption: "", title: image.filename });
    expect(item.product).toEqual({
      price: 19.5, regularPrice: 24, salePrice: 19.5, onSale: true,
      priceText: new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(19.5),
      currency: "EUR", currencySymbol: "€", sku: "TZ-BLU", inStock: true, stockStatus: "instock", type: "simple",
      shortDescription: "Ceramica smaltata a mano & cotta due volte.",
      addToCartUrl: "https://negozio.example/?product=tazza-blu", addToCartText: "Aggiungi al carrello",
      rating: 0, reviewCount: 0,
      gallery: [{ id: back.id, url: `/__cms-media/${project.id}/${back.id}`, alt: "Tazza, retro", caption: "", title: back.filename }],
      categories: [expect.objectContaining({ name: "Tazze", slug: "tazze", taxonomy: "product_cat", url: "/product_cat/cucina/tazze/" })],
      tags: [expect.objectContaining({ name: "Ceramica", slug: "ceramica", taxonomy: "product_tag", url: "/product_tag/ceramica/" })],
    });
    const soldOut = store.content.listRecords({ typeKey: "product", status: "any", includePrivate: true, limit: 10 }).items.find((entry) => entry.slug === "piatto-grande")!;
    expect((queryItemWithMedia(soldOut, store, project.id) as Record<string, Record<string, unknown>>).product).toMatchObject({ price: 40, onSale: false, salePrice: null, inStock: false, stockStatus: "outofstock", addToCartText: "Leggi di più", gallery: [] });
    // No shop named: the links are left out, never pointed at a guess.
    store.setShopSettings({ currency: "USD" });
    expect((queryItemWithMedia(record, store, project.id) as Record<string, Record<string, unknown>>).product).toMatchObject({ addToCartUrl: null, currency: "USD", currencySymbol: "USD" });
    store.close();
  });

  it("le impostazioni del negozio: https (http solo in locale), senza credenziali né parametri, valuta ISO 4217", () => {
    expect(normalizeShopSettings({ url: "https://negozio.example/shop/", currency: "CHF" })).toEqual({ url: "https://negozio.example/shop", currency: "CHF" });
    expect(normalizeShopSettings({ url: "http://negozio.localhost:8080" })).toEqual({ url: "http://negozio.localhost:8080", currency: "EUR" });
    expect(normalizeShopSettings(undefined)).toEqual({ url: null, currency: "EUR" });
    for (const url of ["http://negozio.example", "https://user:pw@negozio.example", "https://negozio.example/?x=1", "https://negozio.example/#a", "javascript:alert(1)"]) expect(() => normalizeShopSettings({ url })).toThrow(TypeError);
    for (const currency of ["eur", "EURO", 978]) expect(() => normalizeShopSettings({ currency })).toThrow(/ISO 4217/u);
    expect(() => normalizeShopSettings({ url: "https://negozio.example", vat: 22 })).toThrow(/vat/u);
  });
});
