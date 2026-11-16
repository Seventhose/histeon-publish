# ADR 0010 — Pubblicazione di bundle statici su hosting e VPS

- Stato: accettato
- Data: 2026-10-23

## Contesto

Cloudflare Workers non copre tutti i siti statici. Hosting condivisi e VPS espongono spesso FTP, FTPS o SFTP e possono servire file statici da una cartella pubblica.

## Decisione

Histos Publish offre una destinazione generica per trasferire una build pronta tramite FTP, FTPS o SFTP, senza dipendere da API specifiche del provider. L’interfaccia richiede host, porta, cartella remota e URL pubblico facoltativo. Ogni sito mantiene la propria destinazione; la build resta verificata localmente prima del trasferimento.

Per SFTP sono supportati password e chiavi private SSH tramite il client integrato `ssh2`, incluso nel pacchetto desktop e disponibile su Linux, macOS e Windows. Il client legge l’impronta SHA-256 durante la negoziazione SSH prima dell’autenticazione; l’interfaccia la mostra per il confronto con quella del provider. Password, chiave privata o passphrase non vengono inviate finché l’utente non conferma l’impronta. La chiave host confermata resta nella configurazione del sito; i segreti restano nel portachiavi di sistema.

FTP in chiaro richiede una conferma esplicita ed è presentato come ultima scelta. FTPS e SFTP sono i protocolli consigliati.

La pubblicazione sovrascrive i file della build e non elimina i file remoti che non esistono più nella sorgente. Le funzionalità WordPress lato server, inclusi i moduli Fluent Forms gestiti dal Worker, non vengono emulate su FTP/SFTP.

## Conseguenze

- Provider e pannelli diversi possono usare lo stesso protocollo standard.
- Un VPS deve già avere il web server, il document root, DNS e TLS configurati; Histos trasferisce solo il bundle.
- Non sono incluse API specifiche di object storage/CDN come S3, R2 o provider che richiedono funzioni di deploy proprietarie.
- Un host key sconosciuto o cambiato blocca l’invio delle credenziali finché l’utente non confronta e conferma la nuova impronta.

## Dipendenze

- `basic-ftp` per FTP e FTPS.
- `ssh2` (MIT) gestisce la connessione e il trasferimento SFTP nel processo desktop; non serve installare un client SSH di sistema.
- `bcrypt-pbkdf` usa il sorgente BSD dell’implementazione OpenBSD; la copia locale sostituisce la dipendenza SHA-512 con `node:crypto`, senza cambiare l’algoritmo.
