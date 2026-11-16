import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Usage:
//   node packages/cms/update-vendor-snapshot.mjs
//     recomputes the hashes of the local files (UPSTREAM.md and any overlay) and keeps the upstream ones as they are;
//   node packages/cms/update-vendor-snapshot.mjs --from /path/to/builder --commit <rev>
//     replaces the upstream files with the selection below read from <rev> of the builder repository (git objects only:
//     the builder's working tree is neither read nor changed), pins the commit and rewrites every hash. UPSTREAM.md is
//     not rewritten: update its pinned commit by hand, the check refuses a snapshot whose notes name another commit.
const cmsDirectory = path.dirname(fileURLToPath(import.meta.url));
const vendorDirectory = path.join(cmsDirectory, "vendor/histos");
const snapshotPath = path.join(vendorDirectory, "SNAPSHOT.json");
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
/**
 * What Publish vendors from the builder: the editor, the DSL, the block schema and its specification, and the script
 * of the behaviours (tabs, toggles, reveal, videos, maps) its sites run as WordPress's do (doc 23 item 120).
 */
const upstreamDirectories = ["editor/", "packages/dsl/", "packages/spec/"];
const upstreamFiles = ["LICENSE", "docs/spec/blocks.md", "tsconfig.base.json", "plugin/assets/front/behaviors.js", "plugin/assets/front/behaviors.css"];
/** Files that belong to Publish, never to the builder. Overlays that upstream now ships become upstream files. */
const localCandidates = [
  "UPSTREAM.md",
  "packages/spec/package.json",
  "packages/spec/schemas/site-transfer-v2.schema.json",
  "packages/spec/schemas/site-entity-v2.schema.json",
  "packages/spec/schemas/site-reference-v2.schema.json",
  "packages/spec/schemas/histos-static-page-v1.schema.json",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} vuole un valore.`);
  return value;
}

const source = option("--from");
const revision = option("--commit");
if (Boolean(source) !== Boolean(revision)) throw new Error("--from e --commit vanno indicati insieme.");

if (source && revision) {
  const git = (args, options = {}) => execFileSync("git", ["-C", path.resolve(source), ...args], { maxBuffer: 64 * 1024 * 1024, ...options });
  const commit = git(["rev-parse", "--verify", `${revision}^{commit}`], { encoding: "utf8" }).trim();
  const tree = git(["ls-tree", "-r", "-z", "--full-tree", commit], { encoding: "utf8" }).split("\0").filter(Boolean);
  const selected = [];
  for (const line of tree) {
    const [meta, file] = line.split("\t");
    const [mode, type] = meta.split(" ");
    if (!(upstreamFiles.includes(file) || upstreamDirectories.some((directory) => file.startsWith(directory)))) continue;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) throw new Error(`Voce upstream non supportata: ${file} (${mode} ${type}).`);
    selected.push(file);
  }
  selected.sort();
  for (const file of Object.keys(snapshot.files)) await rm(path.join(vendorDirectory, file), { force: true });
  const files = {};
  for (const file of selected) {
    const bytes = git(["cat-file", "blob", `${commit}:${file}`]);
    const target = path.join(vendorDirectory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    files[file] = { bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  snapshot.commit = commit;
  snapshot.files = files;
  process.stdout.write(`Snapshot upstream ${commit}: ${selected.length} file.\n`);
}

const localPaths = localCandidates.filter((file) => !Object.hasOwn(snapshot.files, file));
snapshot.localFiles = {};
for (const file of localPaths) {
  const bytes = await readFile(path.join(vendorDirectory, file));
  snapshot.localFiles[file] = { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
process.stdout.write(`Aggiornati ${Object.keys(snapshot.localFiles).length} hash locali; ${Object.keys(snapshot.files).length} hash upstream${source ? " riscritti" : " conservati invariati"}.\n`);
