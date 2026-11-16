import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appImageName, checkDownload, downloadAsset, isNewer, latestRelease, parseRelease, replaceAppImage, UPDATE_REPOSITORY, verifyMinisign, type FetchLike } from "../src/updates.js";

const REPO = "Seventhose/histeon-publish";
const ASSETS = `https://api.github.com/repos/${REPO}/releases/assets/`;

function keypair(): { publicKey: string; privateKey: KeyObject; id: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const id = randomBytes(8);
  return { publicKey: Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64"), privateKey, id };
}

/** A .minisig as scripts/sign-release.php of the builder writes it. */
function minisig(data: Buffer, name: string, key: ReturnType<typeof keypair>, comment = `timestamp:1\tfile:${name}\thashed`): string {
  const signature = sign(null, createHash("blake2b512").update(data).digest(), key.privateKey);
  const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), key.privateKey);
  return `untrusted comment: x\n${Buffer.concat([Buffer.from("ED"), key.id, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
}

function release(version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const name = appImageName(version);
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/${REPO}/releases/tag/v${version}`,
    assets: [{ name, url: `${ASSETS}1` }, { name: `${name}.minisig`, url: `${ASSETS}2` }],
    ...extra,
  };
}

const appImage = (text = "payload") => Buffer.concat([Buffer.from("\x7fELF", "latin1"), Buffer.from(text)]);

describe("app updates", () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

  it("reads only complete, final releases of this repository through the API", () => {
    expect(parseRelease(release("1.22.0"))?.appImage).toEqual({ name: "Histeon-Publish-1.22.0-linux-x64.AppImage", url: `${ASSETS}1` });
    expect(parseRelease(release("1.22.0", { prerelease: true }))).toBeNull();
    expect(parseRelease(release("1.22.0", { draft: true }))).toBeNull();
    expect(parseRelease(release("1.22.0", { tag_name: "latest" }))).toBeNull();
    expect(parseRelease({ ...release("1.22.0"), assets: [{ name: appImageName("1.22.0"), url: `${ASSETS}1` }] }), "no signature, no release").toBeNull();
    expect(parseRelease({ ...release("1.22.0"), assets: [{ name: appImageName("1.22.0"), url: "https://evil.example/a" }, { name: `${appImageName("1.22.0")}.minisig`, url: `${ASSETS}2` }] }), "only this repository's assets").toBeNull();
  });

  it("reads the public repository and compares versions numerically", () => {
    expect(UPDATE_REPOSITORY).toBe(REPO);
    expect(isNewer("1.22.0", "1.21.8")).toBe(true);
    expect(isNewer("1.21.10", "1.21.9")).toBe(true);
    expect(isNewer("1.21.8", "1.21.8")).toBe(false);
    expect(isNewer("1.2.0", "1.10.0")).toBe(false);
  });

  it("installs only a file signed by the release key, for exactly this asset, newer than the running app", () => {
    const key = keypair();
    const other = keypair();
    const target = parseRelease(release("1.22.0"));
    if (!target) throw new Error("release");
    const data = appImage();
    expect(() => checkDownload(target, data, minisig(data, target.appImage.name, key), "1.21.8", key.publicKey)).not.toThrow();
    expect(() => checkDownload(target, Buffer.concat([data, Buffer.from("x")]), minisig(data, target.appImage.name, key), "1.21.8", key.publicKey)).toThrow(/non corrisponde/u);
    expect(() => checkDownload(target, data, minisig(data, target.appImage.name, other), "1.21.8", key.publicKey)).toThrow(/altra chiave/u);
    expect(() => checkDownload(target, data, minisig(data, "Histeon-Publish-1.0.0-linux-x64.AppImage", key), "1.21.8", key.publicKey)).toThrow(/altro file/u);
    expect(() => checkDownload(target, data, minisig(data, target.appImage.name, key).replace("timestamp:1", "timestamp:2"), "1.21.8", key.publicKey)).toThrow(/alterato/u);
    expect(() => checkDownload(target, data, minisig(data, target.appImage.name, key), "1.22.0", key.publicKey)).toThrow(/più nuova/u);
    const text = Buffer.from("#!/bin/sh\necho");
    expect(() => checkDownload(target, text, minisig(text, target.appImage.name, key), "1.21.8", key.publicKey)).toThrow(/AppImage/u);
  });

  it("verifies the real release key format", () => {
    const key = keypair();
    const data = randomBytes(1000);
    expect(verifyMinisign(data, minisig(data, "f", key), key.publicKey)).toBe("timestamp:1\tfile:f\thashed");
    expect(() => verifyMinisign(data, minisig(data, "f", key), "RWQnon-una-chiave")).toThrow(/Chiave pubblica/u);
  });

  it("sends no Authorization header in any request", async () => {
    const calls: Array<{ url: string; auth: string | null; cookie: string | null }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const sent = new Headers(init?.headers);
      calls.push({ url, auth: sent.get("authorization"), cookie: sent.get("cookie") });
      if (url.endsWith("/releases/latest")) return Response.json(release("1.22.0"));
      if (url === `${ASSETS}1`) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/file?sig=abc" } });
      if (url.startsWith("https://release-assets.githubusercontent.com/")) return new Response(appImage("downloaded"));
      return new Response("no", { status: 404 });
    };
    const found = await latestRelease(fetchImpl);
    expect(found?.version).toBe("1.22.0");
    const bytes = await downloadAsset(`${ASSETS}1`, 1000, fetchImpl);
    expect(bytes.subarray(4).toString()).toBe("downloaded");
    expect(calls.map((call) => call.url)).toEqual([`https://api.github.com/repos/${REPO}/releases/latest`, `${ASSETS}1`, "https://release-assets.githubusercontent.com/file?sig=abc"]);
    expect(calls.map((call) => call.auth)).toEqual([null, null, null]);
    expect(calls.map((call) => call.cookie)).toEqual([null, null, null]);
  });

  it("refuses redirects elsewhere, oversized files and a refused request", async () => {
    const elsewhere: FetchLike = async () => new Response(null, { status: 302, headers: { location: "https://evil.example/file" } });
    await expect(downloadAsset(`${ASSETS}1`, 1000, elsewhere)).rejects.toThrow(/host non ammesso/u);
    const big: FetchLike = async () => new Response(randomBytes(2000));
    await expect(downloadAsset(`${ASSETS}1`, 1000, big)).rejects.toThrow(/troppo grande/u);
    await expect(downloadAsset("https://example.com/x", 1000, big)).rejects.toThrow(/non ammesso/u);
    const limited: FetchLike = async () => new Response("", { status: 403 });
    await expect(latestRelease(limited)).rejects.toThrow(/riprova più tardi/u);
    const missing: FetchLike = async () => new Response("", { status: 404 });
    await expect(latestRelease(missing)).resolves.toBeNull();
  });

  it("replaces the AppImage in one step and refuses a link", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "histeon-update-"));
    directories.push(directory);
    const target = path.join(directory, "Histeon-Publish.AppImage");
    await writeFile(target, "old", { mode: 0o755 });
    await replaceAppImage(target, appImage("new"));
    expect((await readFile(target)).subarray(4).toString()).toBe("new");
    expect((await stat(target)).mode & 0o777).toBe(0o755);
    const link = path.join(directory, "link.AppImage");
    await symlink(target, link);
    await expect(replaceAppImage(link, appImage())).rejects.toThrow(/file normale/u);
  });
});
