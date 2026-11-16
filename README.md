# Histeon Publish

Applicazione desktop per costruire siti con Histeon fuori da WP e portarli online: dai prototipi HTML ai progetti Histeon, fino a un sito WP con Histeon o a una copia statica.

## Che cosa fa

- **Prototipi → progetti Histeon.** Un prototipo è un sito intero in un file HTML (classi BEM, token `--xb-*`, componenti, record e loop). Publish lo controlla, lo importa come progetto di Histeon CMS (il builder di Histeon che gira dentro l'app, senza WP) e lo aggiorna quando il prototipo cambia. Converte anche pagine HTML qualsiasi, proposte grafiche e pagine o riquadri di file di design.
- **Progetti → WP.** Un progetto si invia a un sito WP con il plugin Histeon, sempre in sviluppo, e torna indietro con le modifiche fatte sul sito. Si esporta anche come file `.xbsite`.
- **Copie statiche.** Costruisce il sito statico di un progetto, o di un sito esistente, lo controlla (collegamenti, immagini, motori di ricerca, peso, accessibilità) e lo pubblica su Cloudflare Workers o via FTP, FTPS e SFTP, dopo un riepilogo e una conferma.
- **App desktop** (Electron) per Linux e Windows. L'interfaccia è servita da un server locale che ascolta solo su `127.0.0.1`.
- **CLI** `histos-publish`: build, controlli ed esportazioni dalla riga di comando, i comandi `prototype` (manuale, controllo, verifica, esportazione) e i token di design.
- **Connettore per agenti AI.** Un server MCP con un elenco chiuso di operazioni: un agente sul computer dell'utente legge il manuale dei prototipi, li controlla e li importa, fa build e anteprime, ed esporta. Il connettore è spento di serie; lo accende l'utente nell'app, e un agente non può pubblicare né leggere credenziali.
- **Agente Linux** opzionale per pubblicare un sito WP ospitato su un server proprio senza dare a WP il token di Cloudflare (`docs/AGENTE.md`).

Le credenziali restano nel portachiavi del sistema. L'app non invia telemetria.

## Costruire e provare

Serve Node.js 22.13 o successivo.

```sh
npm ci
npm run build
npm test
```

`npm run dist:linux` prepara i pacchetti Linux (AppImage e `.deb`), `npm run dist:windows` l'installer per Windows. Le prove con WP (`npm run test:wordpress:all` e simili) vogliono Docker e un checkout del builder Histeon in `HISTOS_BUILDER_DIR`.

La documentazione è in `docs/`: installazione (`INSTALL-LINUX.md`, `INSTALL-WINDOWS.md`), primo deploy (`PRIMO-DEPLOY.md`), decisioni (`adr/`) e specifiche (`spec/`).

## Questo repository

Riceve una copia dei sorgenti a ogni versione, un commit per versione; lo sviluppo quotidiano avviene altrove.

Ogni **release** contiene l'AppImage per Linux x64 (`Histeon-Publish-<versione>-linux-x64.AppImage`) con la sua firma `.minisig`, il pacchetto `.deb`, `SHA256SUMS` e l'archivio dei sorgenti `histeon-publish-<versione>-sorgenti.tar.gz`. L'app installata come AppImage si aggiorna da sola da queste release, senza token: installa una versione nuova solo se la firma è valida ([docs/spec/aggiornamenti-app.md](docs/spec/aggiornamenti-app.md)).

Chiave pubblica di rilascio di Histeon (formato minisign, id `7245FEACC0E94D12`):

```
RWQSTenArP5FclHgI0qEErGDYUEQ6gL4cEhpgec49VKtqKfgl2TIAn5W
```

Prima di installare, controlla l'impronta dei file con `SHA256SUMS` (`sha256sum -c SHA256SUMS --ignore-missing`) e la firma dell'AppImage con `minisign -Vm Histeon-Publish-<versione>-linux-x64.AppImage -P RWQSTenArP5FclHgI0qEErGDYUEQ6gL4cEhpgec49VKtqKfgl2TIAn5W`. Il `.deb` non è firmato: per lui vale l'impronta.

## Licenza

GPL-3.0-or-later: il testo è in `LICENSE`. La copia del builder Histeon in `packages/cms/vendor/histos/` ha la stessa licenza; gli avvisi del codice di terzi sono in `packages/desktop/resources/THIRD-PARTY-NOTICES.md` e le licenze delle dipendenze in `docs/policy/PROVENANCE.md`.

- Segnalare una falla, in privato: [SECURITY.md](SECURITY.md).
- Il nome Histeon e i marchi di altri: [TRADEMARKS.md](TRADEMARKS.md).
