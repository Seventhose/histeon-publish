import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// CodeMirror for the XB tabs in Gutenberg, as an ES module loaded with import() by inspector.js the first time a
// code tab opens (src/gutenberg/lazyCode.ts). Built after inspector.js, into the same folder.
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('../plugin/assets/gutenberg', import.meta.url)),
    emptyOutDir: false,
    sourcemap: false,
    target: 'es2022',
    rolldownOptions: { output: { minify: true } },
    lib: {
      entry: fileURLToPath(new URL('./src/gutenberg/code.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'inspector-code.js',
    },
  },
});
