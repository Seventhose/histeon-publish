# Avvisi sulle licenze del desktop

- Electron 45.0.0: MIT. La distribuzione contiene `LICENSE` e `LICENSES.chromium.html` forniti da Electron.
- Playwright Core 1.64.1: Apache-2.0. Il testo della licenza resta nel pacchetto ASAR.
- Zod 4.6.7: MIT. Il testo della licenza resta nel pacchetto ASAR.
- axe-core 4.10.3: MPL-2.0, non modificato (sorgente su https://github.com/dequelabs/axe-core). Il controllo dei prototipi lo esegue nelle pagine dell’anteprima; `axe.min.js`, i messaggi italiani, `LICENSE` e `LICENSE-3RD-PARTY.txt` (le librerie che include, MIT) restano in `node_modules/axe-core` nel pacchetto ASAR.
- Pagefind 1.5.2: MIT. L’interfaccia Node e i testi di licenza restano nel pacchetto ASAR; il binario per la piattaforma è in `resources/pagefind/`.
- `ssh2` 1.17.0: MIT. Il client SFTP viene incluso nel processo desktop; il testo della licenza è in `licenses/ssh2-MIT.txt`.
- `asn1` 0.2.6 e `safer-buffer` 2.1.2: MIT. Le licenze sono incluse accanto ai moduli SFTP in `node_modules/asn1/LICENSE` e `node_modules/safer-buffer/LICENSE`.
- jSquash (`@jsquash/avif` 2.1.1, `@jsquash/jxl` 1.3.0, `@jsquash/webp` 1.5.0, `@jsquash/jpeg` 1.6.0, `@jsquash/png` 3.1.1, `@jsquash/resize` 2.1.1) e `wasm-feature-detect` 1.9.0: Apache-2.0. Il codificatore delle immagini (coda B6) è in `image-worker.js`; i moduli WebAssembly a un thread e le licenze sono in `image-codecs/` dentro il pacchetto ASAR. Le librerie compilate in WebAssembly: libavif (BSD-2-Clause) con libaom (BSD-2-Clause e Alliance for Open Media Patent License 1.0, licenza di brevetto gratuita), libjxl (BSD-3-Clause, con la concessione gratuita di brevetti di Google nel file `PATENTS` del progetto libjxl), libwebp (BSD-3-Clause), mozjpeg (IJG, BSD-3-Clause e zlib), i crate Rust `png` e `resize` (MIT o Apache-2.0). I testi sono in `licenses/libaom-BSD-2-Clause-and-AOM-Patent-License-1.0.txt`, `licenses/libavif-BSD-2-Clause.txt`, `licenses/libjxl-BSD-3-Clause.txt` e in `image-codecs/licenses/`. Nessun codec commerciale, nessuna chiave di licenza.
- `bcrypt-pbkdf` 1.0.3: BSD-3-Clause (codice OpenBSD con modifica locale SHA-512 tramite `node:crypto`). Il testo integrale della licenza è in `licenses/bcrypt-pbkdf-BSD-3-Clause.txt`.

L’installer Windows è prodotto con IExpress e PowerShell già presenti in Windows. Questi strumenti non vengono copiati nel prodotto. Il programma installato non richiede Node.js né un runtime .NET.

## Algoritmo di decompressione Core Framework

Il decoder locale UTF-16 in `packages/cms/src/core-framework-preset.ts` segue l’algoritmo MIT `lz-string` per leggere gli export `.core`. Mantiene limiti espliciti di dimensione, output e dizionario; il pacchetto `lz-string` non è incluso nel runtime dell’app.

MIT License

Copyright (c) 2013 pieroxy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Fixture del preset Core Framework

Il file `packages/cms/test/fixtures/core-framework-default-preset.json` è un campione ridotto di `DEFAULT_PRESET` e `DEFAULT_PREFERENCES` del repository Core Framework al commit `9e7390a2959fe73c62dcb39107f4b4158e7daab5`. Il file `packages/cms/test/fixtures/core-framework-default-preset-1.1.0.json` conserva invece il preset completo `GET_DEFAULT_PRESET_1_1_0` fornito dallo stesso commit. Sono fixture di test, non codice runtime, e non vengono incluse nel prodotto desktop.

L'adapter offline `packages/cms/src/core-framework-css.ts` riproduce le parti verificate del formato CSS 1.1.0. Le regole `prefers-reduced-motion` seguono l'implementazione MIT del progetto; il CSS ufficiale previsto dal test upstream è conservato come fixture di confronto. Le condizioni e i limiti sono descritti in `docs/progettazione/histos-cms/13-framework-css.md`.

Core Framework è distribuito con licenza MIT. Copyright (c) 2026 David Babinec.

MIT License

Copyright (c) 2026 David Babinec

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: [Core Framework at the pinned commit](https://github.com/CoreBunch/Core-Framework/tree/9e7390a2959fe73c62dcb39107f4b4158e7daab5).

## Trasformazione gradienti easing Core Framework

`packages/cms/src/core-easing-gradients.ts` adatta il trasformatore easing del Core Framework 1.1.0 al commit `9e7390a2959fe73c62dcb39107f4b4158e7daab5`, distribuito con licenza MIT. L'adattamento conserva le regole non convertibili e le segnala all'utente. Il codice usa `easing-coordinates` 2.0.2 (MIT), `chroma-js` 2.4.2 (BSD-3-Clause AND Apache-2.0) e `postcss-value-parser` 4.2.0 (MIT); i testi di licenza sono inclusi nella cartella `licenses/` dell'app.

## Progetto citato ma non incluso

FluentSMTP è sviluppato da WPManageNinja LLC e dai contributori del progetto; il plugin è GPL-2.0-or-later. Histeon Publish non lo distribuisce e non è affiliato ai suoi autori. È citato soltanto come trasporto opzionale di `wp_mail()` sul sito WordPress. [Repository ufficiale e licenza](https://github.com/WPManageNinja/fluent-smtp).
