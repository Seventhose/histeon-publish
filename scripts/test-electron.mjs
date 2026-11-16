import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const args = [cli, "test", "--config", path.join(root, "playwright.electron.config.ts")];
const command = process.platform === "linux" ? "xvfb-run" : process.execPath;
const commandArgs = process.platform === "linux" ? ["-a", process.execPath, ...args] : args;
const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
