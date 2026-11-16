# ADR 0011 — Connettore AI di Histos Publish

Data: 2026-10-26

Stato: **accettata; implementata**

## Contesto

- Serve che un agente AI sul computer dell’utente controlli e importi prototipi, faccia build e anteprime, esporti `.xbsite` e invii in sviluppo a un WordPress collegato. Le scelte di sicurezza sono quelle del connettore del builder: operazioni chiuse, nessun codice dall’agente, solo `127.0.0.1`.
- I segreti WordPress si decifrano solo nel processo dell’app (`safeStorage` di Electron). Anteprime, build registrate e piani di sincronizzazione esistono solo in memoria, in quel processo.
- Il token di sessione della UI apre tutta l’API, deploy, abbinamenti e impostazioni compresi.
- `applyRemoteSyncPlan` esegue l’azione salvata nel piano, e la mappa dei piani ne tiene 32 espellendo il più vecchio.

## Decisioni

| # | Decisione | Motivazione |
|---:|---|---|
| 1 | Le operazioni girano nel processo dell’app (`startLocalServer`), con chiamate di libreria dirette: `importProfile`, `importPrototypeHtml`, `buildCmsProject` ed `exportXbsiteArchive`, esportate da `cms-api.ts`. Il processo dell’agente è un client sottile: non apre mai SQLite, il catalogo o i segreti. Il token di sessione non passa mai dal connettore. | Segreti e stato in memoria stanno solo lì, e resta un solo scrittore sul catalogo. Inoltrare le chiamate a `/api` con il token avrebbe esposto rotte non previste, come l’abbinamento e l’applicazione dei piani. |
| 2 | Un secondo `http.createServer` su `127.0.0.1`, porta scelta dal sistema, `Host` esatto, tre rotte (`GET /v1/hello`, `POST /v1/call`, `POST /v1/prototype`), nessuna CORS e nessuna rotta in comune con la UI. | Il connettore resta isolato dalla UI. Un socket Unix o una named pipe costavano troppo per la v1 (ACL su Windows, lunghezza dei percorsi su macOS); il dispatcher non dipende dal trasporto. |
| 3 | Protocollo firmato derivato da `agent-protocol.ts`, con un proprio separatore di dominio. Il MAC copre metodo, percorso con query, timestamp, nonce, `instance`, client e sha256 del corpo. Ogni risposta a una richiesta autenticata è firmata. Il client manda un hello senza corpo e verifica la prova dell’app prima di qualsiasi dato. Il nonce si registra solo dopo il MAC, e la cache si chiude quando è piena. Niente numeri di sequenza. | Il client non manda HTML o argomenti a un impostore. Chi non ha la chiave non fa leggere corpi all’app e non riempie la cache. Le sequenze rigide romperebbero le chiamate MCP in parallelo e l’annullamento. |
| 4 | Chiave da 32 byte e `instance` nuove a ogni attivazione, solo in `<dati>/connector/session.json` (0600, cartella 0700). Il client legge il file come ssh legge le chiavi. I comandi da copiare non contengono segreti. | Una chiave non sopravvive allo spegnimento e non finisce nella configurazione del client MCP. |
| 5 | Il prototipo lo legge il client, con i permessi dell’agente e i controlli alla ssh: solo `.html`/`.htm`, nessuna componente che inizia con «.», niente collegamenti, `O_NOFOLLOW` con gli stessi `dev`/`ino`, al massimo 32 MiB, UTF-8 rigoroso, marcatore del prototipo. L’app riceve solo byte, mai percorsi. | Le «radici approvate» lette dall’app creano attrito e si aggirano comunque con l’HTML inline. Un file qualunque non arriva mai all’app e non può tornare in un messaggio d’errore. |
| 6 | Gli export li scrive l’app, nella cartella che decide lei e con un nome generato (`O_CREAT \| O_EXCL \| O_NOFOLLOW`, 0600, mai sovrascritti). Un aggiornamento richiede `update: true`, controllato dentro `importProfile`, e salva prima un backup `.histosproject`. Le rotte della UI passano sempre `allowUpdate: true`. | L’agente non sceglie dove scrivere. Un id preso dall’elenco dei progetti non porta a un aggiornamento silenzioso, e non c’è finestra fra controllo e scrittura. |
| 7 | WordPress: solo `push` in sviluppo (rotta `/import`, mai `/publish`), dietro un permesso per collegamento: `off` (predefinito), `confirm`, `auto`. L’inizializzazione è rifiutata, le rimozioni chiedono sempre conferma, il `planId` non esce mai dall’app. Al massimo 2 invii aperti e 6 piani all’ora. | L’app ricontrolla l’azione del piano e non la riceve mai dall’agente. Il tetto impedisce di espellere un piano preparato nella UI. Il sito online cambia solo con una release fatta da una persona. |
| 8 | Spento di default. «Attiva» vale fino alla chiusura dell’app; «Riattiva all’avvio» è spento di default; «Ferma» spegne tutto e toglie la riattivazione. Si accende solo dalle rotte di sessione `/api/connector*`. L’agente non apre mai l’app. | Nessun permesso permanente che si rinnova da solo. |
| 9 | Un solo modulo client, `packages/connector`, impacchettato in un file senza dipendenze per Node ≥ 18. L’app lo copia nella cartella dati a ogni attivazione. La modalità `mcp` del binario dell’app viene dopo la v1. | Funziona su tutte le piattaforme, senza dipendere da uno spike su Electron come server stdio. La versione del client è sempre quella dell’app. |
| 10 | L’elenco chiuso (`packages/connector/src/tools.ts`) è condiviso da client e server; l’app rivalida ogni argomento. Aggiungere un’operazione richiede di cambiare lo snapshot del test e la sezione sicurezza della specifica. | Client e server non divergono, e ogni allargamento dell’ambito passa da una revisione. |
| 11 | Il codice del connettore del builder si copia e si adatta, senza un blocco identico fra i due repository. Le correzioni al protocollo del builder si fanno nel repository del builder, con una modifica a sé. | Le due release restano indipendenti. |

## Conseguenze

- Senza app aperta e connettore acceso, l’agente ha solo il manuale e `hp_status`. Gli altri strumenti rispondono `connector-off`, e l’agente si ferma.
- Finché manca la modalità `mcp` del binario, sul computer serve Node 18 o superiore.
- Mentre il connettore è acceso, qualunque processo dello stesso utente può leggere `session.json`. È un rischio accettato, come nel connettore del builder.
- Gli altri account locali raggiungono la porta TCP, ma si fermano prima della lettura del corpo.
- L’invio a WordPress in modalità `auto` arriva in sviluppo senza conferma, rimozioni escluse; va online con la release successiva del sito, fatta da una persona.
- Il ripristino dei backup non c’è ancora: `importNativeProjectBackup` rifiuta un id già presente.

## Alternative scartate

- Inoltrare le chiamate a `/api` con il token di sessione: espone rotte non previste e mette il token nel codice del connettore.
- Socket Unix o named pipe nella v1: costo e verifiche su Windows e macOS. Restano un miglioramento.
- Numeri di sequenza nel protocollo: rompono parallelismo e annullamento.
- Radici approvate da cui l’app legge file: attrito e nessuna protezione reale.
- Avvio dell’app da parte dell’agente, o accensione salvata come impostazione permanente.
- Codice condiviso byte per byte con il builder: lega le release dei due repository.

## Riferimenti

- Specifica e modello di minaccia del connettore: documenti di progetto interni.
- Protocollo dell’agente di pubblicazione: [ADR 0008](0008-agente-di-pubblicazione.md).
