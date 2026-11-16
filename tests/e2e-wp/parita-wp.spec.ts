import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CmsProjectCatalog, documentAddress } from "../../packages/cms/dist/index.js";
import { buildCmsProject, importPrototypeHtml, type CmsOperationsContext } from "../../packages/server/dist/cms-api.js";
import { applyRemoteSyncPlan, CmsRemoteCatalog, connectRemoteSite, createRemoteSyncPlan } from "../../packages/server/dist/cms-remote.js";

/**
 * Doc 23, item 183: the static build of Histeon Publish and the same pages on WordPress after a real send look the
 * same. A prototype (header and footer parts, a grid of component cards, large headings, a web font and an image as
 * media, a page on its own template, a record, a post) is imported as «Importa prototipo» does, sent to a test
 * WordPress through the bridge and released there, then built by Publish; each page is photographed on both sides at
 * 1280 and 390 px and compared pixel by pixel as the builder's item 129 compares editor and site.
 *
 * It runs only against a disposable WordPress: HISTOS_PARITY_WP_URL (its address on localhost) and
 * HISTOS_PARITY_WP_CONTAINER (its Docker container, for the pairing code and the release). `npm run test:parita-wp`
 * starts one from the builder's dev/compose.yml and removes it afterwards; docs/PARITA-WP.md says how.
 */

const wordpressUrl = process.env.HISTOS_PARITY_WP_URL?.trim() ?? "";
const container = process.env.HISTOS_PARITY_WP_CONTAINER?.trim() ?? "";
/** A folder where every picture is written, also when the comparison passes (for a look by eye). */
const keepDirectory = process.env.HISTOS_PARITY_SAVE_DIR?.trim() ?? "";
/** Disposable stacks only: the ones `npm run test:parita-wp` starts, or the builder's own e2e stacks (xb-e2e*). */
const DISPOSABLE_CONTAINER = /^(?:histos-cms-[a-z0-9-]+|xb-e2e[a-z0-9-]*)-wordpress-1$/u;

/** As item 129: per-pixel tolerance 48 on the sum of the RGB channels, under 2% of the pixels, sizes within 2 px. */
const PIXEL_TOLERANCE = 48;
const MAX_SHARE = 0.02;
const MAX_SIZE_GAP = 2;
const WIDTHS = [1280, 390] as const;

test.skip(!wordpressUrl, "Prova di parità con WordPress saltata: imposta HISTOS_PARITY_WP_URL e HISTOS_PARITY_WP_CONTAINER, oppure lancia npm run test:parita-wp (docs/PARITA-WP.md).");
test.describe.configure({ timeout: 600_000 });

interface Target { name: string; publishPath: string; wordpressPath: string }
interface Comparison { target: Target; width: number; share: number; sizes: [number, number, number, number] }

function php(body: string): string {
  return execFileSync("docker", ["exec", container, "php", "-d", "memory_limit=512M", "-r", String.raw`require "/var/www/html/wp-load.php"; $u = get_user_by("login", "admin"); if (!$u) { fwrite(STDERR, "admin user missing\n"); exit(20); } wp_set_current_user($u->ID); ` + body], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}

/** A static server for the build folder, on loopback: "/x/" serves x/index.html, as the published site does. */
async function serveBuild(root: string): Promise<{ server: Server; url: string }> {
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".jxl": "image/jxl", ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain" };
  const server = createServer(async (request, response) => {
    try {
      const address = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      let file = path.join(root, path.normalize(address).replace(/^(\.\.[/\\])+/u, ""));
      if (!file.startsWith(root)) throw new Error("outside");
      if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, "index.html");
      const body = await readFile(file);
      response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** The page's markup and every rule of its style sheets, for a look at what differs (HISTOS_PARITY_SAVE_DIR). */
async function pageSource(page: Page): Promise<string> {
  const rules = await page.evaluate(() => Array.from(document.styleSheets).map((sheet) => {
    try { return `/* ${sheet.href ?? "inline"} */\n${Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\n")}`; } catch { return `/* ${sheet.href}: not readable */`; }
  }).join("\n\n"));
  return `${await page.content()}\n\n<!-- style sheets -->\n<!--\n${rules.replaceAll("--", "- -")}\n-->\n`;
}

/** The whole page at one width, after the fonts and every image (lazy ones too) are in. */
async function photograph(page: Page, url: string, width: number): Promise<Buffer> {
  await page.setViewportSize({ width, height: 900 });
  const response = await page.goto(url, { waitUntil: "load" });
  expect(response?.status(), `${url} risponde`).toBe(200);
  await page.evaluate(async () => {
    for (const image of Array.from(document.images)) image.loading = "eager";
    await Promise.all(Array.from(document.images).map((image) => image.decode().catch(() => undefined)));
    await document.fonts.ready;
  });
  return page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
}

/**
 * The difference() of the builder's gutenberg-layout-parity.spec.ts (item 129): the share of pixels that differ by more
 * than the tolerance, over the larger of the two pictures, with a picture of where they differ (red on a faded copy
 * of the first one; the area only one of them covers is blue).
 */
async function difference(page: Page, a: Buffer, b: Buffer): Promise<{ share: number; sizes: [number, number, number, number]; diff: string }> {
  return page.evaluate(
    async ([one, two, tolerance]) => {
      const load = async (data: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return { w: image.width, h: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
      };
      const [x, y] = [await load(one), await load(two)];
      const w = Math.min(x.w, y.w);
      const h = Math.min(x.h, y.h);
      const W = Math.max(x.w, y.w);
      const H = Math.max(x.h, y.h);
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const context = canvas.getContext("2d")!;
      const out = context.createImageData(W, H);
      let differ = 0;
      for (let row = 0; row < H; row++) {
        for (let col = 0; col < W; col++) {
          const o = (row * W + col) * 4;
          out.data[o + 3] = 255;
          if (row >= h || col >= w) {
            out.data[o + 2] = 255;
            continue;
          }
          const i = (row * x.w + col) * 4;
          const j = (row * y.w + col) * 4;
          if (Math.abs(x.data[i]! - y.data[j]!) + Math.abs(x.data[i + 1]! - y.data[j + 1]!) + Math.abs(x.data[i + 2]! - y.data[j + 2]!) > tolerance) {
            differ++;
            out.data[o] = 255;
          } else {
            const grey = 200 + Math.round((x.data[i]! + x.data[i + 1]! + x.data[i + 2]!) / 3 / 255 * 55);
            out.data[o] = grey;
            out.data[o + 1] = grey;
            out.data[o + 2] = grey;
          }
        }
      }
      context.putImageData(out, 0, 0);
      return { share: differ / (W * H), sizes: [x.w, x.h, y.w, y.h] as [number, number, number, number], diff: canvas.toDataURL("image/png").slice("data:image/png;base64,".length) };
    },
    [a.toString("base64"), b.toString("base64"), PIXEL_TOLERANCE] as const,
  );
}

test("la build statica di Publish e le stesse pagine su WordPress, dopo un invio e una release, si vedono uguali (doc 23, voce 183)", async ({ page, browser }, testInfo) => {
  expect(DISPOSABLE_CONTAINER.test(container), `HISTOS_PARITY_WP_CONTAINER deve essere il container di uno stack usa-e-getta (histos-cms-*-wordpress-1 o xb-e2e*-wordpress-1), non «${container}».`).toBe(true);
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-parita-wp-"));
  let served: { server: Server; url: string } | null = null;
  try {
    const catalog = new CmsProjectCatalog(path.join(root, "publish"));
    await catalog.initialize();
    const context: CmsOperationsContext = { catalog, dataDirectory: root, port: 1, registerPreview: () => undefined, registerBuild: () => undefined };

    // Prototype → Publish, as «Importa prototipo» does (no download: the font and the image are in the file).
    const font = (await readFile(path.resolve("node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2"))).toString("base64");
    const prototype = (await readFile(path.resolve("tests/e2e-wp/prototipo-parita.html"), "utf8")).replace("FONT_INTER", font);
    const imported = await test.step("importa il prototipo", () => importPrototypeHtml(context, prototype, { download: false, allowUpdate: false }));
    expect(imported.status, JSON.stringify(imported.body).slice(0, 500)).toBe(201);
    const projectId = String((imported.body.project as { id: string }).id);

    // Publish → WordPress: a link that reads and writes, the send in development, then a release as the administrator.
    const remotes = new CmsRemoteCatalog(root);
    const secrets = new Map<string, string>();
    const secretStoreFor = (account: string) => ({
      get: async () => secrets.get(account) ?? null,
      set: async (value: string) => { secrets.set(account, value); },
      delete: async () => { secrets.delete(account); },
    });
    await test.step("invia a WordPress e pubblica la release", async () => {
      const code = php(String.raw`echo \XB\Cms\Link::create("Prova di parità Publish e WordPress", true, true, false);`).trim();
      expect(code.startsWith("histos-cms-1:"), "WordPress dà un codice di collegamento").toBe(true);
      const connection = await connectRemoteSite(code, remotes, secretStoreFor);
      expect(connection.projectId, "il WordPress di prova non è già collegato a un altro progetto: serve uno stack nuovo").toBeNull();
      const plan = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId }, remotes, catalog, secretStoreFor);
      expect(plan.applyAllowed && plan.counts.conflict === 0, `piano d'invio applicabile: ${JSON.stringify(plan.counts)}`).toBe(true);
      const applied = await applyRemoteSyncPlan({ connectionId: connection.id, planId: plan.planId! }, remotes, catalog, secretStoreFor);
      expect(applied.complete, "invio completato").toBe(true);
      const released = php(String.raw`try { \XB\Plugin::instance()->versioning->publish(null, "Prova di parità"); } catch (\XB\Versioning\VersioningException $e) { if (400 !== $e->getCode()) { fwrite(STDERR, $e->getMessage()."\n"); exit(21); } \XB\Remote\ContentProfileAdapter::apply_queue(0); } echo "RELEASED";`);
      expect(released).toContain("RELEASED");
    });

    // The pages to compare: each document's address in the build and its permalink on WordPress.
    const opened = await catalog.openProject(projectId);
    if (!opened) throw new Error("Il progetto importato non si apre.");
    const targets: Target[] = [];
    try {
      const { store } = opened;
      const locale = store.getRenderSettings().locale;
      const documents = [...store.listPages(), ...store.listPosts()].filter((document) => document.status === "published");
      const record = (store.content.listRecords({ typeKey: "opera", status: "any", limit: 10 }) as { items: Array<{ id: string; slug: string }> }).items.find((item) => item.slug === "campi");
      if (!record) throw new Error("Il record «campi» manca nel progetto.");
      const links = JSON.parse(php(String.raw`$ids = json_decode(${JSON.stringify(JSON.stringify(documents.map((document) => document.id)))}, true); $out = array(); foreach ($ids as $id) { $post = \XB\Remote\PageProfileAdapter::post_of_entity($id); $out[$id] = $post > 0 ? get_permalink($post) : null; } $record = \XB\Remote\ContentProfileAdapter::linked_record_by_id(${JSON.stringify(record.id)}, "opera"); $out["record"] = $record ? get_permalink($record) : null; $out["archive"] = get_post_type_archive_link("opera"); echo wp_json_encode($out);`)) as Record<string, string | null>;
      const wordpressPath = (link: string | null | undefined, what: string) => {
        if (!link) throw new Error(`${what} non è su WordPress dopo l'invio.`);
        return new URL(link).pathname;
      };
      for (const document of documents) targets.push({ name: document.documentType === "post" ? `articolo ${document.slug}` : `pagina ${document.slug}`, publishPath: documentAddress(document, locale), wordpressPath: wordpressPath(links[document.id], `«${document.title}»`) });
      targets.push({ name: "record opera/campi", publishPath: "/opera/campi/", wordpressPath: wordpressPath(links.record, "Il record «Campi»") });
      targets.push({ name: "archivio opera", publishPath: "/opera/", wordpressPath: wordpressPath(links.archive, "L'archivio delle opere") });
    } finally {
      opened.store.close();
    }

    // The static build of Publish, the one «Prepara il sito» makes, served as a site.
    const built = await test.step("costruisce il sito statico", async () => {
      const reopened = await catalog.openProject(projectId);
      if (!reopened) throw new Error("Il progetto importato non si apre.");
      try { return await buildCmsProject(context, reopened); } finally { reopened.store.close(); }
    });
    expect(built.status, JSON.stringify(built.findings ?? []).slice(0, 800)).toBe("ready");
    served = await serveBuild(path.join(root, "histos-cms-builds", projectId, String(built.id)));

    // Only the two sites themselves: nothing from the network (as in item 129).
    const allowed = [new URL(served.url).origin, new URL(wordpressUrl).origin];
    await page.route("**/*", (route) => allowed.includes(new URL(route.request().url()).origin) ? route.continue() : route.fulfill({ status: 204, body: "" }));
    const other = await browser.newPage();
    await other.route("**/*", (route) => allowed.includes(new URL(route.request().url()).origin) ? route.continue() : route.fulfill({ status: 204, body: "" }));

    const results: Comparison[] = [];
    for (const target of targets) {
      for (const width of WIDTHS) {
        await test.step(`${target.name} a ${width} px`, async () => {
          const publish = await photograph(page, new URL(target.publishPath, served!.url).toString(), width);
          const wordpress = await photograph(other, new URL(target.wordpressPath, wordpressUrl).toString(), width);
          const { share, sizes, diff } = await difference(page, publish, wordpress);
          results.push({ target, width, share, sizes });
          const slug = `${target.name.replace(/[^a-z0-9]+/giu, "-")}-${width}`;
          const failed = share >= MAX_SHARE || Math.abs(sizes[0] - sizes[2]) > MAX_SIZE_GAP || Math.abs(sizes[1] - sizes[3]) > MAX_SIZE_GAP;
          if (failed) {
            // Written into the test's output folder (test-results/parita-wp/…), which stays after a failure.
            for (const [name, body] of [["publish", publish], ["wordpress", wordpress], ["differenze", Buffer.from(diff, "base64")]] as const) {
              const file = testInfo.outputPath(`${slug}-${name}.png`);
              await writeFile(file, body);
              await testInfo.attach(`${slug}-${name}.png`, { path: file, contentType: "image/png" });
            }
          }
          if (keepDirectory) {
            await mkdir(keepDirectory, { recursive: true });
            await writeFile(path.join(keepDirectory, `${slug}-publish.png`), publish);
            await writeFile(path.join(keepDirectory, `${slug}-wordpress.png`), wordpress);
            await writeFile(path.join(keepDirectory, `${slug}-differenze.png`), Buffer.from(diff, "base64"));
            if (width === WIDTHS[0]) {
              await writeFile(path.join(keepDirectory, `${slug}-publish.html`), await pageSource(page));
              await writeFile(path.join(keepDirectory, `${slug}-wordpress.html`), await pageSource(other));
            }
          }
          const where = `${target.name} a ${width} px (Publish ${target.publishPath}, WordPress ${target.wordpressPath})`;
          expect.soft(Math.abs(sizes[0] - sizes[2]), `${where}: larghezze ${sizes[0]} e ${sizes[2]}`).toBeLessThanOrEqual(MAX_SIZE_GAP);
          expect.soft(Math.abs(sizes[1] - sizes[3]), `${where}: altezze ${sizes[1]} e ${sizes[3]}`).toBeLessThanOrEqual(MAX_SIZE_GAP);
          expect.soft(share, `${where}: pixel diversi ${(share * 100).toFixed(2)}%`).toBeLessThan(MAX_SHARE);
        });
      }
    }
    await other.close();
    const table = results.map((item) => `${item.target.name.padEnd(24)} ${String(item.width).padStart(4)} px  ${(item.share * 100).toFixed(2).padStart(6)}%  Publish ${item.target.publishPath} ${item.sizes[0]}×${item.sizes[1]}, WordPress ${item.target.wordpressPath} ${item.sizes[2]}×${item.sizes[3]}`).join("\n");
    process.stdout.write(`\nParità Publish ↔ WordPress (soglia ${(MAX_SHARE * 100).toFixed(0)}%):\n${table}\n`);
    await testInfo.attach("parita.txt", { body: table, contentType: "text/plain" });
  } finally {
    await new Promise<void>((resolve) => {
      if (!served) return resolve();
      served.server.close(() => resolve());
      // `page` is still open here and Chromium keeps sockets to the site, some opened ahead with no request yet: close()
      // alone waits for those until the test times out.
      served.server.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  }
});
