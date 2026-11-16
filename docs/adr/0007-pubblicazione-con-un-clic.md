# ADR 0007 — Pubblicazione con un clic e account Cloudflare

Data: 2026-10-22

Stato: **implementata e verificata con mock; nessun account Cloudflare reale usato**

## Decisioni

| # | Decisione | Motivazione |
|---:|---|---|
| 1 | Il pulsante **Crea build e pubblica** crea una build nuova, esegue i controlli e invia il bundle a Cloudflare se lo stato è `ready`. | Evita di chiedere all’utente una build separata e impedisce di pubblicare l’ultima build per errore quando la sorgente è cambiata. |
| 2 | Il clic sul pulsante è l’autorizzazione esplicita all’invio reale. Se la build è bloccata o fallisce, l’invio non parte e l’app mostra il report o l’errore. | Riduce la pubblicazione a un’azione riconoscibile, mantenendo il controllo nel momento dell’effetto esterno. |
| 3 | Se il token vede un solo account, Histos salva automaticamente l’ID. Se ne vede più di uno, la UI chiede di sceglierne uno; senza il permesso necessario resta disponibile l’inserimento manuale. | Evita la copia a mano dell’ID quando la lettura degli account è autorizzata. |
| 4 | Il token resta nel portachiavi di sistema. L’ID account è solo un identificatore e non sostituisce l’autorizzazione API. | Pubblicare richiede credenziali con permessi Workers; Cloudflare tratta l’autorizzazione OAuth come un flusso separato dall’identificatore dell’account. |
| 5 | Il collegamento iniziale di un dominio resta un’azione distinta con riepilogo DNS. | Associare un hostname può spostare il traffico e può richiedere la sostituzione di un CNAME esistente. |
| 6 | Il token API, salvato nel portachiavi di sistema, resta il metodo di accesso previsto. OAuth non è un requisito per il rilascio corrente. | Il token API basta: consente di autorizzare le chiamate senza registrare un client OAuth del prodotto. |

## Verifiche

- `CloudflareClient.listAccounts()` legge ID e nomi con paginazione e restituisce un errore esplicito se il token non ha `Account Settings Read`.
- Il mock locale espone un account sintetico per verificare la selezione automatica.
- Gli E2E verificano pubblicazione da una sorgente senza build precedente e blocco senza deployment Cloudflare quando lo scanner segnala un nonce.
- Le verifiche usano il mock locale. Nessun account Cloudflare reale è stato contattato e nessun sito è stato pubblicato.

## Limiti e prossimo passaggio

Questa decisione combina build e pubblicazione e riduce la configurazione: il token si salva una volta nel portachiavi e, con il permesso `Account Settings Read`, Histos rileva l’ID account. Se il token non include quel permesso, l’ID si può inserire manualmente. OAuth resta una possibile evoluzione e non blocca il rilascio corrente.

Fonti Cloudflare: [creazione OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/), [integrazione OAuth](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/), [autorizzazione di un’app](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/), [list account API](https://developers.cloudflare.com/api/resources/accounts/methods/list/).
