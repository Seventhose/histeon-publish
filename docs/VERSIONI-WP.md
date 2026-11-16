# Publish e Histeon di versioni diverse

Un progetto di Histeon Publish N va su un sito con Histeon N−1, e un progetto della Publish N−1 va su un sito con Histeon N e poi torna nella Publish N. La prova avrebbe trovato prima due difetti veri: la 1.24.0 che non apriva in build i progetti delle versioni prima (il database) e il rifiuto di `url.path` di un contenuto scritto sul sito.

## Come si lancia

Dalla cartella di Publish, con Docker acceso e dopo `npm run build`:

```sh
HISTOS_BUILDER_DIR=<checkout del builder> npm run test:versioni-wp
```

Il comando compila il server, alza due WP usa-e-getta con lo `dev/compose.yml` del builder (porte e subnet libere, mai uno stack già in uso o un sito di LocalWP), installa su **A** lo zip di Histeon N−1 e su **B** quello di Histeon N, lancia `scripts/test-versioni-wp.mjs` e alla fine toglie stack, volumi e credenziali.

- **Histeon N** è la versione che questa Publish conosce (`HISTEON_VERSION` di `packages/server/src/histeon-version.ts`), **N−1** la release subito prima. Gli zip vengono da `dist/` del builder, quelli firmati (`.minisig`) per primi; `HISTOS_VERSIONS_ZIP_DIR` indica un'altra cartella, `HISTOS_VERSIONS_NEW_ZIP` e `HISTOS_VERSIONS_OLD_ZIP` due zip precisi (per esempio uno zip non ancora rilasciato come Histeon N).
- **Prima di una release di Histeon** `HISTOS_VERSIONS_NEW_ZIP=checkout` mette su B il plugin del checkout del builder (la sua cartella `plugin/`, come la monta `dev/compose.yml`), con la versione scritta in `plugin/xb.php`: così una correzione si prova prima di farne uno zip.
- **Publish N−1** è il commit di release della versione prima di questa (il più vecchio commit con quella versione in `package.json`), o `HISTOS_VERSIONS_OLD_PUBLISH_REF`. La prova lo estrae con `git archive` in una cartella temporanea (il repository non cambia), gli dà le dipendenze di questo checkout con dei link e i suoi pacchetti propri, e ne costruisce solo i moduli del server.
- **Nomi dei progetti Compose:** `histos-cms-a-…` e `histos-cms-b-…`; con `HISTOS_TEST_COMPOSE_PREFIX=nome` diventano `nome-cms-a-…`, per tenere separate due prove lanciate insieme. La prova rifiuta container che non hanno quella forma.

## Cosa controlla

1. **Publish N → Histeon N−1 (sito A).**
   - Per ogni funzione che solo Histeon N sa leggere e che ha una capacità (`url.path`, loop a gruppi…, dalla tabella `HISTEON_FEATURES`), un prototipo che la usa: Publish N non lo invia e lo dice con `cms-remote-markup-unavailable`, prima di mandare qualcosa (il sito resta senza progetto). Una capacità nuova senza una modifica di prova in `NEWER` fa fallire la prova: va aggiunta.
   - Il prototipo semplice va, con la pubblicazione; il piano dice la versione del sito e cosa non funziona; la rilettura del sito non trova conflitti.
   - La proposta della pagina iniziale compare solo se quell'Histeon ha la rotta `/front-page`.
2. **Publish N−1 → Histeon N (sito B), poi Publish N.**
   - La release precedente importa il suo prototipo d'esempio, si collega a B, invia e pubblica.
   - Publish N, su una copia dei dati della release precedente, apre il database del progetto, lo costruisce (il difetto della 1.24.0), lo rimanda allo stesso sito (che prima rilegge i suoi contenuti: il caso di `url.path`) senza conflitti, e rilegge il sito.
   - La release precedente scarica ciò che Publish N ha mandato, senza conflitti.

Ogni controllo stampa ✓ o ✗ con il motivo; la prova fallisce se uno non passa. `npm test` e `npm run test:e2e` non la lanciano: serve Docker.

## Esito del 5 novembre 2026

Publish 1.27.0 con Histeon 0.5.4 e 0.5.5 dagli zip di release, e Publish 1.26.0 dai suoi sorgenti.

- **Trovato un difetto vero, in ogni Histeon fino alla 0.5.6:** un record con due termini fuori dall'ordine alfabetico (nel prototipo d'esempio «Ehi», temi `notte` e `luce`) tornava da WP con i termini in ordine di nome e quindi con un altro hash. Il primo invio con pubblicazione si fermava con `cms-remote-heads-invalid` («WordPress ha restituito revisioni diverse dal profilo inviato»), le basi non avanzavano e gli invii dopo trovavano conflitti. Succedeva in entrambe le direzioni (Publish 1.27.0 → 0.5.4, Publish 1.26.0 → 0.5.5) e anche a versioni uguali. Corretto nel plugin: l'ordine inviato resta in `_xb_page_profile_terms` finché i termini sono gli stessi.
- **Con il plugin corretto su B** (`HISTOS_VERSIONS_NEW_ZIP=checkout`, Histeon 0.5.6 preso dal checkout del builder): 15 controlli su 17. La direzione 2 passa per intero: la 1.26.0 invia e pubblica, Publish 1.27.0 apre e costruisce il suo database, rimanda il progetto (24 elementi uguali, nessun conflitto) e la 1.26.0 rilegge. Nella direzione 1 il loop a gruppi si ferma prima dell'invio con `cms-remote-markup-unavailable` e il sito resta vuoto; restano rossi i due controlli dell'invio con pubblicazione a Histeon 0.5.4, che ha il difetto dei termini: si chiudono quando la release con la correzione diventa N−1.
- **Con gli zip di release su A e B:** 11 su 17, per lo stesso difetto.
