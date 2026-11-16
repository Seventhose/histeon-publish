<script lang="ts">
  // «Inserisci un dato» (lista della spesa 156): field, format, fallback and the words around it, for who does not
  // write expressions; the code it makes stays in sight, so the panel also teaches the language.
  import { t } from '../lib/i18n.ts';
  import { composeExpression, composeText, DATE_FORMS, formatsFor, readExpression, valid, type Composition, type DataChoice, type FormatId } from '../lib/expressionComposer.ts';

  let {
    choices,
    mode = 'text',
    current = '',
    onuse,
  }: {
    choices: DataChoice[];
    /** `text`: words around `{…}`, added to a text; `expression`: the bare expression (a prop). */
    mode?: 'text' | 'expression';
    /** The expression being edited (mode `expression`), read back when the composer could have written it. */
    current?: string;
    onuse: (value: string) => void;
  } = $props();

  let open = $state(false);
  let path = $state('');
  let format = $state<FormatId>('none');
  let arg = $state('');
  let fallback = $state('');
  let before = $state('');
  let after = $state('');

  function start() {
    open = !open;
    if (!open) return;
    const read = mode === 'expression' && current ? readExpression(current, choices) : null;
    const first = read ?? { path: choices[0]?.path ?? 'this.title', format: 'none' as FormatId, arg: '', fallback: '' };
    ({ path, format, arg, fallback } = first);
    if (!read) pick(first.path);
    before = '';
    after = '';
  }

  function pick(next: string) {
    path = next;
    const formats = formatsFor(choices.find((c) => c.path === next)?.kind ?? 'text');
    format = formats[0]!.id;
    arg = formats[0]!.arg ?? '';
  }

  const choice = $derived(choices.find((c) => c.path === path));
  const formats = $derived(formatsFor(choice?.kind ?? 'text'));
  const spec = $derived(formats.find((f) => f.id === format));
  const groups = $derived([...new Set(choices.map((c) => c.group))]);
  const composition = $derived<Composition>({ path, format, arg, fallback });
  const expression = $derived(composeExpression(composition));
  const ok = $derived(valid(expression));
  const result = $derived(mode === 'text' ? composeText(composition, before, after) : expression);

  function use() {
    if (!ok) return;
    onuse(result);
    open = false;
  }
</script>

<div class="xb-compose">
  <button type="button" class="toggle" aria-expanded={open} onclick={start}>{'{ }'} {mode === 'text' ? t('Inserisci un dato') : t('Componi l’espressione')}</button>
  {#if open}
    <div class="box">
      <label>{t('Dato')}
        <select value={path} onchange={(e) => pick(e.currentTarget.value)}>
          {#each groups as group (group)}
            <optgroup label={group}>
              {#each choices.filter((c) => c.group === group) as c (c.path)}<option value={c.path}>{c.label}</option>{/each}
            </optgroup>
          {/each}
        </select>
      </label>
      {#if formats.length > 1}
        <label>{t('Forma')}
          <select value={format} onchange={(e) => { format = e.currentTarget.value as FormatId; arg = formats.find((f) => f.id === format)?.arg ?? ''; }}>
            {#each formats as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
          </select>
        </label>
      {/if}
      {#if spec?.argLabel}
        <label>{spec.argLabel}
          {#if format === 'date'}
            <select bind:value={arg}>
              {#each DATE_FORMS as [pattern, sample] (pattern)}<option value={pattern}>{sample}</option>{/each}
              {#if !DATE_FORMS.some(([p]) => p === arg)}<option value={arg}>{arg}</option>{/if}
            </select>
          {:else}
            <input bind:value={arg} inputmode={format === 'join' ? undefined : 'numeric'} />
          {/if}
        </label>
      {/if}
      <label>{t('Se è vuoto, mostra')} <input bind:value={fallback} placeholder={t('niente')} /></label>
      {#if mode === 'text'}
        <label>{t('Testo prima')} <input bind:value={before} placeholder={t('Pubblicato il ')} /></label>
        <label>{t('Testo dopo')} <input bind:value={after} /></label>
      {/if}
      <p class="code" aria-label={t('Come si scrive nel codice')}><code>{mode === 'text' ? result : `{${result}}`}</code></p>
      {#if !ok}<p class="error">{t('Questa combinazione non si può scrivere: cambia la forma.')}</p>{/if}
      <div class="row">
        <button type="button" class="primary" disabled={!ok} onclick={use}>{mode === 'text' ? t('Aggiungi al contenuto') : t('Usa questa espressione')}</button>
        <button type="button" onclick={() => (open = false)}>{t('Annulla')}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .xb-compose { margin: 4px 0 8px; font-size: 12px; }
  .toggle { font: 12px var(--xb-sans); padding: 3px 8px; border-radius: var(--xb-r-sm); border: 1px dashed var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  .box { display: grid; gap: 6px; margin-top: 6px; padding: 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  label { display: grid; gap: 2px; color: var(--xb-muted); }
  select, input { font: 12px var(--xb-sans); padding: 4px 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); background: var(--xb-bg); color: var(--xb-text); }
  .code { margin: 0; padding: 6px; border-radius: var(--xb-r-sm); background: var(--xb-surface, rgb(0 0 0 / 0.04)); overflow-wrap: anywhere; }
  .error { margin: 0; color: var(--xb-danger); }
  .row { display: flex; gap: 6px; }
  .row button { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  .row button.primary { background: var(--xb-accent, #e2725b); border-color: transparent; color: #fff; }
  .row button:disabled { opacity: 0.5; cursor: default; }
</style>
