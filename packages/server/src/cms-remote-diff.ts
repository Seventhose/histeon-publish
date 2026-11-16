import { createHash } from "node:crypto";
import { canonicalizeJson, type StaticPageProfile } from "@histos-publish/histos-contract";
import type { CmsSyncAction, CmsSyncPlanStatus, CmsSyncFieldComparison, CmsSyncPlanEntity } from "./cms-remote-catalog.js";

/** Comparing a local project with a WordPress profile: the sync plan before anything is sent or applied. */
export function profileFingerprint(profile: StaticPageProfile): string {
  return fingerprint(profile, true);
}

/**
 * What a download takes: identities, revisions, references and files, without the sync bases (nor entities.ndjson,
 * which holds them; its entities are compared one by one). The first export of content born on WordPress records its
 * bases after building the archive, so the next export differs only in them; a plan to download must not go stale
 * for that (queue C4).
 */
export function pullFingerprint(profile: StaticPageProfile): string {
  return fingerprint(profile, false);
}

function fingerprint(profile: StaticPageProfile, withBases: boolean): string {
  const entities = profile.entities
    .map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      schemaVersion: entity.schemaVersion,
      revisionHash: entity.revisionHash,
      ...(withBases ? { baseHash: entity.baseHash ?? null } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const references = [...profile.references]
    .map((reference) => ({ ...reference }))
    .sort((left, right) =>
      `${left.ownerId}\0${left.blockUid}\0${left.path}\0${left.targetId}`.localeCompare(
        `${right.ownerId}\0${right.blockUid}\0${right.path}\0${right.targetId}`,
      ),
    );
  const files = profile.manifest.files
    .filter((file) => withBases || file.path !== "entities.ndjson")
    .map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const stable = JSON.stringify({
    project: profile.manifest.project,
    profile: profile.manifest.profile,
    entities,
    references,
    files,
  });
  return createHash("sha256").update(stable).digest("hex");
}

export function buildInitialPushDiff(local: StaticPageProfile): {
  counts: Record<CmsSyncPlanStatus, number>;
  entities: CmsSyncPlanEntity[];
} {
  const counts: Record<CmsSyncPlanStatus, number> = {
    new: local.entities.length,
    update: 0,
    delete: 0,
    unchanged: 0,
    "local-only": 0,
    "remote-only": 0,
    conflict: 0,
  };
  const entities = local.entities.map((entity) => ({
    id: entity.id,
    kind: entity.kind,
    label: entityLabel(entity),
    status: "new" as const,
    canResolve: false,
  }));
  entities.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  return { counts, entities };
}

export function entityLabel(entity: StaticPageProfile["entities"][number]): string {
  const payload = entity.payload;
  for (const key of ["title", "label", "name", "slug", "key", "ref"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return `${entity.kind} · ${entity.id.slice(0, 8)}`;
}

export const MAX_COMPARISON_FIELDS = 8;
export const MAX_COMPARISON_VALUE_CHARS = 240;

export function comparisonValue(value: unknown): string {
  const text = typeof value === "string" ? value : canonicalizeJson(value);
  return text.length > MAX_COMPARISON_VALUE_CHARS ? `${text.slice(0, MAX_COMPARISON_VALUE_CHARS)}…` : text;
}

/**
 * The text a reader sees in a block content (`content` of a page, a component or a template): the words of its text
 * blocks, without markup. Null for any other field, or when the content has no text block.
 */
export function readableContent(field: string, value: unknown): string | null {
  if (field !== "content" || typeof value !== "string" || value.length > 4 * 1024 * 1024) return null;
  // A linear scan, not a regular expression: the content comes from the site and may be built to be slow to match.
  const opening = "<!-- wp:xb/text ";
  const words: string[] = [];
  for (let at = value.indexOf(opening); at !== -1 && words.length < 200; at = value.indexOf(opening, at + opening.length)) {
    const close = value.indexOf("/-->", at + opening.length);
    if (close === -1) break;
    let attrs: unknown;
    try { attrs = JSON.parse(value.slice(at + opening.length, close).trim()); } catch { continue; }
    const text = attrs && typeof attrs === "object" && typeof (attrs as Record<string, unknown>).content === "string" ? (attrs as Record<string, string>).content : "";
    const plainText = (text ?? "").slice(0, 2000).replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, "\"").replace(/\s+/gu, " ").trim();
    if (plainText) words.push(plainText);
  }
  return words.length ? words.join(" · ") : null;
}

/**
 * The order of a plan's list (doc 23 items 199-200): every conflict first, then what the transfer changes, then what is
 * on one side only, and what is already aligned last; the list is cut after PLAN_LIST_LIMIT entries, so a long project
 * never hides a conflict or a content only on the site behind its aligned pages.
 */
export const PLAN_LIST_LIMIT = 1000;
const LIST_RANK: Record<CmsSyncPlanStatus, number> = { conflict: 0, new: 1, update: 1, delete: 1, "remote-only": 2, "local-only": 2, unchanged: 3 };
export function planEntityList(entities: readonly CmsSyncPlanEntity[]): { entities: CmsSyncPlanEntity[]; omittedEntities: number } {
  const ordered = [...entities].sort((left, right) => LIST_RANK[left.status] - LIST_RANK[right.status]
    || left.status.localeCompare(right.status) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  return { entities: ordered.slice(0, PLAN_LIST_LIMIT), omittedEntities: Math.max(0, ordered.length - PLAN_LIST_LIMIT) };
}

export function compareEntityPayloads(
  local: StaticPageProfile["entities"][number],
  remote: StaticPageProfile["entities"][number],
): { comparison: CmsSyncFieldComparison[]; omittedComparisonFields: number } {
  const localPayload = local.payload as Record<string, unknown>;
  const remotePayload = remote.payload as Record<string, unknown>;
  const changedFields = [...new Set([...Object.keys(localPayload), ...Object.keys(remotePayload)])]
    .sort((left, right) => left.localeCompare(right))
    .filter((field) => {
      const hasLocal = Object.hasOwn(localPayload, field);
      const hasRemote = Object.hasOwn(remotePayload, field);
      return hasLocal !== hasRemote || canonicalizeJson(localPayload[field]) !== canonicalizeJson(remotePayload[field]);
    });
  const values: CmsSyncFieldComparison[] = local.kind === remote.kind ? [] : [{ field: "tipo entità", local: local.kind, remote: remote.kind }];
  values.push(...changedFields.map((field) => {
    const localText = Object.hasOwn(localPayload, field) ? readableContent(field, localPayload[field]) : null;
    const remoteText = Object.hasOwn(remotePayload, field) ? readableContent(field, remotePayload[field]) : null;
    // Doc 23 item 199: the words of a page say more to its owner than its block markup; the markup only when they match.
    if (localText !== null && remoteText !== null && localText !== remoteText) {
      return { field: "testo", local: comparisonValue(localText), remote: comparisonValue(remoteText) };
    }
    return {
      field,
      local: Object.hasOwn(localPayload, field) ? comparisonValue(localPayload[field]) : "(assente)",
      remote: Object.hasOwn(remotePayload, field) ? comparisonValue(remotePayload[field]) : "(assente)",
    };
  }));
  return {
    comparison: values.slice(0, MAX_COMPARISON_FIELDS),
    omittedComparisonFields: Math.max(0, values.length - MAX_COMPARISON_FIELDS),
  };
}

export function buildSyncDiff(
  action: CmsSyncAction,
  local: StaticPageProfile | null,
  remote: StaticPageProfile,
  knownBases: Map<string, string> = new Map(),
  localDraftProjection: StaticPageProfile | null = local,
): { counts: Record<CmsSyncPlanStatus, number>; entities: CmsSyncPlanEntity[] } {
  const tombstonableKinds = new Set(["document", "content-record", "component", "template-part", "template", "asset"]);
  const counts: Record<CmsSyncPlanStatus, number> = {
    new: 0,
    update: 0,
    delete: 0,
    unchanged: 0,
    "local-only": 0,
    "remote-only": 0,
    conflict: 0,
  };
  const localById = new Map((local?.entities ?? []).map((entity) => [entity.id, entity]));
  const localDraftById = new Map((localDraftProjection?.entities ?? []).map((entity) => [entity.id, entity]));
  const remoteById = new Map(remote.entities.map((entity) => [entity.id, entity]));
  const entities: CmsSyncPlanEntity[] = [];
  const add = (
    entity: StaticPageProfile["entities"][number],
    status: CmsSyncPlanStatus,
    canResolve = false,
    comparison?: ReturnType<typeof compareEntityPayloads>,
    blockedReason?: CmsSyncPlanEntity["blockedReason"],
    onSite?: CmsSyncPlanEntity["onSite"],
  ) => {
    counts[status] += 1;
    const documentType = entity.kind === "document" && (entity.payload.documentType === "page" || entity.payload.documentType === "post") ? entity.payload.documentType : undefined;
    entities.push({
      id: entity.id,
      kind: entity.kind,
      label: entityLabel(entity),
      status,
      canResolve,
      ...(comparison && comparison.comparison.length > 0 ? comparison : {}),
      ...(blockedReason ? { blockedReason } : {}),
      ...(documentType ? { documentType } : {}),
      ...(onSite ? { onSite } : {}),
    });
  };

  for (const incoming of action === "pull" ? remote.entities : (localDraftProjection?.entities ?? [])) {
    const current = action === "pull" ? localById.get(incoming.id) : remoteById.get(incoming.id);
    const base = knownBases.get(incoming.id) ?? incoming.baseHash ?? current?.baseHash;
    if (incoming.kind === "tombstone") {
      if (current?.kind === "tombstone" && current.revisionHash === incoming.revisionHash) {
        add(incoming, "unchanged");
        continue;
      }
      const previousHash = incoming.payload.previousRevisionHash;
      const safeDeletion = tombstonableKinds.has(String(incoming.payload.entityKind))
        && current !== undefined
        && current.kind === incoming.payload.entityKind
        && typeof previousHash === "string"
        && base === previousHash
        && current.revisionHash === previousHash;
      if (safeDeletion) add(incoming, "delete");
      else add(incoming, "conflict", false, undefined, tombstonableKinds.has(String(incoming.payload.entityKind)) ? "tombstone-conflict" : "tombstone-unsupported");
      continue;
    }
    if (current?.kind === "tombstone") {
      add(current, "conflict", false, undefined, "tombstone-conflict");
      continue;
    }
    if (!current) {
      // An entity removed on the receiving side after a common sync must not be silently resurrected.
      const wasPreviouslyShared =
        action === "pull" ? local !== null && Boolean(base || incoming.baseHash) : Boolean(base);
      add(incoming, wasPreviouslyShared ? "conflict" : "new", false, undefined, wasPreviouslyShared ? (action === "pull" ? "local-missing" : "remote-missing") : undefined);
      continue;
    }
    if (action === "pull") {
      const projectedLocal = localDraftById.get(incoming.id);
      const localUnchanged = Boolean(base && (current.revisionHash === base || projectedLocal?.revisionHash === base));
      const remoteUnchanged = Boolean(base && incoming.revisionHash === base);
      if (current.revisionHash === incoming.revisionHash || (localUnchanged && remoteUnchanged)) {
        add(incoming, "unchanged");
      } else if (localUnchanged && !remoteUnchanged) {
        add(incoming, "update");
      } else if (!localUnchanged && remoteUnchanged) {
        add(incoming, "local-only");
      } else {
        const canResolve = current.kind === incoming.kind;
        add(incoming, "conflict", canResolve, compareEntityPayloads(projectedLocal ?? current, incoming), canResolve ? undefined : "type-changed");
      }
    } else {
      const localUnchanged = Boolean(base && incoming.revisionHash === base);
      const remoteUnchanged = Boolean(base && current.revisionHash === base);
      if (current.revisionHash === incoming.revisionHash || (localUnchanged && remoteUnchanged)) {
        add(incoming, "unchanged");
      } else if (remoteUnchanged && !localUnchanged) {
        add(incoming, "update");
      } else if (localUnchanged && !remoteUnchanged) {
        // The site's version is the newer one: listed by its own title (doc 23 item 200).
        add(current, "remote-only", false, undefined, undefined, "changed-on-site");
      } else {
        const canResolve = current.kind === incoming.kind;
        add(incoming, "conflict", canResolve, compareEntityPayloads(incoming, current), canResolve ? undefined : "type-changed");
      }
    }
  }

  const source = action === "pull" ? (local?.entities ?? []) : remote.entities;
  const destination = action === "pull" ? remoteById : localById;
  for (const entity of source) {
    if (destination.has(entity.id)) continue;
    // On a send, WordPress's own mark only says it exported the entity once (its default categories, say): what counts
    // is whether this project ever shared it.
    const base = action === "pull" ? entity.baseHash ?? knownBases.get(entity.id) : knownBases.get(entity.id);
    const wasPreviouslyShared = Boolean(base);
    if (entity.kind === "tombstone") {
      add(entity, "conflict", false, undefined, tombstonableKinds.has(String(entity.payload.entityKind)) ? "tombstone-conflict" : "tombstone-unsupported");
      continue;
    }
    add(
      entity,
      wasPreviouslyShared ? "conflict" : action === "pull" ? "local-only" : "remote-only",
      false,
      undefined,
      wasPreviouslyShared ? (action === "pull" ? "remote-missing" : "local-missing") : undefined,
      !wasPreviouslyShared && action !== "pull" ? "only-on-site" : undefined,
    );
  }
  entities.sort(
    (left, right) =>
      left.status.localeCompare(right.status) ||
      left.label.localeCompare(right.label) ||
      left.id.localeCompare(right.id),
  );
  return { counts, entities };
}
