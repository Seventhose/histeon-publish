# ADR 0008 — Agente di pubblicazione per siti Histos

Data: 2026-10-22

Stato: **implementata in Histos Publish 0.1.11; verificata solo con fixture e mock locali**

## Decisioni

| # | Decisione | Motivazione |
|---:|---|---|
| G1 | L’agente è una modalità di Histos Publish (`histos-publish agent`), non un pacchetto nuovo. | Riusa crawler, scanner e deploy già verificati. |
| G2 | Nel codice e nella documentazione si chiama «agente», mai «worker». | «Worker» indica già lo script statico caricato su Cloudflare. |
| G3 | Le richieste usano HMAC-SHA256 con chiave da 32 byte, timestamp valido per ±300 secondi e nonce monouso persistito. Anche le risposte autenticate sono firmate. | Autentica le richieste di Histos e consente di verificare gli stati restituiti dall’agente. |
| G4 | La v1 non implementa TLS; l’agente ascolta su loopback o su una rete privata. Per reti non fidate si usa un tunnel WireGuard o SSH. | L’HMAC protegge integrità e autenticità, ma non cifra il trasporto. |
| G5 | I segreti arrivano da variabili d’ambiente o file con proprietario e permessi controllati; non sono nel JSON, nel database o nel portachiavi. | L’agente gira come servizio senza sessione grafica. |
| G6 | Histos controlla i job con polling. L’agente non invia chiamate a WordPress. | L’agente non deve conservare credenziali WordPress. |
| G7 | Si esegue un job alla volta e si conserva al massimo un job in coda; una richiesta più recente sostituisce quella ancora in attesa. | Le pubblicazioni devono seguire la release più recente senza accumulare una coda arbitraria. |
| G8 | La pubblicazione richiede l’eco del token di export; i moduli nativi Histos bloccano il deploy su questo Worker dedicato. | Evita di pubblicare HTML fuori modalità export e moduli che smetterebbero di funzionare. |
| G9 | Le eccezioni di rete privata, gli header di export, le pagine seed e la prova 404 sono opzioni di build, non campi di `SiteConfig`. | La CLI e l’app desktop non possono attivarle tramite una configurazione ordinaria. |

## Confini e sicurezza

Il token Cloudflare, l’account, il Worker, l’origine del sito e la rete privata ammessa restano nella configurazione dell’agente. WordPress può chiedere di pubblicare il proprio sito, annullare un job, leggere lo stato e richiedere il ripristino di una versione dello stesso Worker.

La compromissione di WordPress può causare la pubblicazione di contenuti alterati e richieste di ripristino, ma non rivela il token Cloudflare. La compromissione dell’agente compromette invece quel token: il servizio deve usare un utente di sistema dedicato e non quello del web server.

## Verifiche e limiti

L’implementazione usa il server HTTP separato dell’agente, SQLite nella cartella dati privata, chiavi HMAC anti-replay, lo scanner e il client Cloudflare condivisi. Test e mock restano locali: le prove non contattano Cloudflare o WordPress reali.

Per i dettagli operativi, le variabili segrete e i limiti della v1, vedere [Guida dell’agente](../AGENTE.md) e [schema JSON](../spec/agent.schema.json).
