import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { createReadStream } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDirectory = path.join(rootDirectory, "packages/desktop");

export function getApplicationsDirectory({ env = process.env, platform = process.platform } = {}) {
  if (platform !== "linux") throw new Error("La copia in Documenti/Applicazioni è disponibile solo su Linux.");
  if (env.HISTOS_APPLICATIONS_DIR) {
    if (!path.isAbsolute(env.HISTOS_APPLICATIONS_DIR)) throw new Error("HISTOS_APPLICATIONS_DIR deve essere un percorso assoluto.");
    return path.resolve(env.HISTOS_APPLICATIONS_DIR);
  }

  const result = spawnSync("xdg-user-dir", ["DOCUMENTS"], { encoding: "utf8", timeout: 5_000 });
  const documents = result.status === 0 ? result.stdout.trim() : "";
  const baseDirectory = documents && path.isAbsolute(documents)
    ? documents
    : path.join(os.homedir(), "Documents");
  return path.join(baseDirectory, "Applicazioni");
}

/**
 * The folder with the Linux packages of `version`: release/<version>/, where scripts/release-linux.mjs writes them, when
 * it holds that AppImage; else release/ itself, where a plain `npm run dist:linux` leaves them.
 */
export async function linuxReleaseDirectory(desktop, version) {
  const versioned = path.join(desktop, "release", version);
  const appImage = await lstat(path.join(versioned, `Histeon-Publish-${version}-linux-x64.AppImage`)).catch(() => null);
  return appImage ? versioned : path.join(desktop, "release");
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function readExpectedChecksum(releaseDirectory, filename) {
  const manifest = await readFile(path.join(releaseDirectory, "SHA256SUMS.txt"), "utf8");
  const row = manifest.split(/\r?\n/u).find((line) => {
    const match = line.match(/^([a-f\d]{64})\s+\*?(.+)$/iu);
    return match?.[2] === filename;
  });
  if (!row) throw new Error(`SHA256SUMS.txt non contiene una verifica per ${filename}.`);
  return row.match(/^([a-f\d]{64})\s+\*?(.+)$/iu)[1].toLowerCase();
}

export async function copyVerifiedAppImage({ releaseDirectory, applicationsDirectory, version }) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("Versione AppImage non valida.");
  const filename = `Histeon-Publish-${version}-linux-x64.AppImage`;
  const source = path.join(releaseDirectory, filename);
  const target = path.join(applicationsDirectory, filename);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile()) throw new Error(`L’AppImage sorgente non è un file regolare: ${source}`);
  const expected = await readExpectedChecksum(releaseDirectory, filename);
  const sourceHash = await sha256File(source);
  if (sourceHash !== expected) throw new Error(`Checksum SHA-256 non valido per ${filename}.`);

  await mkdir(applicationsDirectory, { recursive: true });
  try {
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile()) throw new Error(`Il file di destinazione esiste ma non è un file regolare: ${target}`);
    const targetHash = await sha256File(target);
    if (targetHash === sourceHash) return { filename, target, sha256: sourceHash, copied: false };
    throw new Error(`Esiste già una versione diversa di ${filename}; non è stata sovrascritta.`);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  const temporaryDirectory = await mkdtemp(path.join(applicationsDirectory, `.${filename}.${randomUUID()}.`));
  const temporary = path.join(temporaryDirectory, filename);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o755);
    const temporaryHash = await sha256File(temporary);
    if (temporaryHash !== sourceHash) throw new Error(`La verifica della copia di ${filename} non è riuscita.`);
    await link(temporary, target);
    await rm(temporary, { force: true });
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      const targetInfo = await lstat(target).catch(() => null);
      if (targetInfo?.isFile() && await sha256File(target) === sourceHash) {
        return { filename, target, sha256: sourceHash, copied: false };
      }
      throw new Error(`Esiste già una versione diversa di ${filename}; non è stata sovrascritta.`);
    }
    throw error;
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
  return { filename, target, sha256: sourceHash, copied: true };
}

async function main() {
  const env = process.env;
  const { version } = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));
  const releaseDirectory = env.HISTOS_RELEASE_DIR
    ? path.resolve(rootDirectory, env.HISTOS_RELEASE_DIR)
    : await linuxReleaseDirectory(desktopDirectory, version);
  const applicationsDirectory = getApplicationsDirectory({ env });
  const result = await copyVerifiedAppImage({ releaseDirectory, applicationsDirectory, version });
  process.stdout.write(`${result.copied ? "Copiata" : "Già aggiornata"}: ${result.target}\nSHA-256: ${result.sha256}\n`);
}

// Run as a program, also through a symlink: node loads the module from its real path, argv keeps the one typed.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
