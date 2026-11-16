<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { Bootstrap, Site } from "../lib/app-types.js";

  /** The quick guide. */
  let { language, act, beginNewSite, bootstrap, busy, loadSettings, openSite, sites }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    beginNewSite: () => void;
    bootstrap: Bootstrap;
    busy: boolean;
    loadSettings: () => Promise<void>;
    openSite: (id: string, navigateToSite?: boolean) => Promise<void>;
    sites: Site[];
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
</script>

<section class="page-wrap narrow guide-page">
  <div class="page-heading"><div><div class="eyebrow">{say("GUIDA RAPIDA", "QUICK GUIDE")}</div><h1>{say("Dal sito al dominio, passo per passo", "From your site to your domain, step by step")}</h1><p>{say("Imposta Cloudflare una volta, pubblica la copia e collega il dominio quando sei pronto. Histeon ti accompagna senza chiederti modifiche DNS a mano.", "Set up Cloudflare once, publish your copy, and connect the domain when you are ready. Histeon guides you without asking you to edit DNS by hand.")}</p></div></div>

  <div class="guide-steps">
    <article class="panel-card guide-step" data-testid="guide-admin">
      <div class="guide-step-head"><span class="guide-step-number" aria-hidden="true">★</span><div><div class="eyebrow">{say("DENTRO IL SITO", "INSIDE THE SITE")}</div><h2>{say("Amministra il sito e le sue lingue", "Manage the site and its languages")}</h2></div></div>
      <p>{say("Apri un sito dalla schermata iniziale: a sinistra hai pagine, articoli, contenuti, media, aspetto, pubblicazione, lingue e impostazioni; in alto a destra, sempre, Anteprima e Pubblica. Ctrl+K cerca in tutto il sito; j e k scorrono una tabella, Invio apre, e porta al builder.", "Open a site from the home screen: on the left are pages, posts, content, media, appearance, publishing, languages and settings; top right, always, Preview and Publish. Ctrl+K searches the whole site; j and k move through a table, Enter opens, e goes to the builder.")}</p>
      <ul class="guide-list">
        <li>{say("Articoli: si scrivono come testo, senza HTML. «/» aggiunge un blocco (titolo, elenco, citazione, immagine), una selezione mostra grassetto, corsivo e link, si salva da solo. L'aspetto viene dal Modello degli articoli, uguale per tutti.", "Posts are written as text, without HTML. “/” adds a block (heading, list, quote, image), a selection shows bold, italic and link, and it saves by itself. The look comes from the Article template, the same for all.")}</li>
        <li>{say("Da WordPress: in Nuovo sito scegli il file di Strumenti → Esporta. Funziona con qualsiasi sito; moduli, video incorporati e shortcode restano fuori e te lo dico.", "From WordPress: in New site choose the file from Tools → Export. It works with any site; forms, embedded videos and shortcodes stay out and I tell you so.")}</li>
        <li>{say("Lingue: aggiungi una lingua, poi «Traduci» accanto a una pagina crea una bozza nella sua cartella, per esempio /en/.", "Languages: add a language, then “Translate” next to a page creates a draft in its folder, for example /en/.")}</li>
        <li>{say("Una traduzione segue l'originale: quando cambia, vedi le frasi cambiate e «Aggiorna la bozza». Una pubblicata non si tocca da sola.", "A translation follows its original: when that changes, you see the changed sentences and “Update the draft”. A published one never changes by itself.")}</li>
        <li>{say("I testi di menu e piè di pagina si traducono una volta sola, in Lingue. Il selettore di lingua è nel menu Inserisci del builder.", "Menu and footer texts are translated once, in Languages. The language switcher is in the builder's Insert menu.")}</li>
        <li>{say("Con l'indirizzo del sito nelle Impostazioni la versione scrive anche sitemap e link hreflang completi.", "With the site address in Settings the build also writes the sitemap and full hreflang links.")}</li>
      </ul>
    </article>
    <!-- Doc 23 items 188 and 191: everything about a linked WP site is in the site itself. -->
    <article class="panel-card guide-step" data-testid="guide-wordpress">
      <div class="guide-step-head"><span class="guide-step-number" aria-hidden="true">WP</span><div><div class="eyebrow">{say("DENTRO IL SITO", "INSIDE THE SITE")}</div><h2>{say("Collega il sito a WP e all'agente AI", "Link the site to WP and to the AI agent")}</h2></div></div>
      <p>{say("Tutto ciò che riguarda un sito WP collegato sta nel sito stesso, in Pubblica → Siti Histeon collegati.", "Everything about a linked WP site is in the site itself, under Publish → Connected Histeon sites.")}</p>
      <ul class="guide-list">
        <li>{say("Abbina il sito con il codice che Histeon ti dà in WP, poi «Scarica aggiornamenti» porta qui le modifiche fatte sul sito e «Invia in sviluppo» manda le tue: vanno online solo con una release in WP.", "Pair the site with the code Histeon gives you in WP, then “Download updates” brings here the changes made on the site and “Send to development” sends yours: they go live only with a release in WP.")}</li>
        <li>{say("«Invio dell'agente AI a questo sito» dice se l'agente può inviare: Mai, Solo prove (vede cosa cambierebbe sul sito, ma non invia nulla), Con la mia conferma (ti chiede ogni invio) o Senza chiedere. Si salva appena scegli e compare «✓ Salvato». La schermata Agente AI lo mostra soltanto, con «Cambia nel sito».", "“AI agent sends to this site” says whether the agent may send: Never, Trial runs only (it sees what would change on the site, but sends nothing), With my confirmation (it asks you each time) or Without asking. It saves as soon as you choose and “✓ Saved” appears. The AI agent screen only shows it, with “Change in the site”.")}</li>
        <li>{say("Dopo il primo invio con pubblicazione, Publish ti chiede se il sito deve aprirsi sulla home del progetto e, se il progetto ha una pagina «blog», elencare lì gli articoli. Cambia il sito online solo se rispondi sì; con «No, lascia così» non te lo chiede più.", "After the first send with publishing, Publish asks you whether the site should open on the project's home and, if the project has a “blog” page, list the posts there. It changes the live site only if you say yes; with “No, leave it” it does not ask again.")}</li>
        <li>{say("«Scollega» toglie il collegamento; il sito in WP resta com'era.", "“Disconnect” removes the link; the WP site stays as it was.")}</li>
        <li>{say("«Controlla il sito WP» rilegge il sito come prima di un invio, senza cambiare nulla, e dice per nome cosa non può viaggiare, perché e cosa fare: ciò che ferma l'invio e ciò che resta fuori. Si corregge in WP e si ricontrolla.", "“Check the WP site” reads the site as a send would, without changing anything, and names what cannot travel, why and what to do: what stops the send and what stays out. Fix it in WP and check again.")}</li>
        <li>{say("Se un contenuto è cambiato sia qui sia in WP, è un conflitto: «Risolvi i conflitti» li mostra per tipo, con le due versioni a confronto, e per un gruppo intero o per uno solo scegli «Tieni quella del progetto» o «Tieni quella del sito».", "If an item changed both here and in WP, it is a conflict: “Resolve the conflicts” shows them by type, with the two versions side by side, and for a whole group or one item you choose “Keep the project’s” or “Keep the site’s”.")}</li>
        <li>{say("Nella revisione dell'invio, «Solo sul sito» elenca per tipo e titolo i contenuti che il sito ha e il progetto no: l'invio non li tocca. Scegli quelli che ti servono e «Porta nel progetto» li scarica, con ciò che serve loro.", "In the send review, “Only on the site” lists by type and title the items the site has and the project does not: the send leaves them alone. Choose the ones you need and “Bring into the project” downloads them, with what they need.")}</li>
        <li>{say("Se l'invio si ferma su un contenuto del sito che non può viaggiare, il messaggio lo nomina: si corregge in WP e si riprova.", "If a send stops on content of the site that cannot travel, the message names it: fix it in WP and try again.")}</li>
      </ul>
    </article>

    <article class="panel-card guide-step">
      <div class="guide-step-head"><span class="guide-step-number">1</span><div><div class="eyebrow">{say("UNA VOLTA SOLA", "ONE TIME")}</div><h2>{say("Collega Cloudflare", "Connect Cloudflare")}</h2></div><span class="guide-state" class:complete={bootstrap.token.configured && Boolean(bootstrap.accountId)}>{bootstrap.token.configured && bootstrap.accountId ? say("Accesso salvato", "Access saved") : say("Da configurare", "Set up needed")}</span></div>
      <p>{say("Per usare un solo Worker, crea un Account API Token e assegna i permessi soltanto alle risorse che Histeon deve gestire.", "To use one Worker, create an Account API Token and grant access only to the resources Histeon needs.")}</p>
      <ul class="guide-list">
        <li>{say("Policy Worker: Workers specifici → scegli il Worker già creato → Editor.", "Worker policy: Specific Workers → choose the existing Worker → Editor.")}</li>
        <li>{say("Per collegare il dominio in automatico, aggiungi una policy Developer Platform → Workers Scripts Write con ambito account. È un permesso più ampio del singolo Worker e può modificare tutti i Worker dell’account; concedilo solo se ti va bene.", "To connect a domain automatically, add a Developer Platform → Workers Scripts Write policy scoped to the account. It is broader than a single Worker and can modify all Workers in the account; grant it only if you accept that.")}</li>
        <li>{say("Aggiungi anche una policy Domini specificati sulla sola zona → Zone Read e DNS Read. DNS Write serve soltanto se Histeon deve sostituire un CNAME in conflitto, e te lo chiede prima.", "Also add a Specific domains policy for that zone only → Zone Read and DNS Read. DNS Write is needed only if Histeon must replace a conflicting CNAME, and it asks first.")}</li>
        <li>{say("In Impostazioni incolla l’Account ID (non lo Zone ID) e il valore del token senza “Bearer”, poi premi Verifica e salva.", "In Settings, paste the Account ID (not the Zone ID) and the token value without “Bearer”, then choose Verify and save.")}</li>
      </ul>
      <p class="guide-note">{say("Se preferisci mantenere il token limitato al singolo Worker, collega il dominio da Workers & Pages nel pannello Cloudflare. Per la via automatica, la policy account-level è richiesta dall’API dei domini Worker. DNS Write resta limitato alla zona e serve solo per sostituire il CNAME dopo conferma.", "If you prefer to keep the token limited to one Worker, connect the domain from Workers & Pages in the Cloudflare dashboard. The account-level policy is required by the Worker Domains API for automatic setup. DNS Write stays limited to the zone and is needed only to replace a CNAME after confirmation.")}</p>
      <div class="guide-actions"><button class="button outline" onclick={() => void act(loadSettings)}>{say("Apri Impostazioni", "Open Settings")} →</button><a class="button text" href="https://developers.cloudflare.com/workers/authorization/" target="_blank" rel="noreferrer">{say("Permessi Cloudflare", "Cloudflare permissions")} ↗</a></div>
    </article>

    <article class="panel-card guide-step">
      <div class="guide-step-head"><span class="guide-step-number">2</span><div><div class="eyebrow">{say("PREPARA E PUBBLICA", "PREPARE AND PUBLISH")}</div><h2>{say("Aggiungi il sito", "Add your site")}</h2></div></div>
      <p>{say("Scegli una cartella, un file HTML, un archivio ZIP oppure un sito online che sei autorizzato a copiare. Per una copia statica non servono credenziali WordPress.", "Choose a folder, HTML file, ZIP archive, or an online site you are authorized to copy. A static copy does not need WordPress credentials.")}</p>
      <ol class="guide-list"><li>{say("Apri Nuovo sito e scegli la sorgente.", "Choose New site and select a source.")}</li><li>{say("Apri il sito, avvia una versione e controlla il report.", "Open the site, create a build, and review its report.")}</li><li>{say("Quando il report è pronto, scegli Prepara e pubblica. Questo invia davvero il sito al Worker Cloudflare.", "When the report is ready, choose Build and publish. This sends the site to your Cloudflare Worker.")}</li></ol>
      <div class="guide-actions"><button class="button primary" onclick={beginNewSite}>{say("Aggiungi un sito", "Add a site")} →</button></div>
    </article>

    <!-- Doc 18 §9 (F7): the automatic importer, from a plain site to a project the builder edits element by element. -->
    <article class="panel-card guide-step" data-testid="guide-html-import">
      <div class="guide-step-head"><span class="guide-step-number" aria-hidden="true">+</span><div><div class="eyebrow">{say("HISTOS CMS", "HISTOS CMS")}</div><h2>{say("Rendi modificabile un sito HTML", "Make an HTML site editable")}</h2></div></div>
      <p>{say("Trascina nel catalogo di Histeon CMS una pagina HTML, lo ZIP di un sito o la sua cartella. Histeon lo converte in un progetto che il builder modifica elemento per elemento; nulla del sito viene eseguito durante la conversione.", "Drop an HTML page, a site's ZIP or its folder on the Histeon CMS catalog. Histeon converts it into a project the builder edits element by element; nothing of the site runs during the conversion.")}</p>
      <ol class="guide-list">
        <li>{say("Nella finestra di controllo guarda quanti elementi si selezionano uno per uno e le note: cosa è stato tolto, cambiato o proposto.", "In the check dialog, see how many elements are selectable one by one and the notes: what was dropped, changed or proposed.")}</li>
        <li>{say("Scegli il framework di arrivo (Histeon CSS è preselezionato) e, se vuoi, intestazione e piè come parti, schede come componenti ed elenchi.", "Choose the target framework (Histeon CSS is preselected) and, if you like, header and footer as parts, cards as components and lists.")}</li>
        <li>{say("Le classi utility (Tailwind, Bootstrap) diventano classi BEM solo dove il CSS resta identico; gli script del sito restano nella sezione JS della pagina e girano nel sito e nell'anteprima, mai nel builder.", "Utility classes (Tailwind, Bootstrap) become BEM classes only where the CSS stays the same; the site's scripts stay in the page's JS section and run on the site and in the preview, never in the builder.")}</li>
        <li>{say("Scarica il prototipo o il rapporto in JSON se vuoi conservarli, poi importa. Il progetto tiene i suoi rapporti d'importazione, scaricabili dalla sua pagina.", "Download the prototype or the JSON report if you want to keep them, then import. The project keeps its import reports, downloadable from its page.")}</li>
      </ol>
    </article>

    <article class="panel-card guide-step">
      <div class="guide-step-head"><span class="guide-step-number">3</span><div><div class="eyebrow">{say("DOMINIO E DNS", "DOMAIN AND DNS")}</div><h2>{say("Collega il dominio", "Connect your domain")}</h2></div></div>
      <p>{say("Dopo aver pubblicato il Worker, apri le impostazioni del sito e inserisci il dominio principale, per esempio esempio.it. Lascia selezionato www se vuoi collegare anche quel nome: la casella compare solo per il dominio principale.", "After publishing the Worker, open the site settings and enter the root domain, for example example.com. Leave www selected if you also want to connect that hostname: the option shows only for the root domain.")}</p>
      <ol class="guide-list"><li>{say("Premi Collega dominio e controlla la zona che Histeon ha trovato.", "Choose Connect domain and check the zone Histeon found.")}</li><li>{say("Leggi il riepilogo. Se segnala un CNAME incompatibile, conferma Sostituisci e collega solo se quel nome deve passare al Worker.", "Review the summary. If it reports an incompatible CNAME, confirm Replace and connect only if that hostname should point to the Worker.")}</li><li>{say("Cloudflare crea le voci del Worker e il certificato HTTPS. Attendi qualche minuto e prova l’indirizzo https://.", "Cloudflare creates the Worker records and HTTPS certificate. Wait a few minutes, then try the https:// address.")}</li></ol>
      <p class="guide-note">{say("Histeon non tocca MX/TXT della posta né altri nomi del dominio. Il token verificato non rende il sito online finché non pubblichi il Worker e confermi il collegamento del dominio.", "Histeon does not change mail MX/TXT records or other hostnames. A verified token does not bring the site online until you publish the Worker and confirm the domain connection.")}</p>
      <p class="guide-note">{say("Con le «JavaScript detections» dei bot attive sulla zona, Cloudflare inietta in / uno script inline: una CSP rigida lo blocca senza danni al sito.", "With bot «JavaScript detections» on for the zone, Cloudflare injects an inline script into /: a strict CSP blocks it without harming the site.")}</p>
      {#if sites.length > 0}<div class="guide-site-list" aria-label={say("Apri le impostazioni di un sito", "Open a site's settings")}>{#each sites as site (site.id)}<button class="guide-site-link" onclick={() => void act(() => openSite(site.id))} disabled={busy}><span><strong>{site.name}</strong><small>{site.domain ?? site.publicUrl ?? say("Apri impostazioni sito", "Open site settings")}</small></span><span aria-hidden="true">→</span></button>{/each}</div>{:else}<div class="guide-actions"><button class="button outline" onclick={beginNewSite}>{say("Aggiungi prima il sito", "Add the site first")} →</button></div>{/if}
    </article>
  </div>

  <section class="panel-card guide-glossary" aria-labelledby="glossary-title">
    <div class="eyebrow">{t("glossary.eyebrow")}</div>
    <h2 id="glossary-title">{t("glossary.title")}</h2>
    <dl>
      {#each ["draft", "inSite", "build", "publish", "sendDev"] as term (term)}<div><dt>{t(`glossary.${term}`)}</dt><dd>{t(`glossary.${term}Text`)}</dd></div>{/each}
    </dl>
  </section>
</section>
