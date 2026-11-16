# Agente di pubblicazione

L’agente è un servizio Linux opzionale per chi ospita WordPress su un server proprio o in una rete privata. Riceve da Histeon richieste firmate, legge il sito in modalità export, lo controlla e pubblica su un Worker Cloudflare dedicato. WordPress non riceve né conserva il token Cloudflare.

Le prove automatiche dell’agente usano fixture locali e il mock Cloudflare: prima dell’uso su un sito pubblico fai una prova controllata.

## Prerequisiti

- Linux e Node.js 22.13 o successivo;
- un Worker Cloudflare dedicato al sito, non condiviso con moduli nativi Histeon;
- un token Cloudflare con permessi Workers Scripts necessari a leggere versioni e pubblicare sul solo Worker scelto; non servono permessi DNS;
- WordPress raggiungibile dall’agente all’indirizzo configurato come origine;
- una rete privata tra WordPress e agente oppure un tunnel WireGuard/SSH se i server sono su una rete non fidata.

Il servizio deve usare un account di sistema `histos-agent`, diverso dall’utente del web server (`www-data`). La v1 non implementa TLS. Non esporre la porta dell’agente su Internet.

## Configurazione

Salva un file `agent.json` leggibile dal servizio e non scrivibile da gruppo o altri. Lo schema completo è in [agent.schema.json](spec/agent.schema.json). I valori non indicati usano i default dello schema.

Esempio minimo:

```json
{
  "schemaVersion": 1,
  "dataDir": "/var/lib/histos-publish-agent",
  "site": {
    "name": "mio-sito",
    "origin": "https://www.example.org"
  },
  "cloudflare": {
    "accountId": "0123456789abcdef0123456789abcdef",
    "script": "mio-sito-statico"
  }
}
```

`site.origin` deve essere solo schema, host e porta, senza percorso; deve coincidere con l’indirizzo `home` di WordPress. Se WordPress è sulla stessa rete Docker, usa il nome del servizio, per esempio `http://wordpress`, e abilita `site.privateNetwork`. Per quell’eccezione l’agente accetta solo indirizzi privati o loopback e blocca risposte DNS miste. Gli asset esterni restano soggetti alla protezione ordinaria del crawler.

Il nome in `cloudflare.script` identifica il Worker dedicato. Il primo deploy dell’agente ne sostituisce codice e versioni distribuite; non riusare il Worker pubblicato direttamente da Histeon se contiene moduli nativi o altre rotte.

## Token e chiavi

I segreti non vanno in `agent.json`, nel database o in un portachiavi grafico. L’agente accetta il token Cloudflare da una sola sorgente:

- `HISTOS_CLOUDFLARE_API_TOKEN_FILE` con il percorso di un file protetto;
- `HISTOS_CLOUDFLARE_API_TOKEN` con il valore impostato nell’ambiente del servizio.

Se usi un file, deve essere regolare, non un symlink, massimo 4 KiB e con permessi `0400` o `0600` per l’utente agente. Per le credenziali systemd è accettato anche un file root-owned, nel gruppo del servizio e con mode `0440`. Lo stesso controllo vale per le chiavi HMAC e per il segreto Turnstile.

Crea una chiave HMAC con:

```sh
histos-publish agent-key --keys-file /var/lib/histos-publish-agent/agent-keys.json --id k1
```

Il comando stampa una sola volta l’oggetto JSON con l’ID e il segreto. Copialo in modo sicuro nella configurazione di Histeon. Proteggi il file con `chmod 0600`; può contenere una o due chiavi durante la rotazione. Non inviare il segreto via email o ticket.

L’agente deve ricevere il percorso del file chiavi in `HISTOS_AGENT_KEYS_FILE`. Se `site.forms` è configurato, aggiungi il segreto Turnstile con `HISTOS_TURNSTILE_SECRET_FILE`.

Rotazione HMAC: aggiungi la nuova chiave, riavvia l’agente, aggiorna Histeon, rimuovi la chiave precedente e riavvia di nuovo.

## Avvio manuale

```sh
export HISTOS_CLOUDFLARE_API_TOKEN_FILE=/etc/histos-publish/secrets/cloudflare-token
export HISTOS_AGENT_KEYS_FILE=/var/lib/histos-publish-agent/agent-keys.json
histos-publish agent --config /etc/histos-publish/agent.json
```

All’avvio compare una riga JSON con indirizzo di ascolto, origine e nome Worker, senza account ID né segreti. `Ctrl+C` o `SIGTERM` ferma le richieste, annulla il job in corso e chiude il servizio.

## Installazione con systemd

Crea l’utente e il gruppo dedicati, quindi prepara file segreti leggibili solo da root o dall’utente agente. Il token e i file di configurazione devono stare fuori dalla cartella pubblica del sito.

Esempio `/etc/systemd/system/histos-publish-agent.service`:

```ini
[Unit]
Description=Histeon Publish — agente di pubblicazione
After=network-online.target
Wants=network-online.target

[Service]
User=histos-agent
Group=histos-agent
ExecStart=/usr/bin/node /opt/histos-publish/packages/cli/dist/index.js agent --config /etc/histos-publish/agent.json
LoadCredential=cloudflare-token:/etc/histos-publish/secrets/cloudflare-token
LoadCredential=agent-keys:/var/lib/histos-publish-agent/agent-keys.json
Environment=HISTOS_CLOUDFLARE_API_TOKEN_FILE=%d/cloudflare-token
Environment=HISTOS_AGENT_KEYS_FILE=%d/agent-keys
StateDirectory=histos-publish-agent
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/histos-publish-agent
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
Restart=on-failure
TimeoutStopSec=30s

[Install]
WantedBy=multi-user.target
```

Dopo aver creato l’unità, controlla i file materializzati da `LoadCredential=` con `stat -c '%u %g %a %n' "$CREDENTIALS_DIRECTORY/cloudflare-token"` e `.../agent-keys`. Il lettore rifiuta permessi o proprietari diversi dai casi descritti sopra: se i metadati non rientrano nei casi accettati, il servizio non parte e va corretto il setup delle credenziali prima dell’avvio.

Poi:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now histos-publish-agent.service
sudo systemctl status histos-publish-agent.service
sudo journalctl -u histos-publish-agent.service -f
```

Il comando `histos-publish agent` richiede `--config`. Gli errori di configurazione escono con codice 2, quelli relativi a segreti o permessi con codice 4.

## Docker Compose

Il Dockerfile usa l’immagine ufficiale Node 22 Bookworm slim fissata al digest verificato, installa solo le dipendenze runtime di core/server/CLI e non include Electron o l’interfaccia desktop. Prima della build genera le cartelle `dist` con:

```sh
npm ci
npm run build -w @histos-publish/core
npm run build -w @histos-publish/server
npm run build -w @histos-publish/cli
docker build -f packages/server/Dockerfile.agent -t histos-publish-agent:0.1.11 .
```

Esempio `agent.json` per WordPress e agente nella stessa rete Docker:

```json
{
  "schemaVersion": 1,
  "listen": {
    "host": "0.0.0.0",
    "allInterfaces": true,
    "port": 8787,
    "allowedHosts": ["histos-agent:8787", "127.0.0.1:8787"]
  },
  "dataDir": "/var/lib/histos-publish-agent",
  "site": {
    "name": "mio-sito",
    "origin": "http://wordpress",
    "privateNetwork": true
  },
  "cloudflare": {
    "accountId": "0123456789abcdef0123456789abcdef",
    "script": "mio-sito-statico"
  }
}
```

`wordpress` è il nome DNS del servizio WordPress dentro la rete Docker; `home` in WordPress deve usare lo stesso indirizzo. Collega entrambi i container a una rete interna comune.

Esempio `compose.yaml`:

```yaml
services:
  histos-agent:
    image: histos-publish-agent:0.1.11
    read_only: true
    tmpfs:
      - /tmp
    volumes:
      - agent-data:/var/lib/histos-publish-agent
      - ./agent.json:/etc/histos-publish/agent.json:ro
    secrets:
      - cloudflare-token
      - agent-keys
    environment:
      HISTOS_CLOUDFLARE_API_TOKEN_FILE: /run/secrets/cloudflare-token
      HISTOS_AGENT_KEYS_FILE: /run/secrets/agent-keys
    networks:
      - wp-internal
    # Non aggiungere "ports": WordPress raggiunge l'agente sulla rete interna.

secrets:
  cloudflare-token:
    file: ./secrets/cloudflare-token
  agent-keys:
    file: ./secrets/agent-keys.json

volumes:
  agent-data:

networks:
  wp-internal:
    external: true
```

Per i segreti montati come file, assegna sul server `uid 10001` e mode `0400`; la directory dati deve essere privata e scrivibile da `10001:10001`. Non pubblicare la porta Docker sul server. L’agente ascolta su tutte le interfacce del container solo perché `allInterfaces` è esplicitamente attivo; il container resta collegato solo alla rete interna.

Controlla l’avvio e lo stato con `docker compose logs -f histos-agent` e `docker compose ps`. Un container sano risponde `204` su `/healthz` all’interno della propria rete.

## Limiti della v1

- WordPress installato in una sottocartella non è supportato;
- l’origine configurata deve coincidere con `home` di WordPress; non si può usare un IP alternativo mantenendo un altro header Host;
- una build che supera la scadenza del token export si ferma e va ripetuta da Histeon;
- i moduli nativi Histeon bloccano il deploy su questo Worker. Fluent Forms può essere abilitato nella configurazione agente con Turnstile; Fluent SMTP resta installato e configurato su WordPress;
- l’agente supporta Linux e non offre TLS nella v1;
- l’esempio Docker non pubblica porte e richiede WordPress sulla rete `wp-internal`;
- questa versione non gestisce domini o DNS e non chiama WordPress per notificare i job.

## Cosa protegge e cosa no

WordPress non può leggere il token Cloudflare né scegliere account, Worker o origine. Una compromissione di WordPress può comunque chiedere di pubblicare contenuto alterato o ripristinare una versione dello stesso Worker. Una compromissione dell’agente compromette anche il token Cloudflare: separa l’utente di sistema dal web server, limita il token al Worker dedicato e proteggi i backup della configurazione e dei segreti.
