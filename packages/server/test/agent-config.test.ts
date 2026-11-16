import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentCloudflareToken, readSecretFile } from "../../core/src/secrets.js";
import { AGENT_CONFIG_SCHEMA, generateAgentKey, loadAgentSecrets, readAgentConfig, type AgentConfig } from "../src/agent-config.js";

const directories: string[] = [];
async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "histos-agent-config-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function baseConfig(directory: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    dataDir: path.join(directory, "data"),
    site: { name: "fixture", origin: "https://example.test" },
    cloudflare: { accountId: "0123456789abcdef0123456789abcdef", script: "fixture-site" },
  };
}

async function configFile(directory: string, value: unknown, mode = 0o600): Promise<string> {
  const target = path.join(directory, "agent.json");
  await writeFile(target, `${JSON.stringify(value)}\n`, { mode });
  await chmod(target, mode);
  return target;
}

// The publishing agent is a Linux service (docs/spec/agente-di-pubblicazione.md): it refuses to start elsewhere.
describe.skipIf(process.platform !== "linux")("configurazione e segreti dell’agente", () => {
  it("mantiene lo schema pubblicato sincronizzato con quello validato all’avvio", async () => {
    const published = JSON.parse(await readFile(path.resolve("docs/spec/agent.schema.json"), "utf8")) as unknown;
    expect(published).toEqual(JSON.parse(JSON.stringify(AGENT_CONFIG_SCHEMA)) as unknown);
  });

  it("applica i valori predefiniti e deriva l’Host consentito", async () => {
    const directory = await tempDirectory();
    const config = await readAgentConfig(await configFile(directory, baseConfig(directory)));
    expect(config.listen).toEqual({ host: "127.0.0.1", port: 8787, allInterfaces: false, allowedHosts: ["127.0.0.1:8787"] });
    expect(config.site.crawl).toMatchObject({ concurrency: 4, delayMs: 50, maxPages: 5000, includeFeeds: false });
    expect(config.site.rewrite.externalAssets).toEqual([]);
    expect(config.retention).toEqual({ jobsDays: 90, keepBundles: 1 });
  });

  it("rifiuta campi fuori schema e configurazioni di ascolto o origine insicure", async () => {
    const directory = await tempDirectory();
    const invalidValues: unknown[] = [];
    invalidValues.push({ ...baseConfig(directory), unknown: true });
    invalidValues.push({ ...baseConfig(directory), listen: { host: "localhost" } });
    invalidValues.push({ ...baseConfig(directory), listen: { host: "8.8.8.8" } });
    invalidValues.push({ ...baseConfig(directory), listen: { host: "0.0.0.0" } });
    invalidValues.push({ ...baseConfig(directory), listen: { host: "127.0.0.1", invalid: true } });
    invalidValues.push({ ...baseConfig(directory), site: { name: "fixture", origin: "https://example.test/wp/" } });
    invalidValues.push({ ...baseConfig(directory), site: { name: "fixture", origin: "http://example.test" } });
    invalidValues.push({ ...baseConfig(directory), dataDir: "relative/data" });

    for (const [index, value] of invalidValues.entries()) {
      const file = await configFile(directory, value, 0o600);
      await expect(readAgentConfig(file), `caso di configurazione ${index}`).rejects.toMatchObject({ code: "agent-config-invalid", exitCode: 2 });
      await rm(file, { force: true });
    }

    const writableConfig = await configFile(directory, baseConfig(directory), 0o620);
    await expect(readAgentConfig(writableConfig)).rejects.toMatchObject({ code: "agent-config-invalid", exitCode: 2 });
  });

  it("consente loopback e origini private solo con le relative impostazioni", async () => {
    const directory = await tempDirectory();
    const base = baseConfig(directory);
    const privateOrigin = { ...base, listen: { host: "10.0.0.4" }, site: { name: "fixture", origin: "http://wordpress", privateNetwork: true } };
    await expect(readAgentConfig(await configFile(directory, privateOrigin))).resolves.toMatchObject({
      listen: { host: "10.0.0.4", allowedHosts: ["10.0.0.4:8787"] },
      site: { origin: "http://wordpress", privateNetwork: true },
    });

    const allInterfaces = { ...base, listen: { host: "0.0.0.0", allInterfaces: true, allowedHosts: ["agent:8787"] } };
    await expect(readAgentConfig(await configFile(directory, allInterfaces))).resolves.toMatchObject({ listen: { host: "0.0.0.0", allInterfaces: true } });
  });

  it("legge un segreto solo da file privato e rifiuta file vuoti, grandi, pubblici o symlink", async () => {
    const directory = await tempDirectory();
    const accepted = path.join(directory, "accepted");
    await writeFile(accepted, "synthetic-secret\r\n", { mode: 0o600 });
    await expect(readSecretFile(accepted, "prova")).resolves.toBe("synthetic-secret");

    const empty = path.join(directory, "empty");
    await writeFile(empty, "", { mode: 0o600 });
    const tooLarge = path.join(directory, "large");
    await writeFile(tooLarge, "s".repeat(4097), { mode: 0o600 });
    const publicFile = path.join(directory, "public");
    await writeFile(publicFile, "synthetic-secret", { mode: 0o644 });
    const link = path.join(directory, "link");
    await symlink(accepted, link);
    for (const file of [empty, tooLarge, publicFile, link, path.join(directory, "missing")]) {
      await expect(readSecretFile(file, "prova")).rejects.toMatchObject({ code: "agent-secret-file-invalid", exitCode: 4 });
    }
  });

  it("rifiuta sorgenti Cloudflare ambigue e accetta solo una sorgente alla volta", async () => {
    const directory = await tempDirectory();
    const tokenFile = path.join(directory, "cloudflare-token");
    await writeFile(tokenFile, "synthetic-token\n", { mode: 0o400 });
    await expect(readAgentCloudflareToken({ HISTOS_CLOUDFLARE_API_TOKEN_FILE: tokenFile })).resolves.toBe("synthetic-token");
    await expect(readAgentCloudflareToken({ HISTOS_CLOUDFLARE_API_TOKEN: "synthetic-token" })).resolves.toBe("synthetic-token");
    await expect(readAgentCloudflareToken({ HISTOS_CLOUDFLARE_API_TOKEN_FILE: tokenFile, HISTOS_CLOUDFLARE_API_TOKEN: "" }))
      .rejects.toMatchObject({ code: "agent-secret-ambiguous", exitCode: 4 });
  });

  it("genera chiavi da 32 byte, aggiorna atomicamente e limita a due chiavi", async () => {
    const directory = await tempDirectory();
    const file = path.join(directory, "agent-keys.json");
    const first = await generateAgentKey(file, "k1");
    const firstJson = JSON.parse(await readFile(file, "utf8")) as { keys: Array<{ id: string; secret: string }> };
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(first, "base64url").byteLength).toBe(32);
    expect(firstJson.keys).toEqual([{ id: "k1", secret: first }]);
    const second = await generateAgentKey(file, "k2");
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(generateAgentKey(file, "k1")).rejects.toMatchObject({ code: "agent-key-id-exists", exitCode: 2 });
    await expect(generateAgentKey(file, "k3")).rejects.toMatchObject({ code: "agent-key-rotation-limit", exitCode: 2 });
    await expect(stat(file).then((info) => info.mode & 0o777)).resolves.toBe(0o600);
  });

  it("carica solo chiavi HMAC canoniche di 32 byte e redige i segreti in memoria", async () => {
    const directory = await tempDirectory();
    const keysPath = path.join(directory, "agent-keys.json");
    const secret = Buffer.alloc(32).toString("base64url");
    await writeFile(keysPath, JSON.stringify({ keys: [{ id: "k1", secret }] }), { mode: 0o600 });
    const config = await readAgentConfig(await configFile(directory, baseConfig(directory))) as AgentConfig;
    const secrets = await loadAgentSecrets({ HISTOS_CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-token", HISTOS_AGENT_KEYS_FILE: keysPath }, config);
    expect(secrets.keys[0]?.bytes.byteLength).toBe(32);
    expect(secrets.redact).toContain("synthetic-cloudflare-token");
    expect(secrets.redact).toContain(secret);

    for (const invalidSecret of ["a".repeat(42), "a".repeat(44), Buffer.alloc(31).toString("base64url")]) {
      await writeFile(keysPath, JSON.stringify({ keys: [{ id: "k1", secret: invalidSecret }] }), { mode: 0o600 });
      await expect(loadAgentSecrets({ HISTOS_CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-token", HISTOS_AGENT_KEYS_FILE: keysPath }, config))
        .rejects.toMatchObject({ code: "agent-keys-invalid", exitCode: 4 });
    }
    await writeFile(keysPath, JSON.stringify({ keys: ["k1", "k2", "k3"].map((id) => ({ id, secret })) }), { mode: 0o600 });
    await expect(loadAgentSecrets({ HISTOS_CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-token", HISTOS_AGENT_KEYS_FILE: keysPath }, config))
      .rejects.toMatchObject({ code: "agent-keys-invalid", exitCode: 4 });
  });
});
