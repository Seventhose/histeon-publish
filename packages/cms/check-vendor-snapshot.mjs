import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cmsDirectory = path.dirname(fileURLToPath(import.meta.url));
const vendorDirectory = path.join(cmsDirectory, "vendor/histos");
const snapshotPath = path.join(vendorDirectory, "SNAPSHOT.json");

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolutePath, relativePath));
    else if (entry.isFile() && relativePath !== "SNAPSHOT.json") files.push(relativePath);
    else if (!entry.isFile() && !entry.isDirectory()) throw new Error(`Tipo di file non supportato nella snapshot: ${relativePath}`);
  }

  return files;
}

export async function assertVendorSnapshot() {
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  if (snapshot.schemaVersion !== 1 || !snapshot.commit || !snapshot.files || typeof snapshot.files !== "object" || (snapshot.localFiles !== undefined && (!snapshot.localFiles || typeof snapshot.localFiles !== "object" || Array.isArray(snapshot.localFiles)))) {
    throw new Error("Manifest della snapshot Histeon non valido.");
  }

  const upstreamNotes = await readFile(path.join(vendorDirectory, "UPSTREAM.md"), "utf8");
  if (!upstreamNotes.includes(snapshot.commit)) {
    throw new Error(`Il commit in UPSTREAM.md non coincide con SNAPSHOT.json (${snapshot.commit}).`);
  }

  const localFiles = snapshot.localFiles ?? {};
  const localPaths = Object.keys(localFiles);
  const collisions = localPaths.filter((file) => Object.hasOwn(snapshot.files, file));
  if (collisions.length) throw new Error(`La snapshot dichiara gli stessi file come upstream e overlay locale: ${collisions.join(", ")}`);
  const expectedPaths = [...Object.keys(snapshot.files), ...localPaths].sort();
  const actualPaths = (await listFiles(vendorDirectory)).sort();
  const expectedSet = new Set(expectedPaths);
  const actualSet = new Set(actualPaths);
  const missing = expectedPaths.filter((file) => !actualSet.has(file));
  const extra = actualPaths.filter((file) => !expectedSet.has(file));
  const changed = [];

  for (const relativePath of expectedPaths) {
    if (!actualSet.has(relativePath)) continue;
    const data = await readFile(path.join(vendorDirectory, relativePath));
    const expected = snapshot.files[relativePath] ?? localFiles[relativePath];
    if (!expected || !Number.isSafeInteger(expected.bytes) || typeof expected.sha256 !== "string") throw new Error(`Voce snapshot non valida per ${relativePath}.`);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (data.byteLength !== expected.bytes || sha256 !== expected.sha256) changed.push(relativePath);
  }

  if (missing.length || extra.length || changed.length) {
    const details = [
      missing.length ? `mancanti: ${missing.join(", ")}` : "",
      extra.length ? `file non registrati: ${extra.join(", ")}` : "",
      changed.length ? `contenuto modificato: ${changed.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    throw new Error(`Snapshot Histeon alterata (${details}). Aggiornare la snapshot solo insieme a una nuova verifica della provenienza.`);
  }

  return { commit: snapshot.commit, files: actualPaths.length, upstreamFiles: Object.keys(snapshot.files).length, localFiles: localPaths.length };
}

// Run as a program, also through a symlink: node loads the module from its real path, argv keeps the one typed.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const result = await assertVendorSnapshot();
    const overlay = result.localFiles ? `, ${result.localFiles} overlay di contratto locali` : "";
    console.log(`Snapshot Histeon integra: ${result.upstreamFiles} file upstream${overlay}, commit ${result.commit}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
