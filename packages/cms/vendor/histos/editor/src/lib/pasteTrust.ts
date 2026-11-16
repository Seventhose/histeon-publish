import { parseXb, serializeXb, type XbBlock } from '@xb/dsl';
import type { Clip } from './clip.ts';

/**
 * What comes from the clipboard was written by whoever wrote it last: any page can set it from its own copy event.
 * Before it enters the document it goes through the server's restricted tier (POST /paste/sanitize), whoever pastes
 * it. The only exception is what this very tab copied: the builder remembers it and takes it back as it was.
 */
let copiedHereText = '';

export function rememberCopy(text: string): void {
  copiedHereText = text;
}

export function copiedHere(text: string): boolean {
  return text !== '' && text === copiedHereText;
}

interface PasteSanitizer {
  sanitizePaste(content: string, styles: Array<{ selector: string; css: string }>): Promise<{ content: string; styles: Array<{ selector: string; css: string }> }>;
}

/** Blocks and styles from outside this tab, held to the restricted tier by the server. */
export async function restrictPaste(api: PasteSanitizer, blocks: XbBlock[], styles: Array<{ selector: string; css: string }> = []): Promise<{ blocks: XbBlock[]; styles: Array<{ selector: string; css: string }> }> {
  const clean = await api.sanitizePaste(serializeXb(blocks), styles);
  return { blocks: parseXb(clean.content).blocks, styles: clean.styles };
}

/** A clip from outside this tab, with its markup and styles restricted. */
export async function restrictClip(api: PasteSanitizer, clip: Clip): Promise<Clip> {
  const clean = await api.sanitizePaste(clip.markup, clip.styles);
  return { ...clip, markup: clean.content, styles: clean.styles };
}
