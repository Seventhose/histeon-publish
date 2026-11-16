import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildPrototypeProfile,
  CmsProjectCatalog,
  decodeStaticPageArchive,
  encodeStaticPageArchive,
  parsePrototype,
  queryItemWithMedia,
} from "../packages/cms/dist/index.js";
import { applyRemoteSyncPlan, CmsRemoteCatalog, connectRemoteSite, createRemoteSyncPlan } from "../packages/server/dist/cms-remote.js";
import { readPairingCode, TEST_CONTAINER } from "./wordpress-test-pairing.mjs";

/**
 * Queue C6, interoperability with the builder: the shop prototype (a product type with its product and shop templates,
 * product categories and tags, products on sale, out of stock and in draft) goes into Publish, through the bridge onto
 * a disposable WordPress with Histeon and WooCommerce, is released, and comes back into an empty catalog with the same
 * revision hashes. On the way:
 * - a send without a release never changes the live products, and the release applies them;
 * - WooCommerce holds the products as simple products with their prices, SKU, stock status, images and terms;
 * - the site renders them with the project's templates in place of WooCommerce's product and shop templates;
 * - the static site's «aggiungi al carrello» link (`?product=<slug>`) reaches the product on WordPress;
 * - nothing but the catalogue changes: no order, customer or stock quantity.
 */

const container = process.env.HISTOS_TEST_WP_CONTAINER;
const pairingFile = process.env.HISTOS_TEST_PAIRING_CODE_FILE;
if (!container || !TEST_CONTAINER.test(container)) throw new TypeError("Serve uno stack Docker usa-e-getta histos-cms-* (HISTOS_TEST_WP_CONTAINER).");
if (!pairingFile) throw new TypeError("Serve il codice di collegamento locale (HISTOS_TEST_PAIRING_CODE_FILE).");

const root = await mkdtemp(path.join(os.tmpdir(), "histos-commerce-roundtrip-"));
const remotes = new CmsRemoteCatalog(root);
const secrets = new Map();
const secretStoreFor = (account) => ({
  get: async () => secrets.get(account) ?? null,
  set: async (value) => secrets.set(account, value),
  delete: async () => secrets.delete(account),
});

/** Runs PHP in the disposable WordPress as its administrator; prints JSON. */
function php(body) {
  const code = String.raw`require "/var/www/html/wp-load.php"; $user=get_user_by("login","admin"); if (!$user) { fwrite(STDERR,"admin user missing\n"); exit(20); } wp_set_current_user($user->ID); ` + body;
  return JSON.parse(execFileSync("docker", ["exec", container, "php", "-r", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

function releaseOnWordPress() {
  const result = php(String.raw`try { \XB\Plugin::instance()->versioning->publish(null, "Release di prova C6"); } catch (\XB\Versioning\VersioningException $e) { if (400 !== $e->getCode()) { fwrite(STDERR, $e->getMessage()."\n"); exit(21); } \XB\Remote\ContentProfileAdapter::apply_queue(0); } echo wp_json_encode(array("released" => true, "queue" => get_option("xb_cms_pending_contents", array())));`);
  assert.equal(result.released, true, "la release di prova su WordPress non è riuscita");
  return result;
}

/** The products of the shop as WooCommerce holds them, by slug. */
function products() {
  return php(String.raw`$out = array(); foreach (get_posts(array("post_type" => "product", "post_status" => "any", "posts_per_page" => -1)) as $post) { $p = wc_get_product($post->ID); $out[$post->post_name] = array("id" => $post->ID, "status" => $post->post_status, "type" => $p->get_type(), "name" => $p->get_name(), "regular" => $p->get_regular_price("edit"), "sale" => $p->get_sale_price("edit"), "sku" => $p->get_sku("edit"), "stock" => $p->get_stock_status("edit"), "manageStock" => $p->get_manage_stock(), "short" => $p->get_short_description("edit"), "image" => (int) $p->get_image_id("edit"), "gallery" => array_map("intval", $p->get_gallery_image_ids("edit")), "cats" => wp_get_object_terms($post->ID, "product_cat", array("fields" => "slugs")), "tags" => wp_get_object_terms($post->ID, "product_tag", array("fields" => "slugs"))); } echo wp_json_encode((object) $out);`);
}

async function applyPlan(connectionId, action, catalog, plan) {
  if (!plan.applyAllowed || !plan.planId || plan.counts.conflict !== 0) throw new Error(`Piano ${action} non applicabile senza conflitti: ${JSON.stringify(plan.counts)}; ${(plan.entities ?? []).filter((entity) => entity.status !== "unchanged").map((entity) => `${entity.kind} ${entity.label} ${entity.status}${entity.blockedReason ? ` (${entity.blockedReason})` : ""}`).join("; ")}`);
  const result = await applyRemoteSyncPlan({ connectionId, planId: plan.planId }, remotes, catalog, secretStoreFor);
  if (!result.complete) throw new Error(`Il trasferimento ${action} non è stato completato.`);
}

async function exportSummary(catalog, projectId) {
  const opened = await catalog.openProject(projectId);
  if (!opened) throw new Error(`Il progetto ${projectId} non è nel catalogo.`);
  try {
    const archive = await encodeStaticPageArchive(opened.project, opened.store);
    const decoded = await decodeStaticPageArchive(archive);
    const entities = new Map(decoded.profile.entities.filter((entity) => entity.kind !== "tombstone").map((entity) => [entity.id, entity]));
    const files = new Map(decoded.profile.manifest.files.map((file) => [file.path, file.sha256]));
    return { entities, files, capabilities: decoded.profile.manifest.requiredCapabilities, archiveSha256: createHash("sha256").update(archive).digest("hex") };
  } finally {
    opened.store.close();
  }
}

const describe = (entity) => {
  const payload = entity.payload ?? {};
  const name = ["key", "taxonomyKey", "slug", "label", "title", "ref"].filter((key) => typeof payload[key] === "string").map((key) => `${key}=${payload[key]}`).join(" ");
  return `${entity.kind} ${entity.id}${name ? ` (${name})` : ""}`;
};
/** What WordPress could add of its own: WooCommerce's default product category, which the builder leaves out until the project uses it (cms-bridge §15). */
const isWordPressNative = (entity) => entity.kind === "term" && entity.payload.taxonomyKey === "product_cat" && entity.payload.slug === "uncategorized";

try {
  const { code, target } = await readPairingCode(pairingFile);
  const source = new CmsProjectCatalog(path.join(root, "publish"));
  const returned = new CmsProjectCatalog(path.join(root, "returned"));
  const scratch = new CmsProjectCatalog(path.join(root, "scratch"));
  await Promise.all([source.initialize(), returned.initialize(), scratch.initialize()]);

  // Prototype → Publish, as "Importa prototipo" does: the shop's settings with it.
  const prototype = await readFile(new URL("../packages/cms/test/fixtures/prototipo-negozio.html", import.meta.url), "utf8");
  const built = await buildPrototypeProfile(parsePrototype(prototype), scratch);
  const imported = await source.importStaticPageProfile(built.profile, built.files);
  const projectId = imported.project.id;
  // The static site links to the shop on this WordPress.
  imported.store.setShopSettings({ url: target.origin, currency: "EUR" });
  const staticLink = queryItemWithMedia(imported.store.content.listRecords({ typeKey: "product", status: "published", limit: 10 }).items.find((item) => item.slug === "tazza-blu"), imported.store, projectId).product.addToCartUrl;
  assert.equal(staticLink, `${target.origin}/?product=tazza-blu`);
  imported.store.close();
  const before = await exportSummary(source, projectId);
  assert.ok(before.capabilities.includes("commerce:products:v1"), "il trasferimento dichiara i prodotti");

  // Publish → WordPress (the plugin declares commerce:products:v1 with WooCommerce active, or nothing is sent).
  const connection = await connectRemoteSite(code, remotes, secretStoreFor);
  if (connection.projectId !== null) throw new Error("Il WordPress usa-e-getta è già collegato a un progetto: serve uno stack nuovo; nulla è stato inviato.");
  const push = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, source, secretStoreFor);
  assert.ok(push.initializingRemote, "il WordPress di prova deve essere vuoto");
  await applyPlan(connection.id, "push", source, push);
  assert.deepEqual(products(), {}, "un invio senza release non mette prodotti nel negozio");
  releaseOnWordPress();

  const shop = products();
  assert.deepEqual(Object.keys(shop).sort(), ["ciotola", "piatto-grande", "tazza-blu"]);
  const tazza = shop["tazza-blu"];
  assert.deepEqual({ status: tazza.status, type: tazza.type, regular: tazza.regular, sale: tazza.sale, sku: tazza.sku, stock: tazza.stock, manageStock: tazza.manageStock, short: tazza.short, cats: tazza.cats, tags: tazza.tags },
    { status: "publish", type: "simple", regular: "24", sale: "19.5", sku: "TZ-BLU", stock: "instock", manageStock: false, short: "Ceramica smaltata a mano & cotta due volte.", cats: ["tazze"], tags: ["ceramica"] });
  assert.ok(tazza.image > 0 && tazza.gallery.length === 1 && tazza.gallery[0] !== tazza.image, "immagine e galleria sono allegati della libreria");
  assert.deepEqual({ status: shop["piatto-grande"].status, stock: shop["piatto-grande"].stock, sale: shop["piatto-grande"].sale }, { status: "publish", stock: "outofstock", sale: "" });
  assert.equal(shop.ciotola.status, "draft", "un prodotto in bozza resta in bozza");

  // What the site prints with the project's templates in place of WooCommerce's.
  const page = async (address) => {
    const response = await fetch(new URL(address, target), { signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200, `WordPress deve servire ${address}`);
    return { url: response.url, html: await response.text() };
  };
  const single = await page("/product/tazza-blu/");
  assert.match(single.html, /<article class="prodotto">/u, "la pagina del prodotto usa il template del progetto");
  assert.match(single.html, /<p class="sku">TZ-BLU<\/p>/u);
  assert.match(single.html, /<p class="breve">Ceramica smaltata a mano &amp; cotta due volte\.<\/p>/u);
  assert.match(single.html, new RegExp(`<img class="principale" src="${target.origin.replaceAll(".", "\\.")}/wp-content/uploads/[^"]+" alt="Tazza blu"`, "u"), "l'immagine del prodotto è il suo allegato");
  assert.match(single.html, /<a class="carrello" href="[^"]*add-to-cart=\d+[^"]*">/u, "su WordPress «aggiungi al carrello» è quello di WooCommerce");
  const archive = await page("/?post_type=product");
  assert.match(archive.html, /<article class="scheda"><a class="nome" href="[^"]+">Tazza blu<\/a>/u, "l'archivio dei prodotti usa il template del negozio del progetto");
  assert.doesNotMatch(archive.html, />Ciotola</u, "la bozza non è nel negozio");
  // The static site's link reaches the same product on WordPress.
  const linked = await page(staticLink);
  assert.match(linked.html, /<p class="sku">TZ-BLU<\/p>/u, `il link del sito statico porta al prodotto: ${linked.url}`);

  const again = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, source, secretStoreFor);
  assert.equal(again.counts.update + again.counts.new + again.counts.delete, 0, "un secondo invio dopo la release non deve trovare differenze");

  // A change sent without a release waits: the live product does not change until the next release.
  const edited = await source.openProject(projectId);
  try {
    const record = edited.store.content.listRecords({ typeKey: "product", status: "any", includePrivate: true, limit: 10 }).items.find((item) => item.slug === "tazza-blu");
    const saved = edited.store.content.saveRecord({ id: record.id, typeKey: "product", title: record.title, slug: record.slug, locale: record.locale, status: record.status, publishedAt: record.publishedAt, excerpt: record.excerpt, order: record.order, values: { ...record.values, regular_price: 26, sale_price: null }, expectedHead: record.headRevision });
    assert.equal(saved.status, "saved");
  } finally {
    edited.store.close();
  }
  const change = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, source, secretStoreFor);
  assert.equal(change.counts.update, 1, "si invia solo il prodotto cambiato");
  await applyPlan(connection.id, "push", source, change);
  assert.deepEqual([products()["tazza-blu"].regular, products()["tazza-blu"].sale], ["24", "19.5"], "in sviluppo il prodotto online non cambia");
  releaseOnWordPress();
  assert.deepEqual([products()["tazza-blu"].regular, products()["tazza-blu"].sale], ["26", ""], "la release applica il prodotto");

  const final = await exportSummary(source, projectId);

  // WordPress → an empty catalog: the same project.
  const pull = await createRemoteSyncPlan({ action: "pull", connectionId: connection.id }, remotes, returned, secretStoreFor);
  await applyPlan(connection.id, "pull", returned, pull);
  const after = await exportSummary(returned, projectId);
  const problems = [];
  const native = [];
  for (const [id, entity] of final.entities) {
    const back = after.entities.get(id);
    if (!back) problems.push(`${describe(entity)} manca al ritorno`);
    else if (back.revisionHash !== entity.revisionHash) {
      const keys = [...new Set([...Object.keys(entity.payload), ...Object.keys(back.payload)])].filter((key) => JSON.stringify(entity.payload[key]) !== JSON.stringify(back.payload[key]));
      problems.push(`${describe(entity)}: hash diverso (${keys.map((key) => `${key}: ${JSON.stringify(entity.payload[key]).slice(0, 300)} → ${JSON.stringify(back.payload[key]).slice(0, 300)}`).join("; ") || "metadati"})`);
    }
  }
  for (const [id, entity] of after.entities) if (!final.entities.has(id)) (isWordPressNative(entity) ? native : problems).push(describe(entity));
  for (const [file, hash] of final.files) if (file !== "entities.ndjson" && after.files.get(file) !== hash) problems.push(`file ${file}: ${after.files.has(file) ? "hash diverso" : "manca al ritorno"}`);
  for (const file of after.files.keys()) if (!final.files.has(file)) problems.push(`file ${file} in più al ritorno`);
  if (problems.length) throw new assert.AssertionError({ message: `L'andata e ritorno su WooCommerce cambia il progetto:\n- ${problems.join("\n- ")}` });

  // Only the catalogue: no order, no customer, no stock quantity.
  const untouched = php(String.raw`echo wp_json_encode(array("orders" => count(wc_get_orders(array("limit" => -1, "return" => "ids"))), "customers" => count(get_users(array("role" => "customer", "fields" => "ID"))), "managed" => count(get_posts(array("post_type" => "product", "post_status" => "any", "posts_per_page" => -1, "fields" => "ids", "meta_key" => "_manage_stock", "meta_value" => "yes")))));`);
  assert.deepEqual(untouched, { orders: 0, customers: 0, managed: 0 });

  process.stdout.write(`Negozio: ${final.entities.size} entità e ${final.files.size} file, stessi hash dopo WooCommerce${final.archiveSha256 === after.archiveSha256 ? " (export identico byte per byte)" : ""}; 3 prodotti, template prodotto e negozio del progetto, link statico al prodotto, invio senza release in attesa.\n`);
  if (native.length) process.stdout.write(`  aggiunte di WooCommerce previste: ${native.join("; ")}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
