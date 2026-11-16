import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBundle } from "../src/bundle.js";
import { crawlSite, detectOnlineSite } from "../src/crawler.js";
import { rewriteCrawledHtml } from "../src/crawler-html.js";
import { underExternalAsset } from "../src/crawler-http.js";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "/");
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Il server di prova non ha una porta.");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": type, ...headers });
  response.end(body);
}

function wordpressFixture(): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (path === "/robots.txt") return send(response, 200, "text/plain", "User-agent: *\nDisallow: /private/\nSitemap: /sitemap.xml\n");
    if (path === "/wp-content/static-bridge/") return send(response, 403, "text/plain", "Access denied");
    if (path === "/sitemap.xml") return send(response, 200, "application/xml", `<?xml version="1.0"?><urlset><url><loc>http://${request.headers.host}/product/</loc></url></urlset>`);
    if (path === "/wp-json/") return send(response, 200, "application/json", JSON.stringify({ namespaces: ["wp/v2"] }));
    if (path === "/wp-json/wp/v2/types") return send(response, 200, "application/json", JSON.stringify({ post: { rest_base: "posts", viewable: true } }));
    if (path === "/wp-json/wp/v2/taxonomies") return send(response, 200, "application/json", JSON.stringify({}));
    if (path === "/wp-json/wp/v2/posts") return send(response, 200, "application/json", JSON.stringify([{ link: `http://${request.headers.host}/about/` }]), { "X-WP-TotalPages": "1" });
    if (path === "/favicon.ico") return send(response, 200, "image/x-icon", Buffer.from([0, 1, 2]));
    if (path === "/assets/hero.png" || path === "/assets/hero@2.png" || path === "/assets/bg.png") return send(response, 200, "image/png", Buffer.from([1, 2, 3]));
    if (path === "/assets/main.css") return send(response, 200, "text/css", '@import "./fonts.css"; .hero { background: url("./bg.png") }');
    if (path === "/manifest.json") return send(response, 200, "application/manifest+json", JSON.stringify({ name: "Demo", start_url: "/", icons: [{ src: "/assets/hero.png", sizes: "192x192" }] }));
    if (path === "/assets/fonts.css") return send(response, 200, "text/css", '@font-face { font-family: demo; src: url("./font.woff2") format("woff2") }');
    if (path === "/assets/font.woff2") return send(response, 200, "font/woff2", Buffer.from([9, 8, 7]));
    if (path === "/old") { response.writeHead(301, { Location: "/about/" }); return response.end(); }
    if (path === "/temporary") { response.writeHead(302, { Location: "/about/" }); return response.end(); }
    if (path === "/about/") return send(response, 200, "text/html", `<!doctype html><html><head><title>About</title><link rel="stylesheet" href="/assets/main.css"><meta property="og:image" content="/assets/hero.png"></head><body><img src="/assets/hero.png" srcset="/assets/hero.png 1x, /assets/hero@2.png 2x"><a href="/temporary">temporary</a><div class="wpcf7"><form action="/wp-json/contact-form-7/v1/feedback"><input name="email"></form></div></body></html>`);
    if (path === "/product/") return send(response, 200, "text/html", '<!doctype html><html><head><title>Product</title></head><body class="product woocommerce"><a class="add_to_cart_button" href="/?add-to-cart=4">Acquista</a><form action="/cart/" method="post"></form><a href="/my-account/">Account</a></body></html>');
    if (path === "/") {
      const etag = '"home-v1"';
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { ETag: etag });
        return response.end();
      }
      return send(response, 200, "text/html", '<!doctype html><html><head><meta name="generator" content="WordPress 6.9"><link rel="https://api.w.org/" href="/wp-json/"><link rel="canonical" href="http://127.0.0.1/"><link rel="stylesheet" href="/assets/main.css"><link rel="manifest" href="/manifest.json"><meta property="og:url" content="http://127.0.0.1/"><meta property="og:image" content="/assets/hero.png"></head><body class="home wp-home woocommerce"><a href="/about/">About</a><a href="/old">Old</a><a href="/private/">Private</a><a href="/product/">Product</a><a href="/temporary">Temporary</a><script type="application/ld+json">{"@type":"WebSite","url":"http://127.0.0.1/"}</script></body></html>', { ETag: etag, Link: '<http://127.0.0.1/wp-json/>; rel="https://api.w.org/"' });
    }
    if (path === "/private/") return send(response, 200, "text/html", "<!doctype html><html><body>Private</body></html>");
    return send(response, 404, "text/plain", "not found");
  };
}

async function serveStaticFixture(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/redirect-permanent") {
    response.writeHead(301, { Location: "/about/" });
    response.end();
    return;
  }
  if (url.pathname === "/redirect-temporary") {
    response.writeHead(302, { Location: "/about/" });
    response.end();
    return;
  }
  if (url.pathname === "/missing") {
    send(response, 404, "text/html; charset=utf-8", "<!doctype html><title>404 di prova</title>");
    return;
  }
  // Two URLs that differ only by case, served from memory: Windows and macOS checkouts cannot hold both files.
  const caseVariants: Record<string, string> = {
    "/assets/images/Photo.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><text x="0" y="1">A</text></svg>\n',
    "/assets/images/photo.svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><text x="0" y="1">a</text></svg>\n',
  };
  const caseVariant = caseVariants[url.pathname];
  if (caseVariant !== undefined) {
    send(response, 200, "image/svg+xml", caseVariant);
    return;
  }
  const root = path.resolve(process.cwd(), "test-sites/static");
  const relative = url.pathname === "/" ? "index.html" : url.pathname.endsWith("/") ? `${url.pathname.slice(1)}index.html` : url.pathname.slice(1);
  const target = path.resolve(root, decodeURIComponent(relative));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    send(response, 400, "text/plain", "bad path");
    return;
  }
  let bytes: Buffer;
  try { bytes = await readFile(target); }
  catch { send(response, 404, "text/plain", "not found"); return; }
  const extension = path.extname(target).toLowerCase();
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
    ".xml": "application/xml",
  };
  send(response, 200, types[extension] ?? "application/octet-stream", bytes, { ETag: `"${bytes.byteLength.toString(16)}-${bytes.subarray(0, 12).toString("hex")}"` });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("crawler HTTP", () => {
  it("la modalità catalogo mantiene gli acquisti sul negozio originale", () => {
    const result = rewriteCrawledHtml('<!doctype html><html><body><a class="button add_to_cart_button" href="/?add-to-cart=42">Aggiungi al carrello</a><form class="cart" method="post"><button name="add-to-cart" value="43">Acquista</button></form><a href="/cart/">Carrello</a></body></html>', {
      pageUrl: "https://shop.example/prodotto/fixture/",
      outputPath: "prodotto/fixture/index.html",
      sourceOrigin: "https://shop.example",
      destinationOrigin: "https://static.example",
      filesByUrl: new Map(),
      wooCommerceCatalog: true,
    });
    expect(result).toContain("https://shop.example/prodotto/fixture/?add-to-cart=42");
    expect(result).toContain("https://shop.example/prodotto/fixture/?add-to-cart=43");
    expect(result).toContain('href="https://shop.example/cart/"');
    expect(result).not.toContain("<form");
    expect(result).toContain("Acquista sul sito originale");
  });

  it("copia un sito statico con risorse annidate, redirect e collisioni senza eseguire la SPA", async () => {
    const site = await listen((request, response) => { void serveStaticFixture(request, response); });
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-static-cache-"));
    temporaryDirectories.push(cacheDirectory);
    const detection = await detectOnlineSite({ sourceUrl: site.url, crawlConsent: new URL(site.url).origin, delayMs: 0 });
    expect(detection.engine).toBe("generic");
    expect(site.requests).toEqual(["/robots.txt", "/"]);
    const result = await crawlSite({ sourceUrl: site.url, crawlConsent: new URL(site.url).origin, crawl: { concurrency: 1, delayMs: 0, maxPages: 100 }, cacheDirectory });
    const files = new Map(result.files.map((file) => [file.path, file.bytes.toString("utf8")]));
    expect(result.report.engine).toBe("generic");
    expect(result.report.pagesDownloaded).toBeGreaterThanOrEqual(4);
    expect(result.report.pagesSkipped.some((url) => url.includes("/missing"))).toBe(true);
    expect(result.redirects).toContainEqual({ from: "/redirect-permanent", to: "/about/", status: 301 });
    expect(result.findings.some((finding) => finding.code === "temporary-redirect" || finding.code === "redirect-temporary")).toBe(true);
    expect(files.get("404.html")).toContain("Errore 404 personalizzato");
    expect(files.get("assets/css/main.css")).toContain("theme.css");
    expect(files.get("assets/css/theme.css")).toContain("fixture.woff2");
    expect(files.has("assets/fonts/fixture.woff2")).toBe(true);
    expect(files.has("assets/images/lazy.svg")).toBe(true);
    expect(files.has("manifest.webmanifest")).toBe(true);
    expect(files.get("manifest.webmanifest")).toContain("assets/images/hero.svg");
    const caseCollisionImages = [...files.entries()].filter(([, contents]) => /<text x="0" y="1">[Aa]<\/text>/u.test(contents));
    expect(caseCollisionImages).toHaveLength(2);
    expect(caseCollisionImages.some(([, contents]) => contents.includes(">A<"))).toBe(true);
    expect(caseCollisionImages.some(([, contents]) => contents.includes(">a<"))).toBe(true);
    expect(files.get("spa/index.html")).toContain("Contenuto iniziale");
    expect(files.get("spa/index.html")).not.toContain("Questo testo viene inserito dal JavaScript");
    expect(site.requests.some((request) => request.startsWith("/about/?"))).toBe(false);
    expect(site.requests).toContain("/missing");
  });

  it("usa il renderer isolato iniettato e registra risorse e API della SPA", async () => {
    const site = await listen((request, response) => {
      if (request.url === "/robots.txt") return send(response, 404, "text/plain", "not found");
      if (request.url === "/assets/hero.svg") return send(response, 200, "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>hero</text></svg>");
      if (request.url === "/assets/late.svg") return send(response, 200, "image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>late</text></svg>");
      if (request.url === "/api/data") return send(response, 200, "application/json", "{\"message\":\"live\"}");
      if (request.url === "/") return send(response, 200, "text/html", "<!doctype html><html><body><div id=\"app\"></div><script src=\"/assets/app.js\"></script></body></html>");
      if (request.url === "/assets/app.js") return send(response, 200, "text/javascript", "document.querySelector('#app').textContent = 'non eseguito dal crawler statico';");
      return send(response, 404, "text/plain", "not found");
    });
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-render-cache-"));
    temporaryDirectories.push(cacheDirectory);
    let fetchedByRenderer = false;
    const result = await crawlSite({
      sourceUrl: site.url,
      crawlConsent: new URL(site.url).origin,
      crawl: { concurrency: 1, delayMs: 0, maxPages: 20, render: true },
      cacheDirectory,
      renderPage: async (context) => {
        const response = await context.fetchResource(new URL("/assets/hero.svg", context.url).href, 1024);
        fetchedByRenderer = response.status === 200 && response.body.toString("utf8").includes("hero");
        return {
          html: "<!doctype html><html lang=\"it\"><head><title>SPA resa</title></head><body><main><h1>Contenuto renderizzato</h1><img src=\"/assets/hero.svg\"></main></body></html>",
          finalUrl: context.url,
          requests: [
            { url: new URL("/assets/hero.svg", context.url).href, type: "image" },
            { url: new URL("/api/data", context.url).href, type: "fetch" },
            // Loaded only by the browser, named as Playwright names it (lowercase): it must still become an asset.
            { url: new URL("/assets/late.svg", context.url).href, type: "image" },
          ],
          idleTimedOut: true,
        };
      },
    });
    const files = new Map(result.files.map((file) => [file.path, file.bytes.toString("utf8")]));
    expect(fetchedByRenderer).toBe(true);
    expect(files.get("index.html")).toContain("Contenuto renderizzato");
    expect(files.get("assets/hero.svg")).toContain("hero");
    expect(files.get("assets/late.svg")).toContain("late");
    expect(result.report?.dynamicFeatures.some((feature) => feature.code === "rendered-js-api" && feature.message.includes("/api/data"))).toBe(true);
    expect(result.findings.some((finding) => finding.code === "render-networkidle-timeout")).toBe(true);
    expect(result.findings.some((finding) => finding.code === "rendered-spa-api-limit")).toBe(true);
    expect(site.requests).not.toContain("/api/data");
  });

  it("scopre WordPress, rispetta robots, copia asset e riscrive SEO e redirect; riusa ETag", async () => {
    const site = await listen(wordpressFixture());
    const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-cache-"));
    temporaryDirectories.push(cacheDirectory);
    const consent = new URL(site.url).origin;
    const detection = await detectOnlineSite({ sourceUrl: site.url, crawlConsent: consent, delayMs: 0 });
    expect(detection.engine).toBe("wordpress");
    expect(detection.technologies).toContain("WooCommerce");
    expect(detection.integrations.staticBridge).toBe(true);
    const first = await crawlSite({ sourceUrl: site.url, crawlConsent: consent, crawl: { delayMs: 0, maxPages: 100 }, rewrite: { destinationDomain: "publish.example" }, cacheDirectory });
    expect(first.report.engine).toBe("wordpress");
    expect(first.report.pagesDownloaded).toBe(3);
    expect(first.report.pagesSkipped.some((url) => url.includes("/private/"))).toBe(true);
    expect(first.report.technologies).toContain("WooCommerce");
    expect(first.report.dynamicFeatures.some((feature) => feature.code === "contact-form-7")).toBe(true);
    expect(first.redirects).toContainEqual({ from: "/old", to: "/about/", status: 301 });
    const files = new Map(first.files.map((file) => [file.path, file.bytes.toString("utf8")]));
    expect(files.get("index.html")).toContain("https://publish.example/");
    expect(files.get("index.html")).not.toContain("api.w.org");
    expect(files.get("about/index.html")).toContain("../assets/hero.png");
    expect(files.get("assets/main.css")).toContain("fonts.css");
    expect(files.get("manifest.json")).toContain('"src": "assets/hero.png"');
    expect(files.get("_redirects")).toContain("/old /about/ 301");
    expect(files.get("sitemap.xml")).toContain("https://publish.example/about/index.html");
    expect(files.get("robots.txt")).toContain("https://publish.example/sitemap.xml");
    expect(site.requests).not.toContain("/private/");

    const second = await crawlSite({ sourceUrl: site.url, crawlConsent: consent, crawl: { delayMs: 0, maxPages: 100 }, cacheDirectory });
    expect(second.report.cache.notModified).toBeGreaterThan(0);
    expect(site.requests.filter((url) => url === "/")).toHaveLength(3);
  });

  it("in robots.txt vale il gruppo che nomina esattamente HistosPublish, non uno con un pezzo del nome", async () => {
    let robots = "User-agent: h\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    const site = await listen((request, response) => {
      if (request.url === "/robots.txt") return send(response, 200, "text/plain", robots);
      send(response, 200, "text/html", "<!doctype html><html lang=\"it\"><head><title>Home</title></head><body><h1>Home</h1></body></html>");
    });
    const crawled = await crawlSite({ sourceUrl: site.url, crawlConsent: new URL(site.url).origin, crawl: { delayMs: 0, maxPages: 1 } });
    expect(crawled.files.some((file) => file.path === "index.html")).toBe(true);
    robots = "User-agent: HistosPublish\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    await expect(crawlSite({ sourceUrl: site.url, crawlConsent: new URL(site.url).origin, crawl: { delayMs: 0, maxPages: 1 } })).rejects.toMatchObject({ code: "crawl-robots-disallowed" });
  });

  it("un indirizzo di asset esterni ammette la sua origine e la sua cartella, non un host che comincia allo stesso modo", () => {
    const allowed = (url: string, entry: string) => underExternalAsset(new URL(url), new URL(entry));
    expect(allowed("https://cdn.example/font.woff2", "https://cdn.example")).toBe(true);
    expect(allowed("https://cdn.example.evil.com/font.woff2", "https://cdn.example")).toBe(false);
    expect(allowed("https://cdn.example/lib/a.css", "https://cdn.example/lib")).toBe(true);
    expect(allowed("https://cdn.example/library/a.css", "https://cdn.example/lib")).toBe(false);
    expect(allowed("http://127.0.0.1:1234/a.css", "http://127.0.0.1:1")).toBe(false);
  });

  it("non scarica la home se robots.txt la vieta e blocca gli IP privati pubblici", async () => {
    const site = await listen((request, response) => {
      if (request.url === "/robots.txt") return send(response, 200, "text/plain", "User-agent: *\nDisallow: /\n");
      send(response, 200, "text/html", "<!doctype html><html></html>");
    });
    await expect(crawlSite({ sourceUrl: site.url, crawlConsent: new URL(site.url).origin, crawl: { delayMs: 0 } })).rejects.toMatchObject({ code: "crawl-robots-disallowed" });
    expect(site.requests).toEqual(["/robots.txt"]);
    await expect(crawlSite({ sourceUrl: "http://192.168.1.2/", crawlConsent: "http://192.168.1.2", crawl: { delayMs: 0 } })).rejects.toMatchObject({ code: "crawl-private-network" });
  });

  it("blocca un redirect iniziale verso un’altra origine prima di contattarla", async () => {
    const target = await listen((_request, response) => send(response, 200, "text/html", "<!doctype html><html></html>"));
    const source = await listen((request, response) => {
      if (request.url === "/robots.txt") return send(response, 404, "text/plain", "not found");
      response.writeHead(302, { Location: target.url });
      response.end();
    });
    await expect(crawlSite({ sourceUrl: source.url, crawlConsent: new URL(source.url).origin, crawl: { delayMs: 0 } })).rejects.toMatchObject({ code: "crawl-cross-origin-redirect" });
    expect(target.requests).toEqual([]);
  });

  it("blocca il bundle se nessuna pagina supera i controlli", async () => {
    const site = await listen((request, response) => {
      if (request.url === "/robots.txt") return send(response, 404, "text/plain", "not found");
      if (request.url === "/") return send(response, 200, "text/html", "<!doctype html><html><body>There has been a critical error on this website.</body></html>");
      send(response, 404, "text/plain", "not found");
    });
    const parent = await mkdtemp(path.join(os.tmpdir(), "histos-publish-no-pages-"));
    temporaryDirectories.push(parent);
    const result = await buildBundle({
      source: { kind: "url", path: site.url },
      outputDirectory: path.join(parent, "bundle"),
      crawlConsent: new URL(site.url).origin,
      crawl: { concurrency: 1, delayMs: 0, maxPages: 2 },
    });
    expect(result.status).toBe("blocked");
    expect(result.pages).toBe(0);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "crawl-no-pages", severity: "block" }));
    const metadata = JSON.parse(await readFile(path.join(result.bundlePath ?? "", ".histos-publish", "meta.json"), "utf8")) as { status?: string };
    expect(metadata.status).toBe("blocked");
  });
});
