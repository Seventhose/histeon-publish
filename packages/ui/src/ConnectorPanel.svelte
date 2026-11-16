<script module lang="ts">
  import { connectorApi, previewCmsBuild, previewPrototype, type ConnectorActivityEntry, type ConnectorSnapshot } from "./lib/api.js";

  const POLL_MS = 2000;
  /** After a failed poll (app busy, session gone) the next one waits longer. */
  const RETRY_MS = 10_000;
  /** While the window is hidden the state is still read, more slowly, so a WordPress request does not expire unseen. */
  const HIDDEN_POLL_MS = 15_000;
  /** Same as the server's in-memory log. */
  const KEPT = 200;

  interface Listener { announce: (entries: ConnectorActivityEntry[]) => void }

  /** Successes the user hears about at once: they add or change what the CMS catalog shows. */
  function announced(entry: ConnectorActivityEntry): boolean {
    if (entry.outcome !== "ok") return false;
    if (entry.operation === "importPrototype" || entry.operation === "build") return true;
    return entry.operation === "wordpressPush" && entry.facts?.state === "applied";
  }

  /**
   * One poller for every place the connector shows up (top-bar chip, approval banner, settings section). The
   * instances share this state; polling runs while at least one of them is mounted, the connector is on and the page
   * is visible, and stops otherwise. A poll asks only for the log entries after the last one seen.
   */
  class ConnectorState {
    snapshot = $state.raw<ConnectorSnapshot | null>(null);
    /** Newest first, merged from the `after=<seq>` answers. */
    activity = $state.raw<ConnectorActivityEntry[]>([]);
    /** The clock for "seen in the last 5 minutes" and the approval countdown. */
    now = $state(Date.now());
    failure = $state("");
    /** The prototype the user wants the agent to import: kept while moving between screens. */
    prototypePath = $state("");
    private lastSeq = 0;
    /** The first answer is history: only entries that arrive after it are announced. */
    private primed = false;
    /** Bumped by "Svuota registro", so an answer already on its way does not bring the cleared entries back. */
    private epoch = 0;
    private mounted = 0;
    private listeners: Listener[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private ticker: ReturnType<typeof setInterval> | undefined;
    private chain: Promise<void> = Promise.resolve();
    private queued = 0;

    private readonly onVisibility = (): void => {
      if (document.visibilityState === "visible" && this.snapshot?.enabled) void this.refresh();
      else this.schedule();
    };

    attach(listener: Listener): () => void {
      this.listeners.push(listener);
      this.mounted += 1;
      if (this.mounted === 1) document.addEventListener("visibilitychange", this.onVisibility);
      void this.refresh();
      return () => {
        this.listeners = this.listeners.filter((item) => item !== listener);
        this.mounted -= 1;
        if (this.mounted === 0) document.removeEventListener("visibilitychange", this.onVisibility);
        this.schedule();
      };
    }

    /**
     * One load at a time and at most one waiting behind it: a request made while a load runs is answered by the
     * waiting load, which starts after the user's action and so sees its effect (an enable, a stop, a decision).
     */
    refresh(): Promise<void> {
      if (this.queued > 1) return this.chain;
      this.queued += 1;
      this.chain = this.chain
        .then(() => this.load())
        .catch((error: unknown) => {
          // load() handles the network; this is a listener that threw. The chain must stay usable.
          this.failure = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          this.queued -= 1;
          this.schedule();
        });
      return this.chain;
    }

    clearActivity(): void {
      this.epoch += 1;
      this.activity = [];
    }

    private async load(): Promise<void> {
      const after = this.lastSeq;
      const epoch = this.epoch;
      let next: ConnectorSnapshot;
      try {
        next = await connectorApi.snapshot(after);
      } catch (error) {
        this.failure = error instanceof Error ? error.message : String(error);
        return;
      }
      this.failure = "";
      this.now = Date.now();
      this.snapshot = next;
      if (next.lastSeq < after) {
        // A new app process numbers its log from 1 again: read it from the start.
        this.lastSeq = 0;
        this.activity = [];
        this.primed = false;
        await this.load();
        return;
      }
      this.lastSeq = next.lastSeq;
      if (epoch !== this.epoch) return;
      const fresh = next.activity.filter((entry) => entry.seq > after);
      if (fresh.length > 0) this.activity = [...fresh].reverse().concat(this.activity).slice(0, KEPT);
      const news = this.primed ? fresh.filter(announced) : [];
      this.primed = true;
      if (news.length > 0) this.listeners[0]?.announce(news);
    }

    private schedule(): void {
      clearTimeout(this.timer);
      this.timer = undefined;
      const watching = this.mounted > 0 && document.visibilityState === "visible";
      if (this.mounted > 0 && this.snapshot?.enabled) this.timer = setTimeout(() => void this.refresh(), this.failure ? RETRY_MS : watching ? POLL_MS : HIDDEN_POLL_MS);
      const counting = watching && (this.snapshot?.pending.length ?? 0) > 0;
      if (counting && this.ticker === undefined) {
        this.ticker = setInterval(() => {
          this.now = Date.now();
        }, 1000);
      } else if (!counting && this.ticker !== undefined) {
        clearInterval(this.ticker);
        this.ticker = undefined;
      }
    }
  }

  const connector = new ConnectorState();
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import type { ConnectorPushView } from "./lib/api.js";
  import { plural, translate, type Language } from "./lib/i18n.js";

  type CommandTab = "claudeCode" | "codex" | "claudeDesktop" | "chatgptDesktop" | "generic" | "cli";
  const TABS: CommandTab[] = ["claudeCode", "codex", "claudeDesktop", "chatgptDesktop", "generic", "cli"];
  const TAB_COMMANDS: Record<CommandTab, string[]> = { claudeCode: ["claudeCode"], codex: ["codex", "codexToml"], claudeDesktop: ["claudeDesktop"], chatgptDesktop: ["chatgptChat", "chatgptDesktop", "chatgptToml"], generic: ["generic"], cli: ["cli"] };
  const IMPORT_COUNTS = ["pages", "posts", "templates", "parts", "components", "types", "records", "taxonomies", "terms", "media"];
  /** Failures that are part of the normal correction loop: amber "to fix", not a red error (E5). */
  const FIX_CODES = new Set(["cms-prototype-invalid", "connector-file-invalid", "connector-file-not-prototype", "cms-sync-conflict", "cms-transfer-invalid"]);
  const WAIT_CODES = new Set(["cms-prototype-update-requires-flag", "connector-wordpress-off"]);
  const PUSH_COUNTS = ["new", "update", "delete"];
  const SEEN_MS = 5 * 60_000;

  /**
   * `view` picks where this instance sits: "chip" next to the top bar's local pill, "dot" in the sidebar's "Agente AI"
   * item (the same state as the chip, as a colour only: the chip carries the words), "banner" at the end of the main
   * area, fixed to the bottom of the window on every screen (WordPress sends waiting for the user), "section" on the
   * "Agente AI" screen. They all read the same state.
   */
  let { view, language, onNotice, onError, onProjectsChanged, onOpen, onOpenProject, onOpenReport, onOpenSite, onPendingChange }: {
    view: "chip" | "dot" | "banner" | "section";
    language: Language;
    /** `fromAgent` marks what the agent did (the toast says «✦ Agente»); the user's own actions here are not. */
    onNotice?: (message: string, action?: { label: string; projectId?: string }, fromAgent?: boolean) => void;
    onError?: (message: string) => void;
    /** A new import, build or send: the app reloads its CMS catalog. */
    onProjectsChanged?: () => void;
    /** The chip was clicked: the app shows the "Agente AI" screen. */
    onOpen?: () => void;
    onOpenProject?: (projectId: string) => void;
    /** "Vedi rapporto" on an import: the project opens with its import report (D1). */
    onOpenReport?: (projectId: string) => void;
    /** «Cambia nel sito»: the project opens on its «Siti collegati», where the agent's permission is chosen. */
    onOpenSite?: (projectId: string) => void;
    /** How many requests wait for the user: the app puts "(n) Conferma invio" in the tab title. */
    onPendingChange?: (count: number) => void;
  } = $props();

  let busy = $state(false);
  let autoStartChoice = $state(false);
  let tab = $state<CommandTab>("claudeCode");
  let approvalsHeight = $state(0);

  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const locale = $derived(language === "it" ? "it-IT" : "en-US");
  const snapshot = $derived(connector.snapshot);
  const activity = $derived(connector.activity);
  const operations = $derived(snapshot?.since ? activity.filter((entry) => entry.at >= (snapshot.since as string)).length : 0);
  const chip = $derived.by(() => {
    if (!snapshot?.enabled) return null;
    const lastSeen = snapshot.clients[0] ? Date.parse(snapshot.clients[0].lastSeen) : 0;
    const tone = snapshot.pending.length > 0 ? "pending" : connector.now - lastSeen < SEEN_MS ? "seen" : "idle";
    const running = snapshot.running.length > 0;
    const state = tone === "pending" ? "pending" : running ? "running" : tone;
    const label = t(state === "pending" ? "connector.chipPending" : state === "running" ? "connector.chipRunning" : state === "seen" ? "connector.chipSeen" : "connector.chipIdle");
    return { tone, running, state, label };
  });
  const statusLine = $derived.by(() => {
    if (!snapshot?.enabled) return "";
    const agent = snapshot.clients[0];
    return [
      snapshot.since ? t("connector.since", { time: clock(snapshot.since) }) : t("connector.title"),
      agent ? t("connector.lastAgent", { name: agent.name }) : t("connector.noAgent"),
      count(operations, "operations"),
    ].join(" · ");
  });

  /** The guided connection (E10): open at first for whoever never connected an agent, then as the user leaves it. */
  let guideOpen = $state<boolean | null>(null);
  $effect(() => {
    if (guideOpen === null && snapshot) guideOpen = !snapshot.connectedBefore;
  });
  const nodeStep = $derived.by(() => {
    const node = snapshot?.node;
    if (!node) return { state: "waiting", text: t("connector.node.searching") };
    if (node.supported) return { state: "done", text: t("connector.node.found", { version: node.version ?? "", path: node.path ?? "node" }) };
    return { state: "warning", text: node.version ? t("connector.node.old", { version: node.version }) : t("connector.node.missing") };
  });
  const agentStep = $derived.by(() => {
    const agent = snapshot?.clients[0];
    if (agent) return { state: "done", text: t("connector.agent.connected", { name: agent.name }) };
    if (snapshot?.connectedBefore) return { state: "done", text: t("connector.agent.before") };
    return { state: "waiting", text: t("connector.agent.waiting") };
  });
  /** The desktop app opens a file dialog that gives the absolute path; a browser cannot, so there the path is typed. */
  const canChoose = typeof window.histosDesktop?.choosePrototypeFile === "function";
  const firstMessage = $derived(connector.prototypePath.trim() ? t("connector.firstMessageFor", { path: connector.prototypePath.trim() }) : t("connector.firstMessageText"));

  onMount(() => connector.attach({ announce }));

  // A request waiting for the user shows in the tab title and is announced at once (E8).
  let announcement = $state("");
  let announcedRequests = new Set<string>();
  $effect(() => {
    if (view !== "banner") return;
    const pending = snapshot?.pending ?? [];
    // The app owns the title (E12) and adds "(n) Conferma invio" from this count.
    onPendingChange?.(pending.length);
    const fresh = pending.find((request) => !announcedRequests.has(request.requestId));
    announcedRequests = new Set(pending.map((request) => request.requestId));
    if (fresh) announcement = t("connector.announce", { client: fresh.client, project: fresh.project.name, host: fresh.host });
  });

  // The app's notices stack above the approval banner instead of covering it (E11).
  $effect(() => {
    if (view !== "banner") return;
    const offset = (snapshot?.pending.length ?? 0) > 0 ? approvalsHeight + 12 : 0;
    document.documentElement.style.setProperty("--hp-approvals-offset", `${offset}px`);
    return () => document.documentElement.style.removeProperty("--hp-approvals-offset");
  });

  function announce(entries: ConnectorActivityEntry[]): void {
    const last = entries[entries.length - 1];
    if (!last) return;
    const project = last.project?.name ?? "";
    const open = last.project?.id ? { label: t("connector.openProject"), projectId: last.project.id } : undefined;
    if (last.operation === "importPrototype") onNotice?.(t(last.facts?.result === "aggiornato" ? "connector.toast.importUpdated" : "connector.toast.import", { project }), open, true);
    else if (last.operation === "build") onNotice?.(t("connector.toast.build", { project }), open, true);
    else onNotice?.(t("connector.toast.push", { host: host(last) }), undefined, true);
    onProjectsChanged?.();
  }

  // ---------------------------------------------------------------------------------------------- formatting

  function count(value: number, key: string): string {
    return plural(language, `count.${key}`, value);
  }

  /** A known label, or the raw value when the server sends something this UI does not know yet. */
  function label(key: string, fallback: string): string {
    const text = t(key);
    return text === key ? fallback : text;
  }

  function clock(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    const today = date.toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat(locale, today ? { hour: "2-digit", minute: "2-digit" } : { dateStyle: "short", timeStyle: "short" }).format(date);
  }

  function entryTime(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    const today = date.toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat(locale, today ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { dateStyle: "short", timeStyle: "medium" }).format(date);
  }

  function duration(milliseconds: number): string {
    if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
    const seconds = milliseconds / 1000;
    if (seconds < 60) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(seconds)} s`;
    return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
  }

  function bytes(value: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size)} ${units[unit]}`;
  }

  function countdown(expiresAt: string): string {
    const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - connector.now) / 1000));
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  }

  function fact(entry: ConnectorActivityEntry, key: string): number {
    const value = entry.facts?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  function host(entry: ConnectorActivityEntry): string {
    const value = entry.facts?.host;
    return typeof value === "string" && value ? value : t("connector.someSite");
  }

  function counts(entry: ConnectorActivityEntry, keys: string[]): string {
    return keys.filter((key) => fact(entry, key) > 0).slice(0, 4).map((key) => count(fact(entry, key), key)).join(", ");
  }

  function withCounts(sentence: string, list: string): string {
    return list ? `${sentence}: ${list}` : sentence;
  }

  /** A readable sentence from the entry's fields only (operation, outcome, facts, project, file). */
  function describe(entry: ConnectorActivityEntry): string {
    const project = entry.project?.name ?? "—";
    const file = entry.file?.name ?? "—";
    const state = entry.facts?.state;
    if (entry.operation === "wordpressPush" && typeof state === "string") {
      const values = { host: host(entry) };
      if (state === "dry-run") return withCounts(t("connector.say.pushDryRun", values), counts(entry, PUSH_COUNTS));
      if (state === "pending") return withCounts(t("connector.say.pushPending", values), counts(entry, PUSH_COUNTS));
      if (state === "applying") return withCounts(t("connector.say.pushApplying", values), counts(entry, PUSH_COUNTS));
      if (state === "applied") return withCounts(t("connector.say.pushApplied", values), counts(entry, PUSH_COUNTS));
      if (state === "rejected") return t("connector.say.pushRejected", values);
      if (state === "expired") return t("connector.say.pushExpired", values);
      if (state === "not-applicable") return t("connector.say.pushConflicts", values);
      return t("connector.say.pushFailed", values);
    }
    if (entry.operation === "importPrototype" && typeof state === "string" && state !== "applied") {
      // An update the agent asked for (D2): waiting, refused, expired or failed after the user's approval.
      return withCounts(t(`connector.say.import.${state === "pending" || state === "rejected" || state === "expired" ? state : "failed"}`, { project, file }), state === "pending" ? counts(entry, PUSH_COUNTS) : "");
    }
    if (entry.outcome === "error") {
      const failed = label(`connector.fail.${entry.operation}`, t("connector.fail.other", { operation: entry.operation }));
      return entry.project ? `${failed} · «${project}»` : entry.file ? `${failed} · ${file}` : failed;
    }
    switch (entry.operation) {
      case "checkPrototype": {
        if (entry.facts?.valid !== true) return t(entry.facts?.outcome === "refused-duplicate" ? "connector.say.checkDuplicate" : "connector.say.checkInvalid", { file, project });
        return t(entry.facts?.outcome === "update" ? "connector.say.checkUpdate" : "connector.say.checkCreate", { file, project });
      }
      case "importPrototype":
        if (entry.facts?.result === "aggiornato") {
          const changes = [count(fact(entry, "changed"), "changed")];
          if (fact(entry, "keptLocal") > 0) changes.push(count(fact(entry, "keptLocal"), "kept"));
          return withCounts(t("connector.say.importUpdated", { project }), changes.join(", "));
        }
        {
          const created = withCounts(t("connector.say.importCreated", { project }), IMPORT_COUNTS.filter((key) => fact(entry, key) > 0).map((key) => count(fact(entry, key), key)).join(", "));
          return fact(entry, "ignored") > 0 ? `${created} · ${t("connector.say.ignored", { n: fact(entry, "ignored") })}` : created;
        }
      case "build": {
        const status = String(entry.facts?.status ?? "");
        const draft = entry.facts?.draft === true;
        const sentence = status === "ready"
          ? t(draft ? "connector.say.draftReady" : "connector.say.buildReady", { project })
          : status === "blocked"
            ? t(draft ? "connector.say.draftBlocked" : "connector.say.buildBlocked", { project })
            : t("connector.say.buildOther", { project, status });
        const findings = fact(entry, "findings");
        return findings > 0 ? `${sentence}, ${count(findings, "findings")}` : sentence;
      }
      case "exportXbsite":
        return t("connector.say.export", { project, file });
      default:
        return label(`connector.op.${entry.operation}`, entry.operation);
    }
  }

  /** A send or update the agent asked for and the user still has to decide is shown as waiting, not as done. */
  function outcome(entry: ConnectorActivityEntry): "ok" | "error" | "pending" | "fix" {
    if ((entry.operation === "wordpressPush" || entry.operation === "importPrototype") && entry.facts?.state === "pending") return "pending";
    if (entry.outcome === "error" && entry.code && FIX_CODES.has(entry.code)) return "fix";
    if (entry.outcome === "error" && entry.code && WAIT_CODES.has(entry.code)) return "pending";
    if (entry.operation === "checkPrototype" && entry.outcome === "ok" && entry.facts?.valid !== true) return "fix";
    return entry.outcome;
  }

  /** Why it failed, in words: a sentence for known codes, else the server's cleaned message. */
  function reason(entry: ConnectorActivityEntry): string {
    if (entry.outcome !== "error") return "";
    const known = entry.code ? label(`connector.code.${entry.code}`, "") : "";
    if (known && entry.message) return `${known} ${entry.message}`;
    return known || entry.message || "";
  }

  async function openBuildPreview(entry: ConnectorActivityEntry): Promise<void> {
    const projectId = entry.project?.id;
    // A checked prototype's throwaway preview (A2) or a registered build.
    const prototypeBuild = entry.operation === "checkPrototype" ? entry.facts?.previewBuildId : undefined;
    const buildId = entry.facts?.buildId;
    const address = typeof prototypeBuild === "string" ? () => previewPrototype(prototypeBuild) : projectId && typeof buildId === "string" ? () => previewCmsBuild(projectId, buildId) : null;
    if (!address) return;
    // Opened at once and filled after the request, so the browser does not treat it as an unrequested popup; the new
    // tab loses its link to this page. The desktop app refuses the blank window and opens the address in the browser.
    const opened = window.open("", "_blank");
    if (opened) opened.opener = null;
    try {
      const url = await address();
      if (opened) opened.location.href = url;
      else window.open(url, "_blank", "noreferrer");
    } catch (error) {
      opened?.close();
      onError?.(error instanceof Error ? error.message : t("connector.previewUnavailable"));
    }
  }

  function canPreview(entry: ConnectorActivityEntry): boolean {
    if (entry.operation === "checkPrototype") return entry.outcome === "ok" && typeof entry.facts?.previewBuildId === "string";
    return entry.operation === "build" && entry.outcome === "ok" && entry.facts?.status === "ready" && entry.facts?.draft !== true && typeof entry.facts?.buildId === "string" && Boolean(entry.project?.id);
  }

  /** The project an entry can open: one that exists (not a check that would create it, not a failure). */
  function openable(entry: ConnectorActivityEntry): string | null {
    if (!onOpenProject || !entry.project?.id || entry.outcome === "error") return null;
    if (entry.operation === "checkPrototype" && entry.facts?.outcome !== "update") return null;
    return entry.project.id;
  }

  /** The approval sentence in pieces, so host and project are bold while every value stays plain text. */
  function approvalParts(request: ConnectorPushView): Array<{ text: string; strong: boolean }> {
    const values: Record<string, string> = {
      client: request.client,
      host: request.host,
      project: request.project.name,
      file: request.file?.name ?? "",
      // Only what happens: no "0 conflicts" (a send with conflicts is never offered for approval).
      counts: ["new", "update", "delete", ...(request.kind === "import" ? ["kept"] : [])].filter((key) => (request.counts[key] ?? 0) > 0).map((key) => count(request.counts[key] ?? 0, key)).join(", ") || t("connector.approvalNothing"),
    };
    return t(request.kind === "import" ? "connector.importApprovalText" : "connector.approvalText").split(/(\{[a-z]+\})/u).filter((part) => part !== "").map((part) => {
      const name = /^\{([a-z]+)\}$/u.exec(part)?.[1];
      const value = name === undefined ? undefined : values[name];
      return value === undefined ? { text: part, strong: false } : { text: value, strong: name === "host" || name === "project" || name === "file" };
    });
  }

  // ---------------------------------------------------------------------------------------------- actions

  /** Runs one user action: its notice or error goes to the app's toasts, then the state is read again. */
  async function run(task: () => Promise<string | undefined>): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const notice = await task();
      if (notice) onNotice?.(notice);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : t("connector.unavailable"));
    } finally {
      busy = false;
      await connector.refresh();
    }
  }

  function enable(): void {
    void run(async () => {
      await connectorApi.update({ enabled: true, autoStart: autoStartChoice });
      return t("connector.enabledNotice");
    });
  }

  function stop(): void {
    void run(async () => {
      await connectorApi.update({ enabled: false });
      autoStartChoice = false;
      return t("connector.stoppedNotice");
    });
  }

  function interrupt(): void {
    void run(async () => (await connectorApi.interrupt()).interrupted > 0 ? t("connector.interrupted") : t("connector.nothingRunning"));
  }

  function setAutoStart(input: HTMLInputElement): void {
    const value = input.checked;
    void run(async () => {
      await connectorApi.update({ autoStart: value });
      return undefined;
    }).then(() => {
      // A refused change leaves the box as the server has it.
      input.checked = connector.snapshot?.autoStart ?? false;
    });
  }

  let seenRemovals = $state(new Set<string>());
  function markSeen(requestId: string, seen: boolean): void {
    const next = new Set(seenRemovals);
    if (seen) next.add(requestId);
    else next.delete(requestId);
    seenRemovals = next;
  }

  function decide(request: ConnectorPushView, decision: "approve" | "reject"): void {
    const update = request.kind === "import";
    void run(async () => {
      await connectorApi.decide(request.requestId, decision);
      return t(decision === "approve" ? (update ? "connector.importApprovedNotice" : "connector.approvedNotice") : (update ? "connector.importRejectedNotice" : "connector.rejectedNotice"));
    });
  }

  function clearActivity(): void {
    void run(async () => {
      await connectorApi.clearActivity();
      connector.clearActivity();
      return t("connector.activityCleared");
    });
  }

  function downloadManual(): void {
    void run(async () => {
      await connectorApi.downloadManual();
      return undefined;
    });
  }

  function copyManual(): void {
    void run(async () => {
      const text = await connectorApi.manualText();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        throw new Error(t("connector.copyFailed"));
      }
      return t("connector.manualCopied");
    });
  }

  /**
   * The server's commands, plus a message for ChatGPT's chat: the agent registers the server itself when it can run
   * commands, and otherwise works through the connector's CLI (the same operations, one command each). In the app's
   * language, with this computer's paths.
   */
  const shownCommands = $derived.by((): Record<string, string> => {
    const commands = (snapshot?.commands ?? {}) as Record<string, string>;
    if (typeof commands.chatgptToml !== "string" || typeof commands.cli !== "string") return commands;
    return { ...commands, chatgptChat: t("connector.chatMessage", { toml: commands.chatgptToml.trim(), cli: commands.cli }) };
  });

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      onNotice?.(t("connector.copied"));
    } catch {
      onError?.(t("connector.copyFailed"));
    }
  }

  async function choosePrototype(): Promise<void> {
    try {
      const chosen = await window.histosDesktop?.choosePrototypeFile?.();
      if (chosen) connector.prototypePath = chosen;
    } catch {
      onError?.(t("connector.chooseFailed"));
    }
  }

  function tabKeydown(event: KeyboardEvent): void {
    const index = TABS.indexOf(tab);
    const next = event.key === "ArrowRight" ? TABS[(index + 1) % TABS.length] : event.key === "ArrowLeft" ? TABS[(index + TABS.length - 1) % TABS.length] : event.key === "Home" ? TABS[0] : event.key === "End" ? TABS[TABS.length - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    tab = next;
    document.getElementById(`connector-tab-${next}`)?.focus();
  }
</script>

{#if view === "chip"}
  {#if chip}
    <button type="button" class="connector-chip {chip.tone}" class:running={chip.running} data-testid="connector-chip" data-state={chip.state} title={chip.label} aria-label={chip.label} onclick={() => onOpen?.()}><span class="connector-chip-mark" aria-hidden="true">✦</span>AI{#if chip.state === "pending"} · {t("connector.chipToConfirm", { n: snapshot?.pending.length ?? 0 })}{/if}</button>
  {/if}
{:else if view === "dot"}
  {#if chip}<span class="connector-nav-dot {chip.tone}" data-testid="connector-nav-dot" data-state={chip.state} aria-hidden="true"></span>{/if}
{:else if view === "banner"}
  <div class="visually-hidden" aria-live="assertive" aria-atomic="true">{announcement}</div>
  {#if snapshot && snapshot.pending.length > 0}
    <!-- The banner is fixed to the bottom of the window, clear of the top-right toasts; this keeps as much room at
         the end of the page so it never covers the last controls of a screen. -->
    <div class="connector-approvals-space" style:height="{approvalsHeight + 24}px" aria-hidden="true"></div>
    <div class="connector-approvals" bind:clientHeight={approvalsHeight}>
      {#each snapshot.pending as request (request.requestId)}
        {@const removals = request.counts.delete ?? 0}
        {@const update = request.kind === "import"}
        <section class="connector-approval" data-testid="connector-approval" data-request-id={request.requestId} aria-labelledby="connector-approval-{request.requestId}">
          <span class="connector-approval-mark" aria-hidden="true">✦</span>
          <div class="connector-approval-body">
            <strong id="connector-approval-{request.requestId}">{t(update ? "connector.importApprovalTitle" : "connector.approvalTitle")}</strong>
            <p>{#each approvalParts(request) as part, index (index)}{#if part.strong}<strong>{part.text}</strong>{:else}{part.text}{/if}{/each}</p>
            <p class="connector-approval-note">{t(update ? "connector.importApprovalNote" : request.replacesMedia ? "connector.approvalNoteMedia" : "connector.approvalNote")}</p>
            {#if request.replacesMedia}<p class="connector-approval-warning">{t("connector.approvalMedia")}</p>{/if}
            {#if (request.counts.delete ?? 0) > 0}<p class="connector-approval-warning">{t(update ? "connector.importApprovalDeletes" : "connector.approvalDeletes")}</p>{/if}
            {#if request.entities.length > 0}
              <details>
                <summary>{t("connector.approvalDetails")}</summary>
                <ul>
                  {#each request.entities as entity, index (index)}<li><span class="connector-entity-status {entity.status}">{label(`connector.status.${entity.status}`, entity.status)}</span> {entity.label} <small>{label(`connector.kind.${entity.kind}`, entity.kind)}</small></li>{/each}
                </ul>
                {#if request.omitted > 0}<button type="button" class="button text small" onclick={() => onOpenProject?.(request.project.id)}>{t("connector.approvalSeeAll", { n: request.omitted })}</button>{/if}
              </details>
            {/if}
          </div>
          {#if removals > 0}
            <!-- Removals on WordPress are approved only after the list was looked at (E8). -->
            <label class="connector-approval-seen"><input type="checkbox" data-testid="connector-approval-seen" checked={seenRemovals.has(request.requestId)} onchange={(event) => markSeen(request.requestId, event.currentTarget.checked)} />{t(removals === 1 ? "connector.approvalSeenOne" : "connector.approvalSeen", { n: removals })}</label>
          {/if}
          <div class="connector-approval-actions">
            <span class="connector-countdown" aria-live="off">{t("connector.approvalExpires", { time: countdown(request.expiresAt) })}</span>
            <button type="button" class="button outline small" data-testid="connector-reject" disabled={busy} onclick={() => decide(request, "reject")}>{t("connector.reject")}</button>
            <button type="button" class="button primary small" data-testid="connector-approve" disabled={busy || Date.parse(request.expiresAt) <= connector.now || (removals > 0 && !seenRemovals.has(request.requestId))} onclick={() => decide(request, "approve")}>{t(request.kind === "import" ? "connector.importApprove" : "connector.approve")}</button>
          </div>
        </section>
      {/each}
    </div>
  {/if}
{:else}
  <div class="connector-page" id="connector-section" data-testid="connector-section" data-enabled={snapshot?.enabled ? "true" : "false"}>
    <section class="panel-card connector-card" aria-labelledby="connector-title">
      <div class="section-card-header"><h2 id="connector-title" class="connector-card-title">{t("connector.title")}</h2><span class="connector-mark" class:on={snapshot?.enabled} aria-hidden="true">✦</span></div>
      {#if !snapshot}
        {#if connector.failure}
          <p class="connector-failure" role="alert">{t("connector.unavailable")} {connector.failure} <button type="button" class="button text small" onclick={() => void connector.refresh()}>{t("connector.retry")}</button></p>
        {:else}
          <p class="muted">{t("common.loading")}</p>
        {/if}
      {:else if !snapshot.enabled}
        <p class="connector-intro">{t("connector.offIntro")}</p>
        <label class="connector-check"><input type="checkbox" data-testid="connector-autostart" bind:checked={autoStartChoice} disabled={busy} /> {t("connector.autoStart")}</label>
        <div class="connector-actions"><button type="button" class="button primary" data-testid="connector-enable" disabled={busy} onclick={enable}>{t("connector.enable")}</button></div>
      {:else}
        <div class="connector-status">
          <span class="status-light on" aria-hidden="true"></span>
          <p data-testid="connector-status">{statusLine}</p>
          <div class="connector-status-actions">
            {#if snapshot.running.length > 0}<button type="button" class="button outline small" data-testid="connector-interrupt" disabled={busy} onclick={interrupt}>{t("connector.interrupt")}</button>{/if}
            <button type="button" class="button outline small" data-testid="connector-stop" disabled={busy} onclick={stop}>{t("connector.stop")}</button>
          </div>
        </div>
        {#each snapshot.running as item, index (index)}
          <p class="connector-running"><span class="connector-running-dot" aria-hidden="true"></span>{t("connector.runningNow", { operation: label(`connector.op.${item.operation}`, item.operation), client: item.client })}</p>
        {/each}
        <label class="connector-check"><input type="checkbox" data-testid="connector-autostart" checked={snapshot.autoStart} disabled={busy} onchange={(event) => setAutoStart(event.currentTarget)} /> {t("connector.autoStart")}</label>

        <details class="connector-guide" data-testid="connector-guide" open={guideOpen ?? !snapshot.connectedBefore} ontoggle={(event) => guideOpen = event.currentTarget.open}>
          <summary><span class="connector-guide-title">{t("connector.connectTitle")}</span><span class="connector-guide-state" data-state={agentStep.state}>{t(agentStep.state === "done" ? "connector.guideDone" : "connector.guideTodo")}</span></summary>
          <ol class="connector-steps">
            <li class="connector-step" data-testid="connector-step-node" data-state={nodeStep.state}>
              <span class="connector-step-mark" aria-hidden="true">{nodeStep.state === "done" ? "✓" : nodeStep.state === "warning" ? "!" : "1"}</span>
              <div class="connector-step-body"><strong>{t("connector.step.node")}</strong><p>{nodeStep.text}</p></div>
            </li>
            <li class="connector-step" data-testid="connector-step-command">
              <span class="connector-step-mark" aria-hidden="true">2</span>
              <div class="connector-step-body">
                <strong>{t("connector.step.command")}</strong>
                <div class="connector-tabs" role="tablist" aria-label={t("connector.step.command")}>
                  {#each TABS as key (key)}
                    <button type="button" role="tab" id="connector-tab-{key}" aria-selected={tab === key} aria-controls="connector-commands" tabindex={tab === key ? 0 : -1} class:active={tab === key} onclick={() => tab = key} onkeydown={tabKeydown}>{t(`connector.tab.${key}`)}</button>
                  {/each}
                </div>
                <div class="connector-commands" id="connector-commands" role="tabpanel" aria-labelledby="connector-tab-{tab}" data-testid="connector-commands" data-tab={tab}>
                  {#each TAB_COMMANDS[tab].filter((key) => typeof shownCommands[key] === "string" && shownCommands[key] !== "") as key (key)}
                    <p class="connector-hint">{t(`connector.hint.${key}`)}</p>
                    <div class="connector-command">
                      <pre data-command={key}><code>{shownCommands[key]}</code></pre>
                      <button type="button" class="button outline small" onclick={() => void copy(shownCommands[key] ?? "")}>{t("connector.copy")}</button>
                    </div>
                  {/each}
                  <p class="connector-note">{t("connector.noSecrets")}</p>
                </div>
              </div>
            </li>
            <li class="connector-step" data-testid="connector-step-agent" data-state={agentStep.state}>
              <span class="connector-step-mark" aria-hidden="true">{agentStep.state === "done" ? "✓" : "3"}</span>
              <div class="connector-step-body"><strong>{t("connector.step.agent")}</strong><p aria-live="polite">{#if agentStep.state === "waiting"}<span class="connector-running-dot" aria-hidden="true"></span>{/if}{agentStep.text}</p></div>
            </li>
          </ol>
        </details>

        <h3 class="connector-subtitle">{t("connector.askTitle")}</h3>
        <p class="connector-hint">{t("connector.askHint")}</p>
        <label class="connector-field-label" for="connector-prototype-path">{t("connector.prototypePath")}</label>
        <div class="connector-ask-row">
          <input id="connector-prototype-path" data-testid="connector-prototype-path" bind:value={connector.prototypePath} maxlength="1024" autocomplete="off" spellcheck="false" placeholder={t("connector.prototypePathPlaceholder")} />
          {#if canChoose}<button type="button" class="button outline small" data-testid="connector-choose-prototype" onclick={() => void choosePrototype()}>{t("connector.choosePrototype")}</button>{/if}
        </div>
        <div class="connector-first">
          <span>{t("connector.firstMessage")}</span>
          <q data-testid="connector-first-message">{firstMessage}</q>
          <button type="button" class="button text small" onclick={() => void copy(firstMessage)}>{t("connector.copy")}</button>
        </div>
        <p class="connector-note">{t("connector.remoteImages")}</p>
      {/if}
      {#if snapshot}
        <div class="connector-actions">
          <button type="button" class="button outline small" data-testid="connector-manual" disabled={busy} onclick={downloadManual}>{t("connector.manual")}</button>
          <button type="button" class="button text small" disabled={busy} onclick={copyManual}>{t("connector.copyManual")}</button>
        </div>
      {/if}
    </section>

    {#if snapshot && (snapshot.enabled || activity.length > 0 || snapshot.rejected > 0)}
      <section class="panel-card connector-card" aria-labelledby="connector-activity-title">
        <div class="connector-activity-head">
          <h2 id="connector-activity-title" class="connector-card-title">{t("connector.activityTitle")}</h2>
          {#if activity.length > 0}<button type="button" class="button text small" data-testid="connector-clear-activity" disabled={busy} onclick={clearActivity}>{t("connector.clearActivity")}</button>{/if}
        </div>
        {#if snapshot.rejected > 0}
          <div class="connector-rejected" data-testid="connector-rejected"><strong>{t("connector.rejected", { n: snapshot.rejected })}</strong><p>{t("connector.rejectedHint")}</p></div>
        {/if}
        <ol class="connector-activity" data-testid="connector-activity">
          {#each activity as entry (entry.seq)}
            {@const result = outcome(entry)}
            {@const projectId = openable(entry)}
            <li class="connector-entry" data-seq={entry.seq} data-operation={entry.operation} data-outcome={result}>
              <time datetime={entry.at}>{entryTime(entry.at)}</time>
              <div class="connector-entry-body">
                <p>{describe(entry)}</p>
                {#if reason(entry)}<p class="connector-entry-reason">{reason(entry)}</p>{/if}
                <div class="connector-entry-meta">
                  <span class="connector-outcome {result}">{t(`connector.outcome.${result}`)}</span>
                  {#if entry.file}<span>{entry.file.name}</span>{/if}
                  <details class="connector-entry-details">
                    <summary>{t("connector.details")}</summary>
                    {#if entry.code}<code>{entry.code}</code>{/if}
                    <span>{entry.client}</span>
                    {#if entry.durationMs > 0}<span>{duration(entry.durationMs)}</span>{/if}
                    {#if entry.file}<span>{bytes(entry.file.bytes)} · sha256 {entry.file.sha256}…</span>{/if}
                  </details>
                </div>
              </div>
              <div class="connector-entry-actions">
                {#if canPreview(entry)}<button type="button" class="button text small" onclick={() => void openBuildPreview(entry)}>{t("connector.openPreview")}</button>{/if}
                {#if projectId && onOpenReport && entry.operation === "importPrototype"}<button type="button" class="button text small" onclick={() => onOpenReport?.(projectId)}>{t("connector.openReport")}</button>
                {:else if projectId}<button type="button" class="button text small" onclick={() => onOpenProject?.(projectId)}>{t("connector.openProject")}</button>{/if}
              </div>
            </li>
          {:else}
            <li class="connector-empty">{t("connector.activityEmpty")}</li>
          {/each}
        </ol>
      </section>
    {/if}

    {#if snapshot?.enabled}
      <section class="panel-card connector-card" aria-labelledby="connector-wordpress-title">
        <h2 id="connector-wordpress-title" class="connector-card-title">{t("connector.wordpressTitle")}</h2>
        <p class="connector-hint">{t("connector.wordpressHint")}</p>
        <div class="connector-sites">
          {#each snapshot.wordpress as site (site.connectionId)}
            <div class="connector-site">
              <div class="connector-site-heading">
                <div><strong>{site.host}</strong><small>{site.projectName}</small></div>
                <span class="connector-site-mode" data-testid="connector-wordpress-mode" data-connection-id={site.connectionId}>{t(`connector.mode.${site.mode}`)}</span>
                {#if site.projectId}<button type="button" class="button outline small" data-testid="connector-wordpress-open" onclick={() => onOpenSite?.(site.projectId!)}>{t("connector.siteModeOpen")}</button>{/if}
              </div>
              {#if !site.canWrite}<p class="connector-note">{t("connector.readOnly")}</p>{/if}
              {#if site.mode === "auto"}<p class="connector-warning" role="note">{t("connector.autoWarning")}</p>{/if}
            </div>
          {:else}
            <p class="connector-note">{t("connector.wordpressNone")}</p>
          {/each}
        </div>
        {#if snapshot.wordpress.length}<p class="connector-note">{t("connector.siteModeWhere")}</p>{/if}

        <h3 class="connector-subtitle">{t("connector.exportsTitle")}</h3>
        <p class="connector-hint">{t("connector.exports")}</p>
        <code class="path-display connector-path">{snapshot.exportDirectory}</code>
      </section>
    {/if}

  </div>
{/if}

<style>
  .connector-chip { display: inline-flex; min-height: 32px; align-items: center; gap: 6px; padding: 0 11px; border: 1px solid #e6dfd4; border-radius: 30px; background: #fbf8f3; color: #65657b; font: inherit; font-size: 14px; font-weight: 700; cursor: pointer; }
  .connector-chip:hover { border-color: #d6cdc0; color: var(--ink); }
  .connector-chip.seen { border-color: #b9dcc7; background: var(--mint); color: var(--mint-ink); }
  .connector-chip.pending { border-color: #e8b47a; background: #fff0de; color: #8a4f12; }
  .connector-chip-mark { display: inline-block; }
  .connector-nav-dot { width: 8px; height: 8px; flex: 0 0 auto; margin-left: auto; border-radius: 50%; background: #8b8792; }
  .connector-nav-dot.seen { background: #3fae74; }
  .connector-nav-dot.pending { background: #e8913a; }
  .connector-chip.running .connector-chip-mark { animation: connector-pulse 1.1s ease-in-out infinite; }
  @keyframes connector-pulse { 50% { opacity: .3; transform: scale(.75); } }

  /* Fixed above the page and below toasts (25) and modals (40); left follows the sidebar width of style.css. */
  .connector-approvals { position: fixed; z-index: 20; right: 28px; bottom: 18px; left: 276px; display: grid; max-height: 70vh; gap: 10px; overflow: auto; }
  .connector-approval { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border: 1px solid #e8b47a; border-radius: 10px; background: #fff7ec; color: #4d3517; box-shadow: var(--shadow); }
  .connector-approval-mark { display: grid; width: 26px; height: 26px; flex: 0 0 auto; place-items: center; border-radius: 50%; background: #ffe2bf; color: #8a4f12; font-weight: 800; }
  .connector-approval-body { min-width: 0; flex: 1; overflow-wrap: anywhere; }
  .connector-approval-seen { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 650; }
  .connector-approval-seen input { width: 17px; height: 17px; min-height: 0; accent-color: var(--coral); }
  .connector-approval-body > strong { display: block; margin-bottom: 4px; font-size: 14px; }
  .connector-approval-body p { margin: 0 0 4px; font-size: 14px; line-height: 1.5; }
  .connector-approval-note { color: #7a6043; }
  .connector-approval-warning { color: var(--danger); font-weight: 650; }
  .connector-approval details { margin-top: 6px; font-size: 14px; }
  .connector-approval summary { cursor: pointer; font-weight: 650; }
  .connector-approval ul { display: grid; gap: 3px; max-height: 220px; margin: 8px 0 4px; padding: 0 0 0 4px; overflow: auto; list-style: none; }
  .connector-approval small { color: #8a7358; }
  .connector-entity-status { display: inline-block; min-width: 82px; color: #7a6043; font-size: 13px; font-weight: 700; }
  .connector-entity-status.delete, .connector-entity-status.conflict { color: var(--danger); }
  .connector-approval-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
  .connector-countdown { color: #7a6043; font-size: 13px; font-variant-numeric: tabular-nums; }

  .connector-page { display: grid; gap: 18px; }
  .connector-card-title { margin: 0; color: var(--ink); font-size: 18px; }
  .connector-guide { margin-top: 18px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel); }
  .connector-guide > summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px; cursor: pointer; font-weight: 700; }
  .connector-guide-title { color: var(--ink); font-size: 15px; }
  .connector-guide-state { padding: 1px 8px; border-radius: 10px; background: #fff0de; color: #8a4f12; font-size: 12px; }
  .connector-guide-state[data-state="done"] { background: var(--mint); color: var(--mint-ink); }
  .connector-steps { display: grid; gap: 14px; margin: 0; padding: 4px 14px 16px; list-style: none; }
  .connector-step { display: flex; align-items: flex-start; gap: 12px; }
  .connector-step-mark { display: grid; width: 26px; height: 26px; flex: 0 0 auto; place-items: center; border-radius: 50%; background: var(--panel-soft); color: var(--muted); font-size: 13px; font-weight: 800; }
  .connector-step[data-state="done"] .connector-step-mark { background: var(--mint); color: var(--mint-ink); }
  .connector-step[data-state="warning"] .connector-step-mark { background: #fff0de; color: #8a4f12; }
  .connector-step-body { min-width: 0; flex: 1; }
  .connector-step-body > strong { display: block; margin-top: 3px; color: var(--ink); font-size: 14px; }
  .connector-step-body > p { display: flex; align-items: center; gap: 8px; margin: 4px 0 0; color: var(--muted); font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
  .connector-field-label { display: block; margin-top: 10px; color: var(--label); font-size: 13px; font-weight: 700; }
  .connector-ask-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .connector-ask-row input { min-width: 0; flex: 1 1 260px; }
  .connector-mark { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 9px; background: #f3eee8; color: #8b8792; font-size: 17px; }
  .connector-mark.on { background: var(--mint); color: var(--mint-ink); }
  .connector-intro { max-width: 760px; margin: 14px 0 0; color: var(--muted); font-size: 14px; line-height: 1.65; }
  .connector-check { display: flex; align-items: center; gap: 8px; margin: 14px 0 0; color: var(--ink); font-size: 14px; cursor: pointer; }
  .connector-check input { width: 17px; height: 17px; min-height: 0; margin: 0; accent-color: var(--coral); }
  .connector-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; }
  .connector-failure { margin: 14px 0 0; color: var(--danger); font-size: 14px; }
  .connector-status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 14px; padding: 11px 13px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-soft); }
  .connector-status p { min-width: 0; flex: 1; margin: 0; color: var(--ink); font-size: 14px; overflow-wrap: anywhere; }
  .connector-status-actions { display: flex; gap: 8px; }
  .connector-running { display: flex; align-items: center; gap: 8px; margin: 8px 0 0; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
  .connector-running-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--coral); animation: connector-pulse 1.1s ease-in-out infinite; }
  .connector-subtitle { margin: 22px 0 6px; color: var(--ink); font-size: 15px; }
  .connector-hint { margin: 6px 0 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
  .connector-note { margin: 8px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
  .connector-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; padding: 4px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel-soft); }
  .connector-tabs button { min-height: 34px; padding: 4px 11px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--muted); font: inherit; font-size: 13px; font-weight: 650; cursor: pointer; }
  .connector-tabs button.active { border-color: var(--line); background: var(--panel); color: var(--ink); box-shadow: 0 1px 2px rgb(23 32 51 / 5%); }
  .connector-commands { margin-top: 4px; }
  .connector-command { display: flex; align-items: flex-start; gap: 8px; margin-top: 8px; }
  .connector-command pre { min-width: 0; flex: 1; margin: 0; padding: 10px 12px; overflow-x: auto; border: 1px solid var(--line); border-radius: 7px; background: var(--panel-soft); color: var(--ink); font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .connector-first { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; font-size: 14px; }
  .connector-first span { color: var(--muted); font-weight: 650; }
  .connector-first q { color: var(--ink); }
  .connector-sites { display: grid; gap: 8px; margin-top: 8px; }
  .connector-site { padding: 11px 13px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .connector-site-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
  .connector-site-heading > div { display: grid; min-width: 0; gap: 2px; overflow-wrap: anywhere; }
  .connector-site-heading strong { font-size: 14px; }
  .connector-site-heading small { color: var(--muted); font-size: 13px; }
  .connector-site-heading > .connector-site-mode { margin-left: auto; color: var(--muted); font-size: 13px; font-weight: 700; }
  .connector-warning { margin: 9px 0 0; padding: 9px 11px; border-radius: 6px; background: #fff4e8; color: #845923; font-size: 13px; line-height: 1.55; }
  .connector-path { margin-top: 8px; overflow-wrap: anywhere; }
  .connector-rejected { margin-top: 16px; padding: 10px 12px; border: 1px solid #e8c59a; border-radius: 7px; background: #fff8ed; color: #6e4b1f; font-size: 14px; }
  .connector-rejected p { margin: 4px 0 0; font-size: 13px; line-height: 1.5; }
  .connector-activity-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .connector-activity { display: grid; gap: 0; margin: 4px 0 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .connector-entry { display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px; border-top: 1px solid var(--line); }
  .connector-entry:first-child { border-top: 0; }
  .connector-entry time { flex: 0 0 auto; min-width: 64px; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .connector-entry-body { min-width: 0; flex: 1; }
  .connector-entry-body p { margin: 0; color: var(--ink); font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
  .connector-entry-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 3px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .connector-entry-meta code { font-size: 12px; }
  .connector-entry-reason { margin-top: 2px !important; color: var(--muted) !important; font-size: 13px !important; }
  .connector-entry-details { display: inline; }
  .connector-entry-details summary { display: inline; cursor: pointer; }
  .connector-entry-details[open] { display: flex; flex-basis: 100%; flex-wrap: wrap; gap: 4px 10px; }
  .connector-entry-actions { display: flex; flex: 0 0 auto; flex-direction: column; align-items: flex-end; gap: 4px; }
  .connector-outcome.fix { background: #fff0de; color: #8a4f12; }
  .connector-outcome { padding: 1px 7px; border-radius: 10px; background: var(--mint); color: var(--mint-ink); font-weight: 700; }
  .connector-outcome.error { background: #fdeceb; color: var(--danger); }
  .connector-outcome.pending { background: #fff0de; color: #8a4f12; }
  .connector-empty { padding: 12px; color: var(--muted); font-size: 14px; }

  @media (max-width: 1180px) {
    .connector-approvals { left: 243px; }
  }
  @media (max-width: 900px) {
    .connector-approvals { right: 12px; bottom: 12px; left: 12px; }
    .connector-approval { flex-wrap: wrap; }
    .connector-approval-actions { width: 100%; justify-content: flex-start; }
  }
  @media (max-width: 620px) {
    .connector-command { flex-direction: column; }
    .connector-entry { flex-wrap: wrap; }
    .connector-entry-body { flex-basis: 100%; }
    .connector-entry-actions { flex-direction: row; align-items: center; }
    .connector-steps { padding: 4px 10px 14px; }
    .connector-step { gap: 9px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .connector-chip.running .connector-chip-mark, .connector-running-dot { animation: none; }
    .connector-chip.running { outline: 2px solid var(--coral); outline-offset: 1px; }
  }
  @media (prefers-color-scheme: dark) {
    .connector-chip { border-color: #333548; background: var(--panel); color: #ccc9d3; }
    .connector-chip.seen { border-color: #3e6550; background: var(--mint); color: var(--mint-ink); }
    .connector-chip.pending, .connector-approval-mark, .connector-outcome.pending { border-color: #8a5a2b; background: #3a2a1a; color: #f4c48e; }
    .connector-approval { border-color: #8a5a2b; background: #2b2219; color: #f1dcc3; }
    .connector-approval-note, .connector-countdown, .connector-entity-status, .connector-approval small { color: #d2b48f; }
    .connector-mark { background: #2b2d3f; color: #aaa8b8; }
    .connector-warning, .connector-rejected { border-color: #6b5140; background: #302821; color: #f0c99a; }
    .connector-outcome.error { background: #3a2222; color: #f2a9a5; }
    .connector-outcome.fix, .connector-guide-state, .connector-step[data-state="warning"] .connector-step-mark { background: #3a2a1a; color: #f4c48e; }
  }
</style>
