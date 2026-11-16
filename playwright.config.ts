import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { defineConfig } from "@playwright/test";

async function reserveEphemeralPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Non riesco a riservare una porta per Playwright.");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const port = Number(process.env.HISTOS_PUBLISH_E2E_PORT ?? await reserveEphemeralPort());
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Porta E2E non valida.");
const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), `histos-publish-e2e-${port}.json`);
process.env.HISTOS_PUBLISH_E2E_PORT = String(port);
process.env.HISTOS_PUBLISH_E2E_STATE = stateFile;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/e2e-serve.mjs",
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      HISTOS_PUBLISH_E2E_STATE: stateFile,
      HISTOS_PUBLISH_E2E_PORT: String(port),
    },
  },
});
