/*
 * Products in the static build (queue C6): `this.product.*` on a product's page and `item.product.*` in a loop of
 * products, with the keys the builder's ProductNode gives them on WordPress (docs/spec/ecommerce.md of the builder).
 * A static site does not sell: there is no cart without WordPress. «Aggiungi al carrello» links to the product's page
 * on the shop's WordPress site, where it is added to the cart, and is left out (null) when the project names no shop.
 */
import { PRODUCT_TYPE_KEY } from "@histos-publish/histos-contract";

/** The shop a project sells through: its WordPress site, when there is one, and the currency its prices are in. */
export interface CmsShopSettings {
  url: string | null;
  currency: string;
}

export const DEFAULT_SHOP_CURRENCY = "EUR";

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:localhost|test))$/iu;

/**
 * A project's shop settings, checked: `url` the address of the WordPress site of the shop (https, or http for a local
 * development host), without credentials, query or fragment, kept without its final slash; `currency` an ISO 4217
 * code in capitals. Throws a TypeError in Italian, naming the setting.
 */
export function normalizeShopSettings(value: unknown): CmsShopSettings {
  if (value === undefined || value === null) return { url: null, currency: DEFAULT_SHOP_CURRENCY };
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("shop è un oggetto con url e currency.");
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) if (key !== "url" && key !== "currency") throw new TypeError(`shop: «${key}» non è un'impostazione del negozio (url, currency).`);
  let url: string | null = null;
  if (candidate.url !== undefined && candidate.url !== null && candidate.url !== "") {
    if (typeof candidate.url !== "string" || candidate.url.length > 2048) throw new TypeError("shop.url è l'indirizzo del sito WordPress del negozio, al massimo 2048 caratteri.");
    let parsed: URL;
    try { parsed = new URL(candidate.url); } catch { throw new TypeError(`shop.url «${candidate.url}» non è un indirizzo: scrivi per esempio https://negozio.example.`); }
    const local = LOCAL_HOST.test(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) throw new TypeError("shop.url comincia con https:// (http:// solo per un sito di sviluppo locale).");
    if (parsed.username || parsed.password || parsed.search || parsed.hash || /[\s<>"'`\\]/u.test(candidate.url)) throw new TypeError("shop.url è l'indirizzo del sito, senza credenziali, parametri (?…) né frammenti (#…).");
    url = parsed.href.replace(/\/+$/u, "");
  }
  let currency = DEFAULT_SHOP_CURRENCY;
  if (candidate.currency !== undefined && candidate.currency !== null) {
    if (typeof candidate.currency !== "string" || !/^[A-Z]{3}$/u.test(candidate.currency)) throw new TypeError("shop.currency è un codice ISO 4217 di tre lettere maiuscole, per esempio EUR.");
    try { new Intl.NumberFormat("en", { style: "currency", currency: candidate.currency }); } catch { throw new TypeError(`shop.currency «${candidate.currency}» non è una valuta.`); }
    currency = candidate.currency;
  }
  return { url, currency };
}

/** What the static build knows of a project to describe its products. */
export interface CmsCommerceContext {
  shop: CmsShopSettings;
  /** The project's language: a record in another one has the language in its WordPress slug (cms-bridge §7). */
  defaultLocale: string;
  asset(id: string): { id: string; alt: string; caption: string; filename: string } | null;
  /** A term's slugs from the root down, for its static address. */
  termPath(taxonomyKey: string, term: { id: string; slug: string; parentId: string | null }): string[];
}

interface ProductRecord {
  typeKey: string;
  slug: string;
  locale: string;
  title: string;
  excerpt: string;
  values: Record<string, unknown>;
  terms?: Record<string, unknown>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function localeRoutePrefix(locale: string, defaultLocale: string): string {
  return locale.toLowerCase() === defaultLocale.toLowerCase() ? "" : `/${locale.toLowerCase()}`;
}

/** An image as the builder's ImageNode gives it: id, url, alt, caption, title. */
function imageNode(id: unknown, context: CmsCommerceContext, projectId: string): Record<string, unknown> | null {
  if (typeof id !== "string") return null;
  const asset = context.asset(id);
  if (!asset) return null;
  return { id: asset.id, url: `/__cms-media/${projectId}/${asset.id}`, alt: asset.alt, caption: asset.caption, title: asset.filename };
}

/** The prices as the shop writes them: the current price, formatted in the record's language and the shop's currency. */
function priceFormat(locale: string, currency: string): Intl.NumberFormat {
  try { return new Intl.NumberFormat(locale, { style: "currency", currency }); } catch { return new Intl.NumberFormat("en", { style: "currency", currency }); }
}

/**
 * `product` of a product record, with ProductNode's keys. Null for a record of another type. Prices are numbers, the
 * texts plain; there are no reviews in a project, so `rating` and `reviewCount` are 0, as WooCommerce gives them for
 * a product nobody reviewed.
 */
export function productNode(record: ProductRecord, context: CmsCommerceContext, projectId: string): Record<string, unknown> | null {
  if (record.typeKey !== PRODUCT_TYPE_KEY) return null;
  const values = record.values;
  const regularPrice = numberOrNull(values.regular_price);
  const salePrice = numberOrNull(values.sale_price);
  const onSale = regularPrice !== null && salePrice !== null && salePrice < regularPrice;
  const price = onSale ? salePrice : regularPrice;
  const stockStatus = typeof values.stock_status === "string" && values.stock_status ? values.stock_status : "instock";
  const inStock = stockStatus !== "outofstock";
  const format = priceFormat(record.locale, context.shop.currency);
  const currencySymbol = format.formatToParts(0).find((part) => part.type === "currency")?.value ?? context.shop.currency;
  // WooCommerce sells a product with a price that is not out of stock; another one only has «read more».
  const purchasable = price !== null && inStock;
  const italian = record.locale.toLowerCase().startsWith("it");
  const addToCartText = purchasable ? (italian ? "Aggiungi al carrello" : "Add to cart") : (italian ? "Leggi di più" : "Read more");
  const wordpressSlug = record.locale.toLowerCase() === context.defaultLocale.toLowerCase() ? record.slug : `${record.slug}-${record.locale.toLowerCase()}`;
  const terms = (taxonomyKey: string): Array<Record<string, unknown>> => {
    const assigned = record.terms?.[taxonomyKey];
    if (!Array.isArray(assigned)) return [];
    return assigned.flatMap((term) => {
      if (!term || typeof term !== "object") return [];
      const item = term as { id?: unknown; slug?: unknown; label?: unknown; parentId?: unknown };
      if (typeof item.id !== "string" || typeof item.slug !== "string") return [];
      const path = context.termPath(taxonomyKey, { id: item.id, slug: item.slug, parentId: typeof item.parentId === "string" ? item.parentId : null });
      return [{ id: item.id, name: item.label, slug: item.slug, taxonomy: taxonomyKey, url: `${localeRoutePrefix(record.locale, context.defaultLocale)}/${taxonomyKey}/${path.join("/")}/` }];
    });
  };
  const gallery = Array.isArray(values.gallery) ? values.gallery.map((id) => imageNode(id, context, projectId)).filter((image): image is Record<string, unknown> => image !== null) : [];
  return {
    price,
    regularPrice,
    salePrice,
    onSale,
    priceText: price === null ? "" : format.format(price),
    currency: context.shop.currency,
    currencySymbol,
    sku: typeof values.sku === "string" && values.sku ? values.sku : null,
    inStock,
    stockStatus,
    type: "simple",
    shortDescription: record.excerpt.trim(),
    addToCartUrl: context.shop.url ? `${context.shop.url}/?product=${encodeURIComponent(wordpressSlug)}` : null,
    addToCartText,
    rating: 0,
    reviewCount: 0,
    gallery,
    categories: terms("product_cat"),
    tags: terms("product_tag"),
  };
}

/** The product's main image (WooCommerce's product image) as `image`, like the builder's PostNode: null without one. */
export function productImage(record: ProductRecord, context: CmsCommerceContext, projectId: string): Record<string, unknown> | null {
  return record.typeKey === PRODUCT_TYPE_KEY ? imageNode(record.values.image, context, projectId) : null;
}
