# Changelog

Le modifiche sono elencate per versione. Le build locali non sono pubblicate su un repository di release.

## 1.39.1 — 2026-11-16

- **L'editor di Histeon 0.5.15.** La copia del builder dentro Publish è quella di Histeon 0.5.15. Nel pannello CSS la striscia di pulsanti rapidi della Mini GUI si chiama «Stile compatto» (prima «Stile Etch»): chi l'aveva scelta la ritrova scelta. Nel pannello delle ricette gli altri nomi con cui si chiama una ricetta (scritti con `?`) sono i «nomi alternativi», e la ricerca li trova.
- **Lo User-Agent del crawler.** Le richieste del rilevamento e della lettura di un sito online si presentano come `HistosPublish/0.1.0 (+https://github.com/Seventhose/histeon-publish)`, cioè rimandano alla pagina del progetto.
- **Manuali per gli agenti e kit minimo riletti.** Gli esempi di `hp_docs`, `hp_manual` e del kit minimo usano nomi, colori, indirizzi e domini inventati (`example.org`, `sito.example`). I testi su Etch, ACSS e Core Framework dicono che cosa fa l'importazione; i moduli su WP rimandano al plugin di moduli del sito.
- **Aggiornamenti dalle release pubbliche.** L'app si aggiorna dalle release pubbliche di `Seventhose/histeon-publish`, senza token: la scheda Aggiornamenti non chiede più il token di GitHub e chi l'aveva messo non deve fare niente (l'app non lo usa più e lo toglie dal portachiavi). L'AppImage nuova si installa sempre solo con la firma valida.
- **Script di rilascio.** La cartella dei rilasci e il comando di firma si leggono dalle variabili d'ambiente `HISTOS_RILASCI` e `HISTOS_SIGN_COMMAND`, senza percorsi della macchina di sviluppo.
- **Copia pubblica dei sorgenti.** `scripts/public-export.sh` prepara la copia pubblica: lascia fuori i percorsi di `.public-exclude` e cerca segreti con `scripts/secret-scan.sh` prima di consegnarla. Ogni release di Publish porta AppImage firmata, `.deb`, `SHA256SUMS` e l'archivio dei sorgenti `histeon-publish-<versione>-sorgenti.tar.gz`.

## 1.39.0 — 2026-11-16

- **L'editor di Histeon 0.5.14.** La copia del builder dentro Publish è quella di Histeon 0.5.14. Nel pannello Histeon CSS ci sono «Importa i token (DTCG)», che legge i file esportati da Figma e da Penpot, ed «Esporta i token (DTCG)», che scrive `tokens.chiaro.json` e, con il tema scuro acceso, `tokens.scuro.json`. Nel Design system, «Importa variabili» aggiunge molte variabili del sito da un file. Nei selettori, una parte BEM seguita da una regola del blocco con lo stesso peso resta nel foglio, così la cascata non cambia (per esempio la voce corrente di un menu tiene il suo fondo). Ciò che in Histeon riguarda le release di WP (release programmata, durata del link di anteprima) in Publish non compare, perché un sito di Publish esce con una build.
- **Video e mappe che un plugin del consenso può trattenere.** Nei siti costruiti, prima di caricare il lettore di un video o una mappa parte l'evento `xb:incorpora`, che si può annullare: chi lo annulla carica il contenuto più tardi con `detail.carica()`. Senza nessuno in ascolto tutto resta come prima.
- **Un sito WP con Histeon più vecchio.** Publish conosce Histeon 0.5.14: l'avviso sul collegamento elenca anche i disegni SVG con testo e sfumature fra le cose che un sito più vecchio non riceve.
- **Controllo severo del prototipo.** `prototype check --severo`, `prototype verify --severo` e `strict: true` di `hp_check_prototype` danno un elenco di problemi, ognuno con regola, livello, documento, riga, messaggio e rimedio. Sono errori una classe non BEM, una classe di utilità, uno stile in linea, un testo segnaposto, schede scritte a mano, un loop senza `else`, un campo che non esiste e ogni avviso del controllo che chiede una correzione. Sono avvisi un valore fisso, un testo ancora da scrivere e una classe senza regola. La riga di comando esce con 1 quando il controllo severo non passa. Senza `--severo` non cambia nulla.
- **Ricette per gli agenti.** `hp_docs` ha sette ricette brevi (scrivere, importare, aggiornare, inviare a WP, tradurre, correggere, partire da un design), ognuna di al più 500 parole e con le stesse quattro sezioni. Un modello piccolo legge l'argomento `rapido` e poi solo la ricetta del lavoro. In una ricetta ogni testo che manca è scritto «[testo da scrivere]», sempre uguale, così il controllo severo lo trova.
- **Proposte fotografate: le misure restano quelle.** Una proposta scritta in px, importata, tiene le sue misure: la dimensione dei testi e gli spazi scritti a mano diventano variabili del sito (`--xb-site-testo-17`, `--xb-site-spazio-14`) con il valore di partenza, invece di passare ai gradini fluidi. Una misura già scritta con una variabile resta com'è. Per cartelle, ZIP e pagine HTML la stessa cosa si sceglie con la casella «Valori esatti» del dialogo di controllo, spenta in partenza.
- **Proposte fotografate: schede e menu da telefono.** Una proposta fotografata non ha più i suoi script. Le schede scritte con `aria-selected` e `hidden` e il pulsante del menu tornano a funzionare con i comportamenti di Histeon, senza spostare nessun elemento. Schede con lo stato scritto in una classe diventano schede di Histeon solo nel caso certo. Ciò che non si riconosce resta com'è, e il rapporto lo elenca in un gruppo «da rifare» insieme a pulsanti, campi, moduli e link che aspettavano uno script.
- **Conversione più fedele.** `<wbr>` e `<kbd>` restano nei testi: prima un indirizzo lungo si spezzava dentro una parola. Un `fill` o uno `stroke` scritto `var(--nome, ripiego)` non viene più tolto. Un nome dato dalla conversione a un elemento senza classe non prende più una classe che il CSS del sito usa già. La cattura di una proposta avvisa quando una variabile è scritta su `<html>` o `<body>` e quindi manca al sito costruito.
- Il manifest del prototipo ha il campo `siteTokens` (variabili del sito), descritto nel manuale. Il link d'esempio del manuale e del kit minimo porta a `example.org`.
- La matrice dell'API dell'editor sta ora in `docs/spec/matrice-api-builder.md`.
- Prove: il server locale restituisce i token del tema chiaro e scuro; il controllo severo sui kit e su prototipi sbagliati apposta; le sette ricette contro gli strumenti e gli argomenti che nominano; `<wbr>` e `<kbd>` fino al formato di trasferimento; le variabili del sito di una conversione esatta inviate a un WP di prova e riportate indietro uguali.

## 1.38.1 — 2026-11-14

- **Un file di design rilasciato sulla scheda.** In «Nuovo sito», un file `.penpot` o `.fig` rilasciato sulla scheda «Da Penpot o Figma» viene letto come uno scelto col pulsante. Prima lo prendeva solo la zona di rilascio della schermata, e sulla scheda non succedeva nulla. Più file insieme o un file di un altro tipo sono rifiutati con il motivo.
- **I livelli del riquadro e quelli scritti.** L'elenco dei riquadri conta ogni livello del file, anche quelli nascosti o vuoti, mentre il rapporto contava solo quelli scritti nel prototipo: i due numeri potevano non coincidere. Ora la prima riga del rapporto li dice tutti e due, per esempio «143 livelli nel riquadro, 140 nel prototipo», con il motivo.
- **«1 modello» e «1 voce».** Nel riepilogo del controllo di un prototipo, un solo modello e una sola voce sono scritti al singolare (prima «1 modelli» e «1 voci»).

## 1.38.0 — 2026-11-14

- **Rifinisci i nomi con un modello.** Il convertitore HTML ora registra come scelte i nomi che inventa: classi BEM nuove, componenti, campi, tipi di contenuto e testi alternativi vuoti. Ogni scelta ha un contesto breve e un identificativo stabile, e si può accettare o lasciare. Con «Rifinisci i nomi» nella finestra di controllo compare la tabella prima e dopo, con una casella per riga, «Applica tutte» e «Torna ai nomi del convertitore». La rifinitura usa Claude dal connettore come predefinito; in alternativa ci sono un modello locale o Claude Haiku 5.5 con la chiave API. Nella prova sul corpus i nomi migliorano con Haiku; con i modelli locali provati non migliorano. Da riga di comando: `histos-publish prototype rifinisci <cartella|zip|html>`, con `--fornitore=locale|haiku`, `--struttura`, `--scrivi` e `-o`. Senza risposte il prototipo resta identico. Corretto anche il tipo `product` dato a un elenco, che faceva fallire l'importazione.
- **Stili del body, dell'html e del font.** Una classe che il `<body>` ha solo in alcune pagine non si perde più con le sue regole: la regola sceglie la pagina e la classe passa al `<main>` di quelle pagine. Le regole scritte sulle classi comuni a ogni pagina restano, riscritte su `body` e `html`, e la pulizia non le toglie più come morte. Il carattere del tema diventa il token dei caratteri solo se il design lo porta: prima una pagina poteva mostrare il carattere di Histeon CSS. Il numero degli elementi selezionabili non supera più il totale.
- **Controllo del sito costruito con regole più giuste.** Un'immagine con `alt=""` è decorativa e non viene più segnalata: conta solo la presenza dell'attributo `alt`, mentre `data-alt` e `title` non contano. Il controllo legge anche titolo, lingua, `noindex`, presenza nella sitemap e peso delle pagine, e segnala le cinque pagine più pesanti oltre 1,5 MiB. Non segnala ciò che la build fa apposta, come le pagine 404, i vecchi indirizzi e la pagina di ricerca.
- **«Pronto per andare online?» in un solo rapporto.** Il controllo dà un verdetto (pronto, da guardare, non pronto) con le sezioni Collegamenti, Immagini, Motori di ricerca, Peso e Accessibilità. Un sito non risulta mai pronto finché l'accessibilità non è verificata. Il pannello Pubblica mostra verdetto e sezioni, in italiano e in inglese. Il rapporto si salva accanto alla versione come `<versione>.pronto.json`, con solo conteggi, nomi delle regole e indirizzi. Il controllo nel browser apre le pagine della versione in una finestra nascosta.
- **Verifica nel browser del sito WordPress collegato.** Da «Controlla il sito WP», il pulsante «Verifica nel browser» apre le pagine del sito collegato con le regole di axe alle due larghezze, e prova i link interni e quelli esterni. Un link esterno che risponde 404 o 410 risulta rotto; una rete o un tempo non raggiungibili, o un 5xx, risultano «non raggiungibili»; gli indirizzi di rete privata restano «non provati»; il resto, redirect compresi, risulta a posto. Il rapporto non mostra mai il gettone di accesso. Se il sito non dichiara la capacità `previewLinks`, Publish chiede di aggiornare Histeon sul sito. Il rapporto dice quante pagine ha aperto su quante: con meno pagine del sito, Accessibilità è «da guardare». Provato in un Electron 45 vero e in un WordPress di prova con Chromium, dove l'anteprima mantiene la sua CSP.
- **Pagina aggiunta a un sito che esiste.** Il convertitore del browser accetta una pagina da aggiungere a un sito già esistente (`addPage`). La base del sito, con stili e media, è letta come dato non fidato: se non è valida, la conversione si ferma con un errore che dice il codice. La pagina porta solo sé stessa, con uno slug preso dall'indirizzo canonico, dal percorso o dal titolo; uno slug già usato è un errore. Le parti, i componenti e gli elenchi restano fuori. Lo stile del sito resta com'è: sulla pagina aggiunta, dove il sito usa lo stesso selettore, vale lo stile della pagina, mentre sulle altre pagine resta quello del sito. Un foglio globale che il sito ha già non entra due volte. Senza `addPage` nulla cambia.
- **Colori della pagina aggiunta.** Con `addPage.colors` si decide di chi sono i colori della pagina: «sito» (come prima), «pagina» (le variabili della conversione tornano ai colori della pagina, e il sito non cambia) o «sostituisci» (il primario e il secondario del design del sito prendono i colori della pagina, e il rapporto elenca ogni variabile prima e dopo). I colori di marchio si scelgono solo fra i fogli della pagina. In una pagina di WordPress, i fogli del tema, di WordPress, dei plugin e del kit di Elementor, e i `<style>` senza id, si convertono come sempre, ma i loro colori non contano.
- **Pagine di WordPress aggiunte senza testata e piè di pagina.** Importando una pagina di WordPress come pagina aggiunta, resta solo il contenuto: il primo `<main>`, oppure, nei temi a blocchi, ciò che sta fra testata e piè di pagina, o nei temi classici `#main`, `#content` o `.site-main`. Vanno via testata, menu, piè di pagina, barra laterale e barra di amministrazione del tema, con i loro script e fogli. Se il contenuto non si riconosce, la pagina si importa intera, con un avviso. Una pagina che non è di WordPress resta com'era.
- **Conversione più vicina all'originale.** Misurando le pagine originali contro il sito importato sono state corrette quattro cose. Le immagini ricevono solo la misura che manca, e un'immagine a cui il CSS dà la sola larghezza non esce più allungata. I link tengono `href="#"`, e un frammento che non è un'ancora diventa `#` con una nota; una scheda nuova prende `noopener`. Un disegno SVG statico incorporato nel CSS resta nel foglio. I sottoinsiemi dei Google Fonts non latini si scaricano quando il testo li usa, e una famiglia senza file lascia una nota.
- **Da una proposta disegnata alla pagina, fino al confronto «Uguale alla proposta».** Una proposta disegnata dagli script, che l'importatore vedrebbe vuota, si fotografa: `histos-publish prototype capture <file> --pagina '#…' --out <cartella>` apre la proposta in un browser isolato, la lascia disegnare e copia la pagina senza script, come sito statico. Nell'app, «Importa» apre il file in un riquadro chiuso: si naviga e si preme «Aggiungi questa pagina», e le pagine diventano un sito statico con i Google Fonts scaricati, conservato in `proposal/`. Un progetto nato così mostra in «Pronto per andare online?» la sezione «Uguale alla proposta»: per ogni pagina, a 1280 e 390 px, quanta parte si vede diversa dalla proposta con i token e senza. Il perché dello scarto è per proprietà di stile, e i gradienti e le ombre si confrontano per il colore che si vede. Se la conversione «senza» non ha un carattere, il confronto lo dice con una nota. Rimisurato nell'app su proposte di prova a più pagine, il numero «senza» torna uguale al pixel.
- **Token di design da Figma e Penpot.** Il comando `histos-publish tokens` legge, senza rete e senza credenziali, un file `.penpot` intero, un file `.fig` salvato da Figma, il DTCG che Figma esporta e il formato Tokens Studio di Penpot, con il tema scuro da `--dark` o dagli insiemi `$themes`. Ne ricava i parametri di Histeon CSS (colori di famiglia, caratteri, misura del testo, titoli, raggio, tema scuro), le variabili `--xb-site-*` e, per Automatic.css, i valori e un foglio di variabili con prefisso (`--prefix ds`). Una misura di testo non diventa mai fissa: il rapporto dice il gradino più vicino. Il comando non sovrascrive una cartella che esiste. In un progetto, «Importa token di design» nelle impostazioni del sito accetta gli stessi file e mostra il rapporto prima di salvare. Il lettore dei file `.fig` è provato su file salvati da Figma: un file diverso può non leggersi, e il comando lo dice.
- **Token dall'API di Figma.** Con `tokens --figma <indirizzo o chiave>`, `figma-login` e `figma-logout`, e con il blocco «Da Figma» nell'app, gli stili si leggono dal file nel conto Figma. Il token di accesso sta nel portachiavi del sistema e va solo ad `api.figma.com`. In questa versione la strada è provata contro un server di prova, non contro l'API di Figma.
- **Da una pagina di Penpot o di Figma a un prototipo.** Il comando `histos-publish design <file>` elenca le pagine e i riquadri di un file `.penpot` o `.fig`; con `--pagina` e `--riquadro` scrive il prototipo di quel riquadro e un rapporto che dice che cosa è stato dedotto e che cosa non è stato convertito (maschere, sfumature non lineari, sfocature, rotazioni). Nell'app lo stesso lavoro è «Nuovo sito» → «Da Penpot o Figma», con «Controlla e importa», «Scarica il prototipo» e «Scarica il rapporto». Le sezioni sono larghe quanto la pagina, righe e colonne vengono dall'auto layout o sono dedotte dalle posizioni, mai da coordinate; le misure dei testi sono gradini della scala, mai px; i colori si legano ai parametri del design quando il file ha gli stili. Di un file di Figma si costruiscono anche le copie dei componenti, con i loro cambi. Le copie di un componente diventano un componente del prototipo, le varianti modificatori BEM, una fila di schede ripetute record letti da un loop: si spengono con `--senza-componenti` e `--senza-record`; `--schede-uniformi` dà alle schede in fila lo stile della prima. Il design ha una sola larghezza: la versione per telefono è dedotta e va controllata. Se più riquadri della pagina hanno lo stesso nome, ognuno diventa un progetto suo: nel menu dell'app dicono quale sono («Dashboard Overview (3º di 4)») e il rapporto dice quale è stato convertito e gli id degli altri. Provato su pagine di tre file Penpot e di due file Figma, con il controllo nel browser a 1440 e 390 px senza scorrimento orizzontale; il confronto in pixel col design non è stato fatto, perché manca un'immagine esportata dal design.
- **Verso Etch con Automatic.css.** Un prototipo nato da un design scrive sempre il padding delle sezioni e l'interlinea dei testi, perché Automatic.css ne dà di suoi. I valori per Automatic.css portano anche la scala dei testi, la scala degli spazi e il margine del design. Provato su un sito locale di prova con Etch e Automatic.css.
- **SVG con testo e sfumature nel formato di trasferimento.** Le conversioni di siti statici tengono ora le righe di testo e le sfumature degli SVG. Il formato `histos-transfer-markup-v1` porta `text`, `tspan`, `defs`, `linearGradient`, `radialGradient` e `stop`, con stile, `lang`, attributi di testo, `aria-*` e `data-*`. Restano fuori `use`, `symbol`, `clipPath`, `mask`, `pattern`, `filter`, `textPath` e `href`. Publish non invia a un sito che non ha la capacità `histos-svg-text-v1`, cioè senza Histeon 0.5.14. Le liste di lunghezze in `x`, `y`, `dx` e `dy` sono limitate a 64, lo stesso limite che accetta Histeon in WP.
- Prove: test nuovi sulle scelte del convertitore con un modello finto e con il corpus, sul formato di trasferimento, sul controllo del sito e sulla verifica nel browser (anche in Electron 45 e in un WordPress di prova), sulla pagina aggiunta, sul confronto «Uguale alla proposta» con proposte a più pagine, sui token di design e sui lettori dei file `.penpot` e `.fig` (con file fatti a mano e con file salvati dai due programmi).

## 1.37.0 — 2026-11-11

- **Importa una proposta scelta dal cliente.** Un file di proposte (il visore HTML con più proposte) si carica con «Importa un file» nei progetti CMS. Si apre «Quale proposta ha scelto il cliente?», con l'elenco delle proposte, il loro gruppo e l'idea, e l'anteprima della proposta scelta, isolata senza script. «Converti questa proposta» la trasforma in un prototipo: le variabili ACSS diventano token `--xb-*` di Histeon con una tabella esplicita, e quelle senza corrispondenza restano nel `:root` con un avviso; le schede ripetute diventano componenti, gli elenchi contenuti con tipo, voci e loop. Poi si passa al controllo del prototipo di sempre. Il nome del progetto viene dal titolo del file e dal nome della proposta.
- Il server accetta `proposal` nella conversione di un file caricato e risponde con la proposta convertita (id, nome, framework); un file senza la proposta chiesta si ferma con un messaggio che la nomina.
- Il manuale dei prototipi dice che un file di proposte (il visore HTML con più proposte) si importa da «Importa un file» e non va riscritto a mano.
- **I ruoli dei colori del design passano nel formato di trasferimento.** Un prototipo con `role_bg`, `role_heading`, `role_link` (o un altro dei 417 parametri di Histeon CSS che il manifest accetta, §12 del manuale) veniva fermato da `prototype check` con «Il progetto non rispetta i limiti del formato di trasferimento (166 problemi)»: lo schema `site-entity-v2` elencava solo 25 parametri del design, al massimo 32. Ora le chiavi già elencate tengono i loro limiti e le altre passano per forma (nome `a-z0-9_`, testo fino a 240 caratteri o numero, al massimo 512); il significato lo controllano la lettura del manifest, che rifiuta una chiave sconosciuta per nome e dice dove sta («Manifest, design: Parametro sconosciuto: role_sfondo (i parametri ammessi sono nel §12 del manuale).»), e Histeon in WP. Lo schema è corretto alla fonte, nella copia del builder.
- **Un rifiuto del formato di trasferimento dice il problema vero.** Per ogni entità restano solo i problemi del suo tipo (non più «kind must be equal to constant» per ognuno degli altri tredici), la chiave in più è detta per nome («must NOT have additional properties («extra»)») e va in cima al messaggio.
- Prove: un prototipo con `role_bg`, `role_heading` e `role_link` si importa e li porta nel progetto; uno con una chiave sconosciuta si ferma alla lettura del manifest col suo nome; il contratto dice la chiave in più e tace i rami degli altri tipi; nel builder ogni parametro di DesignData passa lo schema, compilato in modalità strict come in Publish.

## 1.36.2 — 2026-11-10

- **Il campo «Archivi KV del codice del server» si compila da solo.** Appena carichi il codice del server (un `.js` a parte, oppure uno ZIP o una cartella con `_worker.js`, alla prima versione), Publish scrive nel campo gli archivi che il codice usa, come `NOME=titolo`: l'archivio dell'account che corrisponde, se c'è (per esempio `CONTEGGI=conteggi-esempio`), altrimenti `CONTEGGI=<worker>-CONTEGGI`, creato alla prima pubblicazione. La configurazione si salva come se l'avessi scritto tu, e puoi correggerla. I valori scritti a mano non cambiano: si aggiungono solo i nomi mancanti. Il testo di aiuto del campo lo spiega.
- **Token senza permesso sugli archivi KV: il messaggio giusto.** Un token di account limitato al Worker riceve da Cloudflare 401 «Authentication error» sulle API degli archivi KV, non 403: Publish lo diceva come errore generico nella fase di controllo. Ora anche il 401 è il permesso mancante, e il messaggio dice quale archivio serve (per esempio CONTEGGI, «esempio-CONTEGGI», usato dal codice del Worker come env.CONTEGGI, oppure dichiarato nelle impostazioni del sito), come aggiungere al token Account › Workers KV Storage › Edit e che non è stato caricato nulla.

## 1.36.1 — 2026-11-10

- **Gli archivi KV si collegano da soli.** Publish legge il codice del Worker del sito e trova gli archivi che usa (`env.NOME.get`, `put`, `list`, `delete`, `getWithMetadata`, anche `env?.NOME`). A ogni pubblicazione li collega su `<worker>-NOME` e li crea se mancano, senza scrivere nulla nel campo «Archivi KV del codice del server». Il campo resta per un archivio che esiste già (`CONTEGGI=conteggi-esempio`, che vince sul nome trovato) o per un nome che il codice usa in altro modo. I nomi usati anche con metodi di R2, Durable Object, D1 o code non vengono presi per archivi KV.
- La scheda della versione dice quali archivi il codice usa; sotto il campo compaiono quelli che Publish collegherà da solo («Archivi trovati nel codice: CONTEGGI → esempio-CONTEGGI»).
- **«Prepara e pubblica» pubblica quello che vedi.** Se la configurazione del sito ha modifiche non salvate (Worker, account, archivi KV, rendering, Pagefind, Fluent Forms), le salva prima di preparare la versione. Se è cambiata la destinazione o si pubblica su FTP/SFTP, si ferma e chiede di salvare con «Salva configurazione», perché salvare vuol dire verificare il server. Prima un nome scritto nel campo degli archivi KV e non salvato andava perso senza avviso.
- Un nome nel campo degli archivi KV che differisce solo per maiuscole da quello del codice (`conteggi` contro `env.CONTEGGI`) dà un avviso sotto il campo: i nomi distinguono maiuscole e minuscole.
- Il mock Cloudflare svuota gli archivi KV anche al reset chiesto dal browser (prove e2e).

## 1.36.0 — 2026-11-10

- **Una pagina con il suo codice server su Cloudflare.** Un sito può portare il proprio Worker in due modi. Il primo è un file `.js` caricato a parte nella pagina del sito («Codice del server (Worker)»), accanto all'HTML; si può anche trascinare insieme all'HTML o allo ZIP. Il secondo è un file `_worker.js` nella radice dello ZIP o della cartella. Il file è un modulo con `export default { fetch(request, env, ctx) }` in un solo file, fino a 3 MiB.
- **Come risponde.** Publish carica il file come modulo del Worker, accanto al proprio `worker.js`, e non lo pubblica mai come file pubblico. Ogni richiesta passa prima dal codice del sito (`run_worker_first: true`): se restituisce una Response vale quella; se non restituisce niente, la richiesta va ai file statici. Lo stesso fa `env.ASSETS.fetch(request)`. I moduli Fluent Forms tengono `/xb-form` prima del codice del sito.
- **Archivi KV collegati da Publish.** Nella configurazione del sito, «Archivi KV del codice del server»: `CONTEGGI` collega l'archivio `<worker>-CONTEGGI`, creato se manca; `CONTEGGI=conteggi-esempio` collega un archivio che esiste già. Ogni pubblicazione ricollega gli stessi archivi. Il token Cloudflare deve avere anche Workers KV Storage › Edit; senza quel permesso la pubblicazione si ferma prima di caricare i file.
- **Nulla si perde tra una pubblicazione e l'altra.** `keep_bindings` ora conserva anche gli archivi KV aggiunti a mano nel pannello Cloudflare, oltre ai segreti.
- Un `worker.js` nella radice che sembra codice di Worker dà un avviso: verrebbe pubblicato come file pubblico, va rinominato `_worker.js`. La pubblicazione via FTP/SFTP rifiuta una versione con `_worker.js`.
- Prove: unitarie sull'involucro eseguito in Node con ASSETS e KV finti, sul mock Cloudflare (KV creato una volta e ricollegato, `_worker.js` non pubblico, permesso KV mancante) e e2e dalla pagina del sito.

## 1.35.0 — 2026-11-09

- **Con Histeon per WP 0.5.13:** un sito fatto in Publish arriva in WP com'è in Publish. Le query ordinate per un campo si inviano e ordinano come qui; i rifiuti del sito dicono in italiano l'oggetto e il valore; dopo l'import di un file il piano propone la home come pagina iniziale, una pagina «Blog» e gli articoli a `/blog/`; le date usano mesi e giorni della lingua del progetto. Nella copia del builder: il salvataggio dell'editor mette ciò che il server ha salvato sotto le modifiche fatte intanto (voci 232-236).
- **Collega in un clic:** scrivi l'indirizzo del sito, Publish apre la sua pagina di Histeon, confermi lì i permessi e il collegamento torna nell'app con `histos-publish://collega`. Il segreto non passa dal browser né da una riga di comando: Publish lo ritira una volta sola con PKCE e chiede il sì prima. Il codice da incollare resta (voce 237).
- **Dal file HTML al .xbsite:** `histos-publish prototype export file.html` dà il pacchetto da caricare in WP, lo stesso che l'app esporterebbe, senza creare un progetto (voce 238).
- **Controllo dei prototipi più severo e più chiaro:** l'import dice se il file è stato aperto in un browser e con che esito (239); le righe che dicono cosa ha fatto l'import cominciano con «Nota:» (240); un'immagine i cui byte non possono essere interi si rifiuta con il suo nome (241); la verifica nel browser trova le immagini che non si mostrano e il testo attaccato ai bordi (242); gli sbagli più frequenti dei modelli piccoli (sezione `posts`, tipo `post`, componente richiamato con il `data-ref`, ruolo ripetuto) dicono cosa scrivere.
- **Prototipi (doc 17):** link interni rotti, scorrimento orizzontale e regole axe sulle pagine dell'anteprima; avviso per il CSS che toglie i formati moderni; `prototype init` e `hp_prototype_init` con il kit; le richieste del connettore in coda invece di «occupato»; gli `xmlns` non sono più «HTTP non cifrato».
- **Guida per gli agenti:** i capitoli ecosistema, mestiere e progettare (con modelli presi da un prototipo verificato) e un percorso rapido per i modelli piccoli; il kit minimo ha i margini laterali.
- **Immagini:** lo srcset si ferma alla misura scelta (doc 26).
- Prove: `npm test` e `npm run test:e2e` verdi (le prove e2e che aprono l'editor segnano la guida del builder come già vista).

## 1.34.0 — 2026-11-08

- **Con Histeon per WP 0.5.12:** l'importazione da Etch porta gli stili com'erano sulle pagine del sito (media query personalizzate risolte, stili nello stesso ordine delle pagine, sezioni e contenitori come colonne flessibili), lascia i commenti fuori dai blocchi e mostra i componenti importati nell'anteprima prima della prima release; gli shortcode nei componenti di un modello funzionano; i loop ordinati per data hanno un ordine stabile. Nella copia del builder cambia solo la specifica dei blocchi (shortcode in `xb/passthrough`): l'editor non cambia.

## 1.33.0 — 2026-11-08

- **Worker senza versioni:** un Worker che esiste ma non è mai stato distribuito non risulta più «inesistente». Il messaggio dice «Il Worker esiste ma non ha ancora una versione pubblicata: premi Prepara e pubblica» (voce 227).
- **Pubblicazione non riuscita:** l'avviso e lo Storico mostrano il messaggio di Cloudflare e la fase in cui si è fermata: sessione, caricamento, versione o deploy. Prima la riga diceva solo «Non riuscita», e l'avviso di una pubblicazione fallita diceva «pubblicata» (voce 228).
- **Nomi dei Worker leggibili nei messaggi:** un nome come `appaoi-esempio-prova-works` dopo «Worker» non diventa più «[segreto rimosso]» (voce 229).
- **«Collega anche www»** compare solo quando il dominio scritto è quello principale della zona (o il suo `www.`); per un sottodominio non serviva (voce 230).
- **Guida:** con le «JavaScript detections» dei bot attive, Cloudflare inietta in `/` uno script inline che una CSP rigida blocca senza danni (voce 231).

## 1.32.0 — 2026-11-07

- **Pubblicazione su Cloudflare: ogni file con il suo tipo.** Prima ogni asset caricato era servito come `application/octet-stream`. I moduli JS venivano rifiutati dal browser e le app restavano su «Caricamento…»; ora JS, CSS, manifest, immagini e font hanno il loro tipo (voce 224). Il tipo entra nell'impronta di ogni file: Cloudflare non ricarica un file che ha già e ne terrebbe il tipo vecchio, quindi i siti già pubblicati si correggono alla prima pubblicazione con questa versione.
- **Siti con file senza estensione** (`LICENSE`, `CNAME`): il manifest e il caricamento calcolavano l'estensione in due modi diversi, e la pubblicazione si fermava con «Cloudflare ha richiesto un asset che non è presente nel bundle.» (voce 225).
- **`_headers` e `_redirects` applicati davvero:** vanno in `assets.config`, dove Cloudflare li legge; prima venivano ignorati (voce 226).
- Il Cloudflare finto delle prove ora si comporta come quello vero su questi tre punti.

## 1.31.0 — 2026-11-07

- **Con Histeon per WP 0.5.11:** gli stili di un sito possono arrivare a 500 KB (prima 200 KB), per i siti importati da Etch con gli stili per selettore. L'editor non cambia.

## 1.30.0 — 2026-11-07

- **Con Histeon per WP 0.5.10:** l'importazione da Etch porta anche condizioni, HTML grezzo, query di termini e campi del post di Etch; le tassonomie non pubbliche si possono ammettere nei loop di termini; nuovo campo del post `readingTime`. L'editor non cambia.

## 1.29.0 — 2026-11-06

- **Invio a WordPress con un rapporto grande:** se la risposta del sito non si legge (oltre 4 MiB), Publish controlla l'esito sul sito invece di segnare l'invio come fallito.
- **Siti acquisiti con il browser:** le risorse caricate dal browser diventano di nuovo parte del sito; una cartella con `.git/` non blocca più la versione; gli indirizzi esterni dei CSS si confrontano per origine e cartella.
- **Copie automatiche:** quelle vecchie si tolgono solo dopo che la nuova è scritta.
- **Rinomina di pagine e articoli:** una rinomina rifiutata non lascia un reindirizzamento.
- **Voci con tassonomie non collegate al loro tipo:** rifiutate subito, invece di far fallire l'invio dopo.
- **Ripristino su Cloudflare** registrato sotto la versione giusta; il Cestino dice «conflitto» solo per un conflitto vero.
- **Windows:** la disinstallazione rifiuta una cartella diversa da quella dell'app.
- **Interfaccia:** l'inglese non dice più «versione» e «modello», più testi tradotti, errori mostrati in copie, aggiornamenti e media, italiano dei messaggi corretto.
- **Rilascio:** consegne, copia e rilascio trovano l'AppImage anche in `release/<versione>/`.
- **Documentazione per ricostruire da zero** in schede brevi.
- **Con Histeon per WP 0.5.9** (editor con le stesse correzioni).

## 1.28.0 — 2026-11-05

- **«Controlla il sito WP»** (voce 197): nella riga del sito collegato, un pulsante legge il sito come prima di un invio, senza scrivere nulla, e dice per nome tutto ciò che non può viaggiare, con il motivo e cosa fare. Con Histeon 0.5.7 sul sito li nomina tutti, anche quelli che il progetto conosce.
- **Molti conflitti insieme** (voce 199): i conflitti per tipo, «Tieni quella del progetto» o «Tieni quella del sito» per un gruppo o per tutti, il confronto con le parole della pagina. Un download con molti contenuti allineati non resta più bloccato.
- **Contenuti solo sul sito** (voce 200): la revisione dell'invio li elenca per tipo e titolo, e «Porta nel progetto» scarica solo quelli scelti, con ciò che serve loro.
- **Pagina iniziale come nel progetto** (voce 201): dopo il primo invio con pubblicazione Publish propone di impostare in WP la pagina iniziale e la pagina degli articoli; si risponde sì o no.
- **«Solo prove» per l'agente AI** (voce 203): può fare l'invio di prova, non quello vero.
- **I messaggi del sito tengono il nome del contenuto** (voce 198): l'identità di un documento non viene più nascosta come un segreto.
- **Prova di versioni diverse** (voce 202): `npm run test:versioni-wp` manda un progetto fra Publish e Histeon di versioni diverse, nei due versi (docs/VERSIONI-WP.md). Ha trovato un difetto, corretto in Histeon 0.5.7: un record con due termini fuori dall'ordine alfabetico fermava il primo invio con pubblicazione.
- **Release** (voci 194, 195, 206): `npm run rilascio` controlla le firme, prepara le release con la prova di parità nelle note, pubblica solo con l'impronta confermata da chi rilascia e riscarica per verificare (docs/RILASCI.md).
- **Con Histeon per WP 0.5.7.**

## 1.27.0 — 2026-11-05

- **Loop a gruppi sul risultato di una query** (voce 187): `{#loop foto().groupBy("anno") as gruppo}`, da una sola query; ogni elemento è un gruppo `{key, items}`. Serve Histeon 0.5.5 sul sito: Publish non invia un progetto che lo usa a un sito più vecchio, e lo dice.
- **Le immagini moderne non spostano più l'immagine** in una griglia o in un flex: i `<source>` del `<picture>` avevano un loro spazio, 19 px in più su ogni scheda (voce 183).
- **Prova di parità visiva con WP** (voce 183): `npm run test:parita-wp` invia un prototipo a un WP usa-e-getta, pubblica e confronta le foto delle pagine. Vedi docs/PARITA-WP.md.
- **Il permesso dell'agente nel sito dice «✓ Salvato»** (voce 191); **la Guida** spiega come collegare un sito a WP e all'agente AI.
- **Cronologia dell'articolo:** aperta, finiva sotto la pagina e «Confronta» e «Ripristina» non si potevano cliccare.
- **Con Histeon per WP 0.5.5** (Static Bridge 2.2.12: un redirect verso una pagina tradotta si completa, voce 182).

## 1.26.0 — 2026-11-05

- **`url.path` nelle espressioni** (voce 189): il percorso della pagina costruita, come su WP. Un menu che segna la voce attiva con `url.path`, scritto nel sito o nel prototipo, si invia e si riceve; prima un contenuto del sito scritto così fermava ogni invio. Serve Histeon 0.5.4 sul sito: Publish non invia un progetto con `url.path` a un sito più vecchio, e lo dice.
- **Con Histeon per WP 0.5.4.**

## 1.25.1 — 2026-11-05

- **Il collegamento a WP si gestisce dentro il sito** (voce 188): in Pubblicazione → Siti collegati ogni collegamento ha anche il permesso d'invio dell'agente AI e «Scollega». La schermata «Agente AI» lo mostra soltanto, con «Cambia nel sito».

## 1.25.0 — 2026-11-05

- **Corretto: i progetti creati prima della 1.24.0 non si costruivano e non si aggiornavano** («no such column: image_asset_id»). La 1.24.0 aggiungeva due colonne al database del progetto senza far ripartire la migrazione; ora la migrazione gira una volta su ogni progetto.
- **Corretto: l'app conteneva un'interfaccia e un connettore AI più vecchi del resto** (dalla 1.22.0 alla 1.24.0): `npm run dist:linux` ora fa prima la build completa, e la build dell'app si ferma se trova l'interfaccia o il connettore più vecchi dei loro sorgenti. In questa versione arrivano davvero, fra le altre cose, la scelta dell'immagine in evidenza dell'articolo, i tipi senza pagine proprie e gli avvisi sulla versione di Histeon del sito.
- **Loop affiancati:** il limite di 6 loop annidati contava anche i loop uno accanto all'altro.
- **Articoli senza template:** l'immagine in evidenza si vede sopra il testo; un'importazione da WP non la ripete più nel testo (voce 177).
- **Histeon sul sito più vecchio:** il collegamento e il piano d'invio lo dicono, con ciò che non funzionerà (voce 175).
- **Link a un file della libreria** anche dall'editor (voce 176); elenco chiuso di attributi nel markup trasferito, uguale a quello del plugin (voce 172).
- **Consegne in un comando:** `npm run consegne` (voce 184).
- **Con Histeon per WordPress 0.5.3**, Lingua Bridge 1.5.10 e Static Bridge 2.2.11.

## 1.24.0 — 2026-11-04

- **Immagine in evidenza degli articoli.** Nell'editor dell'articolo «Immagine in evidenza» con anteprima, «Scegli» e «Togli»; i loop la leggono come `post.image` e il template dell'articolo come `page.image`, con le chiavi di WordPress. Nel prototipo `data-image="asset:nome"`; viaggia verso WordPress come miniatura dell'articolo e torna indietro; nel WXR diventa `_thumbnail_id` (voce 119).
- **Link ai file dei media.** `<a href="asset:foto">` collega il file di un'immagine o di un PDF: le tessere di una galleria aprono il file senza una pagina per la foto. Verso WordPress serve Histeon 0.5.2: Publish non invia nulla a un sito più vecchio e lo dice (121).
- **Raggruppare negli elenchi:** modificatore `groupBy(campo, come?)` per lettera, data o valore (118). **Tipi senza pagine proprie** anche in Publish (122). **Comportamenti del sito** (`data-xb-*`: schede, interruttori, comparse, mappe) anche sui siti di Publish (120). **Formati moderni:** `:has()` li toglie solo alle immagini che può toccare (123).
- **Sicurezza e solidità:** Publish non invia a un sito con PHP più vecchio di 8.3 (125); il connettore MCP si chiude quando muore il processo che l'ha aperto (128); `npm run version:set` (127).
- **Con Histeon per WordPress 0.5.2** nel builder incluso e nel plugin che Publish installa: permesso `xb_edit_props` per il cliente, rapporto delle trasformazioni verso Etch, più di 50 correzioni di sicurezza e di solidità, Lingua Bridge 1.5.9 e Static Bridge 2.2.10.

## 1.23.0 — 2026-11-04

- **Histeon 0.5.0 nel builder incluso.** Compositore «Inserisci un dato», varianti dei componenti come interruttori, script del sito, palette e annulla con le parole in Gutenberg, punto di ripristino prima dell'agente AI con «Tieni» e «Annulla tutto», operazioni `view` e `section-brief` per l'agente, «Fai ricostruire all'agente» nella libreria, galleria di query pronte, contrasto con il colore più vicino in OKLCH (voci 140-166).
- **Resoconto unico della conversione HTML.** Il controllo di un sito convertito divide le note in Tolto, Portato nel JavaScript della pagina, Media query e breakpoint (confrontate con `--mobile`, `--tablet`, `--desktop`), Da controllare (voce 163).

## 1.22.0 — 2026-11-04

- **Aggiornamenti dell'app.** In Impostazioni → Dati → Aggiornamenti dell'app inserisci un token di GitHub in sola lettura del repository di Histeon Publish: l'app controlla le release all'avvio e ogni 12 ore, avvisa quando c'è una versione nuova e la installa con un clic, solo se l'AppImage è firmata con la chiave di rilascio. Senza token resta tutto spento. Il pacchetto `.deb` si aggiorna a mano. Dettagli in `docs/spec/aggiornamenti-app.md`.

## 1.21.8 — 2026-11-04

- **Nuovo nome: Histeon Publish.** Histos si chiama ora Histeon, e l'app Histeon Publish: nella finestra, nei menu, nei messaggi, nel manuale, nella documentazione per gli agenti AI e nel connettore. L'AppImage si chiama `Histeon-Publish-…-linux-x64.AppImage`. Con Histeon per WordPress 0.3.12.
- **Niente da migrare.** Restano col nome vecchio le cose tecniche: la cartella dei dati (`~/.config/histos-publish`, con progetti, chiavi e segreti), il comando `histos-publish`, il pacchetto .deb, l'eseguibile e la cartella di installazione su Windows, il server MCP `histos-publish`, i formati dei progetti e dei backup e le intestazioni `X-Histos-*`. I progetti, i collegamenti con WordPress e le chiavi degli agenti continuano a funzionare.

## 1.21.7 — 2026-11-03

- Con Histos per WordPress 0.3.11: il plugin installato riporta gli avvisi di licenza delle librerie che contiene impacchettate (editor e «Importa HTML»), come chiedono le licenze MIT, BSD e Apache-2.0.

## 1.21.6 — 2026-11-03

- Con Histos per WordPress 0.3.10: lo stesso codice della 0.3.9, con un numero nuovo perché lo ZIP di Histos ora contiene Lingua Bridge 1.5.6, da cui è stato tolto un glossario incluso per errore. Il plugin che Publish installa non contiene i moduli, quindi in Publish non cambia altro.

## 1.21.5 — 2026-11-03

- Con Histos per WordPress 0.3.9: correzioni di sicurezza (i moduli Lingua Bridge 1.5.5 e Static Bridge 2.2.6 sono nello ZIP di Histos, non nel plugin che Publish installa). Fra queste: il CSS di chi non ha l'HTML libero non carica risorse di altri siti (il filtro ora rifiuta anche le forme scritte in modo insolito), uno script aggiunto a un blocco Etch da un autore limitato si toglie, una traduzione non aggiunge script salvati come blocchi, un import senza il permesso di pubblicare non cambia niente di ciò che è online, un agente AI scrive come un autore senza HTML libero, e le copie statiche smettono di essere servite quando il modulo si ferma. L'elenco completo è nelle note di Histos 0.3.9.

## 1.21.4 — 2026-11-03

- Con Histos per WordPress 0.3.8: un sito WordPress spostato a un altro indirizzo (All-in-One WP Migration, Duplicator, search-replace) non perde più le versioni di Histos. Prima le versioni diventavano «corrotte» e il builder mostrava pagine vuote. Per un sito già spostato, un avviso per gli amministratori ripara le versioni con l'indirizzo di prima.

## 1.21.3 — 2026-11-03

- Con Histos per WordPress 0.3.7: nell'editor a blocchi di WordPress le pagine hanno i font del sito, come sul sito e nel builder. Prima, con Histos CSS, l'editor tornava al font di sistema e titoli e griglie si allargavano.

## 1.21.2 — 2026-11-03

- Il numero di versione mostrato e scritto dall’app è di nuovo quello giusto: nella 1.21.1 era rimasto 1.21.0.
- Con Histos per WordPress 0.3.6: un tipo senza pagine proprie (per esempio le foto di una galleria che si aprono nella lightbox) compare negli archivi delle sue tassonomie pubbliche. Prima, in WordPress, le pagine per anno della galleria restavano vuote. Nei progetti di Publish non cambia niente.

## 1.21.1 — 2026-11-03

- Collegare un sito WordPress locale con HTTPS (Local, wp-env, DDEV) non si ferma più su «fetch failed». Per gli indirizzi `.local`, `.localhost`, `localhost` e del computer stesso Publish si fida anche dei certificati del sistema, dove Local mette quello di ogni sito; i siti pubblici restano con l'elenco di Node. Quando un sito non si raggiunge, l'errore dice perché (certificato, connessione rifiutata, tempo scaduto) con il codice del sistema.
- Con Histos per WordPress 0.3.5: la nota sotto il codice di abbinamento dice dove incollarlo in Publish (filtro «Collegati», «Collega un sito Histos WordPress», «Verifica e collega →»).

## 1.21.0 — 2026-11-02

- Font del sito nel builder: il pannello del Design system funziona anche in Publish. Si aggiunge una famiglia da Google Fonts (scaricata una volta nel progetto, con la licenza verificata) e si toglie; le pagine la prendono dal sito, non da Google.
- Finestra Video del builder: un video YouTube o Vimeo entra con titolo e copertina, e sul sito il lettore parte solo al clic.
- Con Histos per WordPress 0.3.4: le parti di template (testata, piè) vedono la pagina in cui stanno, così il menu segna la sezione; negli elenchi lo slot del modello resta vuoto invece di mostrare il testo del primo articolo.
## 1.20.2 — 2026-11-02

- Histos per WordPress 0.3.2: lo stesso plugin della 1.20.1 con un numero di versione nuovo, così i siti riconoscono l'aggiornamento.
- Le query vanno a WordPress come lui le scrive (`"$limit ?? N"`, `"$offset ?? N"`): il limite e l'offset scelti in un elenco valgono anche lì. Il manuale per gli agenti dice che WordPress legge gli stessi nomi di Publish.
## 1.20.1 — 2026-11-02

- Histos per WordPress aggiornato. Un progetto inviato o esportato in un sito WordPress ora si vede come nell'app: titoli, briciole, date, categorie e campi tornano visibili nei modelli (prima `{page.title}` e simili restavano vuoti); gli elenchi rispettano quanti elementi mostrare e da quale partire (`limit` e `offset`); il sito prende Histos CSS come framework, così i fogli lasciati da una prova di Automatic.css non cambiano più la grafica. Trovato provando un sito di prova su un WordPress locale.
## 1.20.0 — 2026-11-02

- Siti con molte immagini: «Converti in progetto Histos» non si ferma più al limite di 32 MB. Le immagini restano nell'app e il prototipo le nomina soltanto: un sito di prova di 68 pagine e 149 immagini passa da 37 a 6 MB e si importa intera.
## 1.19.0 — 2026-11-02

- Riscrittura con l'agente: chiedi all'agente collegato di riscrivere un articolo (testo, titolo, riassunto). La proposta compare nell'editor dell'articolo, parte per parte, e accetti o lasci ciascuna. Finché non accetti, l'articolo non cambia. Strumenti nuovi del connettore: `hp_article_read` e `hp_article_propose`.
## 1.18.0 — 2026-11-02

- Versioni del sito un po' più rapide: su un sito di 53 pagine e 153 articoli da 20,7 a 18,3 secondi. Le date si scrivono senza ricreare ogni volta i loro formati, e i fogli di stile delle pagine si confrontano senza copiarli.
## 1.17.0 — 2026-11-02

- Interno: i campi di invio dei moduli (indirizzo e metodo) vengono ora dal builder stesso, non da una correzione della sua copia in Publish. Per chi usa l'app non cambia nulla.
## 1.16.0 — 2026-11-02

- Articoli dei siti di prima: l'elenco «Documenti allegati» e la riga della fonte, finora parti protette, diventano blocchi con un clic su «Converti nei blocchi nuovi». C'è un blocco nuovo, «Fonte».
## 1.15.0 — 2026-11-02

- Importazione di un sito HTML: quando le classi utility diventano classi BEM, l'app fotografa le pagine cambiate prima e dopo, sul computer e sul telefono. Il resoconto dice se sono uguali, oppure quale pagina guardare.
## 1.14.0 — 2026-11-02

- Modifica sulla pagina: nell'anteprima di un articolo o di una pagina, un clic sulla testata o sul piè apre nel builder la parte del modello da cui vengono.
## 1.13.0 — 2026-11-02

- Blocchi «Foto» e «Prima e dopo»: le didascalie accettano grassetto, corsivo e collegamenti, e nella galleria ogni foto ha la sua.
## 1.12.0 — 2026-11-02

- Video nella pagina: il blocco «Video» di un articolo, se punta a YouTube o Vimeo, mostra il lettore sul sito al clic, senza caricare nulla prima (YouTube senza cookie, Vimeo con dnt). Lo stesso succede in WordPress con Histos.
## 1.11.0 — 2026-11-02

- Copie cifrate:
  - una copia si ripristina tra i siti con un clic, senza mai sostituire un sito che c'è ancora;
  - un controllo periodico, e il pulsante «Controlla la frase», dicono se la frase salvata apre ancora l'ultima copia.
- Blocchi propri:
  - si cambiano dopo averli creati (nome, campi, aspetto) senza perdere ciò che gli articoli ci hanno scritto;
  - possono avere righe ripetute.
- Note: da ogni nota si torna al paragrafo che la chiama.
## 1.10.2 — 2026-11-02

- La costruzione dei pacchetti Linux usa una cartella temporanea propria e, prima di partire, controlla che ci sia spazio. Con `/tmp` pieno si fermava a metà con un errore poco chiaro.
- La prova dell'app impacchettata non dipende più dalle parole dell'interfaccia.
- Tolto codice non più usato (i vecchi filtri degli articoli).

## 1.10.1 — 2026-11-02

- **Siti con contenuti propri:** una pagina, un componente o una query che non si possono trasportare non fermano più il lavoro. Restano fuori, con ciò che li usa, e la finestra dell'invio li elenca con il motivo.
- **Il controllo non tocca il sito:** il controllo prima di un invio non scrive nulla, e l'invio e il ritorno indietro leggono solo ciò che appartiene al progetto.
- **Il lavoro del sito resta in sviluppo:** «Pubblica» nel builder e la schermata Release partono dalle sole modifiche arrivate da Publish.
- **Prova completa:** invio, secondo invio, ritorno indietro e rilettura provati su un sito di prova, senza conflitti.

## 1.10.0 — 2026-11-01

- **Modifica sulla pagina:** nell'editor, la pagina com'è sul sito; un clic su un testo riporta a quel blocco.
- **Copie cifrate fuori dal computer:** in Impostazioni si sceglie una cartella, anche sincronizzata, e una frase. Ogni giorno vi finisce una copia cifrata (AES-256-GCM) di ogni sito cambiato; da lì si riapre.
- **Costruzioni più veloci:** un sito di prova da 647 pagine passa da 46 a 28 secondi. Lo stile di una pagina si calcola una volta per costruzione, non per pagina.
- **Traduzione di un sito intero:** provato il percorso con 468 elementi su un sito di prova, nessun rifiuto, in 15 minuti e mezzo. I testi di quella prova erano meccanici.
- **Lettori di schermo:** un controllo automatico sulle schermate principali entra nelle prove.
- **Codice:** `App.svelte` passa da 4.613 a circa 3.200 righe, con 35 componenti.

## 1.9.0 — 2026-11-01

- **Grassetto, corsivo e link nei blocchi:** riquadro, biografia, risposte, cronologia e bibliografia hanno il testo formattato, in Publish e nel pannello di Gutenberg. Nuovo modificatore `inline()`, che stampa solo i formati ammessi.
- **PDF nei media:** «Documento da scaricare» carica un PDF, controllato, che viaggia con il sito e arriva nei media di WordPress.
- **Indice:** un blocco che si compone da solo dai titoli dell'articolo.
- **Note:** togliendo una riga si toglie il suo numero, e le altre si rinumerano.
- **Blocchi protetti modificabili:** di qualunque blocco che l'editor non sa aprire, come «Documenti allegati» e la riga della fonte, si cambiano testi e indirizzi senza toccarne la struttura.
- **Modelli di articolo:** recensione, intervista, comunicato, su un articolo vuoto.
- **Crea un tuo blocco senza HTML:** nome, campi e un aspetto.
- **Gutenberg:** il pannello parla la lingua di WordPress.
- **Lingua Bridge 1.5.3:** vede i testi dei blocchi.
- **Invii interrotti:** se un hosting ferma l'invio a metà, l'app se ne accorge e riprende da sola.
- **Articolo difettoso:** non ferma più la costruzione: resta fuori, e il risultato dice quale. I controlli restano severi.
- **Importazione:** un'immagine che non arriva resta come collegamento, e il resoconto dice cosa è rimasto fuori articolo per articolo.
- **Blocchi di WordPress:** il rifiuto dice quale articolo e come uscirne.

## 1.8.0 — 2026-11-01

La solidità: per la prima volta un progetto grande (un sito di prova con 209 documenti, 243 media, 883 elementi) ha fatto tutto il viaggio con WordPress: invio in 48 secondi, pubblicazione, modifica, secondo invio in 13, ritorno indietro in 14. Quella prova, la lettura di un sito di prova e il carico con 1.114 articoli hanno trovato difetti che i test simulati non vedevano.

- **Le graffe:** WordPress 7.1 scrive la barra rovesciata in un altro modo, e ogni articolo con una graffa nel testo faceva fallire l'invio con «revisioni diverse». Ora le due forme sono lo stesso documento.
- **La «&»:** un riassunto o un tag con una «&» nel nome fermava l'invio o risultava cambiato.
- **I font:** WordPress li rifiutava e l'invio si interrompeva. Ora passano, dopo aver controllato che lo siano davvero.
- **Siti grandi:** l'app aspetta WordPress fino alla fine, invece di dichiarare l'esito incerto dopo due minuti, e un'interruzione dice il motivo vero.
- **Tag e categorie:** l'ordine dei tag e il nome dato alle categorie non fanno più credere che il contenuto sia cambiato. Un piano non scade più alla sua stessa lettura.
- **Blocchi di WordPress senza equivalente** (incorporamenti, blocchi di altri plugin): viaggiano interi, restano protetti in Publish e tornano solo identici; un progetto non può inserirne di nuovi nel sito.
- **Importazione da un indirizzo:** provata su un sito di prova, 1.114 articoli in 60 secondi. Tabelle semplici, video di YouTube e Vimeo, video e audio restano come blocchi; le immagini con `//` si salvano; le trascrizioni non sono più scambiate per codici brevi.
- **Costruzione:** un link con una graffa nell'indirizzo fermava tutto il sito.
- **Traduzioni:** una pagina tradotta elenca gli originali finché la loro versione non è online, invece di restare vuota. Il messaggio per l'agente spiega come arrivare in fondo a un sito grande.
- **Stili dei blocchi:** solo nelle pagine che li usano.

## 1.7.0 — 2026-11-01

**Blocchi per chi scrive.** Sono componenti Histos con chiave `articolo/…`: una definizione sola, che vale per tutti gli articoli, e lo stesso risultato in Publish, nel sito statico e in WordPress.

- **Nel menu «/»:** riquadro, citazione grande, scheda libro, scheda autore, documento da scaricare, video, galleria, pulsante, scheda evento, confronto prima e dopo, audio, mappa, domande e risposte, leggi anche, cronologia, bibliografia. I campi nascono dal componente, e ogni tuo componente `articolo/…` diventa un blocco.
- **Note a piè di pagina:** «Nota» (Ctrl+Alt+N) mette il numero al cursore, rinumera e porta alla riga in fondo, che si scrive sul foglio.
- **In Gutenberg:** i blocchi sono modelli, si vedono come sul sito e si cambiano nel pannello laterale. Il pannello vale per ogni componente Histos.
- **Andata e ritorno con WordPress:** le modifiche fatte in Gutenberg tornano in Publish, compresi i blocchi aggiunti lì e i normali paragrafi, titoli, elenchi, citazioni e immagini. Prima una modifica in Gutenberg alle proprietà di un componente, o un blocco aggiunto, non arrivava alla copia di sviluppo.

## 1.6.0 — 2026-11-01

- **Uno stile su tutti i siti di una cartella:** dentro una cartella, «Porta uno stile su tutti» copia da un sito agli altri colori, caratteri e impostazioni del pannello Histos CSS. Prima mostra cosa cambia in ogni sito, e salva una copia di ognuno in `backups/prima-dello-stile`. Pagine e testi non si toccano.

## 1.5.0 — 2026-11-01

Quattro scelte sulle proposte raccolte.

- **Controllo dei doppioni:** «Controlla il sito» trova titoli e descrizioni uguali su più pagine.
- **Cronologia:** in Pubblica si chiama così, e la pubblicazione che i visitatori vedono ha l'etichetta «Online ora». Il ritorno indietro c'era già.
- **Traduzione del sito intero:** in Lingue → Lavoro, «Fai tradurre all'agente» copia il messaggio da dare all'agente, che scrive bozze. «Pubblica le bozze riviste» le porta nel sito tutte insieme.
- **Assistente per il primo sito:** tre domande (nome, tipo, lingua) e il sito è pronto.

## 1.4.0 — 2026-11-01

- **Articoli a copertine:** oltre all'elenco, una vista con la prima immagine di ogni articolo.
- **Cartelle dei media:** ogni file può stare in una cartella, e la libreria si filtra per cartella.
- **Importazione da WordPress:** avanzamento visibile e annullabile mentre scarica le immagini e scrive i contenuti.

## 1.3.0 — 2026-11-01

Prima parte delle migliorie successive della lista (doc 23).

- **Editor:** tabelle, con righe e colonne da aggiungere e togliere; le tabelle semplici già presenti si possono modificare. Confronto di una versione con il testo attuale. Conteggio delle parole.
- **Sito:** feed RSS in `feed.xml`, quando il sito ha il suo indirizzo. Dati strutturati per Google negli articoli.
- **Bacheca:** dice quando degli articoli programmati sono arrivati alla loro data.
- **I tuoi siti:** ricerca per nome fra tutti i siti, cartelle comprese.
- **Importazione da WordPress:** il riepilogo resta nella bacheca finché non lo chiudi.
- Provate di nuovo su WordPress di prova tutte le andate e i ritorni.

## 1.2.0 — 2026-11-01

- **Ricerca nel sito, senza server:** in Impostazioni si accende, e la versione del sito ha una pagina `/cerca/` con il suo indice.
- **Modelli di partenza:** in Nuovo sito, Rivista e Negozio, siti completi da cambiare come si vuole.
- Aggiornata la lista delle migliorie successive (doc 23).

## 1.1.0 — 2026-11-01

Prima parte delle migliorie della lista (doc 23).

- **Scrittura.** L'editor mostra l'articolo con gli stili del sito, si può togliere. I blocchi si trascinano. Cronologia con ripristino. Le pagine di solo testo si scrivono come gli articoli. Categorie e tag si aggiungono a più articoli insieme. Un articolo con una data futura è «Programmato» e resta fuori dal sito fino a una versione fatta dopo quella data.
- **Media.** Ritaglio e rotazione in una copia, l'originale resta. Filtro «Non usate», con spostamento nel Cestino.
- **WordPress.** Importazione dal solo indirizzo del sito, con le sue API pubbliche: pagine e articoli pubblicati. Titoli e descrizioni di Yoast e Rank Math entrano in Publish, dal file e dall'indirizzo. «Esporta per WordPress» prepara il file per un sito senza Histos: testi e struttura, le immagini si caricano a parte.
- **Pubblicazione.** Pubblica prepara il sito da solo e, se la destinazione è una, parte con un clic. Titolo e descrizione per i motori di ricerca, con l'anteprima come su Google e i tag per i social. Quando un indirizzo cambia, il vecchio porta al nuovo. «Controlla il sito»: link rotti, immagini pesanti, testi alternativi e descrizioni mancanti.
- **App.** Copertina del sito nell'elenco. La bacheca dice cosa è cambiato e il passo dopo. Tema chiaro, scuro o del sistema. `?` mostra le scorciatoie. Benvenuto al primo avvio. Registro degli errori da scaricare. Una copia al giorno dei siti cambiati, le ultime tre, in `backups/automatiche`.
- Le parole semplici arrivano anche ai messaggi del server. Il collaudo dell'AppImage non lascia più 360 MB in `/tmp`. `npm run test:wordpress:all` lancia tutte le prove con WordPress.
- 18 progetti di prova, su una copia: si aprono e si costruiscono tutti con la 1.0.

## 1.0.0 — 2026-11-01

Prima versione stabile: l'app ripensata (doc 22) con l'editor degli articoli, le lingue, l'amministrazione del sito e l'importazione da qualsiasi WordPress.

- Rifinitura: spazio di lavoro senza doppioni in testa, sezioni in una striscia sul telefono, modelli senza pulsanti corallo, testo dell'articolo più arioso, Guida aggiornata.
- La lista di ciò che può venire dopo è nel doc 23.

## 0.1.76 — 2026-11-01

- **L'app ripensata** (doc 22, prima parte). Una sola casa: «I tuoi siti». Un sito si apre nel suo spazio di lavoro, con la sua barra laterale, e lì c'è tutto: pagine, articoli, contenuti, media, aspetto, pubblicazione, lingue, impostazioni. Le vecchie linguette del progetto non ci sono più e nessuna funzione è andata persa.
- In ogni sezione, sempre allo stesso posto, due comandi: **Anteprima** e **Pubblica**. Ogni schermata e ogni indirizzo si ricaricano uguali, e «Indietro» funziona.
- Nuovo aspetto: barra globale stretta con le parole sotto le icone, font Inter incluso nell'app (OFL), icone vere (Lucide, ISC), colori e pulsanti unici, corallo solo per il passo da fare, tema scuro aggiornato. Niente più riquadro nero attorno ai titoli.
- Parole normali: la «build» è ora la «versione» del sito, i «template» sono modelli, i «record» sono voci, lo «slug» è l'indirizzo.
- «Nuovo sito» raccoglie tutti i punti di partenza: da zero, da WordPress, da un indirizzo web, da file. Impostazioni dell'app a schede. Lingua e fuso del sito si scelgono da un elenco; il negozio compare solo se il sito ne ha uno.
- **Importazione da qualsiasi WordPress, senza plugin:** il file di Strumenti → Esporta diventa un sito, con pagine, articoli, categorie (anche annidate), tag, date, riassunti, immagini e immagine in evidenza. Ciò che non si può portare (moduli, video incorporati, shortcode, tabelle ridotte a testo) resta fuori e viene detto. Il file è trattato come ostile: niente DOCTYPE, limiti di dimensione, e l'HTML entra solo come blocchi. Provato su un WordPress locale di prova: `npm run test:export:wordpress:local`.
- Provate di nuovo su WordPress di prova tutte le andate e i ritorni: CMS, prototipi, markup, Etch, negozio, lingue.
- Filtro per categoria o tag nella tabella degli articoli. Backup, esportazione e libreria delle sezioni sono in Impostazioni del sito. Il Cestino chiede su quale sito WordPress preparare la cancellazione.

## 0.1.75 — 2026-11-01

- **Editor degli articoli senza HTML né CSS** (doc 21 §13). In Amministrazione un articolo si apre in un foglio di testo: titolo, paragrafi, titoli, elenchi, citazioni, immagini, separatori. «/» o `##`, `-`, `>` aggiungono un blocco, una selezione mostra grassetto, corsivo e collegamento, `Alt+↑/↓` sposta un blocco, si salva da solo. Immagini dalla libreria, oppure trascinate o incollate.
- Le parti che non sono testo (documenti allegati, riga della fonte) restano blocchi protetti: si spostano o si tolgono, non si rompono. Un blocco non toccato resta identico, e il testo modificato tiene il suo id, così le traduzioni restano collegate. Provato in sola lettura su 2.601 articoli di un sito di prova: nessuna differenza.
- Il server scrive il documento e l'editor gli manda solo dati: niente HTML grezzo. Link solo `https`, `mailto`, `tel` e indirizzi del sito; immagini nuove solo dai media del progetto.
- Gli articoli usano un modello unico: niente scelta del template per articolo, «Modello degli articoli» apre quel template nel builder. Se un articolo ne ha uno suo, si vede e si riporta a quello comune.
- Corretto: «← Publish» dal builder tornava al catalogo anche partendo dall'amministrazione. Ora «← Amministrazione» torna alla sezione di partenza. L'indirizzo era giusto, ma il builder lo scartava.
- Nuova dipendenza: ProseMirror (MIT), solo nell'interfaccia.

## 0.1.74 — 2026-11-01

- **Amministrazione rifatta nell'uso.** Barra laterale a gruppi, e quella scura dell'app si toglie per dare spazio alle tabelle. Da qui ora si crea una pagina o un articolo, si caricano file anche trascinandoli, si vede l'anteprima di una bozza, si scelgono data e categorie di un articolo. Stato a segmenti con i conteggi, `/` per cercare, ordine e date relative, azione rapida sulla riga. Il Cestino si annulla dall'avviso. Avvisi unici invece di messaggi sparsi, e un campo rifiutato torna al valore vero. Impostazioni con barra «Modifiche non salvate» e rinomina del progetto. Bacheca con l'avanzamento per lingua.
- **Lingue:** schede Lingue, Lavoro, Testi fissi, Contesto; aggiunta di una lingua con un clic; le stringhe scritte da un agente si vedono come bozze e si pubblicano in blocco.
- **XLIFF:** esporta e importa per le agenzie, in bozza, dalla scheda Lavoro. Niente DOCTYPE o entità, la lingua del file deve coincidere, un originale cambiato o un testo con tag diversi resta fuori con il motivo.
- Corretti i difetti di una revisione indipendente. I più gravi: leggere i testi da tradurre invalidava la build pronta; un record con termini non si traduceva e non si pubblicava in blocco; un prodotto con SKU non si traduceva (ora la versione non porta lo SKU); la memoria imparava frasi da versioni superate; «Aggiorna la bozza» di un record dichiarava allineati valori vecchi; «Segui l'originale» su una pagina con struttura sua ne cancellava il testo; le impostazioni si salvavano a metà. Le prop di un componente si traducono solo se il suo schema le dichiara testo.

## 0.1.73 — 2026-11-01

- Corretto: i legami fra le lingue non partivano mai con un invio normale, solo dal controllo di un'operazione rimasta in sospeso, e Lingua Bridge non riceveva nulla. Ora partono alla fine di ogni invio; se il sito non li prende, la nota è nell'esito dell'invio.
- Corretto: un articolo in bozza senza categorie teneva «Uncategorized», che WordPress dà da solo a ogni articolo nuovo, e da lì ogni invio successivo era rifiutato con un conflitto (builder). Ora la release gliela toglie.
- Corretto: riesaminare un invio due volte dava conflitti su Categorie, Tag e Uncategorized, i contenuti di WordPress che il progetto non ha mai avuto, e l'invio si bloccava.
- Un legame a un record aspetta la release che crea il record (builder).
- Nuova prova su un WordPress di prova: `npm run test:languages:wordpress:local` (con `HISTOS_BUILDER_DIR` e `HISTOS_LINGUA_BRIDGE_ZIP`) invia pagina, articolo e record in due lingue su uno stack usa-e-getta con Lingua Bridge, e controlla i legami.

## 0.1.72 — 2026-11-01

- Lingue verso WordPress (doc 20, Lingua Bridge 1.5.2): finito l'invio, Publish dice al sito quale contenuto è la traduzione di quale, e Lingua Bridge li collega. Le bozze restano bozze. Se sul sito manca Lingua Bridge o Histos è vecchio, i contenuti arrivano comunque e il messaggio dell'invio lo dice.
- Una prova fissa che aggiornare un prototipo tiene lingue e traduzioni. Guida dell'app aggiornata.

## 0.1.71 — 2026-11-01

- Traduzione con il connettore IA (doc 20): sei strumenti nuovi, `hp_translation_brief`, `_work`, `_source`, `_save`, `_strings`, `_save_strings`. L'agente legge i testi con il loro id e li riscrive in una bozza: niente markup, stessi tag in linea e stesse espressioni dell'originale. Una versione pubblicata o indipendente rifiuta il salvataggio. Le stringhe arrivano come bozze. Pubblicare resta dell'utente.

## 0.1.70 — 2026-11-01

- **Amministrazione del sito** (doc 21): dal progetto, «Amministra il sito» apre una schermata con barra laterale. Bacheca, Pagine, Articoli, un elemento per ogni tipo di contenuto, Media, Aspetto, Lingue, Impostazioni. Tabelle con ricerca, filtri, ordinamento, selezione multipla e azioni di gruppo in una sola transazione; dettaglio accanto alla riga, con titolo, slug, stato, riassunto e template modificabili sul posto; `Ctrl+K` cerca tutto il sito; tastiera ovunque (`j`, `k`, `Invio`, `e`, `x`). Ogni sezione ha il suo indirizzo, e dal builder si torna dove si era.
- Velocità misurata: l'indice di 5001 contenuti si legge in 18 ms, e il cambio di sezione si disegna in 20 ms. Le tabelle disegnano solo le righe visibili.
- **Schermate delle lingue** (doc 20): aggiungere e togliere lingue, lavoro di traduzione per lingua, «Crea tutte le bozze mancanti», stringhe, contesto e glossario, pastiglie per lingua nelle tabelle, riquadro della versione con frasi cambiate, «Aggiorna la bozza», «Segna come aggiornata», «Rendi indipendente». Nel builder la barra delle lingue, la tela nella lingua del documento e il controllo dei testi rimasti uguali all'originale.
- Nuove impostazioni raggiungibili da dentro il sito: indirizzo del sito, lingua e fuso, varianti delle immagini, negozio.
- Il profilo `.xbsite` porta le traduzioni di pagine e articoli come contenuti a sé, con lo slug `<slug>-<lingua>`: il legame fra le lingue verso WordPress arriva in una versione successiva.

## 0.1.69 — 2026-11-01

- Lingue (doc 20). **Stringhe:** i testi fissi di template, parti e componenti e i nomi dei termini si traducono una volta sola; nella build, sulle pagine in un'altra lingua, un testo intero o un `alt`, `title`, `placeholder`, `aria-label` intero prende la stringa pubblicata, mai dentro `script`, `style`, `textarea`, `code`, `pre` o commenti.
- **Link interni:** su una pagina inglese un link a `/chi-siamo/` va a `/en/about/`, e a `/en/` quello alla home; il selettore di lingua resta com'è.
- **Segmenti:** una traduzione si scrive a testi, non a markup, e si ricostruisce dalla struttura dell'originale; un testo con altri tag o altre espressioni è rifiutato. **Memoria di traduzione:** impara da ciò che è pubblicato e serve alle bozze nuove. **Aggiornamenti:** si vedono le frasi cambiate; «Aggiorna la bozza» tiene quelle invariate, e una versione pubblicata non si ricostruisce mai.

## 0.1.68 — 2026-11-01

- Lingue dei progetti CMS (doc 20), senza ancora la schermata: si arriva con l'API. Un progetto ha una lingua del sito e altre lingue; ogni pagina, articolo e record può avere una versione per lingua, collegata all'originale, che nasce sempre bozza e segue l'originale o è indipendente (`cms_translations`, schema del database 5).
- La build scrive ogni lingua nella sua cartella, senza reindirizzamenti: `/en/`, `/en/about/`, `/en/blog/…`, con elenchi, archivi e 404 per lingua. `data.lingua` come in WordPress, quindi lo snippet «Selettore di lingua» funziona; `hreflang` e `x-default`.
- Nuova impostazione: l'indirizzo del sito (`site.url`). Con quello la build scrive `sitemap.xml` e `robots.txt`, e i link `hreflang` sono assoluti. Senza, avviso `cms-site-url-missing` se il sito ha più lingue.
- Corretto: una query su una pagina in un'altra lingua dava gli indirizzi senza prefisso (`/opera/x/` invece di `/en/opera/x/`), e `data` non arrivava dentro template e componenti.
- Un progetto con una lingua sola e senza indirizzo costruisce lo stesso sito di prima. Provato anche con una copia di 18 progetti di prova: si aprono tutti.

## 0.1.67 — 2026-10-30

- Corretto: i progetti creati prima della 0.1.38 non si aprivano più («no such table: cms_document_scripts»). Le tabelle degli script e dei rapporti d'importazione erano state aggiunte senza alzare la versione del database, quindi questi progetti non venivano mai aggiornati. Ora la versione è la 4: all'apertura il progetto si aggiorna da solo, dopo una copia di sicurezza in `recovery/`.

## 0.1.66 — 2026-10-30

- Pannello Histos CSS (doc 19 §5.3): le ultime opzioni. Misure delle icone, titolo delle card (`xb-card-title`) con la sua misura, altre due sovrapposizioni (`xb-overlay-2`, `-3`), a capo per livello dei titoli.

## 0.1.65 — 2026-10-30

- Pannello Histos CSS (doc 19 §5.3): le opzioni minori che mancavano. Corsivo dei titoli, spaziatura e larghezza per livello, stile del focus, citazioni (bordo, padding, corsivo), testo della selezione, colore di bordi e divisori, durata delle transizioni, colore delle etichette, misura della legenda, colore del focus dei campi, padding e raggio dell'icona in riquadro.

## 0.1.64 — 2026-10-30

- Pannello Histos CSS (doc 19): anche un **gruppo di classi** spento si vede subito nell'anteprima, senza salvare.

## 0.1.63 — 2026-10-30

- Pannello Histos CSS (doc 19): gli **effetti** hanno i loro parametri: misura di partenza di `grow` e `shrink`, sfocatura di `blur`, punto in cui l'uscita è compiuta, luminosità di `bright`, opacità di `fade`.

## 0.1.62 — 2026-10-30

- Pannello Histos CSS (doc 19): le varianti chiara e scura dei pulsanti scelgono la **sfumatura al passaggio**; una **superficie** può avere un nome suo (classe `xb-surface-<nome>`).

## 0.1.61 — 2026-10-30

- Pannello Histos CSS (doc 19): le **superfici** del sito possono essere un gradiente, con il testo leggibile a entrambe le estremità; gli interruttori degli **stili predefiniti** sono riuniti in un gruppo; un token di un gruppo spento risulta sconosciuto nel pannello CSS anche in Histos Publish.

## 0.1.60 — 2026-10-30

- Pannello Histos CSS: gli **stili predefiniti dei moduli** arrivano davvero ai moduli di Fluent Forms. Le regole di Histos in `:where()` hanno peso zero e il foglio dei moduli le copriva; provato in Chromium con il foglio di Fluent Forms.

## 0.1.59 — 2026-10-30

- Pannello Histos CSS (doc 19), i pezzi rimasti: **token in linea** (WordPress) e anteprima dei gruppi di variabili spenti; **stile per passo del testo**; pulsanti **Accento** e **Display** in Font del sito; **barra dei passi** dei moduli a più pagine; **ombre** modificabili per passo; **pulsanti** attivabili per famiglia e variante; **simbolo** delle liste con icona; **link esterni** col dominio scritto nel pannello; spaziatura del testo in tutto il contenuto; **sezioni in griglia** di default; contrasto automatico anche contro le **superfici**.

## 0.1.58 — 2026-10-30

- Pannello Histos CSS: la sfumatura al passaggio del **tema scuro** si sceglie (300 di partenza); il **pulsante d'invio** dei moduli prende la famiglia scelta.

## 0.1.57 — 2026-10-30

- Pannello Histos CSS (doc 19), **Avanzate**: si sceglie anche quali **gruppi di classi** stampare (colori, pulsanti, movimento, icone, card, moduli). Un gruppo spento non va nel foglio del sito e non è proposto: nella build di Publish ogni pagina si alleggerisce (con pulsanti e movimento spenti il foglio delle classi passa da 61 a 43 KB).

## 0.1.56 — 2026-10-30

- Pannello Histos CSS: rapporto della scala dei raggi, **divisori** (`xb-divider`: spessore, stile, spazio), massimo di colonne della griglia automatica.

## 0.1.55 — 2026-10-30

- Pannello Histos CSS (doc 19), scheda **Spazi**: lo spazio dei testi `xb-prose` (fra i blocchi, prima e dopo i titoli, fra le voci delle liste) e il **layout a riquadro** (la pagina stretta e centrata sopra uno sfondo, con un'ombra).

## 0.1.54 — 2026-10-30

- Pannello Histos CSS (doc 19), scheda **Forme**: colore, opacità e fusione della sovrapposizione (`xb-overlay`, e la nuova `xb-overlay-gradient`); tre **superfici del sito** (`xb-surface-1`, `-2`, `-3`) con sfondo, bordo e ombra, e il testo sopra leggibile scelto da solo.

## 0.1.53 — 2026-10-30

- Pannello Histos CSS (doc 19), scheda **Testo**: ogni passo del testo e ogni titolo può avere le sue due misure (schermo piccolo e grande), fuori dalla scala; ogni livello di titolo può avere colore, carattere e maiuscole propri.

## 0.1.52 — 2026-10-30

- Pannello Histos CSS (doc 19), **Moduli** completi: misura del testo e segnaposto dei campi, misura delle etichette, misura e colore dell'aiuto, colori di errore e conferma, caselle e scelte (anche come interruttore), spazio fra i campi; con gli stili predefiniti anche la freccia dei menu a tendina e `fieldset`/`legend`, per i campi senza classe e per Fluent Forms.

## 0.1.51 — 2026-10-30

- Pannello Histos CSS (doc 19), **Avanzate**: si sceglie quali gruppi di variabili stampare (trasparenze, ombre, pulsanti e link, moduli, card, icone, movimento). Un gruppo spento non va nel foglio del sito, che si alleggerisce: in WordPress il sito riceve un suo foglio dei token, nella build di Publish lo stesso. Un interruttore lascia all'editor a blocchi la palette del tema.

## 0.1.50 — 2026-10-30

- Histos CSS: accesi di partenza, come propone il doc 19, la **scala dei titoli separata** (i titoli H1-H6 hanno base e rapporto propri, più grandi sugli schermi larghi), l'**anello di focus** su tutto il sito, lo **scorrimento morbido** (mai per chi chiede meno movimento), il **movimento ridotto** quando il sistema lo chiede e le **ancore sotto l'intestazione**. Titoli, testo, link e moduli senza classe restano senza stile, come prima. Si spengono dal pannello Histos CSS.

## 0.1.49 — 2026-10-30

- Pannello Histos CSS (doc 19), scheda **Forme**:
  - **card**: padding, spazio interno, raggio, sfondo, ombra, bordo e proporzioni del media; `xb-card-media` a filo dei bordi, `xb-card-body`, raggio concentrico `xb-radius-inner`;
  - **icone**: colore e spessore del tratto, misure `xb-icon-xs` … `xb-icon-2xl`, icona in riquadro `xb-icon-boxed`, liste con la spunta `xb-list-icon`.

## 0.1.48 — 2026-10-30

- Pannello Histos CSS (doc 19), **Movimento ed effetti**: classi solo CSS per l'entrata e l'uscita legate allo scorrimento (`xb-enter-fade`, `-up`, `-down`, `-left`, `-right`, `-grow`, `-shrink`, `-blur`, `xb-exit-…`) e per il passaggio del mouse (`xb-hover-lift`, `-shadow`, `-glow`, `-scale`, `-bright`, `-fade`, `-underline`), con distanza, curva, durata, sollevamento e ingrandimento dal pannello. Ferme per chi chiede meno movimento e dove il browser non segue lo scorrimento.

## 0.1.47 — 2026-10-29

- Pannello Histos CSS (doc 19), nuova scheda **Moduli e dettagli**:
  - **moduli**: padding, raggio, sfondo, bordo e anello di focus dei campi, peso delle etichette; con «Stili predefiniti dei moduli» valgono anche per i campi senza classe e per i moduli di Fluent Forms, il cui pulsante d'invio diventa come i pulsanti del sito;
  - **accessibilità e dettagli**: anello di focus su tutto il sito, scorrimento morbido, movimento ridotto quando il sistema lo chiede, colore della selezione, stile delle citazioni, colonne di testo (`xb-columns`).

## 0.1.46 — 2026-10-29

- Pannello Histos CSS (doc 19), scheda **Forme**:
  - **pulsanti** da parametri: padding, raggio (fino alla pillola), peso, interlinea, misura del testo, maiuscole, spaziatura, bordo, larghezza minima, a tutta larghezza sui telefoni; ogni famiglia ha il suo pulsante pieno, a contorno, chiaro e scuro, nelle misure da xs a xl;
  - **link**: sottolineatura (sempre, al passaggio, mai), spessore e distanza della linea, stili predefiniti per i link senza classe;
  - **bordo predefinito** (spessore e stile), ombre del testo e `drop-shadow`.
- Al passaggio del mouse un pulsante pieno prende la sfumatura scelta nella palette (600 di partenza; prima era la 700).

## 0.1.45 — 2026-10-29

- Pannello Histos CSS (doc 19), scheda **Spazi**:
  - **sezioni**: moltiplicatore dello spazio verticale (schermo piccolo e grande), padding predefinito, margine laterale in pixel;
  - **spazi fra gli elementi**: fra i figli di una sezione, fra i blocchi, nelle griglie; colonna minima della griglia automatica;
  - **layout**: larghezza minima, altezza dell'intestazione (`--xb-header-height`, `--xb-sticky-top`), ancore sotto l'intestazione;
  - la **griglia dei contenuti** `xb-content-grid`, con le aree contenuto, ampia (`xb-wide`) e piena (`xb-full`).
- Prototipi: il `design` del manifest accetta i parametri di spazi e layout.

## 0.1.44 — 2026-10-29

- Pannello Histos CSS (doc 19), scheda **Testo**:
  - **scala dei titoli separata** (base e rapporto propri per H1-H6);
  - **stile dei titoli**: carattere fra cinque ruoli, peso, interlinea, spaziatura delle lettere, maiuscole, a capo e larghezza massima; **per livello** peso e interlinea (per esempio tutti gli H2 più leggeri). Con «Stili predefiniti dei titoli» valgono anche per gli `h1 … h6` del sito;
  - **testo**: interlinea, a capo, «Stili predefiniti del testo»; **dimensione radice**;
  - due caratteri liberi, **Accento** e **Display**.
- Prototipi: il `design` del manifest accetta i parametri della tipografia; manuale AI e documenti per gli agenti aggiornati.

## 0.1.43 — 2026-10-29

- Pannello Histos CSS (doc 19), nella scheda **Colori**:
  - **Terziario**, una nona famiglia, spenta finché non la accendi; un interruttore spegne anche secondario, accento e famiglie di stato che non usi;
  - **luminosità unica** per le famiglie del marchio o per quelle di stato; **sfumatura al passaggio** (`--xb-primary-hover` e simili);
  - **ruoli dei colori** (sfondo, superfici, testo, titoli, bordo, link, focus) scelti fra famiglie e sfumature, con le **relazioni automatiche di contrasto**: un testo automatico che non si legge passa alla sfumatura più vicina che si legge;
  - **tema scuro** da un interruttore: solo dove c'è `xb-scheme-dark`, sempre scuro o secondo il sistema del visitatore, con il colore in scuro di ogni famiglia. La lista Leggibilità controlla anche il tema scuro.
- Prototipi: il `design` del manifest accetta i nuovi parametri; manuale AI e documenti per gli agenti aggiornati.

## 0.1.42 — 2026-10-29

- Pannello Histos CSS (doc 19): il generatore della sezione Design system è ora lo stesso pannello del cassetto di WordPress e del plugin Histos CSS, scritto una volta sola. Ogni opzione cambiata ha un punto e **↺** per tornare al predefinito; **Cerca un'opzione** trova un'opzione anche con parole inglesi; **Esporta** e **Importa** salvano e rileggono le impostazioni in JSON (solo i valori cambiati, controllati dal server prima di usarli); **Predefiniti** chiede conferma. Le famiglie di colori mostrano sfumature e trasparenze al clic.

## 0.1.41 — 2026-10-29

- Progetti Histos CMS: anche gli articoli portano il loro JavaScript nella pagina costruita, come le pagine.
- Importatore automatico (completo): lo stesso import di Histos Publish gira nel browser, su SQLite per WebAssembly, e scrive il `.xbsite` identico a quello di Publish. Su WordPress il riquadro «Importa HTML» (Release → Histos CMS) lo usa: pagina, ZIP o cartella diventano un progetto, con il controllo del sito prima di scrivere.

## 0.1.40 — 2026-10-29

- Importatore automatico:
  - **Core Framework** è la quarta scelta del framework di arrivo: spazi e misure del testo diventano variabili di Core (`--space-m`, `--text-l`…) quando coincidono con la scala del preset predefinito entro un ventesimo a 1280 px. Le variabili usate sono definite in un foglio del progetto, che Core sostituisce dove è attivo (WordPress);
  - **ricette senza JavaScript come scelta:** con «Senza JavaScript: usa le ricette», menu, fisarmoniche, schede, caroselli e finestre modali diventano HTML e CSS che funzionano anche nel builder, e gli script del sito non vengono tenuti. Senza la scelta restano proposte nel rapporto.

## 0.1.39 — 2026-10-29

- Importatore automatico (primo passo): il convertitore da HTML a prototipo gira anche in un browser, senza Node. Lo stesso sito convertito nel browser e in Histos Publish dà lo stesso prototipo, byte per byte. Serve alla schermata «Importa HTML» di WordPress, che arriverà dopo.
- Un foglio di stile con una mappa sorgente in linea (`sourceMappingURL=data:`) ora si converte invece di essere scartato.
- Importatore automatico: il rapporto della conversione si scarica in JSON dalla finestra di controllo; dopo l'import il progetto conserva i suoi rapporti d'importazione (gli ultimi 20, anche nei backup), con le note e la misura della conversione, scaricabili dalla sua pagina.
- Guida dell'app e manuale AI: come rendere modificabile un sito HTML trascinandolo nel catalogo di Histos CMS.
- Pagina del progetto CMS: l'intestazione compatta non va più avanti e indietro quando la pagina è scorsa fino in fondo.

## 0.1.38 — 2026-10-29

- Progetti Histos CMS: una **sezione JS** per pagine e componenti, come il pannello JS di WordPress. Il JavaScript gira nel sito costruito (come modulo, dopo il contenuto) e nell'anteprima isolata del sito, mai nel builder. Va su WordPress con l'invio solo se l'utente del collegamento ha il permesso `unfiltered_html`; altrimenti Histos si ferma prima di inviare e lo dice.
- Importatore automatico:
  - gli **script del sito** (in linea, del sito e dei CDN, scaricati) restano nella sezione JS della pagina, nell'ordine; gli attributi `onclick` e simili diventano `addEventListener`;
  - un `<dialog>` resta come blocco nascosto e il JavaScript della pagina gli ridà `showModal()` e `close()`; restano anche `hidden` e `tabindex`;
  - il rapporto propone le ricette senza JavaScript per menu, fisarmoniche, schede, caroselli e modali.
- Prototipo: una sezione `scripts` per il JavaScript di pagine e componenti (manuale AI §6.5).
- Pacchetti Linux: i checksum si calcolano un file alla volta, senza esaurire la memoria.
- Richiede Histos su WordPress con la capacità `documents:script:v1` per inviare progetti con JavaScript.

## 0.1.37 — 2026-10-29

- Importatore automatico:
  - le **classi utility** (Tailwind, utility di Bootstrap) diventano una classe BEM per elemento, per esempio `hero__title`, con le stesse regole: varianti responsive in `@media`, stati come `:hover`, nell'ordine dei fogli del sito. Elementi dello stesso blocco con le stesse utility condividono la classe. Una utility che uno script nomina, che un selettore composto usa o per cui la cascata cambierebbe resta com'è, e la finestra di controllo lo dice;
  - gli attributi **`style=""`** diventano CSS della classe dell'elemento, tranne le dichiarazioni che lì perderebbero contro un'altra regola;
  - il CSS va nei selettori con lo stesso `planSheetMove` del builder: ciò che stamperebbe in un altro ordine resta nei fogli, così la cascata è quella del sito;
  - nella finestra di controllo si sceglie il **framework di arrivo**: Histos CSS (preselezionato), Automatic.css o nessuno. Colori, caratteri, misure del testo e spazi diventano variabili del framework quando coincidono con la sua scala entro un ventesimo a 1280 px.

## 0.1.36 — 2026-10-29

- Builder: **Alt+clic** su un link, un grassetto o uno `span` dentro una frase lo rende un elemento con una classe propria (per esempio `hero__link`), già selezionato, da stilare nel pannello CSS. Il resto della frase resta testo, modificabile sul posto.

## 0.1.35 — 2026-10-29

- Importatore automatico: la finestra di controllo della conversione dice quanti elementi del sito si selezionano uno per uno nel builder (per esempio «98% (52 su 53)»).

## 0.1.34 — 2026-10-29

- Builder: nella pagina, intestazione e piè di pagina che vengono dal template (per esempio dopo «Converti in progetto Histos» con le parti) non sono più un punto morto. Un clic dice di quale parte si tratta; un doppio clic la apre e la si modifica sul posto.

## 0.1.33 — 2026-10-29

- Builder: se l'elemento selezionato non ha classi, il pannello CSS propone già un nome, per esempio `hero__title` per un titolo dentro `.hero`. Con il campo vuoto, «Aggiungi classe» usa quello.

## 0.1.32 — 2026-10-29

- Importatore automatico:
  - nel catalogo Histos CMS si può trascinare anche la **cartella** di un sito, oltre a una pagina HTML o a uno ZIP;
  - i fogli di stile presi da un CDN (per esempio Bootstrap) si scaricano e restano, con i font e le immagini che nominano. Le regole che il sito non usa vengono tolte come le altre.

## 0.1.31 — 2026-10-29

- Importatore automatico:
  - un elemento che il CSS del sito stila per posizione (per esempio `.hero h1`) riceve una classe propria, dove scrivono le maniglie del builder;
  - le immagini senza misure le prendono dal loro file;
  - quelle senza testo alternativo ricevono `alt=""`, con una nota per scriverlo;
  - gli attributi `data-*` restano, tranne quelli dei framework di script.
- Sui siti di prova, cinque su sei hanno tra il 98% e il 100% di elementi selezionabili.

## 0.1.30 — 2026-10-29

- Importatore automatico (prima parte): i link e gli elementi in linea che il CSS del sito stila, o che non stanno dentro una frase (le voci di un menu), ricevono una classe propria, come `nav__link`. Così nel builder si selezionano con un clic. Quelli dentro una frase restano parte del testo, modificabile sul posto.
- Sui siti di prova la quota di elementi selezionabili va ora dall'88,5% al 98,8%.

## 0.1.29 — 2026-10-29

- Importatore automatico (prima parte): la conversione di un sito HTML tiene moduli, campi, etichette, pulsanti, `details`/`summary`, `picture`/`source` e le icone SVG statiche. Prima venivano tolti o ridotti al testo. Ogni elemento passa le stesse regole dell'import:
  - un modulo senza indirizzo d'invio punta alla sua pagina;
  - i campi password, file e immagine vengono tolti;
  - delle icone SVG resta il disegno statico.
- Sui siti di prova, gli elementi selezionabili nel builder salgono fino al 97,5%: con i moduli, dal 38% al 96%.
- Le immagini e i font che il sito prende da altri siti (https) si scaricano sempre e diventano media del progetto. Lo scaricamento è protetto: solo indirizzi pubblici, senza reindirizzamenti, al massimo 15 MB ciascuno e 150 MB in tutto. Un'immagine che non si scarica resta fuori con una nota, senza fermare l'importazione. Cinque siti di prova su sei superano ora il 95% di elementi selezionabili.

## 0.1.28 — 2026-10-29

- Importatore automatico, prime due fasi (documento 18):
  - **Importazione diretta:** una pagina HTML o lo ZIP di un sito, trascinati o scelti nel catalogo Histos CMS, diventano subito un progetto, senza passare da «I tuoi siti» e dalla build. Si apre lo stesso controllo con anteprima di «Converti in progetto Histos», con le stesse scelte (struttura, token, caratteri). Il file caricato resta sul computer solo finché il controllo è aperto;
  - **Misura:** sei siti di prova e una misura di quanti elementi restano selezionabili nel builder dopo la conversione. Oggi si va dal 38% al 89%; l'obiettivo è il 95%.

## 0.1.27 — 2026-10-29

- Design system più leggibile (prima fase del pannello Histos CSS, documento 19):
  - i colori si vedono per famiglia: compare il colore principale, e sfumature, trasparenze e colore del testo si aprono con un clic;
  - **Variabili del sito:** con «＋ Variabile» si aggiungono variabili proprie, `--xb-site-<nome>`, accanto a quelle di Histos CSS. Si vedono subito nella tela, finiscono nel CSS del sito e nell'autocompletamento del pannello CSS;
  - **Ricette:** tutte le ricette con la loro origine. Si possono modificare (la versione del progetto sostituisce quella di Histos, ↺ la riporta) e aggiungere; si usano con `@nome`.
- Stessi controlli di sicurezza di WordPress: nomi semplici, valori CSS semplici, ricette senza markup, `url()` o `@import`, al massimo 4 KB.
- Inviando il progetto a WordPress, le variabili del sito viaggiano come foglio globale, quindi il sito le mantiene. Le ricette restano nel progetto.

## 0.1.26 — 2026-10-29

- Selezione di progetti CMS e siti come in un gestore di file:
  - Ctrl+clic (⌘+clic su Mac) sceglie o toglie una scheda alla volta, e avvia la selezione anche quando «Seleziona» è spento;
  - Maiusc+clic sceglie tutte le schede dall'ultima cliccata a questa, nell'ordine a schermo, e le aggiunge a quelle già scelte.
- Il Maiusc+clic non seleziona più il testo delle schede.

## 0.1.25 — 2026-10-29

- Cartelle: i progetti Histos CMS e i siti si raggruppano in cartelle, per esempio le versioni e le proposte dello stesso progetto.
  - «Nuova cartella» accanto a «Seleziona». Le cartelle compaiono sopra l'elenco, con il numero di elementi; dentro una cartella ci sono «Tutti i progetti», «Rinomina…» ed «Elimina la cartella», che riporta il contenuto nell'elenco.
  - Per spostare: si trascina una scheda su una cartella, oppure si usa «Sposta in cartella…» dalla barra di selezione o dal menu del clic destro. Si può spostare in una cartella esistente o in una nuova, oppure fuori dalle cartelle.
- «Seleziona»: si sceglie una scheda cliccandola in qualunque punto, non solo sulla casella. Esc esce dalla selezione.

## 0.1.24 — 2026-10-29

- Cestino: i progetti Histos CMS e i siti eliminati non spariscono subito, vanno nel Cestino (nuova voce nel menu laterale, con il numero di elementi).
  - Ogni elemento si ripristina com'era per 30 giorni con «Ripristina».
  - «Elimina definitivamente…» lo toglie per sempre; anche qui serve il nome esatto, copiato e incollato. «Svuota il Cestino…» fa lo stesso con tutti.
  - Dopo 30 giorni Histos Publish li elimina da solo, all'avvio.
- Un progetto nel Cestino perde subito le sue build, che si rifanno quando serve. Un sito nel Cestino conserva build e credenziali nel portachiavi finché non lo si elimina per sempre.

## 0.1.23 — 2026-10-29

- Si possono eliminare i progetti Histos CMS e i siti di «I tuoi siti», uno o molti alla volta:
  - con «Seleziona», che mette una casella su ogni scheda e mostra una barra con «Elimina i selezionati»;
  - oppure dal menu che si apre con il clic destro su una scheda (Apri, Seleziona, Elimina…).
- La conferma vuole il nome esatto di ogni elemento, copiato con «Copia il nome» e incollato accanto. Il pulsante resta spento finché i nomi non coincidono tutti.
- Un progetto CMS non si elimina mentre una sua pubblicazione è in corso, né quando un sito lo usa come sorgente: prima va eliminato il sito.
- Di un sito si tolgono anche le credenziali salvate nel portachiavi.
- Il sito pubblicato e WordPress restano come sono.

## 0.1.22 — 2026-10-29

- Histos CMS: pagine e articoli in due schede. In «Articoli» i filtri sono istantanei:
  - la categoria si sceglie con un clic e comprende le sue sottocategorie; quando ce ne sono, compare la scelta della sottocategoria;
  - si filtra anche per tag e per stato, e si cerca nel titolo, nell'indirizzo e nel riassunto (anche senza accenti);
  - gli articoli si ordinano dal più recente o per titolo;
  - si vedono 24 schede alla volta, con «Mostra altri».
- La scheda scelta resta nell'indirizzo (`#/cms/<id>/articoli`).

## 0.1.21 — 2026-10-28

- Agente AI: nella scheda «ChatGPT desktop» c'è un messaggio pronto da incollare nella chat di ChatGPT. Se ChatGPT può eseguire comandi, registra da solo il server in `~/.codex/config.toml` e lo controlla con `/mcp`. Se non può aggiungere server MCP, usa la riga di comando del connettore. Seguono, come strade a mano, il modulo di ChatGPT e il blocco TOML.

## 0.1.20 — 2026-10-28

- Histos CMS: il pulsante «Anteprima del sito» apre tutto il sito navigabile, in una finestra dell'app; rifà la build solo se il progetto è cambiato. L'anteprima resta aperta finché la si naviga e scade 5 minuti dopo l'ultima pagina chiesta.
- Editor: le immagini del progetto si vedono anche nell'app desktop. Gli elementi della pagina si selezionano di nuovo dalla tela, con le cornici e le proprietà.
- Editor (builder aggiornato): pannello «Ricette» con l'anteprima sulla tela, 75 ricette CSS con nomi alternativi, ricette JavaScript e una seconda Mini GUI, da scegliere accanto a quella di Histos.
- Import dei prototipi e conversione dei siti: le regole di ogni blocco usato passano dai fogli globali al suo selettore, annidate come in SCSS, con la cascata invariata.
- Agente AI: si collega anche l'app desktop di ChatGPT, dal suo modulo «Server MCP» o con la configurazione condivisa con Codex. Il manuale dei prototipi è riscritto per i modelli piccoli: 7 passi, kit, regole, trappole e riferimento completo.
- Il numero di versione è uno solo, per app, CLI, agente e archivi.

## 0.1.15 — 2026-10-26

- Unione del ramo di lavoro Histos CMS con `main`: tornano la verifica degli Account API Token con l’ID account, la guida in-app «Dal sito al dominio» e il pulsante HP che riporta ai siti invece di chiudere la sessione.
- Correzioni di sicurezza nel crawler, nel rendering isolato, nei trasferimenti CMS, nel provisioning di WordPress e nell’avvio con codice monouso.
- Pacchetto `.xbsite` v2 profilo v4: articoli con categorie e tag, ruoli dei template (home, articolo, archivi, 404…), build statico con `/blog/`, archivi e `404.html`; un pacchetto importato da file riporta le sue basi comuni.
- Windows: rinomina dei file di progetto ritentata quando un’altra lettura li tiene aperti, installer che nomina l’archivio danneggiato, interfaccia che non sovrascrive più l’ultima azione con caricamenti tardivi.

## 0.1.14 — 2026-10-23

- Completa la pubblicazione verso hosting e VPS con SFTP; restano disponibili FTP e FTPS già presenti.
- Per SFTP usa il client `ssh2` integrato nell’app su Linux, macOS e Windows; supporta password o chiave privata SSH e mostra l’impronta del server prima dell’autenticazione. L’utente deve confrontarla e confermarla.
- Conserva le credenziali nel portachiavi locale, carica soltanto i file della build e lascia sul server eventuali file che non fanno più parte del sito.
- Prima di confermare un invio a WordPress, dichiara che Histos Publish non può ripristinare automaticamente i contenuti inviati e che gli hook dei plugin possono produrre effetti esterni.

## 0.1.13 — 2026-10-23

- Consente di acquisire siti Local e altre sorgenti locali con un’autorizzazione separata, limitata all’origine esatta.
- Mantiene il blocco per gli host pubblici che risolvono a indirizzi privati, per le risoluzioni DNS miste e per le destinazioni private diverse dall’origine autorizzata.
- Richiede che la conferma di lettura corrisponda all’origine mostrata nell’interfaccia.

## 0.1.12 — 2026-10-23

- Avvia il server locale di Histos su una porta libera scelta nell'intervallo dinamico 49152–65535, evitando le porte web standard usate da Local.
- Se la porta scelta è già occupata, prova altre porte disponibili prima di interrompere l'avvio.

## 0.1.11 — 2026-10-22

- Aggiunge l’agente Linux opzionale per richieste Histos firmate, crawl in modalità export, scanner, pubblicazione e rollback su un Worker dedicato. Token Cloudflare e chiavi HMAC restano nell’agente.
- Aggiunge configurazione AJV, CLI `agent` e `agent-key`, schema JSON, guida systemd/Docker e un’analisi delle minacce per l’agente.
- Verifica l’agente con vettori HMAC, fixture HTTP e mock Cloudflare locali; nessun account Cloudflare o sito WordPress reale è stato contattato.
- Aggiunge l’add-on Local e il collegamento sicuro `histos-publish://` per aprire in Histos il sito Local selezionato.
- Controlla gli ZIP prima dell’importazione, rimuove automaticamente la cartella radice comune e segnala quando una sorgente modificata richiede una nuova build.
- Dopo la pubblicazione controlla che la home risponda come HTML e avvisa se il browser rischia di scaricare un file.
- Chiarisce nell’interfaccia e nelle guide la differenza fra pagine generate durante una build Etch e funzioni che restano attive durante la visita.
- Aggiorna le guide per l’adapter Fluent Forms; Fluent SMTP resta un servizio separato configurato in WordPress.

## 0.1.10 — 2026-10-22

- Esegue il Worker prima di servire la home e `index.html`, così gli header HTML vengono applicati e il browser mostra il sito invece di scaricarlo.

## 0.1.9 — 2026-10-22

- Aggiunge la sostituzione della sorgente di un progetto con un file HTML o un archivio ZIP, anche se il file HTML non ha estensione.
- Mostra il nome del file sorgente attuale e mantiene le sorgenti precedenti nell’archivio locale.
- Verifica che il Worker indicato esista nell’account Cloudflare prima di collegare un dominio.
- Serve la home HTML con un tipo di contenuto corretto e rimuove l’intestazione che la forza come download.

## 0.1.1 — 2026-10-22

### Corretto

- Aumentate le dimensioni dei testi dell’interfaccia: il corpo usa 16 px, i testi principali 15–16 px e note, metadati ed etichette almeno 14 px.
- Ingranditi i pulsanti piccoli e le voci di navigazione su schermi stretti; i nomi lunghi nell’intestazione vengono abbreviati senza sovrapporsi ai comandi.

### Verifica locale

- `npm run validate`: 48 test, typecheck, Svelte check, lint e tre prove E2E verdi.
- `.deb` e AppImage Linux x64 ricostruiti; lo smoke test dell’app impacchettata ha completato avvio, build locale ed export ZIP.

## 0.1.0 — 2026-10-22

### Aggiunto

- Indice di ricerca statico Pagefind facoltativo, disattivato per default.
- Collegamento opt-in dei moduli Contact Form 7 configurati, con verifica Turnstile sul Worker.
- Chiave segreta Turnstile nel portachiavi locale e binding segreto Cloudflare al deploy.
- CLI `turnstile-secret` per salvare o rimuovere la chiave nel portachiavi.
- Guide per installazione Linux e Windows e preparazione del primo deploy.
- Fluent SMTP documentato come trasporto scelto in WordPress tramite `wp_mail()`; Histos Publish non gestisce credenziali SMTP o provider email.

### Sicurezza e provenienza

- Limiti rigidi per dimensione del form, campi, origine e ID CF7; niente retry automatico.
- Provenienza aggiornata per Pagefind 1.5.2 e i binari di piattaforma; licenza MIT registrata nella allowlist esistente.
- Creazione dell’AppImage su file temporaneo e sostituzione atomica del pacchetto, anche quando una copia precedente è ancora aperta.

### Verifica locale

- `npm run validate`: 48 test, typecheck, lint, 2 E2E web e 1 E2E Electron verdi.
- `npm audit --audit-level=moderate`: nessuna vulnerabilità.
- `npm run provenance`: 230 pacchetti conformi all’allowlist.
- AppImage e `.deb` Linux x64 generati con checksum SHA-256 e smoke test del payload.
- Nessun deploy Cloudflare reale, invio a WordPress o email reale. La build Windows è configurata ma non è stata eseguita su Windows.
