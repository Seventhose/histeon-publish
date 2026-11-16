import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const editorRoot = fileURLToPath(new URL("./.generated/histos-editor/", import.meta.url));

export default defineConfig({
  root: editorRoot,
  plugins: [svelte()],
  resolve: {
    alias: {
      // The subpaths first: an alias also matches what starts with its name and a slash.
      "@xb/dsl/sheet": fileURLToPath(new URL("./vendor/histos/packages/dsl/src/sheet.ts", import.meta.url)),
      "@xb/dsl/scss": fileURLToPath(new URL("./vendor/histos/packages/dsl/src/scss.ts", import.meta.url)),
      "@xb/dsl": fileURLToPath(new URL("./vendor/histos/packages/dsl/src/index.ts", import.meta.url)),
      "@cms/css-resources": fileURLToPath(new URL("./src/css-resources.ts", import.meta.url)),
      "@cms/css-imports": fileURLToPath(new URL("./src/css-imports.ts", import.meta.url)),
      "@cms/core-framework-preset": fileURLToPath(new URL("./src/core-framework-preset.ts", import.meta.url)),
      "@cms/transfer-markup": fileURLToPath(new URL("./src/transfer-markup.ts", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../ui/public/histos-builder/", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL("./.generated/histos-editor/src/main.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "builder.js",
      cssFileName: "builder",
    },
  },
});
