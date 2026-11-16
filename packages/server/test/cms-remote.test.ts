import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import {
  CmsProjectCatalog,
  createDraftImportProfile,
  decodeStaticPageArchive,
  encodeStaticPageProfileArchive,
  type StaticPageProfile,
} from "@histos-publish/cms";
import {
  canonicalizeJson,
  canonicalRevisionPayload,
  manifestHashInput,
  type TransferEntity,
  type TransferManifest,
} from "@histos-publish/histos-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyRemoteSyncPlan,
  buildCompensatingArchive,
  buildSyncDiff,
  CmsRemoteCatalog,
  checkRemoteOperation,
  connectionHisteonNotice,
  connectRemoteSite,
  HISTEON_VERSION,
  createRemoteSyncPlan,
  rollbackRemoteOperation,
  syncRemoteSite,
} from "../src/cms-remote.js";
import { wordpressProvisionConnectionId } from "../src/wordpress-provisioner.js";

const SITE_ID = "de7d1687-bf53-4b1e-8d96-43391da110f0";
const ROOTS: string[] = [];
const SERVERS: Array<ReturnType<typeof createServer>> = [];

describe("buildSyncDiff conflict detail", () => {
  const id = "550e8400-e29b-41d4-a716-446655440101";
  const baseHash = "a".repeat(64);
  const entity = (kind: TransferEntity["kind"], revision: string, payload: Record<string, string>): TransferEntity => ({
    id,
    kind,
    schemaVersion: 1,
    revisionHash: revision.repeat(64),
    baseHash,
    payload,
  });
  const profile = (entities: TransferEntity[]) => ({ entities }) as unknown as StaticPageProfile;

  it("shows bounded field values and blocks type and explicit deletion conflicts", () => {
    const local = entity("document", "1", { title: "Locale", body: "x".repeat(400), localOnly: "presente" });
    const remote = entity("content-record", "2", { title: "Remoto", body: "y".repeat(400), remoteOnly: "presente" });
    const changedType = buildSyncDiff("pull", profile([local]), profile([remote]), new Map([[id, baseHash]]));
    expect(changedType.entities[0]).toMatchObject({ status: "conflict", canResolve: false, blockedReason: "type-changed" });
    expect(changedType.entities[0]?.comparison?.[0]).toEqual({ field: "tipo entità", local: "document", remote: "content-record" });
    expect(changedType.entities[0]?.comparison).toHaveLength(5);
    expect(changedType.entities[0]?.omittedComparisonFields).toBe(0);
    expect(changedType.entities[0]?.comparison?.find((field) => field.field === "body")?.local).toHaveLength(241);

    const localDeleted = buildSyncDiff("pull", profile([]), profile([entity("document", "2", { title: "Remoto" })]), new Map([[id, baseHash]]));
    expect(localDeleted.entities[0]).toMatchObject({ status: "conflict", blockedReason: "local-missing" });

    const remoteDeleted = buildSyncDiff("pull", profile([entity("document", "1", { title: "Locale" })]), profile([]), new Map([[id, baseHash]]));
    expect(remoteDeleted.entities[0]).toMatchObject({ status: "conflict", blockedReason: "remote-missing" });

    const tombstone = entity("tombstone", "3", {
      entityKind: "document",
      deletedAt: "2026-10-24T12:00:00.000Z",
      label: "Pagina rimossa",
      previousRevisionHash: baseHash,
      previousPayload: { title: "Versione prima della cancellazione" },
    } as unknown as Record<string, string>);
    const explicitDeletion = buildSyncDiff("pull", profile([local]), profile([tombstone]), new Map([[id, baseHash]]));
    expect(explicitDeletion.entities[0]).toMatchObject({ kind: "tombstone", label: "Pagina rimossa", status: "conflict", canResolve: false, blockedReason: "tombstone-conflict" });

    const unchangedCommonBase = { ...local, revisionHash: baseHash };
    const safeDeletion = buildSyncDiff("pull", profile([unchangedCommonBase]), profile([tombstone]), new Map([[id, baseHash]]));
    expect(safeDeletion.entities[0]).toMatchObject({ kind: "tombstone", status: "delete", canResolve: false });
    expect(safeDeletion.counts.delete).toBe(1);

    const localRecord = entity("content-record", "1", { title: "Record comune" });
    const recordTombstone = entity("tombstone", "3", {
      entityKind: "content-record",
      deletedAt: "2026-10-24T12:00:00.000Z",
      label: "Record comune",
      previousRevisionHash: baseHash,
      previousPayload: { title: "Record comune" },
    } as unknown as Record<string, string>);
    const safeRecordDeletion = buildSyncDiff("pull", profile([{ ...localRecord, revisionHash: baseHash }]), profile([recordTombstone]), new Map([[id, baseHash]]));
    expect(safeRecordDeletion.entities[0]).toMatchObject({ kind: "tombstone", label: "Record comune", status: "delete", canResolve: false });
  });

  it("recognizes component, template, and media deletions in both sync directions", () => {
    for (const kind of ["component", "template-part", "template", "asset"] as const) {
      const previous = entity(kind, "1", { title: `Contenuto ${kind}` });
      const tombstone = entity("tombstone", "3", {
        entityKind: kind,
        deletedAt: "2026-10-24T12:00:00.000Z",
        label: `Contenuto ${kind}`,
        previousRevisionHash: baseHash,
        previousPayload: previous.payload,
      } as unknown as Record<string, string>);
      const unchangedLocal = { ...previous, revisionHash: baseHash };
      const pulled = buildSyncDiff("pull", profile([unchangedLocal]), profile([tombstone]), new Map([[id, baseHash]]));
      const pushed = buildSyncDiff("push", profile([tombstone]), profile([unchangedLocal]), new Map([[id, baseHash]]));
      expect(pulled.entities[0]).toMatchObject({ kind: "tombstone", status: "delete" });
      expect(pushed.entities[0]).toMatchObject({ kind: "tombstone", status: "delete" });
    }
    const unsupported = entity("tombstone", "3", {
      entityKind: "styles",
      deletedAt: "2026-10-24T12:00:00.000Z",
      label: "Stili",
      previousRevisionHash: baseHash,
      previousPayload: { title: "Stili" },
    } as unknown as Record<string, string>);
    expect(buildSyncDiff("pull", profile([entity("styles", "1", { title: "Stili" })]), profile([unsupported]), new Map([[id, baseHash]])).entities[0])
      .toMatchObject({ status: "conflict", blockedReason: "tombstone-unsupported" });
  });
});

afterEach(async () => {
  await Promise.all(SERVERS.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.once("error", reject);
    request.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

function json(response: ServerResponse, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": String(body.byteLength),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function rewriteProfileEntities(
  profile: StaticPageProfile,
  files: Map<string, Buffer>,
  entities: TransferEntity[],
): { profile: StaticPageProfile; files: Map<string, Buffer> } {
  const nextFiles = new Map(files);
  nextFiles.delete("site.json");
  const entityBytes = Buffer.from(entities.map((entity) => canonicalizeJson(entity)).join("\n") + "\n");
  nextFiles.set("entities.ndjson", entityBytes);
  const manifestBase = {
    ...profile.manifest,
    files: profile.manifest.files.map((file) =>
      file.path === "entities.ndjson"
        ? { ...file, bytes: entityBytes.byteLength, sha256: createHash("sha256").update(entityBytes).digest("hex") }
        : file,
    ),
  };
  const manifestHash = createHash("sha256").update(manifestHashInput(manifestBase)).digest("hex");
  const manifest = { ...manifestBase, manifestHash } as TransferManifest;
  return {
    profile: { manifest, entities: entities as TransferEntity[], references: profile.references },
    files: nextFiles,
  };
}

function advanceRemoteBases(
  profile: StaticPageProfile,
  files: Map<string, Buffer>,
): { profile: StaticPageProfile; files: Map<string, Buffer> } {
  const entities = profile.entities.map((entity) => ({ ...entity, baseHash: entity.revisionHash }));
  return rewriteProfileEntities(profile, files, entities);
}

describe("Remote v2 page and component project profiles", () => {
  it("restores a verified WordPress preimage and realigns only the affected local sync bases", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-remote-rollback-"));
    ROOTS.push(dataDirectory);
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/test/fixtures/histos-static-page-v1.json", import.meta.url), "utf8")) as { profile: StaticPageProfile; files: Record<string, string> };
    let remoteProfile = fixture.profile;
    let remoteFiles = new Map(Object.entries(fixture.files).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]));
    let remoteArchive = await encodeStaticPageProfileArchive(remoteProfile, remoteFiles);
    let pauseRollbackPost = false;
    let rollbackPostStartedResolve = () => {};
    let releaseRollbackPostResolve = () => {};
    const rollbackPostStarted = new Promise<void>((resolve) => { rollbackPostStartedResolve = resolve; });
    const rollbackPostGate = new Promise<void>((resolve) => { releaseRollbackPostResolve = resolve; });
    let rollbackOperationId = "";
    let originalOperationId = "";
    let compensationPosts = 0;
    let missingRollbackStatusFor: string | null = null;
    let failRollbackStatusFor: string | null = null;
    let dropRollbackResponse = false;
    let rollbackPostCount = 0;
    let addExtraRollbackHead = false;
    let simulatePartialRollback = false;
    const secret = Buffer.from("83c6d70b328ece0af2051bb644c8471d4bd2ef5f07fa086a61bf42de02f973a2", "hex");
    const reports = new Map<string, Record<string, unknown>>();
    const remote = createServer((request, response) => {
      void (async () => {
        const body = await readBody(request);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const route = url.searchParams.get("rest_route") ?? "";
        const time = request.headers["x-histos-time"] ?? "";
        const nonce = request.headers["x-histos-nonce"] ?? "";
        const supplied = request.headers["x-histos-signature"] ?? "";
        const expected = createHmac("sha256", secret).update(`${request.method}\n${route}\n${time}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
        if (typeof supplied !== "string" || supplied !== expected) { response.writeHead(401).end(); return; }
        if (route === "/xb/v1/cms/v1/capabilities") {
          json(response, { contractVersion: 2, profile: remoteProfile.manifest.profile, siteId: SITE_ID, projectId: remoteProfile.manifest.project.id, projectName: remoteProfile.manifest.project.name, capabilities: { read: true, write: true, publish: true, profiles: ["histos-static-page-v1", "histos-static-project-v1", "histos-static-project-v2", "histos-static-project-v3"] } });
          return;
        }
        if (route === "/xb/v1/cms/v1/export" && request.method === "GET") {
          response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": String(remoteArchive.byteLength) }).end(remoteArchive);
          return;
        }
        if (["/xb/v1/cms/v1/import", "/xb/v1/cms/v1/publish"].includes(route) && request.method === "POST") {
          const decoded = await decodeStaticPageArchive(body);
          const decodedOperationId = decoded.profile.manifest.selection.snapshot;
          if (originalOperationId && decodedOperationId !== originalOperationId) compensationPosts += 1;
          if (pauseRollbackPost) {
            pauseRollbackPost = false;
            rollbackOperationId = decodedOperationId;
            rollbackPostCount += 1;
            rollbackPostStartedResolve();
            await rollbackPostGate;
          }
          const publishing = route.endsWith("/publish");
          // Like the bridge: the profile keeps the statuses as sent (development view).
          const prepared = { profile: decoded.profile, files: decoded.files };
          if (simulatePartialRollback) {
            simulatePartialRollback = false;
            rollbackOperationId = decodedOperationId;
            const pageTarget = prepared.profile.entities.find((entity) => entity.kind === "document");
            if (!pageTarget) throw new Error("Partial rollback fixture did not contain a page.");
            const partialEntities = remoteProfile.entities.map((entity) => entity.id === pageTarget.id ? pageTarget : entity);
            const partial = rewriteProfileEntities(remoteProfile, remoteFiles, partialEntities);
            const advancedPartial = advanceRemoteBases(partial.profile, partial.files);
            remoteProfile = advancedPartial.profile;
            remoteFiles = advancedPartial.files;
            remoteArchive = await encodeStaticPageProfileArchive(remoteProfile, remoteFiles);
            reports.set(decodedOperationId, { operationId: decodedOperationId, action: publishing ? "publish" : "import", published: publishing, complete: false, state: "partial", projectId: remoteProfile.manifest.project.id });
            response.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "mock partial write" }));
            return;
          }
          const advanced = advanceRemoteBases(prepared.profile, prepared.files);
          remoteProfile = advanced.profile;
          remoteFiles = advanced.files;
          remoteArchive = await encodeStaticPageProfileArchive(remoteProfile, remoteFiles);
          const heads = Object.fromEntries(remoteProfile.entities.map((entity) => [entity.id, entity.revisionHash]));
          const report = { complete: true, action: publishing ? "publish" : "import", published: publishing, project: { id: remoteProfile.manifest.project.id }, heads, changed: Object.keys(heads), unchanged: [], pending: [], operationId: decoded.profile.manifest.selection.snapshot };
          reports.set(String(report.operationId), { ...report, state: "complete", projectId: remoteProfile.manifest.project.id });
          if (dropRollbackResponse && rollbackOperationId === decodedOperationId) {
            dropRollbackResponse = false;
            failRollbackStatusFor = decodedOperationId;
            response.destroy();
            return;
          }
          json(response, report);
          return;
        }
        const statusMatch = /^\/xb\/v1\/cms\/v1\/status\/([0-9a-f-]{36})$/u.exec(route);
        if (statusMatch && request.method === "GET") {
          if (missingRollbackStatusFor === statusMatch[1]) {
            missingRollbackStatusFor = null;
            response.writeHead(404).end();
            return;
          }
          if (failRollbackStatusFor === statusMatch[1]) {
            failRollbackStatusFor = null;
            response.destroy();
            return;
          }
          if (reports.has(statusMatch[1]!)) {
            const report = reports.get(statusMatch[1]!)!;
            if (addExtraRollbackHead && statusMatch[1] === rollbackOperationId) {
              addExtraRollbackHead = false;
              json(response, {
                ...report,
                heads: { ...(report.heads as Record<string, string>), ["3a71171c-4938-4e2f-8620-b04974f7a170"]: "f".repeat(64) },
              });
              return;
            }
            json(response, report);
            return;
          }
        }
        response.writeHead(404).end();
      })().catch((error: unknown) => { response.writeHead(500).end(error instanceof Error ? error.message : "error"); });
    });
    await new Promise<void>((resolve, reject) => { remote.once("error", reject); remote.listen(0, "127.0.0.1", resolve); });
    SERVERS.push(remote);
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("Rollback test server did not start.");
    const secretStore = new Map<string, string>();
    const secretStoreFor = (account: string) => ({ get: async () => secretStore.get(account) ?? null, set: async (value: string) => { secretStore.set(account, value); }, delete: async () => { secretStore.delete(account); } });
    const code = `histos-cms-1:${Buffer.from(JSON.stringify({ url: `http://127.0.0.1:${address.port}`, secret: secret.toString("base64url"), scopes: { read: true, write: true, publish: true } })).toString("base64url")}`;
    const remoteCatalog = new CmsRemoteCatalog(dataDirectory);
    const projects = new CmsProjectCatalog(dataDirectory);
    await projects.initialize();
    try {
      const connection = await connectRemoteSite(code, remoteCatalog, secretStoreFor);
      await syncRemoteSite({ action: "pull" }, connection, remoteCatalog, projects, secretStoreFor);
      const opened = await projects.openProject(fixture.profile.manifest.project.id);
      if (!opened) throw new Error("Il progetto importato non è stato riaperto.");
      const page = opened.store.listPages()[0]!;
      const head = opened.store.getHead(page.id)!;
      const edited = opened.store.saveDocument({ entityId: page.id, expectedHead: head.id, content: `${head.content}<!-- wp:xb/text {"uid":"rollback01","content":"Modifica locale"} /-->` });
      expect(edited.status).toBe("saved");
      const component = opened.store.createComponent({ ref: "ui/rollback-card", title: "Componente temporaneo", content: '<!-- wp:xb/text {"uid":"rollback02","content":"Temporaneo"} /-->', schema: { props: {} } });
      opened.store.close();

      const sent = await syncRemoteSite({ action: "push", projectId: fixture.profile.manifest.project.id }, remoteCatalog.get(connection.id)!, remoteCatalog, projects, secretStoreFor);
      const operationId = String((sent.report as Record<string, unknown>).operationId);
      originalOperationId = operationId;
      const operation = remoteCatalog.getOperation(connection.id, operationId);
      expect(operation).toMatchObject({ state: "complete", rollbackAvailable: true });
      const before = await decodeStaticPageArchive(remoteCatalog.getOperationPreviousArchive(connection.id, operationId)!);

      simulatePartialRollback = true;
      await expect(rollbackRemoteOperation({ connectionId: connection.id, operationId }, remoteCatalog, projects, secretStoreFor))
        .rejects.toMatchObject({ code: "cms-remote-rollback-incomplete" });
      const interruptedRestore = remoteCatalog.listOperations(connection.id).find((candidate) => candidate.rollbackOfOperationId === operationId);
      expect(interruptedRestore).toMatchObject({ state: "partial", rollbackRetryAvailable: true });
      await expect(checkRemoteOperation({ connectionId: connection.id, operationId: interruptedRestore!.operationId }, remoteCatalog, projects, secretStoreFor))
        .resolves.toMatchObject({ state: "partial" });
      const partialProfile = remoteProfile;
      const partialFiles = new Map(remoteFiles);
      const partialPage = partialProfile.entities.find((entity) => entity.kind === "document");
      if (!partialPage) throw new Error("Partial rollback fixture did not retain its page.");
      const editedPartialEntities = partialProfile.entities.map((entity) => {
        if (entity.id !== partialPage.id) return entity;
        const payload = { ...entity.payload, title: "Modifica estranea durante il ripristino" };
        return { ...entity, payload, revisionHash: createHash("sha256").update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, payload), "utf8").digest("hex") };
      });
      const editedPartial = rewriteProfileEntities(partialProfile, partialFiles, editedPartialEntities);
      remoteProfile = editedPartial.profile;
      remoteFiles = editedPartial.files;
      remoteArchive = await encodeStaticPageProfileArchive(remoteProfile, remoteFiles);
      const requestsBeforeConflict = compensationPosts;
      await expect(rollbackRemoteOperation({ connectionId: connection.id, operationId }, remoteCatalog, projects, secretStoreFor))
        .rejects.toMatchObject({ code: "cms-remote-rollback-conflict" });
      expect(compensationPosts).toBe(requestsBeforeConflict);
      expect(remoteProfile.entities.find((entity) => entity.id === partialPage.id)?.payload.title).toBe("Modifica estranea durante il ripristino");
      remoteProfile = partialProfile;
      remoteFiles = partialFiles;
      remoteArchive = await encodeStaticPageProfileArchive(remoteProfile, remoteFiles);
      missingRollbackStatusFor = interruptedRestore!.operationId;
      await expect(checkRemoteOperation({ connectionId: connection.id, operationId: interruptedRestore!.operationId }, remoteCatalog, projects, secretStoreFor))
        .resolves.toMatchObject({ state: "not-found" });
      expect(remoteCatalog.getOperation(connection.id, interruptedRestore!.operationId)).toMatchObject({ state: "not-found", rollbackRetryAvailable: true });
      const restored = await rollbackRemoteOperation({ connectionId: connection.id, operationId }, remoteCatalog, projects, secretStoreFor);
      expect(restored).toMatchObject({ state: "rolled-back", published: false, projectId: fixture.profile.manifest.project.id });
      expect(remoteCatalog.getOperation(connection.id, interruptedRestore!.operationId)).toMatchObject({ state: "superseded", rollbackRetryAvailable: false });
      expect(remoteCatalog.listOperations(connection.id)).toContainEqual(expect.objectContaining({ rollbackOfOperationId: operationId, state: "complete-local-changes" }));
      expect(remoteProfile.entities.find((entity) => entity.id === page.id)?.revisionHash).toBe(before.profile.entities.find((entity) => entity.id === page.id)?.revisionHash);
      expect(remoteProfile.entities.find((entity) => entity.id === component.id)?.kind).toBe("tombstone");
      expect(remoteCatalog.getOperation(connection.id, operationId)).toMatchObject({ state: "rolled-back", rollbackAvailable: false });

      const after = await projects.openProject(fixture.profile.manifest.project.id);
      if (!after) throw new Error("Il progetto locale non è stato riaperto dopo il ripristino.");
      expect(after.store.getHead(page.id)?.content).toContain("Modifica locale");
      expect(after.store.getSyncBase(SITE_ID, page.id)?.baseHash).toBe(before.profile.entities.find((entity) => entity.id === page.id)?.revisionHash);
      expect(after.store.getSyncBase(SITE_ID, component.id)).toBeNull();
      after.store.close();
      await expect(rollbackRemoteOperation({ connectionId: connection.id, operationId }, remoteCatalog, projects, secretStoreFor)).rejects.toMatchObject({ code: "cms-remote-rollback-state-invalid" });

      // Repeat from a clean, independent local catalog and lose both the
      // restore response and the immediate status lookup. The second request
      // must be refused while the first remote write is unresolved, then the
      // saved child operation must complete after the catalog is reopened.
      const recoveryDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-remote-rollback-recovery-"));
      ROOTS.push(recoveryDirectory);
      remoteProfile = fixture.profile;
      remoteFiles = new Map(Object.entries(fixture.files).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]));
      remoteArchive = await encodeStaticPageProfileArchive(remoteProfile, remoteFiles);
      let recoveryCatalog = new CmsRemoteCatalog(recoveryDirectory);
      const recoveryProjects = new CmsProjectCatalog(recoveryDirectory);
      await recoveryProjects.initialize();
      try {
        const recoveryConnection = await connectRemoteSite(code, recoveryCatalog, secretStoreFor);
        await syncRemoteSite({ action: "pull" }, recoveryConnection, recoveryCatalog, recoveryProjects, secretStoreFor);
        const local = await recoveryProjects.openProject(fixture.profile.manifest.project.id);
        if (!local) throw new Error("Il progetto locale di recupero non è stato riaperto.");
        const localPage = local.store.listPages()[0]!;
        const localHead = local.store.getHead(localPage.id)!;
        expect(local.store.saveDocument({ entityId: localPage.id, expectedHead: localHead.id, content: `${localHead.content}<!-- wp:xb/text {\"uid\":\"rollback03\",\"content\":\"Modifica durante il recupero\"} /-->` }).status).toBe("saved");
        local.store.close();
        const recoverySend = await syncRemoteSite({ action: "push", projectId: fixture.profile.manifest.project.id }, recoveryCatalog.get(recoveryConnection.id)!, recoveryCatalog, recoveryProjects, secretStoreFor);
        const originalId = String((recoverySend.report as Record<string, unknown>).operationId);
        originalOperationId = originalId;
        const postPushProfile = remoteProfile;
        const postPushFiles = new Map(remoteFiles);
        const postPushArchive = remoteArchive;

        const changedRemoteEntities = postPushProfile.entities.map((entity) => {
          if (entity.id !== localPage.id) return entity;
          const payload = { ...entity.payload, title: `${String(entity.payload.title ?? "Pagina")} modificata manualmente` };
          return {
            ...entity,
            payload,
            revisionHash: createHash("sha256").update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, payload), "utf8").digest("hex"),
          };
        });
        const divergent = rewriteProfileEntities(postPushProfile, postPushFiles, changedRemoteEntities);
        remoteProfile = divergent.profile;
        remoteFiles = divergent.files;
        remoteArchive = await encodeStaticPageProfileArchive(remoteProfile, remoteFiles);
        await expect(rollbackRemoteOperation({ connectionId: recoveryConnection.id, operationId: originalId }, recoveryCatalog, recoveryProjects, secretStoreFor))
          .rejects.toMatchObject({ code: "cms-remote-rollback-conflict" });
        expect(recoveryCatalog.getOperation(recoveryConnection.id, originalId)).toMatchObject({ rollbackAvailable: true });
        expect(rollbackPostCount).toBe(0);
        remoteProfile = postPushProfile;
        remoteFiles = postPushFiles;
        remoteArchive = postPushArchive;

        pauseRollbackPost = true;
        dropRollbackResponse = true;
        const firstRollback = rollbackRemoteOperation({ connectionId: recoveryConnection.id, operationId: originalId }, recoveryCatalog, recoveryProjects, secretStoreFor);
        await rollbackPostStarted;
        expect(rollbackOperationId).not.toBe("");
        expect(recoveryCatalog.getOperation(recoveryConnection.id, originalId)).toMatchObject({ rollbackAvailable: false });
        await expect(rollbackRemoteOperation({ connectionId: recoveryConnection.id, operationId: originalId }, recoveryCatalog, recoveryProjects, secretStoreFor))
          .rejects.toMatchObject({ code: "cms-remote-rollback-in-progress" });
        expect(rollbackPostCount).toBe(1);
        releaseRollbackPostResolve();
        await expect(firstRollback).rejects.toMatchObject({ code: "cms-remote-rollback-uncertain" });
        expect(recoveryCatalog.getOperation(recoveryConnection.id, rollbackOperationId)).toMatchObject({
          state: "pending",
          rollbackOfOperationId: originalId,
        });
        recoveryCatalog.close();

        recoveryCatalog = new CmsRemoteCatalog(recoveryDirectory);
        expect(recoveryCatalog.getOperation(recoveryConnection.id, originalId)).toMatchObject({ rollbackAvailable: false });
        addExtraRollbackHead = true;
        await expect(checkRemoteOperation(
          { connectionId: recoveryConnection.id, operationId: rollbackOperationId },
          recoveryCatalog,
          recoveryProjects,
          secretStoreFor,
        )).rejects.toMatchObject({ code: "cms-remote-heads-invalid" });
        expect(recoveryCatalog.getOperation(recoveryConnection.id, rollbackOperationId)).toMatchObject({ state: "pending" });
        const recovered = await checkRemoteOperation(
          { connectionId: recoveryConnection.id, operationId: rollbackOperationId },
          recoveryCatalog,
          recoveryProjects,
          secretStoreFor,
        );
        expect(recovered).toMatchObject({ state: "complete-local-changes", localChanges: 1 });
        await expect(checkRemoteOperation(
          { connectionId: recoveryConnection.id, operationId: rollbackOperationId },
          recoveryCatalog,
          recoveryProjects,
          secretStoreFor,
        )).resolves.toMatchObject({ state: "complete-local-changes", localChanges: 1 });
        expect(recoveryCatalog.getOperation(recoveryConnection.id, rollbackOperationId)).toMatchObject({
          state: "complete-local-changes",
          rollbackOfOperationId: originalId,
        });
        expect(recoveryCatalog.getOperation(recoveryConnection.id, originalId)).toMatchObject({ state: "rolled-back", rollbackAvailable: false });
        expect(rollbackPostCount).toBe(1);
        const recoveredProject = await recoveryProjects.openProject(fixture.profile.manifest.project.id);
        if (!recoveredProject) throw new Error("Il progetto non è stato riaperto dopo il recupero del journal.");
        expect(recoveredProject.store.getHead(localPage.id)?.content).toContain("Modifica durante il recupero");
        expect(recoveredProject.store.getSyncBase(SITE_ID, localPage.id)?.baseHash).toBe(
          fixture.profile.entities.find((entity) => entity.id === localPage.id)?.revisionHash,
        );
        recoveredProject.store.close();
      } finally {
        recoveryCatalog.close();
      }
    } finally {
      remoteCatalog.close();
    }
  });

  it("persists pending remote operations and never prunes them with completed history", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-operation-journal-"));
    ROOTS.push(dataDirectory);
    let catalog = new CmsRemoteCatalog(dataDirectory);
    const connectionId = randomUUID();
    const projectId = randomUUID();
    const entityId = randomUUID();
    catalog.add({
      id: connectionId,
      url: "https://wp.example.test",
      siteId: randomUUID(),
      projectId,
      projectName: "WP",
      profile: "histos-static-project-v3",
      read: true,
      write: true,
      publish: false,
    });
    expect(() => catalog.recordOperation({
      operationId: randomUUID(), connectionId, projectId, action: "push", expectedHeads: {},
      archiveHash: "a".repeat(64), requestArchive: Buffer.from("compensation"),
    })).toThrow("Registro operazione remota non valido.");
    expect(() => catalog.recordOperation({
      operationId: randomUUID(), connectionId, projectId, action: "push", expectedHeads: {},
      archiveHash: "a".repeat(64), rollbackOfOperationId: randomUUID(), supersedeOperationId: randomUUID(),
    })).toThrow("Registro operazione remota non valido.");
    const pending = catalog.recordOperation({
      operationId: randomUUID(),
      connectionId,
      projectId,
      action: "push",
      expectedHeads: { [entityId]: "b".repeat(64) },
      archiveHash: "a".repeat(64),
      previousArchive: Buffer.from("before-image"),
    });
    let lastCompletedOperationId = "";
    for (let index = 0; index < 22; index += 1) {
      const complete = catalog.recordOperation({
        operationId: randomUUID(),
        connectionId,
        projectId,
        action: "push",
        expectedHeads: { [entityId]: "c".repeat(64) },
        archiveHash: "d".repeat(64),
      });
      catalog.updateOperation(connectionId, complete.operationId, "complete", null, { [entityId]: "c".repeat(64) });
      lastCompletedOperationId = complete.operationId;
    }
    expect(catalog.listOperations(connectionId)).toHaveLength(21);
    expect(catalog.getOperation(connectionId, pending.operationId)?.state).toBe("pending");
    catalog.close();

    catalog = new CmsRemoteCatalog(dataDirectory);
    try {
      expect(catalog.getOperation(connectionId, pending.operationId)).toMatchObject({ state: "pending", projectId });
      expect(catalog.getOperationPreviousArchive(connectionId, pending.operationId)).toEqual(Buffer.from("before-image"));
      expect(catalog.getOperation(connectionId, lastCompletedOperationId)?.resultHeads).toEqual({ [entityId]: "c".repeat(64) });
      expect(catalog.listOperations(connectionId)).toHaveLength(21);
    } finally {
      catalog.close();
    }
  });

  it("prepares a guarded first push to a clean WordPress site and rechecks the empty state", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-remote-initialize-"));
    ROOTS.push(dataDirectory);
    const secret = Buffer.from("792a20af0fa0d0fb2d4f4611f7219cb9c6610b88d53df40bbdd489e617ab6381", "hex");
    let currentProfile: StaticPageProfile | null = null;
    let currentFiles = new Map<string, Buffer>();
    let currentArchive: Buffer | null = null;
    let initializationAllowed = true;
    let importRequests = 0;
    let exportRequests = 0;
    // Doc 23 item 175: a Histeon before 0.5.2 says neither its version nor its PHP.
    let environment: { histeon: string; php: string } | null = null;
    const remote = createServer((request, response) => {
      void (async () => {
        const body = await readBody(request);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const route = url.searchParams.get("rest_route") ?? "";
        const time = request.headers["x-histos-time"] ?? "";
        const nonce = request.headers["x-histos-nonce"] ?? "";
        const supplied = request.headers["x-histos-signature"] ?? "";
        const expected = createHmac("sha256", secret)
          .update(`${request.method}\n${route}\n${time}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`)
          .digest("hex");
        if (typeof supplied !== "string" || supplied !== expected) {
          response.writeHead(401).end();
          return;
        }
        if (route === "/xb/v1/cms/v1/capabilities") {
          json(response, {
            contractVersion: 2,
            profile: currentProfile?.manifest.profile ?? "histos-static-page-v1",
            siteId: SITE_ID,
            projectId: currentProfile?.manifest.project.id ?? null,
            canInitializeProject: currentProfile === null && initializationAllowed,
            projectName: currentProfile?.manifest.project.name ?? "WordPress vuoto",
            capabilities: {
              read: true,
              write: true,
              publish: false,
              profiles: [
                "histos-static-page-v1",
                "histos-static-project-v1",
                "histos-static-project-v2",
                "histos-static-project-v3",
              ],
            },
            ...(environment ? { environment } : {}),
          });
          return;
        }
        if (route === "/xb/v1/cms/v1/export" && request.method === "GET") {
          exportRequests += 1;
          if (!currentArchive) {
            response.writeHead(422).end();
            return;
          }
          response
            .writeHead(200, { "Content-Type": "application/zip", "Content-Length": String(currentArchive.byteLength) })
            .end(currentArchive);
          return;
        }
        if (route === "/xb/v1/cms/v1/import" && request.method === "POST") {
          importRequests += 1;
          const decoded = await decodeStaticPageArchive(body);
          const prepared = { profile: decoded.profile, files: decoded.files };
          const advanced = advanceRemoteBases(prepared.profile, prepared.files);
          currentProfile = advanced.profile;
          currentFiles = advanced.files;
          currentArchive = await encodeStaticPageProfileArchive(currentProfile, currentFiles);
          const heads = Object.fromEntries(currentProfile.entities.map((entity) => [entity.id, entity.revisionHash]));
          json(response, {
            action: "import",
            complete: true,
            operationId: decoded.profile.manifest.selection.snapshot,
            project: { id: decoded.profile.manifest.project.id },
            heads,
            changed: Object.keys(heads),
            pending: [],
            unchanged: [],
            published: false,
          });
          return;
        }
        response.writeHead(404).end();
      })().catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : "error");
      });
    });
    await new Promise<void>((resolve, reject) => {
      remote.once("error", reject);
      remote.listen(0, "127.0.0.1", resolve);
    });
    SERVERS.push(remote);
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("Remote initialization test server did not start.");
    const code = `histos-cms-1:${Buffer.from(JSON.stringify({ url: `http://127.0.0.1:${address.port}`, secret: secret.toString("base64url"), scopes: { read: true, write: true, publish: false } })).toString("base64url")}`;
    const secrets = new Map<string, string>();
    const secretStoreFor = (account: string) => ({
      get: async () => secrets.get(account) ?? null,
      set: async (value: string) => {
        secrets.set(account, value);
      },
      delete: async () => {
        secrets.delete(account);
      },
    });
    const remotes = new CmsRemoteCatalog(dataDirectory);
    const projects = new CmsProjectCatalog(dataDirectory);
    await projects.initialize();
    const created = await projects.createProject("Primo progetto Histeon");
    const initialPage = created.store.listPages()[0];
    if (!initialPage) throw new Error("Il progetto CMS iniziale non contiene la pagina prevista.");
    created.store.updatePageMetadata(initialPage.id, { title: initialPage.title, slug: initialPage.slug, status: "published" });
    created.store.close();
    try {
      const connection = await connectRemoteSite(code, remotes, secretStoreFor);
      // Doc 23 item 175: the link's screen says the site's Histeon is older, and what will not work.
      const linkNotice = connectionHisteonNotice(remotes.get(connection.id)!);
      expect(linkNotice).toMatchObject({ site: null, known: HISTEON_VERSION });
      expect(linkNotice?.missing.map((feature) => feature.id)).toEqual(["site-environment", "post-image", "types-without-pages", "group-by", "media-links", "url-path", "loop-group", "terms-order", "front-page", "site-check", "field-order", "svg-text"]);
      expect(linkNotice?.missing.find((feature) => feature.id === "media-links")).toMatchObject({ since: "0.5.2", capability: "histos-media-links-v1" });
      const stalePlan = await createRemoteSyncPlan(
        { action: "push", connectionId: connection.id, projectId: created.project.id },
        remotes,
        projects,
        secretStoreFor,
      );
      expect(stalePlan).toMatchObject({ initializingRemote: true, applyAllowed: true, counts: { conflict: 0 } });
      expect(stalePlan.counts.new).toBeGreaterThan(0);
      expect(stalePlan.planId).toBeTruthy();
      initializationAllowed = false;
      await expect(
        applyRemoteSyncPlan(
          { connectionId: connection.id, planId: stalePlan.planId!, expectedProjectId: randomUUID() },
          remotes,
          projects,
          secretStoreFor,
        ),
      ).rejects.toMatchObject({ code: "cms-sync-plan-expired" });
      await expect(
        applyRemoteSyncPlan(
          { connectionId: connection.id, planId: stalePlan.planId! },
          remotes,
          projects,
          secretStoreFor,
        ),
      ).rejects.toMatchObject({ code: "cms-sync-plan-stale" });
      expect(importRequests).toBe(0);

      initializationAllowed = true;
      const plan = await createRemoteSyncPlan(
        { action: "push", connectionId: connection.id, projectId: created.project.id },
        remotes,
        projects,
        secretStoreFor,
      );
      // Said in the plan of the send, and not a block: the capabilities are enough for this project.
      expect(plan).toMatchObject({ initializingRemote: true, applyAllowed: true, histeon: { site: null, known: HISTEON_VERSION } });
      const sent = await applyRemoteSyncPlan(
        { connectionId: connection.id, planId: plan.planId! },
        remotes,
        projects,
        secretStoreFor,
      );
      expect(sent).toMatchObject({ action: "push", complete: true });
      expect(importRequests).toBe(1);
      expect(exportRequests).toBe(0);
      expect(remotes.get(connection.id)?.projectId).toBe(created.project.id);
      // The send keeps the authored status: WordPress holds it in development until its next release.
      expect(currentProfile?.entities.find((entity) => entity.id === initialPage.id)?.payload.status).toBe("published");
      const localAfterPush = await projects.openProject(created.project.id);
      if (!localAfterPush) throw new Error("Il progetto CMS non si è riaperto dopo l’invio iniziale.");
      expect(localAfterPush.store.listPages().find((page) => page.id === initialPage.id)?.status).toBe("published");
      localAfterPush.store.close();
      const followUp = await createRemoteSyncPlan(
        { action: "push", connectionId: connection.id, projectId: created.project.id },
        remotes,
        projects,
        secretStoreFor,
      );
      expect(followUp).toMatchObject({ initializingRemote: false, applyAllowed: true, histeon: { site: null } });
      expect(followUp.counts.unchanged).toBeGreaterThan(0);
      expect(exportRequests).toBe(1);
      // A site with an older version that says it: the same notice, with its version; a download plan does not carry it.
      environment = { histeon: "0.5.1", php: "8.4.1" };
      const older = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId: created.project.id }, remotes, projects, secretStoreFor);
      expect(older.histeon).toMatchObject({ site: "0.5.1", known: HISTEON_VERSION });
      expect(connectionHisteonNotice(remotes.get(connection.id)!)).toMatchObject({ site: "0.5.1" });
      expect((await createRemoteSyncPlan({ action: "pull", connectionId: connection.id }, remotes, projects, secretStoreFor)).histeon).toBeUndefined();
      // Updated to the Histeon Publish knows: nothing to say, here or on the link.
      environment = { histeon: HISTEON_VERSION, php: "8.4.1" };
      const current = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId: created.project.id }, remotes, projects, secretStoreFor);
      expect(current.histeon).toBeUndefined();
      expect(remotes.get(connection.id)?.siteHisteon).toBe(HISTEON_VERSION);
      expect(connectionHisteonNotice(remotes.get(connection.id)!)).toBeNull();
    } finally {
      remotes.close();
    }
  });

  it("refuses SVG, picture and textarea text before any upload to a site without markup v1, and still sends forms", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-remote-markup-"));
    ROOTS.push(dataDirectory);
    const secret = Buffer.from("5b9c1d0a7e3f4b2a8c6d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d", "hex");
    let markup: string[] = [];
    let currentProjectId: string | null = null;
    let importRequests = 0;
    const remote = createServer((request, response) => {
      void (async () => {
        const body = await readBody(request);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const route = url.searchParams.get("rest_route") ?? "";
        const expected = createHmac("sha256", secret)
          .update(`${request.method}\n${route}\n${request.headers["x-histos-time"] ?? ""}\n${request.headers["x-histos-nonce"] ?? ""}\n${createHash("sha256").update(body).digest("hex")}`)
          .digest("hex");
        if (request.headers["x-histos-signature"] !== expected) {
          response.writeHead(401).end();
          return;
        }
        if (route === "/xb/v1/cms/v1/capabilities") {
          json(response, {
            contractVersion: 2, profile: "histos-static-page-v1", siteId: SITE_ID, projectId: currentProjectId, canInitializeProject: currentProjectId === null,
            projectName: "WordPress vuoto", capabilities: { read: true, write: true, publish: false, profiles: ["histos-static-page-v1", "histos-static-project-v1"], markup },
          });
          return;
        }
        if (route === "/xb/v1/cms/v1/import" && request.method === "POST") {
          importRequests += 1;
          const decoded = await decodeStaticPageArchive(body);
          currentProjectId = decoded.profile.manifest.project.id;
          const heads = Object.fromEntries(decoded.profile.entities.map((entity) => [entity.id, entity.revisionHash]));
          json(response, { action: "import", complete: true, operationId: decoded.profile.manifest.selection.snapshot, project: { id: currentProjectId }, heads, changed: Object.keys(heads), pending: [], unchanged: [], published: false });
          return;
        }
        response.writeHead(404).end();
      })().catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : "error");
      });
    });
    await new Promise<void>((resolve, reject) => {
      remote.once("error", reject);
      remote.listen(0, "127.0.0.1", resolve);
    });
    SERVERS.push(remote);
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("Remote markup test server did not start.");
    const code = `histos-cms-1:${Buffer.from(JSON.stringify({ url: `http://127.0.0.1:${address.port}`, secret: secret.toString("base64url"), scopes: { read: true, write: true, publish: false } })).toString("base64url")}`;
    const secrets = new Map<string, string>();
    const secretStoreFor = (account: string) => ({
      get: async () => secrets.get(account) ?? null,
      set: async (value: string) => { secrets.set(account, value); },
      delete: async () => { secrets.delete(account); },
    });
    const remotes = new CmsRemoteCatalog(dataDirectory);
    const projects = new CmsProjectCatalog(dataDirectory);
    await projects.initialize();
    const save = async (projectId: string, content: string) => {
      const opened = await projects.openProject(projectId);
      if (!opened) throw new Error("Il progetto CMS non si apre.");
      const page = opened.store.listPages()[0]!;
      expect(opened.store.saveDocument({ entityId: page.id, expectedHead: opened.store.getHead(page.id)!.id, content }).status).toBe("saved");
      opened.store.close();
    };
    const icons = await projects.createProject("Icone");
    icons.store.close();
    await save(icons.project.id, '<!-- wp:xb/element {"uid":"markupsvg001","tag":"svg","attributes":{"viewBox":"0 0 24 24","aria-hidden":"true"}} --><!-- wp:xb/element {"uid":"markupsvg002","tag":"path","attributes":{"d":"M3 12h18"}} /--><!-- /wp:xb/element -->');
    const forms = await projects.createProject("Moduli");
    forms.store.close();
    await save(forms.project.id, '<!-- wp:xb/element {"uid":"markupform01","tag":"form","attributes":{"action":"/cerca/","method":"get"}} --><!-- wp:xb/element {"uid":"markupform02","tag":"input","attributes":{"type":"search","name":"q"}} /--><!-- wp:xb/element {"uid":"markupform03","tag":"button","attributes":{"type":"submit"}} --><!-- wp:xb/text {"uid":"markupform04","content":"Cerca"} /--><!-- /wp:xb/element --><!-- /wp:xb/element -->');
    try {
      const connection = await connectRemoteSite(code, remotes, secretStoreFor);
      await expect(createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId: icons.project.id }, remotes, projects, secretStoreFor))
        .rejects.toMatchObject({ code: "cms-remote-markup-unavailable" });
      expect(importRequests).toBe(0);

      // Forms and buttons travel to a plugin without markup v1: it accepts them already.
      const formsPlan = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId: forms.project.id }, remotes, projects, secretStoreFor);
      expect(formsPlan).toMatchObject({ initializingRemote: true, applyAllowed: true });
      await expect(applyRemoteSyncPlan({ connectionId: connection.id, planId: formsPlan.planId! }, remotes, projects, secretStoreFor)).resolves.toMatchObject({ action: "push", complete: true });
      expect(importRequests).toBe(1);
    } finally {
      remotes.close();
    }

    const secondDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-remote-markup-v1-"));
    ROOTS.push(secondDirectory);
    currentProjectId = null;
    markup = ["histos-transfer-markup-v1"];
    const upgradedRemotes = new CmsRemoteCatalog(secondDirectory);
    try {
      const connection = await connectRemoteSite(code, upgradedRemotes, secretStoreFor);
      const plan = await createRemoteSyncPlan({ action: "push", connectionId: connection.id, projectId: icons.project.id }, upgradedRemotes, projects, secretStoreFor);
      await expect(applyRemoteSyncPlan({ connectionId: connection.id, planId: plan.planId! }, upgradedRemotes, projects, secretStoreFor)).resolves.toMatchObject({ action: "push", complete: true });
      expect(importRequests).toBe(2);
      // Doc 23 item 121: a link to a media file needs a site that reads histos-media-links-v1.
      const links = await projects.createProject("Link ai file");
      const asset = links.store.saveAsset({ bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png", filename: "foto.png", alt: "Foto" });
      links.store.close();
      await save(links.project.id, `<!-- wp:xb/element {"uid":"markuplink01","tag":"a","attributes":{"href":"/__cms-media/${links.project.id}/${asset.id}"}} --><!-- wp:xb/text {"uid":"markuplink02","content":"Scarica"} /--><!-- /wp:xb/element -->`);
      const thirdDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-remote-media-links-"));
      ROOTS.push(thirdDirectory);
      for (const [declared, accepted] of [[["histos-transfer-markup-v1"], false], [["histos-transfer-markup-v1", "histos-media-links-v1"], true]] as const) {
        currentProjectId = null;
        markup = [...declared];
        const linkRemotes = new CmsRemoteCatalog(await mkdtemp(path.join(thirdDirectory, "r-")));
        try {
          const linked = await connectRemoteSite(code, linkRemotes, secretStoreFor);
          const planning = createRemoteSyncPlan({ action: "push", connectionId: linked.id, projectId: links.project.id }, linkRemotes, projects, secretStoreFor);
          if (!accepted) {
            await expect(planning).rejects.toMatchObject({ code: "cms-remote-markup-unavailable", message: expect.stringContaining("link ai file dei media") });
            expect(importRequests).toBe(2);
          } else {
            await expect(applyRemoteSyncPlan({ connectionId: linked.id, planId: (await planning).planId! }, linkRemotes, projects, secretStoreFor)).resolves.toMatchObject({ action: "push", complete: true });
            expect(importRequests).toBe(3);
          }
        } finally {
          linkRemotes.close();
        }
      }
      // Doc 23 item 189: `url.path` (a menu's active item) needs a site that reads histos-url-path-v1.
      const menu = await projects.createProject("Voce attiva");
      menu.store.close();
      await save(menu.project.id, `<!-- wp:xb/if {"uid":"markupurl01"} --><!-- wp:xb/branch {"uid":"markupurl02","test":"url.path == \\u0022/festival/\\u0022"} --><!-- wp:xb/text {"uid":"markupurl03","content":"Il festival"} /--><!-- /wp:xb/branch --><!-- /wp:xb/if -->`);
      for (const [declared, accepted] of [[["histos-transfer-markup-v1", "histos-media-links-v1"], false], [["histos-transfer-markup-v1", "histos-media-links-v1", "histos-url-path-v1"], true]] as const) {
        currentProjectId = null;
        markup = [...declared];
        const menuRemotes = new CmsRemoteCatalog(await mkdtemp(path.join(thirdDirectory, "u-")));
        try {
          const linked = await connectRemoteSite(code, menuRemotes, secretStoreFor);
          const planning = createRemoteSyncPlan({ action: "push", connectionId: linked.id, projectId: menu.project.id }, menuRemotes, projects, secretStoreFor);
          if (!accepted) {
            await expect(planning).rejects.toMatchObject({ code: "cms-remote-markup-unavailable", message: expect.stringContaining("url.path") });
            expect(importRequests).toBe(3);
          } else {
            await expect(applyRemoteSyncPlan({ connectionId: linked.id, planId: (await planning).planId! }, menuRemotes, projects, secretStoreFor)).resolves.toMatchObject({ action: "push", complete: true });
            expect(importRequests).toBe(4);
          }
        } finally {
          menuRemotes.close();
        }
      }
      // Doc 23 item 187: a loop grouping a query's result needs a site that reads histos-loop-group-v1.
      const grouped = await projects.createProject("Archivio per anno");
      grouped.store.close();
      await save(grouped.project.id, `<!-- wp:xb/loop {"uid":"markupgrp01","source":{"kind":"preset","id":"main","groupBy":{"field":"date","how":"Y"}},"as":"anno"} --><!-- wp:xb/text {"uid":"markupgrp02","content":"{anno.key}"} /--><!-- /wp:xb/loop -->`);
      for (const [declared, accepted] of [[["histos-transfer-markup-v1", "histos-media-links-v1", "histos-url-path-v1"], false], [["histos-transfer-markup-v1", "histos-media-links-v1", "histos-url-path-v1", "histos-loop-group-v1"], true]] as const) {
        currentProjectId = null;
        markup = [...declared];
        const groupRemotes = new CmsRemoteCatalog(await mkdtemp(path.join(thirdDirectory, "g-")));
        try {
          const linked = await connectRemoteSite(code, groupRemotes, secretStoreFor);
          const planning = createRemoteSyncPlan({ action: "push", connectionId: linked.id, projectId: grouped.project.id }, groupRemotes, projects, secretStoreFor);
          if (!accepted) {
            await expect(planning).rejects.toMatchObject({ code: "cms-remote-markup-unavailable", message: expect.stringContaining("groupBy") });
            expect(importRequests).toBe(4);
          } else {
            await expect(applyRemoteSyncPlan({ connectionId: linked.id, planId: (await planning).planId! }, groupRemotes, projects, secretStoreFor)).resolves.toMatchObject({ action: "push", complete: true });
            expect(importRequests).toBe(5);
          }
        } finally {
          groupRemotes.close();
        }
      }
      // A drawing with text and a gradient needs a site that reads histos-svg-text-v1; an icon of the older subset does not.
      const drawn = await projects.createProject("Disegno con testo");
      drawn.store.close();
      await save(drawn.project.id, `<!-- wp:xb/element {"uid":"markupsvt01","tag":"svg","attributes":{"viewBox":"0 0 40 12"}} --><!-- wp:xb/element {"uid":"markupsvt02","tag":"defs"} --><!-- wp:xb/element {"uid":"markupsvt03","tag":"linearGradient","attributes":{"id":"sfumatura"}} --><!-- wp:xb/element {"uid":"markupsvt04","tag":"stop","attributes":{"offset":"0","stop-color":"#16224a"}} /--><!-- /wp:xb/element --><!-- /wp:xb/element --><!-- wp:xb/element {"uid":"markupsvt05","tag":"rect","attributes":{"width":"40","height":"12","fill":"url(#sfumatura)"}} /--><!-- wp:xb/element {"uid":"markupsvt06","tag":"text","attributes":{"x":"20","y":"9"}} --><!-- wp:xb/text {"uid":"markupsvt07","content":"Qui"} /--><!-- /wp:xb/element --><!-- /wp:xb/element -->`);
      const older = ["histos-transfer-markup-v1", "histos-media-links-v1", "histos-url-path-v1", "histos-loop-group-v1"];
      for (const [declared, accepted] of [[older, false], [[...older, "histos-svg-text-v1"], true]] as const) {
        currentProjectId = null;
        markup = [...declared];
        const drawnRemotes = new CmsRemoteCatalog(await mkdtemp(path.join(thirdDirectory, "s-")));
        try {
          const linked = await connectRemoteSite(code, drawnRemotes, secretStoreFor);
          const planning = createRemoteSyncPlan({ action: "push", connectionId: linked.id, projectId: drawn.project.id }, drawnRemotes, projects, secretStoreFor);
          if (!accepted) {
            await expect(planning).rejects.toMatchObject({ code: "cms-remote-markup-unavailable", message: expect.stringContaining("<text>") });
            expect(importRequests).toBe(5);
          } else {
            await expect(applyRemoteSyncPlan({ connectionId: linked.id, planId: (await planning).planId! }, drawnRemotes, projects, secretStoreFor)).resolves.toMatchObject({ action: "push", complete: true });
            expect(importRequests).toBe(6);
          }
        } finally {
          drawnRemotes.close();
        }
      }
    } finally {
      upgradedRemotes.close();
    }
  });

  it("verifies HMAC, downloads a WP profile, edits locally and sends an update with common bases", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-remote-test-"));
    ROOTS.push(dataDirectory);
    const fixture = JSON.parse(
      readFileSync(new URL("../../histos-contract/test/fixtures/histos-static-page-v1.json", import.meta.url), "utf8"),
    ) as { profile: StaticPageProfile; files: Record<string, string> };
    const files = new Map(Object.entries(fixture.files).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]));
    const archive = await encodeStaticPageProfileArchive(fixture.profile, files);
    const secret = Buffer.from("8f1fb6e6bdcaa0538bb7bd27c67e2bc89ce71b8d65c57c013c8520d82b0437a4", "hex");
    let latestProfile = fixture.profile;
    let currentRemoteSiteId = SITE_ID;
    let signedRequests = 0;
    let canWrite = true;
    let reportHeadsValid = true;
    let reportPendingValid = true;
    let includeUnsubmittedHead = false;
    let dropNextImportResponse = false;
    let oversizeNextImportResponse = false;
    let failNextStatusCheck = false;
    let reportedAction: "import" | "publish" | null = null;
    let statusOperation: Record<string, unknown> | null = null;
    let latestOperationId: string | null = null;
    const submittedActions: string[] = [];

    const remote = createServer((request, response) => {
      void (async () => {
        const body = await readBody(request);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const route = url.searchParams.get("rest_route") ?? "";
        const time = request.headers["x-histos-time"] ?? "";
        const nonce = request.headers["x-histos-nonce"] ?? "";
        const supplied = request.headers["x-histos-signature"] ?? "";
        const bodyHash = createHash("sha256").update(body).digest("hex");
        const expected = createHmac("sha256", secret)
          .update(`${request.method}\n${route}\n${time}\n${nonce}\n${bodyHash}`)
          .digest("hex");
        if (
          typeof supplied !== "string" ||
          supplied !== expected ||
          !/^\d{9,11}$/u.test(String(time)) ||
          !/^[0-9a-f]{32}$/u.test(String(nonce))
        ) {
          response.writeHead(401).end("signature failed");
          return;
        }
        signedRequests += 1;
        if (route === "/xb/v1/cms/v1/capabilities") {
          json(response, {
            contractVersion: 2,
            profile: "histos-static-page-v1",
            siteId: currentRemoteSiteId,
            projectId: fixture.profile.manifest.project.id,
            projectName: fixture.profile.manifest.project.name,
            capabilities: {
              read: true,
              write: canWrite,
              publish: true,
              profiles: ["histos-static-page-v1", "histos-static-project-v1"],
            },
          });
          return;
        }
        if (route === "/xb/v1/cms/v1/export" && request.method === "GET") {
          response
            .writeHead(200, { "Content-Type": "application/zip", "Content-Length": String(archive.byteLength) })
            .end(archive);
          return;
        }
        if (
          (route === "/xb/v1/cms/v1/import" || route === "/xb/v1/cms/v1/publish") &&
          request.method === "POST"
        ) {
          const decoded = await decodeStaticPageArchive(body);
          const publishing = route.endsWith("/publish");
          const prepared = { profile: decoded.profile, files: decoded.files };
          latestProfile = prepared.profile;
          latestOperationId = decoded.profile.manifest.selection.snapshot;
          submittedActions.push(publishing ? "publish" : "push");
          const heads = Object.fromEntries(latestProfile.entities.map((entity) => [entity.id, entity.revisionHash]));
          if (!reportHeadsValid) heads[decoded.profile.entities[0]!.id] = "0".repeat(64);
          if (includeUnsubmittedHead) heads["550e8400-e29b-41d4-a716-446655440155"] = "e".repeat(64);
          const report = {
            complete: true,
            action: publishing ? "publish" : "import",
            published: publishing,
            project: { id: decoded.profile.manifest.project.id },
            heads,
            changed: Object.keys(heads),
            pending: reportPendingValid ? [] : [{ id: "not-a-uuid", reason: "later" }],
            unchanged: [],
            operationId: decoded.profile.manifest.selection.snapshot,
          };
          statusOperation = {
            ...report,
            state: "complete",
            action: reportedAction ?? (publishing ? "publish" : "import"),
            projectId: decoded.profile.manifest.project.id,
          };
          reportedAction = null;
          if (dropNextImportResponse) {
            dropNextImportResponse = false;
            response.destroy();
            return;
          }
          if (oversizeNextImportResponse) {
            oversizeNextImportResponse = false;
            json(response, { ...report, padding: "x".repeat(4 * 1024 * 1024 + 1) });
            return;
          }
          json(response, report);
          return;
        }
        const statusMatch = /^\/xb\/v1\/cms\/v1\/status\/([0-9a-f-]{36})$/u.exec(route);
        if (statusMatch && request.method === "GET" && statusOperation?.operationId === statusMatch[1]) {
          if (failNextStatusCheck) {
            failNextStatusCheck = false;
            response.writeHead(503).end("temporary status failure");
            return;
          }
          json(response, statusOperation);
          return;
        }
        response.writeHead(404).end("missing");
      })().catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : "error");
      });
    });
    await new Promise<void>((resolve, reject) => {
      remote.once("error", reject);
      remote.listen(0, "127.0.0.1", () => resolve());
    });
    SERVERS.push(remote);
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("Remote test server did not start.");
    const remoteBaseUrl = `http://127.0.0.1:${address.port}`;
    const pairingCode = (url: string) => `histos-cms-1:${Buffer.from(JSON.stringify({ url, secret: secret.toString("base64url"), scopes: { read: true, write: true, publish: true } })).toString("base64url")}`;
    const code = pairingCode(remoteBaseUrl);
    const secrets = new Map<string, string>();
    const secretStoreFor = (account: string) => ({
      get: async () => secrets.get(account) ?? null,
      set: async (value: string) => {
        secrets.set(account, value);
      },
      delete: async () => {
        secrets.delete(account);
      },
    });
    let remoteCatalog = new CmsRemoteCatalog(dataDirectory);
    const projects = new CmsProjectCatalog(dataDirectory);
    await projects.initialize();

    try {
      const provisionConnectionId = wordpressProvisionConnectionId(randomUUID());
      let connection = await connectRemoteSite(code, remoteCatalog, secretStoreFor, provisionConnectionId);
      expect(connection).toMatchObject({
        siteId: SITE_ID,
        projectId: fixture.profile.manifest.project.id,
        read: true,
        write: true,
        publish: true,
      });
      expect(JSON.stringify(connection)).not.toContain(secret.toString("hex"));
      expect(secrets.size).toBe(1);
      const recoveredConnection = await connectRemoteSite(code, remoteCatalog, secretStoreFor, provisionConnectionId);
      expect(recoveredConnection.id).toBe(connection.id);
      expect(remoteCatalog.list()).toHaveLength(1);

      const movedUrl = `${remoteBaseUrl}/nuovo-indirizzo`;
      connection = await connectRemoteSite(pairingCode(movedUrl), remoteCatalog, secretStoreFor, provisionConnectionId);
      expect(connection).toMatchObject({ id: provisionConnectionId, siteId: SITE_ID, url: movedUrl });
      expect(remoteCatalog.list()).toHaveLength(1);

      currentRemoteSiteId = randomUUID();
      await expect(connectRemoteSite(pairingCode(`${remoteBaseUrl}/altro-sito`), remoteCatalog, secretStoreFor, provisionConnectionId))
        .rejects.toMatchObject({ code: "cms-remote-connection-id-conflict" });
      expect(remoteCatalog.get(provisionConnectionId)?.url).toBe(movedUrl);
      expect(secrets.get(`cms-remote-${provisionConnectionId}`)).toBe(secret.toString("base64url"));
      currentRemoteSiteId = SITE_ID;

      const pulled = await syncRemoteSite({ action: "pull" }, connection, remoteCatalog, projects, secretStoreFor);
      expect(pulled).toMatchObject({
        action: "pull",
        complete: true,
        project: { id: fixture.profile.manifest.project.id },
      });
      const opened = await projects.openProject(fixture.profile.manifest.project.id);
      if (!opened) throw new Error("Remote profile did not create a project.");
      const page = opened.store.listPages()[0]!;
      const head = opened.store.getHead(page.id)!;
      const edited = head.content.replace("Histeon", "Histeon locale");
      const saved = opened.store.saveDocument({ entityId: page.id, expectedHead: head.id, content: edited });
      expect(saved.status).toBe("saved");
      opened.store.updatePageMetadata(page.id, { title: page.title, slug: page.slug, status: "published" });
      const component = opened.store.createComponent({
        ref: "ui/card",
        title: "Scheda riutilizzabile",
        content: '<!-- wp:xb/text {"uid":"cardtext01","content":"Scheda condivisa"} /-->',
        schema: { props: { title: { type: "string", default: "Scheda" } } },
      });
      const withComponent = opened.store.getHead(page.id)!;
      const pageWithComponent = opened.store.saveDocument({
        entityId: page.id,
        expectedHead: withComponent.id,
        content: `${withComponent.content}\n<!-- wp:xb/component {"uid":"cardref0001","ref":"ui/card"} /-->`,
      });
      expect(pageWithComponent.status).toBe("saved");
      const localDraft = opened.store.createPage({
        title: "Bozza distinta",
        slug: "bozza-distinta",
        content: "",
        status: "draft",
      });
      opened.store.close();

      canWrite = false;
      await expect(
        syncRemoteSite(
          { action: "push", projectId: fixture.profile.manifest.project.id },
          remoteCatalog.get(connection.id)!,
          remoteCatalog,
          projects,
          secretStoreFor,
        ),
      ).rejects.toMatchObject({ code: "cms-remote-write-scope-required" });
      expect(submittedActions).toEqual([]);
      canWrite = true;
      const pushed = await syncRemoteSite(
        { action: "push", projectId: fixture.profile.manifest.project.id },
        remoteCatalog.get(connection.id)!,
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(pushed).toMatchObject({ action: "push", complete: true });
      const pushedReport = pushed.report as Record<string, unknown>;
      const operationId = String(pushedReport.operationId);
      const previousArchive = remoteCatalog.getOperationPreviousArchive(connection.id, operationId);
      expect(previousArchive).toBeInstanceOf(Buffer);
      const previousProfile = await decodeStaticPageArchive(previousArchive!);
      expect(previousProfile.profile.entities.find((entity) => entity.id === page.id)?.payload.content)
        .toBe(fixture.profile.entities.find((entity) => entity.id === page.id)?.payload.content);
      expect(previousProfile.profile.entities.find((entity) => entity.id === page.id)?.payload.content).not.toContain("cardref0001");
      const compensationArchive = await buildCompensatingArchive(previousArchive!, latestProfile);
      const restoredProfile = await decodeStaticPageArchive(compensationArchive);
      expect(restoredProfile.profile.entities.find((entity) => entity.id === page.id)?.payload.content)
        .toBe(fixture.profile.entities.find((entity) => entity.id === page.id)?.payload.content);
      expect(restoredProfile.profile.entities.find((entity) => entity.id === component.id)).toMatchObject({ kind: "tombstone" });
      expect(latestProfile.manifest.profile).toBe("histos-static-project-v1");
      expect(latestProfile.entities.find((entity) => entity.id === component.id)).toMatchObject({
        kind: "component",
        payload: { ref: "ui/card", title: "Scheda riutilizzabile" },
      });
      expect(latestProfile.references).toContainEqual({
        ownerId: page.id,
        blockUid: "cardref0001",
        path: "attrs.ref",
        targetId: component.id,
        role: "document",
      });
      expect(
        latestProfile.entities
          .filter((entity) => entity.kind === "document")
          .map((entity) => [entity.id, entity.payload.status]),
      ).toEqual(
        expect.arrayContaining([
          [page.id, "published"],
          [localDraft.id, "draft"],
        ]),
      );
      const sourceAfterDraftPush = await projects.openProject(fixture.profile.manifest.project.id);
      if (!sourceAfterDraftPush) throw new Error("Il progetto CMS locale non si è riaperto dopo l’invio come bozza.");
      expect(sourceAfterDraftPush.store.listPages().find((item) => item.id === page.id)?.status).toBe("published");
      sourceAfterDraftPush.store.close();
      const pushedPageHash = latestProfile.entities.find((entity) => entity.id === page.id)?.revisionHash;
      expect(submittedActions).toEqual(["push"]);
      const published = await syncRemoteSite(
        { action: "publish", projectId: fixture.profile.manifest.project.id },
        remoteCatalog.get(connection.id)!,
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(published).toMatchObject({ action: "publish", complete: true });
      expect(
        latestProfile.entities
          .filter((entity) => entity.kind === "document")
          .map((entity) => [entity.id, entity.payload.status]),
      ).toEqual(
        expect.arrayContaining([
          [page.id, "published"],
          [localDraft.id, "draft"],
        ]),
      );
      expect(submittedActions).toEqual(["push", "publish"]);
      const synced = await projects.openProject(fixture.profile.manifest.project.id);
      if (!synced) throw new Error("Local project did not reopen after push.");
      const base = synced.store.getSyncBase(SITE_ID, page.id);
      const sent = latestProfile.entities.find((entity) => entity.id === page.id);
      expect(sent?.baseHash).toBe(pushedPageHash);
      expect(base?.baseHash).toBe(sent?.revisionHash);
      const commonBase = base?.baseHash;
      const latestHead = synced.store.getHead(page.id)!;
      const nextEdit = synced.store.saveDocument({
        entityId: page.id,
        expectedHead: latestHead.id,
        content: `${latestHead.content}<!-- wp:xb/text {"uid":"f00ba123","content":"next"} /-->`,
      });
      expect(nextEdit.status).toBe("saved");
      reportHeadsValid = false;
      await expect(
        syncRemoteSite(
          { action: "push", projectId: fixture.profile.manifest.project.id },
          remoteCatalog.get(connection.id)!,
          remoteCatalog,
          projects,
          secretStoreFor,
        ),
      ).rejects.toMatchObject({ code: "cms-remote-heads-invalid" });
      expect(synced.store.getSyncBase(SITE_ID, page.id)?.baseHash).toBe(commonBase);
      reportHeadsValid = true;

      // What WordPress keeps for its next release must be listed in the contract's terms, or nothing advances.
      reportPendingValid = false;
      await expect(
        syncRemoteSite(
          { action: "push", projectId: fixture.profile.manifest.project.id },
          remoteCatalog.get(connection.id)!,
          remoteCatalog,
          projects,
          secretStoreFor,
        ),
      ).rejects.toMatchObject({ code: "cms-remote-report-invalid" });
      expect(synced.store.getSyncBase(SITE_ID, page.id)?.baseHash).toBe(commonBase);
      reportPendingValid = true;

      // WordPress can preserve another Histeon entity that the local project
      // does not send. Its extra head must not turn a confirmed import into an
      // error or be added to this project's local sync bases.
      includeUnsubmittedHead = true;
      dropNextImportResponse = true;
      const recovered = await syncRemoteSite(
        { action: "push", projectId: fixture.profile.manifest.project.id },
        remoteCatalog.get(connection.id)!,
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(recovered).toMatchObject({
        action: "push",
        complete: true,
        report: { action: "import", published: false },
      });
      const recoveredBase = synced.store.getSyncBase(SITE_ID, page.id)?.baseHash;
      expect(recoveredBase).toBe(latestProfile.entities.find((entity) => entity.id === page.id)?.revisionHash);

      // A report too large to read came after the send: the operation is checked, never recorded as failed.
      oversizeNextImportResponse = true;
      const oversized = await syncRemoteSite(
        { action: "push", projectId: fixture.profile.manifest.project.id },
        remoteCatalog.get(connection.id)!,
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(oversized).toMatchObject({ action: "push", complete: true });
      expect(remoteCatalog.getOperation(connection.id, latestOperationId!)?.state).not.toBe("failed");

      const postRecoveryHead = synced.store.getHead(page.id)!;
      const laterEdit = synced.store.saveDocument({
        entityId: page.id,
        expectedHead: postRecoveryHead.id,
        content: `${postRecoveryHead.content}<!-- wp:xb/text {"uid":"f00ba124","content":"later edit"} /-->`,
      });
      expect(laterEdit.status).toBe("saved");
      dropNextImportResponse = true;
      failNextStatusCheck = true;
      await expect(
        syncRemoteSite(
          { action: "push", projectId: fixture.profile.manifest.project.id },
          remoteCatalog.get(connection.id)!,
          remoteCatalog,
          projects,
          secretStoreFor,
        ),
      ).rejects.toMatchObject({ code: "cms-remote-operation-uncertain" });
      expect(synced.store.getSyncBase(SITE_ID, page.id)?.baseHash).toBe(recoveredBase);
      expect(latestOperationId).toBeTruthy();
      expect(remoteCatalog.getOperation(connection.id, latestOperationId!)?.state).toBe("pending");
      synced.store.close();
      remoteCatalog.close();
      remoteCatalog = new CmsRemoteCatalog(dataDirectory);
      const operation = remoteCatalog.getOperation(connection.id, latestOperationId!);
      if (!operation) throw new Error("The pending remote operation was not restored from SQLite.");
      expect(operation).toMatchObject({
        state: "pending",
        action: "push",
        projectId: fixture.profile.manifest.project.id,
      });
      const recoveredAfterRestart = await checkRemoteOperation(
        { connectionId: connection.id, operationId: latestOperationId! },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(recoveredAfterRestart).toMatchObject({
        state: "complete",
        advancedBases: Object.keys(operation.expectedHeads).length,
        localChanges: 0,
      });
      const afterRestart = await projects.openProject(fixture.profile.manifest.project.id);
      if (!afterRestart) throw new Error("The project could not reopen after remote operation recovery.");
      expect(afterRestart.store.getSyncBase(SITE_ID, page.id)?.baseHash).toBe(
        latestProfile.entities.find((entity) => entity.id === page.id)?.revisionHash,
      );
      expect(afterRestart.store.getSyncBase(SITE_ID, "550e8400-e29b-41d4-a716-446655440155")).toBeNull();
      afterRestart.store.close();
      expect(submittedActions).toEqual(["push", "publish", "push", "push", "push", "push", "push"]);
      expect(signedRequests).toBeGreaterThanOrEqual(5);
    } finally {
      remoteCatalog.close();
    }
  });

  it("pulls, edits, and pushes the relational v3 profile without losing references or private CMS data", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-remote-v3-test-"));
    ROOTS.push(dataDirectory);
    const fixture = JSON.parse(
      readFileSync(
        new URL("../../histos-contract/test/fixtures/histos-static-project-v3.json", import.meta.url),
        "utf8",
      ),
    ) as { profile: StaticPageProfile; files: Record<string, string> };
    const archive = await encodeStaticPageProfileArchive(
      fixture.profile,
      new Map(Object.entries(fixture.files).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")])),
    );
    const secret = Buffer.from("8f1fb6e6bdcaa0538bb7bd27c67e2bc89ce71b8d65c57c013c8520d82b0437a4", "hex");
    const eventId = "550e8400-e29b-41d4-a716-446655440108";
    const speakerId = "550e8400-e29b-41d4-a716-446655440107";
    const siteId = "c7f66b89-81c2-4e34-9513-c4f1886decc3";
    let latestProfile = fixture.profile;
    let latestArchive = archive;
    let latestFiles = new Map(
      Object.entries(fixture.files).map(([name, bytes]) => [name, Buffer.from(bytes, "base64")]),
    );

    const exportModes: Array<string | string[] | undefined> = [];
    const remote = createServer((request, response) => {
      void (async () => {
        const body = await readBody(request);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const route = url.searchParams.get("rest_route") ?? "";
        const time = String(request.headers["x-histos-time"] ?? "");
        const nonce = String(request.headers["x-histos-nonce"] ?? "");
        const supplied = String(request.headers["x-histos-signature"] ?? "");
        const bodyHash = createHash("sha256").update(body).digest("hex");
        const expected = createHmac("sha256", secret)
          .update(`${request.method}\n${route}\n${time}\n${nonce}\n${bodyHash}`)
          .digest("hex");
        if (supplied !== expected || !/^\d{9,11}$/u.test(time) || !/^[0-9a-f]{32}$/u.test(nonce)) {
          response.writeHead(401).end("signature failed");
          return;
        }
        if (route === "/xb/v1/cms/v1/capabilities") {
          json(response, {
            contractVersion: 2,
            profile: "histos-static-page-v1",
            siteId,
            projectId: fixture.profile.manifest.project.id,
            projectName: fixture.profile.manifest.project.name,
            capabilities: {
              read: true,
              write: true,
              publish: false,
              profiles: [
                "histos-static-page-v1",
                "histos-static-project-v1",
                "histos-static-project-v2",
                "histos-static-project-v3",
              ],
            },
          });
          return;
        }
        if (route === "/xb/v1/cms/v1/export" && request.method === "GET") {
          exportModes.push(request.headers["x-histos-export"]);
          response
            .writeHead(200, { "Content-Type": "application/zip", "Content-Length": String(latestArchive.byteLength) })
            .end(latestArchive);
          return;
        }
        if (route === "/xb/v1/cms/v1/import" && request.method === "POST") {
          const decoded = await decodeStaticPageArchive(body);
          const rebased = advanceRemoteBases(decoded.profile, decoded.files);
          latestProfile = rebased.profile;
          latestFiles = rebased.files;
          latestArchive = await encodeStaticPageProfileArchive(latestProfile, rebased.files);
          const heads = Object.fromEntries(decoded.profile.entities.map((entity) => [entity.id, entity.revisionHash]));
          json(response, {
            complete: true,
            action: "import",
            published: false,
            project: { id: decoded.profile.manifest.project.id },
            heads,
            changed: Object.keys(heads),
            pending: [],
            unchanged: [],
            operationId: decoded.profile.manifest.selection.snapshot,
          });
          return;
        }
        response.writeHead(404).end("missing");
      })().catch((error: unknown) => {
        response
          .writeHead(500, { "Content-Type": "application/json" })
          .end(JSON.stringify({ message: error instanceof Error ? error.message : "error" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      remote.once("error", reject);
      remote.listen(0, "127.0.0.1", () => resolve());
    });
    SERVERS.push(remote);
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("Remote v3 test server did not start.");
    const code = `histos-cms-1:${Buffer.from(JSON.stringify({ url: `http://127.0.0.1:${address.port}`, secret: secret.toString("base64url"), scopes: { read: true, write: true, publish: false } })).toString("base64url")}`;
    const secrets = new Map<string, string>();
    const secretStoreFor = (account: string) => ({
      get: async () => secrets.get(account) ?? null,
      set: async (value: string) => {
        secrets.set(account, value);
      },
      delete: async () => {
        secrets.delete(account);
      },
    });
    const remoteCatalog = new CmsRemoteCatalog(dataDirectory);
    const projects = new CmsProjectCatalog(dataDirectory);
    await projects.initialize();

    try {
      const connection = await connectRemoteSite(code, remoteCatalog, secretStoreFor);
      expect(connection).toMatchObject({
        siteId,
        projectId: fixture.profile.manifest.project.id,
        read: true,
        write: true,
        publish: false,
      });
      // A local project the site was never synchronized with is not a pull target, whatever id the site names.
      const isolatedRoot = `${dataDirectory}/isolated`;
      const isolatedProjects = new CmsProjectCatalog(isolatedRoot);
      await isolatedProjects.initialize();
      const isolatedRemotes = new CmsRemoteCatalog(isolatedRoot);
      const isolatedConnection = await connectRemoteSite(code, isolatedRemotes, secretStoreFor);
      const unrelated = await isolatedProjects.createProject("Progetto locale estraneo", { id: fixture.profile.manifest.project.id });
      unrelated.store.close();
      await expect(createRemoteSyncPlan({ action: "pull", connectionId: isolatedConnection.id }, isolatedRemotes, isolatedProjects, secretStoreFor))
        .rejects.toMatchObject({ code: "cms-remote-project-unbound" });
      isolatedRemotes.close();

      const pullPlan = await createRemoteSyncPlan(
        { action: "pull", connectionId: connection.id },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(exportModes.at(-1)).toBe("read"); // A check leaves WordPress as it was.
      expect(pullPlan).toMatchObject({ action: "pull", applyAllowed: true, counts: { conflict: 0 } });
      expect(pullPlan.destination).toMatchObject({ id: `wordpress:${connection.id}`, kind: "wordpress-existing", transport: "histos-remote", publicUrl: connection.url });
      expect(pullPlan.rollback).toMatchObject({ status: "unavailable", estimatedBytes: 0 });
      expect(pullPlan.rollback.note).toContain("Il download aggiorna il progetto locale ma non modifica WordPress");
      expect(pullPlan.rollback.note).not.toContain("Plugin e hook possono essere eseguiti di nuovo durante il ripristino");
      expect(pullPlan.counts.new).toBeGreaterThan(0);
      const pulled = await applyRemoteSyncPlan(
        { connectionId: connection.id, planId: pullPlan.planId! },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(pulled).toMatchObject({ action: "pull", complete: true });
      expect(exportModes.at(-1)).toBeUndefined(); // The download itself adopts what it reads.
      const opened = await projects.openProject(fixture.profile.manifest.project.id);
      if (!opened) throw new Error("The relational v3 profile did not create a local project.");
      const record = opened.store.content.getRecordById(eventId, true);
      expect(record).toMatchObject({
        title: "Incontro portabile",
        values: { speaker: { id: speakerId, title: "Ada Relatrice" }, private_note: "Non esportare nel frontend" },
      });
      expect(record?.terms["event-category"]?.map((term) => term.id)).toContain("550e8400-e29b-41d4-a716-446655440106");
      if (!record) throw new Error("Relational event record is missing after pull.");
      const relation = record.values.speaker as { id: string };
      const terms = Object.fromEntries(
        Object.entries(record.terms).map(([key, entries]) => [key, entries.map((term) => term.alias)]),
      );
      const saved = opened.store.content.saveRecord({
        id: record.id,
        typeKey: record.typeKey,
        title: "Incontro aggiornato",
        slug: record.slug,
        locale: record.locale,
        status: record.status,
        publishedAt: record.publishedAt,
        excerpt: record.excerpt,
        order: record.order,
        values: { ...record.values, speaker: relation.id, starts_at: "2026-11-15T10:00:00+01:00" },
        terms,
        expectedHead: record.headRevision,
      });
      expect(saved.status).toBe("saved");
      opened.store.close();

      const pushPlan = await createRemoteSyncPlan(
        { action: "push", connectionId: connection.id, projectId: fixture.profile.manifest.project.id },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(pushPlan).toMatchObject({ action: "push", applyAllowed: true, counts: { conflict: 0 } });
      expect(pushPlan.rollback.note).toContain("Plugin e hook possono essere eseguiti di nuovo durante il ripristino");
      expect(pushPlan.rollback.note).toContain("Il backup WordPress non esiste ancora");
      expect(pushPlan.rollback.note).toContain("revisioni Histeon sul sito corrispondono ancora");
      expect(pushPlan.rollback.note).toContain("email e chiamate API già partite non si possono annullare");
      expect(pushPlan.rollback.note).toContain("Prova prima su staging");
      expect(pushPlan.counts.update).toBeGreaterThan(0);
      const pushed = await applyRemoteSyncPlan(
        { connectionId: connection.id, planId: pushPlan.planId! },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(pushed).toMatchObject({ action: "push", complete: true });
      expect(latestProfile.manifest.profile).toBe("histos-static-project-v3");
      const remoteEvent = latestProfile.entities.find((entity) => entity.id === eventId);
      expect(remoteEvent?.payload).toMatchObject({
        title: "Incontro aggiornato",
        status: "published",
        values: {
          starts_at: "2026-11-15T10:00:00+01:00",
          speaker: speakerId,
          private_note: "Non esportare nel frontend",
        },
        terms: { "event-category": ["550e8400-e29b-41d4-a716-446655440106"] },
      });
      expect(latestProfile.entities.find((entity) => entity.id === speakerId)?.payload.title).toBe("Ada Relatrice");
      expect(latestProfile.entities.some((entity) => entity.id === eventId && entity.kind === "content-record")).toBe(
        true,
      );
      expect(
        latestProfile.entities.some(
          (entity) => entity.id === "550e8400-e29b-41d4-a716-446655440112" && entity.kind === "template",
        ),
      ).toBe(true);
      expect(latestProfile.entities.find((entity) => entity.id === speakerId)?.payload.status).toBe("published");
      const localAfterPush = await projects.openProject(fixture.profile.manifest.project.id);
      if (!localAfterPush) throw new Error("Il progetto locale v3 non si è riaperto dopo l’invio.");
      expect(localAfterPush.store.content.getRecordById(eventId, true)?.status).toBe("published");
      expect(localAfterPush.store.content.getRecordById(speakerId, true)?.status).toBe("published");
      localAfterPush.store.close();
      const repeatedPushPlan = await createRemoteSyncPlan(
        { action: "push", connectionId: connection.id, projectId: fixture.profile.manifest.project.id },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(repeatedPushPlan).toMatchObject({ applyAllowed: true, counts: { update: 0, conflict: 0 } });
      expect(repeatedPushPlan.counts.unchanged).toBeGreaterThan(0);

      const sharedPage = latestProfile.entities.find((entity) => entity.kind === "document");
      if (!sharedPage) throw new Error("The mock remote profile has no page to edit.");
      const remoteEdit = latestProfile.entities.map((entity) => {
        if (entity.id !== sharedPage.id) return entity;
        const payload = { ...entity.payload, title: "Titolo modificato in WordPress" };
        return {
          ...entity,
          payload,
          revisionHash: createHash("sha256")
            .update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, payload))
            .digest("hex"),
        };
      });
      const editedRemote = rewriteProfileEntities(latestProfile, latestFiles, remoteEdit);
      latestProfile = editedRemote.profile;
      latestFiles = editedRemote.files;
      latestArchive = await encodeStaticPageProfileArchive(latestProfile, latestFiles);
      const remoteChanges = await createRemoteSyncPlan(
        { action: "pull", connectionId: connection.id },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(remoteChanges).toMatchObject({ applyAllowed: true, counts: { update: 1, conflict: 0 } });
      await applyRemoteSyncPlan(
        { connectionId: connection.id, planId: remoteChanges.planId! },
        remoteCatalog,
        projects,
        secretStoreFor,
      );

      const nextRemoteEdit = latestProfile.entities.map((entity) => {
        if (entity.id !== sharedPage.id) return entity;
        const payload = { ...entity.payload, title: "Seconda modifica WordPress" };
        return {
          ...entity,
          payload,
          revisionHash: createHash("sha256")
            .update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, payload))
            .digest("hex"),
        };
      });
      const twiceEditedRemote = rewriteProfileEntities(latestProfile, latestFiles, nextRemoteEdit);
      latestProfile = twiceEditedRemote.profile;
      latestFiles = twiceEditedRemote.files;
      latestArchive = await encodeStaticPageProfileArchive(latestProfile, latestFiles);
      const nextRemoteChanges = await createRemoteSyncPlan(
        { action: "pull", connectionId: connection.id },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(nextRemoteChanges).toMatchObject({ applyAllowed: true, counts: { update: 1, conflict: 0 } });
      await applyRemoteSyncPlan(
        { connectionId: connection.id, planId: nextRemoteChanges.planId! },
        remoteCatalog,
        projects,
        secretStoreFor,
      );

      const afterRemotePull = await projects.openProject(fixture.profile.manifest.project.id);
      if (!afterRemotePull) throw new Error("The local project did not reopen after the remote edit.");
      const localPage = afterRemotePull.store.listPages().find((item) => item.id === sharedPage.id);
      if (!localPage) throw new Error("The synchronized page is missing locally.");
      afterRemotePull.store.updatePageMetadata(localPage.id, {
        title: "Titolo modificato in locale",
        slug: localPage.slug,
        status: localPage.status,
      });
      afterRemotePull.store.close();
      const localChanges = await createRemoteSyncPlan(
        { action: "push", connectionId: connection.id, projectId: fixture.profile.manifest.project.id },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(localChanges).toMatchObject({ applyAllowed: true, counts: { update: 1, conflict: 0 } });
      await applyRemoteSyncPlan(
        { connectionId: connection.id, planId: localChanges.planId! },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(latestProfile.entities.find((entity) => entity.id === sharedPage.id)?.payload.title).toBe(
        "Titolo modificato in locale",
      );

      const beforePlan = await projects.openProject(fixture.profile.manifest.project.id);
      if (!beforePlan) throw new Error("The relational project did not reopen for plan review.");
      const beforePlanRecord = beforePlan.store.content.getRecordById(eventId, true)!;
      const beforePlanValues = {
        ...beforePlanRecord.values,
        speaker: (beforePlanRecord.values.speaker as { id: string }).id,
      };
      const prePlanEdit = beforePlan.store.content.saveRecord({
        id: eventId,
        typeKey: beforePlanRecord.typeKey,
        title: "Modifica prima del piano",
        slug: beforePlanRecord.slug,
        locale: beforePlanRecord.locale,
        status: beforePlanRecord.status,
        publishedAt: beforePlanRecord.publishedAt,
        excerpt: beforePlanRecord.excerpt,
        order: beforePlanRecord.order,
        values: beforePlanValues,
        terms: Object.fromEntries(
          Object.entries(beforePlanRecord.terms).map(([key, entries]) => [key, entries.map((term) => term.alias)]),
        ),
        expectedHead: beforePlanRecord.headRevision,
      });
      expect(prePlanEdit.status).toBe("saved");
      beforePlan.store.close();
      const stalePlan = await createRemoteSyncPlan(
        { action: "push", connectionId: connection.id, projectId: fixture.profile.manifest.project.id },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(stalePlan.applyAllowed).toBe(true);
      const afterPlan = await projects.openProject(fixture.profile.manifest.project.id);
      if (!afterPlan) throw new Error("The relational project did not reopen after plan review.");
      const afterPlanRecord = afterPlan.store.content.getRecordById(eventId, true)!;
      const afterPlanValues = {
        ...afterPlanRecord.values,
        speaker: (afterPlanRecord.values.speaker as { id: string }).id,
      };
      const concurrentEdit = afterPlan.store.content.saveRecord({
        id: eventId,
        typeKey: afterPlanRecord.typeKey,
        title: "Modifica concorrente dopo il piano",
        slug: afterPlanRecord.slug,
        locale: afterPlanRecord.locale,
        status: afterPlanRecord.status,
        publishedAt: afterPlanRecord.publishedAt,
        excerpt: afterPlanRecord.excerpt,
        order: afterPlanRecord.order,
        values: afterPlanValues,
        terms: Object.fromEntries(
          Object.entries(afterPlanRecord.terms).map(([key, entries]) => [key, entries.map((term) => term.alias)]),
        ),
        expectedHead: afterPlanRecord.headRevision,
      });
      expect(concurrentEdit.status).toBe("saved");
      afterPlan.store.close();
      await expect(
        applyRemoteSyncPlan(
          { connectionId: connection.id, planId: stalePlan.planId! },
          remoteCatalog,
          projects,
          secretStoreFor,
        ),
      ).rejects.toMatchObject({ code: "cms-sync-plan-stale" });
      expect(latestProfile.entities.find((entity) => entity.id === eventId)?.payload.title).toBe("Incontro aggiornato");
      const postStaleRecovery = await createRemoteSyncPlan(
        { action: "push", connectionId: connection.id, projectId: fixture.profile.manifest.project.id },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(postStaleRecovery).toMatchObject({ applyAllowed: true, counts: { update: 1, conflict: 0 } });
      await applyRemoteSyncPlan(
        { connectionId: connection.id, planId: postStaleRecovery.planId! },
        remoteCatalog,
        projects,
        secretStoreFor,
      );

      const remoteConflictEntities = latestProfile.entities.map((entity) => {
        if (entity.id !== sharedPage.id) return entity;
        const payload = { ...entity.payload, title: "Titolo remoto in conflitto" };
        return {
          ...entity,
          payload,
          revisionHash: createHash("sha256")
            .update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, payload))
            .digest("hex"),
        };
      });
      const firstConflictProfile = rewriteProfileEntities(latestProfile, latestFiles, remoteConflictEntities);
      latestProfile = firstConflictProfile.profile;
      latestFiles = firstConflictProfile.files;
      latestArchive = await encodeStaticPageProfileArchive(latestProfile, latestFiles);
      const beforeChoice = await projects.openProject(fixture.profile.manifest.project.id);
      if (!beforeChoice) throw new Error("Il progetto locale non si riapre prima della scelta del conflitto.");
      const conflictPage = beforeChoice.store.listPages().find((item) => item.id === sharedPage.id);
      if (!conflictPage) throw new Error("La pagina del conflitto non esiste localmente.");
      beforeChoice.store.updatePageMetadata(conflictPage.id, {
        title: "Titolo locale in conflitto",
        slug: conflictPage.slug,
        status: conflictPage.status,
      });
      beforeChoice.store.close();

      const conflictPlan = await createRemoteSyncPlan(
        { action: "pull", connectionId: connection.id },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(conflictPlan).toMatchObject({ planId: expect.any(String), applyAllowed: false, counts: { conflict: 1 } });
      expect(conflictPlan.entities.find((entity) => entity.id === sharedPage.id)).toMatchObject({
        status: "conflict",
        canResolve: true,
        comparison: [{ field: "title", local: "Titolo locale in conflitto", remote: "Titolo remoto in conflitto" }],
        omittedComparisonFields: 0,
      });
      await expect(
        applyRemoteSyncPlan(
          { connectionId: connection.id, planId: conflictPlan.planId! },
          remoteCatalog,
          projects,
          secretStoreFor,
        ),
      ).rejects.toMatchObject({ code: "cms-sync-resolution-required" });
      const keepLocalResult = await applyRemoteSyncPlan(
        { connectionId: connection.id, planId: conflictPlan.planId!, resolutions: { [sharedPage.id]: "keep-local" } },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(keepLocalResult).toMatchObject({ keptLocal: [sharedPage.id] });
      const keptLocal = await projects.openProject(fixture.profile.manifest.project.id);
      if (!keptLocal) throw new Error("Il progetto non si riapre dopo aver mantenuto la versione locale.");
      expect(keptLocal.store.listPages().find((item) => item.id === sharedPage.id)?.title).toBe(
        "Titolo locale in conflitto",
      );
      keptLocal.store.close();
      const afterKeepPlan = await createRemoteSyncPlan(
        { action: "push", connectionId: connection.id, projectId: fixture.profile.manifest.project.id },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(afterKeepPlan).toMatchObject({ applyAllowed: true, counts: { update: 1, conflict: 0 } });
      await applyRemoteSyncPlan(
        { connectionId: connection.id, planId: afterKeepPlan.planId! },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(latestProfile.entities.find((entity) => entity.id === sharedPage.id)?.payload.title).toBe(
        "Titolo locale in conflitto",
      );

      const nextRemoteConflictEntities = latestProfile.entities.map((entity) => {
        if (entity.id !== sharedPage.id) return entity;
        const payload = { ...entity.payload, title: "Versione remota scelta" };
        return {
          ...entity,
          payload,
          revisionHash: createHash("sha256")
            .update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, payload))
            .digest("hex"),
        };
      });
      const nextConflictProfile = rewriteProfileEntities(latestProfile, latestFiles, nextRemoteConflictEntities);
      latestProfile = nextConflictProfile.profile;
      latestFiles = nextConflictProfile.files;
      latestArchive = await encodeStaticPageProfileArchive(latestProfile, latestFiles);
      const beforeRemoteChoice = await projects.openProject(fixture.profile.manifest.project.id);
      if (!beforeRemoteChoice)
        throw new Error("Il progetto locale non si riapre prima della scelta della versione remota.");
      const pageBeforeRemoteChoice = beforeRemoteChoice.store.listPages().find((item) => item.id === sharedPage.id);
      if (!pageBeforeRemoteChoice) throw new Error("La pagina da sostituire non esiste localmente.");
      beforeRemoteChoice.store.updatePageMetadata(pageBeforeRemoteChoice.id, {
        title: "Versione locale scartata",
        slug: pageBeforeRemoteChoice.slug,
        status: pageBeforeRemoteChoice.status,
      });
      beforeRemoteChoice.store.close();
      const useRemotePlan = await createRemoteSyncPlan(
        { action: "pull", connectionId: connection.id },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(useRemotePlan).toMatchObject({ applyAllowed: false, counts: { conflict: 1 } });
      const useRemoteResult = await applyRemoteSyncPlan(
        { connectionId: connection.id, planId: useRemotePlan.planId!, resolutions: { [sharedPage.id]: "use-remote" } },
        remoteCatalog,
        projects,
        secretStoreFor,
      );
      expect(useRemoteResult).toMatchObject({ changed: expect.arrayContaining([sharedPage.id]), keptLocal: [] });
      const adoptedRemote = await projects.openProject(fixture.profile.manifest.project.id);
      if (!adoptedRemote) throw new Error("Il progetto non si riapre dopo aver scelto la versione remota.");
      expect(adoptedRemote.store.listPages().find((item) => item.id === sharedPage.id)?.title).toBe(
        "Versione remota scelta",
      );
      adoptedRemote.store.close();
    } finally {
      remoteCatalog.close();
    }
  });

  it("migrates the saved retry archive column without treating legacy partial restores as retryable", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-cms-remote-journal-migrate-"));
    ROOTS.push(dataDirectory);
    const database = new DatabaseSync(path.join(dataDirectory, "histos-cms-catalog.sqlite"));
    database.exec(`CREATE TABLE remote_operations (
      operation_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, project_id TEXT NOT NULL, action TEXT NOT NULL,
      state TEXT NOT NULL, expected_heads TEXT NOT NULL, archive_hash TEXT NOT NULL, previous_archive BLOB,
      result_heads TEXT, rollback_of_operation_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, message TEXT
    );
    INSERT INTO remote_operations VALUES (
      '9e74e404-5052-43ea-9dc2-949aebaa0952', '81a40f20-eb9a-4aa3-9bc5-617364b9715b',
      '7e3be180-623f-4d88-9d79-48566b8f0d03', 'push', 'partial', '{}', '${"a".repeat(64)}',
      X'01', NULL, '63e85b08-9e4d-45e3-9e5c-80d88fb1d92d', '2026-10-25T00:00:00.000Z', '2026-10-25T00:01:00.000Z', 'partial'
    );`);
    database.close();

    const catalog = new CmsRemoteCatalog(dataDirectory);
    try {
      expect(catalog.getOperationRequestArchive("81a40f20-eb9a-4aa3-9bc5-617364b9715b", "9e74e404-5052-43ea-9dc2-949aebaa0952")).toBeNull();
      expect(catalog.getOperation("81a40f20-eb9a-4aa3-9bc5-617364b9715b", "9e74e404-5052-43ea-9dc2-949aebaa0952")).toMatchObject({
        state: "partial",
        rollbackRetryAvailable: false,
      });
    } finally {
      catalog.close();
    }
  });
});
