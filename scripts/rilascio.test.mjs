import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DENSITY_SUFFIX, fingerprint, mustBeSigned, products, publicTextProblems, signatureState, verifyFolder, verifyMinisig } from "./rilascio.mjs";

/** A minisign key pair and signer, as scripts/sign-release.php of the builder writes them. */
function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = Buffer.from("0123456789abcdef", "hex");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const signer = (data, algorithm = "ED") => {
    const message = algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
    const signature = sign(null, message, privateKey);
    const comment = "timestamp:1 file:prova";
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    return `untrusted comment: prova\n${Buffer.concat([Buffer.from(algorithm, "latin1"), id, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
  };
  return { publicLine: Buffer.concat([Buffer.from("Ed", "latin1"), id, raw]).toString("base64"), signer };
}

test("una firma minisign valida, prehash o no; un file cambiato, un commento cambiato o un'altra chiave no", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rilascio-test-"));
  try {
    const { publicLine, signer } = keys();
    const other = keys();
    const file = path.join(dir, "xb-1.2.3-abcdef0.zip");
    await writeFile(file, "contenuto");
    assert.equal(await verifyMinisig(file, signer(Buffer.from("contenuto")), publicLine), "timestamp:1 file:prova");
    assert.equal(await verifyMinisig(file, signer(Buffer.from("contenuto"), "Ed"), publicLine), "timestamp:1 file:prova");
    await assert.rejects(verifyMinisig(file, signer(Buffer.from("altro")), publicLine), /FIRMA NON VALIDA/u);
    await assert.rejects(verifyMinisig(file, signer(Buffer.from("contenuto")).replace("file:prova", "file:altro"), publicLine), /commento fidato non valido/u);
    await assert.rejects(verifyMinisig(file, other.signer(Buffer.from("contenuto")), publicLine), /FIRMA NON VALIDA|un'altra chiave/u);
    assert.equal(await signatureState(file, publicLine), "manca");
    await writeFile(`${file}.minisig`, signer(Buffer.from("contenuto")));
    assert.equal(await signatureState(file, publicLine), "valida");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("quali pacchetti vanno firmati", () => {
  for (const name of ["xb-0.5.6-7b76a32.zip", "lingua-bridge-1.5.10.zip", "static-bridge-2.2.12.zip", "Histeon-Publish-1.27.0-linux-x64.AppImage"]) assert.ok(mustBeSigned(name), name);
  for (const name of ["xb-blank-0.3.1-7b76a32.zip", "fondamenta-0.1.0-7b76a32.zip", "histos-publish_1.27.0_amd64.deb", "histeon-0.5.6-sorgenti.tar.gz", "SHA256SUMS"]) assert.ok(!mustBeSigned(name), name);
});

test("le note pubbliche: parole vietate, e-mail, cartelle personali, «WordPress»", () => {
  assert.deepEqual(publicTextProblems("Histeon 1.0. Requisiti: WP 6.9.", ["cliente-segreto"]), []);
  const problems = publicTextProblems("Per Cliente-Segreto, scrivere a mario@esempio.it da /home/mario. Va su WordPress.", ["cliente-segreto"]);
  assert.equal(problems.length, 4);
  assert.deepEqual(publicTextProblems("Seventhose <540299+Seventhose@users.noreply.github.com>, x@example.com", []), []);
  // In the list of the sources' file names an image with a density suffix is not an address; a real address still is.
  const names = publicTextProblems("test-sites/static/assets/images/hero@2x.svg\ndocs/mario@posta.invalid\nimg/logo@1.5x.png\n", []);
  assert.deepEqual(names.filter((problem) => !DENSITY_SUFFIX.test(problem)), ["indirizzo e-mail: mario@posta.invalid"]);
});

test("una cartella: somme, firme e impronta che cambia con le note", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rilascio-test-"));
  try {
    const { publicLine, signer } = keys();
    await writeFile(path.join(dir, "xb-1.2.3-abcdef0.zip"), "zip");
    await writeFile(path.join(dir, "xb-1.2.3-abcdef0.zip.minisig"), signer(Buffer.from("zip")));
    const sum = (text) => createHash("sha256").update(text).digest("hex");
    await writeFile(path.join(dir, "SHA256SUMS"), `${sum("zip")}  xb-1.2.3-abcdef0.zip\n${sum(await readFile(path.join(dir, "xb-1.2.3-abcdef0.zip.minisig")))}  xb-1.2.3-abcdef0.zip.minisig\n`);
    await writeFile(path.join(dir, "NOTE.md"), "Note.\n");
    await writeFile(path.join(dir, "PIANO.json"), "{}\n");
    assert.equal((await verifyFolder(dir, { publicKey: publicLine })).length, 3);
    const before = await fingerprint(dir);
    await writeFile(path.join(dir, "NOTE.md"), "Note cambiate.\n");
    assert.notEqual(await fingerprint(dir), before);
    await writeFile(path.join(dir, "xb-1.2.3-abcdef0.zip"), "altro");
    await assert.rejects(verifyFolder(dir, { publicKey: publicLine }), /non corrisponde a SHA256SUMS/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("i pacchetti di Publish vengono da release/<versione>/ quando release:linux li ha scritti lì", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rilascio-test-"));
  try {
    const builder = path.join(dir, "builder");
    const publish = path.join(dir, "publish");
    await mkdir(path.join(builder, "plugin"), { recursive: true });
    await writeFile(path.join(builder, "plugin/xb.php"), "<?php\nconst XB_VERSION = '1.2.3';\n");
    await writeFile(path.join(builder, "modules.json"), JSON.stringify({
      "lingua-bridge": { zip: "../modules/lingua-bridge-2.0.0.zip", sha256: "0".repeat(64) },
      "static-bridge": { zip: "../modules/static-bridge-3.0.0.zip", sha256: "0".repeat(64) },
    }));
    await mkdir(path.join(publish, "packages/desktop/release"), { recursive: true });
    await writeFile(path.join(publish, "packages/desktop/package.json"), JSON.stringify({ version: "9.8.7" }));
    const release = path.join(publish, "packages/desktop/release");
    assert.equal(path.dirname((await products({ builder, publish })).publish.files[0].file), release);
    await mkdir(path.join(release, "9.8.7"));
    await writeFile(path.join(release, "9.8.7/Histeon-Publish-9.8.7-linux-x64.AppImage"), "appimage");
    const files = (await products({ builder, publish })).publish.files;
    assert.deepEqual(files.map((f) => path.dirname(f.file)), [path.join(release, "9.8.7"), path.join(release, "9.8.7")]);
    assert.equal(files[0].sums, path.join(release, "9.8.7/SHA256SUMS.txt"));
    const publishProduct = (await products({ builder, publish })).publish;
    assert.equal(publishProduct.repo, "Seventhose/histeon-publish");
    assert.equal(publishProduct.public, true, "Publish esce nel repository pubblico, con i sorgenti.");
    assert.deepEqual(publishProduct.source, { dir: publish, commit: null, name: "histeon-publish", main: "package.json" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
