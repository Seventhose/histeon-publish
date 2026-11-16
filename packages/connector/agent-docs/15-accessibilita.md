---
key: accessibilita
title: Accessibilità in pratica
summary: Leggilo prima di scrivere struttura, immagini, link, pulsanti, moduli e stili: le regole di accessibilità, con esempi giusti e sbagliati.
---
# Accessibilità

Vale sempre, con le stesse regole: **nel builder (connettore xb)** e **in Histeon Publish (prototipo, connettore hp)**.

## Regole essenziali

1. **Un solo `h1` per pagina.** Titoli in ordine, senza salti.
2. **Landmark:** `header`, `nav`, `main`, `footer`. Ogni `section` ha un titolo (`h2`–`h6`) oppure un `aria-label` o `aria-labelledby`.
3. **Elenchi e dati:** liste vere (`ul`, `ol`); tabelle con `th` e `scope`.
4. **Immagini:** `alt` descrittivo se l'immagine ha contenuto, `alt=""` se è decorativa.
5. **Link:** il testo dice dove porta. Mai «clicca qui».
6. **Azioni e navigazione:** per un'azione un `<button type="button">` vero, per andare altrove un `<a href>` vero.
7. **Moduli:** ogni campo ha una `label` collegata (`for` uguale all'`id`).
8. **Contrasto:** almeno 4,5:1, e 3:1 per il testo grande. Usa le coppie di colori del framework.
9. **Focus:** sempre visibile.
10. **Movimento:** rispetta `prefers-reduced-motion` per animazioni e transizioni non essenziali. Niente contenuti che lampeggiano.
11. **ARIA:** solo quando l'HTML non basta.

## In dettaglio

### Titoli e landmark
✅
```html
<header class="site-header">…</header>
<main class="page">
  <h1 class="page__title">Chi siamo</h1>
  <section class="history">
    <h2 class="history__title">La nostra storia</h2>
  </section>
</main>
<footer class="site-footer">…</footer>
```
❌
```html
<div class="header">…</div>                 <!-- un div al posto di header -->
<h1>Benvenuti</h1><h1>Notizie</h1>          <!-- due h1 -->
<h2>Chi siamo</h2><h4>La storia</h4>        <!-- salto da h2 a h4 -->
<p class="big-title">Notizie</p>            <!-- un titolo finto -->
```
- Il livello del titolo segue la struttura. La dimensione la decide il CSS del blocco.
- **Componenti e parti di template** (testata, piè di pagina): i Controlli non chiedono loro un `h1`. L'`h1` sta nella pagina o nel suo template.

### Immagini
✅ Nel prototipo (i media si scrivono `asset:`):
```html
<img class="hero__image" src="asset:chiostro" alt="Il chiostro al tramonto" width="1200" height="800">
<img class="hero__ornament" src="asset:fregio" alt="" width="64" height="16">
```
❌
```html
<img class="hero__image" src="asset:chiostro">              <!-- manca alt -->
<img class="hero__image" src="asset:chiostro" alt="foto">   <!-- alt che non dice nulla -->
```
- **Misure:** scrivi `width` e `height` con le misure del file, in pixel e senza unità. Così la pagina non salta mentre carica.
- **Immagini dai contenuti** (nel builder): l'`alt` viene dal contenuto, e se il contenuto può non avere l'immagine, mettila in un `{#if}`:
```html
{#if post.image}
  <img class="news-card__image" src={post.image.url} alt={post.image.alt}>
{/if}
```

### Link
✅
```html
<a class="news-card__link" href={post.url}>{post.title}</a>
<a class="site-footer__contact" href="/contatti/" aria-label="Scrivici">
  <svg class="site-footer__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18v12H3z" stroke="currentColor" stroke-width="2" fill="none"/></svg>
</a>
```
❌
```html
<a href={post.url}>Clicca qui</a>                <!-- testo vago -->
<a href={post.url}>Leggi di più</a>              <!-- testo vago -->
<a class="card__link">Dettagli</a>               <!-- link senza indirizzo -->
<a href="/eventi/" target="_blank">Eventi</a>    <!-- nuova scheda senza rel="noopener" -->
```
- Un link fatto solo di un'icona ha un nome: `aria-label` sul link, `aria-hidden="true"` sull'icona.
- `target="_blank"` solo se serve davvero, e sempre con `rel="noopener"`.

### Pulsanti
✅
```html
<button class="site-header__toggle" type="button" aria-label="Apri il menu">
  <svg class="site-header__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2"/></svg>
</button>
```
❌
```html
<div class="site-header__toggle">Menu</div>                       <!-- un div al posto di un pulsante -->
<button class="site-header__toggle" type="button"><svg …></svg></button>  <!-- senza testo né aria-label -->
```
- **Domande frequenti e fisarmoniche:** `<details>` con un `<summary>`. Funziona senza script.
- **Un componente interattivo** (schede, fisarmonica, finestra) segue lo schema ARIA del suo tipo, tastiera compresa. Il suo JavaScript lo aggiunge l'utente nel builder: il connettore non scrive script, e nel prototipo gli script non entrano.

### Icone SVG
- **Decorativa:** `aria-hidden="true" focusable="false"`.
- **Con un significato:** `role="img"` e un `<title>` (anche `{props.label}`).
- I Controlli del builder non segnalano ciò che ha `aria-hidden="true"`: usalo solo per ciò che è davvero decorativo. Elementi e attributi SVG ammessi: vedi l'argomento `markup`.

### Moduli
✅
```html
<label class="newsletter__label" for="newsletter-email">La tua email</label>
<input class="newsletter__input" id="newsletter-email" type="email" name="email" autocomplete="email">
```
❌ `<input class="newsletter__input" type="email" name="email" placeholder="Email">`: nessuna `label`.
- **Messaggi d'errore** comprensibili. Le regole del modulo (`action`, `method`, campi vietati) sono nell'argomento `markup`.
- **Etichetta nascosta alla vista:** con Histeon CSS c'è la classe `xb-visually-hidden` (in Automatic.css `hidden-accessible`).

### Tabelle
✅
```html
<table class="schedule">
  <caption class="schedule__caption">Orari di apertura</caption>
  <thead><tr><th scope="col">Giorno</th><th scope="col">Orario</th></tr></thead>
  <tbody><tr><th scope="row">Lunedì</th><td>9–13</td></tr></tbody>
</table>
```

### Colore e contrasto
- **Coppie del framework,** non colori scelti a occhio. In Histeon CSS ogni famiglia ha il suo testo leggibile, `--xb-on-<famiglia>`:
```css
/* set-css .cta-button   (estratto) */
background: var(--xb-primary);
color: var(--xb-on-primary);
```
- ❌ `color: #aaa;` su uno sfondo chiaro: un valore inventato, e spesso illeggibile.
- In Histeon CSS la sezione **Leggibilità** del Design system mostra il contrasto delle coppie del sito. Non considera i token sovrascritti a mano.

### Focus
✅
```css
/* set-css .cta-button   (estratto; con un altro framework le sue variabili, es. var(--primary)) */
&:focus-visible { outline: 2px solid var(--xb-primary); outline-offset: 2px; }
```
❌ `&:focus { outline: none; }`: il focus sparisce. Histeon CSS ha anche il token semantico `--xb-focus`.
- **Nel prototipo** le stesse dichiarazioni stanno in `<style data-histos="selectors">`, dentro `.cta-button { … }`.

### Movimento
✅
```css
&:hover { transform: translateY(-2px); }
@media (prefers-reduced-motion: reduce) { &:hover { transform: none; } }
```

### Lingua
- **Prototipo:** la lingua giusta va in `locale`, nel manifest (per esempio `it-IT`).
- **Un brano in un'altra lingua:** `lang` sull'elemento, per esempio `<blockquote class="quote" lang="la">`.

## Come si controlla

- **Nel builder (connettore xb):** controlla con `render` l'HTML finale: titoli, `alt`, link, pulsanti, `label`. L'utente vede anche i **Controlli** del builder.
  - Errori: immagine senza `alt`, link senza testo né nome accessibile, pulsante senza testo né `aria-label`, campo senza etichetta, iframe senza `title`.
  - Da rivedere o come consiglio: testo vago dei link, link senza indirizzo, nuova scheda senza `rel="noopener"`, titoli saltati o vuoti, contrasto sotto la soglia, nessun `h1` o un secondo `h1`, immagini senza `width`/`height`. Sono un aiuto, non una prova con un lettore di schermo.
- **In Histeon Publish (prototipo, connettore hp):** il rapporto di `hp_check_prototype` avvisa, senza fermare l'import, di:
  - accessibilità: immagini senza `alt`, link senza testo né `aria-label`, un link dentro un altro link, `section` senza titolo (`h2`–`h6`) né `aria-label`/`aria-labelledby`, titoli che saltano un livello, immagini senza `width`/`height` (con i numeri da scrivere quando li legge dal file);
  - accessibilità e SEO: manca `locale` nel manifest, una pagina senza `h1` o con più di un `h1` (contando anche il suo template);
  - SEO: pagine con lo stesso titolo, articoli senza riassunto (`data-excerpt`). Il riassunto di un articolo o di un record è anche il `<meta name="description">` della sua pagina.
  - Il resto (contrasto, focus, testo dei link, `label` dei campi) non lo controlla: guardalo tu. Dopo `hp_build`, leggi l'HTML prodotto con `hp_build_file`.
- Prima di dire «fatto», vedi l'argomento `controllo`.
