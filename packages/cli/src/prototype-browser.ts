import { access } from "node:fs/promises";
import { chromium, type Browser } from "playwright-core";
import { findSystemBrowser, HistosPublishError, launchCrawlBrowser } from "@histos-publish/core";
import type { OpenPageProbe } from "@histos-publish/server";

/**
 * Doc 17 item 4 in the CLI: the browser of `histos-publish prototype verify`. Chrome or Chromium of the system
 * (HISTOS_PUBLISH_BROWSER first), else the Chromium Playwright downloaded for the e2e tests; with its OS sandbox and
 * without this process's secrets, as the render mode (launchCrawlBrowser), here allowed to reach 127.0.0.1 only.
 */
export async function launchVerifyBrowser(): Promise<Browser> {
  let executablePath: string;
  try {
    executablePath = await findSystemBrowser();
  } catch {
    const downloaded = chromium.executablePath();
    if (!downloaded || !(await access(downloaded).then(() => true, () => false))) throw new HistosPublishError("prototype verify apre le pagine in un browser e non trovo Chrome o Chromium: installane uno oppure imposta HISTOS_PUBLISH_BROWSER col suo percorso.", "verify-browser-missing", 5);
    executablePath = downloaded;
  }
  return launchCrawlBrowser(executablePath, { loopback: true });
}

/**
 * The pages of one check in their own context of `browser`: requests to the bundle's server only (every other one
 * refused, WebSockets closed), no download, no service worker, no popup.
 */
export function playwrightPageProbe(browser: Browser): OpenPageProbe {
  return async ({ origin }) => {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
    try {
      await context.route("**/*", (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort("blockedbyclient")));
      await context.routeWebSocket(/.*/u, (socket) => { void socket.close({ code: 1008, reason: "blocked" }); });
      const page = await context.newPage();
      page.on("popup", (popup) => { void popup.close(); });
      return {
        probe: async ({ url, width, height, expression }) => {
          await page.setViewportSize({ width, height });
          await page.goto(url, { waitUntil: "load", timeout: 20_000 });
          return page.evaluate(expression);
        },
        close: () => context.close(),
      };
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  };
}
