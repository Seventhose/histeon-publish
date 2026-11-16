import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream, realpathSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, "..");
const repositoryUrl = "https://github.com/Seventhose/xb.git";
const pluginEntries = ["xb.php", "uninstall.php", "blocks", "assets", "connector", "languages", "src"];

function git(repository, args, env = {}) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

async function addTree(zip, source, archiveBase, entries) {
  const items = await readdir(source, { withFileTypes: true });
  items.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const item of items) {
    const absolute = path.join(source, item.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Plugin source contains a symlink: ${absolute}`);
    const relativePath = `${archiveBase}/${item.name}`;
    if (info.isDirectory()) await addTree(zip, absolute, relativePath, entries);
    else if (info.isFile()) {
      if (info.size > 64 * 1024 * 1024) throw new Error(`Plugin file is larger than 64 MiB: ${relativePath}`);
      const bytes = await readFile(absolute);
      zip.addBuffer(bytes, relativePath, { mtime: new Date("2026-01-01T00:00:00.000Z"), mode: 0o644 });
      entries.push({ path: relativePath, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    } else throw new Error(`Plugin source contains a non-regular entry: ${absolute}`);
  }
}

export async function buildHistosWordPressPlugin(outputDirectory = path.join(rootDirectory, "packages/desktop/dist")) {
  // The plugin is packaged as it is in the builder repository (Seventhose/xb), at a committed state: the bridge
  // with Histeon CMS lives there (docs/spec/cms-bridge.md), no patch is applied on top.
  const repository = process.env.HISTOS_BUILDER_DIR?.trim();
  if (!repository) throw new Error("Set HISTOS_BUILDER_DIR to a checkout of the Histeon builder (Seventhose/xb).");
  const sourceCommit = git(repository, ["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("Could not read the Histeon builder commit.");
  if (git(repository, ["status", "--porcelain", "--", "plugin", "LICENSE"]).trim() !== "")
    throw new Error("The Histeon builder plugin has uncommitted changes: commit them before packaging.");

  const workDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-plugin-package-"));
  let packageDirectory;
  const outputArchive = path.join(outputDirectory, "histos-wordpress-plugin.zip");
  const temporaryArchive = path.join(outputDirectory, `.histos-wordpress-plugin-${process.pid}-${Date.now()}.zip.tmp`);
  const temporaryChecksum = `${outputArchive}.sha256.tmp`;
  const outputChecksum = `${outputArchive}.sha256`;
  try {
    const pluginDirectory = path.join(repository, "plugin");
    const header = await readFile(path.join(pluginDirectory, "xb.php"), "utf8");
    const version = /^\s*\*\s*Version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/mu.exec(header)?.[1];
    if (!version) throw new Error("Could not read the WordPress plugin version from plugin/xb.php.");
    const wordpressMinimum = /^\s*\*\s*Requires at least:\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*$/mu.exec(header)?.[1];
    const phpRequirement = /^\s*"php"\s*:\s*">=([0-9]+\.[0-9]+(?:\.[0-9]+)?)"/mu.exec(await readFile(path.join(pluginDirectory, "composer.json"), "utf8"))?.[1];
    if (!wordpressMinimum || !phpRequirement) throw new Error("Could not read the Histeon WordPress and PHP runtime requirements.");
    packageDirectory = await mkdtemp(path.join(workDirectory, "source-"));
    const outputPluginDirectory = path.join(packageDirectory, "xb");
    await mkdir(outputPluginDirectory, { recursive: true });

    for (const entry of pluginEntries) {
      const source = path.join(pluginDirectory, entry);
      const info = await lstat(source).catch(() => null);
      if (!info) throw new Error(`Required Histeon plugin source is missing: ${entry}`);
      if (info.isDirectory()) await cp(source, path.join(outputPluginDirectory, entry), { recursive: true, dereference: false, filter: async (from) => {
        const item = await lstat(from);
        if (item.isSymbolicLink()) throw new Error(`Plugin source contains a symlink: ${from}`);
        return true;
      } });
      else if (info.isFile()) await cp(source, path.join(outputPluginDirectory, entry));
      else throw new Error(`Required Histeon plugin source is not a regular file: ${entry}`);
    }

    const license = path.join(repository, "LICENSE");
    await cp(license, path.join(outputPluginDirectory, "LICENSE"));
    const provenance = {
      plugin: "Histeon",
      pluginVersion: version,
      license: "GPL-3.0-or-later",
      wordpressMinimum,
      phpMinimum: phpRequirement,
      sourceRepository: repositoryUrl,
      sourceCommit,
      notes: "This archive contains the plugin runtime source and built assets of the commit above. The development tests, PHPStan, Composer development vendor tree, and build tools are excluded.",
    };
    await writeFile(path.join(outputPluginDirectory, "SOURCE-PROVENANCE.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    // The notices of the third-party code bundled in the builder travel with it, as in the builder's own package.
    const notices = path.join(repository, "scripts", "third-party-licenses.mjs");
    if ((await lstat(notices).catch(() => null))?.isFile()) {
      execFileSync(process.execPath, [notices, path.join(outputPluginDirectory, "assets", "builder", "THIRD-PARTY-LICENSES.md")], { cwd: repository, stdio: ["ignore", "ignore", "inherit"] });
    }

    await mkdir(outputDirectory, { recursive: true });
    const zip = new yazl.ZipFile();
    const entries = [];
    await addTree(zip, outputPluginDirectory, "xb", entries);
    const entryManifest = Buffer.from(`${JSON.stringify({ format: "histos-wordpress-plugin-package", version: 1, pluginVersion: version, wordpressMinimum, phpMinimum: phpRequirement, sourceCommit, files: entries.sort((left, right) => left.path.localeCompare(right.path, "en")) }, null, 2)}\n`);
    zip.addBuffer(entryManifest, "histos-publish-manifest.json", { mtime: new Date("2026-01-01T00:00:00.000Z"), mode: 0o644 });
    zip.end();
    await new Promise((resolve, reject) => {
      const stream = createWriteStream(temporaryArchive, { mode: 0o600, flags: "wx" });
      zip.outputStream.on("error", reject);
      stream.on("error", reject);
      stream.on("finish", resolve);
      zip.outputStream.pipe(stream);
    });
    const archive = await readFile(temporaryArchive);
    const digest = createHash("sha256").update(archive).digest("hex");
    await rename(temporaryArchive, outputArchive);
    await writeFile(temporaryChecksum, `${digest}  histos-wordpress-plugin.zip\n`, { mode: 0o600, flag: "wx" });
    await rename(temporaryChecksum, outputChecksum);
    return { archivePath: outputArchive, sha256: digest, pluginVersion: version, sourceCommit, fileCount: entries.length };
  } finally {
    await rm(temporaryArchive, { force: true });
    await rm(temporaryChecksum, { force: true });
    await rm(workDirectory, { recursive: true, force: true });
  }
}

// Run as a program, also through a symlink: node loads the module from its real path, argv keeps the one typed.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = await buildHistosWordPressPlugin(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  process.stdout.write(`Histeon WordPress ${result.pluginVersion}: ${result.fileCount} file inclusi, SHA-256 ${result.sha256}\n${result.archivePath}\n`);
}
