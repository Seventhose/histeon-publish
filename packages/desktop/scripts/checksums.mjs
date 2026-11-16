import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDirectory = path.resolve(desktopDirectory, "../..");
const releaseDirectory = process.env.HISTOS_RELEASE_DIR
  ? path.resolve(rootDirectory, process.env.HISTOS_RELEASE_DIR)
  : path.join(desktopDirectory, "release");
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(absolute);
    else if (entry.isFile() && entry.name !== "SHA256SUMS.txt") files.push(absolute);
  }
}

await collect(releaseDirectory);
files.sort((left, right) => left.localeCompare(right));
if (files.length === 0) throw new Error("Il packager non ha prodotto artefatti da verificare.");
// One file at a time, streamed: the release folder keeps every past package, and reading them all at once runs out of memory.
const rows = [];
for (const absolute of files) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolute)) hash.update(chunk);
  rows.push(`${hash.digest("hex")}  ${path.relative(releaseDirectory, absolute).split(path.sep).join("/")}`);
}
await writeFile(path.join(releaseDirectory, "SHA256SUMS.txt"), `${rows.join("\n")}\n`, "utf8");
process.stdout.write(`Checksum SHA-256: ${files.length} artefatti in ${releaseDirectory}/SHA256SUMS.txt\n`);
