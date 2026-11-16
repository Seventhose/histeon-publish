import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// The English catalog (docs/spec/i18n.md): the parts in i18n/en/, merged into one file next to the bundle. The
// builder page loads it as a script of its own (strings-en_US.js, cached like the bundle) for users who read
// English; the JSON copy is for the server (the Gutenberg inspector gets it in its configuration).
function englishCatalog(): Plugin {
  const dir = fileURLToPath(new URL('./i18n/en/', import.meta.url));
  return {
    name: 'xb-english-catalog',
    generateBundle() {
      const parts = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
      const catalog = Object.assign({}, ...parts.map((f) => JSON.parse(readFileSync(dir + f, 'utf8')) as Record<string, string>));
      this.emitFile({ type: 'asset', fileName: 'strings-en_US.json', source: JSON.stringify(catalog) });
      this.emitFile({ type: 'asset', fileName: 'strings-en_US.js', source: `window.xbStrings=${JSON.stringify(catalog)};\n` });
    },
  };
}

// The builder ships inside the plugin: fixed file names, cache-busted by the plugin with filemtime().
export default defineConfig({
  plugins: [svelte(), englishCatalog()],
  build: {
    outDir: fileURLToPath(new URL('../plugin/assets/builder', import.meta.url)),
    emptyOutDir: true,
    // No source maps in the shipped plugin: they would publish the full editor source next to the bundle.
    sourcemap: false,
    target: 'es2022',
    cssCodeSplit: false,
    // Library mode keeps the whitespace of an `es` bundle (build.minify leaves it, for tree-shaking by whoever
    // imports it); this bundle is the end of the line, so it is minified in full.
    rolldownOptions: { output: { minify: true } },
    lib: {
      entry: fileURLToPath(new URL('./src/main.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'builder.js',
      cssFileName: 'builder',
    },
  },
});
