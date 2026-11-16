<script lang="ts">
  import { api } from "../lib/api.js";
  import { plural, translate, type Language } from "../lib/i18n.js";
  import type { AdminDocument, AdminIndex, AdminLink } from "../lib/admin-index.js";

  /** The right-hand panel: edits in place, the languages of the content, and its way to the builder (doc 21 §5). */
  let { document: item, index, language, projectId, embedded = false, onChanged, onNotice, onOpenBuilder, onWriteAsText, onPreview, onClose, onStep, onOpen, onTrash }: {
    document: AdminDocument;
    index: AdminIndex;
    language: Language;
    projectId: string;
    /** Beside the article editor: the title is on the page, and the builder is a last resort. */
    embedded?: boolean;
    onChanged: () => void;
    onNotice: (text: string, failed?: boolean) => void;
    onOpenBuilder: (alias: number) => void;
    /** A page of plain text opens in the article editor too. */
    onWriteAsText?: ((alias: number) => void) | undefined;
    onPreview: (alias: number) => void;
    onClose: () => void;
    onStep: (direction: number) => void;
    onOpen: (id: string) => void;
    onTrash: (ids: string[]) => Promise<void>;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const base = $derived(`/api/cms/v1/projects/${encodeURIComponent(projectId)}`);
  interface Term { id: string; label: string }
  // The panel is rebuilt for each content ({#key}), so these start from the one on screen.
  // svelte-ignore state_referenced_locally
  let title = $state(item.title);
  // svelte-ignore state_referenced_locally
  let slug = $state(item.slug);
  // svelte-ignore state_referenced_locally
  let status = $state(item.status);
  // svelte-ignore state_referenced_locally
  let templateRef = $state(item.templateRef ?? "");
  let excerpt = $state("");
  let publishedAt = $state("");
  // Doc 23 item 119: the featured image of a post, chosen among the project's images.
  let imageAssetId = $state<string | null>(null);
  let choosingImage = $state(false);
  const images = $derived(index.assets.filter((asset) => asset.mimeType.startsWith("image/")));
  const image = $derived(images.find((asset) => asset.id === imageAssetId) ?? null);
  const mediaUrl = (id: string) => `/__cms-media/${encodeURIComponent(projectId)}/${id}`;
  function chooseImage(id: string | null): void {
    imageAssetId = id;
    choosingImage = false;
    void save({ imageAssetId: id });
  }
  let terms = $state<Record<string, string[]>>({});
  let taxonomyTerms = $state<Array<{ key: string; label: string; terms: Term[] }>>([]);
  let changes = $state<Array<{ id: string; before: string | null; now: string | null; translation: string | null }>>([]);

  const link = $derived(index.translations.find((entry) => entry.translationId === item.id) ?? null);
  const source = $derived(link ? [...index.pages, ...index.posts].find((entry) => entry.id === link.sourceId) ?? null : null);
  const versions = $derived(index.translations.filter((entry) => entry.sourceId === item.id));
  const languageLabel = (code: string) => index.languages.languages.find((entry) => entry.code === code)?.label ?? code;
  const prefix = $derived(item.address.slice(0, item.address.length - (item.slug === "home" ? 0 : item.slug.length + 1)));

  const reason = (error: unknown) => (error instanceof Error ? error.message : "");
  /** `done: null` when the caller says itself what happened. */
  async function report(work: () => Promise<void>, done: string | null = t("admin.saved")): Promise<boolean> {
    try {
      await work();
      if (done) onNotice(done);
      onChanged();
      return true;
    } catch (error) {
      onNotice(t("admin.reverted", { message: reason(error) }), true);
      onChanged();
      return false;
    }
  }
  const target = () => `${base}/${item.kind === "post" ? "posts" : "pages"}/${item.alias}`;
  async function save(fields: Record<string, unknown>): Promise<void> {
    const saved = await report(async () => {
      await api(target(), { method: "PATCH", body: JSON.stringify({ head: item.head, ...(item.kind === "post" ? { status } : {}), ...fields }) });
    });
    // What was refused does not stay on screen as if it were saved.
    if (!saved) { title = item.title; slug = item.slug; status = item.status; templateRef = item.templateRef ?? ""; }
  }
  let seo = $state({ title: "", description: "", image: "" });
  let seoReady = $state(false);
  async function loadSeo(): Promise<void> {
    if (seoReady) return;
    seo = (await api<{ seo: typeof seo }>(`${base}/admin/seo/${item.alias}`)).seo;
    seoReady = true;
  }
  const saveSeo = () => report(async () => {
    await api(`${base}/admin/seo/${item.alias}`, { method: "PUT", body: JSON.stringify($state.snapshot(seo)) });
  });
  async function load(): Promise<void> {
    const content = await api<{ excerpt: string; publishedAt: string | null; imageAssetId?: string | null; terms: Record<string, string[]> }>(`${base}/admin/content/${item.alias}`);
    excerpt = content.excerpt;
    imageAssetId = content.imageAssetId ?? null;
    publishedAt = (content.publishedAt ?? "").replace(/Z$/u, "");
    terms = content.terms;
    if (item.kind !== "post") return;
    const lists = await api<{ taxonomies: Array<{ key: string; label: string; types: string[] }> }>(`${base}/taxonomies`);
    taxonomyTerms = await Promise.all(lists.taxonomies.filter((taxonomy) => taxonomy.types.includes("post")).map(async (taxonomy) => ({ key: taxonomy.key, label: taxonomy.label, terms: (await api<{ terms: Term[] }>(`${base}/taxonomies/${encodeURIComponent(taxonomy.key)}/terms`)).terms })));
  }
  async function loadChanges(entry: AdminLink | null): Promise<void> {
    changes = entry && entry.mode === "follow" ? (await api<{ changes: typeof changes }>(`${base}/translations/${entry.translationId}/changes`)).changes : [];
  }
  $effect(() => { void load().catch(() => undefined); });
  $effect(() => { void loadChanges(link).catch(() => undefined); });

  function toggleTerm(taxonomy: string, id: string): void {
    const current = terms[taxonomy] ?? [];
    terms = { ...terms, [taxonomy]: current.includes(id) ? current.filter((term) => term !== id) : [...current, id] };
    void save({ terms: $state.snapshot(terms) });
  }
  const translateTo = (code: string) => report(async () => {
    await api(`${base}/translations`, { method: "POST", body: JSON.stringify({ sourceId: item.id, language: code }) });
  }, t("admin.version.created", { language: languageLabel(code) }));
  const patchLink = (body: Record<string, unknown>) => report(async () => {
    await api(`${base}/translations/${item.id}`, { method: "PATCH", body: JSON.stringify(body) });
  });
  async function updateDraft(): Promise<void> {
    let left = 0;
    const updated = await report(async () => {
      left = (await api<{ left: number }>(`${base}/translations/${item.id}/update-draft`, { method: "POST", body: "{}" })).left;
    }, null);
    if (updated) onNotice(plural(language, "admin.version.updated", left));
  }
</script>

<aside class="admin-detail" class:embedded aria-label={embedded ? t("article.settings") : item.title} data-testid="admin-detail">
  <header class="admin-detail-head">
    <span class="admin-state {item.status}">{t(`admin.state.${item.status}`)}</span>
    {#if item.status === "published" && item.publishedAt && Date.parse(item.publishedAt) > Date.now()}<span class="admin-state draft" data-testid="admin-scheduled">{t("admin.state.scheduled")}</span>{/if}
    <span class="admin-grow"></span>
    {#if !embedded}
      <button class="admin-icon" aria-label={t("admin.detail.prev")} title={t("admin.detail.prev")} onclick={() => onStep(-1)}>↑</button>
      <button class="admin-icon" aria-label={t("admin.detail.next")} title={t("admin.detail.next")} onclick={() => onStep(1)}>↓</button>
      <button class="admin-icon" aria-label={t("admin.detail.close")} title={t("admin.detail.close")} onclick={onClose}>×</button>
    {/if}
  </header>
  {#if !embedded}
    <div class="admin-detail-actions">
      <button class="button primary small" onclick={() => onOpenBuilder(item.alias)} data-testid="admin-open-builder">{t("admin.detail.builder")}</button>
      {#if onWriteAsText && item.kind === "page"}<button class="button outline small" onclick={() => onWriteAsText(item.alias)} data-testid="admin-write-text">{t("article.writeAsText")}</button>{/if}
      <button class="button outline small" onclick={() => onPreview(item.alias)} data-testid="admin-preview">{t("admin.detail.preview")}</button>
    </div>
    <label class="field-label">{t("admin.detail.title")}<input bind:value={title} maxlength="500" onchange={() => void save({ title })} data-testid="admin-detail-title" /></label>
  {/if}
  <label class="field-label">{t("admin.detail.slug")}
    <span class="admin-slug"><span class="admin-address">{prefix}</span><input bind:value={slug} maxlength="200" onchange={() => void save({ slug })} /></span>
  </label>
  <div class="admin-detail-pair">
    <label class="field-label">{t("admin.detail.status")}
      <select bind:value={status} onchange={() => void save({ status })}>
        <option value="draft">{t("admin.state.draft")}</option>
        <option value="published">{t("admin.state.published")}</option>
      </select>
    </label>
    {#if item.kind !== "post"}
      <label class="field-label">{t("admin.detail.template")}
        <select bind:value={templateRef} onchange={() => void save({ templateRef: templateRef || null })}>
          <option value="">{t("admin.detail.noTemplate")}</option>
          {#each index.templates as template (template.id)}<option value={template.ref}>{template.title}</option>{/each}
        </select>
      </label>
    {/if}
  </div>
  {#if item.kind === "post"}
    {#if status === "published"}
      <label class="field-label">{t("admin.detail.date")}<input type="datetime-local" step="1" bind:value={publishedAt} onchange={() => void save({ publishedAt: publishedAt ? `${publishedAt.length === 16 ? `${publishedAt}:00` : publishedAt}Z` : null })} /></label>
    {/if}
    <label class="field-label">{t("admin.detail.excerpt")}<textarea rows="3" bind:value={excerpt} onchange={() => void save({ excerpt })}></textarea></label>
    <div class="field-label admin-post-image" data-testid="admin-post-image">
      <span>{t("admin.detail.image")}</span>
      {#if image}
        <img src={mediaUrl(image.id)} alt={image.alt} />
      {:else}
        <small class="muted">{t("admin.detail.imageNone")}</small>
      {/if}
      <span class="admin-actions">
        <button type="button" class="button outline small" aria-expanded={choosingImage} onclick={() => (choosingImage = !choosingImage)} data-testid="admin-post-image-choose">{image ? t("admin.detail.imageChange") : t("admin.detail.imageChoose")}</button>
        {#if image}<button type="button" class="button text small" onclick={() => chooseImage(null)} data-testid="admin-post-image-remove">{t("admin.detail.imageRemove")}</button>{/if}
      </span>
      {#if choosingImage}
        {#if images.length}
          <ul class="admin-post-image-grid" aria-label={t("admin.detail.imageChoose")}>
            {#each images as asset (asset.id)}
              <li><button type="button" class:active={asset.id === imageAssetId} aria-pressed={asset.id === imageAssetId} title={asset.alt || asset.filename} onclick={() => chooseImage(asset.id)}><img src={mediaUrl(asset.id)} alt={asset.alt || asset.filename} loading="lazy" /></button></li>
            {/each}
          </ul>
        {:else}
          <small class="muted">{t("admin.detail.imageEmpty")}</small>
        {/if}
      {/if}
    </div>
    {#each taxonomyTerms as taxonomy (taxonomy.key)}
      {#if taxonomy.terms.length}
        <fieldset class="admin-terms">
          <legend>{taxonomy.label}</legend>
          {#each taxonomy.terms as term (term.id)}
            <button type="button" class:active={terms[taxonomy.key]?.includes(term.id)} aria-pressed={terms[taxonomy.key]?.includes(term.id) ?? false} onclick={() => toggleTerm(taxonomy.key, term.id)}>{term.label}</button>
          {/each}
        </fieldset>
      {/if}
    {/each}
  {/if}
  <details class="admin-seo" data-testid="admin-seo" ontoggle={(event) => { if (event.currentTarget.open) void loadSeo(); }}>
    <summary>{t("admin.seo")}</summary>
    <div class="admin-seo-preview"><strong>{seo.title || title}</strong><span>{index.siteUrl ?? ""}{item.address}</span><small>{seo.description || excerpt}</small></div>
    <label class="field-label">{t("admin.seo.title")}<input bind:value={seo.title} disabled={!seoReady} maxlength="200" placeholder={title} onchange={() => void saveSeo()} data-testid="admin-seo-title" /></label>
    <label class="field-label">{t("admin.seo.description")}<textarea rows="3" bind:value={seo.description} disabled={!seoReady} maxlength="400" placeholder={excerpt} onchange={() => void saveSeo()}></textarea><small class="muted">{t("admin.seo.length", { n: seo.description.length })}</small></label>
  </details>
  {#if link}
    <section class="admin-versions">
      <h3>{t("admin.detail.translationOf", { language: languageLabel(link.language), title: source?.title ?? "" })}</h3>
      <p class="admin-version-state"><span class="admin-state {link.state}">{t(`admin.state.${link.state}`)}</span> {link.mode === "follow" ? t("admin.version.mode") : t("admin.version.independent")}</p>
      <div class="admin-actions">
        {#if link.mode === "follow"}
          {#if item.status === "draft"}<button class="button outline small" onclick={() => void updateDraft()}>{t("admin.version.update")}</button>{/if}
          {#if changes.length}<button class="button outline small" onclick={() => void patchLink({ action: "mark-current" })}>{t("admin.version.mark")}</button>{/if}
          <button class="button text small" onclick={() => void patchLink({ mode: "independent" })}>{t("admin.version.makeIndependent")}</button>
        {:else}
          <button class="button outline small" onclick={() => void patchLink({ mode: "follow" })}>{t("admin.version.follow")}</button>
        {/if}
        {#if source}<button class="button text small" onclick={() => onOpen(source.id)}>{t("admin.detail.original")}</button>{/if}
      </div>
      {#if changes.length}
        <h4>{t("admin.version.changes")}</h4>
        <ul class="admin-changes">
          {#each changes as change (change.id)}
            <li><del>{change.before ?? "—"}</del><ins>{change.now ?? "—"}</ins><span>{change.translation ?? "—"}</span></li>
          {/each}
        </ul>
      {/if}
    </section>
  {:else if item.locale === null && index.languages.languages.length}
    <section class="admin-versions">
      <h3>{t("admin.detail.languages")}</h3>
      <ul class="admin-version-list">
        {#each index.languages.languages as entry (entry.code)}
          {@const version = versions.find((candidate) => candidate.language === entry.code)}
          <li>
            <span>{entry.label}</span>
            <span class="admin-state {version?.state ?? "missing"}">{t(`admin.state.${version?.state ?? "missing"}`)}</span>
            {#if version}<button class="button text small" onclick={() => onOpen(version.translationId)}>{t("admin.version.open")}</button>{:else}<button class="button outline small" onclick={() => void translateTo(entry.code)} data-testid="admin-translate-{entry.code}">{t("admin.version.create")}</button>{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if item.kind === "post" && templateRef}
    <p class="admin-note">{t("article.ownTemplate", { name: index.templates.find((template) => template.ref === templateRef)?.title ?? templateRef })} <button class="button text small" onclick={() => { templateRef = ""; void save({ templateRef: null }); }}>{t("article.useCommon")}</button></p>
  {/if}
  {#if embedded}<button class="button text small" onclick={() => onOpenBuilder(item.alias)} data-testid="admin-open-builder">{t("article.openBuilder")}</button>{/if}
  <button class="button text small admin-danger" onclick={() => void onTrash([item.id])}>{t("admin.table.trash")}</button>
</aside>

<style>
  .admin-post-image img { display: block; max-width: 100%; max-height: 10rem; object-fit: cover; border-radius: 0.375rem; }
  .admin-post-image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(4.5rem, 1fr)); gap: 0.375rem; margin: 0; padding: 0; list-style: none; max-height: 14rem; overflow: auto; }
  .admin-post-image-grid button { display: block; width: 100%; padding: 0; border: 2px solid transparent; border-radius: 0.375rem; background: none; cursor: pointer; }
  .admin-post-image-grid button.active, .admin-post-image-grid button:focus-visible { border-color: currentColor; }
  .admin-post-image-grid img { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 0.25rem; }
</style>
