import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EXPECTED_PACKAGE_NAME = "histos-publish-local-addon";
const EXPECTED_SLUG = "histos-publish-local-addon";
const MAX_ENABLED_ADDONS_BYTES = 1024 * 1024;

export function getLinuxLocalUserDataDirectory(environment = process.env, homeDirectory = os.homedir()) {
  // A Linux path on every host the installer is tested on (POSIX separators, also on Windows CI).
  const configDirectory = environment.XDG_CONFIG_HOME || path.posix.join(homeDirectory, ".config");
  return path.posix.join(configDirectory, "Local");
}

function validateAddonManifest(manifest) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.name !== EXPECTED_PACKAGE_NAME ||
    manifest.slug !== EXPECTED_SLUG ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version) ||
    manifest.main !== "main.js" ||
    manifest.renderer !== "renderer.js"
  ) {
    throw new TypeError("Il pacchetto Histeon Publish per Local non ha un manifest valido.");
  }

  const files = manifest.files;
  const allowedFiles = new Set(["README.md", "icon.svg", "main.js", "renderer.js"]);
  if (
    !Array.isArray(files) ||
    files.length !== allowedFiles.size ||
    new Set(files).size !== files.length ||
    files.some((file) => !allowedFiles.has(file))
  ) {
    throw new TypeError("L’elenco dei file del pacchetto Local non è valido.");
  }
}

async function readEnabledAddons(filePath) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_ENABLED_ADDONS_BYTES) {
      throw new TypeError("Il registro degli add-on di Local non è un file regolare valido.");
    }
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Il registro degli add-on di Local non contiene un oggetto JSON.");
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function readSourceFiles(sourceDirectory, manifest) {
  const files = new Map();
  for (const name of ["package.json", ...manifest.files]) {
    const sourcePath = path.join(sourceDirectory, name);
    const info = await lstat(sourcePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new TypeError(`Il file dell’add-on non è regolare: ${name}.`);
    await access(sourcePath, constants.R_OK);
    files.set(name, await readFile(sourcePath));
  }
  return files;
}

function sameContents(left, right) {
  return createHash("sha256").update(left).digest("hex") === createHash("sha256").update(right).digest("hex");
}

async function targetMatches(targetDirectory, files) {
  try {
    const targetInfo = await lstat(targetDirectory);
    if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) return false;
    const entries = await readdir(targetDirectory);
    const expected = new Set(files.keys());
    if (entries.length !== expected.size || entries.some((entry) => !expected.has(entry))) return false;
    for (const [name, expectedBytes] of files) {
      const filePath = path.join(targetDirectory, name);
      const info = await lstat(filePath);
      if (info.isSymbolicLink() || !info.isFile() || !sameContents(await readFile(filePath), expectedBytes)) return false;
    }
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function stageFiles(stageDirectory, files) {
  await mkdir(stageDirectory, { mode: 0o700 });
  for (const [name, bytes] of files) await writeFile(path.join(stageDirectory, name), bytes, { mode: 0o600, flag: "wx" });
}

async function writeEnabledAddons(filePath, enabledAddons) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(enabledAddons, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function isLocalRunning(procDirectory = "/proc") {
  let entries;
  try {
    entries = await readdir(procDirectory);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const executable = await readlink(path.join(procDirectory, entry, "exe"));
      const normalized = executable.replaceAll("\\", "/");
      const basename = path.posix.basename(normalized).replace(/\s+\(deleted\)$/iu, "").toLowerCase();
      if (basename === "local" && /(?:^|\/)(?:Local|\.mount_Local[^/]*)(?:\/|$)/iu.test(normalized)) return true;
      if (/(?:^|\/)Local(?:-[^/]+)?\.AppImage(?:\s+\(deleted\))?$/iu.test(normalized)) return true;
    } catch {
      // Processes can exit between listing /proc and reading their executable.
    }
  }
  return false;
}

export async function installLocalAddon({
  addonSourceDirectory,
  localUserDataDirectory = getLinuxLocalUserDataDirectory(),
  checkLocalRunning = true,
  procDirectory = "/proc",
} = {}) {
  if (!addonSourceDirectory || !path.isAbsolute(addonSourceDirectory)) throw new TypeError("Indica la cartella sorgente assoluta dell’add-on.");
  if (!localUserDataDirectory || !path.isAbsolute(localUserDataDirectory)) throw new TypeError("Indica la cartella dati assoluta di Local.");
  if (checkLocalRunning && await isLocalRunning(procDirectory)) {
    throw new Error("Chiudi Local prima di aggiornare l’add-on. Riaprilo quando il comando ha terminato.");
  }

  const manifest = JSON.parse(await readFile(path.join(addonSourceDirectory, "package.json"), "utf8"));
  validateAddonManifest(manifest);
  const sourceFiles = await readSourceFiles(addonSourceDirectory, manifest);
  const localDataInfo = await lstat(localUserDataDirectory);
  if (localDataInfo.isSymbolicLink() || !localDataInfo.isDirectory()) {
    throw new TypeError("La cartella dati di Local non è una directory sicura.");
  }
  const addonsDirectory = path.join(localUserDataDirectory, "addons");
  const targetDirectory = path.join(addonsDirectory, manifest.slug);
  const enabledAddonsPath = path.join(localUserDataDirectory, "enabled-addons.json");
  const enabledAddons = await readEnabledAddons(enabledAddonsPath);
  enabledAddons[manifest.slug] = true;

  try {
    await lstat(addonsDirectory);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    await mkdir(addonsDirectory, { mode: 0o700 });
  }
  const addonsInfo = await lstat(addonsDirectory);
  if (addonsInfo.isSymbolicLink() || !addonsInfo.isDirectory()) throw new TypeError("La cartella degli add-on di Local non è una directory sicura.");
  if (await targetMatches(targetDirectory, sourceFiles)) {
    await writeEnabledAddons(enabledAddonsPath, enabledAddons);
    return { installed: false, enabled: true, version: manifest.version, targetDirectory };
  }

  const stageRoot = await mkdtemp(path.join(addonsDirectory, `.${manifest.slug}-stage-`));
  const stagedDirectory = path.join(stageRoot, manifest.slug);
  const oldTarget = await (async () => {
    try {
      const info = await lstat(targetDirectory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("La cartella add-on esistente non è una directory sicura: non è stata sostituita.");
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  })();
  const backupDirectory = oldTarget
    ? `${targetDirectory}.backup-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${process.pid}`
    : null;
  let backupCreated = false;
  let newTargetCreated = false;
  try {
    await stageFiles(stagedDirectory, sourceFiles);
    if (oldTarget && backupDirectory) {
      await rename(targetDirectory, backupDirectory);
      backupCreated = true;
    }
    await rename(stagedDirectory, targetDirectory);
    newTargetCreated = true;
    await writeEnabledAddons(enabledAddonsPath, enabledAddons);
    return {
      installed: true,
      enabled: true,
      version: manifest.version,
      targetDirectory,
      backupDirectory,
    };
  } catch (error) {
    if (newTargetCreated) await rm(targetDirectory, { recursive: true, force: true });
    if (backupCreated && backupDirectory) await rename(backupDirectory, targetDirectory);
    throw error;
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}
