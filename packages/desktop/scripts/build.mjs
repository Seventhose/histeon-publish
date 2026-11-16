import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildHistosWordPressPlugin } from "../../../scripts/package-histos-wordpress-plugin.mjs";
import { copyImageCodecs, copySftpRuntimeDependencies } from "./package-runtime.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(directory, "..");
const root = path.resolve(desktopDirectory, "../..");
const output = path.join(desktopDirectory, "dist");
const uiOutput = path.join(root, "packages/ui/dist");

/** The newest modification time under a folder (files only), or 0. */
async function newest(directory) {
  let latest = 0;
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile()) latest = Math.max(latest, (await stat(path.join(entry.parentPath ?? entry.path, entry.name))).mtimeMs);
  }
  return latest;
}

// The interface and the connector client are built by the root `npm run build`, not here: an app packaged with an
// older build of either would ship yesterday's screens or agent manual (Publish 1.22.0 to 1.24.0 did). Stop instead.
for (const [built, sources, what] of [
  [uiOutput, path.join(root, "packages/ui/src"), "l'interfaccia (packages/ui)"],
  [path.join(root, "packages/connector/dist"), path.join(root, "packages/connector/src"), "il connettore (packages/connector)"],
]) {
  if ((await newest(built)) < (await newest(sources))) throw new Error(`Per ${what} c'è una build più vecchia dei sorgenti: lancia npm run build dalla radice (o npm run dist:linux dalla radice, che lo fa).`);
}

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "renderer"), { recursive: true });
await build({
  entryPoints: [path.join(desktopDirectory, "src/main.ts")],
  outfile: path.join(output, "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // ssh2 ships CommonJS modules that rely on their own __dirname. Keep the
  // whole package external; package-runtime.mjs places its audited JS runtime
  // dependencies in app.asar/node_modules. Optional native accelerators are
  // deliberately omitted and ssh2 falls back to Node.js crypto.
  external: ["electron", "@napi-rs/keyring", "playwright-core", "pagefind", "ssh2", "cpu-features", "*.node"],
  banner: { js: "import { createRequire as __histosCreateRequire } from 'node:module'; const require = __histosCreateRequire(import.meta.url);" },
  sourcemap: false,
  legalComments: "none",
});
// The image encoder's worker thread (queue B6) is its own bundle next to main.js, which starts it by that name; its
// WebAssembly codecs are files in image-codecs/, read by the worker (asar reads work in Electron's worker threads).
await build({
  entryPoints: [path.join(root, "packages/server/src/image-worker.ts")],
  outfile: path.join(output, "image-worker.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: "import { createRequire as __histosCreateRequire } from 'node:module'; const require = __histosCreateRequire(import.meta.url);" },
  sourcemap: false,
  legalComments: "none",
});
await copyImageCodecs(path.join(output, "image-codecs"));
await build({
  entryPoints: [path.join(desktopDirectory, "src/preload.ts")],
  outfile: path.join(output, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: false,
  legalComments: "none",
});
await cp(uiOutput, path.join(output, "renderer"), { recursive: true });
// The AI connector client (one dependency-free file) ships next to main.js; the app copies it into the data folder.
await cp(path.join(root, "packages/connector/dist/histos-publish-connector.mjs"), path.join(output, "histos-publish-connector.mjs"));
// The desktop app does not ship a modified Histeon plugin. A development build can still include one for the
// WordPress provisioner, only when the developer points HISTOS_BUILDER_DIR at a checkout on purpose.
if (process.env.HISTOS_BUILDER_DIR?.trim()) await buildHistosWordPressPlugin(output);
await copySftpRuntimeDependencies(output);
process.stdout.write(`Desktop pronto in ${output}\n`);
