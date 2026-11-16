// Doc 23 item 109: the importer measured on a real site, kept outside the repository (its content is not ours to
// publish). A folder with a static copy of a site (wget --mirror, a Webflow export, Static Bridge) is converted as
// «Converti in progetto Histeon» does, without downloading anything, measured as the corpus of doc 18 is, and checked
// by the import of a fresh catalog.
//   npm run build && node scripts/measure-static-site.mjs [--pages N] <folder> [<folder> ...]
// --pages keeps the first N pages (home first) for a site whose prototype would pass the importer's size limit.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPrototypeProfile, CmsProjectCatalog, measureSelectable, parsePrototype, staticSiteToPrototype } from "@histos-publish/cms";

/** The importer's own limits apply anyway; these keep the walk from wandering. */
const MAX_FILES = 20_000;

function filesOf(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      // lstat: a link is skipped, not followed (a link to a parent folder would walk forever).
      const info = lstatSync(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) walk(full);
      else if (info.isFile() && out.length < MAX_FILES) out.push({ path: path.relative(root, full).split(path.sep).join("/"), bytes: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(root);
  return out;
}

const args = process.argv.slice(2);
const pagesAt = args.indexOf("--pages");
const pageLimit = pagesAt >= 0 ? Number(args.splice(pagesAt, 2)[1]) : Infinity;
const folders = args;
if (!folders.length) {
  console.error("Uso: node scripts/measure-static-site.mjs <cartella del sito> [...]");
  process.exit(2);
}
let failed = false;
for (const folder of folders) {
  const root = path.resolve(folder);
  const all = filesOf(root);
  const isPage = (file) => /\.html?$/u.test(file.path);
  const home = (file) => (/^index\.html?$/u.test(file.path) ? 0 : 1);
  const kept = new Set(all.filter(isPage).sort((a, b) => home(a) - home(b) || a.path.localeCompare(b.path)).slice(0, pageLimit).map((file) => file.path));
  const files = all.filter((file) => !isPage(file) || kept.has(file.path));
  const started = Date.now();
  // As the app does (doc 23 item 109): the media stay outside the prototype, kept by hash.
  const held = new Map();
  const prototype = staticSiteToPrototype({ projectId: "0f6b2c1d-4e5a-4b6c-9d7e-8f90a1b2c3d4", name: path.basename(root), files, holdMedia: (bytes, hash) => held.set(hash, bytes) });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const pages = files.filter((file) => /\.html?$/u.test(file.path) && !/(^|\/)404\.html?$/u.test(file.path)).slice(0, 1000).map((file) => new TextDecoder().decode(file.bytes));
  const measured = measureSelectable(pages, prototype.html);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "histos-misura-"));
  let imported = "sì";
  try {
    const catalog = new CmsProjectCatalog(temporary);
    await catalog.initialize();
    const built = await buildPrototypeProfile(parsePrototype(prototype.html), catalog, { convertedMedia: (hash) => held.get(hash) ?? null });
    imported = `sì, ${built.profile.entities.length} entità`;
  } catch (error) {
    imported = `no: ${error instanceof Error ? error.message : String(error)}`;
    failed = true;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(`${path.basename(root)}: ${files.length} file, ${prototype.report.pages} pagine convertite in ${seconds} s; prototipo ${(new TextEncoder().encode(prototype.html).length / 1024 / 1024).toFixed(1)} MB, media tenuti fuori ${held.size}`);
  console.log(`  selezionabili: ${measured.selectable}/${measured.original} = ${(measured.share * 100).toFixed(1)}%`);
  console.log(`  import: ${imported}; media remoti non scaricati: ${prototype.remoteMedia.length}`);
  for (const note of prototype.report.notes.slice(0, 25)) console.log(`  - ${note}`);
}
process.exit(failed ? 1 : 0);
