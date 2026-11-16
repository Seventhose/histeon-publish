import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addonDir = path.join(rootDir, "integrations", "local-addon-histos-publish");
const outputDir = path.join(rootDir, "integrations");
const manifest = JSON.parse(readFileSync(path.join(addonDir, "package.json"), "utf8"));
const targetPath = path.join(outputDir, `Histeon-Publish-Local-Addon-${manifest.version}.tgz`);
const generatedPath = path.join(outputDir, `${manifest.name}-${manifest.version}.tgz`);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = spawnSync(npm, ["pack", "--pack-destination", outputDir], {
  cwd: addonDir,
  env: { ...process.env, npm_config_cache: path.join(os.tmpdir(), "histos-publish-npm-cache") },
  stdio: "inherit",
});

if (packed.error) throw packed.error;
if (packed.status !== 0) process.exit(packed.status ?? 1);
if (!existsSync(generatedPath)) throw new Error(`Archivio npm non trovato: ${generatedPath}`);
if (generatedPath !== targetPath) {
  rmSync(targetPath, { force: true });
  renameSync(generatedPath, targetPath);
}

console.log(`Pacchetto Local creato: ${path.relative(rootDir, targetPath)}`);
