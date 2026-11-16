import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The AppImage release and the Applications folder copy exist only on Linux.
const linuxOnly = { skip: process.platform !== "linux" ? "solo Linux" : false };
import { createLinuxReleasePlan, releaseLinux } from "./release-linux.mjs";

async function makeRoot({ version = "0.2.0", desktopVersion = version } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-linux-release-"));
  await mkdir(path.join(root, "packages/desktop"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(path.join(root, "packages/desktop/package.json"), JSON.stringify({ version: desktopVersion }));
  await writeFile(path.join(root, ".histos-release-linux.json"), JSON.stringify({
    id: "it.example.histos.publish",
    homepage: "https://www.freedesktop.org/software/appstream/docs/",
    maintainer: "Release Test <release@publish.test>",
    developerName: "Release Test",
  }));
  return root;
}

test("prepara una release Linux versionata senza usare la cartella storica", linuxOnly, async () => {
  const root = await makeRoot();
  const applicationsDirectory = path.join(root, "Documenti/Applicazioni");
  try {
    const plan = await createLinuxReleasePlan({
      root,
      env: { HISTOS_APPLICATIONS_DIR: applicationsDirectory },
      platform: "linux",
      arch: "x64",
    });
    assert.equal(plan.version, "0.2.0");
    assert.equal(plan.releaseRelative, "packages/desktop/release/0.2.0");
    assert.equal(plan.releaseDirectory, path.join(root, "packages/desktop/release/0.2.0"));
    assert.equal(plan.releaseSettings.id, "it.example.histos.publish");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rispetta HISTOS_RELEASE_DIR quando la cartella di output è esterna al repository", linuxOnly, async () => {
  const root = await makeRoot();
  const releaseDirectory = path.join(os.tmpdir(), `histos-linux-release-output-${path.basename(root)}`);
  try {
    const plan = await createLinuxReleasePlan({
      root,
      env: {
        HISTOS_RELEASE_DIR: releaseDirectory,
        HISTOS_APPLICATIONS_DIR: path.join(root, "Documenti/Applicazioni"),
      },
      platform: "linux",
      arch: "x64",
    });
    assert.equal(plan.releaseDirectory, releaseDirectory);
    assert.equal(plan.releaseRelative, releaseDirectory);
  } finally {
    await rm(releaseDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("rifiuta percorsi di prova dentro il repository che mescolerebbero gli artefatti", linuxOnly, async () => {
  const root = await makeRoot();
  try {
    await assert.rejects(createLinuxReleasePlan({
      root,
      env: {
        HISTOS_RELEASE_DIR: "release-test",
        HISTOS_APPLICATIONS_DIR: path.join(root, "Documenti/Applicazioni"),
      },
      platform: "linux",
      arch: "x64",
    }), /una release interna deve usare/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocca una release se la cartella della versione esiste già", linuxOnly, async () => {
  const root = await makeRoot();
  try {
    await mkdir(path.join(root, "packages/desktop/release/0.2.0"), { recursive: true });
    await assert.rejects(createLinuxReleasePlan({
      root,
      env: { HISTOS_APPLICATIONS_DIR: path.join(root, "Documenti/Applicazioni") },
      platform: "linux",
      arch: "x64",
    }), /esiste già/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocca versioni incoerenti e piattaforme non supportate", linuxOnly, async () => {
  const root = await makeRoot({ desktopVersion: "0.2.1" });
  try {
    await assert.rejects(createLinuxReleasePlan({
      root,
      env: { HISTOS_APPLICATIONS_DIR: path.join(root, "Documenti/Applicazioni") },
      platform: "linux",
      arch: "x64",
    }), /non coincidono/u);
    await assert.rejects(createLinuxReleasePlan({ root, platform: "win32", arch: "x64" }), /Linux x64/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("richiede dati AppStream e contatto prima di una release", linuxOnly, async () => {
  const root = await makeRoot();
  try {
    await rm(path.join(root, ".histos-release-linux.json"));
    await assert.rejects(createLinuxReleasePlan({
      root,
      env: { HISTOS_APPLICATIONS_DIR: path.join(root, "Documenti/Applicazioni") },
      platform: "linux",
      arch: "x64",
    }), /Copia docs\/release-linux-metadata\.example\.json/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("propaga lo stesso output esterno al packager e al copier dopo il preflight", linuxOnly, async () => {
  const root = await makeRoot();
  const releaseDirectory = path.join(os.tmpdir(), `histos-linux-release-flow-${path.basename(root)}`);
  const applicationsDirectory = path.join(root, "Documenti/Applicazioni");
  const calls = [];
  try {
    const plan = await releaseLinux({
      root,
      env: { HISTOS_RELEASE_DIR: releaseDirectory, HISTOS_APPLICATIONS_DIR: applicationsDirectory },
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, error: undefined };
      },
    });
    assert.equal(plan.releaseDirectory, releaseDirectory);
    assert.deepEqual(calls.map(({ command }) => command), ["appstreamcli", "npm", process.execPath]);
    assert.equal(calls[1]?.options.env.HISTOS_RELEASE_DIR, releaseDirectory);
    assert.equal(calls[2]?.options.env.HISTOS_RELEASE_DIR, releaseDirectory);
    assert.equal(calls[2]?.options.env.HISTOS_APPLICATIONS_DIR, applicationsDirectory);
    assert.equal(calls[1]?.options.env.HISTOS_APPSTREAM_ID, "it.example.histos.publish");
  } finally {
    await rm(releaseDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("non copia l'AppImage se il packager termina con errore", linuxOnly, async () => {
  const root = await makeRoot();
  const releaseDirectory = path.join(os.tmpdir(), `histos-linux-release-failure-${path.basename(root)}`);
  const calls = [];
  try {
    await assert.rejects(releaseLinux({
      root,
      env: {
        HISTOS_RELEASE_DIR: releaseDirectory,
        HISTOS_APPLICATIONS_DIR: path.join(root, "Documenti/Applicazioni"),
      },
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: command === "npm" ? 1 : 0, error: undefined };
      },
    }), /terminata con codice 1/u);
    assert.deepEqual(calls.map(({ command }) => command), ["appstreamcli", "npm"]);
  } finally {
    await rm(releaseDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
