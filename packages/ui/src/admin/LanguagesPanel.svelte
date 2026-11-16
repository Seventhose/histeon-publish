<script lang="ts">
  import { api, downloadGet, uploadText } from "../lib/api.js";
  import { plural, translate, type Language } from "../lib/i18n.js";
  import { languageProgress, searchable, type AdminIndex, type AdminLanguage } from "../lib/admin-index.js";

  /** The languages of Lingua Bridge in a project (doc 20 §6): the list, the work of each language, its strings. */
  let { index, language, projectId, onChanged, onNotice, onBulk, onOpen }: {
    index: AdminIndex;
    language: Language;
    projectId: string;
    onChanged: () => void;
    onNotice: (text: string, failed?: boolean) => void;
    onBulk: (action: "translate" | "publish", ids: string[], language?: string) => Promise<boolean>;
    onOpen: (kind: string, id: string) => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const base = $derived(`/api/cms/v1/projects/${encodeURIComponent(projectId)}`);
  interface StringRow { sourceHash: string; source: string; context: string; translation: string; status: string }
  const COMMON = ["en", "it", "fr", "de", "es", "pt", "pt-BR", "nl", "pl", "ro", "el", "ru", "uk", "sr", "bg", "hr", "cs", "sv", "da", "fi", "nb", "tr", "ar", "he", "ja", "ko", "zh"];
  type Tab = "lingue" | "lavoro" | "stringhe" | "contesto";
  let tab = $state<Tab>("lingue");
  let newCode = $state("");
  let current = $state("");
  let onlyTodo = $state(true);
  let strings = $state<StringRow[]>([]);
  let stringSearch = $state("");
  let stringsTodo = $state(false);
  let brief = $state("");
  let picker = $state<HTMLInputElement | null>(null);

  const hasOthers = $derived(index.languages.languages.length > 0);
  const chosen = $derived(current || index.languages.languages[0]?.code || "");
  const progress = $derived(languageProgress(index));
  const nameOf = (code: string): string => {
    try { return new Intl.DisplayNames([code], { type: "language", languageDisplay: "standard" }).of(code) ?? code; } catch { return code; }
  };
  const offered = $derived(COMMON.filter((code) => code.toLowerCase() !== index.languages.defaultLanguage.code.toLowerCase().split("-")[0] && !index.languages.languages.some((item) => item.code === code)));
  const originals = $derived([
    ...[...index.pages, ...index.posts].filter((item) => item.locale === null).map((item) => ({ id: item.id, title: item.title, kind: item.kind as string })),
    ...index.records.filter((record) => record.locale === index.languages.defaultLanguage.code).map((record) => ({ id: record.id, title: record.title, kind: record.typeKey })),
  ]);
  const work = $derived(originals.map((item) => ({ ...item, version: index.translations.find((link) => link.sourceId === item.id && link.language === chosen) ?? null })));
  const shown = $derived((onlyTodo ? work.filter((row) => row.version?.state !== "published") : work).slice(0, 200));
  const missing = $derived(work.filter((row) => !row.version).map((row) => row.id));
  const draftVersions = $derived(work.filter((row) => row.version?.state === "draft").map((row) => row.version!.translationId));
  /** The whole site through the agent: it writes drafts, and they are read here before anything goes on the site. */
  async function askAgent(): Promise<void> {
    const label = index.languages.languages.find((entry) => entry.code === chosen)?.label ?? chosen;
    await navigator.clipboard.writeText(t("admin.lang.agentMessage", { language: label, code: chosen }));
    onNotice(t("admin.lang.agentCopied"));
  }
  const unlisted = $derived([...new Set(index.records.map((record) => record.locale))].filter((code) => code !== index.languages.defaultLanguage.code && !index.languages.languages.some((item) => item.code === code)));
  const shownStrings = $derived.by(() => {
    const query = searchable(stringSearch.trim());
    return strings.filter((row) => (!stringsTodo || row.status !== "published") && (!query || searchable(`${row.source} ${row.translation}`).includes(query))).slice(0, 300);
  });
  const stringsDone = $derived(strings.filter((row) => row.status === "published").length);
  /** What an agent wrote: a draft stays out of the site until someone approves it here. */
  const drafts = $derived(strings.filter((row) => row.status === "draft"));

  /** `done: null` when the caller says itself what happened. */
  async function report(run: () => Promise<void>, done: string | null = t("admin.saved")): Promise<boolean> {
    try {
      await run();
      if (done) onNotice(done);
      onChanged();
      return true;
    } catch (error) {
      onNotice(t("admin.reverted", { message: error instanceof Error ? error.message : "" }), true);
      onChanged();
      return false;
    }
  }
  const saveLanguages = (languages: AdminLanguage[]) => report(async () => {
    await api(`${base}/languages`, { method: "PUT", body: JSON.stringify({ languages }) });
  });
  async function add(code: string): Promise<void> {
    if (code.trim() && await saveLanguages([...index.languages.languages, { code: code.trim(), label: "" }])) newCode = "";
  }
  async function loadStrings(code: string): Promise<void> {
    strings = code ? (await api<{ strings: StringRow[] }>(`${base}/strings?language=${encodeURIComponent(code)}`)).strings : [];
  }
  $effect(() => { if (tab === "stringhe") void loadStrings(chosen).catch(() => undefined); });
  $effect(() => { void api<{ brief: string }>(`${base}/translation-brief`).then((answer) => { brief = answer.brief; }).catch(() => undefined); });
  const saveString = (row: StringRow, translation: string) => report(async () => {
    await api(`${base}/strings?language=${encodeURIComponent(chosen)}`, { method: "PUT", body: JSON.stringify({ strings: [{ source: row.source, translation, context: row.context }] }) });
    row.translation = translation;
    row.status = translation ? "published" : "missing";
  });
  const publishDrafts = () => report(async () => {
    await api(`${base}/strings?language=${encodeURIComponent(chosen)}`, { method: "PUT", body: JSON.stringify({ strings: drafts.map((row) => ({ source: row.source, translation: row.translation, context: row.context })) }) });
    await loadStrings(chosen);
  });
  const saveBrief = () => report(async () => {
    await api(`${base}/translation-brief`, { method: "PUT", body: JSON.stringify({ brief }) });
  });
  async function createAll(): Promise<void> {
    const ids = missing.slice(0, 500);
    if (await onBulk("translate", ids, chosen)) onNotice(plural(language, "admin.lang.created", ids.length));
  }
  async function importXliff(files: FileList | null): Promise<void> {
    const file = files?.[0];
    if (!file) return;
    let answer: { saved: number; left: number; skipped: Array<{ title: string; reason: string }> } | null = null;
    await report(async () => {
      answer = await uploadText<{ saved: number; left: number; skipped: Array<{ title: string; reason: string }> }>(`${base}/translations/xliff?language=${encodeURIComponent(chosen)}`, file);
    }, null);
    const done = answer as { saved: number; left: number; skipped: Array<{ title: string; reason: string }> } | null;
    if (done) onNotice(t("admin.xliff.done", { saved: done.saved, left: done.left, skipped: done.skipped.length }) + (done.skipped[0] ? ` ${done.skipped[0].title}: ${done.skipped[0].reason}` : ""), done.skipped.length > 0);
  }
</script>

{#snippet languagePicker()}
  <select class="admin-compact" value={chosen} aria-label={t("admin.lang.chooseLanguage")} onchange={(event) => { current = (event.currentTarget as HTMLSelectElement).value; }}>
    {#each index.languages.languages as item (item.code)}<option value={item.code}>{item.label}</option>{/each}
  </select>
{/snippet}

<div class="admin-panel-stack">
  {#if hasOthers}
    <div class="admin-segments admin-tabs" role="tablist" aria-label={t("admin.languages")}>
      {#each [["lingue", "admin.languages"], ["lavoro", "admin.lang.work"], ["stringhe", "admin.lang.stringsTab"], ["contesto", "admin.lang.briefTab"]] as const as [key, label] (key)}
        <button role="tab" aria-selected={tab === key} class:active={tab === key} onclick={() => { tab = key; }} data-testid="admin-lang-tab-{key}">{t(label)}</button>
      {/each}
    </div>
  {/if}
  {#if tab === "lingue" || !hasOthers}
    <section class="admin-block">
      <p class="muted">{t("admin.lang.intro")}</p>
      <ul class="admin-language-list">
        <li><span class="admin-code">/</span><strong>{index.languages.defaultLanguage.label}</strong><span class="admin-state published">{t("admin.lang.default")}</span></li>
        {#each index.languages.languages as item (item.code)}
          {@const line = progress.find((entry) => entry.code === item.code)}
          <li>
            <code class="admin-code">/{item.code.toLowerCase()}/</code>
            <input value={item.label} aria-label={t("admin.lang.name", { language: item.code })} maxlength="40" onchange={(event) => void saveLanguages(index.languages.languages.map((entry) => entry.code === item.code ? { ...entry, label: (event.currentTarget as HTMLInputElement).value } : entry))} />
            {#if line}<span class="admin-progress" role="progressbar" aria-valuenow={line.percent} aria-valuemin="0" aria-valuemax="100" aria-label={item.label}><span style:width="{line.percent}%"></span></span><span class="admin-date">{line.percent}%</span>{/if}
            <button class="admin-icon" aria-label={t("admin.lang.remove", { language: item.label })} title={t("admin.lang.remove", { language: item.label })} onclick={() => void saveLanguages(index.languages.languages.filter((entry) => entry.code !== item.code))}>×</button>
          </li>
        {/each}
      </ul>
      <form class="admin-new" onsubmit={(event) => { event.preventDefault(); void add(newCode); }}>
        <input list="admin-language-codes" bind:value={newCode} maxlength="35" placeholder={t("admin.lang.addLabel")} aria-label={t("admin.lang.addLabel")} data-testid="admin-language-code" />
        <datalist id="admin-language-codes">{#each offered as code (code)}<option value={code}>{nameOf(code)}</option>{/each}</datalist>
        <button class="button primary small" disabled={!newCode.trim()} data-testid="admin-language-add">{t("admin.lang.add")}</button>
      </form>
      {#if !hasOthers}
        <div class="admin-chips">{#each offered.slice(0, 6) as code (code)}<button class="button outline small" onclick={() => void add(code)}>＋ {nameOf(code)}</button>{/each}</div>
      {/if}
      {#if unlisted.length}<div class="admin-notice"><p>{t("admin.lang.unlisted", { list: unlisted.join(", ") })}</p></div>{/if}
    </section>
  {:else if tab === "lavoro"}
    <section class="admin-block">
      <div class="admin-toolbar">
        {@render languagePicker()}
        <label class="admin-check"><input type="checkbox" bind:checked={onlyTodo} /> {t("admin.lang.onlyTodo")}</label>
        <span class="admin-grow"></span>
        <button class="button outline small" onclick={() => void downloadGet(`${base}/translations/xliff?language=${encodeURIComponent(chosen)}`, `traduzione-${chosen}.xlf`).catch((error: unknown) => onNotice(error instanceof Error ? error.message : "", true))} data-testid="admin-xliff-export">{t("admin.xliff.export")}</button>
        <input class="visually-hidden" type="file" accept=".xlf,.xliff" tabindex="-1" aria-hidden="true" bind:this={picker} onchange={(event) => { void importXliff((event.currentTarget as HTMLInputElement).files); (event.currentTarget as HTMLInputElement).value = ""; }} />
        <button class="button outline small" onclick={() => picker?.click()}>{t("admin.xliff.import")}</button>
        {#if missing.length}<button class="button primary small" onclick={() => void createAll()}>{t("admin.lang.createAll", { n: missing.length })}</button>{/if}
        <button class="button outline small" onclick={() => void askAgent()} data-testid="admin-lang-agent">{t("admin.lang.askAgent")}</button>
        {#if draftVersions.length}<button class="button outline small" onclick={() => void onBulk("publish", draftVersions)} data-testid="admin-lang-publish-drafts">{t("admin.lang.publishDrafts", { n: draftVersions.length })}</button>{/if}
      </div>
      {#if shown.length}
        <ul class="admin-work">
          {#each shown as row (row.id)}
            <li><button class="admin-link" onclick={() => onOpen(row.kind, row.version?.translationId ?? row.id)}>{row.title}</button><span class="admin-state {row.version?.state ?? "missing"}">{t(`admin.state.${row.version?.state ?? "missing"}`)}</span></li>
          {/each}
        </ul>
      {:else}
        <div class="admin-empty"><p>{t("admin.lang.done")}</p></div>
      {/if}
    </section>
  {:else if tab === "stringhe"}
    <section class="admin-block">
      <p class="muted">{t("admin.lang.stringsIntro")}</p>
      <div class="admin-toolbar">
        {@render languagePicker()}
        <input class="admin-search-field" type="search" bind:value={stringSearch} placeholder={t("admin.lang.stringsSearch")} aria-label={t("admin.lang.stringsSearch")} />
        <label class="admin-check"><input type="checkbox" bind:checked={stringsTodo} /> {t("admin.lang.onlyTodo")}</label>
        <span class="admin-date">{stringsDone}/{strings.length}</span>
        {#if drafts.length}<button class="button primary small" onclick={() => void publishDrafts()} data-testid="admin-strings-publish">{t("admin.lang.publishDrafts", { n: drafts.length })}</button>{/if}
      </div>
      {#if shownStrings.length}
        <ul class="admin-strings">
          {#each shownStrings as row (row.sourceHash)}
            <li><span>{row.source}</span><span class="admin-string-state"><span class="admin-state {row.status}" title={t(`admin.state.${row.status}`)}><span class="visually-hidden">{t(`admin.state.${row.status}`)}</span></span><input value={row.translation} maxlength="4096" aria-label={t("admin.lang.stringLabel", { text: row.source })} onchange={(event) => void saveString(row, (event.currentTarget as HTMLInputElement).value)} /></span></li>
          {/each}
        </ul>
      {:else}
        <div class="admin-empty"><p>{t("admin.lang.stringsEmpty")}</p></div>
      {/if}
    </section>
  {:else}
    <section class="admin-block">
      <p class="muted">{t("admin.lang.briefHint")}</p>
      <textarea rows="10" maxlength="20000" bind:value={brief} aria-label={t("admin.lang.brief")}></textarea>
      <div class="admin-actions"><button class="button primary small" onclick={() => void saveBrief()}>{t("admin.lang.save")}</button></div>
    </section>
  {/if}
</div>
