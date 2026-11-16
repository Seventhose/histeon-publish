import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The Histeon CSS drawer (src/histos-css/drawer.ts) on its own: one classic script, its Svelte styles injected
// into the drawer's shadow root, and the English texts of the panel's sources picked from i18n/en (the drawer
// runs on WordPress pages, without the builder's catalog).
const sources = fileURLToPath(new URL('./src/histos-css/', import.meta.url));
const i18n = fileURLToPath(new URL('./i18n/en/', import.meta.url));

export function panelEnglish(): Record<string, string> {
  const text = readdirSync(sources).map((f) => readFileSync(sources + f, 'utf8')).join('\n');
  const catalog: Record<string, string> = Object.assign({}, ...readdirSync(i18n).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(i18n + f, 'utf8'))));
  const quoted = (s: string) => [`'${s.replace(/'/g, "\\'")}'`, `"${s}"`, `\`${s}\``].some((q) => text.includes(q));
  // Frames built in options.ts from a step or a level (`Testo xs: {0}`, `H2: {0}`) are not literals there.
  const framed = (it: string) => /^(?:Testo [0-9a-z]+|Ombra(?: del testo)? [0-9a-z]+|Sovrapposizione [23]|H[1-6]|Superficie [1-3]): \{0\}$/.test(it) || it.startsWith('Icone: misura ');
  return Object.fromEntries(Object.entries(catalog).filter(([it]) => quoted(it) || framed(it)));
}

export default defineConfig({
  plugins: [svelte({ compilerOptions: { css: 'injected' } })],
  define: { __HISTOS_CSS_EN__: JSON.stringify(panelEnglish()) },
  build: {
    outDir: fileURLToPath(new URL('../plugin/assets/builder/histos-css', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    copyPublicDir: false,
    rolldownOptions: { output: { minify: true } },
    lib: {
      entry: fileURLToPath(new URL('./src/histos-css/drawer.ts', import.meta.url)),
      formats: ['iife'],
      name: 'XBHistosCssDrawer',
      fileName: () => 'panel.js',
    },
  },
});
