# Matrice di compatibilità dell’editor Histos

Aggiornata: 16 novembre 2026. Questa matrice confronta i metodi upstream di `packages/cms/vendor/histos/editor/src/lib/api.ts`, le aggiunte alla superficie API introdotte da `local-cms.patch`, i loro usi nell’interfaccia e l’adapter in `packages/server/src/cms-api.ts`. La snapshot fissata è quella di `packages/cms/vendor/histos/UPSTREAM.md` (dal 16 novembre 2026 Histeon 0.5.15, commit `6dd9f79`); le aggiunte standalone sono riproducibili senza modificare i sorgenti upstream.

**Legenda:** `Sì` = rotta locale e flusso verificati; `Parziale` = solo i tipi/casi indicati; `No` = API esclusivamente WordPress o funzione non esposta dal CMS locale. Un metodo del client che non ha una rotta locale non viene trattato come successo implicito. Le voci `No` sono nascoste nell’interfaccia o restano fuori dai flussi standalone. `core()` appartiene soltanto a `WordPressBackend` e non fa parte del contratto `BuilderBackend` locale.

## Documenti, rendering e preview

| Metodo builder | API Histos WordPress | CMS standalone | Schermata/uso locale |
|---|---|---|---|
| `getDocument(id)` | `GET documents/{id}` | **Sì** — pagina, componente, template e template part con alias numerico | Apertura e ricaricamento dal builder |
| `saveDocument(id, …)` | `POST documents/{id}` | **Sì** — revisione e conflitto `409`; contenuto e metadati del componente | Salva in sviluppo |
| `render(id, content)` | `POST render` | **Sì** — renderer locale, dati/media del progetto e limiti dichiarati | Canvas e anteprima interna |
| `sanitizePaste(content, styles)` | `POST paste/sanitize` (livello ristretto) | **Sì** — `POST paste/sanitize` prende intero o rifiuta, con il primo motivo: il contenuto come lo leggerebbe un trasferimento del progetto (`checkPastedContent`), gli stili senza risorse né commenti (`checkPaste`). `413 cms-paste-too-large` oltre 128 KiB, `422 cms-paste-markup` / `cms-paste-styles`, `400` per un corpo non valido. Non filtra in qualcos’altro | Incolla di HTML e clip da fuori della scheda; ciò che la scheda ha copiato si reincolla senza controllo, come nel builder |
| `previewLink(id)` | `GET preview-link` firmato WP | **Sì, solo pagine** — `POST build` con `previewAlias`; crea una preview temporanea e privata. La copia non viene registrata tra le build distribuibili | Pulsante Anteprima e comando palette solo per pagine. Componenti/template non anteprimabili sono esclusi dalla UI. Dalla 0.5.14 il builder offre durata e «Copia link» del link firmato di WP: nel CMS locale `local-cms.patch` non passa `relink` all’anteprima, e quel gruppo non compare |
| `createComponent(ref, …)` | `POST components` | **Sì** — componenti con schema props | “Nuovo componente” |
| `listComponents()` | `GET components` | **Sì** | Completamento e inserimento componenti |
| `library(type, search)` | `GET library` | **Parziale** — `page` e `wp_block`; `post` risponde `422 cms-capability-unavailable` perché record e tipi relazionali hanno il proprio pannello | Pagine e componenti nel catalogo builder |
| `core(method, route)` | REST WordPress `wp/v2` | **No** — metodo disponibile soltanto su `WordPressBackend`, non esposto da `LocalBackend` | Tabelle WordPress non sono esposte nel CMS standalone |

**Incollare da fuori (`paste/sanitize`, 28 ottobre 2026).** Da allora il builder manda al server ogni incolla che la scheda non ha copiato da sé (HTML o clip `{"xb":"clip",…}`) e non incolla nulla se il controllo fallisce. Il CMS locale lo legge con le stesse regole di un trasferimento del progetto (`normalizeContentForTransfer`, come un componente: radici `props`, `slots`, `page`, `this`):
- nessuna riparazione di `parseXb` (HTML libero fra i blocchi, tag in maiuscolo, rami fuori posto, blocchi sconosciuti), rami come sono scritti (`checkTransferBranches`), solo i blocchi che un trasferimento porta (niente `xb/raw`, `xb/passthrough`, `xb/post-content`), `histos-transfer-markup-v1`, componenti e query del progetto;
- media solo di questo progetto (`/__cms-media/<progetto>/<asset>`, `histos-media://` dei suoi asset immagine) o `{props.x}` intero in `src`; niente URL esterni, `javascript:` o `data:` in `src` e `srcset`;
- più stretto di un trasferimento: un attributo d'indirizzo (`href`, `src`, `srcset`, `action`, `cite`, `poster`, `data`…) è dinamico solo come un dato intero (`{post.url}`, `{props.link}`): niente letterali, modificatori, operatori, indici o testo attorno alle graffe. Il dato letto è del sito, e la build rifiuta comunque uno schema attivo nell'indirizzo che stampa (`safeUrlAttribute`). Un `<form>` incollato manda i dati solo a un percorso di questo sito: un `action` assoluto o `//host` è rifiutato (su WordPress il livello ristretto non scrive moduli);
- **dimensione:** al massimo 128 KiB di contenuto (`PASTE_MAX_CONTENT_BYTES`), oltre `413`. Il limite tiene sotto il secondo anche il caso peggiore della lettura dei blocchi, che segue la grammatica di WordPress.

Non passa dal controllo ciò che si scrive o si incolla nei pannelli del codice (HTML, CSS): è testo che l'utente scrive, e il documento salvato resta soggetto ai controlli della build e del trasferimento.

La preview standard, senza `previewAlias`, comprende esclusivamente pagine pubblicate e può essere registrata per il deploy. La preview di una bozza include la pagina richiesta, usa un ticket casuale con scadenza, e non è accettata da `/deploy`. Il test API prova sia la visualizzazione della bozza sia il rifiuto del deploy. La rotta del server continua a servire il bundle in sola lettura e con CSP.

## Pubblicazione, versioni e trasferimenti del builder WP

| Metodo builder | CMS standalone | Motivo / alternativa |
|---|---|---|
| `getChanges()` | No | Il CMS conserva revisioni SQLite; non usa il confronto dev/prod WordPress |
| `exportRelease(id)` | No | Export release WordPress non disponibile |
| `importRelease(data, write)` | No | Import release WP non disponibile |
| `diffChange(doc)` | No | Diff release WP non disponibile |
| `listReleases()` | No | La cronologia del progetto è gestita dal repository locale, non dall’API release WP. Dalla 0.5.14 il builder la chiama anche all’apertura di una pagina, per l’avviso della release programmata: `local-cms.patch` salta la chiamata nel CMS locale |
| `publish(version, notes, docs)` | No | L’azione “Pubblica” WP è disattivata. Build e deploy si avviano dalla UI Publish e dalle API CMS dedicate |
| `scheduleRelease(at, version, notes, docs)` | No | «Programma per…» è nella finestra Pubblica di WP, che il CMS locale non mostra (`canPublish` è `false`) |
| `cancelSchedule(last)` | No | Come `scheduleRelease()`: nel CMS locale non c’è una release programmata |
| `restore(id, keepContent)` | No | Restore di release WordPress non disponibile |
| `deployStatus()` | No | Stato deploy gestito dalla UI Publish |
| `deploy()` | No | Deploy gestito dalle destinazioni Publish; il builder non deve invocare un deploy WP |
| `rollbackDeploy(id)` | No | Rollback della cronologia deploy WP non disponibile |
| `openTemplate(type, id)` | Non usato | La lista locale restituisce template e parti custom con `post` alias numerico; l’editor apre direttamente quel documento. Non esistono file di tema WordPress da materializzare con questa API |

Il rifiuto delle API release/deploy Histos non disabilita la pubblicazione del progetto: evita che il builder mostri un secondo flusso WordPress mentre Histos Publish gestisce build, destinazione e stato del sito.

## Template, contenuti e query

| Metodo builder | CMS standalone | Motivo / alternativa |
|---|---|---|
| `listTemplates()` | **Sì** | Elenca template e template part custom del progetto, con alias apribili |
| `getQueries()` | **Sì** | Legge preset query del CMS SQLite |
| `saveQueries(presets, …)` | **Sì** | Salva preset e sorgenti JSON con revisione attesa |
| `testQuery(id, preset, params)` | **Sì** | Prova i preset contro dati locali |
| `queryOptions(type)` | **Sì** | Opzioni per i tipi e i filtri supportati dall’API CMS |
| `getNamedQueries()` / `saveNamedQueries()` | No | API named-query del sito WP; compare nel pannello selettori che resta nascosto. Il CMS locale usa i preset del progetto |
| `getFacets()` / `saveFacets()` / `testFacet()` | No | Facets Histos WP non esposti dal backend locale; pannello Filtri nascosto |
| `moveContentItems(type, action, to)` | No | Sposta o cestina i record orfani dal pannello Campi del ContentHub WP, nascosto nel CMS locale |
| `queryTerms(taxonomy, search, include)` | No | Ricerca dei termini del generatore di query di WP (`queries/terms`); nel CMS locale i termini vengono dalle API del progetto |
| `sourceHosts()` / `saveSourceHosts()` / `testSource()` | No | Indirizzi ammessi e prova delle sorgenti da un indirizzo del sito WP; il CMS locale usa le sorgenti JSON del progetto |
| `agentScopes()` / `saveAgentScopes()` | No | Permessi dell'agente del builder sui contenuti del sito WP; in Publish i permessi dell'agente stanno nel connettore dell'app |
| `searchContent()` / `getAgentContent()` / `updateAgentContent()` | No | Contenuti WP che l'agente del builder legge e cambia (`agent/contents`); in Publish l'agente lavora con gli strumenti `hp_*` |
| `getContent()` / `saveContent()` | No | ContentHub e definizioni legate al backend WP non sono l’API dati standalone. Tipi, campi, record, relazioni e tassonomie si gestiscono con le API CMS del progetto |

**Nomi e loop uguali a WordPress (2 novembre 2026, Publish 1.20.2).** Dalla 0.3.2 Histos per WordPress legge i nomi di Publish:
- `page` è la radice, e `props.page` in un componente;
- un articolo ha `publishedAt`, `updatedAt`, oltre a `date`;
- un termine ha `label`, oltre a `name`.

`limit` e `offset` di un loop valgono su ogni query, con le stesse precedenze di `resolveQueryPreset`: un parametro proprio della query vince su `limit`, `offset` vince sempre. `getQueries()` del CMS locale scrive il limite e l'offset come li scrive WordPress, `"$limit ?? N"` e `"$offset ?? N"`. Rileggendoli, `$limit` e `$offset` sono gli argomenti del loop, non parametri della query.

La presenza di `queryOptions()` nell’API builder non abilita ogni filtro del runtime WP. Le capabilities esposte da `/bootstrap` restano autoritative: per esempio i filtri autore non sono dichiarati disponibili nel profilo corrente.

## Stili, framework e selettori

| Metodo builder | CMS standalone | Schermata/uso locale |
|---|---|---|
| `getStyles()` / `saveStyles()` | **Sì** | CSS per selettore e fogli globali nel pannello CSS |
| `getFonts()` / `importGoogleFont(family, weights, italic)` / `removeFont(family)` | **Sì** | Pannello Font del Design system (dal 2 novembre 2026, 1.21.0). I font sono media WOFF2 del progetto. Le regole `@font-face` stanno fuori dal documento degli stili (`project_meta`, `fonts.sheet`), così il CSS dell'editor non va in conflitto. Tela, build e invio le aggiungono come foglio globale `histos-fonts`, e un progetto ricevuto le rimette al loro posto. Google Fonts solo dall'elenco del builder, con la licenza verificata (OFL, Apache, UFL), una richiesta per peso, latin e latin-ext. Togliere una famiglia lascia i file fra i media |
| `setSafelisted(name, on)` | No | Safelist del sito WP (Impostazioni → Histos), dal pannello Stili e selettori, nascosto nel CMS locale |
| `videoInfo(url)` | **Sì** | Finestra Video (dal 2 novembre 2026, 1.21.0): YouTube o Vimeo come in `Media/Video.php`. Il titolo viene da oEmbed, il lettore da youtube-nocookie o player.vimeo, la copertina solo da `i.ytimg.com` o `i.vimeocdn.com`, scaricata una volta nei media. Sul sito pubblicato da Publish il riquadro `[data-xb-video]` ha il suo aspetto e diventa il lettore al clic (`video-player.ts`) |
| `uploadAsset(file, filename, mimeType)` | **Parziale** | `POST media` aggiunge al progetto immagini supportate e font WOFF/WOFF2/TTF/OTF verificati; il client riceve `asset_id` e URL del media. Il CMS non accetta CSS, SVG o altri formati come allegati CSS |
| `getFramework()` | **Sì** | Histos CSS e inventario di classi/variabili dei fogli utente importati |
| `getTokens()` / `saveTokens()` | **Sì** | Design system e override Histos CSS |
| `previewDesign()` | **Sì** | Anteprima dei parametri prima del salvataggio |
| `designTokens()` | **Sì** | `POST design/preview` con `tokens: true`: tutti i token stampati, tema chiaro e, se acceso, scuro (`histosExportTokens`). Serve a «Esporta i token (DTCG)» e a «Importa i token (DTCG)» del pannello Histeon CSS |
| `listSelectors()` / `renameSelector()` / `deleteSelectors()` | No | Manager di selettori WP; non necessario per modificare i CSS del progetto. Il pannello “Stili e selettori” è nascosto nel builder standalone |
| `getNamedQueries()` / `saveNamedQueries()` | No | Associati allo stesso pannello WordPress-only |

Il pannello “Design system” e gli editor HTML/CSS restano visibili perché sono collegati a `/tokens`, `/design/preview`, `/styles` e `/framework`. Non leggono né scrivono le impostazioni di ACSS o Core Framework in WordPress: il CSS fornito dall’utente conserva la propria provenienza e licenza dichiarata. L’import guidato conserva senza riscriverlo il preset Core `.core`/`.json`; per Core Framework **1.1.0** il generatore offline supporta soltanto le parti esplicitamente verificate e interrompe la generazione quando incontra strutture o regole non supportate. Non copre tutte le opzioni manuali/PostCSS né versioni diverse. Per ACSS, il JSON settings resta opaco e trasferibile: il CSS va esportato o rigenerato nell’ambiente ACSS e importato come foglio utente.

L’import guidato conserva inoltre i preset Core Framework `.core`/`.json` in `source.preset` e usa solo l’eventuale `cssString` incluso oppure la generazione offline parziale per Core Framework 1.1.0. Preset, CSS esterno scelto dall’utente e configurazione ACSS vengono trasferiti senza normalizzazione; quando un generatore non copre il preset, il CSS esportato dal framework resta necessario per ottenere la resa completa.

## Funzioni legate al profilo utente o a WordPress

| Metodo builder | CMS standalone | Stato UI |
|---|---|---|
| `extensions()` | No | `InsertMenu` e `HtmlPanel` non chiamano il registro estensioni WordPress in modalità locale; le completions usano solo le funzioni base |
| `saveShortcuts()` | No | Il comando “Scorciatoie da tastiera” è nascosto; impostazioni personalizzate del profilo WP non vengono salvate nel progetto |
| `reviewComments()` / `setCommentStatus()` / `deleteComment()` | No | Pannello commenti e conteggio commenti sono nascosti/disattivati |
| `listSections()` / `saveSection()` / `getSection()` / `deleteSection()` / `exportSections()` / `importSections()` | No | Libreria di sezioni globale del sito WP; la voce “Libreria” è nascosta |
| `getAgentSessions()` / `agentSession(user, …)` | No | Sessioni dell'agente AI con «Tieni» e «Annulla tutto»: versioni del sito WP; la barra non compare nel CMS locale |
| `getSiteScripts()` / `saveSiteScripts(scripts, …)` | No | Script del sito, nelle impostazioni del sito WP; la sezione resta chiusa senza dati |
| `fluentForms()` | No | In `BuilderConfig` locale `fluentForms` è `false`; il menu limita gli snippet alle strutture statiche. Fluent Forms resta una funzione d’integrazione WordPress, non un database locale |

## Copertura automatica associata

| Verifica | Evidenza locale |
|---|---|
| Metodi chiave del builder e forma dati libreria/template | `packages/server/test/cms-api.test.ts`: test API standalone |
| Copertura integrale dell’API pubblica nella matrice | `npm run check:histos-api-matrix`: tutti i metodi pubblici della snapshot devono comparire nella prima colonna di una riga tabellare con stato esplicito; rileva anche righe che citano metodi non presenti nella snapshot |
| Preview bozza, URL privato e blocco del deploy | `packages/server/test/cms-api.test.ts`: la bozza appare nella preview, non nel build pubblico; la preview-only build risponde `cms-build-missing` al deploy |
| UI builder, azioni WP-only nascoste, contenuti e template | `tests/e2e/cms-editor.spec.ts`; verifica inoltre che le aperture dell’editor non chiamino endpoint WordPress-only (`/extensions`, release, sezioni, query, filtri, selettori, contenuti WP e REST `wp/v2`) |
| Patch upstream applicabile e bundle builder | `node packages/cms/build-editor.mjs` e build root |

La matrice completa l’inventario del **client API del builder**. Il controllo automatico verifica che ogni metodo pubblico della snapshot fissata sia classificato in una riga con stato esplicito, e segnala anche metodi non più presenti nella snapshot. La revisione umana resta necessaria per confermare capability e comportamento, non soltanto i nomi. La matrice non dimostra parità dell’intero runtime Histos: blocchi, espressioni, modifier, limiti e trasferibilità hanno prove proprie. I round-trip su installazioni WordPress di staging restano un gate distinto.
