import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "@histos-publish/cms";
import { HistosPublishError } from "@histos-publish/core";
import { CmsRemoteCatalog, type CmsSyncPlan, type CmsSyncPlanEntity } from "../src/cms-remote.js";
import { ConnectorWordPress, WORDPRESS_PLANS_PER_HOUR, type ConnectorPushView, type ConnectorWordPressDeps, type ConnectorWordPressMode } from "../src/connector-wordpress.js";

/**
 * The connector's WordPress gate (docs/progettazione/histos-cms/16-connettore-ai.md §2.6) with a real remote catalog
 * and fake plan/apply functions: nothing here talks to a site, so every call the gate makes is visible.
 */

function thrown(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error("Nessun errore.");
}

type CreatePlan = NonNullable<ConnectorWordPressDeps["createPlan"]>;
type ApplyPlan = NonNullable<ConnectorWordPressDeps["applyPlan"]>;

interface PlanShape {
  action?: CmsSyncPlan["action"];
  projectId?: string;
  connectionId?: string;
  applyAllowed?: boolean;
  initializingRemote?: boolean;
  counts?: Partial<CmsSyncPlan["counts"]>;
  entities?: CmsSyncPlanEntity[];
  omittedEntities?: number;
  expiresInMs?: number;
}

describe("ConnectorWordPress", () => {
  let dataDirectory: string;
  let remote: CmsRemoteCatalog;
  let projects: CmsProjectCatalog;
  let modes: Map<string, ConnectorWordPressMode>;
  let active: boolean;
  let clock: number;
  let planCalls: Array<Parameters<CreatePlan>[0]>;
  let planIds: string[];
  let applyCalls: Array<Parameters<ApplyPlan>[0]>;
  let nextPlan: PlanShape;
  let events: ConnectorPushView[];
  const projectId = "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10";

  function connect(options: { projectId?: string | null; write?: boolean; host?: string } = {}): string {
    const id = randomUUID();
    remote.add({
      id,
      url: `https://${options.host ?? "wp.example.test"}`,
      siteId: randomUUID(),
      projectId: options.projectId === undefined ? projectId : options.projectId,
      projectName: "Galleria",
      profile: "histos-static-project-v4",
      read: true,
      write: options.write ?? true,
      publish: false,
    });
    return id;
  }

  const createPlan: CreatePlan = async (input, catalog) => {
    planCalls.push(structuredClone(input));
    const shape = nextPlan;
    const pendingProject = shape.projectId ?? input.projectId ?? projectId;
    const expiresAt = clock + (shape.expiresInMs ?? 600_000);
    // createRemoteSyncPlan saves the plan in the remote catalog and returns its id; so does the fake.
    const planId = catalog.saveSyncPlan({ connectionId: input.connectionId, action: shape.action ?? input.action, projectId: pendingProject, remoteFingerprint: "remoto", localFingerprint: "locale", resolvableConflictIds: [], expiresAt: Date.now() + 600_000 });
    planIds.push(planId);
    const counts = { new: 1, update: 1, delete: 0, unchanged: 2, "local-only": 0, "remote-only": 0, conflict: 0, ...shape.counts };
    return {
      schemaVersion: 1,
      planId,
      action: shape.action ?? input.action,
      connectionId: shape.connectionId ?? input.connectionId,
      project: { id: pendingProject, name: "Galleria‮" },
      profile: "histos-static-project-v4",
      initializingRemote: shape.initializingRemote ?? false,
      expiresAt: new Date(expiresAt).toISOString(),
      applyAllowed: shape.applyAllowed ?? true,
      counts,
      entities: shape.entities ?? [
        { id: randomUUID(), kind: "page", label: "Home", status: "update", canResolve: false },
        { id: randomUUID(), kind: "page", label: "Contatti", status: "new", canResolve: false },
        { id: randomUUID(), kind: "styles", label: "Stili", status: "unchanged", canResolve: false },
      ],
      omittedEntities: shape.omittedEntities ?? 0,
    } as unknown as CmsSyncPlan;
  };

  const applyPlan: ApplyPlan = async (input) => {
    applyCalls.push(structuredClone(input));
    return { complete: true, report: { operationId: "operazione-1", pending: [] } };
  };

  function gate(overrides: Partial<ConnectorWordPressDeps> = {}): ConnectorWordPress {
    return new ConnectorWordPress({
      remoteCatalog: remote,
      projects,
      secretStoreFor: () => ({ get: async () => null, set: async () => undefined, delete: async () => undefined }),
      mode: (connectionId) => modes.get(connectionId) ?? "off",
      active: () => active,
      createPlan,
      applyPlan,
      onEvent: (view) => events.push(view),
      now: () => clock,
      ...overrides,
    });
  }

  const push = (wordpress: ConnectorWordPress, connectionId: string, dryRun = false) => wordpress.push({ projectId, connectionId, dryRun, client: "agente di prova" });

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-connector-wp-"));
    remote = new CmsRemoteCatalog(dataDirectory);
    projects = new CmsProjectCatalog(dataDirectory);
    modes = new Map();
    active = true;
    clock = Date.now();
    planCalls = [];
    planIds = [];
    applyCalls = [];
    nextPlan = {};
    events = [];
  });

  afterEach(async () => {
    remote.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  it("con il permesso spento risponde 403 senza preparare nessun piano", async () => {
    const connectionId = connect();
    const wordpress = gate();
    await expect(push(wordpress, connectionId)).rejects.toMatchObject({ code: "connector-wordpress-off", exitCode: 403 });
    await expect(push(wordpress, connectionId, true)).rejects.toMatchObject({ code: "connector-wordpress-off", exitCode: 403 });
    expect(planCalls).toEqual([]);
    expect(wordpress.connections()).toEqual([{ connectionId, host: "wp.example.test", projectId, projectName: "Galleria", canWrite: true, mode: "off" }]);
  });

  it("con «solo prove» fa l'invio di prova e rifiuta quello vero prima di preparare un piano (voce 203)", async () => {
    const connectionId = connect();
    modes.set(connectionId, "dry-run");
    const wordpress = gate();
    expect(await push(wordpress, connectionId, true)).toMatchObject({ state: "dry-run", counts: { new: 1, update: 1 } });
    expect(planCalls).toHaveLength(1);
    expect(remote.getSyncPlan(planIds[0] as string)).toBeNull();
    // The real send: refused on the server, whatever the agent passes, with no plan, no rate slot, nothing to approve.
    await expect(push(wordpress, connectionId)).rejects.toMatchObject({ code: "connector-wordpress-dry-run-only", exitCode: 403 });
    expect(planCalls).toHaveLength(1);
    expect(applyCalls).toEqual([]);
    expect(wordpress.approvals()).toEqual([]);
    expect(events).toEqual([]);
    expect(wordpress.connections()).toEqual([expect.objectContaining({ connectionId, mode: "dry-run" })]);
    // The limit of plans counts only the dry runs.
    for (let index = 1; index < WORDPRESS_PLANS_PER_HOUR; index += 1) await push(wordpress, connectionId, true);
    await expect(push(wordpress, connectionId, true)).rejects.toMatchObject({ code: "connector-rate-limited" });
  });

  it("una richiesta in attesa passata a «solo prove» non si applica più (voce 203)", async () => {
    const connectionId = connect();
    modes.set(connectionId, "confirm");
    const wordpress = gate();
    const waiting = await push(wordpress, connectionId);
    expect(waiting).toMatchObject({ state: "pending" });
    modes.set(connectionId, "dry-run");
    expect(wordpress.decide(waiting.requestId as string, "approve")).toMatchObject({ state: "rejected", error: { code: "connector-wordpress-off" } });
    expect(applyCalls).toEqual([]);
    for (const planId of planIds) expect(remote.getSyncPlan(planId)).toBeNull();
  });

  it("rifiuta l'inizializzazione, un altro progetto e un collegamento senza scrittura senza contattare il sito", async () => {
    const initializing = connect({ projectId: null });
    const otherProject = connect({ projectId: randomUUID() });
    const readOnly = connect({ write: false });
    for (const id of [initializing, otherProject, readOnly]) modes.set(id, "auto");
    const wordpress = gate();
    await expect(push(wordpress, initializing)).rejects.toMatchObject({ code: "connector-wordpress-initializing", exitCode: 409 });
    await expect(push(wordpress, otherProject)).rejects.toMatchObject({ code: "connector-wordpress-project-mismatch", exitCode: 409 });
    await expect(push(wordpress, readOnly)).rejects.toMatchObject({ code: "cms-remote-write-scope-required", exitCode: 403 });
    await expect(push(wordpress, randomUUID())).rejects.toMatchObject({ code: "cms-remote-connection-missing", exitCode: 404 });
    expect(planCalls).toEqual([]);
    expect(applyCalls).toEqual([]);
  });

  it("chiede sempre e solo un piano push e non mostra mai l'id del piano all'agente", async () => {
    const confirm = connect();
    const auto = connect({ host: "auto.example.test" });
    modes.set(confirm, "confirm");
    modes.set(auto, "auto");
    const wordpress = gate();
    const results = [await push(wordpress, confirm, true), await push(wordpress, confirm), await push(wordpress, auto)];
    expect(planCalls).toEqual([
      { action: "push", connectionId: confirm, projectId },
      { action: "push", connectionId: confirm, projectId },
      { action: "push", connectionId: auto, projectId },
    ]);
    for (const result of results) for (const planId of planIds) expect(JSON.stringify(result)).not.toContain(planId);
    // Text from WordPress is shown without bidi controls.
    expect(results[1]).toMatchObject({ state: "pending", project: { id: projectId, name: "Galleria" } });
  });

  it("dryRun mostra i cambiamenti e scarta subito il piano", async () => {
    const connectionId = connect();
    modes.set(connectionId, "confirm");
    const wordpress = gate();
    const result = await push(wordpress, connectionId, true);
    expect(result).toEqual({
      state: "dry-run",
      counts: { new: 1, update: 1, delete: 0, unchanged: 2, "local-only": 0, "remote-only": 0, conflict: 0 },
      entities: [{ kind: "page", label: "Home", status: "update" }, { kind: "page", label: "Contatti", status: "new" }],
      omitted: 0,
      replacesMedia: false,
    });
    expect(remote.getSyncPlan(planIds[0] as string)).toBeNull();
    expect(wordpress.approvals()).toEqual([]);
    expect(applyCalls).toEqual([]);
  });

  it("con la conferma resta in attesa, poi applica il piano approvato con il progetto atteso e nessuna risoluzione", async () => {
    const connectionId = connect();
    modes.set(connectionId, "confirm");
    const wordpress = gate();
    const pending = await push(wordpress, connectionId);
    expect(pending).toMatchObject({ state: "pending", host: "wp.example.test", client: "agente di prova", counts: { new: 1, update: 1, delete: 0 }, message: expect.stringContaining("hp_wordpress_push_status") });
    const requestId = pending.requestId as string;
    expect(wordpress.approvals().map((item) => item.requestId)).toEqual([requestId]);
    expect(applyCalls).toEqual([]);
    expect(events.map((item) => item.state)).toEqual(["pending"]);

    const waiting = wordpress.status(requestId, 5);
    const decided = wordpress.decide(requestId, "approve");
    expect(["applying", "applied"]).toContain(decided.state);
    const final = await waiting;
    expect(final).toMatchObject({ requestId, state: "applied", result: { operationId: "operazione-1", complete: true, waitingForRelease: 0 } });
    expect(applyCalls).toEqual([{ connectionId, planId: planIds[0], expectedProjectId: projectId, resolutions: {} }]);
    expect(remote.getSyncPlan(planIds[0] as string)).toBeNull();
    expect(wordpress.approvals()).toEqual([]);
    expect(events.map((item) => item.state)).toEqual(["pending", "applied"]);
    expect(thrown(() => wordpress.decide(requestId, "approve"))).toMatchObject({ code: "connector-approval-missing" });
  });

  it("un rifiuto scarta il piano senza applicarlo", async () => {
    const connectionId = connect();
    modes.set(connectionId, "confirm");
    const wordpress = gate();
    const pending = await push(wordpress, connectionId);
    const rejected = wordpress.decide(pending.requestId as string, "reject");
    expect(rejected).toMatchObject({ state: "rejected", error: { code: "connector-wordpress-rejected" } });
    expect(await wordpress.status(pending.requestId as string, 0)).toMatchObject({ state: "rejected" });
    expect(remote.getSyncPlan(planIds[0] as string)).toBeNull();
    expect(applyCalls).toEqual([]);
    expect(thrown(() => wordpress.decide(pending.requestId as string, "approve"))).toMatchObject({ code: "connector-approval-missing" });
  });

  it("una richiesta non approvata in tempo scade con il suo piano", async () => {
    const connectionId = connect();
    modes.set(connectionId, "confirm");
    nextPlan = { expiresInMs: 60_000 };
    const wordpress = gate();
    const pending = await push(wordpress, connectionId);
    clock += 60_001;
    expect(wordpress.approvals()).toEqual([]);
    expect(await wordpress.status(pending.requestId as string, 0)).toMatchObject({ state: "expired", error: { code: "connector-wordpress-expired" } });
    expect(remote.getSyncPlan(planIds[0] as string)).toBeNull();
    expect(thrown(() => wordpress.decide(pending.requestId as string, "approve"))).toMatchObject({ code: "connector-approval-missing" });
    expect(applyCalls).toEqual([]);
  });

  it("senza chiedere applica subito, ma una rimozione aspetta sempre l'utente", async () => {
    const connectionId = connect();
    modes.set(connectionId, "auto");
    const wordpress = gate();
    expect(await push(wordpress, connectionId)).toMatchObject({ state: "applied", result: { complete: true } });
    expect(applyCalls).toHaveLength(1);

    nextPlan = { counts: { delete: 1 } };
    const withDeletion = await push(wordpress, connectionId);
    expect(withDeletion).toMatchObject({ state: "pending", counts: { delete: 1 } });
    expect(applyCalls).toHaveLength(1);
    expect(wordpress.approvals().map((item) => item.requestId)).toEqual([withDeletion.requestId]);
  });

  it("riconsulta permesso e connettore prima di applicare un piano approvato", async () => {
    const connectionId = connect();
    modes.set(connectionId, "confirm");
    const wordpress = gate();
    const first = await push(wordpress, connectionId);
    modes.set(connectionId, "off");
    expect(wordpress.decide(first.requestId as string, "approve")).toMatchObject({ state: "rejected", error: { code: "connector-wordpress-off" } });
    modes.set(connectionId, "confirm");
    const second = await push(wordpress, connectionId);
    active = false;
    expect(wordpress.decide(second.requestId as string, "approve")).toMatchObject({ state: "rejected", error: { code: "connector-wordpress-off" } });
    expect(applyCalls).toEqual([]);
    for (const planId of planIds) expect(remote.getSyncPlan(planId)).toBeNull();
  });

  it("un piano con conflitti non è applicabile e viene scartato", async () => {
    const connectionId = connect();
    modes.set(connectionId, "auto");
    nextPlan = {
      applyAllowed: false,
      counts: { conflict: 1 },
      entities: [{ id: randomUUID(), kind: "page", label: "Contatti​", status: "conflict", canResolve: true }, { id: randomUUID(), kind: "page", label: "Home", status: "update", canResolve: false }],
    };
    const wordpress = gate();
    const result = await push(wordpress, connectionId);
    expect(result).toMatchObject({ state: "not-applicable", conflicts: [{ kind: "page", label: "Contatti" }] });
    expect(remote.getSyncPlan(planIds[0] as string)).toBeNull();
    expect(applyCalls).toEqual([]);
    expect(wordpress.approvals()).toEqual([]);
  });

  it("scarta un piano che non corrisponde alla richiesta", async () => {
    const connectionId = connect();
    modes.set(connectionId, "auto");
    const wordpress = gate();
    for (const shape of [{ action: "publish" as const }, { initializingRemote: true }, { projectId: randomUUID() }, { connectionId: randomUUID() }]) {
      nextPlan = shape;
      await expect(push(wordpress, connectionId)).rejects.toMatchObject({ code: "connector-wordpress-plan-invalid" });
    }
    for (const planId of planIds) expect(remote.getSyncPlan(planId)).toBeNull();
    expect(applyCalls).toEqual([]);
  });

  it("tiene al massimo due richieste aperte e una nuova richiesta per lo stesso sito sostituisce quella in attesa", async () => {
    const [first, second, third] = [connect({ host: "uno.example.test" }), connect({ host: "due.example.test" }), connect({ host: "tre.example.test" })] as [string, string, string];
    for (const id of [first, second, third]) modes.set(id, "confirm");
    const wordpress = gate();
    const one = await push(wordpress, first);
    await push(wordpress, second);
    await expect(push(wordpress, third)).rejects.toMatchObject({ code: "connector-wordpress-busy", exitCode: 429 });
    expect(planCalls).toHaveLength(2);

    const replacement = await push(wordpress, first);
    expect(await wordpress.status(one.requestId as string, 0)).toMatchObject({ state: "expired", error: { code: "connector-wordpress-superseded" } });
    expect(remote.getSyncPlan(planIds[0] as string)).toBeNull();
    expect(remote.getSyncPlan(planIds[2] as string)).not.toBeNull();
    const waiting = wordpress.approvals();
    expect(waiting.map((item) => item.host).sort()).toEqual(["due.example.test", "uno.example.test"]);
    expect(waiting.map((item) => item.requestId)).toContain(replacement.requestId);
  });

  it("prepara al massimo sei piani all'ora", async () => {
    const connectionId = connect();
    modes.set(connectionId, "confirm");
    const wordpress = gate();
    for (let index = 0; index < WORDPRESS_PLANS_PER_HOUR; index++) await push(wordpress, connectionId, true);
    await expect(push(wordpress, connectionId, true)).rejects.toMatchObject({ code: "connector-rate-limited", exitCode: 429 });
    expect(planCalls).toHaveLength(WORDPRESS_PLANS_PER_HOUR);
    clock += 3_600_001;
    expect(await push(wordpress, connectionId, true)).toMatchObject({ state: "dry-run" });
  });

  it("non tocca mai un piano preparato dall'utente nell'app per lo stesso collegamento", async () => {
    const connectionId = connect();
    const other = connect({ host: "altro.example.test" });
    modes.set(connectionId, "confirm");
    modes.set(other, "confirm");
    const uiPlan = remote.saveSyncPlan({ connectionId, action: "publish", projectId, remoteFingerprint: "remoto", localFingerprint: "locale", resolvableConflictIds: [], expiresAt: Date.now() + 600_000 });
    const wordpress = gate();
    // Dry run, superseded request, rejection, approval, conflicts, expiry and a stop: six plans, the hourly cap.
    await push(wordpress, connectionId, true);
    await push(wordpress, connectionId);
    const rejected = await push(wordpress, connectionId);
    wordpress.decide(rejected.requestId as string, "reject");
    const approved = await push(wordpress, connectionId);
    wordpress.decide(approved.requestId as string, "approve");
    expect(await wordpress.status(approved.requestId as string, 5)).toMatchObject({ state: "applied" });
    nextPlan = { applyAllowed: false, counts: { conflict: 1 }, entities: [{ id: randomUUID(), kind: "page", label: "Home", status: "conflict", canResolve: true }] };
    expect(await push(wordpress, connectionId)).toMatchObject({ state: "not-applicable" });
    nextPlan = { expiresInMs: 1_000 };
    await push(wordpress, other);
    clock += 1_001;
    expect(wordpress.approvals()).toEqual([]);
    wordpress.discardAll("Il connettore è stato fermato.");
    expect(planCalls).toHaveLength(6);
    expect(applyCalls.map((call) => call.planId)).not.toContain(uiPlan);
    expect(remote.getSyncPlan(uiPlan)).toMatchObject({ connectionId, action: "publish", projectId });
    for (const planId of planIds) expect(remote.getSyncPlan(planId)).toBeNull();
  });

  it("allo stop rifiuta le richieste in attesa e ne scarta i piani", async () => {
    const connectionId = connect();
    modes.set(connectionId, "confirm");
    const wordpress = gate();
    const pending = await push(wordpress, connectionId);
    wordpress.discardAll("Il connettore è stato fermato.");
    expect(await wordpress.status(pending.requestId as string, 0)).toMatchObject({ state: "rejected", error: { code: "connector-stopped" } });
    expect(remote.getSyncPlan(planIds[0] as string)).toBeNull();
    expect(applyCalls).toEqual([]);
  });

  it.each<[ConnectorWordPressMode, "Interrompi" | "Ferma"]>([
    ["auto", "Interrompi"],
    ["confirm", "Interrompi"],
    ["auto", "Ferma"],
    ["confirm", "Ferma"],
  ])("in modalità %s, «%s» mentre il piano si prepara lo scarta senza registrare né applicare nulla", async (mode, how) => {
    const connectionId = connect();
    modes.set(connectionId, mode);
    let planned!: () => void;
    const planning = new Promise<void>((resolve) => {
      planned = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // createRemoteSyncPlan saves the plan before it returns: the slow part comes after, as when WordPress is slow.
    const slowPlan: CreatePlan = async (...args) => {
      const plan = await createPlan(...args);
      planned();
      await released;
      return plan;
    };
    const wordpress = gate({ createPlan: slowPlan });
    const controller = new AbortController();
    const work = wordpress.push({ projectId, connectionId, dryRun: false, client: "agente di prova" }, controller.signal);
    work.catch(() => undefined);
    await planning;
    if (how === "Interrompi") controller.abort();
    else active = false;
    release();
    await expect(work).rejects.toMatchObject({ code: "connector-cancelled", exitCode: 499 });
    expect(planIds).toHaveLength(1);
    expect(remote.getSyncPlan(planIds[0] as string)).toBeNull();
    expect(wordpress.approvals()).toEqual([]);
    expect(applyCalls).toEqual([]);
    expect(events).toEqual([]);

    // Nothing was left behind: the next send for the same site goes through as usual.
    active = true;
    const next = await push(wordpress, connectionId);
    expect(next).toMatchObject({ state: mode === "auto" ? "applied" : "pending" });
    expect(applyCalls.map((call) => call.planId)).toEqual(mode === "auto" ? [planIds[1]] : []);
  });

  it("un dry run, un piano con conflitti o un piano fallito lasciano approvabile la richiesta in attesa", async () => {
    const [first, second, third] = [connect({ host: "uno.example.test" }), connect({ host: "due.example.test" }), connect({ host: "tre.example.test" })] as [string, string, string];
    for (const id of [first, second, third]) modes.set(id, "confirm");
    let failPlan = false;
    const wordpress = gate({
      createPlan: async (...args) => {
        if (!failPlan) return createPlan(...args);
        planCalls.push(structuredClone(args[0]));
        throw new HistosPublishError("WordPress non risponde.", "cms-remote-unreachable", 502);
      },
    });
    const waiting = await push(wordpress, first);
    const other = await push(wordpress, second);
    // Two requests are open: the one waiting for the same site does not count, so the agent may still look at it.
    expect(await push(wordpress, first, true)).toMatchObject({ state: "dry-run" });
    nextPlan = { applyAllowed: false, counts: { conflict: 1 }, entities: [{ id: randomUUID(), kind: "page", label: "Home", status: "conflict", canResolve: true }] };
    expect(await push(wordpress, first)).toMatchObject({ state: "not-applicable" });
    nextPlan = {};
    failPlan = true;
    await expect(push(wordpress, first)).rejects.toMatchObject({ code: "cms-remote-unreachable" });
    failPlan = false;
    // Another site still finds the two open requests.
    await expect(push(wordpress, third)).rejects.toMatchObject({ code: "connector-wordpress-busy", exitCode: 429 });
    expect(planCalls).toHaveLength(5);

    expect(await wordpress.status(waiting.requestId as string, 0)).toMatchObject({ state: "pending" });
    expect(remote.getSyncPlan(planIds[0] as string)).not.toBeNull();
    expect(wordpress.approvals().map((item) => item.requestId).sort()).toEqual([waiting.requestId, other.requestId].sort());
    expect(events.map((item) => item.state)).toEqual(["pending", "pending"]);
    wordpress.decide(waiting.requestId as string, "approve");
    expect(await wordpress.status(waiting.requestId as string, 5)).toMatchObject({ state: "applied" });
    expect(applyCalls).toEqual([{ connectionId: first, planId: planIds[0], expectedProjectId: projectId, resolutions: {} }]);
  });

  it("un invio che sostituisce media già sul sito aspetta sempre l'utente, anche senza chiedere", async () => {
    const connectionId = connect();
    modes.set(connectionId, "auto");
    const wordpress = gate();
    nextPlan = {
      entities: [
        { id: randomUUID(), kind: "asset", label: "ehi.png", status: "update", canResolve: false },
        { id: randomUUID(), kind: "page", label: "Home", status: "update", canResolve: false },
      ],
    };
    expect(await push(wordpress, connectionId, true)).toMatchObject({ state: "dry-run", replacesMedia: true });
    const replacing = await push(wordpress, connectionId);
    expect(replacing).toMatchObject({ state: "pending", replacesMedia: true, message: expect.stringContaining("approvare") });
    expect(applyCalls).toEqual([]);
    expect(wordpress.approvals()).toEqual([expect.objectContaining({ requestId: replacing.requestId, replacesMedia: true })]);
    expect(await wordpress.status(replacing.requestId as string, 0)).toMatchObject({ state: "pending", replacesMedia: true });
    expect(events).toEqual([expect.objectContaining({ state: "pending", replacesMedia: true })]);

    // Entities beyond the plan's list cannot be ruled out: they count as media to replace.
    nextPlan = { omittedEntities: 3 };
    expect(await push(wordpress, connectionId, true)).toMatchObject({ state: "dry-run", omitted: 3, replacesMedia: true });
    const omitted = await push(wordpress, connectionId);
    expect(omitted).toMatchObject({ state: "pending", omitted: 3, replacesMedia: true });
    expect(applyCalls).toEqual([]);
    wordpress.decide(omitted.requestId as string, "approve");
    expect(await wordpress.status(omitted.requestId as string, 5)).toMatchObject({ state: "applied", replacesMedia: true });
    expect(applyCalls).toHaveLength(1);
  });

  it("senza media da sostituire replacesMedia è falso e la modalità automatica applica subito", async () => {
    const connectionId = connect();
    modes.set(connectionId, "auto");
    const wordpress = gate();
    nextPlan = {
      entities: [
        { id: randomUUID(), kind: "asset", label: "nuova.png", status: "new", canResolve: false },
        { id: randomUUID(), kind: "asset", label: "ehi.png", status: "unchanged", canResolve: false },
        { id: randomUUID(), kind: "page", label: "Home", status: "update", canResolve: false },
      ],
    };
    expect(await push(wordpress, connectionId, true)).toMatchObject({ state: "dry-run", replacesMedia: false });
    expect(await push(wordpress, connectionId)).toMatchObject({ state: "applied", replacesMedia: false });
    expect(applyCalls).toHaveLength(1);
    expect(wordpress.approvals()).toEqual([]);

    modes.set(connectionId, "confirm");
    const pending = await push(wordpress, connectionId);
    expect(pending).toMatchObject({ state: "pending", replacesMedia: false });
    expect(wordpress.approvals()).toEqual([expect.objectContaining({ replacesMedia: false })]);
  });
});
