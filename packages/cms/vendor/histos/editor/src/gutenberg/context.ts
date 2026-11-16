// What the Gutenberg side of Histeon is given by EditorLaunch (window.xbInspector), and the REST client built on it.
import { Api } from '../lib/api.ts';
import type { BuilderConfig } from '../lib/config.ts';

export interface InspectorConfig {
  restUrl: string;
  nonce: string;
  postId: number;
  builderUrl: string;
  historyUrl: string;
  releasesUrl: string;
  /** This page has changes in XB development, not yet online. */
  pending: boolean;
  /** The release online now. */
  release: string | null;
  /** Client mode (docs/spec/client-mode.md): the code shows read-only, the visual panels stay. */
  client?: boolean;
  /** Voce 186: the Aspetto groups that may write this page's own look ([]: none). */
  pageLook?: string[];
}
export const config = (window as unknown as { xbInspector?: InspectorConfig }).xbInspector;
export const api = config ? new Api({ restUrl: config.restUrl, nonce: config.nonce } as BuilderConfig) : null;

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
