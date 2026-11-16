<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import { languageProgress, type AdminDocument, type AdminIndex } from "../lib/admin-index.js";

  let { index, language, lastBuildAt = null, onGo, onOpen, onPublish }: { index: AdminIndex; language: Language; lastBuildAt?: string | null; onGo: (section: string) => void; onOpen: (document: AdminDocument) => void; onPublish: () => void } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const dateFormat = $derived(new Intl.DateTimeFormat(language === "it" ? "it-IT" : "en-GB", { dateStyle: "medium", timeStyle: "short" }));
  const count = (items: ReadonlyArray<{ status: string }>, status: string) => items.filter((item) => item.status === status).length;
  const inSiteLanguage = (items: readonly AdminDocument[]) => items.filter((item) => item.locale === null);
  const recent = $derived([...index.pages, ...index.posts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 8));
  const progress = $derived(languageProgress(index));
  const siteRecords = $derived(index.records.filter((record) => record.locale === index.languages.defaultLanguage.code));
  const changed = $derived(lastBuildAt ? [...index.pages, ...index.posts].filter((item) => item.updatedAt > lastBuildAt).length : null);
  const drafts = $derived(inSiteLanguage(index.posts).filter((item) => item.status === "draft").length);
  const due = $derived(lastBuildAt ? index.posts.filter((post) => post.status === "published" && post.publishedAt && post.publishedAt > lastBuildAt && Date.parse(post.publishedAt) <= Date.now()).length : 0);
  const missingAlt = $derived(index.assets.filter((asset) => asset.mimeType.startsWith("image/") && !asset.alt.trim()).length);
  const tiles = $derived([
    { key: "pagine", label: t("admin.dash.pages"), items: inSiteLanguage(index.pages) },
    { key: "articoli", label: t("admin.dash.posts"), items: inSiteLanguage(index.posts) },
    ...(index.types.length ? [{ key: `tipo-${index.types[0]!.key}`, label: t("admin.dash.records"), items: siteRecords }] : []),
  ]);
</script>

<div class="admin-dashboard">
  <div class="admin-tiles">
    {#each tiles as tile (tile.label)}
      <button class="admin-tile" onclick={() => onGo(tile.key)}>
        <strong>{tile.items.length}</strong><span>{tile.label}</span>
        <small>{t("admin.dash.published", { n: count(tile.items, "published") })} · {t("admin.dash.drafts", { n: count(tile.items, "draft") })}</small>
      </button>
    {/each}
    <button class="admin-tile" onclick={() => onGo("media")}><strong>{index.assets.length}</strong><span>{t("admin.dash.media")}</span></button>
  </div>
  <section class="admin-next" data-testid="admin-next">
    <div><h2>{t(changed === null ? "admin.next.first" : changed ? "admin.next.changed" : "admin.next.same", { n: changed ?? 0 })}</h2><p class="muted">{t(changed === null ? "admin.next.firstHint" : changed ? "admin.next.changedHint" : "admin.next.sameHint")}</p></div>
    {#if changed === null || changed}<button class="button primary" onclick={onPublish}>{t("admin.publish")}</button>{/if}
    <ul>
      {#if due}<li><button onclick={onPublish} data-testid="admin-due">{t("admin.next.scheduled", { n: due })}</button></li>{/if}
      {#if drafts}<li><button onclick={() => onGo("articoli")}>{t("admin.next.drafts", { n: drafts })}</button></li>{/if}
      {#if missingAlt}<li><button onclick={() => onGo("media")}>{t("admin.next.alt", { n: missingAlt })}</button></li>{/if}
    </ul>
  </section>
  {#if !index.siteUrl}
    <div class="admin-notice"><p>{t("admin.dash.noUrl")}</p><button class="button outline small" onclick={() => onGo("impostazioni")}>{t("admin.dash.setUrl")}</button></div>
  {/if}
  <div class="admin-columns">
    <section class="admin-block">
      <h2>{t("admin.dash.recent")}</h2>
      {#if recent.length}
        <ul class="admin-recent">
          {#each recent as item (item.id)}
            <li><span class="admin-title"><button onclick={() => onOpen(item)}>{item.title}</button><small class="admin-address">{item.address}</small></span><span class="admin-date">{dateFormat.format(new Date(item.updatedAt))}</span></li>
          {/each}
        </ul>
      {:else}
        <p class="muted">{t("admin.empty")}</p>
      {/if}
    </section>
    <section class="admin-block">
      <h2>{t("admin.languages")}</h2>
      {#if progress.length}
        <ul class="admin-progress-list">
          {#each progress as line (line.code)}
            <li>
              <button onclick={() => onGo("lingue")}><span>{line.label}</span><span class="admin-date">{line.published}/{line.total}</span></button>
              <span class="admin-progress" role="progressbar" aria-valuenow={line.percent} aria-valuemin="0" aria-valuemax="100" aria-label={line.label}><span style:width="{line.percent}%"></span></span>
              <small class="admin-date">{t("admin.dash.todoLine", { missing: line.missing, draft: line.draft, stale: line.stale })}</small>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">{t("admin.lang.none")}</p>
        <button class="button outline small" onclick={() => onGo("lingue")}>{t("admin.dash.addLanguage")}</button>
      {/if}
    </section>
  </div>
</div>
