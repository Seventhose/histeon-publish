<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { api, ApiError, download, fetchImportReport, followJob, initializeSession, ImportError, uploadFile, uploadTransferArchive, type ImportReportView } from "./lib/api.js";
  import { availableCmsDeployTargets, cmsDeployTargetLabel, type CmsDeploySite } from "./lib/cms-deploy.js";
  import { readProposalChoices, type ProposalChoice } from "./lib/proposals-file.js";
  import IconActivity from "@lucide/svelte/icons/activity";
  import IconHelp from "@lucide/svelte/icons/circle-help";
  import IconSettings from "@lucide/svelte/icons/settings";
  import IconSites from "@lucide/svelte/icons/layout-grid";
  import IconSparkles from "@lucide/svelte/icons/sparkles";
  import IconTrash from "@lucide/svelte/icons/trash-2";
  import CmsContentPanel from "./CmsContentPanel.svelte";
  import SiteAdmin from "./admin/SiteAdmin.svelte";
  import DeleteDialog from "./DeleteDialog.svelte";
  import FolderDialog, { type FolderChoice } from "./FolderDialog.svelte";
  import ConnectorPanel from "./ConnectorPanel.svelte";
  import { hasMessage, plural, stateLabel, translate, type Language, type StateTone } from "./lib/i18n.js";
  import CardMenu from "./app/CardMenu.svelte";
  import CmsAdvancedPanel from "./app/CmsAdvancedPanel.svelte";
  import CmsImportZone from "./app/CmsImportZone.svelte";
  import CmsNoticesPanel from "./app/CmsNoticesPanel.svelte";
  import CmsPublishPanel from "./app/CmsPublishPanel.svelte";
  import CmsRemoteRollbackDialog from "./app/CmsRemoteRollbackDialog.svelte";
  import FrontPageOffer, { type FrontPageOfferView } from "./app/FrontPageOffer.svelte";
  import CmsRollbackDialog from "./app/CmsRollbackDialog.svelte";
  import CmsSyncDialog from "./app/CmsSyncDialog.svelte";
  import CmsTemplatesPanel from "./app/CmsTemplatesPanel.svelte";
  import CmsTrashDialog from "./app/CmsTrashDialog.svelte";
  import CmsUnlinkDialog from "./app/CmsUnlinkDialog.svelte";
  import DatabaseRemoveDialog from "./app/DatabaseRemoveDialog.svelte";
  import DomainDialog from "./app/DomainDialog.svelte";
  import FirstSiteDialog from "./app/FirstSiteDialog.svelte";
  import FolderBar from "./app/FolderBar.svelte";
  import GuideScreen from "./app/GuideScreen.svelte";
  import HistoryScreen from "./app/HistoryScreen.svelte";
  import HomeConnections from "./app/HomeConnections.svelte";
  import ImportUpdateDialog from "./app/ImportUpdateDialog.svelte";
  import ProposalPickDialog from "./app/ProposalPickDialog.svelte";
  import ProposalCaptureDialog, { type CapturedProposalPage } from "./app/ProposalCaptureDialog.svelte";
  import NewSiteScreen from "./app/NewSiteScreen.svelte";
  import PickBar from "./app/PickBar.svelte";
  import PrototypeCheckDialog from "./app/PrototypeCheckDialog.svelte";
  import ImportRefineSettings from "./app/ImportRefineSettings.svelte";
  import PrototypeProblemsPanel from "./app/PrototypeProblemsPanel.svelte";
  import ReportScreen from "./app/ReportScreen.svelte";
  import SettingsScreen from "./app/SettingsScreen.svelte";
  import ShortcutsDialog from "./app/ShortcutsDialog.svelte";
  import SiteDeployDialog from "./app/SiteDeployDialog.svelte";
  import SiteFormsSettings from "./app/SiteFormsSettings.svelte";
  import SiteHostingFields from "./app/SiteHostingFields.svelte";
  import SiteJobProgress from "./app/SiteJobProgress.svelte";
  import SiteRollbackDialog from "./app/SiteRollbackDialog.svelte";
  import SiteSourceCard from "./app/SiteSourceCard.svelte";
  import SiteWordPressTools from "./app/SiteWordPressTools.svelte";
  import StyleSpreadDialog from "./app/StyleSpreadDialog.svelte";
  import TrashScreen from "./app/TrashScreen.svelte";
  import { deployFailure, formatBytes as formatBytesIn, formatDate as formatDateIn } from "./lib/app-format.js";
  import type { Bootstrap, CmsSiteCheck, BuildResult, CloudflareAccount, ConversionOptions, ImportRefineSettingsView, RefineView, CmsBuild, CmsBuildDeployment, CmsProject, CmsProjectDetails, CmsPublishPlan, CmsPublishedHomeCheck, CmsRemoteConnection, CmsRemoteOperation, CmsRemoteOperationState, CmsSyncConflictChoice, CmsSyncPlan, CmsTab, CmsTemplate, CmsTermInfo, DatabaseConnection, DeleteKind, DeployTarget, DomainPlan, FolderInfo, HistoryData, HostingAuthMethod, HostingDirectoryInspection, HostingProtocol, ImportFramework, ImportProgressView, JobState, ListKind, PrototypeCheckView, PrototypeIssueView, PrototypeProblemsView, PrototypeReport, Screen, Site, SiteConversionView, SiteStructureChoice, SiteStructureView, SourceKind, TrashEntry, UploadEntry, WordPressPreflight, WordPressProvisionPlan } from "./lib/app-types.js";

  let screen = $state<Screen>("home");
  /** The section of the site administration on screen (doc 21), part of its address. */
  let adminSection = $state("bacheca");
  let settingsTab = $state<"account" | "database" | "data">("account");
  let wordPressAddress = $state("");
  /** One site's look brought to the other sites of a folder: first what would change, then the change. */
  let styleSpread = $state<{ from: string; ids: string[]; results: Array<{ id: string; name: string; changes: string[]; applied: boolean }> | null } | null>(null);
  async function previewSpread(): Promise<void> {
    if (!styleSpread) return;
    const { from, ids } = styleSpread;
    styleSpread.results = (await api<{ results: NonNullable<NonNullable<typeof styleSpread>["results"]> }>("/api/cms/v1/projects/spread-design", { method: "POST", body: JSON.stringify({ from, to: ids }) })).results;
  }
  async function applySpread(): Promise<void> {
    if (!styleSpread) return;
    const { from, ids } = styleSpread;
    const { results } = await api<{ results: Array<{ applied: boolean }> }>("/api/cms/v1/projects/spread-design", { method: "POST", body: JSON.stringify({ from, to: ids, apply: true }) });
    styleSpread = null;
    successMessage = t("spread.done", { n: results.filter((entry) => entry.applied).length });
  }
  /** The first site, by three questions: name, kind, language. */
  let firstSite = $state<{ step: number; name: string; kind: "rivista" | "negozio" | "vuoto"; locale: string } | null>(null);
  let siteQuery = $state("");
  /** What the last import from WordPress left out: it stays on screen until read, a notice would go away. */
  let wordPressReport = $state<{ projectId: string; pages: number; posts: number; images: { saved: number; failed: number }; lost: Record<string, number>; skipped: Record<string, number>; failed: string[]; articles: Array<{ title: string; lost: Record<string, number> }>; featuredImages?: { posts: number; removedFromText: string[] } } | null>(null);
  /** The app's colours, remembered on this computer. */
  let theme = $state<"system" | "light" | "dark">("system");
  function setTheme(next: "system" | "light" | "dark"): void {
    theme = next;
    try { localStorage.setItem("histos-theme", next); } catch { /* It is only a preference. */ }
    void window.histosDesktop?.setTheme?.(next);
  }
  let showShortcuts = $state(false);
  let language = $state<Language>("it");
  let bootstrap = $state<Bootstrap | null>(null);
  let sites = $state<Site[]>([]);
  let selectedSite = $state<Site | null>(null);
  let cmsProjects = $state<CmsProject[]>([]);
  // Projects that exist on disk but do not open: shown, never hidden.
  let cmsUnavailableProjects = $state<Array<{ id: string; message: string }>>([]);
  let cmsConnections = $state<CmsRemoteConnection[]>([]);
  let cmsSyncPlan = $state<CmsSyncPlan | null>(null);
  let cmsSyncConnection = $state<CmsRemoteConnection | null>(null);
  let cmsSyncChoices = $state<Record<string, CmsSyncConflictChoice | "">>({});
  let cmsRemoteRollback = $state<{ connection: CmsRemoteConnection; operation: CmsRemoteOperation; resumePartial: boolean } | null>(null);
  let cmsUnlink = $state<{ connection: CmsRemoteConnection; remoteRevocationFailed: boolean } | null>(null);
  let cmsFrontPageOffer = $state<{ connectionId: string; projectId: string; host: string; offer: FrontPageOfferView } | null>(null);
  let selectedCmsProject = $state<CmsProjectDetails | null>(null);
  let cmsTrashSelection = $state<string[]>([]);
  let cmsTrashConnectionId = $state("");
  let showCmsTrashConfirm = $state(false);
  let cmsContentPanelKey = $state(0);
  let cmsProjectName = $state("");
  // ------------------------------------------------------------------ deleting CMS projects and sites
  /** «Seleziona» on the catalog (CMS projects) or on «I tuoi siti»: the cards get a box, and a bar deletes them. */
  let pickMode = $state<"cms" | "sites" | null>(null);
  let picked = $state<string[]>([]);
  /** The right-click menu of a card. */
  let cardMenu = $state<{ x: number; y: number; kind: "cms" | "sites"; id: string; name: string } | null>(null);
  /** Moving to the Cestino ("trash") or deleting from it for good ("purge"); each item says what it is. */
  let deleting = $state<{ mode: "trash" | "purge"; kind: DeleteKind | "mixed"; items: Array<{ id: string; name: string; kind: DeleteKind }> } | null>(null);
  let trash = $state<{ retentionDays: number; projects: TrashEntry[]; sites: TrashEntry[] } | null>(null);
  const trashItems = $derived(trash ? [...trash.projects.map((item) => ({ ...item, kind: "project" as const })), ...trash.sites.map((item) => ({ ...item, kind: "site" as const }))] : []);
  const trashDays = $derived(trash?.retentionDays ?? 30);

  // The menu takes the focus when it opens (its first entry), so the keyboard reaches it too.
  $effect(() => {
    if (!cardMenu) return;
    void tick().then(() => document.querySelector<HTMLElement>(".card-menu [role=menuitem]")?.focus());
  });

  /** The card a Shift+click selects from: the last one picked or unpicked. */
  let pickAnchor: string | null = null;
  function startPicking(kind: "cms" | "sites", first?: string): void {
    pickMode = kind;
    picked = first ? [first] : [];
    pickAnchor = first ?? null;
  }
  function stopPicking(): void {
    pickMode = null;
    picked = [];
    pickAnchor = null;
  }
  function togglePicked(id: string, on: boolean): void {
    picked = on ? [...new Set([...picked, id])] : picked.filter((value) => value !== id);
  }
  /** A right click, or the menu key on a focused card: the menu opens where the pointer is, or under the card. */
  function openCardMenu(event: MouseEvent, kind: "cms" | "sites", id: string, name: string): void {
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX || rect.left + 24;
    const y = event.clientY || rect.top + 40;
    cardMenu = { x: Math.min(x, window.innerWidth - 240), y: Math.min(y, window.innerHeight - 170), kind, id, name };
  }
  function askDelete(kind: "cms" | "sites", items: Array<{ id: string; name: string }>): void {
    cardMenu = null;
    const itemKind: DeleteKind = kind === "cms" ? "project" : "site";
    if (items.length) deleting = { mode: "trash", kind: itemKind, items: items.map((item) => ({ ...item, kind: itemKind })) };
  }
  /** «Elimina definitivamente» on a row of the Cestino, or «Svuota il Cestino» with all of them. */
  function askPurge(items: Array<{ id: string; name: string; kind: DeleteKind }>): void {
    if (!items.length) return;
    const kinds = new Set(items.map((item) => item.kind));
    deleting = { mode: "purge", kind: kinds.size === 1 ? items[0]!.kind : "mixed", items };
  }
  async function loadTrash(): Promise<void> {
    try {
      trash = await api<{ retentionDays: number; projects: TrashEntry[]; sites: TrashEntry[] }>("/api/trash");
    } catch {
      // The Cestino stays as it was read; the next refresh reads it again.
    }
  }
  // ------------------------------------------------------------------ folders of CMS projects and of sites
  let folders = $state<{ folders: FolderInfo[]; members: Record<ListKind, Record<string, string>> }>({ folders: [], members: { cms: {}, sites: {} } });
  /** The folder open in each list, null for the top. */
  let openFolder = $state<Record<ListKind, string | null>>({ cms: null, sites: null });
  let folderDialog = $state<{ mode: "create" | "rename" | "move"; kind: ListKind; folderId?: string; items: Array<{ id: string; name: string }>; current: string | null; name: string } | null>(null);
  /** The item being dragged onto a folder card (or the picked ones, when it is among them). */
  let dragging = $state<{ kind: ListKind; ids: string[] } | null>(null);
  let dropFolder = $state<string | null>(null);

  async function loadFolders(): Promise<void> {
    try {
      folders = await api<typeof folders>("/api/folders");
    } catch {
      // The folders stay as they were read; the next refresh reads them again.
    }
  }
  const folderListOf = (kind: ListKind) => folders.folders.filter((folder) => folder.kind === kind).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const folderOf = (kind: ListKind, id: string): string | null => folders.members[kind][id] ?? null;
  /** The open folder, if it still exists. */
  const currentFolder = (kind: ListKind): FolderInfo | null => folders.folders.find((folder) => folder.id === openFolder[kind] && folder.kind === kind) ?? null;
  /** What the list shows: the open folder's items, or at the top those in no folder. */
  function visibleItems<T extends { id: string; name?: string }>(kind: ListKind, list: T[]): T[] {
    const query = siteQuery.trim().toLowerCase();
    if (query) return list.filter((item) => (item.name ?? "").toLowerCase().includes(query));
    const inside = currentFolder(kind)?.id ?? null;
    return list.filter((item) => folderOf(kind, item.id) === inside);
  }
  function enterFolder(kind: ListKind, id: string | null): void {
    openFolder = { ...openFolder, [kind]: id };
    picked = [];
    pickAnchor = null;
    cardMenu = null;
  }
  function askFolder(mode: "create" | "rename" | "move", kind: ListKind, items: Array<{ id: string; name: string }> = [], folder?: FolderInfo): void {
    cardMenu = null;
    const places = [...new Set(items.map((item) => folderOf(kind, item.id)))];
    folderDialog = { mode, kind, items, current: places.length === 1 ? places[0]! : null, name: folder?.name ?? "", ...(folder ? { folderId: folder.id } : {}) };
  }
  async function moveItems(kind: ListKind, ids: string[], folderId: string | null): Promise<void> {
    await api("/api/folders/move", { method: "POST", body: JSON.stringify({ kind, ids, folderId }) });
  }
  /** What the folder dialog asked: returns the reason it could not, for the dialog to show. */
  async function submitFolder(choice: FolderChoice): Promise<string | null> {
    if (!folderDialog) return null;
    const { mode, kind, items, folderId } = folderDialog;
    busy = true;
    try {
      if (mode === "rename" && folderId) {
        await api(`/api/folders/${encodeURIComponent(folderId)}`, { method: "PATCH", body: JSON.stringify({ name: choice.name }) });
        successMessage = t("folder.renamed");
      } else {
        let target = choice.target;
        if (mode === "create" || target === "new") {
          target = (await api<{ folder: FolderInfo }>("/api/folders", { method: "POST", body: JSON.stringify({ kind, name: choice.name }) })).folder.id;
          successMessage = t("folder.created", { name: choice.name });
        }
        if (mode === "move" && items.length) {
          await moveItems(kind, items.map((item) => item.id), target);
          successMessage = t("folder.moved", { count: items.length });
          picked = [];
          if (pickMode === kind) stopPicking();
        }
      }
      folderDialog = null;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      await loadFolders();
    }
  }
  async function removeFolder(folder: FolderInfo): Promise<void> {
    await api(`/api/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" });
    enterFolder(folder.kind, null);
    await loadFolders();
    successMessage = t("folder.deleted", { name: folder.name });
  }
  function startDrag(event: DragEvent, kind: ListKind, id: string): void {
    const ids = pickMode === kind && picked.includes(id) ? [...picked] : [id];
    dragging = { kind, ids };
    event.dataTransfer?.setData("text/plain", ids.join("\n"));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  function overFolder(event: DragEvent, kind: ListKind, folderId: string | null): void {
    if (dragging?.kind !== kind) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dropFolder = folderId ?? "";
  }
  async function dropOnFolder(event: DragEvent, kind: ListKind, folderId: string | null): Promise<void> {
    event.preventDefault();
    const moving = dragging;
    dragging = null;
    dropFolder = null;
    if (moving?.kind !== kind) return;
    const ids = moving.ids.filter((id) => folderOf(kind, id) !== folderId);
    if (!ids.length) return;
    await moveItems(kind, ids, folderId);
    await loadFolders();
    successMessage = t("folder.moved", { count: ids.length });
    if (pickMode === kind) stopPicking();
  }
  /**
   * While «Seleziona» is on, a click anywhere on a card (its buttons too) picks it or takes it back; the box itself
   * works as a box. Ctrl+click (⌘ on a Mac) does the same, and starts the selection when it is off. Shift+click adds
   * every card from the last one clicked to this one, in the order on screen; with none clicked yet, just this one.
   */
  function pickCardClick(event: MouseEvent, kind: ListKind, id: string): void {
    const toggle = event.ctrlKey || event.metaKey;
    const range = event.shiftKey;
    if (pickMode !== kind && !toggle && !range) return;
    if ((event.target as Element | null)?.closest(".card-pick") && !range) {
      pickAnchor = id;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (pickMode !== kind) startPicking(kind);
    const order = visibleItems<{ id: string }>(kind, kind === "cms" ? cmsProjects : sites).map((item) => item.id);
    const from = pickAnchor ? order.indexOf(pickAnchor) : -1;
    const to = order.indexOf(id);
    if (range && from >= 0 && to >= 0) {
      picked = [...new Set([...picked, ...order.slice(Math.min(from, to), Math.max(from, to) + 1)])];
      return;
    }
    togglePicked(id, !picked.includes(id));
    pickAnchor = id;
  }
  /** Shift+click would select the text between two clicks: not on the cards (listened on the document). */
  function noShiftSelect(event: MouseEvent): void {
    if (event.shiftKey && (event.target as Element | null)?.closest?.(".site-card")) event.preventDefault();
  }

  async function restoreItem(item: { id: string; name: string; kind: DeleteKind }): Promise<void> {
    await api(`/api/trash/${item.kind === "project" ? "projects" : "sites"}/${encodeURIComponent(item.id)}/restore`, { method: "POST", body: "{}" });
    await refresh();
    successMessage = t("trash.restored", { name: item.name });
  }
  function pickedItems(kind: "cms" | "sites"): Array<{ id: string; name: string }> {
    const list: Array<{ id: string; name: string }> = kind === "cms" ? cmsProjects : sites;
    return list.filter((item) => picked.includes(item.id)).map((item) => ({ id: item.id, name: item.name }));
  }
  /** One request per item, with its name; what failed stays in the dialog, what went leaves the lists. */
  async function deleteItems(chosen: Array<{ id: string; name: string }>): Promise<Array<{ id: string; message: string }>> {
    if (!deleting) return [];
    const { mode, kind } = deleting;
    const items = deleting.items.filter((item) => chosen.some((one) => one.id === item.id));
    busy = true;
    const failures: Array<{ id: string; message: string }> = [];
    let done = 0;
    try {
      for (const item of items) {
        try {
          const id = encodeURIComponent(item.id);
          const url = mode === "purge" ? `/api/trash/${item.kind === "project" ? "projects" : "sites"}/${id}` : item.kind === "project" ? `/api/cms/v1/projects/${id}` : `/api/sites/${id}`;
          await api(url, { method: "DELETE", body: JSON.stringify({ confirmName: item.name }) });
          done++;
        } catch (error) {
          failures.push({ id: item.id, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      busy = false;
    }
    await refresh();
    picked = picked.filter((id) => failures.some((failure) => failure.id === id));
    if (done) successMessage = mode === "purge" ? t(done === 1 ? "purge.doneOne" : "purge.dones", { count: done }) : t(`delete.done${kind === "project" ? "Project" : "Site"}${done === 1 ? "One" : "s"}`, { count: done });
    if (!failures.length) {
      deleting = null;
      if (!picked.length) stopPicking();
    } else deleting = { mode, kind, items: items.filter((item) => failures.some((failure) => failure.id === item.id)) };
    return failures;
  }

  let cmsTemplateTitle = $state("");
  let cmsTemplateRef = $state("site/page");
  let cmsTemplatePartTitle = $state("");
  let cmsTemplatePartRef = $state("site/header");
  let cmsRenderLocale = $state("it-IT");
  /** B6: modern image variants in the project's builds. */
  let cmsImageVariants = $state(true);
  let cmsRenderTimeZone = $state("Europe/Rome");
  let cmsPairingCode = $state("");
  let cmsPairingTargetId = $state("");
  let cmsCatalogFilter = $state<"all" | "local" | "connected">("all");
  let cmsBuild = $state<CmsBuild | null>(null);
  let cmsBuilding = $state(false);
  /**
   * Notices (E11): a stack of at most three. Successes close by themselves after a few seconds (paused while the
   * pointer or the focus is on them), errors stay until closed or until the next action. The code keeps writing
   * successMessage and errorMessage; an effect moves each message into the stack, with an optional action.
   */
  interface Toast { id: number; kind: "success" | "error"; text: string; agent: boolean; action?: ToastAction; remaining: number; detail?: string }
  interface ToastAction { label: string; href?: string; run?: () => void }
  let toasts = $state<Toast[]>([]);
  let toastSeq = 0;
  let toastsPaused = $state(false);
  let nextToastAction: ToastAction | null = null;
  let nextToastFromAgent = false;
  const TOAST_SUCCESS_MS = 6_000;
  /** E9: one file input for prototypes, .xbsite and .histosproject; the app recognizes the file. */
  let cmsImportInput = $state<HTMLInputElement | null>(null);
  /** E9: an HTML picked in "Nuovo sito" that is a Histeon prototype. */
  let newSitePrototype = $state<File | null>(null);
  let newSiteDesign = $state<File | null>(null);
  /** The import button that opened the file chooser, to give it the focus back after the update dialog. */
  let cmsImportOpener = $state<HTMLElement | null>(null);
  let cmsImportUpdate = $state<{ file: File; project: { id: string; name: string } } | null>(null);
  /** A kit proposte file: the client's choice of its proposal comes before the conversion (Q5). */
  let cmsProposalPick = $state<{ file: File; title: string; groups: Array<{ id: string; name: string }>; proposals: ProposalChoice[] } | null>(null);
  /** «Fotografa la proposta»: an uploaded page drawn by its scripts, shown alive in a sealed frame before the conversion. */
  let cmsProposalCapture = $state<{ file: File; importId: string; url: string; reasons: string[] } | null>(null);
  /** A prototype checked before its import, with a throwaway preview (queue A2). */
  let cmsPrototypeCheck = $state<{ file: File; result: PrototypeCheckView; conversion?: SiteConversionView & { downloadUrl: string } } | null>(null);
  let cmsPrototypeProblems = $state<PrototypeProblemsView | null>(null);
  let cmsPrototypeProblemsPanel = $state<HTMLElement | null>(null);
  /** The structure the user is choosing in the check dialog (B3), before converting again. */
  let cmsStructureChoice = $state<SiteStructureChoice>({ parts: false, components: false, lists: false });
  let cmsBuildSummary = $state<HTMLElement | null>(null);
  /** The report of the last prototype import of the open project (D1), and its panel for the focus. */
  let cmsImportReport = $state<ImportReportView | null>(null);
  let cmsImportReportPanel = $state<HTMLElement | null>(null);
  /** Doc 18 §9 (F7): the import reports the project keeps, newest first. */
  let cmsImportHistory = $state<Array<{ id: string; createdAt: string; file: string | null; result: string | null }>>([]);
  /** E6: the other ways to publish, also when the project already has destinations. */
  let cmsPublishWaysOpen = $state(false);
  /** E6: a static site's ready build, waiting for "Conferma e pubblica" after the summary. */
  let siteDeploySummary = $state<{ siteId: string; build: BuildResult; target: DeployTarget; destination: string; label: string } | null>(null);
  let siteDeployOpener = $state<HTMLElement | null>(null);
  let cmsBuildHistory = $state<CmsBuild[]>([]);
  /** What visitors see now: the newest publication that went through. */
  const cmsLiveDeploymentId = $derived(cmsBuildHistory.flatMap((build) => build.deployments ?? []).filter((deployment) => deployment.status === "deployed").sort((left, right) => String(right.completedAt ?? "").localeCompare(String(left.completedAt ?? "")))[0]?.id ?? null);
  let cmsDeployHealthCheck = $state<CmsPublishedHomeCheck | null>(null);
  let cmsPublishPlan = $state<CmsPublishPlan | null>(null);
  let cmsPublishPlanConfirmed = $state(false);
  let cmsDeploySiteId = $state("");
  let cmsWordPressSetupSiteId = $state("");
  let cmsRollback = $state<{ projectId: string; buildId: string; deploymentId: string; destinationId: string; destinationName: string; provider: "cloudflare" | "hosting"; worker: string; versionId: string } | null>(null);
  let report = $state<BuildResult | null>(null);
  let historyData = $state<HistoryData>({ builds: [], deploys: [] });
  let remoteHistory = $state<{ deployments: Array<Record<string, unknown>>; versions: Array<Record<string, unknown>>; note?: string } | null>(null);
  let activeJob = $state<JobState | null>(null);
  let errorMessage = $state("");
  let successMessage = $state("");
  let busy = $state(false);
  let showDomainSummary = $state(false);
  let domainPlan = $state<DomainPlan | null>(null);
  let showRollback = $state<Record<string, unknown> | null>(null);
  let progressFilter = $state("all");

  const cmsTrashConnections = $derived(cmsConnections.filter((connection) => connection.write && (!connection.projectId || connection.projectId === selectedCmsProject?.project.id)));

  let urlInput = $state("");
  let pendingLocalImport = $state<{ url: string; name: string } | null>(null);
  // Doc 23 item 237: a pairing started here and confirmed on the site, waiting for the user's yes.
  let pendingPairing = $state<{ state: string; claim: string; siteUrl: string } | null>(null);
  let pairingSiteUrl = $state("");
  let detection = $state<Record<string, unknown> | null>(null);
  let consentOrigin = $state("");
  let consentLocalOrigin = $state(false);
  let siteName = $state("");
  let workerName = $state("");
  let accountId = $state("");
  let domain = $state("");
  let includeWww = $state(true);
  /** The account's active zones, by name: «Collega anche www» shows only for a zone's main domain (voce 230). */
  let domainZones = $state<string[] | null>(null);
  const wwwApplies = $derived.by(() => {
    const host = domain.trim().toLowerCase().replace(/\.$/u, "");
    return domainZones?.some((zone) => host === zone || host === `www.${zone}`) ?? false;
  });
  let renderMode = $state(false);
  let pagefindEnabled = $state(false);
  let formsRestUrl = $state("");
  let formsIds = $state("");
  let kvNames = $state("");
  /** KV archives the site's Worker code uses (from the latest version) and the field does not declare: Publish binds them itself. */
  let foundKv = $derived.by(() => {
    const declared = new Set(kvNames.split(/[\s,;]+/u).filter(Boolean).map((value) => value.split("=")[0]?.trim() ?? ""));
    return (report?.worker?.kv ?? []).filter((name) => !declared.has(name));
  });
  /** The KV archives Publish wrote into the site's settings (found in the Worker code) join the field; typed ones stay. */
  function mergeSavedKv(site: Site | null): void {
    if (!site) return;
    const typed = kvNames.split(/[\s,;]+/u).filter(Boolean);
    const bound = new Set(typed.map((value) => value.split("=")[0]?.trim() ?? ""));
    const missing = (site.kv ?? []).filter((value) => !bound.has(value.split("=")[0] ?? ""));
    if (missing.length > 0) kvNames = [...typed, ...missing].join(", ");
  }

  /** Names in the field that differ from a name of the code only in case: env.VOTI is not «voti». */
  let kvCaseMismatches = $derived.by(() => {
    const found = report?.worker?.kv ?? [];
    return kvNames.split(/[\s,;]+/u).filter(Boolean).map((value) => value.split("=")[0]?.trim() ?? "")
      .flatMap((name) => found.filter((used) => used !== name && used.toLowerCase() === name.toLowerCase()).map((used) => ({ name, used })));
  });
  let turnstileSiteKey = $state("");
  let turnstileSecret = $state("");
  let basicUser = $state("");
  let basicPassword = $state("");
  let cookie = $state("");
  let selectedFiles = $state<UploadEntry[]>([]);
  let importKind = $state<"directory" | "html" | "zip">("directory");
  let importId = $state("");
  let importProgress = $state(0);
  let sourceReplacementProgress = $state(0);
  let sourceDropActive = $state(false);
  let cmsArchiveDropActive = $state(false);
  let sourceZipSummary = $state("");
  let localImportNotice = $state("");
  let settingsToken = $state("");
  let settingsTokenState = $state<{ configured: boolean; source: string | null; available: boolean } | null>(null);
  let cloudflareAccounts = $state<CloudflareAccount[]>([]);
  let settingsAccountId = $state("");
  let settingsLanguage = $state<Language>("it");
  let databaseConnections = $state<DatabaseConnection[]>([]);
  let databaseConnectionName = $state("");
  let databaseHost = $state("");
  let databasePort = $state(3306);
  let databaseName = $state("");
  let databaseTablePrefix = $state("wp_");
  let databaseUsername = $state("");
  let databasePassword = $state("");
  let databaseCaCertificate = $state("");
  let databaseUseSshTunnel = $state(false);
  let databaseSshHost = $state("");
  let databaseSshPort = $state(22);
  let databaseSshUsername = $state("");
  let databaseSshAuthMethod = $state<"password" | "privateKey">("password");
  let databaseSshPassword = $state("");
  let databaseSshPrivateKey = $state("");
  let databaseSshPassphrase = $state("");
  let databaseSshHostKeyFingerprint = $state("");
  let databaseSshHostKeyIdentity = $state("");
  let databaseSshHostKeyConfirmed = $state(false);
  let editingDatabaseConnectionId = $state<string | null>(null);
  let databaseRemoval = $state<DatabaseConnection | null>(null);
  let wordpressDatabaseConnectionId = $state("");
  let wordpressPreflight = $state<WordPressPreflight | null>(null);
  let wordpressProvisionPlans = $state<WordPressProvisionPlan[]>([]);
  let wordpressProvisionPlan = $state<WordPressProvisionPlan | null>(null);
  let wordpressProvisionSiteTitle = $state("");
  let wordpressProvisionAdminUsername = $state("admin");
  let wordpressProvisionAdminEmail = $state("");
  let wordpressProvisionAdminPassword = $state("");
  let wpUser = $state("");
  let wpPassword = $state("");
  let wpCookie = $state("");
  let deployTarget = $state<DeployTarget>("cloudflare");
  let hostingProtocol = $state<HostingProtocol>("ftps");
  let hostingHost = $state("");
  let hostingPort = $state(21);
  let hostingRemoteDirectory = $state("");
  let hostingPublicUrl = $state("");
  let hostingUsername = $state("");
  let hostingPassword = $state("");
  let hostingAuthMethod = $state<HostingAuthMethod>("password");
  let hostingPrivateKey = $state("");
  let hostingPassphrase = $state("");
  let hostingTlsCaCertificate = $state("");
  let hostingTlsCaFilename = $state("");
  let hostingHostKeyFingerprint = $state("");
  let observedHostingHostKeyFingerprint = $state("");
  let hostingHostKeyConfirmed = $state(false);
  let hostingDirectoryInspection = $state<HostingDirectoryInspection | null>(null);
  let allowInsecureFtp = $state(false);

  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const say = (italian: string, english: string) => language === "it" ? italian : english;
  /** "1 articolo", "2 articoli": `{key}.one` or `{key}.other` by the language's plural rules (E13). */
  const n = (key: string, count: number, values: Record<string, string | number> = {}) => plural(language, key, count, values);
  /** One name and tone per state, the same everywhere (E13). */
  const stateOf = (status: string) => stateLabel(language, status);

  /** The state of a site, the same on the home card, in Activity and on the site screen. */
  function siteState(site: Site): { label: string; tone: StateTone } {
    if (site.needsBuild) return stateOf("stale");
    if (site.lastBuild) return stateOf(site.lastBuild.status);
    if (site.lastAttempt) return stateOf(site.lastAttempt.status);
    return stateOf("new");
  }

  /** The newest operation of a site for Activity: the last attempt, even a cancelled one, or the site's build. */
  function activityState(site: Site): { label: string; tone: StateTone } {
    const latest = site.lastAttempt ?? site.lastBuild;
    return latest ? stateOf(latest.status) : stateOf("added");
  }

  $effect(() => {
    // Screen readers and the browser's spelling and hyphenation follow the app's language.
    document.documentElement.lang = language;
  });
  let showSandboxFallback = $state(false);
  const wordPressDatabaseTlsStatus = (runtime: WordPressPreflight["runtime"]) => {
    if (!runtime.phpChecked) return say("TLS dal runtime PHP non ancora verificato.", "PHP-side TLS has not been checked yet.");
    if (runtime.databaseTlsVerified) return say("Connessione PHP → database cifrata e certificato host verificato.", "PHP → database connection is encrypted and the host certificate is verified.");
    if (runtime.databaseTlsFailure === "client-unsupported") return say("Il runtime usa un client MySQL diverso da mysqlnd; la verifica del certificato non è supportata da questo flusso.", "This PHP runtime uses a MySQL client other than mysqlnd; certificate verification is not supported by this flow.");
    if (runtime.databaseTlsFailure === "tls-not-active") return say("Il database ha risposto senza attivare TLS. L’installazione è bloccata.", "The database responded without TLS. Installation is blocked.");
    if (runtime.databaseTlsFailure === "ca-temp-file-failed") return say("Il server PHP non è riuscito a preparare il certificato CA temporaneo.", "The PHP server could not prepare the temporary CA certificate.");
    if (runtime.databaseTlsFailure === "ca-unavailable") return say("Il server PHP non ha CA di sistema per verificare il database: incolla il certificato CA del database.", "The PHP server has no system CAs to verify the database: paste the database CA certificate.");
    return say("Il server PHP non ha verificato il certificato del database. Controlla accesso remoto, CA e nome host.", "The PHP server could not verify the database certificate. Check remote access, CA, and hostname.");
  };
  const sitePath = (siteId: string, action: string) => `/api/sites/${encodeURIComponent(siteId)}/${action}`;
  const formatDate = (value?: string) => formatDateIn(language, value);
  const formatBytes = (bytes?: number) => formatBytesIn(language, bytes);
  const reportIsStale = $derived(Boolean(selectedSite?.needsBuild && selectedSite.lastBuild?.id === report?.id));

  onMount(() => {
    try {
      const stored = localStorage.getItem("histos-theme");
      if (stored === "light" || stored === "dark") setTheme(stored);
    } catch { /* The system's colours, then. */ }
    void window.histosDesktop?.sandboxFallback().then((fallback) => showSandboxFallback = fallback).catch(() => undefined);
    const start = (): void => {
      consumeLocalImport();
      void refresh();
      void consumePairing();
    };
    const session = initializeSession();
    if (typeof session === "string") start();
    else void session.then(start);
    // E12: Back and Forward move between screens, as their addresses say.
    // An in-page anchor (#section) is not a screen: only `#/…` addresses and an empty one are.
    const onPopState = (): void => {
      const hash = window.location.hash;
      if (!routeReady || (hash !== "" && !hash.startsWith("#/"))) return;
      // Back between two tabs of the project on screen: no reload, and the notices stay (E14).
      const [section, id, sub] = hash.replace(/^#\/?/u, "").split("/");
      if (section === "cms" && screen === "cms" && sub !== "amministra" && id && selectedCmsProject?.project.id === id) {
        appliedHash = hash;
        showCmsTabFromRoute(CMS_TABS.find((tab) => tab.slug === sub)?.id ?? "pages");
        return;
      }
      void act(() => applyRoute(hash));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  // ------------------------------------------------------------------ E12: an address for every screen
  // Project ids restored from a backup may be upper-case.
  const ROUTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  /** The first address is applied once the session and the catalogs are loaded; until then nothing is written. */
  let routeReady = $state(false);
  let applyingRoute = $state(false);
  /** The address being (or just) applied: if the screen it leads to differs, the entry is replaced, not stacked. */
  let appliedHash: string | null = null;
  /** The next address replaces the current entry (moving between tabs with the arrows, E14). */
  let replaceNextRoute = false;

  /** The address of what is on screen: `#/cms/<id>`, `#/agente`… Home has none. */
  function currentRoute(): string {
    switch (screen) {
      case "cms":
      case "admin": return selectedCmsProject ? `#/cms/${selectedCmsProject.project.id}/amministra${adminSection === "bacheca" ? "" : `/${adminSection}`}` : "";
      case "agent": return "#/agente";
      case "settings": return "#/impostazioni";
      case "guide": return "#/guida";
      case "activity": return "#/attivita";
      case "trash": return "#/cestino";
      case "new": return "#/nuovo";
      case "site": case "report": case "history": case "preview": return selectedSite ? `#/siti/${selectedSite.id}` : "";
      default: return "";
    }
  }

  /** Opens the screen an address names (an unknown one goes home). */
  async function applyRoute(hash: string): Promise<void> {
    const [section, id, sub, detail] = hash.replace(/^#\/?/u, "").split("/");
    appliedHash = hash;
    applyingRoute = true;
    try {
      if (section === "cms" && id && ROUTE_ID.test(id) && sub === "amministra") {
        if (selectedCmsProject?.project.id !== id) await openCmsProject(id);
        if (selectedCmsProject?.project.id === id) {
          adminSection = detail && /^[a-z0-9_-]{1,80}$/u.test(detail) ? detail : "bacheca";
          nav("admin");
        }
      }
      else if (section === "cms" && id && ROUTE_ID.test(id)) {
        // Another tab of the project on screen only changes the tab (E14); an unknown tab is the first.
        if (selectedCmsProject?.project.id !== id || screen !== "cms") await openCmsProject(id);
        if (selectedCmsProject?.project.id === id) {
          const tab = CMS_TABS.find((entry) => entry.slug === sub)?.id;
          if (tab) showCmsTabFromRoute(tab);
          else { adminSection = "bacheca"; nav("admin"); }
        }
      }
      else if (section === "cms") { selectedCmsProject = null; nav("cms"); }
      else if (section === "agente") nav("agent");
      else if (section === "impostazioni") await loadSettings();
      else if (section === "guida") nav("guide");
      else if (section === "attivita") nav("activity");
      else if (section === "cestino") { nav("trash"); void loadTrash(); }
      else if (section === "nuovo") beginNewSite();
      else if (section === "siti" && id) {
        // A site added since the list was read (another window, the agent): read it again before giving up.
        if (!sites.some((site) => site.id === id)) sites = (await api<Bootstrap>("/api/bootstrap")).sites;
        if (sites.some((site) => site.id === id)) await openSite(id);
        else goHome();
      }
      else goHome();
    } catch (error) {
      // A project or site that no longer exists: home, with the reason in the notice.
      goHome();
      throw error;
    } finally {
      applyingRoute = false;
    }
  }

  $effect(() => {
    const route = currentRoute();
    if (!routeReady || applyingRoute) return;
    const hash = window.location.hash;
    if (hash === route || (!route && !hash)) {
      appliedHash = null;
      replaceNextRoute = false;
      return;
    }
    const url = `${window.location.pathname}${window.location.search}${route}`;
    // A dead address (or one left before it finished) is replaced, so Back never returns to an address that sends
    // you on again; a new screen is a new entry.
    if ((appliedHash !== null && hash === appliedHash) || replaceNextRoute) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    appliedHash = null;
    replaceNextRoute = false;
  });

  /** "Galleria · Histeon CMS": the tab says where you are; a pending agent request keeps its "(1) …" prefix. */
  function screenTitle(): string {
    if (screen === "admin" && selectedCmsProject) return `${t("admin.title")} · ${selectedCmsProject.project.name}`;
    if (screen === "cms") return selectedCmsProject ? `${selectedCmsProject.project.name} · Histeon CMS` : "Histeon CMS · Histeon Publish";
    if ((screen === "site" || screen === "report" || screen === "history" || screen === "preview") && selectedSite) return `${selectedSite.name} · Histeon Publish`;
    const names: Partial<Record<Screen, string>> = { agent: t("agent.title"), settings: t("settings.title"), guide: say("Guida", "Guide"), activity: t("nav.activity"), trash: t("trash.title"), new: t("new.eyebrow") };
    const name = names[screen];
    return name ? `${name} · Histeon Publish` : "Histeon Publish";
  }

  /** WordPress sends and updates waiting for the user, from the connector banner (E8): "(1) Conferma invio · …". */
  let pendingApprovals = $state(0);
  $effect(() => {
    // Built from the count, never read back from the title: a project's own name cannot fake the prefix.
    const title = screenTitle();
    document.title = pendingApprovals > 0 ? `(${pendingApprovals}) ${t("connector.titlePending")} · ${title}` : title;
  });

  // A new screen moves the focus to its title, so a screen reader announces it (not on the first load).
  let focusedRoute: string | null = null;
  $effect(() => {
    // A tab of the project is not a new screen (E14): the focus stays on the tab.
    const route = currentRoute().replace(/^(#\/cms\/[^/]+)\/.*$/u, "$1");
    if (!routeReady) return;
    if (focusedRoute === null || route === focusedRoute) {
      focusedRoute = route;
      return;
    }
    focusedRoute = route;
    void tick().then(focusScreenTitle);
  });

  function focusScreenTitle(): void {
    if (document.querySelector("[role='dialog']")) return;
    const heading = document.querySelector<HTMLElement>("main h1");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }

  /** The breadcrumb from the screen: each level but the last leads back. */
  function crumbs(): Array<{ label: string; go?: () => void }> {
    if (screen === "home" || (screen === "cms" && !selectedCmsProject)) return [{ label: t("home.title") }];
    if ((screen === "admin" || screen === "cms") && selectedCmsProject) return [{ label: t("home.title"), go: () => { selectedCmsProject = null; nav("home"); } }, { label: selectedCmsProject.project.name }];
    if ((screen === "site" || screen === "report" || screen === "history" || screen === "preview") && selectedSite) {
      const site = selectedSite;
      return screen === "site" ? [{ label: t("nav.sites"), go: goHome }, { label: site.name }] : [{ label: t("nav.sites"), go: goHome }, { label: site.name, go: () => nav("site") }, { label: screen === "report" ? t("report.title") : screen === "history" ? say("Storico", "History") : say("Anteprima", "Preview") }];
    }
    if (screen === "new") return [{ label: t("nav.sites"), go: goHome }, { label: t("new.eyebrow") }];
    const names: Partial<Record<Screen, string>> = { agent: t("agent.title"), settings: t("settings.title"), guide: say("Guida alla pubblicazione", "Publishing guide"), activity: t("nav.activity"), trash: t("trash.title") };
    return [{ label: names[screen] ?? t("home.title") }];
  }

  /** `?pairState=…&pairClaim=…`, set by the app when the site's link comes back (desktop main.ts, pairingAppUrl). */
  async function consumePairing(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const state = params.get("pairState") ?? "";
    const claim = params.get("pairClaim") ?? "";
    if (!state && !claim) return;
    history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
    try {
      const pending = await api<{ siteUrl: string }>(`/api/cms/v1/pairings/${encodeURIComponent(state)}`);
      pendingPairing = { state, claim, siteUrl: pending.siteUrl };
      cmsCatalogFilter = "connected";
      nav("home");
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : say("Il collegamento ricevuto dal sito non è valido.", "The link received from the site is invalid.");
    }
  }

  async function startPairing(): Promise<void> {
    const started = await api<{ state: string; url: string }>("/api/cms/v1/pairings", { method: "POST", body: JSON.stringify({ siteUrl: pairingSiteUrl.trim() }) });
    const opened = await window.histosDesktop?.openExternal?.(started.url).catch(() => false);
    if (!opened) window.open(started.url, "_blank", "noopener,noreferrer");
    successMessage = t("cms.pairOpened", { host: new URL(started.url).hostname });
  }

  async function confirmPairing(): Promise<void> {
    const pending = pendingPairing;
    if (!pending) return;
    pendingPairing = null;
    const result = await api<{ connection: CmsRemoteConnection }>(`/api/cms/v1/pairings/${encodeURIComponent(pending.state)}/claim`, { method: "POST", body: JSON.stringify({ claim: pending.claim }) });
    pairingSiteUrl = "";
    await refresh();
    successMessage = t("cms.connectSuccess", { host: new URL(result.connection.url).hostname });
  }

  function consumeLocalImport(): void {
    const params = new URLSearchParams(window.location.search);
    const rawUrl = params.get("localImportUrl");
    if (!rawUrl) return;
    const rawName = params.get("localImportName") ?? "Sito Local";
    try {
      const target = new URL(rawUrl);
      const host = target.hostname.toLowerCase();
      const localHost = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
      if (!localHost || !(target.protocol === "http:" || target.protocol === "https:") || target.username || target.password) throw new Error("Sorgente Local non valida.");
      target.hash = "";
      pendingLocalImport = { url: target.href, name: rawName.trim().slice(0, 80) || "Sito Local" };
    } catch {
      errorMessage = say("Il collegamento ricevuto da Local non è valido. Riapri Histeon Publish dal menu del sito in Local.", "The link received from Local is invalid. Reopen Histeon Publish from the site's Local menu.");
    }
    history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }

  /** The catalog cards only: a build or an edit inside a project changes them (E9). */
  async function reloadCmsProjects(): Promise<void> {
    try {
      const cmsList = await api<{ projects: CmsProject[]; unavailable?: Array<{ id: string; message: string }> }>("/api/cms/v1/projects");
      cmsProjects = cmsList.projects;
      cmsUnavailableProjects = cmsList.unavailable ?? [];
    } catch {
      // The list stays as it was; the next refresh reads it again.
    }
  }

  // Back to the catalog from a project: its card reads again.
  let cmsCatalogShown = false;
  $effect(() => {
    const showing = (screen === "cms" || screen === "home") && selectedCmsProject === null;
    if (showing && !cmsCatalogShown && bootstrap) void reloadCmsProjects();
    cmsCatalogShown = showing;
  });

  async function refresh(): Promise<void> {
    try {
      bootstrap = await api<Bootstrap>("/api/bootstrap");
      sites = bootstrap.sites;
      const cmsList = await api<{ projects: CmsProject[]; unavailable?: Array<{ id: string; message: string }> }>("/api/cms/v1/projects");
      cmsProjects = cmsList.projects;
      cmsUnavailableProjects = cmsList.unavailable ?? [];
      cmsConnections = (await api<{ connections: CmsRemoteConnection[] }>("/api/cms/v1/connections")).connections;
      await loadTrash();
      await loadFolders();
      if (!selectedSite) language = bootstrap.language;
      if (!routeReady) {
        // E12: the address the app was opened at (a reload, the builder's "← Galleria").
        const initial = window.location.hash.startsWith("#/") ? window.location.hash : "";
        if (initial && !pendingLocalImport) {
          try {
            await applyRoute(initial);
          } catch (error) {
            errorMessage = error instanceof Error ? error.message : t("app.routeMissing");
          }
        }
        routeReady = true;
      }
      if (pendingLocalImport) {
        const pending = pendingLocalImport;
        pendingLocalImport = null;
        const imported = sites.find((site) => site.source.kind === "url" && site.sourceUrl && canonicalLocalSource(site.sourceUrl) === canonicalLocalSource(pending.url));
        if (imported) {
          await openSite(imported.id);
          successMessage = say("Progetto Local già collegato: aperta la versione e le impostazioni di pubblicazione.", "This Local project is already connected. Its build and publishing settings are ready.");
        } else {
          urlInput = pending.url;
          siteName = pending.name;
          screen = "new";
          localImportNotice = say("Sito ricevuto da Local. Riconosci la sorgente, autorizza la lettura e poi scegli dove pubblicarlo.", "Site received from Local. Detect the source, authorize the crawl, then choose where to publish it.");
        }
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "Non riesco a collegarmi al server locale.";
    }
  }

  function canonicalLocalSource(value: string): string {
    try { const url = new URL(value); url.hash = ""; url.search = ""; return `${url.origin}/`; }
    catch { return value.trim(); }
  }

  /** "galleria-2026-10-26.xbsite" instead of an id: the file is recognisable in the Downloads folder (E11). */
  function readableFileName(extension: string, suffix = ""): string {
    const name = selectedCmsProject?.project.name ?? "progetto";
    const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60) || "progetto";
    const date = new Date();
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return `${slug}-${day}${suffix ? `-${suffix}` : ""}.${extension}`;
  }

  function pushToast(kind: Toast["kind"], text: string, detail = ""): void {
    const toast: Toast = { id: ++toastSeq, kind, text, agent: nextToastFromAgent, remaining: TOAST_SUCCESS_MS, ...(nextToastAction ? { action: nextToastAction } : {}), ...(detail ? { detail } : {}) };
    nextToastAction = null;
    nextToastFromAgent = false;
    toasts = [...toasts.filter((item) => item.text !== text || item.kind !== kind), toast].slice(-3);
  }

  function dismissToast(id: number): void {
    toasts = toasts.filter((item) => item.id !== id);
  }

  $effect(() => {
    const text = successMessage;
    if (!text) return;
    untrack(() => {
      pushToast("success", text);
      successMessage = "";
    });
  });

  $effect(() => {
    const text = errorMessage;
    if (!text) return;
    untrack(() => {
      pushToast("error", text);
      errorMessage = "";
    });
  });

  onMount(() => {
    const timer = setInterval(() => {
      if (toastsPaused || !toasts.some((item) => item.kind === "success")) return;
      toasts = toasts.map((item) => item.kind === "success" ? { ...item, remaining: item.remaining - 500 } : item).filter((item) => item.remaining > 0);
    }, 500);
    return () => clearInterval(timer);
  });

  /** The last errors of this session, for a report: codes and messages, no contents of the sites. */
  const errorLog: Array<{ at: string; screen: string; text: string }> = [];
  function downloadErrorLog(): void {
    const lines = [`Histeon Publish ${bootstrap?.version ?? ""}`, navigator.userAgent, "", ...errorLog.map((entry) => `${entry.at} [${entry.screen}] ${entry.text}`), ...(errorLog.length ? [] : [say("Nessun errore in questa sessione.", "No errors in this session.")])];
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain" }));
    link.download = "histos-publish-registro.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function act(task: () => Promise<void>): Promise<void> {
    errorMessage = "";
    successMessage = "";
    // A new action makes the errors of the previous one stale.
    toasts = toasts.filter((item) => item.kind !== "error");
    busy = true;
    try { await task(); }
    catch (error) {
      errorLog.push({ at: new Date().toISOString(), screen, text: errorView(error).text.slice(0, 400) });
      errorLog.splice(0, Math.max(0, errorLog.length - 200));
      showError(error);
    }
    finally { busy = false; }
  }

  /**
   * An error in the user's language (E13). The server writes Italian and specific messages: in Italian they are shown
   * as they are; in English the message for the error's code is shown, or a generic one. The code, and in English the
   * server's own text, stay in a collapsible "Technical details".
   */
  function errorView(error: unknown): { text: string; detail: string } {
    if (error instanceof TypeError && /fetch|network/iu.test(error.message)) return { text: t("error.network"), detail: error.message };
    if (!(error instanceof Error)) return { text: t("common.error"), detail: "" };
    if (!(error instanceof ApiError) || !error.code) return { text: error.message, detail: "" };
    const key = `error.${error.code}`;
    const code = t("error.code", { code: error.code });
    if (language === "it") return { text: error.message, detail: code };
    return { text: hasMessage(language, key) ? t(key, { status: error.status }) : t("error.generic"), detail: `${code} · ${error.message}` };
  }

  function showError(error: unknown): void {
    const view = errorView(error);
    pushToast("error", view.text, view.detail);
  }

  function resetNewSite(): void {
    urlInput = ""; detection = null; consentOrigin = ""; consentLocalOrigin = false; siteName = ""; workerName = "";
    accountId = bootstrap?.accountId ?? ""; domain = ""; includeWww = true; domainZones = null; domainPlan = null; basicUser = ""; basicPassword = ""; cookie = "";
    selectedFiles = []; importId = ""; importProgress = 0; newSitePrototype = null; newSiteDesign = null;
  }

  function beginNewSite(): void { resetNewSite(); errorMessage = ""; screen = "new"; }

  async function detectSite(authorized = false): Promise<void> {
    const credentials = { basicUser, basicPassword, cookie };
    const result = await api<Record<string, unknown>>("/api/detect", {
      method: "POST", body: JSON.stringify({ input: urlInput.trim(), ...(authorized ? { authorized: true, authorizedOrigin: consentOrigin } : {}), credentials }),
    });
    if (result.needsConsent === true) {
      consentOrigin = String(result.origin ?? "");
      consentLocalOrigin = result.localOrigin === true;
      detection = result;
      return;
    }
    detection = result;
    consentOrigin = "";
    consentLocalOrigin = false;
    siteName = String(result.suggestedName ?? "Nuovo sito");
    workerName = String(result.suggestedWorker ?? "nuovo-sito");
    sourceToSave = result.source as { kind: SourceKind; path: string };
    screen = "new";
  }

  let sourceToSave = $state<{ kind: SourceKind; path: string } | null>(null);

  function filesFromInput(event: Event, kind: "directory" | "html" | "zip"): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    let entries = files.map((file) => {
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      return { file, path: kind === "directory" ? (relative || file.name) : file.name };
    });
    if (kind === "directory" && entries.length > 0) {
      const firstPart = entries[0]?.path.split("/")[0];
      if (firstPart && entries.every((entry) => entry.path.startsWith(`${firstPart}/`))) entries = entries.map((entry) => ({ ...entry, path: entry.path.slice(firstPart.length + 1) }));
    }
    useSourceEntries(entries, kind);
  }

  /** The files chosen for a new static site; a Histeon prototype is pointed to the CMS instead (E9). */
  function useSourceEntries(entries: UploadEntry[], kind: "directory" | "html" | "zip"): void {
    newSitePrototype = null;
    // A lone .penpot or .fig file is no static site: it goes to «Da Penpot o Figma» (NewSiteDesign.svelte).
    const design = entries.length === 1 && /\.(?:penpot|fig)$/iu.test(entries[0]?.file.name ?? "") ? entries[0]?.file : undefined;
    if (design) void isDesignFile(design).then((found) => { if (found && selectedFiles.length === 1 && selectedFiles[0]?.file === design) { selectedFiles = []; siteName = ""; workerName = ""; newSiteDesign = design; } });
    const single = kind === "html" && entries.length === 1 ? entries[0]?.file : undefined;
    if (single) void isHistosPrototype(single).then((prototype) => { if (prototype && selectedFiles[0]?.file === single) newSitePrototype = single; });
    importKind = kind;
    selectedFiles = entries;
    siteName = kind === "directory" ? (entries[0]?.path.split("/")[0] ?? "") : (entries[0]?.file.name.replace(/\.[^.]+$/u, "") ?? "");
    workerName = siteName.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 63);
    sourceToSave = null;
    detection = null;
    consentOrigin = "";
    consentLocalOrigin = false;
  }

  interface DroppedEntry { isFile: boolean; isDirectory: boolean; name: string; file?: (success: (file: File) => void, failure?: (error: DOMException) => void) => void; createReader?: () => { readEntries: (success: (entries: DroppedEntry[]) => void, failure?: (error: DOMException) => void) => void } }
  function readDroppedEntry(entry: DroppedEntry, prefix = ""): Promise<UploadEntry[]> {
    const name = `${prefix}${entry.name}`;
    if (entry.isFile && entry.file) return new Promise((resolve, reject) => entry.file?.((file) => resolve([{ file, path: name }]), reject));
    if (!entry.isDirectory || !entry.createReader) return Promise.resolve([]);
    const reader = entry.createReader();
    const collect = async (): Promise<DroppedEntry[]> => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    return (async () => {
      const all: DroppedEntry[] = [];
      while (true) { const batch = await collect(); if (!batch.length) break; all.push(...batch); }
      const children = await Promise.all(all.map((child) => readDroppedEntry(child, `${name}/`)));
      return children.flat();
    })();
  }

  async function handleDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    const items = [...(event.dataTransfer?.items ?? [])];
    const entryResults = await Promise.all(items.map((item) => {
      const webkit = item as DataTransferItem & { webkitGetAsEntry?: () => DroppedEntry | null };
      const entry = webkit.webkitGetAsEntry?.();
      return entry ? readDroppedEntry(entry) : Promise.resolve([] as UploadEntry[]);
    }));
    let entries = entryResults.flat();
    if (!entries.length) return;
    const isArchive = entries.length === 1 && entries[0]?.path.toLowerCase().endsWith(".zip");
    const droppedPath = entries[0]?.path ?? "";
    const droppedFile = entries[0]?.file;
    const isHtml = entries.length === 1 && (/\.html?$/iu.test(droppedPath) || droppedFile?.type === "text/html" || !/\.[^/.]+$/u.test(droppedPath));
    const kind = isArchive ? "zip" : isHtml ? "html" : "directory";
    if (kind === "directory" && entries.length > 0) {
      const firstPart = entries[0]?.path.split("/")[0];
      if (firstPart && entries.every((entry) => entry.path.startsWith(`${firstPart}/`))) entries = entries.map((entry) => ({ ...entry, path: entry.path.slice(firstPart.length + 1) }));
    }
    useSourceEntries(entries, kind);
  }

  /** The marker of a Histeon prototype on its <html>, read by the browser's own HTML parser like the importer reads it. */
  async function isHistosPrototype(file: File): Promise<boolean> {
    try {
      const head = await file.slice(0, 256 * 1024).text();
      return new DOMParser().parseFromString(head, "text/html").documentElement.getAttribute("data-histos-prototype") === "1";
    } catch {
      return false;
    }
  }

  /** The first bytes of a design file: a ZIP archive (`.penpot`, `.fig`) or the bare document of an old `.fig`. */
  async function isDesignFile(file: File): Promise<boolean> {
    try {
      const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      return (head[0] === 0x50 && head[1] === 0x4b) || new TextDecoder().decode(head) === "fig-kiwi";
    } catch {
      return false;
    }
  }

  /** The prototype made from a frame of a design file goes to the CMS check and its preview, like one the user wrote. */
  async function importNewSiteDesign(prototype: File): Promise<void> {
    selectedCmsProject = null;
    nav("cms");
    await checkCmsPrototype(prototype);
  }

  /** A prototype picked in "Nuovo sito" goes to the CMS check and its preview instead. */
  async function importNewSitePrototype(): Promise<void> {
    const file = newSitePrototype;
    if (!file) return;
    selectedCmsProject = null;
    nav("cms");
    await checkCmsPrototype(file);
  }

  async function saveCredentials(siteId: string): Promise<void> {
    if (!basicUser && !basicPassword && !cookie) return;
    await api(sitePath(siteId, "credentials"), { method: "POST", body: JSON.stringify({ basicUser, basicPassword, cookie }) });
  }

  async function saveNewSite(): Promise<void> {
    if (!siteName.trim()) throw new Error(t("settings.invalid"));
    let created: { site: Site };
    if (selectedFiles.length) {
      const plan = await api<{ id: string }>("/api/imports", { method: "POST", body: JSON.stringify({ name: siteName.trim(), kind: importKind, files: selectedFiles.map(({ file, path: relativePath }) => ({ path: relativePath, size: file.size })) }) });
      importId = plan.id;
      try {
        for (let index = 0; index < selectedFiles.length; index += 1) {
          const entry = selectedFiles[index];
          if (!entry) continue;
          const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
          await uploadFile(`/api/imports/${encodeURIComponent(plan.id)}/files/${encodedPath}`, entry.file);
          importProgress = index + 1;
        }
        if (importKind === "zip") {
          const inspection = await api<{ rootIndexFound: boolean; blockedFindings: number }>(`/api/imports/${encodeURIComponent(plan.id)}/inspect`, { method: "POST", body: "{}" });
          if (!inspection.rootIndexFound || inspection.blockedFindings > 0) throw new Error("Lo ZIP non contiene un index.html utilizzabile oppure include percorsi non sicuri. Correggi l’archivio e riprova.");
        }
        created = await api<{ site: Site }>(`/api/imports/${encodeURIComponent(plan.id)}/complete`, { method: "POST", body: "{}" });
        importId = "";
      } catch (error) {
        await api(`/api/imports/${encodeURIComponent(plan.id)}`, { method: "DELETE" }).catch(() => undefined);
        importId = "";
        throw error;
      }
      await api(sitePath(created.site.id, ""), { method: "PATCH", body: JSON.stringify({ accountId: accountId || undefined, script: workerName || undefined }) });
    } else {
      if (!sourceToSave) throw new Error("Riconosci un URL oppure scegli i file del sito.");
      created = await api<{ site: Site }>("/api/sites", {
        method: "POST",
        body: JSON.stringify({ name: siteName.trim(), source: sourceToSave, cloudflare: { accountId: accountId || undefined, script: workerName || undefined } }),
      });
    }
    await saveCredentials(created.site.id);
    await refresh();
    await openSite(created.site.id);
    successMessage = say("Sito aggiunto. Puoi creare la prima versione quando vuoi.", "Site added. You can create the first version whenever you like.");
  }

  function selectReplacementFile(kind: "html" | "zip"): void {
    const input = document.getElementById(`replace-source-${kind}`) as HTMLInputElement | null;
    if (!input) return;
    input.value = "";
    input.click();
  }

  async function replaceSourceFile(file: File, kind: "html" | "zip"): Promise<void> {
    await act(async () => {
      if (sourceFileKind(file) !== kind) {
        throw new Error(say("Il formato del file non corrisponde. Scegli un file HTML o uno ZIP.", "The file format does not match. Choose an HTML file or a ZIP archive."));
      }
      const siteId = selectedSite?.id;
      if (!siteId) throw new Error("Apri prima il progetto da aggiornare.");
      sourceReplacementProgress = 0;
      const relativePath = file.name || (kind === "html" ? "pagina" : "sito.zip");
      const plan = await api<{ id: string }>(sitePath(siteId, "source-import"), {
        method: "POST",
        body: JSON.stringify({ kind, files: [{ path: relativePath, size: file.size }] }),
      });
      importId = plan.id;
      try {
        const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
        await uploadFile(`/api/imports/${encodeURIComponent(plan.id)}/files/${encodedPath}`, file);
        sourceReplacementProgress = 1;
        if (kind === "zip") {
          const inspection = await api<{ fileCount: number; totalBytes: number; rootIndexFound: boolean; strippedRoot?: string; blockedFindings: number }>(`/api/imports/${encodeURIComponent(plan.id)}/inspect`, { method: "POST", body: "{}" });
          if (!inspection.rootIndexFound || inspection.blockedFindings > 0) throw new Error("Non sostituisco la sorgente: nello ZIP manca index.html oppure ci sono percorsi non sicuri. Controlla l’archivio e riprova.");
          sourceZipSummary = `${inspection.fileCount} file · ${formatBytes(inspection.totalBytes)}${inspection.strippedRoot ? ` · ${say("cartella “", "removed folder “")}${inspection.strippedRoot}${say("” rimossa automaticamente", "” automatically")}` : ""}`;
        } else sourceZipSummary = "";
        const result = await api<{ site: Site }>(`/api/imports/${encodeURIComponent(plan.id)}/complete`, { method: "POST", body: "{}" });
        importId = "";
        await refresh();
        selectedSite = sites.find((site) => site.id === result.site.id) ?? result.site;
        await openSite(result.site.id);
        successMessage = say(`Sorgente sostituita${sourceZipSummary ? ` (${sourceZipSummary})` : ""}. La versione precedente è segnata come da aggiornare.`, `Source replaced${sourceZipSummary ? ` (${sourceZipSummary})` : ""}. The previous version is marked as out of date.`);
      } catch (error) {
        await api(`/api/imports/${encodeURIComponent(plan.id)}`, { method: "DELETE" }).catch(() => undefined);
        importId = "";
        throw error;
      }
    });
  }

  function selectWorkerFile(): void {
    const input = document.getElementById("site-worker-js") as HTMLInputElement | null;
    if (!input) return;
    input.value = "";
    input.click();
  }

  /** The site's own server code: a .js file sent as text and kept by Publish as `_worker.js` (no act: callers wrap it). */
  async function uploadWorkerModule(file: File): Promise<void> {
    const siteId = selectedSite?.id;
    if (!siteId) throw new Error("Apri prima il sito.");
    if (!/\.m?js$/iu.test(file.name)) throw new Error(say("Il codice del Worker deve essere un file .js.", "The Worker code must be a .js file."));
    if (file.size > 3 * 1024 * 1024) throw new Error(say("Il codice del Worker supera 3 MiB.", "The Worker code is larger than 3 MiB."));
    const result = await api<{ site: Site; kvAdded?: string[] }>(sitePath(siteId, "worker-module"), { method: "PUT", body: JSON.stringify({ name: file.name, source: await file.text() }) });
    await refresh();
    selectedSite = sites.find((site) => site.id === result.site.id) ?? result.site;
    mergeSavedKv(selectedSite);
    const kvNote = result.kvAdded?.length ? say(` Archivi KV trovati nel codice e aggiunti alla configurazione: ${result.kvAdded.join(", ")}.`, ` KV namespaces found in the code and added to the settings: ${result.kvAdded.join(", ")}.`) : "";
    successMessage = say(`Codice del Worker caricato (${file.name}). Entra nella prossima versione come _worker.js; la versione precedente è segnata come da aggiornare.`, `Worker code uploaded (${file.name}). It enters the next version as _worker.js; the previous version is marked as out of date.`) + kvNote;
  }

  async function workerFromInput(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) await act(() => uploadWorkerModule(file));
  }

  async function removeWorkerModule(): Promise<void> {
    if (!selectedSite) return;
    const result = await api<{ site: Site }>(sitePath(selectedSite.id, "worker-module"), { method: "DELETE" });
    await refresh();
    selectedSite = sites.find((site) => site.id === result.site.id) ?? result.site;
    successMessage = say("Codice del Worker tolto: la prossima versione userà solo i file del sito.", "Worker code removed: the next version uses only the site's files.");
  }

  async function replaceSourceFromInput(event: Event, kind: "html" | "zip"): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) await replaceSourceFile(file, kind);
  }

  function sourceFileKind(file: File): "html" | "zip" | null {
    const name = file.name.toLowerCase();
    if (/\.zip$/u.test(name)) return "zip";
    if (/\.html?$/u.test(name) || (file.type === "text/html" && !/\.[^/.]+$/u.test(name))) return "html";
    return null;
  }

  function handleSourceDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    sourceDropActive = true;
  }

  async function handleSourceDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    sourceDropActive = false;
    if (busy) return;
    const dropped = [...(event.dataTransfer?.files ?? [])];
    // The site's files (one HTML or one ZIP) and, apart, its Worker code (one .js): either, or both together.
    const scripts = dropped.filter((file) => /\.m?js$/iu.test(file.name));
    const files = dropped.filter((file) => !scripts.includes(file));
    if (files.length > 1 || scripts.length > 1 || dropped.length === 0) {
      errorMessage = say("Trascina un solo file HTML o ZIP, ed eventualmente un solo file .js con il codice del Worker.", "Drop one HTML or ZIP file and, if needed, one .js file with the Worker code.");
      successMessage = "";
      return;
    }
    const file = files[0];
    const kind = file ? sourceFileKind(file) : null;
    if (file && !kind) {
      errorMessage = say("Formato non supportato. Usa un file .html o un archivio .zip, più un eventuale .js del Worker.", "Unsupported file. Use an .html file or a .zip archive, plus an optional Worker .js.");
      successMessage = "";
      return;
    }
    if (file && kind) await replaceSourceFile(file, kind);
    const script = scripts[0];
    if (script && !errorMessage) {
      const sourceMessage = file ? successMessage : "";
      await act(() => uploadWorkerModule(script));
      if (sourceMessage && !errorMessage) successMessage = `${sourceMessage} ${successMessage}`;
    }
  }

  async function openSite(id: string, navigateToSite = true): Promise<void> {
    selectedSite = sites.find((site) => site.id === id) ?? null;
    if (!selectedSite) {
      // The safe site summary is refreshed through bootstrap when a site was just created.
      await refresh();
      selectedSite = sites.find((site) => site.id === id) ?? null;
    }
    if (!selectedSite) throw new Error("Sito non trovato.");
    if (navigateToSite) screen = "site";
    accountId = selectedSite.accountId ?? bootstrap?.accountId ?? "";
    workerName = selectedSite.worker ?? "";
    domain = selectedSite.domain ?? "";
    deployTarget = selectedSite.deployTarget ?? "cloudflare";
    hostingProtocol = selectedSite.hosting?.protocol ?? "ftps";
    hostingHost = selectedSite.hosting?.host ?? "";
    hostingPort = selectedSite.hosting?.port ?? (hostingProtocol === "sftp" ? 22 : 21);
    hostingRemoteDirectory = selectedSite.hosting?.remoteDirectory ?? "";
    hostingPublicUrl = selectedSite.hosting?.publicUrl ?? "";
    hostingUsername = selectedSite.hosting?.username ?? "";
    hostingPassword = "";
    hostingAuthMethod = selectedSite.hosting?.authMethod ?? "password";
    hostingPrivateKey = "";
    hostingPassphrase = "";
    hostingTlsCaCertificate = selectedSite.hosting?.tlsCaCertificate ?? "";
    hostingTlsCaFilename = hostingTlsCaCertificate ? say("CA già salvata nel progetto", "CA already saved in the project") : "";
    hostingHostKeyFingerprint = selectedSite.hosting?.hostKeyFingerprint ?? "";
    observedHostingHostKeyFingerprint = "";
    hostingHostKeyConfirmed = false;
    hostingDirectoryInspection = null;
    wordpressPreflight = null;
    wordpressProvisionPlans = [];
    wordpressProvisionPlan = null;
    wordpressProvisionSiteTitle = selectedSite.name;
    wordpressProvisionAdminUsername = "admin";
    wordpressProvisionAdminEmail = "";
    wordpressProvisionAdminPassword = "";
    allowInsecureFtp = selectedSite.hosting?.allowInsecureFtp ?? false;
    includeWww = true;
    domainPlan = null;
    domainZones = null;
    if ((selectedSite.deployTarget ?? "cloudflare") === "cloudflare" && selectedSite.worker) void loadDomainZones(id);
    renderMode = selectedSite.render ?? false;
    pagefindEnabled = selectedSite.pagefind ?? false;
    formsRestUrl = selectedSite.forms?.wordpress?.restUrl ?? "";
    formsIds = selectedSite.forms?.wordpress?.fluentFormIds.join(", ") ?? "";
    kvNames = (selectedSite.kv ?? []).join(", ");
    turnstileSiteKey = selectedSite.forms?.wordpress?.turnstileSiteKey ?? "";
    turnstileSecret = "";
    report = null;
    historyData = await api<HistoryData>(sitePath(id, "history"));
    if (selectedSite.lastBuild?.id) report = await api<BuildResult>(`/api/builds/${encodeURIComponent(selectedSite.lastBuild.id)}/report`).catch(() => null);
    wpUser = ""; wpPassword = ""; wpCookie = "";
    const savedDatabases = await api<{ connections: DatabaseConnection[] }>("/api/database-connections");
    databaseConnections = savedDatabases.connections;
    wordpressDatabaseConnectionId = databaseConnections[0]?.id ?? "";
    await loadWordPressProvisionPlans();
  }

  async function refreshSite(): Promise<void> {
    await refresh();
    if (selectedSite) selectedSite = sites.find((site) => site.id === selectedSite?.id) ?? selectedSite;
    if (selectedSite) historyData = await api<HistoryData>(sitePath(selectedSite.id, "history"));
    await loadWordPressProvisionPlans();
  }

  async function showReport(buildId = selectedSite?.lastBuild?.id): Promise<void> {
    if (!buildId) return;
    report = await api<BuildResult>(`/api/builds/${encodeURIComponent(buildId)}/report`);
    screen = "report";
  }

  async function runBuild(): Promise<void> {
    if (!selectedSite) return;
    const started = await api<{ jobId: string; buildId: string }>(sitePath(selectedSite.id, "build"), { method: "POST", body: "{}" });
    activeJob = { id: started.jobId, type: "build", status: "running", events: [], buildId: started.buildId };
    screen = "site";
    await followJob(started.jobId, (event) => receiveJobEvent(event));
    await refreshSite();
    mergeSavedKv(selectedSite);
    const result = await api<BuildResult>(`/api/builds/${encodeURIComponent(started.buildId)}/report`).catch(() => null);
    // A cancelled or failed build does not replace the ready one (E13): the report stays the site's build.
    if (result && (result.status === "ready" || result.status === "blocked")) report = result;
    else if (activeJob?.status === "cancelled") successMessage = t(report ? "build.cancelledKept" : "build.cancelledNone");
  }

  function receiveJobEvent(event: Record<string, unknown>): void {
    if (!activeJob) return;
    activeJob = { ...activeJob, events: [...activeJob.events, event].slice(-300) };
    if (event.type === "job-finished") activeJob = { ...activeJob, status: String(event.status ?? "complete") };
  }

  async function cancelJob(): Promise<void> {
    if (!activeJob) return;
    await api(`/api/jobs/${encodeURIComponent(activeJob.id)}/cancel`, { method: "POST", body: "{}" });
  }

  async function createPreview(): Promise<void> {
    if (!report?.id) return;
    const ticket = await api<{ baseUrl: string }>(`/api/builds/${encodeURIComponent(report.id)}/preview-ticket`, { method: "POST", body: "{}" });
    previewUrl = `${ticket.baseUrl}index.html`;
    screen = "preview";
  }

  let previewUrl = $state("");

  async function exportReport(format: "json" | "markdown"): Promise<void> {
    if (report?.id) await download(`/api/builds/${encodeURIComponent(report.id)}/export?format=${format}`, {}, `report.${format === "json" ? "json" : "md"}`);
  }

  async function exportBundle(): Promise<void> {
    if (report?.id) await download(`/api/builds/${encodeURIComponent(report.id)}/export?format=zip`, {}, `${selectedSite?.name ?? "sito"}.zip`);
  }

  async function refreshRemoteHistory(): Promise<void> {
    if (!selectedSite) return;
    remoteHistory = await api(sitePath(selectedSite.id, "remote-history"));
  }

  async function confirmRollback(): Promise<void> {
    if (!selectedSite || !showRollback) return;
    await api(sitePath(selectedSite.id, "rollback"), { method: "POST", body: JSON.stringify({ id: showRollback.version_id ?? showRollback.id, confirmed: true }) });
    showRollback = null;
    await refreshSite();
    successMessage = "Ripristino richiesto a Cloudflare.";
  }

  /**
   * Asked when the site opens and, until known, when the domain field gets the focus (a new site has its account only
   * later). Without Zone Read the zones stay unknown and the www option hidden: the domain check says what is missing.
   */
  async function loadDomainZones(siteId: string): Promise<void> {
    const loaded = await api<{ zones: string[] }>(sitePath(siteId, "domain-zones")).catch(() => null);
    if (loaded && selectedSite?.id === siteId) domainZones = loaded.zones;
  }

  async function prepareDomain(): Promise<void> {
    if (!selectedSite || !domain.trim()) throw new Error("Inserisci il dominio, per esempio esempio.it.");
    domainPlan = await api<DomainPlan>(sitePath(selectedSite.id, "domain-check"), {
      method: "POST",
      body: JSON.stringify({ hostname: domain.trim(), includeWww: includeWww && wwwApplies }),
    });
    showDomainSummary = true;
  }

  async function attachDomain(): Promise<void> {
    if (!selectedSite || !domainPlan) throw new Error("Controlla di nuovo il dominio prima di collegarlo.");
    if (domainPlan.workerConflicts.length > 0) throw new Error("Uno dei nomi è già collegato a un altro Worker. Scegli un hostname libero o risolvi il collegamento in Cloudflare.");
    const result = await api<{ domain: { hostname: string; hostnames: string[] } }>(sitePath(selectedSite.id, "domain"), {
      method: "POST",
      body: JSON.stringify({
        hostname: domainPlan.hostname,
        includeWww: domainPlan.hostnames.length > 1,
        replaceCnameRecords: domainPlan.cnameConflicts.map((record) => ({ id: record.id, name: record.name, content: record.content, proxied: record.proxied })),
        confirmed: true,
      }),
    });
    await refreshSite();
    showDomainSummary = false;
    domainPlan = null;
    successMessage = `Richiesta inviata a Cloudflare per ${result.domain.hostnames.join(" e ")}. Il certificato HTTPS potrebbe impiegare qualche minuto.`;
  }

  async function saveSiteSettings(): Promise<void> {
    if (!selectedSite) return;
    const anyFormSetting = formsRestUrl.trim() !== "" || formsIds.trim() !== "" || turnstileSiteKey.trim() !== "";
    let forms: { wordpress: { restUrl: string; fluentFormIds: number[]; turnstileSiteKey: string } } | null = null;
    if (deployTarget === "cloudflare" && anyFormSetting) {
      const idParts = formsIds.split(/[\s,;]+/u).filter(Boolean);
      const ids = idParts.map((value) => Number(value));
      if (!formsRestUrl.trim() || !turnstileSiteKey.trim() || ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
        throw new Error(say("Per collegare Fluent Forms inserisci l’URL REST WordPress, almeno un ID e la chiave pubblica Turnstile.", "To connect Fluent Forms, enter the WordPress REST URL, at least one form ID, and the Turnstile site key."));
      }
      forms = { wordpress: { restUrl: formsRestUrl.trim(), fluentFormIds: ids, turnstileSiteKey: turnstileSiteKey.trim() } };
    }
    await api(sitePath(selectedSite.id, ""), {
      method: "PATCH",
      body: JSON.stringify({
        accountId,
        script: workerName,
        render: renderMode,
        pagefind: pagefindEnabled,
        ...(deployTarget === "cloudflare" ? { deployTarget, forms, kv: kvNames.split(/[\s,;]+/u).filter(Boolean) } : {}),
      }),
    });
    if (deployTarget === "ftp") {
      const result = await api<{ site?: Site; hostKeyConfirmationRequired?: boolean; hostKeyFingerprint?: string }>(sitePath(selectedSite.id, "hosting"), {
        method: "POST",
        body: JSON.stringify({
          settings: {
            protocol: hostingProtocol,
            host: hostingHost,
            port: hostingPort,
            remoteDirectory: hostingRemoteDirectory,
            publicUrl: hostingPublicUrl,
            username: hostingUsername,
            allowInsecureFtp,
            ...(hostingProtocol === "ftps" && hostingTlsCaCertificate ? { tlsCaCertificate: hostingTlsCaCertificate } : {}),
            authMethod: hostingAuthMethod,
            ...(hostingHostKeyFingerprint ? { hostKeyFingerprint: hostingHostKeyFingerprint } : {}),
          },
          username: hostingUsername,
          password: hostingPassword,
          authMethod: hostingAuthMethod,
          privateKey: hostingPrivateKey,
          passphrase: hostingPassphrase,
          confirmHostKeyFingerprint: hostingHostKeyConfirmed ? observedHostingHostKeyFingerprint : "",
        }),
      });
      if (result.hostKeyConfirmationRequired) {
        if (!result.hostKeyFingerprint) throw new Error(say("Il server non ha restituito un’impronta SSH valida.", "The server did not return a valid SSH fingerprint."));
        hostingHostKeyFingerprint = result.hostKeyFingerprint;
        observedHostingHostKeyFingerprint = result.hostKeyFingerprint;
        hostingHostKeyConfirmed = false;
        successMessage = say("Confronta l’impronta SSH qui sotto con quella mostrata dal tuo provider. La password o la chiave non verranno inviate prima della verifica.", "Compare the SSH fingerprint below with the one shown by your provider. The password or key will not be sent before verification.");
        return;
      }
      if (!result.site) throw new Error(say("La configurazione hosting non è stata salvata.", "The hosting settings were not saved."));
      selectedSite = result.site;
      hostingDirectoryInspection = null;
      hostingPassword = "";
      hostingPrivateKey = "";
      hostingPassphrase = "";
      observedHostingHostKeyFingerprint = "";
      hostingHostKeyConfirmed = false;
    }
    if (deployTarget === "cloudflare" && turnstileSecret.trim()) {
      await api(sitePath(selectedSite.id, "turnstile-secret"), { method: "POST", body: JSON.stringify({ secret: turnstileSecret }) });
      turnstileSecret = "";
    }
    await refreshSite();
    successMessage = deployTarget === "ftp"
      ? say("Connessione hosting verificata e destinazione salvata.", "Hosting connection verified and destination saved.")
      : say("Impostazioni del sito salvate.", "Site settings saved.");
  }

  function hostingProtocolChanged(): void {
    if (hostingProtocol === "sftp" && hostingPort === 21) hostingPort = 22;
    else if (hostingProtocol !== "sftp" && hostingPort === 22) hostingPort = 21;
    hostingHostKeyConfirmed = false;
    observedHostingHostKeyFingerprint = "";
    hostingHostKeyFingerprint = selectedSite?.hosting?.protocol === "sftp" && hostingProtocol === "sftp"
      ? selectedSite.hosting.hostKeyFingerprint ?? ""
      : "";
    if (hostingProtocol !== "ftps") {
      hostingTlsCaCertificate = "";
      hostingTlsCaFilename = "";
      const input = document.getElementById("hosting-tls-ca") as HTMLInputElement | null;
      if (input) input.value = "";
    }
  }

  function clearHostingTlsCa(): void {
    hostingTlsCaCertificate = "";
    hostingTlsCaFilename = "";
    const input = document.getElementById("hosting-tls-ca") as HTMLInputElement | null;
    if (input) input.value = "";
  }

  async function removeHostingCredentials(): Promise<void> {
    if (!selectedSite) return;
    await api(sitePath(selectedSite.id, "hosting"), { method: "DELETE" });
    await refreshSite();
    hostingPassword = "";
    hostingPrivateKey = "";
    hostingPassphrase = "";
    hostingDirectoryInspection = null;
    successMessage = say("Credenziali hosting rimosse dal portachiavi.", "Hosting credentials removed from the keyring.");
  }

  async function inspectHostingDirectory(): Promise<void> {
    if (!selectedSite) return;
    const result = await api<{ directory: HostingDirectoryInspection }>(sitePath(selectedSite.id, "hosting/inspect"), { method: "POST" });
    hostingDirectoryInspection = result.directory;
    successMessage = result.directory.isEmpty
      ? say("La cartella è leggibile e vuota. Il controllo non ha modificato file e non ha installato WordPress.", "The directory is readable and empty. The check did not change files or install WordPress.")
      : say(`Cartella leggibile: ${result.directory.entryCount} elementi. Il controllo non ha modificato file.`, `Directory is readable: ${result.directory.entryCount} entries. The check did not change any files.`);
  }

  async function removeTurnstileSecret(): Promise<void> {
    if (!selectedSite) return;
    await api(sitePath(selectedSite.id, "turnstile-secret"), { method: "DELETE" });
    await refreshSite();
    successMessage = say("Chiave locale rimossa dal portachiavi.", "Local key removed from the keyring.");
  }

  async function saveWpCredentials(): Promise<void> {
    if (!selectedSite) return;
    if (!wpUser && !wpPassword && !wpCookie) throw new Error(t("settings.invalid"));
    await api(sitePath(selectedSite.id, "credentials"), { method: "POST", body: JSON.stringify({ basicUser: wpUser, basicPassword: wpPassword, cookie: wpCookie }) });
    await refreshSite();
    successMessage = "Credenziali salvate nel portachiavi.";
    wpUser = ""; wpPassword = ""; wpCookie = "";
  }

  async function removeWpCredentials(): Promise<void> {
    if (!selectedSite) return;
    await api(sitePath(selectedSite.id, "credentials"), { method: "DELETE" });
    await refreshSite();
    successMessage = "Credenziali rimosse.";
  }

  async function loadSettings(): Promise<void> {
    const navigation = navigationSeq;
    const [result, databases] = await Promise.all([
      api<{ accountId: string; language: Language; dataDirectory: string; token: Bootstrap["token"] }>("/api/settings"),
      api<{ connections: DatabaseConnection[] }>("/api/database-connections"),
    ]);
    settingsAccountId = result.accountId;
    settingsLanguage = result.language;
    settingsTokenState = result.token;
    cloudflareAccounts = [];
    dataDirectoryDisplay = result.dataDirectory;
    databaseConnections = databases.connections;
    arrive("settings", navigation);
  }

  /** How the AI connector's chip, approval banner and settings section reach the app: toasts, catalog, project. */
  const connectorHooks = {
    onNotice: (message: string, action?: { label: string; projectId?: string }, fromAgent = false) => {
      nextToastFromAgent = fromAgent;
      if (action?.projectId) {
        const projectId = action.projectId;
        nextToastAction = { label: action.label, run: () => void act(() => openCmsProject(projectId)) };
      }
      successMessage = message;
    },
    onError: (message: string) => { nextToastFromAgent = false; errorMessage = message; },
    onProjectsChanged: () => void refresh(),
    onOpen: () => nav("agent"),
    onOpenProject: (projectId: string) => void act(() => openCmsProject(projectId)),
    onOpenReport: (projectId: string) => void act(() => openCmsImportReport(projectId)),
    onOpenSite: (projectId: string) => void act(async () => { await openCmsProject(projectId); openCmsTab("publish", "cms-linked-sites"); }),
    onPendingChange: (count: number) => { pendingApprovals = count; },
  };

  async function verifyWordPressPreflight(): Promise<void> {
    if (!selectedSite || !wordpressDatabaseConnectionId) throw new Error(say("Scegli prima una connessione database salvata.", "Choose a saved database connection first."));
    const result = await api<WordPressPreflight>(sitePath(selectedSite.id, "hosting/wordpress-preflight"), {
      method: "POST",
      body: JSON.stringify({ databaseConnectionId: wordpressDatabaseConnectionId }),
    });
    wordpressPreflight = result;
    successMessage = result.status === "awaiting-php-check"
      ? say("Cartella e database superano i controlli attuali. Il preflight non installa WordPress: manca ancora il controllo runtime PHP.", "The directory and database pass the current checks. This preflight does not install WordPress; the PHP runtime check is still missing.")
      : say("Preflight bloccato: controlla cartella, database, versione e permessi indicati qui sotto. Non è stato installato nulla.", "Preflight blocked: review the directory, database, version, and permissions below. Nothing was installed.");
  }

  async function verifyWordPressRuntime(): Promise<void> {
    if (!selectedSite || !wordpressDatabaseConnectionId) throw new Error(say("Scegli prima una connessione database salvata.", "Choose a saved database connection first."));
    const result = await api<WordPressPreflight>(sitePath(selectedSite.id, "hosting/wordpress-runtime-check"), {
      method: "POST",
      body: JSON.stringify({ databaseConnectionId: wordpressDatabaseConnectionId }),
    });
    wordpressPreflight = result;
    successMessage = result.status === "ready-for-install"
      ? say(`Prerequisiti verificati: PHP ${result.runtime.phpVersion} e HTTPS raggiungibile. L’installazione non è ancora partita.`, `Prerequisites verified: PHP ${result.runtime.phpVersion} and HTTPS reachable. Installation has not started.`)
      : say("Prerequisiti WordPress non superati. Non è stata avviata alcuna installazione.", "WordPress prerequisites did not pass. No installation was started.");
  }

  async function loadWordPressProvisionPlans(): Promise<void> {
    if (!selectedSite || !selectedSite.hosting || !selectedSite.hostingCredentialsConfigured) {
      wordpressProvisionPlans = [];
      wordpressProvisionPlan = null;
      return;
    }
    const result = await api<{ plans: WordPressProvisionPlan[] }>(sitePath(selectedSite.id, "hosting/wordpress-install"));
    wordpressProvisionPlans = result.plans;
    wordpressProvisionPlan = result.plans.find((plan) => plan.id === wordpressProvisionPlan?.id)
      ?? result.plans.find((plan) => ["planned", "uploading", "installing", "recovering", "needs-recovery"].includes(plan.state))
      ?? result.plans[0]
      ?? null;
  }

  async function prepareWordPressInstall(): Promise<void> {
    if (!selectedSite || !wordpressDatabaseConnectionId) throw new Error(say("Scegli una connessione database verificata.", "Choose a verified database connection."));
    if (wordpressPreflight?.status !== "ready-for-install") throw new Error(say("Completa prima il preflight WordPress, compreso il controllo PHP e TLS.", "Complete the WordPress preflight first, including the PHP and TLS checks."));
    const result = await api<{ plan: WordPressProvisionPlan }>(sitePath(selectedSite.id, "hosting/wordpress-install"), {
      method: "POST",
      body: JSON.stringify({
        databaseConnectionId: wordpressDatabaseConnectionId,
        siteTitle: wordpressProvisionSiteTitle.trim(),
        adminUsername: wordpressProvisionAdminUsername.trim(),
        adminEmail: wordpressProvisionAdminEmail.trim(),
        adminPassword: wordpressProvisionAdminPassword,
      }),
    });
    wordpressProvisionAdminPassword = "";
    wordpressProvisionPlan = result.plan;
    await loadWordPressProvisionPlans();
    successMessage = say("Piano pronto. Controlla destinazione, database e versioni qui sotto prima di avviare l’installazione.", "The plan is ready. Review the destination, database, and versions below before starting the installation.");
  }

  async function applyWordPressInstall(planId: string): Promise<void> {
    if (!selectedSite) return;
    const result = await api<{ plan: WordPressProvisionPlan }>(sitePath(selectedSite.id, `hosting/wordpress-install/${encodeURIComponent(planId)}/apply`), {
      method: "POST",
      body: "{}",
    });
    wordpressProvisionPlan = result.plan;
    await loadWordPressProvisionPlans();
    if (result.plan.state === "complete") {
      const projectId = selectedCmsProject?.project.id;
      const connectionId = result.plan.result?.connectionId;
      if (projectId && connectionId) {
        await refresh();
        if (cmsConnections.some((connection) => connection.id === connectionId)) {
          await openCmsProject(projectId);
          cmsDeploySiteId = `wordpress:${connectionId}`;
          successMessage = say("WordPress e Histeon sono pronti. Ho selezionato il nuovo sito: rivedi il piano per trasferire il progetto. Non ho pubblicato contenuti.", "WordPress and Histeon are ready. I selected the new site; review the plan to transfer this project. No content has been published.");
          return;
        }
      }
      successMessage = say("WordPress e Histeon sono installati e il sito è abbinato. Non ho importato o pubblicato contenuti.", "WordPress and Histeon are installed and the site is connected. No content was imported or published.");
    } else if (result.plan.state === "needs-recovery") {
      successMessage = say("Il sito risponde ancora al piano. Puoi riprendere la verifica e completare l’abbinamento.", "The site still responds to this plan. You can resume the check and finish connecting it.");
    }
  }

  async function saveDatabaseConnection(): Promise<void> {
    const updating = Boolean(editingDatabaseConnectionId);
    const sshTunnel = databaseUseSshTunnel ? {
      host: databaseSshHost,
      port: databaseSshPort,
      username: databaseSshUsername,
      authMethod: databaseSshAuthMethod,
      hostKeyFingerprint: databaseSshHostKeyFingerprint,
      ...(databaseSshAuthMethod === "password" ? { password: databaseSshPassword } : { privateKey: databaseSshPrivateKey, ...(databaseSshPassphrase ? { passphrase: databaseSshPassphrase } : {}) }),
    } : undefined;
    const result = await api<{ connection: DatabaseConnection }>(editingDatabaseConnectionId ? `/api/database-connections/${encodeURIComponent(editingDatabaseConnectionId)}` : "/api/database-connections", {
      method: updating ? "PUT" : "POST",
      body: JSON.stringify({
        name: databaseConnectionName,
        host: databaseHost,
        port: databasePort,
        databaseName,
        tablePrefix: databaseTablePrefix,
        username: databaseUsername,
        password: databasePassword,
        caCertificate: databaseCaCertificate,
        ...(sshTunnel ? { sshTunnel } : {}),
      }),
    });
    databaseConnections = editingDatabaseConnectionId
      ? databaseConnections.map((connection) => connection.id === result.connection.id ? result.connection : connection)
      : [result.connection, ...databaseConnections];
    editingDatabaseConnectionId = null;
    databaseUsername = "";
    databasePassword = "";
    databaseCaCertificate = "";
    databaseSshPassword = "";
    databaseSshPrivateKey = "";
    databaseSshPassphrase = "";
    successMessage = t(updating ? "db.updated" : "db.saved");
  }

  async function verifyDatabaseSshHostKey(): Promise<void> {
    if (!databaseSshHost.trim()) throw new Error(say("Inserisci prima l’host SSH.", "Enter the SSH host first."));
    const result = await api<{ hostKeyFingerprint: string }>("/api/database-connections/ssh-hostkey", {
      method: "POST",
      body: JSON.stringify({ host: databaseSshHost, port: databaseSshPort }),
    });
    databaseSshHostKeyFingerprint = result.hostKeyFingerprint;
    databaseSshHostKeyIdentity = `${databaseSshHost.trim().toLowerCase()}:${databaseSshPort}`;
    databaseSshHostKeyConfirmed = false;
  }

  function editDatabaseConnection(connection: DatabaseConnection): void {
    editingDatabaseConnectionId = connection.id;
    databaseConnectionName = connection.name;
    databaseHost = connection.host;
    databasePort = connection.port;
    databaseName = connection.databaseName;
    databaseTablePrefix = connection.tablePrefix;
    databaseUsername = "";
    databasePassword = "";
    databaseCaCertificate = "";
    databaseUseSshTunnel = Boolean(connection.sshTunnel);
    databaseSshHost = connection.sshTunnel?.host ?? "";
    databaseSshPort = connection.sshTunnel?.port ?? 22;
    databaseSshUsername = connection.sshTunnel?.username ?? "";
    databaseSshAuthMethod = connection.sshTunnel?.authMethod ?? "password";
    databaseSshPassword = "";
    databaseSshPrivateKey = "";
    databaseSshPassphrase = "";
    databaseSshHostKeyFingerprint = connection.sshTunnel?.hostKeyFingerprint ?? "";
    databaseSshHostKeyIdentity = connection.sshTunnel ? `${connection.sshTunnel.host.toLowerCase()}:${connection.sshTunnel.port}` : "";
    databaseSshHostKeyConfirmed = Boolean(connection.sshTunnel?.hostKeyFingerprint);
  }

  function cancelDatabaseConnectionEdit(): void {
    editingDatabaseConnectionId = null;
    databaseUsername = "";
    databasePassword = "";
    databaseCaCertificate = "";
    databaseSshPassword = "";
    databaseSshPrivateKey = "";
    databaseSshPassphrase = "";
  }

  async function recheckDatabaseConnection(id: string): Promise<void> {
    const result = await api<{ connection: DatabaseConnection }>(`/api/database-connections/${encodeURIComponent(id)}/probe`, { method: "POST" });
    databaseConnections = databaseConnections.map((connection) => connection.id === id ? result.connection : connection);
    successMessage = `${t("db.lastCheck")}: ${formatDate(result.connection.checkedAt)}`;
  }

  async function removeDatabaseConnection(id: string): Promise<void> {
    await api(`/api/database-connections/${encodeURIComponent(id)}`, { method: "DELETE" });
    databaseConnections = databaseConnections.filter((connection) => connection.id !== id);
    databaseRemoval = null;
    successMessage = t("db.remove");
  }

  async function confirmRemoveDatabaseConnection(): Promise<void> {
    if (databaseRemoval) await removeDatabaseConnection(databaseRemoval.id);
  }

  let dataDirectoryDisplay = $state("");
  async function saveSettings(): Promise<void> {
    const result = await api<{ accountId: string; language: Language; token: Bootstrap["token"] }>("/api/settings", { method: "POST", body: JSON.stringify({ accountId: settingsAccountId, language: settingsLanguage }) });
    settingsTokenState = result.token;
    language = settingsLanguage;
    await refresh();
    successMessage = t("common.saved");
  }

  async function verifyAndSaveToken(): Promise<void> {
    const result = await api<{ token: Bootstrap["token"]; accountOwned?: boolean; accountId?: string | null }>("/api/settings/cloudflare-token", { method: "POST", body: JSON.stringify({ token: settingsToken, accountId: settingsAccountId }) });
    settingsTokenState = result.token;
    if (result.accountId) settingsAccountId = result.accountId;
    settingsToken = "";
    successMessage = "Token verificato e salvato nel portachiavi.";
    try { await discoverCloudflareAccounts(); }
    catch (error) {
      errorMessage = error instanceof Error ? error.message : "Non riesco a trovare gli account Cloudflare.";
    }
  }

  async function discoverCloudflareAccounts(): Promise<void> {
    const result = await api<{ accounts: CloudflareAccount[] }>("/api/cloudflare/accounts");
    cloudflareAccounts = result.accounts;
    if (result.accounts.length === 0) throw new Error("Non ho trovato account Cloudflare accessibili. Controlla il token o inserisci l’ID account manualmente.");
    if (result.accounts.length === 1) {
      const account = result.accounts[0];
      if (!account) throw new Error("La risposta Cloudflare non contiene un account valido.");
      settingsAccountId = account.id;
      await saveSettings();
      successMessage = `Account Cloudflare “${account.name}” selezionato automaticamente.`;
      return;
    }
    if (!result.accounts.some((account) => account.id === settingsAccountId)) settingsAccountId = "";
    successMessage = `Ho trovato ${result.accounts.length} account. Scegline uno e salva le impostazioni.`;
  }

  async function removeToken(): Promise<void> {
    const result = await api<{ token: Bootstrap["token"] }>("/api/settings/cloudflare-token", { method: "DELETE" });
    settingsTokenState = result.token;
    cloudflareAccounts = [];
    successMessage = "Token rimosso.";
  }

  /** The site settings that differ from what is saved: what «Salva configurazione» would send. */
  function unsavedSiteSettings(): string[] {
    if (!selectedSite) return [];
    const list = (value: string): string => value.split(/[\s,;]+/u).filter(Boolean).join(",");
    const changed: string[] = [];
    if (deployTarget !== (selectedSite.deployTarget ?? "cloudflare")) changed.push(say("destinazione", "destination"));
    if (workerName.trim() !== (selectedSite.worker ?? "")) changed.push(say("nome del Worker", "Worker name"));
    if (accountId.trim() !== (selectedSite.accountId ?? bootstrap?.accountId ?? "")) changed.push(say("account Cloudflare", "Cloudflare account"));
    if (renderMode !== (selectedSite.render ?? false)) changed.push(say("rendering", "rendering"));
    if (pagefindEnabled !== (selectedSite.pagefind ?? false)) changed.push("Pagefind");
    if (list(kvNames) !== (selectedSite.kv ?? []).join(",")) changed.push(say("archivi KV", "KV namespaces"));
    const wordpress = selectedSite.forms?.wordpress;
    if (formsRestUrl.trim() !== (wordpress?.restUrl ?? "") || list(formsIds) !== (wordpress?.fluentFormIds ?? []).join(",") || turnstileSiteKey.trim() !== (wordpress?.turnstileSiteKey ?? "")) changed.push("Fluent Forms");
    if (turnstileSecret.trim()) changed.push(say("chiave segreta Turnstile", "Turnstile secret key"));
    return changed;
  }

  async function publishWithFreshBuild(): Promise<void> {
    if (!selectedSite) return;
    errorMessage = "";
    // What the configuration card shows is what gets published: unsaved Cloudflare settings are saved first; a
    // changed destination or unsaved hosting settings stop here, since saving them means verifying the server.
    const unsaved = unsavedSiteSettings();
    if (unsaved.length > 0) {
      if (deployTarget !== "cloudflare" || (selectedSite.deployTarget ?? "cloudflare") !== "cloudflare") {
        throw new Error(say(`La configurazione del sito ha modifiche non salvate (${unsaved.join(", ")}): salvala con «Salva configurazione», poi pubblica.`, `The site settings have unsaved changes (${unsaved.join(", ")}): save them with “Save settings”, then publish.`));
      }
      await saveSiteSettings();
      if (!selectedSite) return;
    }
    const siteId = selectedSite.id;
    const target = selectedSite.deployTarget ?? "cloudflare";
    if (target === "ftp" && (!selectedSite.hosting?.host || !selectedSite.hostingCredentialsConfigured)) {
      throw new Error(say("Completa e verifica prima la destinazione FTP/FTPS nelle impostazioni del sito.", "Complete and verify the FTP/FTPS destination in site settings first."));
    }
    if (target === "cloudflare" && !bootstrap?.token.configured) {
      await loadSettings();
      errorMessage = "Collega Cloudflare nelle Impostazioni, poi torna qui per pubblicare.";
      return;
    }
    if (target === "cloudflare" && !selectedSite.accountId && !bootstrap?.accountId) {
      try {
        const result = await api<{ accounts: CloudflareAccount[] }>("/api/cloudflare/accounts");
        cloudflareAccounts = result.accounts;
        if (result.accounts.length === 1 && result.accounts[0]) {
          settingsAccountId = result.accounts[0].id;
          await api("/api/settings", { method: "POST", body: JSON.stringify({ accountId: settingsAccountId }) });
          await refresh();
          successMessage = `Account Cloudflare “${result.accounts[0].name}” trovato e selezionato.`;
        } else {
          await loadSettings();
          cloudflareAccounts = result.accounts;
          errorMessage = result.accounts.length > 1
            ? "Ho trovato più account: scegline uno nelle Impostazioni e poi ripeti la pubblicazione."
            : "Non ho trovato account accessibili: controlla il permesso Account Settings Read o inserisci l’ID nelle Impostazioni.";
          return;
        }
      } catch (error) {
        await loadSettings();
        errorMessage = error instanceof Error ? error.message : "Non riesco a trovare l’account Cloudflare.";
        return;
      }
    }
    if (target === "cloudflare" && !selectedSite.worker) throw new Error("Apri le impostazioni del sito e scegli il nome del Worker.");

    screen = "site";
    const build = await api<{ jobId: string; buildId: string }>(sitePath(selectedSite.id, "build"), { method: "POST", body: "{}" });
    activeJob = { id: build.jobId, type: "build", status: "running", events: [], buildId: build.buildId };
    await followJob(build.jobId, receiveJobEvent);
    const builtReport = await api<BuildResult>(`/api/builds/${encodeURIComponent(build.buildId)}/report`);
    await refreshSite();
    mergeSavedKv(selectedSite);
    if (activeJob?.status === "cancelled") {
      successMessage = t("build.cancelledNothingSent");
      return;
    }
    if (builtReport.status === "ready" || builtReport.status === "blocked") report = builtReport;
    if (builtReport.status !== "ready") {
      if (builtReport.status === "blocked") {
        screen = "report";
        errorMessage = target === "cloudflare"
          ? say("La versione è bloccata dai controlli. Non è stato inviato nulla a Cloudflare; apri il report per vedere cosa correggere.", "The version is blocked by the checks. Nothing was sent to Cloudflare; open the report to see what to fix.")
          : say("La versione è bloccata dai controlli. Non è stato caricato nulla sul server; apri il report per vedere cosa correggere.", "The version is blocked by the checks. Nothing was uploaded; open the report to see what to fix.");
        return;
      }
      throw new Error(target === "cloudflare" ? say("La versione non è riuscita. Non è stato inviato nulla a Cloudflare.", "The version failed. Nothing was sent to Cloudflare.") : say("La versione non è riuscita. Non è stato caricato nulla sul server.", "The version failed. Nothing was uploaded to the server."));
    }

    // E6: nothing goes online before the summary and the user's confirmation. The summary names the site's
    // destination as it is now (settings may have changed during the build), and only for the site that was built.
    if (selectedSite?.id !== siteId) {
      successMessage = say("Sito pronto: riapri il sito per pubblicarla.", "Build ready: open the site again to publish it.");
      return;
    }
    const now = selectedSite;
    const currentTarget = now.deployTarget ?? "cloudflare";
    const label = currentTarget === "cloudflare" ? `Cloudflare · ${now.worker ?? ""}${now.domain ? ` · ${now.domain}` : ""}` : `${now.hosting?.protocol.toUpperCase() ?? ""} · ${now.hosting?.host ?? ""} · ${now.hosting?.remoteDirectory || "/"}`;
    siteDeploySummary = { siteId, build: builtReport, target: currentTarget, destination: now.deployDestination ?? "", label };
  }

  async function confirmSiteDeploy(): Promise<void> {
    const summary = siteDeploySummary;
    if (!summary || !selectedSite || selectedSite.id !== summary.siteId) return;
    siteDeploySummary = null;
    const target = summary.target;
    const previousEvents = activeJob?.events ?? [];
    const deploy = await api<{ jobId: string }>(sitePath(selectedSite.id, "deploy"), { method: "POST", body: JSON.stringify({ buildId: summary.build.id, confirmed: true, expectedDestination: summary.destination }) });
    activeJob = { id: deploy.jobId, type: "deploy", status: "running", events: previousEvents };
    await followJob(deploy.jobId, receiveJobEvent);
    await refreshSite();
    // A failed publish is not a success: the notice says why and where it stopped (voce 228).
    const ended = activeJob?.id === deploy.jobId ? activeJob : null;
    if (ended && ended.status !== "complete") {
      if (ended.status === "failed") {
        const end = ended.events.filter((event) => event.type === "job-finished").at(-1);
        throw new Error(deployFailure(language, end?.error, end?.phase) ?? t("progress.failed"));
      }
      return;
    }
    successMessage = target === "cloudflare"
      ? say("Sito pronto e pubblicata su Cloudflare.", "Build ready and published to Cloudflare.")
      : say("Sito pronto e caricata sull’hosting. I file non presenti nella nuova versione restano sul server.", "Build uploaded to the hosting provider. Files absent from the new build remain on the server.");
  }

  /** Bumped by every navigation: a screen that finishes loading later does not pull the user back. */
  let navigationSeq = 0;
  function nav(target: Screen): void { navigationSeq++; screen = target; errorMessage = ""; successMessage = ""; }
  /** A screen reached after loading: only if the user has not gone elsewhere since the action began. */
  function arrive(target: Screen, navigation: number): void {
    if (navigation !== navigationSeq) return;
    navigationSeq++;
    screen = target;
  }

  function showCmsConnectionImport(): void {
    cmsCatalogFilter = "connected";
    window.setTimeout(() => {
      const heading = document.getElementById("cms-connect-title");
      heading?.scrollIntoView({ behavior: "smooth", block: "start" });
      heading?.focus({ preventScroll: true });
    }, 0);
  }

  /** `navigation`: the navigation count when the user's action began (a create or import awaits before it opens). */
  async function openCmsProject(projectId: string, navigation = navigationSeq): Promise<void> {
    const details = await api<CmsProjectDetails>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}`);
    // The user went elsewhere while it loaded: this project does not take the screen back, nor change its state.
    if (navigation !== navigationSeq) return;
    if (selectedCmsProject?.project.id !== projectId) {
      cmsTab = "pages";
      adminSection = "bacheca";
      cmsSelecting = false;
      cmsTrashSelection = [];
      cmsTrashConnectionId = "";
      cmsWordPressSetupSiteId = "";
    }
    cmsMoreOpen = false;
    if (cmsImportReport && cmsImportReport.projectId !== projectId) cmsImportReport = null;
    selectedCmsProject = details;
    cmsRenderLocale = selectedCmsProject.renderSettings.locale;
    cmsRenderTimeZone = selectedCmsProject.renderSettings.timeZone;
    cmsImageVariants = selectedCmsProject.imageSettings?.variants ?? true;
    cmsBuild = null;
    cmsBuildHistory = [];
    cmsPublishPlan = null;
    cmsPublishPlanConfirmed = false;
    cmsDeploySiteId = "";
    arrive("cms", navigation);
    await refreshCmsBuildHistory(projectId, true);
  }

  async function refreshCmsBuildHistory(projectId: string, selectLatest = false): Promise<void> {
    const result = await api<{ builds: CmsBuild[] }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/builds`);
    cmsBuildHistory = result.builds;
    const latest = result.builds[0] ?? null;
    // The registry keeps no image note (B6): the build's own answer keeps it while the same build is shown.
    if (selectLatest || (latest && latest.id === cmsBuild?.id)) cmsBuild = latest && cmsBuild?.imagesNote && latest.id === cmsBuild.id ? { ...latest, imagesNote: cmsBuild.imagesNote } : latest;
  }

  async function createCmsProject(): Promise<void> {
    const navigation = navigationSeq;
    const created = await api<{ project: CmsProject }>("/api/cms/v1/projects", { method: "POST", body: JSON.stringify({ name: cmsProjectName.trim() }) });
    cmsProjectName = "";
    await refresh();
    await openCmsProject(created.project.id, navigation);
  }






  async function enableCmsPostTaxonomies(): Promise<void> {
    if (!selectedCmsProject) return;
    const projectId = selectedCmsProject.project.id;
    // Same labels as WordPress exports for its native taxonomies, so both sides hash them alike.
    for (const [key, label] of [["category", "Categorie"], ["post_tag", "Tag"]] as const) {
      if (selectedCmsProject.taxonomies.some((taxonomy) => taxonomy.key === key)) continue;
      await api(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/taxonomies`, { method: "POST", body: JSON.stringify({ key, label, types: ["post"] }) });
    }
    await openCmsProject(projectId);
    cmsContentPanelKey += 1;
    successMessage = t("cms.postTaxonomiesCreated");
  }

  async function setCmsTemplateRole(template: CmsTemplate, role: string): Promise<void> {
    if (!selectedCmsProject) return;
    const projectId = selectedCmsProject.project.id;
    await api(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/templates/${template.alias}/role`, { method: "PUT", body: JSON.stringify({ role: role || null }) });
    await openCmsProject(projectId);
    successMessage = t("cms.roleSaved");
  }

  async function createCmsTemplate(): Promise<void> {
    if (!selectedCmsProject) return;
    const projectId = selectedCmsProject.project.id;
    await api(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/templates`, { method: "POST", body: JSON.stringify({ title: cmsTemplateTitle.trim(), ref: cmsTemplateRef.trim() }) });
    cmsTemplateTitle = "";
    cmsTemplateRef = "";
    await openCmsProject(projectId);
  }

  async function createCmsTemplatePart(): Promise<void> {
    if (!selectedCmsProject) return;
    const projectId = selectedCmsProject.project.id;
    await api(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/template-parts`, { method: "POST", body: JSON.stringify({ title: cmsTemplatePartTitle.trim(), ref: cmsTemplatePartRef.trim() }) });
    cmsTemplatePartTitle = "";
    cmsTemplatePartRef = "";
    await openCmsProject(projectId);
  }



  async function restoreCmsDeletion(id: string): Promise<void> {
    if (!selectedCmsProject) return;
    const projectId = selectedCmsProject.project.id;
    await api(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/recovery/tombstones/${encodeURIComponent(id)}`, { method: "POST", body: "{}" });
    await openCmsProject(projectId);
    successMessage = t("cms.deletionRestored");
  }

  // ------------------------------------------------------------------ E14: the project page in tabs
  /** The tabs in order, with their address after `#/cms/<id>/` ("pagine" is the default and has none). */
  const CMS_TABS: ReadonlyArray<{ id: CmsTab; slug: string; key: string }> = [
    { id: "pages", slug: "pagine", key: "cms.tab.pages" },
    { id: "posts", slug: "articoli", key: "cms.tab.posts" },
    { id: "content", slug: "contenuti", key: "cms.tab.content" },
    { id: "templates", slug: "template", key: "cms.tab.templates" },
    { id: "media", slug: "media", key: "cms.tab.media" },
    { id: "publish", slug: "pubblica", key: "cms.tab.publish" },
    { id: "settings", slug: "impostazioni", key: "cms.tab.settings" },
  ];
  let cmsTab = $state<CmsTab>("pages");
  /** "Seleziona": the boxes for the Cestino appear only in this mode. */
  let cmsSelecting = $state(false);
  let cmsMoreOpen = $state(false);



  /** The tab an address names (Back, Forward): the focus does not stay in a panel that is now hidden. */
  function showCmsTabFromRoute(tab: CmsTab): void {
    openCmsTab(tab);
  }


  /** Shows a tab; with a target, moves the focus (or the view, for a section) there once it is on screen. */
  /** What used to be the project's tabs are sections of its administration (doc 22 §R2). */
  const CMS_SECTION: Record<CmsTab, string> = { pages: "pagine", posts: "articoli", content: "contenuti", templates: "aspetto", media: "media", publish: "pubblica", settings: "impostazioni" };
  function openCmsTab(tab: CmsTab, target = ""): void {
    cmsTab = tab;
    adminSection = CMS_SECTION[tab];
    cmsMoreOpen = false;
    if (screen !== "admin") nav("admin");
    if (!target) return;
    void tick().then(() => {
      const element = document.getElementById(target);
      element?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (element?.tabIndex === -1) element.focus({ preventScroll: true });
    });
  }




  /** The menu also closes when the focus or a click goes elsewhere. */
  function closeCmsMoreOutside(event: Event): void {
    if (!cmsMoreOpen) return;
    const menu = document.querySelector(".cms-more-menu");
    const target = (event instanceof FocusEvent ? event.relatedTarget : event.target) as Node | null;
    if (menu && target && menu.contains(target)) return;
    if (event instanceof FocusEvent && !target) return;
    cmsMoreOpen = false;
  }


  function toggleCmsTrashSelection(id: string, checked: boolean): void {
    cmsTrashSelection = checked
      ? [...new Set([...cmsTrashSelection, id])]
      : cmsTrashSelection.filter((selectedId) => selectedId !== id);
  }

  async function trashCmsSelection(): Promise<void> {
    if (!selectedCmsProject) return;
    const projectId = selectedCmsProject.project.id;
    const connection = cmsTrashConnectionId ? cmsTrashConnections.find((item) => item.id === cmsTrashConnectionId) : undefined;
    if (cmsTrashConnectionId && !connection) throw new Error(t("cms.trashConnectionUnavailable"));
    if (cmsTrashSelection.length === 0) return;
    await api(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/trash`, {
      method: "POST",
      body: JSON.stringify({ ...(connection ? { connectionId: connection.id } : {}), entityIds: cmsTrashSelection }),
    });
    showCmsTrashConfirm = false;
    cmsTrashSelection = [];
    cmsSelecting = false;
    await openCmsProject(projectId);
    cmsContentPanelKey += 1;
    successMessage = t(connection ? "cms.deletionQueued" : "cms.localDeletionQueued");
  }

  function launchCmsEditor(page: { alias: number }, back?: string): void {
    if (!selectedCmsProject) return;
    const target = `/cms-editor.html?project=${encodeURIComponent(selectedCmsProject.project.id)}&document=${encodeURIComponent(page.alias)}${back ? `&back=${encodeURIComponent(back)}` : ""}`;
    window.location.assign(target);
  }

  /**
   * The whole site as visitors would see it: the latest build when it is the project as it is now, otherwise a new one,
   * opened on its home page with every page, link and asset (the desktop app shows it in a window of its own).
   */
  async function previewCmsSite(): Promise<void> {
    if (!selectedCmsProject) return;
    const projectId = selectedCmsProject.project.id;
    // In a browser a window opened after awaiting the build would be blocked as a pop-up: it opens now, empty.
    const desktop = location.protocol === "app:";
    const target = desktop ? null : window.open("about:blank", "_blank");
    try {
      await refreshCmsBuildHistory(projectId, true);
      if (!(cmsBuild?.status === "ready" && cmsBuild.current !== false)) await buildCmsProject();
      if (cmsBuild?.status !== "ready") {
        target?.close();
        return;
      }
      const { previewUrl } = await api<{ previewUrl: string }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/builds/${encodeURIComponent(cmsBuild.id)}/preview`, { method: "POST", body: "{}" });
      if (target) {
        target.opener = null;
        target.location.href = previewUrl;
      } else window.open(previewUrl, "_blank");
    } catch (error) {
      target?.close();
      throw error;
    }
  }

  /** One page or post as it is now, drafts too, from the site administration: an ephemeral build, never published. */
  async function previewCmsDocument(alias: number): Promise<void> {
    if (!selectedCmsProject) return;
    const desktop = location.protocol === "app:";
    const target = desktop ? null : window.open("about:blank", "_blank");
    try {
      const { previewUrl } = await api<{ previewUrl: string | null }>(`/api/cms/v1/projects/${encodeURIComponent(selectedCmsProject.project.id)}/build`, { method: "POST", body: JSON.stringify({ previewAlias: alias }) });
      if (!previewUrl) throw new Error(t("error.generic"));
      if (target) {
        target.opener = null;
        target.location.href = previewUrl;
      } else window.open(previewUrl, "_blank");
    } catch (error) {
      target?.close();
      throw error;
    }
  }

  /** A notice of the site administration, in the app's toasts; `action` is what undoes it. */
  function adminNotice(text: string, failed = false, action?: { label: string; run: () => void }): void {
    if (action) nextToastAction = action;
    pushToast(failed ? "error" : "success", text);
  }

  async function buildCmsProject(): Promise<void> {
    if (!selectedCmsProject) return;
    cmsDeployHealthCheck = null;
    cmsPublishPlan = null;
    cmsPublishPlanConfirmed = false;
    cmsBuilding = true;
    try {
      cmsBuild = await api<CmsBuild>(`/api/cms/v1/projects/${encodeURIComponent(selectedCmsProject.project.id)}/build`, { method: "POST", body: "{}" });
    } finally {
      cmsBuilding = false;
    }
    await refreshCmsBuildHistory(selectedCmsProject.project.id);
    if (cmsBuild.status === "ready") {
      if (cmsBuild.previewUrl) nextToastAction = { label: t("cms.openPreview"), href: cmsBuild.previewUrl };
      successMessage = t("cms.buildDone", { pages: cmsBuild.pages });
    }
    // The result appears right under the project title and takes the focus, so it is seen and announced at once.
    await tick();
    cmsBuildSummary?.focus();
  }


  /** The sites the open project may publish to: every general site, and the destinations created for it (E6). */
  function cmsProjectSites(): Site[] {
    const projectId = selectedCmsProject?.project.id;
    return sites.filter((site) => !site.cmsProjectId || site.cmsProjectId === projectId);
  }

  function cmsDeploymentTargets(): CmsDeploySite[] {
    return availableCmsDeployTargets(cmsProjectSites(), bootstrap?.token, bootstrap?.accountId);
  }

  /** E6: the static site as a .zip, building first when there is no current ready build. */
  async function downloadCmsStaticZip(): Promise<void> {
    if (!selectedCmsProject) return;
    if (!cmsBuild || cmsBuild.status !== "ready" || cmsBuild.current === false) await buildCmsProject();
    if (cmsBuild?.status !== "ready") return;
    await exportCmsStaticBuild();
  }

  /** E6: a destination for this project only, where Cloudflare or the hosting is set up; it opens at once. */
  async function createCmsDestinationSite(): Promise<void> {
    if (!selectedCmsProject) return;
    const project = selectedCmsProject.project;
    const created = await api<{ site: Site }>("/api/sites", { method: "POST", body: JSON.stringify({ name: project.name.slice(0, 80), source: { kind: "cms", path: project.id } }) });
    await refresh();
    await openSite(created.site.id);
    successMessage = t("cms.wayHostingCreated", { name: project.name });
  }

  function cmsProjectNameById(projectId: string): string {
    return cmsProjects.find((project) => project.id === projectId)?.name ?? t("cms.title");
  }

  function cmsPublishDestinations(): Array<{ id: string; label: string; kind: "static" | "wordpress" | "new-wordpress" }> {
    const staticDestinations = cmsDeploymentTargets().map((site) => ({ id: site.id, label: cmsDeployTargetLabel(site), kind: "static" as const }));
    const projectId = selectedCmsProject?.project.id;
    const wordpressDestinations = cmsConnections
      .filter((connection) => connection.publish && connection.write && (!connection.projectId || connection.projectId === projectId))
      .map((connection) => ({
        id: `wordpress:${connection.id}`,
        label: `${connection.projectName || new URL(connection.url).hostname} · WordPress · ${new URL(connection.url).hostname}`,
        kind: "wordpress" as const,
      }));
    const newWordPressDestinations = cmsProjectSites()
      .filter((site) => site.deployTarget === "ftp" && site.hosting?.host && site.hosting.publicUrl && site.hostingCredentialsConfigured)
      .map((site) => ({
        id: `wordpress-new:${site.id}`,
        label: `${site.name} · Nuovo WordPress · ${site.hosting?.host ?? ""}`,
        kind: "new-wordpress" as const,
      }));
    return [...staticDestinations, ...wordpressDestinations, ...newWordPressDestinations];
  }

  async function prepareCmsPublishPlan(): Promise<void> {
    if (!selectedCmsProject || !cmsBuild || cmsBuild.status !== "ready" || cmsBuild.current === false) throw new Error(say("Questa versione è obsoleta. Creane una nuova prima di pubblicare.", "This build is out of date. Create a new build before publishing."));
    const projectId = selectedCmsProject.project.id;
    cmsDeployHealthCheck = null;
    const target = cmsDeploymentTargets().find((site) => site.id === cmsDeploySiteId);
    if (!target) throw new Error(t("cms.chooseDestination"));
    cmsPublishPlan = null;
    cmsPublishPlanConfirmed = false;
    const plan = await api<CmsPublishPlan>("/api/cms/v1/destinations/plan", {
      method: "POST",
      body: JSON.stringify({ destinationId: target.id, action: "deploy", projectId, buildId: cmsBuild.id }),
    });
    if (plan.projectId !== projectId || plan.buildId !== cmsBuild.id || plan.destination.id !== target.id || plan.writeVerified !== false) {
      throw new Error(say("Il piano ricevuto non corrisponde alla versione o alla destinazione scelte.", "The returned plan does not match the selected build or destination."));
    }
    cmsPublishPlan = plan;
  }

  /** «Pubblica»: with one place to publish to there is nothing to ask, and the plan comes up at once. */
  function publishNow(): void {
    openCmsTab("publish", "cms-publish-heading");
    const destinations = cmsPublishDestinations();
    if (destinations.length !== 1 || destinations[0]?.id.startsWith("wordpress-new:")) return;
    cmsDeploySiteId = destinations[0]!.id;
    void act(prepareCmsDestinationPlan);
  }

  async function prepareCmsDestinationPlan(): Promise<void> {
    if (cmsDeploySiteId.startsWith("wordpress:")) {
      const connectionId = cmsDeploySiteId.slice("wordpress:".length);
      const connection = cmsConnections.find((item) => item.id === connectionId);
      if (!connection || !connection.publish || !connection.write || (connection.projectId && connection.projectId !== selectedCmsProject?.project.id)) {
        throw new Error(say("Il collegamento WordPress non è più autorizzato per questo progetto. Aggiorna i collegamenti e riprova.", "This WordPress connection is no longer authorized for this project. Refresh the connections and try again."));
      }
      cmsPublishPlan = null;
      cmsPublishPlanConfirmed = false;
      await pushCmsProject(connection, "publish");
      return;
    }
    if (cmsDeploySiteId.startsWith("wordpress-new:")) {
      const siteId = cmsDeploySiteId.slice("wordpress-new:".length);
      const site = sites.find((item) => item.id === siteId);
      if (!site?.hosting?.host || !site.hosting.publicUrl || !site.hostingCredentialsConfigured) {
        throw new Error(say("La destinazione per il nuovo WordPress non è più configurata. Verifica hosting e credenziali e riprova.", "The new WordPress destination is no longer configured. Check hosting and credentials, then try again."));
      }
      await openSite(siteId, false);
      cmsWordPressSetupSiteId = siteId;
      successMessage = say(`Configurazione WordPress pronta per ${site.name}. Completa verifica database, PHP e HTTPS; l’installazione non parte da sola.`, `WordPress setup is ready for ${site.name}. Complete the database, PHP, and HTTPS checks; installation will not start automatically.`);
      return;
    }
    if (!cmsBuild || cmsBuild.status !== "ready" || cmsBuild.current === false) {
      await buildCmsProject();
      if (!cmsBuild || cmsBuild.status !== "ready" || cmsBuild.current === false) {
        throw new Error(say("La versione non è pronta. Apri il report, correggi i blocchi e riprova.", "The build is not ready. Open the report, fix blocking findings, and try again."));
      }
    }
    await prepareCmsPublishPlan();
  }

  async function deployCmsProject(): Promise<void> {
    if (!selectedCmsProject || !cmsBuild || cmsBuild.status !== "ready" || !cmsPublishPlan || cmsPublishPlan.status !== "ready" || !cmsPublishPlan.planId) throw new Error(t("cms.deployFailed"));
    if (!cmsPublishPlanConfirmed) throw new Error(say("Conferma il riepilogo prima di pubblicare.", "Confirm the summary before publishing."));
    const projectId = selectedCmsProject.project.id;
    const buildId = cmsBuild.id;
    if (cmsPublishPlan.projectId !== projectId || cmsPublishPlan.buildId !== cmsBuild.id || cmsPublishPlan.destination.id !== cmsDeploySiteId) {
      throw new Error(say("La versione o la destinazione è cambiata. Prepara un nuovo piano.", "The build or destination changed. Prepare a new plan."));
    }
    cmsDeployHealthCheck = null;
    const target = cmsDeploymentTargets().find((site) => site.id === cmsPublishPlan?.destination.id);
    if (!target) throw new Error(t("cms.chooseDestination"));
    const started = await api<{ jobId: string; deployId: string }>("/api/cms/v1/destinations/apply", {
      method: "POST",
      body: JSON.stringify({ destinationId: cmsPublishPlan.destination.id, action: "deploy", projectId, planId: cmsPublishPlan.planId, confirmed: true }),
    });
    activeJob = { id: started.jobId, type: "deploy", status: "running", events: [] };
    let followError: unknown;
    try { await followJob(started.jobId, receiveJobEvent); }
    catch (error) { followError = error; }
    const finished = activeJob;
    activeJob = null;
    await refreshCmsBuildHistory(projectId).catch(() => undefined);
    if (followError) throw followError;
    if (finished?.status !== "complete") {
      const end = finished?.events.find((event) => event.type === "job-finished");
      throw new Error(typeof end?.error === "string" ? end.error : t("cms.deployFailed"));
    }
    const history = await api<{ deployments: CmsBuildDeployment[] }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/builds/${encodeURIComponent(buildId)}/deployments`);
    cmsBuildHistory = cmsBuildHistory.map((item) => item.id === buildId ? { ...item, deployments: history.deployments } : item);
    if (cmsBuild?.id === buildId) cmsBuild = { ...cmsBuild, deployments: history.deployments };
    const deployment = history.deployments.find((item) => item.id === started.deployId && item.status === "deployed");
    if (!deployment) throw new Error(t("cms.deployFailed"));
    cmsDeployHealthCheck = deployment.result?.healthCheck ?? null;
    successMessage = t("cms.deployComplete", { target: target.name });
    cmsPublishPlan = null;
    cmsPublishPlanConfirmed = false;
  }

  function prepareCmsRollback(build: CmsBuild, deployment: CmsBuildDeployment): void {
    const target = sites.find((site) => site.id === deployment.targetSiteId);
    const versionId = deployment.result?.versionId;
    const projectId = selectedCmsProject?.project.id;
    if (!projectId) throw new Error(t("cms.noProjects"));
    if (!target) throw new Error(say("La destinazione non è più configurata.", "The destination is no longer configured."));
    if (deployment.result?.provider === "hosting" && deployment.result.rollbackAvailable === true
      && ["deployed", "failed", "cancelled", "interrupted"].includes(deployment.status) && target.deployTarget === "ftp") {
      cmsRollback = { projectId, buildId: build.id, deploymentId: deployment.id, destinationId: target.id, destinationName: target.name, provider: "hosting", worker: "", versionId: "" };
      return;
    }
    if (target.deployTarget === "ftp" || deployment.status !== "deployed" || deployment.result?.provider !== "cloudflare" || !versionId) {
      throw new Error(say("Non trovo una versione ripristinabile per questa pubblicazione.", "I can’t find a restorable version for this deployment."));
    }
    cmsRollback = { projectId, buildId: build.id, deploymentId: deployment.id, destinationId: target.id, destinationName: target.name, provider: "cloudflare", worker: target.worker ?? deployment.result.script ?? "—", versionId };
  }

  async function confirmCmsRollback(): Promise<void> {
    const pending = cmsRollback;
    if (!pending || !selectedCmsProject || selectedCmsProject.project.id !== pending.projectId) return;
    const started = await api<{ jobId: string; deployId: string }>("/api/cms/v1/destinations/rollback", {
      method: "POST", body: JSON.stringify({ destinationId: pending.destinationId, projectId: pending.projectId, buildId: pending.buildId, deploymentId: pending.deploymentId, confirmed: true }),
    });
    activeJob = { id: started.jobId, type: "deploy", status: "running", events: [] };
    let followError: unknown;
    try { await followJob(started.jobId, receiveJobEvent); }
    catch (error) { followError = error; }
    const finished = activeJob;
    activeJob = null;
    await refreshCmsBuildHistory(pending.projectId).catch(() => undefined);
    if (followError) throw followError;
    if (finished?.status !== "complete") {
      const end = finished?.events.find((event) => event.type === "job-finished");
      throw new Error(typeof end?.error === "string" ? end.error : say("Il provider non ha confermato il ripristino.", "The provider did not confirm the rollback."));
    }
    cmsRollback = null;
    successMessage = pending.provider === "hosting"
      ? say(`File precedenti ripristinati su ${pending.destinationName}.`, `Previous files restored on ${pending.destinationName}.`)
      : say(`Worker ${pending.worker} ripristinato alla versione ${pending.versionId}.`, `Worker ${pending.worker} restored to version ${pending.versionId}.`);
  }


  async function exportCmsProject(): Promise<void> {
    if (!selectedCmsProject) return;
    const id = selectedCmsProject.project.id;
    await download(`/api/cms/v1/projects/${encodeURIComponent(id)}/export`, {}, readableFileName("xbsite"));
  }

  async function exportCmsStaticBuild(): Promise<void> {
    if (!selectedCmsProject || !cmsBuild || cmsBuild.status !== "ready") throw new Error(t("cms.buildBlocked"));
    const id = selectedCmsProject.project.id;
    await download(`/api/cms/v1/projects/${encodeURIComponent(id)}/builds/${encodeURIComponent(cmsBuild.id)}/export`, {}, readableFileName("zip", "sito"));
    successMessage = t("cms.staticZipDownloaded");
  }

  /** D5: the sections of the pages as a .xblibrary file for the builder's section library, with what stayed out. */
  async function exportCmsSectionLibrary(): Promise<void> {
    if (!selectedCmsProject) return;
    const id = selectedCmsProject.project.id;
    const result = await api<{ fileName: string; file: unknown; sections: number; notes: string[] }>(`/api/cms/v1/projects/${encodeURIComponent(id)}/section-library`, { method: "POST", body: "{}" });
    const details = result.notes.length ? ` ${result.notes.join("; ")}.` : "";
    if (!result.sections) throw new Error(`${t("cms.sectionLibraryEmpty")}${details}`);
    const blob = new Blob([JSON.stringify(result.file)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    successMessage = `${n("cms.sectionLibraryDone", result.sections)}${details}`;
  }

  let cmsSiteCheck = $state<CmsSiteCheck | null>(null);
  /** The site as visitors would get it, looked over before it goes online. */
  async function checkCmsSite(): Promise<void> {
    if (!selectedCmsProject) return;
    if (!cmsBuild || cmsBuild.status !== "ready" || cmsBuild.current === false) await buildCmsProject();
    cmsSiteCheck = await api(`/api/cms/v1/projects/${encodeURIComponent(selectedCmsProject.project.id)}/admin/site-check`);
  }
  /** Accessibility of the same version, in the app's hidden browser (V1.3): the verdict is never «ready» without it. */
  async function verifyCmsSiteInBrowser(): Promise<void> {
    if (!selectedCmsProject) return;
    cmsSiteCheck = await api(`/api/cms/v1/projects/${encodeURIComponent(selectedCmsProject.project.id)}/admin/site-check/browser`, { method: "POST", body: "{}" });
  }

  /** For a WordPress without Histeon: its Strumenti → Importa takes the file. */
  async function exportForWordPress(): Promise<void> {
    if (!selectedCmsProject) return;
    await download(`/api/cms/v1/projects/${encodeURIComponent(selectedCmsProject.project.id)}/export-wordpress`, {}, readableFileName("xml"));
    successMessage = t("cms.exportWordPressDone");
  }

  async function backupCmsProject(): Promise<void> {
    if (!selectedCmsProject) return;
    const id = selectedCmsProject.project.id;
    await download(`/api/cms/v1/projects/${encodeURIComponent(id)}/backup`, {}, readableFileName("histosproject"));
  }



  function changeKindLabel(kind: string): string {
    const label = t(`connector.kind.${kind}`);
    return label === `connector.kind.${kind}` ? kind : label;
  }

  /** What a prototype holds, as "2 pagine, 1 articolo, 5 template". */
  function prototypeCounts(counts: Record<string, number>): string {
    return (["pages", "posts", "templates", "components", "records", "media"] as const)
      .filter((key) => Number(counts[key]) > 0).map((key) => n(`count.${key}`, Number(counts[key]))).join(", ");
  }

  /** What a prototype import did, in one line: what was created, what was left out and why. */
  function prototypeSummary(report: PrototypeReport): string {
    const made = prototypeCounts(report.counts);
    // Ignored items and warnings, all of them, are in the report panel under the title (D1).
    const left = report.ignored.length || report.warnings.length ? ` ${t("cms.reportBelow")}` : "";
    return say(`Prototipo importato: ${made || "progetto vuoto"}.`, `Prototype imported: ${made || "empty project"}.`) + left;
  }

  /**
   * Imports a .xbsite, a prototype or a backup. When the file would update the project it created before, the server
   * answers 409 with that project: the user confirms in a dialog, the app saves a backup and only then updates.
   */
  async function importCmsArchive(file: File, confirmedUpdate = false, conversion?: SiteConversionView): Promise<void> {
    const name = file.name.toLocaleLowerCase("en-US");
    const nativeProject = name.endsWith(".histosproject");
    const prototype = name.endsWith(".html") || name.endsWith(".htm");
    const endpoint = nativeProject ? "/api/cms/v1/projects/restore" : prototype ? "/api/cms/v1/projects/import-prototype" : "/api/cms/v1/projects/import";
    const navigation = navigationSeq;
    let imported: { project: CmsProject; report?: PrototypeReport; changed?: string[]; keptLocal?: string[]; unchanged?: string[]; backup?: string };
    try {
      const query = [...(confirmedUpdate ? ["update=1"] : []), ...(prototype ? ["progress=TOKEN"] : [])];
      const result = prototype
        ? await withImportProgress("import", (token, signal) => uploadTransferArchive<typeof imported>(`${endpoint}?${query.join("&").replace("TOKEN", token)}`, file, "text/html; charset=utf-8", signal))
        : await uploadTransferArchive<typeof imported>(`${endpoint}${query.length ? `?${query.join("&")}` : ""}`, file, "application/zip");
      if (!result) {
        dropPendingProposal();
        return;
      }
      imported = result;
    } catch (error) {
      if (error instanceof ImportError && error.code === "cms-import-update-requires-confirmation") {
        const project = error.body.project as { id: string; name: string } | undefined;
        if (project) {
          cmsImportUpdate = { file, project };
          return;
        }
      }
      if (error instanceof ImportError && error.code === "cms-sync-conflict" && Array.isArray(error.body.conflicts)) {
        dropPendingProposal();
        throw new Error(cmsConflictMessage(error.body.conflicts as Array<{ kind: string; label?: string }>));
      }
      dropPendingProposal();
      throw error;
    }
    cmsImportUpdate = null;
    await refresh();
    await openCmsProject(imported.project.id, navigation);
    if (imported.backup) successMessage = t("cms.importUpdated", { name: imported.project.name, changed: imported.changed?.length ?? 0, kept: imported.keptLocal?.length ?? 0, unchanged: imported.unchanged?.length ?? 0 });
    else if (imported.report) successMessage = prototypeSummary(imported.report);
    // Doc 18 §9 (F7): the conversion's notes and measure join the report the project keeps.
    if (prototype && conversion) await api(`/api/cms/v1/projects/${encodeURIComponent(imported.project.id)}/import-reports/conversion`, { method: "POST", body: JSON.stringify(conversionReportBody(file, conversion)) });
    if (prototype && pendingProposal) {
      const upload = pendingProposal;
      pendingProposal = null;
      try {
        await api(`/api/imports/${encodeURIComponent(upload)}/keep-proposal`, { method: "POST", body: JSON.stringify({ projectId: imported.project.id }) });
      } catch {
        // The project is imported all the same: only the comparison with the proposal will be missing.
        errorMessage = t("capture.keepFailed");
      } finally {
        void api(`/api/imports/${encodeURIComponent(upload)}`, { method: "DELETE" }).catch(() => undefined);
      }
    }
    if (prototype) await showCmsImportReport(imported.project.id, file.name);
  }

  /**
   * A prototype is checked first (A2): the app builds a throwaway preview and shows what the import would do, then
   * imports on the user's "Importa" (or "Aggiorna", which saves a backup first). An invalid file stops here.
   */
  // ------------------------------------------------------------------ D3: progress and «Annulla» for big prototypes
  let cmsImportProgress = $state<ImportProgressView | null>(null);
  let cmsImportController: AbortController | null = null;

  /** A prototype check or import with its progress read every half second, and a way to stop it. */
  async function withImportProgress<T>(kind: "check" | "import", run: (token: string, signal: AbortSignal) => Promise<T>): Promise<T | null> {
    const token = crypto.randomUUID();
    const controller = new AbortController();
    cmsImportController = controller;
    cmsImportProgress = { kind };
    const timer = window.setInterval(() => {
      void api<{ progress: { phase: "media" | "records" | "documents" | "writing"; done: number; total: number } | null }>(`/api/cms/v1/import-progress/${token}`)
        .then((result) => { if (cmsImportController === controller && result.progress) cmsImportProgress = { kind, ...result.progress }; })
        .catch(() => undefined);
    }, 500);
    try {
      return await run(token, controller.signal);
    } catch (error) {
      // «Annulla»: the server stops before writing, and «Annulla» goes once it writes. A check never writes; after an
      // import the list is read again rather than assumed, in case the cancellation came as the writing began.
      if (controller.signal.aborted) {
        successMessage = t(kind === "check" ? "cms.checkCancelled" : "cms.importCancelled");
        if (kind === "import") await refresh().catch(() => undefined);
        return null;
      }
      throw error;
    } finally {
      window.clearInterval(timer);
      if (cmsImportController === controller) {
        cmsImportController = null;
        cmsImportProgress = null;
      }
    }
  }

  function cancelCmsImport(): void {
    cmsImportController?.abort();
  }

  /**
   * `chosen` is the file the user picked (for «Ricontrolla», the one read again is `file`). The list of an earlier
   * refusal of the same file stays until this check concludes: cancelled or failed for another reason, the user still
   * has it and its «Ricontrolla»; a check of another file starts without it.
   */
  async function checkCmsPrototype(file: File, conversion?: SiteConversionView, chosen: File = file): Promise<void> {
    if (cmsPrototypeProblems?.file !== chosen) cmsPrototypeProblems = null;
    let result: PrototypeCheckView | null;
    const check = (query: string) => withImportProgress("check", (token, signal) => uploadTransferArchive<PrototypeCheckView>(`/api/cms/v1/projects/import-prototype?check=1${query}&preview=1&progress=${token}`, file, "text/html; charset=utf-8", signal));
    try {
      // Remote media stay placeholders in a check, unless the server says it is an update: then "Cosa cambia" is
      // compared again with the media downloaded, as «Aggiorna» will import them (otherwise every remote media would
      // read as modified, and one edited in Publish as a conflict that hides «Aggiorna»).
      result = await check("");
      if (result?.changesNeedDownload) result = await check("&download=1");
      // Never an update to approve without what it changes.
      if (result?.changesNeedDownload) throw new Error(t("cms.checkNeedsDownload"));
    } catch (error) {
      if (!(error instanceof ImportError) || error.code !== "cms-prototype-invalid") throw error;
      await showPrototypeProblems(chosen, error, conversion !== undefined);
      return;
    }
    if (!result) return;
    cmsPrototypeProblems = null;
    cmsPrototypeCheck = { file, result, ...(conversion ? { conversion: { ...conversion, downloadUrl: URL.createObjectURL(file) } } : {}) };
  }

  /**
   * E4: the problems of a refused prototype, all of them, with the focus on their panel. The panel sits with the
   * import buttons, which "Collegati" hides: a refusal shows "Tutti" again, wherever the check started (a prototype
   * from "Nuovo sito", a converted site). `generated`: the prototype was made from a site (B1), not chosen.
   */
  async function showPrototypeProblems(file: File, error: ImportError, generated = false): Promise<void> {
    const listed = Array.isArray(error.body.issues) ? error.body.issues : [];
    const parsed = listed.flatMap((item: unknown): PrototypeIssueView[] => {
      if (!item || typeof item !== "object") return [];
      const { document, line, column, message } = item as Record<string, unknown>;
      if (typeof message !== "string") return [];
      return [{ message, ...(typeof document === "string" ? { document } : {}), ...(typeof line === "number" ? { line } : {}), ...(typeof column === "number" ? { column } : {}) }];
    });
    const issues = parsed.length ? parsed : [{ message: error.message }];
    // Past the first 100 the server sends how many there are in all.
    const reported = error.body.issuesTotal;
    const total = typeof reported === "number" && Number.isSafeInteger(reported) && reported > issues.length ? reported : issues.length;
    const rereadable = !generated && window.histosDesktop?.canRereadPrototypeFile?.(file) === true;
    cmsPrototypeProblems = { file, issues, total, rereadable, ...(generated ? { downloadUrl: URL.createObjectURL(file) } : {}) };
    if (cmsCatalogFilter === "connected") cmsCatalogFilter = "all";
    // Gone elsewhere while the check ran: the list waits on the catalog, and a notice leads there.
    if ((screen !== "cms" && screen !== "home") || selectedCmsProject) {
      // After the new screen has given its title the focus (E12), as showCmsConnectionImport does.
      nextToastAction = { label: t("cms.problemsShow"), run: () => { selectedCmsProject = null; nav("cms"); window.setTimeout(() => cmsPrototypeProblemsPanel?.focus(), 0); } };
      errorMessage = total === 1 ? t("cms.problemsTitleOne", { file: file.name }) : t("cms.problemsTitle", { file: file.name, n: total });
      return;
    }
    await tick();
    cmsPrototypeProblemsPanel?.focus();
  }

  // The download link of a refused converted prototype lives as long as its list.
  $effect(() => {
    const url = cmsPrototypeProblems?.downloadUrl;
    return () => { if (url) URL.revokeObjectURL(url); };
  });

  /** "page contatti, riga 93, colonna 3", or nothing for a problem of the whole file. */
  function prototypeIssuePlace(issue: PrototypeIssueView): string {
    return [issue.document, issue.line ? t("cms.problemsLine", { line: issue.line }) : "", issue.line && issue.column ? t("cms.problemsColumn", { column: issue.column }) : ""].filter(Boolean).join(", ");
  }

  /** The list as an agent reads it: the file, every problem numbered with its place, what to do next. */
  async function copyPrototypeProblems(problems: PrototypeProblemsView): Promise<void> {
    const lines = problems.issues.map((issue, index) => {
      const place = prototypeIssuePlace(issue);
      return `${index + 1}. ${place ? `${place}: ` : ""}${issue.message}`;
    });
    // Every problem counted, and those not listed said, so the agent does not take the list for the whole.
    const more = problems.total > problems.issues.length ? [t("cms.problemsMore", { n: problems.total - problems.issues.length })] : [];
    const text = [t("cms.problemsAgent", { file: problems.file.name, n: problems.total }), ...lines, ...more, t("cms.problemsAgentEnd")].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      successMessage = t("cms.problemsCopied");
    } catch {
      errorMessage = t("connector.copyFailed");
    }
  }

  /** «Ricontrolla» (desktop app): the same file read again from disk, without the file chooser. */
  async function recheckPrototype(file: File): Promise<void> {
    const bytes = await window.histosDesktop?.rereadPrototypeFile?.(file);
    if (!(bytes instanceof Uint8Array)) throw new Error(t("cms.problemsRecheckFailed"));
    await checkCmsPrototype(new File([bytes], file.name, { type: "text/html" }), undefined, file);
  }

  // The download link of a converted prototype lives as long as its dialog.
  $effect(() => {
    const url = cmsPrototypeCheck?.conversion?.downloadUrl;
    return () => { if (url) URL.revokeObjectURL(url); };
  });

  /** B1: the site's latest build as a Histeon prototype, through the same check, preview and import. */
  /** Converts a site's ready build (B1); `fonts` downloads its Google Fonts (B5), `tokens` applies the design proposal (B4). */
  /**
   * The upload converted straight from the CMS catalog (doc 18 F1): its id while the check dialog is open, so a new
   * choice converts it again; it goes from the server when the dialog closes.
   */
  let directImport: string | null = null;
  /** The proposal chosen in a kit proposte file for the upload in directImport; it goes with every new conversion of it. */
  let directProposal: string | null = null;
  let reconverting = false;
  /** True when the upload in directImport is the pages captured from a proposal («Fotografa la proposta»). */
  let directCaptured = false;
  /**
   * The captured upload of the prototype being imported: its pages go into the project once it exists (the original
   * of «Uguale alla proposta»), then the upload goes from the server.
   */
  let pendingProposal: string | null = null;
  function dropPendingProposal(): void {
    const id = pendingProposal;
    pendingProposal = null;
    if (id) void api(`/api/imports/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
  }
  $effect(() => {
    if (cmsPrototypeCheck !== null || reconverting || !directImport) return;
    const id = directImport;
    directImport = null;
    directProposal = null;
    directCaptured = false;
    void api(`/api/imports/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
  });

  /**
   * Doc 18 F1-F2: an HTML page, a site's ZIP or a site's folder that is not a prototype becomes one at once, without a
   * site or a build. `entries` are the folder's files, paths relative to it (one entry for a page or a ZIP).
   */
  async function convertUploadToCms(file: File, kind: "html" | "zip" | "directory", entries: UploadEntry[] = [{ file, path: file.name }], folder = ""): Promise<void> {
    const name = (folder || file.name.replace(/\.(?:html?|zip)$/iu, "")).trim().slice(0, 80) || say("Sito importato", "Imported site");
    const plan = await api<{ id: string }>("/api/imports", { method: "POST", body: JSON.stringify({ name, kind, files: entries.map((entry) => ({ path: entry.path, size: entry.file.size })) }) });
    try {
      for (const entry of entries) await uploadFile(`/api/imports/${encodeURIComponent(plan.id)}/files/${entry.path.split("/").map(encodeURIComponent).join("/")}`, entry.file);
      // «Fotografa la proposta»: a page drawn by its scripts would convert into an empty viewer. The person sees it
      // alive first and adds its pages; the dialog owns the upload from here.
      if (kind === "html" && directProposal === null) {
        const frame = await api<{ scripted: boolean; reasons: string[]; url?: string }>(`/api/imports/${encodeURIComponent(plan.id)}/capture-frame`, { method: "POST", body: "{}" });
        if (frame.scripted && frame.url) {
          cmsProposalCapture = { file, importId: plan.id, url: frame.url, reasons: frame.reasons };
          return;
        }
      }
      directImport = plan.id;
      await convertSiteToCms(`import:${plan.id}`);
    } catch (error) {
      if (directImport === plan.id) {
        directImport = null;
        directProposal = null;
      }
      await api(`/api/imports/${encodeURIComponent(plan.id)}`, { method: "DELETE" }).catch(() => undefined);
      throw error;
    }
  }

  /** Q5: the proposal the client chose in a kit proposte file becomes the conversion of that file, as an HTML page. */
  async function convertProposalChoice(file: File, id: string): Promise<void> {
    cmsProposalPick = null;
    directProposal = id;
    try {
      await convertUploadToCms(file, "html");
    } catch (error) {
      directProposal = null;
      throw error;
    }
  }

  /** Converts the upload `id` under the check dialog; if the conversion fails the upload goes from the server. */
  async function convertDirectUpload(id: string, options: ConversionOptions = {}): Promise<void> {
    directImport = id;
    try {
      await convertSiteToCms(`import:${id}`, options);
    } catch (error) {
      if (directImport === id) directImport = null;
      await api(`/api/imports/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * «Importa queste pagine»: the pages added in the frame become an upload of their own (a static site) and the
   * proposal's file goes. Its Google Fonts are always downloaded (decision of 13 November 2026).
   */
  async function importCapturedProposal(pages: CapturedProposalPage[]): Promise<void> {
    const capture = cmsProposalCapture;
    if (!capture) return;
    const site = await api<{ id: string }>(`/api/imports/${encodeURIComponent(capture.importId)}/captured-site`, { method: "POST", body: JSON.stringify({ pages: pages.map(({ name, hash, title, html, notes }) => ({ name, hash, title, html, notes })) }) });
    cmsProposalCapture = null;
    await api(`/api/imports/${encodeURIComponent(capture.importId)}`, { method: "DELETE" }).catch(() => undefined);
    directCaptured = true;
    await convertDirectUpload(site.id, { fonts: true });
  }

  /** «Converti il file com'è»: the proposal's file converted without its scripts, as before the capture existed. */
  async function convertProposalAsItIs(): Promise<void> {
    const capture = cmsProposalCapture;
    if (!capture) return;
    cmsProposalCapture = null;
    await convertDirectUpload(capture.importId);
  }

  function closeProposalCapture(): void {
    const capture = cmsProposalCapture;
    cmsProposalCapture = null;
    if (capture) void api(`/api/imports/${encodeURIComponent(capture.importId)}`, { method: "DELETE" }).catch(() => undefined);
  }

  /** `siteId` is a site's id, or `import:<id>` for an upload converted straight from the CMS catalog. */
  async function convertSiteToCms(siteId = selectedSite?.id, options: ConversionOptions = {}): Promise<void> {
    if (!siteId) return;
    reconverting = true;
    try {
      await convertSource(siteId, options);
    } finally {
      reconverting = false;
    }
  }
  /** The request of a refinement under the import progress bar, with its «Annulla»; null when the user stopped it. */
  async function withRefineProgress<T>(refining: boolean, run: (signal: AbortSignal | null) => Promise<T>): Promise<T | null> {
    if (!refining) return run(null);
    const controller = new AbortController();
    cmsImportController = controller;
    cmsImportProgress = { kind: "refine" };
    // «Claude dal connettore»: the bar says what to tell Claude, since nothing happens until the person asks it.
    void api<ImportRefineSettingsView>("/api/import-refine").then((settings) => {
      if (cmsImportController === controller && settings.provider === "connettore") cmsImportProgress = { kind: "refine", connector: true };
    }).catch(() => undefined);
    try {
      return await run(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      if (cmsImportController === controller) {
        cmsImportController = null;
        cmsImportProgress = null;
      }
    }
  }
  async function convertSource(siteId: string, options: ConversionOptions): Promise<void> {
    cmsPrototypeCheck = null;
    const route = siteId.startsWith("import:") ? `/api/imports/${encodeURIComponent(siteId.slice("import:".length))}/cms-prototype` : sitePath(siteId, "cms-prototype");
    // Doc 27, G3: asking a model takes a while (minutes with a local one): the progress bar says so and can stop it.
    const converted = await withRefineProgress(options.refine === true, (signal) => api<{ fileName: string; prototype: string; report: { pages: number; assets: number; stylesheets: number; notes: string[]; groups?: SiteConversionView["groups"] }; googleFonts: number; fontsRequested: boolean; design?: Record<string, string>; tokensRequested?: boolean; framework?: ImportFramework; exact?: boolean; exactChoice?: string; recipes?: boolean; recipesAvailable?: boolean; structure?: SiteStructureView; structureApplied?: SiteStructureChoice; selectable?: { original: number; selectable: number; share: number }; choices?: number; choicesApplied?: Record<string, string>; choicesRejected?: Array<{ id: string; motivo: string }>; refine?: RefineView }>(route, { method: "POST", signal, body: JSON.stringify({ fonts: options.fonts === true, framework: options.framework ?? "histos-css", ...(options.exact === true ? { exact: true } : {}), recipes: options.recipes === true, ...(options.structure ? { structure: options.structure } : {}), ...(route.startsWith("/api/imports/") && directProposal !== null ? { proposal: directProposal } : {}), ...(options.choices && Object.keys(options.choices).length ? { choices: options.choices } : {}), ...(options.refine ? { refine: true } : {}) }) }));
    if (!converted) {
      successMessage = say("Rifinitura fermata: i nomi restano quelli del convertitore.", "Refinement stopped: the names stay the converter’s.");
      return convertSource(siteId, { ...options, refine: false });
    }
    const applied = converted.structureApplied ?? { parts: false, components: false, lists: false };
    cmsStructureChoice = { ...applied };
    const file = new File([converted.prototype], converted.fileName, { type: "text/html" });
    selectedCmsProject = null;
    nav("cms");
    await checkCmsPrototype(file, { notes: converted.report.notes, ...(converted.report.groups ? { groups: converted.report.groups } : {}), siteId, ...(converted.selectable ? { selectable: converted.selectable } : {}), googleFonts: converted.googleFonts, fontsRequested: converted.fontsRequested, design: converted.design ?? {}, tokensRequested: converted.tokensRequested === true, framework: converted.framework ?? (converted.tokensRequested ? "histos-css" : "none"), exact: converted.exact === true, exactChoice: converted.exactChoice === "always" || converted.exactChoice === "choice" ? converted.exactChoice : "none", recipes: converted.recipes === true, recipesAvailable: converted.recipesAvailable === true, structure: converted.structure ?? { parts: [], components: [], lists: [] }, structureApplied: applied, choices: converted.choices ?? 0, choicesApplied: converted.choicesApplied ?? {}, choicesRejected: converted.choicesRejected ?? [], ...(converted.refine ? { refine: converted.refine } : options.refineView ? { refine: options.refineView } : {}) });
  }


  async function importCheckedPrototype(): Promise<void> {
    const checked = cmsPrototypeCheck;
    if (!checked || checked.result.outcome === "refused-duplicate") return;
    // «Fotografa la proposta»: the captured upload outlives the dialog, until its pages are kept in the project.
    if (directCaptured && directImport !== null && checked.conversion?.siteId === `import:${directImport}`) {
      dropPendingProposal();
      pendingProposal = directImport;
      directImport = null;
      directCaptured = false;
    }
    cmsPrototypeCheck = null;
    await importCmsArchive(checked.file, checked.result.outcome === "update", checked.conversion);
  }

  /** A JSON file the user saves (doc 18 §9): made in the page, nothing leaves the app. */
  function saveJsonFile(name: string, value: unknown): void {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /** The conversion's part of the report, as the check dialog shows it and the project keeps it. */
  function conversionReportBody(file: File, conversion: SiteConversionView): { file: string; framework: ImportFramework; notes: string[]; selectable?: { original: number; selectable: number; share: number }; structure: SiteStructureChoice } {
    return { file: file.name.slice(0, 200), framework: conversion.framework, notes: conversion.notes.slice(0, 500).map((note) => note.slice(0, 400)), ...(conversion.selectable ? { selectable: conversion.selectable } : {}), structure: conversion.structureApplied };
  }

  async function downloadCmsImportReport(projectId: string, reportId: string): Promise<void> {
    const report = await api<unknown>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/import-reports/${encodeURIComponent(reportId)}`);
    saveJsonFile(`rapporto-import-${reportId.slice(0, 8)}.json`, report);
  }

  /** E9: the file says what it is. Prototypes go through the check and its preview; projects and backups at once. */
  /** A complete sample site kept with the app: a prototype like any other, with an id of its own each time. */
  async function createFromStarter(starter: "rivista" | "negozio", settings?: { name: string; locale: string }): Promise<void> {
    const html = await (await fetch(`/starters/${starter}.html`)).text();
    const created = await api<{ project?: { id: string } }>("/api/cms/v1/projects/import-prototype?download=0", { method: "POST", headers: { "Content-Type": "text/html" }, body: html.replace(/"id": "[0-9a-f-]{36}"/u, `"id": "${crypto.randomUUID()}"`) });
    if (created.project?.id && settings) await api(`/api/cms/v1/projects/${encodeURIComponent(created.project.id)}/settings`, { method: "PATCH", body: JSON.stringify({ name: settings.name, locale: settings.locale, timeZone: "Europe/Rome" }) });
    await reloadCmsProjects();
    if (created.project?.id) await openCmsProject(created.project.id);
  }
  async function finishFirstSite(): Promise<void> {
    const answers = firstSite;
    if (!answers) return;
    if (answers.kind === "vuoto") {
      cmsProjectName = answers.name;
      await createCmsProject();
    } else await createFromStarter(answers.kind, { name: answers.name.trim(), locale: answers.locale });
    firstSite = null;
  }

  /** A file from WordPress's own Strumenti → Esporta, or a site's address: no plugin on it (doc 22 §R6). */
  async function importWordPressFile(file: File | string): Promise<void> {
    const body = typeof file === "string" ? JSON.stringify({ url: file }) : file;
    const report = await withImportProgress("import", (token, signal) => api<{ projectId: string; name: string; pages: number; posts: number; images: { saved: number; failed: number }; lost: Record<string, number>; skipped: Record<string, number>; failed: string[]; articles: Array<{ title: string; lost: Record<string, number> }>; featuredImages?: { posts: number; removedFromText: string[] } }>(`/api/cms/v1/projects/import-wordpress?progress=${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": typeof file === "string" ? "application/json" : "application/xml" }, body, signal }));
    if (!report) return;
    await reloadCmsProjects();
    await openCmsProject(report.projectId);
    wordPressReport = report;
    const left = [...Object.entries(report.lost), ...Object.entries(report.skipped)].map(([name, count]) => `${name} ${count}`).join(", ");
    successMessage = t("cms.wordpressImported", { name: report.name, pages: report.pages, posts: report.posts, images: report.images.saved }) + (report.images.failed ? ` ${t("cms.wordpressImagesFailed", { n: report.images.failed })}` : "") + (left ? ` ${t("cms.wordpressLeft", { list: left })}` : "") + (report.featuredImages?.removedFromText.length ? ` ${t("cms.wordpressFeaturedRemoved", { n: report.featuredImages.removedFromText.length })}.` : "") + (report.failed.length ? ` ${t("cms.wordpressFailed", { n: report.failed.length })}` : "");
  }

  async function importCmsFile(file: File): Promise<void> {
    if (/\.(?:xbsite|histosproject)$/iu.test(file.name)) return importCmsArchive(file);
    if (/\.zip$/iu.test(file.name)) return convertUploadToCms(file, "zip");
    if (/\.xml$/iu.test(file.name)) return importWordPressFile(file);
    if (!/\.html?$/iu.test(file.name)) throw new Error(t("cms.importUnknown"));
    // A kit proposte file (Q5): the client chooses its proposal first; the dialog converts the chosen one.
    const choices = readProposalChoices(await file.text());
    if (choices) {
      cmsProposalPick = { file, ...choices };
      return;
    }
    // A plain HTML page is converted (doc 18 F1); a prototype goes to the check as it is.
    if (!(await isHistosPrototype(file))) return convertUploadToCms(file, "html");
    return checkCmsPrototype(file);
  }

  /**
   * The import report under the project title, with the focus (D1): after an import in the app, or from "Vedi
   * rapporto" in the agent's log. The file name the app knows is used when the server has none.
   */
  async function showCmsImportReport(projectId: string, file?: string): Promise<void> {
    const report = await fetchImportReport(projectId);
    cmsImportReport = file && !report.file ? { ...report, file } : report;
    cmsImportHistory = (await api<{ reports: typeof cmsImportHistory }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/import-reports`)).reports;
    await tick();
    cmsImportReportPanel?.focus();
  }

  async function openCmsImportReport(projectId: string): Promise<void> {
    await openCmsProject(projectId);
    await showCmsImportReport(projectId);
  }


  function cmsConflictMessage(conflicts: Array<{ kind: string; label?: string }>): string {
    const names = conflicts.slice(0, 8).map((item) => item.label ? `«${item.label}»` : item.kind).join(", ");
    return t("cms.importConflicts", { n: conflicts.length, names: names + (conflicts.length > 8 ? ` ${t("cms.buildDraftsMore", { n: conflicts.length - 8 })}` : "") });
  }

  function handleCmsArchiveDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (!busy) cmsArchiveDropActive = true;
  }

  function handleCmsArchiveDragLeave(event: DragEvent): void {
    const zone = event.currentTarget;
    if (event.relatedTarget instanceof Node && zone instanceof Node && zone.contains(event.relatedTarget)) return;
    cmsArchiveDropActive = false;
  }

  function handleCmsArchiveDrop(event: DragEvent): void {
    event.preventDefault();
    cmsArchiveDropActive = false;
    if (busy) return;
    // A site's folder (doc 18 F2): its files are read here, the entry only exists during the event.
    const items = [...(event.dataTransfer?.items ?? [])].map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => DroppedEntry | null }).webkitGetAsEntry?.() ?? null);
    const folder = items.length === 1 && items[0]?.isDirectory ? items[0] : null;
    if (folder) {
      void act(async () => {
        const read = await readDroppedEntry(folder);
        const entries = read.map((entry) => ({ ...entry, path: entry.path.slice(folder.name.length + 1) })).filter((entry) => entry.path);
        if (!entries.some((entry) => entry.path === "index.html")) throw new Error(say("La cartella non contiene index.html: trascina la cartella principale del sito.", "The folder has no index.html: drop the site's main folder."));
        const first = entries[0];
        if (first) await convertUploadToCms(first.file, "directory", entries, folder.name);
      });
      return;
    }
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length !== 1) {
      errorMessage = say("Trascina un solo archivio alla volta.", "Drop one archive at a time.");
      successMessage = "";
      return;
    }
    const file = files[0];
    if (!file) return;
    if (!/\.(?:xbsite|histosproject|html?|zip)$/iu.test(file.name)) {
      errorMessage = t("cms.importUnknown");
      successMessage = "";
      return;
    }
    void act(() => importCmsFile(file));
  }

  async function connectCmsSite(): Promise<void> {
    const targetId = cmsPairingTargetId;
    const result = await api<{ connection: CmsRemoteConnection }>("/api/cms/v1/connections", { method: "POST", body: JSON.stringify({ code: cmsPairingCode.trim(), ...(targetId ? { connectionId: targetId } : {}) }) });
    cmsPairingCode = "";
    cmsPairingTargetId = "";
    await refresh();
    successMessage = targetId
      ? t("cms.connectionUpdated", { host: new URL(result.connection.url).hostname })
      : t("cms.connectSuccess", { host: new URL(result.connection.url).hostname });
  }

  async function previewCmsSync(connection: CmsRemoteConnection, action: "pull" | "push" | "publish", only?: string[]): Promise<void> {
    const projectId = action === "pull" ? undefined : selectedCmsProject?.project.id;
    if (action !== "pull" && !projectId) return;
    const result = await api<CmsSyncPlan>("/api/cms/v1/destinations/plan", { method: "POST", body: JSON.stringify({ destinationId: `wordpress:${connection.id}`, action, ...(projectId ? { projectId } : {}), ...(only ? { only } : {}) }) });
    cmsSyncConnection = connection;
    cmsSyncPlan = result;
    cmsSyncChoices = {};
  }

  async function pullCmsSite(connection: CmsRemoteConnection): Promise<void> {
    await previewCmsSync(connection, "pull");
  }

  async function pushCmsProject(connection: CmsRemoteConnection, action: "push" | "publish" = "push"): Promise<void> {
    await previewCmsSync(connection, action);
  }

  /** Doc 23 items 199-200: a download of only these entries of the site (the server adds what they need). */
  async function bringCmsEntities(connection: CmsRemoteConnection, ids: string[]): Promise<void> {
    await previewCmsSync(connection, "pull", ids);
  }

  async function checkCmsRemoteOperation(connection: CmsRemoteConnection, operation: CmsRemoteOperation): Promise<void> {
    const result = await api<{ state: CmsRemoteOperationState; phase: string | null; advancedBases: number; localChanges: number }>(`/api/cms/v1/connections/${encodeURIComponent(connection.id)}/operations/${encodeURIComponent(operation.operationId)}/check`, { method: "POST" });
    await refresh();
    const refreshedOperation = cmsConnections.find((candidate) => candidate.id === connection.id)?.operations?.find((candidate) => candidate.operationId === operation.operationId);
    const rollbackCanResume = refreshedOperation?.rollbackRetryAvailable ?? operation.rollbackRetryAvailable ?? false;
    if (operation.rollbackOfOperationId && result.state === "complete") {
      successMessage = say(`Ripristino verificato: la copia precedente è tornata su WordPress e ${result.advancedBases} voci locali sono state riallineate.`, `Restore verified: the previous copy is back on WordPress and ${result.advancedBases} local items were aligned.`);
    } else if (operation.rollbackOfOperationId && result.state === "complete-local-changes") {
      successMessage = say(`Ripristino verificato. ${result.localChanges} voci locali sono cambiate: rivedi un nuovo piano per riallinearle.`, `Restore verified. ${result.localChanges} local items changed; review a new plan to align them.`);
    } else if (result.state === "complete") {
      successMessage = say(`Esito verificato: invio completato, ${result.advancedBases} voci riallineate.`, `Verified: the send completed and ${result.advancedBases} items were aligned.`);
    } else if (result.state === "complete-local-changes") {
      successMessage = say(`Invio completato. ${result.localChanges} voci sono cambiate dopo l’invio: rivedi un nuovo piano.`, `The send completed. ${result.localChanges} items changed afterwards; review a new plan.`);
    } else if (result.state === "partial") {
      successMessage = operation.rollbackOfOperationId
        ? rollbackCanResume
          ? say("WordPress ha interrotto il ripristino. L’operazione è registrata: dopo il controllo puoi usare “Verifica e riprendi”; una modifica estranea bloccherà il nuovo invio.", "WordPress interrupted the restore. The operation is recorded: after checking it, use “Verify and resume”; an unrelated change will block the retry.")
          : say("WordPress ha interrotto il ripristino. Controlla manualmente il sito e non avviare un altro ripristino finché l’esito resta parziale.", "WordPress interrupted the restore. Check the site manually and do not start another restore while its result remains partial.")
        : say("WordPress ha interrotto l’operazione. Rivedi un nuovo piano prima di riprovare.", "WordPress interrupted the operation. Review a new plan before retrying.");
    } else if (result.state === "not-found") {
      successMessage = operation.rollbackOfOperationId
        ? say("WordPress non trova il ripristino. Controlla il sito; dopo la verifica puoi ripreparare il ripristino dall’invio originale.", "WordPress cannot find the restore. Check the site; after verifying it, you can prepare the restore again from the original send.")
        : say("WordPress non trova l’operazione. Crea un nuovo piano e controllalo prima di inviare.", "WordPress cannot find the operation. Create a new plan and review it before sending.");
    } else if (result.state === "applying") {
      successMessage = say(`WordPress sta ancora applicando il trasferimento${result.phase ? ` (${result.phase})` : ""}. Attendi prima di inviare di nuovo.`, `WordPress is still applying the transfer${result.phase ? ` (${result.phase})` : ""}. Wait before sending again.`);
    } else {
      successMessage = say("WordPress non ha ancora confermato il completamento. Puoi controllare di nuovo più tardi.", "WordPress has not confirmed completion yet. Check again later.");
    }
  }

  async function prepareCmsRemoteRollback(connection: CmsRemoteConnection, operation: CmsRemoteOperation, resumePartial = false): Promise<void> {
    const hasVerifiedPartial = connection.operations?.some((candidate) => candidate.rollbackOfOperationId === operation.operationId && candidate.rollbackRetryAvailable) ?? false;
    if ((!operation.rollbackAvailable && !(resumePartial && hasVerifiedPartial)) || !["complete", "complete-local-changes"].includes(operation.state)) {
      throw new Error(say("Non è disponibile un backup verificabile per questo invio.", "A verifiable backup is not available for this send."));
    }
    cmsRemoteRollback = { connection, operation, resumePartial };
  }

  async function confirmCmsRemoteRollback(): Promise<void> {
    const pending = cmsRemoteRollback;
    if (!pending || !selectedCmsProject || selectedCmsProject.project.id !== pending.operation.projectId) return;
    let result: { state: "rolled-back"; rollbackOperationId: string; published: boolean };
    try {
      result = await api(
        `/api/cms/v1/connections/${encodeURIComponent(pending.connection.id)}/operations/${encodeURIComponent(pending.operation.operationId)}/rollback`,
        { method: "POST", body: JSON.stringify({ confirmed: true }) },
      );
    } catch (error) {
      // The server may have applied the restore even if its response was lost.
      // Close confirmation and reload the durable journal so the user checks
      // the existing operation instead of starting a duplicate request.
      cmsRemoteRollback = null;
      await refresh();
      throw error;
    }
    if (result.state !== "rolled-back") throw new Error(say("WordPress non ha confermato il ripristino.", "WordPress did not confirm the rollback."));
    cmsRemoteRollback = null;
    await refresh();
    await openCmsProject(pending.operation.projectId);
    successMessage = say("La copia precedente è stata ripristinata su WordPress. Le basi locali sono state riallineate.", "The previous copy was restored to WordPress. Local sync bases were realigned.");
  }

  /**
   * Doc 23 item 201: after a send with publishing, the proposal to give the site the project's home and posts page.
   * Only a help: a site that cannot answer gets none, and the send has already succeeded.
   */
  async function offerCmsFrontPage(connection: CmsRemoteConnection, projectId: string): Promise<void> {
    try {
      const { offer } = await api<{ offer: FrontPageOfferView | null }>(`/api/cms/v1/connections/${encodeURIComponent(connection.id)}/front-page?projectId=${encodeURIComponent(projectId)}`);
      if (offer) cmsFrontPageOffer = { connectionId: connection.id, projectId, host: new URL(connection.url).hostname, offer };
    } catch { /* No proposal. */ }
  }

  async function answerCmsFrontPage(accept: boolean): Promise<void> {
    const pending = cmsFrontPageOffer;
    if (!pending) return;
    await api(`/api/cms/v1/connections/${encodeURIComponent(pending.connectionId)}/front-page`, { method: "POST", body: JSON.stringify({ projectId: pending.projectId, accept }) });
    cmsFrontPageOffer = null;
    successMessage = accept
      ? say(`Ora ${pending.host} si apre su «${pending.offer.frontPage.title}», come nel progetto.`, `${pending.host} now opens on “${pending.offer.frontPage.title}”, as in the project.`)
      : say("La pagina iniziale del sito resta com’era.", "The site’s home page stays as it was.");
  }

  async function applyCmsSyncPlan(): Promise<void> {
    if (!cmsSyncPlan || !cmsSyncConnection || !cmsSyncPlan.planId || !cmsSyncPlanReady()) return;
    const plan = cmsSyncPlan;
    const syncedConnection = cmsSyncConnection;
    const resolutions = Object.fromEntries(plan.entities
      .filter((entity) => entity.status === "conflict")
      .map((entity) => [entity.id, cmsSyncChoices[entity.id]])) as Record<string, CmsSyncConflictChoice>;
    let result: { action: "pull" | "push" | "publish"; project?: { id: string; name: string }; projectId?: string; changed?: string[]; keptLocal?: string[]; report?: { changed?: string[]; pending?: Array<{ id: string; reason: string }> }; complete: boolean };
    try {
      result = await api("/api/cms/v1/destinations/apply", { method: "POST", body: JSON.stringify({ destinationId: plan.destination.id, projectId: plan.project.id, action: plan.action, planId: plan.planId, confirmed: true, ...(Object.keys(resolutions).length ? { resolutions } : {}) }) });
    } catch (error) {
      closeCmsSyncPlan();
      // A timeout can happen after WordPress has accepted the request. Refresh
      // the durable operation journal before surfacing the error so the user
      // can check its result instead of being left with a closed dialog only.
      await refresh();
      throw error;
    }
    if (!result.complete) throw new Error(t(plan.action === "pull" ? "cms.pullFailed" : plan.action === "publish" ? "cms.publishFailed" : "cms.sendFailed"));
    cmsSyncPlan = null;
    cmsSyncConnection = null;
    await refresh();
    const projectId = plan.action === "pull" ? result.project?.id : result.projectId;
    if (projectId) await openCmsProject(projectId);
    const count = plan.action === "pull" ? (result.changed?.length ?? 0) : (result.report?.changed?.length ?? 0);
    const keptLocalCount = result.keptLocal?.length ?? 0;
    successMessage = plan.action === "pull" && plan.bring && !plan.counts.conflict
      ? say(`${count === 1 ? "Un contenuto portato" : `${count} contenuti portati`} nel progetto. Gli altri restano solo sul sito.`, `${count} item(s) brought into the project. The others stay only on the site.`)
      : plan.action === "pull" && keptLocalCount
      ? say(count ? `${count} aggiornamenti scaricati; ${keptLocalCount} versioni locali conservate. Puoi inviarle con “Invia in sviluppo”.` : `${keptLocalCount} versioni locali conservate. Puoi inviarle con “Invia in sviluppo”.`, count ? `${count} updates downloaded; ${keptLocalCount} local versions kept. You can send them with “Send to development”.` : `${keptLocalCount} local versions kept. You can send them with “Send to development”.`)
      : plan.action === "pull"
      ? count ? t("cms.downloadComplete", { count }) : t("cms.aligned")
      : count ? t(plan.action === "publish" ? "cms.publishComplete" : "cms.sendComplete", { count }) : t(plan.action === "publish" ? "cms.publishAligned" : "cms.sendAligned");
    const waiting = result.report?.pending?.length ?? 0;
    if (plan.action === "push" && waiting) successMessage += ` ${t("cms.sendWaiting", { count: waiting })}`;
    if (plan.action === "publish" && projectId) void offerCmsFrontPage(syncedConnection, projectId);
  }




  function cmsSyncPlanReady(): boolean {
    if (!cmsSyncPlan?.planId) return false;
    if (!cmsSyncPlan.counts.conflict) return cmsSyncPlan.applyAllowed;
    // Every conflict must be listed (the server lists them first) and chosen; other entries beyond the list do not matter.
    if (cmsSyncPlan.action !== "pull") return false;
    const conflicts = cmsSyncPlan.entities.filter((entity) => entity.status === "conflict");
    return conflicts.length === cmsSyncPlan.counts.conflict && conflicts.every((entity) => entity.canResolve && (cmsSyncChoices[entity.id] === "keep-local" || cmsSyncChoices[entity.id] === "use-remote"));
  }

  function setCmsSyncChoice(entityId: string, value: string): void {
    cmsSyncChoices[entityId] = value === "keep-local" || value === "use-remote" ? value : "";
  }

  function closeCmsSyncPlan(): void { cmsSyncPlan = null; cmsSyncConnection = null; cmsSyncChoices = {}; }

  function beginCmsUnlink(connection: CmsRemoteConnection): void {
    errorMessage = "";
    cmsUnlink = { connection, remoteRevocationFailed: false };
  }

  async function confirmCmsUnlink(localOnly = false): Promise<void> {
    if (!cmsUnlink) return;
    const connection = cmsUnlink.connection;
    const result = await api<{ remoteAccess: "revoked" | "already-unavailable" | "left-active" }>(
      `/api/cms/v1/connections/${encodeURIComponent(connection.id)}${localOnly ? "?localOnly=true" : ""}`,
      { method: "DELETE" },
    );
    await refresh();
    cmsUnlink = null;
    successMessage = result.remoteAccess === "revoked"
      ? say("Pairing revocato su WordPress; il progetto locale resta intatto.", "Pairing revoked on WordPress; the local project remains intact.")
      : result.remoteAccess === "already-unavailable"
        ? say("WordPress non accetta più questo pairing; il collegamento locale è stato rimosso.", "WordPress no longer accepts this pairing; the local connection was removed.")
        : say("Collegamento rimosso da questo computer. Il pairing può restare valido su WordPress: revocalo da Histeon → Release → Histeon CMS.", "Connection removed from this computer. The pairing may still be valid on WordPress: revoke it in Histeon → Releases → Histeon CMS.");
  }

  async function tryCmsUnlink(localOnly = false): Promise<void> {
    try {
      await confirmCmsUnlink(localOnly);
    } catch (error) {
      if (!localOnly && cmsUnlink) cmsUnlink = { ...cmsUnlink, remoteRevocationFailed: true };
      throw error;
    }
  }

  function importCmsArchiveInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void act(() => importCmsFile(file));
  }
  function goHome(): void { navigationSeq++; screen = "home"; selectedSite = null; report = null; errorMessage = ""; successMessage = ""; }

  function handleGlobalKeydown(event: KeyboardEvent): void {
    if (event.key === "?" && !event.ctrlKey && !event.metaKey && !(event.target as HTMLElement).closest("input, select, textarea, [contenteditable], dialog, [role=dialog]")) {
      showShortcuts = !showShortcuts;
      return;
    }
    if (event.key === "Escape" && showShortcuts) showShortcuts = false;
    if (event.key === "Escape") {
      if (cardMenu) cardMenu = null;
      // «Seleziona» ends with Esc too (a dialog open over it takes the Esc first).
      else if (pickMode && !deleting && !folderDialog) stopPicking();
      if (cmsUnlink && !busy) cmsUnlink = null;
      if (showDomainSummary) showDomainSummary = false;
      if (showRollback) showRollback = null;
    }
  }


  function selectFiles(kind: "directory" | "html" | "zip"): void { document.getElementById(`file-${kind}`)?.click(); }
</script>

<svelte:document onpointerdown={closeCmsMoreOutside} onmousedown={noShiftSelect} />

<svelte:head>
  <title>Histeon Publish</title>
  <meta name="theme-color" content="#171A33" />
</svelte:head>
<svelte:window onkeydown={handleGlobalKeydown} />

<div class="app-shell">
  <button class="skip-link" type="button" onclick={focusScreenTitle}>{t("app.skipToContent")}</button>
  <aside class="sidebar" aria-label="Navigazione principale">
    <button class="brand" onclick={() => nav("home")} aria-label="Histeon Publish, pagina iniziale">
      <span class="brand-mark" aria-hidden="true">H</span><span><strong>histos</strong><small>publish</small></span>
    </button>
    <div class="local-note"><span class="pulse"></span><span>{t("nav.local")}</span></div>
    <nav class="main-nav">
      <button class:active={screen === "home" || screen === "cms" || screen === "admin" || screen === "site" || screen === "new" || screen === "report" || screen === "history" || screen === "preview"} onclick={() => { selectedCmsProject = null; nav("home"); }}><IconSites size={21} strokeWidth={1.8} aria-hidden="true" />{t("nav.sites")}</button>
      <button class:active={screen === "agent"} onclick={() => nav("agent")}><IconSparkles size={21} strokeWidth={1.8} aria-hidden="true" />{t("nav.agent")}{#if bootstrap}<ConnectorPanel view="dot" {language} {...connectorHooks} />{/if}</button>
      <button class:active={screen === "activity"} onclick={() => nav("activity")}><IconActivity size={21} strokeWidth={1.8} aria-hidden="true" />{t("nav.activity")}</button>
      <button class="nav-trash" class:active={screen === "trash"} aria-label={trashItems.length ? `${t("nav.trash")} (${trashItems.length})` : t("nav.trash")} onclick={() => { nav("trash"); void loadTrash(); }}><IconTrash size={21} strokeWidth={1.8} aria-hidden="true" /><span class="nav-text">{t("nav.trash")}</span>{#if trashItems.length}<span class="nav-count" aria-hidden="true">{trashItems.length}</span>{/if}</button>
      <button class="nav-end" class:active={screen === "guide"} onclick={() => nav("guide")}><IconHelp size={21} strokeWidth={1.8} aria-hidden="true" />{say("Guida", "Guide")}</button>
      <button class:active={screen === "settings"} onclick={() => void act(loadSettings)}><IconSettings size={21} strokeWidth={1.8} aria-hidden="true" />{t("nav.settings")}</button>
    </nav>
    <div class="sidebar-footer">
      <span title={say("Elaborazione locale: resta tutto sul tuo computer", "Local processing: everything stays on your computer")}>{bootstrap?.version ?? ""}</span>
    </div>
  </aside>

  <main class="main-area">
    <header class="topbar">
      <nav class="breadcrumb" aria-label={t("app.breadcrumb")}>{#each crumbs() as crumb, index (index)}{#if index}<span class="slash" aria-hidden="true">/</span>{/if}{#if crumb.go}{@const go = crumb.go}<button class="crumb" type="button" onclick={go}>{crumb.label}</button>{:else}<strong aria-current="page">{crumb.label}</strong>{/if}{/each}</nav>
      <div class="top-actions">{#if bootstrap}<ConnectorPanel view="chip" {language} {...connectorHooks} />{/if}<span class="local-pill"><span class="pulse"></span>{t("common.local")}</span><button class="avatar-button" aria-label={say("Vai ai tuoi siti", "Go to your sites")} title={say("Vai ai tuoi siti", "Go to your sites")} onclick={goHome}>HP</button></div>
    </header>

    {#if cmsImportProgress}
      <div class="import-progress" role="status" data-testid="cms-import-progress">
        <span class="spinner small-spinner" aria-hidden="true"></span>
        <span>{cmsImportProgress.phase ? t(`cms.progress.${cmsImportProgress.phase}`, { done: cmsImportProgress.done ?? 0, total: cmsImportProgress.total ?? 0 }) : cmsImportProgress.kind === "refine" ? cmsImportProgress.connector ? say("In attesa di Claude: in Claude Code o Claude Desktop, con il connettore di Histeon Publish, scrivi «Rispondi alle scelte dei nomi di Histeon Publish». La domanda aspetta 15 minuti.", "Waiting for Claude: in Claude Code or Claude Desktop, with the Histeon Publish connector, write «Answer the Histeon Publish name choices». The question waits 15 minutes.") : say("Il modello sta scegliendo i nomi: con un modello locale può volerci qualche minuto.", "The model is choosing the names: with a local model it may take a few minutes.") : t(cmsImportProgress.kind === "check" ? "cms.progressCheck" : "cms.progressImport")}</span>
        {#if cmsImportProgress.phase && cmsImportProgress.total}<progress max={cmsImportProgress.total} value={cmsImportProgress.done ?? 0}></progress>{/if}
        {#if cmsImportProgress.phase !== "writing"}<button class="button outline small" type="button" onclick={cancelCmsImport}>{t("cms.importCancel")}</button>{/if}
      </div>
    {/if}

    <!-- Both regions are always in the page, empty until a notice arrives, so screen readers announce what is added. -->
    <div class="toast-region" role="region" aria-label={say("Avvisi", "Notices")} onmouseenter={() => toastsPaused = true} onmouseleave={() => toastsPaused = false} onfocusin={() => toastsPaused = true} onfocusout={() => toastsPaused = false}>
      <div class="toast-list" role="alert" aria-live="assertive">{#each toasts.filter((item) => item.kind === "error") as toast (toast.id)}{@render toastItem(toast)}{/each}</div>
      <div class="toast-list" role="status" aria-live="polite">{#each toasts.filter((item) => item.kind === "success") as toast (toast.id)}{@render toastItem(toast)}{/each}</div>
    </div>
    {#snippet toastItem(toast: Toast)}
      <div class="toast" class:error-toast={toast.kind === "error"} class:success-toast={toast.kind === "success"}>
        <span aria-hidden="true">{toast.kind === "error" ? "!" : "✓"}</span>
        <div class="toast-text"><p>{#if toast.agent}<strong class="toast-agent">{t("toast.agent")}</strong> {/if}{toast.text}</p>{#if toast.detail}<details class="toast-detail"><summary>{t("error.details")}</summary><p>{toast.detail}</p></details>{/if}</div>
        {#if toast.action?.href}<a class="button text small" href={toast.action.href} target="_blank" rel="noreferrer">{toast.action.label}</a>{:else if toast.action?.run}<button class="button text small" onclick={() => { toast.action?.run?.(); dismissToast(toast.id); }}>{toast.action.label}</button>{/if}
        <button class="icon-button" aria-label={t("common.close")} onclick={() => dismissToast(toast.id)}>×</button>
      </div>
    {/snippet}

    {#if showSandboxFallback}<div class="sandbox-notice" role="note"><span aria-hidden="true">!</span><p>{say("Questa AppImage gira senza sandbox Chromium perché il kernel blocca gli user namespace. Per mantenere l’isolamento, installa il pacchetto .deb.", "This AppImage is running without the Chromium sandbox because the kernel blocks user namespaces. Install the .deb package to keep process isolation.")}</p><button class="icon-button" aria-label={t("common.close")} onclick={() => showSandboxFallback = false}>×</button></div>{/if}

    {#if !bootstrap}
      <section class="loading-state"><div class="spinner"></div><p>{t("common.loading")}</p></section>
    {:else if screen === "home" || (screen === "cms" && !selectedCmsProject)}
      <section class="page-wrap">
        <div class="page-heading"><div><h1 data-testid="home-title">{t("home.title")}</h1><p>{t("home.subtitle")}</p></div><div class="home-heading-actions"><button class="button primary" data-testid="home-new-site" onclick={beginNewSite}><span>＋</span>{t("home.add")}</button></div></div>
          <div class="cms-catalog-filters" role="group" aria-label={t("cms.catalogFilterLabel")}>
            <button class:active={cmsCatalogFilter === "all"} aria-pressed={cmsCatalogFilter === "all"} onclick={() => cmsCatalogFilter = "all"}>{t("cms.catalogAll")} <span>{cmsProjects.length + cmsConnections.length}</span></button>
            <button class:active={cmsCatalogFilter === "local"} aria-pressed={cmsCatalogFilter === "local"} onclick={() => cmsCatalogFilter = "local"}>{t("cms.catalogLocal")} <span>{cmsProjects.length}</span></button>
            <button class:active={cmsCatalogFilter === "connected"} aria-pressed={cmsCatalogFilter === "connected"} onclick={() => cmsCatalogFilter = "connected"}>{t("cms.catalogConnected")} <span>{cmsConnections.length}</span></button>
          </div>
          {#if cmsProjects.length + sites.length > 3}<input class="home-search" type="search" bind:value={siteQuery} placeholder={t("home.searchSites")} aria-label={t("home.searchSites")} data-testid="home-search" />{/if}
          {#if cmsCatalogFilter !== "connected" && cmsProjects.length}
            <div class="catalog-pick-row"><button class="button outline small" onclick={() => askFolder("create", "cms")}>▤ {t("folder.new")}</button><button class="button outline small" aria-pressed={pickMode === "cms"} onclick={() => pickMode === "cms" ? stopPicking() : startPicking("cms")}>{t("delete.select")}</button></div>
            {@render folderBar("cms", cmsProjects)}
            {#if pickMode === "cms"}{@render pickBar("cms")}{/if}
            <div class="site-grid">
              {#each visibleItems("cms", cmsProjects) as project (project.id)}
                <article class="site-card site-card-open" class:pickable={pickMode === "cms"} class:picked={pickMode === "cms" && picked.includes(project.id)} draggable={folderListOf("cms").length > 0} ondragstart={(event) => startDrag(event, "cms", project.id)} ondragend={() => { dragging = null; dropFolder = null; }} onclickcapture={(event) => pickCardClick(event, "cms", project.id)} oncontextmenu={(event) => openCardMenu(event, "cms", project.id, project.name)}>
                  {#if project.summary?.cover}<img class="site-cover" src={project.summary.cover} alt="" loading="lazy" />{/if}
                  {#if pickMode === "cms"}<label class="card-pick"><input type="checkbox" checked={picked.includes(project.id)} aria-label={t("delete.pickLabel", { name: project.name })} onchange={(event) => togglePicked(project.id, (event.currentTarget as HTMLInputElement).checked)} /></label>{/if}
                  <div class="site-card-top"><span class="site-icon">{project.name.slice(0, 1).toUpperCase()}</span><span class="status-chip" data-origin={project.summary?.origin ?? "local"}>{t(`cms.origin.${project.summary?.origin ?? "local"}`)}</span></div>
                  <button class="site-title" onclick={() => void act(() => openCmsProject(project.id))}>{project.name}<span aria-hidden="true">↗</span></button>
                  {#if project.summary}<p class="muted">{t("cms.cardCounts", { pages: n("count.pages", project.summary.pages), posts: n("count.posts", project.summary.posts) })}</p>{/if}
                  <p class="muted">{t("cms.updated", { date: formatDate(project.updatedAt) })}</p>
                  {#if project.summary?.lastBuild}<p class="muted" data-testid="cms-card-build">{t(project.summary.lastBuild.current ? "cms.cardBuild" : "cms.cardBuildOld", { date: formatDate(project.summary.lastBuild.at) })}</p>{/if}
                </article>
              {/each}
            </div>
            {#if currentFolder("cms") && !visibleItems("cms", cmsProjects).length}<p class="empty-note">{t("folder.empty")}</p>{/if}
          {:else if cmsCatalogFilter !== "connected"}<div class="welcome" data-testid="welcome"><h2>{t("welcome.title")}</h2><p class="muted">{t("welcome.hint")}</p><ol><li><strong>{t("welcome.one")}</strong><span>{t("welcome.oneHint")}</span></li><li><strong>{t("welcome.two")}</strong><span>{t("welcome.twoHint")}</span></li><li><strong>{t("welcome.three")}</strong><span>{t("welcome.threeHint")}</span></li></ol><button class="button primary" onclick={() => { firstSite = { step: 0, name: "", kind: "rivista", locale: "it-IT" }; }} data-testid="welcome-start">{t("welcome.start")}</button></div>{/if}
          {#if cmsCatalogFilter === "connected" || (cmsCatalogFilter === "all" && cmsConnections.length)}
          <!-- E9: in "Tutti" only the connected sites; the pairing form is in "Collegati" or behind "Importa da Histeon WordPress". -->
          <HomeConnections {language} {act} {beginCmsUnlink} {busy} {cmsCatalogFilter} {cmsConnections} bind:cmsPairingCode bind:cmsPairingTargetId {cmsProjects} {connectCmsSite} {openCmsProject} {pullCmsSite} bind:pairingSiteUrl {pendingPairing} {startPairing} {confirmPairing} cancelPairing={() => { pendingPairing = null; }} />
          {/if}
          {#if cmsUnavailableProjects.length}
            <section class="panel-card cms-unavailable" role="alert">
              <h3>{say("Progetti che non si aprono", "Projects that do not open")}</h3>
              <ul>{#each cmsUnavailableProjects as problem (problem.id)}<li>{problem.message}</li>{/each}</ul>
            </section>
          {/if}
          {#if cmsCatalogFilter !== "connected"}
            <CmsImportZone {language} {busy} {cmsArchiveDropActive} bind:cmsImportInput bind:cmsImportOpener {handleCmsArchiveDragLeave} {handleCmsArchiveDragOver} {handleCmsArchiveDrop} {importCmsArchiveInput} {nav} />
            {#if cmsPrototypeProblems}<PrototypeProblemsPanel {language} {act} {busy} bind:cmsPrototypeProblemsPanel {copyPrototypeProblems} {prototypeIssuePlace} {recheckPrototype} problems={cmsPrototypeProblems} onclose={() => { cmsPrototypeProblems = null; }} />{/if}
          {/if}
        {#if sites.length && !currentFolder("cms") && cmsCatalogFilter !== "connected"}
          <h2 class="home-section-title">{t("home.staticSites")}</h2>
          {@render folderBar("sites", sites)}
          {#if pickMode === "sites"}{@render pickBar("sites")}{/if}
          <div class="site-grid">
            {#each visibleItems("sites", sites) as site (site.id)}
              <article class="site-card" class:pickable={pickMode === "sites"} class:picked={pickMode === "sites" && picked.includes(site.id)} draggable={folderListOf("sites").length > 0} ondragstart={(event) => startDrag(event, "sites", site.id)} ondragend={() => { dragging = null; dropFolder = null; }} onclickcapture={(event) => pickCardClick(event, "sites", site.id)} oncontextmenu={(event) => openCardMenu(event, "sites", site.id, site.name)}>
                {#if pickMode === "sites"}<label class="card-pick"><input type="checkbox" checked={picked.includes(site.id)} aria-label={t("delete.pickLabel", { name: site.name })} onchange={(event) => togglePicked(site.id, (event.currentTarget as HTMLInputElement).checked)} /></label>{/if}
                <div class="site-card-top"><span class="site-icon">{site.name.slice(0, 1).toUpperCase()}</span><span class="status-chip {siteState(site).tone}">{siteState(site).label}</span></div>
                <button class="site-title" onclick={() => void act(() => openSite(site.id))}>{site.name}<span aria-hidden="true">↗</span></button>
                <p class="muted">{site.source.label} · {t(`site.kind.${site.source.kind}`)}</p>
                <div class="site-metadata"><div><small>{t("home.lastBuild")}</small><span>{site.lastBuild ? formatDate(site.lastBuild.createdAt) : t("home.noBuild")}</span></div><div><small>{t("home.lastDeploy")}</small><span>{site.lastDeploy ? `${formatDate(site.lastDeploy.createdAt)}${site.lastDeploy.versionId ? ` · ${site.lastDeploy.versionId.slice(0, 8)}` : ""}` : t("home.noDeploy")}</span></div></div>
                {#if site.publicUrl}<a class="public-link card-public-link" href={site.publicUrl} target="_blank" rel="noreferrer">{site.publicUrl} ↗</a>{/if}
                <div class="site-card-actions">{#if site.cmsProjectId}{@const projectId = site.cmsProjectId}<button class="button primary small" onclick={() => void act(() => openCmsProject(projectId))}>{t("site.cmsOpenProject")}</button>{:else}<button class="button primary small" onclick={() => void act(async () => { await openSite(site.id); await runBuild(); })}>{t("home.build")}</button>{/if}<button class="button text small" onclick={() => void act(() => openSite(site.id))}>{t("home.open")} →</button></div>
              </article>
            {/each}
          </div>
          {#if currentFolder("sites") && !visibleItems("sites", sites).length}<p class="empty-note">{t("folder.empty")}</p>{/if}
        {/if}
      </section>
    {:else if (screen === "admin" || screen === "cms") && selectedCmsProject}
      {@const adminProject = selectedCmsProject.project}
      <SiteAdmin lastBuildAt={cmsProjects.find((project) => project.id === adminProject.id)?.summary?.lastBuild?.at ?? null} notices={cmsNoticesPanel} publishPanel={cmsPublishPanel} templatesPanel={cmsTemplatesPanel} advancedPanel={cmsAdvancedPanel} trashSites={cmsTrashConnections.length} onAskTrash={(ids) => { cmsTrashSelection = ids; showCmsTrashConfirm = true; }} projectId={adminProject.id} projectName={adminProject.name} {language} section={adminSection} onSection={(next) => { adminSection = next; }} onOpenBuilder={(alias, back) => launchCmsEditor({ alias }, back === "bacheca" ? "amministra" : `amministra/${back}`)} onPublish={publishNow} onPreview={(alias) => void act(() => previewCmsDocument(alias))} onPreviewSite={() => void act(previewCmsSite)} onNotice={adminNotice} onRenamed={(name) => { if (selectedCmsProject) selectedCmsProject.project.name = name; }} />
    {:else if screen === "new"}
      <NewSiteScreen {language} bind:accountId {act} bind:basicPassword bind:basicUser {busy} bind:cmsProjectName {cmsWordPressSetupSiteId} {consentLocalOrigin} {consentOrigin} bind:cookie {createCmsProject} {createFromStarter} {detectSite} {detection} {filesFromInput} {handleDrop} {importNewSiteDesign} {importNewSitePrototype} {importProgress} {importWordPressFile} bind:localImportNotice {nav} bind:newSiteDesign bind:newSitePrototype {saveNewSite} {selectFiles} {selectedCmsProject} bind:selectedFiles {showCmsConnectionImport} bind:siteName {sourceToSave} bind:urlInput bind:wordPressAddress bind:workerName onBackToProject={() => { screen = "cms"; }} />
    {:else if screen === "site" && selectedSite}
      <section class="page-wrap">
        <button class="back-link" onclick={() => nav("home")}>← {t("new.back")}</button>
        <div class="page-heading site-heading"><div><div class="eyebrow">{selectedSite.cmsProjectId ? t("site.cmsEyebrow") : `${say("PROGETTO", "PROJECT")} · ${selectedSite.source.kind === "url" ? say("ONLINE", "ONLINE") : say("LOCALE", "LOCAL")}`}</div><h1>{selectedSite.name}</h1><p>{selectedSite.cmsProjectId ? t("site.cmsSubtitle", { project: cmsProjectNameById(selectedSite.cmsProjectId) }) : selectedSite.source.label} <span class="muted-dot">·</span> {selectedSite.worker ? `Worker ${selectedSite.worker}` : say("Worker da configurare", "Worker not configured")}</p></div><div class="heading-actions">{#if !selectedSite.cmsProjectId}<button class="button outline" data-testid="site-convert-cms" onclick={() => void act(convertSiteToCms)} disabled={busy || selectedSite.lastBuild?.status !== "ready"} title={selectedSite.lastBuild?.status === "ready" ? t("site.convertHint") : t("site.convertNeedsBuild")}>{t("site.convert")}</button>{/if}{#if selectedSite.cmsProjectId}{@const projectId = selectedSite.cmsProjectId}<button class="button primary" data-testid="site-open-cms-project" onclick={() => void act(() => openCmsProject(projectId))} disabled={busy}>{t("site.cmsOpenProject")} <span>→</span></button>{:else}<button class="button outline" onclick={() => void act(() => showReport())} disabled={!report}>{t("site.report")}</button><button class="button primary" data-testid="site-build" onclick={() => void act(runBuild)} disabled={busy}>{busy ? t("site.preparing") : t("site.buildNow")} <span>→</span></button>{/if}</div></div>
        <div class="site-detail-grid">
          <div class="site-primary-column">
            <SiteJobProgress {language} {act} {activeJob} {cancelJob} bind:progressFilter />
            {#if selectedSite.cmsProjectId}
              <section class="panel-card cms-destination-card" data-testid="cms-destination-card">
                <div class="section-card-header"><div><div class="eyebrow">{t("site.cmsEyebrow")}</div><h2>{t("site.cmsCardTitle", { project: cmsProjectNameById(selectedSite.cmsProjectId) })}</h2></div><span class="settings-gear" aria-hidden="true">▦</span></div>
                <p class="field-hint">{t("site.cmsCardBody")}</p>
              </section>
            {:else}
            <section class="panel-card latest-build-card"><div class="section-card-header"><div><div class="eyebrow">{say("ULTIMA VERIFICA", "LATEST CHECK")}</div><h2>{reportIsStale ? t("site.staleTitle") : report ? t("site.ready") : t("site.needsBuild")}</h2></div>{#if report}{@const reportChip = stateOf(report.status)}<span class="status-chip {reportChip.tone}">{reportChip.label}</span>{/if}</div>
      {#if reportIsStale}<p class="stale-build-note">{t("site.staleBody")}</p>{/if}
      {#if selectedSite.lastAttempt && selectedSite.lastBuild && ["cancelled", "failed"].includes(selectedSite.lastAttempt.status)}<p class="field-hint" data-testid="last-attempt-note">{t(selectedSite.lastAttempt.status === "cancelled" ? "build.lastAttemptCancelled" : "build.lastAttemptFailed", { date: formatDate(selectedSite.lastBuild.createdAt) })}</p>{/if}
      {#if report}<div class="build-stats"><div><strong>{report.pages ?? 0}</strong><small>{t("site.pages")}</small></div><div><strong>{report.assets ?? 0}</strong><small>{t("site.assets")}</small></div><div><strong>{report.files ?? 0}</strong><small>{t("site.files")}</small></div><div><strong>{formatBytes(report.totalBytes)}</strong><small>{t("site.size")}</small></div></div>{#if report.pagefind?.enabled}<p class="field-hint">{say(`Pagefind: ${report.pagefind.indexedPages} pagine indicizzate.`, `Pagefind: ${report.pagefind.indexedPages} pages indexed.`)}</p>{/if}{#if report.worker}<p class="field-hint" data-testid="build-worker-note">{say(`Codice del server: _worker.js (${formatBytes(report.worker.bytes)}), ${report.worker.origin === "file" ? "caricato a parte" : "dai file del sito"}. Risponde per primo a ogni richiesta; il resto va ai file statici.${report.worker.kv?.length ? ` Archivi KV usati dal codice: ${report.worker.kv.join(", ")}.` : ""}`, `Server code: _worker.js (${formatBytes(report.worker.bytes)}), ${report.worker.origin === "file" ? "uploaded apart" : "from the site's files"}. It answers every request first; the rest goes to the static files.${report.worker.kv?.length ? ` KV namespaces used by the code: ${report.worker.kv.join(", ")}.` : ""}`)}</p>{/if}{#if report.forms}<p class="field-hint">{report.forms.enabled ? say(`${report.forms.attachedForms} moduli Fluent Forms collegati.`, `${report.forms.attachedForms} Fluent Forms connected.`) : say("Nessun modulo Fluent Forms collegato; gli altri restano inattivi.", "No Fluent Forms was connected; other forms stay inactive.")}</p>{/if}<div class="build-card-footer"><span>{t("site.date")}: {formatDate(report.completedAt ?? report.createdAt)}</span><div><button class="button text small" onclick={() => void act(() => showReport(report?.id))}>{t("site.report")} →</button><button class="button outline small" disabled={report.status !== "ready" || reportIsStale} onclick={() => void act(createPreview)}>{t("site.preview")}</button><button class="button outline small" data-testid="site-export" disabled={report.status !== "ready" || reportIsStale} onclick={() => void act(exportBundle)}>{t("site.export")}</button></div></div>{:else}<div class="build-empty"><span class="build-empty-icon">✳</span><p>{say("La versione analizza pagine, immagini, collegamenti e funzioni dinamiche prima di preparare una copia esportabile.", "The build checks pages, images, links, and dynamic features before preparing an exportable copy.")}</p><button class="button primary" onclick={() => void act(runBuild)}>{t("site.buildNow")} →</button></div>{/if}
            </section>
            <SiteSourceCard {language} {act} {busy} {handleSourceDragOver} {handleSourceDrop} {removeWorkerModule} {replaceSourceFromInput} {selectReplacementFile} {selectWorkerFile} {selectedSite} bind:sourceDropActive {sourceReplacementProgress} {workerFromInput} />
            {/if}
            <section class="panel-card site-settings-card">
              <div class="section-card-header"><div><div class="eyebrow">{say("CONFIGURAZIONE", "CONFIGURATION")}</div><h2>{t("site.settings")}</h2></div><span class="settings-gear" aria-hidden="true">⚙</span></div>
              <label class="field-label" for="deploy-target">{say("Dove vuoi pubblicare?", "Where do you want to publish?")}</label>
              <select id="deploy-target" bind:value={deployTarget}>
                <option value="cloudflare">Cloudflare Workers</option>
                <option value="ftp">{say("Hosting o VPS tramite FTP / FTPS / SFTP", "Hosting or VPS via FTP / FTPS / SFTP")}</option>
              </select>
              {#if deployTarget === "cloudflare"}
              <div class="settings-grid">
                <div><label class="field-label" for="site-account">{t("new.account")}</label><input id="site-account" bind:value={accountId} maxlength="32" placeholder={say("32 caratteri esadecimali", "32 hexadecimal characters")} /></div>
                <div><label class="field-label" for="site-worker">{t("new.workerName")}</label><input id="site-worker" bind:value={workerName} maxlength="63" /></div>
                <div class="wide-field"><label class="field-label" for="site-domain">{t("site.public")}</label><div class="input-action"><input id="site-domain" bind:value={domain} onfocus={() => { if (domainZones === null && selectedSite) void loadDomainZones(selectedSite.id); }} oninput={() => domainPlan = null} placeholder="esempio.it" /><button class="button outline" onclick={() => void act(prepareDomain)} disabled={!domain.trim() || busy}>{selectedSite.domain ? say("Aggiorna dominio", "Update domain") : say("Collega dominio", "Connect domain")}</button></div>{#if wwwApplies}<label class="domain-option" for="domain-www"><input id="domain-www" type="checkbox" bind:checked={includeWww} onchange={() => domainPlan = null} /><span>{say("Collega anche www (es. www.esempio.it)", "Connect www too (for example, www.example.com)")}</span></label>{/if}<p class="field-hint">{say("Controlliamo Cloudflare e configuriamo DNS e HTTPS per te. Non servono modifiche manuali.", "We check Cloudflare and set up DNS and HTTPS for you. No manual changes are needed.")}</p></div>
              </div>
              {#if !selectedSite.cmsProjectId}
              <div class="settings-grid"><div class="wide-field"><label class="field-label" for="site-kv">{say("Archivi KV del codice del server", "KV namespaces for the server code")}</label><input id="site-kv" bind:value={kvNames} placeholder="VOTI" autocomplete="off" spellcheck="false" /><p class="field-hint">{say(`Quando carichi il codice del server, Publish trova gli archivi che usa (env.NOME.get, put, list, delete) e li scrive qui come NOME=titolo: l’archivio dell’account che corrisponde, se c’è, altrimenti «${workerName || "worker"}-NOME», creato alla prima pubblicazione. Puoi correggere il titolo o aggiungere altri archivi, separati da virgole; quello che scrivi tu non viene cambiato. I dati restano da una pubblicazione all’altra. Il token Cloudflare deve avere anche il permesso Workers KV Storage › Edit.`, `When you upload the server code, Publish finds the namespaces it uses (env.NAME.get, put, list, delete) and writes them here as NAME=title: the account's matching namespace if there is one, otherwise “${workerName || "worker"}-NAME”, created on the first publication. You can fix the title or add more namespaces, comma-separated; what you write is never changed. The data stays from one publication to the next. The Cloudflare token also needs Workers KV Storage › Edit.`)}</p>{#each kvCaseMismatches as mismatch}<p class="field-hint field-warning" data-testid="site-kv-case">{say(`«${mismatch.name}» non è il nome usato nel codice: il codice legge env.${mismatch.used}, e maiuscole e minuscole contano. Scrivi ${mismatch.used} oppure lascia il campo vuoto: Publish collega ${mismatch.used} da solo.`, `“${mismatch.name}” is not the name the code uses: the code reads env.${mismatch.used}, and case matters. Write ${mismatch.used} or leave the field empty: Publish binds ${mismatch.used} by itself.`)}</p>{/each}{#if foundKv.length > 0}<p class="field-hint" data-testid="site-kv-found">{say(`Archivi trovati nel codice: ${foundKv.map((name) => `${name} → ${workerName || "worker"}-${name}`).join(", ")}.`, `Namespaces found in the code: ${foundKv.map((name) => `${name} → ${workerName || "worker"}-${name}`).join(", ")}.`)}</p>{/if}</div></div>
              <label class="render-mode-toggle"><input type="checkbox" bind:checked={pagefindEnabled} /><span>{say("Aggiungi alla versione la ricerca locale Pagefind", "Add local Pagefind search to the bundle")}</span></label>
              <p class="field-hint">{say("La ricerca è disattivata per default e viene preparata nel computer.", "Search is off by default and built on this computer.")}</p>
              <SiteFormsSettings {language} {act} bind:formsIds bind:formsRestUrl {removeTurnstileSecret} {selectedSite} bind:turnstileSecret bind:turnstileSiteKey />
              {/if}
              {:else}
                <SiteHostingFields {language} {act} bind:allowInsecureFtp {clearHostingTlsCa} bind:hostingAuthMethod bind:hostingHost bind:hostingHostKeyConfirmed bind:hostingPassphrase bind:hostingPassword bind:hostingPort bind:hostingPrivateKey bind:hostingProtocol {hostingProtocolChanged} bind:hostingPublicUrl bind:hostingRemoteDirectory bind:hostingTlsCaCertificate bind:hostingTlsCaFilename bind:hostingUsername {observedHostingHostKeyFingerprint} {removeHostingCredentials} {selectedSite} onCertificateLoaded={(message) => { successMessage = message; }} />
                <SiteWordPressTools {language} {act} {applyWordPressInstall} {busy} {databaseConnections} {hostingDirectoryInspection} {inspectHostingDirectory} {prepareWordPressInstall} {selectedSite} {verifyWordPressPreflight} {verifyWordPressRuntime} {wordPressDatabaseTlsStatus} bind:wordpressDatabaseConnectionId bind:wordpressPreflight bind:wordpressProvisionAdminEmail bind:wordpressProvisionAdminPassword bind:wordpressProvisionAdminUsername bind:wordpressProvisionPlan {wordpressProvisionPlans} bind:wordpressProvisionSiteTitle />
                <p class="field-hint">{say("I moduli Fluent Forms tramite WordPress richiedono il Worker Cloudflare di Histeon Publish; seleziona Cloudflare per mantenerli attivi.", "Fluent Forms through WordPress require Histeon Publish's Cloudflare Worker; choose Cloudflare to keep them enabled.")}</p>
              {/if}
              <button class="button text small" onclick={() => void act(saveSiteSettings)} disabled={Boolean(observedHostingHostKeyFingerprint && !hostingHostKeyConfirmed)}>{deployTarget === "ftp" ? say("Verifica e salva la destinazione", "Verify and save destination") : say("Salva configurazione", "Save settings")} →</button>
              {#if selectedSite.publicUrl}<a class="public-link" href={selectedSite.publicUrl} target="_blank" rel="noreferrer">{selectedSite.publicUrl} ↗</a>{/if}
            </section>
            {#if selectedSite.source.kind === "url"}
              <section class="panel-card render-mode-card"><div class="eyebrow">MODALITÀ AVANZATA</div><h2>{say("Pagina renderizzata da JavaScript", "JavaScript-rendered page")}</h2><p>{say("Acquisisce il DOM dopo il caricamento. Le richieste API restano dinamiche e vengono segnalate nel report.", "Captures the DOM after loading. API requests remain dynamic and are reported.")}</p><label class="render-mode-toggle"><input type="checkbox" bind:checked={renderMode} /><span>{say("Attiva il browser isolato", "Use the isolated browser")}</span></label></section>
            {/if}
            {#if selectedSite.source.kind === "url"}
              <details class="panel-card wp-credentials-card">
                <summary><span class="keyring-icon" aria-hidden="true">⌑</span><span><strong>{t("settings.wp")}</strong><small>{t("settings.wpHelp")}</small></span><span class="summary-chevron" aria-hidden="true">＋</span></summary>
                <div class="settings-grid"><div><label class="field-label" for="wp-user">{t("new.user")}</label><input id="wp-user" autocomplete="username" bind:value={wpUser} /></div><div><label class="field-label" for="wp-pass">{t("new.password")}</label><input id="wp-pass" type="password" autocomplete="new-password" bind:value={wpPassword} /></div><div class="wide-field"><label class="field-label" for="wp-cookie">{t("new.cookie")}</label><input id="wp-cookie" type="password" autocomplete="off" bind:value={wpCookie} /></div></div>
                <div class="wp-actions"><span class="muted">{selectedSite.wpCredentialsConfigured ? say("Accesso configurato", "Access configured") : say("Nessun accesso salvato", "No access saved")}</span><div><button class="button text small" onclick={() => void act(removeWpCredentials)} disabled={!selectedSite.wpCredentialsConfigured}>{t("settings.removeWp")}</button><button class="button outline small" onclick={() => void act(saveWpCredentials)}>{t("settings.saveWp")}</button></div></div>
              </details>
            {/if}
          </div>
            <aside class="site-side-column">{#if !selectedSite.cmsProjectId}<section class="panel-card publish-card"><div class="eyebrow">{say("PUBBLICAZIONE", "PUBLISHING")}</div><div class="publish-illustration">↗</div><h2>{say("Dal sito al web con un clic.", "From your site to the web in one click.")}</h2><p>{deployTarget === "cloudflare" ? say("Creo una nuova versione, controllo i file e li pubblico su Cloudflare se tutto è pronto.", "I create a fresh build, check the files, and publish them to Cloudflare when ready.") : say("Creo una nuova versione, controllo i file e li invio al tuo hosting o VPS in modo cifrato.", "I create a fresh build, check the files, and upload them to your hosting or VPS securely.")}</p><div class="publish-destination"><span class="destination-icon">◈</span><span><small>{t("site.target")}</small><strong>{deployTarget === "cloudflare" ? selectedSite.worker ?? say("Worker da configurare", "Worker not configured") : selectedSite.hosting?.host ?? say("Hosting da configurare", "Hosting not configured")}</strong><small>{deployTarget === "cloudflare" ? selectedSite.domain ?? t("site.noneDomain") : selectedSite.hosting?.remoteDirectory || say("Cartella iniziale", "Root folder")}</small></span></div><button class="button dark full" disabled={busy} onclick={(event) => { siteDeployOpener = event.currentTarget; void act(publishWithFreshBuild); }}>{busy ? t("site.preparing") : t("site.deployNow")} <span>→</span></button>{#if report?.status === "blocked"}<small class="blocked-hint">{t("site.caution")}</small>{/if}</section>{/if}
            {#if selectedSite.lastDeploy?.healthCheck}<section class="panel-card publish-health" class:warning={selectedSite.lastDeploy.healthCheck.status !== "ok"}><div class="section-card-header"><h2>{say("Controllo del sito pubblicato", "Published site check")}</h2><span class="status-chip" class:ready={selectedSite.lastDeploy.healthCheck.status === "ok"} class:stale={selectedSite.lastDeploy.healthCheck.status !== "ok"}>{selectedSite.lastDeploy.healthCheck.status === "ok" ? say("OK", "OK") : say("Da controllare", "Needs attention")}</span></div><p>{selectedSite.lastDeploy.healthCheck.message}</p>{#if selectedSite.lastDeploy.healthCheck.url}<a class="public-link" href={selectedSite.lastDeploy.healthCheck.url} target="_blank" rel="noreferrer">{selectedSite.lastDeploy.healthCheck.url} ↗</a>{/if}</section>{/if}
            <section class="panel-card history-shortcut"><div class="section-card-header"><div><div class="eyebrow">{say("ATTIVITÀ", "ACTIVITY")}</div><h2>{t("history.title")}</h2></div><button class="icon-button" aria-label={t("site.history")} onclick={() => { screen = "history"; remoteHistory = null; }}>↗</button></div><div class="activity-mini"><span class="timeline-dot build-dot"></span><div><strong>{historyData.builds.length} {t("history.build").toLowerCase()}</strong><small>{historyData.builds[0] ? formatDate(historyData.builds[0].createdAt) : t("history.noLocal")}</small></div></div><div class="activity-mini"><span class="timeline-dot deploy-dot"></span><div><strong>{historyData.deploys.length} {t("history.deploy").toLowerCase()}</strong><small>{historyData.deploys[0] ? formatDate(String(historyData.deploys[0].createdAt ?? "")) : t("home.noDeploy")}</small></div></div><button class="button text small" onclick={() => { screen = "history"; remoteHistory = null; }}>{t("site.history")} →</button></section>
            <div class="local-storage-note"><span>⌂</span><div><strong>{say("Archivio privato", "Private archive")}</strong><p>{say("Le versioni e i report restano nella cartella dati locale.", "Builds and reports stay in the local data folder.")}</p></div></div>
          </aside>
        </div>
      </section>
    {:else if screen === "report" && report}
      <ReportScreen {language} {act} {exportReport} {nav} {report} {reportIsStale} {selectedSite} />
    {:else if screen === "preview"}
      <section class="page-wrap preview-page"><div class="page-heading"><div><div class="eyebrow">{say("ANTEPRIMA ISOLATA", "ISOLATED PREVIEW")}</div><h1>{selectedSite?.name ?? say("Anteprima", "Preview")}</h1><p>{say("Questa pagina viene caricata in un riquadro isolato e temporaneo.", "This page is loaded in a temporary isolated frame.")}</p></div><button class="button outline" onclick={() => nav("site")}>← {say("Torna al sito", "Back to site")}</button></div>{#if previewUrl}<iframe class="preview-frame" title={`${say("Anteprima isolata di", "Isolated preview of")} ${selectedSite?.name ?? say("sito", "site")}`} src={previewUrl} sandbox="allow-scripts"></iframe>{/if}</section>
    {:else if screen === "history" && selectedSite}
      <HistoryScreen {language} {act} {historyData} {nav} {refreshRemoteHistory} {remoteHistory} {showReport} onRollback={(item) => { showRollback = item; }} />
    {:else if screen === "guide"}
      <GuideScreen {language} {act} {beginNewSite} {bootstrap} {busy} {loadSettings} {openSite} {sites} />
    {:else if screen === "settings"}
      <SettingsScreen {language} {act} {busy} {cancelDatabaseConnectionEdit} {cloudflareAccounts} {dataDirectoryDisplay} bind:databaseCaCertificate bind:databaseConnectionName {databaseConnections} bind:databaseHost bind:databaseName bind:databasePassword bind:databasePort bind:databaseSshAuthMethod bind:databaseSshHost bind:databaseSshHostKeyConfirmed bind:databaseSshHostKeyFingerprint bind:databaseSshHostKeyIdentity bind:databaseSshPassphrase bind:databaseSshPassword bind:databaseSshPort bind:databaseSshPrivateKey bind:databaseSshUsername bind:databaseTablePrefix bind:databaseUseSshTunnel bind:databaseUsername {discoverCloudflareAccounts} {downloadErrorLog} {editDatabaseConnection} {editingDatabaseConnectionId} {nav} {recheckDatabaseConnection} {removeToken} {saveDatabaseConnection} {saveSettings} {setTheme} bind:settingsAccountId bind:settingsLanguage bind:settingsTab bind:settingsToken {settingsTokenState} {theme} {verifyAndSaveToken} {verifyDatabaseSshHostKey} onRemoveDatabase={(connection) => { databaseRemoval = connection; }} />
    {:else if screen === "agent"}
      <section class="page-wrap narrow"><div class="page-heading"><div><div class="eyebrow">{t("agent.eyebrow")}</div><h1>{t("agent.title")}</h1><p>{t("agent.subtitle")}</p></div></div>
        <ConnectorPanel view="section" {language} {...connectorHooks} />
        <ImportRefineSettings {language} {act} {busy} />
      </section>
    {:else if screen === "trash"}
      <TrashScreen {language} {act} {askPurge} {busy} {restoreItem} {trash} {trashDays} {trashItems} />
    {:else if screen === "activity"}
      <section class="page-wrap"><div class="page-heading"><div><div class="eyebrow">{say("REGISTRO LOCALE", "LOCAL LOG")}</div><h1>{t("nav.activity")}</h1><p>{say("Versione e pubblicazioni recenti dei tuoi siti.", "Recent builds and publishes for your sites.")}</p></div></div><div class="panel-card"><div class="activity-table-head"><span>{say("Sito", "Site")}</span><span>{say("Operazione", "Operation")}</span><span>{say("Stato", "Status")}</span><span>{say("Data", "Date")}</span><span></span></div>{#each sites as site}<button class="activity-row" onclick={() => void act(async () => { await openSite(site.id); screen = "history"; })}><strong>{site.name}</strong><span>{site.lastAttempt ?? site.lastBuild ? say("Versione", "Build") : say("Sito aggiunto", "Site added")}</span><span class="status-chip {activityState(site).tone}">{activityState(site).label}</span><time>{formatDate(site.lastBuild?.createdAt ?? site.createdAt)}</time><span>→</span></button>{/each}{#if !sites.length}<p class="empty-note">{t("history.noLocal")}</p>{/if}</div></section>
    {/if}

    <!-- Mounted once the session works: with the top-bar chip it keeps the AI connector polled on every screen;
         it shows WordPress sends waiting for the user, fixed to the bottom of the window. -->
    {#if bootstrap}<ConnectorPanel view="banner" {language} {...connectorHooks} />{/if}
  </main>
</div>

{#if showDomainSummary && selectedSite && domainPlan}<DomainDialog {language} {act} {attachDomain} {busy} {domainPlan} {selectedSite} onclose={() => { showDomainSummary = false; }} />{/if}

{#snippet cmsNoticesPanel()}<CmsNoticesPanel {language} {act} {cmsBuild} bind:cmsBuildSummary {cmsBuilding} {cmsImportHistory} bind:cmsImportReport bind:cmsImportReportPanel {downloadCmsImportReport} {launchCmsEditor} {openCmsTab} {prototypeCounts} {report} {selectedCmsProject} bind:wordPressReport />{/snippet}

{#snippet cmsPublishPanel()}<CmsPublishPanel {language} {act} {applyWordPressInstall} {beginCmsUnlink} {buildCmsProject} {busy} {checkCmsRemoteOperation} {checkCmsSite} {verifyCmsSiteInBrowser} {closeCmsSyncPlan} {cmsBuild} {cmsBuildHistory} {cmsBuilding} {cmsConnections} {cmsDeployHealthCheck} bind:cmsDeploySiteId {cmsLiveDeploymentId} bind:cmsPairingCode {cmsPublishDestinations} bind:cmsPublishPlan bind:cmsPublishPlanConfirmed bind:cmsPublishWaysOpen {cmsSiteCheck} bind:cmsWordPressSetupSiteId {connectCmsSite} {createCmsDestinationSite} {databaseConnections} {deployCmsProject} {downloadCmsStaticZip} {exportCmsStaticBuild} {hostingDirectoryInspection} {inspectHostingDirectory} {loadSettings} {openSite} {prepareCmsDestinationPlan} {prepareCmsRemoteRollback} {prepareCmsRollback} {prepareWordPressInstall} {pullCmsSite} {pushCmsProject} {selectedCmsProject} {selectedSite} {sites} {verifyWordPressPreflight} {verifyWordPressRuntime} {wordPressDatabaseTlsStatus} bind:wordpressDatabaseConnectionId bind:wordpressPreflight bind:wordpressProvisionAdminEmail bind:wordpressProvisionAdminPassword bind:wordpressProvisionAdminUsername bind:wordpressProvisionPlan {wordpressProvisionPlans} bind:wordpressProvisionSiteTitle />{/snippet}

{#snippet cmsTemplatesPanel()}<CmsTemplatesPanel {language} {act} {busy} bind:cmsSelecting bind:cmsTemplatePartRef bind:cmsTemplatePartTitle bind:cmsTemplateRef bind:cmsTemplateTitle bind:cmsTrashSelection {createCmsTemplate} {createCmsTemplatePart} {launchCmsEditor} {selectedCmsProject} {setCmsTemplateRole} bind:showCmsTrashConfirm {toggleCmsTrashSelection} />{/snippet}

{#snippet cmsAdvancedPanel()}<CmsAdvancedPanel {language} {act} {backupCmsProject} {busy} {enableCmsPostTaxonomies} {exportCmsProject} {exportCmsSectionLibrary} {exportForWordPress} {restoreCmsDeletion} {selectedCmsProject} />{/snippet}

{#snippet folderBar(kind: ListKind, list: Array<{ id: string; name: string }>)}<FolderBar {language} {act} {askFolder} {busy} {currentFolder} bind:dropFolder {dropOnFolder} {enterFolder} {folderListOf} {folderOf} {overFolder} {removeFolder} {visibleItems} {kind} {list} onSpread={(ids) => { styleSpread = { from: "", ids, results: null }; }} />{/snippet}

{#snippet pickBar(kind: "cms" | "sites")}<PickBar {language} {askDelete} {askFolder} {busy} {cmsProjects} bind:picked {pickedItems} {sites} {stopPicking} {visibleItems} {kind} />{/snippet}

{#if cardMenu}<CardMenu {language} {act} {askDelete} {askFolder} {openCmsProject} {openSite} {pickMode} {picked} {pickedItems} {startPicking} {togglePicked} menu={cardMenu} onclose={() => { cardMenu = null; }} />{/if}

{#if folderDialog}
  <FolderDialog {language} mode={folderDialog.mode} folders={folderListOf(folderDialog.kind)} items={folderDialog.items} current={folderDialog.current} initialName={folderDialog.name} {busy} onsubmit={submitFolder} onclose={() => folderDialog = null} />
{/if}

{#if deleting}
  <DeleteDialog {language} mode={deleting.mode} kind={deleting.kind} items={deleting.items} days={trashDays} {busy} ondelete={deleteItems} onclose={() => deleting = null} />
{/if}

{#if databaseRemoval}<DatabaseRemoveDialog {language} {act} {busy} {confirmRemoveDatabaseConnection} {databaseRemoval} onclose={() => { databaseRemoval = null; }} />{/if}

{#if siteDeploySummary && selectedSite?.id === siteDeploySummary.siteId}<SiteDeployDialog {language} {act} {busy} {confirmSiteDeploy} {siteDeployOpener} summary={siteDeploySummary} site={selectedSite} onclose={() => { siteDeploySummary = null; }} />{/if}
{#if cmsPrototypeCheck}<PrototypeCheckDialog {language} {act} {busy} {changeKindLabel} {cmsImportOpener} bind:cmsStructureChoice {conversionReportBody} {convertSiteToCms} {importCheckedPrototype} {prototypeCounts} {saveJsonFile} checked={cmsPrototypeCheck} onclose={() => { cmsPrototypeCheck = null; }} />{/if}
{#if cmsImportUpdate}<ImportUpdateDialog {language} {act} {busy} {cancelCmsImport} {cmsImportOpener} {cmsImportProgress} {importCmsArchive} pendingUpdate={cmsImportUpdate} onclose={() => { cmsImportUpdate = null; dropPendingProposal(); }} />{/if}
{#if cmsProposalCapture}{@const capture = cmsProposalCapture}<ProposalCaptureDialog {language} {busy} {cmsImportOpener} fileName={capture.file.name} url={capture.url} reasons={capture.reasons} onimport={(pages) => void act(() => importCapturedProposal(pages))} onplain={() => void act(convertProposalAsItIs)} onclose={closeProposalCapture} />{/if}
{#if cmsProposalPick}{@const pick = cmsProposalPick}<ProposalPickDialog {language} {busy} {cmsImportOpener} title={pick.title} groups={pick.groups} proposals={pick.proposals} onconvert={(id) => void act(() => convertProposalChoice(pick.file, id))} onclose={() => { cmsProposalPick = null; }} />{/if}
{#if cmsUnlink}<CmsUnlinkDialog {language} {act} {busy} {cmsUnlink} {tryCmsUnlink} onclose={() => { cmsUnlink = null; }} />{/if}

{#if firstSite}<FirstSiteDialog {language} {act} {busy} {finishFirstSite} bind:answers={firstSite} onclose={() => { firstSite = null; }} />{/if}

{#if styleSpread}<StyleSpreadDialog {language} {act} {applySpread} {busy} {cmsProjects} {previewSpread} bind:spread={styleSpread} onclose={() => { styleSpread = null; }} />{/if}

{#if showShortcuts}<ShortcutsDialog {language} onclose={() => { showShortcuts = false; }} />{/if}

{#if showCmsTrashConfirm && selectedCmsProject}<CmsTrashDialog {language} {act} {busy} bind:cmsTrashConnectionId {cmsTrashConnections} {cmsTrashSelection} {trashCmsSelection} onclose={() => { showCmsTrashConfirm = false; }} />{/if}

{#if showRollback && selectedSite}<SiteRollbackDialog {language} {act} {busy} {confirmRollback} {selectedSite} rollback={showRollback} onclose={() => { showRollback = null; }} />{/if}

{#if cmsFrontPageOffer}<FrontPageOffer {language} host={cmsFrontPageOffer.host} offer={cmsFrontPageOffer.offer} answer={answerCmsFrontPage} onclose={() => { cmsFrontPageOffer = null; }} />{/if}
{#if cmsRemoteRollback}<CmsRemoteRollbackDialog {language} {act} {busy} {cmsRemoteRollback} {confirmCmsRemoteRollback} onclose={() => { cmsRemoteRollback = null; }} />{/if}

{#if cmsRollback}<CmsRollbackDialog {language} {act} {busy} {cmsRollback} {confirmCmsRollback} onclose={() => { cmsRollback = null; }} />{/if}

{#if cmsSyncPlan}<CmsSyncDialog {language} {act} {applyCmsSyncPlan} {bringCmsEntities} {busy} {closeCmsSyncPlan} {cmsSyncChoices} {cmsSyncConnection} {cmsSyncPlan} {cmsSyncPlanReady} {pullCmsSite} {setCmsSyncChoice} />{/if}
