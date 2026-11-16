<script lang="ts">
  import { t, tn } from '../lib/i18n.ts';
  import { childrenOf, parse, print, reconcileUids, XbSyntaxError, type XbBlock } from '@xb/dsl';
  import CodeEditor from './CodeEditor.svelte';
  import { fromSfc, SfcError, toSfc } from '../lib/sfc.ts';
  import { staticClasses, staticId } from '../lib/tree.ts';
  import type { Schema } from '../lib/api.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';

  // The document as one file (docs/spec/single-file.md): HTML, the CSS of its selectors, its script and props.
  // Edited here, applied together with "Applica"; the styles are shared by the whole site, so a rule left out
  // of the file is never deleted.
  let { app }: { app: BuilderState } = $props();

  function selectorsOf(blocks: XbBlock[], out = new Set<string>()): Set<string> {
    for (const b of blocks) {
      for (const c of staticClasses(b)) out.add(`.${c}`);
      const id = staticId(b);
      if (id) out.add(`#${id}`);
      selectorsOf(childrenOf(b), out);
    }
    return out;
  }
  function current(): string {
    // What was just typed in the other panels counts too.
    app.flushEdits();
    const used = selectorsOf(app.tree);
    return toSfc({
      html: print(app.tree),
      styles: app.styles.filter((s) => used.has(s.selector)).map((s) => [s.selector, s.css] as [string, string]),
      script: app.script,
      props: app.isComponent ? ($state.snapshot(app.schema) ?? { props: {} }) : null,
    });
  }

  const initial = current();
  let text = $state(initial);
  let loaded = $state(initial);
  let message = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const changed = $derived(text !== loaded);

  function reload() {
    text = current();
    loaded = text;
    message = null;
  }
  const lineOf = (offset: number) => text.slice(0, Math.max(0, offset)).split('\n').length;

  function apply() {
    let parts;
    try {
      parts = fromSfc(text);
    } catch (e) {
      message = { kind: 'error', text: e instanceof SfcError ? t('Riga {0}: {1}', lineOf(e.offset), e.message) : String(e) };
      return;
    }
    let blocks: XbBlock[];
    try {
      blocks = parse(parts.html).blocks;
    } catch (e) {
      // The parser counts lines from the start of the template's content: the file's line is that plus where it starts.
      const first = lineOf(text.indexOf('<template>')) + 1;
      message = { kind: 'error', text: e instanceof XbSyntaxError ? t('Riga {0} del file: {1}', first + e.line - 1, e.message.replace(/ \(riga \d+, colonna \d+\)$/, '')) : String(e) };
      return;
    }
    if (parts.script !== app.script && app.doc?.scriptEditable !== true) {
      message = { kind: 'error', text: t('Lo script di questo documento si modifica solo con il permesso di scrivere HTML senza filtri.') };
      return;
    }
    app.setTree(reconcileUids(app.tree, blocks));
    let styles = 0;
    for (const [selector, css] of parts.styles) {
      const before = app.styles.find((s) => s.selector === selector)?.css ?? '';
      if (before.trim() === css.trim()) continue;
      app.upsertStyle(selector, css ? `${css}\n` : '');
      styles++;
    }
    if (styles) app.styleRevision++;
    if (parts.script !== app.script) app.script = parts.script;
    if (app.isComponent && parts.props && JSON.stringify(parts.props) !== JSON.stringify(app.schema)) app.setSchema(parts.props as Schema);
    reload();
    message = { kind: 'ok', text: styles ? tn('Applicato: {0} stile aggiornati. Salva per tenerlo.', 'Applicato: {0} stili aggiornati. Salva per tenerlo.', styles, styles) : t('Applicato. Salva per tenerlo.') };
  }
</script>

<div class="source">
  <p class="intro">
    {app.isComponent ? t('Il componente in un solo file:') : t('Il documento in un solo file:')} <code>&lt;template&gt;</code> {t("con l'HTML,")} <code>&lt;style&gt;</code>
    {t('con le regole dei suoi selettori,')} <code>&lt;script&gt;</code>{app.isComponent ? ' ' + t('e le props') : ''}. {t('Gli stili valgono in tutto il sito: togliere una regola da qui non la cancella.')}
  </p>
  <div class="bar">
    <button class="primary" onclick={apply} disabled={!changed}>{t('Applica')}</button>
    <button onclick={reload} title={t("Riprende il documento com'è ora, lasciando le modifiche di questo file")}>{t('Ricarica dal documento')}</button>
    {#if message}<span class="msg {message.kind}" role="status">{message.text}</span>{:else if changed}<span class="msg">{t('Modifiche da applicare')}</span>{/if}
  </div>
  <div class="code">
    <CodeEditor value={text} language="html" onchange={(v) => (text = v)} emmet label={t('File unico del documento')} />
  </div>
</div>

<style>
  .source { display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 10px; height: 100%; min-height: 0; }
  .intro { margin: 0; color: var(--xb-muted); font-size: 13px; max-width: 80ch; }
  .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  button { font: 500 13px var(--xb-sans); padding: 6px 12px; border-radius: var(--xb-r); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); cursor: pointer; }
  button:disabled { opacity: 0.45; cursor: default; }
  .primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  .msg { font-size: 12.5px; color: var(--xb-muted); }
  .msg.ok { color: var(--xb-ok); }
  .msg.error { color: var(--xb-danger); }
  .code { min-height: 320px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); overflow: hidden; }
</style>
