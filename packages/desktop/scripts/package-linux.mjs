import { access, chmod, cp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  desktopDirectory,
  desktopPackage,
  downloadVerified,
  prepareElectronPackage,
  releaseDirectory,
  rootDirectory,
  run,
  runPackagedElectronTest,
} from "./package-runtime.mjs";
import { createAppRunScript } from "./linux-apprun.mjs";
import { createAppStreamMetainfo, validateAppStreamSettings } from "./appstream-metadata.mjs";

// List item 106: the packages are built in a temporary folder of their own, next to the release, not in /tmp: a
// full /tmp (a small tmpfs, or what other programs left) stopped the build halfway with an unclear error. The space
// is checked first and the message says how much is missing and where.
{
  const { mkdirSync, statfsSync } = await import("node:fs");
  // A short path: Chromium refuses a socket path over 108 characters, and the AppImage test nests folders in it.
  const buildTemporary = process.env.HISTOS_BUILD_TMPDIR || path.join(os.homedir(), ".cache", "histos-build");
  mkdirSync(buildTemporary, { recursive: true, mode: 0o700 });
  const stats = statfsSync(buildTemporary);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const neededBytes = 3 * 1024 ** 3;
  if (freeBytes < neededBytes) {
    console.error(`Spazio insufficiente per costruire i pacchetti: in ${buildTemporary} restano ${(freeBytes / 1024 ** 3).toFixed(1)} GB, ne servono almeno 3. Libera spazio o indica un'altra cartella con HISTOS_BUILD_TMPDIR.`);
    process.exit(1);
  }
  process.env.TMPDIR = buildTemporary;
}

const appImageTool = {
  version: "1.9.1",
  sha256: "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0",
  url: "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage",
};
const appImageRuntime = {
  version: "20251108",
  sha256: "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d",
  url: "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64",
};
const iconPath = path.join(desktopDirectory, "resources/histos-publish.svg");
// A per-user cache: a fixed name in the shared temporary directory could be created first by another account.
const toolDirectory = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "histos-publish", "appimage-tools");
const appImageToolPath = path.join(toolDirectory, `appimagetool-${appImageTool.version}-x86_64.AppImage`);
const appImageRuntimePath = path.join(toolDirectory, `runtime-${appImageRuntime.version}-x86_64`);
const debPackageName = `histos-publish_${desktopPackage.version}_amd64.deb`;
const appImageName = `Histeon-Publish-${desktopPackage.version}-linux-x64.AppImage`;
const appstreamKeys = ["HISTOS_APPSTREAM_ID", "HISTOS_APPSTREAM_HOMEPAGE", "HISTOS_DEB_MAINTAINER"];
const hasAppstreamSettings = appstreamKeys.some((key) => process.env[key] !== undefined);
const appstreamSettings = hasAppstreamSettings
  ? validateAppStreamSettings({
      id: process.env.HISTOS_APPSTREAM_ID,
      homepage: process.env.HISTOS_APPSTREAM_HOMEPAGE,
      maintainer: process.env.HISTOS_DEB_MAINTAINER,
      developerName: process.env.HISTOS_APPSTREAM_DEVELOPER_NAME,
    })
  : undefined;
const appstreamFileName = appstreamSettings ? `${appstreamSettings.id}.appdata.xml` : undefined;
const desktopFileName = appstreamSettings ? `${appstreamSettings.id}.desktop` : "histos-publish.desktop";
const desktopFile = `[Desktop Entry]\nType=Application\nName=Histeon Publish\nComment=Creazione e pubblicazione controllata di siti statici\nExec=histos-publish %U\nIcon=histos-publish\nTerminal=false\nCategories=Development;WebDevelopment;\nMimeType=x-scheme-handler/histos-publish;\nStartupWMClass=histos-publish\n`;
const appstreamDate = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000).toISOString().slice(0, 10)
  : new Date().toISOString().slice(0, 10);
const appstreamXml = appstreamSettings
  ? createAppStreamMetainfo({
      ...appstreamSettings,
      version: desktopPackage.version,
      releaseDate: appstreamDate,
      developerName: appstreamSettings.developerName,
    })
  : undefined;
const debMaintainer = appstreamSettings?.maintainer ?? "Histeon Publish <noreply@example.invalid>";

const packageApp = await prepareElectronPackage("linux");
try {
  const appDirectory = path.join(packageApp.workDirectory, "HistosPublish.AppDir");
  const appLibraryDirectory = path.join(appDirectory, "usr/lib/histos-publish");
  const debRoot = path.join(packageApp.workDirectory, "deb-root");
  const debPackageDirectory = path.join(debRoot, "debian/histos-publish");
  const debAppDirectory = path.join(debPackageDirectory, "opt/histos-publish");
  const debControlDirectory = path.join(debPackageDirectory, "DEBIAN");
  await mkdir(path.join(appDirectory, "usr/bin"), { recursive: true });
  await mkdir(path.join(appDirectory, "usr/share/applications"), { recursive: true });
  await mkdir(path.join(appDirectory, "usr/share/icons/hicolor/scalable/apps"), { recursive: true });
  await cp(packageApp.stageDirectory, appLibraryDirectory, { recursive: true });
  await symlink("../lib/histos-publish/histos-publish", path.join(appDirectory, "usr/bin/histos-publish"));
  await cp(iconPath, path.join(appDirectory, "histos-publish.svg"));
  await cp(iconPath, path.join(appDirectory, "usr/share/icons/hicolor/scalable/apps/histos-publish.svg"));
  await writeFile(path.join(appDirectory, desktopFileName), desktopFile);
  await cp(path.join(appDirectory, desktopFileName), path.join(appDirectory, "usr/share/applications", desktopFileName));
  if (appstreamXml && appstreamFileName) {
    const appstreamPath = path.join(appDirectory, "usr/share/metainfo", appstreamFileName);
    await mkdir(path.dirname(appstreamPath), { recursive: true });
    await writeFile(appstreamPath, appstreamXml, "utf8");
    // Validate the local metadata without fetching its homepage during a package build.
    run("appstreamcli", ["validate", "--pedantic", "--no-net", appstreamPath], { cwd: rootDirectory });
  }
  await writeFile(path.join(appDirectory, "AppRun"), createAppRunScript(), { mode: 0o755 });
  await chmod(path.join(appDirectory, "AppRun"), 0o755);

  // The private mkdtemp work directory holds the copies that are run and embedded.
  const privateTools = path.join(packageApp.workDirectory, "tools");
  await mkdir(privateTools, { mode: 0o700 });
  const toolPath = await downloadVerified(appImageTool.url, appImageToolPath, appImageTool.sha256, privateTools);
  const runtimePath = await downloadVerified(appImageRuntime.url, appImageRuntimePath, appImageRuntime.sha256, privateTools);
  // AppImage mounts are nosuid. Keep the setuid helper only in the .deb, where
  // dpkg installs its root-owned 04755 payload; AppRun below selects the
  // user-namespace sandbox or the documented compatibility fallback.
  await rm(path.join(appLibraryDirectory, "chrome-sandbox"), { force: true });
  const outputAppImage = path.join(releaseDirectory, appImageName);
  const temporaryAppImage = `${outputAppImage}.tmp`;
  await rm(temporaryAppImage, { force: true });
  // AppStream was validated above with --no-net; skip appimagetool's networked second check.
  run(toolPath, ["--runtime-file", runtimePath, "--no-appstream", appDirectory, temporaryAppImage], {
    cwd: rootDirectory,
    env: { ...process.env, ARCH: "x86_64", APPIMAGE_EXTRACT_AND_RUN: "1" },
  });
  await rename(temporaryAppImage, outputAppImage);

  await mkdir(debControlDirectory, { recursive: true });
  await mkdir(path.join(debPackageDirectory, "usr/bin"), { recursive: true });
  await mkdir(path.join(debPackageDirectory, "usr/share/applications"), { recursive: true });
  await mkdir(path.join(debPackageDirectory, "usr/share/icons/hicolor/scalable/apps"), { recursive: true });
  await cp(packageApp.stageDirectory, debAppDirectory, { recursive: true });
  await symlink("../../opt/histos-publish/histos-publish", path.join(debPackageDirectory, "usr/bin/histos-publish"));
  await cp(iconPath, path.join(debPackageDirectory, "usr/share/icons/hicolor/scalable/apps/histos-publish.svg"));
  await writeFile(path.join(debPackageDirectory, "usr/share/applications", desktopFileName), desktopFile);
  if (appstreamXml && appstreamFileName) {
    const debAppstreamPath = path.join(debPackageDirectory, "usr/share/metainfo", appstreamFileName);
    await mkdir(path.dirname(debAppstreamPath), { recursive: true });
    await writeFile(debAppstreamPath, appstreamXml, "utf8");
  }
  const sourceMetadata = [
    "Source: histos-publish",
    "Section: web",
    "Priority: optional",
    `Maintainer: ${debMaintainer}`,
    "Standards-Version: 4.6.0",
    "",
    "Package: histos-publish",
    "Architecture: any",
    "Description: Histeon Publish desktop application",
    " Creates static site bundles and prepares controlled Cloudflare deployments.",
    "",
  ].join("\n");
  await mkdir(path.join(debRoot, "debian"), { recursive: true });
  await writeFile(path.join(debRoot, "debian/control"), sourceMetadata);
  // dpkg-shlibdeps parses -e<path> as one option; a separate path becomes another executable.
  const dependencyResult = run("dpkg-shlibdeps", [
    "-O",
    "-edebian/histos-publish/opt/histos-publish/histos-publish",
    "-ldebian/histos-publish/opt/histos-publish",
  ], {
    cwd: debRoot,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const dependencyLine = dependencyResult.stdout.toString("utf8").match(/^shlibs:Depends=(.+)$/mu)?.[1];
  if (!dependencyLine) throw new Error("dpkg-shlibdeps non ha individuato le dipendenze del pacchetto Debian.");
  const binaryMetadata = [
    "Package: histos-publish",
    `Version: ${desktopPackage.version}`,
    "Section: web",
    "Priority: optional",
    "Architecture: amd64",
    `Maintainer: ${debMaintainer}`,
    `Depends: ${dependencyLine}`,
    "Description: Histeon Publish desktop application",
    " Creates static site bundles and prepares controlled Cloudflare deployments.",
    "",
  ].join("\n");
  await writeFile(path.join(debControlDirectory, "control"), binaryMetadata);
  const outputDeb = path.join(releaseDirectory, debPackageName);
  // `--compression-level=9` is not recognized by dpkg-deb 1.22 (Ubuntu 24.04);
  // the equivalent short option is supported by both 1.22 and newer releases.
  run("dpkg-deb", ["--build", "--root-owner-group", "--uniform-compression", "-z9", debPackageDirectory, outputDeb], {
    cwd: rootDirectory,
    env: { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? "0" },
  });
  run("dpkg-deb", ["--info", outputDeb], { cwd: rootDirectory });
  const debContents = run("dpkg-deb", ["--contents", outputDeb], {
    cwd: rootDirectory,
    stdio: ["ignore", "pipe", "inherit"],
  }).stdout.toString("utf8").split(/\r?\n/u);
  const sandboxEntry = debContents.find((line) => line.trimEnd().endsWith("./opt/histos-publish/chrome-sandbox"));
  const [sandboxMode, sandboxOwner] = sandboxEntry?.trim().split(/\s+/u) ?? [];
  if (sandboxMode !== "-rwsr-xr-x" || sandboxOwner !== "root/root") {
    throw new Error("Il .deb deve contenere chrome-sandbox con proprietario root:root e permessi 4755.");
  }
  if (appstreamSettings) {
    const desktopEntry = `./usr/share/applications/${desktopFileName}`;
    const metainfoEntry = `./usr/share/metainfo/${appstreamFileName}`;
    if (!debContents.some((line) => line.trimEnd().endsWith(desktopEntry))) {
      throw new Error(`Il .deb non contiene ${desktopEntry}.`);
    }
    if (!debContents.some((line) => line.trimEnd().endsWith(metainfoEntry))) {
      throw new Error(`Il .deb non contiene ${metainfoEntry}.`);
    }
  }

  if (process.env.HISTOS_SKIP_PACKAGED_TEST !== "1") {
    runPackagedElectronTest(packageApp.executablePath);
    const debExtractDirectory = path.join(packageApp.workDirectory, "deb-extracted-smoke");
    const debExecutablePath = path.join(debExtractDirectory, "opt/histos-publish/histos-publish");
    await mkdir(debExtractDirectory, { recursive: true });
    run("dpkg-deb", ["--extract", outputDeb, debExtractDirectory], { cwd: rootDirectory });
    await access(debExecutablePath);
    runPackagedElectronTest(debExecutablePath);
    runPackagedElectronTest(outputAppImage, { appImage: true });
  }
  process.stdout.write(`Pacchetti Linux pronti: ${outputDeb} e ${outputAppImage}\n`);
} finally {
  await rm(path.join(releaseDirectory, `${appImageName}.tmp`), { force: true });
  await rm(packageApp.workDirectory, { recursive: true, force: true });
}
