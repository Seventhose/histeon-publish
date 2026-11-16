---
key: sintassi
title: Sintassi dell'HTML di Histeon
summary: Leggilo prima di scrivere HTML nel builder o nei template di un prototipo (markup stretto, spazi, espressioni, condizioni, loop, escape).
---

# Sintassi dell'HTML di Histeon

È HTML vero, più alcune estensioni tra graffe. Vale in due posti:
- **Nel builder (connettore xb):** è il testo che leggi con `html` (`xb_getHtml`) e scrivi con `set-html` (`xb_setHtml`) o `insert` (`xb_insert`). Gli uid non compaiono nel testo: non scriverli.
- **In Histeon Publish (prototipo, connettore hp):** è il contenuto di ogni `<template data-histos="…">`. I limiti in più sono nella sezione «In Histeon Publish».

## Le regole essenziali
1. Chiudi ogni elemento: `<p>…</p>`. `<div/>` vale `<div></div>`.
2. Scrivi i tag HTML in minuscolo. Un'iniziale maiuscola indica un componente (vedi l'argomento `componenti`).
3. Gli elementi void non hanno il tag di chiusura (niente `</img>`): `area base br col embed hr img input link meta source track wbr`.
4. Non ripetere un attributo nello stesso elemento.
5. Un a capo tra due elementi non lascia spazio. Per uno spazio scrivi `{" "}`, oppure tieni gli elementi sulla stessa riga.
6. Le espressioni stanno tra graffe: `{this.title}`, `href={item.url}`. Una graffa letterale si scrive `\{` o `\}`.
7. Niente aritmetica e niente chiamate libere: solo campi, operatori e modificatori.
8. Ogni valore stampato è escapato: un'espressione non stampa mai HTML.
9. Ciò che si ripete viene da un loop, non da testo copiato più volte.
10. Prevedi il caso vuoto con `{:else}` dentro il loop: `{#loop … as x}…{:else}<p>Niente da mostrare.</p>{/loop}`. Nel ramo `{:else}` la variabile del loop (`x`) e l'indice non esistono.

❌ Sbagliato
```html
<DIV class="hero"><p>Primo<p>Secondo</DIV>
<p class="hero__text" class="lead">Terzo</p>
```
✅ Giusto
```html
<div class="hero"><p>Primo</p><p>Secondo</p></div>
<p class="hero__text">Terzo</p>
```

## Esempio completo (nel builder)
`notizie` è un nome d'esempio: usa solo query che il sito ha davvero (sezione «Dati e query» del builder; se non le conosci, chiedile all'utente).
```html
<section xb:label="Notizie" class="news">
  <h2 class="news__title">Ultime notizie</h2>
  {#loop data.notizie as post, i}
    <article class="news-card">
      <h3 class="news-card__title"><a href={post.url}>{post.title}</a></h3>
      <p class="news-card__excerpt">{post.excerpt.truncateWords(20)}</p>
    </article>
  {:else}
    <p class="news__empty">Nessuna notizia per ora.</p>
  {/loop}
</section>
```

## In dettaglio
### Markup
- **Etichetta nel pannello Struttura:** `<section xb:label="Hero">`. È l'unico attributo `xb:*`: ogni altro `xb:*` è un errore.
- **Nomi dei tag:** iniziano con una minuscola. La maiuscola interna serve all'SVG (`linearGradient`), il trattino ai tag personalizzati (`my-widget`). `<DIV>` è un errore; `<Header>` è un componente.
- **Testo letterale:** dentro `script`, `style` e `textarea` non ci sono espressioni né markup. Le entità HTML (`&amp;`, `&lt;`) restano come le scrivi.
- **Commenti** `<!-- … -->`: vengono rimossi, con un avviso. Non usarli per lasciare note.
- **Blocchi WordPress (nel builder):** `<!-- wp:nome /-->` (oppure `<!-- wp:nome -->…<!-- /wp:nome -->`) inserisce un blocco WordPress, anche un blocco PHP del sito. Non è un commento: resta.
- **HTML grezzo (nel builder):** `{#raw}…{/raw}`. Dentro non c'è interpolazione; per chi non ha `unfiltered_html` passa da `wp_kses_post` al salvataggio.
- **Limiti:** al massimo 128 livelli di annidamento. `__proto__`, `constructor` e `prototype` non valgono come nomi di attributo o di prop.
- **Escape:** `\{` e `\}` danno graffe letterali nel testo e negli attributi (`<p>Scrivi \{nome\} nel modulo.</p>`). Un testo che finisce con `\` subito prima di un blocco `{#…}` viene letto come escape: per una barra finale scrivi `&#92;`.
- **Forma canonica:** quando rileggi `html`, il builder lo stampa con 2 spazi di rientro, i frammenti con testo su una riga e `href={url}` senza virgolette. Non è un errore tuo.

### Spazi (come in JSX)
- Fuori da `pre`, `textarea`, `script` e `style`, gli spazi che contengono un a capo spariscono quando stanno da soli tra due nodi (è indentazione) o all'inizio e alla fine del contenuto di un elemento.
- Gli altri spazi consecutivi diventano uno solo. Dentro `pre` tutto resta com'è.

❌ Sbagliato: a schermo i due link si attaccano («UnoDue»)
```html
<a class="btn" href="/uno/">Uno</a>
<a class="btn" href="/due/">Due</a>
```
✅ Giusto, in uno dei due modi
```html
<a class="btn" href="/uno/">Uno</a> <a class="btn" href="/due/">Due</a>
<a class="btn" href="/uno/">Uno</a>{" "}<a class="btn" href="/due/">Due</a>
```

### Formattazione inline
- `a abbr b br code em i kbd mark q s small span strong sub sup time u wbr` restano parte del testo se hanno solo gli attributi ammessi (`a`: `href`, `target`, `rel`; `abbr`: `title`; `time`: `datetime`; gli altri nessuno), nessun `{…}` negli attributi, nessun `xb:label`, e dentro solo testo o altra formattazione inline.
- Altrimenti diventano elementi selezionabili. `<p>Leggi <a href="/orari/">gli orari</a> prima di venire.</p>` è un solo testo; `<a class="btn" href={item.url}>{item.title}</a>` è un elemento.

### Espressioni
- **Dove:** nel testo e negli attributi. `href={item.url}` è solo un'espressione; `alt="Foto di {item.title}"` è testo con un'espressione.
- **Percorsi:** `post.image.url`, con gli indici `data.orari[0].giorno`. Sono null-safe: se `post` è nullo, `post.image.url` vale `null`, non un errore. Un nome sconosciuto vale `null`.
- **Letterali:** numeri (`3`, `-1`), stringhe (`"testo"`), `true`, `false`, `null`, liste (`[1, 2, 3]`).
- **Radici:** `this`, `site`, `user`, `url`, `data`, `facets`; nei componenti anche `props` e `slots`; nei loop la variabile del loop e l'indice. I campi sono nell'argomento `dati`.

### Operatori
`== != < <= > >= && || ! ?: ??`, più le parentesi per raggruppare.
- `==` e `!=` sono stretti, senza conversioni di tipo (`1 == 1.0` è vero). `===` e `!==` non esistono.
- `<` `<=` `>` `>=` confrontano due numeri o due stringhe; in ogni altro caso danno `false`.
- `&&` e `||` restituiscono sempre un booleano, mai un valore di ripiego.
- `a ?? b` dà `b` solo se `a` è `null`; `a.default(b)` dà `b` se `a` è falso. `cond ? a : b` è il condizionale.
- Sono falsi `false`, `null`, `0`, `""` e la lista vuota. Tutto il resto è vero.

❌ Sbagliato
```html
<p>{item.fields.prezzo * 2}</p>
<p>{post.excerpt || "Nessun estratto"}</p>
```
✅ Giusto
```html
<p>{post.excerpt.default("Nessun estratto")}</p>
<p class="news-card__label">{i == 0 ? "Il più recente" : "Archivio"}</p>
```

### Attributi e uscita
- Un attributo fatto **solo** di un'espressione sparisce se vale `false` o `null` (`hidden={!this.excerpt}`); se vale `true` diventa booleano.
- Nel testo `null` non stampa nulla, i booleani stampano `true`/`false`, le liste i valori separati da virgole.
- **Un oggetto nel testo:** nel builder stampa il suo testo (titolo del post, nome del termine, URL dell'immagine). In Publish ferma la build, e il controllo lo rifiuta: stampa sempre un suo campo, `{opera.fields.serie.title}`, mai `{opera.fields.serie}`.
- Tutto è escapato. Nel builder: `esc_html` nel testo, `esc_attr` negli attributi, in più `esc_url` per gli URL dinamici.
- Nel builder un errore di valutazione, per esempio un modificatore sconosciuto, non rompe la pagina: l'espressione vale `null`. In Publish il controllo lo rifiuta prima (vedi «In Histeon Publish»).

### Modificatori
Si chiamano come metodi, con le parentesi, e si concatenano: `{post.title.trim().upper()}`.
- **Testo:** `upper()` `lower()` `capitalize()` `trim()` `stripTags()`; `truncateWords(n, più = "…")` e `truncateChars(n, più = "…")` accorciano dopo aver tolto i tag.
- **Date e numeri:** `date(formato?)` (vedi «Date» qui sotto), `number(decimali = 0)`.
- **Liste e stringhe:** `length()` `first()` `last()` `join(sep = ", ")` `slice(inizio, lunghezza?)` `includes(x)` `pluck(chiave)`.
- **Altri:** `default(x)`, `json()`, `slug()`.
- Nel builder il sito può aggiungerne altri dal suo PHP (filtro `xb_modifiers`). Non inventarne: uno sconosciuto vale `null` nel builder; in Publish il controllo lo rifiuta e suggerisce il nome giusto (`uppercase()` → `upper`).

### Date
`date("formato")` usa le lettere di `date()` di PHP. Le più utili, per sabato 7 novembre 2026 alle 9:05:

| Lettera | Dà | Lettera | Dà |
|---|---|---|---|
| `j` | giorno, `7` | `d` | giorno a due cifre, `07` |
| `l` | nome del giorno, `sabato` | `D` | nome breve, `sab` |
| `n` | mese, `11` | `m` | mese a due cifre, `11` |
| `F` | nome del mese, `novembre` | `M` | nome breve, `nov` |
| `Y` | anno, `2026` | `y` | anno a due cifre, `26` |
| `H` | ora, `09` | `G` | ora senza zero, `9` |
| `i` | minuti, `05` | `\\` | nel file due barre: la lettera che segue resta com'è |

- `{opera.fields.in_mostra.date("j F Y")}` dà «7 novembre 2026». Nomi di giorni e mesi nella lingua del sito (in Publish il `locale` del manifest).
- **Una lettera com'è:** nel file scrivi **due** barre prima della lettera. `{opera.fields.in_mostra.date("j \\d\\i F")}` dà «7 di novembre».
  - Con una barra sola (`"j \d\i F"`) la stringa perde la barra, e `d` e `i` restano lettere del formato: si stamperebbe «7 0700 novembre». Vale nel builder e in Publish.
  - In Publish il controllo rifiuta la barra singola e mostra il formato giusto, con le barre raddoppiate. Rifiuta anche `\n`, `\t` e `\r`, che diventano un a capo o una tabulazione.
- **Cosa legge in Publish:** `AAAA-MM-GG`, `AAAA-MM-GGThh:mm:ss` con `Z` o con il fuso (`+01:00`), un numero di secondi. Un'ora senza fuso vale nel `timeZone` del manifest. Un valore vuoto non stampa nulla; ogni altra forma ferma la build.
- **Scrivi sempre il formato.** Senza, il builder usa il formato del sito e Publish stampa `2026-11-07`.

### Condizioni
`{#if this.image}<img src={this.image.url} alt={this.image.alt}>{:else if this.excerpt}<p>{this.excerpt}</p>{:else}<p>Nessuna immagine.</p>{/if}`
- Viene mostrato il primo ramo vero. `{:else}` è uno solo e va per ultimo.

### Loop e sorgenti (nel builder)
Forma: `{#loop sorgente as elemento, indice}…{:else}…{/loop}`. L'indice è facoltativo e parte da 0.
- **`{:else}`:** facoltativo, uno solo, in fondo al loop. Si mostra quando il loop non ha elementi; lì la variabile del loop e l'indice non esistono, le altre radici sì. Senza `{:else}` un loop vuoto non mostra nulla.
- **Query predefinite:** `posts(limit: 3, type: "post")`, con argomenti `limit type category tag author orderby order offset include exclude taxonomy term`; `terms`; `users`, con argomenti `limit role orderby order`; `main`, cioè l'archivio corrente.
- **Query dei loop del sito** (sezione «Dati e query» del builder): `{#loop nome(param: valore) as item}`. Il `brief` le elenca con i loro parametri, nella sezione «Query dei loop»; le «media query con nome» del `brief` sono un'altra cosa, solo per `@media`.
- **Liste:** `data.nome` (sorgenti JSON, query, dati PHP del sito), `props.items`, `this.fields.capitoli` (ripetitore), `facets.nome.items` (elenchi con filtri), `[1, 2, 3]`.
- **Limiti:** al massimo 6 loop annidati e 1.000 elementi per loop. Le query danno solo contenuti pubblicati e leggibili da chi visita.

❌ Sbagliato
```html
{#loop posts(3) as post}…{/loop}
<p>{posts(limit: 3).length()} articoli</p>
```
✅ Giusto: argomenti sempre con nome; una query fuori da un loop si legge con `data` (vedi l'argomento `dati`)
```html
{#loop posts(limit: 3) as post}…{/loop}
<p>{data.notizie.length()} articoli</p>
```

## In Histeon Publish (prototipo, connettore hp)
Stessa sintassi, con questi limiti, per restare portabile su WordPress (tag e attributi ammessi: vedi l'argomento `markup`):
- **Radici:** nelle pagine e negli articoli solo `page` e `this`; nei template e nelle parti `page` è il documento che il template mostra (pagina, articolo, record o archivio); nei componenti, nelle parti e nei template anche `props` e `slots`; nei loop la variabile e l'indice. `site`, `user`, `url`, `data` e `facets` non ci sono: un altro nome è un errore del controllo, con riga e colonna.
- **Loop:** su query dichiarate in `content.queries` (`{#loop opere_recenti() as opera, i}`), su liste in `props` o su liste del documento (`{#loop opera.terms.tema as t}`). Nei template d'archivio anche `{#loop main() as opera}`, senza argomenti: i contenuti di quell'archivio (vedi l'argomento `dati`). `posts(…)`, `terms(…)` e `data.*` non ci sono.
- **Argomenti di una query:** solo `limit`, `offset`, `page`, `paged`, `posts_per_page`, `count` e `locale`. Scritti come valori: `limit`, `posts_per_page` e `count` da 1 a 100 (o `-1` per il massimo), `offset` da 0 a 1.000.000, `page` e `paged` da 1 in su, `locale` un tag fra virgolette (`locale: "en-GB"`). Un altro argomento o un altro valore è un errore del controllo.
- **Campi e chiavi:** il controllo segnala una radice sconosciuta, non un campo: `page.inventato` o `opera.fields.inventato` valgono vuoto senza avviso. Negli archivi `page.prevUrl`, `page.nextUrl` e `page.pageLinks` ci sono (vedi l'argomento `dati`); in un template che non fa mai da archivio (ruolo `single`, `page` o `404`, o usato solo da pagine, articoli o record) il controllo avvisa che `page.prevUrl`, `page.nextUrl`, `page.pageLinks`, `page.totalPages` e `page.totalRecords` valgono vuoto. Una chiave con il trattino si legge fra parentesi, `page.terms["tipo-evento"]`: `page.terms.tipo-evento` è una sottrazione e ferma il controllo («Token inatteso "-"»). Vedi l'argomento `dati`.
- **Campi:** scrivi sempre `opera.fields.prezzo`, mai la forma breve `opera.prezzo`.
- **Caso vuoto:** `{:else}` dentro il loop, per ogni sorgente: `{#loop opere_recenti() as opera}…{:else}<p>Nessuna opera.</p>{/loop}`. Quando deve sparire anche ciò che sta attorno al loop (un titolo, un `<ul>`), conta: per le liste in `props` `{#if props.items.length()}…{:else}…{/if}`; nei template d'archivio `{#if page.totalRecords}…{:else}…{/if}` (vedi l'argomento `dati`).
- **Fermano la build**, e il controllo li segnala con documento, riga e colonna: un modificatore sconosciuto (con il nome giusto da scrivere), una lettera di `date()` sconosciuta, una barra singola in `date()`, una data scritta nel file in un'altra forma (`{"7 novembre".date("j F")}`), `number()` con più di 100 decimali, un oggetto stampato intero nel testo o dentro un attributo (`{opera.fields.serie}`: scrivi `{opera.fields.serie.title}`), una `}` da sola (scrivi `\}`), un argomento di query sbagliato.
- **Come valore intero di un attributo** (`title={page}`) o nel testo di una prop, un oggetto si stampa vuoto: non ferma nulla, ma non mostra nulla.
- **Li vede solo la build:** una data che arriva dai dati in un'altra forma (un campo o un valore della pagina che non è una data ISO) e un argomento di query calcolato da un'espressione (`limit: page.title`). Li trovi con l'ultimo controllo con `preview: true` («La versione del sito si ferma: …») o con `hp_build` (`cms-capability-unavailable`).
- **Limiti della build:** al massimo 64 livelli di blocchi uno dentro l'altro, 6 `{#loop}` uno dentro l'altro e 16 componenti uno dentro l'altro, contando il template, le parti e i componenti che la pagina chiama. Oltre, il sito non si costruisce. Il controllo senza `preview` lo dice con un avviso, «Build del sito: page home, riga 5: … 7 {#loop} stanno uno dentro l'altro: la build del sito si ferma oltre 6.», e il progetto si importa. Il controllo con `preview: true` rifiuta il prototipo: «page home, riga 5: La versione del sito si ferma: /: I loop annidati superano il limite di 6.».
- **`src` dinamico:** solo come prop intera di un componente (`src={props.immagine}`). Altrove `src="asset:nome"`.
- **`style="…"`:** solo statico, senza `{…}`.
- **Entità:** sempre con il punto e virgola (`&amp;`, `&nbsp;`).
- **`pattern`:** niente quantificatori `{n}`, perché le graffe sono espressioni. Scrivi `[0-9][0-9][0-9][0-9][0-9]`, non `[0-9]{5}`.
- **`textarea`:** il testo iniziale resta com'è, senza `{…}`, `<` o `&`.

## Errori
Ogni errore di sintassi ha messaggio, riga e colonna. I più comuni: tag non chiuso o chiuso con un altro nome, tag HTML in maiuscolo, attributo duplicato, `{#…}` non chiuso, ramo dopo `{:else}` (in un loop: un secondo `{:else}` o un `{:else if}`), graffa non chiusa, `xb:*` diverso da `xb:label`, `{#slot}` fuori da un componente, chiamata a funzione libera, preset con argomenti senza nome o dentro un'espressione.
- **La variabile del loop nel suo `{:else}`:** nel prototipo il controllo dice «{voce}: nel {:else} di un loop voce non c'è: il ramo si mostra quando il loop non ha elementi.», con riga e colonna. Nel ramo `{:else}` scrivi un testo, o leggi le radici attorno al loop (`page`, `props`).
- **Nel builder:** `set-html` e `insert` escono con codice 2 (errore del builder). Leggi il messaggio, correggi, riprova.
- **In Publish:** `hp_check_prototype` (o `histos-publish prototype check file.html`) dà gli errori insieme, fino a 100, in `issues`: documento, riga e, quando c'è, colonna. Un errore di sintassi ferma la lettura del suo documento, non degli altri: dopo la correzione ricontrolla.
