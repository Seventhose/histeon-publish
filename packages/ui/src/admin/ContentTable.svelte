<script lang="ts">
  import { api } from "../lib/api.js";
  import { tick } from "svelte";
  import { plural, translate, type Language } from "../lib/i18n.js";
  import { filterDocuments, sortDocuments, tableWindow, versionsBySource, type AdminDocument, type AdminIndex, type AdminSort } from "../lib/admin-index.js";
  import ContentDetail from "./ContentDetail.svelte";
  import LanguagePills from "./LanguagePills.svelte";

  /** Pages or posts as a table (doc 21 §5): filters, selection, keyboard, and the detail beside the row. */
  let { index, kind, language, projectId, onChanged, onNotice, onOpenBuilder, onOpenArticle, onWriteAsText, onPreview, onCreate, onBulk, onTrash, initial = "" }: {
    index: AdminIndex;
    kind: "page" | "post";
    language: Language;
    projectId: string;
    onChanged: () => void;
    onNotice: (text: string, failed?: boolean) => void;
    onOpenBuilder: (alias: number) => void;
    /** Articles open in their editor, not in the panel beside the row. */
    onOpenArticle?: ((alias: number) => void) | undefined;
    onWriteAsText?: ((alias: number) => void) | undefined;
    onPreview: (alias: number) => void;
    onCreate: (kind: "page" | "post", title: string) => Promise<string | null>;
    onBulk: (action: "publish" | "draft" | "translate" | "term", ids: string[], language?: string, extra?: Record<string, string>) => Promise<boolean>;
    onTrash: (ids: string[]) => Promise<void>;
    /** A content to open at once (from the search, the dashboard or a work list). */
    initial?: string;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const ROW = 52;
  let search = $state("");
  let status = $state("");
  let filterLanguage = $state("");
  let filterTerm = $state("");
  /** Articles can be seen as a wall of covers, kept for next time. */
  // svelte-ignore state_referenced_locally
  let wall = $state(kind === "post" && storedWall());
  function storedWall(): boolean {
    try { return localStorage.getItem("histos-posts-wall") === "on"; } catch { return false; }
  }
  function setWall(on: boolean): void {
    wall = on;
    try { localStorage.setItem("histos-posts-wall", on ? "on" : "off"); } catch { /* It is only a preference. */ }
  }
  /** Categories and tags of the articles: asked for once, when their table opens. */
  let postTerms = $state<{ taxonomies: Array<{ key: string; label: string; terms: Array<{ id: string; label: string }> }>; posts: Record<string, Record<string, string[]>>; covers: Record<string, string> } | null>(null);
  $effect(() => {
    if (kind === "post") void api<NonNullable<typeof postTerms>>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/admin/post-terms`).then((answer) => { postTerms = answer; }).catch(() => undefined);
  });
  let sortKey = $state<AdminSort>("updatedAt");
  let sortDirection = $state<1 | -1>(-1);
  let selected = $state<string[]>([]);
  let openId = $state("");
  let cursor = $state(0);
  let scrollTop = $state(0);
  let viewport = $state(600);
  let body = $state<HTMLDivElement | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);
  let creating = $state(false);
  let newTitle = $state("");
  let saving = $state(false);

  const items = $derived(kind === "page" ? index.pages : index.posts);
  $effect(() => {
    if (!initial) return;
    openId = initial;
    // A translation lives outside the site's language: its row must be on screen to move from it.
    if (items.find((item) => item.id === initial)?.locale) filterLanguage = "*";
  });

  const versions = $derived(versionsBySource(index.translations));
  const statusCounts = $derived({ all: filterDocuments(items, { search, status: "", language: filterLanguage }).length, published: filterDocuments(items, { search, status: "published", language: filterLanguage }).length, draft: filterDocuments(items, { search, status: "draft", language: filterLanguage }).length });
  const rows = $derived(sortDocuments(filterDocuments(items, { search, status, language: filterLanguage }).filter((item) => !filterTerm || Object.values(postTerms?.posts[item.id] ?? {}).some((ids) => ids.includes(filterTerm))), sortKey, sortDirection));
  const visible = $derived(tableWindow(rows.length, scrollTop, viewport, ROW));
  const open = $derived(items.find((item) => item.id === openId) ?? null);
  const filtered = $derived(search !== "" || status !== "" || filterLanguage !== "" || filterTerm !== "");
  const relative = $derived(new Intl.RelativeTimeFormat(language === "it" ? "it-IT" : "en-GB", { numeric: "auto" }));
  const fullDate = $derived(new Intl.DateTimeFormat(language === "it" ? "it-IT" : "en-GB", { dateStyle: "long", timeStyle: "short" }));
  const hasLanguages = $derived(index.languages.languages.length > 0);

  /** «2 ore fa», «ieri»: what a list needs; the exact date is its tooltip. */
  function ago(value: string): string {
    const minutes = Math.round((new Date(value).getTime() - Date.now()) / 60_000);
    if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
    if (Math.abs(minutes) < 1440) return relative.format(Math.round(minutes / 60), "hour");
    if (Math.abs(minutes) < 43_200) return relative.format(Math.round(minutes / 1440), "day");
    return relative.format(Math.round(minutes / 43_200), "month");
  }
  function sortBy(key: AdminSort): void {
    if (sortKey === key) sortDirection = sortDirection === 1 ? -1 : 1;
    else { sortKey = key; sortDirection = key === "updatedAt" ? -1 : 1; }
  }
  function toggle(id: string, checked: boolean): void {
    selected = checked ? [...selected, id] : selected.filter((item) => item !== id);
  }
  function allChecked(event: Event): void {
    selected = (event.currentTarget as HTMLInputElement).checked ? rows.slice(0, 500).map((row) => row.id) : [];
  }
  function clearFilters(): void {
    search = "";
    status = "";
    filterLanguage = "";
    filterTerm = "";
  }
  function openRow(row: AdminDocument): void {
    if (onOpenArticle && row.kind === "post") onOpenArticle(row.alias);
    else openId = row.id;
  }
  function moveCursor(step: number): void {
    cursor = Math.min(rows.length - 1, Math.max(0, cursor + step));
    if (!body) return;
    const top = cursor * ROW;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + ROW > body.scrollTop + body.clientHeight) body.scrollTop = top + ROW - body.clientHeight;
  }
  function keydown(event: KeyboardEvent): void {
    if ((event.target as HTMLElement).closest("input, select, textarea, button")) return;
    const row: AdminDocument | undefined = rows[cursor];
    if (event.key === "j" || event.key === "ArrowDown") { event.preventDefault(); moveCursor(1); }
    else if (event.key === "k" || event.key === "ArrowUp") { event.preventDefault(); moveCursor(-1); }
    else if (event.key === "Enter" && row) { event.preventDefault(); openRow(row); }
    else if (event.key === "e" && row) { event.preventDefault(); onOpenBuilder(row.alias); }
    else if (event.key === "x" && row) { event.preventDefault(); toggle(row.id, !selected.includes(row.id)); }
  }
  /** «/» goes to the search from anywhere in the section, as in most lists. */
  function windowKeydown(event: KeyboardEvent): void {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest("input, select, textarea, [contenteditable], dialog, [role=dialog]")) return;
    event.preventDefault();
    searchInput?.focus();
  }
  function step(direction: number): void {
    const place = rows.findIndex((row) => row.id === openId);
    const next = rows[place + direction];
    if (next) { openId = next.id; cursor = place + direction; }
  }
  async function bulk(action: "publish" | "draft" | "translate", code?: string): Promise<void> {
    if (await onBulk(action, selected, code)) selected = [];
  }
  async function addTerm(taxonomy: string, term: string): Promise<void> {
    if (await onBulk("term", selected, undefined, { taxonomy, term })) {
      selected = [];
      postTerms = await api<NonNullable<typeof postTerms>>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/admin/post-terms`);
    }
  }
  async function startCreate(): Promise<void> {
    creating = true;
    await tick();
    document.getElementById("admin-new-title")?.focus();
  }
  async function create(event: Event): Promise<void> {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title || saving) return;
    saving = true;
    const id = await onCreate(kind, title);
    saving = false;
    if (id) {
      newTitle = "";
      creating = false;
      clearFilters();
      await tick();
      const created = onOpenArticle ? index.posts.find((post) => post.id === id) : undefined;
      if (created) onOpenArticle?.(created.alias);
      else openId = id;
    }
  }
</script>

<svelte:window onkeydown={windowKeydown} />

<div class="admin-split" class:has-detail={open}>
  <div class="admin-list">
    <div class="admin-toolbar">
      <div class="admin-segments" role="group" aria-label={t("admin.table.status")}>
        {#each [["", "admin.table.allStatus", statusCounts.all], ["published", "admin.state.published", statusCounts.published], ["draft", "admin.state.draft", statusCounts.draft]] as const as [value, label, count] (value)}
          <button class:active={status === value} aria-pressed={status === value} onclick={() => { status = value; }}>{t(label)} <span>{count}</span></button>
        {/each}
      </div>
      <input class="admin-search-field" type="search" bind:this={searchInput} bind:value={search} placeholder={t("admin.table.searchLabel")} aria-label={t("admin.table.searchLabel")} aria-keyshortcuts="/" data-testid="admin-table-search" />
      {#if postTerms?.taxonomies.some((taxonomy) => taxonomy.terms.length)}
        <select class="admin-compact" bind:value={filterTerm} aria-label={t("admin.table.terms")} data-testid="admin-filter-term">
          <option value="">{t("admin.table.allTerms")}</option>
          {#each postTerms.taxonomies as taxonomy (taxonomy.key)}
            {#if taxonomy.terms.length}<optgroup label={taxonomy.label}>{#each taxonomy.terms as term (term.id)}<option value={term.id}>{term.label}</option>{/each}</optgroup>{/if}
          {/each}
        </select>
      {/if}
      {#if kind === "post"}<button class="button text small" aria-pressed={wall} onclick={() => setWall(!wall)} data-testid="admin-wall">{t(wall ? "admin.table.asList" : "admin.table.asWall")}</button>{/if}
      {#if hasLanguages}
        <select class="admin-compact" bind:value={filterLanguage} aria-label={t("admin.table.languages")}>
          <option value="">{t("admin.table.siteLanguage")}</option>
          <option value="*">{t("admin.table.allLanguages")}</option>
          {#each index.languages.languages as item (item.code)}<option value={item.code}>{item.label}</option>{/each}
        </select>
      {/if}
      <span class="admin-grow"></span>
      <button class="button primary small" onclick={() => void startCreate()} data-testid="admin-new">＋ {t(kind === "page" ? "admin.new.page" : "admin.new.post")}</button>
    </div>
    {#if creating}
      <form class="admin-new" onsubmit={create}>
        <input id="admin-new-title" bind:value={newTitle} maxlength="500" placeholder={t("admin.new.title")} aria-label={t("admin.new.title")} onkeydown={(event) => { if (event.key === "Escape") creating = false; }} data-testid="admin-new-title" />
        <button class="button primary small" disabled={saving || !newTitle.trim()}>{t("admin.new.create")}</button>
        <button type="button" class="button text small" onclick={() => { creating = false; }}>{t("common.close")}</button>
      </form>
    {/if}
    {#if selected.length}
      <div class="admin-bulk" role="group" aria-label={plural(language, "admin.table.selected", selected.length)}>
        <strong>{plural(language, "admin.table.selected", selected.length)}</strong>
        <button class="button outline small" onclick={() => void bulk("publish")}>{t("admin.table.publish")}</button>
        <button class="button outline small" onclick={() => void bulk("draft")}>{t("admin.table.draft")}</button>
        {#if postTerms?.taxonomies.some((taxonomy) => taxonomy.terms.length)}
          <select class="admin-compact" aria-label={t("admin.table.addTerm")} data-testid="admin-bulk-term" onchange={(event) => { const [taxonomy, term] = event.currentTarget.value.split("|"); event.currentTarget.value = ""; if (taxonomy && term) void addTerm(taxonomy, term); }}>
            <option value="">{t("admin.table.addTerm")}</option>
            {#each postTerms.taxonomies as taxonomy (taxonomy.key)}
              {#if taxonomy.terms.length}<optgroup label={taxonomy.label}>{#each taxonomy.terms as term (term.id)}<option value="{taxonomy.key}|{term.id}">{term.label}</option>{/each}</optgroup>{/if}
            {/each}
          </select>
        {/if}
        {#each index.languages.languages as item (item.code)}<button class="button outline small" onclick={() => void bulk("translate", item.code)}>{t("admin.table.translate", { language: item.label })}</button>{/each}
        <button class="button text small admin-danger" onclick={() => void onTrash(selected).then(() => { selected = []; })}>{t("admin.table.trash")}</button>
        <span class="admin-grow"></span>
        <button class="button text small" onclick={() => { selected = []; }}>{t("admin.table.deselect")}</button>
      </div>
    {/if}
    {#if rows.length && wall}
      <ul class="admin-wall" data-testid="admin-wall-list">
        {#each rows.slice(0, 300) as row (row.id)}
          <li><button onclick={() => openRow(row)}>
            {#if postTerms?.covers[row.id]}<img src={postTerms.covers[row.id]} alt="" loading="lazy" />{:else}<span class="admin-wall-empty" aria-hidden="true"></span>{/if}
            <strong>{row.title}</strong><span class="admin-state {row.status}">{t(`admin.state.${row.status}`)}</span>
          </button></li>
        {/each}
      </ul>
    {:else if rows.length}
      <div class="admin-table" class:langs={hasLanguages} role="grid" aria-rowcount={rows.length + 1} tabindex="0" onkeydown={keydown} data-testid="admin-table">
        <div class="admin-row admin-row-head" role="row">
          <span role="columnheader"><input type="checkbox" aria-label={t("admin.table.selectAll")} checked={selected.length > 0 && selected.length >= Math.min(rows.length, 500)} onchange={allChecked} /></span>
          <span role="columnheader" aria-sort={sortKey === "title" ? (sortDirection === 1 ? "ascending" : "descending") : "none"}><button class="admin-sort" onclick={() => sortBy("title")}>{t("admin.table.title")}</button></span>
          <span role="columnheader" aria-sort={sortKey === "status" ? (sortDirection === 1 ? "ascending" : "descending") : "none"}><button class="admin-sort" onclick={() => sortBy("status")}>{t("admin.table.status")}</button></span>
          {#if hasLanguages}<span role="columnheader">{t("admin.table.languages")}</span>{/if}
          <span role="columnheader" class="admin-col-date" aria-sort={sortKey === "updatedAt" ? (sortDirection === 1 ? "ascending" : "descending") : "none"}><button class="admin-sort" onclick={() => sortBy("updatedAt")}>{t("admin.table.updated")}</button></span>
          <span role="columnheader" class="admin-col-actions"><span class="visually-hidden">{t("admin.detail.builder")}</span></span>
        </div>
        <div class="admin-body" bind:this={body} bind:clientHeight={viewport} onscroll={(event) => { scrollTop = (event.currentTarget as HTMLElement).scrollTop; }}>
          <div class="admin-spacer" style:height="{rows.length * ROW}px">
            {#each rows.slice(visible.start, visible.end) as row, offset (row.id)}
              {@const place = visible.start + offset}
              <div class="admin-row" class:cursor={place === cursor} class:open={row.id === openId} class:picked={selected.includes(row.id)} role="row" aria-rowindex={place + 2} style:top="{place * ROW}px">
                <span role="gridcell"><input type="checkbox" aria-label={t("admin.table.select", { title: row.title })} checked={selected.includes(row.id)} onchange={(event) => toggle(row.id, (event.currentTarget as HTMLInputElement).checked)} /></span>
                <span role="gridcell" class="admin-title">
                  <button onclick={() => { cursor = place; openRow(row); }}>{row.title}</button>
                  <small class="admin-address">{row.address}</small>
                </span>
                <span role="gridcell"><span class="admin-state {row.status}">{t(`admin.state.${row.status}`)}</span></span>
                {#if hasLanguages}<span role="gridcell"><LanguagePills {index} {language} locale={row.locale} versions={versions.get(row.id) ?? []} /></span>{/if}
                <span role="gridcell" class="admin-date admin-col-date" title={fullDate.format(new Date(row.updatedAt))}>{ago(row.updatedAt)}</span>
                <span role="gridcell" class="admin-col-actions"><button class="admin-row-action" aria-label="{t('admin.detail.builder')}: {row.title}" title={t("admin.detail.builder")} onclick={() => onOpenBuilder(row.alias)}>↗</button></span>
              </div>
            {/each}
          </div>
        </div>
      </div>
      <p class="admin-keys">{t("admin.table.keys")}</p>
    {:else if items.length && filtered}
      <div class="admin-empty"><p>{t("admin.noMatch")}</p><button class="button outline small" onclick={clearFilters}>{t("admin.clearFilters")}</button></div>
    {:else}
      <div class="admin-empty"><p>{t(kind === "page" ? "admin.empty.pages" : "admin.empty.posts")}</p><button class="button primary small" onclick={() => void startCreate()}>＋ {t(kind === "page" ? "admin.new.page" : "admin.new.post")}</button></div>
    {/if}
  </div>
  {#if open}
    {#key open.id}
      <ContentDetail document={open} {index} {language} {projectId} {onChanged} {onNotice} {onOpenBuilder} {onWriteAsText} {onPreview} onClose={() => { openId = ""; }} onStep={step} onOpen={(id) => { openId = id; filterLanguage = "*"; }} {onTrash} />
    {/key}
  {/if}
</div>
