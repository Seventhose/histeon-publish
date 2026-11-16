import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [svelte({ compilerOptions: { runes: true } })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: { app: fileURLToPath(new URL("./index.html", import.meta.url)), cmsEditor: fileURLToPath(new URL("./cms-editor.html", import.meta.url)) } },
  },
  server: { host: "127.0.0.1" },
});
