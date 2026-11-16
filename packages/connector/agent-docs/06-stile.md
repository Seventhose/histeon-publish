---
key: stile
title: Lo stile: un selettore per blocco
summary: Leggilo prima di scrivere CSS, nel builder o in un prototipo: BEM con nesting, fogli globali, media query, variabili, layout, stili inline.
---

# Lo stile

## La regola d'oro

**Una classe per blocco, in BEM. Lo stile del blocco nel suo selettore. I valori dalle variabili.**

```text
.event-card              il blocco
.event-card__title       una parte
.event-card__meta        una parte
.event-card--featured    una variante
```

1. Ogni blocco ha **una** regola. Parti, varianti, stati e `@media` stanno **annidati** dentro.
2. I fogli globali non stilano i blocchi: servono a reset, `:root` e base tipografica.
3. Spazi, testi, colori, raggi e ombre sono variabili o token. Mai numeri inventati.
4. Niente catene di utility, niente `!important`, niente selettori lunghi e fragili. Il controllo non segnala né le catene né `!important`: controllali tu.
5. Nomi in minuscolo, con i trattini. Il blocco dice cosa è (`event-card`, `site-header`), non come appare (`box-blu`).

## Dove scrivi lo stile

### Nel builder (connettore xb)
Un `set-css` per blocco (`xb_setCss`, argomenti `selector` e `css`). Scrivi il **corpo** della regola, senza `.event-card { … }` attorno:

```css
/* histos-connector set-css .event-card '…'   (nomi delle variabili: quelli del brief) */
display: grid;
gap: var(--space-s);
padding: var(--space-m);
border-radius: var(--radius-m);
&__title { font-size: var(--text-l); line-height: 1.2; }
&__meta { font-size: var(--text-s); }
&--featured { box-shadow: var(--shadow-m); }
&:hover { transform: translateY(-2px); }
@media (--tablet) { padding: var(--space-s); }
```

- Prima di riscrivere un selettore, leggilo: `css <selettore>` (`xb_getCss`). L'elenco: `styles` (`xb_listStyles`).
- Classi BEM in un colpo: dai una classe al contenitore, poi `bem <uid>` (`xb_applyBem`) dà `blocco__parte` ai figli senza classe.
- Il CSS arriva in pagina solo se un elemento usa la classe: non servono pulizie.

### In Histeon Publish (prototipo, connettore hp)
Le regole dei blocchi stanno in **un solo** `<style data-histos="selectors">`. Lì scrivi la regola intera, una per selettore:

```html
<style data-histos="selectors">
.opera-card {
  display: grid;
  gap: var(--xb-space-s);
  padding: var(--xb-space-m);
  border-radius: var(--xb-radius-m);
  background: var(--xb-surface);
  &__titolo { font-size: var(--xb-text-l); }
  &:hover { box-shadow: var(--xb-shadow-m); }
  @media (width < 48rem) { padding: var(--xb-space-s); }
}
</style>
```

- Ogni regola diventa uno stile del pannello CSS del builder.
- Una regola per selettore: non ripetere `.opera-card` più in basso, aggiungi alla sua regola. Un selettore ripetuto ferma l'import con «Stili per selettore: selettore vuoto, troppo lungo o ripetuto (.opera-card).», senza riga: di solito è lo stesso selettore scritto due volte al primo livello. Cercalo nel foglio e unisci le due regole. Un selettore vuoto o di più di 1.024 caratteri dà lo stesso messaggio.
- Un `@media` fuori da una regola ferma l'import.
- Un `<style>` senza `data-histos` viene ignorato e segnalato nel rapporto.

## L'errore più grave: tutto in un foglio globale

```html
<!-- ❌ ogni blocco nel foglio globale, il selettore ripetuto in ogni @media -->
<style data-histos="global" data-name="Base">
.opera-card { display: grid; padding: 24px; }
.opera-card__titolo { font-size: 22px; }
.opera-card:hover { box-shadow: 0 2px 8px #0003; }
@media (max-width: 768px) { .opera-card { padding: 12px; } }
</style>

<!-- ✅ il foglio globale tiene solo la base; il blocco ha la sua regola -->
<style data-histos="global" data-name="Base">
body { margin: 0; font-family: var(--xb-font-body); color: var(--xb-text); background: var(--xb-bg); }
img { max-width: 100%; height: auto; }
</style>
<style data-histos="selectors">
.opera-card { padding: var(--xb-space-m); &__titolo { … } &:hover { … } @media (width < 48rem) { … } }
</style>
```

```css
/* ❌ builder: tutta la pagina in un solo selettore */
/* set-css .pagina '& .hero { … } & .card { … } & .card h3 { … }' */
/* ✅ builder: un set-css per blocco */
/* set-css .hero '…'   poi   set-css .card '… &__title { … }' */
```

**Perché:** un selettore si legge e si modifica in un posto solo, nel pannello CSS. In un foglio globale la stessa classe si ripete in più regole, e di nuovo in ogni `@media`.

## In dettaglio

### Fogli globali: a cosa servono
- **Sì:** reset, `:root`, regole sugli elementi (`body`, `img`), base tipografica.
- **In Histeon Publish:** `<style data-histos="global" data-name="…">`, anche più d'uno; l'ordine resta quello del file. `@font-face` va qui, con i file WOFF2 dichiarati come media. Un `<link>` a Google Fonts viene ignorato.
- **Limiti in Histeon Publish:** al massimo 100 fogli globali di 1 MB; fogli e stili per selettore insieme al massimo 8 MiB. Un foglio troppo fitto da analizzare (di solito una parentesi, una virgoletta o un commento non chiusi) ferma gli stili per selettore; un foglio globale così entra com'è, con l'avviso «… l'import non ne legge le regole». Il source map incorporato che chiude un foglio (`/*# sourceMappingURL=data:… */` su una riga sua) esce con un avviso; in un altro punto ferma il foglio. Dichiarazioni molto lunghe che finiscono con `important` senza `!` contano come un foglio troppo fitto: fermano gli stili per selettore, e un foglio globale entra com'è, con lo stesso avviso. Scrivi `!important`, o meglio toglilo.
- **No:** blocchi, parti, varianti, stati, le `@media` di un blocco.
- **Se succede lo stesso:** all'import di un prototipo Histeon Publish sposta nel selettore di ogni blocco usato le sue regole rimaste nei fogli globali, annidate come in SCSS, con la cascata invariata (`counts.selectorRules` nel rapporto); restano nel foglio le regole condivise con altri blocchi e quelle di blocchi che nessun documento usa. Nel builder lo stesso spostamento lo fanno «Porta nel selettore» e «Nei selettori…». Non contarci: scrivi lo stile nel selettore.

### BEM e annidamento
- `&__parte` e `&--variante` diventano regole sorelle: `.card__title`, `.card--dark`.
- Funziona anche annidato: `&__title { &--big { … } }` diventa `.card__title--big`.
- Funziona dentro `@media`, `@container`, `@supports`, `@layer` annidate: `@media (…) { &__title { … } }` diventa `@media (…) { .card__title { … } }`.
- `&:hover`, `&:focus-visible`, `& img` e `@media` restano annidati.

```css
/* ❌ la parte scritta fuori dal blocco */
.card { padding: var(--xb-space-m); }
.card__title { font-size: var(--xb-text-l); }
/* ✅ la parte annidata nel blocco */
.card { padding: var(--xb-space-m); &__title { font-size: var(--xb-text-l); } }
```

### Media query
- **Nel builder (connettore xb):** usa le media query con nome: `@media (--tablet)`. I nomi esatti sono nel `brief`; quelli predefiniti sono `mobile` `(width < 40em)`, `tablet` `(width < 64em)`, `desktop` `(width >= 64em)`. Valgono anche nelle container query: `@container card (--tablet)`.
- Un nome sconosciuto resta com'è scritto e il browser ignora la regola: scrivi solo nomi del `brief`.
- **In Histeon Publish (prototipo, connettore hp):** una condizione con una misura, sempre annidata nella regola: `@media (width < 48rem)`. Il prototipo non ha media query con nome: `@media (--tablet)` resterebbe scritto così e la regola non varrebbe mai.

```css
/* ❌ builder: misura scritta a mano */   @media (max-width: 768px) { padding: 12px; }
/* ✅ builder: media query con nome */    @media (--tablet) { padding: var(--space-s); }
```

### Variabili e token
- **Nel builder (connettore xb):** le variabili del framework attivo, con i nomi del `brief` (spazi `--space-*`, testi `--text-*`, colori `--primary`…, raggi `--radius-*`, ombre `--shadow-*`). Nei componenti i token `--xb-*`, che valgono con ogni framework. Con Histeon CSS attivo, solo token `--xb-*`.
- **In Histeon Publish (prototipo, connettore hp):** token `--xb-*`. Palette e caratteri si impostano in `design` nel manifest, non con valori sparsi.
- Il controllo del prototipo segnala ogni `var(--nome)` che nessun foglio definisce: usa un token `--xb-*` o un valore di riserva, `var(--nome, 1rem)`.
- Un valore fisso solo quando nessun token va bene.
- I token per gruppo sono nell'argomento `histos-css`; i nomi di Automatic.css nell'argomento `acss`.

```css
/* ❌ */ padding: 23px; color: #3a7bd5; font-size: 17px;
/* ✅ */ padding: var(--xb-space-m); color: var(--xb-primary); font-size: var(--xb-text-m);
```

### Layout
- Grid e flex con `gap`, mai margini a caso tra fratelli.
- Griglie fluide: `repeat(auto-fit, minmax(min(16rem, 100%), 1fr))`, spesso senza media query.
- `min()` e `clamp()` per spazi e larghezze. Mai larghezze fisse in px sui contenitori.
- Blocchi di testo larghi al massimo `60ch`–`75ch`.
- Componenti che cambiano con lo spazio: `container-type: inline-size` sul contenitore, poi `@container (width <= 30rem)`.
- Rispetta `prefers-reduced-motion` per animazioni e transizioni non essenziali.

```css
/* ❌ */ width: 1200px; & .item { width: 380px; float: left; margin-right: 20px; }
/* ✅ */ display: grid; gap: var(--xb-space-m); grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr));
```

### Stili inline, utility, focus
- **Stili inline:** no per stilare un blocco. Nel builder solo per un valore dinamico: `style="--progress: {item.fields.percentuale}%"`. Nel prototipo `style` è ammesso solo statico, senza `{…}`, `url()`, `image-set()`, `@import`, `expression()` o commenti.
- **Utility nel builder:** solo per una regolazione puntuale in un contenuto editoriale. Mai per layout, componenti o sezioni. Nel dubbio, il blocco.
- **Utility nel prototipo:** nessuna nei blocchi che scrivi. Con `"framework": "acss"` l'import converte le classi di ACSS in utility di Histeon CSS (`text--l` → `xb-text-l`): valgono, ma lo stile del blocco sta nella sua regola. Preferisci `font-size: var(--text-l)` dentro `.hero__title { … }` a `class="hero__title text--l"`. Il controllo non segnala le utility: controllale tu.
- **Focus visibile:** `&:focus-visible { outline: 2px solid var(--xb-primary); outline-offset: 2px; }`.
- **Immagini nel CSS del prototipo:** `background-image: url("asset:nome")`. `asset:` solo dentro `url()`.
