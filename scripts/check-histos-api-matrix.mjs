import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPath = path.join(root, "packages/cms/vendor/histos/editor/src/lib/api.ts");
const localPatchPath = path.join(root, "packages/cms/patches/histos/local-cms.patch");
const matrixPath = path.join(root, "docs/spec/matrice-api-builder.md");
const source = readFileSync(apiPath, "utf8");
const localPatch = readFileSync(localPatchPath, "utf8");
const matrix = readFileSync(matrixPath, "utf8");
const classStart = source.indexOf("export class Api {");
if (classStart < 0) throw new Error("Classe Api del builder Histeon non trovata nella snapshot fissata.");

const classSource = source.slice(classStart);
const methods = [...classSource.matchAll(/^\s{2}(private\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)(?:<[^>]+>)?\s*\(/gmu)]
  .filter((match) => !match[1] && match[2] !== "constructor")
  .map((match) => match[2]);
const publicMethods = [...new Set(methods)];

// The standalone integration adds a small API surface that does not belong in the
// immutable upstream snapshot. Include additions from the api.ts patch so the matrix
// checks the effective editor contract without editing vendored Histeon sources.
const apiPatch = localPatch.split(/(?=^diff --git )/mu)
  .find((section) => /^diff --git a\/src\/lib\/api\.ts b\/src\/lib\/api\.ts$/mu.test(section));
if (!apiPatch) throw new Error("La patch locale dell’API Histeon non contiene src/lib/api.ts.");
const localMethods = [...apiPatch.matchAll(/^\+\s{2}(private\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)(?:<[^>]+>)?\s*\(/gmu)]
  .filter((match) => !match[1] && match[2] !== "constructor")
  .map((match) => match[2])
  // Methods moved to a host-specific adapter already exist in the upstream
  // contract and must not be counted again as standalone additions.
  .filter((name) => !publicMethods.includes(name));
publicMethods.push(...localMethods);

// Read method names only from the first column of Markdown table rows. A mention in prose,
// a test description, or the document introduction is not evidence that the method has
// been classified in the compatibility matrix.
const rows = matrix.split(/\r?\n/u).flatMap((line, index) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || trimmed.startsWith("|---")) return [];
  const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim());
  const methodNames = [...(cells[0] ?? "").matchAll(/`([^`]+)`/gu)]
    .flatMap(([, code]) => [...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)].map((match) => match[1]));
  if (methodNames.length === 0) return [];
  const classified = cells.slice(1).some((cell) => /\*\*(?:Sì|Parziale|No)[^*]*\*\*|\b(?:No|Non usato)\b/u.test(cell));
  return [{ line: index + 1, methodNames, classified }];
});

const matrixMethods = new Set(rows.flatMap((row) => row.methodNames));
const missing = publicMethods.filter((name) => !matrixMethods.has(name));
const unknown = [...matrixMethods].filter((name) => !publicMethods.includes(name));
const unclassified = rows.filter((row) => !row.classified);

if (missing.length || unknown.length || unclassified.length) {
  const problems = [
    missing.length ? `metodi non classificati: ${missing.join(", ")}` : "",
    unknown.length ? `metodi matrice assenti dalla snapshot: ${unknown.join(", ")}` : "",
    unclassified.length ? `righe senza stato esplicito (linee ${unclassified.map((row) => row.line).join(", ")})` : "",
  ].filter(Boolean);
  throw new Error(`Matrice API Histeon incoerente: ${problems.join("; ")}.`);
}

process.stdout.write(`${publicMethods.length} metodi dell’API effettiva (${methods.length} upstream e ${localMethods.length} aggiunti dalla patch locale) sono classificati in ${rows.length} righe; ogni riga ha uno stato esplicito.\n`);
