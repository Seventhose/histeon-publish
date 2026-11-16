# Histeon Publish per Local

L'add-on aggiunge **Apri in Histeon Publish** al menu **More** della schermata di un sito Local. Passa a Histeon Publish il nome e il dominio `.local`; non legge file, database, password o credenziali WordPress.

## Pacchetto installabile

Dalla cartella principale di Histeon Publish esegui:

```bash
npm run pack:local-addon
```

Il comando crea `integrations/Histeon-Publish-Local-Addon-0.1.2.tgz` con la struttura npm richiesta da Local. Usa questo `.tgz` con **Add-ons → Installed → Install from disk**. Il vecchio `.zip` e l'archivio `.tar.gz` creato manualmente non sono i pacchetti da installare.

### Linux: errore `EXDEV` durante l'installazione

Se Local mostra `cross-device link not permitted`, il suo installer sta estraendo il pacchetto in `/tmp` e poi prova a spostarlo nella cartella add-on su un altro filesystem. Chiudi Local e, dalla cartella principale di Histeon Publish, esegui:

```bash
npm run install:local-addon
```

Il comando ricrea il `.tgz`, installa i file direttamente nella cartella add-on di Local sullo stesso filesystem, abilita Histeon Publish e conserva la copia sostituita in una cartella `*.backup-*`. Riapri Local e controlla **Add-ons → Installed**. Il comando si ferma se Local è ancora aperto o se trova una cartella/registro non sicuro. Su macOS e Windows continua a usare **Install from disk**.

La versione 0.1.2 aggiunge un componente principale senza effetti collaterali. Local 10.1.2 carica e registra gli add-on dichiarati con `main` prima di sincronizzare lo stato; un add-on dichiarato soltanto con `renderer` non viene mantenuto attivo all'avvio. Il loader Linux installato è stato verificato nel pacchetto Local 10.1.2+7004.

## Installazione su Linux

1. In Local apri **Add-ons → Installed**. Se vedi la versione 0.1.1, apri `…` e scegli **Uninstall**; lascia riavviare Local.
2. Dopo il riavvio scegli **Install from disk** e seleziona `Histeon-Publish-Local-Addon-0.1.2.tgz`.
3. Attiva **Histeon Publish** e conferma il riavvio. Ora l'add-on deve restare attivo.
4. Avvia un sito, apri il menu **More** e scegli **Apri in Histeon Publish**.

Se, dopo aver disinstallato la vecchia versione, Local mostra ancora **Add-on already exists**, chiudi Local. Sposta la cartella residua fuori da `addons` con questo comando, che la conserva come backup:

   ```bash
   mv ~/.config/Local/addons/histos-publish-local-addon ~/.config/Local/histos-publish-local-addon-backup-$(date +%Y%m%d-%H%M%S)
   ```

   Se il terminale dice che la cartella non esiste, non serve fare altro.
   Poi riapri Local, installa il `.tgz` da **Add-ons → Installed → Install from disk** e attivalo.

Il percorso ufficiale degli add-on su macOS è `~/Library/Application Support/Local/addons/`; su Windows è `%APPDATA%\\Local\\addons\\`.

## App Histeon Publish

Installa una versione di Histeon Publish che supporta il collegamento `histos-publish://`. Sul desktop Linux che usi con Local, il protocollo deve essere associato all'AppImage o al pacchetto installato.

## Limiti

L'add-on passa soltanto un indirizzo locale. Histeon Publish acquisisce le pagine raggiungibili e costruisce un sito statico. PHP, database, login WordPress e codice dei plugin non vengono trasferiti; le funzioni che richiedono WordPress o un server restano da sostituire o collegare a un servizio compatibile. Tieni il sito Local avviato durante il rilevamento e la build.

Histeon Publish è un progetto indipendente e non è affiliato a Local o WP Engine.
