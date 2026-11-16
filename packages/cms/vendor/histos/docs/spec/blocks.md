# Specifica dei blocchi Histeon — v0.1

Schema normativo: `packages/spec/schemas/blocks.schema.json`.
Implementazione di riferimento: `packages/dsl/src/tree.ts` e `packages/dsl/src/wp.ts`.

## 1. Principi

1. **Gutenberg è il formato di storage, non l'interfaccia.** Le pagine sono grammatica a blocchi standard in `post_content`, quindi `parse_blocks()`, REST, revisioni, export WXR e plugin SEO funzionano senza adattatori.
2. **Tutti i blocchi Histeon sono dinamici**: il rendering lo fa PHP (`render_callback`) e il contenuto statico salvato è vuoto. Niente "Questo blocco contiene contenuto inatteso" nell'editor.
3. **Pochi blocchi generici** invece di un blocco per ogni widget. L'HTML è descritto da `xb/element` (tag + attributi); la logica da `xb/if`, `xb/loop`, `xb/component`.
4. **Ogni nodo ha un `uid` stabile.** Serve a diff, merge a tre vie (versioning), selezione nell'editor, operazioni AI e mappa delle dipendenze per l'export statico.
5. **Blocchi esterni ammessi** tramite `xb/passthrough`, così i template dei temi FSE e i blocchi core restano utilizzabili.

## 2. Regole comuni

| Regola | Valore |
|---|---|
| Namespace | `xb/` |
| `uid` | obbligatorio, `^[a-z0-9]{8,16}$`, unico nel documento. Generato casualmente (10 caratteri base36). |
| Ordine delle chiavi | canonico, come nelle tabelle sotto. Garantisce serializzazioni identiche e diff puliti. |
| Mappe vuote e valori assenti | **omessi** (PHP trasformerebbe `{}` in `[]` al salvataggio) |
| Serializzazione | `<!-- wp:xb/nome {json} -->figli<!-- /wp:xb/nome -->`, oppure `<!-- wp:xb/nome {json} /-->` se non ci sono figli. Escape degli attributi identico a `serialize_block_attributes()` (`--`, `<`, `>`, `&`, `\"`). Nessun separatore tra blocchi. |
| HTML statico dentro un blocco Histeon | non ammesso; se presente viene ignorato con un avviso |
| Default nei `block.json` | **nessuno**. Al salvataggio Gutenberg elimina gli attributi uguali al default, e la forma salvata non sarebbe più canonica. Verificato con `"tag":"div"`. I valori di ripiego li applica il renderer. |
| Spazi tra i blocchi | Gutenberg salva un a capo tra i blocchi; Histeon lo ignora sia in lettura sia nel rendering |

### Riparazione in lettura (`parseXb`)
Il contenuto può essere modificato fuori da Histeon (Gutenberg, REST, import). Quando Histeon lo legge:
- un `uid` mancante, non valido o duplicato viene sostituito, con un avviso;
- un blocco non Histeon figlio di un blocco Histeon viene avvolto in `xb/passthrough`;
- l'HTML libero fuori dai blocchi diventa `xb/raw`;
- un figlio non ammesso (es. un `xb/element` dentro `xb/if`) viene rimosso, con un avviso;
- un blocco `xb/*` sconosciuto (versione futura) viene conservato come passthrough.

Gli avvisi tornano all'editor e al versioning, così una riparazione non passa in silenzio.

## 3. Blocchi

### `xb/element` — un elemento HTML o SVG
| Attributo | Tipo | Note |
|---|---|---|
| `uid` | string | |
| `tag` | string | `^[a-z][a-zA-Z0-9]*(-[a-zA-Z0-9]+)*$`. La prima lettera è minuscola; la maiuscola interna serve all'SVG (`linearGradient`). |
| `label` | string? | Nome nel pannello Struttura (max 80, niente `{`) |
| `attributes` | object? | Nome → `string` oppure `true` (attributo booleano). Ordine conservato. Nomi `^[a-zA-Z_:@][a-zA-Z0-9_:.@-]*$`, mai `xb:*`. I valori possono contenere interpolazioni `{…}`. |

- Figli: qualsiasi blocco Histeon, tranne `xb/branch` e `xb/slot-fill`. Gli elementi void (`img`, `br`, `input`, …) non hanno figli.
- `script`, `style` e `textarea` hanno al massimo un figlio `xb/text` con `verbatim: true`.
- Ammissibilità di tag e attributi per livello di permesso (chi ha `unfiltered_html` e chi no): è applicata **al salvataggio**.
- Rendering: le interpolazioni nei valori vengono risolte ed escapate per contesto (`esc_attr`, `esc_url` per gli attributi URL).

### `xb/text` — testo con formattazione inline
| Attributo | Tipo | Note |
|---|---|---|
| `content` | string | Non vuota. Testo + sottoinsieme di markup inline (`strong`, `em`, `a[href,target,rel]`, …: `dsl.md` §3.4) + interpolazioni `{…}` + escape `\{` `\}`. Le entità HTML restano come scritte. |
| `verbatim` | `true`? | Solo dentro `script`, `style`, `textarea`: nessuna interpolazione, nessun filtro inline |

È il blocco che il cliente modifica in Gutenberg (RichText, modalità `contentOnly`).

**In Gutenberg, ciò che solo il server sa disegnare** (loop, componenti, HTML grezzo, contenuto del post, un testo con espressioni finché non è selezionato) arriva da `POST /xb/v1/editor-render` e passa da `clean()` di `plugin/assets/editor/blocks.js`: l'HTML si legge una volta sola, in un documento che non esegue nulla, e i nodi ammessi si ricostruiscono uno per uno nel documento del riquadro (`createElementNS`, `createTextNode`), senza riscriverli come HTML e rileggerli (niente `innerHTML` né `dangerouslySetInnerHTML`). Una lista chiusa decide cosa passa:
- **elementi:** gli elementi HTML di contenuto (anche `style`, `form` e i vecchi `center`, `font`, `marquee`…), gli elementi personalizzati con il trattino, SVG statico (forme, testo, gradienti, maschere, filtri, `use`, `image`, `foreignObject`), MathML. Restano fuori, con ciò che contengono, `script` (anche in SVG), `base`, `meta`, `link`, `noscript`, `noembed`, `noframes`, `frame`, `frameset`, `portal`, `template`, `title`; `iframe`, `object` ed `embed` diventano un riquadro vuoto con classi, misure e stile (`xb-editor-embed`). Un elemento fuori dalla lista (un tag sconosciuto, le animazioni SVG `set`/`animate*`, che potrebbero cambiare un indirizzo) lascia passare solo ciò che contiene;
- **attributi:** quelli HTML, SVG e MathML con un effetto visibile o di accessibilità, `data-*` (non le grafie dei framework `data-hx-`, `data-ng-`, `data-on-`, `data-bind`) e `aria-*`, sempre dopo il filtro di prima (niente `on*`, `srcdoc`, `autofocus`, URL `javascript:`/`vbscript:`/`data:` non immagine). Restano fuori `contenteditable`, `draggable`, `nonce`, `integrity`, `is`, e `name` su `img` e `form`, che oscurerebbe le proprietà del documento del riquadro.
Il risultato visibile è quello di prima (le prove `gutenberg-*` lo confermano); cambia solo che un SVG animato si vede fermo. La prova è `e2e/specs/gutenberg-clean.spec.ts`, che sostituisce le risposte del server con markup ostile, mutazioni MathML comprese.

### `xb/if` + `xb/branch` — condizioni
- `xb/if`: solo `uid`. Figli: uno o più `xb/branch`.
- `xb/branch`: `test` (espressione) opzionale. Il primo ramo ha sempre `test`; un ramo senza `test` è l'`else` e deve essere l'ultimo.
- Viene renderizzato il primo ramo il cui `test` è vero (truthiness: `dsl.md` §4.3).

**Testo.** Nel testo scritto in Histeon gli apici `'` e `"` vengono stampati come entità (`&#039;`, `&quot;`): il risultato è identico, e `wptexturize` di WordPress li lascia come scritti.

### `xb/loop` — ripetizione
| Attributo | Tipo | Note |
|---|---|---|
| `source` | `{kind:"preset", id, args?, groupBy?}` oppure `{kind:"expr", expr}` | Un preset è una query predefinita (`posts`, `terms`, `main`) o definita da un utente con il permesso `xb_build`. Gli `args` sono espressioni. `groupBy` (`{field, how?}`, testi; DSL `foto().groupBy("anno")`) raggruppa il risultato della query: ogni elemento del loop è un gruppo `{key, items}`, come quelli del modificatore `groupBy` (`dsl.md` §4.4), da una sola query. `expr` itera un array, ad esempio `props.items` o `[1,2,3]`. |
| `as` | identificatore | Nome dell'elemento corrente |
| `index` | identificatore? | Indice, a partire da 0 |

Le query del preset vengono eseguite con i permessi di chi visita la pagina: un anonimo vede solo contenuti pubblicati.

**Limiti.** Al massimo 6 loop annidati e 1.000 elementi per loop (in un loop a gruppi, 1.000 gruppi; `groupBy` legge i primi 2.000 contenuti della query). Oltre i 1.000 elementi WordPress mostra i primi 1.000 e, a chi costruisce con il debug attivo, un avviso nel sorgente; la build statica di Histeon CMS invece rifiuta la pagina, perché non pubblica in silenzio una resa incompleta.

**Preset personalizzati.** Si salvano nell'opzione `xb_loop_presets` come `{id: {type, args}}`:
- `type` è `posts`, `terms` oppure `main`, cioè la query principale della pagina con `posts_per_page`, `offset`, `order` e `orderby` sostituiti;
- negli `args`, `"$nome"` prende l'argomento del loop e `"$nome ?? default"` ha un valore predefinito;
- in un preset `posts`, gli argomenti `limit` e `offset` del loop valgono anche quando `posts_per_page` e `offset` sono numeri fissi, come in Histeon Publish dove ogni query li accetta: un parametro proprio del preset (`"$quanti ?? 6"`) vince su `limit` quando il loop lo passa, `offset` vince sempre. Le query importate da Publish si salvano già come `"$limit ?? N"` e `"$offset ?? N"`;
- `posts_per_page: -1` vale il massimo ammesso (100).

**Tipi di contenuto ammessi.** Con un solo tipo, la query lo riceve come stringa, come fa WordPress. I tipi ammessi sono quelli visibili pubblicamente, più quelli elencati da un amministratore in `xb_loop_types` (filtro `xb_loop_post_types`). I tipi interni di WordPress e i messaggi dei form non sono mai ammessi. Un loop di termini elenca le tassonomie pubbliche, più quelle elencate da un amministratore in `xb_loop_taxonomies` (filtro `xb_loop_taxonomies`); quelle interne di WordPress (menu, formati, temi, aree e categorie dei pattern) mai.

### `xb/component` — istanza di un componente
| Attributo | Tipo | Note |
|---|---|---|
| `ref` | string | **Chiave stabile** `nome` o `namespace/nome` (kebab-case, ogni segmento inizia con una lettera). Non un ID di post: sopravvive a export, import e migrazioni. |
| `label` | string? | |
| `props` | object? | Nome (identificatore) → valore JSON letterale, `{"expr": "…"}` oppure `{"tpl": "testo con {interp}"}` |

- Figli: solo `xb/slot-fill`, uno per nome.
- **Definizione del componente**: un post `wp_block` con meta `xb_component_key` (= `ref`, univoco) e `xb_component_schema` (props tipizzate: `string`, `number`, `boolean`, `url`, `image`, `rich-text`, `enum`, `array`, `object`; con default). Il corpo è un albero Histeon che usa `xb/slot` per i punti di inserimento.

**Blocchi per chi scrive (`articolo/…`).** Sono componenti come gli altri, definiti in `plugin/assets/framework/article-components.json` (generato da `scripts/build-article-components.mjs`, scritti nel linguaggio di Histeon). Il plugin li rende sempre disponibili con il filtro `xb_component_definition`: `Content\ArticleBlocks` non scrive nulla finché uno non viene usato, e al primo uso in Gutenberg la definizione entra nel sito come componente, così viaggia. Un componente salvato con la stessa chiave ha la precedenza. In Gutenberg sono modelli (categoria «Histeon · Per chi scrive»). Gli stili sono le classi `xb-art-*` di `histos.css`. I blocchi a righe (galleria, domande e risposte, cronologia…) hanno un'istanza per riga nello slot `default`, indicata da `rows`: ogni riga ha i suoi testi e le sue traduzioni.

**Blocchi di Gutenberg in un articolo che viaggia.** All'esportazione verso Publish, `ArticleBlocks::from_core()` trasforma paragrafi, titoli, elenchi, citazioni, immagini e separatori in elementi Histeon. Tutto il resto (incorporamenti, blocchi di altri plugin) viaggia intero in `xb/passthrough`: in Publish è un blocco protetto, il sito statico lo stampa ripulito, e all'importazione in WordPress è accettato solo se identico a uno già presente in quell'articolo (`assert_foreign_known`), perché un blocco gira con i diritti del sito. Vale solo per i documenti, non per componenti e template.

**In Gutenberg** un'istanza si vede come sul sito e si seleziona; le sue props letterali si cambiano nel pannello laterale, generato dallo schema (`GET /xb/v1/component-schema`); una prop calcolata da un'espressione si cambia in Histeon.

### `xb/slot` — punto di inserimento (nella definizione)
`name` (`^[a-z][a-zA-Z0-9_-]*$`, default `default`). Nessun figlio.

### `xb/slot-fill` — contenuto per uno slot (nell'istanza)
`name`, figli liberi. Uno slot senza riempimento non renderizza nulla, e `slots.<nome>.empty` è disponibile nelle espressioni della definizione.

### `xb/raw` — HTML grezzo
`content`: string (mai `{/raw}`). Nessuna interpolazione. Per chi non ha `unfiltered_html` passa da `wp_kses_post` al salvataggio.

### `xb/passthrough` — blocco esterno
Nessun attributo oltre `uid`. Contiene **esattamente un** blocco non Histeon (core o di terze parti), conservato in forma serializzata canonica.

**Shortcode.** WordPress esegue gli shortcode sul contenuto (`the_content`) e sul markup di un template a blocchi prima di disegnarne i blocchi, mai su un blocco da solo. Un componente si disegna dopo entrambi: dentro un componente e fuori dal contenuto (un piede con un modulo, in un template) Histeon passa a `do_shortcode()` ciò che disegna un blocco `core/shortcode` o `core/html`, anche annidato. Nel contenuto non lo fa, perché lo fa `the_content` subito dopo: ogni shortcode si esegue una volta.

### `xb/post-content` — contenuto del post corrente
Solo `uid`. Si usa nei template FSE: equivale a `core/post-content`, ma renderizza Histeon senza wrapper aggiuntivi.

## 4. Fuori dai blocchi (riferimenti)

| Cosa | Dove vive | Spec |
|---|---|---|
| Stili (selettori, CSS) | Registro stili Histeon, collegato agli elementi tramite le classi | `styles.md` |
| JS per componente o pagina | Entità `xb_script`, solo `unfiltered_html` | — |
| Preset di loop | Predefiniti `posts`, `terms` e `main` (la query principale); preset personalizzati nell'opzione `xb_loop_presets` (`plugin/src/Render/LoopPresets.php`) | questo file, §3 |
| Token del framework | Framework Provider | `framework.md` |

## 5. Versioni della spec
L'attributo `uid` e le chiavi definite qui sono stabili da v0.1. Le aggiunte saranno solo opzionali. Una modifica incompatibile alza la versione e richiede una migrazione registrata dal versioning Histeon.
