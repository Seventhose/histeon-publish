# Agente di pubblicazione — specifica di implementazione (v1)

Stato: **specifica di partenza**, scritta prima dell'implementazione; ciò che è stato fatto è nell'ADR 0008 e in `docs/AGENTE.md`. Il lato Histeon (WordPress) segue il contratto di questo documento, nel repository Histeon.
Origine: una decisione di Histeon («worker opzionale di Static Bridge per chi ospita in proprio»).
Data: 22 ottobre 2026. Versione di Histeon Publish di partenza: 0.1.8.

---

## 0. Come leggere questo documento

Questo documento è scritto per chi implementa senza conoscere il resto del progetto. Ogni regola è da applicare alla lettera.

- **DEVE / NON DEVE**: obbligo. Una differenza è un errore.
- **PUÒ**: facoltativo.
- I blocchi `così` sono nomi esatti: file, funzioni, campi JSON, header, codici di errore. Vanno scritti identici, maiuscole comprese.
- Se una regola sembra in conflitto con il codice esistente, **fermati e chiedi**. Non scegliere da solo.
- Le sezioni 1–3 spiegano il perché. Le sezioni 4–14 dicono cosa fare. La sezione 15 elenca i test. La sezione 16 è il lato Histeon, da **non** implementare qui.

### Confini fissi (valgono per tutta l'implementazione)

1. Nessuna richiesta a Cloudflare reale. Si usa solo il mock `packages/cf-mock`.
2. Nessun sito WordPress reale. Si usa solo la fixture `test-sites/wp` (Docker, locale).
3. Nessun segreto reale nei test, nei log, nei commit o nei messaggi.
4. Non indebolire nessun controllo esistente del crawler, dello scanner o del client Cloudflare. Le eccezioni nuove previste qui valgono **solo** in modalità agente e solo come descritto.

---

## 1. Contesto: i pezzi in gioco

### 1.1 Histeon
Histeon è un plugin WordPress, un costruttore di siti; i suoi identificatori usano il prefisso `XB`/`xb`. Una delle sue funzioni è **pubblicare il sito come copia statica su Cloudflare Workers Static Assets**:

1. Histeon genera le pagine in «modalità export»: è una richiesta anonima con l'header `X-XB-Export`, che toglie dalla pagina ciò che una copia statica non deve contenere.
2. Le controlla con uno scanner.
3. Le carica su Cloudflare con un **token API Cloudflare salvato dentro WordPress**: in `wp-config.php` oppure cifrato nel database.

**Il problema:** se WordPress viene compromesso, l'attaccante legge il token. Con il token può modificare il Worker e, a seconda dei permessi, altro nell'account Cloudflare.

### 1.2 La decisione
Per chi ospita in proprio, cioè ha un server suo o una VPS con Docker, si offre un **processo separato** che:
- legge il sito WordPress via HTTP, come farebbe un visitatore;
- scrive solo nella propria cartella;
- **custodisce il token Cloudflare**, che WordPress non vede mai;
- pubblica quando WordPress glielo chiede con una richiesta firmata da un segreto condiviso.

Chi compromette WordPress può ancora chiedere una pubblicazione, ma **non può rubare il token** né usarlo per altro.

### 1.3 Perché in Histeon Publish
Histeon Publish (questo repository) sa già fare quasi tutto:

| Serve | C'è già | Dove |
|---|---|---|
| Leggere un sito via HTTP in sicurezza | crawler con blocco SSRF, limiti, robots | `packages/core/src/crawler.ts`, `crawler-http.ts` (`SafeHttpClient`) |
| Scanner di segreti e nonce | sì, blocca i nonce WordPress | `packages/core/src/scanner.ts` |
| Bundle e manifest | sì | `packages/core/src/bundle.ts` (`buildBundle`) |
| Deploy su Workers Static Assets, rollback | sì | `packages/core/src/deploy.ts` (`deployBundle`, `rollbackVersion`), `cloudflare.ts` (`CloudflareClient`) |
| Mock Cloudflare | sì | `packages/cf-mock` |
| Fixture WordPress | sì | `test-sites/wp` |

Manca il **modo di essere comandato da WordPress senza un umano davanti**. Oggi Histeon Publish ha la CLI, l'interfaccia web solo sulla loopback e l'app desktop: tutti chiedono conferma a una persona. Questa specifica aggiunge una **modalità servizio**.

### 1.4 Terminologia (importante, per evitare confusione)

| Termine in questo documento | Significato |
|---|---|
| **agente** | Il nuovo processo Histeon Publish in modalità servizio, avviato con `histos-publish agent`. |
| **Worker Cloudflare** | Lo script su Cloudflare che serve i file statici. Esiste già in Histeon Publish con questo nome. |
| **Histeon** | Il plugin WordPress, client dell'agente. |
| **job** | Una richiesta di pubblicazione o di ripristino, eseguita dall'agente. |

**NON chiamare l'agente «worker»** nel codice, nei nomi di file, nella UI o nei log: in questo repository «Worker» significa già il Worker Cloudflare. La decisione di Histeon lo chiama «worker di Static Bridge», ma **Static Bridge non è coinvolto**: è un altro modulo di Histeon, che copia il sito sullo stesso server. Il deploy Cloudflare di Histeon è nel nucleo di Histeon (`plugin/src/Deploy/`).

---

## 2. Proprietà di sicurezza da garantire (invarianti)

L'implementazione è corretta solo se valgono **tutte**. Ognuna ha almeno un test (sezione 15).

| # | Invariante |
|---|---|
| A1 | Il token Cloudflare non esce mai dall'agente: niente risposte HTTP, log, file di stato, messaggi di errore o bundle. |
| A2 | WordPress non può scegliere **cosa** leggere fuori dal proprio sito, **dove** pubblicare (account, Worker) né **con quale** token. Tutto questo sta solo nella configurazione dell'agente. |
| A3 | Ogni richiesta che cambia stato o legge dati è autenticata con HMAC-SHA256, ha una finestra di tempo di 300 secondi ed è usabile **una sola volta** (anti-replay). |
| A4 | Le risposte dell'agente sono firmate: WordPress può verificare che uno stato «pubblicato» viene davvero dall'agente. |
| A5 | L'agente legge solo l'origine configurata, più gli asset esterni che la configurazione ammette esplicitamente. Nessun redirect o link lo porta altrove. |
| A6 | L'agente scrive solo nella propria cartella dati. |
| A7 | Non parte nessun deploy se lo scanner trova un problema bloccante, se una pagina non conferma la modalità export, o se il sito usa i moduli nativi di Histeon (sezione 9.6). |
| A8 | L'agente non è raggiungibile da Internet per configurazione predefinita: ascolta solo su loopback o su indirizzi privati espliciti. |
| A9 | Un errore non rivela dettagli interni: niente percorsi assoluti, stack trace, estratti dello scanner o contenuto delle pagine. |

### 2.1 Cosa NON protegge (dirlo nella documentazione utente)
- **WordPress compromesso pubblica contenuti alterati.** Chi controlla WordPress controlla già i contenuti: l'agente li pubblicherà. L'agente protegge il **token**, non il contenuto.
- **WordPress compromesso può chiedere un ripristino** a una versione recente dello stesso Worker, o annullare un job.
- **Agente compromesso = token compromesso.** L'agente va eseguito con un utente di sistema dedicato, diverso da quello del web server.

---

## 3. Architettura

```
         ┌────────────────────────── stesso server o rete privata ──────────────────────────┐
         │                                                                                   │
         │   WordPress + Histeon                         Agente (histos-publish agent)        │
         │   ─────────────────                          ─────────────────────────────        │
         │   conosce: URL agente, id chiave,            conosce: token Cloudflare,           │
         │            segreto condiviso                          segreto condiviso,          │
         │                                                       origine del sito,           │
         │                                                       account e Worker            │
         │        │  (1) POST /v1/publish, firmato HMAC                ▲                      │
         │        └───────────────────────────────────────────────────┘                      │
         │        ▲  (2) GET pagine con X-XB-Export (anonimo)          │                      │
         │        └────────────────────────────────────────────────────┘                     │
         │        │  (4) GET /v1/jobs/{id}, firmato (polling)           ▲                     │
         │        └───────────────────────────────────────────────────┘                      │
         └───────────────────────────────────────────────────────────────────────────────────┘
                                                                  │ (3) HTTPS + token
                                                                  ▼
                                                     api.cloudflare.com/client/v4
```

1. Histeon chiede una pubblicazione e passa un **token di export**, che vale 15–30 minuti e permette solo di vedere le pagine pubbliche in modalità export.
2. L'agente legge il sito con quel token nell'header `X-XB-Export`.
3. L'agente controlla e pubblica con il proprio token Cloudflare.
4. Histeon chiede lo stato finché il job non è finito. **L'agente non chiama mai WordPress per notificare**: non ha e non deve avere credenziali WordPress.

---

## 4. Avvio e comandi della CLI

Aggiungere a `packages/cli/src/index.ts` due comandi nuovi, nello stile degli esistenti (`program.command(...)`).

### 4.1 `histos-publish agent`
```
histos-publish agent --config <file>
```
- `--config` è **obbligatorio**. Nessun valore predefinito, nessuna ricerca automatica di `histos-publish.json`.
- Legge la configurazione (sezione 5) e i segreti (sezione 6), apre il database (sezione 10.4) e si mette in ascolto.
- Stampa su stdout **una riga JSON** all'avvio: `{"event":"agent-started","listen":"127.0.0.1:8787","site":"https://wp.example.org","script":"esempio-sito","apiVersion":1}`. Non stampa account id, segreti o token.
- Su `SIGTERM` o `SIGINT`:
  - smette di accettare richieste nuove (`503`, `shutting_down`);
  - annulla il job in corso (`AbortController`);
  - lo segna `failed` con `agent_stopped`;
  - chiude il database ed esce con codice 0 entro 30 secondi.
- Codici di uscita: `0` ok, `2` configurazione non valida, `4` segreti mancanti o con permessi sbagliati, `1` altro errore. Sono gli stessi codici già documentati nella CLI.

### 4.2 `histos-publish agent-key`
```
histos-publish agent-key --keys-file <file> --id <id>
```
Genera una chiave condivisa nuova:
- 32 byte da `crypto.randomBytes(32)`, codificati **base64url senza padding**: 43 caratteri.
- `--id`: `^[a-z0-9][a-z0-9-]{0,31}$`. Se esiste già nel file: errore, codice 2.
- Se il file non esiste, lo crea con permessi `0600`. Se esiste, lo riscrive in modo atomico (file temporaneo nella stessa cartella, poi `rename`) e mantiene `0600`. Se i permessi del file esistente sono più larghi di `0600`: errore, codice 4.
- Il file contiene al massimo 2 chiavi, per la rotazione. Con 2 chiavi già presenti: errore, codice 2, con il messaggio «Rimuovi prima la chiave vecchia».
- Stampa su stdout **una sola volta**: `{"id":"k1","secret":"<43 caratteri>"}`. È l'unico momento in cui il segreto appare: l'utente lo copia nella configurazione di Histeon.

### 4.3 Cosa NON fare
- Niente opzione `--yes` per l'agente: la conferma è la richiesta firmata.
- L'agente non riusa `startLocalServer` di `packages/server`. È un server HTTP **separato** (`node:http`) in un modulo nuovo, `packages/server/src/agent.ts`, con regole diverse: niente UI, niente token di sessione, niente SQLite dell'app desktop. Le funzioni di core si riusano; il server UI no.

---

## 5. Configurazione: `agent.json`

Un file JSON indicato da `--config`. Si valida con uno schema **AJV**, già usato in `packages/core/src/config.ts`, con `additionalProperties: false` a ogni livello. Va aggiunto `docs/spec/agent.schema.json`.

### 5.1 Esempio completo
```json
{
  "schemaVersion": 1,
  "listen": {
    "host": "127.0.0.1",
    "port": 8787,
    "allowedHosts": ["127.0.0.1:8787", "localhost:8787"]
  },
  "dataDir": "/var/lib/histos-publish-agent",
  "site": {
    "name": "esempio",
    "origin": "https://wp.example.org",
    "privateNetwork": false,
    "crawl": {
      "concurrency": 4,
      "delayMs": 50,
      "timeoutMs": 60000,
      "maxPages": 5000,
      "maxDepth": 12,
      "maxBytes": 536870912,
      "includeFeeds": false
    },
    "rewrite": { "externalAssets": [] },
    "pagefind": false
  },
  "cloudflare": {
    "accountId": "0123456789abcdef0123456789abcdef",
    "script": "esempio-sito",
    "maxFiles": 20000
  },
  "limits": {
    "publishPerHour": 30,
    "requestsPerMinute": 120
  },
  "retention": {
    "jobsDays": 90,
    "keepBundles": 1
  }
}
```

### 5.2 Campi

| Campo | Tipo e vincoli | Predefinito | Note |
|---|---|---|---|
| `schemaVersion` | costante `1` | — | Obbligatorio. |
| `listen.host` | stringa: un letterale IP. Ammessi `127.0.0.1`, `::1` o un indirizzo privato RFC 1918 o ULA `fc00::/7`. `0.0.0.0` e `::` solo con `listen.allInterfaces: true`. | `127.0.0.1` | Un nome host (es. `localhost`) **non** è ammesso. Un IP pubblico: errore. |
| `listen.allInterfaces` | booleano | `false` | Serve solo in un container con la porta non pubblicata (sezione 13.2). Con `true`, all'avvio l'agente scrive su stderr un avviso: `{"event":"warning","code":"listening-all-interfaces"}`. |
| `listen.port` | intero 1024–65535 | `8787` | |
| `listen.allowedHosts` | array di 1–8 stringhe `host:porta`, ognuna di al massimo 255 caratteri. IPv6 tra parentesi quadre: `[::1]:8787` | `["<host>:<port>"]` | Valori ammessi dell'header `Host` (sezione 7.1). Con Docker si aggiunge il nome del servizio, es. `histos-agent:8787`. |
| `dataDir` | percorso assoluto | — | Obbligatorio. Creato con `0700` se manca; se esiste con permessi più larghi: errore 4. |
| `site.name` | `^[a-z0-9][a-z0-9-]{0,62}$` | — | Solo per log e messaggi. |
| `site.origin` | URL `http:` o `https:` con **solo** origine: path `/` o vuoto, niente query, frammento o credenziali | — | DEVE coincidere con l'origine dell'indirizzo del sito WordPress (opzione `home`). WordPress in una sottocartella **non** è supportato nella v1. `http:` è ammesso solo se l'host è loopback oppure con `site.privateNetwork: true`. |
| `site.privateNetwork` | booleano | `false` | Permette che `site.origin` risolva a indirizzi privati (es. `http://wordpress` in una rete Docker). Vedi 9.2. |
| `site.crawl.*` | come `SiteConfig.crawl` (`packages/core/src/types.ts`), ma **solo** i campi della tabella sopra | come nel crawler | `urls`, `render`, `bypassCache`, `respectRobots`, `ignoreRobots` e `siteManaged` **non** sono ammessi qui: l'agente li imposta da solo (9.1). |
| `site.rewrite.externalAssets` | come `SiteConfig.rewrite.externalAssets` | `[]` | |
| `site.pagefind` | booleano | `false` | Come oggi. |
| `site.forms` | come `SiteConfig.forms` | assente | Moduli Fluent Forms, come oggi. Con i moduli, serve anche il segreto Turnstile (6.3). |
| `cloudflare.accountId` | `^[0-9a-f]{32}$` | — | Obbligatorio. |
| `cloudflare.script` | `^[a-z0-9-]{1,63}$` | — | Obbligatorio. Va usato un Worker **dedicato** a questo sito (13.4). |
| `cloudflare.maxFiles` | intero 1–100000 | `20000` | Come oggi. |
| `limits.publishPerHour` | intero 1–600 | `30` | Massimo di `POST /v1/publish` e `POST /v1/rollback` accettati in un'ora, per chiave. |
| `limits.requestsPerMinute` | intero 10–6000 | `120` | Massimo di richieste firmate valide in un minuto, per chiave. |
| `retention.jobsDays` | intero 1–3650 | `90` | Dopo, i job finiti vengono cancellati dal database. |
| `retention.keepBundles` | intero 0–5 | `1` | Quanti bundle di job `complete` tenere su disco. Gli altri si cancellano a fine job. |

### 5.3 Validazione all'avvio (in quest'ordine)
1. Il file esiste, è un file regolare, non supera 64 KiB ed è JSON valido. Altrimenti esce con codice 2.
2. Rispetta lo schema. Altrimenti codice 2, con un messaggio che indica il **percorso** del campo errato e non il valore.
3. Il file di configurazione non è scrivibile dal gruppo o dagli altri (`mode & 0o022 === 0`). Altrimenti codice 2: chi può modificarlo può cambiare dove si pubblica.
4. Controlli semantici:
   - `listen.host` ammesso;
   - `site.origin` normalizzato (`new URL(...).origin`) ammesso;
   - `http:` solo se consentito;
   - `cloudflare.*` coerente con `cloudflareSettings()` della CLI.

   Altrimenti codice 2.

---

## 6. Segreti

**Mai** nel file `agent.json`. **Mai** nel portachiavi di sistema: l'agente è un servizio senza sessione grafica, e il portachiavi di sistema (`@napi-rs/keyring`) richiede una sessione utente. Si leggono da variabili d'ambiente o da **file indicati in variabili d'ambiente**: è il formato di Docker secrets e di systemd `LoadCredential=`.

### 6.1 Token Cloudflare
Sorgenti, in quest'ordine:
1. `HISTOS_CLOUDFLARE_API_TOKEN_FILE`: percorso di un file.
2. `HISTOS_CLOUDFLARE_API_TOKEN`: il valore; è la variabile che esiste già, `CLOUDFLARE_TOKEN_ENV` in `packages/core/src/secrets.ts`.

Se mancano entrambe: errore e codice di uscita 4. Se ci sono entrambe: errore e codice 4, per evitare ambiguità.

Regole per ogni **file di segreto** (vale anche per 6.2 e 6.3):
- Si legge con `fs.open` e `fstat` **sullo stesso descrittore**, per non controllare un file e leggerne un altro.
- Deve essere un file regolare, non un symlink: controllare con `lstat` prima dell'apertura e usare `O_NOFOLLOW` dove la piattaforma lo supporta.
- Proprietario e permessi: il file è accettato **solo** in uno di questi due casi; in ogni altro si rifiuta (codice 4).
  - (a) `stat.uid === process.getuid()` e `(stat.mode & 0o777)` vale `0o400` oppure `0o600`;
  - (b) `stat.uid === 0`, `stat.gid === process.getgid()` e `(stat.mode & 0o777) === 0o440`. È il caso delle credenziali di systemd.

  L'agente è supportato solo su Linux nella v1: su altri sistemi esce con codice 2.
- Dimensione: al massimo 4 KiB. Si toglie solo il `\n` o `\r\n` finale. Un file vuoto è un errore.
- Il token si legge **una volta all'avvio** e si tiene in memoria. Non va scritto in nessun file dell'agente.

Implementazione: aggiungere in `packages/core/src/secrets.ts` una funzione `readSecretFile(path: string, label: string): Promise<string>` con queste regole, e `readAgentCloudflareToken(env)`. **Non** cambiare il comportamento di `readCloudflareToken()`, usata dalla CLI e dal desktop.

### 6.2 Chiavi condivise con Histeon
- Variabile `HISTOS_AGENT_KEYS_FILE`: percorso di un file JSON, con le stesse regole di 6.1. È il file creato da `histos-publish agent-key`.
- Formato:
  ```json
  { "keys": [ { "id": "k1", "secret": "<43 caratteri base64url>" } ] }
  ```
- 1 o 2 chiavi. `id` come in 4.2. `secret`: esattamente 43 caratteri `[A-Za-z0-9_-]` e, decodificato in base64url, **esattamente 32 byte**. Altrimenti errore e codice 4.
- **La chiave HMAC sono i 32 byte decodificati**, non la stringa di 43 caratteri. È la causa più probabile di firme che non tornano: vedi i vettori di prova in 7.6.
- Rotazione:
  1. si aggiunge `k2` con `agent-key`;
  2. si riavvia l'agente;
  3. si aggiorna Histeon;
  4. si toglie `k1` a mano dal file;
  5. si riavvia.

  Le due chiavi sono valide insieme.

### 6.3 Segreto Turnstile (solo con `site.forms`)
`HISTOS_TURNSTILE_SECRET_FILE`, stesse regole di 6.1. Se `site.forms` è configurato e il segreto manca: errore all'avvio, codice 4. Si passa a `deployBundle({ turnstileSecret })` come fa oggi `deployCommand` nella CLI.

### 6.4 Redazione
Ogni stringa diretta a log, risposta HTTP o database passa da una funzione `redactSecrets(text)` con i valori esatti di token, segreti delle chiavi e segreto Turnstile, e i token di export dei job in corso. Ogni occorrenza diventa `[redatto]`. Questo **si aggiunge** alla redazione già fatta da `CloudflareClient` e non la sostituisce.

---

## 7. Protocollo: autenticazione HMAC

### 7.1 Trasporto
- HTTP/1.1 in chiaro, su loopback o rete privata. **Non** implementare TLS nella v1: integrità e autenticità vengono dall'HMAC. Il contenuto non è segreto: il token di export dura al massimo 30 minuti e permette solo di vedere pagine pubbliche. Se WordPress e l'agente sono su macchine diverse attraverso una rete non fidata, la documentazione utente indica un tunnel (WireGuard o SSH).
- Prima dell'HMAC si rifiuta, in quest'ordine:
  1. `Host` assente o non presente in `listen.allowedHosts`, confronto esatto senza distinguere maiuscole: `400 invalid_host`.
  2. Presenza dell'header `Origin`: `403 forbidden`. Un browser non deve poter parlare con l'agente; WordPress (`wp_remote_*`) non manda `Origin`.
  3. Metodo non previsto per la rotta: `405 method_not_allowed`, con header `Allow`.
  4. Corpo oltre **2 MiB** (2 097 152 byte): `413 body_too_large`. Leggere in streaming e interrompere appena si supera; non fidarsi di `Content-Length`.
  5. Con un corpo, `Content-Type` diverso da `application/json` (si ammette solo il parametro `charset=utf-8`): `415 unsupported_media_type`.
- Nessun header CORS, in nessuna risposta.
- Protezione dalle richieste in massa non autenticate, che il limite di 7.4 punto 6 non copre:
  - `server.headersTimeout = 10_000`;
  - `server.requestTimeout = 30_000`;
  - `server.maxHeadersCount = 50`;
  - al massimo 32 connessioni aperte insieme (`server.maxConnections = 32`);
  - header oltre 16 KiB rifiutati (`maxHeaderSize`).
- Ogni risposta ha:
  - `Cache-Control: no-store`;
  - `Content-Type: application/json; charset=utf-8`, se c'è un corpo;
  - `X-Content-Type-Options: nosniff`.

### 7.2 Header della richiesta firmata
| Header | Formato | Esempio |
|---|---|---|
| `X-Histos-Key` | id della chiave, come in 4.2 | `k1` |
| `X-Histos-Timestamp` | secondi Unix, solo cifre, 10 caratteri | `1793000000` |
| `X-Histos-Nonce` | 32 caratteri esadecimali minuscoli (128 bit casuali) | `00112233445566778899aabbccddeeff` |
| `X-Histos-Signature` | `v1=` + 64 caratteri esadecimali minuscoli | `v1=291e4cf7…` |

### 7.3 Stringa canonica della richiesta
Sette righe unite da `\n` (un solo LF, nessun `\n` finale), codificate in UTF-8:
```
HISTOS-AGENT-V1
<METODO in maiuscolo>
<path della richiesta, esattamente come arriva, query compresa>
<X-Histos-Timestamp>
<X-Histos-Nonce>
<X-Histos-Key>
<sha256 esadecimale minuscolo dei byte grezzi del corpo>
```
- Il path è `request.url` di `node:http`, così come arriva, senza normalizzazioni (niente decodifica di `%xx`, niente rimozione di `/` doppi). Esempi: `/v1/publish`, `/v1/jobs?limit=20`.
- Senza corpo (GET), si usa lo sha256 della stringa vuota: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Firma: `hex(HMAC-SHA256(chiave = 32 byte decodificati, messaggio = stringa canonica))`.

### 7.4 Verifica (DEVE seguire quest'ordine)
1. I quattro header esistono e rispettano il formato di 7.2. Altrimenti `401 unauthorized`.
2. `X-Histos-Key` è una delle chiavi caricate. Altrimenti `401 unauthorized`.
3. `|ora_agente − timestamp| ≤ 300` secondi. Altrimenti `401 unauthorized`.
4. Si calcola la firma attesa e si confronta con `crypto.timingSafeEqual` su due `Buffer` di 32 byte, ottenuti dall'esadecimale. Se il formato non permette di ottenere 32 byte: `401` **prima** del confronto. Firma diversa: `401 unauthorized`.
5. **Solo dopo** una firma valida: si registra `(key, nonce)` nella tabella anti-replay (10.4). Se esiste già: `401 unauthorized`.

   Inserimento atomico: `INSERT` con vincolo `PRIMARY KEY (key_id, nonce)`; un conflitto significa replay.

   Le righe più vecchie di 900 secondi si cancellano al massimo una volta al minuto.
6. Limiti di frequenza (`limits.*`), contati **dopo** la verifica e per chiave. Oltre il limite: `429 rate_limited`, con `Retry-After` in secondi interi.

Tutti i fallimenti dei passi 1–5 rispondono **esattamente**:
```json
{"error":{"code":"unauthorized","message":"Richiesta non autorizzata.","retryable":false}}
```
Il motivo preciso (`bad_format`, `unknown_key`, `stale_timestamp`, `bad_signature`, `replayed_nonce`) va **solo** nel log dell'agente (sezione 11), mai nella risposta: non deve fare da oracolo.

### 7.5 Firma della risposta
Ogni risposta a una richiesta che ha superato la verifica (anche errori 4xx/5xx successivi, come `404 not_found`) porta:
| Header | Valore |
|---|---|
| `X-Histos-Timestamp` | secondi Unix al momento della risposta |
| `X-Histos-Signature` | `v1=` + hex HMAC-SHA256, con la **stessa chiave** della richiesta, di: |

```
HISTOS-AGENT-V1-RESPONSE
<codice di stato HTTP, es. 202>
<X-Histos-Nonce della richiesta>
<X-Histos-Timestamp della risposta>
<sha256 esadecimale minuscolo dei byte esatti del corpo della risposta>
```
Le risposte `401`, `400 invalid_host`, `403`, `405`, `413` e `415` **non** sono firmate: l'agente non ha ancora stabilito quale chiave usare. Histeon le tratta come errori senza fidarsi del contenuto.

Il corpo va serializzato **una volta** (`JSON.stringify`). Si firmano quei byte e si spediscono gli stessi byte. Non serializzare due volte.

### 7.6 Vettori di prova (DEVONO diventare test automatici)
Chiave: `id = k1`, `secret = AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8` (i byte da 0 a 31). È una chiave di prova pubblica: non va mai usata in un'installazione.

**Vettore 1, richiesta POST.**
- Metodo `POST`, path `/v1/publish`, timestamp `1793000000`, nonce `00112233445566778899aabbccddeeff`.
- Corpo (225 byte, su una riga, senza a capo finale):
  ```
  {"request_id":"3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b","release":{"version":"1.4.0","label":"Nuova home"},"export_token":"1793000900.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","paths":["/","/chi-siamo/"]}
  ```
- sha256 del corpo: `ab5902899ca73cc74892bd30d9fc900832e00fac7de2e0cf0c77ac3180018d6f`
- Firma attesa: `v1=291e4cf7828bfbbc48b904891466e1c1af7c5500b44a91bd239fd76f1facd7ee`

**Vettore 2, richiesta GET senza corpo.**
- Metodo `GET`, path `/v1/jobs/7c9e6679-7425-40de-944b-e07fc1f90ae7`, timestamp `1793000060`, nonce `ffeeddccbbaa99887766554433221100`.
- Firma attesa: `v1=944a1618969472417b5c52f3899ba8e4826b5d8a53029781e31e1cb178b6e2f1`

**Vettore 3, risposta al vettore 1.**
- Stato `202`, timestamp della risposta `1793000001`.
- Corpo: `{"job":{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","type":"publish","status":"queued"}}`
- sha256 del corpo: `c43e34100c00b101a5ac6a19b5542ceef69204b3bfc3f4449aef6ca59f24c1f2`
- Firma attesa: `v1=a5bc10303c037fad19a3f9b60a284a4fc17f1b08efe41ef566b924e7d2ee6214`

I vettori servono a provare l'algoritmo: il corpo del vettore 3 è più corto di una risposta reale. Riferimento Node (verificato):
```ts
import { createHash, createHmac } from "node:crypto";
const key = Buffer.from("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8", "base64url"); // 32 byte
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const canonical = ["HISTOS-AGENT-V1", "GET", "/v1/jobs/7c9e6679-7425-40de-944b-e07fc1f90ae7", "1793000060",
  "ffeeddccbbaa99887766554433221100", "k1", sha("")].join("\n");
createHmac("sha256", key).update(canonical).digest("hex"); // 944a1618…b6e2f1
```

---

## 8. API

Base: `/v1`. Tutte le rotte richiedono la firma (sezione 7), tranne `GET /healthz`. I corpi JSON vanno validati con AJV e `additionalProperties: false`. Un campo sconosciuto dà `400 invalid_request`.

### 8.1 Formato degli errori
```json
{"error":{"code":"<codice stabile>","message":"<frase in italiano, senza dati del sito>","retryable":true}}
```

| HTTP | `code` | `retryable` | Quando |
|---|---|---|---|
| 400 | `invalid_request` | false | JSON non valido o fuori schema. `message` dice il campo, non il valore. |
| 400 | `invalid_host` | false | 7.1. |
| 401 | `unauthorized` | false | 7.4. |
| 403 | `forbidden` | false | Header `Origin` presente. |
| 404 | `not_found` | false | Rotta o job inesistente. |
| 405 | `method_not_allowed` | false | |
| 409 | `request_id_reused` | false | Stesso `request_id` con un corpo diverso (8.3). |
| 409 | `not_cancellable` | false | Annullamento di un job già finito. |
| 413 | `body_too_large` | false | |
| 415 | `unsupported_media_type` | false | |
| 429 | `rate_limited` | true | Con `Retry-After`. |
| 500 | `internal` | true | Qualsiasi eccezione non prevista. **Mai** il messaggio dell'eccezione. |
| 502 | `cloudflare_error` | true | Errore dell'API Cloudflare in `GET /v1/deployments`. Messaggio già redatto. |
| 503 | `shutting_down` | true | Durante lo spegnimento. |

### 8.2 `GET /healthz` (non firmata)
Risposta `204` senza corpo e senza altri dati. Serve solo al healthcheck del container. Applica comunque i controlli di 7.1, punti 1–3.

### 8.3 `POST /v1/publish`
Chiede una pubblicazione.

Corpo:
| Campo | Vincoli | Note |
|---|---|---|
| `request_id` | UUID v4 minuscolo: `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` | Idempotenza, vedi sotto. |
| `release.version` | `^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$` | La versione della release Histeon (es. `1.4.0`). |
| `release.label` | stringa di 0–120 caratteri, facoltativa. Senza caratteri di controllo (`\p{Cc}`) | Nota della release. |
| `export_token` | `^[0-9]{10}\.[0-9a-f]{64}$` | Token di export di Histeon (sezione 16.2). L'agente **non** sa verificarlo: lo inoltra e controlla l'eco (9.3). |
| `paths` | array facoltativo di 0–20000 stringhe, ciascuna di 1–1024 caratteri | Percorsi da cui partire (9.4). |

Regole su ogni elemento di `paths`. Un elemento che non le rispetta rende **tutta** la richiesta `400 invalid_request`:
- inizia con `/`;
- non contiene `?`, `#`, `\`, caratteri di controllo né spazi;
- dopo `decodeURIComponent`, nessun segmento è `.` o `..`. Se `decodeURIComponent` lancia un errore, la richiesta è `400`;
- non inizia con `//`.

I duplicati si tolgono senza errore.

Controllo del token di export: se la scadenza (la parte prima del punto) è già passata, o è oltre `ora + 1800`: `400 invalid_request`, campo `export_token`.

**Idempotenza.** Si salva `request_id` con lo sha256 del corpo.
- Stesso `request_id` e stesso sha256: si risponde con lo stato **attuale** di quel job (`200`), senza crearne un altro.
- Stesso `request_id` e sha256 diverso: `409 request_id_reused`.
- Il ricordo dei `request_id` dura quanto il job (`retention.jobsDays`).

**Coda.** Al massimo un job `running` e un job `queued`.
- Nessun job attivo: il nuovo diventa `queued` e parte subito.
- Un job `running` e nessuno in coda: il nuovo diventa `queued`.
- Un job `running` e uno `queued`: quello in coda passa a `superseded` e il nuovo prende il suo posto. Le release si sostituiscono: conta solo l'ultima.

Risposta `202`:
```json
{"job":{ ...oggetto job, sezione 8.7... }}
```

### 8.4 `GET /v1/jobs/{id}`
`{id}`: UUID v4 come sopra, altrimenti `404 not_found`. Risposta `200`: `{"job":{...}}`. Un job inesistente o cancellato dalla retention: `404 not_found`.

### 8.5 `GET /v1/jobs?limit=<n>`
`limit` intero 1–50, predefinito 20. Risposta `200`: `{"jobs":[...]}`, dal più recente. Ogni elemento è l'oggetto job **senza** `findings.items`.

### 8.6 `POST /v1/jobs/{id}/cancel`
Corpo: `{}`. Se il job è `queued` diventa `cancelled`. Se è `running`, si annulla con `AbortController` e diventa `cancelled` quando la pipeline si ferma: se l'upload su Cloudflare è già iniziato, la versione caricata resta su Cloudflare **ma non viene distribuita**. In entrambi i casi la risposta è `200` con il job. Un job già finito: `409 not_cancellable`.

### 8.7 Oggetto job
```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "type": "publish",
  "status": "running",
  "phase": "crawl",
  "request_id": "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b",
  "release": { "version": "1.4.0", "label": "Nuova home" },
  "created_at": "2026-10-22T10:00:00.000Z",
  "started_at": "2026-10-22T10:00:00.120Z",
  "finished_at": null,
  "progress": { "pages": 12, "assets": 40, "bytes": 1048576, "uploaded": 0, "to_upload": 0 },
  "findings": { "block": 0, "warn": 1, "items": [ { "code": "admin-link", "severity": "warn", "file": "chi-siamo/index.html" } ] },
  "error": null,
  "result": null
}
```

| Campo | Valori |
|---|---|
| `type` | `publish` o `rollback` |
| `status` | `queued`, `running`, `complete`, `blocked`, `failed`, `cancelled`, `superseded` |
| `phase` | `null` se non `running`; altrimenti `crawl`, `scan`, `upload`, `version`, `deploy`, `rollback` |
| `progress` | Contatori che non diminuiscono mai. `bytes` = byte letti dal sito. |
| `findings.items` | Al massimo 200 elementi: prima i `block`, poi i `warn`, poi per `file`. Contengono solo `code`, `severity` e `file`, senza estratti (come oggi). `file` è un percorso relativo del bundle. |
| `error` | `null` oppure `{"code","message","retryable"}` (codici in 9.8). |
| `result` | `null` oppure, a job `complete`: `{"version_id","deployment_id","files","uploaded"}` per `publish`, `{"version_id","deployment_id"}` per `rollback`. |

Stati finali: `complete`, `blocked`, `failed`, `cancelled`, `superseded`. Un job finito non cambia più.

**Mai** nel job: `export_token`, `paths`, URL completi, percorsi assoluti, account id, messaggi grezzi di eccezioni.

### 8.8 `GET /v1/deployments`
Risposta `200`:
```json
{"deployments":[{"id":"…","created_on":"…","versions":[{"version_id":"…","percentage":100}],"message":"Histeon 1.4.0"}]}
```
Viene da `CloudflareClient.listDeployments(accountId, script)`. `message` è `annotations["workers/message"]` oppure `null`. Al massimo 20 elementi. Un errore Cloudflare: `502 cloudflare_error` (tabella 8.1).

### 8.9 `POST /v1/rollback`
Corpo: `{"request_id": "<uuid v4>", "target": "<id>"}`, con `target` che rispetta `^[0-9a-f-]{8,64}$`. Crea un job `type: "rollback"`, con la stessa idempotenza e la stessa coda di 8.3. Il job chiama `rollbackVersion({ client, accountId, script, deploymentOrVersionId: target, message: "Ripristino richiesto da Histeon" })`. `rollbackVersion` accetta già solo gli id presenti in `listDeployments` di **quello** script. Se l'id non c'è: job `failed` con `rollback_target_unknown`.

### 8.10 `GET /v1/info`
Risposta `200`:
```json
{"api_version":1,"agent_version":"0.1.9","site":{"origin":"https://wp.example.org"},"cloudflare":{"script":"esempio-sito"},"busy":false,"limits":{"maxPaths":20000,"exportTokenMaxSeconds":1800}}
```
Serve a Histeon per il pulsante «Prova la connessione». Non contiene `accountId` né altri dati.

---

## 9. La pipeline di un job `publish`

### 9.1 Configurazione della build
Per ogni job, l'agente costruisce in memoria un `SiteConfig` (`packages/core/src/types.ts`) così:
```ts
{
  schemaVersion: 1,
  name: agent.site.name,
  source: { kind: "url", path: agent.site.origin + "/" },
  crawl: {
    ...agent.site.crawl,
    siteManaged: true,      // l'operatore dichiara di gestire il sito (config dell'agente)
    ignoreRobots: true,     // ammesso solo con siteManaged; un sito di staging spesso ha Disallow: /
    bypassCache: true,      // mai risposte dalla cache del crawler
  },
  rewrite: agent.site.rewrite,
  pagefind: agent.site.pagefind,
  forms: agent.site.forms,
  cloudflare: { accountId, script, maxFiles },
}
```
- `crawlConsent` = `new URL(agent.site.origin).origin`. Il consenso è la configurazione stessa dell'agente: non si usa né si scrive il file `crawl-consents.json` della CLI.
- `cacheDirectory`: **non** impostato. L'agente non usa la cache persistente del crawler.
- `outputDirectory`: `<dataDir>/bundles/<job-id>/`, creata con `0700`.
- Il `SiteConfig` va validato con `parseSiteConfig()`. Un errore qui è un bug dell'agente: job `failed` con `internal`.

### 9.2 Rete privata (modifica a `SafeHttpClient`)
Oggi `resolvePinned()` (`crawler-http.ts`, ~riga 156) blocca gli indirizzi privati, salvo la loopback quando anche l'origine è loopback. Va aggiunta un'opzione:
```ts
interface HttpClientOptions { /* … */ privateOrigin?: boolean }
```
Con `privateOrigin: true`:
- vale **solo** per richieste il cui `hostname` coincide esattamente con quello dell'origine. Per gli asset esterni (`externalAssets`) resta il blocco attuale;
- ammessa solo se **tutti** gli indirizzi risolti sono privati o loopback. Se alcuni sono pubblici e altri privati, si blocca con `crawl-private-network`: è la difesa contro il DNS rebinding;
- gli indirizzi restano «fissati» (pinned) come oggi.

`crawlSite()` riceve un parametro nuovo, `privateOrigin?: boolean`, e lo passa a `SafeHttpClient`. **Non** è un campo di `SiteConfig` né del suo schema JSON: la CLI e il desktop non possono attivarlo. Solo l'agente lo passa, con `agent.site.privateNetwork`.

Test: privato con l'opzione è ammesso; privato senza l'opzione è bloccato; risoluzione mista è bloccata; un asset esterno privato con l'opzione è bloccato.

### 9.3 Modalità export di Histeon (modifiche al crawler)
Histeon genera la pagina «pulita» solo se la richiesta porta `X-XB-Export: <export_token>`. Risponde con lo stesso valore in `X-XB-Export-Render`. Se l'eco manca, la pagina può venire da una cache davanti a WordPress, e non è garantito che sia in modalità export.

Modifiche:
1. `crawlSite()` riceve `originHeaders?: Record<string, string>`. `SafeHttpClient.get()` li aggiunge **solo** se `url.origin === this.origin.origin`: mai verso asset esterni, mai dopo un redirect verso un'altra origine (già vietato oggi).
2. `crawlSite()` riceve `requireEcho?: { header: string; value: string }`. Per ogni risposta HTML (`content-type` che inizia con `text/html`) dell'origine con stato 200 o 404, se `headerValue(headers, header) !== value` la build si ferma: errore `HistosPublishError(…, "export-mode-not-confirmed", 2)`. Non si salva nulla della pagina.
3. L'agente passa `originHeaders: { "X-XB-Export": export_token }` e `requireEcho: { header: "x-xb-export-render", value: export_token }`.
4. Il token di export **non** va in nessun log, finding, report o file del bundle.

Scadenza: se durante la build l'ora supera la scadenza del token, l'agente annulla la build e il job finisce `failed` con `export_token_expired`, `retryable: true`. Una build non deve mai mescolare pagine in modalità export e pagine normali.

### 9.4 Pagine di partenza (`paths`)
`crawlSite()` riceve `seedPaths?: string[]` (già validati in 8.3), al massimo 20000. Ogni path diventa `new URL(path, origin)` e va accodato come le `crawl.urls` attuali (`crawler.ts`, ~riga 644), con profondità 0. **Non** passarli in `crawl.urls`: lo schema JSON lo limita a 500 elementi, e quel limite resta per la CLI. Se `seedPaths` supera `maxPages`, i primi `maxPages` si visitano e il report segnala un `warn` con codice `seed-paths-truncated`.

### 9.5 Pagina 404
Histeon Publish oggi non crea `404.html`, mentre Histeon lo fa. Il Worker Cloudflare usa `not_found_handling: "404-page"`. Dopo il crawl, l'agente:
1. chiede `GET <origin>/histos-404-<16 hex casuali>/` con gli stessi header e lo stesso controllo dell'eco;
2. si aspetta lo stato **404**. Se l'eco va bene, il corpo viene trattato come una pagina, con la stessa riscrittura dei link, e salvato come `404.html` alla radice del bundle;
3. con uno stato diverso da 404 (es. 200 o 301), aggiunge un finding `warn`, `missing-404-page`, e prosegue senza `404.html`.

Implementarlo come opzione `notFoundProbe?: boolean` di `buildBundle`/`crawlSite`, attiva solo dall'agente. Se è più semplice, PUÒ diventare predefinita anche per le sorgenti WordPress della CLI, ma solo con un ADR a parte. Nella v1 resta solo nell'agente.

### 9.6 Moduli nativi di Histeon (blocco)
I moduli di contatto nativi di Histeon inviano a `POST /xb-form`, con un campo nascosto `name="xb_form"`, a un Worker Cloudflare **di Histeon** che inoltra a WordPress con un protocollo suo. Il Worker che pubblica Histeon Publish è diverso: i moduli smetterebbero di funzionare in silenzio.

Durante la scansione si analizzano le pagine HTML **sorgente**, prima di qualsiasi riscrittura dei moduli. Se una contiene un elemento `<input>` con attributo `name` uguale a `xb_form`, si aggiunge un finding `block` con codice `histos-forms-unsupported` e `file` = percorso della pagina. Il job finisce `blocked`. Va usato il parser HTML già presente (`html.ts`); niente regex sull'HTML grezzo.

### 9.7 Sequenza completa
| # | Fase (`phase`) | Azione | Se fallisce |
|---|---|---|---|
| 1 | — | `status: running`, `started_at`. Si crea l'`AbortController` del job. | |
| 2 | `crawl` | `buildBundle(...)` con 9.1–9.5, `onEvent` → `progress` | Errore di sorgente → `failed`, codice dalla tabella 9.8 |
| 3 | `scan` | Scanner esistente più 9.6. Il risultato di `buildBundle` ha `status: "blocked"` → stop. | `blocked`, `error: {"code":"scan_blocked",…}` |
| 4 | `upload` | `loadBundleFiles(bundlePath)` (va spostata da `packages/cli/src/index.ts` a core, vedi sotto), `planCloudflareManifest(files, maxFiles)`, poi `deployBundle({ client, accountId, script, files, findings, forms, turnstileSecret, message, maxFiles, signal, onEvent })` | `failed`, `cloudflare_error` |
| 5 | `version`, `deploy` | Avanzamento dagli eventi di `deployBundle` | `failed`, `cloudflare_error` |
| 6 | — | `status: complete`, `result`, `finished_at` | |
| 7 | — | Pulizia: si tengono gli ultimi `retention.keepBundles` bundle di job `complete`; tutti gli altri bundle di questo job si cancellano, anche se `blocked` o `failed`. | Un errore di pulizia va nel log e non cambia lo stato. |

- `message` per Cloudflare: `Histeon <release.version>`, più ` — <release.label>` se c'è una label. Tagliare a 1000 byte UTF-8: lo fa già `truncateUtf8` in `deployVersion`.
- `CloudflareClient`: `new CloudflareClient({ token, apiBase? })`. `apiBase` solo da `HISTOS_CLOUDFLARE_API_BASE`, come oggi.
- **Spostamento di `loadBundleFiles`.** Portarla in `packages/core/src/bundle-files.ts` ed esportarla da `packages/core/src/index.ts`. La CLI la importa da lì, **senza cambiare comportamento**: è un refactoring puro, in un commit a parte con i test della CLI verdi.

### 9.8 Codici di errore del job (`error.code`)
| Codice | `retryable` | Origine |
|---|---|---|
| `scan_blocked` | false | Lo scanner ha trovato almeno un `block`, compreso `histos-forms-unsupported`. |
| `export_mode_not_confirmed` | false | 9.3, eco assente o diverso. Di solito c'è una cache davanti a WordPress. |
| `export_token_expired` | true | 9.3. |
| `source_unreachable` | true | Errori del crawler con codice di uscita 5 (`crawl-dns-failed`, timeout…). |
| `source_rejected` | false | Errori del crawler con codice di uscita 2 (`crawl-private-network`, `crawl-cross-origin`…). |
| `cloudflare_error` | true | `CloudflareApiError` o errori di `deployBundle`. |
| `rollback_target_unknown` | false | 8.9. |
| `agent_restarted` | true | 10.3. |
| `agent_stopped` | true | 4.1. |
| `internal` | true | Tutto il resto. |

Il `message` dell'errore è una frase fissa in italiano per ogni codice. Il messaggio originale, già redatto, va solo nel log.

---

## 10. Stato e persistenza

### 10.1 Cartella dati
```
<dataDir>/                 0700
  agent.db                 0600   SQLite (node:sqlite, DatabaseSync, come packages/server/src/repository.ts)
  bundles/<job-id>/        0700   bundle in lavorazione o conservati
  tmp/                     0700   temporanei; svuotata all'avvio
```
L'agente non scrive altrove. Le funzioni di core che hanno bisogno di temporanei ricevono cartelle dentro `<dataDir>/tmp/`.

### 10.2 Un solo agente per cartella
All'avvio si crea `<dataDir>/agent.lock` con `open(..., "wx")`, e dentro il pid. Se esiste e quel pid è vivo (`process.kill(pid, 0)`), si esce con codice 2: «Un altro agente usa questa cartella». Se il pid non esiste più, il lock si sostituisce. Il lock si toglie allo spegnimento.

### 10.3 Riavvio
All'avvio, ogni job `running` o `queued` diventa `failed` con `agent_restarted`. Il token di export non è persistito (10.4), quindi un job in coda non può ripartire. Histeon ripeterà la richiesta.

### 10.4 Schema SQLite
```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,                 -- uuid v4 generato dall'agente (crypto.randomUUID)
  type TEXT NOT NULL CHECK (type IN ('publish','rollback')),
  status TEXT NOT NULL,
  phase TEXT,
  request_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  release_version TEXT,
  release_label TEXT,
  rollback_target TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  progress_json TEXT NOT NULL DEFAULT '{}',
  findings_json TEXT NOT NULL DEFAULT '{"block":0,"warn":0,"items":[]}',
  error_json TEXT,
  result_json TEXT,
  UNIQUE (key_id, request_id)
);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at);
CREATE TABLE IF NOT EXISTS nonces (
  key_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  seen_at INTEGER NOT NULL,            -- secondi Unix
  PRIMARY KEY (key_id, nonce)
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);  -- 'schema_version' = '1'
```
- **Non** si salvano `export_token` né `paths`: vivono solo in memoria per il job in corso o in coda.
- L'idempotenza (8.3) è per `(key_id, request_id)`: due chiavi diverse non condividono gli id.
- La pulizia della retention avviene all'avvio e poi ogni ora.

---

## 11. Log e audit

- Su stdout, **una riga JSON per evento** (NDJSON). Nessun file di log scritto dall'agente: ci pensano systemd o Docker.
- Campi sempre presenti: `time` (ISO 8601), `event`.
- Eventi minimi:
  - `agent-started`, `agent-stopping`;
  - `request` con `method`, `route` (il **modello** della rotta, es. `/v1/jobs/:id`, mai il path reale), `status`, `key` (id, mai il segreto), `ms`;
  - `auth-failed` con `reason` tra `bad_format`, `unknown_key`, `stale_timestamp`, `bad_signature`, `replayed_nonce`, e `remote` (indirizzo IP);
  - `job-queued`, `job-started`, `job-phase`, `job-finished` con `id`, `type`, `status`, `error` (solo il codice);
  - `job-superseded`, `retention-cleanup`, `warning`.
- **Mai** nei log: token, segreti, `X-Histos-Signature`, `export_token`, corpi delle richieste, `paths`, URL con query, estratti dello scanner. Ogni riga passa da `redactSecrets` (6.4).

---

## 12. Modifiche al codice esistente (riepilogo)

| File | Modifica | Retrocompatibile? |
|---|---|---|
| `packages/core/src/crawler-http.ts` | `privateOrigin` (9.2); intestazioni solo verso l'origine (9.3) | Sì: opzioni facoltative, predefinito invariato |
| `packages/core/src/crawler.ts` | `privateOrigin`, `originHeaders`, `requireEcho`, `seedPaths`, `notFoundProbe` in `CrawlInput` | Sì |
| `packages/core/src/bundle.ts` / `types.ts` | Gli stessi campi in `BuildOptions`, passati a `crawlSite`; non in `SiteConfig` | Sì |
| `packages/core/src/scanner.ts` | Regola `histos-forms-unsupported`, attiva solo se richiesta, oppure controllo nell'agente sull'HTML sorgente | Sì |
| `packages/core/src/secrets.ts` | `readSecretFile`, `readAgentCloudflareToken` | Sì |
| `packages/core/src/bundle-files.ts` (nuovo) | `loadBundleFiles` spostata dalla CLI | Sì |
| `packages/server/src/agent.ts` (nuovo) | Server HTTP, verifica HMAC, coda, pipeline, SQLite | Nuovo |
| `packages/cli/src/index.ts` | Comandi `agent` e `agent-key` | Sì |
| `docs/spec/agent.schema.json` (nuovo) | Schema di 5.2 | — |
| `docs/adr/0008-agente-di-pubblicazione.md` (nuovo) | Decisioni di questa specifica (sezione 17) | — |
| Modello di minaccia del progetto | Nuove righe (sezione 14) | — |
| `CHANGELOG.md`, `README.md` | Versione 0.1.9 | — |

Nessuna modifica a `packages/ui`, `packages/desktop` o al server UI esistente.

---

## 13. Installazione (va documentata in `docs/AGENTE.md`, nuovo)

### 13.1 systemd (consigliato)
```ini
# /etc/systemd/system/histos-publish-agent.service
[Unit]
Description=Histeon Publish — agente di pubblicazione
After=network-online.target

[Service]
User=histos-agent
Group=histos-agent
ExecStart=/usr/bin/node /opt/histos-publish/packages/cli/dist/index.js agent --config /etc/histos-publish/agent.json
LoadCredential=cloudflare-token:/etc/histos-publish/secrets/cloudflare-token
LoadCredential=agent-keys:/etc/histos-publish/secrets/agent-keys.json
Environment=HISTOS_CLOUDFLARE_API_TOKEN_FILE=%d/cloudflare-token
Environment=HISTOS_AGENT_KEYS_FILE=%d/agent-keys.json
StateDirectory=histos-publish-agent
StateDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/histos-publish-agent
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
L'utente `histos-agent` **non** è quello del web server (`www-data`), e il web server non può leggere `/etc/histos-publish/secrets/`. Con `LoadCredential=`, systemd consegna i file con i permessi corretti: va verificato che `readSecretFile` li accetti (6.1) e documentato il risultato.

### 13.2 Docker
Aggiungere `packages/server/Dockerfile.agent` (o `docker/agent/Dockerfile`):
- immagine base `node:22-bookworm-slim` con digest fissato;
- `npm ci --omit=dev` dei soli pacchetti `core`, `server` e `cli`, **senza** Electron e UI;
- `USER 10001:10001`, `WORKDIR /app`. Il volume dati deve appartenere a `10001`, e i file segreti sull'host vanno messi con `chown 10001` e `chmod 0400`: compose li monta così come sono (caso (a) di 6.1);
- `HEALTHCHECK CMD node -e "require('http').get('http://127.0.0.1:8787/healthz',r=>process.exit(r.statusCode===204?0:1)).on('error',()=>process.exit(1))"`.

Esempio di `compose.yaml`, in `docs/AGENTE.md`:
```yaml
services:
  histos-agent:
    image: histos-publish-agent:0.1.9
    read_only: true
    tmpfs: ["/tmp"]
    volumes:
      - agent-data:/var/lib/histos-publish-agent
      - ./agent.json:/etc/histos-publish/agent.json:ro
    secrets: [cloudflare-token, agent-keys]
    environment:
      HISTOS_CLOUDFLARE_API_TOKEN_FILE: /run/secrets/cloudflare-token
      HISTOS_AGENT_KEYS_FILE: /run/secrets/agent-keys
    networks: [wp-internal]
    # NESSUNA sezione "ports": l'agente non è raggiungibile dall'esterno
secrets:
  cloudflare-token: { file: ./secrets/cloudflare-token }
  agent-keys: { file: ./secrets/agent-keys.json }
volumes: { agent-data: {} }
networks: { wp-internal: { external: true } }
```
In questo caso `agent.json` ha `"listen": {"host":"0.0.0.0","allInterfaces":true,"port":8787,"allowedHosts":["histos-agent:8787","127.0.0.1:8787"]}` e `"site": {"origin":"http://wordpress","privateNetwork":true, …}`. L'indirizzo `home` di WordPress deve essere `http://wordpress`: con un `home` pubblico, l'agente deve poter raggiungere quell'indirizzo pubblico (limite della v1, sezione 18).

### 13.3 Permessi del token Cloudflare
Gli stessi di oggi: *Account › Workers Scripts › Edit*, meglio un Account API Token limitato al singolo Worker (`docs/PRIMO-DEPLOY.md`). L'agente **non** gestisce i domini: il comando `domain` resta solo nella CLI e nel desktop, con conferma umana.

### 13.4 Worker dedicato
Il Worker Cloudflare indicato in `cloudflare.script` deve essere usato **solo** dall'agente. Se prima era pubblicato da Histeon direttamente, il primo deploy dell'agente ne sostituisce il codice: i moduli nativi di Histeon smetterebbero di funzionare. Per questo l'agente li blocca (9.6). Va scritto in `docs/AGENTE.md`.

---

## 14. Minacce e difese

| Minaccia | Mitigazione |
|---|---|
| Richieste false o ripetute all'agente | HMAC-SHA256 con chiave da 256 bit, finestra di 300 s, nonce monouso persistito, `timingSafeEqual`, risposte 401 identiche, limiti per chiave. |
| WordPress compromesso usa l'agente | Può solo pubblicare il proprio sito, ripristinare versioni recenti dello stesso Worker, annullare o leggere lo stato. Non sceglie origine, account, Worker o token; non legge il token. |
| Agente esposto in rete | Ascolto solo su loopback o IP privati; `0.0.0.0` solo con un'opzione esplicita e un avviso; controllo di `Host`; rifiuto di `Origin`; niente CORS; nessuna porta pubblicata nell'esempio Docker. |
| Status falsificato verso WordPress | Risposte firmate legate al nonce della richiesta (7.5). |

---

## 15. Test obbligatori

Ogni test va nel framework già usato: `vitest` per gli unitari, Playwright o vitest per l'integrazione. Nessuna rete esterna.

### 15.1 Unitari
1. **Vettori di prova 7.6**: i tre vettori producono le firme esatte.
2. **Verifica HMAC** (7.4), un caso per ognuno:
   - header mancante;
   - formato del timestamp errato;
   - nonce non esadecimale o di lunghezza sbagliata;
   - firma senza `v1=`;
   - chiave sconosciuta;
   - timestamp a +301 s e a −301 s, che falliscono;
   - timestamp a ±300 s, che passa;
   - firma con un carattere cambiato;
   - corpo con un byte cambiato;
   - path con una query cambiata;
   - metodo cambiato;
   - nonce ripetuto, che passa la prima volta e fallisce la seconda;
   - nonce ripetuto dopo un riavvio (database persistito), che fallisce.

   In ogni fallimento, il corpo della risposta è identico byte per byte.
3. **Firma delle risposte**: presente sulle 2xx e sui 404 dopo l'autenticazione; assente su 401, 403, 405, 413 e 415.
4. **Configurazione** (5.3): ogni campo fuori schema; `listen.host` uguale a `0.0.0.0` senza `allInterfaces`; IP pubblico; nome host; origine con path; `http:` pubblico senza `privateNetwork`; file di configurazione scrivibile dal gruppo.
5. **Segreti** (6): file assente; vuoto; oltre 4 KiB; `0644`; symlink; proprietario diverso (simulato); entrambe le sorgenti del token; chiave lunga 42 o 44 caratteri; chiave di 31 byte decodificati; tre chiavi nel file.
6. **`paths`** (8.3): `..`, `%2e%2e`, `//host`, `?`, `#`, `\`, carattere di controllo, 1025 caratteri, 20001 elementi, `%` non valido. Tutti danno `400`.
7. **Idempotenza e coda** (8.3): stesso id e stesso corpo danno lo stesso job; stesso id e corpo diverso danno `409`; la terza richiesta mette in `superseded` quella in coda.
8. **`SafeHttpClient`**: i casi di 9.2. Gli `originHeaders` non vanno verso un asset esterno ammesso.
9. **Redazione** (6.4): token, segreti ed export token passati in un'eccezione non compaiono nel log né nella risposta.

### 15.2 Integrazione (agente reale, mock Cloudflare, fixture)
Si avvia l'agente su una porta casuale, con `HISTOS_CLOUDFLARE_API_BASE` puntato a `packages/cf-mock` e una cartella dati temporanea.

**A. Fixture HTTP minima che simula Histeon.** È un server `node:http` scritto nel test, che risponde solo con l'export token giusto e fa l'eco in `X-XB-Export-Render`.
1. Il flusso completo arriva a `complete`. Il mock riceve un deploy, e nel bundle ci sono le pagine e `404.html`.
2. Senza l'eco (la fixture lo «dimentica» su una pagina): job `failed` con `export_mode_not_confirmed`, e nessun deploy sul mock.
3. Un export token che scade a metà: `export_token_expired`, nessun deploy.
4. Una pagina con `<input type="hidden" name="xb_form" value="contatti">`: `blocked` con `histos-forms-unsupported`, nessun deploy.
5. Una pagina con un nonce WordPress: `blocked` con `scan_blocked` (regola esistente), nessun deploy.
6. `paths` con 3 pagine non collegate dalla home: tutte nel bundle.
7. Annullamento durante `crawl`: `cancelled`, nessun deploy.
8. Rollback a un deployment del mock: `complete`. Rollback a un id inesistente: `rollback_target_unknown`.
9. `GET /v1/deployments`: la lista corrisponde al mock.
10. Riavvio dell'agente con un job in coda: il job diventa `agent_restarted`.
11. Il token Cloudflare usato nel test (sintetico, es. `test-token-` + 20 caratteri casuali) non compare in nessun file sotto `dataDir` né su stdout o stderr. Il controllo cerca la stringa esatta in tutti i file.
12. Due agenti sulla stessa `dataDir`: il secondo esce con codice 2.

**B. Fixture WordPress (`test-sites/wp`).** Una prova con `site.privateNetwork: true` contro il WordPress Docker della fixture. Senza Histeon l'eco non c'è, quindi il risultato atteso è `export_mode_not_confirmed`. Il test dimostra che rete privata, consenso e robots si comportano come descritto. Il flusso completo con Histeon si prova nel repository Histeon (sezione 16).

### 15.3 Gate di chiusura dell'implementazione
- `npm run validate` verde, con i test nuovi.
- `npm audit --audit-level=moderate` senza vulnerabilità; `npm run provenance` entro l'allowlist, se si aggiungono dipendenze (meglio di no: tutto si fa con `node:http`, `node:crypto` e `node:sqlite`).
- Lo stato e le verifiche si registrano **senza** dichiarare cose non provate.
- `CHANGELOG.md` e versione `0.1.9`.

### 15.4 Cose da NON fare
- Non aggiungere un'opzione per disattivare la firma, nemmeno «per i test». Nei test si firma davvero.
- Non accettare il segreto in chiaro in `agent.json`.
- Non usare `===` per confrontare le firme.
- Non registrare il nonce **prima** di aver verificato la firma: un attaccante potrebbe bruciare i nonce altrui.
- Non riusare il token di sessione della UI (`X-Histos-Token`) né il suo server.
- Non aggiungere notifiche da agente a WordPress.
- Non gestire domini o DNS dall'agente.

---

## 16. Il lato Histeon (solo informativo: si implementa nel repository Histeon)

Serve a capire chi è il client. **Non implementarlo in questo repository.**

### 16.1 Configurazione in WordPress
Costanti in `wp-config.php`. Niente nel database, per non esporre il segreto a chi legge il database:
```php
define( 'XB_PUBLISH_AGENT_URL', 'http://127.0.0.1:8787' );
define( 'XB_PUBLISH_AGENT_KEY_ID', 'k1' );
define( 'XB_PUBLISH_AGENT_SECRET', '<43 caratteri, lo stesso segreto del file delle chiavi>' );
```
`XB_PUBLISH_AGENT_URL` è solo un'origine (schema, host, porta), senza percorso: la firma copre il path così come lo vede l'agente, e un prefisso davanti a un proxy lo cambierebbe. Se `XB_PUBLISH_AGENT_URL` è definita, Histeon **non** usa il proprio token Cloudflare e le schermate di deploy chiamano l'agente. Il token Cloudflare di Histeon (`XB_CLOUDFLARE_API_TOKEN` o quello salvato) va tolto: lo dirà la documentazione utente di Histeon.

### 16.2 Token di export
Histeon lo crea con `XB\StaticSite\ExportMode::token()`: formato `<scadenza>.<hmac>`, scadenza `time() + 900`, firmato con `wp_salt('auth')`. `ExportMode::valid()` accetta scadenze fino a `time() + 1800`. Lato Histeon potrà servire una variante a 1800 secondi per i siti grandi. Histeon lo riconosce solo per richieste **anonime**, cioè senza cookie di login: l'agente non manda mai cookie (9.1, nessuna credenziale).

### 16.3 Flusso lato Histeon
1. Release pubblicata, o clic su «Pubblica su Cloudflare».
2. `POST /v1/publish` firmato, con `request_id` nuovo, `release`, `export_token` e `paths` dall'elenco del suo esportatore (filtro `xb_static_paths`).
3. Registra il job nel proprio registro dei deploy, con l'id del job dell'agente.
4. WP-Cron fa `GET /v1/jobs/{id}` ogni 30 secondi, finché lo stato è finale. Verifica **sempre** la firma della risposta (7.5) con il nonce che ha mandato.
5. Mostra lo stato e i finding, solo codici e file. Il rollback chiama `POST /v1/rollback`.

### 16.4 Implementazione PHP di riferimento della firma
```php
$body      = wp_json_encode( $payload );
$timestamp = (string) time();
$nonce     = bin2hex( random_bytes( 16 ) );
$canonical = implode( "\n", array( 'HISTOS-AGENT-V1', 'POST', '/v1/publish', $timestamp, $nonce, XB_PUBLISH_AGENT_KEY_ID, hash( 'sha256', $body ) ) );
$key       = base64_decode( strtr( XB_PUBLISH_AGENT_SECRET, '-_', '+/' ) . '=' ); // 43 car. → 32 byte
$signature = 'v1=' . hash_hmac( 'sha256', $canonical, $key );
```
Il PHP deve passare gli stessi vettori di 7.6. Lo snippet è verificato: con il corpo, il timestamp e il nonce del vettore 1 dà `291e4cf7…d7ee`.

Note per il PHP:
- `wp_json_encode` scrive `\/` al posto di `/`. Va bene: si firmano i byte che si spediscono, qualunque siano.
- Per ripetere una richiesta (idempotenza, 8.3) bisogna rispedire **gli stessi byte** del corpo, con un timestamp e un nonce nuovi. Il corpo va salvato, non rigenerato: una chiave JSON in ordine diverso cambierebbe lo sha256 e darebbe `409`.

---

## 17. Decisioni da registrare nell'ADR 0008

| # | Decisione | Motivazione |
|---|---|---|
| G1 | L'agente è una modalità di Histeon Publish (`histos-publish agent`), non un pacchetto nuovo. | Riusa crawler, scanner e deploy già verificati. |
| G2 | Si chiama «agente», mai «worker». | In questo repository «Worker» è il Worker Cloudflare. |
| G3 | HMAC-SHA256 con chiave da 32 byte, timestamp ±300 s, nonce monouso persistito; risposte firmate. | Stesso schema dei moduli di Histeon, più la firma delle risposte. |
| G4 | Niente TLS nella v1; solo loopback o rete privata. | L'HMAC dà integrità e autenticità; il token di export non ha valore fuori dalla finestra. TLS si valuta quando servirà su reti non fidate. |
| G5 | Segreti da file, con controlli di proprietario, permessi e symlink, oppure da env; mai dal portachiavi o dal file di configurazione. | Un servizio senza sessione grafica; formato compatibile con Docker secrets e systemd. |
| G6 | Polling da WordPress, nessuna notifica dall'agente. | L'agente non deve avere credenziali WordPress. |
| G7 | Un job alla volta, uno in coda, l'ultimo sostituisce. | Le release si sostituiscono; si evitano code lunghe e deploy fuori ordine. |
| G8 | Eco obbligatorio della modalità export e blocco dei moduli nativi di Histeon. | Stessa garanzia dell'esportatore di Histeon; nessun guasto silenzioso dei moduli. |
| G9 | Le eccezioni di rete (`privateOrigin`) e gli header verso l'origine non sono in `SiteConfig`. | La CLI e il desktop non possono attivarle per errore. |

---

## 18. Limiti noti della v1 (da scrivere in `docs/AGENTE.md`)
- WordPress in una sottocartella non è supportato.
- L'origine dell'agente deve coincidere con l'indirizzo `home` di WordPress. Non c'è un «connetti a questo IP ma usa questo Host».
- Un sito che non finisce di essere letto entro la durata del token di export (15–30 minuti) fallisce con `export_token_expired`.
- I moduli nativi di Histeon bloccano la pubblicazione. I moduli Fluent Forms si configurano con `site.forms`, come nella CLI.
- Solo Linux.
- Le prove automatiche usano solo il mock di Cloudflare e WordPress in Docker.
