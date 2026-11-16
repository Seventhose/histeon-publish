import assert from "node:assert/strict";
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
  sectionLibrary,
  staticSiteProjectId,
  stylesData,
  staticSiteToPrototype,
} from "../packages/cms/dist/index.js";
import { applyRemoteSyncPlan, CmsRemoteCatalog, connectRemoteSite, createRemoteSyncPlan } from "../packages/server/dist/cms-remote.js";
import { readPairingCode, TEST_CONTAINER } from "./wordpress-test-pairing.mjs";

/**
 * Queue C3, the part that needs no licence: a prototype goes into Publish, out as .xbsite, onto a disposable
 * WordPress with Histeon, and back into a second, empty Publish catalog; the two exports must have the same entities
 * with the same revision hashes and the same files. Two prototypes, one per WordPress: the example of the manual (A),
 * and a static site converted with its parts and components (B1, B3). ACSS and Etch are not part of this run: they
 * need the owner's licence and the customer's stack.
 *
 * An image whose source is a component prop (`src={props.immagine}`) does not reach WordPress yet: the plugin's
 * restore_media() accepts only histos-media:// (transfer-markup.md §5, W2 item 2, after the builder's media merge).
 * The example loses that one image binding here, and lists of B3 (which need it) are left out, until W2.
 */
const WITHOUT_DYNAMIC_IMAGES = (html) => html
  .replace("{#if props.immagine}<img src={props.immagine} alt={props.titolo}>{/if}", "")
  .replaceAll(" immagine={opera.fields.immagine}", "");

const cases = [
  { label: "prototipo d'esempio", container: process.env.HISTOS_TEST_WP_CONTAINER, pairingFile: process.env.HISTOS_TEST_PAIRING_CODE_FILE },
  { label: "sito statico convertito con struttura", container: process.env.HISTOS_TEST_SECOND_WP_CONTAINER, pairingFile: process.env.HISTOS_TEST_SECOND_PAIRING_CODE_FILE, url: process.env.HISTOS_TEST_SECOND_WP_URL?.replace(/\/$/u, "") },
];
/** Doc 28: what the converted site's sizes become. */
const SITE_TOKENS = { "testo-17": "17px", "spazio-14": "14px" };
for (const item of cases) {
  if (!item.container || !TEST_CONTAINER.test(item.container)) throw new TypeError("Servono due stack Docker usa-e-getta histos-cms-* (HISTOS_TEST_WP_CONTAINER e HISTOS_TEST_SECOND_WP_CONTAINER).");
  if (!item.pairingFile) throw new TypeError("Servono i due codici di collegamento locali (HISTOS_TEST_PAIRING_CODE_FILE e HISTOS_TEST_SECOND_PAIRING_CODE_FILE).");
}

const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-roundtrip-"));
const remotes = new CmsRemoteCatalog(root);
const secrets = new Map();
const secretStoreFor = (account) => ({
  get: async () => secrets.get(account) ?? null,
  set: async (value) => secrets.set(account, value),
  delete: async () => secrets.delete(account),
});

// A send lands in development; the next Histeon release, which the test publishes as the administrator, makes it live.
function releaseOnWordPress(container) {
  const code = String.raw`require "/var/www/html/wp-load.php"; $user=get_user_by("login","admin"); if (!$user) { fwrite(STDERR,"admin user missing\n"); exit(20); } wp_set_current_user($user->ID); try { \XB\Plugin::instance()->versioning->publish(null, "Release di prova"); } catch (\XB\Versioning\VersioningException $e) { if (400 !== $e->getCode()) { fwrite(STDERR, $e->getMessage()."\n"); exit(21); } \XB\Remote\ContentProfileAdapter::apply_queue(0); } echo "RELEASED";`;
  const output = execFileSync("docker", ["exec", container, "php", "-r", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!output.includes("RELEASED")) throw new Error("La release di prova su WordPress non è riuscita.");
}

async function applyPlan(connectionId, action, catalog, plan) {
  if (!plan.applyAllowed || !plan.planId || plan.counts.conflict !== 0) throw new Error(`Piano ${action} non applicabile senza conflitti.`);
  const result = await applyRemoteSyncPlan({ connectionId, planId: plan.planId }, remotes, catalog, secretStoreFor);
  if (!result.complete) throw new Error(`Il trasferimento ${action} non è stato completato.`);
}

/** What an export holds, comparable across catalogs: each entity's kind and revision hash, each file's hash. */
async function exportSummary(catalog, projectId) {
  const opened = await catalog.openProject(projectId);
  if (!opened) throw new Error(`Il progetto ${projectId} non è nel catalogo.`);
  try {
    const archive = await encodeStaticPageArchive(opened.project, opened.store);
    const decoded = await decodeStaticPageArchive(archive);
    const entities = new Map(decoded.profile.entities.filter((entity) => entity.kind !== "tombstone").map((entity) => [entity.id, entity]));
    const files = new Map(decoded.profile.manifest.files.map((file) => [file.path, file.sha256]));
    return { entities, files, archiveSha256: (await import("node:crypto")).createHash("sha256").update(archive).digest("hex") };
  } finally {
    opened.store.close();
  }
}

/** An entity in a line: kind, id and what names it. */
function describe(entity) {
  const payload = entity.payload ?? {};
  const name = ["key", "taxonomyKey", "slug", "label", "title", "ref"].filter((key) => typeof payload[key] === "string").map((key) => `${key}=${payload[key]}`).join(" ");
  return `${entity.kind} ${entity.id}${name ? ` (${name})` : ""}`;
}

/** The payload with each taxonomy's terms as a set: WordPress does not keep their order (it lists them by name). */
function sameIgnoringTermOrder(left, right) {
  const normal = (payload) => JSON.stringify({ ...payload, ...(payload.terms ? { terms: Object.fromEntries(Object.entries(payload.terms).map(([key, ids]) => [key, [...ids].sort()]).sort(([a], [b]) => a.localeCompare(b))) } : {}) });
  return normal(left) === normal(right);
}

/** What WordPress adds by design: with posts, its categories and tags travel with all their terms (cms-bridge §12). */
const WORDPRESS_NATIVE = new Set(["category", "post_tag"]);
const isWordPressNative = (entity) => (entity.kind === "taxonomy" && WORDPRESS_NATIVE.has(entity.payload.key)) || (entity.kind === "term" && WORDPRESS_NATIVE.has(entity.payload.taxonomyKey));

function compare(label, before, after) {
  const problems = [];
  const reordered = [];
  const native = [];
  for (const [id, entity] of before.entities) {
    const back = after.entities.get(id);
    if (!back) problems.push(`${describe(entity)} manca al ritorno`);
    else if (back.revisionHash !== entity.revisionHash && sameIgnoringTermOrder(entity.payload, back.payload)) reordered.push(describe(entity));
    else if (back.revisionHash !== entity.revisionHash) {
      const keys = [...new Set([...Object.keys(entity.payload), ...Object.keys(back.payload)])].filter((key) => JSON.stringify(entity.payload[key]) !== JSON.stringify(back.payload[key]));
      const detail = keys.map((key) => `${key}: ${JSON.stringify(entity.payload[key]).slice(0, 200)} → ${JSON.stringify(back.payload[key]).slice(0, 200)}`).join("; ");
      problems.push(`${describe(entity)}: hash diverso (${detail || "stesso contenuto, metadati diversi"})`);
    }
  }
  for (const [id, entity] of after.entities) {
    if (before.entities.has(id)) continue;
    if (isWordPressNative(entity)) native.push(describe(entity));
    else problems.push(`${describe(entity)} in più al ritorno`);
  }
  // The entity list itself is compared entity by entity above.
  for (const [file, hash] of before.files) if (file !== "entities.ndjson" && after.files.get(file) !== hash) problems.push(`file ${file}: ${after.files.has(file) ? "hash diverso" : "manca al ritorno"}`);
  for (const file of after.files.keys()) if (!before.files.has(file)) problems.push(`file ${file} in più al ritorno`);
  if (problems.length) return `${label}: l'andata e ritorno su WordPress cambia il progetto:\n- ${problems.join("\n- ")}`;
  process.stdout.write(`${label}: ${before.entities.size} entità e ${before.files.size} file, stessi hash dopo WordPress${before.archiveSha256 === after.archiveSha256 ? " (export identico byte per byte)" : ""}.\n`);
  if (reordered.length) process.stdout.write(`  stessi termini in un altro ordine (WordPress li ordina per nome): ${reordered.join("; ")}\n`);
  if (native.length) process.stdout.write(`  aggiunte di WordPress previste (categorie e tag nativi, §12): ${native.join("; ")}\n`);
  return null;
}

/** The static site of the B3 test, converted with parts, components and lists. */
function convertedSite() {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const text = (value) => new TextEncoder().encode(value);
  const header = '<header class="top"><a href="index.html">Studio</a><nav><a href="servizi.html">Servizi</a></nav></header>';
  const footer = '<footer class="bottom"><p>Studio 2026</p></footer>';
  const card = (index, title) => `<article class="card"><img src="img/${index}.png" alt="${title}"><h3>${title}</h3><p>Su ${title} & altro</p><a class="more" href="servizi.html">Scopri</a></article>`;
  const page = (title, main) => text(`<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${title}</title><style>.card{padding:14px;color:#c83c28}.card h3{font-size:17px}.top{display:flex}</style></head><body>${header}<main>${main}</main>${footer}</body></html>`);
  const files = [
    { path: "index.html", bytes: page("Home", `<h1>Benvenuti</h1><section>${card(1, "Restauro")}${card(2, "Cornici")}${card(3, "Doratura")}</section>`) },
    { path: "servizi.html", bytes: page("Servizi", "<h1>Servizi</h1>") },
    { path: "contatti.html", bytes: page("Contatti", "<h1>Contatti</h1>") },
    ...[1, 2, 3].map((index) => ({ path: `img/${index}.png`, bytes: Buffer.concat([png, Buffer.from([index])]) })),
  ];
  // Doc 28: converted as a photographed proposal is, with Histeon CSS and the sizes written by hand kept exact as the
  // site's variables, so that they travel in a real send.
  const converted = staticSiteToPrototype({ projectId: staticSiteProjectId("c3-roundtrip"), name: "Studio C3", files, structure: { parts: true, components: true }, framework: "histos-css", exact: true });
  assert.deepEqual(converted.siteTokens, SITE_TOKENS, "la conversione deve dare le variabili del sito della prova");
  return converted.html;
}

/** The site's variables of a project, as its styles document holds them. */
async function siteTokensOf(catalog, projectId) {
  const opened = await catalog.openProject(projectId);
  try {
    const head = opened.store.getHead(opened.store.getStyles()?.id ?? "")?.content;
    return head ? stylesData(head).siteTokens ?? {} : {};
  } finally {
    opened.store.close();
  }
}

try {
  const prototypes = [
    WITHOUT_DYNAMIC_IMAGES(await readFile(new URL("../packages/cms/test/fixtures/prototipo-esempio.html", import.meta.url), "utf8")),
    convertedSite(),
  ];
  const failures = [];
  for (const [index, item] of cases.entries()) {
    const { code } = await readPairingCode(item.pairingFile);
    const source = new CmsProjectCatalog(path.join(root, `publish-${index}`));
    const returned = new CmsProjectCatalog(path.join(root, `returned-${index}`));
    const scratch = new CmsProjectCatalog(path.join(root, `scratch-${index}`));
    await Promise.all([source.initialize(), returned.initialize(), scratch.initialize()]);
    // Prototype → Publish, as "Importa prototipo" does.
    const parsed = parsePrototype(prototypes[index]);
    const built = await buildPrototypeProfile(parsed, scratch);
    const imported = await source.importStaticPageProfile(built.profile, built.files);
    const projectId = imported.project.id;
    imported.store.close();
    const before = await exportSummary(source, projectId);

    // Publish → WordPress, released; WordPress → an empty catalog.
    const connection = await connectRemoteSite(code, remotes, secretStoreFor);
    if (connection.projectId !== null) throw new Error("Il WordPress usa-e-getta è già collegato a un progetto: serve uno stack nuovo; nulla è stato inviato.");
    const push = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, source, secretStoreFor);
    assert.ok(push.initializingRemote, "il WordPress di prova deve essere vuoto");
    await applyPlan(connection.id, "push", source, push);
    releaseOnWordPress(item.container);
    const again = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, source, secretStoreFor);
    assert.equal(again.counts.update + again.counts.new + again.counts.delete, 0, `${item.label}: un secondo invio dopo la release non deve trovare differenze`);
    const pull = await createRemoteSyncPlan({ action: "pull", connectionId: connection.id }, remotes, returned, secretStoreFor);
    await applyPlan(connection.id, "pull", returned, pull);
    const failure = compare(item.label, before, await exportSummary(returned, projectId));
    if (failure) failures.push(failure);
    // Doc 28: the site's variables of a converted proposal are in Publish, on the WordPress front end after the
    // release, and back in the catalog that pulled them.
    if (index === 1) {
      assert.deepEqual(await siteTokensOf(source, projectId), SITE_TOKENS, `${item.label}: le variabili del sito devono essere nel progetto importato`);
      assert.deepEqual(await siteTokensOf(returned, projectId), SITE_TOKENS, `${item.label}: le variabili del sito devono tornare da WordPress`);
      if (!item.url) throw new TypeError("Serve l'indirizzo del secondo WordPress (HISTOS_TEST_SECOND_WP_URL).");
      const front = await (await fetch(`${item.url}/`)).text();
      const sheets = [...front.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/giu)].map((match) => match[1].replaceAll("&#038;", "&").replaceAll("&amp;", "&")).filter((href) => href.startsWith(item.url));
      const css = [front, ...(await Promise.all(sheets.map(async (href) => (await fetch(href)).text())))].join("\n");
      for (const [name, value] of Object.entries(SITE_TOKENS)) assert.match(css, new RegExp(`--xb-site-${name}:\\s*${value}\\b`, "u"), `${item.label}: la pagina di WordPress deve stampare --xb-site-${name}: ${value}`);
      process.stdout.write(`  variabili del sito: ${Object.keys(SITE_TOKENS).length} nel progetto, sulla pagina di WordPress e al ritorno.\n`);
    }
    // D5: the project's sections as a .xblibrary file, accepted by the builder's section library on this site.
    const opened = await source.openProject(projectId);
    const pages = opened.store.listPages().map((page) => ({ title: page.title, slug: page.slug, content: opened.store.getHead(page.id)?.content ?? "" }));
    const stylesHead = opened.store.getHead(opened.store.getStyles()?.id ?? "")?.content;
    const styles = (stylesHead ? stylesData(stylesHead).styles ?? [] : []).map((style) => ({ selector: style.selector, css: style.css }));
    opened.store.close();
    const library = sectionLibrary({ projectId, projectName: item.label, pages, styles, created: new Date().toISOString() });
    if (library.sections) {
      const data = Buffer.from(JSON.stringify(library.file), "utf8").toString("base64");
      const code = String.raw`require "/var/www/html/wp-load.php"; $u = get_user_by("login", "admin"); wp_set_current_user($u->ID); try { $r = \XB\Library\Sections::import(json_decode(base64_decode("${data}"), true)); echo json_encode($r); } catch (\Throwable $e) { fwrite(STDERR, $e->getMessage()); exit(30); }`;
      const imported = JSON.parse(execFileSync("docker", ["exec", item.container, "php", "-r", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
      assert.equal(imported.added, library.sections, `${item.label}: la libreria del builder deve accettare tutte le sezioni esportate`);
      process.stdout.write(`  libreria di sezioni: ${library.sections} sezioni accettate dal builder.\n`);
    }
  }
  if (failures.length) throw new assert.AssertionError({ message: failures.join("\n") });
} finally {
  await rm(root, { recursive: true, force: true });
}
