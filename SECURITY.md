# Sicurezza

Histeon Publish gira sul computer di chi lo usa, con le sue credenziali di Cloudflare, dei server FTP e SFTP e dei siti WP collegati: una falla può toccare siti veri. Se ne trovi una, segnalala in privato, non in una issue pubblica.

## Come segnalare

- Sul repository pubblico usa **Security → Report a vulnerability** (segnalazione privata di GitHub). Solo i manutentori la vedono.
- Scrivi la versione di Histeon Publish (o il commit), il sistema operativo, cosa può fare chi sfrutta la falla e da dove (un sito letto, un prototipo, un altro processo sul computer, la rete), e i passi per riprodurla.
- Non provarla su siti o account che non sono tuoi.

Rispondiamo il prima possibile, diciamo se la confermiamo e, quando la correzione è pronta, la pubblichiamo con una nota nella versione che la contiene. Chi l'ha segnalata è citato, se lo desidera.

## Versioni coperte

Solo l'ultima versione di Histeon Publish. Le versioni precedenti non ricevono correzioni: aggiorna.

La copia del builder in `packages/cms/vendor/histos/` viene dal repository `Seventhose/histeon`: una falla nel suo codice va segnalata lì; se riguarda solo come Publish la usa, segnalala qui.

## Le superfici di Publish

- **Server locale.** L'interfaccia è servita da un server che ascolta solo su `127.0.0.1`, con un token di sessione e i controlli su `Host` e `Origin`. Una pagina web aperta nel browser, o un altro account del computer, non deve poterlo usare.
- **Connettore per agenti AI.** Spento di serie. Quando è acceso, un secondo server su `127.0.0.1` accetta solo richieste firmate con una chiave nuova a ogni attivazione e solo le operazioni di un elenco chiuso: un agente non può pubblicare, leggere impostazioni o credenziali, né eliminare. Gli invii a WP vanno solo in sviluppo e secondo il permesso dato a quel collegamento.
- **Lettura di siti e file.** Il crawler, l'importatore di pagine e prototipi e i lettori dei file di design trattano tutto ciò che leggono come dato non fidato: niente richieste verso indirizzi privati senza una conferma separata, niente percorsi della macchina nelle copie pubblicate, niente codice eseguito fuori da un browser isolato.
- **Credenziali.** Token e password stanno nel portachiavi del sistema; un portachiavi Linux non protetto è rifiutato. Non compaiono nei messaggi, nei registri né nelle risposte del server.
- **Agente Linux.** Riceve da Publish solo richieste firmate, ascolta su loopback o su una rete privata e gira con un account suo, diverso da quello del server web.
- **Aggiornamenti dell'app.** Un pacchetto viene installato solo se la firma della chiave di rilascio è valida.

## Cosa Publish considera una falla

- un sito letto, un prototipo, un file di design o una risposta di un server che fa eseguire codice, scrivere fuori dalle cartelle dell'app o fare richieste verso indirizzi interni;
- un altro processo, un altro account del computer o una pagina web che usa il server locale o il connettore senza la chiave;
- segreti (token, password, chiavi) che finiscono nei file pubblicati, nei registri o in risposte leggibili;
- un agente collegato al connettore che fa più di quello che l'elenco delle operazioni permette;
- un aggiornamento o un pacchetto non verificato che viene installato.

Non sono falle di Publish ciò che può già fare chi ha accesso all'account del computer con i permessi dell'utente, né i problemi dei siti, dei plugin e dei servizi di terzi a cui Publish si collega.
