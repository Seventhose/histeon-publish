<script lang="ts">
  import { IDENTIFIER_PATTERN, COMPONENT_REF_PATTERN, refToTag } from '@xb/dsl';
  import type { PropDefinition } from '../lib/api.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import { t } from '../lib/i18n.ts';
  import { listVariants, planVariant, removeVariant } from '../lib/variants.ts';

  let { app }: { app: BuilderState } = $props();
  const TYPES = ['string', 'number', 'boolean', 'url', 'image', 'rich-text', 'enum', 'array', 'object'];
  const propList = $derived(Object.entries(app.schema?.props ?? {}));
  let newName = $state('');
  let error = $state('');

  function update(fn: (props: Record<string, PropDefinition>) => void) {
    // A plain object even if the schema came as a list ([] when empty): keys set on a list are lost in JSON.
    const next: Record<string, PropDefinition> = Object.fromEntries(Object.entries(structuredClone($state.snapshot(app.schema?.props ?? {}))));
    fn(next);
    app.setSchema({ props: next });
  }

  function addProp(event: SubmitEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!IDENTIFIER_PATTERN.test(name)) {
      error = t('Il nome deve essere un identificatore (es. titolo, mostraImmagine).');
      return;
    }
    error = '';
    update((p) => (p[name] = { type: 'string' }));
    newName = '';
  }

  // ---- variants (lista della spesa 157): a yes/no prop and a BEM modifier that redefines a few variables
  let variantLabel = $state('');
  let variantNote = $state('');
  const variants = $derived(listVariants(app.tree, app.schema?.props ?? {}));

  function addVariant(event: SubmitEvent) {
    event.preventDefault();
    app.flushEdits(); // CSS just typed for the block is where the variant's variables come from.
    const plan = planVariant(app.tree, $state.snapshot(app.schema?.props ?? {}), app.styles, variantLabel);
    if (!plan.ok) {
      error = plan.error;
      return;
    }
    error = '';
    update((p) => (p[plan.prop] = plan.definition));
    app.setTree(plan.tree);
    app.upsertStyle(plan.selector, plan.css);
    variantNote = t('Variante pronta: nel CSS di {0} ridefinisci le variabili che cambiano. Il cliente la accende con l’interruttore «{1}».', plan.selector, plan.definition.label ?? plan.prop);
    variantLabel = '';
  }

  function dropVariant(prop: string) {
    app.setTree(removeVariant(app.tree, prop));
    update((p) => delete p[prop]);
    variantNote = '';
  }

  function setRef(value: string) {
    if (!COMPONENT_REF_PATTERN.test(value)) {
      error = t('Chiave non valida: minuscole e trattini, al massimo un namespace (es. ui/card-hero).');
      return;
    }
    error = '';
    app.setSchema($state.snapshot(app.schema) ?? { props: {} }, value);
  }
</script>

<div class="component">
  <label class="field">
    {t('Chiave del componente')}
    <input value={app.ref ?? ''} onchange={(e) => setRef(e.currentTarget.value.trim())} />
    <small>{t('Nel codice:')} <code>&lt;{app.ref ? refToTag(app.ref) : '…'} /&gt;</code></small>
  </label>
  <h3>Props</h3>
  {#each propList as [name, def] (name)}
    <div class="row">
      <code>{name}</code>
      <select value={def.type} onchange={(e) => update((p) => { const d = p[name]; if (d) d.type = e.currentTarget.value; })} aria-label={t('Tipo di {0}', name)}>
        {#each TYPES as ty (ty)}<option value={ty}>{ty}</option>{/each}
      </select>
      <input
        placeholder="default"
        value={def.default ?? ''}
        onchange={(e) => update((p) => { const d = p[name]; if (!d) return; const v = e.currentTarget.value; if (v === '') delete d.default; else d.default = d.type === 'number' && !Number.isNaN(Number(v)) ? Number(v) : d.type === 'boolean' ? v === 'true' : v; })}
        aria-label={t('Default di {0}', name)}
      />
      <input
        placeholder={t('esempio')}
        title={t('Si vede solo qui, nel builder, quando il componente è aperto da solo; le pagine usano il default')}
        value={def.sample ?? ''}
        onchange={(e) => update((p) => { const d = p[name]; if (!d) return; const v = e.currentTarget.value; if (v === '') delete d.sample; else d.sample = d.type === 'number' && !Number.isNaN(Number(v)) ? Number(v) : d.type === 'boolean' ? v === 'true' : v; })}
        aria-label={t('Valore di prova di {0}', name)}
      />
      <button onclick={() => update((p) => delete p[name])} aria-label={t('Rimuovi {0}', name)}>✕</button>
    </div>
  {/each}
  <form onsubmit={addProp} class="row add">
    <input bind:value={newName} placeholder={t('nuova prop')} aria-label={t('Nome della nuova prop')} />
    <button type="submit">{t('Aggiungi')}</button>
  </form>
  <h3>{t('Varianti')}</h3>
  {#each variants as v (v.prop)}
    <div class="row variant">
      <span>{v.label}</span>
      <code>{v.selector}</code>
      <button onclick={() => dropVariant(v.prop)} aria-label={t('Togli la variante {0}', v.label)}>✕</button>
    </div>
  {/each}
  <form onsubmit={addVariant} class="row add">
    <input bind:value={variantLabel} placeholder={t('Scura, Grande, In evidenza…')} aria-label={t('Nome della nuova variante')} />
    <button type="submit" disabled={variantLabel.trim() === ''}>{t('Aggiungi una variante')}</button>
  </form>
  {#if variantNote}<p class="hint" role="status">{variantNote}</p>{/if}
  <p class="hint">{t('Una variante è un interruttore per chi usa il componente: aggiunge al primo elemento una classe come card--scura, che cambia solo alcune variabili.')}</p>
  {#if error}<p class="error">{error}</p>{/if}
  <p class="hint">{t('Nel codice del componente le props si leggono con')} <code>{'{props.nome}'}</code>, {t('gli slot con')} <code>{'{@slot}'}</code>.</p>
  <p class="hint">{t('Aperto da solo, il componente si disegna con i valori di prova: l’esempio, se c’è, poi il default, poi un valore dal tipo (il nome della prop, un’immagine segnaposto, la prima scelta). Gli elementi nascosti si vedono tratteggiati, quelli vuoti con un segnaposto.')}</p>
</div>

<style>
  .component { padding: 12px 16px; display: grid; gap: 10px; align-content: start; font-size: 13px; overflow: auto; height: 100%; }
  h3 { margin: 8px 0 0; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-muted); }
  .field { display: grid; gap: 4px; color: var(--xb-muted); }
  .row { display: grid; grid-template-columns: 1fr 90px 1fr 1fr auto; gap: 6px; align-items: center; }
  .row.add { grid-template-columns: 1fr auto; }
  .row.variant { grid-template-columns: 1fr 1fr auto; }
  input, select, button { font: 12.5px var(--xb-sans); padding: 5px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); }
  input { font-family: var(--xb-mono); }
  button { cursor: pointer; }
  .error { color: var(--xb-danger); margin: 0; }
  .hint, small { color: var(--xb-muted); margin: 0; }
</style>
