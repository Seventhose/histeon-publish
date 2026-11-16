# Installare Histeon Publish su Linux

Histeon Publish per Linux x64 è distribuito come pacchetto `.deb` e come AppImage, nelle release del repository pubblico [`Seventhose/histeon-publish`](https://github.com/Seventhose/histeon-publish/releases). Prima di installare, controlla che i checksum accanto ai file corrispondano.

## Verificare i file

Nella cartella dove hai scaricato i file di una release, insieme a `SHA256SUMS`:

```sh
sha256sum -c SHA256SUMS --ignore-missing
minisign -Vm Histeon-Publish-X.Y.Z-linux-x64.AppImage -P RWQSTenArP5FclHgI0qEErGDYUEQ6gL4cEhpgec49VKtqKfgl2TIAn5W
```

Il primo comando deve mostrare `OK` per ogni file scaricato, il secondo `Signature and comment signature verified`. Il `.deb` non è firmato: per lui vale il checksum.

Per un pacchetto costruito da te, nella cartella `packages/desktop/release/` c'è `SHA256SUMS.txt`: `sha256sum -c SHA256SUMS.txt`.

## Scegliere il pacchetto

### `.deb` Linux x64

Il `.deb` ricava le dipendenze di sistema dal binario Electron (`dpkg-shlibdeps`) sul sistema dove viene costruito: usa un pacchetto costruito per la tua distribuzione. Non forzare l’installazione se il gestore pacchetti non trova le dipendenze.

Per creare una release Linux locale, copia `docs/release-linux-metadata.example.json` in `.histos-release-linux.json` e sostituisci dominio, ID reverse-DNS e contatto con i dati ufficiali del prodotto. La release richiede `appstreamcli`; la validazione AppStream viene eseguita senza contattare la homepage. Per eseguire gli smoke test senza un display X attivo serve anche `xvfb-run`. Poi esegui `npm run release:linux` dopo aver approvato la versione e completato i gate previsti. Il comando crea gli artefatti in `packages/desktop/release/<versione>/`, con metadati AppStream validati, verifica i checksum e copia l’AppImage in `Documenti/Applicazioni` (usa la cartella Documenti configurata da Linux). Rifiuta una versione già presente e non modifica gli artefatti storici. Se la build è già pronta e devi ripetere solo la copia, usa `npm run copy:appimage`: conserva le versioni precedenti e rifiuta di sovrascrivere un file omonimo con contenuto diverso. `HISTOS_RELEASE_DIR` seleziona la cartella della build; in `release:linux` accetta anche un percorso assoluto esterno al repository per prove isolate. All’interno della repository è ammessa solo la cartella versionata predefinita. `HISTOS_APPLICATIONS_DIR` consente di indicare una destinazione assoluta diversa, utile per collaudare la copia in una cartella temporanea. Questi comandi non pubblicano il sito né installano il pacchetto.

Quando ricevi un `.deb` della release destinato alla tua distribuzione, il gestore pacchetti verifica e installa le dipendenze:

```sh
sudo apt install ./histos-publish_X.Y.Z_amd64.deb
```

Poi apri **Histeon Publish** dal menu delle applicazioni (il launcher è `/usr/bin/histos-publish`). Per salvare le credenziali serve un servizio Secret Service (GNOME Keyring) o KWallet attivo: vedi «Dati e credenziali».

### AppImage Linux x64

Rendi il file eseguibile e avvialo:

```sh
chmod +x Histeon-Publish-X.Y.Z-linux-x64.AppImage
./Histeon-Publish-X.Y.Z-linux-x64.AppImage
```

Su alcune distribuzioni serve FUSE 2 (`libfuse2` o il pacchetto equivalente della distribuzione). Per aggiornare, sostituisci il file con una build nuova dopo averne verificato il checksum; dalla 1.22.0 l’AppImage può anche aggiornarsi da sé, come descritto in `docs/spec/aggiornamenti-app.md`.

L’AppImage mantiene il sandbox Chromium se il sistema permette di creare user namespace. Se il kernel o AppArmor lo impedisce, appare un avviso nell’app e l’AppImage avvia Chromium con `--no-sandbox` per poter funzionare. In questo caso usa il `.deb` se vuoi mantenere l’isolamento dei processi; il fallback dell’AppImage è meno adatto a visualizzare contenuti non fidati.

La modalità render del CLI e di `histos-publish ui` (Chrome di sistema tramite Playwright) richiede invece il sandbox: se non parte, il build si ferma con `render-sandbox-unavailable`. Solo per siti di cui ti fidi puoi farlo partire senza sandbox con `HISTOS_PUBLISH_RENDER_NO_SANDBOX=1`; il CLI lo segnala a ogni avvio.

SFTP è incluso nell’app e non richiede l’installazione di OpenSSH Client. Alla prima connessione confronta l’impronta del server con quella indicata dal provider; Histeon Publish invia le credenziali solo dopo la conferma.

## Dati e credenziali

Siti, cronologia e configurazioni restano nella cartella dati utente. Il token Cloudflare e le chiavi segrete usano il portachiavi di sistema. Su Linux l’app non salva segreti se il backend non offre cifratura sicura; in quel caso sblocca GNOME Keyring o KWallet e riapri l’app.

La disinstallazione del `.deb` o la rimozione dell’AppImage non è una procedura di cancellazione dei dati utente. Prima di rimuovere manualmente la cartella dati, esporta ciò che vuoi conservare.

## Nota sulla provenienza

L’AppImage delle release ha accanto la firma minisign (`.minisig`) della chiave di rilascio di Histeon; il `.deb` non è firmato. Usa i checksum della stessa build e conserva il file originale finché non hai completato le tue verifiche.
