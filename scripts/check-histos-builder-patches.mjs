import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const editor = path.join(root, "packages/cms/vendor/histos/editor");
const generated = path.join(root, "packages/cms/.generated/histos-editor");
const patches = [
  "packages/cms/patches/histos/local-cms.patch",
  "packages/cms/patches/histos/framework-config.patch",
];
const temporary = await mkdtemp(path.join(os.tmpdir(), "histos-builder-patch-check-"));
const reconstructed = path.join(temporary, "editor");

async function files(directory, prefix = "") {
  const result = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, digest] of await files(absolute, relative)) result.set(name, digest);
    } else if (entry.isFile()) {
      const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
      result.set(relative, digest);
    } else {
      throw new Error(`Tipo di file non supportato nella snapshot Histeon: ${relative}`);
    }
  }
  return result;
}

try {
  await cp(editor, reconstructed, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("node_modules"),
  });

  for (const relativePatch of patches) {
    const patch = await readFile(path.join(root, relativePatch));
    const patchPath = path.join(temporary, path.basename(relativePatch));
    await writeFile(patchPath, patch);
    // The same bytes as build-editor.mjs on every platform: no CRLF conversion outside the repository either.
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "apply", "--check", "--whitespace=nowarn", patchPath], { cwd: reconstructed });
    execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "apply", "--whitespace=nowarn", patchPath], { cwd: reconstructed });
  }

  const actual = await files(reconstructed);
  // How many files the rebuild must have (list item 113): the editor's files in the verified snapshot, plus those
  // the patches create and minus those they delete. Read from the snapshot and the patches, never written by hand.
  const snapshot = JSON.parse(await readFile(path.join(root, "packages/cms/vendor/histos/SNAPSHOT.json"), "utf8"));
  const snapshotFiles = Array.isArray(snapshot.files) ? snapshot.files.map((entry) => (typeof entry === "string" ? entry : entry.path)) : Object.keys(snapshot.files);
  let expectedCount = snapshotFiles.filter((name) => typeof name === "string" && name.startsWith("editor/")).length;
  for (const relativePatch of patches) {
    const text = await readFile(path.join(root, relativePatch), "utf8");
    expectedCount += (text.match(/^--- \/dev\/null$/gmu) ?? []).length - (text.match(/^\+\+\+ \/dev\/null$/gmu) ?? []).length;
  }
  assert.equal(actual.size, expectedCount, "Il numero di file ricostruiti deve corrispondere alla snapshot verificata e alle patch");
  let expected = null;
  try {
    expected = await files(generated);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (expected) {
    assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), "La ricostruzione deve avere gli stessi file dell'editor compilato");
    for (const [relative, digest] of actual) {
      if (digest !== expected.get(relative)) {
        const lf = async (directory) => createHash("sha256").update((await readFile(path.join(directory, relative))).toString("binary").replaceAll("\r\n", "\n")).digest("hex");
        const onlyLineEndings = (await lf(reconstructed)) === (await lf(generated));
        assert.fail(`${relative} deve essere identico all'editor compilato${onlyLineEndings ? " (differiscono solo i fine riga CRLF/LF)" : ""}`);
      }
    }
    process.stdout.write(`Patch Histeon riproducibili: ${actual.size} file identici all'editor generato.\n`);
  } else {
    process.stdout.write(`Patch Histeon applicabili e riproducibili: ${actual.size} file; editor generato assente, confronto byte rinviato alla build.\n`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
