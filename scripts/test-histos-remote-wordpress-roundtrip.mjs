import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { CmsProjectCatalog, renderCmsPage } from "../packages/cms/dist/index.js";
import { startLocalServer } from "../packages/server/dist/server.js";
import {
  applyRemoteSyncPlan,
  CmsRemoteCatalog,
  connectRemoteSite,
  createRemoteSyncPlan,
  revokeRemotePairing,
} from "../packages/server/dist/cms-remote.js";
import { readPairingCode, TEST_CONTAINER } from "./wordpress-test-pairing.mjs";

const container = process.env.HISTOS_TEST_WP_CONTAINER;
const pairingPath = process.env.HISTOS_TEST_PAIRING_CODE_FILE;
const secondContainer = process.env.HISTOS_TEST_SECOND_WP_CONTAINER;
const secondPairingPath = process.env.HISTOS_TEST_SECOND_PAIRING_CODE_FILE;
if (!container || !TEST_CONTAINER.test(container)) {
  throw new TypeError("Imposta HISTOS_TEST_WP_CONTAINER con il nome di uno stack Docker usa-e-getta histos-cms-*.");
}
if (!pairingPath) throw new TypeError("Imposta HISTOS_TEST_PAIRING_CODE_FILE con il percorso del codice di collegamento locale.");
if (Boolean(secondContainer) !== Boolean(secondPairingPath)) {
  throw new TypeError("Per il secondo WordPress locale servono sia HISTOS_TEST_SECOND_WP_CONTAINER sia HISTOS_TEST_SECOND_PAIRING_CODE_FILE.");
}
if (secondContainer && !TEST_CONTAINER.test(secondContainer)) {
  throw new TypeError("Il secondo container deve appartenere a uno stack Docker usa-e-getta histos-cms-*.");
}

const { code: pairingCode, target } = await readPairingCode(pairingPath);
const secondPairing = secondPairingPath ? await readPairingCode(secondPairingPath) : null;
if (secondPairing && secondPairing.target.origin === target.origin) {
  throw new TypeError("Le due installazioni WordPress devono avere origini diverse.");
}

const eventId = "550e8400-e29b-41d4-a716-446655440108";
const secondEventId = "550e8400-e29b-41d4-a716-446655440109";
const homePageId = "550e8400-e29b-41d4-a716-446655440101";
const speakerId = "550e8400-e29b-41d4-a716-446655440107";
const localizedSpeakerId = "550e8400-e29b-41d4-a716-446655440204";
const termId = "550e8400-e29b-41d4-a716-446655440106";
const templatePageContent = '<!-- wp:xb/element {"uid":"m3template01","tag":"p"} --><!-- wp:xb/text {"uid":"m3template02","content":"Pagina resa nel template Histeon dopo il round-trip WordPress"} /--><!-- /wp:xb/element -->';
const singleTemplateContent = '<!-- wp:xb/element {"uid":"m3singleroot","tag":"main"} --><!-- wp:xb/element {"uid":"m3singletitle","tag":"h1"} --><!-- wp:xb/text {"uid":"m3singletxt","content":"{props.page.title}"} /--><!-- /wp:xb/element --><!-- wp:xb/element {"uid":"m3singledate","tag":"time"} --><!-- wp:xb/text {"uid":"m3singledatetxt","content":"{props.page.meta.starts_at}"} /--><!-- /wp:xb/element --><!-- wp:xb/element {"uid":"m3singleprivate","tag":"p"} --><!-- wp:xb/text {"uid":"m3privatetxt01","content":"{props.page.meta.private_note}"} /--><!-- /wp:xb/element --><!-- wp:xb/slot {"uid":"m3singleslot","name":"default"} /--><!-- /wp:xb/element -->';
const archiveTemplateContent = '<!-- wp:xb/element {"uid":"m3archiveroot","tag":"main"} --><!-- wp:xb/element {"uid":"m3archivetitle","tag":"h1"} --><!-- wp:xb/text {"uid":"m3archivetxt","content":"{props.page.title}"} /--><!-- /wp:xb/element --><!-- wp:xb/loop {"uid":"m3archiveloop","source":{"kind":"preset","id":"m3_events","args":{"count":"1"}},"as":"item"} --><!-- wp:xb/element {"uid":"m3archiveitem","tag":"h2"} --><!-- wp:xb/text {"uid":"m3archiveitemtxt","content":"{item.title}"} /--><!-- /wp:xb/element --><!-- /wp:xb/loop --><!-- wp:xb/slot {"uid":"m3archiveslot","name":"default"} /--><!-- /wp:xb/element -->';
const projectRoot = await mkdtemp(path.join(os.tmpdir(), "histos-wp-roundtrip-"));
const localCatalog = new CmsProjectCatalog(path.join(projectRoot, "cms-a"));
const returnedCatalog = new CmsProjectCatalog(path.join(projectRoot, "cms-c"));
const remotes = new CmsRemoteCatalog(projectRoot);
const secrets = new Map();
const secretStoreFor = (account) => ({
  get: async () => secrets.get(account) ?? null,
  set: async (value) => secrets.set(account, value),
  delete: async () => secrets.delete(account),
});
let sourceStore;
let returnedStore;
let independentStore;
let cmsBuildServer;

function editWordPressRecordAndTerm() {
  const code = String.raw`require "/var/www/html/wp-load.php"; $post=get_posts(["post_type"=>"events","post_status"=>["draft","publish","private"],"posts_per_page"=>20,"meta_key"=>"_xb_page_profile_id","meta_value"=>"${eventId}"])[0]??null; if (!$post) { fwrite(STDERR,"Synthetic event not found.\n"); exit(2); } $saved=wp_update_post(["ID"=>$post->ID,"post_title"=>"Titolo modificato in WordPress"],true); if (is_wp_error($saved)) { fwrite(STDERR,$saved->get_error_message()."\n"); exit(3); } $term=null; foreach (get_terms(["taxonomy"=>"event-category","hide_empty"=>false]) as $candidate) { if (get_term_meta($candidate->term_id,"_xb_page_profile_id",true)==="${termId}") { $term=$candidate; break; } } if (!$term) { fwrite(STDERR,"Synthetic term not found.\n"); exit(4); } $updated=wp_update_term($term->term_id,"event-category",["name"=>"Formazione modificata in WordPress"]); if (is_wp_error($updated)) { fwrite(STDERR,$updated->get_error_message()."\n"); exit(5); } echo "synthetic record and term edited";`;
  execFileSync("docker", ["exec", container, "php", "-r", code], { stdio: "pipe" });
}

function assertWordPressDraftTitle(title, wpContainer = container) {
  const code = String.raw`require "/var/www/html/wp-load.php"; $post=get_posts(["post_type"=>"events","post_status"=>["draft","publish","private"],"posts_per_page"=>20,"meta_key"=>"_xb_page_profile_id","meta_value"=>"${eventId}"])[0]??null; if (!$post || $post->post_title!=="${title}") { fwrite(STDERR,"WordPress title does not match the round-trip result after the release.\n"); exit(6); } echo "synthetic WordPress draft verified";`;
  execFileSync("docker", ["exec", wpContainer, "php", "-r", code], { stdio: "pipe" });
}

function editWordPressDraftTitle(title, wpContainer) {
  const encodedTitle = Buffer.from(title, "utf8").toString("base64");
  const code = String.raw`require "/var/www/html/wp-load.php"; $post=get_posts(["post_type"=>"events","post_status"=>["draft","publish","private"],"posts_per_page"=>20,"meta_key"=>"_xb_page_profile_id","meta_value"=>"${eventId}"])[0]??null; if (!$post) { fwrite(STDERR,"Synthetic event not found.\\n"); exit(7); } $title=base64_decode("${encodedTitle}",true); if (!is_string($title)) { fwrite(STDERR,"Synthetic title is invalid.\\n"); exit(8); } $saved=wp_update_post(["ID"=>$post->ID,"post_title"=>$title],true); if (is_wp_error($saved)) { fwrite(STDERR,$saved->get_error_message()."\\n"); exit(9); } echo "synthetic WordPress title changed";`;
  execFileSync("docker", ["exec", wpContainer, "php", "-r", code], { stdio: "pipe" });
}

function trashWordPressDraftRecord(recordId, wpContainer) {
  const code = String.raw`require "/var/www/html/wp-load.php"; $post=get_posts(["post_type"=>"events","post_status"=>["draft","publish","private"],"posts_per_page"=>20,"meta_key"=>"_xb_page_profile_id","meta_value"=>"${recordId}"])[0]??null; if (!$post) { fwrite(STDERR,"Synthetic event not found before trash.\\n"); exit(10); } $trashed=wp_trash_post($post->ID); if (!$trashed || get_post_status($post->ID)!=="trash") { fwrite(STDERR,"WordPress did not move the synthetic event to Trash.\\n"); exit(11); } $tombstone=get_post_meta($post->ID,"_xb_page_profile_tombstone",true); if (!is_array($tombstone) || ($tombstone["kind"]??null)!=="tombstone") { fwrite(STDERR,"Histeon did not create a recoverable tombstone.\\n"); exit(12); } echo "synthetic Histeon tombstone created";`;
  execFileSync("docker", ["exec", wpContainer, "php", "-r", code], { stdio: "pipe" });
}

function changeWordPressRecordTypeToPage(recordId, wpContainer) {
  const code = String.raw`require "/var/www/html/wp-load.php"; $post=get_posts(["post_type"=>"events","post_status"=>["draft","publish","private"],"posts_per_page"=>20,"meta_key"=>"_xb_page_profile_id","meta_value"=>"${recordId}"])[0]??null; if (!$post) { fwrite(STDERR,"Synthetic event not found before type change.\\n"); exit(13); } $updated=wp_update_post(["ID"=>$post->ID,"post_type"=>"page"],true); if (is_wp_error($updated) || get_post_type($post->ID)!=="page" || get_post_meta($post->ID,"_xb_page_profile_id",true)!=="${recordId}") { fwrite(STDERR,"WordPress did not preserve the Histeon identity while changing post type.\\n"); exit(14); } echo "synthetic Histeon post type changed";`;
  execFileSync("docker", ["exec", wpContainer, "php", "-r", code], { stdio: "pipe" });
}

// A send from Histeon CMS lands in development; it goes live with the next Histeon release, which an administrator
// publishes from the builder (docs/spec/cms-bridge.md §5). The test plays that administrator.
function releaseOnWordPress(wpContainer = container) {
  const code = String.raw`require "/var/www/html/wp-load.php"; $user=get_user_by("login","admin"); if (!$user) { fwrite(STDERR,"admin user missing\n"); exit(20); } wp_set_current_user($user->ID); try { \XB\Plugin::instance()->versioning->publish(null, "Release di prova"); } catch (\XB\Versioning\VersioningException $e) { if (400 !== $e->getCode()) { fwrite(STDERR, $e->getMessage()."\n"); exit(21); } \XB\Remote\ContentProfileAdapter::apply_queue(0); } echo "RELEASED";`;
  const output = execFileSync("docker", ["exec", wpContainer, "php", "-r", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!output.includes("RELEASED")) throw new Error("La release di prova su WordPress non è riuscita.");
}

async function pushAndRelease(connectionId, projects, plan, wpContainer = container) {
  const result = await applyPlan(connectionId, "push", projects, plan);
  releaseOnWordPress(wpContainer);
  return result;
}

async function applyPlan(connectionId, action, projects, plan) {
  if (!plan.applyAllowed || !plan.planId || plan.counts.conflict !== 0) throw new Error(`Piano ${action} non applicabile senza conflitti.`);
  const result = await applyRemoteSyncPlan({ connectionId, planId: plan.planId }, remotes, projects, secretStoreFor);
  if (!result.complete) throw new Error(`Il trasferimento ${action} non è stato completato.`);
  return result;
}

async function assertTemplateRoundTrip(store, projectId) {
  const eventType = store.content.getType("events");
  assert.ok(eventType);
  assert.equal(eventType.singleTemplateRef, "content/event-single");
  assert.equal(eventType.archiveTemplateRef, "content/event-archive");
  const single = store.getTemplateByRef("content/event-single");
  const archive = store.getTemplateByRef("content/event-archive");
  assert.ok(single);
  assert.ok(archive);
  assert.equal(single.content, singleTemplateContent);
  assert.equal(archive.content, archiveTemplateContent);
  const event = store.content.getRecordById(eventId, true);
  assert.ok(event);
  const publicFields = Object.fromEntries(eventType.fields.filter((field) => field.public && Object.hasOwn(event.values, field.key)).map((field) => [field.key, event.values[field.key]]));
  const detailRendered = await renderCmsPage({
    store,
    projectId,
    content: "",
    templateRef: eventType.singleTemplateRef,
    page: { ...event, url: `/events/${event.slug}/`, fields: publicFields, meta: publicFields, values: publicFields },
    locale: event.locale,
  });
  assert.ok(detailRendered.html.includes(`<h1>${event.title}</h1>`));
  assert.ok(detailRendered.html.includes(`<time>${String(publicFields.starts_at)}</time>`));
  assert.ok(!detailRendered.html.includes("Non esportare nel frontend"), "the detail template must not expose private fields");

  const archiveRendered = await renderCmsPage({
    store,
    projectId,
    content: "",
    templateRef: eventType.archiveTemplateRef,
    page: { id: eventType.id, title: eventType.label, slug: eventType.key, url: "/events/" },
    locale: event.locale,
    resolveQuery: (presetId, args, locale) => store.content.resolveQueryPreset(presetId, args, locale),
  });
  assert.ok(archiveRendered.html.includes(`<h1>${eventType.label}</h1>`));
  assert.equal(archiveRendered.html.includes(`<h2>${event.title}</h2>`), event.status === "published", "the archive loop must include published records and exclude drafts");

  assert.ok(!archiveRendered.html.includes("<h2>Zeta evento di prova</h2>"), "the dynamic count argument must limit the query loop to one record");

  const page = store.listPages().find((entry) => entry.id === homePageId);
  assert.ok(page);
  assert.equal(page.templateRef, "content/event-single");
  const revision = store.getHead(page.id);
  assert.ok(revision);
  assert.equal(revision.content, templatePageContent);
  const rendered = await renderCmsPage({
    store,
    projectId,
    content: revision.content,
    templateRef: page.templateRef,
    page: { id: page.id, title: page.title, slug: page.slug, url: "/", meta: { starts_at: "2026-10-24T09:00:00Z" } },
  });
  assert.ok(rendered.html.includes(`<h1>${page.title}</h1>`));
  assert.ok(rendered.html.includes("<time>2026-10-24T09:00:00Z</time>"));
  assert.ok(rendered.html.includes("<p>Pagina resa nel template Histeon dopo il round-trip WordPress</p>"));
}

async function captureLocalVisualComparison({ wordpressUrl, staticUrl }) {
  const outputDirectory = process.env.HISTOS_VISUAL_OUTPUT_DIR;
  if (!outputDirectory) return;

  const wordpressOrigin = new URL(wordpressUrl).origin;
  const staticOrigin = new URL(staticUrl).origin;
  const allowedOrigins = new Set([wordpressOrigin, staticOrigin]);
  const browser = await chromium.launch({ headless: true });
  const pages = [
    ["wordpress-archive.png", "WordPress archive", new URL("/events/", wordpressOrigin).href],
    ["static-archive.png", "Static archive", new URL("events/index.html", staticUrl).href],
    ["wordpress-single.png", "WordPress single", new URL("/events/incontro-portabile/", wordpressOrigin).href],
    ["static-single.png", "Static single", new URL("events/incontro-portabile/index.html", staticUrl).href],
  ];
  const viewportWidths = [1280, 390, 320];
  const metrics = {};
  try {
    await mkdir(outputDirectory, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: "light", reducedMotion: "reduce" });
    await context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.startsWith("data:")) return route.continue();
      try {
        const origin = new URL(requestUrl).origin;
        if (allowedOrigins.has(origin)) return route.continue();
      } catch {}
      return route.abort("blockedbyclient");
    });
    for (const [filename, label, url] of pages) {
      for (const width of viewportWidths) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 900 });
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => document.fonts.ready.then(() => true));
        await page.screenshot({ path: path.join(outputDirectory, filename.replace(".png", `-${width}.png`)), fullPage: true });
        metrics[`${label} @${width}px`] = await page.evaluate(() => {
          const rect = (element) => {
            if (!element) return null;
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height };
          };
          const style = (element) => {
            if (!element) return null;
            const computed = getComputedStyle(element);
            return { color: computed.color, fontFamily: computed.fontFamily, fontSize: computed.fontSize, fontWeight: computed.fontWeight, lineHeight: computed.lineHeight, margin: computed.margin, padding: computed.padding };
          };
          const main = document.querySelector("main");
          const h1 = document.querySelector("main h1");
          return {
            title: document.title,
            heading: h1?.textContent?.trim() ?? null,
            main: rect(main),
            headingRect: rect(h1),
            mainStyle: style(main),
            headingStyle: style(h1),
            scrollWidth: document.documentElement.scrollWidth,
            viewportWidth: document.documentElement.clientWidth,
          };
        });
        await page.close();
      }
    }
    await context.close();
    await writeFile(path.join(outputDirectory, "metrics.json"), `${JSON.stringify({ viewport: { width: 1280, height: 900 }, externalRequests: "blocked", pages: metrics }, null, 2)}\n`, "utf8");
    for (const suffix of ["archive", "single"]) {
      for (const width of viewportWidths) {
        const wordpress = metrics[`WordPress ${suffix} @${width}px`];
        const staticSite = metrics[`Static ${suffix} @${width}px`];
        assert.deepEqual(staticSite.mainStyle, wordpress.mainStyle, `${suffix} main styles must match at ${width}px`);
        assert.deepEqual(staticSite.headingStyle, wordpress.headingStyle, `${suffix} heading styles must match at ${width}px`);
        assert.deepEqual(staticSite.main, wordpress.main, `${suffix} main geometry must match at ${width}px`);
        assert.deepEqual(staticSite.headingRect, wordpress.headingRect, `${suffix} heading geometry must match at ${width}px`);
        assert.equal(staticSite.scrollWidth, staticSite.viewportWidth, `${suffix} static page must not overflow at ${width}px`);
        assert.equal(wordpress.scrollWidth, wordpress.viewportWidth, `${suffix} WordPress page must not overflow at ${width}px`);
      }
    }
    process.stdout.write(`Visual comparison captured locally in ${outputDirectory}; no external origins were requested.\n`);
  } finally {
    await browser.close();
  }
}

try {
  const fixture = JSON.parse(await readFile(new URL("../packages/histos-contract/test/fixtures/histos-static-project-v3.json", import.meta.url), "utf8"));
  const files = new Map(Object.entries(fixture.files).map(([name, encoded]) => [name, Buffer.from(encoded, "base64")]));
  const imported = await localCatalog.importStaticPageProfile(fixture.profile, files);
  const projectId = imported.project.id;
  sourceStore = imported.store;
  const styles = sourceStore.getStyles();
  const stylesHead = styles && sourceStore.getHead(styles.id);
  if (!styles || !stylesHead) throw new Error("Il documento Stili necessario alla prova visuale M2/M3 non è presente.");
  const visualStyles = JSON.parse(stylesHead.content);
  visualStyles.globals = [{
    id: "m3-visual-parity",
    css: "body{margin:0;font-family:Arial,sans-serif}main{box-sizing:border-box;max-width:768px;margin:0 auto;padding:24px;color:#123456}main h1{font-size:32px;line-height:1.2;margin:0 0 16px}",
  }];
  const savedStyles = sourceStore.saveDocument({ entityId: styles.id, expectedHead: stylesHead.id, content: JSON.stringify(visualStyles) });
  if (savedStyles.status !== "saved") throw new Error("Il foglio CSS della prova visuale non è stato salvato.");
  const sourceEventType = sourceStore.content.getType("events");
  assert.ok(sourceEventType);
  assert.equal(sourceEventType.singleTemplateRef, "content/event-single");
  assert.equal(sourceEventType.archiveTemplateRef, "content/event-archive");
  const savedQuery = sourceStore.content.saveQueryPreset({ key: "m3_events", label: "Eventi M3", typeKey: "events", limit: 10, limitParam: "count", orderBy: "title", order: "asc", expectedHead: null });
  if (savedQuery.status !== "saved") throw new Error("La query archivio necessaria alla prova M3 non è stata salvata.");
  const secondEvent = sourceStore.content.saveRecord({
    id: secondEventId,
    typeKey: "events",
    title: "Zeta evento di prova",
    slug: "zeta-evento-di-prova",
    locale: "it-IT",
    status: "published",
    publishedAt: "2026-10-23T12:00:00.000Z",
    excerpt: "",
    order: 1,
    values: { starts_at: "2026-11-16T09:30:00+01:00", speaker: speakerId },
    expectedHead: null,
  });
  if (secondEvent.status !== "saved") throw new Error("Il secondo evento necessario alla verifica del limite dinamico non è stato salvato.");
  for (const [ref, content] of [["content/event-single", singleTemplateContent], ["content/event-archive", archiveTemplateContent]]) {
    const template = sourceStore.getTemplateByRef(ref);
    if (!template) throw new Error(`Il template ${ref} necessario alla prova M3 non è presente.`);
    const result = sourceStore.saveComponent({ alias: template.alias, expectedHead: template.headRevision, ref: template.ref, schema: template.schema, content });
    if (result.status !== "saved") throw new Error(`Il contenuto del template ${ref} non è stato salvato.`);
  }
  const homePage = sourceStore.listPages().find((entry) => entry.id === homePageId);
  if (!homePage) throw new Error("La pagina Home necessaria alla verifica del template non è presente.");
  sourceStore.updatePageMetadata(homePage.id, { title: homePage.title, slug: homePage.slug, status: homePage.status, templateRef: "content/event-single" });
  const homeRevision = sourceStore.getHead(homePage.id);
  if (!homeRevision) throw new Error("La revisione Home necessaria alla verifica del template non è presente.");
  const savedHome = sourceStore.saveDocument({ entityId: homePage.id, expectedHead: homeRevision.id, content: templatePageContent });
  if (savedHome.status !== "saved") throw new Error("Il contenuto Home di prova non è stato salvato.");
  await assertTemplateRoundTrip(sourceStore, projectId);
  const speakerType = sourceStore.content.getType("speaker");
  const speaker = sourceStore.content.getRecordById(speakerId, true);
  if (!speakerType || !speaker) throw new Error("Il tipo o il relatore necessario alla prova M3 non è presente.");
  const pageFixture = JSON.parse(await readFile(new URL("../packages/histos-contract/test/fixtures/histos-static-page-v1.json", import.meta.url), "utf8"));
  const sourceAsset = pageFixture.profile.entities.find((entity) => entity.kind === "asset");
  if (!sourceAsset) throw new Error("La fixture immagine per la prova M3 non è presente.");
  const sharedPng = Buffer.from(pageFixture.files[sourceAsset.payload.path], "base64");
  const portraitIt = sourceStore.saveAsset({ bytes: sharedPng, mimeType: "image/png", filename: "ritratto-it.png", alt: "Ada alla conferenza", caption: "Relatrice italiana" });
  const portraitEn = sourceStore.saveAsset({ bytes: sharedPng, mimeType: "image/png", filename: "portrait-en.png", alt: "Ada at the conference", caption: "English speaker portrait" });
  assert.notEqual(portraitIt.id, portraitEn.id);
  assert.equal(portraitIt.sha256, portraitEn.sha256);
  const typeUpdate = sourceStore.content.saveType({
    id: speakerType.id,
    key: speakerType.key,
    label: speakerType.label,
    fields: [...speakerType.fields, { key: "portrait", label: "Ritratto", type: "asset", required: false, public: true, multiple: false }],
    expectedHead: speakerType.headRevision,
  });
  if (typeUpdate.status !== "saved") throw new Error("Il campo immagine non è stato salvato nel tipo relatore.");
  const speakerUpdate = sourceStore.content.saveRecord({
    id: speaker.id,
    typeKey: speaker.typeKey,
    title: speaker.title,
    slug: "la-biblioteca",
    locale: speaker.locale,
    status: speaker.status,
    publishedAt: speaker.publishedAt,
    excerpt: speaker.excerpt,
    order: speaker.order,
    values: { ...speaker.values, portrait: portraitEn.id },
    expectedHead: speaker.headRevision,
  });
  if (speakerUpdate.status !== "saved") throw new Error("Il ritratto inglese non è stato collegato al record.");
  const localizedSpeaker = sourceStore.content.saveRecord({
    id: localizedSpeakerId,
    typeKey: "speaker",
    title: "Ada relatrice",
    slug: "la-biblioteca",
    locale: "it-IT",
    status: "published",
    values: { biography: "Ricercatrice italiana", editor_note: "Solo redazione italiana", portrait: portraitIt.id },
    expectedHead: null,
  });
  if (localizedSpeaker.status !== "saved") {
    throw new Error("Il record localizzato non ha l’identità prevista.");
  }
  sourceStore.close();
  sourceStore = undefined;

  const connection = await connectRemoteSite(pairingCode, remotes, secretStoreFor);
  if (connection.projectId !== null) {
    throw new Error("Il WordPress usa-e-getta è già collegato a un progetto Histeon. Usa uno stack e un database nuovi; la prova non ha applicato modifiche.");
  }
  const initialPlan = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, localCatalog, secretStoreFor);
  if (!initialPlan.initializingRemote) {
    throw new Error("Il WordPress usa-e-getta contiene già dati Histeon e non consente l’inizializzazione. Usa uno stack e un database nuovi; la prova non ha applicato modifiche.");
  }
  await pushAndRelease(connection.id, localCatalog, initialPlan);

  const repeatedPush = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, localCatalog, secretStoreFor);
  assert.equal(repeatedPush.counts.update, 0, "repeating a push already released must be idempotent");
  assert.equal(repeatedPush.counts.conflict, 0);

  editWordPressRecordAndTerm();
  const pullToCmsC = await createRemoteSyncPlan({ action: "pull", connectionId: connection.id }, remotes, returnedCatalog, secretStoreFor);
  assert.ok(pullToCmsC.counts.new > 0, "the second CMS project must import the complete WordPress profile");
  await applyPlan(connection.id, "pull", returnedCatalog, pullToCmsC);
  const returned = await returnedCatalog.openProject(projectId);
  assert.ok(returned);
  returnedStore = returned.store;
  await assertTemplateRoundTrip(returnedStore, projectId);
  const returnedEvent = returnedStore.content.getRecordById(eventId, true);
  assert.ok(returnedEvent);
  assert.equal(returnedEvent.title, "Titolo modificato in WordPress");
  assert.equal(returnedEvent.status, "published", "the release publishes what CMS A marked as published, and CMS C receives that status");
  assert.equal(returnedEvent.values.private_note, "Non esportare nel frontend");
  assert.equal(returnedEvent.values.speaker?.id, speakerId);
  assert.equal(returnedStore.content.getTermById(termId)?.label, "Formazione modificata in WordPress");
  const returnedSpeakerEn = returnedStore.content.getRecordById(speakerId, true);
  const returnedSpeakerIt = returnedStore.content.getRecordById(localizedSpeakerId, true);
  assert.ok(returnedSpeakerEn);
  assert.ok(returnedSpeakerIt);
  assert.equal(returnedSpeakerEn.slug, "la-biblioteca");
  assert.equal(returnedSpeakerIt.slug, "la-biblioteca");
  assert.equal(returnedSpeakerEn.locale, "en-US");
  assert.equal(returnedSpeakerIt.locale, "it-IT");
  assert.equal(returnedSpeakerEn.values.portrait, portraitEn.id);
  assert.equal(returnedSpeakerIt.values.portrait, portraitIt.id);
  const returnedPortraitEn = returnedStore.listAssets().find((asset) => asset.id === portraitEn.id);
  const returnedPortraitIt = returnedStore.listAssets().find((asset) => asset.id === portraitIt.id);
  assert.ok(returnedPortraitEn);
  assert.ok(returnedPortraitIt);
  assert.equal(returnedPortraitEn.sha256, returnedPortraitIt.sha256);
  assert.equal(returnedPortraitEn.alt, "Ada at the conference");
  assert.equal(returnedPortraitEn.caption, "English speaker portrait");
  assert.equal(returnedPortraitIt.alt, "Ada alla conferenza");
  assert.equal(returnedPortraitIt.caption, "Relatrice italiana");
  const returnedPngEn = await returnedStore.readAsset(portraitEn.id);
  const returnedPngIt = await returnedStore.readAsset(portraitIt.id);
  assert.ok(returnedPngEn);
  assert.ok(returnedPngIt);
  assert.deepEqual([...returnedPngEn.bytes], [...sharedPng]);
  assert.deepEqual([...returnedPngIt.bytes], [...sharedPng]);
  const returnedTerms = Object.fromEntries(Object.entries(returnedEvent.terms).map(([key, terms]) => [key, terms.map((term) => term.alias)]));
  const returnedEdit = returnedStore.content.saveRecord({
    id: returnedEvent.id,
    typeKey: returnedEvent.typeKey,
    title: "Titolo aggiornato da CMS C",
    slug: returnedEvent.slug,
    locale: returnedEvent.locale,
    status: returnedEvent.status,
    publishedAt: returnedEvent.publishedAt,
    excerpt: returnedEvent.excerpt,
    order: returnedEvent.order,
    values: { ...returnedEvent.values, speaker: speakerId },
    terms: returnedTerms,
    expectedHead: returnedEvent.headRevision,
  });
  assert.equal(returnedEdit.status, "saved");
  returnedStore.close();
  returnedStore = undefined;
  const pushFromCmsC = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, returnedCatalog, secretStoreFor);
  assert.ok(pushFromCmsC.counts.update > 0);
  await pushAndRelease(connection.id, returnedCatalog, pushFromCmsC);
  assertWordPressDraftTitle("Titolo aggiornato da CMS C");
  const repeatedCmsCPush = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, returnedCatalog, secretStoreFor);
  assert.equal(repeatedCmsCPush.counts.update, 0);
  assert.equal(repeatedCmsCPush.counts.conflict, 0);

  const pullToCmsA = await createRemoteSyncPlan({ action: "pull", connectionId: connection.id }, remotes, localCatalog, secretStoreFor);
  assert.equal(pullToCmsA.counts.conflict, 0);
  await applyPlan(connection.id, "pull", localCatalog, pullToCmsA);
  const local = await localCatalog.openProject(projectId);
  assert.ok(local);
  sourceStore = local.store;
  await assertTemplateRoundTrip(sourceStore, projectId);
  const localEvent = sourceStore.content.getRecordById(eventId, true);
  assert.ok(localEvent);
  assert.equal(localEvent.title, "Titolo aggiornato da CMS C");
  assert.equal(localEvent.status, "published", "pulling back must keep CMS A published");
  assert.equal(localEvent.values.private_note, "Non esportare nel frontend");
  assert.equal(sourceStore.content.getTermById(termId)?.label, "Formazione modificata in WordPress");
  const localTerms = Object.fromEntries(Object.entries(localEvent.terms).map(([key, terms]) => [key, terms.map((term) => term.alias)]));
  const localEdit = sourceStore.content.saveRecord({
    id: localEvent.id,
    typeKey: localEvent.typeKey,
    title: "Titolo aggiornato da CMS A",
    slug: localEvent.slug,
    locale: localEvent.locale,
    status: localEvent.status,
    publishedAt: localEvent.publishedAt,
    excerpt: localEvent.excerpt,
    order: localEvent.order,
    values: { ...localEvent.values, speaker: speakerId },
    terms: localTerms,
    expectedHead: localEvent.headRevision,
  });
  assert.equal(localEdit.status, "saved");
  sourceStore.close();
  sourceStore = undefined;
  const pushFromCmsA = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, localCatalog, secretStoreFor);
  assert.ok(pushFromCmsA.counts.update > 0);
  assert.equal(pushFromCmsA.counts.conflict, 0);
  await pushAndRelease(connection.id, localCatalog, pushFromCmsA);
  assertWordPressDraftTitle("Titolo aggiornato da CMS A");
  const repeatedCmsAPush = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, localCatalog, secretStoreFor);
  assert.equal(repeatedCmsAPush.counts.update, 0);
  assert.equal(repeatedCmsAPush.counts.conflict, 0);
  const publishRenderFixture = 'require "/var/www/html/wp-load.php"; $ids=["' + eventId + '","' + secondEventId + '"]; foreach ($ids as $id) { $post=get_posts(["post_type"=>"events","post_status"=>["draft","publish"],"posts_per_page"=>20,"meta_key"=>"_xb_page_profile_id","meta_value"=>$id])[0]??null; if (!$post) { fwrite(STDERR,"Synthetic event missing before rendering."); exit(10); } $updated=wp_update_post(["ID"=>$post->ID,"post_status"=>"publish"],true); if (is_wp_error($updated)) { fwrite(STDERR,$updated->get_error_message()); exit(11); } } foreach (["content/event-single","content/event-archive"] as $ref) { $templates=get_posts(["post_type"=>"wp_template","post_status"=>["draft","publish"],"posts_per_page"=>20,"meta_key"=>"_xb_page_profile_ref","meta_value"=>$ref]); if (1!==count($templates)) { fwrite(STDERR,"Expected one synthetic template."); exit(12); } $updated=wp_update_post(["ID"=>$templates[0]->ID,"post_status"=>"publish"],true); if (is_wp_error($updated)) { fwrite(STDERR,$updated->get_error_message()); exit(13); } } flush_rewrite_rules(false);';
  execFileSync("docker", ["exec", container, "php", "-r", publishRenderFixture], { stdio: "pipe" });
  const archiveResponse = await fetch(new URL("/events/", target.origin));
  assert.equal(archiveResponse.status, 200, "the isolated WordPress archive route must render successfully");
  const archiveHtml = await archiveResponse.text();
  assert.ok(archiveHtml.includes("<h1>Eventi</h1>"), "the WordPress archive template must receive the archive page context");
  assert.ok(archiveHtml.includes("<h2>Titolo aggiornato da CMS A</h2>"), "the WordPress query loop must render the first published event");
  assert.ok(!archiveHtml.includes("<h2>Zeta evento di prova</h2>"), "the WordPress query loop must apply its dynamic count argument");
  const singleResponse = await fetch(new URL("/events/incontro-portabile/", target.origin));
  assert.equal(singleResponse.status, 200, "the isolated WordPress single route must render successfully");
  const singleHtml = await singleResponse.text();
  assert.ok(singleHtml.includes("<h1>Titolo aggiornato da CMS A</h1>"), "the WordPress single template must receive the current record as props.page");
  assert.ok(singleHtml.includes("<time>2026-11-15T09:30:00+01:00</time>"), "public Histeon fields must be available in props.page.meta");
  assert.ok(!singleHtml.includes("Non esportare nel frontend"), "private Histeon fields must not reach the public WordPress HTML");
  assert.match(archiveHtml, /main\{box-sizing:border-box;max-width:768px;margin:0 auto;padding:24px;color:#123456\}/u, "WordPress archive must include the project's Histeon CSS");
  assert.match(singleHtml, /main\{box-sizing:border-box;max-width:768px;margin:0 auto;padding:24px;color:#123456\}/u, "WordPress single must include the project's Histeon CSS");
  const missingResponse = await fetch(new URL("/events/slug-che-non-esiste/", target.origin));
  assert.equal(missingResponse.status, 404, "an unknown Histeon record route must return an actual HTTP 404");
  assert.ok((await missingResponse.text()).includes("Pagina non trovata"), "an unknown Histeon record route must render the not-found template");

  // Build the same final CMS A catalog and compare its generated static routes
  // with the live WordPress frontend assertions above. The disposable CMS data
  // directory is shared with the test server; no user project is opened.
  cmsBuildServer = await startLocalServer({ dataDirectory: path.join(projectRoot, "cms-a"), openBrowser: false });
  const cmsBase = `http://127.0.0.1:${cmsBuildServer.port}`;
  const cmsHeaders = { "X-Histos-Token": cmsBuildServer.token, "Content-Type": "application/json", Origin: cmsBase };
  const staticBuildResponse = await fetch(`${cmsBase}/api/cms/v1/projects/${projectId}/build`, { method: "POST", headers: cmsHeaders, body: "{}" });
  const staticBuild = await staticBuildResponse.json();
  assert.equal(staticBuildResponse.status, 200, JSON.stringify(staticBuild));
  assert.equal(staticBuild.status, "ready", JSON.stringify(staticBuild.findings));
  assert.ok(staticBuild.previewUrl);
  const staticBase = new URL("./", staticBuild.previewUrl);
  const staticArchiveResponse = await fetch(new URL("events/index.html", staticBase));
  assert.equal(staticArchiveResponse.status, 200);
  const staticArchiveHtml = await staticArchiveResponse.text();
  assert.ok(staticArchiveHtml.includes("<h1>Eventi</h1>"), "the static archive must receive the same archive page context as WordPress");
  assert.ok(staticArchiveHtml.includes("<h2>Titolo aggiornato da CMS A</h2>"), "the static archive must render the same first published event as WordPress");
  assert.ok(!staticArchiveHtml.includes("<h2>Zeta evento di prova</h2>"), "the static archive must apply the same dynamic query count as WordPress");
  const staticSingleResponse = await fetch(new URL("events/incontro-portabile/index.html", staticBase));
  assert.equal(staticSingleResponse.status, 200);
  const staticSingleHtml = await staticSingleResponse.text();
  assert.ok(staticSingleHtml.includes("<h1>Titolo aggiornato da CMS A</h1>"), "the static single route must receive the same record page context as WordPress");
  assert.ok(staticSingleHtml.includes("<time>2026-11-15T09:30:00+01:00</time>"), "the static single route must render the same public date field as WordPress");
  assert.ok(!staticSingleHtml.includes("Non esportare nel frontend"), "private Histeon fields must also stay out of the static HTML");
  assert.match(staticArchiveHtml, /main\{box-sizing:border-box;max-width:768px;margin:0 auto;padding:24px;color:#123456\}/u, "the static archive must contain the project's Histeon CSS");
  assert.match(staticSingleHtml, /main\{box-sizing:border-box;max-width:768px;margin:0 auto;padding:24px;color:#123456\}/u, "the static single must contain the project's Histeon CSS");
  const staticMissingResponse = await fetch(new URL("events/slug-che-non-esiste/index.html", staticBase));
  assert.equal(staticMissingResponse.status, 404, "the static preview must not invent an output route for a missing record");
  await captureLocalVisualComparison({
    wordpressUrl: target.origin,
    staticUrl: staticBase.href,
  });
  const finalLocal = await localCatalog.openProject(projectId);
  assert.ok(finalLocal);
  await assertTemplateRoundTrip(finalLocal.store, projectId);
  assert.equal(finalLocal.store.content.getRecordById(eventId, true)?.status, "published");
  const finalSpeakerEn = finalLocal.store.content.getRecordById(speakerId, true);
  const finalSpeakerIt = finalLocal.store.content.getRecordById(localizedSpeakerId, true);
  assert.ok(finalSpeakerEn);
  assert.ok(finalSpeakerIt);
  assert.equal(finalSpeakerEn.slug, "la-biblioteca");
  assert.equal(finalSpeakerIt.slug, "la-biblioteca");
  assert.equal(finalSpeakerEn.locale, "en-US");
  assert.equal(finalSpeakerIt.locale, "it-IT");
  assert.equal(finalSpeakerEn.status, "published");
  assert.equal(finalSpeakerIt.status, "published");
  assert.equal(finalSpeakerEn.values.portrait, portraitEn.id);
  assert.equal(finalSpeakerIt.values.portrait, portraitIt.id);
  const finalPortraitEn = finalLocal.store.listAssets().find((asset) => asset.id === portraitEn.id);
  const finalPortraitIt = finalLocal.store.listAssets().find((asset) => asset.id === portraitIt.id);
  assert.ok(finalPortraitEn);
  assert.ok(finalPortraitIt);
  assert.equal(finalPortraitEn.sha256, finalPortraitIt.sha256);
  assert.equal(finalPortraitEn.alt, "Ada at the conference");
  assert.equal(finalPortraitEn.caption, "English speaker portrait");
  assert.equal(finalPortraitIt.alt, "Ada alla conferenza");
  assert.equal(finalPortraitIt.caption, "Relatrice italiana");
  const finalPngEn = await finalLocal.store.readAsset(portraitEn.id);
  const finalPngIt = await finalLocal.store.readAsset(portraitIt.id);
  assert.ok(finalPngEn);
  assert.ok(finalPngIt);
  assert.deepEqual([...finalPngEn.bytes], [...sharedPng]);
  assert.deepEqual([...finalPngIt.bytes], [...sharedPng]);
  finalLocal.store.close();

  if (secondPairing) {
    const independentCatalog = new CmsProjectCatalog(path.join(projectRoot, "cms-d"));
    const independentConnection = await connectRemoteSite(secondPairing.code, remotes, secretStoreFor);
    assert.notEqual(independentConnection.siteId, connection.siteId, "separate WordPress installs must have distinct Histeon site identities");
    if (independentConnection.projectId !== null) {
      throw new Error("Il secondo WordPress usa-e-getta è già collegato a un progetto Histeon. Usa uno stack e un database nuovi.");
    }
    const transferCmsCToWordPressB = await createRemoteSyncPlan({ action: "push", connectionId: independentConnection.id, projectId }, remotes, returnedCatalog, secretStoreFor);
    if (!transferCmsCToWordPressB.initializingRemote) {
      throw new Error("Il secondo WordPress contiene già dati Histeon e non consente l’inizializzazione.");
    }
    await pushAndRelease(independentConnection.id, returnedCatalog, transferCmsCToWordPressB, secondContainer);
    assertWordPressDraftTitle("Titolo aggiornato da CMS C", secondContainer);

    const transferWordPressBToCmsD = await createRemoteSyncPlan({ action: "pull", connectionId: independentConnection.id }, remotes, independentCatalog, secretStoreFor);
    assert.ok(transferWordPressBToCmsD.counts.new > 0, "the independent WordPress install must be importable into a fourth CMS catalog");
    await applyPlan(independentConnection.id, "pull", independentCatalog, transferWordPressBToCmsD);
    const independent = await independentCatalog.openProject(projectId);
    assert.ok(independent);
    independentStore = independent.store;
    assert.equal(independentStore.content.getRecordById(eventId, true)?.title, "Titolo aggiornato da CMS C");
    const independentEvent = independentStore.content.getRecordById(eventId, true);
    assert.ok(independentEvent);
    const changedAgain = independentStore.content.saveRecord({
      id: independentEvent.id,
      typeKey: independentEvent.typeKey,
      title: "Titolo aggiornato da CMS D",
      slug: independentEvent.slug,
      locale: independentEvent.locale,
      status: independentEvent.status,
      publishedAt: independentEvent.publishedAt,
      excerpt: independentEvent.excerpt,
      order: independentEvent.order,
      values: { ...independentEvent.values, speaker: speakerId },
      terms: Object.fromEntries(Object.entries(independentEvent.terms).map(([key, terms]) => [key, terms.map((term) => term.alias)])),
      expectedHead: independentEvent.headRevision,
    });
    assert.equal(changedAgain.status, "saved");
    independentStore.close();
    independentStore = undefined;

    const transferCmsDToWordPressB = await createRemoteSyncPlan({ action: "push", connectionId: independentConnection.id, projectId }, remotes, independentCatalog, secretStoreFor);
    assert.ok(transferCmsDToWordPressB.counts.update > 0);
    await pushAndRelease(independentConnection.id, independentCatalog, transferCmsDToWordPressB, secondContainer);
    assertWordPressDraftTitle("Titolo aggiornato da CMS D", secondContainer);
    const repeatIndependentPush = await createRemoteSyncPlan({ action: "push", connectionId: independentConnection.id, projectId }, remotes, independentCatalog, secretStoreFor);
    assert.equal(repeatIndependentPush.counts.update, 0);
    assert.equal(repeatIndependentPush.counts.conflict, 0);

    const conflictProject = await independentCatalog.openProject(projectId);
    assert.ok(conflictProject);
    const conflictBaseEvent = conflictProject.store.content.getRecordById(eventId, true);
    assert.ok(conflictBaseEvent);
    const localConflictEdit = conflictProject.store.content.saveRecord({
      id: conflictBaseEvent.id,
      typeKey: conflictBaseEvent.typeKey,
      title: "Modifica concorrente CMS D",
      slug: conflictBaseEvent.slug,
      locale: conflictBaseEvent.locale,
      status: conflictBaseEvent.status,
      publishedAt: conflictBaseEvent.publishedAt,
      excerpt: conflictBaseEvent.excerpt,
      order: conflictBaseEvent.order,
      values: { ...conflictBaseEvent.values, speaker: speakerId },
      terms: Object.fromEntries(Object.entries(conflictBaseEvent.terms).map(([key, terms]) => [key, terms.map((term) => term.alias)])),
      expectedHead: conflictBaseEvent.headRevision,
    });
    assert.equal(localConflictEdit.status, "saved");
    conflictProject.store.close();

    editWordPressDraftTitle("Modifica concorrente WordPress B", secondContainer);
    const concurrentPush = await createRemoteSyncPlan({ action: "push", connectionId: independentConnection.id, projectId }, remotes, independentCatalog, secretStoreFor);
    assert.equal(concurrentPush.counts.conflict, 1, "two edits after the shared CMS/WordPress base must block the push");
    assert.equal(concurrentPush.applyAllowed, false);
    assert.equal(concurrentPush.planId, null, "a conflicted push must not create an applicable operation");
    assert.deepEqual(concurrentPush.entities.find((entity) => entity.id === eventId)?.comparison?.find((field) => field.field === "title"), {
      field: "title",
      local: "Modifica concorrente CMS D",
      remote: "Modifica concorrente WordPress B",
    });
    assertWordPressDraftTitle("Modifica concorrente WordPress B", secondContainer);
    const preservedConflictProject = await independentCatalog.openProject(projectId);
    assert.ok(preservedConflictProject);
    assert.equal(preservedConflictProject.store.content.getRecordById(eventId, true)?.title, "Modifica concorrente CMS D");
    preservedConflictProject.store.close();

    const deletionConflictProject = await independentCatalog.openProject(projectId);
    assert.ok(deletionConflictProject);
    const deletionBaseEvent = deletionConflictProject.store.content.getRecordById(secondEventId, true);
    assert.ok(deletionBaseEvent);
    const localDeleteConflictEdit = deletionConflictProject.store.content.saveRecord({
      id: deletionBaseEvent.id,
      typeKey: deletionBaseEvent.typeKey,
      title: "Modifica locale prima della cancellazione remota",
      slug: deletionBaseEvent.slug,
      locale: deletionBaseEvent.locale,
      status: deletionBaseEvent.status,
      publishedAt: deletionBaseEvent.publishedAt,
      excerpt: deletionBaseEvent.excerpt,
      order: deletionBaseEvent.order,
      values: { ...deletionBaseEvent.values, speaker: speakerId },
      terms: Object.fromEntries(Object.entries(deletionBaseEvent.terms).map(([key, terms]) => [key, terms.map((term) => term.alias)])),
      expectedHead: deletionBaseEvent.headRevision,
    });
    assert.equal(localDeleteConflictEdit.status, "saved");
    deletionConflictProject.store.close();

    trashWordPressDraftRecord(secondEventId, secondContainer);
    const deletionPlan = await createRemoteSyncPlan({ action: "pull", connectionId: independentConnection.id }, remotes, independentCatalog, secretStoreFor);
    assert.equal(deletionPlan.counts.conflict, 2, "the existing concurrent edit and new tombstone must both remain conflicts");
    assert.equal(deletionPlan.applyAllowed, false);
    assert.equal(deletionPlan.planId, null, "a tombstone conflict must not create an applicable operation");
    const deletionConflict = deletionPlan.entities.find((entity) => entity.id === secondEventId);
    assert.ok(deletionConflict);
    assert.equal(deletionConflict.kind, "tombstone");
    assert.equal(deletionConflict.status, "conflict");
    assert.equal(deletionConflict.canResolve, false);
    assert.equal(deletionConflict.blockedReason, "tombstone-conflict");
    assert.equal(deletionPlan.entities.find((entity) => entity.id === eventId)?.status, "conflict", "the earlier concurrent edits must also remain visible in the refreshed plan");
    const preservedDeletionConflict = await independentCatalog.openProject(projectId);
    assert.ok(preservedDeletionConflict);
    assert.equal(preservedDeletionConflict.store.content.getRecordById(secondEventId, true)?.title, "Modifica locale prima della cancellazione remota");
    preservedDeletionConflict.store.close();

    changeWordPressRecordTypeToPage(eventId, secondContainer);
    const typeChangePlan = await createRemoteSyncPlan({ action: "pull", connectionId: independentConnection.id }, remotes, independentCatalog, secretStoreFor);
    assert.equal(typeChangePlan.applyAllowed, false, "a WordPress content-record to page type change must not be applied automatically");
    assert.equal(typeChangePlan.planId, null);
    const typeChangeConflict = typeChangePlan.entities.find((entity) => entity.id === eventId);
    assert.ok(typeChangeConflict);
    assert.equal(typeChangeConflict.kind, "document");
    assert.equal(typeChangeConflict.status, "conflict");
    assert.equal(typeChangeConflict.canResolve, false);
    assert.equal(typeChangeConflict.blockedReason, "type-changed");
    const preservedTypeConflict = await independentCatalog.openProject(projectId);
    assert.ok(preservedTypeConflict);
    assert.equal(preservedTypeConflict.store.content.getRecordById(eventId, true)?.typeKey, "events");
    assert.equal(preservedTypeConflict.store.content.getRecordById(eventId, true)?.title, "Modifica concorrente CMS D");
    preservedTypeConflict.store.close();
  }

  assert.equal(await revokeRemotePairing(connection, secretStoreFor), "revoked", "the signed desktop disconnect must revoke the pairing on WordPress");
  await assert.rejects(
    () => createRemoteSyncPlan({ action: "pull", connectionId: connection.id }, remotes, returnedCatalog, secretStoreFor),
    (error) => error?.code === "cms-remote-rejected" && error?.exitCode === 401,
    "a revoked pairing must no longer authorize profile reads",
  );

  process.stdout.write(JSON.stringify({
    cmsAToWordPress: "sent to development, then released",
    repeatedPush: "idempotent",
    wordpressRecordAndTermEdit: "pulled into CMS C",
    cmsCToWordPress: "sent to development, then released",
    wordpressBackToCmsA: "passed",
    localPublicationState: "preserved",
    privateFieldsAndRelations: "preserved",
    localizedSameSlugAndSharedMedia: "passed with per-language metadata",
    contentTypeTemplateAssignments: "preserved through CMS A -> WordPress -> CMS C -> WordPress -> CMS A",
    assignedPageTemplateRendering: "preserved and rendered after both CMS returns",
    wordpressSingleAndArchiveRendering: "passed with props.page, dynamic query args, and private-field exclusion",
    staticAndWordPressContentRendering: "passed for detail, archive, dynamic count, and private-field exclusion",
    independentWordPressInstallRoundTrip: secondPairing ? "CMS C -> independent WordPress B -> CMS D -> WordPress B; update and repeat are idempotent" : "not configured (single-site local mode)",
    concurrentCmsAndWordPressEdit: secondPairing ? "blocked as a conflict; both revisions preserved" : "not configured (single-site local mode)",
    remoteDeletionAfterLocalEdit: secondPairing ? "blocked as tombstone conflict; local content preserved" : "not configured (single-site local mode)",
    remoteTypeChange: secondPairing ? "blocked as type-changed conflict; local content preserved" : "not configured (single-site local mode)",
    remotePairingRevocation: "signed disconnect revoked the WordPress pairing; subsequent reads were rejected",
  }) + "\n");
} finally {
  if (cmsBuildServer) await cmsBuildServer.close();
  sourceStore?.close();
  returnedStore?.close();
  independentStore?.close();
  remotes.close();
  secrets.clear();
  await rm(projectRoot, { recursive: true, force: true });
}
