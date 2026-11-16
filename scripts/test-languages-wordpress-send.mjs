import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CmsProjectCatalog } from "../packages/cms/dist/index.js";
import { applyRemoteSyncPlan, CmsRemoteCatalog, connectRemoteSite, createRemoteSyncPlan } from "../packages/server/dist/cms-remote.js";
import { readPairingCode, TEST_CONTAINER } from "./wordpress-test-pairing.mjs";

/**
 * Doc 20 §5.9, the whole way: a project in Italian and English goes from Publish through the bridge onto a disposable
 * WordPress with Lingua Bridge, and the plugin ends up knowing which page is the English version of which. On the way:
 * - pages and posts are linked at the send, records at the release that creates them;
 * - the translation arrives as a draft, and the link publishes nothing;
 * - the mode the project chose reaches the plugin, and a second send changes it without a second link;
 * - a language the site does not have is left out, and the send says so instead of failing.
 */

const container = process.env.HISTOS_TEST_WP_CONTAINER;
const pairingFile = process.env.HISTOS_TEST_PAIRING_CODE_FILE;
if (!container || !TEST_CONTAINER.test(container)) throw new TypeError("Serve uno stack Docker usa-e-getta histos-cms-* (HISTOS_TEST_WP_CONTAINER).");
if (!pairingFile) throw new TypeError("Serve il codice di collegamento locale (HISTOS_TEST_PAIRING_CODE_FILE).");

const root = await mkdtemp(path.join(os.tmpdir(), "histos-languages-send-"));
const remotes = new CmsRemoteCatalog(root);
const secrets = new Map();
const secretStoreFor = (account) => ({
  get: async () => secrets.get(account) ?? null,
  set: async (value) => secrets.set(account, value),
  delete: async () => secrets.delete(account),
});

/** Runs PHP in the disposable WordPress as its administrator; prints JSON. */
function php(body) {
  const code = String.raw`require "/var/www/html/wp-load.php"; wp_set_current_user(get_user_by("login","admin")->ID); ` + body;
  return JSON.parse(execFileSync("docker", ["exec", container, "php", "-r", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

/** What Lingua Bridge knows of a content sent by Publish. */
function linked(entityId) {
  return php(String.raw`$post = \XB\Remote\PageProfileAdapter::post_of_entity(${JSON.stringify(entityId)}); $row = $post ? \LinguaBridge\Storage::find($post) : null; echo wp_json_encode(array("post" => $post, "status" => get_post_status($post), "title" => get_the_title($post), "language" => $row["language"] ?? null, "source" => isset($row["source_id"]) ? (int) $row["source_id"] : null, "group" => $row["group_uuid"] ?? null, "mode" => get_post_meta($post, \LinguaBridge\Translations::MODE_META, true)));`);
}

async function send(connectionId, projectId, catalog) {
  const plan = await createRemoteSyncPlan({ action: "push", connectionId, projectId }, remotes, catalog, secretStoreFor);
  if (!plan.applyAllowed || !plan.planId) throw new Error(`Piano di invio non applicabile: ${JSON.stringify(plan.counts)}`);
  const result = await applyRemoteSyncPlan({ connectionId, planId: plan.planId }, remotes, catalog, secretStoreFor);
  assert.equal(result.complete, true, "l'invio deve completarsi");
  return result;
}

try {
  const { code } = await readPairingCode(pairingFile);
  php(String.raw`$s = \LinguaBridge\Languages::settings(); $s["languages"] = array("it" => "Italiano", "en" => "English"); $s["default_language"] = "it"; update_option("lingua_bridge_settings", $s); echo wp_json_encode(\LinguaBridge\Languages::all());`);

  const catalog = new CmsProjectCatalog(path.join(root, "publish"));
  await catalog.initialize();
  const opened = await catalog.createProject("Lingue");
  const projectId = opened.project.id;
  opened.store.setRenderSettings({ locale: "it-IT", timeZone: "Europe/Rome" });
  opened.store.setProjectLanguages([{ code: "en" }, { code: "fr" }]);
  const page = opened.store.createPage({ title: "Chi siamo", slug: "chi-siamo" });
  opened.store.updatePageMetadata(page.id, { title: "Chi siamo", slug: "chi-siamo", status: "published" });
  const english = opened.store.createTranslation({ sourceId: page.id, language: "en", slug: "about", title: "About us" });
  const french = opened.store.createTranslation({ sourceId: page.id, language: "fr", slug: "a-propos", title: "À propos" });
  const post = opened.store.createPost({ title: "Ciao", slug: "ciao", status: "published" });
  const englishPost = opened.store.createTranslation({ sourceId: post.id, language: "en", slug: "hello", title: "Hello" });
  opened.store.content.saveType({ key: "opera", label: "Opere", fields: [{ key: "autore", label: "Autore", type: "text", required: false, public: true, multiple: false }] });
  const saved = opened.store.content.saveRecord({ typeKey: "opera", title: "Opera", slug: "opera", status: "published", values: { autore: "Dante" } });
  assert.equal(saved.status, "saved");
  const englishRecord = opened.store.createTranslation({ sourceId: saved.record.id, language: "en" });
  opened.store.close();

  const connection = await connectRemoteSite(code, remotes, secretStoreFor);
  await send(connection.id, projectId, catalog);

  // A send stays in development until a release, as on any site; the release decides what goes live.
  const released = php(String.raw`try { \XB\Plugin::instance()->versioning->publish(null, "Release di prova doc 20"); } catch (\XB\Versioning\VersioningException $e) { if (400 !== $e->getCode()) { fwrite(STDERR, $e->getMessage()); exit(21); } } echo wp_json_encode(array("released" => true));`);
  assert.equal(released.released, true);

  const source = linked(page.id);
  const translation = linked(english.translationId);
  assert.equal(source.status, "publish", "con la release l'originale è online");
  assert.equal(source.title, "Chi siamo");
  assert.equal(translation.status, "draft", "il legame non pubblica la traduzione");
  assert.equal(translation.title, "About us");
  assert.equal(translation.language, "en", `Lingua Bridge deve sapere che è la versione inglese: ${JSON.stringify(translation)}`);
  assert.equal(translation.source, source.post, "la traduzione punta al suo originale");
  assert.equal(translation.group, source.group, "originale e traduzione sono nello stesso gruppo");
  assert.equal(translation.mode, "follow");
  assert.equal(linked(french.translationId).language, null, "una lingua che il sito non ha resta fuori");
  assert.equal(linked(englishPost.translationId).language, "en", "anche un articolo finisce collegato");
  assert.equal(linked(englishRecord.translationId).language, "en", "anche un record, che WordPress crea con la release, finisce collegato");
  assert.equal(linked(saved.record.id).language, "it");

  // The project changes its mind: the same link, with the new mode.
  const again = await catalog.openProject(projectId);
  try {
    again.store.setTranslationMode(english.translationId, "independent");
  } finally {
    again.store.close();
  }
  // Twice: looking at a send changes nothing, and WordPress's default categories never block it.
  for (const look of [1, 2]) {
    const plan = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, catalog, secretStoreFor);
    assert.equal(plan.counts.conflict, 0, `il riesame ${look} non deve trovare conflitti: ${JSON.stringify(plan.entities.filter((entity) => entity.status === "conflict"))}`);
  }
  await send(connection.id, projectId, catalog);
  const after = linked(english.translationId);
  assert.equal(after.mode, "independent", "il secondo invio aggiorna il modo");
  assert.equal(after.group, source.group, "il secondo invio non crea un altro legame");

  process.stdout.write(`Lingue: «${source.title}» (${source.post}) e «${translation.title}» (${translation.post}) collegate da Lingua Bridge.\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
