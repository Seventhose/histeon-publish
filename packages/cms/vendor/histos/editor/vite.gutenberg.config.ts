import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The XB tabs inside Gutenberg's sidebar: one classic script on WordPress's own globals (React from wp.element,
// never bundled), loaded only in the block editor for builders (plugin/src/Admin/EditorLaunch.php).
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('../plugin/assets/gutenberg', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    // The inspector is the end of the line: minified in full (CodeMirror is in inspector-code.js, see V8).
    rolldownOptions: { output: { minify: true } },
    lib: {
      entry: fileURLToPath(new URL('./src/gutenberg/main.ts', import.meta.url)),
      formats: ['iife'],
      name: 'xbInspectorBundle',
      fileName: () => 'inspector.js',
    },
  },
});
