import { realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateAppStreamSettings } from "../packages/desktop/scripts/appstream-metadata.mjs";
import { getApplicationsDirectory } from "./copy-appimage-to-applications.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readLinuxReleaseSettings({ root = rootDirectory, env = process.env } = {}) {
  const configPath = env.HISTOS_RELEASE_METADATA_FILE
    ? path.resolve(root, env.HISTOS_RELEASE_METADATA_FILE)
    : path.join(root, ".histos-release-linux.json");
  let configured = {};
  try {
    configured = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw new Error("Il file di metadati release deve contenere un oggetto JSON.");
  const id = env.HISTOS_APPSTREAM_ID ?? configured.id;
  const homepage = env.HISTOS_APPSTREAM_HOMEPAGE ?? configured.homepage;
  const maintainer = env.HISTOS_DEB_MAINTAINER ?? configured.maintainer;
  const developerName = env.HISTOS_APPSTREAM_DEVELOPER_NAME ?? configured.developerName;
  if (id === undefined && homepage === undefined && maintainer === undefined) {
    throw new Error(`Manca ${path.basename(configPath)}. Copia docs/release-linux-metadata.example.json, inserisci homepage e contatto reali e riprova.`);
  }
  const settings = validateAppStreamSettings({
    id,
    homepage,
    maintainer,
    developerName,
  });
  return { ...settings, developerName, configPath };
}

export async function createLinuxReleasePlan({ root = rootDirectory, env = process.env, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "linux" || arch !== "x64") throw new Error("La release AppImage locale richiede Linux x64.");
  const releaseSettings = await readLinuxReleaseSettings({ root, env });
  const rootPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const desktopPackage = JSON.parse(await readFile(path.join(root, "packages/desktop/package.json"), "utf8"));
  if (rootPackage.version !== desktopPackage.version) throw new Error("Le versioni Publish e Desktop non coincidono.");
  const version = desktopPackage.version;
  const defaultReleaseRelative = path.posix.join("packages/desktop/release", version);
  const releaseSetting = env.HISTOS_RELEASE_DIR ?? defaultReleaseRelative;
  const releaseDirectory = path.resolve(root, releaseSetting);
  const relativeFromRoot = path.relative(root, releaseDirectory);
  const isInsideRoot = relativeFromRoot === "" ||
    (!relativeFromRoot.startsWith(`..${path.sep}`) && relativeFromRoot !== ".." && !path.isAbsolute(relativeFromRoot));
  const expectedRepositoryRelease = path.resolve(root, defaultReleaseRelative);
  if (isInsideRoot && releaseDirectory !== expectedRepositoryRelease) {
    throw new Error(`Per non mescolare file del progetto, una release interna deve usare ${defaultReleaseRelative}; per una cartella di prova usa un percorso esterno, per esempio /tmp/histos-publish-release-test.`);
  }
  const releaseRelative = isInsideRoot ? relativeFromRoot : releaseDirectory;
  const appImageName = `Histeon-Publish-${version}-linux-x64.AppImage`;
  const applicationsDirectory = getApplicationsDirectory({ env, platform });
  if (await exists(releaseDirectory)) throw new Error(`La cartella di release ${releaseRelative} esiste già; non verrà modificata.`);
  if (await exists(path.join(applicationsDirectory, appImageName))) {
    throw new Error(`In Documenti/Applicazioni esiste già ${appImageName}; incrementa la versione prima di rilasciare.`);
  }
  return { version, releaseRelative, releaseDirectory, applicationsDirectory, appImageName, releaseSettings };
}

export async function releaseLinux({ root = rootDirectory, env = process.env, spawn = spawnSync } = {}) {
  const plan = await createLinuxReleasePlan({ root, env });
  const appstream = spawn("appstreamcli", ["--version"], { stdio: "ignore" });
  if (appstream.error || appstream.status !== 0) throw new Error("Per la release Linux installa il comando appstreamcli del pacchetto AppStream della distribuzione.");
  const releaseEnvironment = {
    ...env,
    HISTOS_RELEASE_DIR: plan.releaseDirectory,
    HISTOS_APPSTREAM_ID: plan.releaseSettings.id,
    HISTOS_APPSTREAM_HOMEPAGE: plan.releaseSettings.homepage,
    HISTOS_DEB_MAINTAINER: plan.releaseSettings.maintainer,
    HISTOS_APPSTREAM_DEVELOPER_NAME: plan.releaseSettings.developerName,
  };
  const packageResult = spawn("npm", ["run", "dist:linux"], {
    cwd: root,
    stdio: "inherit",
    env: releaseEnvironment,
  });
  if (packageResult.error) throw packageResult.error;
  if (packageResult.status !== 0) throw new Error(`La build Linux è terminata con codice ${packageResult.status ?? "sconosciuto"}.`);

  const copyResult = spawn(process.execPath, [path.join(root, "scripts/copy-appimage-to-applications.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: releaseEnvironment,
  });
  if (copyResult.error) throw copyResult.error;
  if (copyResult.status !== 0) throw new Error(`La copia AppImage è terminata con codice ${copyResult.status ?? "sconosciuto"}. Gli artefatti restano in ${plan.releaseRelative}.`);
  return plan;
}

// Run as a program, also through a symlink: node loads the module from its real path, argv keeps the one typed.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  releaseLinux().then((plan) => {
    process.stdout.write(`Release Linux ${plan.version} pronta in ${plan.releaseRelative}/ e in Documenti/Applicazioni.\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
