# ADR 0009 — Fluent Forms e invii statici

## Decisione

L’adapter dei moduli per i siti statici supporta Fluent Forms. Contact Form 7 non viene usato per gli invii pubblicati. L’utente sceglie esplicitamente gli ID dei moduli, configura Turnstile e mantiene il servizio email su WordPress; Fluent SMTP può consegnare i messaggi tramite il provider scelto dall’utente.

## Flusso

1. Histos riconosce in una pagina il markup del modulo Fluent Forms e lo collega solo se il suo ID è configurato.
2. Il browser invia campi e token Turnstile al Worker.
3. Il Worker verifica Turnstile e inoltra il modulo all’endpoint AJAX di Fluent Forms su WordPress.
4. WordPress genera la notifica email; Fluent SMTP la consegna se è installato e configurato.

Histos non riceve password SMTP né credenziali WordPress per questo flusso. La chiave segreta Turnstile è conservata localmente e viene inviata a Cloudflare come binding segreto durante il deploy confermato.

## Limiti

Gli ID non trovati nelle pagine pubblicate e i moduli con caricamenti file, CAPTCHA integrato o pagamenti restano inattivi e vengono segnalati. Le prove sono locali; nessun invio o email verso un sito reale è stato eseguito.

Fluent SMTP è un progetto separato di WPManageNinja LLC e dei contributori, con licenza GPL-2.0-or-later. Histos Publish non lo include e non è affiliato ai suoi autori. [Repository ufficiale Fluent SMTP](https://github.com/WPManageNinja/fluent-smtp).
