#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Automatic.css → Histeon CSS names of Publish (C1) are the builder's: `packages/cms/assets/histos-css/acss-map.json`
 * must say what `AcssImport::tokens()` and `::classes()` return in the given checkout. Needs `php` on the PATH.
 */
const publishRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The Histeon WordPress (builder) checkout: an argument or HISTOS_BUILDER_ROOT; there is no default location.
const builderArgument = process.argv[2] ?? process.env.HISTOS_BUILDER_ROOT;
if (!builderArgument) {
  process.stderr.write("Uso: node scripts/check-acss-map.mjs /percorso/del/builder (oppure HISTOS_BUILDER_ROOT).\n");
  process.exit(2);
}
const source = path.join(path.resolve(builderArgument), "plugin", "src", "Framework", "HistosCss", "AcssImport.php");
const dump = "require $argv[1]; echo json_encode(['tokens' => XB\\Framework\\HistosCss\\AcssImport::tokens(), 'classes' => XB\\Framework\\HistosCss\\AcssImport::classes()]);";
let builder;
try {
  builder = JSON.parse(execFileSync("php", ["-r", dump, source], { encoding: "utf8" }));
} catch (error) {
  process.stderr.write(`Non riesco a leggere le corrispondenze del builder da ${source}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
const publish = JSON.parse(await readFile(path.join(publishRoot, "packages", "cms", "assets", "histos-css", "acss-map.json"), "utf8"));
// Order matters too: the first token of a variable wins, as in AcssImport::variables().
for (const key of ["tokens", "classes"]) {
  if (JSON.stringify(Object.entries(publish[key])) !== JSON.stringify(Object.entries(builder[key]))) {
    process.stderr.write(`Le corrispondenze ACSS (${key}) differiscono tra Publish e il builder: rigenera packages/cms/assets/histos-css/acss-map.json da ${source}.\n`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) process.stdout.write(`Corrispondenze ACSS uguali al builder: ${Object.keys(publish.tokens).length} token, ${Object.keys(publish.classes).length} classi.\n`);
