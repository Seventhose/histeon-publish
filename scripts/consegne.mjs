// Doc 23 item 184: the deliverables of a release in one command. After a release, the latest packages go to the
// owner's folders, and only there:
// - Documenti/Applicazioni/Plugin: the Histeon plugin and theme ZIPs (Fondamenta and the XB Blank compatibility theme), the Lingua Bridge and Static Bridge ZIPs that
//   Histeon pins (modules.json), with their .minisig when signed, and SHA256SUMS.txt;
// - Documenti/Applicazioni: the Histeon Publish AppImage (copy-appimage-to-applications.mjs, never overwritten);
// - each installer folder: the AppImage, the .deb, the plugin and theme ZIPs, SHA256SUMS.txt.
// Every source is checked against a SHA-256 it was built with before it is copied. In the target folders only the
// older versions of these same files are removed (by name, regular files only): copies stay in the repositories.
//
//   npm run consegne             does it
//   npm run consegne -- --prova  says what it would do, changes nothing
import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyVerifiedAppImage, getApplicationsDirectory, linuxReleaseDirectory } from "./copy-appimage-to-applications.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files a delivery replaces in a target folder: older versions of these names, never anything else. */
export const REPLACED = [
  /^xb-\d+\.\d+\.\d+-[0-9a-f]{7,40}(?:-senza-moduli)?\.zip(?:\.minisig)?$/u,
  /^xb-blank-\d+\.\d+\.\d+-[0-9a-f]{7,40}\.zip(?:\.minisig)?$/u,
  /^fondamenta-\d+\.\d+\.\d+-[0-9a-f]{7,40}\.zip(?:\.minisig)?$/u,
  /^lingua-bridge-\d+\.\d+\.\d+\.zip(?:\.minisig)?$/u,
  /^static-bridge-\d+\.\d+\.\d+\.zip(?:\.minisig)?$/u,
  /^Histeon-Publish-\d+\.\d+\.\d+-linux-x64\.AppImage(?:\.minisig)?$/u,
  /^histos-publish_\d+\.\d+\.\d+_amd64\.deb$/u,
];

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** The SHA-256 a sums file (`<hex>  <name>`) gives for a name, or null. */
export async function expectedSum(sumsFile, name) {
  const text = await readFile(sumsFile, "utf8").catch(() => "");
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([a-f\d]{64})\s+\*?(.+)$/iu.exec(line);
    if (match?.[2] === name) return match[1].toLowerCase();
  }
  return null;
}

/** A source file checked against its expected SHA-256, with its signature when one sits next to it. */
async function checked(file, expected) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`Manca il pacchetto ${file}: costruiscilo prima delle consegne.`);
  const actual = await sha256File(file);
  if (!expected || actual !== expected) throw new Error(`${path.basename(file)} non corrisponde alla sua impronta SHA-256 (${expected ? "diversa" : "assente"}): niente è stato consegnato.`);
  const signature = await lstat(`${file}.minisig`).then((s) => s.isFile()).catch(() => false);
  return { file, name: path.basename(file), sha256: actual, signature: signature ? `${file}.minisig` : null };
}

/**
 * What goes where, read from the repositories: the builder's current version and commit, the modules it pins, the
 * Publish version. Throws when a package is missing or does not match its sum.
 */
export async function plan({ builder, publish, env = process.env, home = os.homedir() }) {
  const xbPhp = await readFile(path.join(builder, "plugin/xb.php"), "utf8");
  const xbVersion = /const XB_VERSION = '([^']+)';/u.exec(xbPhp)?.[1];
  if (!xbVersion) throw new Error("Versione di Histeon non trovata in plugin/xb.php.");
  const dist = path.join(builder, "dist");
  const names = await readdir(dist);
  const pick = (re) => names.filter((n) => re.test(n)).sort().at(-1) ?? null;
  const xbZip = pick(new RegExp(`^xb-${xbVersion.replaceAll(".", "\\.")}-[0-9a-f]+\\.zip$`, "u"));
  if (!xbZip) throw new Error(`Nessun pacchetto xb-${xbVersion}-<commit>.zip in ${dist}: lancia scripts/package.sh nel builder.`);
  const commit = /-([0-9a-f]+)\.zip$/u.exec(xbZip)[1];
  const blankZip = pick(new RegExp(`^xb-blank-\\d+\\.\\d+\\.\\d+-${commit}\\.zip$`, "u"));
  if (!blankZip) throw new Error(`Manca il tema xb-blank-…-${commit}.zip in ${dist}.`);
  const fondamentaZip = pick(new RegExp(`^fondamenta-\\d+\\.\\d+\\.\\d+-${commit}\\.zip$`, "u"));
  if (!fondamentaZip) throw new Error(`Manca il tema fondamenta-…-${commit}.zip in ${dist}.`);
  const sums = path.join(dist, "SHA256SUMS");
  const plugin = await checked(path.join(dist, xbZip), await expectedSum(sums, xbZip));
  const theme = await checked(path.join(dist, blankZip), await expectedSum(sums, blankZip));
  const fondamenta = await checked(path.join(dist, fondamentaZip), await expectedSum(sums, fondamentaZip));
  const modules = JSON.parse(await readFile(path.join(builder, "modules.json"), "utf8"));
  const pinned = [];
  for (const id of Object.keys(modules).sort()) {
    pinned.push(await checked(path.resolve(builder, modules[id].zip), String(modules[id].sha256).toLowerCase()));
  }
  const { version: publishVersion } = JSON.parse(await readFile(path.join(publish, "packages/desktop/package.json"), "utf8"));
  const release = env.HISTOS_RELEASE_DIR ? path.resolve(publish, env.HISTOS_RELEASE_DIR) : await linuxReleaseDirectory(path.join(publish, "packages/desktop"), publishVersion);
  const appImageName = `Histeon-Publish-${publishVersion}-linux-x64.AppImage`;
  const debName = `histos-publish_${publishVersion}_amd64.deb`;
  const releaseSums = path.join(release, "SHA256SUMS.txt");
  const appImage = await checked(path.join(release, appImageName), await expectedSum(releaseSums, appImageName));
  const deb = await checked(path.join(release, debName), await expectedSum(releaseSums, debName));
  const applications = getApplicationsDirectory({ env });
  const installers = (env.HISTOS_INSTALLER_DIRS ?? `${path.join(home, "Corallo/installer-2026-11-02")}:${path.join(home, "Corallo/installer-2026-10-28")}`).split(":").filter(Boolean);
  return {
    publishVersion,
    release,
    applications,
    targets: [
      { directory: path.join(applications, "Plugin"), files: [plugin, fondamenta, theme, ...pinned] },
      ...installers.map((directory) => ({ directory, files: [appImage, deb, plugin, fondamenta, theme] })),
    ],
  };
}

/** Puts the files of one target folder in place: old versions out, new ones in (verified after the copy), sums. */
async function deliverTarget(target, dryRun, say) {
  const wanted = new Set(target.files.flatMap((f) => [f.name, ...(f.signature ? [`${f.name}.minisig`] : [])]));
  const present = await readdir(target.directory).catch(() => []);
  for (const name of present) {
    if (wanted.has(name) || !REPLACED.some((re) => re.test(name))) continue;
    const info = await lstat(path.join(target.directory, name));
    if (!info.isFile()) continue;
    say(`  via   ${name}`);
    if (!dryRun) await rm(path.join(target.directory, name));
  }
  if (!dryRun) await mkdir(target.directory, { recursive: true });
  for (const file of target.files) {
    for (const [source, name] of [[file.file, file.name], ...(file.signature ? [[file.signature, `${file.name}.minisig`]] : [])]) {
      const destination = path.join(target.directory, name);
      const same = await lstat(destination).then((s) => s.isFile()).catch(() => false) && await sha256File(destination) === await sha256File(source);
      if (same) continue;
      say(`  copia ${name}`);
      if (dryRun) continue;
      await copyFile(source, destination);
      if (await sha256File(destination) !== await sha256File(source)) throw new Error(`La copia di ${name} in ${target.directory} non è riuscita.`);
    }
  }
  const sums = target.files.map((f) => `${f.sha256}  ${f.name}`).join("\n") + "\n";
  if (!dryRun) await writeFile(path.join(target.directory, "SHA256SUMS.txt"), sums);
}

export async function deliver({ builder, publish, env = process.env, home = os.homedir(), dryRun = false, say = () => {} }) {
  const delivery = await plan({ builder, publish, env, home });
  for (const target of delivery.targets) {
    say(`${target.directory}`);
    await deliverTarget(target, dryRun, say);
  }
  say(delivery.applications);
  if (dryRun) say(`  copia Histeon-Publish-${delivery.publishVersion}-linux-x64.AppImage (se non c'è già)`);
  else {
    const copied = await copyVerifiedAppImage({ releaseDirectory: delivery.release, applicationsDirectory: delivery.applications, version: delivery.publishVersion });
    say(`  ${copied.copied ? "copiata" : "già presente"} ${copied.filename}`);
  }
  return delivery;
}

async function main() {
  const dryRun = process.argv.includes("--prova");
  const builder = path.resolve(process.env.HISTOS_BUILDER_DIR ?? path.join(rootDirectory, "../builder"));
  await deliver({ builder, publish: rootDirectory, dryRun, say: (line) => process.stdout.write(`${line}\n`) });
  process.stdout.write(dryRun ? "Prova: niente è stato cambiato.\n" : "Consegne fatte.\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
