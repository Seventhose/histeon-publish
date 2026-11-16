import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builder = path.resolve(process.env.HISTOS_BUILDER_ROOT ?? path.join(root, "../histos-cms-builder"));
const source = path.join(root, "packages/cms/assets/histos-css/design-data.json");
const tsTarget = path.join(root, "packages/cms/src/histos-design-data.generated.ts");
const phpTarget = path.join(builder, "plugin/src/Framework/HistosCss/DesignData.php");
const data = JSON.parse(await readFile(source, "utf8"));

const phpLiteral = (value, depth = 0) => {
  const indent = "\t".repeat(depth);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "array()";
    return `array(\n${value.map((entry) => `${indent}\t${phpLiteral(entry, depth + 1)}`).join(",\n")}\n${indent})`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "array()";
    return `array(\n${entries.map(([key, entry]) => `${indent}\t${phpLiteral(key, depth + 1)} => ${phpLiteral(entry, depth + 1)}`).join(",\n")}\n${indent})`;
  }
  throw new TypeError("Histeon design data contains an unsupported value.");
};

const phpProperties = [
  ["SCHEMA_VERSION", data.schemaVersion],
  ["ROOT_PX", data.rootPx],
  ["FAMILIES", data.families],
  ["BRAND_FAMILIES", data.brandFamilies],
  ["STATE_FAMILIES", data.stateFamilies],
  ["DEFAULTS", data.defaults],
  ["LIMITS", data.limits],
  ["FLAGS", data.flags],
  ["CHOICES", data.choices],
  ["OPTIONAL_FONTS", data.optionalFonts],
  ["ROLES", data.roles],
  ["ROLE_DEFAULTS", data.roleDefaults],
  ["AUTO_TEXT", data.autoText],
  ["AUTO_ALSO", data.autoAlso],
  ["LIST_ICONS", data.listIcons],
  ["PATTERNS", data.patterns],
  ["DARK_HOVER", data.darkHover],
  ["PRINT_GROUPS", data.printGroups],
  ["CLASS_GROUPS", data.classGroups],
  ["SHADES", data.shades],
  ["CHROMA", data.chroma],
  ["TEXT_STEPS", data.textSteps],
  ["SPACE_STEPS", data.spaceSteps],
  ["ALPHAS", data.alphas],
  ["HEADINGS", data.headings],
];
const php = [
  "<?php",
  "/**",
  " * Generated from packages/cms/assets/histos-css/design-data.json. Do not edit by hand.",
  " * @package XB",
  " */",
  "",
  "declare(strict_types=1);",
  "",
  "namespace XB\\Framework\\HistosCss;",
  "",
  "final class DesignData {",
  ...phpProperties.flatMap(([name, value]) => [`\tpublic const ${name} = ${phpLiteral(value, 1)};`, ""]),
  "}",
  "",
].join("\n");
const ts = [
  "/* Generated from assets/histos-css/design-data.json. Do not edit by hand. */",
  "// biome-ignore-all lint/suspicious/noApproximativeNumericConstant: keep exact source values for PHP parity.",
  `export const HISTOS_CSS_DESIGN_DATA = ${JSON.stringify(data, null, 2)} as const;`,
  "",
].join("\n");

const files = new Map([[tsTarget, ts], [phpTarget, php]]);
const check = process.argv.includes("--check");
let mismatches = [];
for (const [file, content] of files) {
  if (check) {
    const actual = await readFile(file, "utf8").catch(() => "");
    if (actual !== content) mismatches.push(file);
  } else {
    await writeFile(file, content, "utf8");
  }
}
if (mismatches.length) {
  throw new Error(`Generated Histeon design data is stale: ${mismatches.join(", ")}`);
}
process.stdout.write(check ? "Histeon design data outputs are current.\n" : `Generated TS and PHP Histeon design data from ${source}.\n`);
