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
  transferMarkupIssues,
} from "../packages/cms/dist/index.js";
import { parse, parseXb, serializeXb } from "../packages/cms/.generated/histos-dsl/index.js";
import { applyRemoteSyncPlan, CmsRemoteCatalog, connectRemoteSite, createRemoteSyncPlan } from "../packages/server/dist/cms-remote.js";
import { readPairingCode, TEST_CONTAINER } from "./wordpress-test-pairing.mjs";

/**
 * Queue A6, interoperability with the builder: a prototype with every part of histos-transfer-markup-v1 (inline SVG,
 * also inside a component, picture/srcset with project media, details, forms with fields and a textarea, a component
 * with src={props.immagine} filled from a record) goes into Publish, through the bridge onto a disposable WordPress
 * with Histeon (the builder's current plugin), is released, and comes back into an empty catalog: same entities with
 * the same revision hashes, same media files byte for byte. WordPress must print what it received.
 *
 * The known limits of the builder's spec (transfer-markup.md §5, «Limiti noti») are expected behaviour here, checked
 * as such and not failures:
 * - an image prop written as a literal in an instance (as the editor's media picker leaves it) has no media path: the
 *   value travels and comes back unchanged, but WordPress prints the image without src;
 * - a form in a page filled into the slot of a component that is itself a form passes: the content model is checked
 *   document by document.
 */

const container = process.env.HISTOS_TEST_WP_CONTAINER;
const pairingFile = process.env.HISTOS_TEST_PAIRING_CODE_FILE;
if (!container || !TEST_CONTAINER.test(container)) throw new TypeError("Serve uno stack Docker usa-e-getta histos-cms-* (HISTOS_TEST_WP_CONTAINER).");
if (!pairingFile) throw new TypeError("Serve il codice di collegamento locale (HISTOS_TEST_PAIRING_CODE_FILE).");

const root = await mkdtemp(path.join(os.tmpdir(), "histos-markup-roundtrip-"));
const remotes = new CmsRemoteCatalog(root);
const secrets = new Map();
const secretStoreFor = (account) => ({
  get: async () => secrets.get(account) ?? null,
  set: async (value) => secrets.set(account, value),
  delete: async () => secrets.delete(account),
});

function releaseOnWordPress() {
  const code = String.raw`require "/var/www/html/wp-load.php"; $user=get_user_by("login","admin"); if (!$user) { fwrite(STDERR,"admin user missing\n"); exit(20); } wp_set_current_user($user->ID); try { \XB\Plugin::instance()->versioning->publish(null, "Release di prova A6"); } catch (\XB\Versioning\VersioningException $e) { if (400 !== $e->getCode()) { fwrite(STDERR, $e->getMessage()."\n"); exit(21); } \XB\Remote\ContentProfileAdapter::apply_queue(0); } echo "RELEASED";`;
  const output = execFileSync("docker", ["exec", container, "php", "-r", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!output.includes("RELEASED")) throw new Error("La release di prova su WordPress non è riuscita.");
}

async function applyPlan(connectionId, action, catalog, plan) {
  if (!plan.applyAllowed || !plan.planId || plan.counts.conflict !== 0) throw new Error(`Piano ${action} non applicabile senza conflitti.`);
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
    return { entities, files, archiveSha256: createHash("sha256").update(archive).digest("hex") };
  } finally {
    opened.store.close();
  }
}

const describe = (entity) => {
  const payload = entity.payload ?? {};
  const name = ["key", "taxonomyKey", "slug", "label", "title", "ref"].filter((key) => typeof payload[key] === "string").map((key) => `${key}=${payload[key]}`).join(" ");
  return `${entity.kind} ${entity.id}${name ? ` (${name})` : ""}`;
};
const WORDPRESS_NATIVE = new Set(["category", "post_tag"]);
const isWordPressNative = (entity) => (entity.kind === "taxonomy" && WORDPRESS_NATIVE.has(entity.payload.key)) || (entity.kind === "term" && WORDPRESS_NATIVE.has(entity.payload.taxonomyKey));

/** Every element of the blocks with this tag, in document order. */
const elements = (blocks, tag) => blocks.flatMap((block) => [...(block.name === "xb/element" && block.attrs.tag === tag ? [block] : []), ...("children" in block ? elements(block.children, tag) : [])]);

try {
  const { code, target } = await readPairingCode(pairingFile);
  const source = new CmsProjectCatalog(path.join(root, "publish"));
  const returned = new CmsProjectCatalog(path.join(root, "returned"));
  const scratch = new CmsProjectCatalog(path.join(root, "scratch"));
  await Promise.all([source.initialize(), returned.initialize(), scratch.initialize()]);

  // Prototype → Publish, as "Importa prototipo" does.
  const prototype = await readFile(new URL("../packages/cms/test/fixtures/prototipo-markup-v1.html", import.meta.url), "utf8");
  const built = await buildPrototypeProfile(parsePrototype(prototype), scratch);
  const imported = await source.importStaticPageProfile(built.profile, built.files);
  const projectId = imported.project.id;
  const store = imported.store;
  const assets = new Map(store.listAssets().map((asset) => [asset.filename, asset]));
  assert.equal(assets.size, 4, "il prototipo porta quattro immagini");
  const opera = [...assets.values()].find((asset) => asset.alt === "Opera");
  assert.ok(opera, "manca l'immagine del record");
  // The two known limits, written as the local editor leaves them (the prototype manual refuses both forms).
  store.createPage({ title: "Letterale", slug: "letterale", status: "published", templateRef: "site/page", content: serializeXb(parse(`<Scheda titolo="Letterale" immagine="/__cms-media/${projectId}/${opera.id}" />`).blocks) });
  store.createPage({ title: "Annidato", slug: "annidato", status: "published", templateRef: "site/page", content: serializeXb(parse('<Modulo><form action="/iscrizione/" method="post"><input type="email" name="email" aria-label="Email"></form></Modulo>').blocks) });
  const pages = new Map(store.listPages().map((page) => [page.slug, store.getHead(page.id)?.content ?? ""]));
  for (const [slug, content] of pages) assert.deepEqual(transferMarkupIssues(parseXb(content).blocks), [], `la pagina ${slug} deve essere markup trasferibile`);
  store.close();
  const before = await exportSummary(source, projectId);

  // Publish → WordPress (the plugin declares histos-transfer-markup-v1, or nothing is sent), released.
  const connection = await connectRemoteSite(code, remotes, secretStoreFor);
  if (connection.projectId !== null) throw new Error("Il WordPress usa-e-getta è già collegato a un progetto: serve uno stack nuovo; nulla è stato inviato.");
  const push = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, source, secretStoreFor);
  assert.ok(push.initializingRemote, "il WordPress di prova deve essere vuoto");
  await applyPlan(connection.id, "push", source, push);
  releaseOnWordPress();
  const again = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, source, secretStoreFor);
  assert.equal(again.counts.update + again.counts.new + again.counts.delete, 0, "un secondo invio dopo la release non deve trovare differenze");

  // What WordPress prints, from the live site.
  const page = async (slug) => {
    const response = await fetch(new URL(`/${slug}/`, target), { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200, `WordPress deve servire /${slug}/`);
    return response.text();
  };
  const uploads = `${target.origin}/wp-content/uploads/`;
  const home = await page("home");
  const svg = /<svg\b[^>]*viewBox="0 0 16 16"[^>]*>[\s\S]*?<\/svg>/u.exec(home)?.[0] ?? "";
  assert.match(svg, /<rect\b[^>]*rx="2"/u, "l'SVG in linea arriva con le sue forme");
  assert.doesNotMatch(svg, /xmlns/u);
  assert.match(home, /<svg\b[^>]*class="icona"[^>]*>\s*<title>Cerca nel sito<\/title>/u, "l'icona del componente arriva con il titolo dalla prop");
  const source1 = /<source\b[^>]*>/u.exec(home)?.[0] ?? "";
  assert.ok(source1.includes(`srcset="${uploads}`) && / 1x, http:\/\/[^ ]+\/wp-content\/uploads\/[^ ]+ 2x"/u.test(source1), `il srcset di <source> usa i file degli allegati: ${source1}`);
  assert.match(home, /<details\b[^>]*name="faq"[^>]*open[^>]*>\s*<summary>Come si ordina\?<\/summary>/u);
  assert.match(home, /<textarea\b[^>]*name="messaggio"[^>]*>Buongiorno,\nvorrei sapere di più\.<\/textarea>/u, "il testo iniziale della textarea arriva com'è");
  assert.match(home, /<form\b[^>]*action="https:\/\/moduli\.example\.org\/contatti"[^>]*method="post"/u);
  const card = /<article class="scheda">[\s\S]*?<\/article>/u.exec(home)?.[0] ?? "";
  assert.match(card, new RegExp(`<img\\b[^>]*src="${uploads.replaceAll(".", "\\.")}[^"]+"`, "u"), `src={props.immagine} stampa l'URL dell'allegato: ${card}`);
  // An image written in a prop of the instance travels as a media reference (doc 24): the attachment's address.
  const literal = /<article class="scheda">[\s\S]*?<\/article>/u.exec(await page("letterale"))?.[0] ?? "";
  assert.match(literal, /<h2>Letterale<\/h2>/u);
  assert.match(literal, new RegExp(`<img\\b[^>]*src="${uploads.replaceAll(".", "\\.")}[^"]+"`, "u"), `una prop immagine letterale stampa l'URL dell'allegato: ${literal}`);
  // Known limit: a form filled into the slot of a form component is accepted on both sides.
  assert.equal((await page("annidato")).match(/<form\b/gu)?.length, 2, "limite noto: il modulo nello slot di un modulo passa");

  // WordPress → an empty catalog: the same project, byte for byte where it counts.
  const pull = await createRemoteSyncPlan({ action: "pull", connectionId: connection.id }, remotes, returned, secretStoreFor);
  await applyPlan(connection.id, "pull", returned, pull);
  const after = await exportSummary(returned, projectId);
  const problems = [];
  const native = [];
  for (const [id, entity] of before.entities) {
    const back = after.entities.get(id);
    if (!back) problems.push(`${describe(entity)} manca al ritorno`);
    else if (back.revisionHash !== entity.revisionHash) {
      const keys = [...new Set([...Object.keys(entity.payload), ...Object.keys(back.payload)])].filter((key) => JSON.stringify(entity.payload[key]) !== JSON.stringify(back.payload[key]));
      problems.push(`${describe(entity)}: hash diverso (${keys.map((key) => `${key}: ${JSON.stringify(entity.payload[key]).slice(0, 300)} → ${JSON.stringify(back.payload[key]).slice(0, 300)}`).join("; ") || "metadati"})`);
    }
  }
  for (const [id, entity] of after.entities) if (!before.entities.has(id)) (isWordPressNative(entity) ? native : problems).push(describe(entity));
  for (const [file, hash] of before.files) if (file !== "entities.ndjson" && after.files.get(file) !== hash) problems.push(`file ${file}: ${after.files.has(file) ? "hash diverso" : "manca al ritorno"}`);
  for (const file of after.files.keys()) if (!before.files.has(file)) problems.push(`file ${file} in più al ritorno`);
  if (problems.length) throw new assert.AssertionError({ message: `L'andata e ritorno su WordPress cambia il progetto:\n- ${problems.join("\n- ")}` });

  // The returned pages hold the markup itself, not only the same hashes: srcset as project media, the textarea text.
  const back = await returned.openProject(projectId);
  try {
    const content = back.store.getHead(back.store.listPages().find((item) => item.slug === "home").id).content;
    const blocks = parseXb(content).blocks;
    assert.match(elements(blocks, "source")[0]?.attrs.attributes?.srcset ?? "", new RegExp(`^/__cms-media/${projectId}/[0-9a-f-]{36} 1x, /__cms-media/${projectId}/[0-9a-f-]{36} 2x$`, "u"));
    assert.deepEqual(elements(blocks, "textarea")[0]?.children.map((child) => child.attrs.content), ["Buongiorno,\nvorrei sapere di più."]);
  } finally {
    back.store.close();
  }
  process.stdout.write(`Markup v1: ${before.entities.size} entità e ${before.files.size} file, stessi hash dopo WordPress${before.archiveSha256 === after.archiveSha256 ? " (export identico byte per byte)" : ""}.\n`);
  if (native.length) process.stdout.write(`  aggiunte di WordPress previste (categorie e tag nativi, §12): ${native.join("; ")}\n`);
  process.stdout.write("  limite noto verificato come previsto: modulo nello slot di un modulo accettato.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
