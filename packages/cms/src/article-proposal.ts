import { type ArticleBlock, readArticle, writeArticle } from "./article-document.js";
import type { CardRules } from "./article-cards.js";

/**
 * Doc 23 item 94: a rewrite of an article the agent proposes (a draft, titles, a summary) and the writer accepts block
 * by block in the article editor. The agent never writes the article: what it sends is checked as a save from the
 * editor would be (blocks only, no markup, images only from the project's media) and kept aside until the writer
 * accepts or discards each part. The proposal is no part of the site and never travels.
 */
export interface ArticleProposal {
  /** The article's revision the agent read: the editor says when the article changed since. */
  head: string;
  title?: string;
  /** Only for posts: pages have no summary. */
  excerpt?: string;
  /** The whole article as the agent would have it, read back as the editor reads a saved article. */
  blocks?: ArticleBlock[];
  /** What the agent says about its proposal, shown as text. */
  note?: string;
  createdAt: string;
}

export const ARTICLE_PROPOSAL_LIMITS = { title: 500, excerpt: 2000, note: 1000 } as const;

/** One line or a paragraph of plain text: no markup, no control characters, trimmed to its limit. */
function plainText(value: unknown, label: string, max: number, oneLine: boolean): string {
  if (typeof value !== "string") throw new TypeError(`${label} non è un testo.`);
  if (/[<>]/u.test(value)) throw new TypeError(`${label} è testo semplice, senza tag.`);
  const text = value.replace(oneLine ? /[\p{Cc}]+/gu : /[^\P{Cc}\n]+/gu, " ").replace(/[ \t]+/gu, " ").trim();
  if (!text) throw new TypeError(`${label} è vuoto.`);
  if ([...text].length > max) throw new TypeError(`${label} supera i ${max} caratteri.`);
  return text;
}

/**
 * The proposal for an article whose saved document is `content` at revision `head`, checked. Throws a TypeError with
 * the reason when anything in it would not be accepted by a save.
 */
export function makeArticleProposal(
  content: string,
  head: string,
  input: { head?: unknown; title?: unknown; excerpt?: unknown; blocks?: unknown; note?: unknown },
  options: { post: boolean; mediaBase: string; rulesOf: (ref: string) => CardRules | null; now?: () => Date },
): ArticleProposal {
  if (input.head !== head) throw new TypeError("L'articolo è cambiato dopo che l'hai letto: rileggilo e proponi di nuovo.");
  const proposal: ArticleProposal = { head, createdAt: (options.now?.() ?? new Date()).toISOString() };
  if (input.title !== undefined) proposal.title = plainText(input.title, "Il titolo", ARTICLE_PROPOSAL_LIMITS.title, true);
  if (input.excerpt !== undefined) {
    if (!options.post) throw new TypeError("Una pagina non ha riassunto: proponilo solo per un articolo.");
    proposal.excerpt = plainText(input.excerpt, "Il riassunto", ARTICLE_PROPOSAL_LIMITS.excerpt, false);
  }
  if (input.note !== undefined) proposal.note = plainText(input.note, "La nota", ARTICLE_PROPOSAL_LIMITS.note, false);
  if (input.blocks !== undefined) {
    // Written as a save would write it, then read back: the editor shows exactly what accepting would save.
    const written = writeArticle(content, input.blocks, { mediaBase: options.mediaBase, rulesOf: options.rulesOf });
    proposal.blocks = readArticle(written).blocks;
  }
  if (proposal.title === undefined && proposal.excerpt === undefined && proposal.blocks === undefined) throw new TypeError("La proposta è vuota: manda il testo, il titolo o il riassunto.");
  return proposal;
}

/** A stored proposal read back, or null when it is not one (an older or damaged value is dropped, never trusted). */
export function readArticleProposal(value: string | null | undefined): ArticleProposal | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ArticleProposal>;
    if (typeof parsed.head !== "string" || typeof parsed.createdAt !== "string") return null;
    if (parsed.blocks !== undefined && !Array.isArray(parsed.blocks)) return null;
    return parsed as ArticleProposal;
  } catch {
    return null;
  }
}
