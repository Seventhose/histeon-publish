# ADR 0004 — Applicazione desktop Electron

Data: 2026-10-21

Stato: **implementata; Linux verificato in locale, Windows configurato in CI**

## Decisioni

| # | Decisione | Motivazione |
|---:|---|---|
| 1 | Distribuire l’app desktop con Electron 45.0.0. | Il motore e il server sono Node.js; Electron include Chromium per il render isolato e `safeStorage` per cifrare i segreti con il portachiavi del sistema. Tauri 2 usa la WebView installata dal sistema e, per riusare il core Node, richiederebbe un sidecar Node con gestione separata del ciclo di vita e dei messaggi. Per il primo rilascio si preferisce un’architettura sola. |
| 2 | Servire la UI con `app://histos-publish` registrato prima di `app.whenReady()` e gestito con `protocol.handle`; non usare `file://`. | L’origine applicativa è stabile, può avere una CSP propria e inoltra solo `/api/*` e `/__preview/*` al server locale già autenticato. File e percorsi del renderer sono risolti sotto la directory di build. |
| 3 | Configurare la finestra UI con `contextIsolation`, `sandbox`, `webSecurity` e `nodeIntegration: false`; negare navigazioni, popup non sicuri, webview, permessi e download. | La UI locale non deve eseguire il contenuto dei siti importati. I link HTTP(S) validi si aprono nel browser di sistema. |
| 4 | Esporre dal preload una sola funzione tipizzata e validare mittente principale, origine, URL e schema con Zod nel processo principale. | Il token di sessione resta nell’header verso il server locale; non viene esposto via IPC. Le azioni privilegiate restano nel processo principale. |
| 5 | Renderizzare i siti in una `BrowserWindow` nascosta, con partizione casuale, senza preload, sandbox attivo, Node disabilitato, download e permessi negati. Intercettare le richieste con CDP e scaricarle tramite il `SafeHttpClient` del core. | Il browser non effettua richieste di rete indipendenti dalle regole del crawler; si registrano asset e API osservati. Il DOM viene salvato con un limite di attesa per `networkidle`; le API della SPA restano segnalate e non sono rese statiche. |
| 6 | Cifrare il token con le API asincrone `safeStorage`; salvare solo il blob cifrato, in un file con permessi utente. Su Linux rifiutare lettura e scrittura se la cifratura non è disponibile o il backend selezionato è `basic_text`. | Il fallback Linux non garantisce protezione del token. La UI invita a sbloccare GNOME Keyring/KWallet o a usare la variabile d’ambiente in sola lettura. |
| 7 | Disattivare `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` e `EnableNodeCliInspectArguments`; attivare `OnlyLoadAppFromAsar`. Su Windows attivare anche `EnableEmbeddedAsarIntegrityValidation` e incorporare l’hash dell’header ASAR nella risorsa PE. | Riduce l’avvio del runtime da variabili e argomenti. Electron supporta la verifica integrità embedded su Windows e macOS; su Linux il fuse resta disattivato. L’ASAR contiene gli hash per file e non include source map. |
| 8 | Sostituire il packager universale con script locali: ASAR e Fuses via `@electron/asar` e `@electron/fuses`; hash PE Windows via `resedit`; `.deb` via `dpkg-deb`; AppImage via `appimagetool` 1.9.1 e runtime 20251108, entrambi fissati e verificati; installer Windows per utente via IExpress e PowerShell, senza elevazione. Generare SHA-256 per ogni artefatto finale. | Evita le dipendenze desktop fuori allowlist e la ricompilazione di moduli nativi. Il setup Windows installa in `%LOCALAPPDATA%`, crea collegamenti utente e include una disinstallazione che conserva dati e segreti. Firma e aggiornamento automatico restano disattivati. |

## Verifiche e limiti

- L’anteprima del server locale resta in un iframe sandbox. La modalità render usa invece il Chromium Electron isolato descritto sopra.
- Il render desktop passa ogni URL al `SafeHttpClient`; il renderer CDP non segue redirect cross-origin e non permette protocolli diversi da HTTP(S).
- Il browser di sistema richiesto dalla modalità render CLI viene individuato separatamente; la CLI non scarica Chromium.
- Il test Electron usa una cartella dati temporanea, rimuove token Cloudflare dall’ambiente del processo e non contatta Cloudflare.
- Il database resta nel formato SQLite corrente e usa `DatabaseSync` di Node; CLI/server richiedono Node 22.13 o superiore. `node:sqlite` è sperimentale nella linea 22 e release candidate in Node 24.15+; Electron 45 incorpora Node 24.22.0.
- Il pacchetto `.deb` ricava le dipendenze di sistema dal binario Electron con `dpkg-shlibdeps`; i tool Debian non vengono inclusi nel pacchetto.
- Il setup Windows usa le utility già presenti nel sistema e l’archivio ZIP resta sotto il limite di 2 GB di `Expand-Archive`. L’installer non copia IExpress o PowerShell nel prodotto. Creazione, installazione, smoke test e rimozione sono codificati nel job Windows della CI.
- L’integrità ASAR protegge l’integrità del pacchetto locale; non sostituisce la firma del distributore o la verifica dell’origine dell’installer. Gli installer non sono firmati.
- L’AppImage costruito con il runtime type 2 fissato può richiedere `libfuse2`/`libfuse2t64` su varie versioni recenti di Ubuntu. Il pacchetto `.deb` non ha questo requisito. L’AppImage non può usare il setuid helper dal mount `nosuid`: `AppRun` verifica la creazione di user e PID namespace; se il kernel/AppArmor la blocca, rimuove il helper dal bundle, passa `--no-sandbox` e la UI mostra un avviso che raccomanda il `.deb`. Il `.deb` conserva invece il helper nell’archivio come `root:root` con permessi `4755`.
- Il render controllato limita richieste e byte, ma una SPA può continuare a dipendere da API esterne dopo la pubblicazione statica.
- Lo smoke test dell’Electron staged e l’E2E sull’AppImage verificano avvio UI, API bootstrap, build locale ed export ZIP. Dove il sistema nega gli user namespace (`unshare --user --map-root-user --pid --fork true`), l’E2E verifica il fallback e l’avviso visibile. L’archivio `.deb` conserva `chrome-sandbox` come `root:root` 4755.
- La CI è configurata per Ubuntu e Windows.

## Fonti ufficiali consultate

Verificate il 2026-10-21.

- Electron, [Security](https://www.electronjs.org/docs/latest/tutorial/security), [protocol](https://www.electronjs.org/docs/latest/api/protocol), [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), [ASAR Integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity), [Debugger](https://www.electronjs.org/docs/latest/api/debugger).
- Chrome DevTools Protocol, [Fetch domain](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/).
- Electron, [distribuzione applicazioni](https://www.electronjs.org/docs/latest/tutorial/application-distribution), [ASAR Integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity) e [Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses).
- Node.js 22, [SQLite API](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html) e [flag SQLite](https://nodejs.org/download/release/v22.13.0/docs/api/cli.html); Node.js, [stato SQLite in 24.x](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html); Electron, [release schedule e Node incluso](https://releases.electronjs.org/schedule), [correzione dell’integrazione SQLite](https://releases.electronjs.org/pr/47706) e [release 45.0.0](https://github.com/electron/electron/releases/tag/v45.0.0).
- AppImage, [appimagetool](https://github.com/AppImage/appimagetool), [licenza](https://github.com/AppImage/appimagetool/blob/main/LICENSE), [runtime type 2](https://github.com/AppImage/type2-runtime) e [licenza runtime](https://github.com/AppImage/type2-runtime/blob/main/LICENSE). Versioni fissate: appimagetool 1.9.1 SHA-256 `ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0`; runtime 20251108 SHA-256 `2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d`.
- Electron Builder, [comportamento AppImage e fallback condizionale quando user namespace non sono disponibili](https://github.com/electron-userland/electron-builder/blob/master/website/docs/appimage.md); Chromium, [restrizioni AppArmor agli user namespace](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
- Microsoft Learn, [creare un setup autoestraente con IExpress](https://learn.microsoft.com/en-us/cpp/windows/deploying-visual-cpp-application-by-using-the-vcpp-redistributable-package?view=msvc-170) e [Expand-Archive](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.archive/expand-archive?view=powershell-5.1).
- Tauri 2, [process model](https://v2.tauri.app/concept/process-model/) e [sidecar](https://v2.tauri.app/develop/sidecar/).
- Electron, [release v45.0.0](https://github.com/electron/electron/releases/tag/v45.0.0), verificata come stabile al momento della scelta.
