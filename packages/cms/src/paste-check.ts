import { checkPastedContent, type PasteProjectContext } from "./page-transfer.js";
import { inlineStyleLoadsResources } from "./transfer-markup.js";

/** At most this many style entries come with one paste. */
export const PASTE_MAX_STYLES = 500;
/**
 * At most this many bytes of content (UTF-8) in one paste. The block grammar (parseBlockGrammar, the WordPress parser's
 * tokenizer) is quadratic on a run of unclosed delimiters (`<!-- wp:xb/element {` repeated): 128 KiB of them take about
 * 0.4 s to read, and the check reads them twice (parseXb, then the blocks as written), so a paste stays under a second
 * in the worst case. A real paste is a few KiB.
 */
export const PASTE_MAX_CONTENT_BYTES = 128 * 1024;
const PASTE_MAX_SELECTOR = 1024;
const PASTE_MAX_CSS = 64 * 1024;

export interface PasteCheckInput {
  content: string;
  styles: Array<{ selector: string; css: string }>;
}

/** Why a paste from outside the builder tab was refused (`reason`: what, for tests and logs). */
export class PasteRefusedError extends TypeError {
  readonly reason: "invalid" | "too-large" | "markup" | "styles";

  constructor(reason: "invalid" | "too-large" | "markup" | "styles", message: string) {
    super(message);
    this.name = "PasteRefusedError";
    this.reason = reason;
  }
}

/**
 * The local CMS's `POST paste/sanitize` (the builder's restricted tier for the clipboard, docs/spec/quick-actions.md):
 * whatever the tab did not copy itself comes here before it enters the document. Histeon Publish does not filter it
 * into something else: it takes it whole when the project could transfer its content (checkPastedContent: the rules of
 * a transfer, media of this project only, address attributes dynamic only as a whole data path) and its styles load
 * nothing, and refuses it otherwise with the first reason, so the editor pastes nothing (its own rule when the check
 * fails).
 */
export function checkPaste(body: unknown, project: PasteProjectContext): PasteCheckInput {
  const input = body as { content?: unknown; styles?: unknown } | null;
  if (!input || typeof input !== "object" || typeof input.content !== "string" || (input.styles !== undefined && !Array.isArray(input.styles))) {
    throw new PasteRefusedError("invalid", "Il contenuto incollato non è valido.");
  }
  if (Buffer.byteLength(input.content, "utf8") > PASTE_MAX_CONTENT_BYTES) {
    throw new PasteRefusedError("too-large", `Il contenuto incollato supera ${PASTE_MAX_CONTENT_BYTES / 1024} KiB: incollalo a pezzi, una sezione alla volta.`);
  }
  const rawStyles = (input.styles ?? []) as unknown[];
  if (rawStyles.length > PASTE_MAX_STYLES) throw new PasteRefusedError("invalid", `Il contenuto incollato porta più di ${PASTE_MAX_STYLES} stili.`);
  const styles = rawStyles.map((entry) => {
    const style = entry as { selector?: unknown; css?: unknown } | null;
    if (!style || typeof style !== "object" || typeof style.selector !== "string" || typeof style.css !== "string" || style.selector.length > PASTE_MAX_SELECTOR || style.css.length > PASTE_MAX_CSS) {
      throw new PasteRefusedError("invalid", "Uno stile incollato non è valido.");
    }
    return { selector: style.selector, css: style.css };
  });
  try {
    checkPastedContent(input.content, project);
  } catch (error) {
    // TransferMarkupError is a TypeError; a document nested past parseXb's limit is a RangeError.
    if (error instanceof TypeError || error instanceof RangeError) throw new PasteRefusedError("markup", `Il contenuto incollato non entra: ${error.message}`);
    throw error;
  }
  for (const style of styles) {
    // Selector and declarations together, held to the rule of a transferred `style` attribute (G7): neither may load a
    // resource (url(), image-set(), @import…), run an active behaviour or hide one in a comment.
    if (inlineStyleLoadsResources(`${style.selector}{${style.css}}`)) {
      throw new PasteRefusedError("styles", `Lo stile incollato per ${style.selector.slice(0, 80)} carica risorse o contiene commenti: Histeon Publish non lo accetta da fuori.`);
    }
  }
  return { content: input.content, styles };
}
