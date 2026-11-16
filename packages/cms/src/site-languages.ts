import { languageRoutePrefix, type CmsProjectLanguages } from "./translations.js";

/**
 * What a static build knows about its languages (doc 20 §5.5, §5.6): which address is which version of what, so that a
 * page gets `data.lingua`, its `hreflang` links and its line of the sitemap. It only reads what it is given: published
 * contents and the routes of the build's plan.
 */

export interface SiteLanguageContent {
  /** The original's id: the versions of one content share it. */
  group: string;
  language: string;
  address: string;
}

export interface SiteLanguageAlternate {
  code: string;
  name: string;
  url: string;
  current: boolean;
  /** The same content in that language; otherwise `url` is only that language's home. */
  equivalent: boolean;
}

export interface SiteLanguageData {
  code: string;
  name: string;
  default: boolean;
  alternates: SiteLanguageAlternate[];
}

/** The key of a route, as the plan keeps them: no slashes around it, lower case. */
function routeKey(address: string): string {
  return address.replace(/^\/+|\/+$/gu, "").toLowerCase();
}

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** Addresses are ours (slugs, codes), but every one goes through this on its way into HTML. */
function htmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export class SiteLanguages {
  private readonly all: Array<{ code: string; name: string; prefix: string }>;
  private readonly groupOfAddress = new Map<string, string>();
  private readonly addressesOfGroup = new Map<string, Map<string, string>>();
  private readonly routes: ReadonlySet<string>;
  private readonly defaultCode: string;
  private readonly siteUrl: string | null;
  private readonly links = new Map<string, ReadonlyMap<string, string>>();
  private readonly strings = new Map<string, ReadonlyMap<string, string>>();
  private readonly readStrings: (language: string) => ReadonlyMap<string, string>;

  constructor(input: { languages: CmsProjectLanguages; contents: readonly SiteLanguageContent[]; routes: Iterable<string>; siteUrl: string | null; strings?: (language: string) => ReadonlyMap<string, string> }) {
    this.readStrings = input.strings ?? (() => new Map());
    this.defaultCode = input.languages.defaultLanguage.code;
    this.siteUrl = input.siteUrl;
    this.routes = new Set(input.routes);
    this.all = [input.languages.defaultLanguage, ...input.languages.languages].map((language) => ({ code: language.code, name: language.label, prefix: languageRoutePrefix(language.code, this.defaultCode) }));
    for (const content of input.contents) {
      this.groupOfAddress.set(routeKey(content.address), content.group);
      const addresses = this.addressesOfGroup.get(content.group) ?? new Map<string, string>();
      addresses.set(content.language.toLowerCase(), content.address);
      this.addressesOfGroup.set(content.group, addresses);
    }
  }

  /** Whether the project has more than one language: without that a build carries nothing of this. */
  get active(): boolean {
    return this.all.length > 1;
  }

  /** The language an address belongs to, by its folder. */
  private languageOf(address: string): { code: string; name: string; prefix: string } {
    const key = routeKey(address);
    return this.all.find((language) => language.prefix && (key === language.prefix.slice(1) || key.startsWith(`${language.prefix.slice(1)}/`))) ?? this.all[0]!;
  }

  /** Each language's version of the page at `address`: its translation, the same archive there, or that language's home. */
  private alternates(address: string, currentCode: string): SiteLanguageAlternate[] {
    const key = routeKey(address);
    const group = this.groupOfAddress.get(key);
    const versions = group ? this.addressesOfGroup.get(group) : undefined;
    const own = this.languageOf(address);
    const tail = key.slice(own.prefix ? own.prefix.length : 0).replace(/^\/+/u, "");
    return this.all.flatMap((language): SiteLanguageAlternate[] => {
      if (language.code.toLowerCase() === currentCode.toLowerCase()) return [{ code: language.code, name: language.name, url: address, current: true, equivalent: true }];
      const version = versions?.get(language.code.toLowerCase());
      if (version) return [{ code: language.code, name: language.name, url: version, current: false, equivalent: true }];
      // A page of its own has no twin by its address: only an archive, the same in every language, does.
      const same = group === undefined && !key.endsWith("404.html") ? `${language.prefix}/${tail ? `${tail}/` : ""}` : null;
      if (same && this.routes.has(routeKey(same)) && !this.groupOfAddress.has(routeKey(same))) return [{ code: language.code, name: language.name, url: same, current: false, equivalent: true }];
      const home = `${language.prefix}/`;
      return this.routes.has(routeKey(home)) ? [{ code: language.code, name: language.name, url: home, current: false, equivalent: false }] : [];
    });
  }

  /**
   * Where each internal address leads on a page in `language` (localizeHtml): every version of a content to the one in
   * that language, and every other route of the site's language to its twin there. What has no version stays as it is.
   */
  linksIn(language: string): ReadonlyMap<string, string> {
    const key = language.toLowerCase();
    const cached = this.links.get(key);
    if (cached) return cached;
    const links = new Map<string, string>();
    const target = this.all.find((item) => item.code.toLowerCase() === key);
    if (target?.prefix) {
      for (const route of this.routes) {
        if (route.endsWith("404.html") || this.languageOf(`/${route}/`).prefix) continue;
        const twin = `${target.prefix}/${route ? `${route}/` : ""}`;
        if (this.routes.has(routeKey(twin)) && !this.groupOfAddress.has(route)) links.set(route ? `/${route}/` : "/", twin);
      }
      for (const versions of this.addressesOfGroup.values()) {
        const version = versions.get(key);
        if (!version) continue;
        for (const address of versions.values()) if (address !== version) links.set(address, version);
      }
    }
    this.links.set(key, links);
    return links;
  }

  /** The published strings of a language, read once per build. */
  stringsIn(language: string): ReadonlyMap<string, string> {
    const strings = this.strings.get(language) ?? this.readStrings(language);
    this.strings.set(language, strings);
    return strings;
  }

  /** The language of an address, for the build's last pass; null for the site's own. */
  otherLanguageOf(address: string): string | null {
    const language = this.languageOf(address);
    return language.prefix ? language.code : null;
  }

  /** `data.lingua` of the page at `address`, the shape Lingua Bridge gives on WordPress (docs/spec/multilingual.md). */
  data(address: string, locale: string): SiteLanguageData | null {
    if (!this.active) return null;
    const language = this.all.find((item) => item.code.toLowerCase() === locale.toLowerCase());
    return { code: language?.code ?? locale, name: language?.name ?? locale, default: locale.toLowerCase() === this.defaultCode.toLowerCase(), alternates: this.alternates(address, locale) };
  }

  private absolute(address: string): string {
    return this.siteUrl ? `${this.siteUrl}${address}` : address;
  }

  /** The `<link rel="alternate">` of a page, or nothing when it has no version in another language. */
  headLinksOf(address: string): string {
    if (!this.active) return "";
    const versions = this.alternates(address, this.languageOf(address).code).filter((item) => item.equivalent);
    if (versions.length < 2) return "";
    const defaultVersion = versions.find((item) => item.code === this.defaultCode) ?? versions[0]!;
    return [...versions.map((item) => `<link rel="alternate" hreflang="${htmlAttribute(item.code)}" href="${htmlAttribute(this.absolute(item.url))}">`), `<link rel="alternate" hreflang="x-default" href="${htmlAttribute(this.absolute(defaultVersion.url))}">`].join("");
  }

  /** The sitemap of `addresses`, every page with its versions; null without the site's address, which it must have. */
  sitemap(addresses: readonly string[]): string | null {
    if (!this.siteUrl) return null;
    const lines = addresses.map((address) => {
      const language = this.languageOf(address);
      const versions = this.active ? this.alternates(address, language.code).filter((item) => item.equivalent) : [];
      const links = versions.length > 1 ? versions.map((item) => `<xhtml:link rel="alternate" hreflang="${xmlText(item.code)}" href="${xmlText(this.absolute(item.url))}"/>`).join("") : "";
      return `<url><loc>${xmlText(this.absolute(address))}</loc>${links}</url>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${lines.join("")}</urlset>\n`;
  }

  /** robots.txt with the sitemap's line, or null. */
  robots(): string | null {
    return this.siteUrl ? `User-agent: *\nAllow: /\n\nSitemap: ${this.siteUrl}/sitemap.xml\n` : null;
  }
}

/**
 * The site's address (doc 20 §5.6), with no slash at the end: https, http only for a local site, no credentials, path,
 * query or fragment. The build writes it into links and never contacts it.
 */
export function normalizeSiteUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 253 + 16) throw new TypeError("L'indirizzo del sito non è valido.");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new TypeError("L'indirizzo del sito non è valido: scrivilo per intero, con https://."); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new TypeError("L'indirizzo del sito comincia con https:// (http:// solo per un sito locale).");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new TypeError("L'indirizzo del sito è solo il dominio, senza percorso, parametri o credenziali.");
  return url.origin;
}
