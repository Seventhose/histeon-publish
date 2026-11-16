import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { startLocalFtpServer } from "./fixtures/local-ftp-server.mjs";
import { startLocalSftpServer } from "./fixtures/local-sftp-server.mjs";

const executablePath = process.env.HISTOS_PUBLISH_ELECTRON_PATH;
if (!executablePath) throw new Error("HISTOS_PUBLISH_ELECTRON_PATH deve indicare l’eseguibile Electron impacchettato.");
const isAppImage = process.env.HISTOS_PUBLISH_APPIMAGE === "1";
const configuredUserDataDirectory = process.env.HISTOS_PUBLISH_TEST_USER_DATA_DIR?.trim();

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Impossibile riservare una porta di test.");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

/**
 * A JPEG of 640×480 made with the same jSquash encoder the app ships (queue B6): a gradient, so that the modern formats
 * are lighter than it.
 */
async function sampleJpeg() {
  const { readFile: read } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const { default: encode, init } = await import("@jsquash/jpeg/encode.js");
  await init(await WebAssembly.compile(await read(require.resolve("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"))));
  const width = 640;
  const height = 480;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([(x * 255) / width, (y * 255) / height, 140 + ((x * y) % 40), 255], (y * width + x) * 4);
  return Buffer.from(await encode({ data, width, height }, { quality: 90 }));
}

async function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function appApi(page, route, { method = "GET", body } = {}) {
  return page.evaluate(async ({ route, method, body }) => {
    const token = sessionStorage.getItem("histos-publish-session") ?? "";
    const response = await fetch(route, {
      method,
      headers: {
        "X-Histos-Token": token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, data };
  }, { route, method, body });
}

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-packaged-electron-"));
const userDataDirectory = configuredUserDataDirectory
  ? path.resolve(configuredUserDataDirectory)
  : path.join(temporaryDirectory, "electron-user-data");
const dataDirectory = path.join(temporaryDirectory, "app-data");
const port = await availablePort();
const environment = { ...process.env, HISTOS_PUBLISH_DATA_DIR: dataDirectory };
delete environment.HISTOS_CLOUDFLARE_API_TOKEN;
delete environment.CLOUDFLARE_API_TOKEN;
delete environment.CLOUDFLARE_ACCOUNT_ID;
delete environment.HISTOS_CLOUDFLARE_ACCOUNT_ID;
delete environment.HISTOS_WP_BASIC_USER;
delete environment.HISTOS_WP_BASIC_PASSWORD;
delete environment.HISTOS_WP_COOKIE;
delete environment.WAYLAND_DISPLAY;
delete environment.WAYLAND_SOCKET;

const electronArguments = [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDirectory}`];
if (process.platform === "linux") {
  // CI runs a throwaway GNOME Keyring without a desktop session: name the backend instead of letting Chromium guess.
  const passwordStore = process.env.HISTOS_TEST_PASSWORD_STORE;
  if (passwordStore === "gnome-libsecret" || passwordStore === "kwallet5" || passwordStore === "kwallet6") electronArguments.push(`--password-store=${passwordStore}`);
  electronArguments.unshift("--ozone-platform=x11");
  if (!isAppImage) electronArguments.unshift("--no-sandbox");
}
const child = spawn(executablePath, electronArguments, {
  cwd: path.dirname(executablePath), env: environment, stdio: ["ignore", "pipe", "pipe"], detached: process.platform === "linux",
});
const output = [];
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => output.push(chunk));
}

let browser;
let localSftp;
let localFtp;
let localFtps;
try {
  localSftp = await startLocalSftpServer();
  localFtp = await startLocalFtpServer();
  localFtps = await startLocalFtpServer({ secure: true });
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let connected = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron si è chiuso prima di avviare il protocollo di test.\n${output.join("")}`);
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) { connected = true; break; }
    } catch { /* Il listener Chromium non è ancora pronto. */ }
    await wait(200);
  }
  if (!connected) throw new Error(`Electron non ha avviato il protocollo di test entro 60 secondi.\n${output.join("")}`);

  browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  const context = browser.contexts()[0];
  assert.ok(context, "Electron non ha esposto un contesto browser.");
  let page = context.pages()[0];
  if (!page) {
    try { page = await context.waitForEvent("page", { timeout: 15_000 }); }
    catch (error) { throw new Error(`Electron non ha aperto una pagina dell’app.\n${output.join("")}`, { cause: error }); }
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
  // Stable identifiers, not labels (list item 107): a word changed in the interface must not stop the package build.
  await page.getByTestId("home-title").waitFor({ state: "visible", timeout: 15_000 });
  if (isAppImage && process.platform === "linux") {
    const namespaceCheck = spawnSync("unshare", ["--user", "--map-root-user", "--pid", "--fork", "true"], { stdio: "ignore" });
    const fallbackExpected = namespaceCheck.status !== 0;
    const notice = page.locator(".sandbox-notice");
    try {
      await notice.waitFor({ state: fallbackExpected ? "visible" : "hidden", timeout: 10_000 });
    } catch (error) {
      throw new Error(`L’avviso AppImage non corrisponde al sandbox disponibile (fallback atteso: ${fallbackExpected}).\n${output.join("")}`, { cause: error });
    }
    if (fallbackExpected) assert.match(await notice.innerText(), /\.deb/u, "L’AppImage non avvisa del sandbox Chromium disattivato su questo sistema.");
  }
  assert.match(page.url(), /^app:\/\/histos-publish\//u);
  const bootstrapStatus = await page.evaluate(async () => {
    const token = sessionStorage.getItem("histos-publish-session") ?? "";
    return (await fetch("/api/bootstrap", { headers: { "X-Histos-Token": token } })).status;
  });
  assert.equal(bootstrapStatus, 200, "La API locale non ha completato il bootstrap.");

  await page.getByTestId("home-new-site").click();
  await page.locator("#file-html").setInputFiles({
    name: "index.html",
    mimeType: "text/html",
    buffer: Buffer.from("<!doctype html><html lang=\"it\"><head><meta charset=\"utf-8\"><title>Prova pacchetto</title></head><body><h1>Test desktop</h1></body></html>"),
  });
  await page.locator("#site-name").fill("Test pacchetto");
  await page.locator("#worker-name").fill("test-pacchetto");
  await page.getByTestId("new-site-save").click();
  await page.getByTestId("site-build").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("site-build").click();
  // The version is ready when its ZIP can be downloaded.
  await page.locator('[data-testid="site-export"]:not([disabled])').waitFor({ state: "visible", timeout: 30_000 });

  const bootstrap = await appApi(page, "/api/bootstrap");
  assert.equal(bootstrap.status, 200, "Il bootstrap dell’app deve restare disponibile dopo la build.");
  const site = bootstrap.data.sites.find((candidate) => candidate.name === "Test pacchetto");
  assert.ok(site?.id, "Il sito creato dal test deve comparire nel bootstrap.");
  const history = await appApi(page, `/api/sites/${encodeURIComponent(site.id)}/history`);
  assert.equal(history.status, 200, "Lo storico della build deve essere disponibile.");
  const build = history.data.builds.find((candidate) => candidate.status === "ready");
  assert.ok(build?.id, "La build pronta deve avere un identificativo.");

  const hostingSettings = {
    protocol: "sftp",
    host: localSftp.host,
    port: localSftp.port,
    remoteDirectory: "/public/packaged-smoke",
    username: "publisher",
  };
  const credentials = { username: "publisher", password: "local-only-password" };
  const hostingRoute = `/api/sites/${encodeURIComponent(site.id)}/hosting`;
  const discovery = await appApi(page, hostingRoute, {
    method: "POST",
    body: { settings: hostingSettings, ...credentials },
  });
  assert.equal(discovery.status, 200, `Il test SFTP dell’app impacchettata non ha letto l’impronta host: ${JSON.stringify(discovery.data)}`);
  assert.deepEqual(discovery.data, {
    hostKeyConfirmationRequired: true,
    hostKeyFingerprint: localSftp.fingerprint,
  }, "L’app deve chiedere conferma dell’impronta prima di salvare il server SFTP.");

  const savedHosting = await appApi(page, hostingRoute, {
    method: "POST",
    body: {
      settings: { ...hostingSettings, hostKeyFingerprint: localSftp.fingerprint },
      ...credentials,
      confirmHostKeyFingerprint: localSftp.fingerprint,
    },
  });
  assert.equal(savedHosting.status, 200, `Le credenziali SFTP non sono state salvate nel portachiavi del sistema: ${JSON.stringify(savedHosting.data)}`);
  assert.equal(savedHosting.data.site?.hostingCredentialsConfigured, true, "La configurazione SFTP verificata deve risultare salvata.");

  const deployment = await appApi(page, `/api/sites/${encodeURIComponent(site.id)}/deploy`, {
    method: "POST",
    body: { confirmed: true, buildId: build.id },
  });
  assert.equal(deployment.status, 202, `La pubblicazione SFTP non è partita: ${JSON.stringify(deployment.data)}`);
  const deployDeadline = Date.now() + 45_000;
  let deployed;
  while (Date.now() < deployDeadline) {
    const updatedHistory = await appApi(page, `/api/sites/${encodeURIComponent(site.id)}/history`);
    assert.equal(updatedHistory.status, 200, "Lo storico deve essere disponibile durante il deploy SFTP.");
    deployed = updatedHistory.data.deploys.find((candidate) => candidate.id === deployment.data.deployId);
    if (deployed?.status === "deployed" || deployed?.status === "failed") break;
    await wait(150);
  }
  assert.equal(deployed?.status, "deployed", `Il deploy SFTP dell’app impacchettata non si è concluso: ${JSON.stringify(deployed)}`);
  assert.ok(localSftp.state.files.has("/public/packaged-smoke/index.html"), "Il server SFTP deve ricevere index.html dal bundle pronto.");
  assert.equal(localSftp.state.authenticatedUsers.length, 2, "Il server deve aver autenticato il controllo host pinning e il deploy.");

  const ftpSettings = {
    protocol: "ftp",
    host: localFtp.host,
    port: localFtp.port,
    remoteDirectory: "/public/packaged-ftp-smoke",
    username: "publisher",
    allowInsecureFtp: true,
  };
  const ftpHosting = await appApi(page, hostingRoute, {
    method: "POST",
    body: { settings: ftpSettings, ...credentials },
  });
  assert.equal(ftpHosting.status, 200, `La verifica FTP dell’app impacchettata non è riuscita: ${JSON.stringify(ftpHosting.data)}`);
  assert.equal(ftpHosting.data.site?.hostingCredentialsConfigured, true, "Le credenziali FTP verificate devono risultare salvate.");
  const ftpDeployment = await appApi(page, `/api/sites/${encodeURIComponent(site.id)}/deploy`, {
    method: "POST",
    body: { confirmed: true, buildId: build.id },
  });
  assert.equal(ftpDeployment.status, 202, `La pubblicazione FTP non è partita: ${JSON.stringify(ftpDeployment.data)}`);
  const ftpDeadline = Date.now() + 45_000;
  let ftpDeployed;
  while (Date.now() < ftpDeadline) {
    const updatedHistory = await appApi(page, `/api/sites/${encodeURIComponent(site.id)}/history`);
    assert.equal(updatedHistory.status, 200, "Lo storico deve essere disponibile durante il deploy FTP.");
    ftpDeployed = updatedHistory.data.deploys.find((candidate) => candidate.id === ftpDeployment.data.deployId);
    if (ftpDeployed?.status === "deployed" || ftpDeployed?.status === "failed") break;
    await wait(150);
  }
  assert.equal(ftpDeployed?.status, "deployed", `Il deploy FTP dell’app impacchettata non si è concluso: ${JSON.stringify(ftpDeployed)}`);
  assert.ok(localFtp.state.files.has("/public/packaged-ftp-smoke/index.html"), "Il server FTP deve ricevere index.html dal bundle pronto.");
  assert.equal(localFtp.state.authenticatedUsers.length, 2, "Il server FTP deve aver verificato il login e il deploy.");

  const tlsCaCertificate = await readFile(new URL("./fixtures/certs/ftps-test-cert.pem", import.meta.url), "utf8");
  const ftpsSettings = {
    protocol: "ftps",
    host: localFtps.host,
    port: localFtps.port,
    remoteDirectory: "/public/packaged-ftps-smoke",
    username: "publisher",
    tlsCaCertificate,
  };
  const ftpsHosting = await appApi(page, hostingRoute, {
    method: "POST",
    body: { settings: ftpsSettings, ...credentials },
  });
  assert.equal(ftpsHosting.status, 200, `La verifica FTPS dell’app impacchettata non è riuscita: ${JSON.stringify(ftpsHosting.data)}`);
  assert.equal(ftpsHosting.data.site?.hostingCredentialsConfigured, true, "Le credenziali FTPS verificate devono risultare salvate.");
  const ftpsDeployment = await appApi(page, `/api/sites/${encodeURIComponent(site.id)}/deploy`, {
    method: "POST",
    body: { confirmed: true, buildId: build.id },
  });
  assert.equal(ftpsDeployment.status, 202, `La pubblicazione FTPS non è partita: ${JSON.stringify(ftpsDeployment.data)}`);
  const ftpsDeadline = Date.now() + 45_000;
  let ftpsDeployed;
  while (Date.now() < ftpsDeadline) {
    const updatedHistory = await appApi(page, `/api/sites/${encodeURIComponent(site.id)}/history`);
    assert.equal(updatedHistory.status, 200, "Lo storico deve essere disponibile durante il deploy FTPS.");
    ftpsDeployed = updatedHistory.data.deploys.find((candidate) => candidate.id === ftpsDeployment.data.deployId);
    if (ftpsDeployed?.status === "deployed" || ftpsDeployed?.status === "failed") break;
    await wait(150);
  }
  assert.equal(ftpsDeployed?.status, "deployed", `Il deploy FTPS dell’app impacchettata non si è concluso: ${JSON.stringify(ftpsDeployed)}`);
  assert.ok(localFtps.state.files.has("/public/packaged-ftps-smoke/index.html"), "Il server FTPS deve ricevere index.html dal bundle pronto.");
  assert.equal(localFtps.state.authenticatedUsers.length, 2, "Il server FTPS deve aver verificato il login e il deploy.");

  const archiveReady = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByTestId("site-export").click();
  const archive = await archiveReady;
  assert.match(archive.suggestedFilename(), /\.zip$/u, "L’app non ha esportato il bundle ZIP.");

  // B6: the image encoder runs in the packaged app (its worker and WebAssembly codecs from the ASAR archive).
  const jpeg = await sampleJpeg();
  const prototype = `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>Immagini</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"${crypto.randomUUID()}","name":"Immagini del pacchetto","framework":"none","locale":"it-IT"}</script>
<script type="application/json" data-histos="assets">[{"name":"foto","data":"data:image/jpeg;base64,${jpeg.toString("base64")}","alt":"Foto"}]</script>
</head><body><template data-histos="page" data-slug="home" data-title="Home"><main><h1>Foto</h1><img src="asset:foto" width="640" height="480" alt="Foto"></main></template></body></html>`;
  const imported = await page.evaluate(async (html) => {
    const token = sessionStorage.getItem("histos-publish-session") ?? "";
    const response = await fetch("/api/cms/v1/projects/import-prototype", { method: "POST", headers: { "X-Histos-Token": token, "Content-Type": "text/html" }, body: html });
    return { status: response.status, data: await response.json() };
  }, prototype);
  assert.equal(imported.status, 201, `L’import del prototipo con un’immagine non è riuscito: ${JSON.stringify(imported.data)}`);
  const cmsBuild = await appApi(page, `/api/cms/v1/projects/${encodeURIComponent(imported.data.project.id)}/build`, { method: "POST", body: {} });
  assert.equal(cmsBuild.status, 200, `La build CMS con un’immagine non è riuscita: ${JSON.stringify(cmsBuild.data)}`);
  assert.equal(cmsBuild.data.images?.images, 1, `Il codificatore delle immagini non ha prodotto varianti nell’app impacchettata: ${JSON.stringify(cmsBuild.data.images)}`);
  assert.ok(cmsBuild.data.images.formats.avif + cmsBuild.data.images.formats.webp >= 1, "Le varianti devono avere almeno un formato moderno.");

  // The editor loads the project's images by /__cms-media/ on app://: the app must hand them over, not answer 404.
  const media = await appApi(page, `/api/cms/v1/projects/${encodeURIComponent(imported.data.project.id)}/media`);
  assert.equal(media.status, 200, `L’elenco dei media del progetto non è riuscito: ${JSON.stringify(media.data)}`);
  const source = media.data[0]?.source_url ?? "";
  assert.match(source, /^\/__cms-media\//u, `Il media importato non ha un indirizzo /__cms-media/: ${JSON.stringify(media.data)}`);
  const served = await page.evaluate(async (url) => {
    const response = await fetch(url);
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => undefined);
    return { status: response.status, type: response.headers.get("content-type"), width: image.naturalWidth };
  }, source);
  assert.equal(served.status, 200, `L’app non serve le immagini del progetto all’editor: ${JSON.stringify(served)}`);
  assert.match(served.type ?? "", /^image\//u);
  assert.equal(served.width, 640, `L’immagine del progetto non si apre nell’app: ${JSON.stringify(served)}`);

  // «Anteprima del sito»: the whole site in a window of the app, sandboxed and without the app's bridge.
  await page.evaluate((id) => { location.hash = `#/cms/${id}`; }, imported.data.project.id);
  const previewWindow = context.waitForEvent("page", { timeout: 60_000 });
  await page.getByTestId("cms-site-preview").click();
  const sitePreview = await previewWindow;
  await sitePreview.waitForLoadState("domcontentloaded");
  assert.match(sitePreview.url(), /^http:\/\/127\.0\.0\.1:\d+\/__preview\/[^/]+\/[0-9a-f-]{36}\/index\.html$/u, `L’anteprima del sito non si è aperta nell’app: ${sitePreview.url()}`);
  assert.equal(await sitePreview.evaluate(() => typeof window.histosDesktop), "undefined", "La finestra dell’anteprima non deve avere il ponte dell’app.");
  assert.match(await sitePreview.locator("h1").first().innerText(), /Foto/u);
  await sitePreview.close();

  // The app's own updates (desktop app-updates.ts): the bridge answers, from the public releases, with no token to set.
  const updateState = await page.evaluate(() => window.histosDesktop.updates.status());
  assert.equal("tokenConfigured" in (updateState ?? {}), false, "Gli aggiornamenti dell’app non devono più dipendere da un token.");
  assert.match(updateState?.current ?? "", /^\d+\.\d+\.\d+$/u, "La versione dell’app non è leggibile.");
  assert.equal(await page.evaluate(() => typeof window.histosDesktop.updates.setToken), "undefined", "Il ponte non deve più offrire un token per gli aggiornamenti.");

  process.stdout.write("Smoke test Electron impacchettato completato: avvio, build, export ZIP, FTP/FTPS/SFTP, pinning host, CA TLS, portachiavi, deploy locali, varianti moderne, immagini del progetto nell’editor, anteprima del sito in una finestra dell’app e aggiornamenti dell’app.\n");
} finally {
  if (browser) await Promise.race([browser.close().catch(() => undefined), wait(3000)]);
  if (child.exitCode === null) {
    const signalProcess = (signal) => {
      if (process.platform === "linux" && child.pid) {
        try { process.kill(-child.pid, signal); } catch { /* Il gruppo può essere già terminato. */ }
      } else child.kill(signal);
    };
    signalProcess("SIGTERM");
    await Promise.race([once(child, "exit"), wait(5000)]);
    if (child.exitCode === null) signalProcess("SIGKILL");
  }
  if (localFtp) await localFtp.close();
  if (localFtps) await localFtps.close();
  if (localSftp) await localSftp.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
