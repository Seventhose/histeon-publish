import { main } from "./cli.js";

declare const __HP_VERSION__: string | undefined;

// The entry of dist/histos-publish-connector.mjs (build.mjs); never imported.
main(process.argv.slice(2), { version: typeof __HP_VERSION__ === "string" ? __HP_VERSION__ : "dev" }).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
