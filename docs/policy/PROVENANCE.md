# Registro di provenienza

Ogni pacchetto fissato nel lockfile è elencato qui. Il controllo rifiuta licenze non dichiarate o incompatibili con la policy del progetto.

## Dipendenze npm

| Pacchetto | Versione | Licenza | Ambito | Uso | Motivo |
|---|---:|---|---|---|---|
| `@biomejs/biome` | 2.5.15 | MIT OR Apache-2.0 | development | Lint di TypeScript, JavaScript e JSON senza dipendenze fuori policy. | Importato o usato dal workspace histos-publish. |
| `@biomejs/cli-darwin-arm64` | 2.5.15 | MIT OR Apache-2.0 | development transitiva | Supporto interno alle dipendenze @biomejs/biome. | Necessaria alla catena @biomejs/biome; non importata direttamente. |
| `@biomejs/cli-darwin-x64` | 2.5.15 | MIT OR Apache-2.0 | development transitiva | Supporto interno alle dipendenze @biomejs/biome. | Necessaria alla catena @biomejs/biome; non importata direttamente. |
| `@biomejs/cli-linux-arm64` | 2.5.15 | MIT OR Apache-2.0 | development transitiva | Supporto interno alle dipendenze @biomejs/biome. | Necessaria alla catena @biomejs/biome; non importata direttamente. |
| `@biomejs/cli-linux-arm64-musl` | 2.5.15 | MIT OR Apache-2.0 | development transitiva | Supporto interno alle dipendenze @biomejs/biome. | Necessaria alla catena @biomejs/biome; non importata direttamente. |
| `@biomejs/cli-linux-x64` | 2.5.15 | MIT OR Apache-2.0 | development transitiva | Supporto interno alle dipendenze @biomejs/biome. | Necessaria alla catena @biomejs/biome; non importata direttamente. |
| `@biomejs/cli-linux-x64-musl` | 2.5.15 | MIT OR Apache-2.0 | development transitiva | Supporto interno alle dipendenze @biomejs/biome. | Necessaria alla catena @biomejs/biome; non importata direttamente. |
| `@biomejs/cli-win32-arm64` | 2.5.15 | MIT OR Apache-2.0 | development transitiva | Supporto interno alle dipendenze @biomejs/biome. | Necessaria alla catena @biomejs/biome; non importata direttamente. |
| `@biomejs/cli-win32-x64` | 2.5.15 | MIT OR Apache-2.0 | development transitiva | Supporto interno alle dipendenze @biomejs/biome. | Necessaria alla catena @biomejs/biome; non importata direttamente. |
| `@codemirror/autocomplete` | 6.20.4 | MIT | runtime | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, codemirror. | Importato o usato dal workspace @xb/editor. |
| `@codemirror/commands` | 6.11.1 | MIT | runtime | Supporto interno alle dipendenze @codemirror/commands, codemirror. | Importato o usato dal workspace @xb/editor. |
| `@codemirror/lang-css` | 6.3.1 | MIT | runtime | Supporto interno alle dipendenze @codemirror/lang-css, @codemirror/lang-html. | Importato o usato dal workspace @xb/editor. |
| `@codemirror/lang-html` | 6.4.12 | MIT | runtime | Supporto interno alle dipendenze @codemirror/lang-html. | Importato o usato dal workspace @xb/editor. |
| `@codemirror/lang-javascript` | 6.2.5 | MIT | runtime | Supporto interno alle dipendenze @codemirror/lang-html, @codemirror/lang-javascript. | Importato o usato dal workspace @xb/editor. |
| `@codemirror/language` | 6.13.1 | MIT | runtime | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, codemirror. | Importato o usato dal workspace @xb/editor. |
| `@codemirror/lint` | 6.9.7 | MIT | runtime | Supporto interno alle dipendenze @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/lint, codemirror. | Importato o usato dal workspace @xb/editor. |
| `@codemirror/search` | 6.7.2 | MIT | runtime | Supporto interno alle dipendenze @codemirror/search, codemirror. | Importato o usato dal workspace @xb/editor. |
| `@codemirror/state` | 6.7.6 | MIT | runtime | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @codemirror/lint, @codemirror/search, @codemirror/state, @codemirror/view, codemirror. | Importato o usato dal workspace @xb/editor. |
| `@codemirror/streamparser` | 6.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, codemirror. | Necessaria alla catena @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, codemirror; non importata direttamente. |
| `@codemirror/view` | 6.43.15 | MIT | runtime | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @codemirror/lint, @codemirror/search, @codemirror/view, codemirror. | Importato o usato dal workspace @xb/editor. |
| `@electron-internal/extract-zip` | 1.0.5 | BSD-2-Clause | development transitiva | Supporto interno alle dipendenze electron. | Necessaria alla catena electron; non importata direttamente. |
| `@electron/asar` | 3.4.1 | MIT | development | Crea l’archivio desktop con integrità dei file senza un packager preconfezionato. | Importato o usato dal workspace @histos-publish/desktop. |
| `balanced-match` | 1.0.2 | MIT | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `brace-expansion` | 1.1.21 | MIT | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `commander` | 5.1.0 | MIT | runtime | Gestisce i comandi, gli argomenti e l’aiuto della CLI. | Importato o usato dal workspace @histos-publish/cli. |
| `minimatch` | 3.1.5 | ISC | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `@electron/fuses` | 2.1.3 | MIT | development | Applica i fuse di sicurezza richiesti al runtime Electron distribuito. | Importato o usato dal workspace @histos-publish/desktop. |
| `@electron/get` | 5.1.0 | MIT | development transitiva | Supporto interno alle dipendenze electron. | Necessaria alla catena electron; non importata direttamente. |
| `@esbuild/aix-ppc64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/android-arm` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/android-arm64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/android-x64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/darwin-arm64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/darwin-x64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/freebsd-arm64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/freebsd-x64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/linux-arm` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/linux-arm64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/linux-ia32` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/linux-loong64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/linux-mips64el` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/linux-ppc64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/linux-riscv64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/linux-s390x` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/linux-x64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/netbsd-arm64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/netbsd-x64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/openbsd-arm64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/openbsd-x64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/openharmony-arm64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/sunos-x64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/win32-arm64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/win32-ia32` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@esbuild/win32-x64` | 0.28.2 | MIT | development transitiva | Supporto interno alle dipendenze esbuild. | Necessaria alla catena esbuild; non importata direttamente. |
| `@jridgewell/gen-mapping` | 0.3.13 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `@jridgewell/remapping` | 2.3.5 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `@jridgewell/resolve-uri` | 3.1.2 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte, svelte-check, vitest. | Necessaria alla catena svelte, svelte-check, vitest; non importata direttamente. |
| `@jridgewell/sourcemap-codec` | 1.6.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @sveltejs/vite-plugin-svelte, svelte, svelte-check, vitest. | Necessaria alla catena @sveltejs/vite-plugin-svelte, svelte, svelte-check, vitest; non importata direttamente. |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte, svelte-check, vitest. | Necessaria alla catena svelte, svelte-check, vitest; non importata direttamente. |
| `@jsquash/avif` | 2.1.1 | Apache-2.0 | runtime | Codifica (libavif con libaom) e decodifica AVIF in WebAssembly per le varianti moderne della build (B6), in un worker, senza moduli nativi. | Importato o usato dal workspace @histos-publish/server. |
| `@jsquash/jpeg` | 1.6.0 | Apache-2.0 | runtime | Decodifica i JPEG (mozjpeg) in WebAssembly per le varianti moderne della build (B6). | Importato o usato dal workspace @histos-publish/server. |
| `@jsquash/jxl` | 1.3.0 | Apache-2.0 | runtime | Codifica JPEG XL (libjxl) in WebAssembly per le varianti moderne della build (B6). | Importato o usato dal workspace @histos-publish/server. |
| `@jsquash/png` | 3.1.1 | Apache-2.0 | runtime | Decodifica i PNG (crate Rust png) in WebAssembly per le varianti moderne della build (B6). | Importato o usato dal workspace @histos-publish/server. |
| `@jsquash/resize` | 2.1.1 | Apache-2.0 | runtime | Ridimensiona le immagini (Lanczos, crate Rust resize) in WebAssembly per le larghezze di srcset (B6). | Importato o usato dal workspace @histos-publish/server. |
| `@jsquash/webp` | 1.5.0 | Apache-2.0 | runtime | Codifica e decodifica WebP (libwebp) in WebAssembly per le varianti moderne della build (B6). | Importato o usato dal workspace @histos-publish/server. |
| `wasm-feature-detect` | 1.9.0 | Apache-2.0 | runtime transitiva | Supporto interno alle dipendenze @jsquash/avif, @jsquash/jxl, @jsquash/webp. | Necessaria alla catena @jsquash/avif, @jsquash/jxl, @jsquash/webp; non importata direttamente. |
| `@lezer/common` | 1.5.3 | MIT | runtime transitiva | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @lezer/highlight, codemirror. | Necessaria alla catena @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @lezer/highlight, codemirror; non importata direttamente. |
| `@lezer/css` | 1.3.9 | MIT | runtime transitiva | Supporto interno alle dipendenze @codemirror/lang-css, @codemirror/lang-html. | Necessaria alla catena @codemirror/lang-css, @codemirror/lang-html; non importata direttamente. |
| `@lezer/highlight` | 1.2.5 | MIT | runtime | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @lezer/highlight, codemirror. | Importato o usato dal workspace @xb/editor. |
| `@lezer/html` | 1.3.13 | MIT | runtime transitiva | Supporto interno alle dipendenze @codemirror/lang-html. | Necessaria alla catena @codemirror/lang-html; non importata direttamente. |
| `@lezer/javascript` | 1.5.6 | MIT | runtime transitiva | Supporto interno alle dipendenze @codemirror/lang-html, @codemirror/lang-javascript. | Necessaria alla catena @codemirror/lang-html, @codemirror/lang-javascript; non importata direttamente. |
| `@lezer/lr` | 1.4.11 | MIT | runtime transitiva | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, codemirror. | Necessaria alla catena @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, codemirror; non importata direttamente. |
| `@marijn/find-cluster-break` | 1.0.4 | MIT | runtime transitiva | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @codemirror/lint, @codemirror/search, @codemirror/state, @codemirror/view, codemirror. | Necessaria alla catena @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @codemirror/lint, @codemirror/search, @codemirror/state, @codemirror/view, codemirror; non importata direttamente. |
| `@napi-rs/keyring` | 2.0.0 | MIT | runtime | Salva il token Cloudflare nel portachiavi di sistema senza fallback in chiaro. | Importato o usato dal workspace @histos-publish/core. |
| `@napi-rs/keyring-darwin-arm64` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@napi-rs/keyring-darwin-x64` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@napi-rs/keyring-freebsd-x64` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@napi-rs/keyring-linux-arm-gnueabihf` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@napi-rs/keyring-linux-arm64-gnu` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@napi-rs/keyring-linux-arm64-musl` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@napi-rs/keyring-linux-riscv64-gnu` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@napi-rs/keyring-linux-x64-gnu` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@napi-rs/keyring-linux-x64-musl` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@napi-rs/keyring-win32-arm64-msvc` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@napi-rs/keyring-win32-ia32-msvc` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@napi-rs/keyring-win32-x64-msvc` | 2.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @napi-rs/keyring. | Necessaria alla catena @napi-rs/keyring; non importata direttamente. |
| `@oxc-project/types` | 0.155.0 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@pagefind/darwin-arm64` | 1.5.2 | MIT | runtime transitiva | Supporto interno alle dipendenze pagefind. | Necessaria alla catena pagefind; non importata direttamente. |
| `@pagefind/darwin-x64` | 1.5.2 | MIT | runtime transitiva | Supporto interno alle dipendenze pagefind. | Necessaria alla catena pagefind; non importata direttamente. |
| `@pagefind/freebsd-x64` | 1.5.2 | MIT | runtime transitiva | Supporto interno alle dipendenze pagefind. | Necessaria alla catena pagefind; non importata direttamente. |
| `@pagefind/linux-arm64` | 1.5.2 | MIT | runtime transitiva | Supporto interno alle dipendenze pagefind. | Necessaria alla catena pagefind; non importata direttamente. |
| `@pagefind/linux-x64` | 1.5.2 | MIT | runtime transitiva | Supporto interno alle dipendenze pagefind. | Necessaria alla catena pagefind; non importata direttamente. |
| `@pagefind/windows-arm64` | 1.5.2 | MIT | runtime transitiva | Supporto interno alle dipendenze pagefind. | Necessaria alla catena pagefind; non importata direttamente. |
| `@pagefind/windows-x64` | 1.5.2 | MIT | runtime transitiva | Supporto interno alle dipendenze pagefind. | Necessaria alla catena pagefind; non importata direttamente. |
| `@playwright/test` | 1.64.1 | Apache-2.0 | development | Esegue i test end-to-end dell’interfaccia sul server locale con servizi simulati. | Importato o usato dal workspace histos-publish. |
| `@rolldown/binding-android-arm-eabi` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-android-arm64` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-darwin-arm64` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-darwin-x64` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-freebsd-x64` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-linux-arm-gnueabihf` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-linux-arm64-gnu` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-linux-arm64-musl` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-linux-ppc64-gnu` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-linux-s390x-gnu` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-linux-x64-gnu` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-linux-x64-musl` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-openharmony-arm64` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-win32-arm64-msvc` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/binding-win32-x64-msvc` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@rolldown/pluginutils` | 1.0.1 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `@sveltejs/acorn-typescript` | 1.0.13 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `@sveltejs/load-config` | 0.2.3 | MIT | development transitiva | Supporto interno alle dipendenze svelte-check. | Necessaria alla catena svelte-check; non importata direttamente. |
| `@sveltejs/vite-plugin-svelte` | 7.3.1 | MIT | development | Compila i componenti Svelte dell’interfaccia locale. | Importato o usato dal workspace @xb/editor. |
| `obug` | 2.2.1 | MIT | development transitiva | Supporto interno alle dipendenze @sveltejs/vite-plugin-svelte. | Necessaria alla catena @sveltejs/vite-plugin-svelte; non importata direttamente. |
| `@types/chai` | 5.2.3 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `@types/chroma-js` | 2.4.5 | MIT | development | Tipi TypeScript per l’interpolazione dei colori dei gradienti Core. | Importato o usato dal workspace @histos-publish/cms. |
| `@types/deep-eql` | 4.0.2 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `@types/estree` | 1.0.9 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte, vitest. | Necessaria alla catena svelte, vitest; non importata direttamente. |
| `@types/node` | 26.6.5 | MIT | development | Fornisce i tipi per le API Node, incluso node:sqlite. | Importato o usato dal workspace histos-publish. |
| `@types/parse-srcset` | 1.0.0 | MIT | development | Tipi per parse-srcset. | Importato o usato dal workspace histos-publish. |
| `@types/yauzl` | 3.4.0 | MIT | development | Tipi per yauzl. | Importato o usato dal workspace histos-publish. |
| `@types/yazl` | 3.3.1 | MIT | development | Tipi per yazl. | Importato o usato dal workspace histos-publish. |
| `@typescript/typescript-aix-ppc64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-darwin-arm64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-darwin-x64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-freebsd-arm64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-freebsd-x64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-linux-arm` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-linux-arm64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-linux-loong64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-linux-mips64el` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-linux-ppc64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-linux-riscv64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-linux-s390x` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-linux-x64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-netbsd-arm64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-netbsd-x64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-openbsd-arm64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-openbsd-x64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-sunos-x64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-win32-arm64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@typescript/typescript-win32-x64` | 7.0.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze typescript. | Necessaria alla catena typescript; non importata direttamente. |
| `@vitest/mocker` | 5.0.5 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `@vitest/spy` | 5.0.5 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `@wordpress/block-serialization-default-parser` | 5.57.0 | GPL-2.0-or-later | runtime | Supporto interno alle dipendenze @wordpress/block-serialization-default-parser. | Importato o usato dal workspace @xb/dsl. |
| `acorn` | 8.19.0 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `ajv` | 8.20.0 | MIT | runtime | Valida la configurazione del sito contro uno schema chiuso. | Importato o usato dal workspace @histos-publish/histos-contract. |
| `aria-query` | 5.3.1 | Apache-2.0 | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `asn1` | 0.2.6 | MIT | runtime transitiva | Supporto interno alle dipendenze ssh2. | Necessaria alla catena ssh2; non importata direttamente. |
| `assertion-error` | 2.0.1 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `aws-ssl-profiles` | 1.1.2 | MIT | runtime transitiva | Supporto interno alle dipendenze mysql2. | Necessaria alla catena mysql2; non importata direttamente. |
| `axobject-query` | 4.1.0 | Apache-2.0 | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `basic-ftp` | 6.2.3 | MIT | runtime | Supporto interno alle dipendenze basic-ftp. | Importato o usato dal workspace @histos-publish/server. |
| `buffer-crc32` | 1.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze yazl. | Necessaria alla catena yazl; non importata direttamente. |
| `buildcheck` | 0.0.7 | MIT | runtime transitiva | Supporto interno alle dipendenze ssh2. | Necessaria alla catena ssh2; non importata direttamente. |
| `bundle-name` | 4.1.1 | MIT | runtime transitiva | Supporto interno alle dipendenze open. | Necessaria alla catena open; non importata direttamente. |
| `chai` | 6.3.0 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `chokidar` | 4.0.3 | MIT | development transitiva | Supporto interno alle dipendenze svelte-check. | Necessaria alla catena svelte-check; non importata direttamente. |
| `chroma-js` | 2.4.2 | (BSD-3-Clause AND Apache-2.0) | runtime | Interpola i colori dei gradienti easing Core in RGB lineare e produce fermate HSL. | Importato o usato dal workspace @histos-publish/cms. |
| `clsx` | 2.1.1 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `codemirror` | 6.0.2 | MIT | runtime | Supporto interno alle dipendenze codemirror. | Importato o usato dal workspace @xb/editor. |
| `commander` | 15.0.0 | MIT | runtime | Gestisce i comandi, gli argomenti e l’aiuto della CLI. | Importato o usato dal workspace @histos-publish/cli. |
| `concat-map` | 0.0.1 | MIT | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `cpu-features` | 0.0.10 | MIT | runtime transitiva | Supporto interno alle dipendenze ssh2. | Necessaria alla catena ssh2; non importata direttamente. |
| `crelt` | 1.0.7 | MIT | runtime transitiva | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @codemirror/lint, @codemirror/search, @codemirror/view, codemirror. | Necessaria alla catena @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @codemirror/lint, @codemirror/search, @codemirror/view, codemirror; non importata direttamente. |
| `debug` | 4.4.3 | MIT | development transitiva | Supporto interno alle dipendenze electron. | Necessaria alla catena electron; non importata direttamente. |
| `deepmerge` | 4.3.1 | MIT | development transitiva | Supporto interno alle dipendenze @sveltejs/vite-plugin-svelte. | Necessaria alla catena @sveltejs/vite-plugin-svelte; non importata direttamente. |
| `default-browser` | 5.5.1 | MIT | runtime transitiva | Supporto interno alle dipendenze open. | Necessaria alla catena open; non importata direttamente. |
| `default-browser-id` | 5.0.1 | MIT | runtime transitiva | Supporto interno alle dipendenze open. | Necessaria alla catena open; non importata direttamente. |
| `define-lazy-prop` | 3.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze open. | Necessaria alla catena open; non importata direttamente. |
| `detect-libc` | 2.1.2 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `devalue` | 5.9.4 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `easing-coordinates` | 2.0.2 | MIT | runtime | Calcola le coordinate delle funzioni timing usate nei gradienti Core. | Importato o usato dal workspace @histos-publish/cms. |
| `electron` | 45.0.0 | MIT | development | Fornisce Chromium e il runtime desktop isolato per l’applicazione. | Importato o usato dal workspace @histos-publish/desktop. |
| `@types/node` | 24.19.2 | MIT | development | Fornisce i tipi per le API Node, incluso node:sqlite. | Importato o usato dal workspace histos-publish. |
| `undici-types` | 7.24.6 | MIT | development transitiva | Supporto interno alle dipendenze electron. | Necessaria alla catena electron; non importata direttamente. |
| `entities` | 8.1.0 | BSD-2-Clause | runtime diretta (cms) e transitiva (parse5) | Decodifica le entità degli attributi prima dei controlli del renderer statico. | Già presente con parse5; usata direttamente per vedere gli attributi come il browser. |
| `env-paths` | 3.0.0 | MIT | development transitiva | Supporto interno alle dipendenze electron. | Necessaria alla catena electron; non importata direttamente. |
| `es-module-lexer` | 2.3.2 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `esbuild` | 0.28.2 | MIT | development | Compila il processo principale Electron e il preload con dipendenze workspace incluse. | Importato o usato dal workspace @histos-publish/desktop. |
| `esm-env` | 1.2.2 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `esrap` | 2.4.0 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `estree-walker` | 3.0.3 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `expect-type` | 1.4.0 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `fast-deep-equal` | 3.1.3 | MIT | runtime transitiva | Supporto interno alle dipendenze ajv. | Necessaria alla catena ajv; non importata direttamente. |
| `fast-uri` | 3.1.9 | BSD-3-Clause | runtime transitiva | Supporto interno alle dipendenze ajv. | Necessaria alla catena ajv; non importata direttamente. |
| `fdir` | 6.5.0 | MIT | development transitiva | Supporto interno alle dipendenze svelte-check, vite, vitest. | Necessaria alla catena svelte-check, vite, vitest; non importata direttamente. |
| `fs.realpath` | 1.0.0 | ISC | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `fsevents` | 2.3.3 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `generate-function` | 2.3.1 | MIT | runtime transitiva | Supporto interno alle dipendenze mysql2. | Necessaria alla catena mysql2; non importata direttamente. |
| `glob` | 7.2.3 | ISC | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `balanced-match` | 1.0.2 | MIT | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `brace-expansion` | 1.1.21 | MIT | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `minimatch` | 3.1.5 | ISC | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `graceful-fs` | 4.2.11 | ISC | development transitiva | Supporto interno alle dipendenze electron. | Necessaria alla catena electron; non importata direttamente. |
| `iconv-lite` | 0.7.3 | MIT | runtime transitiva | Supporto interno alle dipendenze mysql2. | Necessaria alla catena mysql2; non importata direttamente. |
| `inflight` | 1.0.6 | ISC | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `inherits` | 2.0.4 | ISC | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `is-docker` | 3.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze open. | Necessaria alla catena open; non importata direttamente. |
| `is-in-ssh` | 1.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze open. | Necessaria alla catena open; non importata direttamente. |
| `is-inside-container` | 1.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze open. | Necessaria alla catena open; non importata direttamente. |
| `is-property` | 1.0.2 | MIT | runtime transitiva | Supporto interno alle dipendenze mysql2. | Necessaria alla catena mysql2; non importata direttamente. |
| `is-reference` | 3.0.3 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `is-wsl` | 3.1.1 | MIT | runtime transitiva | Supporto interno alle dipendenze open. | Necessaria alla catena open; non importata direttamente. |
| `jiti` | 2.7.0 | MIT | development transitiva | Supporto interno alle dipendenze del lockfile. | Necessaria alla catena registrata nel lockfile; non importata direttamente. |
| `json-schema-traverse` | 1.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze ajv. | Necessaria alla catena ajv; non importata direttamente. |
| `lightningcss` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `lightningcss-android-arm64` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `lightningcss-darwin-arm64` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `lightningcss-darwin-x64` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `lightningcss-freebsd-x64` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `lightningcss-linux-arm-gnueabihf` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `lightningcss-linux-arm64-gnu` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `lightningcss-linux-arm64-musl` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `lightningcss-linux-x64-gnu` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `lightningcss-linux-x64-musl` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `lightningcss-win32-arm64-msvc` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `lightningcss-win32-x64-msvc` | 1.33.0 | MPL-2.0 | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `locate-character` | 3.0.0 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `long` | 5.3.2 | Apache-2.0 | runtime transitiva | Supporto interno alle dipendenze mysql2. | Necessaria alla catena mysql2; non importata direttamente. |
| `lru.min` | 1.1.5 | MIT | runtime transitiva | Supporto interno alle dipendenze mysql2. | Necessaria alla catena mysql2; non importata direttamente. |
| `lz-string` | 1.5.0 | MIT | development | Crea fixture di test per i preset Core compressi; l’editor usa un decoder locale con limiti espliciti. | Importato o usato dal workspace @histos-publish/cms. |
| `magic-string` | 1.4.3 | MIT | development transitiva | Supporto interno alle dipendenze @sveltejs/vite-plugin-svelte, vitest. | Necessaria alla catena @sveltejs/vite-plugin-svelte, vitest; non importata direttamente. |
| `mri` | 1.2.0 | MIT | development transitiva | Supporto interno alle dipendenze svelte-check. | Necessaria alla catena svelte-check; non importata direttamente. |
| `ms` | 2.1.3 | MIT | development transitiva | Supporto interno alle dipendenze electron. | Necessaria alla catena electron; non importata direttamente. |
| `mysql2` | 3.24.6 | MIT | runtime | Supporto interno alle dipendenze mysql2. | Importato o usato dal workspace @histos-publish/server. |
| `named-placeholders` | 1.1.6 | MIT | runtime transitiva | Supporto interno alle dipendenze mysql2. | Necessaria alla catena mysql2; non importata direttamente. |
| `nan` | 2.30.0 | MIT | runtime transitiva | Supporto interno alle dipendenze ssh2. | Necessaria alla catena ssh2; non importata direttamente. |
| `nanoid` | 3.3.20 | MIT | runtime transitiva | Supporto interno alle dipendenze postcss, vite. | Necessaria alla catena postcss, vite; non importata direttamente. |
| `obug` | 3.0.0 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `once` | 1.4.0 | ISC | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `open` | 11.0.4 | MIT | runtime | Apre la schermata locale nel browser predefinito quando si avvia la CLI grafica. | Importato o usato dal workspace @histos-publish/server. |
| `pagefind` | 1.5.2 | MIT | runtime | Genera offline un indice statico opt-in, senza query o servizio di ricerca esterno. | Importato o usato dal workspace @histos-publish/core. |
| `parse-srcset` | 1.0.2 | MIT | runtime | Analizza srcset mantenendo i descrittori delle immagini. | Importato o usato dal workspace @histos-publish/cms. |
| `parse5` | 8.0.1 | MIT | runtime | Analizza e riscrive HTML senza trasformazioni regex fragili. | Importato o usato dal workspace @histos-publish/cms. |
| `path-is-absolute` | 1.0.1 | MIT | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `pe-library` | 0.4.1 | MIT | development transitiva | Supporto interno alle dipendenze resedit. | Necessaria alla catena resedit; non importata direttamente. |
| `pend` | 1.2.0 | MIT | runtime transitiva | Supporto interno alle dipendenze yauzl. | Necessaria alla catena yauzl; non importata direttamente. |
| `picocolors` | 1.1.1 | ISC | runtime transitiva | Supporto interno alle dipendenze postcss, svelte-check, vite. | Necessaria alla catena postcss, svelte-check, vite; non importata direttamente. |
| `picomatch` | 4.0.7 | MIT | development transitiva | Supporto interno alle dipendenze vite, vitest. | Necessaria alla catena vite, vitest; non importata direttamente. |
| `playwright` | 1.64.1 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze @playwright/test. | Necessaria alla catena @playwright/test; non importata direttamente. |
| `playwright-core` | 1.64.1 | Apache-2.0 | runtime | Esegue il render controllato di siti nel core e lo smoke test dell’app Electron. | Importato o usato dal workspace @histos-publish/desktop. |
| `postcss` | 8.5.31 | MIT | runtime | Analizza il CSS e i suoi at-rule per trovare risorse locali. | Importato o usato dal workspace @histos-publish/cms. |
| `postcss-value-parser` | 4.2.0 | MIT | runtime | Legge i valori CSS, inclusi i parametri dei gradienti Core e gli import locali. | Importato o usato dal workspace @histos-publish/cms. |
| `powershell-utils` | 0.2.1 | MIT | runtime transitiva | Supporto interno alle dipendenze open. | Necessaria alla catena open; non importata direttamente. |
| `progress` | 2.0.3 | MIT | development transitiva | Supporto interno alle dipendenze electron. | Necessaria alla catena electron; non importata direttamente. |
| `readdirp` | 4.1.2 | MIT | development transitiva | Supporto interno alle dipendenze svelte-check. | Necessaria alla catena svelte-check; non importata direttamente. |
| `require-from-string` | 2.0.2 | MIT | runtime transitiva | Supporto interno alle dipendenze ajv. | Necessaria alla catena ajv; non importata direttamente. |
| `resedit` | 1.7.2 | MIT | development | Aggiunge all’eseguibile Windows l’hash ASAR richiesto da Electron. | Importato o usato dal workspace @histos-publish/desktop. |
| `rolldown` | 1.2.15 | MIT | development transitiva | Supporto interno alle dipendenze vite. | Necessaria alla catena vite; non importata direttamente. |
| `run-applescript` | 7.1.0 | MIT | runtime transitiva | Supporto interno alle dipendenze open. | Necessaria alla catena open; non importata direttamente. |
| `sade` | 1.8.1 | MIT | development transitiva | Supporto interno alle dipendenze svelte-check. | Necessaria alla catena svelte-check; non importata direttamente. |
| `safer-buffer` | 2.1.2 | MIT | runtime transitiva | Supporto interno alle dipendenze mysql2, ssh2. | Necessaria alla catena mysql2, ssh2; non importata direttamente. |
| `semver` | 7.7.4 | ISC | development transitiva | Supporto interno alle dipendenze electron. | Necessaria alla catena electron; non importata direttamente. |
| `source-map-js` | 1.2.2 | BSD-3-Clause | runtime transitiva | Supporto interno alle dipendenze postcss, vite. | Necessaria alla catena postcss, vite; non importata direttamente. |
| `sql-escaper` | 1.5.2 | MIT | runtime transitiva | Supporto interno alle dipendenze mysql2. | Necessaria alla catena mysql2; non importata direttamente. |
| `ssh2` | 1.17.0 | MIT | runtime | Gestisce SFTP nel processo locale con verifica della chiave host prima dell’autenticazione, senza richiedere un client SSH esterno. | Importato o usato dal workspace @histos-publish/server. |
| `std-env` | 4.3.0 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `style-mod` | 4.1.4 | MIT | runtime transitiva | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @codemirror/lint, @codemirror/search, @codemirror/view, codemirror. | Necessaria alla catena @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @codemirror/lint, @codemirror/search, @codemirror/view, codemirror; non importata direttamente. |
| `sumchecker` | 3.0.1 | Apache-2.0 | development transitiva | Supporto interno alle dipendenze electron. | Necessaria alla catena electron; non importata direttamente. |
| `svelte` | 5.57.2 | MIT | runtime | Costruisce l’interfaccia guidata dell’applicazione. | Importato o usato dal workspace @xb/editor. |
| `magic-string` | 0.30.21 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `tinybench` | 6.2.2 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `tinyexec` | 1.3.1 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `tinyglobby` | 0.2.17 | MIT | development transitiva | Supporto interno alle dipendenze vite, vitest. | Necessaria alla catena vite, vitest; non importata direttamente. |
| `typescript` | 7.0.2 | Apache-2.0 | development | Compila il monorepo e applica il typecheck strict. | Importato o usato dal workspace histos-publish. |
| `undici` | 7.30.1 | MIT | development transitiva | Supporto interno alle dipendenze electron. | Necessaria alla catena electron; non importata direttamente. |
| `undici-types` | 8.9.0 | MIT | runtime transitiva | Supporto interno alle dipendenze @types/node, @types/yauzl, @types/yazl. | Necessaria alla catena @types/node, @types/yauzl, @types/yazl; non importata direttamente. |
| `vite` | 8.3.5 | MIT | development | Compila e serve l’interfaccia web locale durante lo sviluppo. | Importato o usato dal workspace @xb/editor. |
| `vitefu` | 1.1.3 | MIT | development transitiva | Supporto interno alle dipendenze @sveltejs/vite-plugin-svelte. | Necessaria alla catena @sveltejs/vite-plugin-svelte; non importata direttamente. |
| `vitest` | 5.0.5 | MIT | development | Esegue i test unitari e di integrazione locale. | Importato o usato dal workspace histos-publish. |
| `w3c-keyname` | 2.2.8 | MIT | runtime transitiva | Supporto interno alle dipendenze @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @codemirror/lint, @codemirror/search, @codemirror/view, codemirror. | Necessaria alla catena @codemirror/autocomplete, @codemirror/commands, @codemirror/lang-css, @codemirror/lang-html, @codemirror/lang-javascript, @codemirror/language, @codemirror/lint, @codemirror/search, @codemirror/view, codemirror; non importata direttamente. |
| `wasm-feature-detect` | 1.9.0 | Apache-2.0 | runtime transitiva | Supporto interno alle dipendenze @jsquash/avif, @jsquash/jxl, @jsquash/webp. | Necessaria alla catena @jsquash/avif, @jsquash/jxl, @jsquash/webp; non importata direttamente. |
| `why-is-node-running` | 3.2.1 | MIT | development transitiva | Supporto interno alle dipendenze vitest. | Necessaria alla catena vitest; non importata direttamente. |
| `wrappy` | 1.0.2 | ISC | development transitiva | Supporto interno alle dipendenze @electron/asar. | Necessaria alla catena @electron/asar; non importata direttamente. |
| `wsl-utils` | 1.0.1 | MIT | runtime transitiva | Supporto interno alle dipendenze open. | Necessaria alla catena open; non importata direttamente. |
| `yauzl` | 3.4.0 | MIT | runtime | Legge ZIP in modo sequenziale e con validazione delle dimensioni. | Importato o usato dal workspace @histos-publish/cms. |
| `yazl` | 3.3.1 | MIT | runtime | Crea le esportazioni ZIP in streaming e l’archivio ZIP temporaneo incorporato nell’installer Windows per utente. | Importato o usato dal workspace @histos-publish/cms. |
| `zimmerframe` | 1.1.5 | MIT | runtime transitiva | Supporto interno alle dipendenze svelte. | Necessaria alla catena svelte; non importata direttamente. |
| `zod` | 4.6.7 | MIT | runtime | Valida mittenti e argomenti IPC dell’app Electron con schemi chiusi. | Importato o usato dal workspace @histos-publish/desktop. |

## Codice permissivo adattato nel workspace

| Pacchetto | Versione | Licenza | Uso e modifica |
|---|---:|---|---|
| `bcrypt-pbkdf` (copia locale del port OpenBSD) | 1.0.3 | BSD-3-Clause | Dipendenza runtime di `ssh2`; SHA-512 usa il modulo Node `node:crypto` al posto di `tweetnacl`. Il file `packages/bcrypt-pbkdf/LICENSE` conserva gli avvisi originali; il testo viene incluso nell’app desktop. |

## Librerie compilate in WebAssembly dentro jSquash

Nessuna è copiata nel workspace: arrivano già compilate nei pacchetti `@jsquash/*` del lockfile. Il desktop include solo i moduli a un thread (`image-codecs/`) e i testi delle licenze (`packages/desktop/resources/licenses/`, ADR 0012).

| Libreria | Licenza | Uso |
|---|---|---|
| libavif e libaom | BSD-2-Clause; libaom anche Alliance for Open Media Patent License 1.0 (gratuita) | Codifica e decodifica AVIF |
| libjxl | BSD-3-Clause, con la concessione gratuita di brevetti del progetto | Codifica JPEG XL |
| libwebp | BSD-3-Clause | Codifica e decodifica WebP |
| mozjpeg (libjpeg-turbo) | IJG, BSD-3-Clause, zlib | Decodifica JPEG |
| crate Rust `png`, `resize` | MIT o Apache-2.0 | Decodifica PNG, ridimensionamento |

## Strumenti esterni di packaging

| Strumento | Versione | Licenza | Uso e distribuzione |
|---|---:|---|---|
| [appimagetool](https://github.com/AppImage/appimagetool) | 1.9.1 | MIT | Costruisce l’AppImage; scaricato da un tag immutabile e verificato con SHA-256 ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0. Non viene incluso nel prodotto. |
| [AppImage type2-runtime](https://github.com/AppImage/type2-runtime) | 20251108 | MIT | Runtime incorporato nell’AppImage; tag e SHA-256 fissati (2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d). |
| dpkg-deb e dpkg-shlibdeps | Sistema Debian/Ubuntu | GPL-2.0-or-later | Creano il pacchetto Debian e ne calcolano le dipendenze di sistema; non vengono inclusi nel prodotto. |
| IExpress e PowerShell | Windows | Componenti del sistema operativo | Creano e verificano l’installer per utente; non vengono copiati nel prodotto. |

## Fonti e decisioni

| Fonte | Verifica |
|---|---|
| Documentazione ufficiale Cloudflare, Electron, Node.js e librerie registrate negli ADR 0001 e 0004 | Consultata il 2026-10-21; riferimenti in docs/PIANO.md e nelle ADR. |
| Node.js node:sqlite, versione minima CLI 22.13; Electron 45 include Node 24.22 | L’API sincrona è integrata e non richiede il modulo npm better-sqlite3; è sperimentale nella linea Node 22 e release candidate da Node 24.15. |
| Electron ASAR Integrity | L’archivio ASAR contiene hash per i file; Windows riceve anche l’hash dell’header nella risorsa PE INTEGRITY/ELECTRONASAR. |
| AppImage, [appimagetool](https://github.com/AppImage/appimagetool) e [type2-runtime](https://github.com/AppImage/type2-runtime) | Tool e runtime sono versionati, verificati con SHA-256 e usati solo per il packaging. |
| Registry npm: Electron 45.0.0, @electron/asar 3.4.1, @electron/fuses 2.1.3, esbuild 0.28.2, Playwright Core 1.64.1, resedit 1.7.2, yazl 3.3.1 e Zod 4.6.7 | Licenze, versioni e dipendenze risultano dal lockfile; i testi delle licenze runtime sono conservati nell’archivio desktop. |
| Static Bridge 2.0.25, commit 06086c68f38213dbbb7b4ca6c84f755e0555e531 | Ispezionato in sola lettura per la proposta; nessun codice o asset importato. |
| Histeon e Static Bridge | Documenti e sorgenti sono stati consultati come riferimenti del progetto; nessun repository originale è stato modificato. |

## Regole SPDX

- La policy accetta MIT, BSD, Apache-2.0, ISC, GPL-2.0-or-later, LGPL e MPL-2.0. Le varianti BSD con identificatore BSD-* e LGPL 2.0, 2.1 o 3.0 sono trattate come appartenenti a queste famiglie.
- OR è ammesso quando almeno una scelta completa rispetta la policy; AND è ammesso solo se ogni componente la rispetta.
- WITH, licenze sconosciute e identificatori non ammessi interrompono npm run provenance. 0BSD e GPL-2.0-only non sono inclusi nell’allowlist; GPL-3.0-or-later è ammessa per lo snapshot Histeon con NOTICE e sorgenti tracciati.
- Licenze e versioni npm arrivano dal package-lock.json; le eccezioni per binari opzionali sono dichiarate nello script del registro.
- Lo snapshot dell’editor e dei pacchetti Histeon è copiato dal commit upstream 5b3745596d8045e0b5bb197bd8b48def28e43f6e (prima 9bc212050403dd056ac21edfcff398b514e4a3c1) in packages/cms/vendor/histos, con LICENSE e provenance; la patch host è separata in packages/cms/patches/histos. Nessun codice o asset Static Bridge è stato copiato.
