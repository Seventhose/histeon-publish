---
key: componenti
title: Componenti, slot e template
summary: Leggilo quando una struttura si ripete, quando usi o crei un componente, o quando lavori su template e parti di template, nel builder o in un prototipo.
---

# Componenti, slot e template

Un componente è una struttura riusabile con **props** (i valori) e **slot** (il contenuto libero). Lo definisci una volta e lo usi con `<Nome prop="…"/>`.

## Le regole essenziali
1. Prima di crearne uno, guarda quelli che esistono e usali. Nel builder: `components` (`xb_getComponents`) e il `brief`. In Publish: i `<template data-histos="component">` già nel prototipo e, per un progetto importato, `hp_project`.
2. Crea un componente quando la stessa struttura compare due volte o più: schede, card, testimonianze, call to action.
3. Nel markup il nome è in PascalCase, la chiave è in kebab-case: `<Ui.CardHero>` è `ui/card-hero`.
4. Dentro un componente non vedi le variabili di chi lo usa: passa tutto come props.
5. Il contenuto libero va in uno slot, non in una prop.
6. Classi in BEM con un nome di blocco unico (`.pricing-card`), stile nel suo selettore con i token `--xb-*` (vedi l'argomento `stile`).
7. Non scrivere JavaScript. Se serve, lo aggiunge l'utente dal pannello JS del componente.
8. Un componente è accessibile: ruoli, tastiera, focus, movimento ridotto (vedi l'argomento `accessibilita`).

❌ Sbagliato: la stessa card copiata a mano
```html
<article class="event-card"><h3 class="event-card__title">Concerto</h3></article>
<article class="event-card"><h3 class="event-card__title">Mostra</h3></article>
```
✅ Giusto: un componente in un loop, con il caso vuoto (nel builder; `eventi` è un nome d'esempio: usa una query che il sito ha davvero)
```html
{#loop data.eventi as e}<EventCard title={e.title} url={e.url} />
{:else}<p class="events__empty">Nessun evento in programma.</p>{/loop}
```

## Usare un componente
Esempio nel builder. In Publish un `src` dinamico vale solo come prop intera di un componente (vedi «In Histeon Publish»).
```html
<Ui.Card title="Prossimi eventi" featured={true}>
  {#slot media}<img src={item.image.url} alt={item.image.alt}>{/slot}
  <p>Contenuto libero nello slot predefinito.</p>
</Ui.Card>
```

| Scrivi | La prop vale |
|---|---|
| `title="Concerti"` | una stringa |
| `featured` (da solo) | `true` |
| `count={3}`, `open={false}`, `icon={null}` | il valore letterale |
| `url={post.url}` | un'espressione |
| `title="Scheda di {this.title}"` | un testo con un'espressione |

- I nomi delle props sono identificatori. `__proto__`, `constructor` e `prototype` non valgono.
- Il contenuto libero va nello slot `default`. Uno slot con nome si scrive `{#slot nome}…{/slot}`, come figlio diretto del componente.
- Non mettere insieme contenuto libero e `{#slot default}`: è un errore.
- Il contenuto di uno slot si valuta nel contesto di chi usa il componente: lì vedi `item`, `post`, `this`.
- Quando rileggi `html`, un componente con slot con nome mostra anche lo slot `default` in forma esplicita. È normale.

## Scrivere la definizione
```html
<article class="event-card">
  {#if !slots.media.empty}<div class="event-card__media">{@slot media}</div>{/if}
  <h3 class="event-card__title"><a href={props.url}>{props.title}</a></h3>
  <div class="event-card__body">{@slot}</div>
</article>
```
- `{props.title}` legge una prop. `{#loop props.items as item}` ripete una lista passata come prop.
- `{@slot}` è il punto dello slot predefinito; `{@slot media}` quello dello slot `media`.
- Uno slot senza contenuto non mostra nulla. `slots.media.empty` ti dice se è vuoto.
- I tipi delle props sono `string`, `number`, `boolean`, `url`, `image`, `rich-text`, `enum`, `array`, `object`, ognuno con un valore predefinito. Una prop `enum` dichiara anche le sue scelte in `options`, e il suo valore predefinito è una di quelle.
- Una variante può venire da una prop: `class="event-card event-card--{props.variant}"`.

❌ Sbagliato: la definizione legge una variabile di chi la usa
```html
<h3 class="event-card__title">{post.title}</h3>
```
✅ Giusto: la definizione legge una prop…
```html
<h3 class="event-card__title">{props.title}</h3>
```
…e chi usa il componente passa il valore
```html
<EventCard title={post.title} url={post.url} />
```

## Nomi e chiavi
- La chiave (`ref`) è `nome` oppure `namespace/nome`, con al massimo una `/`. La stessa regola vale per componenti, parti di template e template.
- Ogni parte è fatta di parole minuscole unite da un trattino singolo; ogni parola comincia con una lettera e poi ha lettere o cifre. Niente maiuscole, `_` o trattini doppi.
- Nel markup ogni segmento passa in PascalCase e `/` diventa `.`. La conversione vale nei due sensi.
- Al massimo un namespace: `<Ui.CardHero>` sì, `<Ui.Card.Hero>` no.
- La chiave non è un id di post: sopravvive a esportazioni, importazioni e migrazioni.

| Chiave | Nel markup |
|---|---|
| `card` | `<Card>` |
| `event-card` | `<EventCard>` |
| `card-v2` | `<CardV2>` |
| `ui/card-hero` | `<Ui.CardHero>` |
| `site/header` | `<Site.Header />` |

❌ `<event-card>` e `<eventCard>` sono tag HTML con l'iniziale minuscola, non il componente. ✅ `<EventCard>`, `<Ui.CardHero>`.

❌ Chiavi rifiutate, con la correzione:
```text
site/404      → site/pagina-non-trovata   (una parola che comincia con una cifra)
hero-2col     → hero-due-colonne
ui/card/hero  → ui/card-hero              (due /)
Card, event_card, event--card → card, event-card
```
Un template di ruolo `404` tiene `data-role="404"`: è la chiave a non poter avere una parola che comincia con una cifra. Nel prototipo il controllo segnala una chiave fuori regola con documento e riga.

## Nel builder (connettore xb)
### Creare un componente
1. Costruisci un esemplare con classi BEM e il suo stile: un `set-css` per blocco.
2. Trasformalo con `component <uid> <chiave> [titolo]` (`xb_createComponent`: `uid`, `ref`, `title` facoltativo). La chiave è in minuscolo, come `event-card` o `ui/event-card`.
3. L'elemento diventa un'istanza del componente.
4. Le props le definisce l'utente nel pannello del componente. Proponigli quali servono (titolo, immagine, link…), con valori predefiniti sensati.
5. Le altre istanze le scrivi nel markup, con `insert` o `set-html`: `<EventCard title="…" />`.

L'utente può farlo anche da solo: Proprietà → Crea componente, o clic destro nella Struttura.

### Dove vive un componente
- È un documento del builder, come una pagina, con la sua chiave e lo schema delle props. `doc` ti dice quale documento è aperto nella scheda.
- Nel `brief` ogni componente compare come `<Ui.Card> (ui/card) props: …`. Usa quel nome e quelle props.
- Con i token `--xb-*` lo stile del componente funziona con qualsiasi framework.
- Una sezione della Libreria che usa un componente funziona su un altro sito solo se lì il componente esiste.

### Template e parti di template
- Template (`wp_template`) e parti di template (`wp_template_part`) sono documenti del builder come le pagine: stessa sintassi, salvataggio in sviluppo.
- Li apre l'utente: Aspetto → Template Histeon, oppure «Template con Histeon: …» nella barra di amministrazione. Servono un tema a blocchi e i permessi giusti. Il connettore non ha uno strumento per crearli: un template nuovo lo crea l'utente (pannello «Nuovo template» di Histeon → Template).
- In un template, il contenuto del post corrente si inserisce con `{@content}`.
- Un template non ha una pagina sua: canvas e anteprima lo mostrano con un contenuto di esempio («Anteprima con»).
- Nei componenti e nelle parti di template i controlli non chiedono un `h1`.

## In Histeon Publish (prototipo, connettore hp)
Componenti, parti e template sono elementi `<template data-histos="…">` nel `body` del prototipo (vedi l'argomento `prototipi`).

### Componente
```html
<template data-histos="component" data-ref="card-opera" data-title="Scheda opera" data-props='{"titolo":{"type":"string","default":""},"immagine":{"type":"image","default":""},"url":{"type":"url","default":"/"}}'>
  <article class="card-opera">{#if props.immagine}<img class="card-opera__img" src={props.immagine} alt={props.titolo}>{/if}{@slot media}<h3 class="card-opera__title"><a href={props.url}>{props.titolo}</a></h3></article>
</template>
```
- `data-ref` è la chiave, con la regola di «Nomi e chiavi» (anche per parti e template: `site/404` ❌, `site/pagina-non-trovata` ✅), `data-title` il nome leggibile. `data-props` è lo schema JSON delle props, facoltativo: per ogni prop `type` e `default`, con i tipi elencati sopra.
- **Prop `enum`:** vuole anche `options`, un elenco non vuoto di testi (al massimo 100), e il suo `default` deve essere uno di questi. Senza `options` il controllo si ferma. Esempio: `"variante":{"type":"enum","default":"chiara","options":["chiara","scura"]}`, poi `class="card-opera card-opera--{props.variante}"`.
- `data-ref` è unico. Un componente usato deve essere dichiarato nel file.
- **Props controllate:** passi solo le props dichiarate nel suo `data-props` (un componente o una parte senza `data-props` non ne ha). Il valore scritto ha il tipo della prop:

| Tipo della prop | ✅ | ❌ |
|---|---|---|
| `number` | `conta={3}` | `conta="3"` |
| `boolean` | `vetrina={true}` | `vetrina="true"` |
| `string` | `titolo="5"` | `titolo={5}` |
| `enum` | `variante="scura"` | `variante="blu"` |

  - Un `enum` vale uno dei suoi `options`. Un oggetto intero (`{opera}`) va solo in una prop `object`: altrove passa un suo campo, `titolo={opera.title}`.
  - Uno slot riempito deve esistere: `{#slot media}` vuole `{@slot media}` nella definizione, il contenuto libero vuole `{@slot}`.
  - Il controllo dice ogni problema alla prop, al `{#slot}` o al tag, con riga e colonna, anche se il componente è dichiarato più avanti nel file. Un `asset:` in una prop è detto alla riga dove comincia il documento, senza colonna.
- In un loop passi i campi del record: `{#loop opere_recenti() as opera}<CardOpera titolo={opera.title} url={opera.url} immagine={opera.fields.immagine} />{/loop}`.
- **Immagini:** `asset:` non va mai in una prop, perché su WordPress l'immagine sarebbe rotta. Un'immagine fissa va in uno slot; l'immagine di un record arriva dal suo campo `asset` e nella definizione scrivi `src={props.immagine}`. Su WordPress `src={props.immagine}` arriva solo se il plugin Histeon del sito è aggiornato: nei componenti che non stanno in un elenco preferisci lo slot.
- **Icone:** SVG in linea, meglio in un componente (`ui/icona`).
- **Titoli in un componente usato a livelli diversi:** il tag non può venire da una prop. Dichiara una prop `enum` con i livelli e scrivi un ramo per livello, con il livello predefinito nel primo ramo: il controllo dei titoli legge il primo.

```html
<template data-histos="component" data-ref="ui/scheda" data-title="Scheda" data-props='{"titolo":{"type":"string","default":""},"livello":{"type":"enum","default":"h2","options":["h2","h3"]}}'>
  <article class="scheda">{#if props.livello == "h2"}<h2 class="scheda__titolo">{props.titolo}</h2>{:else}<h3 class="scheda__titolo">{props.titolo}</h3>{/if}</article>
</template>
```
Poi `<Ui.Scheda titolo="Uno" />` sotto un `h1`, `<Ui.Scheda titolo="Due" livello="h3" />` sotto un `h2`.

❌ Sbagliato: l'import si ferma
```html
<CardOpera titolo="Ehi" immagine="asset:ehi" />
```
✅ Giusto
```html
<CardOpera titolo="Ehi" url="/opera/ehi/">{#slot media}<img src="asset:ehi" alt="Ehi">{/slot}</CardOpera>
```

### Parti di template
- `<template data-histos="part" data-ref="site/header" data-area="header" data-title="Testata">…</template>`.
- `data-area` vale `header`, `footer` o `uncategorized`.
- Si usano come i componenti: `site/header` diventa `<Site.Header />`.
- Testata e piè di pagina comuni della proposta diventano due parti: `site/header` e `site/footer`.

### Template
```html
<template data-histos="template" data-ref="site/page" data-title="Pagina">
  <Site.Header /><main>{@slot}</main><Site.Footer />
</template>
```
- Ogni template contiene `{@slot}`: lì va il contenuto della pagina o dell'articolo. Anche un template d'archivio, dove resta vuoto: lì i contenuti arrivano da `{#loop main() as x}` (vedi l'argomento `dati`).
- Un template con `data-props` dichiara anche `"page": {"type": "object"}`: è la prop in cui riceve la pagina. Senza `data-props` ha `page` da sé.
- `data-role` è facoltativo: uno di `front-page`, `home`, `index`, `single`, `page`, `archive`, `category`, `tag`, `search`, `404`. Al massimo un template per ruolo. Il template della 404 si chiama per esempio `site/pagina-non-trovata`, mai `site/404`.
- Una pagina sceglie il template con `data-template="site/page"`; un tipo di contenuto con `singleTemplate` e `archiveTemplate`. Quale template vince per ogni vista: vedi l'argomento `prototipi`.
- Nei template e nelle parti `page` è il documento che il template mostra: la pagina, l'articolo, il record o l'archivio. Nei template, nelle parti e nei componenti hai anche `props` e `slots`; nelle pagine solo `page` e `this` (vedi l'argomento `sintassi`).
- Nel prototipo non c'è JavaScript: carrello, filtri dal vivo e gallerie diventano link, pagine vere, loop e componenti.
