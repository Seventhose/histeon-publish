import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publishRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const histosRoot = process.env.HISTOS_BUILDER_DIR?.trim() ? path.resolve(process.env.HISTOS_BUILDER_DIR.trim()) : "";
if (!histosRoot) throw new Error("Set HISTOS_BUILDER_DIR to a checkout of the Histeon builder (Seventhose/xb).");
const composeFile = path.join(histosRoot, "dev/compose.yml");
// "--prototypes": the prototype → Publish → WordPress → Publish round-trip of queue C3; "--etch": Etch → Histeon on
// WordPress → Publish, queue C4; "--markup": the histos-transfer-markup-v1 prototype through the bridge and back, queue
// A6; "--commerce": a prototype with products through the bridge into WooCommerce and back, queue C6 (WooCommerce from
// HISTOS_WOOCOMMERCE_ZIP, or its stable zip from WordPress.org); "--languages": a project in two languages through the
// bridge onto Lingua Bridge, doc 20 §5.9 (the plugin from HISTOS_LINGUA_BRIDGE_ZIP); "--export-file": a plain WordPress
// site through its own export file into Publish, doc 22 §R6; "--parita": Publish's static build against the same pages
// on WordPress after a send, doc 23 item 183 (a Playwright run, with the plugin of a release zip: HISTOS_PARITY_PLUGIN_ZIP,
// or the newest xb-*.zip of the builder's dist/); "--versioni": Publish and Histeon of different versions, doc 23 item 202
// (stack A with the previous Histeon release zip, stack B with the one this Publish knows; docs/VERSIONI-WP.md);
// "--site-check": «Verifica nel browser» of «Controlla il sito WP», axe and external links on a page that changes in
// development, V1.6 (threat model T32 of the builder). Without a flag, the CMS round-trip between two WordPress installs. HISTOS_TEST_COMPOSE_PREFIX names the Compose projects
// (default histos-cms: «histos-cms-a-<pid>-<random>»), so that parallel runs keep to their own stacks.
const scenario = process.argv.includes("--prototypes")
  ? { script: "scripts/test-prototype-wordpress-roundtrip.mjs", title: "Round-trip prototipo → Publish → WordPress → Publish", stacks: 2 }
  : process.argv.includes("--markup")
    ? { script: "scripts/test-transfer-markup-wordpress-roundtrip.mjs", title: "Round-trip del markup v1 (SVG, picture, details, moduli) → WordPress → Publish", stacks: 1 }
  : process.argv.includes("--commerce")
    ? { script: "scripts/test-commerce-wordpress-roundtrip.mjs", title: "Round-trip di un negozio: prototipo → Publish → WooCommerce → Publish", stacks: 1, woocommerce: true }
  : process.argv.includes("--languages")
    ? { script: "scripts/test-languages-wordpress-send.mjs", title: "Invio di un progetto in due lingue → WordPress con Lingua Bridge", stacks: 1, linguaBridge: true }
  : process.argv.includes("--export-file")
    ? { script: "scripts/test-wordpress-export-import.mjs", title: "Sito WordPress senza Histeon → file di esportazione → Publish", stacks: 1 }
  : process.argv.includes("--real-project")
    ? { script: "scripts/test-real-project-wordpress.mjs", title: "Progetto reale, su una copia: invio, pubblicazione, modifica e ritorno", stacks: 1 }
  : process.argv.includes("--article-blocks")
    ? { script: "scripts/test-article-blocks-wordpress.mjs", title: "Articolo con i blocchi: Publish → WordPress → Gutenberg → Publish", stacks: 1 }
  : process.argv.includes("--parita")
    ? { command: ["npx", "playwright", "test", "-c", "playwright.parita-wp.config.ts"], title: "Parità visiva fra la build di Publish e WordPress (doc 23, voce 183)", stacks: 1, pluginZip: true }
  : process.argv.includes("--versioni")
    ? { script: "scripts/test-versioni-wp.mjs", title: "Versioni diverse: Publish N con Histeon N−1, Publish N−1 con Histeon N (doc 23, voce 202)", stacks: 2, versionZips: true }
  : process.argv.includes("--site-check")
    ? { script: "scripts/test-site-check-wordpress.mjs", title: "«Verifica nel browser» del sito WP: axe e link esterni delle pagine in sviluppo (V1.6)", stacks: 1 }
  : process.argv.includes("--etch")
    ? { script: "scripts/test-etch-publish-roundtrip.mjs", title: "Percorso Etch → WordPress con Histeon → Publish", stacks: 1 }
    : { script: "scripts/test-histos-remote-wordpress-roundtrip.mjs", title: "Round-trip CMS fra due installazioni WordPress locali", stacks: 2 };
// A copy of the repository may leave a scenario's script out (the public copy has no "--etch" one): say so and stop
// before any stack starts, so that test:wordpress:all goes on.
if (scenario.script && !existsSync(path.join(publishRoot, scenario.script))) {
  console.log(`${scenario.title}: saltata, ${scenario.script} non è in questa copia del repository.`);
  process.exit(0);
}
const composePrefix = process.env.HISTOS_TEST_COMPOSE_PREFIX?.trim() || "histos-cms";
if (!/^[a-z0-9][a-z0-9-]{0,30}$/u.test(composePrefix)) throw new Error("HISTOS_TEST_COMPOSE_PREFIX: solo minuscole, cifre e trattini.");
const composeContexts = ["a", "b"].slice(0, scenario.stacks).map((label) => {
  const projectName = `${composePrefix === "histos-cms" ? "histos-cms" : `${composePrefix}-cms`}-${label}-${process.pid}-${randomBytes(4).toString("hex")}`;
  return {
    projectName,
    wordpressContainer: `${projectName}-wordpress-1`,
    stackMayExist: false,
  };
});
const pairingPrefix = "histos-cms-1:";
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-wordpress-local-"));
await chmod(temporaryDirectory, 0o700);
let interruptedSignal;
const rememberSignal = (signal) => { interruptedSignal ??= signal; };
process.on("SIGINT", rememberSignal);
process.on("SIGTERM", rememberSignal);
for (const context of composeContexts) {
  context.environmentFile = path.join(temporaryDirectory, `${context.projectName}.env`);
  context.pairingFile = path.join(temporaryDirectory, `${context.projectName}.pairing`);
  context.networkFile = path.join(temporaryDirectory, `${context.projectName}.network.yml`);
}

function throwIfInterrupted() {
  if (!interruptedSignal) return;
  process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
  throw new Error(`Test interrotto (${interruptedSignal}); pulisco gli stack Docker temporanei.`);
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function docker(args, { capture = false, sensitive = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd: histosRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (!interruptedSignal && (result.status === 130 || result.status === 143)) {
    interruptedSignal = result.status === 130 ? "SIGINT" : "SIGTERM";
  }
  if (interruptedSignal && !args.includes("down")) throwIfInterrupted();
  if (result.error) throw new Error(`Docker non disponibile: ${result.error.message}`);
  if (result.status !== 0) {
    const details = sensitive ? "" : [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(details || `Comando Docker non riuscito (codice ${result.status ?? "sconosciuto"}).`);
  }
  return capture ? result.stdout.trim() : "";
}

const compose = (context, ...args) => docker([
  "compose", "--project-name", context.projectName, "--env-file", context.environmentFile,
  "-f", composeFile, "-f", context.networkFile, ...((context.pluginFile ?? pluginFile) ? ["-f", context.pluginFile ?? pluginFile] : []), ...args,
]);
const wp = (context, ...args) => compose(context, "run", "--rm", "-T", "cli", "wp", ...args);

function ipv4Number(address) {
  const pieces = address.split(".").map(Number);
  if (pieces.length !== 4 || pieces.some((piece) => !Number.isInteger(piece) || piece < 0 || piece > 255)) return null;
  return pieces.reduce((value, piece) => value * 256 + piece, 0);
}

function cidrRange(value) {
  const [address, rawPrefix] = value.split("/");
  const ip = ipv4Number(address ?? "");
  const prefix = Number(rawPrefix);
  if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ip / size) * size;
  return [start, start + size - 1];
}

function subnetsOverlap(left, right) {
  const leftRange = cidrRange(left);
  const rightRange = cidrRange(right);
  return Boolean(leftRange && rightRange && leftRange[0] <= rightRange[1] && rightRange[0] <= leftRange[1]);
}

function occupiedIpv4Routes() {
  const result = spawnSync("ip", ["-o", "-4", "route", "show"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0 || !result.stdout) return [];
  return [...result.stdout.matchAll(/(?:^|\s)(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})(?:\s|$)/gmu)].map((match) => match[1]).filter(Boolean);
}

function allocateIsolatedSubnets(count) {
  const networkIds = docker(["network", "ls", "-q"], { capture: true }).split(/\s+/u).filter(Boolean);
  const inspected = networkIds.length
    ? docker(["network", "inspect", "--format", "{{range .IPAM.Config}}{{println .Subnet}}{{end}}", ...networkIds], { capture: true })
    : "";
  const occupied = [...inspected.split(/\s+/u), ...occupiedIpv4Routes()].filter((subnet) => cidrRange(subnet));
  const candidates = [];
  for (let second = 240; second <= 255; second += 1) {
    for (let third = 0; third < 256; third += 1) candidates.push(`10.${second}.${third}.0/24`);
  }
  const selected = [];
  for (const candidate of candidates) {
    if ([...occupied, ...selected].some((subnet) => subnetsOverlap(candidate, subnet))) continue;
    selected.push(candidate);
    if (selected.length === count) return selected;
  }
  throw new Error("Non trovo due subnet IPv4 private e libere per i WordPress Docker usa-e-getta.");
}

/** The newest release zip of the plugin in the builder's dist/ (xb-X.Y.Z-commit.zip), by version. */
async function newestPluginZip() {
  const directory = path.join(histosRoot, "dist");
  const version = (name) => name.match(/^xb-(\d+)\.(\d+)\.(\d+)-[0-9a-f]+\.zip$/u)?.slice(1).map(Number) ?? null;
  const zips = (await readdir(directory).catch(() => [])).filter((name) => version(name));
  zips.sort((left, right) => {
    const [a, b] = [version(left), version(right)];
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  if (!zips.length) throw new Error("Nessuno zip del plugin in dist/ del builder: imposta HISTOS_PARITY_PLUGIN_ZIP.");
  return path.join(directory, zips.at(-1));
}

/** The plugin from a release zip instead of the builder's working tree, mounted where compose.yml mounts plugin/. */
async function pluginOverride(chosen, folder = "plugin") {
  const zip = chosen ?? (process.env.HISTOS_PARITY_PLUGIN_ZIP?.trim() ? path.resolve(process.env.HISTOS_PARITY_PLUGIN_ZIP.trim()) : await newestPluginZip());
  const unpacked = path.join(temporaryDirectory, folder);
  await mkdir(unpacked, { mode: 0o755 });
  const unzip = spawnSync("unzip", ["-q", zip, "-d", unpacked], { stdio: "inherit" });
  if (unzip.status !== 0) throw new Error(`Lo zip del plugin non si apre: ${zip}`);
  await chmod(unpacked, 0o755);
  process.stdout.write(`Plugin Histeon da ${path.relative(histosRoot, zip).startsWith("..") ? zip : path.relative(histosRoot, zip)}.\n`);
  const mount = `      - ${path.join(unpacked, "xb")}:/var/www/html/wp-content/plugins/xb\n`;
  return `services:\n  wordpress:\n    volumes:\n${mount}  cli:\n    volumes:\n${mount}`;
}
const pluginFile = scenario.pluginZip ? path.join(temporaryDirectory, "plugin.override.yml") : null;
if (pluginFile) await writeFile(pluginFile, await pluginOverride(), { mode: 0o600 });

/**
 * Doc 23 item 202: the release zips of the Histeon this Publish knows (HISTEON_VERSION) and of the one before it, from
 * HISTOS_VERSIONS_ZIP_DIR (default: the builder's dist/), signed ones first; or HISTOS_VERSIONS_NEW_ZIP / _OLD_ZIP.
 * HISTOS_VERSIONS_NEW_ZIP=checkout puts on B the plugin of the builder checkout itself (its plugin/, as compose.yml
 * mounts it), to try a fix before its release.
 */
async function versionZips() {
  const { HISTEON_VERSION, compareHisteon } = await import(path.join(publishRoot, "packages/server/dist/histeon-version.js"));
  const directory = process.env.HISTOS_VERSIONS_ZIP_DIR?.trim() ? path.resolve(process.env.HISTOS_VERSIONS_ZIP_DIR.trim()) : path.join(histosRoot, "dist");
  const names = await readdir(directory).catch(() => []);
  const zips = names.map((name) => ({ name, version: name.match(/^xb-(\d+\.\d+\.\d+)-[0-9a-f]+\.zip$/u)?.[1] })).filter((item) => item.version).map((item) => ({ ...item, signed: names.includes(`${item.name}.minisig`) }));
  const pick = (items) => items.sort((left, right) => compareHisteon(right.version, left.version) || Number(right.signed) - Number(left.signed))[0];
  const fromEnv = (name) => process.env[name]?.trim() ? { file: path.resolve(process.env[name].trim()), version: path.basename(process.env[name].trim()).match(/^xb-(\d+\.\d+\.\d+)-/u)?.[1] } : null;
  const known = pick(zips.filter((item) => compareHisteon(item.version, HISTEON_VERSION) === 0));
  const checkout = process.env.HISTOS_VERSIONS_NEW_ZIP?.trim() === "checkout";
  const header = checkout ? (await readFile(path.join(histosRoot, "plugin/xb.php"), "utf8")).match(/^\s*\*\s*Version:\s*(\d+\.\d+\.\d+)/mu)?.[1] : null;
  const newer = checkout ? { file: null, version: header } : fromEnv("HISTOS_VERSIONS_NEW_ZIP") ?? (known ? { file: path.join(directory, known.name), version: known.version } : null);
  // N−1 is the release before the Histeon this Publish knows, whatever B gets.
  const before = pick(zips.filter((item) => compareHisteon(item.version, HISTEON_VERSION) < 0));
  const older = fromEnv("HISTOS_VERSIONS_OLD_ZIP") ?? (before ? { file: path.join(directory, before.name), version: before.version } : null);
  if (!newer?.version || !older?.version) throw new Error(`Servono gli zip di Histeon ${HISTEON_VERSION} e di una versione prima in ${directory}, o HISTOS_VERSIONS_NEW_ZIP e HISTOS_VERSIONS_OLD_ZIP.`);
  if (compareHisteon(older.version, newer.version) >= 0) throw new Error(`Lo zip vecchio (${older.version}) non è più vecchio di quello nuovo (${newer.version}).`);
  return { older, newer };
}
const versions = scenario.versionZips ? await versionZips() : null;
if (versions) {
  for (const [context, zip, folder] of [[composeContexts[0], versions.older, "plugin-vecchio"], [composeContexts[1], versions.newer, "plugin-nuovo"]]) {
    if (!zip.file) {
      process.stdout.write(`Plugin Histeon ${zip.version} dal checkout del builder (${path.join(histosRoot, "plugin")}).\n`);
      continue;
    }
    context.pluginFile = path.join(temporaryDirectory, `${folder}.override.yml`);
    await writeFile(context.pluginFile, await pluginOverride(zip.file, folder), { mode: 0o600 });
  }
}

const subnets = allocateIsolatedSubnets(composeContexts.length);
for (const [context, subnet] of composeContexts.map((context, index) => [context, subnets[index]])) {
  if (!subnet) throw new Error("Subnet di test non assegnata.");
  context.subnet = subnet;
  await writeFile(context.networkFile, `networks:\n  default:\n    ipam:\n      config:\n        - subnet: ${subnet}\n`, { mode: 0o600 });
  await chmod(context.networkFile, 0o600);
}

async function createPairingCode(context) {
  const php = String.raw`require "/var/www/html/wp-load.php"; $user=get_user_by("login","admin"); if (!$user) { fwrite(STDERR,"admin user missing"); exit(2); } wp_set_current_user($user->ID); echo \XB\Cms\Link::create("Histeon local integration test",true,true,false);`;
  const code = docker(["exec", context.wordpressContainer, "php", "-r", php], { capture: true, sensitive: true });
  if (!code.startsWith(pairingPrefix)) throw new Error("WordPress non ha restituito un pairing Histeon valido.");
  await writeFile(context.pairingFile, `${code}\n`, { mode: 0o600 });
  await chmod(context.pairingFile, 0o600);
}

async function waitForWordPress(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    throwIfInterrupted();
    try {
      const response = await fetch(new URL("/wp-json/", url), { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        throwIfInterrupted();
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("WordPress non ha risposto entro 60 secondi sul loopback locale.");
}

/**
 * WooCommerce (GPL, free) in the disposable stack only, never in a repository: the zip HISTOS_WOOCOMMERCE_ZIP names, or
 * the stable one from WordPress.org, unpacked in the temporary directory and copied into the container.
 */
async function installWooCommerce(context) {
  let zip = process.env.HISTOS_WOOCOMMERCE_ZIP?.trim() ? path.resolve(process.env.HISTOS_WOOCOMMERCE_ZIP.trim()) : "";
  if (!zip) {
    process.stdout.write("Scarico WooCommerce da WordPress.org…\n");
    const response = await fetch("https://downloads.wordpress.org/plugin/woocommerce.latest-stable.zip", { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`WooCommerce non scaricato da WordPress.org (HTTP ${response.status}).`);
    zip = path.join(temporaryDirectory, "woocommerce.zip");
    await writeFile(zip, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  }
  const unpacked = path.join(temporaryDirectory, "woocommerce-plugin");
  await mkdir(unpacked, { mode: 0o700 });
  const unzip = spawnSync("unzip", ["-q", zip, "-d", unpacked], { stdio: "inherit" });
  if (unzip.status !== 0) throw new Error("Lo zip di WooCommerce non si apre.");
  compose(context, "cp", path.join(unpacked, "woocommerce"), "wordpress:/var/www/html/wp-content/plugins/woocommerce");
  compose(context, "exec", "-T", "wordpress", "chown", "-R", "www-data:www-data", "/var/www/html/wp-content/plugins/woocommerce");
  wp(context, "plugin", "activate", "woocommerce");
  throwIfInterrupted();
}

/**
 * The Lingua Bridge zip the builder pins in its modules.json (path relative to the builder), when its sha256 matches:
 * `kit prova` passes only HISTOS_BUILDER_DIR. Empty when the builder pins none or the file is missing or different.
 */
async function pinnedLinguaBridgeZip() {
  try {
    const modules = JSON.parse(await readFile(path.join(histosRoot, "modules.json"), "utf8"));
    const pinned = modules?.["lingua-bridge"];
    if (typeof pinned?.zip !== "string" || typeof pinned?.sha256 !== "string") return "";
    const zip = path.resolve(histosRoot, pinned.zip);
    const digest = createHash("sha256").update(await readFile(zip)).digest("hex");
    return digest === pinned.sha256.toLowerCase() ? zip : "";
  } catch {
    return "";
  }
}

/** Lingua Bridge in the disposable stack only, from its release zip, as a site would install it. */
async function installLinguaBridge(context) {
  const zip = process.env.HISTOS_LINGUA_BRIDGE_ZIP?.trim() ? path.resolve(process.env.HISTOS_LINGUA_BRIDGE_ZIP.trim()) : await pinnedLinguaBridgeZip();
  if (!zip) throw new Error("Set HISTOS_LINGUA_BRIDGE_ZIP to a release zip of Lingua Bridge (the builder's modules.json pins none that is readable).");
  const unpacked = path.join(temporaryDirectory, "lingua-bridge-plugin");
  await mkdir(unpacked, { mode: 0o700 });
  const unzip = spawnSync("unzip", ["-q", zip, "-d", unpacked], { stdio: "inherit" });
  if (unzip.status !== 0) throw new Error("Lo zip di Lingua Bridge non si apre.");
  compose(context, "cp", path.join(unpacked, "lingua-bridge"), "wordpress:/var/www/html/wp-content/plugins/lingua-bridge");
  compose(context, "exec", "-T", "wordpress", "chown", "-R", "www-data:www-data", "/var/www/html/wp-content/plugins/lingua-bridge");
  wp(context, "plugin", "activate", "lingua-bridge");
  throwIfInterrupted();
}

async function startWordPress(context, label) {
  throwIfInterrupted();
  const port = await freeLoopbackPort();
  const password = randomBytes(32).toString("hex");
  const databasePassword = randomBytes(32).toString("hex");
  const mockToken = randomBytes(32).toString("hex");
  const baseUrl = `http://localhost:${port}`;
  await writeFile(context.environmentFile, `XB_DB_PASSWORD=${databasePassword}\nXB_ADMIN_PASSWORD=${password}\nXB_PORT=${port}\nXB_MOCK_TOKEN=${mockToken}\n`, { mode: 0o600 });
  await chmod(context.environmentFile, 0o600);

  process.stdout.write(`Avvio WordPress ${label} usa-e-getta sulla porta locale ${port}…\n`);
  context.stackMayExist = true;
  compose(context, "up", "-d", "--wait", "db", "wordpress");
  throwIfInterrupted();
  await waitForWordPress(baseUrl);
  wp(context, "core", "install", `--url=${baseUrl}`, `--title=Histeon CMS local test ${label}`, "--admin_user=admin", `--admin_password=${password}`, "--admin_email=admin@example.test", "--skip-email");
  throwIfInterrupted();
  wp(context, "config", "set", "WP_ENVIRONMENT_TYPE", "local", "--type=constant", "--quiet");
  wp(context, "rewrite", "structure", "/%postname%/");
  wp(context, "theme", "activate", "xb-blank");
  wp(context, "plugin", "activate", "xb");
  await createPairingCode(context);
  // After the pairing: with WooCommerce active, PHP notices of the debug site would print before the code.
  if (scenario.woocommerce) await installWooCommerce(context);
  if (scenario.linguaBridge) await installLinguaBridge(context);
  throwIfInterrupted();
  context.baseUrl = baseUrl;
  return { port, baseUrl };
}

let testError;
try {
  for (const [index, context] of composeContexts.entries()) await startWordPress(context, ["A", "B"][index]);
  throwIfInterrupted();

  process.stdout.write(`${composeContexts.length === 1 ? "L'installazione WordPress usa-e-getta è pronta" : "Le installazioni WordPress indipendenti sono pronte"}; eseguo: ${scenario.title}…\n`);
  const [program, ...programArgs] = scenario.command ?? [process.execPath, path.join(publishRoot, scenario.script)];
  const result = spawnSync(program, [...programArgs, ...(scenario.command ? process.argv.slice(2).filter((arg) => arg !== "--parita") : [])], {
    cwd: publishRoot,
    env: {
      ...process.env,
      HISTOS_PARITY_WP_URL: composeContexts[0].baseUrl,
      HISTOS_PARITY_WP_CONTAINER: composeContexts[0].wordpressContainer,
      HISTOS_TEST_WP_CONTAINER: composeContexts[0].wordpressContainer,
      HISTOS_TEST_WP_URL: composeContexts[0].baseUrl,
      ...(composeContexts[1] ? { HISTOS_TEST_SECOND_WP_URL: composeContexts[1].baseUrl } : {}),
      ...(versions ? { HISTOS_VERSIONS_OLD_HISTEON: versions.older.version, HISTOS_VERSIONS_NEW_HISTEON: versions.newer.version } : {}),
      HISTOS_TEST_PAIRING_CODE_FILE: composeContexts[0].pairingFile,
      ...(composeContexts[1] ? { HISTOS_TEST_SECOND_WP_CONTAINER: composeContexts[1].wordpressContainer, HISTOS_TEST_SECOND_PAIRING_CODE_FILE: composeContexts[1].pairingFile } : {}),
    },
    stdio: "inherit",
  });
  throwIfInterrupted();
  if (result.error) throw new Error(`Test CMS non avviato: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Test CMS non superato (codice ${result.status ?? "sconosciuto"}).`);
} catch (error) {
  testError = error;
}

let cleanupError;
for (const context of [...composeContexts].reverse()) {
  if (!context.stackMayExist) continue;
  try {
    compose(context, "down", "--volumes", "--remove-orphans");
  } catch (error) {
    cleanupError ??= error;
  }
}
await rm(temporaryDirectory, { recursive: true, force: true });
if (cleanupError && testError) {
  const projects = composeContexts.filter((context) => context.stackMayExist).map((context) => context.projectName).join(", ");
  process.stderr.write(`Pulizia Docker incompleta per ${projects}; controllare esclusivamente questi progetti Compose.\n`);
}
if (cleanupError) {
  const message = interruptedSignal
    ? `Interruzione ${interruptedSignal} con cleanup Docker incompleto: ${cleanupError.message}`
    : `Test superato ma cleanup Docker non riuscito: ${cleanupError.message}`;
  throw new Error(message);
}
if (interruptedSignal) {
  process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
  process.stderr.write(`Test interrotto (${interruptedSignal}); entrambi gli stack e le credenziali temporanee sono stati rimossi.\n`);
} else if (testError) {
  throw testError;
} else {
  process.stdout.write(`${scenario.title} superato; entrambi gli stack e le credenziali temporanee rimossi.\n`);
}
