import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CmsProjectCatalog, readArticle } from "../packages/cms/dist/index.js";
import { importWordPressExport } from "../packages/server/dist/cms-api.js";
import { TEST_CONTAINER } from "./wordpress-test-pairing.mjs";

/**
 * Doc 22 §R6, the whole way: a WordPress with content written the normal way, in the block editor and in the classic
 * one, with categories, tags and a featured image, gives its own export file, and that file becomes a project in Publish.
 * Nothing here uses Histeon on the WordPress side.
 */

const container = process.env.HISTOS_TEST_WP_CONTAINER;
if (!container || !TEST_CONTAINER.test(container)) throw new TypeError("Serve uno stack Docker usa-e-getta histos-cms-* (HISTOS_TEST_WP_CONTAINER).");
const php = (body) => execFileSync("docker", ["exec", container, "php", "-r", String.raw`require "/var/www/html/wp-load.php"; wp_set_current_user(get_user_by("login","admin")->ID); ` + body], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

php(String.raw`
require_once ABSPATH . "wp-admin/includes/taxonomy.php"; require_once ABSPATH . "wp-admin/includes/image.php"; require_once ABSPATH . "wp-admin/includes/post.php";
$cat = wp_create_category("Notizie"); $sub = wp_create_category("Locali", $cat);
$image = wp_upload_bits("foto.png", null, base64_decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="));
$thumb = wp_insert_attachment(array("post_title" => "Foto di copertina", "post_mime_type" => "image/png", "post_status" => "inherit", "guid" => $image["url"]), $image["file"]);
$block = wp_insert_post(wp_slash(array("post_type" => "post", "post_status" => "publish", "post_title" => "Articolo a blocchi", "post_name" => "articolo-a-blocchi", "post_date_gmt" => "2024-05-06 07:08:09", "post_excerpt" => "Riassunto", "post_category" => array($sub), "tags_input" => array("libri"), "post_content" => "<!-- wp:paragraph --><p>Ciao <strong>mondo</strong> e <a href=\"https://esempio.it/\">link</a></p><!-- /wp:paragraph --><!-- wp:heading --><h2>Titolo</h2><!-- /wp:heading --><!-- wp:list --><ul><li>Uno</li><li>Due</li></ul><!-- /wp:list --><!-- wp:image --><figure class=\"wp-block-image\"><img src=\"" . $image["url"] . "\" alt=\"Dentro\"/><figcaption>Didascalia</figcaption></figure><!-- /wp:image --><!-- wp:html --><iframe src=\"https://video.it/x\"></iframe><!-- /wp:html -->")));
set_post_thumbnail($block, $thumb);
wp_insert_post(wp_slash(array("post_type" => "post", "post_status" => "draft", "post_title" => "Bozza classica", "post_content" => "Prima riga\n\nSeconda riga con [gallery ids=\"1\"]")));
wp_insert_post(wp_slash(array("post_type" => "page", "post_status" => "publish", "post_title" => "Chi siamo", "post_name" => "chi-siamo", "post_content" => "<p>Siamo noi.</p>")));
wp_insert_post(wp_slash(array("post_type" => "wp_block", "post_status" => "publish", "post_title" => "Blocco riusabile", "post_content" => "<p>x</p>")));
`);
const text = php(String.raw`require_once ABSPATH . "wp-admin/includes/export.php"; export_wp(array("content" => "all"));`).replace(/^[\s\S]*?(<\?xml)/u, "$1");

const root = await mkdtemp(path.join(os.tmpdir(), "histos-wxr-"));
try {
  const catalog = new CmsProjectCatalog(path.join(root, "publish"));
  await catalog.initialize();
  // The file's images are on this local WordPress, which the real downloader refuses as it should.
  const fetchAsset = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  const https = text.replaceAll("http://localhost", "https://localhost");
  const report = await importWordPressExport({ catalog, text: https, fetchAsset: (url) => fetchAsset(url.replace("https://", "http://")) });
  // WordPress starts with «Hello world!» and two pages of its own: they count, as on any site.
  assert.deepEqual({ pages: report.pages, posts: report.posts, failed: report.failed }, { pages: 3, posts: 3, failed: [] });
  assert.equal(report.images.saved, 1, "la stessa immagine, nel testo e in evidenza, entra una volta");
  assert.equal(report.images.failed, 0);
  assert.equal(report.lost.iframe, 1, "il video incorporato resta fuori e si dice");
  assert.equal(report.lost.shortcode, 1);
  assert.equal(report.skipped.wp_block, 1);
  const opened = await catalog.openProject(report.projectId);
  try {
    const posts = opened.store.listPosts();
    const block = posts.find((post) => post.slug === "articolo-a-blocchi");
    assert.equal(block.status, "published");
    assert.equal(block.publishedAt?.slice(0, 19), "2024-05-06T07:08:09");
    assert.equal(block.excerpt, "Riassunto");
    const blocks = readArticle(opened.store.getRevision(block.headRevision).content).blocks;
    assert.deepEqual(blocks.map((entry) => entry.type), ["paragraph", "heading", "list", "image"], "testo e immagine, che era già nel testo");
    assert.equal(blocks[0].html, "Ciao <strong>mondo</strong> e <a href=\"https://esempio.it/\">link</a>");
    assert.ok(blocks[3].src.startsWith(`/__cms-media/${report.projectId}/`), "l'immagine è del progetto");
    assert.equal(blocks[3].caption, "Didascalia");
    assert.equal(posts.find((post) => post.title === "Bozza classica").status, "draft");
    const terms = opened.store.getPostTermIds(block.id);
    assert.equal(terms.category.length, 1);
    assert.equal(terms.post_tag.length, 1);
    const subcategory = opened.store.content.listTerms("category").find((term) => term.slug === "locali");
    assert.ok(subcategory?.parentId, "la sottocategoria tiene il suo genitore");
    assert.ok(opened.store.listPages().some((page) => page.slug === "chi-siamo"));
  } finally {
    opened.store.close();
  }
  process.stdout.write(`Esportazione WordPress: ${report.pages} pagine, ${report.posts} articoli, ${report.terms} termini, ${report.images.saved} immagini.\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
