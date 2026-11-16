<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import CodeEditor from './CodeEditor.svelte';
  import SiteScripts from './SiteScripts.svelte';
  import type { BuilderState } from '../lib/state.svelte.ts';

  let { app }: { app: BuilderState } = $props();
  const editable = $derived(app.doc?.scriptEditable === true);
</script>

<div class="panel">
  <p class="note" class:locked={!editable}>
    {#if editable}
      {app.isComponent ? t('Modulo JavaScript di questo componente: va in pagina come') : t('Modulo JavaScript di questo documento: va in pagina come')}
      <code>&lt;script type="module"&gt;</code> {t("dopo il contenuto. Non viene eseguito nell'anteprima.")}
    {:else}
      {t('Sola lettura: solo chi ha il permesso')} <code>unfiltered_html</code> {t('può modificare il JavaScript.')}
    {/if}
  </p>
  <CodeEditor value={app.script} language="javascript" readOnly={!editable} onchange={(v) => (app.script = v)} label={t('JavaScript del documento')} />
  <SiteScripts {app} />
</div>

<style>
  .panel {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100%;
    min-height: 0;
  }
  .note {
    margin: 0;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--xb-muted);
    border-bottom: 1px solid var(--xb-line);
  }
  .note.locked {
    color: var(--xb-danger);
  }
</style>
