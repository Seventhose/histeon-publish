import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copySftpRuntimeDependencies, createPackagedElectronTestEnvironment, desktopDirectory } from "./package-runtime.mjs";

test("il pacchetto SFTP include solo i runtime JS consentiti e il port BSD locale", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-sftp-runtime-"));
  const repositoryRoot = path.join(temporaryDirectory, "repo");
  const appContentDirectory = path.join(temporaryDirectory, "app-content");
  const put = async (relativePath, contents = "fixture") => {
    const filename = path.join(repositoryRoot, relativePath);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  };

  try {
    for (const packageName of ["ssh2", "asn1", "safer-buffer"]) {
      const allowedEntries = packageName === "ssh2"
        ? ["lib/index.js", "util/pagent.exe", "package.json", "LICENSE"]
        : packageName === "asn1"
          ? ["lib/index.js", "package.json", "LICENSE"]
          : ["safer.js", "package.json", "LICENSE"];
      for (const entry of allowedEntries) await put(`node_modules/${packageName}/${entry}`);
    }
    await put("node_modules/ssh2/lib/crypto/build/Release/sshcrypto.node");
    await put("packages/bcrypt-pbkdf/index.js");
    await put("packages/bcrypt-pbkdf/package.json", '{"name":"bcrypt-pbkdf"}');
    await put("packages/bcrypt-pbkdf/LICENSE");

    await copySftpRuntimeDependencies(appContentDirectory, repositoryRoot);

    for (const packageName of ["ssh2", "asn1", "safer-buffer", "bcrypt-pbkdf"]) {
      assert.ok(await readFile(path.join(appContentDirectory, "node_modules", packageName, "package.json")));
      assert.ok(await readFile(path.join(appContentDirectory, "node_modules", packageName, "LICENSE")));
    }
    assert.ok(await readFile(path.join(appContentDirectory, "node_modules/ssh2/util/pagent.exe")));
    assert.match(await readFile(path.join(appContentDirectory, "node_modules/ssh2/node_modules/cpu-features/index.js"), "utf8"), /MODULE_NOT_FOUND/u);
    await assert.rejects(readFile(path.join(appContentDirectory, "node_modules/ssh2/lib/crypto/build/Release/sshcrypto.node")), { code: "ENOENT" });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("il test Electron normale scarta i flag e il profilo utente ereditati", () => {
  const environment = createPackagedElectronTestEnvironment("/tmp/histos-publish", {
    baseEnvironment: {
      HISTOS_PUBLISH_TEST_USER_DATA_DIR: "/home/user/profile",
      HISTOS_PUBLISH_APPIMAGE: "1",
      APPIMAGE_EXTRACT_AND_RUN: "1",
    },
  });

  assert.equal(environment.HISTOS_PUBLISH_ELECTRON_PATH, "/tmp/histos-publish");
  assert.equal(Object.hasOwn(environment, "HISTOS_PUBLISH_TEST_USER_DATA_DIR"), false);
  assert.equal(Object.hasOwn(environment, "HISTOS_PUBLISH_APPIMAGE"), false);
  assert.equal(Object.hasOwn(environment, "APPIMAGE_EXTRACT_AND_RUN"), false);
});

test("il test Electron accetta solo il profilo esplicitamente passato dal packager", () => {
  const environment = createPackagedElectronTestEnvironment("Histos Publish.exe", {
    baseEnvironment: { HISTOS_PUBLISH_TEST_USER_DATA_DIR: "C:\\Users\\test\\profile" },
    env: { HISTOS_PUBLISH_TEST_USER_DATA_DIR: "C:\\Temp\\histos-profile" },
  });

  assert.equal(environment.HISTOS_PUBLISH_TEST_USER_DATA_DIR, "C:\\Temp\\histos-profile");
});

test("solo il test dell’AppImage attiva i flag specifici del formato", () => {
  const normal = createPackagedElectronTestEnvironment("histos-publish", { baseEnvironment: {} });
  const appImage = createPackagedElectronTestEnvironment("Histeon-Publish.AppImage", { appImage: true, baseEnvironment: {} });

  assert.equal(Object.hasOwn(normal, "HISTOS_PUBLISH_APPIMAGE"), false);
  assert.equal(Object.hasOwn(normal, "APPIMAGE_EXTRACT_AND_RUN"), false);
  assert.equal(appImage.HISTOS_PUBLISH_APPIMAGE, "1");
  assert.equal(appImage.APPIMAGE_EXTRACT_AND_RUN, "1");
});

test("l’ambiente esplicito del packager non reintroduce flag AppImage ereditati", () => {
  const environment = createPackagedElectronTestEnvironment("Histos Publish.exe", {
    baseEnvironment: {},
    env: {
      HISTOS_PUBLISH_TEST_USER_DATA_DIR: "C:\\Temp\\histos-profile",
      HISTOS_PUBLISH_APPIMAGE: "1",
      APPIMAGE_EXTRACT_AND_RUN: "1",
    },
  });

  assert.equal(environment.HISTOS_PUBLISH_TEST_USER_DATA_DIR, "C:\\Temp\\histos-profile");
  assert.equal(Object.hasOwn(environment, "HISTOS_PUBLISH_APPIMAGE"), false);
  assert.equal(Object.hasOwn(environment, "APPIMAGE_EXTRACT_AND_RUN"), false);
});

test("l’aggiornamento Windows verifica lo staging prima di spostare la copia corrente", async () => {
  const installer = await readFile(path.join(desktopDirectory, "installer/install.ps1"), "utf8");
  const extract = installer.indexOf("Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingDirectory");
  const validateExecutable = installer.indexOf('Join-Path $stagingDirectory "Histos Publish.exe"');
  const stopRunningApp = installer.indexOf('Get-Process -Name "Histos Publish"');
  const movePrevious = installer.indexOf("[System.IO.Directory]::Move($installDirectory, $previousDirectory)");
  const moveStaging = installer.indexOf("[System.IO.Directory]::Move($stagingDirectory, $installDirectory)");

  assert.ok(extract >= 0 && extract < validateExecutable);
  assert.ok(validateExecutable < stopRunningApp);
  assert.ok(stopRunningApp < movePrevious);
  assert.ok(movePrevious < moveStaging);
});

test("il setup Windows limita la destinazione e tenta il ripristino solo prima del commit", async () => {
  const installer = await readFile(path.join(desktopDirectory, "installer/install.ps1"), "utf8");

  assert.ok(installer.includes('Split-Path -Leaf $installDirectory) -ne "Histos Publish"'));
  assert.ok(installer.includes('Split-Path -Leaf $installParent) -ne "Programs"'));
  assert.ok(installer.includes("if ($newInstallMoved -and -not $installCommitted"));
  assert.ok(installer.includes("if ($previousInstallMoved -and -not $installCommitted"));
  assert.ok(installer.includes("[System.IO.Directory]::Move($previousDirectory, $installDirectory)"));
});

test("la disinstallazione Windows rifiuta una cartella che non termina con Programs\\Histos Publish", async () => {
  const uninstaller = await readFile(path.join(desktopDirectory, "installer/uninstall.ps1"), "utf8");
  const guard = uninstaller.indexOf('Split-Path -Leaf $installDirectory) -ne "Histos Publish"');
  const firstRemoval = uninstaller.indexOf("Remove-Item");

  assert.ok(guard >= 0 && guard < firstRemoval);
  assert.ok(uninstaller.includes('Split-Path -Leaf $installParent) -ne "Programs"'));
  assert.ok(uninstaller.slice(guard, firstRemoval).includes("exit 1"));
});

test("il packaging Windows prova reinstallazione, rifiuto ZIP corrotto e conservazione dati", async () => {
  const packager = await readFile(path.join(desktopDirectory, "scripts/package-windows.mjs"), "utf8");

  assert.equal((packager.match(/run\(installerOutput, \["\/Q:U"\]/gu) ?? []).length, 2);
  assert.ok(packager.includes('writeFile(path.join(corruptUpgradeDirectory, "histos-publish.zip"), "not a ZIP archive\\n"'));
  assert.ok(packager.includes("if (corruptUpgrade.status === 0)"));
  assert.ok(packager.includes('includes("histos-publish.zip")'));
  assert.ok(packager.includes("La disinstallazione ha modificato i dati utente"));
});

