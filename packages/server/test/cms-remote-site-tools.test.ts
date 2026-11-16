import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { CmsProjectCatalog, createStaticPageProfile, encodeStaticPageProfileArchive } from "@histos-publish/cms";
import { afterEach, describe, expect, it } from "vitest";
import { applyRemoteSyncPlan, CmsRemoteCatalog, connectRemoteSite, createRemoteSyncPlan, syncRemoteSite } from "../src/cms-remote.js";
import { checkRemoteSite, explainSiteReason, siteText } from "../src/cms-remote-check.js";
import { bringClosure, parseBringIds } from "../src/cms-remote-bring.js";
import { planEntityList, readableContent } from "../src/cms-remote-diff.js";
import type { CmsSyncPlanEntity } from "../src/cms-remote-catalog.js";

/** Doc 23 items 197, 199 and 200 against a WordPress stand-in: «Controlla il sito», conflicts in bulk, «Porta nel progetto». */

const SITE_ID = "de7d1687-bf53-4b1e-8d96-43391da110f0";
const ROOTS: string[] = [];
const SERVERS: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  for (const server of SERVERS.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of ROOTS.splice(0)) await rm(root, { recursive: true, force: true });
});

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}

interface FakeSite {
  url: string;
  archive: Buffer | null;
  exportError: { status: number; code: string; message: string } | null;
  capabilities: Record<string, unknown>;
  exportHeaders: string[];
  imports: number;
}

/** A Histeon site that answers capabilities and export; it never checks signatures (cms-remote.test.ts does). */
async function fakeSite(projectId: string, projectName: string): Promise<FakeSite> {
  const site: FakeSite = { url: "", archive: null, exportError: null, capabilities: {}, exportHeaders: [], imports: 0 };
  const server = createServer((request, response) => {
    void (async () => {
      await readBody(request);
      const route = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("rest_route") ?? "";
      if (route === "/xb/v1/cms/v1/capabilities") {
        json(response, {
          contractVersion: 2, profile: "histos-static-page-v1", siteId: SITE_ID, projectId, projectName,
          capabilities: { read: true, write: true, publish: true, profiles: ["histos-static-page-v1", "histos-static-project-v1", "histos-static-project-v2", "histos-static-project-v3", "histos-static-project-v4"], markup: ["histos-transfer-markup-v1"] },
          ...site.capabilities,
        });
        return;
      }
      if (route === "/xb/v1/cms/v1/export") {
        site.exportHeaders.push(String(request.headers["x-histos-export"] ?? "adopt"));
        if (site.exportError) {
          json(response, { code: site.exportError.code, message: site.exportError.message }, site.exportError.status);
          return;
        }
        response.writeHead(200, { "Content-Type": "application/zip" }).end(site.archive);
        return;
      }
      if (route === "/xb/v1/cms/v1/import") site.imports += 1;
      response.writeHead(404).end("missing");
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  SERVERS.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  site.url = `http://127.0.0.1:${address.port}`;
  return site;
}

const text = (uid: string, content: string) => `<!-- wp:xb/text {"uid":"${uid}","content":"${content}"} /-->`;

/** The site's own project (what WP holds), made with Publish's own store so its profile is valid. */
async function siteProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-g11a-site-"));
  ROOTS.push(root);
  const catalog = new CmsProjectCatalog(root, { durable: false });
  await catalog.initialize();
  const { project, store } = await catalog.createProject("Sito di prova");
  const archive = async () => {
    const profile = await createStaticPageProfile(project, store);
    return { profile: profile.profile, archive: await encodeStaticPageProfileArchive(profile.profile, profile.files) };
  };
  return { project, store, archive };
}

async function linked(site: FakeSite) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-g11a-publish-"));
  ROOTS.push(dataDirectory);
  const secrets = new Map<string, string>();
  const secretStoreFor = (account: string) => ({
    get: async () => secrets.get(account) ?? null,
    set: async (value: string) => { secrets.set(account, value); },
    delete: async () => { secrets.delete(account); },
  });
  const remoteCatalog = new CmsRemoteCatalog(dataDirectory);
  const projects = new CmsProjectCatalog(dataDirectory, { durable: false });
  await projects.initialize();
  const code = `histos-cms-1:${Buffer.from(JSON.stringify({ url: site.url, secret: Buffer.alloc(32, 7).toString("base64url"), scopes: { read: true, write: true, publish: false } })).toString("base64url")}`;
  const connection = await connectRemoteSite(code, remoteCatalog, secretStoreFor);
  return { remoteCatalog, projects, secretStoreFor, connection };
}

describe("«Controlla il sito» (doc 23 item 197)", () => {
  it("names every content the site leaves out, with reason and remedy, and reads without writing", async () => {
    const wp = await siteProject();
    const built = await wp.archive();
    const leftOut = [
      { kind: "template-part", title: "Testata", reason: "The expression scope is not portable in 0b5a2f0e-0000-4000-8000-000000000001: url." },
      { kind: "page", title: "Contatti", reason: "The page profile cannot transfer external, embedded or unresolved media URLs." },
      { kind: "page", title: "Strana\u202e", reason: "Qualcosa di nuovo che Publish non conosce." },
    ];
    const profile = { ...built.profile, manifest: { ...built.profile.manifest, leftOut } };
    const files = (await createStaticPageProfile(wp.project, wp.store)).files;
    // The manifest hash covers leftOut: the archive is made again with it.
    const { manifestHashInput } = await import("@histos-publish/histos-contract");
    const { createHash } = await import("node:crypto");
    const { manifestHash: _old, ...base } = profile.manifest;
    profile.manifest = { ...base, manifestHash: createHash("sha256").update(manifestHashInput(base), "utf8").digest("hex") } as typeof profile.manifest;
    const site = await fakeSite(wp.project.id, wp.project.name);
    site.archive = await encodeStaticPageProfileArchive(profile, files);
    const { remoteCatalog, projects, secretStoreFor, connection } = await linked(site);

    const check = await checkRemoteSite({ connectionId: connection.id }, remoteCatalog, projects, secretStoreFor);
    expect(site.exportHeaders).toEqual(["read"]);
    expect(check).toMatchObject({ canSend: true, stoppedEarly: false, host: new URL(site.url).host });
    expect(check.read).toBeGreaterThan(0);
    expect(check.problems.map((problem) => problem.title)).toEqual(["Contatti", "Strana", "Testata"]);
    const header = check.problems.find((problem) => problem.title === "Testata")!;
    expect(header).toMatchObject({ where: "site", kind: "template-part", blocking: false });
    expect(header.reason).toContain("«url»");
    expect(header.remedy).toContain("url.path");
    expect(check.problems.find((problem) => problem.title === "Contatti")?.remedy).toContain("libreria dei media");
    expect(check.problems.find((problem) => problem.title === "Strana")?.message).toBe("Qualcosa di nuovo che Publish non conosce.");
  });

  it("asks a site with the check reading for it, and its contents the project knows are blocking (Histeon 0.5.7)", async () => {
    const wp = await siteProject();
    const built = await wp.archive();
    const leftOut = [
      { kind: "page", title: "Nota al progetto", reason: "The page profile cannot transfer external, embedded or unresolved media URLs.", blocks: true },
      { kind: "template", title: "Senza contenuto", reason: "Il template non ha il blocco «Contenuto del post»: aggiungilo nel builder dove va il testo della pagina, poi riprova." },
    ];
    const profile = { ...built.profile, manifest: { ...built.profile.manifest, leftOut } };
    const files = (await createStaticPageProfile(wp.project, wp.store)).files;
    const { manifestHashInput } = await import("@histos-publish/histos-contract");
    const { createHash } = await import("node:crypto");
    const { manifestHash: _old, ...base } = profile.manifest;
    profile.manifest = { ...base, manifestHash: createHash("sha256").update(manifestHashInput(base), "utf8").digest("hex") } as typeof profile.manifest;
    const site = await fakeSite(wp.project.id, wp.project.name);
    site.archive = await encodeStaticPageProfileArchive(profile as never, files);
    site.capabilities = { capabilities: { read: true, write: true, publish: true, profiles: ["histos-static-page-v1", "histos-static-project-v1", "histos-static-project-v2", "histos-static-project-v3", "histos-static-project-v4"], markup: ["histos-transfer-markup-v1"], readings: ["adopt", "read", "linked", "check", "altro"] } };
    const { remoteCatalog, projects, secretStoreFor, connection } = await linked(site);

    const check = await checkRemoteSite({ connectionId: connection.id }, remoteCatalog, projects, secretStoreFor);
    expect(site.exportHeaders).toEqual(["check"]);
    expect(check).toMatchObject({ canSend: false, stoppedEarly: false });
    expect(check.problems.find((problem) => problem.title === "Nota al progetto")).toMatchObject({ blocking: true });
    const template = check.problems.find((problem) => problem.title === "Senza contenuto");
    expect(template).toMatchObject({ kind: "template", blocking: false });
    expect(template?.remedy).toContain("Contenuto del post");
  });

  it("names the known content that stops the reading, and says a stopped reading may hide others", async () => {
    const wp = await siteProject();
    const site = await fakeSite(wp.project.id, wp.project.name);
    site.exportError = { status: 422, code: "xb_cms_unavailable", message: "Testata: The expression scope is not portable in 0b5a2f0e-0000-4000-8000-000000000001: url." };
    const { remoteCatalog, projects, secretStoreFor, connection } = await linked(site);
    const check = await checkRemoteSite({ connectionId: connection.id }, remoteCatalog, projects, secretStoreFor);
    expect(check).toMatchObject({ canSend: false, stoppedEarly: true });
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]).toMatchObject({ title: "Testata", blocking: true });
    expect(check.problems[0]?.reason).toContain("«url»");

    site.exportError = { status: 422, code: "xb_cms_unavailable", message: "Il sito WordPress non contiene ancora pagine Histeon da scaricare." };
    const other = await checkRemoteSite({ connectionId: connection.id }, remoteCatalog, projects, secretStoreFor);
    expect(other.problems[0]).toMatchObject({ title: "Un contenuto del sito", message: "Il sito WordPress non contiene ancora pagine Histeon da scaricare.", blocking: true });

    site.exportError = { status: 500, code: "xb_cms_export_failed", message: "Non è stato possibile preparare il profilo del sito." };
    const failed = await checkRemoteSite({ connectionId: connection.id }, remoteCatalog, projects, secretStoreFor);
    expect(failed.problems[0]).toMatchObject({ kind: "site", blocking: true });
    expect(failed.problems[0]?.remedy).toContain("Contenuto del post");
  });

  it("adds what of the project the site cannot read, and needs a link that may read", async () => {
    const wp = await siteProject();
    const built = await wp.archive();
    const site = await fakeSite(wp.project.id, wp.project.name);
    site.archive = built.archive;
    site.capabilities = { environment: { php: "8.1.2" } };
    const { remoteCatalog, projects, secretStoreFor, connection } = await linked(site);
    await syncRemoteSite({ action: "pull" }, connection, remoteCatalog, projects, secretStoreFor);
    const check = await checkRemoteSite({ connectionId: connection.id, projectId: wp.project.id }, remoteCatalog, projects, secretStoreFor);
    expect(check.canSend).toBe(false);
    expect(check.problems).toEqual([expect.objectContaining({ where: "project", title: "Sito di prova", blocking: true })]);
    expect(check.problems[0]?.reason).toContain("PHP 8.1.2");
    expect(check.problems[0]?.reason).not.toContain("non ho inviato nulla");

    // Pairing codes always allow reading today; an older link that does not is refused before any request.
    remoteCatalog.updateConnection(connection.id, { ...remoteCatalog.get(connection.id)!, read: false });
    await expect(checkRemoteSite({ connectionId: connection.id }, remoteCatalog, projects, secretStoreFor)).rejects.toMatchObject({ code: "cms-remote-read-scope-required" });
  });

  it("explains known reasons in plain words and keeps the site's text plain", () => {
    expect(explainSiteReason("A Histeon page template must contain the default slot.").remedy).toContain("Contenuto del post");
    expect(explainSiteReason("Template x contains a custom script outside the static project profile.").known).toBe(true);
    expect(explainSiteReason("boh").known).toBe(false);
    expect(siteText("a\u0000b\u202ec\n<d>", 100)).toBe("a b c <d>");
    expect(siteText("x".repeat(500), 10)).toHaveLength(10);
  });
});

describe("conflicts in bulk and contents only on the site (doc 23 items 199-200)", () => {
  it("lists conflicts first, then changes, then one-sided entries, aligned last", () => {
    const entity = (id: string, status: CmsSyncPlanEntity["status"], label: string): CmsSyncPlanEntity => ({ id, kind: "document", label, status, canResolve: false });
    const listed = planEntityList([entity("1", "unchanged", "A"), entity("2", "remote-only", "B"), entity("3", "update", "C"), entity("4", "conflict", "Z")]);
    expect(listed.entities.map((item) => item.id)).toEqual(["4", "3", "2", "1"]);
    expect(listed.omittedEntities).toBe(0);
  });

  it("compares the words of a page, not its markup", () => {
    expect(readableContent("content", `${text("aaaaaaaa1", "Ciao \\u003cb\\u003emondo\\u003c/b\\u003e")}${text("aaaaaaaa2", "Due")}`)).toBe("Ciao mondo · Due");
    expect(readableContent("title", "x")).toBeNull();
  });

  it("refuses ids that are not a list of identities", () => {
    expect(() => parseBringIds(["../x"])).toThrow();
    expect(() => parseBringIds([])).toThrow();
    expect(parseBringIds(undefined)).toBeUndefined();
    expect(parseBringIds([SITE_ID, SITE_ID])).toEqual([SITE_ID]);
  });

  it("brings only the chosen contents and what they need; the rest stays only on the site", async () => {
    const wp = await siteProject();
    const first = await wp.archive();
    const site = await fakeSite(wp.project.id, wp.project.name);
    site.archive = first.archive;
    const { remoteCatalog, projects, secretStoreFor, connection } = await linked(site);
    await syncRemoteSite({ action: "pull" }, connection, remoteCatalog, projects, secretStoreFor);

    // On the site, after the download: a card component, a page that uses it, and another page.
    const card = wp.store.createComponent({ ref: "ui/scheda", title: "Scheda", content: text("schedatx1", "Scheda"), schema: { props: {} } });
    const withCard = wp.store.createPage({ title: "Con la scheda", slug: "con-la-scheda", status: "published", content: `<!-- wp:xb/component {"uid":"schedaref1","ref":"ui/scheda"} /-->` });
    const other = wp.store.createPage({ title: "Un'altra pagina", slug: "altra", status: "published", content: text("altratxt1", "Altro") });
    site.archive = (await wp.archive()).archive;

    const push = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId: wp.project.id }, remoteCatalog, projects, secretStoreFor);
    const onSite = push.entities.filter((entity) => entity.status === "remote-only");
    expect(onSite.map((entity) => [entity.label, entity.onSite])).toEqual(expect.arrayContaining([["Con la scheda", "only-on-site"], ["Scheda", "only-on-site"], ["Un'altra pagina", "only-on-site"]]));
    expect(onSite.find((entity) => entity.label === "Con la scheda")?.documentType).toBe("page");

    await expect(createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId: wp.project.id, only: [withCard.id] }, remoteCatalog, projects, secretStoreFor)).rejects.toMatchObject({ code: "cms-remote-bring-invalid" });
    const bring = await createRemoteSyncPlan({ action: "pull", connectionId: connection.id, only: [withCard.id] }, remoteCatalog, projects, secretStoreFor);
    expect(bring.bring).toEqual({ requested: 1, total: 2 });
    expect(bring.entities.map((entity) => entity.id).sort()).toEqual([card.id, withCard.id].sort());
    expect(bring.applyAllowed).toBe(true);
    await applyRemoteSyncPlan({ connectionId: connection.id, planId: bring.planId! }, remoteCatalog, projects, secretStoreFor);

    const opened = (await projects.openProject(wp.project.id))!;
    try {
      expect(opened.store.listPages().map((page) => page.title).sort()).toEqual(["Con la scheda", "Home"].sort());
      expect(opened.store.getComponentById(card.id)?.ref).toBe("ui/scheda");
      expect(opened.store.getSyncBase(SITE_ID, withCard.id)).not.toBeNull();
      expect(opened.store.getSyncBase(SITE_ID, other.id)).toBeNull();
    } finally {
      opened.store.close();
    }
    const after = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId: wp.project.id }, remoteCatalog, projects, secretStoreFor);
    expect(after.entities.filter((entity) => entity.status === "remote-only").map((entity) => entity.label)).toEqual(["Un'altra pagina"]);
    expect(after.counts.conflict).toBe(0);
  });

  it("downloads only the conflicts, with a choice for each, and leaves the site's other contents out", async () => {
    const wp = await siteProject();
    const site = await fakeSite(wp.project.id, wp.project.name);
    site.archive = (await wp.archive()).archive;
    const { remoteCatalog, projects, secretStoreFor, connection } = await linked(site);
    await syncRemoteSite({ action: "pull" }, connection, remoteCatalog, projects, secretStoreFor);
    const home = wp.store.listPages()[0]!;
    // The same page changed on both sides, and a new page only on the site.
    const siteHead = wp.store.getHead(home.id)!;
    wp.store.saveDocument({ entityId: home.id, expectedHead: siteHead.id, content: text("homesite1", "Dal sito") });
    const extra = wp.store.createPage({ title: "Solo sul sito", slug: "solo-sito", status: "published", content: text("solosito1", "Solo") });
    site.archive = (await wp.archive()).archive;
    const local = (await projects.openProject(wp.project.id))!;
    const localHead = local.store.getHead(home.id)!;
    local.store.saveDocument({ entityId: home.id, expectedHead: localHead.id, content: text("homeprog1", "Dal progetto") });
    local.store.close();

    const push = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId: wp.project.id }, remoteCatalog, projects, secretStoreFor);
    expect(push.entities[0]).toMatchObject({ id: home.id, status: "conflict", canResolve: true });
    expect(push.entities[0]?.comparison).toEqual([{ field: "testo", local: "Dal progetto", remote: "Dal sito" }]);

    const resolve = await createRemoteSyncPlan({ action: "pull", connectionId: connection.id, only: [home.id] }, remoteCatalog, projects, secretStoreFor);
    expect(resolve.entities.map((entity) => entity.id)).toEqual([home.id]);
    expect(resolve.planId).not.toBeNull();
    await expect(applyRemoteSyncPlan({ connectionId: connection.id, planId: resolve.planId! }, remoteCatalog, projects, secretStoreFor)).rejects.toMatchObject({ code: "cms-sync-resolution-required" });
    await applyRemoteSyncPlan({ connectionId: connection.id, planId: resolve.planId!, resolutions: { [home.id]: "keep-local" } }, remoteCatalog, projects, secretStoreFor);

    const after = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId: wp.project.id }, remoteCatalog, projects, secretStoreFor);
    expect(after.counts.conflict).toBe(0);
    expect(after.entities.find((entity) => entity.id === home.id)?.status).toBe("update");
    expect(after.entities.find((entity) => entity.id === extra.id)?.status).toBe("remote-only");
  });

  it("stops a partial download that would need what cannot come along", () => {
    const entity = (id: string, kind: string, payload: Record<string, unknown>) => ({ id, kind, schemaVersion: 1, revisionHash: "a".repeat(64), payload }) as never;
    const page = "550e8400-e29b-41d4-a716-446655440001";
    const asset = "550e8400-e29b-41d4-a716-446655440002";
    const styles = "550e8400-e29b-41d4-a716-446655440003";
    const remote = { manifest: {}, entities: [entity(page, "document", { title: "Pagina", documentType: "page" }), entity(asset, "asset", { title: "Foto" }), entity(styles, "styles", {})], references: [{ ownerId: page, blockUid: "x", path: "attrs.attributes.src", targetId: asset, role: "media" }] } as never;
    const local = { manifest: {}, entities: [], references: [] } as never;
    const plan = (status: CmsSyncPlanEntity["status"], id: string, canResolve = false): CmsSyncPlanEntity => ({ id, kind: "document", label: id, status, canResolve });
    expect(bringClosure({ requested: [page], remote, local, pullEntities: [plan("new", page), plan("new", asset)] })).toEqual([page, asset].sort());
    expect(() => bringClosure({ requested: [page], remote, local, pullEntities: [plan("new", page), plan("conflict", asset)] })).toThrow(/Foto/u);
    expect(() => bringClosure({ requested: [styles], remote, local, pullEntities: [plan("update", styles)] })).toThrow(/stili/u);
    expect(() => bringClosure({ requested: [page], remote, local, pullEntities: [plan("conflict", page)] })).toThrow(/conflitto/u);
    expect(() => bringClosure({ requested: [page], remote, local, pullEntities: [plan("unchanged", page)] })).toThrow(/Niente da portare/u);
  });
});

describe("readableContent on content built to be slow", () => {
  it("stays linear on many openings without an end", () => {
    const hostile = "<!-- wp:xb/text {".repeat(200_000);
    const started = Date.now();
    expect(readableContent("content", hostile)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
