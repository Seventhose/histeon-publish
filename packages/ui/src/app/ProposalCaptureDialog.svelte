<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";

  /** One page of the proposal as the frame sent it back: untrusted, the server reads it again. */
  export interface CapturedProposalPage { key: string; name: string; hash: string; title: string; html: string; notes: string[] }

  /**
   * «Fotografa la proposta»: a file drawn by its scripts, alive in a sealed frame. The person browses it as the client
   * would and adds the pages one by one; each is the page as drawn at that moment, without scripts. The frame comes
   * from an origin of its own (not the app's) with a policy of its own: it speaks to this dialog with two messages
   * and nothing else.
   */
  let { language, busy, cmsImportOpener, fileName, url, reasons, onimport, onplain, onclose }: {
    language: Language;
    busy: boolean;
    cmsImportOpener: HTMLElement | null;
    fileName: string;
    url: string;
    reasons: string[];
    onimport: (pages: CapturedProposalPage[]) => void;
    onplain: () => void;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);

  /** The proposal is drawn at this width, as on a desktop, and scaled to the room the dialog has. */
  const FRAME_WIDTH = 1280;
  const MAX_PAGES = 20;
  /** The pages travel in one request of at most 128 MiB: stop a little before. */
  const MAX_CHARACTERS = 110 * 1024 * 1024;
  const ANSWER_TIMEOUT_MS = 45_000;

  let frame = $state<HTMLIFrameElement | null>(null);
  let stage = $state<HTMLDivElement | null>(null);
  let scale = $state(1);
  let stageHeight = $state(560);
  let ready = $state(false);
  let capturing = $state(false);
  let pages = $state<CapturedProposalPage[]>([]);
  let status = $state("");
  let problem = $state("");
  let rootSelector = $state("");
  let removeSelectors = $state("");
  let waiting: { id: string; done: (value: unknown) => void } | null = null;

  $effect(() => {
    const element = stage;
    if (!element) return;
    const measure = (): void => {
      scale = Math.min(1, element.clientWidth / FRAME_WIDTH);
      stageHeight = Math.max(320, Math.round(window.innerHeight * 0.56));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  });

  $effect(() => {
    const listen = (event: MessageEvent): void => {
      // Only the frame of this dialog is heard; what it says is data, never trusted.
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown; id?: unknown; value?: unknown } | null;
      if (typeof data !== "object" || data === null) return;
      if (data.type === "histos-capture-ready") ready = true;
      if (data.type === "histos-captured" && waiting && data.id === waiting.id) waiting.done(data.value);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  });

  /** A name for the page, as the server's capturedPageName proposes it: the last part of the fragment, else the title. */
  function proposedName(hash: string, title: string, index: number): string {
    if (index === 0) return "Home";
    const parts = hash.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && !/^\d+$/u.test(last)) {
      const words = last.replace(/[-_]+/gu, " ").trim();
      if (words) return `${words.charAt(0).toUpperCase()}${words.slice(1)}`.slice(0, 80);
    }
    return (title.replace(/\s+/gu, " ").trim() || t("capture.pageN", { n: index + 1 })).slice(0, 80);
  }

  const text = (value: unknown, limit: number): string => (typeof value === "string" ? value.slice(0, limit) : "");

  async function addPage(): Promise<void> {
    const target = frame?.contentWindow;
    if (!target || capturing || busy || pages.length >= MAX_PAGES) return;
    capturing = true;
    problem = "";
    status = t("capture.working");
    const id = crypto.randomUUID();
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), ANSWER_TIMEOUT_MS);
        waiting = { id, done: (answer) => { clearTimeout(timer); resolve(answer); } };
        const remove = removeSelectors.split(",").map((selector) => selector.trim()).filter(Boolean).slice(0, 20);
        // The message carries no secret: «*» spares telling the frame's origin apart from the address it was given.
        target.postMessage({ type: "histos-capture", id, ...(rootSelector.trim() ? { rootSelector: rootSelector.trim().slice(0, 300) } : {}), ...(remove.length ? { remove } : {}) }, "*");
      });
      const result = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
      if (result.error === "root-missing") throw new Error(t("capture.rootMissing"));
      if (result.error === "too-large") throw new Error(t("capture.tooLarge"));
      if (typeof result.html !== "string" || result.html.trim() === "") throw new Error(t("capture.failed"));
      const html = result.html;
      if (pages.reduce((sum, page) => sum + page.html.length, 0) + html.length > MAX_CHARACTERS) throw new Error(t("capture.tooLarge"));
      const hash = text(result.hash, 500);
      const title = text(result.title, 300);
      const notes = Array.isArray(result.notes) ? result.notes.slice(0, 20).map((note) => text(note, 300)).filter(Boolean) : [];
      const name = proposedName(hash, title, pages.length);
      pages = [...pages, { key: id, name, hash, title, html, notes }];
      status = t("capture.added", { name, kb: Math.max(1, Math.round(html.length / 1024)) });
    } catch (error) {
      status = "";
      problem = error instanceof Error && error.message !== "timeout" ? error.message : t("capture.noAnswer");
    } finally {
      waiting = null;
      capturing = false;
    }
  }

  function removePage(key: string): void {
    const gone = pages.find((page) => page.key === key);
    pages = pages.filter((page) => page.key !== key);
    if (gone) status = t("capture.removed", { name: gone.name });
  }

  function moveUp(index: number): void {
    if (index < 1) return;
    const next = [...pages];
    const [page] = next.splice(index, 1);
    if (!page) return;
    next.splice(index - 1, 0, page);
    pages = next;
    status = t("capture.moved", { name: page.name, n: index });
  }

  function rename(key: string, name: string): void {
    pages = pages.map((page) => (page.key === key ? { ...page, name: name.slice(0, 80) } : page));
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal-card capture-card" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy, returnFocus: cmsImportOpener }} aria-labelledby="cms-proposal-capture-title" tabindex="-1" data-testid="cms-proposal-capture">
    <button class="modal-close" aria-label={t("common.close")} onclick={() => { if (!busy) onclose(); }}>×</button>
    <div class="eyebrow">HISTOS CMS</div>
    <h2 id="cms-proposal-capture-title">{t("capture.title")}</h2>
    <p>{t("capture.intro", { file: fileName })}{#if reasons.length} <span class="capture-why">{t("capture.why", { reasons: reasons.join("; ") })}</span>{/if}</p>
    <div class="capture-body">
      <div class="capture-stage" bind:this={stage} style:height={`${stageHeight}px`}>
        <!-- The proposal's scripts run here and only here. allow-same-origin gives the page the origin it is served
             from, the capture port, never the app's: a viewer needs it to write into its own inner frame. -->
        <iframe bind:this={frame} src={url} sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" title={t("capture.frameTitle")} data-testid="cms-proposal-capture-frame" style:width={`${FRAME_WIDTH}px`} style:height={`${Math.round(stageHeight / scale)}px`} style:transform={`scale(${scale})`}></iframe>
      </div>
      <div class="capture-side">
        <button class="button dark" data-testid="cms-proposal-capture-add" disabled={busy || capturing || !ready || pages.length >= MAX_PAGES} onclick={() => void addPage()}>{capturing ? t("capture.working") : t("capture.add")}</button>
        <p class="capture-hint">{ready ? t("capture.hint") : t("capture.loading")}</p>
        <p class="capture-status" role="status" aria-live="polite" data-testid="cms-proposal-capture-status">{status}</p>
        {#if problem}<p class="capture-problem" role="alert" data-testid="cms-proposal-capture-problem">{problem}</p>{/if}
        <h3>{t("capture.pages", { n: pages.length })}</h3>
        {#if pages.length === 0}
          <p class="capture-hint">{t("capture.empty")}</p>
        {:else}
          <ol class="capture-pages" data-testid="cms-proposal-capture-pages">
            {#each pages as page, index (page.key)}
              <li>
                <label>
                  <span class="capture-label">{index === 0 ? t("capture.homePage") : t("capture.pageN", { n: index + 1 })}{#if page.hash}{" · "}<code>{page.hash.slice(0, 40)}</code>{/if}</span>
                  <input type="text" value={page.name} maxlength="80" disabled={busy} oninput={(event) => rename(page.key, event.currentTarget.value)} />
                </label>
                {#each page.notes as note}<small>{note}</small>{/each}
                <span class="capture-row">
                  {#if index > 0}<button class="button outline small" disabled={busy} onclick={() => moveUp(index)} aria-label={t("capture.moveUpLabel", { name: page.name })}>{t("capture.moveUp")}</button>{/if}
                  <button class="button outline small" disabled={busy} onclick={() => removePage(page.key)} aria-label={t("capture.removeLabel", { name: page.name })}>{t("capture.remove")}</button>
                </span>
              </li>
            {/each}
          </ol>
        {/if}
        <details class="capture-options">
          <summary>{t("capture.options")}</summary>
          <label><span class="capture-label">{t("capture.rootSelector")}</span><input type="text" bind:value={rootSelector} maxlength="300" placeholder="#proposta" disabled={busy} data-testid="cms-proposal-capture-root" /></label>
          <label><span class="capture-label">{t("capture.removeSelectors")}</span><input type="text" bind:value={removeSelectors} maxlength="800" placeholder=".barra-visore, #scelta" disabled={busy} /></label>
        </details>
      </div>
    </div>
    <div class="modal-actions">
      <button class="button outline" disabled={busy} onclick={() => { if (!busy) onclose(); }}>{t("common.cancel")}</button>
      <button class="button outline" data-testid="cms-proposal-capture-plain" disabled={busy || capturing} onclick={() => onplain()}>{t("capture.plain")}</button>
      <button class="button dark" data-testid="cms-proposal-capture-import" disabled={busy || capturing || pages.length === 0} onclick={() => onimport(pages)}>{t("capture.import", { n: pages.length })} →</button>
    </div>
  </div>
</div>

<style>
  .capture-card { width: min(1500px, 100%); max-height: calc(100dvh - 24px); overflow-y: auto; }
  .capture-why { display: block; margin-top: 4px; font-size: 14px; }
  .capture-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 300px); gap: 16px; margin: 14px 0 6px; }
  .capture-stage { overflow: hidden; min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
  .capture-stage iframe { display: block; border: 0; background: #fff; transform-origin: 0 0; }
  .capture-side { display: grid; align-content: start; gap: 8px; min-width: 0; }
  .capture-side h3 { margin: 8px 0 0; font-size: 15px; }
  .capture-hint { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
  .capture-status { min-height: 1.5em; margin: 0; font-size: 14px; line-height: 1.5; }
  .capture-problem { margin: 0; color: var(--danger, #b3261e); font-size: 14px; line-height: 1.5; }
  .capture-pages { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .capture-pages li { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; }
  .capture-pages small { color: var(--muted); font-size: 13px; line-height: 1.4; }
  .capture-label { display: block; margin-bottom: 3px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .capture-row { display: flex; gap: 6px; justify-content: flex-end; }
  .capture-side input[type="text"] { width: 100%; }
  .capture-options { font-size: 14px; }
  .capture-options summary { cursor: pointer; }
  .capture-options label { display: block; margin-top: 8px; }
  @media (max-width: 860px) {
    .capture-body { grid-template-columns: 1fr; }
  }
</style>
