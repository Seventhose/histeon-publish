import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { ARTICLE_LIBRARY, CmsProjectCatalog, readArticle, writeArticle } from "../packages/cms/dist/index.js";
import { applyRemoteSyncPlan, CmsRemoteCatalog, connectRemoteSite, createRemoteSyncPlan } from "../packages/server/dist/cms-remote.js";
import { readPairingCode, TEST_CONTAINER } from "./wordpress-test-pairing.mjs";

/**
 * Doc 24, the whole way: an article with the blocks for writers goes from Publish onto a disposable WordPress, shows on
 * the site, is changed in the real Gutenberg (a prop in the side panel, a paragraph in place), and comes back to Publish
 * with what changed and nothing else.
 */

const container = process.env.HISTOS_TEST_WP_CONTAINER;
const pairingFile = process.env.HISTOS_TEST_PAIRING_CODE_FILE;
if (!container || !TEST_CONTAINER.test(container)) throw new TypeError("Serve uno stack Docker usa-e-getta histos-cms-* (HISTOS_TEST_WP_CONTAINER).");
if (!pairingFile) throw new TypeError("Serve il codice di collegamento locale (HISTOS_TEST_PAIRING_CODE_FILE).");

const root = await mkdtemp(path.join(os.tmpdir(), "histos-article-blocks-"));
const remotes = new CmsRemoteCatalog(root);
const secrets = new Map();
const secretStoreFor = (account) => ({
  get: async () => secrets.get(account) ?? null,
  set: async (value) => secrets.set(account, value),
  delete: async () => secrets.delete(account),
});
const php = (body) => JSON.parse(execFileSync("docker", ["exec", container, "php", "-r", String.raw`require "/var/www/html/wp-load.php"; wp_set_current_user(get_user_by("login","admin")->ID); ` + body], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const rulesOf = (ref) => ARTICLE_LIBRARY.find((entry) => entry.ref === ref) ?? null;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function transfer(action, connectionId, projectId, catalog) {
  const plan = await createRemoteSyncPlan({ action, connectionId, ...(projectId ? { projectId } : {}) }, remotes, catalog, secretStoreFor);
  if (!plan.applyAllowed || !plan.planId) throw new Error(`Piano ${action} non applicabile: ${JSON.stringify(plan.counts)}`);
  const result = await applyRemoteSyncPlan({ connectionId, planId: plan.planId }, remotes, catalog, secretStoreFor);
  assert.equal(result.complete, true, `${action} deve completarsi`);
  return result;
}

/** Changes the article as a person does, in the editor WordPress ships. */
async function editInGutenberg(baseUrl, postId) {
  const password = randomBytes(18).toString("base64url");
  php(String.raw`wp_set_password(${JSON.stringify(password)}, get_user_by("login","admin")->ID); echo "true";`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const problems = [];
    page.on("pageerror", (error) => problems.push(error.message));
    await page.goto(`${baseUrl}/wp-login.php?redirect_to=${encodeURIComponent(`/wp-admin/post.php?post=${postId}&action=edit`)}`);
    await page.fill("#user_login", "admin");
    await page.fill("#user_pass", password);
    await page.click("#wp-submit");
    await page.waitForFunction(() => window.wp?.data?.select("core/editor")?.getCurrentPostId?.());
    await page.evaluate(() => {
      window.wp.data.dispatch("core/preferences").set("core/edit-post", "welcomeGuide", false);
      window.wp.data.dispatch("core/edit-post").openGeneralSidebar("edit-post/block");
    });
    const canvas = page.frameLocator('iframe[name="editor-canvas"]');
    await canvas.locator(".xb-art-riquadro").waitFor({ timeout: 30_000 });
    await canvas.locator(".xb-editor-rows img").first().waitFor({ timeout: 30_000 });
    if (process.env.HISTOS_TEST_SHOTS) await page.screenshot({ path: path.join(process.env.HISTOS_TEST_SHOTS, "gutenberg.png"), fullPage: false });
    const health = await page.evaluate(() => {
      const walk = (blocks) => blocks.flatMap((block) => [block, ...walk(block.innerBlocks)]);
      const blocks = walk(window.wp.data.select("core/block-editor").getBlocks());
      return { total: blocks.length, invalid: blocks.filter((block) => !block.isValid).map((block) => block.name) };
    });
    assert.deepEqual(health.invalid, [], "nessun blocco deve risultare non valido in Gutenberg");
    // The rows of a gallery change place with the block's own arrows.
    const altOf = () => page.evaluate(() => {
      const rows = [];
      const walk = (blocks) => { for (const block of blocks) { if (block.attributes.ref === "articolo/foto") rows.push(block.attributes.props.alt); walk(block.innerBlocks); } };
      walk(window.wp.data.select("core/block-editor").getBlocks());
      return rows;
    });
    // Selected from the store: the code panel at the bottom stands over the gallery in this window.
    await page.evaluate(() => {
      const find = (blocks) => { for (const block of blocks) { if (block.attributes.ref === "articolo/foto") return block; const inner = find(block.innerBlocks); if (inner) return inner; } return null; };
      window.wp.data.dispatch("core/block-editor").selectBlock(find(window.wp.data.select("core/block-editor").getBlocks()).clientId);
    });
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Move down" }).click({ timeout: 8000 });
    assert.deepEqual(await altOf(), ["Foto 2", "Foto 1"], "le righe si spostano");
    await page.keyboard.press("Control+z");
    await canvas.locator(".xb-art-riquadro").click();
    // This WordPress is in English: the panel speaks its language.
    const title = page.getByLabel("Title", { exact: true });
    await title.fill("Cambiato in Gutenberg");
    await canvas.locator(".xb-art-riquadro .xb-art-titolo", { hasText: "Cambiato in Gutenberg" }).waitFor({ timeout: 30_000 });
    const paragraph = canvas.getByText("Primo paragrafo dell'articolo", { exact: false });
    // The toolbar of the block selected just below stands over this line.
    await paragraph.focus();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" Aggiunto.");
    if (process.env.HISTOS_TEST_SHOTS) await page.screenshot({ path: path.join(process.env.HISTOS_TEST_SHOTS, "gutenberg-panel.png"), fullPage: false });
    // A block of the library not used yet, and Gutenberg's own blocks, as a person adds them from the inserter.
    await page.evaluate(() => {
      const { createBlock } = window.wp.blocks;
      window.wp.data.dispatch("core/block-editor").insertBlocks([
        createBlock("xb/component", { ref: "articolo/autore", props: { name: "Ada", bio: "Scrive." } }),
        createBlock("core/heading", { level: 2, content: "Un titolo di Gutenberg" }),
        createBlock("core/paragraph", { content: "Un paragrafo di <strong>Gutenberg</strong> {qui}." }),
        createBlock("core/list", {}, [createBlock("core/list-item", { content: "Voce" })]),
        createBlock("core/embed", { url: "https://www.youtube.com/watch?v=abc123", providerNameSlug: "youtube" }),
      ]);
    });
    await page.evaluate(() => window.wp.data.dispatch("core/editor").savePost());
    await page.waitForFunction(() => { const editor = window.wp.data.select("core/editor"); return !editor.isSavingPost() && !editor.isEditedPostDirty(); });
    assert.deepEqual(problems, [], "l'editor non deve dare errori");
  } finally {
    await browser.close();
  }
}

try {
  const { code } = await readPairingCode(pairingFile);
  const catalog = new CmsProjectCatalog(path.join(root, "publish"));
  await catalog.initialize();
  const opened = await catalog.createProject("Blocchi");
  const { store, project } = opened;
  store.setRenderSettings({ locale: "it-IT", timeZone: "Europe/Rome" });
  for (const definition of ARTICLE_LIBRARY) store.createComponent({ ref: definition.ref, title: definition.title, content: definition.content, schema: definition.schema });
  const media = (name) => `/__cms-media/${project.id}/${store.saveAsset({ bytes: PNG, mimeType: "image/png", filename: name, alt: name }).id}`;
  const cover = media("copertina.png");
  const photos = [media("uno.png"), media("due.png")];
  const pdf = `/__cms-media/${project.id}/${store.saveAsset({ bytes: Buffer.from("%PDF-1.4\n%prova\n"), mimeType: "application/pdf", filename: "programma.pdf", alt: "" }).id}`;
  const post = store.createPost({ title: "Con i blocchi", slug: "con-i-blocchi", status: "published" });
  const content = writeArticle("", [
    { type: "paragraph", html: 'Primo paragrafo dell\'articolo.<a href="#nota-1"><sup>1</sup></a>' },
    { type: "paragraph", html: "Una graffa scritta {così}, che WordPress 7.1 salva con un'altra forma della barra." },
    { type: "card", ref: "articolo/riquadro", props: { variant: "avviso", title: "Attenzione", text: "Un testo con l'apostrofo, <strong>in grassetto</strong>, le \"virgolette\" & {graffe}" }, entries: [] },
    { type: "card", ref: "articolo/libro", props: { image: cover, title: "Il barone rampante", author: "Italo Calvino", link: "https://esempio.it/barone", linkLabel: "Scheda" }, entries: [] },
    { type: "card", ref: "articolo/galleria", props: {}, entries: photos.map((src, at) => ({ props: { src, alt: `Foto ${at + 1}` } })) },
    { type: "card", ref: "articolo/documento", props: { label: "Il programma", href: pdf }, entries: [] },
    { type: "card", ref: "articolo/video", props: { url: "https://www.youtube.com/watch?v=abc123", title: "L'incontro" }, entries: [] },
    { type: "card", ref: "articolo/domande", props: {}, entries: [{ props: { question: "Perché?", answer: "Perché sì." } }] },
    { type: "card", ref: "articolo/leggi-anche", props: { title: "Da leggere" }, entries: [{ props: { title: "Un altro", link: "/altro/" } }] },
    { type: "card", ref: "articolo/cronologia", props: {}, entries: [{ props: { date: "1957", text: "Esce il libro" } }] },
    { type: "card", ref: "articolo/confronto", props: { before: photos[0], after: photos[1], caption: "Prima e dopo" }, entries: [] },
    // Doc 23 item 86: every other kind of block travels too, one row each.
    { type: "card", ref: "articolo/citazione", props: { text: "Chi legge vive <em>mille</em> vite.", author: "Umberto Eco" }, entries: [] },
    { type: "card", ref: "articolo/pulsante", props: { label: "Iscriviti", link: "https://esempio.it/iscrizione" }, entries: [] },
    { type: "card", ref: "articolo/evento", props: { title: "Presentazione", date: "12 novembre 2026, 18:00", place: "Biblioteca civica", link: "https://esempio.it/evento", linkLabel: "Prenota" }, entries: [] },
    { type: "card", ref: "articolo/audio", props: { url: "https://esempio.it/lettura.mp3", title: "La lettura" }, entries: [] },
    { type: "card", ref: "articolo/mappa", props: { place: "Piazza Maggiore", link: "https://www.openstreetmap.org/#map=18/44.49/11.34" }, entries: [] },
    { type: "card", ref: "articolo/indice", props: { title: "In questo articolo" }, entries: [] },
    { type: "card", ref: "articolo/bibliografia", props: {}, entries: [{ props: { text: "I. Calvino, <em>Il barone rampante</em>, Einaudi 1957." } }] },
    { type: "list", notes: true, items: [{ html: "Una nota con <em>corsivo</em>." }] },
  ], { mediaBase: `/__cms-media/${project.id}`, rulesOf });
  assert.equal(store.saveDocument({ entityId: post.id, expectedHead: store.getEntityById(post.id).headRevision, content }).status, "saved");
  const before = readArticle(content).blocks;
  store.close();

  const connection = await connectRemoteSite(code, remotes, secretStoreFor);
  await transfer("push", connection.id, project.id, catalog);
  const sent = php(String.raw`try { \XB\Plugin::instance()->versioning->publish(null, "Prova dei blocchi"); } catch (\XB\Versioning\VersioningException $e) { if (400 !== $e->getCode()) throw $e; } $id = \XB\Remote\PageProfileAdapter::post_of_entity(${JSON.stringify(post.id)}); echo wp_json_encode(array("id"=>$id,"content"=>get_post_field("post_content",$id),"home"=>home_url()));`);
  assert.ok(sent.content.includes("articolo/riquadro"), "l'articolo arriva con le istanze dei componenti");

  const html = execFileSync("docker", ["exec", container, "php", "-r", String.raw`echo file_get_contents("http://127.0.0.1/?p=${sent.id}");`], { encoding: "utf8" });
  for (const piece of ['class="xb-art-riquadro xb-art-riquadro-avviso"', "<details>", 'class="xb-art-cronologia"', 'class="xb-art-confronto"', 'class="xb-art-libro"', 'class="xb-art-galleria"', 'id="nota-1"', 'href="#nota-1"', "Il barone rampante"]) assert.ok(html.includes(piece), `il sito mostra ${piece}`);
  for (const piece of ["xb-art-citazione", "Umberto Eco", "xb-art-pulsante", "https://esempio.it/iscrizione", "xb-art-evento", "Biblioteca civica", "xb-art-audio", "xb-art-mappa", "Piazza Maggiore", "xb-art-indice", "xb-art-bibliografia", "Einaudi 1957"]) assert.ok(html.includes(piece), `il sito mostra ${piece}`);
  assert.ok(html.includes("xb-art-riquadro-avviso{") || html.includes("xb-art-riquadro {") || html.includes(".xb-art-riquadro"), "lo stile dei blocchi arriva al sito");
  assert.ok(!html.includes("/__cms-media/"), "le immagini sono quelle di WordPress");
  assert.ok(html.includes("<strong>in grassetto</strong>"), "i formati nei blocchi arrivano sul sito");
  assert.match(html, /class="xb-art-documento" href="[^"]*\/wp-content\/uploads\/[^"]*programma[^"]*\.pdf"/u, "il PDF è nei media di WordPress");

  await editInGutenberg(sent.home, sent.id);
  const edited = php(String.raw`echo wp_json_encode(get_post_field("post_content",${sent.id}));`);
  assert.ok(edited.includes("Cambiato in Gutenberg") && edited.includes("Aggiunto."), "Gutenberg salva le modifiche");

  await transfer("pull", connection.id, null, catalog);
  const back = (await catalog.openProject(project.id)).store;
  const after = readArticle(back.getRevision(back.getEntityById(post.id).headRevision).content).blocks;
  const summary = (blocks) => blocks.map((block) => block.type === "card" ? { type: block.type, ref: block.ref, entries: block.entries.length } : { type: block.type });
  assert.deepEqual(summary(after.slice(0, before.length)), summary(before), "tornano gli stessi blocchi, nello stesso ordine");
  const added = after.slice(before.length);
  assert.deepEqual(added.map((block) => block.type), ["card", "heading", "paragraph", "list", "kept"], "tornano anche i blocchi aggiunti in Gutenberg");
  assert.equal(added[4].label, "WordPress: embed", "ciò che non ha una forma semplice resta protetto, e non ferma nulla");
  assert.equal(added[0].props.name, "Ada");
  assert.equal(added[2].html, "Un paragrafo di <strong>Gutenberg</strong> {qui}.");
  assert.ok(back.getComponentByRef("articolo/autore"), "il blocco nuovo arriva con la sua definizione");
  assert.equal(after[2].props.title, "Cambiato in Gutenberg");
  assert.equal(after[2].props.text, before[2].props.text, "l'altro testo del blocco è intatto");
  assert.ok(after[0].html.includes("Aggiunto.") && after[0].html.includes('href="#nota-1"'));
  assert.equal(after[3].props.title, "Il barone rampante");
  assert.ok(/^\/__cms-media\//u.test(String(after[3].props.image)), `la copertina torna ai media di Publish: ${after[3].props.image}`);
  assert.ok(after[4].entries.every((row) => /^\/__cms-media\//u.test(String(row.props.src))), "la galleria torna ai media di Publish");
  assert.deepEqual(after[18].items.map((item) => item.html), ["Una nota con <em>corsivo</em>."]);
  // Each kind of block comes back with its texts and rows.
  assert.equal(after[11].props.author, "Umberto Eco");
  assert.equal(after[12].props.link, "https://esempio.it/iscrizione");
  assert.equal(after[13].props.place, "Biblioteca civica");
  assert.equal(after[14].props.url, "https://esempio.it/lettura.mp3");
  assert.equal(after[15].props.place, "Piazza Maggiore");
  // The index writes its own rows from the headings: here it comes back as a block.
  assert.equal(after[16].ref, "articolo/indice");
  assert.equal(after[17].entries[0].props.text, "I. Calvino, <em>Il barone rampante</em>, Einaudi 1957.");
  assert.equal(after[7].entries[0].props.answer, "Perché sì.");
  assert.ok(/^\/__cms-media\//u.test(String(after[10].props.after)), "anche il confronto torna ai media di Publish");

  // Back to the site: the foreign block is still there, whole; a new one from the project is refused, nothing written.
  const backHead = back.getEntityById(post.id).headRevision;
  const backContent = back.getRevision(backHead).content;
  const changed = backContent.replace("Aggiunto.", "Aggiunto e cambiato in Publish.");
  assert.equal(back.saveDocument({ entityId: post.id, expectedHead: backHead, content: changed }).status, "saved");
  back.close();
  await transfer("push", connection.id, project.id, catalog);
  const again = php(String.raw`try { \XB\Plugin::instance()->versioning->publish(null, "Prova del ritorno"); } catch (\XB\Versioning\VersioningException $e) { if (400 !== $e->getCode()) throw $e; } echo wp_json_encode(get_post_field("post_content",${sent.id}));`);
  assert.ok(again.includes("cambiato in Publish") && again.includes("wp:embed"), "il testo cambia e il blocco di WordPress resta");
  const hostile = (await catalog.openProject(project.id)).store;
  const hostileHead = hostile.getEntityById(post.id).headRevision;
  const injected = '<!-- wp:xb/passthrough {"uid":"pinjected1"} --><!-- wp:html --><script>alert(1)</script><!-- /wp:html --><!-- /wp:xb/passthrough -->';
  assert.equal(hostile.saveDocument({ entityId: post.id, expectedHead: hostileHead, content: hostile.getRevision(hostileHead).content + injected }).status, "saved");
  hostile.close();
  // The refusal of the plugin's preflight, in the language of the disposable site (English since Histeon 0.3.8 on en_US).
  await assert.rejects(
    transfer("push", connection.id, project.id, catalog),
    (error) => error.remoteCode === "xb_cms_preflight" && /questo sito non ha|this site does not have/u.test(String(error.message)),
    "un blocco nuovo non entra in WordPress da un progetto",
  );
  assert.ok(!php(String.raw`echo wp_json_encode(get_post_field("post_content",${sent.id}));`).includes("alert(1)"), "nulla è stato scritto");
  process.stdout.write("Articolo con i blocchi: Publish → WordPress → Gutenberg → Publish superato.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
