import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { HistosPublishError } from "@histos-publish/core";
import { afterEach, describe, expect, it } from "vitest";
import { CmsRemoteCatalog, connectRemoteSite } from "../src/cms-remote.js";
import { checkExternalLinks, checkRemoteSiteInBrowser, externalLinks, linkOutcome, validatePreviewLinks, withoutTokens, type LinkProbe } from "../src/cms-remote-browser-check.js";
import type { OpenPageProbe, PageProbeInput } from "../src/prototype-verify.js";

/** V1.6, threat model T32: «Verifica nel browser» of «Controlla il sito WP», against a WordPress stand-in. */

const SITE = "https://sito.example";
const SIG = "a".repeat(64);
const token = (post: number) => `1900000000.${post}.1.as-guest.${SIG}`;
const entry = (post: number, page = `${SITE}/pagina-${post}/`) => ({ doc: `post:${post}`, title: `Pagina ${post}`, page, url: `${page}${page.includes("?") ? "&" : "?"}xb_preview=${token(post)}` });
const answer = (pages: unknown[], extra: Record<string, unknown> = {}) => ({ pages, skipped: 0, expires: 1_900_000_000, ...extra });

describe("validatePreviewLinks", () => {
  it("keeps the pages of the site with the one token, texts cut as the site's", () => {
    const links = validatePreviewLinks(answer([entry(5), { ...entry(6, `${SITE}/?page_id=6`), title: `Lunga‮ ${"x".repeat(300)}` }], { skipped: 3 }), SITE);
    expect(links.skipped).toBe(3);
    expect(links.pages.map((page) => page.page)).toEqual([`${SITE}/pagina-5/`, `${SITE}/?page_id=6`]);
    expect(links.pages[1]!.title.length).toBe(160);
    expect(links.pages[1]!.title).not.toContain("‮");
    expect(links.pages[0]!.url).toBe(`${SITE}/pagina-5/?xb_preview=${token(5)}`);
  });

  it.each([
    ["more than 20 pages", answer(Array.from({ length: 21 }, (_item, index) => entry(index + 1)))],
    ["another origin in page", answer([{ ...entry(5), page: "https://altro.example/pagina-5/" }])],
    ["another origin in url", answer([{ ...entry(5), url: `https://altro.example/pagina-5/?xb_preview=${token(5)}` }])],
    ["http instead of https", answer([{ ...entry(5), page: "http://sito.example/pagina-5/", url: `http://sito.example/pagina-5/?xb_preview=${token(5)}` }])],
    ["javascript address", answer([{ ...entry(5), url: "javascript:alert(1)" }])],
    ["credentials", answer([{ ...entry(5), url: `https://chi:pw@sito.example/pagina-5/?xb_preview=${token(5)}` }])],
    ["no token", answer([{ ...entry(5), url: `${SITE}/pagina-5/` }])],
    ["two tokens", answer([{ ...entry(5), url: `${SITE}/pagina-5/?xb_preview=${token(5)}&xb_preview=${token(5)}` }])],
    ["another parameter", answer([{ ...entry(5), url: `${SITE}/pagina-5/?xb_preview=${token(5)}&dove=altrove` }])],
    ["another path", answer([{ ...entry(5), url: `${SITE}/altra/?xb_preview=${token(5)}` }])],
    ["token in page", answer([{ ...entry(5), page: `${SITE}/pagina-5/?xb_preview=${token(5)}` }])],
    ["repeated page", answer([entry(5), entry(5)])],
    ["no pages", { skipped: 0, expires: 1 }],
    ["negative skipped", answer([], { skipped: -1 })],
  ])("refuses %s, without quoting an address", (_name, value) => {
    let error: unknown;
    try { validatePreviewLinks(value, SITE); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(HistosPublishError);
    expect((error as HistosPublishError).code).toBe("cms-remote-preview-links-invalid");
    expect((error as Error).message).not.toMatch(/xb_preview|sito\.example|altro\.example/u);
  });
});

describe("external links", () => {
  it("takes http(s) of another origin, without credentials, repeats or a preview token, at most 200", () => {
    const pages = [
      { page: "/a/", links: [`${SITE}/interno/`, "https://esterno.example/x#parte", "https://esterno.example/x", "mailto:chi@example.org", "https://chi:pw@esterno.example/", `https://social.example/condividi?u=${encodeURIComponent(`${SITE}/a/?xb_preview=${token(5)}`)}`, `https://altro.example/${SIG}`] },
      { page: "/b/", links: ["https://esterno.example/x", "http://10.0.0.1/", ...Array.from({ length: 250 }, (_item, index) => `https://molti.example/${index}`)] },
    ];
    const found = externalLinks(pages, SITE, [token(5)]);
    expect(found.links[0]).toEqual({ url: "https://esterno.example/x", pages: ["/a/", "/b/"] });
    expect(found.links.some((link) => /social|altro\.example|chi:pw|mailto|sito\.example/u.test(link.url))).toBe(false);
    expect(found.links).toHaveLength(200);
    expect(found.found).toBe(252);
  });

  it("classes each answer: 404 and 410 broken, 5xx and network unreachable, private untested, the rest fine", () => {
    expect(linkOutcome({ status: 404 })).toBe("broken");
    expect(linkOutcome({ status: 410 })).toBe("broken");
    expect(linkOutcome({ status: 503 })).toBe("unreachable");
    expect(linkOutcome({ status: 301 })).toBe("ok");
    expect(linkOutcome({ status: 200 })).toBe("ok");
    expect(linkOutcome({ status: 403 })).toBe("ok");
    expect(linkOutcome({ error: new HistosPublishError("privata", "crawl-private-network", 2) })).toBe("untested");
    expect(linkOutcome({ error: new HistosPublishError("dns", "crawl-dns-failed", 5) })).toBe("unreachable");
    expect(linkOutcome({ error: new HistosPublishError("tempo", "crawl-timeout", 5) })).toBe("unreachable");
    expect(linkOutcome({ error: new Error("ECONNRESET") })).toBe("unreachable");
  });

  it("probes 4 at a time, each within its time, with a fake client", async () => {
    let running = 0;
    let most = 0;
    const answers: Record<string, () => Promise<{ status: number }>> = {
      "https://rotto.example/": async () => ({ status: 404 }),
      "https://spostato.example/": async () => ({ status: 302 }),
      "https://giu.example/": async () => ({ status: 502 }),
      "http://10.0.0.1/": async () => { throw new HistosPublishError("privata", "crawl-private-network", 2); },
      "https://lento.example/": () => new Promise(() => undefined),
    };
    const probe: LinkProbe = async (url) => {
      running++;
      most = Math.max(most, running);
      try {
        return await (answers[url] ?? (async () => { await new Promise((done) => setTimeout(done, 5)); return { status: 200 }; }))();
      } finally {
        running--;
      }
    };
    const links = [...Object.keys(answers), ...Array.from({ length: 10 }, (_item, index) => `https://bene.example/${index}`)];
    const results = await checkExternalLinks(links, probe, { timeoutMs: 50 });
    expect(results.slice(0, 5).map((result) => result.outcome)).toEqual(["broken", "ok", "unreachable", "untested", "unreachable"]);
    expect(results.slice(5).every((result) => result.outcome === "ok")).toBe(true);
    expect(most).toBeLessThanOrEqual(4);
  });
});

describe("withoutTokens", () => {
  it("takes every token out of every text", () => {
    const value = withoutTokens({ a: [`a[href="${SITE}/x/?xb_preview=${token(5)}"]`, `fine ${token(5)}`, `x ${SIG}`, "xb_preview%3D123"], n: 3 }, [token(5)]);
    expect(JSON.stringify(value)).not.toContain(SIG);
    expect(JSON.stringify(value)).not.toContain("1900000000");
    expect(value.n).toBe(3);
  });
});

describe("checkRemoteSiteInBrowser", () => {
  const roots: string[] = [];
  const servers: Array<ReturnType<typeof createServer>> = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function site(previewLinks: boolean) {
    const state = { url: "", previewCalls: 0 };
    const server = createServer((request: IncomingMessage, response) => {
      const route = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("rest_route") ?? "";
      if (route === "/xb/v1/cms/v1/capabilities") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          contractVersion: 2, profile: "histos-static-page-v1", siteId: "de7d1687-bf53-4b1e-8d96-43391da110f0", projectId: null, projectName: "Sito",
          capabilities: { read: true, write: false, publish: false, profiles: ["histos-static-page-v1"], ...(previewLinks ? { previewLinks: true } : {}) },
        }));
        return;
      }
      if (route === "/xb/v1/cms/v1/preview-links") {
        state.previewCalls++;
        const page = `${state.url}/pagina/`;
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pages: [{ doc: "post:7", title: "Pagina", page, url: `${page}?xb_preview=${token(7)}` }], skipped: 2, expires: 1_900_000_000 }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    state.url = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-browser-check-"));
    roots.push(root);
    const catalog = new CmsRemoteCatalog(root);
    const secrets = new Map<string, Buffer>();
    const storeFor = (account: string) => ({ get: async () => secrets.get(account) ?? null, set: async (value: Buffer) => { secrets.set(account, value); }, delete: async () => { secrets.delete(account); } });
    const code = `histos-cms-1:${Buffer.from(JSON.stringify({ url: state.url, secret: Buffer.alloc(32, 7).toString("base64url"), scopes: { read: true, write: false, publish: false } })).toString("base64url")}`;
    const connection = await connectRemoteSite(code, catalog, storeFor);
    return { state, catalog, storeFor, connection };
  }

  it("opens the signed links on the site's origin only and reports without a token", async () => {
    const { state, catalog, storeFor, connection } = await site(true);
    const opened: Array<{ origin: string; site?: boolean }> = [];
    const visited: string[] = [];
    const openProbe: OpenPageProbe = async ({ origin, site: real }) => {
      opened.push({ origin, ...(real ? { site: real } : {}) });
      return {
        probe: async ({ url }: PageProbeInput) => {
          visited.push(url);
          // A page whose axe selector carries the signed address, as a link of the page may.
          return { width: 1440, scrollWidth: 1440, elements: [], broken: [], edges: [], violations: [{ id: "button-name", impact: "critical", help: "I pulsanti devono avere un testo distinguibile", helpUrl: "https://dequeuniversity.com/rules/axe/4.10/button-name", targets: [`a[href="${url}"] > button`] }], links: ["https://link-rotto.invalid/", "http://10.0.0.1/", `${state.url}/altra/`] };
        },
        close: async () => undefined,
      };
    };
    const probeLink: LinkProbe = async (url) => {
      if (url.startsWith("http://10.")) throw new HistosPublishError("privata", "crawl-private-network", 2);
      throw new HistosPublishError("dns", "crawl-dns-failed", 5);
    };
    const result = await checkRemoteSiteInBrowser({ connectionId: connection.id }, catalog, storeFor, { openProbe, axe: { source: "" }, probeLink });
    expect(state.previewCalls).toBe(1);
    expect(opened).toEqual([{ origin: state.url, site: true }]);
    expect(visited.every((url) => url.includes("xb_preview="))).toBe(true);
    expect(result.opened).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.pages).toEqual([{ doc: "post:7", title: "Pagina", page: `${state.url}/pagina/` }]);
    expect(result.axe.map((rule) => [rule.id, rule.pages])).toEqual([["button-name", ["/pagina/"]]]);
    expect(result.links.unreachable.map((link) => link.url)).toEqual(["https://link-rotto.invalid/"]);
    expect(result.links.untested.map((link) => link.url)).toEqual(["http://10.0.0.1/"]);
    expect(result.links.checked).toBe(2);
    const text = JSON.stringify(result);
    expect(text).not.toContain(SIG);
    expect(text).not.toMatch(/xb_preview=\d/u);
  });

  it("asks to update Histeon on a site without the preview links", async () => {
    const { catalog, storeFor, connection } = await site(false);
    const openProbe: OpenPageProbe = async () => { throw new Error("never"); };
    await expect(checkRemoteSiteInBrowser({ connectionId: connection.id }, catalog, storeFor, { openProbe, axe: { source: "" } })).rejects.toMatchObject({ code: "cms-remote-preview-links-unavailable" });
  });
});
