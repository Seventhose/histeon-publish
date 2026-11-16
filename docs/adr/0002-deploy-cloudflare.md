# ADR 0002 — Deploy Cloudflare via API diretta

Data: 2026-10-21

Stato: **implementato e verificato con mock locale; nessun account reale usato**

## Decisioni

1. Usare l’API Cloudflare Workers Static Assets Direct Upload: creare la sessione asset con il manifest, caricare solo gli hash richiesti, creare la versione multipart e distribuire al 100% la nuova versione.
2. Per un Worker nuovo, se la creazione della versione risponde 404, creare lo script con `PUT /workers/scripts/{script}` e ripetere la creazione della versione. Il Worker minimale inoltra le richieste ad `env.ASSETS.fetch(request)`.
3. Codificare ogni segmento dei percorsi del manifest mantenendo `/` come separatore. La documentazione Direct Upload non mostra un esempio con caratteri accentati; una segnalazione pubblica nel progetto Workers SDK riguarda i percorsi non codificati (vedi le fonti). La codifica è quindi difensiva e coperta dal mock; non è stata convalidata su un account reale.
4. Inviare `_headers` e `_redirects` nei campi `assets.headers` e `assets.redirects`; usare `assets.config` per `html_handling` e `not_found_handling`. I due file speciali non entrano nel manifest degli asset pubblici.
5. Applicare al preflight il limite prudenziale di 20.000 file per versione; consentire `cloudflare.maxFiles` fino a 100.000 quando l’utente sa di avere Workers Paid. Il programma non determina il piano dell’account. Il limite per singolo file è 25 MiB.
6. Conservare il token CLI nel portachiavi di sistema tramite `@napi-rs/keyring`; accettare `HISTOS_CLOUDFLARE_API_TOKEN` come override di sola lettura. Nessun fallback su file in chiaro.
7. Accettare l’endpoint API override solo dalla variabile `HISTOS_CLOUDFLARE_API_BASE`, con HTTPS vincolato a `api.cloudflare.com/client/v4` e HTTP limitato a loopback per il mock. Disabilitare redirect HTTP e redigere token, JWT ed errori API prima dell’output.
8. Ritentare soltanto risposte 429, per un numero limitato di tentativi rispettando `Retry-After`. `deploy`, `rollback` e associazione dominio richiedono conferma CLI, salvo `--yes` esplicito. L’associazione seleziona la zona attiva più specifica e lascia disattivate le preview.

## Verifiche

- Primo deploy, riuso di hash, modifica di un file, rollback e risposta dal mock.
- Applicazione delle regole `_headers` e `_redirects` nel mock.
- Associazione dominio al mock, limiti di upload, retry 429 e risposte 400/401/404/500.
- Token sintetici redatti dagli errori; il mock registra i nomi dei segreti e mai i valori.
- `deploy --dry-run` prepara un bundle e mostra il riepilogo senza richieste Cloudflare.

## Fonti consultate

- Cloudflare, [Direct Upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/) e [schema API di Workers scripts](https://developers.cloudflare.com/api/terraform/resources/workers/subresources/scripts/), consultati il 2026-10-21.
- Cloudflare, [limiti Workers](https://developers.cloudflare.com/workers/platform/limits/), [headers](https://developers.cloudflare.com/workers/static-assets/headers/), [redirects](https://developers.cloudflare.com/workers/static-assets/redirects/) e [versioni e deployment](https://developers.cloudflare.com/workers/versions-and-deployments/), consultati il 2026-10-21.
- Cloudflare, [API Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/) e [custom domains](https://developers.cloudflare.com/api/terraform/resources/workers/subresources/domains/), consultati il 2026-10-21.
- Cloudflare Workers SDK, [segnalazione sui percorsi manifest che richiedono URI encoding](https://github.com/cloudflare/workers-sdk/issues/14461), consultata il 2026-10-21. È un’indicazione del progetto SDK, non una garanzia nella documentazione Direct Upload.
- npm, [@napi-rs/keyring 2.0.0](https://www.npmjs.com/package/@napi-rs/keyring), licenza MIT, consultato il 2026-10-21.

## Limiti noti

- Il test del mock dimostra l’integrazione tra le parti del progetto, non certifica gli endpoint contro un account Cloudflare.
- Il preflight non conosce il piano dell’account né il numero di versioni conservate.
- L’interfaccia server e desktop aggiungerà lo storico locale; la CLI di questa versione non mantiene ancora un catalogo locale dei deploy.
- Il comando `domain` crea o aggiorna il dominio lato Cloudflare dopo conferma. Il test usa solo il mock locale.
