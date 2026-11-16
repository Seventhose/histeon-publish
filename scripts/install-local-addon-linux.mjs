import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLinuxLocalUserDataDirectory, installLocalAddon } from "./local-addon-installer.mjs";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = path.join(rootDirectory, "integrations", "local-addon-histos-publish");
const addonArchive = path.join(rootDirectory, "integrations");
const manifest = JSON.parse(await readFile(path.join(sourceDirectory, "package.json"), "utf8"));

if (process.platform !== "linux") throw new Error("L’installazione diretta evita il problema EXDEV su Linux. Su macOS e Windows usa Add-ons → Installed → Install from disk.");

console.log("Preparo il pacchetto Histeon Publish per Local…");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = spawnSync(npmCommand, ["run", "pack:local-addon"], {
  cwd: rootDirectory,
  env: { ...process.env, npm_config_cache: path.join(os.tmpdir(), "histos-publish-npm-cache") },
  stdio: "inherit",
});
if (packed.error) throw packed.error;
if (packed.status !== 0) process.exit(packed.status ?? 1);

const result = await installLocalAddon({
  addonSourceDirectory: sourceDirectory,
  localUserDataDirectory: getLinuxLocalUserDataDirectory(),
});
console.log(result.installed ? `Add-on ${result.version} installato.` : `Add-on ${result.version} già aggiornato.`);
console.log(`Local lo troverà qui: ${result.targetDirectory}`);
if (result.backupDirectory) console.log(`Copia precedente conservata in: ${result.backupDirectory}`);
console.log("Apri Local e controlla Add-ons → Installed. L’add-on è abilitato nel registro di Local.");
console.log(`Pacchetto .tgz per Install from disk: ${path.join(addonArchive, `Histeon-Publish-Local-Addon-${manifest.version}.tgz`)}`);
