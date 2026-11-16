# ADR 0006 — Fluent Forms e Pagefind

Data: 2026-10-22

Stato: **Accettata**

## Scelte

| # | Decisione | Motivazione |
|---:|---|---|
| 1 | Usare Fluent Forms come adapter WordPress supportato. | È il plugin richiesto per i moduli pubblicati. La sua interfaccia pubblica invia `action=fluentform_submit`, `form_id` e i campi serializzati a `admin-ajax.php`. |
| 2 | Inoltrare dal Worker solo agli URL WordPress ricavati dall’URL REST HTTPS configurato; accettare esclusivamente gli ID Fluent Forms scelti. | Il browser parla solo con `/xb-form`; non può scegliere endpoint, destinatario o ID. Il Worker controlla origine, dimensioni, campi e Turnstile prima dell’inoltro. |
| 3 | Non chiedere credenziali WordPress per l’invio del modulo né per sorgenti locali o pubbliche. | L’invio usa l’endpoint pubblico del plugin. Basic Auth o cookie sono facoltativi e servono solo al crawler quando la sorgente URL è protetta. |
| 4 | Lasciare l’email a WordPress `wp_mail()` e al provider scelto dall’utente in Fluent SMTP. | Histos Publish non raccoglie password SMTP, non sceglie provider e non invia email autonomamente. La UI e la guida attribuiscono Fluent SMTP a WPManageNinja LLC e ai contributori, indicano la GPL-2.0-or-later e linkano il progetto ufficiale. |
| 5 | Richiedere Turnstile; lasciare inattivi i moduli con caricamenti file, CAPTCHA già presente o pagamenti. | Queste funzioni richiedono flussi o token aggiuntivi non gestiti dall’adapter. Il report deve spiegare l’esclusione. |
| 6 | Segnalare che, secondo la documentazione di Fluent Forms, la verifica nonce è disattivata per default, ma che un sito può abilitarla e rendere non validi i nonce congelati nell’HTML statico. | Histos Publish non rinnova nonce WordPress sul dominio sorgente. La copia non deve promettere compatibilità se l’amministratore attiva tale controllo. |
| 7 | Conservare Pagefind opt-in e disattivato per default. | La ricerca statica è locale e indipendente dai moduli. |
| 8 | Non migrare gli ID Contact Form 7 come ID Fluent Forms. | I due plugin usano configurazioni diverse. La configurazione dell’adapter precedente viene scartata senza impedire l’apertura del sito. |

## Configurazione

Nella scheda **Moduli** si inseriscono l’URL WordPress in formato `/wp-json/`, gli ID Fluent Forms e la chiave pubblica Turnstile. La chiave segreta resta nel portachiavi locale e viene inviata a Cloudflare solo come binding segreto nel deploy confermato.

La scheda di accesso protetto compare solo per sorgenti URL. Non serve per cartelle, file HTML, ZIP, siti pubblici o invio dei moduli statici. Per le sorgenti private è riservata al crawler e resta nel portachiavi.

## Flusso

1. La build individua solo form con markup Fluent Forms e ID configurati.
2. Seleziona l’endpoint `/xb-form`, aggiunge il client locale e inserisce Turnstile.
3. Il browser raccoglie i controlli riusciti, escludendo quelli disabilitati o condizionali `.ff_excluded`, i pulsanti di invio, i file e il token Turnstile.
4. Il Worker controlla `Origin`, ID form, struttura e dimensione dei dati; verifica Turnstile con hostname e action attesi.
5. Il Worker invia `action`, `form_id` e `data` serializzato all’`admin-ajax.php` dello stesso sito WordPress indicato in configurazione. Non segue redirect e non ripete automaticamente gli invii.
6. WordPress esegue Fluent Forms; `wp_mail()` può essere intercettato da Fluent SMTP. Histos Publish restituisce solo un esito generico.

## Limiti

- L’endpoint WordPress deve essere pubblico e raggiungibile via HTTPS. WAF, plugin di sicurezza o policy CORS/rete del server possono bloccare le richieste del Worker.
- Secondo la documentazione di Fluent Forms, la verifica nonce degli invii è disattivata per default. Se il sito la attiva, il nonce copiato nell’HTML può scadere; il modulo non è supportato in quel caso.
- I file, CAPTCHA già configurati e campi di pagamento non sono inoltrati. Altri controlli client-side specifici del plugin potrebbero non essere presenti nella copia; la validazione server-side Fluent Forms resta attiva.
- La configurazione accetta ancora l’URL in forma `/wp-json/` per individuare l’installazione WordPress; l’inoltro usa il percorso corrispondente `/wp-admin/admin-ajax.php`, anche in un’installazione in sottocartella.
- Il primo invio reale e la consegna email restano una prova controllata dell’utente. I test automatici usano solo mock locali.

## Fonti ufficiali consultate il 2026-10-22

- Fluent Forms, [Submission Lifecycle](https://fluentforms.com/docs/submission-lifecycle/): action AJAX, serializzazione dei campi, esclusione dei controlli condizionali, risposta e comportamento nonce.
- Fluent Forms Developers, [Submission Lifecycle](https://developers.fluentforms.com/submission-lifecycle/): flusso client/server e validazione.
- Fluent SMTP, [repository ufficiale e descrizione di `wp_mail()`](https://github.com/WPManageNinja/fluent-smtp/blob/master/readme.txt).
- Cloudflare, [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) e [Attach Worker Domain](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/).

La proposta precedente, che descriveva l’adapter Contact Form 7, è storica e superata da questa decisione.
