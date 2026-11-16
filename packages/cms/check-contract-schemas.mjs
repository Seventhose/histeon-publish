import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cmsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(cmsDirectory, "../..");
const canonicalDirectory = path.join(cmsDirectory, "vendor/histos/packages/spec/schemas");
const consumerDirectory = path.join(repositoryRoot, "packages/histos-contract/schemas");
const schemaFiles = [
  "site-transfer-v2.schema.json",
  "site-entity-v2.schema.json",
  "site-reference-v2.schema.json",
  "histos-static-page-v1.schema.json",
];

for (const file of schemaFiles) {
  const [canonical, consumer] = await Promise.all([
    readFile(path.join(canonicalDirectory, file)),
    readFile(path.join(consumerDirectory, file)),
  ]);
  if (!canonical.equals(consumer)) throw new Error(`Lo schema ${file} non coincide con la copia usata dal CMS. Aggiorna il mirror soltanto dalla fonte @xb/spec.`);
}

process.stdout.write(`Contratti JSON condivisi: ${schemaFiles.length} schemi @xb/spec coincidono con il package CMS.\n`);
