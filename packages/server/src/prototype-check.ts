import { createHash, randomUUID } from "node:crypto";
import { removeTemporary } from "./remove-temporary.js";
import { imageVariantSentence, type ImageVariantSummary } from "./image-variants.js";
import { brokenLinkWarnings, type BrokenLink } from "./prototype-links.js";
import { browserCheckWarnings, type AxeViolation, type PageOverflow } from "./prototype-verify.js";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { HistosPublishError } from "@histos-publish/core";
import { assertNativeBackupFits, buildPrototypeProfile, PICTURE_SKIP_TEXT, CmsProjectCatalog, CmsProjectChangedError, CmsSyncConflictError, createStaticPageProfile, formatPrototypeIssue, pageAddress, parsePrototype, postAddress, PrototypeError, strictResult, verifyPrototypeProfile, type CmsRenderOrigin, type PrototypeStrictResult, type PrototypeImportProgress, type CmsProjectStore, type PrototypeAssetFetcher, type PrototypeIssue, type PrototypeReport } from "@histos-publish/cms";
import type { StaticPageProfile } from "@histos-publish/histos-contract";
import { cmsRoutePlanProblems, MAX_CMS_BUILD_ROUTES, planCmsRoutes } from "./cms-api.js";
import { hideFilePaths } from "./http.js";
import { fetchPrototypeAsset } from "./prototype-assets.js";

export type PrototypeOutcome = "create" | "update" | "refused-duplicate";

/**
 * A refused prototype with every problem found (E4): the app lists them and the agent reads them one by one. `total`
 * counts them all when `issues` holds only the first ones (the importer keeps PROTOTYPE_ISSUES_KEPT).
 */
export class PrototypeInvalidError extends HistosPublishError {
  readonly total: number;
  constructor(message: string, readonly issues: readonly PrototypeIssue[], total = issues.length) {
    super(message, "cms-prototype-invalid", 422);
    this.total = Number.isSafeInteger(total) && total > issues.length ? total : issues.length;
  }
}

/**
 * A refusal listing `issues` (the first ones), worded as the importer words its own: one alone is the message, each
 * with its place when it has one (formatPrototypeIssue: "page contatti, riga 93: …").
 */
function issuesRefused(issues: PrototypeIssue[], total: number): PrototypeInvalidError {
  const counted = Math.max(total, issues.length);
  if (issues.length === 1 && counted === 1) return new PrototypeInvalidError(formatPrototypeIssue(issues[0]!), issues, 1);
  const more = counted - issues.length;
  return new PrototypeInvalidError(`Il prototipo ha ${counted} errori:\n${issues.map((issue, index) => `${index + 1}. ${formatPrototypeIssue(issue)}`).join("\n")}${more ? `\n… e altri ${more}: correggi questi e ricontrolla.` : ""}`, issues, counted);
}

/** Why the build does not build the site, with the prototype document it names when it names one. */
export interface BuildRefusal {
  message: string;
  /** How the issues name a document ("page chi-siamo", "template site/opera"): the check adds its line (locatedRefusal). */
  document?: string;
}

/**
 * A prototype whose site does not build (D8): the throwaway preview's build refused it (a renderer capability, a limit,
 * an argument a query refuses, missing content). Invalid like any other refused prototype, each reason an issue, so
 * that no check answers valid while the build fails; the preview is never merely "unavailable" for it.
 */
export function prototypeBuildRefused(reasons: readonly (string | BuildRefusal)[]): PrototypeInvalidError {
  const issues = reasons.slice(0, 100).map((reason): PrototypeIssue => {
    const { message, document } = typeof reason === "string" ? { message: reason, document: undefined } : reason;
    return { ...(document ? { document } : {}), message: `La versione del sito si ferma: ${message}` };
  });
  return issuesRefused(issues, reasons.length);
}

/**
 * A build stopped by an error that is neither the machine's (previewMachineFailure) nor one of the app's refusals: it
 * was thrown while the project's own content was rendered, so the site does not build. Its message only, never a
 * stack, with every path of this machine hidden (hideFilePaths: the home, `folders`, any absolute path). EEXIST is
 * two contents writing one file of the build (buildCmsProject stages each build in a folder of its own, under
 * histos-cms-stage-…/source, and writes each file once), named by its place in the site. `document` is the one whose
 * blocks were rendering when it was thrown, when a render threw it (refusalDocument).
 */
export function prototypeBuildFailed(error: unknown, folders: readonly string[], document?: string): PrototypeInvalidError {
  const { code, path: target } = (error ?? {}) as { code?: unknown; path?: unknown };
  if (code === "EEXIST") {
    const file = typeof target === "string" ? /[/\\]histos-cms-stage-[^/\\]+[/\\]source[/\\](.+)$/u.exec(target)?.[1]?.replaceAll("\\", "/") : undefined;
    return prototypeBuildRefused([`due contenuti scriverebbero lo stesso file della build${file ? `, ${file}` : ""}: cambia lo slug di uno dei due.`]);
  }
  const message = error instanceof Error && error.message.trim() ? hideFilePaths(error.message.trim(), error, folders) : "un errore inatteso, senza messaggio.";
  return prototypeBuildRefused([{ message, ...(document ? { document } : {}) }]);
}

/** Node's file-system codes that stop a build on this machine, in words: the machine's state, never the prototype's. */
const SYSTEM_FAILURES: Readonly<Record<string, string>> = {
  ENOSPC: "il disco è pieno",
  EDQUOT: "è finito lo spazio che questo utente può usare sul disco",
  EACCES: "mancano i permessi per usare la cartella dei dati o quella temporanea",
  EPERM: "mancano i permessi per usare la cartella dei dati o quella temporanea",
  EROFS: "la cartella dei dati o quella temporanea è in sola lettura",
  EMFILE: "ci sono troppi file aperti in questo momento",
  ENFILE: "ci sono troppi file aperti in questo momento",
  EIO: "il disco ha dato un errore di lettura o scrittura",
  EBUSY: "un file è occupato da un altro programma (per esempio l'antivirus)",
  ENOMEM: "la memoria non basta",
  EAGAIN: "il sistema è occupato",
  ENOENT: "un file che la build usava è sparito nel frattempo",
  ENAMETOOLONG: "un percorso di file della build è troppo lungo per questo sistema",
};

/** node:sqlite's primary result codes for a database or a disk that failed, never for what the content asks. */
const SQLITE_FAILURES: ReadonlyMap<number, string> = new Map([
  [3, "il database del progetto controllato non è accessibile"],
  [5, "il database del progetto controllato è occupato"],
  [6, "il database del progetto controllato è occupato"],
  [7, "la memoria non basta"],
  [8, "il database del progetto controllato è in sola lettura"],
  [10, "il disco ha dato un errore di lettura o scrittura"],
  [11, "il database del progetto controllato è danneggiato"],
  [13, "il disco è pieno"],
  [14, "il database del progetto controllato non si apre"],
  [26, "il database del progetto controllato è danneggiato"],
]);

/**
 * Why the preview could not be built on this machine, or null when the error is not the machine's: a system error
 * (Node's errno code, E…, as mkdtemp, mkdir, writeFile and the bundle's copy throw them; one without a sentence of its
 * own is named by its code; the content's errors never carry one), node:sqlite's for a database or a disk that
 * failed, an operation interrupted. In words, never with the path the error names.
 */
export function previewMachineFailure(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { code, errcode, name } = error as { code?: unknown; errcode?: unknown; name?: unknown };
  let reason: string | undefined;
  if (code === "ERR_SQLITE_ERROR") reason = typeof errcode === "number" ? SQLITE_FAILURES.get(errcode & 0xff) : undefined;
  else if (code === "ABORT_ERR" || name === "AbortError") reason = "la build è stata interrotta";
  // EEXIST is not the machine's: each build writes into a new folder of its own (prototypeBuildFailed).
  else if (typeof code === "string" && code !== "EEXIST" && /^E[A-Z0-9]{1,20}$/u.test(code)) reason = SYSTEM_FAILURES[code] ?? `il sistema ha risposto con l'errore ${code}`;
  return reason ? `La build dell'anteprima non è riuscita: ${reason}. Non dipende dal prototipo.` : null;
}

/**
 * The prototype documents whose pages the build writes, by address, as the check's issues name them: "/" → "page
 * home", "/chi-siamo/" → "page chi-siamo", "/blog/un-antico-sogno/" → "post un-antico-sogno" (a page first, as the
 * plan refuses two contents on one address anyway). A record or an archive is no document of the prototype (its
 * template is). Read once per check, whatever the number of problems it then places.
 */
export function documentAddresses(store: CmsProjectStore): ReadonlyMap<string, string> {
  const documents = new Map<string, string>();
  const defaultLocale = store.getRenderSettings().locale;
  for (const page of store.listPages()) {
    const address = pageAddress(page, defaultLocale);
    if (!documents.has(address)) documents.set(address, `page ${page.slug}`);
  }
  for (const post of store.listPosts()) {
    const address = postAddress(post, defaultLocale);
    if (!documents.has(address)) documents.set(address, `post ${post.slug}`);
  }
  return documents;
}

/**
 * The document a build refusal belongs to: the one whose blocks were rendering when it failed (`origin`, from the
 * renderer: cmsRenderOrigin), «template site/lista», «part site/testata», «component scheda», or, for the own content
 * of a page or post, the page or post at the address the message names («/chi-siamo/ (template site/page): …», as the
 * build words it). Without an origin (a refusal of the build, not of a render): the page or post at that address,
 * otherwise the template the message names (a record, an archive).
 */
export function refusalDocument(addresses: ReadonlyMap<string, string>, message: string, origin?: CmsRenderOrigin): string | undefined {
  if (origin && origin.kind !== "content") return `${origin.kind} ${origin.ref}`;
  const place = /^(\/[^\s()]*)(?: \(template ([^\s()]+)\))?: /u.exec(message);
  if (!place) return undefined;
  const document = addresses.get(place[1]!);
  if (document || origin) return document;
  return place[2] ? `template ${place[2]}` : undefined;
}

/** The page a file of the bundle is, by its address ("index.html" is /, "chi-siamo/index.html" /chi-siamo/). */
export function bundleFileAddress(file: string): string | null {
  if (file === "index.html") return "/";
  return file.endsWith("/index.html") && !file.startsWith("/") ? `/${file.slice(0, -"index.html".length)}` : null;
}

/** A finding of the preview's bundle that would stop publishing, with the document of its page when it is one. */
export interface PublishBlock {
  file: string;
  line?: number;
  message: string;
  document?: string;
}

/**
 * What the preview hands the check: the preview itself and, for a site that builds but whose bundle would be blocked
 * from publishing (a secret, a server path), the blocking findings, which the check turns into report warnings
 * (publishWarnings) and never gives out as part of the preview.
 */
export type PrototypePreviewOutcome = PrototypePreview & { publishBlocks?: { items: PublishBlock[]; total: number } };

type PrototypeDocuments = ReturnType<typeof parsePrototype>["documents"];

/** The line of the file where the document the issues call `name` starts ("page home", "template site/opera"). */
function documentLine(documents: PrototypeDocuments, name: string): number | undefined {
  return documents.find((item) => `${item.kind} ${item.attributes["data-ref"] ?? item.attributes["data-slug"] ?? "?"}` === name)?.line;
}

/**
 * The preview's refusal with each issue placed in the prototype: the line where the document it names starts. A name
 * no document of the prototype has is dropped, so that no issue points at a document that is not there.
 */
function locatedRefusal(error: PrototypeInvalidError, documents: PrototypeDocuments): PrototypeInvalidError {
  if (!error.issues.some((issue) => issue.document !== undefined && issue.line === undefined)) return error;
  const issues = error.issues.map((issue): PrototypeIssue => {
    if (issue.document === undefined || issue.line !== undefined) return issue;
    const line = documentLine(documents, issue.document);
    const { document, ...rest } = issue;
    return line ? { document, line, ...rest } : rest;
  });
  return issuesRefused(issues, error.total);
}

/**
 * Doc 17 item 1: one warning for each rule of the CSS that left images with only their `src`, with how many, as the
 * build found them page by page. A rule the check already named (pageWideImageRules, the same text) is not said twice.
 */
export function imageCssWarnings(images: ImageVariantSummary, warnings: readonly string[]): string[] {
  const prefix = `${PICTURE_SKIP_TEXT.css} (`;
  const out: string[] = [];
  for (const item of images.skipped) {
    if (!item.reason.startsWith(prefix)) continue;
    const rule = item.reason.slice(prefix.length, -1);
    const bare = rule.replace(/ \(:has\(\) intorno all'immagine\)$/u, "");
    if (warnings.some((warning) => warning.includes(`: ${bare}`) && warning.includes("toglie i formati moderni"))) continue;
    out.push(`Immagini moderne: la regola ${rule} toglie i formati moderni (JPEG XL, AVIF, WebP) a ${item.count === 1 ? "un'immagine" : `${item.count} immagini`}: cambiala come dice il manuale, §3.1.`);
  }
  return out;
}

/**
 * The report warnings for a bundle blocked from publishing: «La pubblicazione si fermerebbe: <file>, riga N:
 * <message>», then the prototype document the file comes from when it is a page or a post, with its line.
 */
function publishWarnings(blocks: { items: PublishBlock[]; total: number }, documents: PrototypeDocuments): string[] {
  const warnings = blocks.items.map((block) => {
    const line = block.document ? documentLine(documents, block.document) : undefined;
    const origin = block.document && line ? ` Il file viene da ${block.document}, riga ${line} del prototipo.` : "";
    return `La pubblicazione si fermerebbe: ${block.file}${block.line ? `, riga ${block.line}` : ""}: ${block.message}${origin}`;
  });
  const more = blocks.total - blocks.items.length;
  return more > 0 ? [...warnings, `La pubblicazione si fermerebbe anche per altri ${more} problemi.`] : warnings;
}

/**
 * The addresses the build would write, from the build's own plan (planCmsRoutes) on the checked project: two contents
 * on one address, more routes than a build writes, a type's archive over its records, a bundle certainly over its
 * limits (more files than it takes, or more bytes than 250 MiB in the CSS every page inlines alone). Refused here, with
 * each problem an issue, rather than at the first build: the same messages the build would give, all of them.
 */
async function routeIssues(verified: CmsProjectCatalog, projectId: string, signal?: AbortSignal): Promise<void> {
  const opened = await verified.openProject(projectId);
  if (!opened) return;
  let problems: { messages: string[]; total: number };
  try {
    const { store } = opened;
    const pages = store.listPages().filter((page) => page.status === "published");
    const posts = store.listPosts().filter((post) => post.status === "published");
    try {
      problems = cmsRoutePlanProblems(planCmsRoutes(store, { pages, posts, maxRoutes: MAX_CMS_BUILD_ROUTES, check: () => signal?.throwIfAborted() }), MAX_CMS_BUILD_ROUTES);
    } catch (error) {
      if (!(error instanceof HistosPublishError) || error.code !== "cms-build-content-limit") throw error;
      problems = { messages: [error.message], total: 1 };
    }
  } finally {
    opened.store.close();
  }
  if (problems.messages.length) throw issuesRefused(problems.messages.map((message) => ({ message })), problems.total);
}

/** The refusal of a prototype as the server reports it; `file` names it when several are read together (A4). */
export function prototypeInvalid(error: TypeError | RangeError, file?: string): PrototypeInvalidError {
  const issues = error instanceof PrototypeError ? error.issues : [{ message: error.message }];
  // The importer's count of every problem, when it has one; otherwise the list is the whole.
  const total = error instanceof PrototypeError ? (error as { total?: unknown }).total : undefined;
  return new PrototypeInvalidError(file ? `${file}: ${error.message}` : error.message, file ? issues.map((issue) => ({ ...issue, document: issue.document ? `${file} · ${issue.document}` : file })) : issues, typeof total === "number" ? total : issues.length);
}

/**
 * A throwaway build of the checked prototype (queue A2): an address for the user, or why there is none. "built" only
 * from a check with no server to show it (checkPrototypeBuild, the CLI's `prototype check --preview`): the site builds,
 * `note` says that there is no address and where a preview is.
 */
/**
 * Doc 17 item 4, what the preview checks: the pages read and the internal links that lead nowhere (at most 50, with
 * `brokenTotal` when there are more); with a browser (the app's hidden window, `histos-publish prototype verify`) the
 * pages opened at 1440 and 390 px, those that scroll sideways and the axe rules they fail (checkBuiltPages). Without a
 * browser (`prototype check --preview`) only the links.
 */
/**
 * Doc 23 item 239: the browser checks of this app, by the prototype's SHA-256, for the import to say whether the file
 * it imports was opened in a browser and with what result. Only checks that opened pages count; at most 100 kept,
 * the oldest going first, in this process only.
 */
const browserChecks = new Map<string, { opened: number; overflow: number; axe: number }>();

function rememberBrowserCheck(html: string, verify: PreviewVerify): void {
  const key = createHash("sha256").update(html).digest("hex");
  browserChecks.delete(key);
  browserChecks.set(key, { opened: verify.opened ?? 0, overflow: (verify.overflow?.length ?? 0) + (verify.edges?.length ?? 0), axe: (verify.axe?.length ?? 0) + (verify.brokenImages?.length ?? 0) });
  while (browserChecks.size > 100) browserChecks.delete(browserChecks.keys().next().value!);
}

/** What the import says of the browser check of this file: nothing when it passed, else one sentence. */
export function browserCheckNote(html: string): string | null {
  const check = browserChecks.get(createHash("sha256").update(html).digest("hex"));
  if (!check) return "Verifica nel browser: questo file non è stato aperto in un browser (scorrimento a 1440 e 390 px, accessibilità). Controllalo con «Controlla» e l'anteprima nell'app, hp_check_prototype con preview: true o histos-publish prototype verify.";
  if (!check.overflow && !check.axe) return null;
  const parts = [check.axe ? (check.axe === 1 ? "una regola di accessibilità non rispettata" : `${check.axe} regole di accessibilità non rispettate`) : "", check.overflow ? (check.overflow === 1 ? "una pagina che scorre di lato" : `${check.overflow} pagine che scorrono di lato`) : ""].filter(Boolean);
  return `Verifica nel browser: il controllo di questo file ha trovato ${parts.join(" e ")}. I dettagli sono negli avvisi del controllo: correggili prima di pubblicare.`;
}

export interface PreviewVerify {
  pages: number;
  brokenLinks: BrokenLink[];
  brokenTotal?: number;
  opened?: number;
  overflow?: PageOverflow[];
  axe?: AxeViolation[];
  /** Doc 23 item 242: pages with images the browser could not show, and with text touching a side. */
  brokenImages?: Array<{ page: string; images: string[] }>;
  edges?: Array<{ page: string; width: number; elements: string[] }>;
  note?: string;
  failures?: string[];
}

export type PrototypePreview =
  | { status: "ready"; buildId: string; previewUrl: string; expiresAt: string; findings: number; images?: ImageVariantSummary; verify?: PreviewVerify }
  | { status: "unavailable"; reason: string; findings?: number }
  | { status: "built"; findings: number; note: string; images?: ImageVariantSummary; verify?: PreviewVerify };

/** One entity an update would touch, by kind and the name the user knows. */
export interface PrototypeChange {
  id: string;
  kind: string;
  label: string;
}

/**
 * What updating the project with this prototype would do (queue D2): computed by applying it to a copy of the project
 * in the scratch folder, so it is exactly what the import does. With conflicts the import would stop and change
 * nothing.
 */
export interface PrototypeChanges {
  added: PrototypeChange[];
  modified: PrototypeChange[];
  removed: PrototypeChange[];
  /** Changed in Publish only: the update keeps them as they are. */
  keptLocal: PrototypeChange[];
  conflicts: PrototypeChange[];
  unchanged: number;
  /** Items beyond CHANGES_KEPT, per list. */
  omitted: number;
  /**
   * What the comparison was made against: the project's revision and the prototype's own digest. An update approved
   * later runs only if both are still the same, so the user never approves something other than what was shown.
   */
  basis: { projectRevision: string; profileDigest: string };
}

/** One value for a built prototype: its entities and their revisions (remote media bytes included). */
export function profileDigest(profile: StaticPageProfile): string {
  const hash = createHash("sha256");
  for (const line of profile.entities.map((entity) => `${entity.id}:${entity.revisionHash}`).sort()) hash.update(`${line}\n`);
  return hash.digest("hex");
}

const CHANGES_KEPT = 200;

export interface PrototypeCheckResult {
  check: true;
  valid: boolean;
  /** What an import into the given catalog would do; "create" when no catalog was given. */
  outcome: PrototypeOutcome;
  report: PrototypeReport;
  /** Only when a preview was asked for. */
  preview?: PrototypePreview;
  /**
   * Only for an update: what would change in the project. Missing only with `changesNeedDownload`, with the
   * `backupUnavailable` of an update checked with `askDownloadForUpdate` before its downloads, or if the project went
   * away during the check.
   */
  changes?: PrototypeChanges;
  /**
   * Only for an update whose backup would not fit the backup's limits (512 MiB, 9,999 media): why. Every update saves a
   * backup of the project first, from the app as from the agent, so this update cannot run; the changes are still given.
   */
  backupUnavailable?: string;
  /**
   * Only for an update checked with `askDownloadForUpdate` and placeholders for its remote media: there are no
   * `changes` and no `preview` (see checkPrototype), and the check must run again with `download` to have them.
   */
  changesNeedDownload?: true;
  /**
   * Only for a check asked as strict (F1, `prototype check --severo`): the house rules of the guides as problems, with
   * every warning of the report that asks for a change; `passed` when none is an error.
   */
  strict?: PrototypeStrictResult;
}

type ProfileEntity = StaticPageProfile["entities"][number];

/** The kind the user sees: a document is a page or a post. */
function changeKind(entity: ProfileEntity | undefined, fallback: string): string {
  if (!entity) return fallback;
  if (entity.kind === "document") return entity.payload.documentType === "post" ? "post" : "page";
  if (entity.kind === "tombstone" && typeof entity.payload.entityKind === "string") return entity.payload.entityKind === "document" ? "page" : entity.payload.entityKind;
  return entity.kind;
}

function changeLabel(entity: ProfileEntity | undefined): string {
  for (const key of ["title", "label", "name", "filename", "slug", "key"]) {
    const value = entity?.payload[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  }
  return "";
}

/**
 * Applies the prototype to a copy of the project in `scratch` and says what changed (see PrototypeChanges). The copy
 * is made on disk (a snapshot of the database, hard links to the media), with no archive in memory and no size limit;
 * the profiles below still read the media, as the import itself does. The revision, the profile before and the local
 * edits are read from the copy, so they all come from one consistent snapshot. The comparison has no size limit, but
 * the backup every update saves first has. The copy measured exactly what that backup holds (its database snapshot as
 * written, each media file once), the same sizes the update measures on its own snapshot, so whether the backup fits is
 * answered here as the update will answer it; and the copy refused what a restore of that backup would refuse.
 */
async function prototypeChanges(catalog: CmsProjectCatalog, built: { profile: StaticPageProfile; files: Map<string, Buffer> }, scratch: string, signal?: AbortSignal): Promise<{ changes: PrototypeChanges; backupUnavailable?: string } | undefined> {
  const projectId = built.profile.manifest.project.id;
  const copies = new CmsProjectCatalog(path.join(scratch, "changes"), { durable: false });
  const copy = await catalog.copyProjectForComparison(projectId, copies, signal);
  if (!copy) return undefined;
  let before: StaticPageProfile;
  let projectRevision: string;
  let backupUnavailable: string | undefined;
  /** Changed in Publish since the last import and not in the prototype: the import leaves them as they are. */
  const localOnly = new Set<string>();
  try {
    projectRevision = copy.store.getProjectRevision();
    // The copy's own sizes, nothing read: a RangeError is a backup limit, which stops the update but not the comparison.
    try { assertNativeBackupFits(copy.project, copy.backup); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      backupUnavailable = error.message;
    }
    before = (await createStaticPageProfile(copy.project, copy.store)).profile;
    const current = new Map(before.entities.map((entity) => [entity.id, entity]));
    for (const entity of built.profile.entities) {
      const base = copy.store.getSyncBase(projectId, entity.id);
      const local = current.get(entity.id);
      if (base && local && local.revisionHash !== base.baseHash && entity.revisionHash === base.baseHash) localOnly.add(entity.id);
    }
  } finally {
    copy.store.close();
  }
  signal?.throwIfAborted();
  const local = new Map(before.entities.map((entity) => [entity.id, entity]));
  const remote = new Map(built.profile.entities.map((entity) => [entity.id, entity]));
  const item = (id: string, fallbackKind = "document"): PrototypeChange => {
    const entity = remote.get(id) ?? local.get(id);
    const label = changeLabel(remote.get(id)) || changeLabel(local.get(id));
    return { id, kind: changeKind(entity, fallbackKind), label };
  };
  const result: PrototypeChanges = { added: [], modified: [], removed: [], keptLocal: [], conflicts: [], unchanged: 0, omitted: 0, basis: { projectRevision, profileDigest: profileDigest(built.profile) } };
  const push = (list: PrototypeChange[], value: PrototypeChange) => {
    if (list.length < CHANGES_KEPT) list.push(value);
    else result.omitted += 1;
  };
  try {
    const applied = await copies.importRemoteStaticPageProfile(built.profile, built.files, projectId);
    for (const id of applied.changed) push(remote.get(id)?.kind === "tombstone" ? result.removed : local.has(id) ? result.modified : result.added, item(id));
    for (const id of new Set([...applied.keptLocal, ...localOnly])) push(result.keptLocal, item(id));
    result.unchanged = applied.unchanged.filter((id) => !localOnly.has(id)).length;
  } catch (error) {
    if (!(error instanceof CmsSyncConflictError)) throw error;
    for (const conflict of error.conflicts) push(result.conflicts, item(conflict.id, conflict.kind));
  }
  return { changes: result, ...(backupUnavailable ? { backupUnavailable } : {}) };
}

/**
 * What an update of project `projectId` needs of the project as it is now, checked before its remote media are
 * downloaded (askDownloadForUpdate), so that the user does not wait for every download to learn that the update cannot
 * run: the backup every update saves first, measured and read as that backup measures and reads it
 * (CmsProjectStore.withBackupSnapshot: its database copy passes the restore's checks, each media file is there and
 * still has the bytes of its sha256 name). Nothing is copied and nothing built: a refusal is the one the dry run
 * (prototypeChanges) throws, a damaged project (CmsBackupUnrestorableError) or a file another program holds (EPERM,
 * EACCES, EBUSY); a backup over its limits is its reason (the RangeError's message), as the dry run gives it, and no
 * media file is read for it. The project gone meanwhile is not refused here: the check with the downloads says so.
 * The copy of the database lives next to the project's for the measure only, as for the update's own (private,
 * removed when the measure settles).
 */
async function updateReadiness(catalog: CmsProjectCatalog, projectId: string, signal?: AbortSignal): Promise<string | undefined> {
  const opened = await catalog.openProject(projectId);
  if (!opened) return undefined;
  try {
    return await opened.store.withBackupSnapshot(async ({ sizes, read }) => {
      try { assertNativeBackupFits(opened.project, sizes); }
      catch (error) {
        if (error instanceof RangeError) return error.message;
        throw error;
      }
      // One file at a time, as the backup reads them: `read` refuses one whose bytes no longer match its name.
      for (const media of sizes.media) {
        signal?.throwIfAborted();
        await read(media.path);
      }
      return undefined;
    });
  } finally {
    opened.store.close();
  }
}

/**
 * Checks a Histeon prototype as an import would, and writes nothing outside a private scratch folder that is always
 * removed (docs/progettazione/histos-cms/15-coda-import-html.md, A1), but the private copy of the project's database
 * that updateReadiness measures for a moment, as the update does. Remote media stand in as placeholders unless
 * `download` is set. A refusal is a HistosPublishError with code `cms-prototype-invalid` and the file line. The site's
 * addresses are planned as its build plans them (routeIssues): two contents on one address or a site over the route
 * limit refuse the prototype too, with every problem. With `preview`, the project imported into the scratch catalog is
 * handed over to be built before the folder goes (A2); a preview that throws the check's refusal (the site does not
 * build: buildPrototypePreview, also for a site with only drafts, whose published content is still rendered) makes the
 * check invalid, each problem placed at the document it names; one merely "unavailable" does not, nor one whose bundle
 * would be blocked from publishing, whose findings become warnings.
 *
 * `askDownloadForUpdate`: an update checked with placeholders for its remote media is answered as soon as it is known
 * to be one (the prototype parsed, built and verified, so `valid` still means valid) and the project can take it
 * (updateReadiness), with `changesNeedDownload` and neither the dry run nor the preview. Compared with placeholders
 * every remote media reads as modified, and one whose alt text was edited in Publish as a conflict, so both would be
 * thrown away; the caller checks again with `download`, and that check alone makes them, once. A project the update
 * cannot change is refused as the dry run refuses it, before any download; an update whose backup would not fit is
 * answered with `backupUnavailable` instead of `changesNeedDownload`, as it cannot run whatever the media.
 */
export async function checkPrototype(html: string, options: { scratchRoot: string; download?: boolean; askDownloadForUpdate?: boolean; strict?: boolean; fetchAsset?: PrototypeAssetFetcher; catalog?: CmsProjectCatalog; signal?: AbortSignal; onProgress?: (progress: PrototypeImportProgress) => void; convertedMedia?: (sha256: string) => Uint8Array | null; preview?: (opened: { project: { id: string }; store: CmsProjectStore }, signal?: AbortSignal) => Promise<PrototypePreviewOutcome> }): Promise<PrototypeCheckResult> {
  const invalid = (error: unknown): never => {
    if (error instanceof TypeError || error instanceof RangeError) throw prototypeInvalid(error);
    throw error;
  };
  let parsed: ReturnType<typeof parsePrototype>;
  try { parsed = parsePrototype(html); }
  catch (error) { throw error instanceof TypeError || error instanceof RangeError ? prototypeInvalid(error) : new HistosPublishError(error instanceof Error ? error.message : "Prototipo non valido.", "cms-prototype-invalid", 422); }
  await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = path.join(options.scratchRoot, `.prototype-check-${randomUUID()}`);
  try {
    // Private from the start: the copy for the changes holds hard links to the project's media.
    await mkdir(scratch, { mode: 0o700 });
    let built: Awaited<ReturnType<typeof buildPrototypeProfile>>;
    const verified = new CmsProjectCatalog(path.join(scratch, "verify"), { durable: false });
    try {
      const signal = options.signal ? { signal: options.signal } : {};
      const progress = options.onProgress ? { onProgress: options.onProgress } : {};
      const kept = options.convertedMedia ? { convertedMedia: options.convertedMedia } : {};
      const strict = options.strict ? { strict: true } : {};
      built = await buildPrototypeProfile(parsed, new CmsProjectCatalog(path.join(scratch, "build"), { durable: false }), options.download ? { fetchAsset: options.fetchAsset ?? fetchPrototypeAsset, ...signal, ...progress, ...kept, ...strict } : { remotePlaceholders: true, ...signal, ...progress, ...kept, ...strict });
      await verifyPrototypeProfile(built, verified);
    } catch (error) { return invalid(error); }
    // Before the comparison and the preview: the site's addresses, as its build would plan them.
    await routeIssues(verified, built.report.project.id, options.signal);
    let outcome: PrototypeOutcome = "create";
    const existing = options.catalog ? await options.catalog.openProject(built.report.project.id) : null;
    if (existing) {
      outcome = existing.store.hasSyncBases(built.report.project.id) ? "update" : "refused-duplicate";
      existing.store.close();
    }
    // An update that the caller checks again with its media downloaded: no dry run, no throwaway preview build, only
    // what the update needs of the project as it is now (updateReadiness), refused here and not after the downloads.
    const askDownload = outcome === "update" && options.askDownloadForUpdate === true && !options.download && built.report.placeholders.length > 0;
    // D2: an update shows what it would change, from a dry run on a copy of the project.
    let changes: PrototypeChanges | undefined;
    let backupUnavailable: string | undefined;
    if (outcome === "update" && options.catalog) {
      try {
        if (askDownload) backupUnavailable = await updateReadiness(options.catalog, built.report.project.id, options.signal);
        else {
          const compared = await prototypeChanges(options.catalog, built, scratch, options.signal);
          changes = compared?.changes;
          backupUnavailable = compared?.backupUnavailable;
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        // The project changed while it was copied (the app saved a media file meanwhile): nothing is invalid, the check
        // only has to run again. A cms- code, so the app's routes answer 409 too, not 500.
        if (error instanceof CmsProjectChangedError) throw new HistosPublishError("Il progetto è cambiato durante il confronto: ripeti il controllo.", "cms-project-changed", 409);
        const code = (error as { code?: unknown } | null)?.code;
        // The project itself is damaged (CmsBackupUnrestorableError: a media file that no longer matches its name, a
        // database its restore refuses): the backup every update saves first could not be restored, so no update is
        // offered. Not the prototype's fault, so not cms-transfer-invalid.
        if (error instanceof TypeError && code === "cms-backup-unrestorable") throw new HistosPublishError(`${error.message} Prima di aggiornare salvo un backup del progetto, e questo backup non si potrebbe ripristinare: l'aggiornamento non si può fare.`, "cms-backup-unrestorable", 422);
        // A file of the project held by another program even after the retries (on Windows an antivirus scan refuses
        // renames for a moment), or not readable: nothing to fix in the prototype. Never a 500 with local paths.
        if (code === "EPERM" || code === "EACCES" || code === "EBUSY") throw new HistosPublishError("Un file del progetto non è accessibile in questo momento, forse perché un altro programma (per esempio l'antivirus) lo tiene aperto: ripeti il controllo tra poco. Se l'errore resta, controlla i permessi della cartella dei dati.", "cms-project-busy", 409);
        // The same refusal the import would give: the dry run is the import's own code on a copy of the project, so a
        // RangeError (a limit of the project's content, never its size since the copy is on disk and the backup's
        // limits are reported apart) stops the update too.
        if (error instanceof TypeError || error instanceof RangeError) throw new HistosPublishError(error.message, "cms-transfer-invalid", 422);
        throw error;
      }
    }
    // An update whose backup would not fit cannot run: said at once, with nothing to download for it.
    // F1: the strict check's answer, with the warnings of the report as it is given.
    const strictOf = (warnings: readonly string[]) => (options.strict ? { strict: strictResult(built.strict ?? [], warnings) } : {});
    if (askDownload) return { check: true, valid: true, outcome, report: built.report, ...(backupUnavailable ? { backupUnavailable } : { changesNeedDownload: true as const }), ...strictOf(built.report.warnings) };
    let preview: PrototypePreview | undefined;
    let report = built.report;
    // A prototype that cannot be imported gets no preview.
    if (options.preview && outcome !== "refused-duplicate") {
      options.signal?.throwIfAborted();
      const opened = await verified.openProject(built.report.project.id);
      if (!opened) throw new HistosPublishError("Il progetto controllato non è leggibile per l'anteprima.", "cms-prototype-preview-failed", 500);
      // The preview shows the products with the shop the import gives the project (queue C6).
      if (built.shop) opened.store.setShopSettings(built.shop);
      let previewed: PrototypePreviewOutcome;
      try {
        previewed = await options.preview(opened, options.signal);
      } catch (error) {
        // The site does not build: the refusal, with the place of each problem in the prototype.
        throw error instanceof PrototypeInvalidError ? locatedRefusal(error, parsed.documents) : error;
      } finally {
        opened.store.close();
      }
      const { publishBlocks, ...shown } = previewed;
      preview = shown as PrototypePreview;
      // A site that builds but would not be published: valid, with what would stop it first among the warnings.
      if (publishBlocks?.items.length) report = { ...report, warnings: [...publishWarnings(publishBlocks, parsed.documents), ...report.warnings] };
      // B6: the build measured the variants (and checked each page's CSS): its words replace the import's estimate.
      const measured = preview.status !== "unavailable" && preview.images ? imageVariantSentence(preview.images) : null;
      if (measured && report.images) report = { ...report, images: { ...report.images, note: measured } };
      const cssWarnings = preview.status !== "unavailable" && preview.images ? imageCssWarnings(preview.images, report.warnings) : [];
      if (cssWarnings.length) report = { ...report, warnings: [...report.warnings, ...cssWarnings] };
      // Doc 17 item 4: the internal links of the built pages that lead nowhere.
      const verify = preview.status !== "unavailable" ? preview.verify : undefined;
      if (verify?.brokenLinks.length) report = { ...report, warnings: [...report.warnings, ...brokenLinkWarnings({ brokenLinks: verify.brokenLinks, brokenTotal: verify.brokenTotal ?? verify.brokenLinks.length })] };
      // With a browser: the pages that scroll sideways at 1440 or 390 px and the axe rules they fail.
      if (verify?.overflow || verify?.axe || verify?.failures || verify?.brokenImages || verify?.edges) report = { ...report, warnings: [...report.warnings, ...browserCheckWarnings({ overflow: verify.overflow ?? [], axe: verify.axe ?? [], ...(verify.brokenImages ? { brokenImages: verify.brokenImages } : {}), ...(verify.edges ? { edges: verify.edges } : {}), ...(verify.failures ? { failures: verify.failures } : {}) })] };
      if (verify?.opened) rememberBrowserCheck(html, verify);
    }
    return { check: true, valid: outcome !== "refused-duplicate", outcome, report, ...(preview ? { preview } : {}), ...(changes ? { changes } : {}), ...(backupUnavailable ? { backupUnavailable } : {}), ...strictOf(report.warnings) };
  } finally {
    await removeTemporary(scratch);
  }
}
