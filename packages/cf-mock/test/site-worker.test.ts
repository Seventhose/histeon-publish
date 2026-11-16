import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudflareApiError, CloudflareClient, deployBundle, kvNamespaceTitle } from "../../core/src/index.js";
import { startCloudflareMock, type CloudflareMockHandle } from "../src/index.js";

const script = "loghi";
const SITE_WORKER = "export default { async fetch(request, env) { if (new URL(request.url).pathname === \"/api/voto\") return Response.json({ ok: true }); } };\n";

let mock: CloudflareMockHandle;
let client: CloudflareClient;

beforeEach(async () => {
  mock = await startCloudflareMock();
  client = new CloudflareClient({ token: mock.token, apiBase: mock.url, rateLimitRetries: 0 });
});
afterEach(async () => {
  await mock.close();
});

function files(home: string, worker = SITE_WORKER) {
  return [
    { path: "index.html", size: Buffer.byteLength(home), bytes: Buffer.from(home) },
    { path: "_worker.js", size: Buffer.byteLength(worker), bytes: Buffer.from(worker) },
  ];
}

describe("Worker del sito e archivi KV sul mock Cloudflare", () => {
  it("pubblica _worker.js come modulo, crea l’archivio KV una volta e lo ricollega a ogni versione", async () => {
    const first = await deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>v1</h1>"), kv: ["VOTI"] });
    const second = await deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>v2</h1>"), kv: ["VOTI"] });
    expect(first.uploaded).toBe(1);
    expect(second.uploaded).toBe(1);

    const state = mock.state();
    expect(state.kvNamespaces).toHaveLength(1);
    expect(state.kvNamespaces[0]?.title).toBe(kvNamespaceTitle(script, "VOTI"));
    const worker = state.scripts[`${mock.accountId}/${script}`];
    expect(worker?.activeVersionId).toBe(second.versionId);
    // The first publication creates the script and then its version: every version carries the same code and KV.
    expect(worker?.workerFirstRoutes.length).toBeGreaterThanOrEqual(2);
    expect(worker?.workerFirstRoutes.every((routes) => routes === true)).toBe(true);
    expect(worker?.siteWorkers.every((source) => source === SITE_WORKER)).toBe(true);
    expect(worker?.kvBindings.every((bindings) => JSON.stringify(bindings) === JSON.stringify([{ name: "VOTI", namespace_id: state.kvNamespaces[0]?.id }]))).toBe(true);

    // _worker.js is server code: it is not a public file of the site.
    const publicBase = mock.url.replace(/\/client\/v4$/u, "");
    expect((await fetch(`${publicBase}/__site/${script}/_worker.js`)).status).toBe(404);
    expect(await (await fetch(`${publicBase}/__site/${script}/`)).text()).toBe("<h1>v2</h1>");
  });

  it("collega un archivio KV che esiste già quando il sito lo dichiara come NOME=titolo", async () => {
    const existing = await client.createKvNamespace(mock.accountId, "voti-logo");
    await deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>v1</h1>"), kv: ["VOTI=voti-logo"] });
    const state = mock.state();
    expect(state.kvNamespaces).toEqual([{ id: existing.id, title: "voti-logo" }]);
    expect(state.scripts[`${mock.accountId}/${script}`]?.kvBindings.at(-1)).toEqual([{ name: "VOTI", namespace_id: existing.id }]);
  });

  it("collega da solo gli archivi KV che il codice del sito usa, senza dichiararli", async () => {
    const voting = "export default { async fetch(request, env) { if (new URL(request.url).pathname !== \"/api/voto\") return; await env.VOTI.put(\"v\", \"1\"); return Response.json({ mio: await env.VOTI.get(\"v\") }); } };\n";
    await deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>v1</h1>", voting) });
    await deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>v2</h1>", voting) });
    const state = mock.state();
    expect(state.kvNamespaces.map((namespace) => namespace.title)).toEqual([kvNamespaceTitle(script, "VOTI")]);
    const id = state.kvNamespaces[0]?.id;
    expect(state.scripts[`${mock.accountId}/${script}`]?.kvBindings.every((bindings) => JSON.stringify(bindings) === JSON.stringify([{ name: "VOTI", namespace_id: id }]))).toBe(true);

    // A declaration wins: VOTI=voti-logo binds that archive and creates no other.
    const existing = await client.createKvNamespace(mock.accountId, "voti-logo");
    await deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>v3</h1>", voting), kv: ["VOTI=voti-logo"] });
    expect(mock.state().kvNamespaces).toHaveLength(2);
    expect(mock.state().scripts[`${mock.accountId}/${script}`]?.kvBindings.at(-1)).toEqual([{ name: "VOTI", namespace_id: existing.id }]);
  });

  it("senza codice del sito resta il Worker di Publish con le sole rotte della home", async () => {
    await deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>solo file</h1>").slice(0, 1) });
    const worker = mock.state().scripts[`${mock.accountId}/${script}`];
    expect(worker?.workerFirstRoutes.every((routes) => JSON.stringify(routes) === JSON.stringify(["/", "/index.html"]))).toBe(true);
    expect(worker?.siteWorkers.every((source) => source === null)).toBe(true);
  });

  it("si ferma prima di caricare i file se il token non può usare gli archivi KV", async () => {
    mock.failNext({ method: "GET", path: `/client/v4/accounts/${mock.accountId}/storage/kv/namespaces`, status: 403, message: "Authentication error" });
    const attempt = deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>v1</h1>"), kv: ["VOTI"] });
    await expect(attempt).rejects.toBeInstanceOf(CloudflareApiError);
    await expect(deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>v1</h1>"), kv: ["VOTI"] })).resolves.toBeDefined();
    expect(mock.state().uploadedAssetCount).toBe(1);
  });

  it("con un token limitato al Worker (401 sulle API KV) dice quale archivio serve e come dare il permesso", async () => {
    const voting = "export default { async fetch(request, env) { return Response.json({ mio: await env.VOTI.get(\"v\") }); } };\n";
    mock.failNext({ method: "GET", path: `/client/v4/accounts/${mock.accountId}/storage/kv/namespaces`, status: 401, message: "Authentication error" });
    const attempt = deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>v1</h1>", voting) });
    await expect(attempt).rejects.toBeInstanceOf(CloudflareApiError);
    await expect(attempt).rejects.toThrow(/archivio KV VOTI \(«loghi-VOTI»\), usato dal codice del Worker \(env\.VOTI\).*risposto 401.*Workers KV Storage › Edit.*Non è stato caricato nulla/u);
    expect(mock.state().uploadedAssetCount).toBe(0);

    mock.failNext({ method: "GET", path: `/client/v4/accounts/${mock.accountId}/storage/kv/namespaces`, status: 403, message: "Forbidden" });
    await expect(deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>v1</h1>", voting), kv: ["VOTI=voti-logo"] }))
      .rejects.toThrow(/archivio KV VOTI \(«voti-logo»\), dichiarato nelle impostazioni del sito.*risposto 403/u);
    expect(mock.state().uploadedAssetCount).toBe(0);
  });

  it("rifiuta un _worker.js che non è un modulo prima di contattare Cloudflare", async () => {
    await expect(deployBundle({ client, accountId: mock.accountId, script, files: files("<h1>v1</h1>", "addEventListener('fetch', () => {});\n") })).rejects.toThrow(/export default/u);
    expect(mock.state().requestCounts).toEqual({});
  });
});
