# ADR 0012 — Codificatore delle immagini: jSquash in WebAssembly

Data: 2026-10-28

Stato: **accettata; implementata. Pensata per essere riusata anche nel builder.**

## Contesto

- Serviva un codificatore per dare alle immagini della build statica formati moderni e più larghezze, JPEG XL compreso.
- Vincoli: solo licenze aperte permissive o compatibili con la LGPL, nessun codec commerciale né chiave; nessuna rete in esecuzione; l'app è Electron più una CLI, impacchettata a mano (`packages/desktop/scripts/package-*.mjs`) per Linux e Windows; i file da decodificare possono venire da un prototipo qualsiasi.
- Il builder (`editor/src/lib/mediaManager.ts`) oggi comprime nel browser in WebP con il canvas, e si vuole portarlo allo stesso codificatore: la scelta deve funzionare anche in una pagina dell'amministrazione di WordPress.

## Alternative

| Opzione | Pro | Contro |
|---|---|---|
| `sharp` (libvips nativo) | Veloce, multithread | Moduli nativi per ogni piattaforma e ABI di Electron nel pacchetto fatto a mano; JPEG XL assente dalla libvips precompilata; non gira nel browser, quindi non serve al builder; un errore di un codec è memoria del processo dell'app |
| `wasm-vips` | Una sola libreria con JPEG XL, AVIF, WebP | Richiede thread WebAssembly, cioè `SharedArrayBuffer` e l'isolamento cross-origin (COOP/COEP) nel browser, che l'amministrazione di WordPress non ha; un modulo unico di molti MB anche per un solo formato; LGPL |
| **jSquash** (`@jsquash/*`, i codec di Squoosh in WebAssembly) | Un pacchetto per formato, caricato solo se serve; versioni a un thread che girano in Node, nei worker e in ogni browser senza isolamento; stessa API in Node e nel browser; licenze Apache-2.0 e BSD | Più lento di libvips (vedi le misure); WebAssembly a un thread |

## Decisione

| # | Decisione | Motivazione |
|---:|---|---|
| 1 | jSquash, versioni esatte nel lockfile: `@jsquash/avif` 2.1.1, `@jsquash/jxl` 1.3.0, `@jsquash/webp` 1.5.0, `@jsquash/jpeg` 1.6.0, `@jsquash/png` 3.1.1, `@jsquash/resize` 2.1.1, con `wasm-feature-detect` 1.9.0. Dipendenze di `@histos-publish/server`. | Una famiglia sola per Publish e per il builder; nessun modulo nativo; un errore di un codec resta nella memoria lineare WebAssembly del suo worker. |
| 2 | Licenze: jSquash e `wasm-feature-detect` Apache-2.0; dentro i moduli libavif (BSD-2-Clause), libaom (BSD-2-Clause più la Alliance for Open Media Patent License 1.0, gratuita), libjxl (BSD-3-Clause più la concessione gratuita di brevetti di Google), libwebp (BSD-3-Clause), mozjpeg (IJG, BSD-3-Clause, zlib), crate Rust `png` e `resize` (MIT o Apache-2.0). Testi in `packages/desktop/resources/licenses/` e `image-codecs/licenses/`, voce in `THIRD-PARTY-NOTICES.md`. | Tutte permissive; nessun codec commerciale, nessuna chiave. |
| 3 | In Publish il codificatore gira in un worker thread per immagine (`packages/server/src/image-worker.ts`), con i `.wasm` letti dal disco e passati a `init(modulo)`: mai `fetch`. Il desktop impacchetta il worker come file a sé (`image-worker.js`) e i moduli a un thread in `image-codecs/`, dentro l'ASAR (i worker di Electron leggono l'ASAR). | Il server non si blocca; un worker che supera tempo o memoria si chiude senza toccare l'app; nessuna rete. |
| 4 | Limiti: 32 MB per file; 40 megapixel letti dall'intestazione prima di decodificare (`inspectImageForVariants`); misure decodificate uguali a quelle dell'intestazione; 1 GiB di memoria WebAssembly per worker (la crescita delle memorie Emscripten passa da `WebAssembly.Memory.prototype.grow`, che il worker limita); 60 secondi per immagine; heap V8 del worker limitato; al massimo 4 worker. | Una bomba di decompressione non arriva al decodificatore, e un file costruito male non porta via memoria o tempo all'app. |
| 5 | Impostazioni predefinite con un solo livello visivo, misurato con SSIM su cinque foto a 1600 px: WebP 75 (metodo 4), AVIF 60 (velocità 8), JPEG XL 75 (sforzo 4). Le sorgenti senza perdita restano senza perdita (JPEG XL sforzo 3, WebP `lossless`). | Con la stessa qualità si possono confrontare i pesi; velocità e sforzo stanno nel tempo di una build. |
| 6 | Le varianti non viaggiano verso WordPress. | WordPress fa le sue misure con la sua pipeline; due serie di file da tenere allineate sarebbero solo un rischio. |

## Misure (un computer a 16 thread, Node 22)

- Foto 2560×1600 (JPEG da 487 KB), quattro larghezze (480, 960, 1600, 2560) nei tre formati, un worker: 4,1 s (decodifica 0,05 s, ridimensionamento 0,4 s, AVIF 1,3 s, JPEG XL 1,3 s, WebP 0,9 s). Memoria WebAssembly necessaria: fra 500 e 700 MiB.
- Foto da 37 megapixel: 7,6 s, picco di memoria del processo 2 GB.
- Sei immagini (cinque foto 2560×1600 e un PNG 1200×800) nella build: 8,6 s la prima volta con 4 worker, 0,1 s con la cache. A piena larghezza un browser recente scarica 232 KB invece di 2,7 MB (−91%); la build aggiunge 43 file, 1,3 MB.
- SSIM medio e peso totale delle cinque foto a 1600 px: AVIF 50 113 KB (0,966), AVIF 60 191 KB (0,973), WebP 75 213 KB (0,972), JPEG XL 75 sforzo 4 252 KB (0,973), sforzo 7 252 KB (0,976). A pari qualità JPEG XL a sforzo 4 pesa più di AVIF sulle foto: la build lo tiene nel `<picture>` solo dove è più leggero (regola in `keptSources`). Per averlo più spesso serve uno sforzo più alto, che costa da tre a quattro volte il tempo.
- Il pacchetto desktop cresce di 7,6 MB non compressi (6,8 MB di WebAssembly, 0,7 MB di JavaScript del worker).

## Che cosa riusa il builder

- **Pacchetti:** gli stessi `@jsquash/*` alle stesse versioni. Nel browser servono solo i codificatori (`@jsquash/avif/encode.js`, `@jsquash/jxl/encode.js`, `@jsquash/webp/encode.js`) e `@jsquash/resize`; la decodifica la fa il browser (`createImageBitmap` e un canvas, poi `getImageData`). I moduli `*_mt` cercano i thread solo con l'isolamento cross-origin; senza, jSquash usa da solo le versioni a un thread.
- **API:** `await init(modulo)` una volta per codec (il modulo da `WebAssembly.compileStreaming(fetch(url))` con l'URL del file `.wasm` servito dal plugin, mai da una CDN), poi `encode(imageData, opzioni)` che restituisce un `ArrayBuffer`; `resize(imageData, { width, height, method: "lanczos3", fitMethod: "stretch", premultiply: true, linearRGB: false })`.
- **Opzioni:** quelle di Publish, per avere gli stessi file: AVIF `{ quality: 60, speed: 8 }`, JPEG XL `{ quality: 75, effort: 4 }` (senza perdita `{ lossless: true, effort: 3 }`), WebP `{ quality: 75, method: 4 }` (senza perdita `{ lossless: 1, quality: 50, method: 4 }`). Le costanti stanno in `CMS_IMAGE_SETTINGS_DEFAULTS` (`packages/cms/src/image-variants.ts`) e in `image-worker.ts`.
- **Nel browser:** il lavoro va in un Web Worker; prima di decodificare si leggono le misure (40 megapixel al massimo) e si rifiutano animazioni e profili colore diversi da sRGB come fa `inspectImageForVariants`.

## Conseguenze

- Una build con molte immagini nuove costa tempo la prima volta (circa un secondo per immagine da 4 megapixel con 4 worker); la cache la rende immediata dopo.
- Aggiornare un pacchetto `@jsquash/*` cambia `IMAGE_CODEC_VERSIONS` (un test lo confronta con i pacchetti installati) e invalida la cache.
- Windows: il codice non ha nulla di nativo, ma il pacchetto Windows va costruito e provato su Windows (`npm run dist:windows` rifiuta un altro sistema).
