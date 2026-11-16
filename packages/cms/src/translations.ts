/**
 * The languages of a project (doc 20): what is the same in the store, the build, the server and the connector. Every
 * language of a content is a normal page, post or record; `cms_translations` links it to its original.
 */

export interface CmsProjectLanguage {
  code: string;
  label: string;
}

/** The site's language (render.locale) and the others, as the project lists them. */
export interface CmsProjectLanguages {
  defaultLanguage: CmsProjectLanguage;
  languages: CmsProjectLanguage[];
}

export type CmsTranslationKind = "page" | "post" | "record";
export type CmsTranslationMode = "follow" | "independent";
/** How a translation stands; `missing` belongs to a language with no version. */
export type CmsTranslationState = "missing" | "draft" | "published" | "stale";

export interface CmsTranslationLink {
  translationId: string;
  sourceId: string;
  kind: CmsTranslationKind;
  language: string;
  mode: CmsTranslationMode;
  sourceHash: string;
  createdAt: string;
  updatedAt: string;
}

export const CMS_MAX_PROJECT_LANGUAGES = 30;
const LANGUAGE_LABEL_MAX = 40;
const LANGUAGE_CODE_MAX = 35;

/**
 * The canonical form of a language of a project. The route prefix is this code in lower case, so the primary subtag
 * has 2 or 3 letters: no code can be `blog`, `media` or `pagefind`.
 */
export function canonicalProjectLanguage(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > LANGUAGE_CODE_MAX) throw new TypeError("La lingua deve essere un codice BCP 47, per esempio en o pt-BR.");
  let code: string | undefined;
  try { code = Intl.getCanonicalLocales(value)[0]; } catch { code = undefined; }
  if (!code || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/u.test(code)) throw new TypeError("La lingua deve essere un codice BCP 47, per esempio en o pt-BR.");
  return code;
}

/** A language's own name ("Deutsch", "Italiano"), or its code when the runtime does not know it. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language", languageDisplay: "standard" }).of(new Intl.Locale(code).language);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch { /* An unknown code keeps its own form. */ }
  return code;
}

function languageLabel(value: unknown, code: string): string {
  if (value === undefined || value === null || value === "") return languageName(code);
  if (typeof value !== "string") throw new TypeError("Il nome di una lingua deve essere testo.");
  const label = value.replace(/[\p{Cc}<>]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!label || label.length > LANGUAGE_LABEL_MAX) throw new TypeError(`Il nome di una lingua ha da 1 a ${LANGUAGE_LABEL_MAX} caratteri.`);
  return label;
}

/** The languages a project lists besides its own: checked, one each, its own language left out. */
export function normalizeProjectLanguages(value: unknown, defaultLocale: string): CmsProjectLanguage[] {
  const list = value && typeof value === "object" && !Array.isArray(value) ? (value as { languages?: unknown }).languages : value;
  if (!Array.isArray(list) || list.length > CMS_MAX_PROJECT_LANGUAGES) throw new TypeError(`Un progetto ha al massimo ${CMS_MAX_PROJECT_LANGUAGES} lingue.`);
  const seen = new Map<string, CmsProjectLanguage>();
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Lingua del progetto non valida.");
    const code = canonicalProjectLanguage((item as { code?: unknown }).code);
    if (code.toLowerCase() === defaultLocale.toLowerCase()) continue;
    if (seen.has(code.toLowerCase())) throw new TypeError(`La lingua ${code} è ripetuta.`);
    seen.set(code.toLowerCase(), { code, label: languageLabel((item as { label?: unknown }).label, code) });
  }
  return [...seen.values()];
}

/** The folder of a language in the static site: none for the site's own. */
export function languageRoutePrefix(locale: string | null, defaultLocale: string): string {
  return locale === null || locale.toLowerCase() === defaultLocale.toLowerCase() ? "" : `/${locale.toLowerCase()}`;
}

/** The address of a page ("/", "/chi-siamo/", "/en/", "/en/about/"). */
export function pageAddress(page: { slug: string; locale?: string | null }, defaultLocale: string): string {
  const prefix = languageRoutePrefix(page.locale ?? null, defaultLocale);
  return page.slug === "home" ? `${prefix}/` : `${prefix}/${page.slug}/`;
}

/** The address of a post ("/blog/ciao/", "/en/blog/hello/"). */
export function postAddress(post: { slug: string; locale?: string | null }, defaultLocale: string): string {
  return `${languageRoutePrefix(post.locale ?? null, defaultLocale)}/blog/${post.slug}/`;
}

/** The address of a page or post. */
export function documentAddress(document: { slug: string; locale?: string | null; documentType: "page" | "post" }, defaultLocale: string): string {
  return document.documentType === "post" ? postAddress(document, defaultLocale) : pageAddress(document, defaultLocale);
}
