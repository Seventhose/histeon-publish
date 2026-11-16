# Installare Histeon Publish su Windows

Il packager supporta Windows x64 e prepara un installer per il solo utente corrente. Le release contengono solo i pacchetti Linux: l’installer Windows si costruisce dal sorgente, su Windows.

## Se hai ricevuto l’installer

1. Verifica che il file e `SHA256SUMS.txt` provengano dalla stessa distribuzione.
2. In PowerShell calcola l’hash:

   ```powershell
   Get-FileHash .\Histeon-Publish-X.Y.Z-win-x64-setup.exe -Algorithm SHA256
   ```

3. Confronta il valore con la riga del file nel checksum ricevuto.
4. Avvia il setup. Installa Histeon Publish in `%LOCALAPPDATA%\Programs\Histeon Publish` e crea collegamenti nel menu Start e sul desktop; non richiede privilegi amministrativi.

Per un aggiornamento, il setup estrae e controlla prima la nuova copia in una cartella temporanea sullo stesso disco. Solo dopo sostituisce la versione presente, mantenendo un backup per poterla ripristinare se il cambio di cartella fallisce. I siti, la cronologia e i segreti restano in AppData.

Il pacchetto non è firmato. Windows può mostrare un avviso sul distributore sconosciuto. Controlla l’origine e l’hash del file prima di decidere se avviarlo.

Il collegamento **Disinstalla Histeon Publish** rimuove il programma e i collegamenti, lasciando cartella dati, siti, cronologia e segreti in AppData.

## Costruire il pacchetto dal sorgente

Su Windows x64, con Node.js 24.22.0 x64:

```powershell
npm ci
npm run validate
npm run dist:windows
```

Il file `Histeon-Publish-X.Y.Z-win-x64-setup.exe` e il suo checksum vengono creati in `packages/desktop/release/`. Il job Windows della CI esegue lo stesso comando, installa l’app in una cartella di prova, verifica l’avvio, ripete l’installazione per coprire il percorso di aggiornamento, prova a installare un archivio corrotto e controlla che la versione precedente resti avviabile, poi disinstalla e verifica che i dati di prova in AppData restino. Non considerare la guida una prova di compatibilità: il pacchetto Windows va ancora eseguito e verificato su Windows.
