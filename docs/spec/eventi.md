# Eventi del core

Versione: 1

Build e operazioni lunghe emettono eventi tipizzati. La CLI li mostra come righe testuali; con `--json-stream` ogni evento è una riga JSON indipendente (NDJSON). `AbortSignal` annulla l’operazione. I messaggi non includono contenuti di file, estratti dei finding o credenziali.

## Tipi di evento

| Evento | Campi | Quando viene emesso |
|---|---|---|
| `start` | `sourceKind` | All’avvio della build. |
| `progress` | `phase`, `completed`, `total?` | Avanzamento di `crawl`, download `assets`, riscrittura `rewrite`, scansione `scan` e scrittura `copy` nel bundle. |
| `finding` | `finding` | Per ogni blocco o avviso rilevato. Include codice, gravità, file, riga facoltativa e messaggio senza estratto. |
| `complete` | `files`, `bytes`, `blocked` | Al termine della build. `blocked: true` impedisce l’esportazione. |
| `cancelled` | nessun altro campo | Riservato alle operazioni che convertono l’annullamento in un evento prima di uscire. |
| `deploy-progress` | `phase`, `completed?`, `total?` | Durante il preflight, l’upload degli asset, la creazione della versione e il deploy Cloudflare. Non include nomi di file o credenziali. |

## Esempi

```json
{"type":"start","sourceKind":"directory"}
{"type":"progress","phase":"scan","completed":12,"total":12}
{"type":"complete","files":12,"bytes":48219,"blocked":false}
```

## Regole

- Gli eventi descrivono avanzamento e risultati; non contengono il contenuto dei file.
- Un finding bloccante produce una build `blocked` e codice di uscita CLI `3`.
- La chiusura della connessione o l’abort interrompe l’operazione quando il passaggio corrente è annullabile.
- I consumatori ignorano campi sconosciuti per mantenere la compatibilità in avanti.
