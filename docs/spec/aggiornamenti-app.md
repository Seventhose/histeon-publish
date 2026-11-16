# Aggiornamenti dell'app desktop

Implementazione: `packages/desktop/src/updates.ts` (release, download, firma, sostituzione), `packages/desktop/src/app-updates.ts` (stato, controlli periodici, IPC), `packages/ui/src/app/UpdatesCard.svelte` (Impostazioni → Dati). Test: `packages/desktop/test/updates.test.ts`, e lo smoke test dell'app impacchettata (`scripts/test-packaged-electron.mjs`).

Dalla 1.39.1 Histeon Publish si aggiorna dalle release del repository GitHub **pubblico** `Seventhose/histeon-publish` (`UPDATE_REPOSITORY` in `packages/desktop/src/updates.ts`), senza token. Dalla 1.22.0 alla 1.39.0 le release erano in un repository privato e serviva un token di GitHub.

## Come funziona

- **Senza token.** Le richieste a GitHub non portano nessuna intestazione `Authorization` né altre credenziali. Un token salvato da una versione fino alla 1.39.0 (nel portachiavi, conto `github-app-updates`) non viene più letto: all'avvio l'app cancella il suo file cifrato; se il portachiavi è bloccato il file resta dov'è, senza effetti, e la cancellazione si riprova all'avvio dopo.
- **Controllo.** L'app chiede a GitHub l'ultima release un minuto dopo l'avvio e poi ogni 12 ore; se c'è una versione più nuova mostra una notifica. Nient'altro viene inviato. «Controlla ora» in **Impostazioni → Dati → Aggiornamenti dell'app** lo fa subito. Se GitHub rifiuta la richiesta (limite delle richieste anonime raggiunto) la scheda lo dice e il controllo successivo riprova.
- **Release valida:** non bozza né pre-release, tag `vX.Y.Z`, con `Histeon-Publish-X.Y.Z-linux-x64.AppImage` e accanto `Histeon-Publish-X.Y.Z-linux-x64.AppImage.minisig`, letti attraverso l'API del repository.
- **Download.** L'API risponde con un reindirizzamento a un indirizzo firmato e temporaneo dell'host di download di GitHub: un reindirizzamento verso un host che non è di GitHub viene rifiutato. AppImage al massimo 512 MB, firma al massimo 4 KB.
- **Verifica prima di installare:**
  - la firma minisign della chiave di rilascio di Histeon (id `7245FEACC0E94D12`): Ed25519 sul BLAKE2b-512 del file e sul commento fidato;
  - il nome del file firmato (`file:` del commento fidato) è esattamente quello dell'allegato;
  - la versione è più nuova di quella in uso;
  - il file è un eseguibile ELF.
- **Installazione.** Solo se l'app gira come AppImage: il file nuovo viene scritto accanto a quello in uso, reso eseguibile e rinominato al suo posto in un solo passo. Un collegamento simbolico non viene seguito. L'app in uso continua finché non si riavvia («Riavvia ora» la riavvia dallo stesso file). Il pacchetto `.deb` e l'installazione Windows si aggiornano a mano dalla release.

## Pubblicare una release

1. `npm run version:set X.Y.Z`: scrive la versione nei sei punti (due `package.json`, tre voci di `package-lock.json`, `version.ts`) e li rilegge; `npm run version:check` controlla senza scrivere, ed è il primo passo di `npm test`.
2. `npm run dist:linux -w @histos-publish/desktop`.
3. Firma l'AppImage con la chiave di rilascio:

   ```bash
   php <checkout del builder>/scripts/sign-release.php sign <chiave-segreta> packages/desktop/release/Histeon-Publish-X.Y.Z-linux-x64.AppImage
   ```

4. `npm run rilascio -- prepara publish --note <file.md>` prepara la release `vX.Y.Z` per `Seventhose/histeon-publish`: l'AppImage, il suo `.minisig`, il `.deb`, l'archivio dei sorgenti `histeon-publish-X.Y.Z-sorgenti.tar.gz` (da `scripts/public-export.sh`, senza `docs/`) e `SHA256SUMS`, con le note controllate come testo pubblico. Dopo il sì del proprietario, `npm run rilascio -- pubblica <cartella> --conferma=<impronta>` la pubblica e la riscarica per verificarla.
