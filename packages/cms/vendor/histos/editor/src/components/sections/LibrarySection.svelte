<script lang="ts">
  import { sectionBrief } from '../../lib/sectionBrief.ts';
  import type { XbBlock } from '@xb/dsl';
  import { t, tn, dateLocale } from '../../lib/i18n.ts';
    import { makeClip, readClip, type Clip } from '../../lib/clip.ts';
  import type { LibrarySection } from '../../lib/api.ts';
  import type { BuilderState } from '../../lib/state.svelte.ts';

  // Section library (docs/spec/library.md): the selected element saved by name, inserted again through the paste
  // dialog (class conflicts), and moved between sites as a .xblibrary file.
  let { app, oninsert, onagent }: { app: BuilderState; oninsert: (clip: Clip) => void; onagent?: (name: string, brief: string) => void } = $props();

  let sections = $state<LibrarySection[]>([]);
  let name = $state('');
  let query = $state('');
  let message = $state('');
  let busy = $state(false);
  let file: HTMLInputElement;

  const selected = $derived(app.selected ? app.find(app.selected) : null);
  const shown = $derived(sections.filter((s) => query.trim() === '' || s.name.toLowerCase().includes(query.trim().toLowerCase())));

  async function load() {
    try {
      sections = (await app.api.listSections()).sections;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
  }
  $effect(() => {
    void load();
  });

  async function run(task: () => Promise<string>) {
    busy = true;
    try {
      message = await task();
      await load();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function save() {
    const block = selected;
    if (!block) return;
    void run(async () => {
      const clip = makeClip([$state.snapshot(block) as XbBlock], $state.snapshot(app.styles), window.location.hostname);
      await app.api.saveSection(name.trim(), JSON.stringify(clip));
      const saved = name.trim();
      name = '';
      return t('«{0}» salvata nella libreria.', saved);
    });
  }

  function insert(section: LibrarySection) {
    void run(async () => {
      const clip = readClip((await app.api.getSection(section.id)).clip);
      if (!clip) throw new Error(t('Sezione non valida.'));
      oninsert(clip);
      return '';
    });
  }

  /** Lista della spesa 166: the agent rebuilds the section with this project's tokens, from its brief. */
  function askAgent(section: LibrarySection) {
    void run(async () => {
      const clip = readClip((await app.api.getSection(section.id)).clip);
      if (!clip) throw new Error(t('Sezione non valida.'));
      onagent?.(section.name, sectionBrief(section.name, clip, app.framework.variables));
      return t('Richiesta mandata all’agente: la trovi nel pannello ✦ AI.');
    });
  }

  function remove(section: LibrarySection) {
    if (!window.confirm(t('Togliere «{0}» dalla libreria?', section.name))) return;
    void run(async () => {
      await app.api.deleteSection(section.id);
      return t('«{0}» tolta dalla libreria.', section.name);
    });
  }

  function exportFile() {
    void run(async () => {
      const data = await app.api.exportSections();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
      link.download = `libreria-${window.location.hostname}.xblibrary`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      return t('Libreria esportata.');
    });
  }

  function importFile(event: Event) {
    const chosen = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!chosen) return;
    void run(async () => {
      if (chosen.size > 50_000_000) throw new Error(t('File troppo grande.'));
      let data: unknown;
      try {
        data = JSON.parse(await chosen.text());
      } catch {
        throw new Error(t('Il file non è una libreria di Histeon.'));
      }
      const result = await app.api.importSections(data);
      file.value = '';
      const pictures = result.media ? ' ' + tn('Con {0} immagine caricata qui.', 'Con {0} immagini caricate qui.', result.media, result.media) : '';
      return t('Importate {0} sezioni; {1} c\'erano già.', result.added, result.skipped) + pictures;
    });
  }

  const date = (gmt: string) => new Date(`${gmt.replace(' ', 'T')}Z`).toLocaleDateString(dateLocale());
</script>

<div class="section">
  <div class="save">
    {#if selected}
      <label for="xb-lib-name">{t('Salva l\'elemento selezionato')}</label>
      <div class="row">
        <input id="xb-lib-name" bind:value={name} maxlength="80" placeholder={t('Nome della sezione (es. Hero con immagine)')} />
        <button class="primary" onclick={save} disabled={busy || name.trim() === ''}>{t('Salva nella libreria')}</button>
      </div>
    {:else}
      <p class="muted">{t('Seleziona un elemento della pagina per salvarlo nella libreria, con gli stili delle sue classi.')}</p>
    {/if}
  </div>
  <div class="bar">
    <input type="search" bind:value={query} placeholder={t('Cerca una sezione…')} aria-label={t('Cerca una sezione')} />
    <button onclick={exportFile} disabled={busy || sections.length === 0}>{t('Esporta')}</button>
    <label class="import">{t('Importa…')}<input bind:this={file} type="file" accept=".xblibrary,application/json" onchange={importFile} /></label>
  </div>
  {#if message}<p class="message" role="status">{message}</p>{/if}
  {#if sections.length === 0}
    <p class="muted">{t('La libreria è vuota. Le sezioni salvate qui si inseriscono in qualsiasi pagina, e con «Esporta» passano a un altro sito.')}</p>
  {:else}
    <ul>
      {#each shown as section (section.id)}
        <li>
          <div>
            <strong>{section.name}</strong>
            <small>{section.origin} · {date(section.created)}</small>
          </div>
          <button class="primary" onclick={() => insert(section)} disabled={busy}>{t('Inserisci')}</button>
          {#if onagent}<button onclick={() => askAgent(section)} disabled={busy} title={t('L’agente la ricostruisce con le classi e i token di questo progetto, senza copiarne il markup')}>{t('Fai ricostruire all’agente')}</button>{/if}
          <button onclick={() => remove(section)} disabled={busy} aria-label={t('Togli «{0}» dalla libreria', section.name)}>✕</button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .section { display: grid; gap: 12px; align-content: start; }
  .save, .bar { display: grid; gap: 6px; }
  .bar { grid-template-columns: 1fr auto auto; align-items: center; }
  .row { display: flex; gap: 8px; }
  .row input { flex: 1; }
  input { font: 13px var(--xb-sans); padding: 6px 10px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); background: var(--xb-bg); color: var(--xb-text); }
  button, .import { font: 13px var(--xb-sans); padding: 6px 12px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); background: var(--xb-bg); color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-accent); border-color: var(--xb-accent); color: #fff; }
  button:disabled { opacity: 0.5; cursor: default; }
  .import input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .import:focus-within { box-shadow: var(--xb-ring); }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  li { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: center; padding: 8px 10px; border: 1px solid var(--xb-line); border-radius: 8px; }
  li div { display: grid; min-width: 0; }
  li small, .muted { color: var(--xb-muted); }
  .message { margin: 0; color: var(--xb-muted); }
</style>
