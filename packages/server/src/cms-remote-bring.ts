import { HistosPublishError } from "@histos-publish/core";
import type { StaticPageProfile, TransferEntity } from "@histos-publish/histos-contract";
import type { CmsSyncPlanEntity } from "./cms-remote-catalog.js";
import { UUID } from "./cms-remote-transport.js";
import { entityLabel } from "./cms-remote-diff.js";

/**
 * Doc 23 items 199-200: a download of only some entries of the site. «Porta nel progetto» brings contents that are only
 * on the site (or that the site changed); «Risolvi i conflitti» downloads only the conflicts, so they can be settled
 * without bringing in everything else the site has. The server decides what the plan takes: the chosen entries and,
 * transitively, what they need that the project does not have (their media, components, template, terms, type).
 * What the project already has (by id, a template also by ref) stays the project's.
 *
 * Never chosen nor taken: the global styles (one for the whole project) and deletions; they come only with a whole
 * «Scarica aggiornamenti».
 */

export const MAX_BRING_IDS = 500;
const NOT_BRINGABLE = new Set(["styles", "tombstone"]);

export function parseBringIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BRING_IDS || value.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw new HistosPublishError(`Scegli da 1 a ${MAX_BRING_IDS} contenuti del sito, con un identificativo valido.`, "cms-remote-bring-invalid", 400);
  }
  return [...new Set(value as string[])];
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value : [value])
  .filter((item): item is string => typeof item === "string")
  .map((item) => item.startsWith("histos-media://") ? item.slice("histos-media://".length) : item);

/** What one entity of the site needs to exist in a project, by id. */
function dependencies(entity: TransferEntity, remote: StaticPageProfile, byKey: (kind: string, key: string) => TransferEntity | undefined, typeFields: (typeKey: string) => Array<Record<string, unknown>>): string[] {
  const payload = entity.payload as Record<string, unknown>;
  const out = remote.references.filter((reference) => reference.ownerId === entity.id).map((reference) => reference.targetId);
  const templateByRef = (ref: unknown) => { if (typeof ref === "string") { const template = byKey("template", ref); if (template) out.push(template.id); } };
  const terms = (value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) for (const ids of Object.values(value as Record<string, unknown>)) out.push(...stringList(ids));
  };
  if (entity.kind === "document") {
    templateByRef(payload.templateRef);
    if (typeof payload.image === "string") out.push(payload.image);
    terms(payload.terms);
  } else if (entity.kind === "content-record") {
    if (typeof payload.typeKey === "string") {
      const type = byKey("content-type", payload.typeKey);
      if (type) out.push(type.id);
      const values = payload.values && typeof payload.values === "object" && !Array.isArray(payload.values) ? payload.values as Record<string, unknown> : {};
      for (const field of typeFields(payload.typeKey)) {
        if (typeof field.key !== "string") continue;
        if (field.type === "relation" || field.type === "image") out.push(...stringList(values[field.key]));
      }
    }
    terms(payload.terms);
  } else if (entity.kind === "term") {
    if (typeof payload.parentId === "string") out.push(payload.parentId);
    if (typeof payload.taxonomyKey === "string") { const taxonomy = byKey("taxonomy", payload.taxonomyKey); if (taxonomy) out.push(taxonomy.id); }
  } else if (entity.kind === "content-type") {
    templateByRef(payload.singleTemplateRef);
    templateByRef(payload.archiveTemplateRef);
    for (const field of Array.isArray(payload.fields) ? payload.fields as Array<Record<string, unknown>> : []) {
      if (field.type === "relation" && typeof field.targetType === "string") { const target = byKey("content-type", field.targetType); if (target) out.push(target.id); }
    }
  } else if (entity.kind === "taxonomy") {
    for (const key of stringList(payload.types)) { const type = byKey("content-type", key); if (type) out.push(type.id); }
  }
  return out.filter((id) => UUID.test(id) && id !== entity.id);
}

/**
 * The entries a partial download takes, from the plan of a whole download (`pullEntities`, built on the same two
 * profiles). A chosen entry must be new for the project, changed only on the site, or a conflict that can be settled;
 * one already aligned or changed only in the project is dropped (nothing to bring). A needed entry the project lacks
 * is taken too, and must itself be new for the project: anything else stops the plan with its name.
 */
export function bringClosure(input: {
  requested: readonly string[];
  remote: StaticPageProfile;
  local: StaticPageProfile;
  pullEntities: readonly CmsSyncPlanEntity[];
}): string[] {
  const remoteById = new Map(input.remote.entities.map((entity) => [entity.id, entity]));
  const localIds = new Set(input.local.entities.map((entity) => entity.id));
  const localTemplateRefs = new Set(input.local.entities.filter((entity) => entity.kind === "template").map((entity) => String(entity.payload.ref)));
  const status = new Map(input.pullEntities.map((entity) => [entity.id, entity]));
  const keyed = new Map<string, TransferEntity>();
  for (const entity of input.remote.entities) {
    const key = entity.kind === "template" ? entity.payload.ref : entity.kind === "content-type" || entity.kind === "taxonomy" ? entity.payload.key : undefined;
    if (typeof key === "string") keyed.set(`${entity.kind}\0${key}`, entity);
  }
  const byKey = (kind: string, key: string) => (kind === "template" && localTemplateRefs.has(key) ? undefined : keyed.get(`${kind}\0${key}`));
  const typeFields = (typeKey: string) => {
    const type = keyed.get(`content-type\0${typeKey}`) ?? input.local.entities.find((entity) => entity.kind === "content-type" && entity.payload.key === typeKey);
    return Array.isArray(type?.payload.fields) ? type.payload.fields as Array<Record<string, unknown>> : [];
  };
  const named = (entity: TransferEntity) => `«${entityLabel(entity)}»`;
  const taken = new Set<string>();
  const queue: Array<{ id: string; neededBy: TransferEntity | null }> = input.requested.map((id) => ({ id, neededBy: null }));
  while (queue.length) {
    const { id, neededBy } = queue.shift()!;
    if (taken.has(id)) continue;
    const entity = remoteById.get(id);
    if (!entity) {
      if (neededBy === null) throw new HistosPublishError("Un contenuto scelto non c'è più sul sito: controlla di nuovo l'invio prima di portarlo nel progetto.", "cms-remote-bring-missing", 409);
      // A media or component the site names but does not hold: the site's own reading would have refused it.
      continue;
    }
    if (NOT_BRINGABLE.has(entity.kind)) {
      throw new HistosPublishError(`${named(entity)} non si porta da solo nel progetto: per gli stili e le cancellazioni usa «Scarica aggiornamenti».`, "cms-remote-bring-unsupported", 409);
    }
    const plan = status.get(id);
    if (neededBy === null) {
      // Already aligned, or changed only in the project: nothing to bring.
      if (!plan || plan.status === "unchanged" || plan.status === "local-only") continue;
      if (plan.status === "conflict" && !plan.canResolve) {
        throw new HistosPublishError(`${named(entity)} è in conflitto in un modo che non si risolve scaricando: guardalo nel piano di invio.`, "cms-remote-bring-blocked", 409);
      }
      if (plan.status !== "new" && plan.status !== "update" && plan.status !== "conflict") continue;
    } else if (plan?.status !== "new") {
      throw new HistosPublishError(`${named(neededBy)} usa ${named(entity)}, che il progetto non ha e non si può portare insieme: usa «Scarica aggiornamenti».`, "cms-remote-bring-dependency", 409);
    }
    taken.add(id);
    for (const dependency of dependencies(entity, input.remote, byKey, typeFields)) {
      if (!taken.has(dependency) && !localIds.has(dependency)) queue.push({ id: dependency, neededBy: entity });
    }
  }
  if (taken.size === 0) throw new HistosPublishError("Niente da portare nel progetto: i contenuti scelti sono già uguali o cambiati solo nel progetto.", "cms-remote-bring-empty", 409);
  return [...taken].sort();
}
