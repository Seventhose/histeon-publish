<script lang="ts">
  import { t, tn } from '../lib/i18n.ts';
  import { tick, untrack } from 'svelte';
  import type { BuilderConfig } from '../lib/config.ts';
  import { fileHref, imageAttributes, LINK_KINDS, mediaElement, mediaFilter, mediaKind, type MediaItem, type MediaKind } from '../lib/media.ts';
  import { PRESETS, collectionTree, collectionsUrl, compress, fromSite, type Collection, type Preset, type SitePreset } from '../lib/mediaManager.ts';
  import { IN_PLACE, MediaLibrary } from '../lib/mediaLibrary.ts';

  // Media manager on the WordPress REST API (docs/spec/media.md): nested collections, several uploads with their
  // progress, compression in the browser before sending, alt text. WordPress's own permissions apply
  // (upload_files). The block editor's media modal needs 'unsafe-eval', which the builder's CSP does not allow.
  let { config }: { config: BuilderConfig } = $props();

  type Item = MediaItem & { xb_media_collection?: number[]; date?: string; xb_compressed?: { before: number; after: number; at: number } | null };
  type Usage = { items: Array<{ id: number; title: string; type: string; status: string; featured: boolean; link: string }>; hidden: number };

  let dialog: HTMLDialogElement;
  let search = $state<HTMLInputElement | null>(null);
  let items = $state<Item[]>([]);
  let query = $state('');
  let page = $state(1);
  let more = $state(false);
  let busy = $state(false);
  let message = $state('');
  let collections = $state<Collection[]>([]);
  /** 0: every image; -1: images in no collection. */
  let current = $state(0);
  let newCollection = $state('');
  // The configuration is fixed for the life of the page.
  const library = untrack(() => new MediaLibrary(config.media.url, config.restUrl, config.nonce, config.media.encoder, config.media.maxBytes));
  /** The site's own presets (doc 26 voce 209), after Histeon's. */
  let sitePresets = $state<SitePreset[]>([]);
  const allPresets = $derived<Preset[]>([...PRESETS, ...sitePresets.map(fromSite)]);
  const PRESET_KEY = 'xb-media-preset';
  /** The preset last used, a convenience of this browser only. */
  let presetId = $state(remembered());
  const preset = $derived(allPresets.find((p) => p.id === presetId) ?? PRESETS[0]!);
  function remembered(): string {
    try {
      return localStorage.getItem(PRESET_KEY) ?? 'web';
    } catch {
      return 'web';
    }
  }
  $effect(() => {
    try {
      localStorage.setItem(PRESET_KEY, presetId);
    } catch {
      /* Storage unavailable: the choice lasts for the page. */
    }
  });
  let presetsOpen = $state(false);
  let draft = $state({ label: '', max: 1600, avif: true, webp: true, quality: 70 });
  let presetError = $state('');
  async function loadPresets() {
    try {
      sitePresets = await library.presets();
    } catch {
      sitePresets = [];
    }
  }
  async function savePresets(next: SitePreset[]) {
    presetError = '';
    try {
      sitePresets = await library.savePresets(next);
    } catch (e) {
      presetError = e instanceof Error ? e.message : String(e);
    }
  }
  function addPreset(event: SubmitEvent) {
    event.preventDefault();
    const label = draft.label.trim();
    if (!label) return;
    const formats = [...(draft.avif ? (['avif'] as const) : []), ...(draft.webp ? (['webp'] as const) : [])];
    const id = label.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || `preset-${sitePresets.length + 1}`;
    void savePresets([...sitePresets, { id, label, max: Math.max(0, Math.round(draft.max)), formats: formats.length ? formats : ['avif', 'webp'], quality: Math.round(draft.quality) }]).then(() => {
      presetId = id;
      draft = { ...draft, label: '' };
    });
  }
  /** Making the open image lighter where it is (voce 209), and putting the original back. */
  let compressing = $state(false);
  let compressNote = $state('');
  async function compressDetails() {
    if (!details) return;
    compressing = true;
    compressNote = '';
    try {
      const done = await library.compressInPlace(details.id, preset);
      if (!done.saved) compressNote = t('Già leggera: con «{0}» non si guadagna nulla.', preset.label);
      else {
        compressNote = t('Da {0} a {1} (−{2}%). Stesso indirizzo; l’originale resta per «Ripristina».', size(done.before), size(done.after), Math.round((1 - done.after / done.before) * 100));
        await refreshDetails();
      }
    } catch (e) {
      compressNote = e instanceof Error ? e.message : String(e);
    } finally {
      compressing = false;
    }
  }
  async function restoreDetails() {
    if (!details) return;
    compressing = true;
    try {
      await library.restore(details.id);
      compressNote = t('Rimesso l’originale.');
      await refreshDetails();
    } catch (e) {
      compressNote = e instanceof Error ? e.message : String(e);
    } finally {
      compressing = false;
    }
  }
  async function refreshDetails() {
    if (!details) return;
    const url = mediaRoute(`/${details.id}`);
    url.searchParams.set('_fields', FIELDS);
    const { data } = await request<Item>(url);
    items = items.map((i) => (i.id === data.id ? data : i));
    details = data;
  }
  let uploads = $state<Array<{ name: string; progress: number; error: string }>>([]);
  let details = $state<Item | null>(null);
  let alt = $state('');
  /**
   * Images only (an image to place), or video, audio and PDF too (M1), with a filter by kind; or the library on
   * its own (E1): a click shows a file's details, where it is used, and a button to insert it in the page. Or a file
   * to link (`link`, doc 23 of Publish, item 176): an image or a PDF, whose address goes into the link.
   */
  let mode = $state<'image' | 'any' | 'browse' | 'link'>('image');
  let caption = $state('');
  /** Null: the caption could not be read for editing (another author's file), so it is not offered. */
  let captionEditable = $state(false);
  let usage = $state<Usage | null>(null);
  let usageError = $state('');
  let kind = $state<MediaKind | 'all'>('all');
  type Element = ReturnType<typeof mediaElement>;
  let resolve: ((value: Record<string, string> | Element | string | null) => void) | null = null;
  const ACCEPT_ANY = 'image/*,video/*,audio/*,application/pdf';
  const FIELDS = 'id,source_url,alt_text,title,media_details,mime_type,date,xb_media_collection,xb_compressed';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tree = $derived(collectionTree(collections));

  /** Opens the manager; resolves with the <img> attributes of the chosen image, or null. */
  export async function pick(): Promise<Record<string, string> | null> {
    mode = 'image';
    return (await open()) as Record<string, string> | null;
  }

  /** Opens the manager on every kind of file: resolves with the element to insert (img, video, audio, link), or null. */
  export async function pickMedia(): Promise<Element | null> {
    mode = 'any';
    kind = 'all';
    return (await open()) as Element | null;
  }

  /** A file to link from the Properties panel (item 176): resolves with its address for `href`, or null. PDF first. */
  export async function pickFile(): Promise<string | null> {
    mode = 'link';
    kind = 'pdf';
    return (await open()) as string | null;
  }

  /** The whole library, from the rail (E1): resolves with the element to insert when one is chosen, or null. */
  export async function browse(): Promise<Element | null> {
    mode = 'browse';
    kind = 'all';
    return (await open()) as Element | null;
  }

  async function open(): Promise<Record<string, string> | Element | string | null> {
    resolve?.(null);
    query = '';
    message = '';
    details = null;
    dialog.showModal();
    // Focus first: moving it after the loads would take it from a field the user is already typing in.
    await tick();
    search?.focus();
    const chosen = new Promise<Record<string, string> | Element | string | null>((done) => (resolve = done));
    await Promise.all([load(true), loadCollections(), config.media.canUpload ? loadPresets() : null]);
    return chosen;
  }

  const headers = (): Record<string, string> => ({ 'X-WP-Nonce': config.nonce });
  /** A route under wp/v2/media (the item `5` → …/media/5), with pretty or plain permalinks. */
  function mediaRoute(suffix = ''): URL {
    const base = config.media.url ?? '';
    const at = base.indexOf('?rest_route=');
    return new URL(at === -1 ? base + suffix : base + suffix, window.location.href);
  }

  async function request<T>(url: URL, init: RequestInit = {}): Promise<{ data: T; response: Response }> {
    const response = await fetch(url, { credentials: 'same-origin', ...init, headers: { ...headers(), ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) } });
    const data = (await response.json().catch(() => null)) as T & { message?: string };
    if (!response.ok) throw new Error((data as { message?: string } | null)?.message ?? t('Errore {0}', response.status));
    return { data, response };
  }

  async function loadCollections() {
    if (!config.media.url) return;
    try {
      const url = new URL(collectionsUrl(config.media.url), window.location.href);
      url.searchParams.set('per_page', '100');
      url.searchParams.set('_fields', 'id,name,parent,count');
      collections = (await request<Collection[]>(url)).data;
    } catch {
      collections = []; // Collections are optional: the library still works.
    }
  }

  async function load(reset: boolean) {
    if (!config.media.url) {
      message = t('Libreria media non disponibile.');
      return;
    }
    busy = true;
    try {
      const next = reset ? 1 : page + 1;
      const url = mediaRoute();
      for (const [key, value] of Object.entries(mediaFilter(mode === 'image' ? 'image' : kind))) url.searchParams.set(key, value);
      url.searchParams.set('per_page', '30');
      url.searchParams.set('page', String(next));
      url.searchParams.set('_fields', FIELDS);
      if (query.trim()) url.searchParams.set('search', query.trim());
      if (current > 0) url.searchParams.set('xb_media_collection', String(current));
      if (current === -1 && collections.length) url.searchParams.set('xb_media_collection_exclude', collections.map((c) => c.id).join(','));
      const { data, response } = await request<Item[]>(url);
      items = reset ? data : [...items, ...data];
      page = next;
      more = next < Number(response.headers.get('X-WP-TotalPages') ?? '1');
      message = items.length ? '' : mode === 'image' ? t('Nessuna immagine.') : t('Nessun file.');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function onsearch() {
    clearTimeout(timer);
    timer = setTimeout(() => void load(true), 300);
  }

  function show(id: number) {
    current = id;
    void load(true);
  }

  async function addCollection(event: SubmitEvent) {
    event.preventDefault();
    const name = newCollection.trim();
    if (!name || !config.media.url) return;
    try {
      const url = new URL(collectionsUrl(config.media.url), window.location.href);
      await request(url, { method: 'POST', body: JSON.stringify({ name, ...(current > 0 ? { parent: current } : {}) }) });
      newCollection = '';
      await loadCollections();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }

  /** One upload with its progress (fetch has none): XMLHttpRequest, same nonce and cookies. */
  function send(file: File, onprogress: (p: number) => void): Promise<Item> {
    return new Promise((done, fail) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', mediaRoute().toString());
      xhr.setRequestHeader('X-WP-Nonce', config.nonce);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => e.lengthComputable && onprogress(e.loaded / e.total);
      xhr.onload = () => {
        let data: (Item & { message?: string }) | null = null;
        try {
          data = JSON.parse(xhr.responseText) as Item & { message?: string };
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && data) done(data);
        else fail(new Error(data?.message ?? t('Errore {0}', xhr.status)));
      };
      xhr.onerror = () => fail(new Error(t('Rete non raggiungibile.')));
      const body = new FormData();
      body.append('file', file, file.name);
      xhr.send(body);
    });
  }

  async function upload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []).slice(0, 20);
    input.value = '';
    if (!files.length || !config.media.url) return;
    message = '';
    uploads = files.map((f) => ({ name: f.name, progress: 0, error: '' }));
    for (const [i, original] of files.entries()) {
      const row = uploads[i]!;
      try {
        const image = original.type.startsWith('image/');
        const uploadKind = mediaKind({ id: 0, source_url: '', mime_type: original.type });
        if (!image && (mode === 'image' || !uploadKind || (mode === 'link' && !LINK_KINDS.includes(uploadKind)))) throw new Error(mode === 'image' ? t("non è un'immagine") : t('tipo di file non ammesso qui'));
        // Only images are compressed in the browser; video, audio and PDF go as they are.
        const file = image ? await compress(original, preset, config.media.encoder) : original;
        if (config.media.maxBytes && file.size > config.media.maxBytes) throw new Error(t('supera {0} MB', Math.round(config.media.maxBytes / 1048576)));
        const item = await send(file, (p) => (row.progress = p));
        if (current > 0) {
          await request(mediaRoute(`/${item.id}`), { method: 'POST', body: JSON.stringify({ xb_media_collection: [current] }) });
          item.xb_media_collection = [current];
        }
        row.progress = 1;
        items = [item, ...items];
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }
    }
    void loadCollections();
    if (uploads.every((u) => !u.error)) setTimeout(() => (uploads = []), 1500);
  }

  function openDetails(item: Item, event?: Event) {
    event?.stopPropagation();
    details = item;
    alt = item.alt_text ?? '';
    if (mode !== 'browse') return;
    caption = '';
    captionEditable = false;
    usage = null;
    usageError = '';
    void loadCaption(item.id);
    void loadUsage(item.id);
  }

  /** The caption as written (context=edit): only for files this user may edit. */
  async function loadCaption(id: number) {
    try {
      const url = mediaRoute(`/${id}`);
      url.searchParams.set('context', 'edit');
      url.searchParams.set('_fields', 'id,caption');
      const { data } = await request<{ id: number; caption?: { raw?: string } }>(url);
      if (details?.id !== id) return;
      caption = data.caption?.raw ?? '';
      captionEditable = config.media.canUpload;
    } catch {
      captionEditable = false;
    }
  }

  async function loadUsage(id: number) {
    try {
      const response = await fetch(`${config.restUrl}media/${id}/usage`, { credentials: 'same-origin', headers: headers() });
      const data = (await response.json().catch(() => null)) as (Usage & { message?: string }) | null;
      if (!response.ok || !data) throw new Error(data?.message ?? t('Errore {0}', response.status));
      if (details?.id === id) usage = data;
    } catch (e) {
      if (details?.id === id) usageError = e instanceof Error ? e.message : String(e);
    }
  }

  async function copyUrl() {
    if (!details) return;
    try {
      await navigator.clipboard.writeText(details.source_url);
      message = t('Indirizzo copiato.');
    } catch {
      message = t('Il browser non ha dato accesso agli appunti.');
    }
  }

  /** The file's page in WordPress, next to the document's own edit link. */
  function wpEdit(id: number): string | null {
    if (!config.editUrl) return null;
    const url = new URL(config.editUrl, window.location.href);
    url.searchParams.set('post', String(id));
    url.searchParams.set('action', 'edit');
    return url.toString();
  }

  function size(bytes: number | undefined): string {
    if (!bytes) return '';
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
  }

  async function saveDetails(collectionIds: number[]) {
    if (!details) return;
    try {
      const fields: Record<string, unknown> = { alt_text: alt, xb_media_collection: collectionIds };
      if (mode === 'browse' && captionEditable) fields.caption = caption;
      const { data } = await request<Item>(mediaRoute(`/${details.id}`), { method: 'POST', body: JSON.stringify(fields) });
      items = items.map((i) => (i.id === data.id ? { ...i, alt_text: data.alt_text, xb_media_collection: data.xb_media_collection } : i));
      details = { ...details, alt_text: data.alt_text, xb_media_collection: data.xb_media_collection ?? collectionIds };
      message = mode === 'browse' ? t('File aggiornato.') : t('Immagine aggiornata.');
      void loadCollections();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }

  function toggleCollection(id: number, on: boolean) {
    const now = details?.xb_media_collection ?? [];
    void saveDetails(on ? [...new Set([...now, id])] : now.filter((x) => x !== id));
  }

  function choose(item: MediaItem) {
    try {
      const attrs = mode === 'image' ? imageAttributes(item) : mode === 'link' ? fileHref(item) : mediaElement(item, title(item));
      dialog.close();
      resolve?.(attrs);
      resolve = null;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }

  function title(item: MediaItem): string {
    const doc = new DOMParser().parseFromString(item.title?.rendered ?? '', 'text/html');
    return (doc.body.textContent ?? '').trim() || `#${item.id}`;
  }

  function thumb(item: MediaItem): string {
    const sizes = item.media_details?.sizes ?? {};
    return (sizes.medium ?? sizes.thumbnail)?.source_url ?? item.source_url;
  }

  function onclose() {
    resolve?.(null);
    resolve = null;
  }
</script>

<dialog bind:this={dialog} class="media" aria-label={t('Gestore dei media')} {onclose}>
  <header>
    <input bind:this={search} bind:value={query} oninput={onsearch} placeholder={t('Cerca nella libreria…')} aria-label={mode === 'image' ? t('Cerca immagini') : t('Cerca nella libreria')} />
    {#if mode === 'link'}
      <!-- A link points to an image or a PDF: what a transfer of Histeon CMS carries (item 176). -->
      <select value={kind} onchange={(e) => ((kind = e.currentTarget.value as MediaKind), void load(true))} aria-label={t('Tipo di file')}>
        <option value="pdf">PDF</option>
        <option value="image">{t('Immagini')}</option>
      </select>
    {:else if mode !== 'image'}
      <select value={kind} onchange={(e) => ((kind = e.currentTarget.value as MediaKind | 'all'), void load(true))} aria-label={t('Tipo di file')}>
        <option value="all">{t('Tutti i file')}</option>
        <option value="image">{t('Immagini')}</option>
        <option value="video">{t('Video')}</option>
        <option value="audio">{t('Audio')}</option>
        <option value="pdf">PDF</option>
      </select>
    {/if}
    {#if config.media.canUpload}
      <select bind:value={presetId} aria-label={t('Compressione prima del caricamento')} title={t("Ridimensiona e converte nel browser, prima di inviare: tiene AVIF o WebP, il più leggero, solo se pesa meno dell'originale")}>
        {#each allPresets as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
      </select>
      <button onclick={() => (presetsOpen = !presetsOpen)} aria-expanded={presetsOpen}>{t('Preset…')}</button>
      <label class="upload">{t('Carica')}<input type="file" accept={mode === 'image' ? 'image/*' : mode === 'link' ? 'image/*,application/pdf' : ACCEPT_ANY} multiple onchange={upload} hidden /></label>
    {/if}
    <button onclick={() => dialog.close()} aria-label={t('Chiudi')}>✕</button>
  </header>
  {#if presetsOpen && config.media.canUpload}
    <section class="presets" aria-label={t('Preset del sito')}>
      <p class="hint">{t('Preset del sito per caricare e comprimere: lato più lungo (0 = misura originale), formati provati al caricamento, qualità. L’ultimo usato resta scelto in questo browser.')}</p>
      {#if sitePresets.length}
        <ul>
          {#each sitePresets as p (p.id)}
            <li>{p.label} <small>{p.max ? `${p.max} px` : t('misura originale')} · {p.formats.join(', ').toUpperCase()} · {t('qualità {0}', p.quality)}</small> <button aria-label={t('Togli il preset {0}', p.label)} onclick={() => void savePresets(sitePresets.filter((x) => x.id !== p.id))}>×</button></li>
          {/each}
        </ul>
      {/if}
      <form onsubmit={addPreset}>
        <label>{t('Nome')} <input bind:value={draft.label} maxlength="40" required /></label>
        <label>{t('Lato più lungo')} <input type="number" bind:value={draft.max} min="0" max="8000" step="10" /></label>
        <label><input type="checkbox" bind:checked={draft.avif} /> AVIF</label>
        <label><input type="checkbox" bind:checked={draft.webp} /> WebP</label>
        <label>{t('Qualità')} <input type="number" bind:value={draft.quality} min="30" max="95" /></label>
        <button type="submit" disabled={!draft.label.trim()}>{t('Aggiungi il preset')}</button>
      </form>
      {#if presetError}<p class="error" role="alert">{presetError}</p>{/if}
    </section>
  {/if}
  {#if message}<p class="message" role="status">{message}</p>{/if}
  {#if uploads.length}
    <ul class="uploads" aria-label={t('Caricamenti')}>
      {#each uploads as u (u.name)}
        <li><span>{u.name}</span>{#if u.error}<em>{u.error}</em>{:else}<progress max="1" value={u.progress}></progress>{/if}</li>
      {/each}
    </ul>
  {/if}
  <div class="body">
    <nav class="collections" aria-label={t('Raccolte')}>
      <button class:active={current === 0} onclick={() => show(0)}>{mode === 'image' ? t('Tutte le immagini') : t('Tutti i file')}</button>
      {#if collections.length}<button class:active={current === -1} onclick={() => show(-1)}>{t('Senza raccolta')}</button>{/if}
      {#each tree as c (c.id)}
        <button class:active={current === c.id} style:padding-left="{10 + c.depth * 14}px" onclick={() => show(c.id)}>{c.name} <small>{c.count}</small></button>
      {/each}
      {#if config.media.canUpload}
        <form onsubmit={addCollection}>
          <input bind:value={newCollection} placeholder={current > 0 ? t('Sottoraccolta…') : t('Nuova raccolta…')} aria-label={t('Nome della nuova raccolta')} />
        </form>
      {/if}
    </nav>
    <ul class="grid">
      {#each items as item (item.id)}
        <li>
          <button onclick={() => (mode === 'browse' ? openDetails(item) : choose(item))} title={title(item)} aria-pressed={mode === 'browse' ? details?.id === item.id : undefined}>
            {#if mediaKind(item) === 'image' || mode === 'image'}
              <img src={thumb(item)} alt={item.alt_text ?? ''} loading="lazy" />
            {:else}
              <span class="kind" aria-hidden="true">{mediaKind(item) === 'video' ? '▶' : mediaKind(item) === 'audio' ? '♪' : 'PDF'}</span>
            {/if}
            <span>{title(item)}</span>
          </button>
          {#if config.media.canUpload && mode !== 'browse'}<button class="more" onclick={(e) => openDetails(item, e)} aria-label={t('Dettagli di {0}', title(item))} title={t('Testo alternativo e raccolte')}>⋯</button>{/if}
        </li>
      {/each}
    </ul>
    {#if details}
      {@const fileKind = mediaKind(details)}
      <aside class="details" aria-label={fileKind === 'image' ? t("Dettagli dell'immagine") : t('Dettagli del file')}>
        {#if fileKind === 'image' || mode === 'image'}<img src={thumb(details)} alt="" />{:else}<span class="kind" aria-hidden="true">{fileKind === 'video' ? '▶' : fileKind === 'audio' ? '♪' : 'PDF'}</span>{/if}
        <strong>{title(details)}</strong>
        {#if mode === 'browse'}
          <dl class="facts">
            {#if details.mime_type}<dt>{t('Tipo')}</dt><dd>{details.mime_type}</dd>{/if}
            {#if details.media_details?.width && details.media_details?.height}<dt>{t('Dimensioni')}</dt><dd>{details.media_details.width} × {details.media_details.height} px</dd>{/if}
            {#if details.media_details?.filesize}<dt>{t('Peso')}</dt><dd>{size(details.media_details.filesize)}</dd>{/if}
            {#if details.date}<dt>{t('Caricato il')}</dt><dd>{new Date(details.date).toLocaleDateString()}</dd>{/if}
          </dl>
          <div class="url">
            <input readonly value={details.source_url} aria-label={t('Indirizzo del file')} onfocus={(e) => e.currentTarget.select()} />
            <button onclick={copyUrl}>{t('Copia')}</button>
          </div>
        {/if}
        {#if config.media.canUpload}
          {#if fileKind === 'image' || mode === 'image'}<label>{t('Testo alternativo')}<textarea bind:value={alt} rows="3"></textarea></label>{/if}
          {#if mode === 'browse' && captionEditable}<label>{t('Didascalia')}<textarea bind:value={caption} rows="2"></textarea></label>{/if}
          <button onclick={() => saveDetails(details?.xb_media_collection ?? [])}>{mode === 'browse' ? t('Salva i dettagli') : t('Salva testo alternativo')}</button>
          {#if fileKind === 'image' && IN_PLACE.includes(details.mime_type ?? '')}
            <section class="lighter" aria-label={t('Rendi più leggera')}>
              <button onclick={() => void compressDetails()} disabled={compressing} title={t('Ridimensiona e ricomprime l’immagine nello stesso formato, al suo posto: l’indirizzo e le misure di WordPress restano, l’originale si può rimettere.')}>{compressing ? t('Comprimo…') : t('Comprimi con «{0}»', preset.label)}</button>
              {#if details.xb_compressed}
                <p class="hint">{t('Compressa: da {0} a {1}.', size(details.xb_compressed.before), size(details.xb_compressed.after))} <button class="link" onclick={() => void restoreDetails()} disabled={compressing}>{t('Ripristina l’originale')}</button></p>
              {/if}
              {#if compressNote}<p class="hint" role="status">{compressNote}</p>{/if}
            </section>
          {:else if fileKind === 'image' && details.mime_type === 'image/avif'}
            <p class="hint">{t('Le immagini AVIF non si comprimono sul posto: sono già nel formato più leggero.')}</p>
          {/if}
          {#if tree.length}
            <fieldset>
              <legend>{t('Raccolte')}</legend>
              {#each tree as c (c.id)}
                <label style:padding-left="{c.depth * 12}px"><input type="checkbox" checked={(details.xb_media_collection ?? []).includes(c.id)} onchange={(e) => toggleCollection(c.id, e.currentTarget.checked)} /> {c.name}</label>
              {/each}
            </fieldset>
          {/if}
        {/if}
        {#if mode === 'browse'}
          <section class="usage" aria-label={t('Dove è usato')}>
            <h4>{t('Dove è usato')}</h4>
            {#if usageError}<p class="error">{usageError}</p>
            {:else if !usage}<p>{t('Cerco…')}</p>
            {:else if !usage.items.length && !usage.hidden}<p>{t('Non risulta usato in nessun contenuto.')}</p>
            {:else}
              <ul>
                {#each usage.items as u (u.id)}
                  <li><a href={u.link} target="_blank" rel="noopener">{u.title || t('(senza titolo)')}</a> <small>{u.type}{u.status !== 'publish' ? ` · ${u.status}` : ''}{u.featured ? ` · ${t('immagine in evidenza')}` : ''}</small></li>
                {/each}
              </ul>
              {#if usage.hidden}<p>{tn('E in {0} contenuto che non puoi modificare.', 'E in {0} contenuti che non puoi modificare.', usage.hidden, usage.hidden)}</p>{/if}
            {/if}
          </section>
        {/if}
        <div class="row">
          <button class="primary" onclick={() => details && choose(details)}>{mode === 'browse' ? t('Inserisci nella pagina') : t('Usa questa immagine')}</button>
          {#if mode === 'browse' && wpEdit(details.id)}<a class="button" href={wpEdit(details.id)} target="_blank" rel="noopener">{t('Apri in WordPress')}</a>{/if}
          <button onclick={() => (details = null)}>{t('Chiudi')}</button>
        </div>
      </aside>
    {/if}
  </div>
  {#if more}<footer><button onclick={() => void load(false)} disabled={busy}>{mode === 'image' ? t('Altre immagini') : t('Altri file')}</button></footer>{/if}
</dialog>

<style>
  .media { width: min(1100px, 96vw); height: min(720px, 90vh); padding: 0; border: 1px solid var(--xb-line); border-radius: 10px; background: var(--xb-panel); color: var(--xb-text); }
  .media[open] { display: grid; grid-template-rows: auto auto auto 1fr auto; }
  .media::backdrop { background: rgb(0 0 0 / 0.4); }
  /* Over the grid, under the header: the dialog's rows stay as they are. */
  .presets { position: absolute; z-index: 3; top: 52px; right: 10px; width: min(560px, calc(100% - 20px)); padding: 10px; border: 1px solid var(--xb-line); border-radius: 8px; background: var(--xb-panel); box-shadow: var(--xb-shadow); font-size: 12px; }
  .presets ul { list-style: none; margin: 0 0 6px; padding: 0; display: grid; gap: 2px; }
  .presets form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
  .presets input[type='number'] { width: 6em; }
  .lighter { display: grid; gap: 4px; }
  .hint { color: var(--xb-muted); margin: 0; font-size: 12px; }
  button.link { border: 0; background: none; padding: 0; color: var(--xb-link); text-decoration: underline; cursor: pointer; }
  header { display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid var(--xb-line); }
  header input, header select { font: 13px var(--xb-sans); padding: 6px 8px; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  header input { flex: 1; }
  button, .upload { font: 12px var(--xb-sans); padding: 6px 12px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  .message { margin: 0; padding: 8px 12px; color: var(--xb-muted); }
  .uploads { list-style: none; margin: 0; padding: 6px 12px; display: grid; gap: 4px; font-size: 12px; border-bottom: 1px solid var(--xb-line); }
  .uploads li { display: grid; grid-template-columns: minmax(0, 1fr) 160px; gap: 8px; align-items: center; }
  .uploads span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .uploads em { color: var(--xb-danger); font-style: normal; }
  .body { display: grid; grid-template-columns: 200px minmax(0, 1fr) auto; min-height: 0; }
  .collections { display: grid; align-content: start; gap: 2px; padding: 8px; border-right: 1px solid var(--xb-line); overflow: auto; }
  .collections button { border: 0; text-align: left; padding: 5px 10px; border-radius: var(--xb-r-sm); }
  .collections button.active { background: var(--xb-accent-bg); }
  .collections small { color: var(--xb-muted); margin-left: 4px; }
  .collections input { width: 100%; margin-top: 6px; font: 12px var(--xb-sans); padding: 5px 8px; border: 1px dashed var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); }
  .grid { list-style: none; margin: 0; padding: 10px; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; align-content: start; }
  .grid li { position: relative; }
  .grid li > button:first-child { width: 100%; padding: 0; display: grid; gap: 4px; text-align: left; border: 1px solid var(--xb-line); overflow: hidden; }
  .grid li > button:first-child:hover, .grid li > button:first-child:focus-visible { border-color: var(--xb-accent); }
  .grid img { width: 100%; aspect-ratio: 1; object-fit: cover; background: #fff; }
  .grid span { padding: 0 6px 6px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .more { position: absolute; top: 4px; right: 4px; padding: 0 7px; background: var(--xb-bg); }
  .details { width: 260px; display: grid; gap: 8px; align-content: start; padding: 10px; border-left: 1px solid var(--xb-line); overflow: auto; font-size: 12px; }
  .details img { width: 100%; border-radius: var(--xb-r); background: #fff; }
  .details label { display: grid; gap: 4px; }
  .details textarea { font: 12px var(--xb-sans); padding: 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); }
  .details fieldset { border: 1px solid var(--xb-line); border-radius: var(--xb-r); display: grid; gap: 4px; }
  .details fieldset label { display: flex; gap: 6px; align-items: center; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .row a.button { font: 12px var(--xb-sans); padding: 6px 12px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); color: var(--xb-text); text-decoration: none; }
  .details .kind { display: grid; place-items: center; aspect-ratio: 16 / 9; border-radius: var(--xb-r); background: var(--xb-stage); color: var(--xb-muted); font: 600 22px var(--xb-sans); }
  .facts { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 0; }
  .facts dt { color: var(--xb-muted); }
  .facts dd { margin: 0; overflow-wrap: anywhere; }
  .url { display: flex; gap: 4px; }
  .url input { flex: 1; min-width: 0; font: 11px var(--xb-mono); padding: 5px 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); }
  .usage h4 { margin: 4px 0; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-muted); }
  .usage ul { margin: 0; padding-left: 16px; display: grid; gap: 2px; }
  .usage p { margin: 0; color: var(--xb-muted); }
  .usage .error { color: var(--xb-danger); }
  .grid li > button[aria-pressed='true'] { border-color: var(--xb-accent); box-shadow: 0 0 0 1px var(--xb-accent); }
  footer { padding: 8px; text-align: center; }
  .grid .kind {
    display: grid;
    place-items: center;
    width: 100%;
    aspect-ratio: 1;
    background: var(--xb-stage);
    color: var(--xb-muted);
    font: 600 22px var(--xb-sans);
  }
</style>
