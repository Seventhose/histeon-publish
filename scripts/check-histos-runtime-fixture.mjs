#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publishRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The Histeon WordPress (builder) checkout: an argument or HISTOS_BUILDER_ROOT; there is no default location.
const builderArgument = process.argv[2] ?? process.env.HISTOS_BUILDER_ROOT;
if (!builderArgument) {
  process.stderr.write("Uso: node scripts/check-histos-runtime-fixture.mjs /percorso/del/builder (oppure HISTOS_BUILDER_ROOT).\n");
  process.exit(2);
}
const cloneRoot = path.resolve(builderArgument);
// Shared byte for byte with plugin/tests/fixtures/ of the builder.
const fixtures = [
  "histos-runtime-m2-v1.json",
  "histos-runtime-modifiers-m2-v1.json",
  "histos-runtime-dates-m2-v1.json",
  "histos-runtime-static-m2-v1.json",
  "histos-transfer-markup-v1.json",
  "histos-agent-docs-v1.json",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

for (const name of fixtures) {
  const canonical = path.join(publishRoot, "packages", "histos-contract", "fixtures", name);
  const wordpress = path.join(cloneRoot, "plugin", "tests", "fixtures", name);
  const wordpressBytes = await readFile(wordpress).catch(() => null);
  if (!wordpressBytes) {
    process.stderr.write(`Manca la copia WordPress della fixture ${name}: ${wordpress}\n`);
    process.exitCode = 1;
    continue;
  }
  const canonicalBytes = await readFile(canonical);
  if (sha256(canonicalBytes) !== sha256(wordpressBytes)) {
    process.stderr.write(`La fixture ${name} differisce tra Publish e il clone Histeon WordPress.\nPublish: ${canonical}\nWordPress: ${wordpress}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Fixture ${name} identica: ${sha256(canonicalBytes)}\n`);
  }
}
