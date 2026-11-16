import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { CmsRemoteCatalog, connectRemoteSite } from "../packages/server/dist/cms-remote.js";
import { checkRemoteSiteInBrowser } from "../packages/server/dist/cms-remote-browser-check.js";
import { loadAxeScript } from "../packages/server/dist/prototype-verify.js";
import { readPairingCode } from "./wordpress-test-pairing.mjs";

/**
 * V1.6, threat model T32: «Verifica nel browser» of «Controlla il sito WP» against a disposable WordPress with the
 * builder's Histeon. A page changes in development with a button without a name and two external links, one to a name
 * that does not exist and one to a private address; its dev version is marked as written without unfiltered_html, so
 * its preview sends `Content-Security-Policy: script-src 'none'` (the case axe must survive without loosening it).
 * Publish asks the site for the signed preview links, opens them in a browser that reaches the site's origin only, and
 * runs axe in a world of its own; the links are probed by Publish itself. Expected: `button-name` on that page, the first
 * link unreachable, the second not checked, no token anywhere in the report.
 *
 * The browser is Playwright's Chromium, as the CLI's (the desktop app uses its hidden Electron window instead).
 */

const container = process.env.HISTOS_TEST_WP_CONTAINER;
const pairingFile = process.env.HISTOS_TEST_PAIRING_CODE_FILE;
if (!container || !/^(?:histos-cms|[a-z0-9][a-z0-9-]{0,30}-cms)-a-\d+-[0-9a-f]{8}-wordpress-1$/u.test(container)) throw new TypeError("Serve uno stack Docker usa-e-getta del runner (HISTOS_TEST_WP_CONTAINER).");
if (!pairingFile) throw new TypeError("Serve il codice di collegamento locale (HISTOS_TEST_PAIRING_CODE_FILE).");

const root = await mkdtemp(path.join(os.tmpdir(), "histos-site-check-"));
const remotes = new CmsRemoteCatalog(root);
const secrets = new Map();
const secretStoreFor = (account) => ({
  get: async () => secrets.get(account) ?? null,
  set: async (value) => secrets.set(account, value),
  delete: async () => secrets.delete(account),
});

/** A page of Histeon, released, then changed in development as an author without unfiltered_html would. */
function changedPage() {
  const php = String.raw`require "/var/www/html/wp-load.php";
$user = get_user_by("login", "admin"); wp_set_current_user($user->ID);
$n = 0;
$block = function ($name, $attrs, $children = array()) use (&$n) { $attrs["uid"] = $attrs["uid"] ?? sprintf("vs%06d", ++$n); return array("blockName" => $name, "attrs" => $attrs, "innerBlocks" => $children, "innerHTML" => "", "innerContent" => array_fill(0, count($children), null)); };
$el = function ($tag, $attributes, $children = array()) use ($block) { $attrs = array("tag" => $tag); if ($attributes) { $attrs["attributes"] = $attributes; } return $block("xb/element", $attrs, $children); };
$text = function ($content) use ($block) { return $block("xb/text", array("content" => $content)); };
$id = wp_insert_post(array("post_type" => "page", "post_status" => "publish", "post_title" => "Pagina da verificare", "post_name" => "da-verificare", "post_content" => wp_slash(serialize_blocks(array($el("p", array(), array($text("Com'era prima."))))))), true);
if (is_wp_error($id)) { fwrite(STDERR, $id->get_error_message()); exit(20); }
try { \XB\Plugin::instance()->versioning->publish(null, "Base della prova V1.6"); } catch (\Throwable $e) { fwrite(STDERR, "release: " . $e->getMessage() . "\n"); }
$doc = rest_do_request(new \WP_REST_Request("GET", "/xb/v1/documents/$id"))->get_data();
$content = serialize_blocks(array(
  $el("p", array(), array($text("Cambiata in sviluppo."))),
  $el("button", array("type" => "button"), array()),
  $el("p", array(), array($el("a", array("href" => "https://link-rotto.invalid/"), array($text("Un link verso un nome che non esiste"))))),
  $el("p", array(), array($el("a", array("href" => "http://10.0.0.1/"), array($text("Un link verso la rete privata"))))),
));
$request = new \WP_REST_Request("POST", "/xb/v1/documents/$id");
foreach (array("content" => $content, "head" => is_array($doc) ? $doc["head"] : "", "base" => is_array($doc) ? $doc["base"] : "") as $key => $value) { $request->set_param($key, $value); }
$saved = rest_do_request($request);
if ($saved->get_status() !== 200) { fwrite(STDERR, "dev: " . wp_json_encode($saved->get_data())); exit(21); }
global $wpdb;
$commits = \XB\Versioning\Schema::table("commits");
$refs = \XB\Versioning\Schema::table("refs");
$wpdb->query($wpdb->prepare("UPDATE $commits c JOIN $refs r ON r.commit_id = c.id SET c.trusted = 0 WHERE r.doc = %s AND r.branch = 'dev'", "post:$id"));
echo wp_json_encode(array("id" => $id, "changes" => count(\XB\Plugin::instance()->versioning->changes())));`;
  return JSON.parse(execFileSync("docker", ["exec", container, "php", "-r", php], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

/**
 * The CLI's kind of browser for a real site: a context of its own that lets through only the site's origin (every other
 * request refused and remembered, WebSockets closed), no download, no service worker, no popup; the expression in an
 * isolated world, with the page's CSP applying to it as it would to Electron's (eval allowed only if the CSP allows it).
 */
function siteProbe(browser, seen) {
  return async ({ origin, site }) => {
    assert.equal(site, true, "the check opens a real site");
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
    try {
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(`${origin}/`)) return route.continue();
        seen.outside += 1;
        return route.abort("blockedbyclient");
      });
      await context.routeWebSocket(/.*/u, (socket) => { void socket.close({ code: 1008, reason: "blocked" }); });
      const page = await context.newPage();
      page.on("popup", (popup) => { void popup.close(); });
      const cdp = await context.newCDPSession(page);
      return {
        probe: async ({ url, width, height, expression }) => {
          await page.setViewportSize({ width, height });
          const response = await page.goto(url, { waitUntil: "load", timeout: 20_000 });
          seen.csp.push(response?.headers()["content-security-policy"] ?? "");
          const { frameTree } = await cdp.send("Page.getFrameTree");
          const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "histeon-check" });
          const answer = await cdp.send("Runtime.evaluate", { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: false });
          if (answer.exceptionDetails) throw new Error(String(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text).split("\n")[0]);
          return answer.result.value;
        },
        close: () => context.close(),
      };
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
  };
}

let browser;
try {
  const { code } = await readPairingCode(pairingFile);
  const made = changedPage();
  assert.ok(made.changes >= 1, "the page changes in development");
  const connection = await connectRemoteSite(code, remotes, secretStoreFor);
  browser = await chromium.launch({ headless: true });
  const seen = { csp: [], outside: 0 };
  const result = await checkRemoteSiteInBrowser({ connectionId: connection.id }, remotes, secretStoreFor, { openProbe: siteProbe(browser, seen), axe: await loadAxeScript() });
  const report = JSON.stringify(result);
  const page = result.pages.find((item) => item.page.endsWith("/da-verificare/"));
  assert.ok(page, `the changed page is listed: ${JSON.stringify(result.pages)}`);
  assert.equal(result.failures, undefined, `every page opened: ${JSON.stringify(result.failures)}`);
  assert.equal(result.opened, result.pages.length);
  assert.ok(seen.csp.some((policy) => policy.includes("script-src 'none'")), "the preview of untrusted content keeps its CSP");
  const rule = result.axe.find((item) => item.id === "button-name");
  assert.ok(rule, `axe gives button-name: ${JSON.stringify(result.axe.map((item) => item.id))}`);
  assert.ok(rule.pages.includes("/da-verificare/"), `on the changed page: ${JSON.stringify(rule.pages)}`);
  assert.match(rule.help, /pulsant/iu, "axe's messages in Italian, under the CSP");
  assert.deepEqual(result.links.unreachable.map((link) => link.url), ["https://link-rotto.invalid/"], "a name that does not exist is unreachable");
  assert.deepEqual(result.links.untested.map((link) => link.url), ["http://10.0.0.1/"], "a private address is not checked");
  assert.deepEqual(result.links.broken, []);
  assert.doesNotMatch(report, /xb_preview=[^…]/u, "no token in the report");
  assert.doesNotMatch(report, /[0-9a-f]{64}/u, "no signature in the report");
  process.stdout.write(`Verifica nel browser: ${result.opened} pagine aperte, regole axe ${result.axe.map((item) => item.id).join(", ")}; link non raggiungibili ${result.links.unreachable.length}, non provati ${result.links.untested.length}; richieste fuori dal sito fermate ${seen.outside}; CSP dell'anteprima tenuta.\n`);
} finally {
  await browser?.close();
  await rm(root, { recursive: true, force: true });
}
