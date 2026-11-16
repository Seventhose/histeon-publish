# Fixture WordPress locale

La fixture avvia WordPress, MariaDB e WP-CLI con Docker Compose solo su `127.0.0.1:8877`. Installa il tema Twenty Twenty-Five, Contact Form 7 e WooCommerce, quindi crea pagine, categoria paginata, articoli, un cambio di slug e un prodotto. Serve per il test anonimo e in sola lettura del crawler.

```sh
./up.sh
./down.sh
```

`up.sh` genera una `.env` con permessi `0600`; password casuali e volumi restano locali e non sono stampati. `down.sh` ferma i container senza cancellare i volumi. Per rimuovere i dati, eliminare esplicitamente i volumi Docker del progetto e il file `.env` dopo aver verificato di non averne più bisogno.

Il crawler può leggere `http://127.0.0.1:8877/` con consenso esplicito per `http://127.0.0.1:8877`. I test non richiedono credenziali amministrative.
