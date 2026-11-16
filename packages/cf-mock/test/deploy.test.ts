import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudflareClient, attachCustomDomain, createFormsWorkerSource, deployBundle, inspectCustomDomain, rollbackVersion } from "../../core/src/index.js";
import { startCloudflareMock, type CloudflareMockHandle } from "../src/index.js";

const script = "histos-publish-demo";

let mock: CloudflareMockHandle;
let client: CloudflareClient;

beforeEach(async () => {
  mock = await startCloudflareMock();
  client = new CloudflareClient({ token: mock.token, apiBase: mock.url, rateLimitRetries: 1 });
});
afterEach(async () => {
  await mock.close();
  vi.unstubAllGlobals();
});

function demoFiles(home: string, image: string): Array<{ path: string; size: number; bytes: Buffer }> {
  const headers = "/*\n  X-Frame-Options: DENY\n";
  const redirects = "/vecchio/ /nuovo/ 301\n";
  return [
    { path: "index.html", size: Buffer.byteLength(home), bytes: Buffer.from(home) },
    { path: "immagini/città nuova.webp", size: Buffer.byteLength(image), bytes: Buffer.from(image) },
    { path: "_headers", size: Buffer.byteLength(headers), bytes: Buffer.from(headers) },
    { path: "_redirects", size: Buffer.byteLength(redirects), bytes: Buffer.from(redirects) },
  ];
}

function deploy(files: ReturnType<typeof demoFiles>) {
  return deployBundle({ client, accountId: mock.accountId, script, files, message: "Versione di prova" });
}

describe("integrazione con il mock Cloudflare", () => {
  it("trova gli account autorizzati senza richiedere la copia manuale dell’ID", async () => {
    await expect(client.listAccounts()).resolves.toEqual([{ id: mock.accountId, name: "Account Cloudflare simulato" }]);
  });

  it("crea il primo script, riusa gli hash, pubblica una modifica e ripristina una versione", async () => {
    const first = await deploy(demoFiles("<main>v1</main>", "foto-v1"));
    expect(first.uploaded).toBe(2);

    const second = await deploy(demoFiles("<main>v1</main>", "foto-v1"));
    expect(second.uploaded).toBe(0);

    const third = await deploy(demoFiles("<main>v2</main>", "foto-v1"));
    expect(third.uploaded).toBe(1);

    const rollback = await rollbackVersion({ client, accountId: mock.accountId, script, deploymentOrVersionId: first.deployment.id });
    expect(rollback.versions[0]?.version_id).toBe(first.versionId);

    const inspection = mock.state();
    const worker = inspection.scripts[`${mock.accountId}/${script}`];
    expect(worker?.activeVersionId).toBe(first.versionId);
    expect(worker?.workerFirstRoutes.length).toBeGreaterThan(0);
    expect(worker?.workerFirstRoutes.every((routes) => routes.includes("/") && routes.includes("/index.html"))).toBe(true);
    expect(inspection.uploadedAssetCount).toBe(3);
    expect(inspection.secretNames).toEqual([]);

    const publicBase = mock.url.replace(/\/client\/v4$/u, "");
    const homeResponse = await fetch(`${publicBase}/__site/${script}/?cache=one`);
    expect(homeResponse.status).toBe(200);
    expect(await homeResponse.text()).toContain("v1");
    expect(homeResponse.headers.get("x-frame-options")).toBe("DENY");

    const imageResponse = await fetch(`${publicBase}/__site/${script}/immagini/citt%C3%A0%20nuova.webp`);
    expect(await imageResponse.text()).toBe("foto-v1");

    const redirectResponse = await fetch(`${publicBase}/__site/${script}/vecchio/`, { redirect: "manual" });
    expect(redirectResponse.status).toBe(301);
    expect(redirectResponse.headers.get("location")).toBe("/nuovo/");
  });

  it("serve ogni file con il suo tipo, carica i file senza estensione e applica _headers e _redirects", async () => {
    const text = (path: string, body: string) => ({ path, size: Buffer.byteLength(body), bytes: Buffer.from(body) });
    const headers = "/js/*\n  X-Prova: si\n";
    const redirects = "/mac /dispositivi 302\n";
    const files = [
      text("index.html", "<main>casa</main>"),
      text("dispositivi.html", "<main>dispositivi</main>"),
      text("js/app.mjs", "export const a = 1;"),
      text("css/arch.css", "main{color:red}"),
      text("manifest.webmanifest", "{}"),
      text("vendor/pdfjs/LICENSE", "licenza"),
      text("a.b/file", "senza estensione in una cartella con il punto"),
      text("_headers", headers),
      text("_redirects", redirects),
    ];
    const result = await deploy(files);
    expect(result.uploaded).toBe(7);

    const base = `${mock.url.replace(/\/client\/v4$/u, "")}/__site/${script}`;
    const type = async (path: string) => (await fetch(`${base}${path}`)).headers.get("content-type");
    expect(await type("/js/app.mjs")).toBe("text/javascript; charset=utf-8");
    expect(await type("/css/arch.css")).toBe("text/css; charset=utf-8");
    expect(await type("/manifest.webmanifest")).toBe("application/manifest+json; charset=utf-8");
    expect(await type("/dispositivi.html")).toBe("text/html; charset=utf-8");
    expect(await type("/vendor/pdfjs/LICENSE")).toBe("application/octet-stream");
    expect(await (await fetch(`${base}/a.b/file`)).text()).toBe("senza estensione in una cartella con il punto");
    expect((await fetch(`${base}/js/app.mjs`)).headers.get("x-prova")).toBe("si");

    const redirect = await fetch(`${base}/mac`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/dispositivi");
  });

  it("associa un dominio alla zona attiva più specifica senza abilitare le preview", async () => {
    await deploy(demoFiles("<main>test</main>", "foto"));
    const result = await attachCustomDomain({ client, accountId: mock.accountId, script, hostname: "www.example.test" });
    expect(result.zone.name).toBe("example.test");
    expect(mock.state().domains[0]).toMatchObject({ hostname: "www.example.test", service: script, previews_enabled: false, enabled: true });
  });

  it("sostituisce solo il CNAME approvato e collega dominio principale e www", async () => {
    await mock.close();
    mock = await startCloudflareMock({ dnsRecords: [
      { zone_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "www.example.test", type: "CNAME", content: "example.test", ttl: 1, proxied: true },
      { zone_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "example.test", type: "MX", content: "mail.example.test", ttl: 1, proxied: false },
      { zone_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "example.test", type: "TXT", content: "v=spf1 include:mail.example.test ~all", ttl: 1, proxied: false },
    ] });
    client = new CloudflareClient({ token: mock.token, apiBase: mock.url, rateLimitRetries: 1 });
    await deploy(demoFiles("<main>test</main>", "foto"));
    const plan = await inspectCustomDomain({ client, accountId: mock.accountId, script, hostname: "example.test", includeWww: true });
    expect(plan.hostnames).toEqual(["example.test", "www.example.test"]);
    expect(plan.cnameConflicts).toMatchObject([{ name: "www.example.test", content: "example.test", proxied: true }]);
    const result = await attachCustomDomain({
      client,
      accountId: mock.accountId,
      script,
      hostname: plan.hostname,
      includeWww: true,
      replaceCnameRecords: plan.cnameConflicts.map((record) => ({ id: record.id, name: record.name, content: record.content, proxied: record.proxied ?? false })),
    });
    expect(result.hostnames).toEqual(["example.test", "www.example.test"]);
    expect(mock.state().domains.map((domain) => domain.hostname).sort()).toEqual(["example.test", "www.example.test"]);
    expect(mock.state().dnsRecords.map(({ name, type }) => [name, type])).toEqual([
      ["example.test", "MX"],
      ["example.test", "TXT"],
    ]);
  });

  it("ripristina il CNAME se Cloudflare rifiuta il collegamento", async () => {
    await mock.close();
    mock = await startCloudflareMock({ dnsRecords: [
      { zone_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "www.example.test", type: "CNAME", content: "old-host.example.test", ttl: 300, proxied: true },
    ] });
    client = new CloudflareClient({ token: mock.token, apiBase: mock.url, rateLimitRetries: 1 });
    await deploy(demoFiles("<main>test</main>", "foto"));
    const plan = await inspectCustomDomain({ client, accountId: mock.accountId, script, hostname: "www.example.test" });
    mock.failNext({ method: "PUT", path: `/client/v4/accounts/${mock.accountId}/workers/domains`, status: 500, message: "Errore temporaneo" });
    await expect(attachCustomDomain({
      client,
      accountId: mock.accountId,
      script,
      hostname: plan.hostname,
      replaceCnameRecords: plan.cnameConflicts.map((record) => ({ id: record.id, name: record.name, content: record.content, proxied: record.proxied ?? false })),
    })).rejects.toThrow("Cloudflare ha risposto 500");
    expect(mock.state().dnsRecords).toMatchObject([{ name: "www.example.test", content: "old-host.example.test", ttl: 300, proxied: true }]);
    expect(mock.state().domains).toEqual([]);
  });

  it("non duplica il CNAME se la cancellazione fallisce prima della modifica", async () => {
    await mock.close();
    mock = await startCloudflareMock({ dnsRecords: [
      { zone_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "www.example.test", type: "CNAME", content: "old-host.example.test", ttl: 300, proxied: true },
    ] });
    client = new CloudflareClient({ token: mock.token, apiBase: mock.url, rateLimitRetries: 1 });
    await deploy(demoFiles("<main>test</main>", "foto"));
    const plan = await inspectCustomDomain({ client, accountId: mock.accountId, script, hostname: "www.example.test" });
    const conflict = plan.cnameConflicts[0];
    if (!conflict) throw new Error("CNAME di prova non creato.");
    mock.failNext({ method: "DELETE", path: `/client/v4/zones/${plan.zone.id}/dns_records/${conflict.id}`, status: 500, message: "Errore temporaneo" });
    await expect(attachCustomDomain({
      client,
      accountId: mock.accountId,
      script,
      hostname: plan.hostname,
      replaceCnameRecords: plan.cnameConflicts.map((record) => ({ id: record.id, name: record.name, content: record.content, proxied: record.proxied ?? false })),
    })).rejects.toThrow("Cloudflare ha risposto 500");
    expect(mock.state().dnsRecords).toMatchObject([{ name: "www.example.test", content: "old-host.example.test", ttl: 300, proxied: true }]);
    expect(mock.state().domains).toEqual([]);
  });

  it("pubblica la route dei moduli solo su /xb-form e invia il binding segreto nel metadata", async () => {
    const forms = {
      enabled: true,
      adapter: "wordpress-fluent-forms" as const,
      restUrl: "https://wp.example.test/wp-json/",
      turnstileSiteKey: "public-site-key",
      fluentFormIds: [123],
      attachedForms: 1,
      unsupportedFiles: [],
      unmatchedIds: [],
      linkedFiles: ["index.html"],
    };
    const secret = "synthetic-turnstile-secret-123456";
    await deployBundle({
      client,
      accountId: mock.accountId,
      script,
      files: demoFiles('<form action="/xb-form"><input name="_wpcf7" value="123"></form>', "foto"),
      forms,
      turnstileSecret: secret,
    });
    expect(mock.state().secretNames).toEqual([`${mock.accountId}/${script}/TURNSTILE_SECRET`]);
    const workerFirstRoutes = mock.state().scripts[`${mock.accountId}/${script}`]?.workerFirstRoutes ?? [];
    expect(workerFirstRoutes.length).toBeGreaterThan(0);
    expect(workerFirstRoutes.every((routes) => routes.includes("/") && routes.includes("/index.html") && routes.includes("/xb-form"))).toBe(true);
    const snapshot = JSON.stringify(mock.state());
    expect(snapshot).not.toContain(secret);
    expect(snapshot).not.toContain("public-site-key");
  });

  it("rifiuta moduli abilitati senza una chiave segreta senza iniziare l’upload", async () => {
    await expect(deployBundle({
      client,
      accountId: mock.accountId,
      script,
      files: demoFiles("<main>test</main>", "foto"),
      forms: { enabled: true, adapter: "wordpress-fluent-forms", restUrl: "https://wp.example.test/wp-json/", turnstileSiteKey: "site-key", fluentFormIds: [123], attachedForms: 1, unsupportedFiles: [], unmatchedIds: [] },
    })).rejects.toMatchObject({ code: "forms-secret-missing" });
    expect(mock.state().requestCounts).toEqual({});
  });

  it("verifica Turnstile e inoltra solo al modulo Fluent Forms configurato", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      if (url === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
        return Response.json({ success: true, hostname: "www.example.test", action: "histos_form" });
      }
      return Response.json({ success: true, data: { result: { message: "sent" } } });
    });
    const source = createFormsWorkerSource({ restUrl: "https://wp.example.test/wp-json/", fluentFormIds: [123] });
    const worker = new Function(source.replace("export default {", "return {"))() as { fetch(request: Request, env: unknown): Promise<Response> };
    const request = new Request("https://www.example.test/xb-form", {
      method: "POST",
      headers: { Origin: "https://www.example.test", "Content-Type": "application/json" },
      body: JSON.stringify({
        form: "123",
        turnstileToken: "synthetic-turnstile-token",
        fields: { __fluent_form_embded_post_id: "8", "_wp_http_referer": "/contatti/", "names[first_name]": "Ada", xb_debug: "private" },
      }),
    });
    const response = await worker.fetch(request, { TURNSTILE_SECRET: "synthetic-turnstile-secret" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "sent" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      "https://wp.example.test/wp-admin/admin-ajax.php",
    ]);
    const upstreamData = calls[1]?.init?.body as URLSearchParams;
    expect(upstreamData.get("action")).toBe("fluentform_submit");
    expect(upstreamData.get("form_id")).toBe("123");
    const serializedFields = new URLSearchParams(upstreamData.get("data") ?? "");
    expect(serializedFields.get("__fluent_form_embded_post_id")).toBe("8");
    expect(serializedFields.get("_wp_http_referer")).toBe("/contatti/");
    expect(serializedFields.get("names[first_name]")).toBe("Ada");
    expect(serializedFields.has("xb_debug")).toBe(false);
    expect(serializedFields.has("cf-turnstile-response")).toBe(false);
  });

  it("rifiuta origini diverse senza verificare o inoltrare la richiesta", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetcher);
    const source = createFormsWorkerSource({ restUrl: "https://wp.example.test/wp-json/", fluentFormIds: [123] });
    const worker = new Function(source.replace("export default {", "return {"))() as { fetch(request: Request, env: unknown): Promise<Response> };
    const request = new Request("https://www.example.test/xb-form", {
      method: "POST",
      headers: { Origin: "https://attacker.test", "Content-Type": "application/json" },
      body: "{}",
    });
    const response = await worker.fetch(request, { TURNSTILE_SECRET: "synthetic-turnstile-secret" });
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ritenta i 429 e restituisce messaggi chiari per 400, 404 e 500", async () => {
    const sessionPath = `/client/v4/accounts/${mock.accountId}/workers/scripts/${script}/assets-upload-session`;
    mock.failNext({ method: "POST", path: sessionPath, status: 429, message: "Riprova", retryAfter: "0" });
    const manifest = { "/index.html": { hash: "a".repeat(32), size: 3 } };
    await expect(client.createAssetUploadSession(mock.accountId, script, manifest)).resolves.toMatchObject({ buckets: [["a".repeat(32)]] });
    expect(mock.state().requestCounts[`POST ${sessionPath}`]).toBe(2);

    for (const status of [400, 500]) {
      mock.failNext({ method: "POST", path: sessionPath, status, message: `Errore ${status}` });
      await expect(client.createAssetUploadSession(mock.accountId, script, manifest)).rejects.toThrow(`Cloudflare ha risposto ${status}`);
    }
    await expect(client.listDeployments(mock.accountId, "inesistente")).rejects.toMatchObject({ status: 404 });
  });

  it("rifiuta token errati e non li riporta nei messaggi", async () => {
    const badClient = new CloudflareClient({ token: mock.token, apiBase: mock.url });
    mock.failNext({
      method: "POST",
      path: `/client/v4/accounts/${mock.accountId}/workers/scripts/${script}/assets-upload-session`,
      status: 500,
      message: mock.token,
    });
    await expect(badClient.createAssetUploadSession(mock.accountId, script, { "/index.html": { hash: "b".repeat(32), size: 4 } }))
      .rejects.toThrow("[segreto rimosso]");
    const invalidClient = new CloudflareClient({ token: "invalid-token-value", apiBase: mock.url });
    await expect(invalidClient.verifyToken()).rejects.toThrow(/Account API Token.*ID account Cloudflare/iu);
    await expect(invalidClient.verifyToken()).rejects.not.toThrow("invalid-token-value");
  });

  it("verifica la modalità mock e non tocca account Cloudflare reali", async () => {
    await expect(client.verifyToken()).resolves.toMatchObject({ status: "active" });
    mock.failNext({ method: "GET", path: "/client/v4/user/tokens/verify", status: 401, message: "Invalid API Token" });
    await expect(client.verifyToken(mock.accountId)).resolves.toMatchObject({ status: "active", accountOwned: true });
    expect(mock.state().requestCounts[`GET /client/v4/accounts/${mock.accountId}/tokens/verify`]).toBe(1);
    await expect(client.verifyToken("not-an-account-id")).rejects.toThrow(/32 caratteri esadecimali/iu);
    expect(() => new CloudflareClient({ token: mock.token, apiBase: "http://134744072/client/v4" })).toThrow(/loopback/iu);
    expect(() => new CloudflareClient({ token: mock.token, apiBase: "https://evil.example/client/v4" })).toThrow(/api\.cloudflare\.com/iu);
    expect(() => new CloudflareClient({ token: mock.token, apiBase: "https://api.cloudflare.com/other" })).toThrow(/client\/v4/iu);
  });
});
