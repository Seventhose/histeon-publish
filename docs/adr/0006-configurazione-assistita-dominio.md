# ADR 0006 — Collegamento assistito di domini e DNS

Data: 2026-10-22

Stato: **implementato e verificato con mock locale; nessun account Cloudflare reale usato**

## Decisioni

| # | Decisione | Motivazione |
|---:|---|---|
| 1 | Prima di collegare un dominio, controllare in sola lettura la zona attiva, i CNAME esistenti e i Worker già associati agli hostname richiesti. | La schermata può spiegare il conflitto prima di qualunque modifica e rifiutare hostname già assegnati a un altro Worker. |
| 2 | Per un dominio principale, proporre insieme il dominio all’apice e `www`; per un sottodominio, usare il solo hostname indicato. | Un Custom Domain vale per il nome esatto. Collegare `example.org` non abilita automaticamente `www.example.org`. |
| 3 | Mostrare nome, destinazione e stato proxy di ogni CNAME incompatibile e richiedere conferma esplicita prima di rimuoverlo. | Cloudflare rifiuta la creazione del Custom Domain se esiste già un CNAME sullo stesso hostname. L’app modifica solo i record esatti approvati; MX, TXT e altri hostname restano intatti. |
| 4 | Ricontrollare l’intero snapshot dei CNAME prima della modifica; se record o assegnazioni sono cambiati, interrompere l’operazione e chiedere un nuovo controllo. | Riduce il rischio di cancellare un record diverso da quello mostrato nella conferma. |
| 5 | Se una cancellazione o un collegamento fallisce, provare a scollegare i Worker creati dal tentativo e ripristinare i CNAME precedenti. Il ripristino è idempotente e non sovrascrive un CNAME diverso creato nel frattempo. | Gestisce anche risposte di rete incerte senza duplicare record o sovrascrivere modifiche concorrenti; gli errori di ripristino chiedono un controllo manuale della zona. |
| 6 | Richiedere Zone Read, DNS Read e Workers Scripts Read/Write per il controllo; DNS Write e Workers Routes Write per la sostituzione e il collegamento. Limitare il token all’account e alla zona interessati. | Segue il principio del minimo privilegio. DNS Write viene usato solo quando l’utente approva la sostituzione di un CNAME. |

## Verifiche

- Vitest: 51 test superati, compresi sostituzione mirata, conservazione di MX/TXT, ripristino dopo errore e mancata duplicazione del CNAME.
- Typecheck e `svelte-check`: superati senza errori o avvisi.
- Biome: 44 file controllati senza segnalazioni.
- Playwright browser: 2 test superati, incluso il riepilogo e la sostituzione confermata del CNAME.
- Smoke test Electron: 1 test superato.
- Le prove usano solo il mock locale; nessun account Cloudflare reale è stato contattato.

## Fonti ufficiali consultate

- Cloudflare, [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), consultata il 2026-10-22. Cloudflare gestisce i record e i certificati; il nome host deve corrispondere esattamente; un CNAME esistente impedisce la creazione.
- Cloudflare, [List DNS Records](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/) e [Records API](https://developers.cloudflare.com/api/resources/dns/subresources/records/), consultate il 2026-10-22. Usate per individuare e rimuovere il CNAME dell’hostname approvato e per ripristinarlo in caso di errore.
- Cloudflare, [Worker Domains API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/), consultata il 2026-10-22. L’API permette di elencare, collegare e scollegare Worker Custom Domains.
- Cloudflare, [List Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/) e [List Worker Domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/), consultate il 2026-10-22. Zone Read serve per individuare la zona; Workers Scripts Read o Write permette di controllare i domini già assegnati.
- Cloudflare, [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/), consultata il 2026-10-22. Workers Routes Write è richiesto per modificare domini o route.

## Limiti

- Il mock verifica il flusso applicativo ma non sostituisce una prova su Cloudflare reale.
- Se DNS Write non è concesso, l’app può controllare i record ma non sostituire il CNAME; mostra quindi il permesso necessario.
- Il ripristino automatico resta best-effort: modifiche concorrenti o permessi revocati possono richiedere una correzione manuale.
