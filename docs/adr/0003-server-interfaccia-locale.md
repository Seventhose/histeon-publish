# ADR 0003 — Server locale e interfaccia guidata

Data: 2026-10-21

Stato: **implementato e verificato in locale con Playwright; nessun account reale contattato**

## Decisioni

1. Servire la UI Svelte dal server Node locale, sul solo indirizzo `127.0.0.1` e su una porta casuale (configurabile per test). Il comando `histos-publish ui` apre il browser di sistema; il desktop Electron usa lo stesso servizio applicativo senza avviare un browser esterno.
2. Generare un token di sessione per avvio. Il link iniziale lo trasporta nel frammento URL, che non viene inviato nella richiesta HTTP; la UI lo sposta subito in `sessionStorage` e lo invia nell’header `X-Histos-Token`. La verifica usa confronto a tempo costante.
3. Rifiutare Host non ammessi e richiedere Origin corrispondente per le richieste che modificano stato. Non abilitare CORS. Validare i corpi JSON e applicare limiti dimensione specifici alle rotte.
4. Persistenza non segreta in SQLite. Token e credenziali WordPress sono delegati a `SecretStore`; il server usa il portachiavi del sistema, l’app desktop l’implementazione Electron basata su `safeStorage` (ADR 0004).
5. Rendere l’anteprima disponibile su una route separata e in sola lettura, con ticket temporaneo. La UI non monta né esegue il contenuto del sito nel proprio contesto; l’anteprima è caricata in un iframe sandbox senza script e con policy restrittiva.
6. Usare una UI guidata per importare una sorgente, acquisire consenso prima del rilevamento remoto, mostrare build/report, consentire export e mantenere una conferma esplicita prima di deploy, rollback e associazione del dominio.
7. Registrare localmente i deploy e i rollback, includendo la URL `workers.dev` restituita da Cloudflare se attiva. Il mock fornisce la prova automatica di questa integrazione; nessun endpoint Cloudflare reale è stato contattato.

## Verifiche

- Il server risponde solo sulla loopback; i test verificano token mancante, Host contraffatto, Origin errato e assenza di chiamate remote prima del consenso.
- Playwright verifica importazione HTML, build, anteprima, ZIP, deploy e rollback sul mock, URL `workers.dev`, storico e associazione del dominio.
- `npm run validate`: 35 test unitari, TypeScript, diagnostica Svelte, lint, build e due test E2E verdi.

## Limiti

- L’impostazione del percorso dati resta un’opzione di avvio (`HISTOS_PUBLISH_DATA_DIR`): il browser non può scegliere direttamente una directory locale.
- I report non persistono estratti dei findings, quindi la UI presenta file e descrizione sintetica ma non mostra un estratto del contenuto.
- Queste verifiche dimostrano il servizio locale e il flusso mock; non certificano un deploy reale o un’integrazione con un account.
