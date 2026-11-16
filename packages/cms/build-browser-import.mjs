// Doc 18 F6: the importer for the WordPress administrator's browser, bundled with esbuild. The Node modules the
// project store and the transfer import become the small replacements in browser/shims (the same code runs; what a
// project in memory never needs is refused). SQLite for WebAssembly is not bundled: the plugin loads it as shipped
// (@sqlite.org/sqlite-wasm) and hands it to convertToXbsite.
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = (name) => path.join(here, "browser/shims", name);

export const browserImportBuild = {
  entryPoints: [path.join(here, "browser/html-import.ts")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  legalComments: "eof",
  alias: {
    "node:crypto": shim("node-crypto.ts"),
    "node:fs": shim("node-fs.ts"),
    "node:fs/promises": shim("node-fs.ts"),
    "node:path": shim("node-path.ts"),
    "node:net": shim("node-net.ts"),
    "node:zlib": shim("node-zlib.ts"),
    "node:sqlite": shim("refused.ts"),
    yazl: shim("refused.ts"),
    yauzl: shim("refused.ts"),
  },
  inject: [shim("buffer-global.ts")],
  define: { "process.env.NODE_ENV": '"production"' },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.join(here, "dist-browser");
  await mkdir(out, { recursive: true });
  await build({ ...browserImportBuild, outfile: path.join(out, "histos-html-import.js"), minify: true });
  const sqlite = path.join(here, "../../node_modules/@sqlite.org/sqlite-wasm/dist");
  for (const file of ["index.mjs", "sqlite3.wasm"]) await copyFile(path.join(sqlite, file), path.join(out, file === "index.mjs" ? "sqlite3.mjs" : file));
  await copyFile(path.join(here, "../../node_modules/@sqlite.org/sqlite-wasm/LICENSE.md"), path.join(out, "sqlite-wasm-LICENSE.md")).catch(() => undefined);
  process.stdout.write(`Importatore per il browser in ${out}\n`);
}
