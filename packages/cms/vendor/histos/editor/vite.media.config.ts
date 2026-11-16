import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// The licences of the image codecs (lista migliorie M5, docs/policy/PROVENANCE.md), next to the .wasm files they
// cover: jSquash's and wasm-feature-detect's from their packages, those of the libraries compiled into the modules
// from editor/licenses/ (the upstream texts, as Histeon Publish ships them).
function codecLicences(): Plugin {
  const modules = fileURLToPath(new URL('../node_modules/', import.meta.url));
  const own = fileURLToPath(new URL('./licenses/', import.meta.url));
  const fromPackages: Array<[string, string]> = [
    ['@jsquash/avif/LICENSE', 'jsquash-Apache-2.0.txt'],
    ['@jsquash/webp/codec/LICENSE.codec.md', 'libwebp-BSD-3-Clause.md'],
    ['@jsquash/resize/lib/resize/LICENSE.codec.md', 'resize-MIT.md'],
    ['wasm-feature-detect/LICENSE', 'wasm-feature-detect-Apache-2.0.txt'],
  ];
  return {
    name: 'xb-codec-licences',
    generateBundle() {
      for (const [source, name] of fromPackages) this.emitFile({ type: 'asset', fileName: `licenses/${name}`, source: readFileSync(modules + source) });
      for (const name of readdirSync(own)) this.emitFile({ type: 'asset', fileName: `licenses/${name}`, source: readFileSync(own + name) });
    },
  };
}

// The image encoder's worker on its own (src/media/encoder.worker.ts): an ES module and its .wasm files, loaded only
// when an image is uploaded. Not library mode, which would inline the WebAssembly as base64 in the script.
export default defineConfig({
  plugins: [codecLicences()],
  // The .wasm URLs relative to the worker's own (import.meta.url), wherever WordPress serves the plugin from.
  base: './',
  build: {
    outDir: fileURLToPath(new URL('../plugin/assets/builder/media', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    assetsInlineLimit: 0,
    modulePreload: false,
    copyPublicDir: false,
    rolldownOptions: {
      input: fileURLToPath(new URL('./src/media/encoder.worker.ts', import.meta.url)),
      output: { format: 'es', entryFileNames: 'encoder.js', assetFileNames: '[name]-[hash][extname]', minify: true },
    },
  },
});
