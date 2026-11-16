// What the Histeon CSS panel needs from the place it opens in (doc 19 §5.1): the builder (tokens on the canvas) or
// the drawer over a WordPress page (tokens on the page itself). The panel never writes markup: CSS built by the
// server from validated values goes in as the text of a style element.

import type { ContrastPair, DesignParams } from '../lib/api.ts';

export interface PanelHost {
  /** The tokens these parameters change, as `:root{…}` built by the server, and the readability list. */
  preview(design: DesignParams): Promise<{ css: string; contrast?: ContrastPair[]; classesOff?: string[] }>;
  /** Shows server-built CSS where the tokens live ('' takes the preview away), without the classes switched off. */
  show(css: string, classesOff?: string[]): void;
  /** Token values as computed where they live (`--name` → value), for the swatches and samples. */
  read(names: string[]): Record<string, string>;
  /** Every token these parameters print, as the server computes them (Tokens::export): for «Esporta i token (DTCG)». */
  tokens(design: DesignParams): Promise<DesignTokens>;
}

/** The printed tokens (`xb-name` → CSS value): the light theme and, with the dark theme on, the dark one. */
export interface DesignTokens {
  light: Record<string, string>;
  dark: Record<string, string> | null;
}

/** The drawer's configuration, printed by Histeon (HistosCss\Panel) or by the standalone plugin. */
export interface DrawerConfig {
  rest: string;
  nonce: string;
  /** The Histeon CSS mark (an image URL of the plugin). */
  mark: string;
  /** The default tokens stylesheet, for the panel's swatches on pages that do not load it (the admin). */
  tokensCss: string;
  settings: string;
  active: boolean;
  savedText?: string;
  /** The user reads English: the panel takes the English texts built into the bundle. */
  english?: boolean;
}
