<script lang="ts">
  import { api, uploadMedia } from "../lib/api.js";
  import { translate, type Language } from "../lib/i18n.js";
  import { searchable, type AdminAsset } from "../lib/admin-index.js";

  let { assets, language, projectId, onChanged, onNotice, onTrash }: { assets: AdminAsset[]; language: Language; projectId: string; onChanged: () => void; onNotice: (text: string, failed?: boolean) => void; onTrash: (ids: string[]) => Promise<void> } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  let search = $state("");
  let onlyMissing = $state(false);
  let uploading = $state(false);
  let onlyUnused = $state(false);
  let used = $state<Set<string> | null>(null);
  let cropping = $state<AdminAsset | null>(null);
  let folders = $state<Record<string, string>>({});
  let folderFilter = $state("");
  const folderNames = $derived([...new Set(Object.values(folders))].sort((left, right) => left.localeCompare(right)));
  $effect(() => {
    void api<{ folders: Record<string, string> }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/admin/media-folders`).then((answer) => { folders = answer.folders; }).catch(() => undefined);
  });
  const message = (error: unknown) => error instanceof Error ? error.message : "";
  const notSaved = (error: unknown) => { onNotice(t("admin.reverted", { message: message(error) }), true); };
  async function setFolder(asset: AdminAsset, name: string): Promise<void> {
    const next = { ...folders };
    if (name.trim()) next[asset.id] = name.trim();
    else delete next[asset.id];
    try {
      folders = (await api<{ folders: Record<string, string> }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/admin/media-folders`, { method: "PUT", body: JSON.stringify({ folders: next }) })).folders;
    } catch (error) { notSaved(error); }
  }
  let cropRatio = $state(0);
  let cropTurn = $state(0);
  async function showUnused(on: boolean): Promise<void> {
    onlyUnused = on;
    try {
      if (on && !used) used = new Set((await api<{ used: string[] }>(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/admin/media-usage`)).used);
    } catch (error) {
      // Without the usage list the filter would show every file as unused.
      onlyUnused = false;
      onNotice(message(error) || t("common.error"), true);
    }
  }
  /** A new file made from the picture, in the browser: the original stays, and what uses it does not change. */
  async function saveCrop(asset: AdminAsset): Promise<void> {
    try { await cropCopy(asset); } catch (error) { notSaved(error); }
  }
  async function cropCopy(asset: AdminAsset): Promise<void> {
    const image = new Image();
    image.src = `/__cms-media/${encodeURIComponent(projectId)}/${asset.id}`;
    await image.decode();
    const sideways = cropTurn % 2 === 1;
    const fullWidth = sideways ? image.naturalHeight : image.naturalWidth;
    const fullHeight = sideways ? image.naturalWidth : image.naturalHeight;
    const ratio = cropRatio || fullWidth / fullHeight;
    const width = Math.min(fullWidth, Math.round(fullHeight * ratio));
    const height = Math.round(width / ratio);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.translate(width / 2, height / 2);
    context.rotate((cropTurn * Math.PI) / 2);
    context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
    const blob = await new Promise<Blob | null>((done) => { canvas.toBlob(done, "image/webp", 0.9); });
    if (!blob) return;
    await uploadMedia(projectId, new File([blob], `${asset.filename.replace(/\.[^.]+$/u, "")}-ritaglio.webp`, { type: "image/webp" }));
    cropping = null;
    onNotice(t("admin.saved"));
    onChanged();
  }
  let dragging = $state(false);
  let picker = $state<HTMLInputElement | null>(null);
  const missingAlt = $derived(assets.filter((asset) => asset.mimeType.startsWith("image/") && !asset.alt.trim()).length);
  const shown = $derived.by(() => {
    const query = searchable(search.trim());
    return assets.filter((asset) => (!folderFilter || folders[asset.id] === folderFilter) && (!onlyUnused || !used?.has(asset.id)) && (!onlyMissing || (asset.mimeType.startsWith("image/") && !asset.alt.trim())) && (!query || searchable(`${asset.filename} ${asset.alt}`).includes(query))).slice(0, 300);
  });
  async function save(asset: AdminAsset, fields: { alt?: string; caption?: string }): Promise<void> {
    try {
      await api(`/api/cms/v1/projects/${encodeURIComponent(projectId)}/media/${asset.alias}`, { method: "POST", body: JSON.stringify(fields) });
      onNotice(t("admin.saved"));
    } catch (error) {
      onNotice(t("admin.reverted", { message: error instanceof Error ? error.message : "" }), true);
    }
    onChanged();
  }
  async function upload(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    uploading = true;
    try {
      for (const file of files) await uploadMedia(projectId, file);
      onNotice(t("admin.saved"));
    } catch (error) {
      onNotice(t("admin.reverted", { message: error instanceof Error ? error.message : "" }), true);
    }
    uploading = false;
    onChanged();
  }
</script>

<div class="admin-dropzone" class:dragging role="group" aria-label={t("admin.media")} ondragover={(event) => { event.preventDefault(); dragging = true; }} ondragleave={() => { dragging = false; }} ondrop={(event) => { event.preventDefault(); dragging = false; void upload(event.dataTransfer?.files ?? null); }}>
  <div class="admin-toolbar">
    <input class="admin-search-field" type="search" bind:value={search} placeholder={t("admin.media.searchLabel")} aria-label={t("admin.media.searchLabel")} />
    {#if missingAlt}<label class="admin-check"><input type="checkbox" bind:checked={onlyMissing} /> {t("admin.media.missingAlt", { n: missingAlt })}</label>{/if}
    <span class="admin-grow"></span>
    <input class="visually-hidden" type="file" multiple accept="image/*,.woff,.woff2,.ttf,.otf" tabindex="-1" aria-hidden="true" bind:this={picker} onchange={(event) => { void upload((event.currentTarget as HTMLInputElement).files); (event.currentTarget as HTMLInputElement).value = ""; }} />
    {#if folderNames.length}<select class="admin-compact" bind:value={folderFilter} aria-label={t("admin.media.folder")} data-testid="admin-media-folder-filter"><option value="">{t("admin.media.allFolders")}</option>{#each folderNames as name (name)}<option value={name}>{name}</option>{/each}</select>{/if}
    <label class="admin-check"><input type="checkbox" checked={onlyUnused} onchange={(event) => void showUnused(event.currentTarget.checked)} data-testid="admin-media-unused" /> {t("admin.media.unused")}</label>
    {#if onlyUnused && shown.length}<button class="button outline small" onclick={() => void onTrash(shown.map((asset) => asset.id))}>{t("admin.media.trashUnused", { n: shown.length })}</button>{/if}
    <button class="button primary small" disabled={uploading} onclick={() => picker?.click()}>＋ {t("admin.media.upload")}</button>
  </div>
  {#if shown.length}
    <ul class="admin-media">
      {#each shown as asset (asset.id)}
        <li>
          {#if asset.mimeType.startsWith("image/")}<img src="/__cms-media/{encodeURIComponent(projectId)}/{asset.id}" alt={asset.alt} loading="lazy" />{:else}<span class="admin-file">{asset.mimeType}</span>{/if}
          <strong title={asset.filename}>{asset.filename}</strong>
          {#if asset.mimeType.startsWith("image/") && asset.mimeType !== "image/svg+xml"}<button class="button text small" onclick={() => { cropping = asset; cropRatio = 0; cropTurn = 0; }}>{t("admin.media.crop")}</button>{/if}
          <label class="field-label">{t("admin.media.folder")}<input list="admin-media-folders" value={folders[asset.id] ?? ""} onchange={(event) => void setFolder(asset, event.currentTarget.value)} data-testid="admin-media-folder" /></label>
          <label class="field-label">{t("admin.media.alt")}<input value={asset.alt} onchange={(event) => void save(asset, { alt: (event.currentTarget as HTMLInputElement).value })} /></label>
          <label class="field-label">{t("admin.media.caption")}<input value={asset.caption} onchange={(event) => void save(asset, { caption: (event.currentTarget as HTMLInputElement).value })} /></label>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="admin-empty"><p>{assets.length ? t("admin.noMatch") : t("admin.media.empty")}</p></div>
  {/if}
</div>
<datalist id="admin-media-folders">{#each folderNames as name (name)}<option value={name}></option>{/each}</datalist>
{#if cropping}
  {@const asset = cropping}
  <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) cropping = null; }}>
    <div class="modal-card admin-crop" role="dialog" aria-modal="true" aria-label={t("admin.media.crop")} data-testid="admin-crop">
      <h2>{t("admin.media.crop")}</h2>
      <div class="admin-crop-view"><img src="/__cms-media/{encodeURIComponent(projectId)}/{asset.id}" alt="" style:transform="rotate({cropTurn * 90}deg)" style:aspect-ratio={cropRatio || "auto"} /></div>
      <div class="admin-actions">
        {#each [[0, "admin.media.cropFree"], [1, "1:1"], [4 / 3, "4:3"], [16 / 9, "16:9"]] as const as [ratio, label] (label)}<button class="button outline small" aria-pressed={cropRatio === ratio} onclick={() => { cropRatio = ratio; }}>{label.includes(":") ? label : t(label)}</button>{/each}
        <button class="button outline small" onclick={() => { cropTurn = (cropTurn + 1) % 4; }}>{t("admin.media.rotate")}</button>
      </div>
      <div class="admin-actions"><button class="button text" onclick={() => { cropping = null; }}>{t("common.cancel")}</button><button class="button primary" onclick={() => void saveCrop(asset)}>{t("admin.media.saveCopy")}</button></div>
    </div>
  </div>
{/if}
