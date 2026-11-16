<script lang="ts">
  import { onMount, type Component, type Snippet } from "svelte";
  import IconPublish from "@lucide/svelte/icons/rocket";
  import IconAppearance from "@lucide/svelte/icons/palette";
  import IconContent from "@lucide/svelte/icons/shapes";
  import IconDashboard from "@lucide/svelte/icons/layout-dashboard";
  import IconLanguages from "@lucide/svelte/icons/languages";
  import IconMedia from "@lucide/svelte/icons/image";
  import IconPages from "@lucide/svelte/icons/file-text";
  import IconPosts from "@lucide/svelte/icons/pen-line";
  import IconSettings from "@lucide/svelte/icons/settings-2";
  import IconType from "@lucide/svelte/icons/folder-open";
  import "./admin.css";
  import { api } from "../lib/api.js";
  import { translate, type Language } from "../lib/i18n.js";
  import { forgetAdminIndex, keptAdminIndex, readAdminIndex, type AdminDocument, type AdminIndex } from "../lib/admin-index.js";
  import CmsContentPanel from "../CmsContentPanel.svelte";
  import ArticleEditor from "./ArticleEditor.svelte";
  import CommandPalette from "./CommandPalette.svelte";
  import ContentTable from "./ContentTable.svelte";
  import Dashboard from "./Dashboard.svelte";
  import LanguagesPanel from "./LanguagesPanel.svelte";
  import MediaGrid from "./MediaGrid.svelte";
  import SettingsPanel from "./SettingsPanel.svelte";

  /**
   * The site administration (doc 21): a screen of its own inside the app, on the store and server that exist. What it
   * shows comes from the index kept in memory, so changing section draws at once; the index is checked behind the scenes.
   */
  let { projectId, projectName, language, section, lastBuildAt = null, notices, publishPanel, templatesPanel, advancedPanel, trashSites = 0, onAskTrash, onSection, onOpenBuilder, onPublish, onPreview, onPreviewSite, onNotice, onRenamed }: {
    projectId: string;
    projectName: string;
    language: Language;
    section: string;
    /** When the site's last version was made: the dashboard says what changed after it. */
    lastBuildAt?: string | null;
    /** The parts of the project that live in the app's main screen, shown here as sections. */
    notices: Snippet;
    publishPanel: Snippet;
    templatesPanel: Snippet;
    advancedPanel: Snippet;
    /** WordPress sites linked to the project: going to the Cestino then asks which one. */
    trashSites?: number;
    onAskTrash: (ids: string[]) => void;
    onSection: (section: string) => void;
    onOpenBuilder: (alias: number, section: string) => void;
    onPublish: () => void;
    onPreview: (alias: number) => void;
    onPreviewSite: () => void;
    onNotice: (text: string, failed?: boolean, action?: { label: string; run: () => void }) => void;
    onRenamed: (name: string) => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const base = $derived(`/api/cms/v1/projects/${encodeURIComponent(projectId)}`);
  // svelte-ignore state_referenced_locally
  let index = $state<AdminIndex | null>(keptAdminIndex(projectId));
  let paletteOpen = $state(false);
  /** What the table of the next section opens at once; a plain move through the sections opens nothing. */
  let openInTable = $state("");

  async function refresh(): Promise<void> {
    try {
      index = await readAdminIndex(projectId);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : t("error.generic"), true);
    }
  }
  onMount(() => {
    void refresh();
    const again = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  });
  function keydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      paletteOpen = !paletteOpen;
    }
  }
  function go(next: string): void {
    openInTable = "";
    onSection(next);
  }
  const contentSections = $derived([
    { key: "pagine", label: t("admin.pages"), icon: IconPages as Component, count: index?.pages.filter((item) => item.locale === null).length ?? null },
    { key: "articoli", label: t("admin.posts"), icon: IconPosts as Component, count: index?.posts.filter((item) => item.locale === null).length ?? null },
    ...(index?.types ?? []).map((type) => ({ key: `tipo-${type.key}`, label: type.label, icon: IconType as Component, count: index?.records.filter((record) => record.typeKey === type.key && record.locale === index?.languages.defaultLanguage.code).length ?? null })),
    { key: "contenuti", label: t("admin.content"), icon: IconContent as Component, count: null as number | null },
  ]);
  const siteSections = $derived([
    { key: "media", label: t("admin.media"), icon: IconMedia as Component, count: index?.assets.length ?? null as number | null },
    { key: "aspetto", label: t("admin.appearance"), icon: IconAppearance as Component, count: null as number | null },
    { key: "pubblica", label: t("admin.publishSection"), icon: IconPublish as Component, count: null as number | null },
    { key: "lingue", label: t("admin.languages"), icon: IconLanguages as Component, count: index ? index.languages.languages.length + 1 : null },
    { key: "impostazioni", label: t("admin.settings"), icon: IconSettings as Component, count: null as number | null },
  ]);
  const sections = $derived([{ key: "bacheca", label: t("admin.dashboard"), icon: IconDashboard as Component, count: null as number | null }, ...contentSections, ...siteSections]);
  const activeTitle = $derived(sections.find((item) => item.key === section)?.label ?? t("admin.dashboard"));
  /** `articolo-<alias>`: an article open in its editor, an address of its own, so the builder and Back return to it. */
  const articleAlias = $derived(/^articolo-(\d+)$/u.exec(section)?.[1]);
  const article = $derived(articleAlias ? [...(index?.posts ?? []), ...(index?.pages ?? [])].find((item) => item.alias === Number(articleAlias)) ?? null : null);
  const current = $derived(articleAlias ? (article?.kind === "page" ? "pagine" : "articoli") : section);
  const postsTemplate = $derived(index?.templates.find((template) => template.role === "single") ?? null);
  const focusType = $derived(section.startsWith("tipo-") ? section.slice(5) : "");

  function openDocument(document: AdminDocument): void {
    if (document.kind === "post") { go(`articolo-${document.alias}`); return; }
    onSection("pagine");
    openInTable = document.id;
  }
  function pick(kind: string, id: string): void {
    paletteOpen = false;
    if (kind === "section") go(id);
    else if (kind === "asset") go("media");
    else if (kind === "record") {
      const record = index?.records.find((item) => item.id === id);
      if (record) go(`tipo-${record.typeKey}`);
    } else {
      const document = [...(index?.pages ?? []), ...(index?.posts ?? [])].find((item) => item.id === id);
      if (document) openDocument(document);
    }
  }
  /** A row of the work list: a page or post opens in its table, a record in its type. */
  function openWork(kind: string, id: string): void {
    pick(kind === "page" || kind === "post" ? kind : "record", id);
  }
  /** Whether it went through: all of them or, on a refusal, none, as the transaction says. */
  async function bulk(action: "publish" | "draft" | "translate" | "term", ids: string[], code?: string, extra: Record<string, string> = {}): Promise<boolean> {
    try {
      await api(`${base}/admin/bulk`, { method: "POST", body: JSON.stringify({ action, ids, ...(code ? { language: code } : {}), ...extra }) });
      if (action !== "translate") onNotice(t("admin.saved"));
      await refresh();
      return true;
    } catch (error) {
      onNotice(t("admin.reverted", { message: error instanceof Error ? error.message : "" }), true);
      await refresh();
      return false;
    }
  }
  async function create(kind: "page" | "post", title: string): Promise<string | null> {
    try {
      const answer = await api<{ page?: { id: string }; post?: { id: string }; id?: string }>(`${base}/${kind === "page" ? "pages" : "posts"}`, { method: "POST", body: JSON.stringify({ title, ...(kind === "post" ? { blank: true } : {}) }) });
      await refresh();
      return answer.page?.id ?? answer.post?.id ?? answer.id ?? null;
    } catch (error) {
      onNotice(t("admin.reverted", { message: error instanceof Error ? error.message : "" }), true);
      return null;
    }
  }
  /** The Cestino keeps what goes there: the notice takes it back at once. */
  async function trash(ids: string[]): Promise<void> {
    if (trashSites) { onAskTrash(ids); return; }
    try {
      for (let start = 0; start < ids.length; start += 100) await api(`${base}/trash`, { method: "POST", body: JSON.stringify({ entityIds: ids.slice(start, start + 100) }) });
      onNotice(t("admin.trashed", { n: ids.length }), false, { label: t("admin.undo"), run: () => void restore(ids) });
    } catch (error) {
      onNotice(t("admin.reverted", { message: error instanceof Error ? error.message : "" }), true);
    }
    await refresh();
  }
  async function restore(ids: string[]): Promise<void> {
    try {
      for (const id of ids) await api(`${base}/recovery/tombstones/${id}`, { method: "POST", body: "{}" });
      onNotice(t("admin.restored"));
    } catch (error) {
      onNotice(t("admin.reverted", { message: error instanceof Error ? error.message : "" }), true);
    }
    forgetAdminIndex(projectId);
    await refresh();
  }
</script>

<svelte:window onkeydown={keydown} />

{#snippet entry(item: { key: string; label: string; icon: Component; count: number | null })}
  <li><button class:active={item.key === current} aria-current={item.key === current ? "page" : undefined} onclick={() => go(item.key)} data-testid="admin-section-{item.key}"><span class="admin-icon-mark" aria-hidden="true"><item.icon size={16} strokeWidth={1.9} /></span><span class="admin-grow">{item.label}</span>{#if item.count !== null}<span class="admin-badge">{item.count}</span>{/if}</button></li>
{/snippet}

<div class="site-admin" data-testid="site-admin">
  <nav class="admin-side" aria-label={t("admin.sections")}>
    <h1 class="admin-site-name" title={projectName} tabindex="-1">{projectName}</h1>
    <button class="admin-search" onclick={() => { paletteOpen = true; }} data-testid="admin-search"><span>{t("admin.search")}</span><kbd>{t("admin.searchKeys")}</kbd></button>
    <ul>{@render entry(sections[0]!)}</ul>
    <h2 class="admin-side-label">{t("admin.group.content")}</h2>
    <ul>{#each contentSections as item (item.key)}{@render entry(item)}{/each}</ul>
    <h2 class="admin-side-label">{t("admin.group.site")}</h2>
    <ul>{#each siteSections as item (item.key)}{@render entry(item)}{/each}</ul>
  </nav>
  <main class="admin-main">
    {#if !articleAlias}
      <header class="admin-head">
        <h2 class="admin-title-main">{activeTitle}</h2>
        <span class="admin-grow"></span>
        {#if section === "articoli" && postsTemplate}<button class="button outline small" onclick={() => onOpenBuilder(postsTemplate.alias, section)} title={t("article.templateHint")} data-testid="admin-posts-template">{t("article.template")}</button>{/if}
        <button class="button outline" onclick={onPreviewSite} data-testid="cms-site-preview">{t("admin.previewSite")}</button>
        {#if section !== "pubblica"}<button class="button primary" onclick={onPublish} data-testid="admin-publish">{t("admin.publish")}</button>{/if}
      </header>
      {@render notices()}
    {/if}
    {#if !index}
      <div class="admin-skeleton" aria-label={t("admin.loading")} role="status">{#each [1, 2, 3, 4, 5] as line (line)}<span></span>{/each}</div>
    {:else if article}
      {#key article.id}
        <ArticleEditor document={article} {index} {language} {projectId} onBack={() => go(article.kind === "page" ? "pagine" : "articoli")} onChanged={() => void refresh()} {onNotice} onOpenBuilder={(alias) => onOpenBuilder(alias, section)} {onPreview} onOpen={(id) => { const version = index?.posts.find((post) => post.id === id); if (version) go(`articolo-${version.alias}`); }} onTrash={async (ids) => { await trash(ids); go("articoli"); }} />
      {/key}
    {:else if section === "pagine" || section === "articoli"}
      {#key section}
        <ContentTable {index} kind={section === "pagine" ? "page" : "post"} {language} {projectId} initial={openInTable} onChanged={() => void refresh()} {onNotice} onOpenBuilder={(alias) => onOpenBuilder(alias, section)} onOpenArticle={section === "articoli" ? (alias) => go(`articolo-${alias}`) : undefined} onWriteAsText={(alias) => go(`articolo-${alias}`)} {onPreview} onCreate={create} onBulk={bulk} onTrash={trash} />
      {/key}
    {:else if focusType || section === "contenuti"}
      {#key section}
        <CmsContentPanel {projectId} {language} locale={index.renderSettings.locale} {focusType} onChanged={() => void refresh()} />
      {/key}
    {:else if section === "media"}
      <MediaGrid assets={index.assets} {language} {projectId} {onNotice} onChanged={() => void refresh()} onTrash={trash} />
    {:else if section === "aspetto"}
      {@render templatesPanel()}
    {:else if section === "pubblica"}
      {@render publishPanel()}
    {:else if section === "lingue"}
      <LanguagesPanel {index} {language} {projectId} {onNotice} onChanged={() => void refresh()} onBulk={bulk} onOpen={openWork} />
    {:else if section === "impostazioni"}
      {#key projectId}
        <SettingsPanel {index} {language} {projectId} {projectName} {onNotice} {onRenamed} onChanged={() => void refresh()} />
      {/key}
      {@render advancedPanel()}
    {:else}
      <Dashboard {index} {language} {lastBuildAt} onGo={go} onOpen={openDocument} {onPublish} />
    {/if}
  </main>
</div>
{#if paletteOpen && index}
  <CommandPalette {index} {language} sections={sections.map((item) => ({ key: item.key, label: item.label }))} onPick={pick} onClose={() => { paletteOpen = false; }} />
{/if}
