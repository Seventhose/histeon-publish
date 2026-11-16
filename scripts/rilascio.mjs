// Doc 23 items 194, 195 and 206: a release in a few commands, each one stopping where the owner decides.
//
//   npm run rilascio -- firme                       the release files without a valid signature, and the one
//                                                   command that signs them (the owner runs it: the key is theirs)
//   npm run rilascio -- prepara <prodotto> --note <file.md> [--senza-parita] [--sorgenti=<commit>]
//                                                   the release folder: packages, sources, SHA256SUMS, checked
//                                                   notes with the visual parity result; publishes nothing.
//                                                   --sorgenti: Histeon's sources from a later commit that changes
//                                                   nothing of the package (only docs/, scripts/, e2e/, dev/,
//                                                   plugin/tests/, editor/test/)
//   npm run rilascio -- pubblica <cartella> --conferma=<impronta>
//                                                   after the owner's yes: the GitHub release, then «verifica»
//   npm run rilascio -- verifica <cartella> | <owner/repo> <tag>
//                                                   sums and signatures of a folder, or of a published release
//                                                   downloaded again
//
// Products: histeon, lingua-bridge, static-bridge and publish, all in public repositories: the packages (for publish
// the AppImage with its signature and the .deb) and the sources from public-export.sh without .git and docs/, tar with
// a fixed mtime. The folder goes
// to $HISTOS_RILASCI/<prodotto>-<versione>/ (default: rilasci/ in the home folder). Public notes are checked against the
// deny list (~/.config/histos/public-deny.txt or XB_PUBLIC_DENY), e-mail addresses, home paths and «WordPress»
// (public texts say «WP»). The fingerprint printed by «prepara» covers the sums, the notes and the plan: «pubblica»
// refuses a folder that changed after the owner saw it.
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectedSum, sha256File } from "./consegne.mjs";
import { linuxReleaseDirectory } from "./copy-appimage-to-applications.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The release public key (docs/spec/updates.md of the builder); HISTOS_RELEASE_PUBLIC_KEY for another one. */
export const RELEASE_PUBLIC_KEY = "RWQSTenArP5FclHgI0qEErGDYUEQ6gL4cEhpgec49VKtqKfgl2TIAn5W";

/**
 * The one command that signs: the secret key never passes through this script. HISTOS_SIGN_COMMAND holds the owner's
 * own; by default the builder's signing script with the key named by HISTOS_RELEASE_KEY, both left for the shell.
 */
export const SIGN_COMMAND = process.env.HISTOS_SIGN_COMMAND?.trim()
  || 'php "$HISTOS_BUILDER_DIR/scripts/sign-release.php" sign "$HISTOS_RELEASE_KEY"';

const SIGNED = [/^xb-\d+\.\d+\.\d+-[0-9a-f]{7,40}\.zip$/u, /^lingua-bridge-\d+\.\d+\.\d+\.zip$/u, /^static-bridge-\d+\.\d+\.\d+\.zip$/u, /^Histeon-Publish-\d+\.\d+\.\d+-linux-x64\.AppImage$/u];

export function mustBeSigned(name) {
  return SIGNED.some((re) => re.test(name));
}

/**
 * A minisign signature checked with Node alone: the file's BLAKE2b-512 (algorithm «ED») or the file itself («Ed»),
 * Ed25519 on it, and the trusted comment's global signature. Returns the trusted comment; throws when anything fails.
 */
export async function verifyMinisig(file, signatureText, publicKey = RELEASE_PUBLIC_KEY) {
  const key = Buffer.from(publicKey.trim(), "base64");
  if (key.length !== 42 || key.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("Chiave pubblica non valida.");
  const lines = signatureText.split(/\r?\n/u);
  const signature = Buffer.from(lines[1] ?? "", "base64");
  if (signature.length !== 74) throw new Error(`${path.basename(file)}: firma illeggibile.`);
  const algorithm = signature.subarray(0, 2).toString("latin1");
  if (!signature.subarray(2, 10).equals(key.subarray(2, 10))) throw new Error(`${path.basename(file)}: firmato con un'altra chiave.`);
  const raw = signature.subarray(10);
  const ed = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]), format: "der", type: "spki" });
  let message;
  if (algorithm === "ED") {
    const hash = createHash("blake2b512");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    message = hash.digest();
  } else if (algorithm === "Ed") {
    message = await readFile(file);
  } else throw new Error(`${path.basename(file)}: algoritmo di firma sconosciuto.`);
  if (!verify(null, message, ed, raw)) throw new Error(`${path.basename(file)}: FIRMA NON VALIDA.`);
  const prefix = "trusted comment: ";
  if (!lines[2]?.startsWith(prefix)) throw new Error(`${path.basename(file)}: manca il commento fidato.`);
  const comment = lines[2].slice(prefix.length);
  if (!verify(null, Buffer.concat([raw, Buffer.from(comment, "utf8")]), ed, Buffer.from(lines[3] ?? "", "base64"))) throw new Error(`${path.basename(file)}: commento fidato non valido.`);
  return comment;
}

/** The signature state of a file: "valida", "manca" or the reason it is not valid. */
export async function signatureState(file, publicKey) {
  const text = await readFile(`${file}.minisig`, "utf8").catch(() => null);
  if (text === null) return "manca";
  try {
    await verifyMinisig(file, text, publicKey);
    return "valida";
  } catch (error) {
    return error.message;
  }
}

/** In a list of file names, an «e-mail address» that is an image with a density suffix: `name@2x.png`. */
export const DENSITY_SUFFIX = /^indirizzo e-mail: [\w.+-]+@\d(?:\.\d)?x\.[a-z0-9]{2,5}$/u;

/** What a public text must not contain. Returns the problems found, in Italian. */
export function publicTextProblems(text, denyWords) {
  const problems = [];
  const lower = text.toLowerCase();
  for (const word of denyWords) if (lower.includes(word.toLowerCase())) problems.push(`parola vietata: «${word}»`);
  for (const email of text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu) ?? []) {
    if (!/@users\.noreply\.github\.com$|@example\.(?:com|org|net)$/u.test(email)) problems.push(`indirizzo e-mail: ${email}`);
  }
  if (/\/(?:home|Users)\/[\w.-]+/u.test(text)) problems.push("un percorso di una cartella personale");
  if (/WordPress/u.test(text)) problems.push("«WordPress»: i testi pubblici dicono «WP»");
  return problems;
}

export async function readDenyWords(env = process.env, home = os.homedir()) {
  const file = env.XB_PUBLIC_DENY ?? path.join(home, ".config/histos/public-deny.txt");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) throw new Error(`Manca la lista delle parole vietate: ${file}.`);
  return text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

/** The fingerprint the owner sees: sums, notes and plan of a release folder. */
export async function fingerprint(folder) {
  const hash = createHash("sha256");
  for (const name of ["SHA256SUMS", "NOTE.md", "PIANO.json"]) hash.update(`${name}\n`).update(await readFile(path.join(folder, name)));
  return hash.digest("hex").slice(0, 16);
}

/** Every asset of a folder against SHA256SUMS, and every signature. Returns lines to print; throws on a problem. */
export async function verifyFolder(folder, { publicKey, assets } = {}) {
  const sums = path.join(folder, "SHA256SUMS");
  const names = assets ?? (await readdir(folder)).filter((name) => !["SHA256SUMS", "NOTE.md", "PIANO.json"].includes(name));
  const out = [];
  for (const name of names) {
    const expected = await expectedSum(sums, name);
    if (!expected) throw new Error(`${name} non è in SHA256SUMS.`);
    if (await sha256File(path.join(folder, name)) !== expected) throw new Error(`${name} non corrisponde a SHA256SUMS.`);
    out.push(`✓  ${name}`);
  }
  for (const name of names.filter(mustBeSigned)) {
    const state = await signatureState(path.join(folder, name), publicKey);
    if (state !== "valida") throw new Error(`${name}: firma ${state}.`);
    out.push(`✓  firma di ${name}`);
  }
  return out;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function must(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(" ")}: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
  return result.stdout;
}

const pick = (names, re) => names.filter((n) => re.test(n)).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1) ?? null;

/** Where each product's files come from, read from the repositories as consegne.mjs does. */
export async function products({ builder, publish = rootDirectory }) {
  const xbVersion = /const XB_VERSION = '([^']+)';/u.exec(await readFile(path.join(builder, "plugin/xb.php"), "utf8"))?.[1];
  const dist = path.join(builder, "dist");
  const names = await readdir(dist).catch(() => []);
  const xbZip = xbVersion ? pick(names, new RegExp(`^xb-${xbVersion.replaceAll(".", "\\.")}-[0-9a-f]+\\.zip$`, "u")) : null;
  const commit = xbZip ? /-([0-9a-f]+)\.zip$/u.exec(xbZip)[1] : null;
  const blankZip = commit ? pick(names, new RegExp(`^xb-blank-\\d+\\.\\d+\\.\\d+-${commit}\\.zip$`, "u")) : null;
  const fondamentaZip = commit ? pick(names, new RegExp(`^fondamenta-\\d+\\.\\d+\\.\\d+-${commit}\\.zip$`, "u")) : null;
  const modules = JSON.parse(await readFile(path.join(builder, "modules.json"), "utf8"));
  const module = (id) => {
    const zip = path.resolve(builder, modules[id].zip);
    return { zip, version: /-(\d+\.\d+\.\d+)\.zip$/u.exec(zip)?.[1], sha256: String(modules[id].sha256).toLowerCase() };
  };
  const lb = module("lingua-bridge");
  const sb = module("static-bridge");
  const { version: publishVersion } = JSON.parse(await readFile(path.join(publish, "packages/desktop/package.json"), "utf8"));
  const release = await linuxReleaseDirectory(path.join(publish, "packages/desktop"), publishVersion);
  return {
    histeon: {
      repo: "Seventhose/histeon", public: true, version: xbVersion, title: `Histeon ${xbVersion}`, source: { dir: builder, commit, name: "histeon" }, parity: true,
      files: [xbZip, fondamentaZip, blankZip].filter(Boolean).map((name) => ({ file: path.join(dist, name), sums: path.join(dist, "SHA256SUMS") })),
      missing: xbZip && fondamentaZip && blankZip ? null : `Nessun pacchetto xb-${xbVersion}-<commit>.zip con i suoi temi (fondamenta, xb-blank) in ${dist}: lancia scripts/package.sh nel builder.`,
    },
    "lingua-bridge": {
      repo: "Seventhose/histeon-lingua-bridge", public: true, version: lb.version, title: `Lingua Bridge ${lb.version}`, source: { dir: path.resolve(builder, "../lingua-bridge"), commit: null, name: "lingua-bridge", main: "lingua-bridge.php" },
      files: [{ file: lb.zip, sha256: lb.sha256 }],
    },
    "static-bridge": {
      repo: "Seventhose/histeon-static-bridge", public: true, version: sb.version, title: `Static Bridge ${sb.version}`, source: { dir: path.dirname(path.dirname(sb.zip)), commit: null, name: "static-bridge", main: "plugin/static-bridge.php" },
      files: [{ file: sb.zip, sha256: sb.sha256 }],
    },
    publish: {
      repo: "Seventhose/histeon-publish", public: true, version: publishVersion, title: `Histeon Publish ${publishVersion}`, parity: true,
      source: { dir: publish, commit: null, name: "histeon-publish", main: "package.json" }, pluginZip: xbZip ? path.join(dist, xbZip) : null,
      files: [`Histeon-Publish-${publishVersion}-linux-x64.AppImage`, `histos-publish_${publishVersion}_amd64.deb`].map((name) => ({ file: path.join(release, name), sums: path.join(release, "SHA256SUMS.txt") })),
    },
  };
}

async function checkedSource(entry) {
  const info = await lstat(entry.file).catch(() => null);
  if (!info?.isFile()) throw new Error(`Manca ${entry.file}.`);
  const expected = entry.sha256 ?? (await expectedSum(entry.sums, path.basename(entry.file)));
  if (!expected || (await sha256File(entry.file)) !== expected) throw new Error(`${path.basename(entry.file)} non corrisponde alla sua impronta SHA-256: rifai il pacchetto.`);
}

/** «firme»: what is not signed yet, among the files the next releases would carry. */
async function signatures({ builder, say }) {
  const all = await products({ builder });
  const files = [...new Set(Object.values(all).flatMap((p) => p.files.map((f) => f.file)).filter((f) => mustBeSigned(path.basename(f))))];
  const unsigned = [];
  for (const file of files) {
    if (!(await lstat(file).then((s) => s.isFile()).catch(() => false))) continue;
    const state = await signatureState(file);
    say(`${state === "valida" ? "✓ " : "✗ "} ${path.basename(file)}: firma ${state}`);
    if (state !== "valida") unsigned.push(file);
  }
  if (unsigned.length) say(`\nPer firmare (lo lancia il proprietario):\n${SIGN_COMMAND} ${unsigned.map((f) => f.replace(os.homedir(), "~")).join(" ")}`);
  else say("\nTutto firmato, tutte le firme valide.");
  return unsigned;
}

/** The visual parity test (doc 23 item 183) with this plugin ZIP; returns the line for the notes. */
function parity(pluginZip, builder, say) {
  say("Prova di parità con WP (qualche minuto)…");
  const result = run("npm", ["run", "test:parita-wp"], { cwd: rootDirectory, env: { ...process.env, HISTOS_PARITY_PLUGIN_ZIP: pluginZip, HISTOS_BUILDER_DIR: builder } });
  const text = `${result.stdout}\n${result.stderr}`;
  const table = text.split("Parità Publish ↔ WordPress")[1]?.split("\n\n")[0] ?? "";
  const rows = table.split("\n").filter((line) => /\d+\.\d{2}%/u.test(line));
  const equal = rows.filter((line) => Number(/(\d+\.\d{2})%/u.exec(line)[1]) < 2).length;
  if (result.status !== 0 || !rows.length) {
    say(text.split("\n").slice(-30).join("\n"));
    throw new Error(`La prova di parità non è verde (${equal} su ${rows.length}): niente è stato preparato. Guarda docs/PARITA-WP.md.`);
  }
  return `Prova di parità con WP prima della release: ${equal} pagine su ${rows.length} uguali alla build di Publish (meno del 2% di pixel diversi).`;
}

/** Paths of the builder that never go into the plugin or theme ZIP: a later commit changing only these has its sources. */
// Never in the package: package.sh ships no tests folder and only the compiled editor, never its tests.
const OUTSIDE_PACKAGE = /^(?:docs|scripts|e2e|dev|plugin\/tests|editor\/test)\//u;

async function sources(product, version, folder, say, sourcesCommit) {
  const { dir, name, main } = product.source;
  let commit = product.source.commit;
  if (sourcesCommit) {
    // The package is signed: its sources may come from a later commit only if nothing that goes into it changed.
    if (!commit || !/^[0-9a-f]{7,40}$/u.test(sourcesCommit)) throw new Error("--sorgenti=<commit> vale solo per Histeon, con un commit del builder.");
    const later = must("git", ["-C", dir, "rev-parse", "--short=7", `${sourcesCommit}^{commit}`]).trim();
    if (run("git", ["-C", dir, "merge-base", "--is-ancestor", commit, later]).status !== 0) throw new Error(`${later} non viene dopo ${commit}, il commit del pacchetto.`);
    const changed = must("git", ["-C", dir, "diff", "--name-only", commit, later]).split("\n").filter(Boolean);
    const inside = changed.filter((file) => !OUTSIDE_PACKAGE.test(file));
    if (inside.length) throw new Error(`Fra ${commit} e ${later} cambia anche ciò che entra nel pacchetto (${inside.slice(0, 5).join(", ")}): rifai il pacchetto.`);
    say(`Sorgenti dal commit ${later}: rispetto al pacchetto (${commit}) cambiano solo ${changed.length} file fuori dal pacchetto.`);
    commit = later;
  }
  if (!commit) {
    commit = must("git", ["-C", dir, "rev-parse", "--short=7", "HEAD"]).trim();
    const header = must("git", ["-C", dir, "show", `${commit}:${main}`]);
    // A plugin's header says «Version: X.Y.Z»; Publish's package.json says "version": "X.Y.Z".
    if (!new RegExp(`(?:Version:\\s+|"version":\\s*")${version.replaceAll(".", "\\.")}\\b`, "u").test(header)) throw new Error(`${name}: il commit ${commit} di ${dir} non è la versione ${version} del pacchetto.`);
  }
  const work = await mkdtemp(path.join(os.tmpdir(), "rilascio-"));
  try {
    const exportDir = path.join(work, `${name}-${version}`);
    say(`Sorgenti da ${dir} al commit ${commit}…`);
    // docs/ leaves the sources below: left out before the export's checks too (they would stop on what is not published).
    must(path.join(dir, "scripts/public-export.sh"), [exportDir, commit], { cwd: dir, env: { ...process.env, XB_PUBLIC_EXCLUDE: "docs/" } });
    await rm(path.join(exportDir, ".git"), { recursive: true, force: true });
    await rm(path.join(exportDir, "docs"), { recursive: true, force: true });
    const tarball = `${name}-${version}-sorgenti.tar.gz`;
    // The commit's date, not today's: the same commit gives the same archive on any day.
    const day = must("git", ["-C", dir, "log", "-1", "--format=%cs", commit]).trim();
    must("tar", ["--sort=name", `--mtime=${day} 00:00:00Z`, "--owner=0", "--group=0", "--numeric-owner", "-czf", path.join(folder, tarball), `${name}-${version}`], { cwd: work });
    return tarball;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** «prepara»: the folder of one release, ready for the owner's yes. */
async function prepare({ builder, id, notesFile, withParity, sourcesCommit, say }) {
  const product = (await products({ builder }))[id];
  if (!product) throw new Error(`Prodotto sconosciuto: ${id} (histeon, lingua-bridge, static-bridge, publish).`);
  if (product.missing) throw new Error(product.missing);
  if (!notesFile) throw new Error("Serve --note <file.md> con le note della release.");
  let notes = (await readFile(notesFile, "utf8")).trim();
  const version = product.version;
  for (const entry of product.files) await checkedSource(entry);
  const unsigned = [];
  for (const { file } of product.files) if (mustBeSigned(path.basename(file)) && (await signatureState(file)) !== "valida") unsigned.push(file);
  if (unsigned.length) throw new Error(`Prima la firma (la lancia il proprietario):\n${SIGN_COMMAND} ${unsigned.map((f) => f.replace(os.homedir(), "~")).join(" ")}`);
  const deny = product.public ? await readDenyWords() : [];
  if (product.public) {
    const problems = publicTextProblems(`${notes}\n${product.title}`, deny);
    if (problems.length) throw new Error(`Le note non possono andare in un repository pubblico:\n- ${problems.join("\n- ")}`);
  }
  const folder = path.join(process.env.HISTOS_RILASCI?.trim() || path.join(os.homedir(), "rilasci"), `${id}-${version}`);
  if (await lstat(folder).then(() => true).catch(() => false)) throw new Error(`Esiste già ${folder}: spostala (gio trash) per rifarla.`);
  if (product.parity) {
    const line = withParity ? parity(id === "histeon" ? product.files[0].file : product.pluginZip, builder, say) : "Prova di parità con WP: non eseguita per questa release.";
    notes = `${notes}\n\n${line}`;
  }
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const assets = [];
  for (const { file } of product.files) {
    for (const source of [file, `${file}.minisig`]) {
      if (!(await lstat(source).then((s) => s.isFile()).catch(() => false))) continue;
      await copyFile(source, path.join(folder, path.basename(source)));
      assets.push(path.basename(source));
    }
  }
  if (product.public) assets.push(await sources(product, version, folder, say, sourcesCommit));
  if (product.public) {
    const listing = must("tar", ["tzf", path.join(folder, assets.at(-1))]);
    // A file name is not a text: `hero@2x.svg` (the density suffix of an image) reads as an e-mail address there.
    const problems = publicTextProblems(listing, deny).filter((p) => !p.startsWith("«WordPress»") && !DENSITY_SUFFIX.test(p));
    if (problems.length) throw new Error(`I nomi dei file dei sorgenti non vanno bene:\n- ${problems.join("\n- ")}`);
  }
  const sums = [];
  for (const name of assets) sums.push(`${await sha256File(path.join(folder, name))}  ${name}`);
  await writeFile(path.join(folder, "SHA256SUMS"), `${sums.join("\n")}\n`);
  assets.push("SHA256SUMS");
  await writeFile(path.join(folder, "NOTE.md"), `${notes}\n`);
  const plan = { repo: product.repo, tag: `v${version}`, title: product.title, target: "main", public: product.public, assets };
  await writeFile(path.join(folder, "PIANO.json"), `${JSON.stringify(plan, null, 2)}\n`);
  for (const line of await verifyFolder(folder, { assets: assets.filter((n) => n !== "SHA256SUMS") })) say(line);
  const print = await fingerprint(folder);
  say(`\nPronta in ${folder}\n${plan.public ? "Repository PUBBLICO" : "Repository privato"} ${plan.repo}, ${plan.tag}: ${assets.join(", ")}.\nImpronta: ${print}\nDopo il sì del proprietario: npm run rilascio -- pubblica ${folder} --conferma=${print}`);
  return { folder, fingerprint: print };
}

/** «verifica <owner/repo> <tag>»: the published release downloaded into an empty folder and checked. */
async function verifyRemote(repo, tag, say) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo) || !/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error("Uso: verifica <owner/repo> <vX.Y.Z>.");
  const work = await mkdtemp(path.join(os.tmpdir(), "rilascio-verifica-"));
  try {
    must("gh", ["release", "download", tag, "--repo", repo, "--dir", work]);
    for (const line of await verifyFolder(work)) say(line);
    say(`${repo} ${tag}: riscaricata, somme e firme valide.`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function publishRelease(folder, confirmation, say) {
  const plan = JSON.parse(await readFile(path.join(folder, "PIANO.json"), "utf8"));
  const print = await fingerprint(folder);
  if (!confirmation || confirmation !== print) throw new Error(`L'impronta non corrisponde (cartella ${print}, data ${confirmation || "nessuna"}): la cartella è cambiata dopo che il proprietario l'ha vista, o manca --conferma.`);
  for (const line of await verifyFolder(folder, { assets: plan.assets.filter((n) => n !== "SHA256SUMS") })) say(line);
  must("gh", ["release", "create", plan.tag, "--repo", plan.repo, "--target", plan.target, "--title", plan.title, "--notes-file", path.join(folder, "NOTE.md"), ...plan.assets.map((n) => path.join(folder, n))]);
  say(`Pubblicata: https://github.com/${plan.repo}/releases/tag/${plan.tag}`);
  await verifyRemote(plan.repo, plan.tag, say);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name) => {
    const at = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (at === -1) return undefined;
    return rest[at].includes("=") ? rest[at].slice(rest[at].indexOf("=") + 1) : rest[at + 1];
  };
  const builder = path.resolve(process.env.HISTOS_BUILDER_DIR ?? path.join(rootDirectory, "../builder"));
  const say = (line) => process.stdout.write(`${line}\n`);
  if (command === "firme") {
    process.exitCode = (await signatures({ builder, say })).length ? 1 : 0;
  } else if (command === "prepara") {
    await prepare({ builder, id: rest[0], notesFile: option("note"), withParity: !rest.includes("--senza-parita"), sourcesCommit: option("sorgenti"), say });
  } else if (command === "pubblica") {
    await publishRelease(path.resolve(rest[0] ?? ""), option("conferma"), say);
  } else if (command === "verifica" && rest.length === 2) {
    await verifyRemote(rest[0], rest[1], say);
  } else if (command === "verifica" && rest.length === 1) {
    for (const line of await verifyFolder(path.resolve(rest[0]))) say(line);
  } else {
    const head = (await readFile(fileURLToPath(import.meta.url), "utf8")).split("\nimport ")[0];
    say(head.replace(/^\/\/ ?/gmu, ""));
    process.exitCode = 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
