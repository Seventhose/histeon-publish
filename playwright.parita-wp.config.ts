import { defineConfig } from "@playwright/test";

// Doc 23, item 183: Publish's static build against the same pages on a test WordPress. No Publish server: the spec
// imports, sends and builds through the server's modules and serves the build itself. Without HISTOS_PARITY_WP_URL the
// test is skipped; `npm run test:parita-wp` starts a disposable WordPress and sets it (docs/PARITA-WP.md).
if (!process.env.HISTOS_PARITY_WP_URL?.trim()) {
  process.stdout.write("Prova di parità con WordPress saltata: manca HISTOS_PARITY_WP_URL. Lanciala con npm run test:parita-wp (docs/PARITA-WP.md).\n");
}

export default defineConfig({
  testDir: "./tests/e2e-wp",
  outputDir: "./test-results/parita-wp",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 600_000,
  expect: { timeout: 10_000 },
  use: {
    browserName: "chromium",
    headless: true,
    deviceScaleFactor: 1,
  },
});
