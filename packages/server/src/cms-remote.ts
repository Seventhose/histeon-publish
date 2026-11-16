import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type CmsProjectCatalog, createTransferTombstone, decodeStaticPageArchive, encodeStaticPageProfileArchive, LOOP_GROUP_ID, MEDIA_LINKS_ID, profileUsesLoopGroup, profileUsesMediaLinks, profileUsesSvgText, profileUsesTransferMarkupV1, profileUsesUrlPath, SVG_TEXT_ID, TRANSFER_MARKUP_ID, URL_PATH_ID } from "@histos-publish/cms";
import { HistosPublishError, type DestinationPlanMetadata } from "@histos-publish/core";
import { canonicalizeJson, manifestHashInput, PRODUCT_CAPABILITY, SCRIPT_CAPABILITY, type StaticPageProfile, type TransferEntity } from "@histos-publish/histos-contract";
import type { CmsRemoteSecretStore, CmsRemoteConnection, CmsSyncAction, CmsRemoteOperationAction, CmsRemoteOperationState, CmsRemoteOperationRecord, CmsSyncConflictChoice, CmsSyncPlan, CmsRemoteCatalog } from "./cms-remote-catalog.js";
import { claimPairingCode, CmsRemoteRejectedError, PROFILE, MAX_ARCHIVE_BYTES, REMOTE_NAMESPACE, UUID, isPendingItem, parsePairingCode, requestRemote, validateCapabilities, validateEntityHeads, validateRemoteUrl } from "./cms-remote-transport.js";
import { profileFingerprint, pullFingerprint, buildInitialPushDiff, buildSyncDiff, planEntityList } from "./cms-remote-diff.js";
import { bringClosure } from "./cms-remote-bring.js";
import { histeonSiteNotice, type HisteonSiteNotice } from "./histeon-version.js";


/** Nothing is sent to a site that cannot read the project's profile: no partial transfer (docs/spec/cms-bridge.md §12). */
const REMOTE_APPLY_WAIT_MS = 30 * 60_000;
const REMOTE_APPLY_POLL_MS = 3000;
const MAX_RESUMES = 20;

export function assertRemoteSupportsProfile(profiles: string[], profile: string): void {
  if (profiles.includes(profile)) return;
  throw new HistosPublishError(
    profile === "histos-static-project-v4"
      ? "Il sito WordPress collegato non supporta articoli e ruoli dei modelli (profilo histos-static-project-v4). Aggiorna Histeon su WordPress prima dell’invio: non ho inviato nulla."
      : "Il sito WordPress collegato non supporta il profilo Histeon di questo progetto. Aggiorna il plugin WordPress prima dell’invio.",
    "cms-remote-profile-unavailable",
    422,
  );
}

/**
 * SVG, responsive images (picture/srcset), details and textarea text need a WordPress site that reads
 * histos-transfer-markup-v1; an older plugin would refuse them after part of the work. Forms and buttons do not:
 * released plugins accept them already.
 */
/** A project with products goes only to a site with WooCommerce active and a Histeon that sends them to it (queue C6). */
export function assertRemoteSupportsProducts(commerce: string[], profile: StaticPageProfile): void {
  if (commerce.includes(PRODUCT_CAPABILITY) || !profile.manifest.requiredCapabilities.includes(PRODUCT_CAPABILITY)) return;
  throw new HistosPublishError(
    "Il progetto ha dei prodotti, ma il sito WordPress collegato non ha WooCommerce attivo o ha un Histeon da aggiornare: non ho inviato nulla.",
    "cms-remote-commerce-unavailable",
    422,
  );
}

/** Doc 18 §6.6: a project whose documents have JavaScript goes only to a site that says it can store it. */
/** The oldest PHP current Histeon runs on; an older site keeps an old Histeon that may not read what Publish sends. */
export const MIN_SITE_PHP = "8.3";

/**
 * Doc 23 item 125: a site on a PHP older than Histeon needs (WP refused to update Histeon there) is told before a send,
 * with its version, instead of failing halfway. Sites that do not say their PHP (older Histeon) pass as before.
 */
export function assertRemotePhp(php: string | null): void {
  if (php === null) return;
  const [major = 0, minor = 0] = php.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [needMajor, needMinor] = MIN_SITE_PHP.split(".").map(Number) as [number, number];
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return;
  throw new HistosPublishError(
    `Il sito usa PHP ${php}: Histeon chiede PHP ${MIN_SITE_PHP} o superiore, e WP non lo aggiorna finché PHP resta questo. Aggiorna PHP dall'hosting, poi Histeon, e riprova: non ho inviato nulla.`,
    "cms-remote-php-too-old",
    422,
  );
}

export function assertRemoteSupportsScripts(scripts: string[], profile: StaticPageProfile): void {
  if (scripts.includes(SCRIPT_CAPABILITY) || !profile.manifest.requiredCapabilities.includes(SCRIPT_CAPABILITY)) return;
  throw new HistosPublishError(
    "Il progetto ha del JavaScript nelle pagine o nei componenti, ma l'utente WordPress del collegamento non può salvarlo (gli manca il permesso unfiltered_html) o Histeon su WordPress è da aggiornare: non ho inviato nulla.",
    "cms-remote-scripts-unavailable",
    422,
  );
}

export function assertRemoteSupportsMarkup(markup: string[], profile: StaticPageProfile): void {
  if (!markup.includes(MEDIA_LINKS_ID) && profileUsesMediaLinks(profile)) {
    throw new HistosPublishError(
      "Il progetto ha link ai file dei media (<a href=\"asset:…\">), che il sito WordPress collegato non sa ancora leggere: aggiorna Histeon su WordPress e riprova. Non ho inviato nulla.",
      "cms-remote-markup-unavailable",
      422,
    );
  }
  if (!markup.includes(URL_PATH_ID) && profileUsesUrlPath(profile)) {
    throw new HistosPublishError(
      "Il progetto ha espressioni con url.path (per esempio la voce attiva di un menu), che il sito WordPress collegato non sa ancora leggere: aggiorna Histeon su WordPress alla 0.5.4 o successiva e riprova. Non ho inviato nulla.",
      "cms-remote-markup-unavailable",
      422,
    );
  }
  if (!markup.includes(LOOP_GROUP_ID) && profileUsesLoopGroup(profile)) {
    throw new HistosPublishError(
      "Il progetto ha loop che raggruppano il risultato di una query (per esempio foto().groupBy(\"anno\")), che il sito WordPress collegato non sa ancora leggere: aggiorna Histeon su WordPress alla 0.5.5 o successiva e riprova. Non ho inviato nulla.",
      "cms-remote-markup-unavailable",
      422,
    );
  }
  if (!markup.includes(TRANSFER_MARKUP_ID) && profileUsesTransferMarkupV1(profile)) {
    throw new HistosPublishError(
      "Il sito WordPress collegato non supporta SVG, immagini responsive, dettagli e testo nei campi (Histeon su WordPress da aggiornare): non ho inviato nulla.",
      "cms-remote-markup-unavailable",
      422,
    );
  }
  if (!markup.includes(SVG_TEXT_ID) && profileUsesSvgText(profile)) {
    throw new HistosPublishError(
      "Il progetto ha disegni SVG con testo, sfumature, stile in linea o stati (<text>, <defs>, style, data-*), che il sito WordPress collegato non sa ancora leggere: aggiorna Histeon su WordPress alla 0.5.14 o successiva e riprova. Non ho inviato nulla.",
      "cms-remote-markup-unavailable",
      422,
    );
  }
}

export { type CmsRemoteSecretStore, type CmsRemoteConnection, type CmsSyncAction, type CmsRemoteOperationAction, type CmsRemoteOperationState, type CmsRemoteOperation, type CmsSyncPlanStatus, type CmsSyncConflictChoice, type CmsSyncFieldComparison, type CmsSyncPlanEntity, type TransferPlan, type CmsSyncPlan, CmsRemoteCatalog } from "./cms-remote-catalog.js";
export { buildSyncDiff } from "./cms-remote-diff.js";
export { HISTEON_FEATURES, HISTEON_VERSION, histeonSiteNotice, type HisteonFeature, type HisteonFeatureId, type HisteonSiteNotice } from "./histeon-version.js";

/**
 * Doc 23 item 175: what the link's screen says of the site's Histeon, from the last reading of its capabilities; null when
 * it is the known one or newer, or when this catalog has not read it yet.
 */
export function connectionHisteonNotice(connection: CmsRemoteConnection): HisteonSiteNotice | null {
  return connection.siteHisteon === undefined ? null : histeonSiteNotice(connection.siteHisteon);
}

/** Build a new profile that restores the saved preimage without overwriting later WordPress edits. */
export function buildCompensatingProfile(before: StaticPageProfile, current: StaticPageProfile): StaticPageProfile {
  if (before.manifest.project.id !== current.manifest.project.id) {
    throw new HistosPublishError("Il backup appartiene a un altro progetto Histeon.", "cms-remote-rollback-project-mismatch", 409);
  }
  const previousById = new Map(before.entities.map((entity) => [entity.id, entity]));
  const currentById = new Map(current.entities.map((entity) => [entity.id, entity]));
  const restored: TransferEntity[] = [];

  for (const previous of before.entities) {
    const live = currentById.get(previous.id);
    if (!live) {
      throw new HistosPublishError("WordPress non restituisce un’entità presente nel backup; il ripristino è stato fermato.", "cms-remote-rollback-head-missing", 409);
    }
    if (previous.kind === "tombstone") {
      if (live.kind === "tombstone" && live.revisionHash === previous.revisionHash) {
        restored.push(previous);
        continue;
      }
      if (live.kind === "tombstone") {
        throw new HistosPublishError("La cancellazione WordPress è cambiata dopo l’invio; il ripristino è stato fermato.", "cms-remote-rollback-conflict", 409);
      }
      restored.push(createTransferTombstone({ ...live, baseHash: live.revisionHash }));
      continue;
    }
    if (live.kind !== previous.kind && live.kind !== "tombstone") {
      throw new HistosPublishError("Il tipo di un’entità WordPress è cambiato dopo l’invio; il ripristino è stato fermato.", "cms-remote-rollback-conflict", 409);
    }
    restored.push({ ...previous, baseHash: live.revisionHash });
  }

  for (const live of current.entities) {
    if (previousById.has(live.id)) continue;
    if (live.kind === "tombstone") {
      throw new HistosPublishError("WordPress contiene una cancellazione non presente nel backup; il ripristino è stato fermato.", "cms-remote-rollback-conflict", 409);
    }
    try {
      restored.push(createTransferTombstone({ ...live, baseHash: live.revisionHash }));
    } catch {
      throw new HistosPublishError(
        `Il ripristino non può rimuovere in modo sicuro la nuova entità “${live.kind}”. Nessun dato è stato modificato.`,
        "cms-remote-rollback-unsupported-entity",
        409,
      );
    }
  }

  restored.sort((left, right) => left.id.localeCompare(right.id));
  const entityBytes = Buffer.from(restored.map((entity) => canonicalizeJson(entity)).join("\n") + "\n", "utf8");
  const manifestBase = {
    ...before.manifest,
    selection: { ...before.manifest.selection, snapshot: randomUUID() },
    files: before.manifest.files.map((file) => file.path === "entities.ndjson"
      ? { ...file, bytes: entityBytes.byteLength, sha256: createHash("sha256").update(entityBytes).digest("hex") }
      : file),
  };
  const manifest = {
    ...manifestBase,
    manifestHash: createHash("sha256").update(manifestHashInput(manifestBase), "utf8").digest("hex"),
  };
  return { manifest, entities: restored, references: before.references };
}

export async function buildCompensatingArchive(previousArchive: Buffer, current: StaticPageProfile): Promise<Buffer> {
  const before = await decodeStaticPageArchive(previousArchive);
  const profile = buildCompensatingProfile(before.profile, current);
  const files = new Map(before.files);
  files.delete("site.json");
  files.set("entities.ndjson", Buffer.from(profile.entities.map((entity) => canonicalizeJson(entity)).join("\n") + "\n", "utf8"));
  return encodeStaticPageProfileArchive(profile, files);
}

/** Rebase a saved compensation request onto a verified mixture of its preimage and target heads. */
async function rebaseCompensatingArchive(requestArchive: Buffer, current: StaticPageProfile): Promise<Buffer> {
  const saved = await decodeStaticPageArchive(requestArchive);
  if (saved.profile.manifest.project.id !== current.manifest.project.id) {
    throw new HistosPublishError("Il ripristino salvato appartiene a un altro progetto Histeon.", "cms-remote-rollback-project-mismatch", 409);
  }
  const currentById = new Map(current.entities.map((entity) => [entity.id, entity]));
  const savedIds = saved.profile.entities.map((entity) => entity.id).sort();
  const currentIds = [...currentById.keys()].sort();
  if (JSON.stringify(savedIds) !== JSON.stringify(currentIds)) {
    throw new HistosPublishError("WordPress contiene entità diverse dal ripristino interrotto. Nessun nuovo tentativo è stato inviato.", "cms-remote-rollback-conflict", 409);
  }
  const entities = saved.profile.entities.map((entity) => {
    const live = currentById.get(entity.id);
    if (!live) throw new HistosPublishError("Manca una revisione WordPress necessaria al ripristino.", "cms-remote-rollback-conflict", 409);
    return { ...entity, baseHash: live.revisionHash };
  });
  const entityBytes = Buffer.from(entities.map((entity) => canonicalizeJson(entity)).join("\n") + "\n", "utf8");
  const manifestBase = {
    ...saved.profile.manifest,
    selection: { ...saved.profile.manifest.selection, snapshot: randomUUID() },
    files: saved.profile.manifest.files.map((file) => file.path === "entities.ndjson"
      ? { ...file, bytes: entityBytes.byteLength, sha256: createHash("sha256").update(entityBytes).digest("hex") }
      : file),
  };
  const profile: StaticPageProfile = {
    ...saved.profile,
    manifest: { ...manifestBase, manifestHash: createHash("sha256").update(manifestHashInput(manifestBase), "utf8").digest("hex") },
    entities,
  };
  const files = new Map(saved.files);
  files.delete("site.json");
  files.set("entities.ndjson", entityBytes);
  return encodeStaticPageProfileArchive(profile, files);
}

type OpenCmsProject = NonNullable<Awaited<ReturnType<CmsProjectCatalog["openProject"]>>>;

async function alignLocalBasesAfterRemoteRollback(input: {
  original: CmsRemoteOperationRecord;
  connection: CmsRemoteConnection;
  before: StaticPageProfile;
  opened: OpenCmsProject;
  projects: CmsProjectCatalog;
}): Promise<{ localChanges: number; advancedBases: number }> {
  if (input.before.manifest.project.id !== input.original.projectId) {
    throw new HistosPublishError("Il backup non corrisponde all’invio originale.", "cms-remote-rollback-backup-invalid", 409);
  }
  const { createStaticPageProfile } = await import("@histos-publish/cms");
  const local = await createStaticPageProfile(input.opened.project, input.opened.store, undefined, input.connection.siteId);
  const localHeads = new Map(local.profile.entities.map((entity) => [entity.id, entity.revisionHash]));
  const beforeHeads = new Map(input.before.entities.map((entity) => [entity.id, entity.revisionHash]));
  let localChanges = 0;
  let advancedBases = 0;
  await input.opened.store.atomic(async () => {
    for (const entityId of Object.keys(input.original.expectedHeads)) {
      const priorHash = beforeHeads.get(entityId);
      if (localHeads.get(entityId) !== priorHash) localChanges += 1;
      if (priorHash) input.opened.store.setSyncBase(input.connection.siteId, input.original.projectId, entityId, priorHash);
      else input.opened.store.deleteSyncBase(input.connection.siteId, entityId);
      advancedBases += 1;
    }
    await input.projects.saveManifest(input.opened.project);
  });
  return { localChanges, advancedBases };
}

function uninitializedRemoteFingerprint(siteId: string): string {
  return createHash("sha256").update(`histos-remote-uninitialized-v1\n${siteId}`).digest("hex");
}

function remotePlanMetadata(connection: CmsRemoteConnection, action: CmsSyncAction): DestinationPlanMetadata {
  return {
    destination: {
      id: `wordpress:${connection.id}`,
      label: connection.projectName || new URL(connection.url).hostname,
      kind: "wordpress-existing",
      transport: "histos-remote",
      publicUrl: connection.url,
    },
    rollback: {
      status: "unavailable",
      estimatedBytes: 0,
      maxBytes: 0,
      note: action === "pull"
        ? "Il download aggiorna il progetto locale ma non modifica WordPress. Esporta un backup .histosproject prima di applicare modifiche se vuoi conservare una copia completa del progetto."
        : "Il backup WordPress non esiste ancora: viene salvato dopo un invio completato. In seguito potrai ripristinarlo dalla cronologia solo se tutte le revisioni Histeon sul sito corrispondono ancora all’esito registrato; il collegamento deve autorizzare lettura e scrittura e, per contenuti pubblicati, anche Publish. Plugin e hook possono essere eseguiti di nuovo durante il ripristino: email e chiamate API già partite non si possono annullare. Prova prima su staging e controlla i plugin attivi.",
    },
  };
}

/** What a reading of WordPress is for: only a download stores identities on the site. */
type RemoteReading = "adopt" | "read" | "linked";

async function exportRemoteProfile(
  connection: CmsRemoteConnection,
  secret: Buffer,
  capabilities: ReturnType<typeof validateCapabilities>,
  reading: RemoteReading,
): Promise<{ profile: StaticPageProfile; files: Map<string, Buffer> }> {
  const response = await requestRemote(
    connection,
    secret,
    "GET",
    `${REMOTE_NAMESPACE}/export`,
    Buffer.alloc(0),
    MAX_ARCHIVE_BYTES,
    undefined,
    reading === "adopt" ? {} : { "X-Histos-Export": reading },
  );
  if (!response.contentType.toLowerCase().startsWith("application/zip"))
    throw new HistosPublishError(
      "Il sito remoto non ha restituito un archivio .xbsite.",
      "cms-remote-export-invalid",
      422,
    );
  const decoded = await decodeStaticPageArchive(response.bytes);
  if (!capabilities.profiles.includes(decoded.profile.manifest.profile))
    throw new HistosPublishError(
      "Il sito remoto ha restituito un profilo che non ha dichiarato tra le proprie capacità.",
      "cms-remote-profile-unavailable",
      422,
    );
  if (connection.projectId && decoded.profile.manifest.project.id !== connection.projectId)
    throw new HistosPublishError(
      "Il progetto remoto è cambiato. Ricollega e controlla il catalogo prima di trasferire.",
      "cms-remote-project-changed",
      409,
    );
  return decoded;
}

/**
 * The project a connection is bound to is local knowledge, never the remote's latest claim: a capabilities answer
 * naming another project is refused, and only the first answer of an unbound connection is adopted.
 */
export function bindRemoteProject(catalog: CmsRemoteCatalog, connection: CmsRemoteConnection, capabilities: { projectId: string | null; projectName: string; histeon: string | null }, checkedAt: string): void {
  if (connection.projectId && capabilities.projectId && capabilities.projectId !== connection.projectId)
    throw new HistosPublishError(
      "Il sito WordPress ora indica un altro progetto Histeon. Ricollega il sito e controlla il catalogo prima di trasferire.",
      "cms-remote-project-changed",
      409,
    );
  catalog.updateRemote(connection.id, {
    projectId: connection.projectId ?? capabilities.projectId,
    projectName: capabilities.projectName,
    lastCheckedAt: checkedAt,
    siteHisteon: capabilities.histeon,
  });
}

/**
 * A pull may create a new local project or update the one this site was synchronized with; it never merges a
 * remote profile into another existing local project the remote happens to name.
 */
async function assertPullTarget(projects: CmsProjectCatalog, projectId: string, remoteSiteId: string): Promise<void> {
  const opened = await projects.openProject(projectId);
  if (!opened) return;
  try {
    if (!opened.store.hasSyncBases(remoteSiteId))
      throw new HistosPublishError(
        "Il sito WordPress propone di scaricare in un progetto locale che non è mai stato sincronizzato con lui. Nessun dato è stato scaricato.",
        "cms-remote-project-unbound",
        409,
      );
  } finally {
    opened.store.close();
  }
}

async function localProfile(
  projectId: string,
  remoteSiteId: string,
  projects: CmsProjectCatalog,
  knownEntityIds: string[] = [],
): Promise<{ profile: StaticPageProfile; files: Map<string, Buffer>; knownBases: Map<string, string> } | null> {
  const opened = await projects.openProject(projectId);
  if (!opened) return null;
  try {
    const { createStaticPageProfile } = await import("@histos-publish/cms");
    const profile = await createStaticPageProfile(opened.project, opened.store, undefined, remoteSiteId);
    const knownBases = new Map<string, string>();
    for (const id of knownEntityIds) {
      const base = opened.store.getSyncBase(remoteSiteId, id);
      if (base) knownBases.set(id, base.baseHash);
    }
    return { ...profile, knownBases };
  } finally {
    opened.store.close();
  }
}

export async function readStoredSecret(storeFor: (account: string) => CmsRemoteSecretStore, id: string): Promise<Buffer> {
  const stored = await storeFor(`cms-remote-${id}`).get();
  if (!stored)
    throw new HistosPublishError(
      "Il segreto del collegamento non è nel portachiavi locale. Ricollega il sito.",
      "cms-remote-secret-missing",
      401,
    );
  const secret = Buffer.from(stored, "base64url");
  if (secret.byteLength !== 32 || secret.toString("base64url") !== stored)
    throw new HistosPublishError(
      "Il segreto del collegamento nel portachiavi non è valido.",
      "cms-remote-secret-invalid",
      401,
    );
  return secret;
}

/**
 * Doc 23 item 237: pairing in one click, as OAuth's PKCE. Publish starts it for a site and keeps a verifier only it
 * knows; the WordPress page it opens shows the administrator what Publish asks, and on their confirmation makes the
 * code and keeps it under a one-time claim tied to the challenge (the verifier's SHA-256). The link back
 * (`histos-publish://collega`) carries only the claim, worthless without the verifier: no secret ever goes through
 * the system's link handler or a command line. A claim back for a pairing Publish did not start, or for another
 * site, is refused. Pairings wait ten minutes, at most five at a time, in this process only.
 */
const PAIRING_TTL_MS = 10 * 60_000;
const pendingPairings = new Map<string, { siteUrl: string; verifier: string; expires: number }>();

export function startRemotePairing(siteUrl: string, now = Date.now()): { state: string; url: string } {
  const url = validateRemoteUrl(siteUrl.trim().replace(/\/+$/u, ""));
  for (const [state, pending] of pendingPairings) if (pending.expires <= now) pendingPairings.delete(state);
  if (pendingPairings.size >= 5) throw new HistosPublishError("Ci sono già cinque abbinamenti in attesa: completane uno o aspetta qualche minuto.", "cms-pairing-busy", 429);
  const state = randomUUID();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  pendingPairings.set(state, { siteUrl: url, verifier, expires: now + PAIRING_TTL_MS });
  const admin = new URL(`${url}/wp-admin/admin.php`);
  admin.searchParams.set("page", "xb-releases");
  admin.searchParams.set("xb_pair", challenge);
  admin.searchParams.set("xb_pair_state", state);
  admin.hash = "xb-cms";
  return { state, url: admin.href };
}

/** The site a pairing waits for, to show before the claim; null when there is none (expired, or never started). */
export function pendingPairingSite(state: string, now = Date.now()): string | null {
  const pending = pendingPairings.get(state);
  return pending && pending.expires > now ? pending.siteUrl : null;
}

export async function claimRemotePairing(
  input: { state: string; claim: string },
  catalog: CmsRemoteCatalog,
  storeFor: (account: string) => CmsRemoteSecretStore,
  now = Date.now(),
): Promise<CmsRemoteConnection> {
  if (!UUID.test(input.state) || !/^[0-9a-f]{32}$/u.test(input.claim)) throw new HistosPublishError("Il link di abbinamento non è valido.", "cms-pairing-invalid", 400);
  const pending = pendingPairings.get(input.state);
  // One try per pairing: a claim that fails is not tried again with the same verifier.
  pendingPairings.delete(input.state);
  if (!pending || pending.expires <= now) throw new HistosPublishError("Questo abbinamento non è stato avviato da Histeon Publish, o è scaduto: ricomincia da «Collega dal sito».", "cms-pairing-unknown", 404);
  const code = await claimPairingCode(pending.siteUrl, input.claim, pending.verifier);
  if (parsePairingCode(code).url !== pending.siteUrl) throw new HistosPublishError("Il codice ricevuto è di un altro sito: il collegamento non è stato fatto.", "cms-pairing-site-mismatch", 409);
  return connectRemoteSite(code, catalog, storeFor);
}

export async function connectRemoteSite(
  input: string,
  catalog: CmsRemoteCatalog,
  storeFor: (account: string) => CmsRemoteSecretStore,
  preferredConnectionId?: string,
): Promise<CmsRemoteConnection> {
  const link = parsePairingCode(input.trim());
  const route = `${REMOTE_NAMESPACE}/capabilities`;
  const result = await requestRemote({ url: link.url }, link.secret, "GET", route);
  const capabilities = validateCapabilities(JSON.parse(result.bytes.toString("utf8")) as unknown);
  const id = preferredConnectionId ?? randomUUID();
  if (!UUID.test(id)) throw new HistosPublishError("Identificativo del collegamento Histeon non valido.", "cms-remote-connection-id-invalid", 400);
  const connection = {
    url: link.url,
    siteId: capabilities.siteId,
    projectId: capabilities.projectId,
    projectName: capabilities.projectName,
    profile: PROFILE,
    read: link.read,
    write: link.write && capabilities.write,
    publish: link.publish && capabilities.publish,
  };
  const secretStore = storeFor(`cms-remote-${id}`);
  const existing = catalog.get(id);
  if (existing) {
    if (existing.siteId !== connection.siteId) {
      throw new HistosPublishError("Il codice appartiene a un altro sito Histeon. Il collegamento esistente non è stato modificato.", "cms-remote-connection-id-conflict", 409);
    }
    const previousSecret = await secretStore.get();
    const nextSecret = link.secret.toString("base64url");
    await secretStore.set(nextSecret);
    try {
      catalog.updateConnection(id, connection);
      catalog.updateRemote(id, { siteHisteon: capabilities.histeon });
      return catalog.get(id)!;
    } catch (error) {
      if (previousSecret === null) await secretStore.delete().catch(() => undefined);
      else await secretStore.set(previousSecret).catch(() => undefined);
      throw error;
    }
  }
  await secretStore.set(link.secret.toString("base64url"));
  try {
    catalog.add({ id,
      ...connection,
    });
    catalog.updateRemote(id, { siteHisteon: capabilities.histeon });
    return catalog.get(id)!;
  } catch (error) {
    await secretStore.delete().catch(() => undefined);
    throw error;
  }
}

export async function revokeRemotePairing(
  connection: CmsRemoteConnection,
  storeFor: (account: string) => CmsRemoteSecretStore,
): Promise<"revoked" | "already-unavailable"> {
  const secret = await readStoredSecret(storeFor, connection.id);
  try {
    const response = await requestRemote(
      connection,
      secret,
      "POST",
      `${REMOTE_NAMESPACE}/revoke`,
      Buffer.from("{}"),
      16 * 1024,
      "application/json",
    );
    let payload: unknown;
    try {
      payload = JSON.parse(response.bytes.toString("utf8")) as unknown;
    } catch {
      throw new Error("La risposta di revoca non è JSON valido.");
    }
    if (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).revoked !== true) {
      throw new Error("WordPress non ha confermato la revoca.");
    }
    return "revoked";
  } catch (error) {
    // Only the bridge's own answer that no pairing exists any more counts as revoked. Any other 401 (clock skew, a
    // proxy or a WAF in front of the site) proves nothing: the code may still be valid on WordPress.
    if (error instanceof CmsRemoteRejectedError && error.exitCode === 401 && error.remoteCode === "xb_cms_inactive") {
      return "already-unavailable";
    }
    throw new HistosPublishError(
      "WordPress non ha confermato la revoca del pairing. Il collegamento è ancora salvato in Histeon Publish. Riprova quando il sito è raggiungibile oppure scegli di scollegare solo questo computer: in quel caso il codice potrebbe restare valido su WordPress.",
      "cms-remote-revoke-unconfirmed",
      409,
    );
  }
}

export async function createRemoteSyncPlan(
  input: { action: CmsSyncAction; connectionId: string; projectId?: string; /** Doc 23 items 199-200: a download of only these entries. */ only?: readonly string[] },
  catalog: CmsRemoteCatalog,
  projects: CmsProjectCatalog,
  storeFor: (account: string) => CmsRemoteSecretStore,
): Promise<CmsSyncPlan> {
  const connection = catalog.get(input.connectionId);
  if (!connection)
    throw new HistosPublishError("Collegamento remoto non trovato.", "cms-remote-connection-missing", 404);
  const secret = await readStoredSecret(storeFor, connection.id);
  const capabilitiesResponse = await requestRemote(connection, secret, "GET", `${REMOTE_NAMESPACE}/capabilities`);
  const capabilities = validateCapabilities(JSON.parse(capabilitiesResponse.bytes.toString("utf8")) as unknown);
  if (capabilities.siteId !== connection.siteId)
    throw new HistosPublishError(
      "L’identità del sito remoto è cambiata. Ricollega il sito prima di trasferire pagine.",
      "cms-remote-site-changed",
      409,
    );
  bindRemoteProject(catalog, connection, capabilities, new Date().toISOString());
  // Doc 23 item 175: said in the plan of a send, never a block (the capabilities stay the block).
  const histeon = input.action === "pull" ? null : histeonSiteNotice(capabilities.histeon);
  if (input.only !== undefined && (input.action !== "pull" || input.only.length === 0 || input.only.some((id) => !UUID.test(id))))
    throw new HistosPublishError("Si portano nel progetto solo contenuti del sito scelti, con un identificativo valido.", "cms-remote-bring-invalid", 400);
  if (input.action === "pull" && !connection.read)
    throw new HistosPublishError(
      "Questo collegamento non autorizza lo scaricamento.",
      "cms-remote-read-scope-required",
      403,
    );
  if (input.action !== "pull" && (!connection.write || !capabilities.write))
    throw new HistosPublishError(
      "Il collegamento non autorizza più l’invio. Verifica i permessi Histeon e crea un nuovo codice se necessario.",
      "cms-remote-write-scope-required",
      403,
    );
  if (input.action === "publish" && (!connection.publish || !capabilities.publish))
    throw new HistosPublishError(
      "La pubblicazione richiede un’autorizzazione esplicita nel collegamento Histeon e nel sito remoto.",
      "cms-remote-publish-scope-required",
      403,
    );

  if (input.action !== "pull" && capabilities.projectId === null) {
    if (connection.projectId !== null)
      throw new HistosPublishError(
        "Il progetto WordPress collegato non è più presente. Ricollega il sito e controlla i dati prima di inviare.",
        "cms-remote-project-changed",
        409,
      );
    if (!capabilities.canInitializeProject)
      throw new HistosPublishError(
        "WordPress contiene già dati Histeon non collegati a un progetto. Scaricali prima oppure collega il progetto corretto; Histeon ha fermato l’invio per proteggere quei dati.",
        "cms-remote-initialization-blocked",
        409,
      );
    const projectId = input.projectId;
    if (!projectId || !UUID.test(projectId))
      throw new HistosPublishError("Seleziona un progetto CMS locale.", "cms-project-invalid", 400);
    const local = await localProfile(projectId, connection.siteId, projects);
    if (!local) throw new HistosPublishError("Progetto CMS locale non trovato.", "cms-project-missing", 404);
    assertRemoteSupportsProfile(capabilities.profiles, local.profile.manifest.profile);
    assertRemoteSupportsMarkup(capabilities.markup, local.profile);
    assertRemoteSupportsProducts(capabilities.commerce, local.profile);
    assertRemoteSupportsScripts(capabilities.scripts ?? [], local.profile);
    assertRemotePhp(capabilities.php);
    const diff = buildInitialPushDiff(local.profile);
    const expiresAt = Date.now() + 10 * 60_000;
    const planId = catalog.saveSyncPlan({
      connectionId: connection.id,
      action: input.action,
      projectId,
      remoteFingerprint: uninitializedRemoteFingerprint(connection.siteId),
      localFingerprint: profileFingerprint(local.profile),
      resolvableConflictIds: [],
      expiresAt,
    });
    return {
      schemaVersion: 1,
      ...remotePlanMetadata(connection, input.action),
      planId,
      action: input.action,
      connectionId: connection.id,
      project: { id: projectId, name: local.profile.manifest.project.name },
      profile: local.profile.manifest.profile,
      initializingRemote: true,
      expiresAt: new Date(expiresAt).toISOString(),
      applyAllowed: true,
      counts: diff.counts,
      entities: diff.entities.slice(0, 250),
      omittedEntities: Math.max(0, diff.entities.length - 250),
      leftOut: [],
      ...(histeon ? { histeon } : {}),
    };
  }

  const remote = await exportRemoteProfile(connection, secret, capabilities, input.action === "pull" ? "read" : "linked");
  const projectId = input.action === "pull" ? remote.profile.manifest.project.id : input.projectId;
  if (!projectId || !UUID.test(projectId))
    throw new HistosPublishError("Seleziona un progetto CMS locale.", "cms-project-invalid", 400);
  if (input.action === "pull") await assertPullTarget(projects, projectId, connection.siteId);
  if (input.action !== "pull" && capabilities.projectId && capabilities.projectId !== projectId)
    throw new HistosPublishError(
      "Il sito WordPress è già collegato a un altro progetto Histeon.",
      "cms-remote-project-conflict",
      409,
    );
  if (remote.profile.manifest.project.id !== projectId)
    throw new HistosPublishError(
      "Il progetto WordPress esportato non corrisponde al progetto selezionato.",
      "cms-remote-project-conflict",
      409,
    );
  const local = await localProfile(
    projectId,
    connection.siteId,
    projects,
    remote.profile.entities.map((entity) => entity.id),
  );
  // Said at review time already: the send would be refused before any upload anyway.
  if (input.action !== "pull" && local) {
    assertRemoteSupportsMarkup(capabilities.markup, local.profile);
    assertRemoteSupportsProducts(capabilities.commerce, local.profile);
    assertRemoteSupportsScripts(capabilities.scripts ?? [], local.profile);
    assertRemotePhp(capabilities.php);
  }
  // Statuses travel as authored: WordPress keeps a send in development, and its next release applies them.
  let diff = buildSyncDiff(input.action, local?.profile ?? null, remote.profile, local?.knownBases);
  let only: string[] | undefined;
  if (input.only) {
    if (!local)
      throw new HistosPublishError("Per portare dei contenuti nel progetto serve il progetto già collegato a questo sito su questo computer.", "cms-remote-bring-no-project", 409);
    only = bringClosure({ requested: input.only, remote: remote.profile, local: local.profile, pullEntities: diff.entities });
    const taken = new Set(only);
    const entities = diff.entities.filter((entity) => taken.has(entity.id));
    const counts = Object.fromEntries(Object.keys(diff.counts).map((status) => [status, entities.filter((entity) => entity.status === status).length])) as typeof diff.counts;
    diff = { counts, entities };
  }
  const applyAllowed = diff.counts.conflict === 0;
  const conflicts = diff.entities.filter((entity) => entity.status === "conflict");
  const allConflictsResolvable =
    input.action === "pull" &&
    conflicts.length > 0 &&
    conflicts.length <= 250 &&
    conflicts.every((entity) => entity.canResolve);
  const planCanBeApplied = applyAllowed || allConflictsResolvable;
  const expiresAt = planCanBeApplied ? Date.now() + 10 * 60_000 : null;
  const planId = planCanBeApplied
    ? catalog.saveSyncPlan({
        connectionId: connection.id,
        action: input.action,
        projectId,
        // Without the bases: WordPress records them while exporting, so a plan would go stale at its own reading.
        remoteFingerprint: pullFingerprint(remote.profile),
        localFingerprint: local ? profileFingerprint(local.profile) : null,
        resolvableConflictIds: allConflictsResolvable ? conflicts.map((entity) => entity.id) : [],
        expiresAt: expiresAt!,
        ...(only ? { only } : {}),
      })
    : null;
  const listed = planEntityList(diff.entities);
  return {
    schemaVersion: 1,
    ...remotePlanMetadata(connection, input.action),
    planId,
    action: input.action,
    connectionId: connection.id,
    project: {
      id: projectId,
      name:
        input.action === "pull"
          ? remote.profile.manifest.project.name
          : (local?.profile.manifest.project.name ?? remote.profile.manifest.project.name),
    },
    profile: remote.profile.manifest.profile,
    initializingRemote: false,
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    applyAllowed,
    counts: diff.counts,
    entities: listed.entities,
    omittedEntities: listed.omittedEntities,
    leftOut: remote.profile.manifest.leftOut ?? [],
    ...(histeon ? { histeon } : {}),
    ...(only && input.only ? { bring: { requested: input.only.length, total: only.length } } : {}),
  };
}

export async function applyRemoteSyncPlan(
  input: { connectionId: string; planId: string; expectedProjectId?: string; resolutions?: Record<string, CmsSyncConflictChoice> },
  catalog: CmsRemoteCatalog,
  projects: CmsProjectCatalog,
  storeFor: (account: string) => CmsRemoteSecretStore,
  attempt = 0,
): Promise<Record<string, unknown>> {
  if (!UUID.test(input.planId))
    throw new HistosPublishError("Il piano di sincronizzazione non è valido.", "cms-sync-plan-invalid", 400);
  const pending = catalog.getSyncPlan(input.planId);
  if (!pending || pending.connectionId !== input.connectionId || (input.expectedProjectId && pending.projectId !== input.expectedProjectId))
    throw new HistosPublishError(
      "Il piano è scaduto, appartiene a un’altra destinazione o a un altro progetto. Rivedi di nuovo le modifiche.",
      "cms-sync-plan-expired",
      409,
    );
  const choices = input.resolutions ?? {};
  const choiceIds = Object.keys(choices).sort();
  const expectedIds = [...pending.resolvableConflictIds].sort();
  if (
    choiceIds.some((id) => !UUID.test(id) || (choices[id] !== "keep-local" && choices[id] !== "use-remote")) ||
    choiceIds.length !== expectedIds.length ||
    choiceIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new HistosPublishError(
      "Scegli quale versione conservare per ogni conflitto prima di applicare il piano.",
      "cms-sync-resolution-required",
      400,
    );
  }
  const plan = catalog.takeSyncPlan(input.planId);
  if (!plan || plan.connectionId !== input.connectionId || (input.expectedProjectId && plan.projectId !== input.expectedProjectId))
    throw new HistosPublishError(
      "Il piano è scaduto, appartiene a un’altra destinazione o a un altro progetto. Rivedi di nuovo le modifiche.",
      "cms-sync-plan-expired",
      409,
    );
  const connection = catalog.get(plan.connectionId);
  if (!connection)
    throw new HistosPublishError("Collegamento remoto non trovato.", "cms-remote-connection-missing", 404);
  const applied = () => syncRemoteSite(
    {
      action: plan.action,
      projectId: plan.projectId,
      expectedRemoteFingerprint: plan.remoteFingerprint,
      expectedLocalFingerprint: plan.localFingerprint,
      resolutions: choices,
      ...(plan.only ? { only: plan.only } : {}),
    },
    connection,
    catalog,
    projects,
    storeFor,
  );
  try {
    return await applied();
  } catch (error) {
    // A host that kills long requests stops a large send halfway: what arrived stays, and a new plan sends the rest.
    if (!(error instanceof HistosPublishError) || error.code !== "cms-remote-operation-interrupted" || attempt >= MAX_RESUMES) throw error;
    // A first send stopped before its pages leaves nothing WordPress can export yet: it is simply sent again.
    if (plan.remoteFingerprint === uninitializedRemoteFingerprint(connection.siteId)) {
      for (let again = attempt + 1; ; again += 1) {
        try {
          return await syncRemoteSite({ action: plan.action, projectId: plan.projectId, resolutions: {}, resumingFirstSend: true }, connection, catalog, projects, storeFor);
        } catch (retry) {
          if (!(retry instanceof HistosPublishError) || retry.code !== "cms-remote-operation-interrupted" || again >= MAX_RESUMES) throw retry;
        }
      }
    }
    const next = await createRemoteSyncPlan({ action: plan.action, connectionId: plan.connectionId, ...(plan.projectId ? { projectId: plan.projectId } : {}) }, catalog, projects, storeFor);
    if (!next.applyAllowed || !next.planId || next.counts.conflict !== 0) throw error;
    return applyRemoteSyncPlan({ connectionId: input.connectionId, planId: next.planId }, catalog, projects, storeFor, attempt + 1);
  }
}

export async function syncRemoteSite(
  input: {
    action: CmsSyncAction;
    projectId?: string;
    expectedRemoteFingerprint?: string;
    /** The site holds only what an interrupted first send left: nothing to read back, nothing to restore. */
    resumingFirstSend?: boolean;
    expectedLocalFingerprint?: string | null;
    resolutions?: Record<string, CmsSyncConflictChoice>;
    /** A download of only these entries, as its plan decided (doc 23 items 199-200). */
    only?: readonly string[];
  },
  connection: CmsRemoteConnection,
  catalog: CmsRemoteCatalog,
  projects: CmsProjectCatalog,
  storeFor: (account: string) => CmsRemoteSecretStore,
): Promise<Record<string, unknown>> {
  const secret = await readStoredSecret(storeFor, connection.id);
  const now = new Date().toISOString();
  const capsResponse = await requestRemote(connection, secret, "GET", `${REMOTE_NAMESPACE}/capabilities`);
  const capabilities = validateCapabilities(JSON.parse(capsResponse.bytes.toString("utf8")) as unknown);
  if (capabilities.siteId !== connection.siteId)
    throw new HistosPublishError(
      "L’identità del sito remoto è cambiata. Ricollega il sito prima di trasferire pagine.",
      "cms-remote-site-changed",
      409,
    );
  bindRemoteProject(catalog, connection, capabilities, now);

  if (input.action === "pull") {
    if (!connection.read)
      throw new HistosPublishError(
        "Questo collegamento non autorizza lo scaricamento.",
        "cms-remote-read-scope-required",
        403,
      );
    const decoded = await exportRemoteProfile(connection, secret, capabilities, "adopt");
    if (input.expectedRemoteFingerprint && pullFingerprint(decoded.profile) !== input.expectedRemoteFingerprint)
      throw new HistosPublishError(
        "Il sito remoto è cambiato dopo la revisione. Nessun dato è stato scaricato: crea un nuovo piano.",
        "cms-sync-plan-stale",
        409,
      );
    if (connection.projectId && decoded.profile.manifest.project.id !== connection.projectId)
      throw new HistosPublishError(
        "Il progetto remoto è cambiato. Ricollega e controlla il catalogo prima di scaricare.",
        "cms-remote-project-changed",
        409,
      );
    await assertPullTarget(projects, decoded.profile.manifest.project.id, connection.siteId);
    if (input.expectedLocalFingerprint !== undefined) {
      const currentLocal = await localProfile(decoded.profile.manifest.project.id, connection.siteId, projects);
      const currentFingerprint = currentLocal ? profileFingerprint(currentLocal.profile) : null;
      if (currentFingerprint !== input.expectedLocalFingerprint)
        throw new HistosPublishError(
          "Il progetto locale è cambiato dopo la revisione. Nessun dato è stato scaricato: crea un nuovo piano.",
          "cms-sync-plan-stale",
          409,
        );
    }
    if (input.only && input.expectedLocalFingerprint === undefined)
      throw new HistosPublishError("Un download di alcuni contenuti passa sempre da un piano.", "cms-sync-plan-required", 428);
    const imported = await projects.importRemoteStaticPageProfile(
      decoded.profile,
      decoded.files,
      connection.siteId,
      input.resolutions,
      input.only ? { only: new Set(input.only) } : undefined,
    );
    catalog.updateRemote(connection.id, {
      projectId: imported.project.id,
      projectName: imported.project.name,
      lastCheckedAt: now,
      lastSyncedAt: new Date().toISOString(),
    });
    return {
      action: "pull",
      connectionId: connection.id,
      project: { id: imported.project.id, name: imported.project.name },
      changed: imported.changed,
      keptLocal: imported.keptLocal,
      unchanged: imported.unchanged,
      complete: true,
    };
  }

  if (!connection.write || !capabilities.write)
    throw new HistosPublishError(
      "Il collegamento non autorizza più l’invio. Verifica i permessi Histeon e crea un nuovo codice se necessario.",
      "cms-remote-write-scope-required",
      403,
    );
  const publishing = input.action === "publish";
  if (publishing && (!connection.publish || !capabilities.publish))
    throw new HistosPublishError(
      "La pubblicazione richiede un’autorizzazione esplicita nel collegamento Histeon e nel sito remoto.",
      "cms-remote-publish-scope-required",
      403,
    );
  const projectId = input.projectId;
  if (!projectId || !UUID.test(projectId))
    throw new HistosPublishError("Seleziona un progetto CMS locale.", "cms-project-invalid", 400);
  if (connection.projectId !== null && capabilities.projectId !== connection.projectId)
    throw new HistosPublishError(
      "Il progetto WordPress collegato non è più presente o è cambiato. Ricollega il sito e controlla i dati prima di inviare.",
      "cms-remote-project-changed",
      409,
    );
  if (capabilities.projectId && capabilities.projectId !== projectId)
    throw new HistosPublishError(
      "Il sito WordPress è già collegato a un altro progetto Histeon.",
      "cms-remote-project-conflict",
      409,
    );
  if (capabilities.projectId === null && !capabilities.canInitializeProject) {
    if (input.expectedRemoteFingerprint === uninitializedRemoteFingerprint(connection.siteId))
      throw new HistosPublishError(
        "WordPress è cambiato dopo la revisione e contiene ora dati Histeon da proteggere. Crea un nuovo piano prima di inviare.",
        "cms-sync-plan-stale",
        409,
      );
    throw new HistosPublishError(
      "WordPress contiene già dati Histeon non collegati a un progetto. Scaricali prima oppure collega il progetto corretto; Histeon ha fermato l’invio per proteggere quei dati.",
      "cms-remote-initialization-blocked",
      409,
    );
  }
  let rollbackArchive: Buffer | null = null;
  if (input.expectedRemoteFingerprint) {
    if (capabilities.projectId === null) {
      if (input.expectedRemoteFingerprint !== uninitializedRemoteFingerprint(connection.siteId))
        throw new HistosPublishError(
          "Il sito WordPress è cambiato dopo la revisione. Nessun dato è stato inviato: crea un nuovo piano.",
          "cms-sync-plan-stale",
          409,
        );
    } else {
      if (input.expectedRemoteFingerprint === uninitializedRemoteFingerprint(connection.siteId))
        throw new HistosPublishError(
          "Il sito WordPress è cambiato dopo la revisione. Nessun dato è stato inviato: crea un nuovo piano.",
          "cms-sync-plan-stale",
          409,
        );
      const currentRemote = await exportRemoteProfile(connection, secret, capabilities, "linked");
      if (pullFingerprint(currentRemote.profile) !== input.expectedRemoteFingerprint)
        throw new HistosPublishError(
          "Il sito remoto è cambiato dopo la revisione. Nessun dato è stato inviato: crea un nuovo piano.",
          "cms-sync-plan-stale",
          409,
        );
      // Keep the exact remote preimage beside the durable operation journal.
      // It is the source for a later, hash-guarded compensation; it is never sent
      // to the remote site and remains inside the local application data store.
      const beforeFiles = new Map(currentRemote.files);
      beforeFiles.delete("site.json");
      rollbackArchive = await encodeStaticPageProfileArchive(currentRemote.profile, beforeFiles);
    }
  } else if (capabilities.projectId !== null && !input.resumingFirstSend) {
    const currentRemote = await exportRemoteProfile(connection, secret, capabilities, "linked");
    const beforeFiles = new Map(currentRemote.files);
    beforeFiles.delete("site.json");
    rollbackArchive = await encodeStaticPageProfileArchive(currentRemote.profile, beforeFiles);
  }
  const opened = await projects.openProject(projectId);
  if (!opened) throw new HistosPublishError("Progetto CMS locale non trovato.", "cms-project-missing", 404);
  try {
    const { createStaticPageProfile } = await import("@histos-publish/cms");
    const source = await createStaticPageProfile(
      opened.project,
      opened.store,
      undefined,
      connection.siteId,
    );
    if (input.expectedLocalFingerprint !== undefined && profileFingerprint(source.profile) !== input.expectedLocalFingerprint)
      throw new HistosPublishError(
        "Il progetto locale è cambiato dopo la revisione. Nessun dato è stato inviato: crea un nuovo piano.",
        "cms-sync-plan-stale",
        409,
      );
    // Never downgraded to drafts: a draft sent for a page that is online would take it offline at the next
    // Histeon release. The bridge keeps everything in development until a release (docs/spec/cms-bridge.md §5).
    const { profile, files } = source;
    assertRemoteSupportsProfile(capabilities.profiles, profile.manifest.profile);
    assertRemoteSupportsMarkup(capabilities.markup, profile);
    assertRemoteSupportsProducts(capabilities.commerce, profile);
    assertRemoteSupportsScripts(capabilities.scripts ?? [], profile);
    assertRemotePhp(capabilities.php);
    const archive = await encodeStaticPageProfileArchive(profile, files);
    const operationId = profile.manifest.selection.snapshot;
    const expectedHeads = Object.fromEntries(profile.entities.map((entity) => [entity.id, entity.revisionHash]));
    catalog.recordOperation({
      operationId,
      connectionId: connection.id,
      projectId,
      action: publishing ? "publish" : "push",
      expectedHeads,
      archiveHash: createHash("sha256").update(archive).digest("hex"),
      previousArchive: rollbackArchive,
    });
    let response: Awaited<ReturnType<typeof requestRemote>>;
    try {
      response = await requestRemote(
        connection,
        secret,
        "POST",
        `${REMOTE_NAMESPACE}/${publishing ? "publish" : "import"}`,
        archive,
      );
    } catch (error) {
      // Only WordPress's own refusal says the send was not applied: an answer that cannot be read (too large, cut
      // off) came after the archive was sent, so the operation is checked like a dropped connection.
      if (error instanceof CmsRemoteRejectedError && error.exitCode < 500) {
        catalog.updateOperation(
          connection.id,
          operationId,
          "failed",
          "WordPress ha rifiutato l’operazione prima di confermarne l’applicazione.",
        );
        throw error;
      }
      let detail: Record<string, unknown>;
      try {
        // A large site takes WordPress longer than one answer lasts: it goes on, and its state says when it is done.
        const deadline = Date.now() + REMOTE_APPLY_WAIT_MS;
        for (;;) {
          const status = await requestRemote(
            connection,
            secret,
            "GET",
            `${REMOTE_NAMESPACE}/status/${profile.manifest.selection.snapshot}`,
          );
          detail = JSON.parse(status.bytes.toString("utf8")) as Record<string, unknown>;
          if (detail.state !== "applying" || Date.now() > deadline) break;
          await new Promise((done) => setTimeout(done, REMOTE_APPLY_POLL_MS));
        }
      } catch (statusError) {
        if (statusError instanceof HistosPublishError && statusError.exitCode === 404)
          catalog.updateOperation(
            connection.id,
            operationId,
            "not-found",
            "WordPress non ha registrato questa operazione; verifica il piano prima di riprovare.",
          );
        else
          catalog.updateOperation(
            connection.id,
            operationId,
            "pending",
            "La risposta si è interrotta; l’esito remoto va controllato.",
          );
        throw new HistosPublishError(
          "La connessione è caduta durante l’invio. Controlla l’esito remoto prima di riprovare.",
          "cms-remote-operation-uncertain",
          504,
        );
      }
      const requestedAction = publishing ? "publish" : "import";
      if (detail.operationId !== operationId || detail.action !== requestedAction || detail.projectId !== projectId) {
        catalog.updateOperation(
          connection.id,
          operationId,
          "pending",
          "La risposta di stato non corrisponde all’operazione inviata.",
        );
        throw new HistosPublishError(
          "WordPress non conferma l’identità dell’operazione inviata. Controlla lo stato prima di riprovare.",
          "cms-remote-operation-uncertain",
          504,
        );
      }
      if (detail.state !== "complete" || detail.complete !== true || detail.published !== publishing) {
        const state = detail.state === "partial" ? "partial" : detail.state === "applying" ? "applying" : "pending";
        catalog.updateOperation(
          connection.id,
          operationId,
          state,
          state === "partial"
            ? "WordPress ha interrotto l’importazione; crea un nuovo piano per riprenderla."
            : "WordPress non ha ancora confermato il completamento; controlla di nuovo lo stato.",
        );
        throw new HistosPublishError(
          state === "partial" && typeof detail.reason === "string"
            ? `WordPress ha interrotto l’invio: ${detail.reason.slice(0, 400)} Crea un nuovo piano per riprenderlo.`
            : "WordPress non conferma ancora il completamento. Nessuna base di sincronizzazione locale è stata avanzata.",
          state === "partial" && detail.failure === "operation-interrupted" ? "cms-remote-operation-interrupted" : "cms-remote-operation-uncertain",
          504,
        );
      }
      response = {
        bytes: Buffer.from(JSON.stringify(detail)),
        contentType: "application/json",
        headers: new Headers(),
      };
    }
    if (!response.contentType.toLowerCase().startsWith("application/json"))
      throw new HistosPublishError(
        "Il sito non ha restituito il report previsto dal ponte Histeon CMS.",
        "cms-remote-report-invalid",
        422,
      );
    const report = JSON.parse(response.bytes.toString("utf8")) as Record<string, unknown>;
    if (
      report.complete !== true ||
      report.project === null ||
      typeof report.project !== "object" ||
      (report.project as Record<string, unknown>).id !== profile.manifest.project.id
    )
      throw new HistosPublishError(
        "WordPress non conferma il progetto previsto e un’importazione completa. Le basi comuni non sono avanzate.",
        "cms-remote-incomplete",
        502,
      );
    if (
      report.operationId !== profile.manifest.selection.snapshot ||
      report.action !== (publishing ? "publish" : "import")
    )
      throw new HistosPublishError(
        "WordPress non conferma l’identità e l’azione dell’operazione richiesta. Le basi comuni non sono avanzate.",
        "cms-remote-operation-invalid",
        502,
      );
    if (report.published !== publishing)
      throw new HistosPublishError(
        "WordPress non conferma l’azione di pubblicazione richiesta. Le basi comuni non sono avanzate.",
        "cms-remote-publish-state-invalid",
        502,
      );
    // Without publishing, WordPress keeps what it cannot apply yet (records, terms, titles, deletions) for its
    // next release: the report lists it, and only these reasons are understood.
    if (!Array.isArray(report.pending) || report.pending.length > 100_000 || !report.pending.every(isPendingItem))
      throw new HistosPublishError(
        "WordPress non ha restituito l’elenco di ciò che resta in attesa. Le basi comuni non sono avanzate.",
        "cms-remote-report-invalid",
        502,
      );
    const heads = report.heads && typeof report.heads === "object" ? (report.heads as Record<string, unknown>) : {};
    const submitted = new Map(profile.entities.map((entity) => [entity.id, entity.revisionHash]));
    // A connected WordPress site can contain Histeon entities that this local
    // project does not include. They are preserved by import and may therefore
    // appear as additional heads in the report. Confirm every submitted head,
    // but do not mistake preserved remote-only content for a failed import.
    if ([...submitted].some(([entityId, hash]) => heads[entityId] !== hash))
      throw new HistosPublishError(
        "WordPress ha restituito revisioni diverse dal profilo inviato. Le basi comuni non sono avanzate.",
        "cms-remote-heads-invalid",
        502,
      );
    await opened.store.atomic(async () => {
      for (const [entityId, hash] of submitted) opened.store.setSyncBase(connection.siteId, projectId, entityId, hash);
      await projects.saveManifest(opened.project);
    });
    const links = languageLinksOf(opened.store);
    const languagesNote = links.length ? await sendLanguageLinks(connection, secret, links) : "";
    catalog.updateOperation(connection.id, operationId, "complete", languagesNote.trim() || null, validateEntityHeads(heads));
    catalog.updateRemote(connection.id, {
      projectId,
      projectName: opened.project.name,
      lastCheckedAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
    });
    return { action: input.action, connectionId: connection.id, projectId, report, complete: true, ...(languagesNote ? { languagesNote: languagesNote.trim() } : {}) };
  } finally {
    opened.store.close();
  }
}

/** Every translation of the project, as the site's language plugin needs it (doc 20 §5.9). */
function languageLinksOf(store: { listTranslations(): Array<{ translationId: string; sourceId: string; language: string; mode: string }> }): Array<{ translationId: string; sourceId: string; language: string; mode: string }> {
  return store.listTranslations().map(({ translationId, sourceId, language, mode }) => ({ translationId, sourceId, language, mode }));
}

/**
 * Tells the site which sent content is which language's version (doc 20 §5.9): the contents went as normal pages, and
 * the links reach its language plugin here. A site that cannot take them keeps the contents, and the message says so.
 */
export async function sendLanguageLinks(connection: CmsRemoteConnection, secret: Buffer, links: ReadonlyArray<{ translationId: string; sourceId: string; language: string; mode: string }>): Promise<string> {
  const unlinked = " Le traduzioni sono arrivate come contenuti a sé: per collegarle servono Lingua Bridge e un Histeon aggiornato sul sito.";
  try {
    const response = await requestRemote(connection, secret, "POST", `${REMOTE_NAMESPACE}/languages`, Buffer.from(JSON.stringify({ links: links.slice(0, 5000) })), 64 * 1024, "application/json");
    const taken = (JSON.parse(response.bytes.toString("utf8")) as { taken?: unknown }).taken;
    return taken === 0 ? unlinked : "";
  } catch {
    return unlinked;
  }
}

export async function checkRemoteOperation(
  input: { connectionId: string; operationId: string },
  catalog: CmsRemoteCatalog,
  projects: CmsProjectCatalog,
  storeFor: (account: string) => CmsRemoteSecretStore,
): Promise<{
  operationId: string;
  projectId: string;
  action: CmsRemoteOperationAction;
  state: CmsRemoteOperationState;
  phase: string | null;
  advancedBases: number;
  localChanges: number;
}> {
  const operation = catalog.getOperation(input.connectionId, input.operationId);
  if (!operation)
    throw new HistosPublishError(
      "Operazione remota non trovata nel registro locale.",
      "cms-remote-operation-missing",
      404,
    );
  const connection = catalog.get(input.connectionId);
  if (!connection)
    throw new HistosPublishError(
      "Il collegamento remoto non è disponibile. Ricollega il sito per controllare l’operazione.",
      "cms-remote-connection-missing",
      404,
    );
  const secret = await readStoredSecret(storeFor, connection.id);
  let detail: Record<string, unknown>;
  try {
    const response = await requestRemote(
      connection,
      secret,
      "GET",
      `${REMOTE_NAMESPACE}/status/${operation.operationId}`,
    );
    detail = JSON.parse(response.bytes.toString("utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HistosPublishError && error.exitCode === 404) {
      catalog.updateOperation(
        connection.id,
        operation.operationId,
        "not-found",
        "WordPress non trova l’operazione registrata localmente.",
      );
      return {
        operationId: operation.operationId,
        projectId: operation.projectId,
        action: operation.action,
        state: "not-found",
        phase: null,
        advancedBases: 0,
        localChanges: operation.expectedEntityCount,
      };
    }
    throw error;
  }
  const expectedAction = operation.action === "publish" ? "publish" : "import";
  if (
    detail.operationId !== operation.operationId ||
    detail.action !== expectedAction ||
    detail.projectId !== operation.projectId
  ) {
    throw new HistosPublishError(
      "Lo stato ricevuto da WordPress non corrisponde al registro dell’operazione.",
      "cms-remote-operation-invalid",
      502,
    );
  }
  const phase = typeof detail.phase === "string" ? detail.phase.slice(0, 80) : null;
  if (detail.state === "partial") {
    catalog.updateOperation(
      connection.id,
      operation.operationId,
      "partial",
      "WordPress ha interrotto l’operazione; rivedi un nuovo piano prima di riprovare.",
    );
    return {
      operationId: operation.operationId,
      projectId: operation.projectId,
      action: operation.action,
      state: "partial",
      phase,
      advancedBases: 0,
      localChanges: operation.expectedEntityCount,
    };
  }
  if (detail.state === "applying") {
    catalog.updateOperation(
      connection.id,
      operation.operationId,
      "applying",
      "WordPress sta ancora applicando il trasferimento. Attendi prima di avviare un altro invio.",
    );
    return {
      operationId: operation.operationId,
      projectId: operation.projectId,
      action: operation.action,
      state: "applying",
      phase,
      advancedBases: 0,
      localChanges: operation.expectedEntityCount,
    };
  }
  if (
    detail.state !== "complete" ||
    detail.complete !== true ||
    detail.published !== (operation.action === "publish")
  ) {
    catalog.updateOperation(
      connection.id,
      operation.operationId,
      "pending",
      "WordPress non ha ancora restituito una conferma completa.",
    );
    return {
      operationId: operation.operationId,
      projectId: operation.projectId,
      action: operation.action,
      state: "pending",
      phase,
      advancedBases: 0,
      localChanges: operation.expectedEntityCount,
    };
  }
  const remoteProject =
    detail.project && typeof detail.project === "object" && !Array.isArray(detail.project)
      ? (detail.project as Record<string, unknown>)
      : {};
  const remoteHeads =
    detail.heads && typeof detail.heads === "object" && !Array.isArray(detail.heads)
      ? (detail.heads as Record<string, unknown>)
      : {};
  const expectedEntries = Object.entries(operation.expectedHeads);
  if (
    remoteProject.id !== operation.projectId ||
    (operation.rollbackOfOperationId !== undefined && Object.keys(remoteHeads).length !== expectedEntries.length) ||
    expectedEntries.some(([id, hash]) => remoteHeads[id] !== hash)
  ) {
    throw new HistosPublishError(
      "WordPress riporta revisioni diverse da quelle inviate. Le basi locali restano ferme.",
      "cms-remote-heads-invalid",
      502,
    );
  }

  const opened = await projects.openProject(operation.projectId);
  if (!opened)
    throw new HistosPublishError(
      "Il progetto locale collegato all’operazione non è disponibile.",
      "cms-project-missing",
      404,
    );
  let advancedBases = 0;
  let localChanges = 0;
  let languageLinks: Array<{ translationId: string; sourceId: string; language: string; mode: string }> = [];
  try {
    if (operation.rollbackOfOperationId) {
      const original = catalog.getOperation(connection.id, operation.rollbackOfOperationId);
      const previousArchive = catalog.getOperationPreviousArchive(connection.id, operation.rollbackOfOperationId);
      if (!original || !previousArchive) {
        throw new HistosPublishError(
          "Il backup dell’invio originale non è più disponibile per completare il ripristino.",
          "cms-remote-rollback-backup-unavailable",
          409,
        );
      }
      const before = await decodeStaticPageArchive(previousArchive);
      const aligned = await alignLocalBasesAfterRemoteRollback({ original, connection, before: before.profile, opened, projects });
      advancedBases = aligned.advancedBases;
      localChanges = aligned.localChanges;
    } else {
      const { createStaticPageProfile } = await import("@histos-publish/cms");
      const source = await createStaticPageProfile(opened.project, opened.store, undefined, connection.siteId);
      const profile = source.profile;
      const currentHashes = new Map(profile.entities.map((entity) => [entity.id, entity.revisionHash]));
      await opened.store.atomic(async () => {
        for (const [entityId, hash] of expectedEntries) {
          if (currentHashes.get(entityId) !== hash) {
            localChanges += 1;
            continue;
          }
          opened.store.setSyncBase(connection.siteId, operation.projectId, entityId, hash);
          advancedBases += 1;
        }
        await projects.saveManifest(opened.project);
      });
      languageLinks = languageLinksOf(opened.store);
    }
  } finally {
    opened.store.close();
  }
  const languagesNote = languageLinks.length ? await sendLanguageLinks(connection, secret, languageLinks) : "";
  const state: CmsRemoteOperationState = localChanges ? "complete-local-changes" : "complete";
  const completionMessage = operation.rollbackOfOperationId
    ? localChanges
      ? "Ripristino remoto completato; alcune voci locali sono cambiate e richiedono un nuovo confronto."
      : "Ripristino remoto completato e basi locali riallineate."
    : localChanges
      ? "Invio remoto completato; alcune voci locali sono cambiate dopo l’invio e richiedono un nuovo confronto."
      : `Invio remoto completato e basi locali aggiornate.${languagesNote}`;
  if (operation.rollbackOfOperationId) {
    catalog.completeRollback({
      connectionId: connection.id,
      originalOperationId: operation.rollbackOfOperationId,
      rollbackOperationId: operation.operationId,
      state,
      resultHeads: validateEntityHeads(remoteHeads),
      message: completionMessage,
    });
  } else {
    catalog.updateOperation(connection.id, operation.operationId, state, completionMessage, validateEntityHeads(remoteHeads));
  }
  catalog.updateRemote(connection.id, {
    projectId: operation.projectId,
    projectName: connection.projectName,
    lastCheckedAt: new Date().toISOString(),
    lastSyncedAt: new Date().toISOString(),
  });
  return {
    operationId: operation.operationId,
    projectId: operation.projectId,
    action: operation.action,
    state,
    phase,
    advancedBases,
    localChanges,
  };
}

/** Apply the latest saved WordPress preimage only when every remote head still matches the completed operation. */
export async function rollbackRemoteOperation(
  input: { connectionId: string; operationId: string },
  catalog: CmsRemoteCatalog,
  projects: CmsProjectCatalog,
  storeFor: (account: string) => CmsRemoteSecretStore,
): Promise<{ operationId: string; rollbackOperationId: string; projectId: string; state: "rolled-back"; published: boolean }> {
  const operation = catalog.getOperation(input.connectionId, input.operationId);
  if (!operation) throw new HistosPublishError("Operazione remota non trovata nel registro locale.", "cms-remote-operation-missing", 404);
  if (!["complete", "complete-local-changes"].includes(operation.state)) {
    throw new HistosPublishError("Puoi ripristinare solo un invio WordPress completato e verificato.", "cms-remote-rollback-state-invalid", 409);
  }
  const partialRollback = catalog.listOperations(input.connectionId).find((candidate) =>
    candidate.rollbackOfOperationId === operation.operationId && ["partial", "not-found"].includes(candidate.state) && candidate.rollbackRetryAvailable,
  );
  const retryingPartialRollback = partialRollback?.rollbackRetryAvailable === true;
  if (!operation.rollbackAvailable && !retryingPartialRollback) {
    throw new HistosPublishError(
      "Un ripristino di questo invio è già stato avviato o completato. Controlla la cronologia prima di ripetere l’operazione.",
      "cms-remote-rollback-in-progress",
      409,
    );
  }
  const previousArchive = catalog.getOperationPreviousArchive(input.connectionId, input.operationId);
  if (!previousArchive || !operation.resultHeads) {
    throw new HistosPublishError("Per questo invio non è disponibile un backup verificabile. Nessun dato è stato modificato.", "cms-remote-rollback-backup-unavailable", 409);
  }
  const connection = catalog.get(input.connectionId);
  if (!connection) throw new HistosPublishError("Il collegamento remoto non è disponibile. Ricollega il sito prima del ripristino.", "cms-remote-connection-missing", 404);
  if (!connection.read || !connection.write) {
    throw new HistosPublishError("Il collegamento deve autorizzare lettura e invio per verificare e ripristinare il backup.", "cms-remote-rollback-scope-required", 403);
  }
  const secret = await readStoredSecret(storeFor, connection.id);
  const capabilitiesResponse = await requestRemote(connection, secret, "GET", `${REMOTE_NAMESPACE}/capabilities`);
  const capabilities = validateCapabilities(JSON.parse(capabilitiesResponse.bytes.toString("utf8")) as unknown);
  if (capabilities.siteId !== connection.siteId || capabilities.projectId !== operation.projectId) {
    throw new HistosPublishError("Il sito o il progetto WordPress è cambiato dopo l’invio. Il ripristino è stato fermato.", "cms-remote-rollback-target-changed", 409);
  }
  if (!capabilities.write) throw new HistosPublishError("Il collegamento WordPress non autorizza più le modifiche.", "cms-remote-write-scope-required", 403);

  const currentRemote = await exportRemoteProfile(connection, secret, capabilities, "linked");
  const currentHeads = validateEntityHeads(Object.fromEntries(currentRemote.profile.entities.map((entity) => [entity.id, entity.revisionHash])));
  const recordedHeads = operation.resultHeads;

  const before = await decodeStaticPageArchive(previousArchive);
  if (before.profile.manifest.project.id !== operation.projectId) {
    throw new HistosPublishError("Il backup non corrisponde al progetto dell’invio.", "cms-remote-rollback-backup-invalid", 409);
  }
  const reusable = before.profile.entities.filter((entity) => ["component", "template-part", "template"].includes(entity.kind));
  if (reusable.some((entity) => entity.payload.status !== "draft" && entity.payload.status !== "published")) {
    throw new HistosPublishError("Il backup non registra lo stato bozza/pubblicato di componenti o modello. Aggiorna Histeon WordPress per abilitarne il ripristino sicuro.", "cms-remote-rollback-status-unavailable", 409);
  }
  const published = before.profile.entities.some((entity) =>
    ["document", "content-record", "component", "template-part", "template"].includes(entity.kind) && entity.payload.status === "published",
  );
  if (published && (!connection.publish || !capabilities.publish)) {
    throw new HistosPublishError("Il ripristino contiene contenuti pubblicati e richiede il permesso Publish nel collegamento WordPress.", "cms-remote-publish-scope-required", 403);
  }

  let archive: Buffer;
  let supersedeOperationId: string | undefined;
  if (retryingPartialRollback && partialRollback) {
    const previousAttempt = catalog.getOperation(connection.id, partialRollback.operationId);
    const savedRequest = catalog.getOperationRequestArchive(connection.id, partialRollback.operationId);
    if (!previousAttempt || !savedRequest || !["partial", "not-found"].includes(previousAttempt.state)) {
      throw new HistosPublishError("Il ripristino parziale non conserva dati sufficienti per un nuovo tentativo sicuro. Controlla WordPress manualmente.", "cms-remote-rollback-retry-unavailable", 409);
    }
    let status: Record<string, unknown> | null = null;
    try {
      const response = await requestRemote(connection, secret, "GET", `${REMOTE_NAMESPACE}/status/${partialRollback.operationId}`);
      status = JSON.parse(response.bytes.toString("utf8")) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof HistosPublishError && error.exitCode === 404) {
        catalog.updateOperation(connection.id, previousAttempt.operationId, "not-found", "WordPress non conserva più lo stato; il retry resta possibile solo se tutte le revisioni corrispondono al piano salvato.");
      } else {
        throw new HistosPublishError("Non riesco a confermare che WordPress abbia fermato il ripristino parziale. Nessun nuovo invio è stato avviato.", "cms-remote-rollback-status-unverified", 504);
      }
    }
    if (status) {
      const expectedRemoteAction = previousAttempt.action === "publish" ? "publish" : "import";
      if (status.operationId !== previousAttempt.operationId || status.projectId !== operation.projectId || status.action !== expectedRemoteAction) {
        throw new HistosPublishError("Lo stato del ripristino in WordPress non corrisponde al journal locale.", "cms-remote-rollback-operation-invalid", 502);
      }
      if (status.state !== "partial") {
        if (status.state === "applying") {
          catalog.updateOperation(connection.id, previousAttempt.operationId, "applying", "WordPress sta ancora applicando il ripristino. Attendi e controlla di nuovo.");
          throw new HistosPublishError("WordPress sta ancora applicando il ripristino. Attendi e controlla di nuovo.", "cms-remote-rollback-in-progress", 409);
        }
        throw new HistosPublishError("Prima controlla e registra l’esito aggiornato dell’operazione WordPress.", "cms-remote-rollback-status-changed", 409);
      }
    }
    const savedProfile = await decodeStaticPageArchive(savedRequest);
    if (savedProfile.profile.manifest.project.id !== operation.projectId) {
      throw new HistosPublishError("Il ripristino parziale salvato appartiene a un altro progetto.", "cms-remote-rollback-backup-invalid", 409);
    }
    const savedHeads = validateEntityHeads(Object.fromEntries(savedProfile.profile.entities.map((entity) => [entity.id, entity.revisionHash])));
    const recordedIds = Object.keys(recordedHeads).sort();
    if (
      JSON.stringify(Object.keys(currentHeads).sort()) !== JSON.stringify(recordedIds) ||
      JSON.stringify(Object.keys(savedHeads).sort()) !== JSON.stringify(recordedIds) ||
      JSON.stringify(Object.entries(savedHeads).sort(([left], [right]) => left.localeCompare(right))) !==
        JSON.stringify(Object.entries(previousAttempt.expectedHeads).sort(([left], [right]) => left.localeCompare(right)))
    ) {
      throw new HistosPublishError("Le entità di WordPress non coincidono con l’invio e il ripristino parziale registrati. Nessun nuovo invio è stato avviato.", "cms-remote-rollback-conflict", 409);
    }
    for (const [id, hash] of Object.entries(currentHeads)) {
      if (hash !== recordedHeads[id] && hash !== savedHeads[id]) {
        throw new HistosPublishError("WordPress contiene una modifica estranea al ripristino interrotto. Nessun nuovo invio è stato avviato.", "cms-remote-rollback-conflict", 409);
      }
    }
    archive = await rebaseCompensatingArchive(savedRequest, currentRemote.profile);
    supersedeOperationId = previousAttempt.operationId;
  } else {
    if (Object.keys(currentHeads).length !== Object.keys(recordedHeads).length || Object.entries(recordedHeads).some(([id, hash]) => currentHeads[id] !== hash)) {
      throw new HistosPublishError("WordPress è cambiato dopo l’invio. Nessun contenuto è stato ripristinato; crea un nuovo piano.", "cms-remote-rollback-conflict", 409);
    }
    archive = await buildCompensatingArchive(previousArchive, currentRemote.profile);
  }

  const opened = await projects.openProject(operation.projectId);
  if (!opened) throw new HistosPublishError("Il progetto locale collegato all’operazione non è disponibile.", "cms-project-missing", 404);
  try {
  const compensation = await decodeStaticPageArchive(archive);
  const rollbackOperationId = compensation.profile.manifest.selection.snapshot;
  const action = published ? "publish" : "push";
  const remoteAction = published ? "publish" : "import";
  const expectedHeads = Object.fromEntries(compensation.profile.entities.map((entity) => [entity.id, entity.revisionHash]));
  const currentFiles = new Map(currentRemote.files);
  currentFiles.delete("site.json");
  const currentArchive = await encodeStaticPageProfileArchive(currentRemote.profile, currentFiles);
  catalog.recordOperation({
    operationId: rollbackOperationId,
    connectionId: connection.id,
    projectId: operation.projectId,
    action,
    expectedHeads,
    archiveHash: createHash("sha256").update(archive).digest("hex"),
    previousArchive: currentArchive,
    requestArchive: archive,
    rollbackOfOperationId: operation.operationId,
    ...(supersedeOperationId ? { supersedeOperationId } : {}),
  });

  let report: Record<string, unknown>;
  try {
    const response = await requestRemote(connection, secret, "POST", `${REMOTE_NAMESPACE}/${remoteAction}`, archive);
    if (!response.contentType.toLowerCase().startsWith("application/json")) throw new Error("Il report del ripristino non è JSON.");
    report = JSON.parse(response.bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    try {
      const statusResponse = await requestRemote(connection, secret, "GET", `${REMOTE_NAMESPACE}/status/${rollbackOperationId}`);
      report = JSON.parse(statusResponse.bytes.toString("utf8")) as Record<string, unknown>;
    } catch (statusError) {
      if (statusError instanceof HistosPublishError && statusError.exitCode === 404) {
        catalog.updateOperation(connection.id, rollbackOperationId, "not-found", "WordPress non ha registrato il ripristino. Puoi verificare di nuovo l’invio originale prima di riprovare.");
        throw new HistosPublishError("WordPress non trova il ripristino. Nessun completamento è stato confermato; controlla il sito prima di riprovare.", "cms-remote-rollback-not-found", 404);
      }
      catalog.updateOperation(connection.id, rollbackOperationId, "pending", "Risposta interrotta: controlla lo stato prima di riprovare.");
      throw new HistosPublishError("La risposta del ripristino si è interrotta. Controlla l’operazione prima di ripetere l’invio.", "cms-remote-rollback-uncertain", 504);
    }
  }
  if (
    report.operationId !== rollbackOperationId || report.action !== remoteAction ||
    report.complete !== true || report.project === null || typeof report.project !== "object" ||
    (report.project as Record<string, unknown>).id !== operation.projectId || report.published !== published
  ) {
    const state = report.state === "partial" ? "partial" : report.state === "applying" ? "applying" : "pending";
    catalog.updateOperation(connection.id, rollbackOperationId, state, "WordPress non ha ancora confermato un ripristino completo.");
    throw new HistosPublishError("WordPress non conferma il completamento del ripristino. Controlla il journal prima di riprovare.", "cms-remote-rollback-incomplete", 504);
  }
  const resultHeads = validateEntityHeads(report.heads);
  if (Object.entries(expectedHeads).some(([id, hash]) => resultHeads[id] !== hash)) {
    catalog.updateOperation(connection.id, rollbackOperationId, "failed", "Le revisioni dopo il ripristino non corrispondono al backup.");
    throw new HistosPublishError("WordPress ha restituito revisioni diverse dal backup. Le basi locali non sono state avanzate.", "cms-remote-rollback-heads-invalid", 502);
  }
  if (Object.keys(expectedHeads).length !== Object.keys(resultHeads).length) {
    catalog.updateOperation(connection.id, rollbackOperationId, "failed", "Il sito WordPress contiene revisioni Histeon inattese dopo il ripristino.");
    throw new HistosPublishError("WordPress ha restituito contenuti Histeon aggiuntivi rispetto al backup. Verifica il sito prima di continuare.", "cms-remote-rollback-heads-invalid", 502);
  }
  const aligned = await alignLocalBasesAfterRemoteRollback({ original: operation, connection, before: before.profile, opened, projects });
  const state = aligned.localChanges ? "complete-local-changes" : "complete";
  catalog.completeRollback({
    connectionId: connection.id,
    originalOperationId: operation.operationId,
    rollbackOperationId,
    state,
    resultHeads,
    message: aligned.localChanges
      ? "Ripristino compensativo completato; alcune voci locali sono cambiate e richiedono un nuovo confronto."
      : "Ripristino compensativo completato e basi locali riallineate.",
  });
  catalog.updateRemote(connection.id, { lastCheckedAt: new Date().toISOString(), lastSyncedAt: new Date().toISOString() });
  return { operationId: operation.operationId, rollbackOperationId, projectId: operation.projectId, state: "rolled-back", published };
  } finally {
    opened.store.close();
  }
}

export function isConnectionId(value: string): boolean {
  return UUID.test(value);
}
