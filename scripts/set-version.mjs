#!/usr/bin/env node
// Doc 23 item 127: the version of Histeon Publish lives in four places (the root and desktop package.json, the two
// entries of package-lock.json, packages/cms/src/version.ts). 1.21.1 came out saying 1.21.0 because one was missed.
// This writes all four, then reads them back and fails if any differs.
//
//   node scripts/set-version.mjs 1.24.0
//   node scripts/set-version.mjs --check      (only reads: exit 1 when they differ)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (file) => path.join(root, file);
const VERSION_TS = "packages/cms/src/version.ts";
const PATTERN = /HISTOS_PUBLISH_VERSION = "([^"]+)"/u;

export function versions() {
  const pkg = JSON.parse(readFileSync(at("package.json"), "utf8"));
  const desktop = JSON.parse(readFileSync(at("packages/desktop/package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(at("package-lock.json"), "utf8"));
  const ts = PATTERN.exec(readFileSync(at(VERSION_TS), "utf8"))?.[1] ?? null;
  return {
    "package.json": pkg.version,
    "packages/desktop/package.json": desktop.version,
    "package-lock.json": lock.version,
    'package-lock.json packages[""]': lock.packages?.[""]?.version,
    'package-lock.json packages["packages/desktop"]': lock.packages?.["packages/desktop"]?.version,
    [VERSION_TS]: ts,
  };
}

function set(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u.test(version)) throw new Error(`Versione non valida: ${version}`);
  for (const file of ["package.json", "packages/desktop/package.json"]) {
    const text = readFileSync(at(file), "utf8");
    writeFileSync(at(file), text.replace(/("version":\s*")[^"]+(")/u, `$1${version}$2`));
  }
  const lock = JSON.parse(readFileSync(at("package-lock.json"), "utf8"));
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  if (lock.packages?.["packages/desktop"]) lock.packages["packages/desktop"].version = version;
  writeFileSync(at("package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  const ts = readFileSync(at(VERSION_TS), "utf8");
  writeFileSync(at(VERSION_TS), ts.replace(PATTERN, `HISTOS_PUBLISH_VERSION = "${version}"`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Uso: node scripts/set-version.mjs <x.y.z> | --check");
    process.exit(2);
  }
  if (arg !== "--check") set(arg);
  const found = versions();
  const distinct = new Set(Object.values(found));
  if (distinct.size !== 1 || (arg !== "--check" && !distinct.has(arg))) {
    console.error(`Versioni diverse: ${JSON.stringify(found, null, 2)}`);
    process.exit(1);
  }
  console.log(`Versione ${[...distinct][0]} in tutti e sei i punti.`);
}
