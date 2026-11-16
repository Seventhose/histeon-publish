---
key: mestiere
title: Il mestiere: come si lavora su un sito esistente, senza «AI slop»
summary: Leggilo subito dopo metodo, prima di toccare un sito esistente: CSS nei selettori e mai nei fogli, JavaScript nel pannello che lo usa e mai negli snippet, migliorare il layout approvato invece di ridisegnarlo, niente aspetto generico da IA.
---

# Il mestiere

Queste regole valgono per ogni sito costruito con Histeon, anche con Etch e ACSS. Ogni regola è nata da un errore già fatto una volta. Valgono nel builder (`xb_*`, `xb/*`), in un prototipo per Histeon Publish (`hp_*`) e su un sito Etch.

## 1. Il CSS sta nei selettori, mai in un foglio

<!-- rapido -->
✅ Ogni blocco ha la sua regola nel **suo selettore**, con parti, stati e `@media` annidati. Nel builder: `set-css` sul selettore. In Etch: lo stile della classe nel pannello del selettore.

❌ Non aggiungere regole a un foglio globale (`style.css`, «CSS aggiuntivo», un foglio `etch-*`, un file caricato dal tema o da uno snippet).

❌ Non scrivere una `@media` fuori dalla regola del blocco, e non ripetere il selettore dentro una `@media`. La `@media` sta **dentro** la regola, come le parti: una `@media` fuori ferma l'import.
```css
/* ✅ */
.concert-card { display: grid; @media (width >= 64em) { grid-template-columns: 1fr 1fr; } }
/* ❌ */
@media (width >= 64em) { .concert-card { grid-template-columns: 1fr 1fr; } }
```
<!-- /rapido -->

Perché:
- un selettore si carica **solo nelle pagine dove la classe c'è**: la pagina pesa meno;
- lo stile **viaggia con il blocco e il componente**: in un altro sito, in un import, in un tema figlio;
- chi apre il blocco vede subito il suo stile, senza cercarlo in un file di mille righe.

I fogli globali tengono solo ciò che è davvero di tutto il sito: le variabili del framework, il reset, la tipografia di base. Se trovi CSS dei blocchi in un foglio globale (succede spesso dopo un'importazione), proponi all'utente di portarlo nei selettori: nel builder «Porta nel selettore» o «Nei selettori…».

Trappole note:
- **Ordine dei fogli.** Non contare sull'ordine in cui la pagina carica selettori, fogli globali e framework: può cambiare da un sito all'altro. Se una regola del blocco deve vincere su una globale o su una del framework, alza la specificità nel selettore (`&.blocco--variante`): non spostarla in fondo a un foglio e non usare `!important`.
- **Specificità invariata.** Se sposti regole in un selettore, avvolgile in modo da non cambiare chi vince (per esempio `:where(&)`), e confronta la pagina prima e dopo.
- **Limite.** Histeon importa al massimo 500 KB di stili per sito. Annida, raggruppa le `@media` consecutive, non ripetere le stesse regole.

## 2. Il JavaScript sta nel pannello che lo usa, mai in uno snippet

<!-- rapido -->
✅ Lo script di un'interfaccia (menu mobile, mini carrello, filtri, slider, lightbox) va **nel pannello script dell'elemento o del componente** che lo usa. Nel builder è lo script dell'elemento o il JavaScript del documento. In Etch è lo script del componente.

❌ Non metterlo in un plugin di snippet (Code Snippets, WPCode, FluentSnippets…), nel `functions.php`, in un `<script>` nel piè di pagina del tema, o in un file caricato su tutte le pagine.
<!-- /rapido -->

Perché è la stessa logica del CSS: lo script si carica dove serve e migra con il componente. Uno snippet separato resta indietro al primo trasloco.

<!-- rapido -->
**Chi scrive lo script.** I connettori di Histeon non scrivono script, e nel prototipo gli script non entrano. Quando serve uno script:
1. scrivi l'HTML che funziona già senza script (`details`, link veri, form veri);
2. prepara lo script per l'utente, breve e commentato;
3. digli **in quale pannello** metterlo: lo script di quale elemento o componente.

<!-- /rapido -->
- **Il PHP lato server** (filtri di WordPress, campi, rotte REST, regole del negozio) resta in un plugin piccolo e dedicato al sito, o in uno snippet PHP. Non è JavaScript di pagina.
- **Uno snippet JS che c'è già:** spostalo nel componente giusto, poi metti lo snippet in bozza. Non cancellarlo: decide l'utente.
- **Il codice si scrive come testo semplice.** Etch e Histeon lo codificano da soli: non fare l'escape a mano.
- **Niente librerie per due righe.** `details`/`summary`, un link vero o un form vero bastano quasi sempre. Niente jQuery nuovo.

## 3. Ciò che si ripete è un componente

Testata, piè di pagina, schede di prodotto, blocchi delle pagine legali, avvisi: sono **componenti**, con le loro proprietà. Prima di crearne uno, cerca se c'è già (`components` nel builder, i componenti di Etch). Se ne trovi due quasi uguali, proponi di unirli.

## 4. Niente «AI slop»

«AI slop» è il lavoro che si riconosce subito come fatto da un'IA: generico, gonfio, uguale a mille altri, con contenuti inventati. L'utente lo rifiuta. Queste sono le regole per evitarlo.

<!-- rapido -->
### Il layout approvato si migliora, non si rifà
- Se il sito ha già un aspetto approvato dal cliente, **ogni proposta lo migliora**: stessa testata, stesse fasce, stessi font e colori, stesse sezioni. Un ridisegno da zero non è richiesto, salvo che l'utente lo dica in parole chiare.
- Prima di disegnare, **studia il sito com'è**: colori e variabili del framework, font, componenti, menu, pagine. La prima versione deve riprodurlo fedelmente. Le altre cambiano solo punti precisi, e dicono quali.

### I contenuti sono veri
- Testi presi dal sito o dati dall'utente. **Mai** lorem ipsum, mai testi di riempimento («Benvenuti nel nostro sito», «La nostra missione è…»).
- **Mai inventare** numeri, recensioni, testimonianze, premi, clienti, date, prezzi, indirizzi, orari. Se un dato manca, lascia un segnaposto evidente («[testo da scrivere]») e dillo all'utente.
- Immagini dalla libreria del sito. Niente immagini generiche al posto di quelle vere.

### L'aspetto è del sito, non dell'IA
❌ Da non fare, salvo che l'utente lo chieda:
- sfumature viola e blu, vetro smerigliato, bagliori, ombre grandi su tutto;
- emoji al posto delle icone;
- la sequenza fissa «grande titolo con pulsante → tre schede uguali con icona → testimonianze → pulsante finale»;
- tutto centrato, tutto arrotondato, ogni sezione in una scheda;
- animazioni che non servono a capire qualcosa;
- testi piccoli e grigio chiaro su bianco.

✅ Da fare:
- i valori **solo dalle variabili** del framework del sito (`brief`): spazi, colori, testi, raggi. Nessun `17px` o `#3a7bd5` inventato;
- **testi mai piccoli**: corpo almeno 16px (meglio 18px), mai sotto 15px, con contrasto sufficiente;
- gerarchia data dal contenuto: un `h1`, titoli in ordine, frasi brevi;
- lo stesso ritmo di spazi del resto del sito.
<!-- /rapido -->

### Prima di dire «fatto», guarda
- Apri l'anteprima a **390 px** e su desktop: niente scorrimento orizzontale, niente sovrapposizioni.
- Controlla l'accessibilità (argomento `accessibilita`) e la lista di `controllo`.
- Confronta con la pagina di prima: deve essere uguale dove non hai lavorato.

## 5. Su un sito esistente si lavora così

1. **Copia prima di ogni cambio.** Prima di toccare un sito l'utente deve avere una copia del database e dei file. Se lavori tu con gli strumenti, controlla che la copia esista e non sia vuota prima del passo dopo.
2. **Tutto in sviluppo.** Le modifiche vanno in sviluppo. Non pubblicare mai tutto in una volta: la release la fa l'utente, quando ha guardato.
3. **A piccoli passi.** Una modifica, un controllo. Non mettere dieci cambi in un solo salvataggio.
4. **Dopo un salvataggio verifica il risultato, non il tempo.** Un salvataggio lento non è per forza fallito: rileggi il documento (o la data di modifica) prima di ripetere.
5. **Usa i plugin che il sito ha già:** i form con il plugin di form del sito, i cookie con il suo plugin dei consensi, le lingue con Lingua Bridge, la copia statica con Static Bridge. Non installare plugin nuovi senza chiederlo.
6. **Dopo un cambio di CSS su un sito con Static Bridge** le pagine statiche vanno rigenerate: dillo all'utente (una esportazione completa, che lancia lui).
7. **Niente licenze né credenziali.** Non leggi e non scrivi chiavi, password, codici di licenza.

## In una riga

Stile nei selettori, script nei componenti, contenuti veri, valori dalle variabili, il layout del cliente migliorato e non rifatto, e un controllo vero prima di dire «fatto».
