import type { Language } from "./i18n.js";

/**
 * What a content of a linked site is, in words, and the group it goes in (doc 23 items 197, 199, 200): a page and a
 * post are told apart, everything else by its kind. Unknown kinds keep a generic name: the kind comes from the site.
 */
const KINDS: Record<string, { it: [string, string]; en: [string, string]; order: number }> = {
  page: { it: ["Pagina", "Pagine"], en: ["Page", "Pages"], order: 0 },
  post: { it: ["Articolo", "Articoli"], en: ["Post", "Posts"], order: 1 },
  document: { it: ["Pagina o articolo", "Pagine e articoli"], en: ["Page or post", "Pages and posts"], order: 2 },
  "content-record": { it: ["Contenuto", "Contenuti"], en: ["Content entry", "Content entries"], order: 3 },
  component: { it: ["Componente", "Componenti"], en: ["Component", "Components"], order: 4 },
  "template-part": { it: ["Parte di template", "Parti di template"], en: ["Template part", "Template parts"], order: 5 },
  template: { it: ["Template", "Template"], en: ["Template", "Templates"], order: 6 },
  asset: { it: ["Media", "Media"], en: ["Media file", "Media"], order: 7 },
  styles: { it: ["Stili", "Stili"], en: ["Styles", "Styles"], order: 8 },
  "content-type": { it: ["Tipo di contenuto", "Tipi di contenuto"], en: ["Content type", "Content types"], order: 9 },
  taxonomy: { it: ["Tassonomia", "Tassonomie"], en: ["Taxonomy", "Taxonomies"], order: 10 },
  term: { it: ["Termine", "Termini"], en: ["Term", "Terms"], order: 11 },
  "query-preset": { it: ["Query", "Query"], en: ["Query", "Queries"], order: 12 },
  query: { it: ["Query", "Query"], en: ["Query", "Queries"], order: 12 },
  "query-source": { it: ["Sorgente di dati", "Sorgenti di dati"], en: ["Data source", "Data sources"], order: 13 },
  tombstone: { it: ["Cancellazione", "Cancellazioni"], en: ["Deletion", "Deletions"], order: 14 },
  project: { it: ["Progetto", "Progetto"], en: ["Project", "Project"], order: 15 },
  site: { it: ["Sito", "Sito"], en: ["Site", "Site"], order: 16 },
};
const OTHER = { it: ["Contenuto del sito", "Altri contenuti"] as [string, string], en: ["Site content", "Other content"] as [string, string], order: 99 };

export function contentKind(kind: string, documentType?: string): string {
  return kind === "document" && (documentType === "page" || documentType === "post") ? documentType : kind;
}

export function kindName(language: Language, kind: string, plural = false): string {
  const entry = KINDS[kind] ?? OTHER;
  return (language === "it" ? entry.it : entry.en)[plural ? 1 : 0];
}

export function groupByKind<T>(items: readonly T[], kindOf: (item: T) => string): Array<{ kind: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const kind = KINDS[kindOf(item)] ? kindOf(item) : "other";
    groups.set(kind, [...(groups.get(kind) ?? []), item]);
  }
  return [...groups].map(([kind, grouped]) => ({ kind, items: grouped }))
    .sort((left, right) => (KINDS[left.kind]?.order ?? OTHER.order) - (KINDS[right.kind]?.order ?? OTHER.order));
}
