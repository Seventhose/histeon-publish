---
key: core-framework
title: Core Framework in Histeon
summary: Leggilo quando il brief dice che il sito usa Core Framework, o quando un progetto di Histeon Publish deve usare un preset o il CSS di Core.
---

# Core Framework in Histeon

Core Framework è un framework CSS di terze parti. Histeon non lo include: se il proprietario del sito lo ha installato e scelto, Histeon ne legge le variabili e le classi.

## L'essenziale

1. **Nel builder (connettore xb)** leggi prima `brief` (`xb_getBrief`) e `framework` (`xb_getFramework`): i nomi di Core di questo sito sono lì. Usa i nomi esatti.
2. **Builder:** valori dalle variabili di Core: `var(--space-m)`, `var(--text-l)`, `var(--primary)`, `var(--bg-surface)`. Mai numeri inventati.
3. **Builder:** nei componenti usa i token `--xb-*` che il brief elenca: Histeon li collega alle variabili di Core.
4. Le classi utility di Core solo per un'eccezione puntuale. Lo stile sta nel blocco BEM.
5. **In Histeon Publish (prototipo, connettore hp):** scrivi con i token `--xb-*`, mai con i nomi di Core. Core non è un `framework` del prototipo e Publish non traduce i suoi nomi.
6. Preset, CSS di Core e cambio di framework li gestisce l'utente, non tu.

✅ Giusto (builder, sito con Core; nomi d'esempio: usa quelli del brief):
```css
display: grid;
gap: var(--space-s);
padding: var(--space-m);
border-radius: var(--radius-m);
background: var(--bg-surface);
&__title { font-size: var(--text-l); color: var(--text-title); }
&__meta { color: var(--text-body); font-size: var(--text-s); }
&--featured { background: var(--primary-l-2); }
@media (--tablet) { padding: var(--space-s); }
```

❌ Sbagliato:
```html
<!-- catena di utility al posto di un blocco con il suo stile -->
<div class="p-4 flex gap-2 text-xl bg-primary">…</div>
```
```css
padding: 23px;          /* valore inventato: var(--space-m) */
background: #f4f4f4;    /* colore inventato: una variabile di colore del brief */
```

## Nel builder (connettore xb)

### Come Histeon legge Core
- Il framework si sceglie in **Impostazioni → Histeon**. Lo sceglie l'utente.
- Variabili e classi arrivano da Core raggruppate per categoria. Il `brief` mostra le variabili per gruppo e solo il numero delle classi; `framework` elenca anche le classi.
- Restano **vuote finché non si salva un preset nell'app di Core**. Se il brief non mostra variabili di Core, dillo all'utente invece di inventare nomi.
- Histeon usa il foglio che Core genera nel sito (`uploads/core-framework/css/core_framework.css`).
- Se Core non è più installato, Histeon torna a Histeon CSS invece di rompere il sito.

### I token `--xb-*` con Core
Histeon stampa gli alias `:root{--xb-space-m:var(--space-m);…}`, solo per le variabili che esistono davvero in Core. Le corrispondenze principali:

| Token Histeon | Core Framework |
|---|---|
| `--xb-space-xs` … `--xb-space-xxl` | `--space-xs` … `--space-2xl` |
| `--xb-text-s` … `--xb-text-xxl` | `--text-s` … `--text-2xl` |
| `--xb-primary`, `--xb-primary-light`, `--xb-primary-dark` | `--primary`, `--primary-l-2`, `--primary-d-2` |
| `--xb-bg`, `--xb-surface`, `--xb-text`, `--xb-heading` | `--bg-body`, `--bg-surface`, `--text-body`, `--text-title` |
| `--xb-radius-s/m/l` | `--radius-s/m/l` |
| `--xb-shadow-s/m/l` | `--shadow-s/m/l` |

- Un componente scritto con `--xb-*` funziona senza modifiche con qualsiasi framework.
- Usa solo i token che il brief elenca come disponibili.

### Cosa fa l'utente, non tu
- **Valori e preset:** si cambiano nell'app di Core. Nel builder si apre con il pulsante «CF» nella barra a sinistra. Chiudendo il pannello, o con «↻ Applica all'anteprima», Histeon ricarica variabili, classi e fogli.
- **Cambio di framework:** **Impostazioni → Histeon → Cambio di framework con migrazione**. Prima l'anteprima, poi «Prepara in sviluppo», poi la release. Con i token `--xb-*` non serve fare nulla.
- **Da Core a un altro framework:** le variabili si riscrivono attraverso lo stesso token `--xb-*` (per esempio `--space-2xl` ↔ `--space-xxl` di ACSS). Una classe si rinomina con la convenzione `a--b` ↔ `a-b` (`bg-light` ↔ `bg--light`), solo se esiste davvero nel framework di destinazione.
- **Da Core a Histeon CSS:**
  - le variabili di Core, con i loro valori, vanno in un foglio globale di Histeon (`carry-<framework>`);
  - i token `--xb-*` prendono i valori di Core, per esempio `--xb-space-m: var(--space-m)`;
  - i nomi che hanno un token diventano token; gli altri restano e valgono ancora, perché il foglio portato con sé li definisce;
  - le regole che il sito usa vanno nel foglio di compatibilità.

  Da Core vale solo la mappa dei token: Histeon ha la tabella completa dei nomi solo per Automatic.css (vedi l'argomento `acss`).
- **Da Automatic.css a Core, tutto compreso:** Histeon crea un nuovo progetto di Core con i colori di ACSS e il foglio «Automatic.css — variabili». Le regole di ACSS che il sito usa vanno in un foglio di compatibilità; le ricette di ACSS diventano completamenti dell'editor CSS. Nessuno dei due plugin viene modificato. Dopo:
  1. in Core, aprire **Stylesheets** e premere **Save changes**;
  2. in Histeon passare a Core con «Prepara in sviluppo» e pubblicare;
  3. disattivare Automatic.css.

**Per te:** dopo una migrazione trovi nel sito nomi del framework di prima che valgono ancora. Lasciali come sono. `save` salva solo in sviluppo; la release la fa l'utente.

## In Histeon Publish (prototipo, connettore hp)

### Nel prototipo
- Core Framework **non** è un `framework` del prototipo. I valori possibili sono `histos-css`, `acss` e `none`.
- Scrivi il prototipo con `"framework": "histos-css"` e i token `--xb-*`. Valgono anche quando il sito WordPress usa Core Framework, perché Histeon li collega alle sue variabili.
- Publish non traduce i nomi di Core: non c'è una tabella come quella di ACSS.
- Il CSS di Core si aggiunge **dopo l'import**, dal pannello CSS del progetto. Lo fa l'utente.

```css
/* ❌ nomi di Core nel prototipo: nessun foglio li definisce, il controllo li segnala */
.hero { padding: var(--space-2xl); background: var(--primary-l-2); }
/* ✅ token Histeon CSS */
.hero { padding: var(--xb-space-2xl); background: var(--xb-primary-light); }
```

### Preset e CSS di Core in Histeon Publish (li importa l'utente)
- **Da Core:** **Download CSS file** scarica il foglio, **Export** il preset. Il file `.core` da solo può non contenere il CSS finale.
- **In Histeon CMS:** pannello CSS → **Importa CSS** → il file `.core` o `.json`, e se serve anche il `.css` scaricato da Core, in qualsiasi ordine. L'utente conferma il diritto d'uso e salva il progetto.
- **Preset 1.1.0:** con `app_version` `1.1.0` Publish prova a generare il CSS senza rete. Con versioni diverse o dati non riconosciuti la generazione si ferma; il preset resta, e si può aggiungere il CSS esportato da Core.
- **Precedenza:** un CSS separato scelto dall'utente vince sul CSS incorporato nel preset o generato.
- **Output esatto:** Publish non genera tutte le opzioni del preset: per lo stesso CSS di Core serve il `.css` esportato da Core.
- **Il preset:** resta nel progetto, non va nella cartella pubblica del sito e non diventa token Histeon. Publish non ha un editor dei parametri di Core: dopo una modifica in Core si riesporta il CSS e lo si reimporta.
- **Foglio vuoto:** se il progetto ha una sorgente Core ma il foglio CSS è vuoto, la build dà un avviso non bloccante. Senza quel foglio gli stili di Core non ci sono nel sito.

### Cosa fai tu
- Il connettore hp non importa preset né CSS: se servono, chiedilo all'utente con i passi qui sopra.
- Dopo `hp_build` leggi gli avvisi. Se dicono che il foglio di Core è vuoto, dillo all'utente.
- Con `hp_build_file` leggi il CSS prodotto e controlla che le variabili che usi esistano.
- L'invio a WordPress (`hp_wordpress_push`) va solo in sviluppo e solo se l'utente lo chiede. Pubblicare resta dell'utente.
