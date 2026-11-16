import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CmsProjectCatalog, readArticle, writeArticle } from "../packages/cms/dist/index.js";
import { applyRemoteSyncPlan, CmsRemoteCatalog, connectRemoteSite, createRemoteSyncPlan, rollbackRemoteOperation } from "../packages/server/dist/cms-remote.js";
import { readPairingCode, TEST_CONTAINER } from "./wordpress-test-pairing.mjs";

/**
 * Doc 23, voce 50: a real project, on a COPY made here, the whole way on a disposable WordPress: send, release, a change,
 * a second send, the return to the state before it, and a read back with nothing to bring. It answers how long a real
 * site takes and whether anything of it fails. HISTOS_TEST_REAL_PROJECTS is the folder of projects, HISTOS_TEST_REAL_ID the one.
 */

const container = process.env.HISTOS_TEST_WP_CONTAINER;
const pairingFile = process.env.HISTOS_TEST_PAIRING_CODE_FILE;
const projects = process.env.HISTOS_TEST_REAL_PROJECTS;
const projectId = process.env.HISTOS_TEST_REAL_ID;
if (!container || !TEST_CONTAINER.test(container)) throw new TypeError("Serve uno stack Docker usa-e-getta histos-cms-* (HISTOS_TEST_WP_CONTAINER).");
if (!pairingFile || !projects || !projectId) throw new TypeError("Servono HISTOS_TEST_PAIRING_CODE_FILE, HISTOS_TEST_REAL_PROJECTS e HISTOS_TEST_REAL_ID.");

const root = await mkdtemp(path.join(os.tmpdir(), "histos-real-project-"));
const remotes = new CmsRemoteCatalog(root);
const secrets = new Map();
const secretStoreFor = (account) => ({
  get: async () => secrets.get(account) ?? null,
  set: async (value) => secrets.set(account, value),
  delete: async () => secrets.delete(account),
});
const php = (body) => JSON.parse(execFileSync("docker", ["exec", container, "php", "-d", "memory_limit=1G", "-r", String.raw`require "/var/www/html/wp-load.php"; wp_set_current_user(get_user_by("login","admin")->ID); ` + body], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }));
const timed = async (name, run) => {
  const started = Date.now();
  const value = await run();
  process.stdout.write(`${name}: ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  return value;
};
const transfer = async (action, connectionId, id, catalog) => {
  const plan = await createRemoteSyncPlan({ action, connectionId, ...(id ? { projectId: id } : {}) }, remotes, catalog, secretStoreFor);
  const strange = (plan.entries ?? plan.items ?? plan.entities ?? []).filter((item) => (item.status ?? item.change) === "remote-only");
  if (strange.length) process.stdout.write(`  soli sul sito: ${JSON.stringify(strange.slice(0, 6)).slice(0, 1800)}\n`);
  process.stdout.write(`  piano ${action}: ${JSON.stringify(plan.counts)}\n`);
  if (!plan.applyAllowed || !plan.planId) throw new Error(`Piano ${action} non applicabile: ${JSON.stringify(plan.counts)}`);
  const result = await applyRemoteSyncPlan({ connectionId, planId: plan.planId }, remotes, catalog, secretStoreFor);
  assert.equal(result.complete, true, `${action} deve completarsi`);
  return result;
};
const release = (label) => php(String.raw`try { \XB\Plugin::instance()->versioning->publish(null, ${JSON.stringify(label)}); } catch (\XB\Versioning\VersioningException $e) { if (400 !== $e->getCode()) { fwrite(STDERR, $e->getMessage()); exit(21); } } echo "true";`);
const shown = (route) => execFileSync("docker", ["exec", container, "php", "-r", `echo @file_get_contents("http://127.0.0.1/?p=${route}");`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

try {
  await readPairingCode(pairingFile);
  // The return to a published state needs the permission to publish, which the usual test link does not have.
  const code = execFileSync("docker", ["exec", container, "php", "-r", String.raw`require "/var/www/html/wp-load.php"; wp_set_current_user(get_user_by("login","admin")->ID); echo \XB\Cms\Link::create("Prova del progetto reale",true,true,true);`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  await cp(path.join(projects, projectId), path.join(root, "publish", "histos-projects", projectId), { recursive: true });
  const catalog = new CmsProjectCatalog(path.join(root, "publish"));
  await catalog.initialize();
  const opened = await catalog.openProject(projectId);
  assert.ok(opened, "il progetto copiato si apre");
  const { store } = opened;
  const posts = store.listPosts().filter((post) => !post.locale && post.status === "published");
  const target = posts.find((post) => readArticle(store.getRevision(post.headRevision)?.content ?? "").blocks.some((block) => block.type === "paragraph"));
  assert.ok(target, "un articolo con testo");
  process.stdout.write(`Progetto: ${store.listPages().length} pagine, ${store.listPosts().length} articoli, ${store.listAssets().length} media.\n`);
  store.close();

  const connection = await connectRemoteSite(code, remotes, secretStoreFor);
  // As a host that kills long requests does: the PHP process dies at the fortieth image, once.
  const killer = `<?php add_filter("xb_remote_operation_lock_ttl", static fn () => 8); add_action("add_attachment", static function () { if (get_option("xb_test_killed")) { return; } $n = 1 + (int) get_option("xb_test_count"); update_option("xb_test_count", $n); if (40 === $n) { update_option("xb_test_killed", 1); posix_kill(getmypid(), 9); } });`;
  execFileSync("docker", ["exec", "-i", container, "sh", "-c", "mkdir -p /var/www/html/wp-content/mu-plugins && cat > /var/www/html/wp-content/mu-plugins/test-kill.php"], { input: killer });
  await timed("primo invio, con un'interruzione", () => transfer("push", connection.id, projectId, catalog));
  assert.equal(php(String.raw`echo wp_json_encode((bool) get_option("xb_test_killed"));`), true, "l'invio è stato davvero interrotto");
  await timed("pubblicazione", async () => release("Primo invio"));
  const wordpress = php(String.raw`$c = wp_count_posts("post"); $p = wp_count_posts("page"); $m = wp_count_posts("attachment"); echo wp_json_encode(array("post"=>$c->publish + $c->draft,"page"=>$p->publish + $p->draft,"media"=>$m->inherit));`);
  process.stdout.write(`In WordPress: ${JSON.stringify(wordpress)}\n`);
  const id = php(String.raw`echo wp_json_encode(\XB\Remote\PageProfileAdapter::post_of_entity(${JSON.stringify(target.id)}));`);
  assert.ok(id > 0, "l'articolo è in WordPress");
  const before = shown(id);
  assert.ok(before.includes("<html") && before.includes(target.title.split(" ")[0]), "l'articolo si vede sul sito");

  // A change, sent and published; then the return to before it.
  const second = (await catalog.openProject(projectId)).store;
  const head = second.getEntityById(target.id).headRevision;
  const content = second.getRevision(head).content;
  const blocks = readArticle(content).blocks;
  blocks.find((block) => block.type === "paragraph").html += " Riga della prova.";
  assert.equal(second.saveDocument({ entityId: target.id, expectedHead: head, content: writeArticle(content, blocks, { mediaBase: `/__cms-media/${projectId}` }) }).status, "saved");
  second.close();
  await timed("secondo invio", () => transfer("push", connection.id, projectId, catalog));
  release("Con la modifica");
  assert.ok(shown(id).includes("Riga della prova."), "la modifica è online");

  const rolled = await timed("ritorno indietro", () => rollbackRemoteOperation({ connectionId: connection.id, operationId: remotes.listOperations(connection.id).filter((operation) => operation.state === "complete").sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).at(-1).operationId }, remotes, catalog, secretStoreFor));
  // With the permission to publish, the return is already online.
  if (!rolled.published) release("Ritorno");
  assert.ok(!shown(id).includes("Riga della prova."), "dopo il ritorno la modifica non c'è più");

  const reread = await createRemoteSyncPlan({ action: "pull", connectionId: connection.id }, remotes, catalog, secretStoreFor);
  process.stdout.write(`Rilettura: ${JSON.stringify(reread.counts)}\n`);
  // Only the article changed here and taken back there differs. WordPress's own «Uncategorized» is new to the project:
  // no reading of a send gave it a base, so it is no conflict.
  assert.equal(reread.counts["local-only"], 1, "la sola differenza è l'articolo cambiato");
  assert.equal(reread.counts.conflict, 0, "nessun conflitto");
  assert.equal(reread.counts.new, 1, "di nuovo solo «Uncategorized»");
  assert.equal(reread.counts.update, 0, "nient'altro è cambiato");
  process.stdout.write("Progetto reale su WordPress: invio, pubblicazione, modifica e ritorno superati.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
