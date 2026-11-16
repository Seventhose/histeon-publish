---
key: progettare
title: Progettare bene al primo colpo: UX, UI e accessibilità già dentro
summary: Leggilo prima di disegnare una pagina o un blocco: le sei domande, i numeri da rispettare e i modelli pronti (pagina, testata con menu mobile, eroe, schede da un loop, articolo, pulsanti, domande frequenti, modulo, piè di pagina) con accessibilità e UX già dentro, provati con il controllo del prototipo.
---

# Progettare bene al primo colpo

Una pagina fatta bene non si corregge dopo: nasce accessibile, leggibile e chiara. Qui trovi le regole in numeri e i **modelli pronti**. Copiali e cambia solo nomi, testi e dati: la struttura, gli attributi e le proprietà CSS restano.

I modelli vengono da un prototipo vero che passa `prototype verify` senza errori, senza avvisi del rapporto, senza violazioni axe e senza scorrimento orizzontale a 390 px. Un test di Histeon Publish controlla che il testo qui sotto sia identico a quel prototipo.

## Come leggere i modelli

<!-- rapido -->
- I modelli sono scritti come nel **prototipo** di Histeon Publish: parti, componenti e template in `<template data-histos="…">`, il CSS in `<style data-histos="selectors">`, una regola per blocco.
- **Le espressioni** (`page.title`, `page.publishedAt.date("j F Y")`, `concerto.fields.luogo`, i loop su una query) valgono uguali nel builder di WordPress.
- **Un'immagine che viene dai dati** si passa a un componente come prop (`immagine={concerto.fields.locandina}`), e il componente scrive `src={props.immagine}`. Nel prototipo è l'unico modo ammesso, e nel builder funziona lo stesso.
- **Nel builder** (connettore `xb`): passa a `set-css .blocco` **solo** il testo fra le graffe esterne della regola del blocco. Poi sostituisci le misure delle `@media` con i nomi del `brief`:

| Nel prototipo | Nel builder (nomi predefiniti) |
|---|---|
| `@media (width < 40em)` | `@media (--mobile)` |
| `@media (width < 48rem)` o `(width < 64em)` | `@media (--tablet)` |
| `@media (width >= 64em)` | `@media (--desktop)` |

- I token sono quelli di Histeon CSS (`--xb-*`). Se il sito usa ACSS o Core Framework, usa i nomi del `brief` (argomenti `acss` e `core-framework`).
- I nomi di esempio (`concerto`, `prossimi_concerti`, `concert-card`) li cambi con quelli del tuo sito.
<!-- /rapido -->

## Prima di scrivere: sei domande

<!-- rapido -->
Rispondi a tutte e sei, nella tua testa o all'utente, **prima** di scrivere una riga:
1. **Chi** usa questa pagina, e da quale schermo? (Quasi sempre il telefono.)
2. **Che cosa deve fare** chi arriva? Una cosa sola: è l'azione principale.
3. **Qual è il testo vero?** Se non ce l'hai, chiedilo. Non inventarlo.
4. **Esiste già un componente** che fa questo? Usa quello.
5. **Che cosa c'è sopra e sotto?** Il blocco deve avere gli stessi spazi, colori e caratteri del resto del sito.
6. **Che cosa succede se i dati mancano?** Elenco vuoto, immagine assente, testo lungo.
<!-- /rapido -->

## I numeri da rispettare

<!-- rapido -->
| Che cosa | Regola |
|---|---|
| Testo del corpo | `var(--xb-text-m)`, che vale almeno 16px. Mai sotto 15px, nemmeno per note e didascalie |
| Righe del testo | Interlinea `var(--xb-leading-normal)`. Larghezza massima dei paragrafi `var(--xb-width-prose)` (circa 65 caratteri) |
| Contrasto | Almeno 4,5:1 per il testo, 3:1 per testi grandi e icone. Testo su un colore di famiglia: `var(--xb-on-<famiglia>)` |
| Bersagli da toccare | Pulsanti e link isolati alti almeno `2.75rem` (44px), con spazio fra uno e l'altro |
| Titoli | Un solo `h1` per pagina, poi `h2`, `h3` in ordine, senza salti. Anche negli archivi: fra l'`h1` e i titoli delle schede (`h3`) serve un `h2` |
| Azione principale | Una per schermata. Le altre azioni hanno uno stile più leggero |
| Spazi | Solo `var(--xb-space-*)` dentro i blocchi, `var(--xb-section-*)` fra le sezioni |
| Larghezza delle pagine | Contenuto dentro `var(--xb-width-content)`, centrato con `margin-inline: auto` |
| Immagini | Sempre `width`, `height` e `alt`. La prima immagine grande della pagina: `fetchpriority="high"`. Tutte le altre: `loading="lazy"` |
| Schermo stretto | A 390px di larghezza niente scorrimento orizzontale e niente testo tagliato |
| Movimento | Animazioni solo se aiutano a capire, e spente con `prefers-reduced-motion: reduce` |
| Link interni | Ogni `href` che comincia con `/` porta a una pagina che esiste |

**Numeri ammessi senza token:** `0`, `1`, `100%`, `50%`, `auto`, `1fr`, `1px` e `2px` per bordi sottili e `outline`, `2.75rem` per i bersagli da toccare, le misure delle `@media`, i valori di `z-index`. Tutto il resto viene dalle variabili.
<!-- /rapido -->

## La pagina

<!-- rapido -->
Ogni pagina usa un template con testata, `main` e piè di pagina. Il `main` ha `id="contenuto"`, e il primo link della testata, «Vai al contenuto», ci porta: chi usa la tastiera salta il menu.

```html
<template data-histos="template" data-ref="site/page" data-role="page" data-title="Pagina"><Site.Header /><main class="page" id="contenuto">{@slot}</main><Site.Footer /></template>
```
```css
.page {
  max-inline-size: var(--xb-width-content);
  margin-inline: auto;
  padding-inline: var(--xb-gutter);
}
```
<!-- /rapido -->

## Testata e menu

La testata ha **due menu**: uno per lo schermo largo e uno per il telefono, dentro un `<details>`. Servono due menu perché un `<details>` chiuso non si apre dal CSS sullo schermo largo. I due `nav` hanno `aria-label` diversi. La voce della pagina aperta ha `aria-current="page"`, scritta con due rami interi (`{#if …}…{:else}…{/if}`). Niente script.

```html
<template data-histos="part" data-ref="site/header" data-area="header" data-title="Testata">
<header class="site-header">
  <a class="skip-link" href="#contenuto">Vai al contenuto</a>
  <a class="site-header__logo" href="/"><img class="site-header__image" src="asset:logo" alt="Coro di prova, torna alla home" width="160" height="48"></a>
  <nav class="site-header__nav site-nav" aria-label="Menu principale">
    <ul class="site-nav__list">
      <li>{#if page.slug == "chi-siamo"}<a class="site-nav__link" href="/chi-siamo/" aria-current="page">Chi siamo</a>{:else}<a class="site-nav__link" href="/chi-siamo/">Chi siamo</a>{/if}</li>
      <li>{#if page.url.includes("/concerto/")}<a class="site-nav__link" href="/concerto/" aria-current="page">Concerti</a>{:else}<a class="site-nav__link" href="/concerto/">Concerti</a>{/if}</li>
      <li>{#if page.slug == "contatti"}<a class="site-nav__link" href="/contatti/" aria-current="page">Contatti</a>{:else}<a class="site-nav__link" href="/contatti/">Contatti</a>{/if}</li>
    </ul>
  </nav>
  <details class="site-header__mobile">
    <summary class="site-header__toggle">Menu</summary>
    <nav class="site-nav" aria-label="Menu mobile">
      <ul class="site-nav__list">
        <li><a class="site-nav__link" href="/chi-siamo/">Chi siamo</a></li>
        <li><a class="site-nav__link" href="/concerto/">Concerti</a></li>
        <li><a class="site-nav__link" href="/contatti/">Contatti</a></li>
      </ul>
    </nav>
  </details>
</header>
</template>
```
```css
.skip-link {
  position: absolute;
  inset-inline-start: var(--xb-space-s);
  inset-block-start: var(--xb-space-s);
  z-index: 100;
  padding: var(--xb-space-xs) var(--xb-space-s);
  background: var(--xb-surface);
  color: var(--xb-text);
  transform: translateY(-200%);
  &:focus-visible { transform: none; outline: 2px solid var(--xb-focus); }
}
.site-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--xb-space-s);
  padding: var(--xb-space-s) var(--xb-gutter);
  background: var(--xb-surface);
  border-block-end: 1px solid var(--xb-border);
  &__image { display: block; }
  &__nav { @media (width < 48rem) { display: none; } }
  &__mobile { display: none; @media (width < 48rem) { display: block; } }
  &__toggle { display: inline-flex; align-items: center; min-block-size: 2.75rem; cursor: pointer; }
}
.site-nav {
  &__list { display: flex; flex-wrap: wrap; gap: var(--xb-space-xs) var(--xb-space-m); list-style: none; margin: 0; padding: 0; }
  &__link {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    color: var(--xb-link);
    font-size: var(--xb-text-m);
    text-decoration: none;
    &:hover { color: var(--xb-link-hover); text-decoration: underline; }
    &:focus-visible { outline: 2px solid var(--xb-focus); outline-offset: 2px; }
    &[aria-current="page"] { font-weight: 700; text-decoration: underline; }
  }
}
```

- La voce corrente si vede diversa **non solo per il colore**: grassetto e sottolineatura.
- Il logo è un link alla home, e il suo `alt` dice il nome del sito.
- Per una sezione con più pagine: `page.url.includes("/concerto/")`, come la voce «Concerti».

## La sezione d'apertura (eroe)

<!-- rapido -->
Un titolo vero, una frase vera, **una** azione, un'immagine vera. Niente slogan generici.

```html
<section class="hero" aria-labelledby="hero-title">
  <div class="hero__body">
    <h1 class="hero__title" id="hero-title">Concerti d'organo in duomo, ogni domenica d'estate</h1>
    <p class="hero__lead">Ingresso libero, alle 21. Il programma cambia ogni settimana.</p>
    <a class="hero__action" href="/concerto/">Leggi il programma</a>
  </div>
  <img class="hero__image" src="asset:organo" alt="L'organo del duomo visto dalla navata" width="1600" height="1000" fetchpriority="high">
</section>
```
```css
.hero {
  display: grid;
  gap: var(--xb-space-l);
  align-items: center;
  padding-block: var(--xb-section-m);
  &__title { font-size: var(--xb-h1); color: var(--xb-heading); text-wrap: balance; margin: 0; }
  &__lead { font-size: var(--xb-text-l); color: var(--xb-text); max-inline-size: var(--xb-width-prose); }
  &__action {
    display: inline-flex;
    align-items: center;
    min-block-size: 2.75rem;
    padding-inline: var(--xb-space-m);
    border-radius: var(--xb-radius-s);
    background: var(--xb-primary);
    color: var(--xb-on-primary);
    font-weight: 700;
    text-decoration: none;
    &:hover { background: var(--xb-primary-hover); }
    &:focus-visible { outline: 2px solid var(--xb-focus); outline-offset: 2px; }
  }
  &__image { inline-size: 100%; block-size: auto; border-radius: var(--xb-radius-m); }
  @media (width >= 64em) { grid-template-columns: 1fr 1fr; }
}
```
<!-- /rapido -->

❌ Errori tipici dell'eroe: «Benvenuti nel nostro sito» come titolo; due o tre pulsanti uguali; testo bianco su una foto senza un fondo che garantisca il contrasto; immagine con `loading="lazy"` (è la prima della pagina: rallenta).

## Schede da un loop

<!-- rapido -->
Le schede ripetute vengono da un **loop** su una query, con il caso vuoto `{:else}`. Ogni scheda è un **componente**: riceve i dati come props, e l'immagine arriva come prop. Tutta la scheda è cliccabile grazie al link del titolo, che si allarga con `::after`: un solo link per scheda.

Il componente:

```html
<template data-histos="component" data-ref="concert-card" data-title="Scheda del concerto" data-props='{"titolo":{"type":"string"},"url":{"type":"url"},"giorno":{"type":"string"},"data":{"type":"string"},"luogo":{"type":"string"},"immagine":{"type":"image"},"larghezza":{"type":"number","default":640},"altezza":{"type":"number","default":400}}'>
<article class="concert-card">
  {#if props.immagine}<img class="concert-card__image" src={props.immagine} alt="" width={props.larghezza} height={props.altezza} loading="lazy">{/if}
  <h3 class="concert-card__title"><a class="concert-card__link" href={props.url}>{props.titolo}</a></h3>
  <p class="concert-card__meta"><time datetime={props.giorno}>{props.data}</time> · {props.luogo}</p>
</article>
</template>
```

La sezione che lo usa:

```html
<section class="events" aria-labelledby="events-title"><h2 class="events__title" id="events-title">In programma</h2><ul class="events__list">{#loop main() as concerto}<li><ConcertCard titolo={concerto.title} url={concerto.url} giorno={concerto.fields.data.date("Y-m-d")} data={concerto.fields.data.date("j F Y")} luogo={concerto.fields.luogo} immagine={concerto.fields.locandina} /></li>{:else}<li class="events__empty">Nessun concerto in programma.</li>{/loop}</ul></section>
```
```css
.events {
  padding-block: var(--xb-section-m);
  &__title { font-size: var(--xb-h2); color: var(--xb-heading); }
  &__list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--xb-grid-min)), 1fr));
    gap: var(--xb-grid-gap);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  &__empty { color: var(--xb-text-muted); font-size: var(--xb-text-m); }
  &__all { display: inline-flex; align-items: center; min-block-size: 2.75rem; color: var(--xb-link); }
}
.concert-card {
  position: relative;
  display: grid;
  gap: var(--xb-space-xs);
  block-size: 100%;
  padding: var(--xb-space-m);
  border: 1px solid var(--xb-border);
  border-radius: var(--xb-radius-m);
  background: var(--xb-surface);
  &__image { inline-size: 100%; block-size: auto; border-radius: var(--xb-radius-s); }
  &__title { font-size: var(--xb-h4); color: var(--xb-heading); margin: 0; overflow-wrap: anywhere; }
  &__link {
    color: inherit;
    text-decoration: none;
    &::after { content: ""; position: absolute; inset: 0; }
    &:focus-visible { outline: 2px solid var(--xb-focus); outline-offset: 2px; }
  }
  &:hover .concert-card__title { text-decoration: underline; }
  &__meta { color: var(--xb-text-muted); font-size: var(--xb-text-s); margin: 0; }
}
```
<!-- /rapido -->

- Il nome della query (`prossimi_concerti`) e dei campi (`data`, `luogo`, `locandina`) vengono dai dati del sito: nel prototipo da `content`, nel builder dal `brief`.
- La data passa due volte: `giorno` per `datetime` (`"Y-m-d"`, la leggono macchine e lettori di schermo), `data` per le persone (`"j F Y"`, «12 luglio 2026»).
- L'immagine della scheda ha `alt=""` perché il titolo accanto dice già tutto. Se l'immagine aggiunge un'informazione, scrivila nell'`alt`.
- `{#if props.immagine}` attorno all'`img`: una scheda senza immagine funziona lo stesso.
- Le schede sono un `ul`: un lettore di schermo dice «elenco, 6 voci».
- Nell'**archivio** dello stesso tipo, fra l'`h1` della pagina e i titoli `h3` delle schede metti una sezione con il suo `h2` («In programma»): i titoli non saltano.

## L'articolo

```html
<template data-histos="template" data-ref="site/articolo" data-role="single" data-title="Articolo"><Site.Header />
<main class="page" id="contenuto">
  <article class="post">
    <header class="post__header">
      <h1 class="post__title">{page.title}</h1>
      <p class="post__meta"><time datetime={page.publishedAt.date("Y-m-d")}>{page.publishedAt.date("j F Y")}</time></p>
    </header>
    <div class="post__content">{@slot}</div>
  </article>
</main>
<Site.Footer /></template>
```
```css
.post {
  max-inline-size: var(--xb-width-prose);
  margin-inline: auto;
  padding-block: var(--xb-section-m);
  &__title { font-size: var(--xb-h1); color: var(--xb-heading); text-wrap: balance; }
  &__meta { color: var(--xb-text-muted); font-size: var(--xb-text-s); }
  &__content {
    font-size: var(--xb-text-m);
    line-height: var(--xb-leading-normal);
    & > * + * { margin-block-start: var(--xb-flow-text); }
    & :is(h2, h3) { margin-block-start: var(--xb-flow-heading); color: var(--xb-heading); }
    & a { color: var(--xb-link); text-decoration: underline; }
  }
}
```
- La colonna del testo resta stretta (`--xb-width-prose`) anche su uno schermo largo: le righe lunghe stancano.
- I link nel testo sono **sempre sottolineati**: il colore da solo non basta.

## Pulsanti e link

<!-- rapido -->
| Se l'elemento… | Allora è… |
|---|---|
| porta a un'altra pagina o a un file | `<a href="…">` |
| fa qualcosa nella pagina (apre, chiude, filtra) | `<button type="button">` |
| invia un modulo | `<button type="submit">` |

- Il testo dice che cosa succede: «Leggi il programma», «Tutti i concerti», «Invia la richiesta». Mai «Clicca qui», «Scopri di più», «Leggi di più» da soli.
- Un pulsante o un link fatto solo di un'icona ha `aria-label`, e l'icona ha `aria-hidden="true" focusable="false"`.
- Ogni pulsante e ogni link ha uno stato `:focus-visible` con `outline: 2px solid var(--xb-focus)`. Mai `outline: none`.
<!-- /rapido -->

## Domande frequenti

```html
<section class="faq" aria-labelledby="faq-title">
  <h2 class="faq__title" id="faq-title">Domande frequenti</h2>
  <details class="faq__item" name="faq">
    <summary class="faq__question">Serve la prenotazione?</summary>
    <div class="faq__answer"><p>No, l'ingresso è libero fino a esaurimento dei posti.</p></div>
  </details>
</section>
```
```css
.faq {
  max-inline-size: var(--xb-width-prose);
  margin-inline: auto;
  padding-block: var(--xb-section-m);
  &__item { border-block-end: 1px solid var(--xb-border); }
  &__question {
    display: flex;
    align-items: center;
    min-block-size: 2.75rem;
    padding-block: var(--xb-space-s);
    font-size: var(--xb-text-m);
    font-weight: 700;
    color: var(--xb-heading);
    cursor: pointer;
    &:focus-visible { outline: 2px solid var(--xb-focus); outline-offset: 2px; }
  }
  &__answer { padding-block-end: var(--xb-space-s); }
}
```
- `details` e `summary` funzionano con tastiera e lettore di schermo, senza script.
- Lo stesso `name` su più `details` ne tiene aperto uno alla volta.

## Moduli

Sul sito WordPress i moduli si fanno con il plugin di moduli del sito (argomento `mestiere`). Quando scrivi tu il modulo (argomento `markup` per le regole), segui questo modello. `action` è l'indirizzo vero che riceve il modulo: chiedilo all'utente, non inventarlo.

```html
<form class="contact-form" action="/contatti/" method="post">
  <div class="contact-form__field">
    <label class="contact-form__label" for="cf-nome">Nome e cognome</label>
    <input class="contact-form__input" id="cf-nome" name="nome" type="text" autocomplete="name" required>
  </div>
  <div class="contact-form__field">
    <label class="contact-form__label" for="cf-email">Email</label>
    <input class="contact-form__input" id="cf-email" name="email" type="email" autocomplete="email" required aria-describedby="cf-email-aiuto">
    <p class="contact-form__help" id="cf-email-aiuto">Ti rispondiamo a questo indirizzo.</p>
  </div>
  <div class="contact-form__field">
    <label class="contact-form__label" for="cf-messaggio">Messaggio</label>
    <textarea class="contact-form__input" id="cf-messaggio" name="messaggio" rows="6" required></textarea>
  </div>
  <button class="contact-form__submit" type="submit">Invia la richiesta</button>
</form>
```
```css
.contact-form {
  display: grid;
  gap: var(--xb-space-m);
  max-inline-size: var(--xb-width-prose);
  &__field { display: grid; gap: var(--xb-space-2xs); }
  &__label { font-weight: 700; color: var(--xb-heading); }
  &__input {
    min-block-size: 2.75rem;
    padding: var(--xb-space-xs) var(--xb-space-s);
    border: 1px solid var(--xb-border);
    border-radius: var(--xb-radius-s);
    font: inherit;
    font-size: var(--xb-text-m);
    &:focus-visible { outline: 2px solid var(--xb-focus); outline-offset: 2px; }
  }
  &__help { color: var(--xb-text-muted); font-size: var(--xb-text-s); margin: 0; }
  &__submit {
    justify-self: start;
    min-block-size: 2.75rem;
    padding-inline: var(--xb-space-m);
    border: 0;
    border-radius: var(--xb-radius-s);
    background: var(--xb-primary);
    color: var(--xb-on-primary);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
    &:hover { background: var(--xb-primary-hover); }
    &:focus-visible { outline: 2px solid var(--xb-focus); outline-offset: 2px; }
  }
}
```
- Ogni campo ha una `label` visibile, collegata con `for` e `id`. Il `placeholder` non sostituisce mai l'etichetta.
- `autocomplete` giusto (`name`, `email`, `tel`, `street-address`…): il telefono compila da solo.
- `type` giusto: `email`, `tel`, `number`, `date`. Il telefono mostra la tastiera adatta.
- Un aiuto sotto il campo si collega con `aria-describedby`.
- Pochi campi: chiedi solo ciò che serve davvero.
- Il testo del pulsante dice che cosa succede («Invia la richiesta», non «Invia» o «OK»).
- Campi alti almeno `2.75rem`, testo almeno `var(--xb-text-m)`: sotto i 16px il telefono ingrandisce la pagina.

## Piè di pagina

```html
<template data-histos="part" data-ref="site/footer" data-area="footer" data-title="Piè di pagina">
<footer class="site-footer">
  <div class="site-footer__inner">
    <section class="site-footer__group" aria-labelledby="footer-contatti">
      <h2 class="site-footer__title" id="footer-contatti">Contatti</h2>
      <p class="site-footer__address">Via dell'Esempio 1<br><a class="site-footer__link" href="tel:+390000000000">000 000 0000</a></p>
    </section>
    <nav class="site-footer__nav" aria-label="Note legali">
      <ul class="site-footer__list">
        <li><a class="site-footer__link" href="/privacy/">Privacy</a></li>
        <li><a class="site-footer__link" href="/cookie/">Cookie</a></li>
      </ul>
    </nav>
  </div>
</footer>
</template>
```
```css
.site-footer {
  padding: var(--xb-section-s) var(--xb-gutter);
  background: var(--xb-surface-2);
  color: var(--xb-text);
  &__inner { display: grid; gap: var(--xb-space-l); grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--xb-grid-min)), 1fr)); }
  &__title { font-size: var(--xb-h5); color: var(--xb-heading); }
  &__list { list-style: none; margin: 0; padding: 0; }
  &__link { display: inline-flex; align-items: center; min-block-size: 2.75rem; color: var(--xb-link); }
}
```
- Indirizzo, telefono ed email sono **dati veri** del sito: se non li hai, scrivi «[testo da scrivere]» e chiedili.
- Il telefono è un link `tel:`, l'email un link `mailto:`. Il controllo li conta fra gli «Avvisi della build», uno per pagina: è normale, dillo all'utente.
- Il piè di pagina ha un secondo `nav` con il suo `aria-label`, diverso da quelli della testata.
- Le pagine dei link legali (`/privacy/`, `/cookie/`) devono esistere: un link interno rotto è un avviso.

## Stati: vuoto, errore, attesa

- **Vuoto:** ogni loop ha `{:else}` con una frase utile («Nessun concerto in programma. Torna a trovarci presto.»), mai uno spazio bianco.
- **Errore:** il messaggio dice che cosa è successo e che cosa fare («L'email non sembra completa: controlla che ci sia la @»). Mai «Errore» da solo.
- **Immagine assente:** il blocco funziona anche senza immagine (`{#if props.immagine}` attorno all'`img`).
- **Testo lunghissimo:** il blocco non si rompe (`overflow-wrap: anywhere` sui titoli che vengono dai dati).

## Le parole

- Frasi brevi, una informazione per frase. Verbi attivi.
- Titoli che dicono il contenuto («Orari della segreteria»), non giochi di parole.
- Niente MAIUSCOLO per intere frasi: si legge peggio. Se serve, `text-transform: uppercase` su una parola corta.
- Date in italiano per esteso (`"j F Y"` → «12 luglio 2026»). Orari scritti sempre allo stesso modo nel sito.
- Lo stesso nome per la stessa cosa in tutto il sito («Contatti» non diventa «Scrivici» in un'altra pagina).
- **Mai** testi di riempimento, mai numeri o recensioni inventati (argomento `mestiere`).

## Prima di dire «fatto»

<!-- rapido -->
Controlla ogni punto. Se uno non va, correggi prima di consegnare.
1. Un solo `h1`, titoli in ordine, anche negli archivi.
2. Ogni `img` ha `alt`, `width` e `height`. Solo la prima immagine grande ha `fetchpriority="high"`, le altre `loading="lazy"`.
3. Ogni link e pulsante ha un testo chiaro o un `aria-label`, e uno stato `:focus-visible`.
4. Ogni campo di un modulo ha una `label`.
5. Ogni loop ha `{:else}`.
6. Nessun valore inventato: solo token e i numeri ammessi.
7. Nessun testo inventato: solo testi veri o «[testo da scrivere]».
8. Una sola azione principale per schermata.
9. Ogni link interno porta a una pagina che esiste.
10. Ogni blocco ha la sua regola nel suo selettore, con le `@media` dentro. Nessuna regola in un foglio globale.
11. Nel prototipo: `prototype verify --severo` (o `hp_check_prototype` con `preview: true` e `strict: true`) dice «Prototipo valido» e il controllo severo è superato, nessun avviso del rapporto, nessuno scorrimento orizzontale, nessuna violazione axe, nessuna immagine rotta, nessun testo attaccato al bordo.
<!-- /rapido -->

Poi la lista completa dell'argomento `controllo`.
