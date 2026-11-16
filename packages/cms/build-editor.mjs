import { cp, mkdir, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertVendorSnapshot } from "./check-vendor-snapshot.mjs";

const cmsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(cmsDirectory, "../..");
const upstreamEditor = path.join(cmsDirectory, "vendor/histos/editor");
const upstreamTsconfig = path.join(cmsDirectory, "vendor/histos/tsconfig.base.json");
const generatedEditor = path.join(cmsDirectory, ".generated/histos-editor");
const generatedEditorConfig = path.join(cmsDirectory, ".generated/tsconfig.base.json");
const relativeGeneratedEditor = path.relative(repositoryRoot, generatedEditor).split(path.sep).join("/");
const relativePatch = "packages/cms/patches/histos/local-cms.patch";
const relativeFrameworkConfigPatch = "packages/cms/patches/histos/framework-config.patch";
// Patched files keep the bytes of the patch on every platform (Windows runners convert to CRLF otherwise).
const LF_ONLY = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"];
const viteCli = path.join(repositoryRoot, "node_modules/vite/bin/vite.js");
const viteConfig = path.join(cmsDirectory, "vite.histos.config.ts");

await assertVendorSnapshot();
await mkdir(path.dirname(generatedEditor), { recursive: true });
await rm(generatedEditor, { recursive: true, force: true });
await cp(upstreamEditor, generatedEditor, { recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules") });
await cp(upstreamTsconfig, generatedEditorConfig);
execFileSync("git", [...LF_ONLY, "apply", `--directory=${relativeGeneratedEditor}`, relativePatch], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
execFileSync("git", [...LF_ONLY, "apply", `--directory=${relativeGeneratedEditor}`, relativeFrameworkConfigPatch], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

const build = spawnSync(process.execPath, [viteCli, "build", "--config", viteConfig], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
