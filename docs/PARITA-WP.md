# Parità visiva fra Publish e WordPress

La build statica di Histeon Publish e le stesse pagine su WordPress, dopo un invio vero e una release, devono vedersi uguali. La prova lo controlla per immagini, con il metodo della prova di parità del builder (`e2e/specs/gutenberg-layout-parity.spec.ts`, che confronta editor e sito).

## Come si lancia

Dalla cartella di Publish, con Docker acceso:

```sh
HISTOS_BUILDER_DIR=<checkout del builder> npm run test:parita-wp
```

Il comando compila il server di Publish, alza un WordPress usa-e-getta con lo `dev/compose.yml` del builder (progetto Compose `histos-cms-a-…`, porta e subnet libere, mai uno stack già in uso o un sito di LocalWP), installa WordPress con il tema `xb-blank` e il plugin Histeon preso dallo zip di una release, lancia la prova Playwright e alla fine toglie stack, volumi e credenziali.

- **Plugin:** lo zip più recente `dist/xb-X.Y.Z-commit.zip` del builder, oppure quello di `HISTOS_PARITY_PLUGIN_ZIP`. Non la cartella `plugin/` del checkout, che può avere modifiche in corso.
- **Immagini da guardare a occhio:** con `HISTOS_PARITY_SAVE_DIR=/una/cartella` la prova scrive lì, per ogni pagina e larghezza, le due foto e quella delle differenze, anche quando passa; a 1280 px anche il markup e le regole CSS dei due lati (`*-publish.html`, `*-wordpress.html`).
- **Senza variabili** (`npx playwright test -c playwright.parita-wp.config.ts`) la prova si salta e lo dice. `npm test` e `npm run test:e2e` non la vedono: sta in `tests/e2e-wp/`, con il suo `playwright.parita-wp.config.ts`.

### Su un WordPress già acceso

```sh
HISTOS_PARITY_WP_URL=http://localhost:8899 HISTOS_PARITY_WP_CONTAINER=nome-wordpress-1 npx playwright test -c playwright.parita-wp.config.ts
```

Prima `npm run build -w @histos-publish/server`. Il container deve essere di uno stack usa-e-getta (`histos-cms-*-wordpress-1` o `xb-e2e*-wordpress-1`: la prova rifiuta gli altri nomi), con l'utente `admin`, i permalink `/%postname%/` e il plugin Histeon attivo. Il sito non deve essere collegato a un altro progetto: dopo una prova lo è, quindi una seconda prova sullo stesso sito si ferma con quel motivo. Per questo lo stack e2e condiviso del builder (con le sue molte pagine e le release dei test del builder) non è il posto giusto: la prova vuole un sito vuoto ogni volta, e lo stack usa-e-getta nasce dallo stesso `dev/compose.yml`.

## Cosa fa

1. **Importa** `tests/e2e-wp/prototipo-parita.html` come «Importa prototipo» (`importPrototypeHtml`): testata e piè di pagina (parti), una griglia di schede (un componente, una con l'immagine nello slot e tre da un loop sui record, con l'immagine del loro campo `asset`), titoli grandi con `clamp()`, il carattere Inter come media (`@font-face`, il file WOFF2 di `node_modules/@fontsource-variable/inter`), una pagina «Chi siamo» su un template suo, tre record con il loro template e l'archivio, un articolo.
2. **Invia** a WordPress con un codice d'abbinamento creato nel container (`\XB\Cms\Link::create`, lettura e scrittura, senza pubblicazione, come quello che dà l'app), con le funzioni dell'app: `connectRemoteSite`, `createRemoteSyncPlan`, `applyRemoteSyncPlan`. L'invio va in sviluppo.
3. **Pubblica una release** come amministratore (`versioning->publish`), come fanno le altre prove con WordPress: si confronta ciò che vede un visitatore, non l'anteprima di sviluppo firmata.
4. **Costruisce** il sito statico con `buildCmsProject` (la build di «Prepara il sito», varianti moderne delle immagini comprese) e lo serve su 127.0.0.1.
5. **Fotografa** home, «Chi siamo», l'articolo, il record `opera/campi` e l'archivio `opera/` sui due lati, a 1280 e 390 px di larghezza, a pagina intera, dopo caratteri e immagini; le richieste verso altri siti sono bloccate. L'indirizzo su WordPress è il permalink del documento (`PageProfileAdapter::post_of_entity`, `linked_record_by_id`), non lo stesso percorso: la home di Publish è `/`, su WordPress `/home/`.
6. **Confronta** come la prova del builder: un pixel è diverso se la somma delle differenze dei tre canali supera 48; la quota di pixel diversi deve restare sotto il 2%, larghezza e altezza entro 2 px. Ogni pagina e larghezza è un controllo a sé (`expect.soft`): la prova le misura tutte e stampa la tabella.

Quando un confronto fallisce, le tre immagini (`…-publish.png`, `…-wordpress.png`, `…-differenze.png`: in rosso i pixel diversi, in blu l'area che solo una delle due foto copre) sono allegati del test, in `test-results/parita-wp/`.

## Esito del 5 novembre 2026

Con Histeon 0.5.4 (`xb-0.5.4-22547b0.zip`) la prima esecuzione ha trovato due differenze vere.

- **Corretta in Publish:** un `<source>` dentro `<picture style="display:contents">` (le immagini moderne della build) diventava un elemento della griglia o del flex, con la sua traccia e il suo `gap`: 19 px in più sopra l'immagine di ogni scheda. Ora i `<source>` hanno `hidden` (`packages/cms/src/picture-markup.ts`). Home, record, archivio e articolo sono passati dal 6–17% allo 0,00% di pixel diversi.
- **Aperta:** WordPress aggiunge le sue regole di base, che la build di Publish non ha. Quella che si vede qui è `:where(figure) { margin: 0 0 1em }` di `wp-block-library`: in Publish la figura di «Chi siamo» ha i margini del browser (`1em 40px`), su WordPress no (11,66% a 1280 px, 12,53% e 34 px d'altezza a 390). Dalla stessa fonte vengono `:where(body) { margin: 0 }` (il prototipo lo scrive già nel foglio globale, quindi qui non si vede) e le regole `html :where([style*=border-…])`. È una scelta da fare: dare alla build di Publish queste regole di base di WordPress, oppure toglierle dalle pagine di Histeon su WordPress (dove però servono agli articoli con i blocchi di Gutenberg). Finché non si sceglie, la prova resta rossa su «Chi siamo».

Fuori dal confronto per immagini, ma visto qui: dopo l'invio a un WordPress nuovo la sua `/` resta l'elenco degli articoli (`show_on_front` non cambia), la pagina `home` è a `/home/` e l'articolo a `/primo-giorno/`, mentre in Publish sono `/` e `/blog/primo-giorno/`; i link scritti nel prototipo (`/blog/`) puntano agli indirizzi di Publish.

| Pagina | Larghezza | Pixel diversi |
|---|---:|---:|
| home | 1280 | 0,00% |
| home | 390 | 0,00% |
| chi-siamo | 1280 | 11,66% |
| chi-siamo | 390 | 12,53% (altezza 1053 contro 1087) |
| articolo primo-giorno | 1280 / 390 | 0,00% / 0,00% |
| record opera/campi | 1280 / 390 | 0,00% / 0,00% |
| archivio opera | 1280 / 390 | 0,00% / 0,00% |

## Prima di ogni release

`npm run rilascio -- prepara histeon` e `prepara publish` lanciano questa prova con il plugin della release e ne scrivono l'esito nelle note di rilascio. Se la prova è rossa, la release non si prepara.
