import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import {
  desktopDirectory,
  desktopPackage,
  prepareElectronPackage,
  releaseDirectory,
  run,
  runPackagedElectronTest,
} from "./package-runtime.mjs";

const installerDirectory = path.join(desktopDirectory, "installer");
const installerName = `Histeon-Publish-${desktopPackage.version}-win-x64-setup.exe`;
const installerOutput = path.join(releaseDirectory, installerName);
const fixedArchiveTime = new Date("2000-01-01T00:00:00.000Z");

async function addDirectory(zip, directory, relativeDirectory = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      await addDirectory(zip, absolutePath, relativePath);
    } else if (entry.isFile()) {
      const fileStat = await stat(absolutePath);
      zip.addFile(absolutePath, relativePath, { mtime: fixedArchiveTime, mode: fileStat.mode & 0o777 });
    }
  }
}

async function createArchive(sourceDirectory, destination) {
  const zip = new yazl.ZipFile();
  await addDirectory(zip, sourceDirectory);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(destination));
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPath(targetPath, shouldExist, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(targetPath) === shouldExist) return;
    await wait(500);
  }
  throw new Error(`Verifica dell’installer scaduta: ${targetPath}`);
}

const packageApp = await prepareElectronPackage("win32");
const installerWorkDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-iexpress-"));
const smokeRoot = path.join(installerWorkDirectory, "smoke");
const smokeInstallDirectory = path.join(smokeRoot, "Programs", "Histos Publish");
const smokeLocalAppData = path.join(smokeRoot, "AppData", "Local");
const smokeRoamingAppData = path.join(smokeRoot, "AppData", "Roaming");
const smokeUserDataDirectory = path.join(smokeRoamingAppData, "histos-publish");
const smokeUserDataSentinel = path.join(smokeUserDataDirectory, "installer-preservation-check.txt");
let installerBuilt = false;
try {
  await cp(path.join(installerDirectory, "uninstall.ps1"), path.join(packageApp.stageDirectory, "uninstall.ps1"));
  const archivePath = path.join(installerWorkDirectory, "histos-publish.zip");
  await createArchive(packageApp.stageDirectory, archivePath);
  await cp(path.join(installerDirectory, "install.cmd"), path.join(installerWorkDirectory, "install.cmd"));
  await cp(path.join(installerDirectory, "install.ps1"), path.join(installerWorkDirectory, "install.ps1"));

  const installerScript = [
    "[Version]",
    "Class=IEXPRESS",
    "SEDVersion=3",
    "[Options]",
    "PackagePurpose=InstallApp",
    "ShowInstallProgramWindow=0",
    "HideExtractAnimation=1",
    "UseLongFileName=1",
    "InsideCompressed=1",
    "CAB_FixedSize=0",
    "CAB_ResvCodeSigning=0",
    "RebootMode=N",
    "InstallPrompt=%InstallPrompt%",
    "DisplayLicense=%DisplayLicense%",
    "FinishMessage=%FinishMessage%",
    "TargetName=%TargetName%",
    "FriendlyName=%FriendlyName%",
    "AppLaunched=%AppLaunched%",
    "PostInstallCmd=%PostInstallCmd%",
    "AdminQuietInstCmd=%AdminQuietInstCmd%",
    "UserQuietInstCmd=%UserQuietInstCmd%",
    "CheckAdminRights=0",
    "SourceFiles=SourceFiles",
    "[Strings]",
    "InstallPrompt=",
    "DisplayLicense=",
    "FinishMessage=",
    `TargetName="${installerOutput}"`,
    `FriendlyName=Histeon Publish ${desktopPackage.version}`,
    "AppLaunched=cmd.exe /c install.cmd",
    "PostInstallCmd=<None>",
    "AdminQuietInstCmd=cmd.exe /c install.cmd",
    "UserQuietInstCmd=cmd.exe /c install.cmd",
    'FILE0="histos-publish.zip"',
    'FILE1="install.cmd"',
    'FILE2="install.ps1"',
    "[SourceFiles]",
    `SourceFiles0="${installerWorkDirectory}"`,
    "[SourceFiles0]",
    "%FILE0%=",
    "%FILE1%=",
    "%FILE2%=",
    "",
  ].join("\r\n");
  const sedPath = path.join(installerWorkDirectory, "histos-publish.sed");
  await writeFile(sedPath, installerScript, "utf8");
  const iexpressPath = path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "iexpress.exe");
  run(iexpressPath, ["/N", "/Q", sedPath], { cwd: installerWorkDirectory });
  const signature = (await readFile(installerOutput)).subarray(0, 2).toString("ascii");
  if (signature !== "MZ") throw new Error("IExpress non ha creato un eseguibile Windows valido.");
  installerBuilt = true;

  await mkdir(path.join(smokeRoot, "Start Menu"), { recursive: true });
  await mkdir(path.join(smokeRoot, "Desktop"), { recursive: true });
  await mkdir(smokeUserDataDirectory, { recursive: true });
  await writeFile(smokeUserDataSentinel, "I dati utente devono restare dopo la disinstallazione.\n", "utf8");
  const smokeEnvironment = {
    ...process.env,
    LOCALAPPDATA: smokeLocalAppData,
    APPDATA: smokeRoamingAppData,
    HISTOS_PUBLISH_INSTALL_DIR: smokeInstallDirectory,
    HISTOS_PUBLISH_START_MENU_DIR: path.join(smokeRoot, "Start Menu", "Histos Publish"),
    HISTOS_PUBLISH_DESKTOP_DIR: path.join(smokeRoot, "Desktop"),
    HISTOS_PUBLISH_SILENT_INSTALL: "1",
    HISTOS_PUBLISH_TEST_USER_DATA_DIR: smokeUserDataDirectory,
  };
  run(installerOutput, ["/Q:U"], { cwd: installerWorkDirectory, env: smokeEnvironment });
  const installedExecutable = path.join(smokeInstallDirectory, "Histos Publish.exe");
  await waitForPath(installedExecutable, true);
  runPackagedElectronTest(installedExecutable, { env: smokeEnvironment });
  // Running the same installer over an existing install exercises the staged
  // replacement path used for normal updates, including backup recovery gates.
  run(installerOutput, ["/Q:U"], { cwd: installerWorkDirectory, env: smokeEnvironment });
  await waitForPath(installedExecutable, true);
  runPackagedElectronTest(installedExecutable, { env: smokeEnvironment });
  const corruptUpgradeDirectory = path.join(installerWorkDirectory, "corrupt-upgrade");
  await mkdir(corruptUpgradeDirectory, { recursive: true });
  await cp(path.join(installerDirectory, "install.ps1"), path.join(corruptUpgradeDirectory, "install.ps1"));
  await writeFile(path.join(corruptUpgradeDirectory, "histos-publish.zip"), "not a ZIP archive\n", "utf8");
  const corruptUpgrade = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(corruptUpgradeDirectory, "install.ps1")], {
    cwd: corruptUpgradeDirectory,
    encoding: "utf8",
    env: smokeEnvironment,
  });
  if (corruptUpgrade.error) throw corruptUpgrade.error;
  if (corruptUpgrade.status === 0) throw new Error("Il setup ha accettato un archivio di aggiornamento non valido.");
  if (!`${corruptUpgrade.stdout}\n${corruptUpgrade.stderr}`.includes("histos-publish.zip")) {
    throw new Error(`Il setup è fallito prima di verificare l'archivio corrotto previsto.\n${corruptUpgrade.stdout}\n${corruptUpgrade.stderr}`.trim());
  }
  await waitForPath(installedExecutable, true);
  const installParentEntries = await readdir(path.dirname(smokeInstallDirectory));
  if (installParentEntries.some((name) => name.endsWith(".installing") || name.endsWith(".previous"))) {
    throw new Error("Il setup ha lasciato una cartella temporanea di transazione dopo il rifiuto dell'archivio corrotto.");
  }
  runPackagedElectronTest(installedExecutable, { env: smokeEnvironment });
  const uninstallScript = path.join(smokeInstallDirectory, "uninstall.ps1");
  run("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", uninstallScript, "-Quiet"], { env: smokeEnvironment });
  await waitForPath(smokeInstallDirectory, false, 15_000);
  const preservedUserData = await readFile(smokeUserDataSentinel, "utf8");
  if (preservedUserData !== "I dati utente devono restare dopo la disinstallazione.\n") {
    throw new Error("La disinstallazione ha modificato i dati utente nella cartella AppData di prova.");
  }
  process.stdout.write(`Installer Windows pronto e verificato: ${installerOutput}\n`);
} finally {
  if (installerBuilt && existsSync(path.join(smokeInstallDirectory, "uninstall.ps1"))) {
    spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(smokeInstallDirectory, "uninstall.ps1"), "-Quiet"], {
      stdio: "ignore",
      env: { ...process.env, HISTOS_PUBLISH_INSTALL_DIR: smokeInstallDirectory, HISTOS_PUBLISH_START_MENU_DIR: path.join(smokeRoot, "Start Menu", "Histos Publish"), HISTOS_PUBLISH_DESKTOP_DIR: path.join(smokeRoot, "Desktop") },
    });
  }
  await rm(smokeRoot, { recursive: true, force: true });
  await rm(installerWorkDirectory, { recursive: true, force: true });
  await rm(packageApp.workDirectory, { recursive: true, force: true });
}
