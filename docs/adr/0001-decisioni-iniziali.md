# ADR 0001 — Decisioni iniziali

Data: 2026-10-21
Stato: **impostazioni iniziali registrate; verifiche tecniche nei passi successivi**

| # | Decisione | Motivazione |
|---|---|---|
| D1 | Nuovo monorepo npm workspaces con Node.js 22 e TypeScript strict; Svelte 5 + Vite per l’interfaccia | La CLI, il server locale, il crawler, l’API Cloudflare e l’app desktop condividono un solo runtime e i contratti TypeScript. |
| D2 | Logica applicativa in packages/core, senza dipendenze UI; CLI, server, UI ed Electron sono adattatori | Build, scanner, storico e deploy hanno comportamento identico in ogni ingresso. Eventi tipizzati e AbortSignal permettono progressi uniformi e annullamento. |
| D3 | App desktop Electron; Tauri 2 non adottato per la prima versione | Electron include Node e Chromium, coerenti con il core e necessari per la modalità render. Tauri riduce il runtime distribuito usando la WebView del sistema, ma richiederebbe un sidecar Node per riusare il core e la sua distribuzione per ogni target. In Linux le WebView di sistema possono differire; su Windows Tauri usa WebView2. Il confronto dimensioni/avvio sarà misurato con i pacchetti, non stimato qui. |
| D4 | Storico in SQLite con `node:sqlite` `DatabaseSync`, migrazioni esplicite e Node.js 22.13 o superiore per CLI/server | Evita binding nativi e ricompilazione per Electron. SQLite conserva il formato esistente, i vincoli, WAL e timeout del singolo writer. L’API è sperimentale in Node 22 e release candidate da Node 24.15; Electron 45 incorpora Node 24.22. Si verifica lo stesso archivio con Node e con l’eseguibile Electron impacchettato. |
| D5 | Segreti dietro un’interfaccia SecretStore: safeStorage asincrono in Electron, portachiavi di sistema con @napi-rs/keyring per CLI/server, variabili d’ambiente in sola lettura | Una stessa regola impedisce di mettere credenziali nei file del sito. Su Linux la UI desktop rifiuta il backend basic_text; non ripiega sulla cifratura con password fissa. L’accesso da env non persiste valori né li restituisce. |
| D6 | API diretta Workers Static Assets, testata solo contro packages/cf-mock | Il flusso manifest/upload/version/deploy supporta upload per hash e versioni immutabili. Il primo deploy reale non rientra nei test automatici. I 429 rispettano Retry-After con tentativi limitati. |
| D7 | L’API diretta carica un Worker minimo con binding ASSETS; niente percorso senza script nel primo rilascio | main_module è richiesto dall’API multipart. Gli asset corrispondenti vengono serviti senza invocare il codice Worker. Questa scelta mantiene un solo flusso di versioni e rollback. |
| D8 | _headers e _redirects passano in `assets.headers` e `assets.redirects`; `assets.config` contiene le opzioni di gestione HTML e 404 | Lo schema API Cloudflare distingue i metadati degli asset da `config`. Il preflight applica limiti espliciti e le regole valgono sulle risposte statiche, non su quelle prodotte dallo script Worker. |
| D9 | Preview workers.dev disattivate per default; attivazione solo con conferma e avviso | La preview è un endpoint pubblico salvo Access. X-Robots-Tag noindex riduce l’indicizzazione ma non limita l’accesso. |
| D10 | SQLite registra siti e deploy, mai segreti; i bundle approvati restano immutabili nel percorso dati dell’utente | Lo storico conserva source kind, date, hash, esito, ID versione e percorso del bundle. Un rollback remoto riusa la versione Cloudflare se disponibile. Se non lo è, si può ricaricare il bundle locale come nuova versione, ma non lo si chiama istantaneo. |
| D11 | Provenienza del codice vincolante dal primo commit | Il codice sarà scritto per Histos Publish. Codice Histos/Static Bridge è riusabile solo entro licenza e provenienza documentate; nessuna modifica ai due progetti senza proposta approvata. |
| D12 | Nessun test contro account Cloudflare reali e nessun deploy reale automatico | Le integrazioni sono simulate. Il primo deploy sarà lanciato dall’utente dopo la guida e i controlli finali. |
| D13 | Interfaccia guidata: aggiungi sorgente, controlla il rilevamento, rivedi i risultati, scegli cartella/ZIP o Cloudflare | Il percorso principale mostra solo le decisioni necessarie; le opzioni tecniche sono in Avanzate. Deploy e modifiche ai domini richiedono un riepilogo e una conferma. |
| D14 | Un solo account Cloudflare nel primo rilascio | Riduce configurazione e gestione delle credenziali; il supporto multi-account si valuta in seguito. |
| D15 | Form rilevati e segnalati, ma inattivi finché l’utente non configura una destinazione | Nessun dato viene inviato a un destinatario scelto implicitamente. L’invio dei form sarà progettato dopo l’MVP. |
| D16 | Pagefind fuori dal primo rilascio; valutazione successiva | Riduce passaggi e dipendenze nella prima versione, mantenendo la ricerca nel piano evolutivo. |
| D17 | User-Agent `HistosPublish/<versione> (+https://github.com/Seventhose/histeon-publish)` | L’URL identifica il crawler; verificarlo prima di ogni rilascio. |
| D18 | Packaging Windows predisposto; firma e aggiornamenti automatici non attivi | Mancano provider e certificato scelti. La firma si attiverà con una decisione successiva. |
| D19 | Biome per il lint del monorepo; ESLint non incluso | Biome mantiene lint locale con un solo pacchetto e una licenza ammessa dalla policy delle dipendenze; il lockfile e il registro includono anche i binari opzionali per piattaforma. |
| D20 | Crawler HTTP del core senza browser nella prima versione | Chiede consenso per l’origine, usa un User-Agent identificativo, rispetta robots.txt per default, mantiene il perimetro del sito e fissa gli IP verificati alla connessione. Limita profondità, pagine, file e byte; non trasferisce credenziali su redirect; asset esterni solo con allowlist. Playwright/Chromium arriva con la modalità render. |
## 1. Scelta desktop: Electron e Tauri

La documentazione Electron raccomanda contenuti locali o remoti fidati, contextIsolation, sandbox, Node disattivato nei renderer, CSP restrittiva, navigazione e nuove finestre controllate, IPC con mittente verificato e uso delle Fuses. safeStorage offre cifratura legata al sistema operativo: DPAPI su Windows e portachiavi configurabili su Linux. La documentazione di safeStorage avverte che il backend Linux basic_text non protegge i dati; il programma non deve usarlo.

La modalità render richiede Chromium e un profilo separato. Electron lo distribuisce insieme all’app e permette di creare una finestra senza preload o API native. Il rendering del sito non condivide sessione con la UI.

Tauri 2 usa WebView2 su Windows e WebKitGTK su Linux. La sua documentazione descrive sidecar come eseguibili esterni, con binari distinti per target. Il core Node riusato via sidecar richiederebbe quindi un altro processo e una matrice di build. Per questa prima versione si preferisce un solo runtime, senza un processo in più. Nessuna stima di dimensione è stata assunta.

## 2. Persistenza e segreti

Il database conserva configurazioni non segrete e storia:

- sito e percorso del file histos-publish.json;
- build ID, sorgente, hash, timestamp, elenco di asset e risultati dello scanner senza estratti;
- account ID e nome Worker solo se non considerati segreti;
- version ID e deployment ID Cloudflare;
- stato di build, export, deploy e rollback.

Non conserva token Cloudflare, JWT upload, Application Password, cookie, password HTTP o chiavi dei form. Il portachiavi contiene la credenziale, associata all’identità dell’account. Le variabili d’ambiente hanno precedenza esplicita quando fornite e sono solo lettura.

`node:sqlite` resta sperimentale nella linea Node 22 ed è release candidate nella linea Node 24 da 24.15. Si verificano persistenza e apertura dell’archivio con Node standalone e negli eseguibili Linux impacchettati; non è richiesto un modulo nativo o un passaggio di ricompilazione. Il pacchetto Windows usa il runtime incluso in Electron.

## 3. API Cloudflare e Worker

Flusso: manifest degli asset → upload dei soli hash richiesti → upload versione del Worker con assets JWT → deployment al 100%. Nome Worker, account, versione, annotazione e destinazione sono dati di configurazione; le credenziali provengono solo da SecretStore o env.

Il comportamento statico usa 404-page per default. SPA con single-page-application richiede una scelta esplicita. Il Worker non intercetta asset corrispondenti. I form non hanno un destinatario predefinito. Il client non abilita da solo workers.dev preview né associa domini.

Cloudflare documenta le quote per piano, ma non dichiara nella pagina consultata un periodo esatto di retention delle versioni. Il client manterrà un bundle locale immutabile e controllerà la versione remota prima di offrire rollback.

## 4. Permessi

L’API token sarà limitato a Cloudflare Workers e agli account/zone necessari. I ruoli documentati attualmente richiedono accesso Editor per le versioni di un Worker; aggiungere o cambiare un dominio o una route richiede inoltre Workers Routes Write per ogni zona. La creazione del Worker ha un requisito più alto. La UI dovrà distinguere l’operazione e mostrare il permesso minimo richiesto prima di abilitarla.

L’endpoint base può arrivare solo da HISTOS_CLOUDFLARE_API_BASE: HTTPS in uso normale, host di produzione verificato, localhost solo per il mock. Né la configurazione del sito né la UI possono dirottare il token.

## 5. Riferimenti ufficiali consultati il 2026-10-21

- Cloudflare: [Direct Uploads](https://developers.cloudflare.com/workers/static-assets/direct-upload/), [Multipart upload metadata](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/), [Static Assets](https://developers.cloudflare.com/workers/static-assets/).
- Cloudflare: [Limits](https://developers.cloudflare.com/workers/platform/limits/), [Headers](https://developers.cloudflare.com/workers/static-assets/headers/), [Redirects](https://developers.cloudflare.com/workers/static-assets/redirects/).
- Cloudflare: [Workers API](https://developers.cloudflare.com/api/resources/workers/), [Workers script schema](https://developers.cloudflare.com/api/terraform/resources/workers/subresources/scripts/), [Versioni e deployment](https://developers.cloudflare.com/workers/versions-and-deployments/).
- Cloudflare: [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Workers roles](https://developers.cloudflare.com/workers/authorization/workers/), [API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/).
- Electron: [Security](https://www.electronjs.org/docs/latest/tutorial/security), [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage), [Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses).
- Tauri 2: [Process Model](https://v2.tauri.app/concept/process-model/), [Embedding External Binaries](https://v2.tauri.app/develop/sidecar/).
- Node.js 22, [SQLite API](https://nodejs.org/download/release/v22.13.0/docs/api/sqlite.html) e [flag `--experimental-sqlite`](https://nodejs.org/download/release/v22.13.0/docs/api/cli.html): API integrata e non più dietro flag da v22.13; resta sperimentale. In Node 24.15+ è release candidate ([documentazione 24.x](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)).

## 6. Impostazioni MVP adottate

1. Worker minimo con binding `ASSETS` per il primo deploy.
2. Form rilevati ma inattivi finché l’utente non configura una destinazione.
3. Pagefind fuori dall’MVP; valutarlo dopo il primo rilascio.
4. Un account Cloudflare nel primo rilascio.
5. Packaging Windows senza firma né aggiornamento automatico; aggiungere un provider solo dopo una decisione successiva.
6. User-Agent `HistosPublish/<versione> (+https://github.com/Seventhose/histeon-publish)`; ricontrollare l’URL prima del rilascio.

Queste sono le scelte del primo rilascio. Si riaprono soltanto se una nuova esigenza modifica il perimetro dell’MVP.
