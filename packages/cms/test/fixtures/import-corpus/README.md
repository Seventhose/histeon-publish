# Corpus dell'importatore automatico (doc 18, F0)

Sei siti scritti per i test, senza contenuti di terzi. Ognuno mette alla prova una parte della conversione:

| Sito | Cosa prova |
|---|---|
| `landing-bootstrap` | navbar con pulsante, card con immagini locali, accordion, modulo d'iscrizione, icone SVG, script da CDN |
| `webflow-like` | molti `div` con classi, immagini remote, `span` stilati dentro i titoli, link con `span` |
| `utility-tailwind` | classi utility, `picture`/`source`, pulsanti, SVG |
| `blog-statico` | indice di articoli, pagine con la stessa testata e lo stesso piè, `figure`, `blockquote`, `code` |
| `moduli-svg` | modulo completo (etichette, campi, `fieldset`, scelte), logo SVG, `details`, `address`, tabella |
| `script-cdn` | carosello e schede pilotati da script, modale, gestori `onclick`, attributi `data-*` |

`import-corpus.test.ts` misura la quota di elementi selezionabili dopo la conversione (`measureSelectable`).
