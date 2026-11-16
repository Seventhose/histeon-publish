import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { RENDER_NO_SANDBOX_ENV, createPlaywrightRenderSession, findSystemBrowser } from "../src/render-playwright.js";

const browser = await findSystemBrowser().catch(() => null);

describe.skipIf(!browser)("Playwright render isolation", () => {
  const connections: string[] = [];
  let listener: Server;
  afterAll(() => new Promise<void>((resolve) => { listener?.close(() => resolve()); }));

  it("keeps crawled script from reaching the network around fetchResource", async () => {
    listener = createServer((request, response) => { connections.push(`http ${request.url}`); response.end("reached"); });
    listener.on("upgrade", (request, socket) => { connections.push(`ws ${request.url}`); socket.destroy(); });
    listener.on("connection", () => connections.push("tcp"));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port;
    const html = `<!doctype html><html><body><p id="rtc"></p><script>
      document.getElementById("rtc").textContent = typeof RTCPeerConnection;
      try { new WebSocket("ws://127.0.0.1:${port}/socket"); } catch {}
      window.open("http://127.0.0.1:${port}/popup");
      fetch("http://127.0.0.1:${port}/fetch").catch(() => {});
      const frame = document.createElement("iframe"); frame.src = "http://127.0.0.1:${port}/frame"; document.body.append(frame);
    </script></body></html>`;
    const fetched: string[] = [];
    // Network isolation is what this test checks; a CI runner without user namespaces opts out of the OS sandbox.
    const session = await createPlaywrightRenderSession({ executablePath: browser ?? undefined }).catch(async (error: unknown) => {
      if ((error as { code?: string }).code !== "render-sandbox-unavailable") throw error;
      process.env[RENDER_NO_SANDBOX_ENV] = "1";
      try { return await createPlaywrightRenderSession({ executablePath: browser ?? undefined }); }
      finally { delete process.env[RENDER_NO_SANDBOX_ENV]; }
    });
    try {
      const rendered = await session.renderPage({
        url: "https://site.example/",
        timeoutMs: 20_000,
        maxBytes: 1024 * 1024,
        maxRequests: 50,
        signal: new AbortController().signal,
        fetchResource: async (url) => {
          fetched.push(url);
          if (url === "https://site.example/") return { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(html) };
          throw new Error("blocked by the crawl policy");
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(rendered.html).toContain('<p id="rtc">undefined</p>');
      // The loopback fetch and iframe reach fetchResource, which refuses them; nothing reaches the listener directly.
      expect(fetched).toContain(`http://127.0.0.1:${port}/fetch`);
      expect(connections).toEqual([]);
    } finally {
      await session.close();
    }
  }, 60_000);
});

describe("Playwright render browser environment", () => {
  it("drops secrets from the environment the crawl browser inherits", async () => {
    const { browserEnvironment } = await import("../src/render-playwright.js");
    expect(browserEnvironment({ PATH: "/usr/bin", HOME: "/home/u", LANG: "it_IT.UTF-8", HISTOS_CLOUDFLARE_API_TOKEN: "x", CLOUDFLARE_API_TOKEN: "x", GITHUB_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "x", DB_PASSWORD: "x", SSH_KEY: "x", API_KEY: "x", HISTOS_WP_COOKIE: "x" }))
      .toEqual({ PATH: "/usr/bin", HOME: "/home/u", LANG: "it_IT.UTF-8" });
  });
});

describe("Playwright render sandbox", () => {
  it("refuses to render when Chromium cannot start with its sandbox", async () => {
    await expect(createPlaywrightRenderSession({ executablePath: process.platform === "win32" ? "C:\\Windows\\System32\\where.exe" : "/bin/false" }))
      .rejects.toMatchObject({ code: "render-sandbox-unavailable" });
  });
});
