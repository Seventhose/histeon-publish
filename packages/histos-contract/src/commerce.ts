/*
 * Products (queue C6, docs/progettazione/histos-cms/15-coda-import-html.md): a content type with the key `product` is
 * the shop's catalogue, the WooCommerce `product` post type on WordPress. Its fields are fixed, so a project, a
 * transfer and WordPress always agree on them; the WordPress side mirrors these rules in
 * plugin/src/Remote/ProductProfile.php of the builder. Catalogue only: never orders, customers, carts or stock
 * movements.
 */
import { canonicalizeJson, type JsonValue } from "./canonical-json.js";

/** The product type's key: WooCommerce's post type. */
export const PRODUCT_TYPE_KEY = "product";
/** WooCommerce's product categories and tags: attached to products only, like category and post_tag to posts. */
export const PRODUCT_TAXONOMIES = ["product_cat", "product_tag"] as const;
/** What a transfer with products requires, and what a WordPress site with WooCommerce active declares. */
export const PRODUCT_CAPABILITY = "commerce:products:v1";
/** WooCommerce's stock statuses: a status only, never quantities or stock movements. */
export const PRODUCT_STOCK_STATUSES = ["instock", "outofstock", "onbackorder"] as const;
/** The highest price a product takes, and its decimals (WooCommerce stores prices as decimal text). */
export const PRODUCT_MAX_PRICE = 999_999_999;
export const PRODUCT_PRICE_DECIMALS = 4;
/** A SKU: letters, digits, `.`, `_`, `-` and `/`, starting with a letter or digit, at most 64 characters. */
export const PRODUCT_SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u;
export const PRODUCT_MAX_GALLERY = 20;

export interface ProductFieldDefinition {
  key: string;
  label: string;
  type: "decimal" | "text" | "enum" | "asset";
  required: false;
  public: true;
  multiple: boolean;
  options?: string[];
}

/**
 * The product type's fields, in their order. The short description is the record's excerpt; the categories and tags
 * are the product_cat and product_tag taxonomies.
 */
export const PRODUCT_FIELDS: readonly ProductFieldDefinition[] = Object.freeze([
  { key: "regular_price", label: "Prezzo", type: "decimal", required: false, public: true, multiple: false },
  { key: "sale_price", label: "Prezzo scontato", type: "decimal", required: false, public: true, multiple: false },
  { key: "sku", label: "SKU", type: "text", required: false, public: true, multiple: false },
  { key: "stock_status", label: "Disponibilità", type: "enum", required: false, public: true, multiple: false, options: [...PRODUCT_STOCK_STATUSES] },
  { key: "image", label: "Immagine", type: "asset", required: false, public: true, multiple: false },
  { key: "gallery", label: "Galleria", type: "asset", required: false, public: true, multiple: true },
] satisfies ProductFieldDefinition[]);

/** The product fields as a transfer or a project writes them. */
export function productFields(): ProductFieldDefinition[] {
  return PRODUCT_FIELDS.map((field) => ({ ...field, ...(field.options ? { options: [...field.options] } : {}) }));
}

/** Whether `fields` are exactly the product fields (keys, labels, types, flags, options and order). */
export function isProductFields(fields: unknown): boolean {
  try {
    return canonicalizeJson(fields as JsonValue) === canonicalizeJson(productFields() as unknown as JsonValue);
  } catch {
    return false;
  }
}

/** A price as WooCommerce keeps it without loss: a number from 0 to PRODUCT_MAX_PRICE with at most 4 decimals. */
export function isProductPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= PRODUCT_MAX_PRICE && Number(value.toFixed(PRODUCT_PRICE_DECIMALS)) === value;
}

/** Plain text a product shows (its title, its short description): no markup. */
export function isProductPlainText(value: unknown): boolean {
  return typeof value === "string" && !/[<>]/u.test(value);
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
}

/**
 * The problems of one product's data beyond its field types, in Italian, each naming the field: prices, the SKU, the
 * stock status, the gallery and plain text in the title and the short description. Empty when it is valid.
 */
export function productValueIssues(input: { title: unknown; excerpt: unknown; values: Record<string, unknown> }): string[] {
  const issues: string[] = [];
  const values = input.values;
  const regular = values.regular_price;
  const sale = values.sale_price;
  for (const [key, value] of [["regular_price", regular], ["sale_price", sale]] as const) {
    if (present(value) && !isProductPrice(value)) issues.push(`${key}: un prezzo è un numero (senza virgolette) da 0 a ${PRODUCT_MAX_PRICE}, con al massimo ${PRODUCT_PRICE_DECIMALS} decimali.`);
  }
  if (present(sale) && !present(regular)) issues.push("sale_price: un prezzo scontato vuole anche regular_price, il prezzo pieno.");
  else if (isProductPrice(sale) && isProductPrice(regular) && sale >= regular) issues.push("sale_price: il prezzo scontato è minore del prezzo pieno (regular_price).");
  if (present(values.sku) && (typeof values.sku !== "string" || !PRODUCT_SKU.test(values.sku))) issues.push("sku: lettere, cifre, «.», «_», «-» e «/», al massimo 64 caratteri, e comincia con una lettera o una cifra.");
  if (present(values.stock_status) && !(PRODUCT_STOCK_STATUSES as readonly unknown[]).includes(values.stock_status)) issues.push(`stock_status: uno fra ${PRODUCT_STOCK_STATUSES.join(", ")}.`);
  const gallery = values.gallery;
  if (Array.isArray(gallery)) {
    if (gallery.length > PRODUCT_MAX_GALLERY) issues.push(`gallery: al massimo ${PRODUCT_MAX_GALLERY} immagini.`);
    if (new Set(gallery).size !== gallery.length) issues.push("gallery: un'immagine è ripetuta.");
  }
  if (!isProductPlainText(input.title)) issues.push("title: il nome di un prodotto è testo, senza markup (< e >).");
  if (!isProductPlainText(input.excerpt)) issues.push("excerpt: la descrizione breve di un prodotto è testo, senza markup (< e >).");
  return issues;
}

/** The SKU of a product's values, when it has one. */
export function productSku(values: Record<string, unknown>): string | null {
  return typeof values.sku === "string" && values.sku !== "" ? values.sku : null;
}

/** Whether a transfer's entities need PRODUCT_CAPABILITY: a product type or WooCommerce's product taxonomies. */
export function transferUsesProducts(entities: ReadonlyArray<{ kind: string; payload: Record<string, JsonValue> }>): boolean {
  return entities.some((entity) => (entity.kind === "content-type" && entity.payload.key === PRODUCT_TYPE_KEY)
    || (entity.kind === "taxonomy" && (PRODUCT_TAXONOMIES as readonly JsonValue[]).includes(entity.payload.key ?? null)));
}
