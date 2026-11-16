#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
umask 077
if [ ! -f .env ]; then
  printf 'WP_FIXTURE_PORT=8877\nWP_FIXTURE_ADMIN_USER=histos-fixture\n' > .env
  printf 'WP_FIXTURE_DB_PASSWORD=%s\nWP_FIXTURE_ROOT_PASSWORD=%s\nWP_FIXTURE_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" >> .env
  chmod 600 .env
fi
set -a
. ./.env
set +a
docker compose --profile tools up -d database wordpress wpcli
printf 'Attendo WordPress locale...\n'
ready=false
for attempt in $(seq 1 60); do
  if docker compose exec -T wpcli wp core is-installed --path=/var/www/html --allow-root >/dev/null 2>&1; then
    ready=true
    break
  fi
  if docker compose exec -T wpcli test -f /var/www/html/wp-includes/version.php >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if [ "$ready" != true ]; then
  docker compose exec -T wpcli wp core install --path=/var/www/html --url="http://127.0.0.1:${WP_FIXTURE_PORT:-8877}" --title="Histeon Publish fixture" --admin_user="$WP_FIXTURE_ADMIN_USER" --admin_password="$WP_FIXTURE_ADMIN_PASSWORD" --admin_email=histos-fixture@example.invalid --skip-email --allow-root >/dev/null
fi
if ! docker compose exec -T wpcli wp theme is-installed twentytwentyfive --path=/var/www/html --allow-root >/dev/null 2>&1; then
  docker compose exec -T wpcli wp theme install twentytwentyfive --activate --path=/var/www/html --allow-root >/dev/null
fi
docker compose exec -T wpcli wp theme activate twentytwentyfive --path=/var/www/html --allow-root >/dev/null
if ! docker compose exec -T wpcli wp plugin is-installed contact-form-7 --path=/var/www/html --allow-root >/dev/null 2>&1; then
  docker compose exec -T wpcli wp plugin install contact-form-7 --activate --path=/var/www/html --allow-root >/dev/null
fi
if ! docker compose exec -T wpcli wp plugin is-installed woocommerce --path=/var/www/html --allow-root >/dev/null 2>&1; then
  docker compose exec -T wpcli wp plugin install woocommerce --activate --path=/var/www/html --allow-root >/dev/null
fi
docker compose exec -T wpcli wp plugin activate contact-form-7 woocommerce --path=/var/www/html --allow-root >/dev/null
if ! docker compose exec -T wpcli wp option get histos_fixture_seeded --path=/var/www/html --allow-root >/dev/null 2>&1; then
  docker compose exec -T wpcli wp rewrite structure '/%postname%/' --path=/var/www/html --allow-root >/dev/null
  home_id=$(docker compose exec -T wpcli wp post create --post_type=page --post_status=publish --post_title="Home fixture" --post_name=home-fixture --post_content='<h1>Home di prova</h1>' --porcelain --path=/var/www/html --allow-root | tr -d '\r')
  docker compose exec -T wpcli wp option update show_on_front page --path=/var/www/html --allow-root >/dev/null
  docker compose exec -T wpcli wp option update page_on_front "$home_id" --path=/var/www/html --allow-root >/dev/null
  docker compose exec -T wpcli wp post create --post_type=page --post_status=publish --post_title="Chi siamo" --post_name=about-fixture --post_content='<p>Pagina informativa.</p>' --path=/var/www/html --allow-root >/dev/null
  docker compose exec -T wpcli wp post create --post_type=page --post_status=publish --post_title="Città e tradizione" --post_name=citta-e-tradizione --post_content='<p>Test italiano.</p>' --path=/var/www/html --allow-root >/dev/null
  category_id=$(docker compose exec -T wpcli wp term create category "Notizie fixture" --slug=notizie-fixture --porcelain --path=/var/www/html --allow-root | tr -d '\r')
  for index in $(seq 1 12); do
    post_id=$(docker compose exec -T wpcli wp post create --post_status=publish --post_title="Notizia fixture $index" --post_name="notizia-fixture-$index" --post_content="<p>Contenuto $index.</p>" --porcelain --path=/var/www/html --allow-root | tr -d '\r')
    docker compose exec -T wpcli wp post term set "$post_id" category "$category_id" --path=/var/www/html --allow-root >/dev/null
  done
  docker compose exec -T wpcli wp option update posts_per_page 5 --path=/var/www/html --allow-root >/dev/null
  old_id=$(docker compose exec -T wpcli wp post create --post_status=publish --post_title="Articolo vecchio" --post_name=vecchio-slug-fixture --porcelain --path=/var/www/html --allow-root | tr -d '\r')
  docker compose exec -T wpcli wp post update "$old_id" --post_title="Articolo nuovo" --post_name=nuovo-slug-fixture --path=/var/www/html --allow-root >/dev/null
  form_id=$(docker compose exec -T wpcli wp post create --post_type=wpcf7_contact_form --post_status=publish --post_title="Form fixture" --post_content='[text* your-name][email* your-email][submit "Invia"]' --porcelain --path=/var/www/html --allow-root | tr -d '\r')
  docker compose exec -T wpcli wp post update "$home_id" --post_content="<h1>Home</h1><a href='/about-fixture/'>Chi siamo</a><a href='/citta-e-tradizione/'>Pagina italiana</a>[contact-form-7 id='$form_id' title='Form fixture']" --path=/var/www/html --allow-root >/dev/null
  product_id=$(docker compose exec -T wpcli wp post create --post_type=product --post_status=publish --post_title="Prodotto fixture" --post_name=prodotto-fixture --post_content='<p>Prodotto WooCommerce locale.</p>' --porcelain --path=/var/www/html --allow-root | tr -d '\r')
  docker compose exec -T wpcli wp post meta update "$product_id" _regular_price 19.90 --path=/var/www/html --allow-root >/dev/null
  docker compose exec -T wpcli wp post meta update "$product_id" _price 19.90 --path=/var/www/html --allow-root >/dev/null
  docker compose exec -T wpcli wp post meta update "$product_id" _stock_status instock --path=/var/www/html --allow-root >/dev/null
  docker compose exec -T wpcli wp rewrite flush --path=/var/www/html --allow-root >/dev/null
  docker compose exec -T wpcli wp option update histos_fixture_seeded 1 --path=/var/www/html --allow-root >/dev/null
fi
printf 'Fixture pronta: http://127.0.0.1:%s/ (utente admin: %s; password nel file test-sites/wp/.env).\n' "${WP_FIXTURE_PORT:-8877}" "$WP_FIXTURE_ADMIN_USER"
