import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The AppImage release and the Applications folder copy exist only on Linux.
const linuxOnly = { skip: process.platform !== "linux" ? "solo Linux" : false };
import { copyVerifiedAppImage, getApplicationsDirectory, linuxReleaseDirectory } from "./copy-appimage-to-applications.mjs";

const version = "9.8.7";
const filename = `Histeon-Publish-${version}-linux-x64.AppImage`;

async function makeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-appimage-copy-"));
  const releaseDirectory = path.join(root, "release");
  const applicationsDirectory = path.join(root, "Documenti", "Applicazioni");
  await mkdir(releaseDirectory, { recursive: true });
  const bytes = Buffer.from("appimage-fixture\n");
  await writeFile(path.join(releaseDirectory, filename), bytes, { mode: 0o755 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(releaseDirectory, "SHA256SUMS.txt"), `${digest}  ${filename}\n`);
  return { root, releaseDirectory, applicationsDirectory, version, bytes, digest };
}

test("copia l'AppImage verificata in modo atomico e conserva i permessi eseguibili", linuxOnly, async () => {
  const fixture = await makeFixture();
  try {
    const result = await copyVerifiedAppImage(fixture);
    assert.equal(result.copied, true);
    assert.equal(result.sha256, fixture.digest);
    assert.deepEqual(await readFile(result.target), fixture.bytes);
    assert.equal((await lstat(result.target)).mode & 0o777, 0o755);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("la ripetizione identica è innocua e non ricopia il file", linuxOnly, async () => {
  const fixture = await makeFixture();
  try {
    const first = await copyVerifiedAppImage(fixture);
    const second = await copyVerifiedAppImage(fixture);
    assert.equal(first.copied, true);
    assert.equal(second.copied, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("non sovrascrive un file diverso con lo stesso nome e versione", linuxOnly, async () => {
  const fixture = await makeFixture();
  try {
    await mkdir(fixture.applicationsDirectory, { recursive: true });
    const target = path.join(fixture.applicationsDirectory, filename);
    await writeFile(target, "existing-user-file\n");
    await assert.rejects(copyVerifiedAppImage(fixture), /non è stata sovrascritta/u);
    assert.equal(await readFile(target, "utf8"), "existing-user-file\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rifiuta un'AppImage che non corrisponde al manifest", linuxOnly, async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(path.join(fixture.releaseDirectory, filename), "tampered\n");
    await assert.rejects(copyVerifiedAppImage(fixture), /Checksum SHA-256 non valido/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("la destinazione Linux usa Documenti/Applicazioni e accetta un override assoluto", linuxOnly, async () => {
  const override = path.join(os.tmpdir(), "histos-apps-test");
  assert.equal(getApplicationsDirectory({ env: { HISTOS_APPLICATIONS_DIR: override }, platform: "linux" }), override);
  assert.throws(() => getApplicationsDirectory({ env: { HISTOS_APPLICATIONS_DIR: "relative" }, platform: "linux" }), /assoluto/u);
  assert.throws(() => getApplicationsDirectory({ env: {}, platform: "win32" }), /solo su Linux/u);
});

test("cerca i pacchetti in release/<versione>/ di release:linux, altrimenti in release/", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-appimage-release-"));
  try {
    assert.equal(await linuxReleaseDirectory(root, version), path.join(root, "release"));
    // An empty or half-written versioned folder is not the release.
    await mkdir(path.join(root, "release", version), { recursive: true });
    assert.equal(await linuxReleaseDirectory(root, version), path.join(root, "release"));
    await writeFile(path.join(root, "release", version, filename), "appimage");
    assert.equal(await linuxReleaseDirectory(root, version), path.join(root, "release", version));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
