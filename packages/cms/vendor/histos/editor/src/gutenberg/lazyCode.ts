// CodeMirror for the Gutenberg sidebar, loaded the first time a code tab opens (lista migliorie V8): the inspector
// script stays small for everyone who never opens HTML, CSS or JS there. inspector-code.js is built next to
// inspector.js (vite.gutenberg-code.config.ts) and shares its ?ver, so both change together.
import type { Code as CodeEditor } from './code.ts';
import { __, h, useEffect, useState } from './wp.ts';

type Props = Parameters<typeof CodeEditor>[0];

/** The inspector's own address, read while it runs: the code module sits next to it. */
const self = typeof document !== 'undefined' ? ((document.currentScript as HTMLScriptElement | null)?.src ?? '') : '';

/**
 * Where the code module is: beside `script`, with the same query (the version WordPress adds). Only a module of this
 * site's own Gutenberg assets is ever imported: '' for any other address (a script tag someone else put in the page).
 */
export function codeUrl(script = self, page = typeof location !== 'undefined' ? location.href : 'http://localhost/'): string {
  let url: URL;
  try {
    url = new URL('inspector-code.js' + new URL(script || page, page).search, new URL(script || page, page));
  } catch {
    return '';
  }
  return url.origin === new URL(page).origin && url.pathname.includes('/assets/gutenberg/') ? url.href : '';
}

let loading: Promise<typeof CodeEditor> | null = null;
function load(): Promise<typeof CodeEditor> {
  const url = codeUrl();
  if (!url) return Promise.reject(new Error(__('indirizzo del modulo non ammesso')));
  loading ??= import(/* @vite-ignore */ url).then(
    (m: { Code: typeof CodeEditor }) => m.Code,
    (e: unknown) => {
      loading = null; // Try again next time a code tab opens.
      throw e;
    },
  );
  return loading;
}

/** Same props as the editor itself; a line of text stands in for it while it loads. */
export function Code(props: Props) {
  const [Loaded, setLoaded] = useState<typeof CodeEditor | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    let alive = true;
    load().then(
      (c) => alive && setLoaded(() => c),
      (e: unknown) => alive && setFailed(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, []);
  if (Loaded) return h(Loaded, props);
  return h('div', { className: 'xb-code-loading', role: 'status' }, failed ? __('Editor di codice non caricato: {0}', failed) : __('Caricamento dell’editor…'));
}
