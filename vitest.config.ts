import { defineConfig } from "vitest/config";

// Doc 23 item 126: the agents' shell sets NODE_USE_SYSTEM_CA=1, the app does not. With it the tests trusted
// certificates the app refuses («fetch failed» in the app, green tests). The workers are started after this file
// runs and inherit its environment: without the variable they trust what the app trusts.
delete process.env.NODE_USE_SYSTEM_CA;

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    // The pinned upstream Histeon snapshot and its generated build copy are
    // inputs to the CMS, not independent workspace test suites. Their Svelte
    // component tests require the upstream editor's own Vite/Svelte setup.
    exclude: ["packages/cms/vendor/**", "packages/cms/.generated/**", "node_modules/**"],
    // Windows CI runners are several times slower on SQLite and file I/O than Linux.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
  },
});
