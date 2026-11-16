# ADR 0005 — Contact Form 7 e Pagefind

> **Superato per l’adapter dei moduli.** La scelta iniziale per Contact Form 7 è stata sostituita da Fluent Forms; l’integrazione corrente è descritta in [ADR 0009](0009-fluent-forms.md). Questa decisione resta qui come cronologia del progetto.

Data: 2026-10-22

Stato: **decisione storica parzialmente superata**. Pagefind resta attivo come funzione facoltativa; l’adapter Contact Form 7 è stato sostituito da Fluent Forms e non fa parte dell’integrazione corrente.

## Decisioni

| # | Decisione | Motivazione |
|---:|---|---|
| 1 | Usare Pagefind 1.5.2, licenza MIT, per la ricerca statica locale e lasciarlo disattivato per default. | La ricerca non richiede un account o un servizio esterno. Il bundle viene indicizzato dopo la pulizia; `404.html` e pagine `noindex` sono escluse. La versione esatta è nel lockfile e il registro include i binari opzionali di tutte le piattaforme. |
| 2 | Implementare solo Contact Form 7 per i form WordPress. | L’API REST ufficiale espone la route di feedback pubblica e richiede un payload multipart. Il Worker la chiama server-to-server, con URL e ID form fissati nella configurazione; non usa nonce o credenziali WordPress nel browser. |
| 3 | Usare Turnstile con verifica Siteverify sul Worker. | Il token del browser da solo non basta. Il Worker confronta esito, hostname e azione prima di inoltrare dati. |
| 4 | Consegnare la mail tramite WordPress `wp_mail()`; lasciare che FluentSMTP usi il provider scelto e configurato dall’utente in WordPress. Attribuire separatamente il progetto nella UI e nelle guide. | È la scelta del progetto. Histos Publish non aggiunge credenziali SMTP/API, destinatari o un secondo servizio email. FluentSMTP è sviluppato da WPManageNinja LLC e dai contributori del progetto (GPL-2.0-or-later); non viene incluso nel prodotto e non c’è affiliazione. |
| 5 | Conservare la chiave Turnstile nel portachiavi locale; trasferirla come binding Cloudflare `secret_text` solo nel deploy confermato. | La chiave non deve entrare in configurazione JSON, bundle, report o log. La richiesta multipart dell’API versione contiene il binding segreto; il client redige il valore dagli errori. |
| 6 | Limitare la route Worker-first a `/xb-form`, con body massimo 32 KB, 50 campi e 5.000 caratteri per valore. Rifiutare allegati, CAPTCHA già presenti, origini diverse e ID non configurati. | Riduce il Worker a un inoltro chiuso verso un solo endpoint. I plugin form non verificati restano segnalati e inattivi; non si implementa un proxy generico. |
| 7 | Non ritentare automaticamente l’invio e restituire risposte generiche. | Un timeout dopo la consegna può produrre duplicati; i dettagli del provider e i dati personali non devono apparire nella risposta del browser o nei log dell’app. |

## Verifica

- I test citati qui si riferiscono alla prima implementazione Contact Form 7 e non verificano l’adapter Fluent Forms; la validazione corrente è registrata nell’ADR 0009.
- La decisione storica era stata controllata con TypeScript strict, `svelte-check`, lint e test sul mock Cloudflare; nessun account, segreto o casella reale.
- Pagefind è serializzato tra build concorrenti; i file creati passano Scanner e manifest.
- L’endpoint CF7 è stato verificato nella documentazione ufficiale. Non è stato eseguito un invio a WordPress reale. Non è stata verificata la consegna email su Fluent SMTP.
- Nessuna modifica a Histos o Static Bridge.

## Fonti

Consultate il 2026-10-22:

- Pagefind [documentazione](https://pagefind.app/docs/) e [licenza](https://github.com/Pagefind/pagefind/blob/main/LICENSE).
- Contact Form 7 [FAQ REST/AJAX](https://contactform7.com/faq/).
- FluentSMTP [README ufficiale, autori e licenza](https://github.com/WPManageNinja/fluent-smtp/blob/master/readme.txt), [repository](https://github.com/WPManageNinja/fluent-smtp) e [documentazione](https://fluentsmtp.com/docs/).
- Cloudflare [Static Assets](https://developers.cloudflare.com/workers/static-assets/), [metadata e binding](https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/) e [verifica Turnstile](https://developers.cloudflare.com/turnstile/get-started/).
