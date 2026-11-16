import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CmsProjectCatalog, readArticle } from "../packages/cms/dist/index.js";
import { importWordPressContent } from "../packages/server/dist/cms-api.js";
import { fetchPrototypeAsset } from "../packages/server/dist/prototype-assets.js";
import { readWordPressSite } from "../packages/server/dist/wordpress-site-read.js";

/**
 * The import from an address (doc 23, voce 51) against a real site over https, through the real client: no simulated
 * answer. Only public reads. node scripts/test-wordpress-read-real.mjs [address] [max images, default 25]
 */

const address = process.argv[2] ?? "https://wordpress.org/news";
const maxImages = Number(process.argv[3] ?? 25);
const root = await mkdtemp(path.join(os.tmpdir(), "histos-read-real-"));
try {
  const started = Date.now();
  const file = await readWordPressSite({ url: address });
  const seconds = (from) => ((Date.now() - from) / 1000).toFixed(1);
  const count = (type) => file.items.filter((item) => item.type === type).length;
  process.stdout.write(`Letto ${address} in ${seconds(started)} s: ${count("post")} articoli, ${count("page")} pagine, ${count("attachment")} immagini in evidenza, ${file.terms.length} termini.\n`);
  assert.ok(count("post") + count("page") > 0, "il sito ha contenuti");

  const catalog = new CmsProjectCatalog(path.join(root, "publish"));
  await catalog.initialize();
  let fetched = 0;
  const imported = Date.now();
  // Real images up to the limit: the rest counts as missing, which the import must report and survive.
  const fetchAsset = (url, signal) => {
    fetched += 1;
    if (fetched > maxImages) throw new Error("oltre il limite della prova");
    return fetchPrototypeAsset(url, signal);
  };
  const result = await importWordPressContent({ catalog, file, fetchAsset });
  process.stdout.write(`Importato in ${seconds(imported)} s: ${JSON.stringify(result).slice(0, 700)}\n`);
  const opened = await catalog.openProject(result.projectId);
  const posts = opened.store.listPosts();
  assert.equal(posts.length, count("post"), "ogni articolo letto è nel progetto");
  const tally = { paragraph: 0, heading: 0, list: 0, quote: 0, image: 0, table: 0, separator: 0, card: 0, kept: 0 };
  const keptLabels = new Map();
  for (const post of posts) {
    for (const block of readArticle(opened.store.getRevision(post.headRevision)?.content ?? "").blocks) {
      tally[block.type] += 1;
      if (block.type === "kept") keptLabels.set(block.label, (keptLabels.get(block.label) ?? 0) + 1);
    }
  }
  process.stdout.write(`Blocchi: ${JSON.stringify(tally)}\nProtetti: ${JSON.stringify([...keptLabels].sort((a, b) => b[1] - a[1]).slice(0, 12))}\n`);
  opened.store.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
