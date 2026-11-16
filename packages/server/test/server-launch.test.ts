import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalServer } from "../src/server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe("browser launch handoff", () => {
  it("opens the browser with a one-time code instead of the session token", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-launch-"));
    let opened = "";
    const server = await startLocalServer({ dataDirectory, port: 0, openBrowser: true, launchBrowser: async (url) => { opened = url; } });
    cleanups.push(async () => { await server.close(); await rm(dataDirectory, { recursive: true, force: true, maxRetries: 5 }); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(opened).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#launch=[A-Za-z0-9_-]{43}$/u);
    expect(opened).not.toContain(server.token);
    const origin = `http://127.0.0.1:${server.port}`;
    const code = new URL(opened).hash.slice("#launch=".length);
    const redeem = (headers: Record<string, string>) => fetch(`${origin}/__session/launch`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ code }) });
    expect((await redeem({ Origin: "https://evil.example" })).status).toBe(403);
    const first = await redeem({ Origin: origin });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ token: server.token });
    expect((await redeem({ Origin: origin })).status).toBe(401);
  });
});
