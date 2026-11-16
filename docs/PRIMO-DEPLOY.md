# Preparare il primo deploy

Dopo la configurazione iniziale, il pulsante **Prepara e pubblica** esegue una build nuova, controlla il risultato e lo invia a Cloudflare quando è pronto. Il clic è l’autorizzazione esplicita alla pubblicazione. Se lo scanner trova un blocco, Histeon apre il report e non invia il sito.

Le prove automatiche usano solo Cloudflare simulato in locale.

## Prima di aprire Histeon Publish

Ti servono:

- un account Cloudflare;
- un token API con **Workers Scripts Write** sull’account;
- una cartella, un file HTML, uno ZIP oppure un sito che sei autorizzato a copiare;
- per un dominio personalizzato, una zona attiva nello stesso account;
- se vuoi pubblicare moduli Fluent Forms, WordPress, le impostazioni del modulo e le chiavi Turnstile descritte più avanti.

### Crea un token Cloudflare

Nel pannello Cloudflare apri **My Profile → API Tokens** e crea un token dedicato a Histeon Publish. Limita le risorse all’account che userai. Per riconoscere l’ID account automaticamente aggiungi **Account Settings Read**; se il token non ha questo permesso, puoi inserire l’ID manualmente nelle Impostazioni. Per creare o aggiornare lo script il token deve includere **Workers Scripts Write**; l’utente dell’account potrebbe inoltre aver bisogno del ruolo Admin per creare un Worker nuovo. Le regole dei ruoli possono cambiare: ricontrolla [ruoli e permessi Workers](https://developers.cloudflare.com/workers/authorization/) e [creazione dei token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) mentre lo configuri.

Se colleghi anche un dominio personalizzato, aggiungi una seconda policy limitata alla sola zona interessata: **Zone Read** e **DNS Read**. Aggiungi **DNS Write** solo se vuoi che Histeon possa sostituire, dopo una tua conferma, un CNAME incompatibile. Se pubblichi solo su `workers.dev`, la policy DNS non serve. Non aggiungere accesso a tutte le zone, KV o R2.

In **Impostazioni** inserisci l’ID account Cloudflare e poi il token. Histeon usa l’ID per verificare il token account-owned e lo conserva insieme alle impostazioni locali. Se Cloudflare mostra il token una sola volta e la finestra viene chiusa, creane uno nuovo. Incolla il valore del token così com’è, senza aggiungere `Bearer`.

## Primo deploy di un sito statico

1. Apri Histeon Publish e vai in **Impostazioni**.
2. Incolla il token nel campo **Token API** e scegli **Verifica e salva**. L’app lo verifica e lo salva nel portachiavi del sistema. Se il token può leggere gli account, Histeon trova l’ID: con un solo account lo seleziona da sé; se ne trova più di uno, scegline uno e salva.
3. Se la ricerca account non è disponibile, incolla nelle Impostazioni l’ID account Cloudflare di 32 caratteri e salva.
4. Scegli **Nuovo sito**. Seleziona la cartella oppure il file HTML/ZIP. Per un URL, leggi la richiesta di consenso e autorizza il dominio solo se puoi copiare quel sito.
5. Controlla il nome del sito e il nome Worker. Aggiungi il sito.
6. Per pubblicare subito, premi **Prepara e pubblica**. Histeon prepara una build nuova e la invia se i controlli la giudicano pronta.

Se vuoi controllare prima la resa, usa **Prepara il sito**, leggi il report e apri l’anteprima locale. Dopo la verifica, **Prepara e pubblica** rifà la build per includere le modifiche più recenti e procede se non ci sono blocchi.

## Pubblicare su hosting o VPS

Per un sito solo statico non servono API specifiche del provider. Histeon Publish trasferisce il bundle a qualunque hosting o VPS che esponga FTP, FTPS o SFTP.

1. Apri le impostazioni del sito e in **Dove vuoi pubblicare?** scegli **Hosting o VPS tramite FTP / FTPS / SFTP**.
2. Copia dal pannello hosting il server, la porta, il nome utente e la cartella pubblica del sito. Inserisci l’host senza `ftp://` o `sftp://` e la cartella, spesso `public_html` o `www`.
3. Usa **SFTP** per un VPS (di solito porta 22) e **FTPS** per un hosting condiviso. SFTP è integrato e funziona su Linux, macOS e Windows. FTP non cifra la password ed è disponibile solo dopo una conferma esplicita.
4. Con SFTP scegli accesso con password o incolla la chiave privata SSH. Alla prima connessione Histeon mostra l’impronta del server e non invia ancora credenziali. Confrontala con l’impronta fornita dal tuo hosting o dal suo supporto e confermala nella schermata.
5. Premi **Verifica e salva la destinazione**. Le credenziali vengono conservate nel portachiavi locale.
6. Premi **Prepara e pubblica**. Histeon ricrea il bundle e lo trasferisce. I file della cartella remota che non sono presenti nella build nuova non vengono cancellati.

La destinazione trasferisce file statici. Funzioni WordPress come Fluent Forms richiedono la destinazione Cloudflare Workers di Histeon Publish. Per un VPS, SFTP carica i file nel document root, ma non installa né configura Apache, Nginx, PHP, HTTPS o DNS.

Histeon Publish crea o aggiorna uno script Worker con gli asset statici. Se vuoi un indirizzo `workers.dev`, abilita quel sottodominio e l’accesso al Worker nell’account Cloudflare.

### Autorizzazione Cloudflare

L’ID Cloudflare individua l’account ma non autorizza le modifiche. Per questo Histeon usa un token API, verificato una volta e conservato nel portachiavi del sistema. L’autorizzazione OAuth è un’alternativa futura, non serve per pubblicare con un clic.

## Collegare il dominio senza modificare i DNS a mano

1. Pubblica prima il sito sul Worker.
2. Apri la schermata del sito e scrivi il dominio principale, per esempio `example.org`.
3. Lascia selezionato **Collega anche www** se vuoi che funzionino sia `example.org` sia `www.example.org`. La casella compare solo per il dominio principale della zona (o per il suo `www.`): un sottodominio come `blog.example.org` si collega da solo.
4. Scegli **Collega dominio**. Histeon Publish controlla che la zona sia attiva nell’account e legge i record dei due hostname. Questo controllo non cambia nulla.
5. Se trova un CNAME incompatibile, la schermata mostra nome e destinazione. Confermando, Histeon Publish rimuove solo quel CNAME e chiede a Cloudflare di collegare il Worker. Se Cloudflare rifiuta il collegamento, l’app prova a ripristinare il record precedente.
6. Cloudflare crea i record del Worker e il certificato HTTPS. L’emissione del certificato può richiedere qualche minuto.

Se la zona ha attive le «JavaScript detections» della gestione dei bot, Cloudflare inietta in `/` uno script inline (`/cdn-cgi/challenge-platform/…`). Una Content Security Policy rigida in `_headers` lo blocca e la console lo segnala, ma il sito funziona: non è un difetto di Histeon Publish.

Histeon Publish non modifica i record MX/TXT della posta né i DNS di altri hostname. Se un nome è già collegato a un altro Worker, la procedura si ferma e ti indica il conflitto. Se il token non ha DNS Write, il controllo funziona ma l’app non può sostituire il CNAME: aggiungi quel permesso oppure rimuovi manualmente il solo record indicato e ripeti il controllo.

## Moduli Fluent Forms e Fluent SMTP

Questa integrazione è facoltativa. Non attivarla finché non hai controllato dove WordPress invia i messaggi.

### Prepara WordPress e la consegna email

1. In Fluent Forms controlla i destinatari e le notifiche email di ogni modulo che vuoi pubblicare.
2. Configura Fluent SMTP sul sito con il provider che hai scelto. Esegui il test di consegna previsto da Fluent SMTP e controlla la casella destinataria.
3. Assicurati che WordPress sia raggiungibile in HTTPS e che `/wp-json/` risponda. In Histeon inserirai la base REST, per esempio `https://sito.example/wp-json/`; l’invio viene inoltrato al servizio AJAX di Fluent Forms sullo stesso sito.
4. In Cloudflare Turnstile crea un widget per l’hostname pubblico su cui servirai il sito (`workers.dev` o il dominio personalizzato). Conserva la chiave pubblica e quella segreta.

Se il bundle contiene una Content Security Policy rigida in `_headers`, controlla che consenta gli script e gli iframe di `https://challenges.cloudflare.com`, come indicato nella [guida CSP di Turnstile](https://developers.cloudflare.com/turnstile/reference/content-security-policy/).

Fluent Forms invia la notifica attraverso WordPress. Se hai configurato Fluent SMTP, questo consegna tramite il provider scelto nelle sue impostazioni. Histeon Publish non riceve la password SMTP e non invia email autonomamente. Vedi il [progetto Fluent SMTP](https://github.com/WPManageNinja/fluent-smtp).

**Attribuzione:** FluentSMTP è sviluppato da WPManageNinja LLC e dai contributori del progetto, con licenza GPL-2.0-or-later. È un software separato: Histeon Publish non lo include e non è affiliato ai suoi autori. Consulta il [repository ufficiale](https://github.com/WPManageNinja/fluent-smtp) per codice, licenza e supporto.

### Collega il modulo

1. Apri le impostazioni del sito in Histeon Publish.
2. Inserisci l’indirizzo REST WordPress, gli ID numerici dei soli moduli da attivare e la chiave pubblica Turnstile.
3. Inserisci anche la chiave segreta Turnstile nel campo dedicato. Viene salvata nel portachiavi locale; non entra nel JSON di configurazione o nella build.
4. Salva e ricrea la build. Il report indica quali moduli sono stati collegati e quali sono rimasti inattivi.
5. Pubblica solo dopo aver controllato report, account, Worker e destinatari. Durante il deploy confermato, la chiave segreta viene inviata a Cloudflare come binding segreto del Worker.
6. Dopo il deploy, prova un invio controllato e controlla la risposta di Fluent Forms e la casella configurata in Fluent SMTP.

Allegati, CAPTCHA già inseriti, pagamenti, moduli di altri plugin e ID non trovati restano inattivi o vengono segnalati. Il Worker limita dimensione e numero dei campi, verifica Turnstile e non ripete automaticamente un invio fallito. Una prova locale non dimostra la consegna reale: fai la prova controllata sul sito quando decidi di pubblicarlo.

## Se il deploy viene rifiutato

- **Token non valido:** ricontrolla il permesso, l’account selezionato e la data di scadenza del token.
- **Permesso insufficiente:** il ruolo Cloudflare del tuo utente e i permessi del token sono controlli separati. Un token limitato a uno specifico Worker può pubblicare solo su quel Worker già creato. Per il dominio servono Editor sul Worker e Zone Read e DNS Read sulla zona; DNS Edit serve se l’app deve sostituire un CNAME incompatibile.
- **Build bloccata:** apri il report; lo Scanner impedisce la pubblicazione finché resta un elemento bloccante.
- **Modulo non collegato:** controlla che l’ID Fluent Forms sia configurato e presente in una pagina pubblicata; moduli con allegati, CAPTCHA o pagamenti restano inattivi.
- **Modulo accettato ma email assente:** verifica il destinatario e le notifiche di Fluent Forms, quindi il registro Fluent SMTP e il provider configurato.

Puoi consultare deploy e versioni precedenti nell’attività del sito. Il rollback modifica traffico Cloudflare e richiede una conferma.
