import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedLicenses = new Set(["MIT", "BSD", "Apache-2.0", "ISC", "GPL-2.0-or-later", "GPL-3.0-or-later", "LGPL", "MPL-2.0"]);
const directReasons = new Map([
  ["@napi-rs/keyring", "Salva il token Cloudflare nel portachiavi di sistema senza fallback in chiaro."],
  ["@electron/asar", "Crea l’archivio desktop con integrità dei file senza un packager preconfezionato."],
  ["@electron/fuses", "Applica i fuse di sicurezza richiesti al runtime Electron distribuito."],
  ["resedit", "Aggiunge all’eseguibile Windows l’hash ASAR richiesto da Electron."],
  ["@playwright/test", "Esegue i test end-to-end dell’interfaccia sul server locale con servizi simulati."],
  ["electron", "Fornisce Chromium e il runtime desktop isolato per l’applicazione."],
  ["esbuild", "Compila il processo principale Electron e il preload con dipendenze workspace incluse."],
  ["@sveltejs/vite-plugin-svelte", "Compila i componenti Svelte dell’interfaccia locale."],
  ["@biomejs/biome", "Lint di TypeScript, JavaScript e JSON senza dipendenze fuori policy."],
  ["ajv", "Valida la configurazione del sito contro uno schema chiuso."],
  ["@histos-publish/histos-contract", "Condivide gli schemi v2 e il profilo di trasferimento delle pagine Histeon."],
  ["@histos-publish/cms", "Gestisce repository SQLite nativi, revisioni e conflitti dei progetti Histeon."],
  ["@types/node", "Fornisce i tipi per le API Node, incluso node:sqlite."],
  ["bcrypt-pbkdf", "Deriva le chiavi per le chiavi SSH cifrate; la copia locale usa SHA-512 integrato in Node e conserva il codice OpenBSD BSD."],
  ["commander", "Gestisce i comandi, gli argomenti e l’aiuto della CLI."],
  ["parse-srcset", "Analizza srcset mantenendo i descrittori delle immagini."],
  ["playwright-core", "Esegue il render controllato di siti nel core e lo smoke test dell’app Electron."],
  ["open", "Apre la schermata locale nel browser predefinito quando si avvia la CLI grafica."],
  ["ssh2", "Gestisce SFTP nel processo locale con verifica della chiave host prima dell’autenticazione, senza richiedere un client SSH esterno."],
  ["parse5", "Analizza e riscrive HTML senza trasformazioni regex fragili."],
  ["pagefind", "Genera offline un indice statico opt-in, senza query o servizio di ricerca esterno."],
  ["@jsquash/avif", "Codifica (libavif con libaom) e decodifica AVIF in WebAssembly per le varianti moderne della build (B6), in un worker, senza moduli nativi."],
  ["@jsquash/jxl", "Codifica JPEG XL (libjxl) in WebAssembly per le varianti moderne della build (B6)."],
  ["@jsquash/webp", "Codifica e decodifica WebP (libwebp) in WebAssembly per le varianti moderne della build (B6)."],
  ["@jsquash/jpeg", "Decodifica i JPEG (mozjpeg) in WebAssembly per le varianti moderne della build (B6)."],
  ["@jsquash/png", "Decodifica i PNG (crate Rust png) in WebAssembly per le varianti moderne della build (B6)."],
  ["@jsquash/resize", "Ridimensiona le immagini (Lanczos, crate Rust resize) in WebAssembly per le larghezze di srcset (B6)."],
  ["chroma-js", "Interpola i colori dei gradienti easing Core in RGB lineare e produce fermate HSL."],
  ["easing-coordinates", "Calcola le coordinate delle funzioni timing usate nei gradienti Core."],
  ["postcss", "Analizza il CSS e i suoi at-rule per trovare risorse locali."],
  ["postcss-value-parser", "Legge i valori CSS, inclusi i parametri dei gradienti Core e gli import locali."],
  ["@types/chroma-js", "Tipi TypeScript per l’interpolazione dei colori dei gradienti Core."],
  ["svelte", "Costruisce l’interfaccia guidata dell’applicazione."],
  ["svelte-check", "Controlla tipi e diagnostica dei componenti Svelte."],
  ["typescript", "Compila il monorepo e applica il typecheck strict."],
  ["vite", "Compila e serve l’interfaccia web locale durante lo sviluppo."],
  ["vitest", "Esegue i test unitari e di integrazione locale."],
  ["yauzl", "Legge ZIP in modo sequenziale e con validazione delle dimensioni."],
  ["yazl", "Crea le esportazioni ZIP in streaming e l’archivio ZIP temporaneo incorporato nell’installer Windows per utente."],
  ["zod", "Valida mittenti e argomenti IPC dell’app Electron con schemi chiusi."],
  ["@types/parse-srcset", "Tipi per parse-srcset."],
  ["@types/yauzl", "Tipi per yauzl."],
  ["@types/yazl", "Tipi per yazl."],
  ["lz-string", "Crea fixture di test per i preset Core compressi; l’editor usa un decoder locale con limiti espliciti."],
]);
const explicitLicenseOverrides = new Map([
  ["jiti", "MIT"],
  ["undici", "MIT"],
  ["balanced-match", "MIT"],
  ["@biomejs/cli-darwin-arm64", "MIT OR Apache-2.0"],
  ["@biomejs/cli-darwin-x64", "MIT OR Apache-2.0"],
  ["@biomejs/cli-linux-arm64", "MIT OR Apache-2.0"],
  ["@biomejs/cli-linux-arm64-musl", "MIT OR Apache-2.0"],
  ["@biomejs/cli-linux-x64", "MIT OR Apache-2.0"],
  ["@biomejs/cli-linux-x64-musl", "MIT OR Apache-2.0"],
  ["@biomejs/cli-win32-arm64", "MIT OR Apache-2.0"],
  ["@biomejs/cli-win32-x64", "MIT OR Apache-2.0"],
]);

function licenseFor(name, metadata, packageMetadata) {
  const known = explicitLicenseOverrides.get(name);
  if (known) return known;
  if (name.startsWith("@pagefind/")) return "MIT";
  if (name.startsWith("@rolldown/binding-")) return "MIT";
  if (name.startsWith("@esbuild/")) return "MIT";
  if (name.startsWith("@napi-rs/keyring-")) return "MIT";
  if (name.startsWith("@typescript/typescript-")) return "Apache-2.0";
  if (name.startsWith("lightningcss-")) return "MPL-2.0";
  if (name === "fsevents") return "MIT";
  const declared = (source) => {
    if (typeof source?.license === "string") return source.license;
    if (Array.isArray(source?.licenses)) {
      const identifiers = source.licenses.map((entry) => entry && typeof entry.type === "string" ? entry.type : "").filter(Boolean);
      if (identifiers.length) return identifiers.join(" OR ");
    }
    return undefined;
  };
  return declared(metadata) ?? declared(packageMetadata) ?? "non dichiarata";
}

function isAllowedLicense(identifier) {
  if (allowedLicenses.has(identifier)) return true;
  if (/^BSD-[A-Za-z0-9.-]+$/u.test(identifier)) return true;
  return /^LGPL-(?:2\.0|2\.1|3\.0)(?:-(?:only|or-later))?$/u.test(identifier);
}

function parseLicenseExpression(expression) {
  const tokens = String(expression).match(/[()]|[^\s()]+/gu) ?? [];
  let cursor = 0;

  function parseAtom() {
    const token = tokens[cursor++];
    if (!token) throw new Error(`Espressione SPDX incompleta: ${expression}`);
    if (token === "(") {
      const nested = parseOr();
      if (tokens[cursor++] !== ")") throw new Error(`Parentesi SPDX non chiusa: ${expression}`);
      return nested;
    }
    if (token === ")" || token === "AND" || token === "OR" || token === "WITH") {
      throw new Error(`Identificatore SPDX inatteso: ${expression}`);
    }
    if (tokens[cursor] === "WITH") {
      cursor += 2;
      return { type: "WITH", license: token };
    }
    return { type: "license", value: token };
  }

  function parseAnd() {
    const nodes = [parseAtom()];
    while (tokens[cursor] === "AND") {
      cursor += 1;
      nodes.push(parseAtom());
    }
    return nodes.length === 1 ? nodes[0] : { type: "AND", children: nodes };
  }

  function parseOr() {
    const nodes = [parseAnd()];
    while (tokens[cursor] === "OR") {
      cursor += 1;
      nodes.push(parseAnd());
    }
    return nodes.length === 1 ? nodes[0] : { type: "OR", children: nodes };
  }

  const tree = parseOr();
  if (cursor !== tokens.length) throw new Error(`Token SPDX residui: ${expression}`);
  return tree;
}

function isAllowedExpression(node) {
  if (node.type === "license") return isAllowedLicense(node.value);
  if (node.type === "WITH") return false;
  if (node.type === "AND") return node.children.every(isAllowedExpression);
  if (node.type === "OR") return node.children.some(isAllowedExpression);
  return false;
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const lockPackages = lock.packages ?? {};
const owners = new Map();
const directUse = new Map();

function resolvePackageKey(parentKey, dependencyName) {
  let current = parentKey;
  while (current) {
    const candidate = `${current}/node_modules/${dependencyName}`;
    if (lockPackages[candidate]) return candidate;
    const marker = current.lastIndexOf("/node_modules/");
    current = marker >= 0 ? current.slice(0, marker) : "";
  }
  const rootCandidate = `node_modules/${dependencyName}`;
  return lockPackages[rootCandidate] ? rootCandidate : null;
}

function track(key, owner, visited = new Set()) {
  if (!key || visited.has(key)) return;
  const nextVisited = new Set(visited).add(key);
  if (!owners.has(key)) owners.set(key, new Set());
  owners.get(key).add(owner);
  for (const dependencyName of Object.keys(lockPackages[key]?.dependencies ?? {})) {
    track(resolvePackageKey(key, dependencyName), owner, nextVisited);
  }
  for (const dependencyName of Object.keys(lockPackages[key]?.optionalDependencies ?? {})) {
    track(resolvePackageKey(key, dependencyName), owner, nextVisited);
  }
}

for (const workspace of packageJson.workspaces ?? []) {
  const workspacePath = path.join(root, workspace);
  const workspacePackage = JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8"));
  for (const [kind, dependencies] of [["runtime", workspacePackage.dependencies ?? {}], ["development", workspacePackage.devDependencies ?? {}]]) {
    for (const dependencyName of Object.keys(dependencies)) {
      const key = resolvePackageKey(workspace, dependencyName);
      if (!key) throw new Error(`Pacchetto non presente nel lockfile: ${dependencyName}`);
      track(key, dependencyName);
      directUse.set(dependencyName, { kind, workspace: workspacePackage.name });
    }
  }
}
for (const dependencyName of Object.keys(packageJson.devDependencies ?? {})) {
  const key = resolvePackageKey("", dependencyName);
  if (!key) throw new Error(`Pacchetto dev non presente nel lockfile: ${dependencyName}`);
  track(key, dependencyName);
  directUse.set(dependencyName, { kind: "development", workspace: packageJson.name });
}

const rows = [];
for (const key of Object.keys(lockPackages).filter((item) => item.startsWith("node_modules/")).sort()) {
  const meta = lockPackages[key];
  if (meta.link || !meta.version) continue;
  let packageMetadata = {};
  try { packageMetadata = JSON.parse(await readFile(path.join(root, key, "package.json"), "utf8")); } catch { /* Optional platform packages may not be installed locally. */ }
  const packageName = packageMetadata.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  if (!packageMetadata.version) {
    try {
      const hoisted = JSON.parse(await readFile(path.join(root, "node_modules", packageName, "package.json"), "utf8"));
      if (hoisted.version === meta.version) packageMetadata = hoisted;
    } catch { /* A duplicate lock entry may not be installed or hoisted. */ }
  }
  const rawLicense = licenseFor(packageName, meta, packageMetadata);
  let allowed;
  try { allowed = isAllowedExpression(parseLicenseExpression(rawLicense)); }
  catch (error) { throw new Error(`Licenza non ammessa o espressione SPDX non valida: ${key} (${rawLicense})`, { cause: error }); }
  if (!allowed) throw new Error(`Licenza non ammessa o non verificata: ${key} (${rawLicense})`);
  const direct = directUse.get(packageName);
  const parentOwners = [...(owners.get(key) ?? [])].sort();
  const kind = direct?.kind ?? (meta.dev ? "development transitiva" : "runtime transitiva");
  const usage = directReasons.get(packageName) ?? `Supporto interno alle dipendenze ${parentOwners.join(", ") || "del lockfile"}.`;
  const reason = direct
    ? `Importato o usato dal workspace ${direct.workspace}.`
    : `Necessaria alla catena ${parentOwners.join(", ") || "registrata nel lockfile"}; non importata direttamente.`;
  rows.push(`| \`${packageName}\` | ${meta.version} | ${rawLicense} | ${kind} | ${usage} | ${reason} |`);
}

const markdown = `# Registro di provenienza

Ogni pacchetto fissato nel lockfile è elencato qui. Il controllo rifiuta licenze non dichiarate o incompatibili con la policy del progetto.

## Dipendenze npm

| Pacchetto | Versione | Licenza | Ambito | Uso | Motivo |
|---|---:|---|---|---|---|
${rows.join("\n")}

## Codice permissivo adattato nel workspace

| Pacchetto | Versione | Licenza | Uso e modifica |
|---|---:|---|---|
| \`bcrypt-pbkdf\` (copia locale del port OpenBSD) | 1.0.3 | BSD-3-Clause | Dipendenza runtime di \`ssh2\`; SHA-512 usa il modulo Node \`node:crypto\` al posto di \`tweetnacl\`. Il file \`packages/bcrypt-pbkdf/LICENSE\` conserva gli avvisi originali; il testo viene incluso nell’app desktop. |

## Strumenti esterni di packaging

| Strumento | Versione | Licenza | Uso e distribuzione |
|---|---:|---|---|
| [appimagetool](https://github.com/AppImage/appimagetool) | 1.9.1 | MIT | Costruisce l’AppImage; scaricato da un tag immutabile e verificato con SHA-256 ${"ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"}. Non viene incluso nel prodotto. |
| [AppImage type2-runtime](https://github.com/AppImage/type2-runtime) | 20251108 | MIT | Runtime incorporato nell’AppImage; tag e SHA-256 fissati (${"2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"}). |
| dpkg-deb e dpkg-shlibdeps | Sistema Debian/Ubuntu | GPL-2.0-or-later | Creano il pacchetto Debian e ne calcolano le dipendenze di sistema; non vengono inclusi nel prodotto. |
| IExpress e PowerShell | Windows | Componenti del sistema operativo | Creano e verificano l’installer per utente; non vengono copiati nel prodotto. |

## Fonti e decisioni

| Fonte | Verifica |
|---|---|
| Documentazione ufficiale Cloudflare, Electron, Node.js e librerie registrate negli ADR 0001 e 0004 | Consultata il 2026-10-21; riferimenti in docs/PIANO.md e nelle ADR. |
| Node.js node:sqlite, versione minima CLI 22.13; Electron 45 include Node 24.22 | L’API sincrona è integrata e non richiede il modulo npm better-sqlite3; è sperimentale nella linea Node 22 e release candidate da Node 24.15. |
| Electron ASAR Integrity | L’archivio ASAR contiene hash per i file; Windows riceve anche l’hash dell’header nella risorsa PE INTEGRITY/ELECTRONASAR. |
| AppImage, [appimagetool](https://github.com/AppImage/appimagetool) e [type2-runtime](https://github.com/AppImage/type2-runtime) | Tool e runtime sono versionati, verificati con SHA-256 e usati solo per il packaging. |
| Registry npm: Electron 45.0.0, @electron/asar 3.4.1, @electron/fuses 2.1.3, esbuild 0.28.2, Playwright Core 1.64.1, resedit 1.7.2, yazl 3.3.1 e Zod 4.6.7 | Licenze, versioni e dipendenze risultano dal lockfile; i testi delle licenze runtime sono conservati nell’archivio desktop. |
| Static Bridge 2.0.25, commit 06086c68f38213dbbb7b4ca6c84f755e0555e531 | Ispezionato in sola lettura per la proposta; nessun codice o asset importato. |
| Histeon e Static Bridge | Documenti e sorgenti sono stati consultati come riferimenti del progetto; nessun repository originale è stato modificato. |

## Regole SPDX

- La policy accetta MIT, BSD, Apache-2.0, ISC, GPL-2.0-or-later, LGPL e MPL-2.0. Le varianti BSD con identificatore BSD-* e LGPL 2.0, 2.1 o 3.0 sono trattate come appartenenti a queste famiglie.
- OR è ammesso quando almeno una scelta completa rispetta la policy; AND è ammesso solo se ogni componente la rispetta.
- WITH, licenze sconosciute e identificatori non ammessi interrompono npm run provenance. 0BSD e GPL-2.0-only non sono inclusi nell’allowlist; GPL-3.0-or-later è ammessa per lo snapshot Histeon con NOTICE e sorgenti tracciati.
- Licenze e versioni npm arrivano dal package-lock.json; le eccezioni per binari opzionali sono dichiarate nello script del registro.
- Lo snapshot dell’editor e dei pacchetti Histeon è copiato dal commit upstream 9bc212050403dd056ac21edfcff398b514e4a3c1 in packages/cms/vendor/histos, con LICENSE e provenance; la patch host è separata in packages/cms/patches/histos. Nessun codice o asset Static Bridge è stato copiato.
`;

await writeFile(path.join(root, "docs/policy/PROVENANCE.md"), markdown);
process.stdout.write(`Registro aggiornato: ${rows.length} pacchetti, licenze ammesse.\n`);
