import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCloudflareMock, startFigmaMock } from "../packages/cf-mock/dist/index.js";
import { startLocalServer } from "../packages/server/dist/server.js";

const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE;
const port = Number(process.env.HISTOS_PUBLISH_E2E_PORT ?? 43129);
if (!stateFile || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Configurazione E2E mancante o non valida.");

const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-publish-e2e-"));
const mock = await startCloudflareMock({ dnsRecords: [
  { zone_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "www.example.test", type: "CNAME", content: "example.test", ttl: 1, proxied: true },
] });
// The REST API of Figma, simulated: one file with a colour style and a text style, and no variables (as below Enterprise).
// Not a real token: the shape of one, accepted by the stand-in only.
const figmaToken = "figd_prova-NONVERO_0123456789abcdefABCDEF";
const figmaKey = "AbCdEfGhIjKlMnOpQrStUv";
const figma = await startFigmaMock({ token: figmaToken, files: { [figmaKey]: {
  file: {
    name: "Kit dell'API",
    document: { id: "0:0", type: "DOCUMENT", children: [{ id: "0:1", type: "CANVAS", name: "Home", children: [{ id: "5:1", type: "RECTANGLE", name: "Fondo", styles: { fill: "1:1" } }] }] },
    styles: { "1:1": { key: "a", name: "Colors/Primary", styleType: "FILL" }, "2:1": { key: "b", name: "Body/Base", styleType: "TEXT" } },
  },
  nodes: {
    "1:1": { document: { id: "1:1", type: "RECTANGLE", fills: [{ type: "SOLID", color: { r: 29 / 255, g: 78 / 255, b: 216 / 255, a: 1 } }] } },
    "2:1": { document: { id: "2:1", type: "TEXT", style: { fontFamily: "Inter", fontWeight: 400, fontSize: 19, lineHeightPercentFontSize: 150, lineHeightUnit: "FONT_SIZE_%" } } },
  },
} } });
const secrets = new Map();
const server = await startLocalServer({
  port,
  dataDirectory,
  openBrowser: false,
  // B5 without the network: Inter has a verified OFL licence and one WOFF2 file; nothing else exists.
  fontFetcher: async (url) => {
    const encode = (value) => new TextEncoder().encode(value);
    if (url === "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/METADATA.pb") return { status: 200, body: encode('name: "Inter"\nlicense: "OFL"\n') };
    if (url.startsWith("https://fonts.googleapis.com/css2")) return { status: 200, body: encode("/* latin */\n@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/inter/latin.woff2) format('woff2'); unicode-range: U+0000-00FF; }") };
    if (url === "https://fonts.gstatic.com/s/inter/latin.woff2") return { status: 200, body: new Uint8Array([...encode("wOF2"), ...new Uint8Array(32)]) };
    return { status: 404, body: new Uint8Array() };
  },
  // The AI connector stays off until a test turns it on; its client is the bundle the build produced.
  connector: {
    appVersion: "0.0.0-e2e",
    clientScript: path.resolve("packages/connector/dist/histos-publish-connector.mjs"),
    minFreeBytes: 0,
    // A fake WordPress for the approval tests: the plan adds one page and removes one record, the send succeeds.
    wordpressPlan: async (input, catalog) => {
      const planId = catalog.saveSyncPlan({ connectionId: input.connectionId, action: input.action, projectId: input.projectId, remoteFingerprint: "e2e", localFingerprint: "e2e", resolvableConflictIds: [], expiresAt: Date.now() + 600_000 });
      return {
        schemaVersion: 1, planId, action: input.action, connectionId: input.connectionId, project: { id: input.projectId, name: "Progetto e2e" }, profile: "histos-static-project-v4",
        initializingRemote: false, expiresAt: new Date(Date.now() + 600_000).toISOString(), applyAllowed: true,
        counts: { new: 1, update: 0, delete: 1, unchanged: 3, "local-only": 0, "remote-only": 0, conflict: 0 },
        entities: [{ id: crypto.randomUUID(), kind: "page", label: "Chi siamo", status: "new", canResolve: false }, { id: crypto.randomUUID(), kind: "content-record", label: "Vecchia opera", status: "delete", canResolve: false }],
        omittedEntities: 0,
      };
    },
    wordpressApply: async () => ({ complete: true, report: { operationId: "e2e-operazione", pending: [] } }),
  },
  publishedHomeCheck: async (url) => url
    ? {
      status: "warning",
      url,
      statusCode: 200,
      contentType: "text/html",
      contentDisposition: "attachment; filename=download",
      message: "Il server invia la home come allegato. Il browser può scaricarla invece di mostrarla: controlla index.html e l’intestazione Content-Disposition.",
    }
    : { status: "unavailable", message: "Non è stato configurato un indirizzo pubblico da controllare." },
  secretStoreFactory: (account) => ({
    get: async () => secrets.get(account) ?? null,
    set: async (value) => { secrets.set(account, value); },
    delete: async () => { secrets.delete(account); },
  }),
});

process.env.HISTOS_CLOUDFLARE_API_BASE = mock.url;
process.env.HISTOS_CLOUDFLARE_API_TOKEN = mock.token;
// An empty optional account ID must not hide the account saved by one-click setup.
process.env.HISTOS_CLOUDFLARE_ACCOUNT_ID = "";
// The token of Figma is not in the environment: the test saves it from the app, into the keyring simulated above.
process.env.HISTOS_FIGMA_API_BASE = figma.origin;
delete process.env.HISTOS_FIGMA_API_TOKEN;
await writeFile(stateFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.port}`, token: server.token, mockUrl: mock.url, mockAccountId: mock.accountId, dataDirectory, figmaToken, figmaKey }), { mode: 0o600 });
process.stdout.write("Histeon Publish E2E pronto (Cloudflare simulato in locale).\n");

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close().catch(() => undefined);
  await mock.close().catch(() => undefined);
  await figma.close().catch(() => undefined);
  await rm(dataDirectory, { recursive: true, force: true });
  await rm(stateFile, { force: true });
  process.exit(0);
}
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
