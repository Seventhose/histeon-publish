import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliver } from "./consegne.mjs";

// The AppImage copy exists only on Linux (copy-appimage-to-applications.mjs).
const linuxOnly = { skip: process.platform !== "linux" ? "solo Linux" : false };
const sum = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture({ versioned = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-consegne-"));
  const builder = path.join(root, "builder");
  const publish = path.join(root, "publish");
  const files = {
    "builder/plugin/xb.php": "<?php\nconst XB_VERSION = '1.2.3';\n",
    "builder/dist/xb-1.2.3-abc1234.zip": "plugin",
    "builder/dist/xb-1.2.3-abc1234.zip.minisig": "firma",
    "builder/dist/xb-blank-0.3.1-abc1234.zip": "tema",
    "builder/dist/fondamenta-0.1.0-abc1234.zip": "fondamenta",
    "modules/lingua-bridge-2.0.0.zip": "lingua",
    "modules/static-bridge-3.0.0.zip": "static",
    "publish/packages/desktop/package.json": JSON.stringify({ version: "9.8.7" }),
    "publish/packages/desktop/release/Histeon-Publish-9.8.7-linux-x64.AppImage": "appimage",
    "publish/packages/desktop/release/histos-publish_9.8.7_amd64.deb": "deb",
    // What the folders hold before: an older delivery and a file of the owner.
    "Documenti/Applicazioni/Plugin/xb-1.2.2-0000000.zip": "vecchio",
    "Documenti/Applicazioni/Plugin/fondamenta-0.0.9-0000000.zip": "vecchio",
    "Documenti/Applicazioni/Plugin/lingua-bridge-1.9.0.zip": "vecchio",
    "Documenti/Applicazioni/Plugin/appunti.txt": "mio",
    "installer/Histeon-Publish-9.8.6-linux-x64.AppImage": "vecchio",
    "installer/histos-publish_9.8.6_amd64.deb": "vecchio",
  };
  // scripts/release-linux.mjs writes into release/<version>/, a plain dist:linux into release/.
  const release = versioned ? "publish/packages/desktop/release/9.8.7" : "publish/packages/desktop/release";
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name.replace("publish/packages/desktop/release", release));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  await writeFile(path.join(builder, "dist/SHA256SUMS"), `${sum("plugin")}  xb-1.2.3-abc1234.zip\n${sum("fondamenta")}  fondamenta-0.1.0-abc1234.zip\n${sum("tema")}  xb-blank-0.3.1-abc1234.zip\n`);
  await writeFile(path.join(builder, "modules.json"), JSON.stringify({
    "lingua-bridge": { zip: "../modules/lingua-bridge-2.0.0.zip", sha256: sum("lingua") },
    "static-bridge": { zip: "../modules/static-bridge-3.0.0.zip", sha256: sum("static") },
  }));
  await writeFile(path.join(root, release, "SHA256SUMS.txt"), `${sum("appimage")}  Histeon-Publish-9.8.7-linux-x64.AppImage\n${sum("deb")}  histos-publish_9.8.7_amd64.deb\n`);
  const env = { HISTOS_APPLICATIONS_DIR: path.join(root, "Documenti/Applicazioni"), HISTOS_INSTALLER_DIRS: path.join(root, "installer") };
  return { root, builder, publish, env };
}

test("consegna i pacchetti verificati, toglie solo le versioni vecchie e scrive le somme", linuxOnly, async () => {
  const f = await fixture();
  try {
    await deliver({ builder: f.builder, publish: f.publish, env: f.env, home: f.root });
    const plugin = path.join(f.root, "Documenti/Applicazioni/Plugin");
    assert.deepEqual((await readdir(plugin)).sort(), ["SHA256SUMS.txt", "appunti.txt", "fondamenta-0.1.0-abc1234.zip", "lingua-bridge-2.0.0.zip", "static-bridge-3.0.0.zip", "xb-1.2.3-abc1234.zip", "xb-1.2.3-abc1234.zip.minisig", "xb-blank-0.3.1-abc1234.zip"]);
    assert.match(await readFile(path.join(plugin, "SHA256SUMS.txt"), "utf8"), new RegExp(`${sum("lingua")}  lingua-bridge-2\\.0\\.0\\.zip`, "u"));
    assert.deepEqual((await readdir(path.join(f.root, "installer"))).sort(), ["Histeon-Publish-9.8.7-linux-x64.AppImage", "SHA256SUMS.txt", "fondamenta-0.1.0-abc1234.zip", "histos-publish_9.8.7_amd64.deb", "xb-1.2.3-abc1234.zip", "xb-1.2.3-abc1234.zip.minisig", "xb-blank-0.3.1-abc1234.zip"]);
    assert.ok((await readdir(path.join(f.root, "Documenti/Applicazioni"))).includes("Histeon-Publish-9.8.7-linux-x64.AppImage"));
    // A second run finds everything in place and changes nothing.
    await deliver({ builder: f.builder, publish: f.publish, env: f.env, home: f.root });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("la prova non cambia niente", linuxOnly, async () => {
  const f = await fixture();
  try {
    const lines = [];
    await deliver({ builder: f.builder, publish: f.publish, env: f.env, home: f.root, dryRun: true, say: (line) => lines.push(line) });
    assert.ok(lines.some((line) => line.includes("via   xb-1.2.2-0000000.zip")));
    assert.ok((await readdir(path.join(f.root, "Documenti/Applicazioni/Plugin"))).includes("xb-1.2.2-0000000.zip"));
    assert.ok(!(await readdir(path.join(f.root, "installer"))).includes("SHA256SUMS.txt"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("un pacchetto che non corrisponde alla sua impronta ferma tutto prima di toccare le cartelle", linuxOnly, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "modules/static-bridge-3.0.0.zip"), "cambiato");
    await assert.rejects(deliver({ builder: f.builder, publish: f.publish, env: f.env, home: f.root }), /static-bridge-3\.0\.0\.zip non corrisponde/u);
    assert.ok((await readdir(path.join(f.root, "Documenti/Applicazioni/Plugin"))).includes("lingua-bridge-1.9.0.zip"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("trova i pacchetti di release:linux in release/<versione>/", linuxOnly, async () => {
  const f = await fixture({ versioned: true });
  try {
    await deliver({ builder: f.builder, publish: f.publish, env: f.env, home: f.root });
    assert.ok((await readdir(path.join(f.root, "installer"))).includes("Histeon-Publish-9.8.7-linux-x64.AppImage"));
    assert.ok((await readdir(path.join(f.root, "Documenti/Applicazioni"))).includes("Histeon-Publish-9.8.7-linux-x64.AppImage"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
