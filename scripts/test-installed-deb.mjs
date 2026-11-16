import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPackagedElectronTest } from "../packages/desktop/scripts/package-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopPackage = JSON.parse(await readFile(path.join(root, "packages/desktop/package.json"), "utf8"));
const installed = spawnSync("dpkg-query", ["-W", "-f=${Status}\t${Version}", "histos-publish"], { encoding: "utf8" });
if (installed.error) throw installed.error;
if (installed.status !== 0) throw new Error("Il pacchetto histos-publish non risulta installato con dpkg.");
const [status, version] = installed.stdout.trim().split("\t");
if (status !== "install ok installed") throw new Error(`Stato dpkg inatteso: ${status ?? "sconosciuto"}.`);
if (version !== desktopPackage.version) {
  throw new Error(`Versione installata ${version ?? "sconosciuta"} diversa da quella attesa ${desktopPackage.version}.`);
}

const executable = "/usr/bin/histos-publish";
await access(executable, constants.X_OK);
runPackagedElectronTest(executable);
process.stdout.write(`Il .deb ${desktopPackage.version} è installato e supera lo smoke test Electron.\n`);
