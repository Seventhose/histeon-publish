import * as parse5 from "parse5";
import { collectCssUrls, rewriteCssUrls } from "./css.js";
import { parseSrcsetCandidates, rewriteSrcset } from "./srcset.js";
import { relativeUrl } from "./paths.js";
import { sameSiteOrigin } from "./crawler-http.js";
import type { DynamicFeature } from "./types.js";

interface HtmlAttribute { name: string; value: string }
interface HtmlNode {
  tagName?: string;
  nodeName?: string;
  attrs?: HtmlAttribute[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  value?: string;
  parentNode?: HtmlNode;
}

export interface HtmlReference {
  raw: string;
  kind: "page" | "asset";
  context: string;
}

export interface HtmlAnalysis {
  references: HtmlReference[];
  dynamicFeatures: DynamicFeature[];
  technologies: string[];
  loggedIn: boolean;
  maintenance: boolean;
  fatalOutput: boolean;
  looksHtml: boolean;
}

export interface HtmlRewriteOptions {
  pageUrl: string;
  outputPath: string;
  sourceOrigin: string;
  destinationOrigin: string;
  filesByUrl: ReadonlyMap<string, string>;
  removeEmoji?: boolean;
  hideComments?: boolean;
  wooCommerceCatalog?: boolean;
}

function walk(node: HtmlNode, visit: (item: HtmlNode) => void): void {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function getAttribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((attribute) => attribute.name.toLowerCase() === name.toLowerCase())?.value;
}

function setAttribute(node: HtmlNode, name: string, value: string): void {
  const found = node.attrs?.find((attribute) => attribute.name.toLowerCase() === name.toLowerCase());
  if (found) found.value = value;
}

function textContent(node: HtmlNode): string {
  let value = "";
  walk(node, (child) => { if (child.value) value += child.value; });
  return value;
}

function pushReference(references: HtmlReference[], raw: string, kind: HtmlReference["kind"], context: string): void {
  const value = raw.trim();
  if (!value || /^(?:data:|blob:|javascript:|mailto:|tel:|#)/iu.test(value)) return;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(value) && !/^https?:/iu.test(value)) return;
  if (!references.some((item) => item.raw === value && item.kind === kind)) references.push({ raw: value, kind, context });
}

function parseCssReferences(css: string, references: HtmlReference[], context: string): void {
  try {
    for (const value of collectCssUrls(css)) pushReference(references, value, "asset", context);
  } catch { /* The build scanner reports malformed text; keep the source page usable. */ }
}

function detectTechnologies(html: string): string[] {
  const values: string[] = [];
  if (/(?:wp-content|wp-includes|wp-emoji-release\.min\.js)/iu.test(html)) values.push("WordPress");
  if (/\bwoocommerce\b|wc\/store|wc-ajax/iu.test(html)) values.push("WooCommerce");
  if (/elementor-/iu.test(html) || /uploads\/elementor\/css/iu.test(html)) values.push("Elementor");
  if (/et_pb_|et_divi/iu.test(html)) values.push("Divi");
  if (/wpml|polylang|hreflang/iu.test(html)) values.push("WPML/Polylang");
  if (/yoast|wpseo/iu.test(html)) values.push("Yoast SEO");
  if (/rank.?math/iu.test(html)) values.push("Rank Math");
  if (/aioseo/iu.test(html)) values.push("AIOSEO");
  if (/complianz|cmplz/iu.test(html)) values.push("Complianz");
  if (/cookieyes/iu.test(html)) values.push("CookieYes");
  if (/iubenda/iu.test(html)) values.push("Iubenda");
  if (/litespeed|wp-rocket|w3-total-cache|w3tc|autoptimize|wp-super-cache/iu.test(html)) values.push("Plugin cache");
  if (/wpcf7|contact-form-7/iu.test(html)) values.push("Contact Form 7");
  if (/fluentform|fluent-forms/iu.test(html)) values.push("Fluent Forms");
  if (/static-bridge-fluent-forms/iu.test(html)) values.push("Static Bridge");
  if (/wp-content\/plugins\/xb\/|\bxb-[a-z0-9_-]+/iu.test(html)) values.push("Histeon");
  return [...new Set(values)];
}

export function analyzeHtml(html: string, file: string): HtmlAnalysis {
  const document = parse5.parse(html) as unknown as HtmlNode;
  const references: HtmlReference[] = [];
  const dynamicFeatures: DynamicFeature[] = [];
  let loggedIn = false;
  let maintenance = /briefly unavailable for scheduled maintenance|maintenance mode|coming soon|under construction/iu.test(html);
  const lower = html.toLowerCase();
  const fatalOutput = /fatal error|warning:|there has been a critical error/iu.test(html);
  const body = (() => {
    let found: HtmlNode | undefined;
    walk(document, (node) => { if (node.tagName?.toLowerCase() === "body") found = node; });
    return found;
  })();
  const bodyClass = body ? getAttribute(body, "class") ?? "" : "";
  loggedIn = /(?:^|\s)(?:logged-in|admin-bar)(?:\s|$)/u.test(bodyClass) || /id=["']wpadminbar["']/iu.test(html) || /(?:_wpnonce|X-WP-Nonce)/u.test(html);
  if (/\bwp_maintenance|maintenance-page|coming-soon/iu.test(html)) maintenance = true;

  const addDynamic = (code: string, message: string, solution: string): void => {
    if (!dynamicFeatures.some((item) => item.code === code && item.file === file)) dynamicFeatures.push({ code, file, message, solution });
  };
  if (/(?:\bwpcf7\b|contact-form-7)/iu.test(html)) addDynamic("contact-form-7", "Contact Form 7 invia i dati a WordPress e non è collegato nella copia statica.", "Usare un modulo supportato oppure rimandare al sito originale.");
  if (/(?:\bfluentform\b|fluent_forms|fluentform_submit)/iu.test(html)) addDynamic("fluent-forms", "Fluent Forms invia i dati a WordPress e richiede un collegamento attivo nella copia statica.", "Configurare il modulo Fluent Forms e verificare l’invio dopo la pubblicazione.");
  if (/(?:gform_wrapper|gravityforms|wpforms-container|elementor-form|nf-form-cont)/iu.test(html)) addDynamic("wordpress-form", "Il form richiede un endpoint dinamico di WordPress.", "Configurare una destinazione dopo aver approvato la proposta dedicata.");
  if (/<form\b/iu.test(html) && dynamicFeatures.length === 0) addDynamic("generic-form", "La pagina contiene un form che può richiedere un server.", "Controllare il campo action e configurare una destinazione prima di raccogliere invii.");
  if (/(?:role=["']search["']|class=["'][^"']*searchform|name=["']s["'])/iu.test(html)) addDynamic("search", "La ricerca WordPress usa un endpoint dinamico e non funziona automaticamente offline.", "Aggiungere una ricerca statica solo dopo una scelta esplicita.");
  if (/(?:id=["']respond["']|wp-comments-post\.php|comment-form)/iu.test(html)) addDynamic("comments", "I commenti richiedono WordPress e non vengono inviati dalla copia statica.", "Nascondere il form dei commenti o rimandare al sito originale.");
  if (/(?:cart|checkout|my-account|wc-ajax=get_refreshed_fragments|wc\/store)/iu.test(html)) addDynamic("woocommerce-dynamic", "Carrello, checkout e account WooCommerce non funzionano come pagine statiche.", "Escludere le pagine dinamiche o usare la modalità catalogo con acquisto sul sito originale.");
  if (/(?:admin-ajax\.php|wp-json\/)/iu.test(html)) addDynamic("wordpress-api", "Gli script della pagina chiamano admin-ajax.php o l’API REST di WordPress.", "Rivedere gli script segnalati e mantenere la funzione solo se il sito originale deve restare raggiungibile.");
  if (/(?:complianz|cmplz|cookieyes|iubenda)/iu.test(html)) addDynamic("cookie-consent", "Il banner cookie può apparire, ma la registrazione del consenso può dipendere da WordPress.", "Verificare il flusso di consenso sul dominio statico.");
  if (/(?:data-user|geoip|geolocation|personalized)/iu.test(html)) addDynamic("personalized-content", "La pagina può variare per utente o posizione.", "Verificare la copia con sessioni e località diverse.");

  walk(document, (node) => {
    const tag = node.tagName?.toLowerCase();
    if (tag === "html") {
      const lang = getAttribute(node, "lang");
      if (lang) maintenance ||= /^(?:en|it)$/u.test(lang) && /coming soon/iu.test(lower);
    }
    if (tag === "a" || tag === "area") {
      const href = getAttribute(node, "href");
      if (href) pushReference(references, href, "page", "href");
    }
    if (tag === "link") {
      const href = getAttribute(node, "href");
      const rel = (getAttribute(node, "rel") ?? "").toLowerCase().split(/\s+/u);
      if (href && rel.some((item) => ["stylesheet", "preload", "modulepreload", "icon", "apple-touch-icon", "manifest", "next", "alternate"].includes(item))) {
        pushReference(references, href, rel.includes("stylesheet") ? "asset" : "page", `link:${rel.join(" ")}`);
      }
    }
    if (tag === "meta") {
      const imageName = (getAttribute(node, "property") ?? getAttribute(node, "name") ?? "").toLowerCase();
      const content = getAttribute(node, "content");
      if (content && ["og:image", "og:image:url", "twitter:image", "twitter:image:src"].includes(imageName)) pushReference(references, content, "asset", `meta:${imageName}`);
    }
    for (const attribute of node.attrs ?? []) {
      const name = attribute.name.toLowerCase();
      if (["src", "poster", "data-src", "data-lazy-src", "data-original", "data-ll-bg", "data-bg-image", "data-background", "xlink:href"].includes(name)
        || (tag === "image" && name === "href")) {
        pushReference(references, attribute.value, "asset", name);
      } else if (["srcset", "data-srcset", "data-lazy-srcset"].includes(name)) {
        try {
          for (const candidate of parseSrcsetCandidates(attribute.value)) pushReference(references, candidate.url, "asset", name);
        } catch { /* Preserve malformed srcset for the output scanner. */ }
      } else if (name === "data-bg") {
        if (/url\s*\(/iu.test(attribute.value)) parseCssReferences(attribute.value, references, name);
        else pushReference(references, attribute.value, "asset", name);
      } else if (name === "style") parseCssReferences(attribute.value, references, name);
      else if (tag === "object" && name === "data") pushReference(references, attribute.value, "asset", name);
      else if (tag === "embed" && name === "src") pushReference(references, attribute.value, "asset", name);
      else if (tag === "form" && name === "action") {
        if (/wp-json|admin-ajax|wp-comments-post|contact-form/iu.test(attribute.value)) addDynamic("wordpress-api", "Il form invia i dati a un endpoint WordPress.", "Configurare una destinazione dopo aver approvato la proposta dedicata.");
      }
    }
    if (tag === "style") parseCssReferences(textContent(node), references, "style");
    if (tag === "script") {
      const src = getAttribute(node, "src") ?? "";
      if (/wp-emoji-release/iu.test(src)) pushReference(references, src, "asset", "emoji-script");
      const content = textContent(node);
      if (/(?:wpApiSettings|rest_url|admin-ajax\.php|wp-json\/)/iu.test(content)) addDynamic("wordpress-api", "Uno script contiene configurazione o chiamate all’API di WordPress.", "Rivedere lo script; la copia statica non esegue endpoint WordPress.");
    }
  });
  return {
    references,
    dynamicFeatures,
    technologies: detectTechnologies(html),
    loggedIn,
    maintenance,
    fatalOutput,
    looksHtml: /<html\b|<!doctype\s+html|<body\b/iu.test(html),
  };
}

function resolveMapping(raw: string, pageUrl: URL, filesByUrl: ReadonlyMap<string, string>): { output: string; suffix: string } | null {
  if (/^(?:data:|blob:|javascript:|mailto:|tel:|#)/iu.test(raw.trim())) return null;
  let absolute: URL;
  try { absolute = new URL(raw, pageUrl); } catch { return null; }
  if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return null;
  const suffix = `${absolute.search}${absolute.hash}`;
  absolute.search = "";
  absolute.hash = "";
  const output = filesByUrl.get(absolute.href);
  return output ? { output, suffix } : null;
}

function relativeReplacement(raw: string, pageUrl: URL, outputPath: string, filesByUrl: ReadonlyMap<string, string>): string {
  const mapped = resolveMapping(raw, pageUrl, filesByUrl);
  if (!mapped) return raw;
  return `${relativeUrl(outputPath, mapped.output)}${mapped.suffix}`;
}

function absoluteReplacement(raw: string, pageUrl: URL, destinationOrigin: string, filesByUrl: ReadonlyMap<string, string>): string {
  let absolute: URL;
  try { absolute = new URL(raw, pageUrl); } catch { return raw; }
  const mapped = resolveMapping(raw, pageUrl, filesByUrl);
  if (!mapped) return absolute.href;
  const target = new URL(`/${mapped.output.split("/").map(encodeURIComponent).join("/")}`, destinationOrigin);
  target.search = mapped.suffix.split("#")[0] ?? "";
  target.hash = mapped.suffix.includes("#") ? mapped.suffix.slice(mapped.suffix.indexOf("#")) : "";
  return target.href;
}

function rewriteJsonLd(value: unknown, pageUrl: URL, destinationOrigin: string, filesByUrl: ReadonlyMap<string, string>, key = ""): unknown {
  if (typeof value === "string") {
    if (["url", "@id"].includes(key)) return destinationPageUrl(value, pageUrl, pageUrl.origin, destinationOrigin);
    if (["logo", "image", "sameAs", "contentUrl"].includes(key)) return absoluteReplacement(value, pageUrl, destinationOrigin, filesByUrl);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteJsonLd(item, pageUrl, destinationOrigin, filesByUrl, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rewriteJsonLd(item, pageUrl, destinationOrigin, filesByUrl, name)]));
  }
  return value;
}

function rewriteEmbeddedJson(value: unknown, pageUrl: URL, outputPath: string, filesByUrl: ReadonlyMap<string, string>, key = ""): unknown {
  if (typeof value === "string" && ["src", "url", "href", "start_url", "scope", "logo", "image", "contentUrl"].includes(key)) {
    return relativeReplacement(value, pageUrl, outputPath, filesByUrl);
  }
  if (Array.isArray(value)) return value.map((item) => rewriteEmbeddedJson(item, pageUrl, outputPath, filesByUrl, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, rewriteEmbeddedJson(item, pageUrl, outputPath, filesByUrl, name)]));
  }
  return value;
}

function shouldKeepAbsolute(node: HtmlNode, tag: string | undefined, name: string): "seo-url" | "seo-asset" | "internal" {
  if (tag === "link" && name === "href" && (getAttribute(node, "rel") ?? "").toLowerCase().split(/\s+/u).includes("canonical")) return "seo-url";
  if (tag === "meta" && name === "content" && ["og:image", "og:image:url", "twitter:image", "twitter:image:src"].includes((getAttribute(node, "property") ?? getAttribute(node, "name") ?? "").toLowerCase())) return "seo-asset";
  if (tag === "link" && name === "href" && (getAttribute(node, "rel") ?? "").toLowerCase().split(/\s+/u).includes("alternate") && getAttribute(node, "hreflang")) return "seo-url";
  return "internal";
}

function destinationPageUrl(raw: string, pageUrl: URL, sourceOrigin: string, destinationOrigin: string): string {
  let absolute: URL;
  try { absolute = new URL(raw, pageUrl); } catch { return raw; }
  if (!sameSiteOrigin(absolute, sourceOrigin)) return absolute.href;
  return new URL(`${absolute.pathname}${absolute.search}${absolute.hash}`, destinationOrigin).href;
}

export function containsInputNamed(html: string, name: string): boolean {
  const wanted = name.toLowerCase();
  let found = false;
  const document = parse5.parse(html) as unknown as HtmlNode;
  walk(document, (node) => {
    if (found || node.tagName?.toLowerCase() !== "input") return;
    found = (node.attrs ?? []).some((attribute) => attribute.name.toLowerCase() === "name" && attribute.value.toLowerCase() === wanted);
  });
  return found;
}

export function rewriteCrawledHtml(html: string, options: HtmlRewriteOptions): string {
  const document = parse5.parse(html) as unknown as HtmlNode;
  const pageUrl = new URL(options.pageUrl);
  const destination = new URL(options.destinationOrigin);
  const remove = new Set<HtmlNode>();
  const replacements = new Map<HtmlNode, HtmlNode>();
  const originalPurchaseUrl = (raw?: string): string => {
    const target = new URL(pageUrl);
    if (raw) {
      try {
        const reference = new URL(raw, pageUrl);
        if (sameSiteOrigin(reference, pageUrl)) {
          const product = reference.searchParams.get("add-to-cart");
          if (product) target.searchParams.set("add-to-cart", product);
        }
      } catch { /* Fall back to the original product page. */ }
    }
    return target.href;
  };
  const originalStoreUrl = (raw: string): string => {
    try {
      const target = new URL(raw, pageUrl);
      if (sameSiteOrigin(target, pageUrl)) return target.href;
    } catch { /* Leave malformed links on the current product page. */ }
    return pageUrl.href;
  };
  const isCartLink = (raw: string): boolean => {
    try {
      const target = new URL(raw, pageUrl);
      return sameSiteOrigin(target, pageUrl) && (target.searchParams.has("add-to-cart") || /\/(?:cart|checkout|my-account)(?:\/|$)/iu.test(target.pathname));
    } catch { return false; }
  };
  walk(document, (node) => {
    const tag = node.tagName?.toLowerCase();
    const rel = (getAttribute(node, "rel") ?? "").toLowerCase();
    const name = (getAttribute(node, "name") ?? "").toLowerCase();
    const href = getAttribute(node, "href") ?? "";
    const src = getAttribute(node, "src") ?? "";
    const className = getAttribute(node, "class") ?? "";
    const isWooCartForm = tag === "form" && /(?:^|\s)cart(?:\s|$)/iu.test(className);
    if (options.wooCommerceCatalog && isWooCartForm && node.parentNode) {
      let purchaseTarget: string | undefined;
      let productId: string | undefined;
      walk(node, (child) => {
        if (child.tagName?.toLowerCase() !== "button" && child.tagName?.toLowerCase() !== "input") return;
        if (getAttribute(child, "name") === "add-to-cart") productId ??= getAttribute(child, "value");
        if (getAttribute(child, "name") === "add-to-cart" && getAttribute(child, "value")) purchaseTarget = getAttribute(child, "value");
      });
      const purchaseUrl = originalPurchaseUrl(purchaseTarget ? `?add-to-cart=${encodeURIComponent(purchaseTarget)}` : productId ? `?add-to-cart=${encodeURIComponent(productId)}` : undefined);
      const label = { nodeName: "#text", value: "Acquista sul sito originale" } as HtmlNode;
      const link: HtmlNode = {
        nodeName: "a",
        tagName: "a",
        attrs: [
          { name: "href", value: purchaseUrl },
          { name: "class", value: "histos-publish-original-store-link" },
        ],
        childNodes: [label],
        parentNode: node.parentNode,
      };
      label.parentNode = link;
      replacements.set(node, link);
      remove.add(node);
    }
    if (options.wooCommerceCatalog && tag === "a" && isCartLink(href)) {
      setAttribute(node, "href", new URL(href, pageUrl).searchParams.has("add-to-cart") ? originalPurchaseUrl(href) : originalStoreUrl(href));
      setAttribute(node, "title", "Continua l’acquisto sul sito originale");
    }
    if (node.nodeName === "meta" && name === "generator") remove.add(node);
    if (node.nodeName === "link" && (rel.includes("https://api.w.org/") || rel === "edituri" || rel === "wlwmanifest" || rel === "shortlink" || rel.includes("alternate")) && (/wp-json|rsd|wlwmanifest|shortlink/iu.test(href) || rel.includes("https://api.w.org/"))) remove.add(node);
    if (node.nodeName === "link" && (rel === "shortlink" || rel === "edituri" || rel === "wlwmanifest")) remove.add(node);
    if (tag === "script" && options.removeEmoji && /wp-emoji-release/iu.test(src)) remove.add(node);
    if (tag === "style" && options.removeEmoji && /wp-emoji-styles/iu.test(className)) remove.add(node);
    if (options.hideComments && (node.nodeName === "#comment" || /(?:^|\s)comment-respond(?:\s|$)/u.test(className) || getAttribute(node, "id") === "respond")) remove.add(node);
    if (tag === "link" && href && getAttribute(node, "hreflang")) setAttribute(node, "href", destinationPageUrl(href, pageUrl, options.sourceOrigin, destination.origin));
    if (tag === "script" && (getAttribute(node, "type") ?? "").toLowerCase() === "application/ld+json") {
      const child = node.childNodes?.find((item) => item.value !== undefined);
      if (child?.value) {
        try { child.value = JSON.stringify(rewriteJsonLd(JSON.parse(child.value), pageUrl, destination.origin, options.filesByUrl)); }
        catch { /* Leave invalid JSON-LD intact and let the report point to the source. */ }
      }
    }
    if (tag === "script" && /^(?:application|text)\/(?:json|manifest\+json)$/iu.test(getAttribute(node, "type") ?? "")) {
      const child = node.childNodes?.find((item) => item.value !== undefined);
      if (child?.value) {
        try { child.value = JSON.stringify(rewriteEmbeddedJson(JSON.parse(child.value), pageUrl, options.outputPath, options.filesByUrl)); }
        catch { /* Leave invalid embedded JSON intact. */ }
      }
    }
    if (tag === "style") {
      for (const child of node.childNodes ?? []) {
        if (child.value === undefined) continue;
        try {
          const replacements = new Map<string, string>();
          for (const raw of collectCssUrls(child.value)) replacements.set(raw, relativeReplacement(raw, pageUrl, options.outputPath, options.filesByUrl));
          child.value = rewriteCssUrls(child.value, replacements);
        } catch { /* Keep malformed CSS unchanged. */ }
      }
    }
    for (const attribute of node.attrs ?? []) {
      const attributeName = attribute.name.toLowerCase();
      if (attributeName === "srcset" || attributeName === "data-srcset" || attributeName === "data-lazy-srcset") {
        try {
          attribute.value = rewriteSrcset(attribute.value, (raw) => relativeReplacement(raw, pageUrl, options.outputPath, options.filesByUrl));
        } catch { /* Keep malformed srcset unchanged. */ }
      } else if (attributeName === "style" || (attributeName === "data-bg" && /url\s*\(/iu.test(attribute.value))) {
        try {
          const replacements = new Map<string, string>();
          for (const raw of collectCssUrls(attribute.value)) replacements.set(raw, relativeReplacement(raw, pageUrl, options.outputPath, options.filesByUrl));
          attribute.value = rewriteCssUrls(attribute.value, replacements);
        } catch { /* Keep malformed CSS unchanged. */ }
      } else if (["src", "href", "poster", "data-src", "data-lazy-src", "data-original", "data-ll-bg", "data-bg-image", "data-background", "data-bg", "xlink:href", "data"].includes(attributeName)) {
        const mode = shouldKeepAbsolute(node, tag, attributeName);
        const mapped = mode === "seo-url"
          ? destinationPageUrl(attribute.value, pageUrl, options.sourceOrigin, destination.origin)
          : mode === "seo-asset"
            ? absoluteReplacement(attribute.value, pageUrl, destination.origin, options.filesByUrl)
            : relativeReplacement(attribute.value, pageUrl, options.outputPath, options.filesByUrl);
        attribute.value = mapped;
      }
      if (tag === "image" && attributeName === "href") attribute.value = relativeReplacement(attribute.value, pageUrl, options.outputPath, options.filesByUrl);
      if (tag === "meta" && attributeName === "content") {
        const imageName = (getAttribute(node, "property") ?? getAttribute(node, "name") ?? "").toLowerCase();
        if (imageName === "og:url") attribute.value = destinationPageUrl(attribute.value, pageUrl, options.sourceOrigin, destination.origin);
        else if (["og:image", "og:image:url", "twitter:image", "twitter:image:src"].includes(imageName)) {
          attribute.value = absoluteReplacement(attribute.value, pageUrl, destination.origin, options.filesByUrl);
        }
      }
    }
  });
  if (remove.size > 0) {
    walk(document, (node) => {
      if (!node.childNodes) return;
      node.childNodes = node.childNodes.flatMap((child) => {
        const replacement = replacements.get(child);
        return replacement ? [replacement] : remove.has(child) ? [] : [child];
      });
    });
  }
  return parse5.serialize(document as never);
}
