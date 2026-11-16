import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";
import { NtExecutable, NtExecutableResource } from "resedit";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const desktopDirectory = path.resolve(scriptDirectory, "..");
export const rootDirectory = path.resolve(desktopDirectory, "../..");
export const releaseDirectory = process.env.HISTOS_RELEASE_DIR
  ? path.resolve(rootDirectory, process.env.HISTOS_RELEASE_DIR)
  : path.join(desktopDirectory, "release");
export const desktopPackage = JSON.parse(await readFile(path.join(desktopDirectory, "package.json"), "utf8"));

const sftpRuntimePackages = [
  { name: "ssh2", entries: ["lib", "util", "package.json", "LICENSE"] },
  { name: "asn1", entries: ["lib", "package.json", "LICENSE"] },
  { name: "safer-buffer", entries: ["safer.js", "package.json", "LICENSE"] },
];

export async function copySftpRuntimeDependencies(appContentDirectory, repositoryRoot = rootDirectory) {
  const nodeModulesDirectory = path.join(appContentDirectory, "node_modules");
  await mkdir(nodeModulesDirectory, { recursive: true });

  for (const dependency of sftpRuntimePackages) {
    const sourceDirectory = path.join(repositoryRoot, "node_modules", dependency.name);
    const destinationDirectory = path.join(nodeModulesDirectory, dependency.name);
    await mkdir(destinationDirectory, { recursive: true });
    for (const entry of dependency.entries) {
      await cp(path.join(sourceDirectory, entry), path.join(destinationDirectory, entry), {
        recursive: true,
        filter: (source) => !source.endsWith(".node"),
      });
    }
  }

  const bcryptSource = path.join(repositoryRoot, "packages/bcrypt-pbkdf");
  await cp(bcryptSource, path.join(nodeModulesDirectory, "bcrypt-pbkdf"), {
    recursive: true,
    filter: (source) => !source.endsWith(".node"),
  });

  // ssh2 treats CPU feature detection as optional. Shadow a host-level
  // cpu-features installation so Electron never loads a native addon built
  // for a different Node ABI; the library catches MODULE_NOT_FOUND and uses
  // its pure JavaScript/Node crypto path.
  const cpuFeaturesDirectory = path.join(nodeModulesDirectory, "ssh2/node_modules/cpu-features");
  await mkdir(cpuFeaturesDirectory, { recursive: true });
  await writeFile(path.join(cpuFeaturesDirectory, "index.js"), [
    'const error = new Error("Optional CPU acceleration is disabled in Histeon Publish.");',
    'error.code = "MODULE_NOT_FOUND";',
    "throw error;",
    "",
  ].join("\n"));
}

/**
 * The WebAssembly codecs of the image encoder (queue B6, packages/server/src/image-worker.ts IMAGE_CODEC_FILES), flat
 * in one folder with the licences of jSquash and of the libraries compiled into them. Only the single-threaded
 * builds the worker loads: the multi-threaded ones are for browsers.
 */
export const imageCodecFiles = [
  "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  "@jsquash/webp/codec/dec/webp_dec.wasm",
  "@jsquash/avif/codec/dec/avif_dec.wasm",
  "@jsquash/avif/codec/enc/avif_enc.wasm",
  "@jsquash/jxl/codec/enc/jxl_enc.wasm",
  "@jsquash/webp/codec/enc/webp_enc.wasm",
  "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm",
];
const imageCodecLicences = [
  ["@jsquash/avif/LICENSE", "jsquash-Apache-2.0.txt"],
  ["@jsquash/jpeg/codec/LICENSE.codec.md", "mozjpeg-IJG-BSD-3-Clause-Zlib.md"],
  ["@jsquash/webp/codec/LICENSE.codec.md", "libwebp-BSD-3-Clause.md"],
  ["@jsquash/png/codec/LICENSE.codec.md", "png-codec-licence.md"],
  ["@jsquash/resize/lib/resize/LICENSE.codec.md", "resize-MIT.md"],
  ["wasm-feature-detect/LICENSE", "wasm-feature-detect-Apache-2.0.txt"],
];

export async function copyImageCodecs(destination, repositoryRoot = rootDirectory) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.join(destination, "licenses"), { recursive: true });
  for (const file of imageCodecFiles) await cp(path.join(repositoryRoot, "node_modules", file), path.join(destination, path.basename(file)));
  for (const [source, name] of imageCodecLicences) await cp(path.join(repositoryRoot, "node_modules", source), path.join(destination, "licenses", name));
}

function asArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function embedWindowsAsarIntegrity(executablePath, archivePath) {
  const { headerString } = asar.getRawHeader(archivePath);
  const hash = createHash("sha256").update(headerString).digest("hex");
  const executableBytes = await readFile(executablePath);
  const executable = NtExecutable.from(executableBytes);
  const resources = NtExecutableResource.from(executable);
  const entry = Buffer.from(JSON.stringify([
    { file: "resources\\app.asar", alg: "sha256", value: hash },
  ]), "utf8");
  resources.entries.push({
    type: "INTEGRITY",
    id: "ELECTRONASAR",
    lang: 0x409,
    codepage: 1200,
    bin: asArrayBuffer(entry),
  });
  resources.outputResource(executable);
  await writeFile(executablePath, Buffer.from(executable.generate()));
}

export async function prepareElectronPackage(platform) {
  const expectedPlatform = platform === "win32" ? "win32" : "linux";
  if (process.platform !== expectedPlatform) {
    throw new Error(`Il pacchetto ${expectedPlatform} va costruito su ${expectedPlatform}; host attuale: ${process.platform}.`);
  }
  if (process.arch !== "x64") throw new Error(`È supportata solo l’architettura x64; host attuale: ${process.arch}.`);

  await mkdir(releaseDirectory, { recursive: true });
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), `histos-publish-${platform}-`));
  const stageDirectory = path.join(workDirectory, `HistosPublish-${platform}-x64`);
  const electronDirectory = path.join(rootDirectory, "node_modules/electron/dist");
  const appContentDirectory = path.join(workDirectory, "app-content");
  const resourcesDirectory = path.join(stageDirectory, "resources");
  const pagefindPlatform = platform === "win32" ? "windows" : "linux";
  const pagefindExecutable = platform === "win32" ? "pagefind_extended.exe" : "pagefind_extended";
  const executableName = platform === "win32" ? "Histos Publish.exe" : "histos-publish";
  const sourceExecutable = path.join(electronDirectory, platform === "win32" ? "electron.exe" : "electron");
  const executablePath = path.join(stageDirectory, executableName);
  const archivePath = path.join(resourcesDirectory, "app.asar");

  await rm(stageDirectory, { recursive: true, force: true });
  await cp(electronDirectory, stageDirectory, { recursive: true });
  await rename(sourceExecutable.replace(electronDirectory, stageDirectory), executablePath);
  await rm(path.join(resourcesDirectory, "default_app.asar"), { force: true });
  await rm(path.join(resourcesDirectory, "default_app"), { recursive: true, force: true });
  await rm(appContentDirectory, { recursive: true, force: true });
  await mkdir(path.join(appContentDirectory, "renderer"), { recursive: true });
  await mkdir(path.join(appContentDirectory, "node_modules"), { recursive: true });
  await copySftpRuntimeDependencies(appContentDirectory);
  await cp(path.join(rootDirectory, "node_modules/pagefind"), path.join(appContentDirectory, "node_modules/pagefind"), { recursive: true });
  await cp(path.join(desktopDirectory, "dist/main.js"), path.join(appContentDirectory, "main.js"));
  await cp(path.join(desktopDirectory, "dist/histos-publish-connector.mjs"), path.join(appContentDirectory, "histos-publish-connector.mjs"));
  await cp(path.join(desktopDirectory, "dist/preload.cjs"), path.join(appContentDirectory, "preload.cjs"));
  await cp(path.join(desktopDirectory, "dist/image-worker.js"), path.join(appContentDirectory, "image-worker.js"));
  await cp(path.join(desktopDirectory, "dist/image-codecs"), path.join(appContentDirectory, "image-codecs"), { recursive: true });
  await cp(path.join(desktopDirectory, "dist/renderer"), path.join(appContentDirectory, "renderer"), { recursive: true });
  if (existsSync(path.join(desktopDirectory, "dist/histos-wordpress-plugin.zip"))) {
    await cp(path.join(desktopDirectory, "dist/histos-wordpress-plugin.zip"), path.join(appContentDirectory, "histos-wordpress-plugin.zip"));
    await cp(path.join(desktopDirectory, "dist/histos-wordpress-plugin.zip.sha256"), path.join(appContentDirectory, "histos-wordpress-plugin.zip.sha256"));
  }
  await cp(path.join(rootDirectory, "node_modules/playwright-core"), path.join(appContentDirectory, "node_modules/playwright-core"), { recursive: true });
  // Doc 17 item 4: axe-core for the prototype check's hidden window (prototype-verify.ts reads it by its package path).
  for (const file of ["package.json", "axe.min.js", "LICENSE", "LICENSE-3RD-PARTY.txt", "locales/it.json"]) {
    await mkdir(path.dirname(path.join(appContentDirectory, "node_modules/axe-core", file)), { recursive: true });
    await cp(path.join(rootDirectory, "node_modules/axe-core", file), path.join(appContentDirectory, "node_modules/axe-core", file));
  }
  const pagefindDirectory = path.join(resourcesDirectory, "pagefind");
  await mkdir(pagefindDirectory, { recursive: true });
  const pagefindSource = path.join(rootDirectory, "node_modules/@pagefind", `${pagefindPlatform}-x64`, "bin", pagefindExecutable);
  const pagefindDestination = path.join(pagefindDirectory, pagefindExecutable);
  await cp(pagefindSource, pagefindDestination);
  if (platform === "linux") await chmod(pagefindDestination, 0o755);
  await cp(path.join(rootDirectory, "node_modules/zod/LICENSE"), path.join(appContentDirectory, "zod-LICENSE.txt"));
  await cp(path.join(rootDirectory, "LICENSE"), path.join(appContentDirectory, "LICENSE.txt"));
  await cp(path.join(desktopDirectory, "resources/THIRD-PARTY-NOTICES.md"), path.join(appContentDirectory, "THIRD-PARTY-NOTICES.md"));
  await cp(path.join(desktopDirectory, "resources/licenses"), path.join(appContentDirectory, "licenses"), { recursive: true });
  await writeFile(path.join(appContentDirectory, "package.json"), `${JSON.stringify({
    name: "histos-publish",
    version: desktopPackage.version,
    private: true,
    type: "module",
    main: "main.js",
  }, null, 2)}\n`);
  await asar.createPackageWithOptions(appContentDirectory, archivePath, { dot: true });

  if (platform === "win32") await embedWindowsAsarIntegrity(executablePath, archivePath);
  const fuseCount = await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: platform === "win32",
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  if (fuseCount < 1) throw new Error("Il binario Electron non contiene un fuse wire aggiornabile.");
  if (platform === "linux") {
    await chmod(executablePath, 0o755);
    const sandboxPath = path.join(stageDirectory, "chrome-sandbox");
    await chmod(sandboxPath, 0o4755).catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    });
  }

  return { workDirectory, stageDirectory, executablePath, archivePath, executableName };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Comando non riuscito (${result.status ?? "senza codice"}): ${command}`);
  return result;
}

export function createPackagedElectronTestEnvironment(executablePath, { appImage = false, env = {}, baseEnvironment = process.env } = {}) {
  const testEnvironment = { ...baseEnvironment };
  const explicitEnvironment = { ...env };
  delete testEnvironment.HISTOS_PUBLISH_TEST_USER_DATA_DIR;
  delete testEnvironment.HISTOS_PUBLISH_APPIMAGE;
  delete testEnvironment.APPIMAGE_EXTRACT_AND_RUN;
  delete explicitEnvironment.HISTOS_PUBLISH_APPIMAGE;
  delete explicitEnvironment.APPIMAGE_EXTRACT_AND_RUN;
  return {
    ...testEnvironment,
    ...explicitEnvironment,
    HISTOS_PUBLISH_ELECTRON_PATH: executablePath,
    ...(appImage ? { HISTOS_PUBLISH_APPIMAGE: "1", APPIMAGE_EXTRACT_AND_RUN: "1" } : {}),
  };
}

export function runPackagedElectronTest(executablePath, { appImage = false, env = {} } = {}) {
  const testScript = path.join(rootDirectory, "scripts/test-packaged-electron.mjs");
  // Desktop builds can use their active X server; CI/headless packaging gets a
  // private Xvfb display, matching the standalone Electron test runner.
  const useVirtualDisplay = process.platform === "linux" && !process.env.DISPLAY;
  const command = useVirtualDisplay ? "xvfb-run" : process.execPath;
  const args = useVirtualDisplay
    ? ["-a", process.execPath, testScript]
    : [testScript];
  // An AppImage unpacks itself under TMPDIR and leaves 360 MB there: here it goes in a folder of its own, removed after.
  const scratch = appImage ? mkdtempSync(path.join(os.tmpdir(), "histos-appimage-")) : null;
  try {
    run(command, args, {
      cwd: rootDirectory,
      env: { ...createPackagedElectronTestEnvironment(executablePath, { appImage, env }), ...(scratch ? { TMPDIR: scratch } : {}) },
    });
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Downloads (or reuses from a cache only the current user can write) a build tool with a pinned SHA-256, and returns a
 * private copy of the verified bytes inside privateDirectory (a mkdtemp directory). The tool is run and embedded from
 * that copy, so nothing can swap it between the hash check and its use.
 */
export async function downloadVerified(url, cachePath, expectedSha256, privateDirectory) {
  const cacheDirectory = path.dirname(cachePath);
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(cacheDirectory);
  const trustedCache = directory.isDirectory() && (typeof process.getuid !== "function" || directory.uid === process.getuid()) && (process.platform === "win32" || (directory.mode & 0o022) === 0);
  let data;
  if (trustedCache) {
    try {
      const cached = await lstat(cachePath);
      if (cached.isFile()) data = await readFile(cachePath);
    } catch { /* Cache non ancora presente. */ }
  }
  if (!data || createHash("sha256").update(data).digest("hex") !== expectedSha256) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download non riuscito (${response.status}): ${url}`);
    data = Buffer.from(await response.arrayBuffer());
    const actualSha256 = createHash("sha256").update(data).digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error(`Checksum errato per ${path.basename(cachePath)}: ${actualSha256}`);
    if (trustedCache) {
      const temporary = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temporary, data, { mode: 0o700, flag: "wx" });
      await rename(temporary, cachePath);
    }
  }
  const privateCopy = path.join(privateDirectory, path.basename(cachePath));
  await writeFile(privateCopy, data, { mode: 0o700, flag: "wx" });
  return privateCopy;
}
