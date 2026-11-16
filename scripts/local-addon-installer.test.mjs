import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getLinuxLocalUserDataDirectory, installLocalAddon, isLocalRunning } from "./local-addon-installer.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const addonSourceDirectory = path.resolve(scriptDirectory, "../integrations/local-addon-histos-publish");

async function withTemporaryDirectory(operation) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "histos-local-addon-test-"));
  try {
    await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("installa l’add-on direttamente nella cartella dati di Local e mantiene gli altri add-on abilitati", async () => {
  await withTemporaryDirectory(async (directory) => {
    const localData = path.join(directory, "Local");
    await mkdir(localData, { recursive: true });
    await writeFile(path.join(localData, "enabled-addons.json"), '{"un altro add-on":true}\n');

    const result = await installLocalAddon({ addonSourceDirectory, localUserDataDirectory: localData, checkLocalRunning: false });
    const manifest = JSON.parse(await readFile(path.join(result.targetDirectory, "package.json"), "utf8"));
    const enabled = JSON.parse(await readFile(path.join(localData, "enabled-addons.json"), "utf8"));

    assert.equal(result.installed, true);
    assert.equal(result.enabled, true);
    assert.equal(manifest.version, "0.1.2");
    assert.equal(enabled["un altro add-on"], true);
    assert.equal(enabled[manifest.slug], true);
    assert.deepEqual(new Set(await readdir(result.targetDirectory)), new Set(["package.json", ...manifest.files]));
  });
});

test("ripetere l’installazione non crea backup inutili", async () => {
  await withTemporaryDirectory(async (directory) => {
    const localData = path.join(directory, "Local");
    await mkdir(localData, { recursive: true });
    const first = await installLocalAddon({ addonSourceDirectory, localUserDataDirectory: localData, checkLocalRunning: false });
    const second = await installLocalAddon({ addonSourceDirectory, localUserDataDirectory: localData, checkLocalRunning: false });

    assert.equal(first.installed, true);
    assert.equal(second.installed, false);
    assert.equal(second.backupDirectory, undefined);
    assert.deepEqual(await readdir(path.join(localData, "addons")), ["histos-publish-local-addon"]);
  });
});

test("aggiornare una copia esistente la conserva come backup", async () => {
  await withTemporaryDirectory(async (directory) => {
    const localData = path.join(directory, "Local");
    await mkdir(localData, { recursive: true });
    const oldAddon = path.join(localData, "addons", "histos-publish-local-addon");
    await mkdir(oldAddon, { recursive: true });
    await writeFile(path.join(oldAddon, "versione-precedente.txt"), "conservare");

    const result = await installLocalAddon({ addonSourceDirectory, localUserDataDirectory: localData, checkLocalRunning: false });
    assert.ok(result.backupDirectory);
    assert.equal(await readFile(path.join(result.backupDirectory, "versione-precedente.txt"), "utf8"), "conservare");
    assert.equal(JSON.parse(await readFile(path.join(result.targetDirectory, "package.json"), "utf8")).version, "0.1.2");
  });
});

test("un registro Local malformato ferma l’installazione senza sostituire file", async () => {
  await withTemporaryDirectory(async (directory) => {
    const localData = path.join(directory, "Local");
    await mkdir(localData, { recursive: true });
    await writeFile(path.join(localData, "enabled-addons.json"), "non-json");

    await assert.rejects(
      installLocalAddon({ addonSourceDirectory, localUserDataDirectory: localData, checkLocalRunning: false }),
      /JSON/u,
    );
    await assert.rejects(readdir(path.join(localData, "addons")), { code: "ENOENT" });
  });
});

test("Local carica gli entry point e il menu apre il collegamento registrato", async () => {
  await withTemporaryDirectory(async (directory) => {
    const localData = path.join(directory, "Local");
    await mkdir(localData, { recursive: true });
    const result = await installLocalAddon({ addonSourceDirectory, localUserDataDirectory: localData, checkLocalRunning: false });
    const requireFromAddon = createRequire(path.join(result.targetDirectory, "package.json"));
    const MainAddon = requireFromAddon("./main.js");
    const registerRenderer = requireFromAddon("./renderer.js");
    const context = { hooks: { addFilter() {} } };
    assert.equal(typeof MainAddon, "function");
    assert.doesNotThrow(() => new MainAddon(context));

    let filterName;
    let filter;
    let openedUrl;
    registerRenderer({
      hooks: { addFilter(name, callback) { filterName = name; filter = callback; } },
      electron: { shell: { openExternal(url) { openedUrl = url; return Promise.resolve(); } } },
      notifier: { notify() { throw new Error("Non è previsto alcun avviso per un sito .local valido."); } },
    });
    const menu = filter([], { name: "Demo", domain: "demo.local" });
    assert.equal(filterName, "siteInfoMoreMenu");
    assert.equal(menu.length, 1);
    assert.equal(menu[0].label, "Apri in Histeon Publish");
    menu[0].click();
    await new Promise((resolve) => setImmediate(resolve));
    const deepLink = new URL(openedUrl);
    assert.equal(deepLink.protocol, "histos-publish:");
    assert.equal(deepLink.searchParams.get("url"), "http://demo.local/");
    assert.equal(deepLink.searchParams.get("name"), "Demo");
  });
});

test("rifiuta una cartella addons collegata con symlink", { skip: process.platform === "win32" }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const localData = path.join(directory, "Local");
    const externalDirectory = path.join(directory, "external-addons");
    await mkdir(localData, { recursive: true });
    await mkdir(externalDirectory);
    await symlink(externalDirectory, path.join(localData, "addons"));

    await assert.rejects(
      installLocalAddon({ addonSourceDirectory, localUserDataDirectory: localData, checkLocalRunning: false }),
      /sicura/u,
    );
    assert.deepEqual(await readdir(externalDirectory), []);
  });
});

test("individua Local in esecuzione prima di sostituire i file", { skip: process.platform === "win32" }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const fakeProc = path.join(directory, "proc");
    await mkdir(path.join(fakeProc, "123"), { recursive: true });
    await symlink("/opt/Local/local", path.join(fakeProc, "123", "exe"));
    assert.equal(await isLocalRunning(fakeProc), true);
  });
});

test("usa XDG_CONFIG_HOME quando è definito", () => {
  assert.equal(
    getLinuxLocalUserDataDirectory({ XDG_CONFIG_HOME: "/tmp/local-test" }, "/home/test"),
    "/tmp/local-test/Local",
  );
});
