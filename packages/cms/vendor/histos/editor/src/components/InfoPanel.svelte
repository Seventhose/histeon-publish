<script lang="ts">
  import { t } from '../lib/i18n.ts';
  import Icon from './Icon.svelte';
  import { parseExpression, randomUid, refToTag, XbSyntaxError, type ElementBlock, type PropValue, type XbBlock } from '@xb/dsl';
  import { describe, updateBlock } from '../lib/tree.ts';
  import { removeAttribute, setAttribute, setTag, setText, textOf as elementText, type Edit } from '../lib/attributes.ts';
  import { focalPoint, withFocalPoint } from '../lib/media.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import { applyField, COMMON, fieldsFor, valueOf, type Field } from '../lib/elementFields.ts';
  import { componentProblem, refFrom } from '../lib/speed.ts';
  import ExpressionComposer from './ExpressionComposer.svelte';
  import { dataChoices } from '../lib/expressionComposer.ts';
  import { CLIENT_PROP_TYPES } from '../lib/contentOnly.ts';
  import MiniGui from './MiniGui.svelte';
  import { bodyAt, setBodyAt, STATES } from '../lib/cssContext.ts';
  import { elementSelectors, pageCssOf } from '../lib/pageLook.ts';

  let {
    app,
    pickImage,
    pickFile,
    oninsert,
    contentOnly = false,
    oneditform,
  }: {
    app: BuilderState;
    pickImage?: () => Promise<Record<string, string> | null>;
    /** A file of the library for a link (doc 23 of Publish, item 176): its address, or null. */
    pickFile?: () => Promise<string | null>;
    oninsert?: (anchor: HTMLElement) => void;
    contentOnly?: boolean;
    oneditform?: (id: number) => void;
  } = $props();

  /** Replaces the image of the selected <img>, keeping its other attributes (class, loading…). */
  async function chooseImage() {
    const attrs = await pickImage?.();
    if (!attrs) return;
    edit((b) => {
      if (b.name !== 'xb/element' || b.attrs.tag !== 'img') return b;
      const current = { ...(b.attrs.attributes ?? {}) };
      for (const name of ['src', 'srcset', 'sizes', 'width', 'height']) delete current[name];
      const keepAlt = typeof current.alt === 'string' && current.alt.trim() !== '';
      const next = { ...current, ...attrs };
      if (keepAlt) next.alt = current.alt as string;
      return { ...b, attrs: { ...b.attrs, attributes: next } };
    });
  }
  const block = $derived(app.selected ? app.find(app.selected) : null);

  // The page's own look for a client (voce 186): which selector, state and width the mini GUI writes into.
  let lookSelector = $state('');
  let lookState = $state('');
  let lookWidth = $state('');
  const lookPath = $derived([lookWidth, lookState].filter(Boolean));
  function setLook(selector: string, next: string) {
    const css = pageCssOf(app.pageStyles, selector);
    app.setPageStyle(selector, setBodyAt(css, lookPath, next));
  }

  /** The link of the selected <a> becomes the address of a file of the library (an image or a PDF). */
  async function chooseFile(field: Field) {
    const href = await pickFile?.();
    if (href) editElement(`f:${field.attr}`, (b) => applyField(b, field, href));
  }

  // ---- quick actions: component from the selection, BEM classes
  let making = $state(false);
  let componentTitle = $state('');
  let componentRef = $state('');
  let refTouched = $state(false);
  let quickMessage = $state('');
  const blocked = $derived(block && block.name === 'xb/element' ? componentProblem([$state.snapshot(block) as XbBlock]) : null);
  $effect(() => {
    void app.selected;
    making = false;
    quickMessage = '';
  });
  function startComponent() {
    componentTitle = block?.name === 'xb/element' ? (block.attrs.label ?? '') : '';
    componentRef = refFrom(componentTitle || (block?.name === 'xb/element' ? (staticClass(block) ?? block.attrs.tag) : 'componente'));
    refTouched = false;
    making = true;
  }
  const staticClass = (b: ElementBlock): string | null => (typeof b.attrs.attributes?.class === 'string' ? (b.attrs.attributes.class.split(/\s+/)[0] ?? null) : null);
  async function makeComponent(event: SubmitEvent) {
    event.preventDefault();
    try {
      await app.componentFromSelection(componentRef, componentTitle.trim() || componentRef);
      // The selection is now the instance (this panel shows its props): the outcome goes to the top bar.
      app.status = { kind: 'idle', message: t('Componente <{0}> creato: la selezione ora è una sua istanza. Salva la pagina; il componente si modifica da Componenti.', refToTag(componentRef)) };
      making = false;
    } catch (e) {
      quickMessage = e instanceof Error ? e.message : String(e);
    }
  }
  function bem() {
    if (!app.selected) return;
    const added = app.bem(app.selected);
    quickMessage = added.length ? t('Classi aggiunte: {0}.', added.join(', ')) : t('Nessun elemento senza classe da nominare.');
  }
  const schema = $derived(block?.name === 'xb/component' ? (app.components.find((c) => c.ref === block.attrs.ref)?.props ?? {}) : {});
  let propErrors = $state<Record<string, string>>({});

  function edit(fn: (b: XbBlock) => XbBlock) {
    if (app.selected) app.setTree(updateBlock(app.tree, app.selected, fn));
  }

  // ---- tag, content and attributes of an element, one row each
  /** Error per field ('tag', 'text', 'attr:<name>', 'new'), cleared by the next valid edit of that field. */
  let fieldErrors = $state<Record<string, string>>({});
  let newName = $state('');
  let newValue = $state('');
  const text = $derived(block ? elementText(block) : null);
  /** What the expression composer offers here: the items of the loops around the selection, the props of the open component. */
  const choices = $derived.by(() => {
    if (!app.selected) return dataChoices({ loops: [], props: [] });
    const loops = app
      .path(app.selected)
      .map((uid) => app.find(uid))
      .filter((b): b is XbBlock => !!b && b.name === 'xb/loop')
      .map((b) => (b.attrs as { as?: string }).as)
      .filter((as): as is string => typeof as === 'string' && /^[A-Za-z_]\w*$/.test(as))
      .reverse();
    return dataChoices({ loops, props: app.isComponent ? Object.keys(app.schema?.props ?? {}) : [] });
  });

  function editElement(field: string, fn: (b: ElementBlock) => Edit): boolean {
    const target = block;
    if (!target || target.name !== 'xb/element') return false;
    const result = fn($state.snapshot(target) as ElementBlock);
    const errors = { ...fieldErrors };
    delete errors[field];
    if (!result.ok) {
      errors[field] = result.error;
      fieldErrors = errors;
      return false;
    }
    fieldErrors = errors;
    edit(() => result.block);
    return true;
  }
  // Focal point of an image (M4): where it is held when its box crops it, as `object-position` in its style.
  function setFocal(point: [number, number] | null) {
    editElement('f:style', (b) => {
      const current = typeof b.attrs.attributes?.style === 'string' ? b.attrs.attributes.style : '';
      const next = withFocalPoint(current, point);
      if (next === '') return { ok: true, block: removeAttribute(b, 'style') };
      return setAttribute(b, b.attrs.attributes?.style !== undefined ? 'style' : null, 'style', next);
    });
  }
  function pickFocal(event: MouseEvent, current: [number, number] | null) {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    // A click from the keyboard (Enter, Space) has no position: it keeps the point.
    if (event.detail === 0) {
      if (!current) setFocal([50, 50]);
      return;
    }
    setFocal([((event.clientX - box.left) / box.width) * 100, ((event.clientY - box.top) / box.height) * 100]);
  }
  function focalKey(event: KeyboardEvent, current: [number, number] | null) {
    const step = event.shiftKey ? 20 : 5;
    const [x, y] = current ?? [50, 50];
    const moves: Record<string, [number, number]> = { ArrowLeft: [x - step, y], ArrowRight: [x + step, y], ArrowUp: [x, y - step], ArrowDown: [x, y + step] };
    const next = moves[event.key];
    if (!next) return;
    event.preventDefault();
    setFocal(next);
  }

  function addAttribute() {
    if (editElement('new', (b) => setAttribute(b, null, newName, newValue))) {
      newName = '';
      newValue = '';
    }
  }
  $effect(() => {
    void app.selected;
    fieldErrors = {};
  });

  function setLabel(value: string) {
    edit((b) => {
      if (b.name !== 'xb/element' && b.name !== 'xb/component') return b;
      const attrs = { ...b.attrs } as typeof b.attrs & { label?: string };
      if (value.trim() === '') delete attrs.label;
      else attrs.label = value.replace(/[{}]/g, '').slice(0, 80);
      return { ...b, attrs } as typeof b;
    });
  }



  // ---- props of a component instance
  type Mode = 'text' | 'expr';
  function modeOf(value: PropValue | undefined): Mode {
    return value !== null && typeof value === 'object' && 'expr' in value ? 'expr' : 'text';
  }
  function textOf(value: PropValue | undefined): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return 'expr' in value ? value.expr : value.tpl;
    return String(value);
  }
  function setProp(name: string, mode: Mode, raw: string, type: string | undefined) {
    let value: PropValue | undefined;
    const errors = { ...propErrors };
    delete errors[name];
    if (raw.trim() === '') value = undefined;
    else if (mode === 'expr') {
      try {
        parseExpression(raw);
        value = { expr: raw.trim() };
      } catch (e) {
        errors[name] = e instanceof XbSyntaxError ? e.message : String(e);
        propErrors = errors;
        return;
      }
    } else if (type === 'number' && !Number.isNaN(Number(raw))) value = Number(raw);
    else if (/(^|[^\\])\{/.test(raw)) value = { tpl: raw };
    else value = raw;
    propErrors = errors;
    edit((b) => {
      if (b.name !== 'xb/component') return b;
      const props = { ...(b.attrs.props ?? {}) };
      if (value === undefined) delete props[name];
      else props[name] = value;
      const attrs = { ...b.attrs, props };
      if (Object.keys(props).length === 0) delete (attrs as { props?: unknown }).props;
      return { ...b, attrs };
    });
  }
  function setBoolean(name: string, checked: boolean) {
    edit((b) => (b.name === 'xb/component' ? { ...b, attrs: { ...b.attrs, props: { ...(b.attrs.props ?? {}), [name]: checked } } } : b));
  }
  const propNames = $derived(
    block?.name === 'xb/component' ? [...new Set([...Object.keys(schema), ...Object.keys(block.attrs.props ?? {})])] : [],
  );
</script>

<div class="info">
  {#if contentOnly}
    <!-- Client mode: only what a client may change (docs/spec/client-mode.md); the server checks it again on save. -->
    <section>
      <h3>{t('Modalità contenuti')}</h3>
      {#if block?.name === 'xb/element' && block.attrs.tag === 'img'}
        {@const src = block.attrs.attributes?.src}
        {#if pickImage}
          <div class="media">
            <button onclick={chooseImage}>{t('Scegli immagine…')}</button>
            {#if typeof src === 'string' && src}<span class="file mono" title={src}>{src.split('/').pop()}</span>{/if}
          </div>
        {/if}
        <label class="row"><span>{t('Testo alternativo')}</span>
          <input value={typeof block.attrs.attributes?.alt === 'string' ? block.attrs.attributes.alt : ''} onchange={(e) => editElement('f:alt', (b) => setAttribute(b, 'alt', 'alt', e.currentTarget.value))} />
        </label>
        {#if fieldErrors['f:alt']}<p class="error" role="alert">{fieldErrors['f:alt']}</p>{/if}
      {:else if block?.name === 'xb/component' && app.contentProps}
        <!-- List 135: with xb_edit_props a client sets the literal props of simple types; dynamic ones stay as they are. -->
        {#each propNames.filter((name) => CLIENT_PROP_TYPES.includes(schema[name]?.type ?? '') && modeOf(block.attrs.props?.[name]) === 'text') as name (name)}
          {@const def = schema[name]}
          {@const value = block.attrs.props?.[name]}
          <div class="prop">
            <span class="name">{def?.label ?? name}</span>
            {#if def?.type === 'boolean'}
              <input type="checkbox" checked={value === true} onchange={(e) => setBoolean(name, e.currentTarget.checked)} aria-label={def?.label ?? name} />
            {:else if def?.type === 'enum'}
              <select value={textOf(value)} onchange={(e) => setProp(name, 'text', e.currentTarget.value, def?.type)} aria-label={def?.label ?? name}>
                <option value="">{t('Predefinito')}</option>
                {#each (def?.options ?? []).map(String) as option (option)}<option value={option}>{option}</option>{/each}
              </select>
            {:else}
              <input value={textOf(value)} placeholder={def?.default !== undefined && def.default !== null ? String(def.default) : ''} onchange={(e) => setProp(name, 'text', e.currentTarget.value, def?.type)} aria-label={def?.label ?? name} />
            {/if}
            {#if propErrors[name]}<span class="error">{propErrors[name]}</span>{/if}
          </div>
        {:else}
          <p class="hint">{t('Questo componente non ha props che puoi cambiare.')}</p>
        {/each}
      {:else}
        <p class="hint">{t('Scrivi direttamente sulla tela: clic su un testo per cambiarlo. Per un\'immagine, selezionala e scegline un\'altra qui.')}</p>
      {/if}
    </section>
    {#if app.lookGroups.length > 0 && block?.name === 'xb/element'}
      {@const selectors = elementSelectors(block.attrs.attributes)}
      <!-- Voce 186: the mini GUI on this page's own look, in the groups the client was given; the server checks again. -->
      <section class="page-look">
        <h3>{t('Aspetto di questa pagina')}</h3>
        {#if selectors.length === 0}
          <p class="hint">{t('Questo elemento non ha una classe: l\'aspetto si cambia sugli elementi che ne hanno una.')}</p>
        {:else}
          {@const target = selectors.includes(lookSelector) ? lookSelector : selectors[0]!}
          {#if selectors.length > 1}
            <label class="row"><span>{t('Classe')}</span>
              <select value={target} onchange={(e) => (lookSelector = e.currentTarget.value)}>
                {#each selectors as sel (sel)}<option value={sel}>{sel}</option>{/each}
              </select>
            </label>
          {/if}
          <label class="row"><span>{t('Quando')}</span>
            <select bind:value={lookState}>
              <option value="">{t('Sempre')}</option>
              {#each STATES as st (st.prelude)}<option value={st.prelude}>{st.label}</option>{/each}
            </select>
          </label>
          <label class="row"><span>{t('Su quali schermi')}</span>
            <select bind:value={lookWidth}>
              <option value="">{t('Tutti')}</option>
              {#each Object.keys(app.queries) as q (q)}<option value={'@media (--' + q + ')'}>{q}</option>{/each}
            </select>
          </label>
          <MiniGui {app} css={bodyAt(pageCssOf(app.pageStyles, target), lookPath)} onchange={(next) => setLook(target, next)} selector={target} tag={block.attrs.tag} groups={app.lookGroups} />
          <p class="hint">{t('Vale solo per questa pagina: la stessa classe sulle altre pagine resta com\'è.')}</p>
        {/if}
      </section>
    {/if}
  {:else}

  {#if block}
    {@const form = block.name === 'xb/passthrough' ? /wp:fluentfom\/guten-block\s+\{[^}]*"formId"\s*:\s*"?(\d+)/.exec(block.raw) : null}
    {#if form && oneditform}
      <section>
        <h3>{t('Modulo Fluent Forms')}</h3>
        <p class="hint">{t('Campi, messaggi e notifiche si cambiano nell\'editor di Fluent Forms.')}</p>
        <button onclick={() => oneditform(Number(form[1]))}>{t('Modifica il modulo')}</button>
      </section>
    {/if}
    <section>
      <h3>{t('Elemento selezionato')}</h3>
      {#if block.name === 'xb/element'}
        {@const attributes = Object.entries(block.attrs.attributes ?? {})}
        {@const group = fieldsFor(block.attrs.tag)}
        {#each group ? [group, COMMON] : [COMMON] as g (g.title)}
          <fieldset class="group">
            <legend>{g.title}</legend>
            {#if g.media && pickImage}
              {@const src = block.attrs.attributes?.src}
              <div class="media">
                <button onclick={chooseImage}>{t('Scegli immagine…')}</button>
                {#if typeof src === 'string' && src}<span class="file mono" title={src}>{src.split('/').pop()}</span>{/if}
              </div>
            {/if}
            {#if g.media}
              {@const src = block.attrs.attributes?.src}
              {@const point = focalPoint(typeof block.attrs.attributes?.style === 'string' ? block.attrs.attributes.style : '')}
              {#if typeof src === 'string' && /^(https?:\/\/|\/)[^{}]*$/.test(src)}
                <div class="focal">
                  <span>{t('Punto focale')}</span>
                  <button class="focal-pick" onclick={(e) => pickFocal(e, point)} onkeydown={(e) => focalKey(e, point)} title={t('Clic sul punto da tenere in vista quando l’immagine è ritagliata; frecce per spostarlo')} aria-label={point ? t('Punto focale: {0}% da sinistra, {1}% dall’alto', point[0], point[1]) : t('Punto focale: al centro')}>
                    <img src={src} alt="" />
                    <span class="dot" aria-hidden="true" style:left="{point?.[0] ?? 50}%" style:top="{point?.[1] ?? 50}%"></span>
                  </button>
                  {#if point}<button onclick={() => setFocal(null)}>{t('Al centro')}</button>{/if}
                </div>
                {#if fieldErrors['f:style']}<p class="error">{fieldErrors['f:style']}</p>{/if}
              {/if}
            {/if}
            {#each g.fields as f (f.attr + f.kind)}
              {@const v = valueOf(block, f)}
              {@const key = `f:${f.attr}`}
              {#if f.kind === 'check' || f.kind === 'newtab'}
                <label class="check"><input type="checkbox" checked={v === true} onchange={(e) => editElement(key, (b) => applyField(b, f, e.currentTarget.checked))} /> {f.label}</label>
              {:else if f.kind === 'level'}
                <div class="row"><span>{f.label}</span>
                  <div class="levels" role="group" aria-label={f.label}>
                    {#each f.options ?? [] as [value, text] (value)}
                      <button class:on={v === value} aria-pressed={v === value} onclick={() => editElement(key, (b) => applyField(b, f, value))}>{text}</button>
                    {/each}
                  </div>
                </div>
              {:else if f.kind === 'select'}
                {@const options: Array<[string, string]> = (f.options ?? []).some(([o]) => o === v) || v === '' ? (f.options ?? []) : [[String(v), String(v)], ...(f.options ?? [])]}
                <label class="row"><span>{f.label}</span>
                  <select value={v} onchange={(e) => editElement(key, (b) => applyField(b, f, e.currentTarget.value))}>
                    {#if !options.some(([o]) => o === '')}<option value="">—</option>{/if}
                    {#each options as [value, text] (value)}<option {value}>{text}</option>{/each}
                  </select>
                </label>
                {#if f.whenEmpty && v === ''}<p class="warn">{f.whenEmpty}</p>{/if}
                {#if f.help}<p class="hint">{f.help}</p>{/if}
              {:else}
                <label class="row"><span>{f.label}</span>
                  <input class:mono={f.kind === 'url'} value={v} placeholder={f.placeholder ?? ''} inputmode={f.kind === 'number' ? 'numeric' : undefined} spellcheck={f.kind === 'url' ? 'false' : undefined}
                    onchange={(e) => editElement(key, (b) => applyField(b, f, e.currentTarget.value)) || (e.currentTarget.value = String(valueOf(block, f)))} />
                </label>
                {#if pickFile && block.attrs.tag === 'a' && f.attr === 'href'}
                  <div class="media"><button onclick={() => chooseFile(f)}>{t('Scegli un file dalla libreria…')}</button></div>
                {/if}
                {#if f.whenEmpty && v === ''}<p class="warn">{f.whenEmpty}</p>{/if}
                {#if f.help}<p class="hint">{f.help}</p>{/if}
              {/if}
              {#if fieldErrors[key]}<p class="error">{fieldErrors[key]}</p>{/if}
            {/each}
          </fieldset>
        {/each}
        <div class="props">
          <label class="row">
            <span>Tag</span>
            <input class="mono" value={block.attrs.tag} onchange={(e) => editElement('tag', (b) => setTag(b, e.currentTarget.value)) || (e.currentTarget.value = block.attrs.tag)} spellcheck="false" />
          </label>
          {#if fieldErrors.tag}<p class="error">{fieldErrors.tag}</p>{/if}
          {#if text !== null}
            <label class="row top">
              <span>{t('Contenuto')}</span>
              <textarea rows="2" value={text} onchange={(e) => editElement('text', (b) => setText(b, e.currentTarget.value, randomUid))}></textarea>
            </label>
            {#if !contentOnly}<ExpressionComposer {choices} onuse={(piece) => editElement('text', (b) => setText(b, (text ?? '') + piece, randomUid))} />{/if}
            {#if fieldErrors.text}<p class="error">{fieldErrors.text}</p>{/if}
          {/if}
          <h4>{t('Attributi')}</h4>
          {#each attributes as [name, value] (name)}
            <div class="attr">
              <input class="mono name" value={name} aria-label={t("Nome dell'attributo {0}", name)} spellcheck="false"
                onchange={(e) => editElement(`attr:${name}`, (b) => setAttribute(b, name, e.currentTarget.value, value === true ? '' : value)) || (e.currentTarget.value = name)} />
              <input class="mono" value={value === true ? '' : value} placeholder={value === true ? t('(senza valore)') : ''} aria-label={t('Valore di {0}', name)} spellcheck="false"
                onchange={(e) => editElement(`attr:${name}`, (b) => setAttribute(b, name, name, e.currentTarget.value))} />
              <button class="icon" onclick={() => editElement(`attr:${name}`, (b) => ({ ok: true, block: removeAttribute(b, name) }))} title={t('Rimuovi {0}', name)} aria-label={t('Rimuovi {0}', name)}>×</button>
            </div>
            {#if fieldErrors[`attr:${name}`]}<p class="error">{fieldErrors[`attr:${name}`]}</p>{/if}
          {/each}
          <form class="attr" onsubmit={(e) => { e.preventDefault(); addAttribute(); }}>
            <input class="mono name" bind:value={newName} placeholder={t('nome')} aria-label={t('Nome del nuovo attributo')} spellcheck="false" />
            <input class="mono" bind:value={newValue} placeholder={t('valore')} aria-label={t('Valore del nuovo attributo')} spellcheck="false" />
            <button class="icon" type="submit" title={t('Aggiungi attributo')} aria-label={t('Aggiungi attributo')} disabled={newName.trim() === ''}>+</button>
          </form>
          {#if fieldErrors.new}<p class="error">{fieldErrors.new}</p>{/if}
        </div>
      {:else}
        <dl>
          <dt>{t('Tipo')}</dt><dd>{block.name}</dd>
          {#if block.name === 'xb/component'}<dt>{t('Componente')}</dt><dd><code>&lt;{refToTag(block.attrs.ref)}&gt;</code></dd>{/if}
          <dt>{t('Nella struttura')}</dt><dd>{describe(block)}</dd>
        </dl>
      {/if}
      <div class="actions">
        <button onclick={() => app.move(block.attrs.uid, -1)} title="Alt+↑">{t('Su')}</button>
        <button onclick={() => app.move(block.attrs.uid, 1)} title="Alt+↓">{t('Giù')}</button>
        <button onclick={() => app.duplicate(block.attrs.uid)} title="Ctrl+D">{t('Duplica')}</button>
        <button class="danger" onclick={() => app.remove(block.attrs.uid)} title={t('Canc')}>{t('Elimina')}</button>
      </div>
      {#if block.name === 'xb/component'}
        <div class="actions">
          <button class="edit-component" onclick={() => void app.openComponent(block.attrs.ref)} title={t('Modifica la definizione qui, senza lasciare la pagina (doppio clic sul componente)')}><Icon name="components" size={14} /> {t('Modifica il componente')}</button>
        </div>
        <p class="hint">{t('Le modifiche valgono ovunque il componente è usato.')}</p>
      {/if}
      {#if block.name === 'xb/element'}
        <div class="actions">
          <button onclick={startComponent} disabled={!!blocked} title={blocked ?? t('La selezione diventa un componente riutilizzabile')}><Icon name="components" size={14} /> {t('Crea componente…')}</button>
          <button onclick={bem} title={t('Dà ai figli senza classe un nome BEM: blocco__parte')}>{t('Classi BEM')}</button>
        </div>
        {#if blocked}<p class="hint">{blocked}</p>{/if}
        {#if making}
          <form class="make" onsubmit={makeComponent}>
            <label>{t('Nome')} <input aria-label={t('Nome del nuovo componente')} bind:value={componentTitle} oninput={() => { if (!refTouched) componentRef = refFrom(componentTitle); }} placeholder={t('Scheda evento')} /></label>
            <label>{t('Chiave')} <input aria-label={t('Chiave del nuovo componente')} class="mono" bind:value={componentRef} oninput={() => (refTouched = true)} spellcheck="false" /></label>
            <div class="actions"><button type="submit">{t('Crea')}</button><button type="button" onclick={() => (making = false)}>{t('Annulla')}</button></div>
          </form>
        {/if}
        {#if quickMessage}<p class="hint" role="status">{quickMessage}</p>{/if}
      {/if}
      {#if block.name === 'xb/element' || block.name === 'xb/component'}
        <label class="field">
          <span>{t('Nome nella struttura')} (<code>xb:label</code>)</span>
          <input value={block.attrs.label ?? ''} onchange={(e) => setLabel(e.currentTarget.value)} />
        </label>
      {/if}
    </section>

    {#if block.name === 'xb/component'}
      <section>
        <h3>Props</h3>
        {#if propNames.length === 0}<p class="hint">{t('Questo componente non dichiara props.')}</p>{/if}
        {#each propNames as name (name)}
          {@const def = schema[name]}
          {@const value = block.attrs.props?.[name]}
          <div class="prop">
            <span class="name">{def?.label ?? name} <small>{def?.type ?? '—'}</small></span>
            {#if def?.type === 'boolean' && modeOf(value) === 'text'}
              <input type="checkbox" checked={value === true} onchange={(e) => setBoolean(name, e.currentTarget.checked)} aria-label={name} />
            {:else}
              <select value={modeOf(value)} onchange={(e) => setProp(name, e.currentTarget.value as Mode, textOf(value), def?.type)} aria-label={t('Modo di {0}', name)}>
                <option value="text">{t('Testo')}</option>
                <option value="expr">{t('Espressione')}</option>
              </select>
              <input
                value={textOf(value)}
                placeholder={def?.default !== undefined && def.default !== null ? String(def.default) : ''}
                onchange={(e) => setProp(name, modeOf(value), e.currentTarget.value, def?.type)}
                aria-label={t('Valore di {0}', name)}
              />
              {#if modeOf(value) === 'expr' && !contentOnly}<ExpressionComposer {choices} mode="expression" current={textOf(value)} onuse={(expr) => setProp(name, 'expr', expr, def?.type)} />{/if}
            {/if}
            {#if propErrors[name]}<span class="error">{propErrors[name]}</span>{/if}
          </div>
        {/each}
      </section>
    {/if}
  {/if}


  {#if !block}
    <div class="none">
      <p>{t("Seleziona un elemento nell'anteprima o nella struttura per vederne e modificarne le proprietà.")}</p>
      {#if oninsert}<button class="add" onclick={(e) => oninsert(e.currentTarget)}>{t('+ Aggiungi un elemento')}</button>{/if}
    </div>
  {/if}

  {#if app.issues.length > 0}
    <details>
      <summary>{t('Riparazioni al caricamento ({0})', app.issues.length)}</summary>
      <ul>{#each app.issues as issue, i (i)}<li>{issue}</li>{/each}</ul>
    </details>
  {/if}
  {/if}
</div>

<style>
  .info { padding: 12px 16px; font-size: 13px; display: grid; gap: 18px; align-content: start; overflow: auto; height: 100%; }
  h3 { margin: 0 0 8px; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-muted); }
  .make { display: grid; gap: 6px; }
  .make label { display: grid; gap: 2px; font-size: 11px; color: var(--xb-muted); }
  .mono { font-family: var(--xb-mono); }
  .hint { margin: 4px 0 0; font-size: 12px; color: var(--xb-muted); }
  button, select, input { font: 12.5px var(--xb-sans); padding: 5px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); }
  button { cursor: pointer; text-align: left; }
  button:hover { border-color: var(--xb-accent); }
  .danger { color: var(--xb-danger); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 0; }
  dt { color: var(--xb-muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .field { display: grid; gap: 4px; color: var(--xb-muted); margin-top: 8px; }
  .prop { display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; padding: 6px 0; border-bottom: 1px solid var(--xb-line); }
  .prop .name { grid-column: 1 / -1; }
  .prop small { color: var(--xb-muted); }
  .prop input:not([type='checkbox']) { grid-column: 1 / -1; font-family: var(--xb-mono); }
  .error { grid-column: 1 / -1; color: var(--xb-danger); font-size: 12px; }
  .hint { color: var(--xb-muted); margin: 0 0 6px; }
  .none { color: var(--xb-muted); display: grid; gap: 10px; justify-items: start; }
  .none p { margin: 0; }
  .add { color: var(--xb-link); border-color: var(--xb-accent); }
  h4 { margin: 10px 0 2px; font: 600 11px var(--xb-sans); color: var(--xb-muted); }
  .props { display: grid; gap: 6px; }
  .row { display: grid; grid-template-columns: 76px 1fr; align-items: center; gap: 8px; color: var(--xb-muted); }
  .row.top { align-items: start; }
  .row.top span { padding-top: 6px; }
  textarea { font: 12.5px var(--xb-sans); padding: 5px 8px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); resize: vertical; min-width: 0; }
  .attr { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) 26px; gap: 4px; margin: 0; }
  .mono { font-family: var(--xb-mono); min-width: 0; }
  .icon { text-align: center; padding: 0; color: var(--xb-muted); }
  .icon:disabled { opacity: 0.4; cursor: default; }
  .props .error { margin: 0; }
  .group { display: grid; gap: 6px; margin: 0 0 12px; padding: 10px 10px 8px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); background: var(--xb-bg); }
  .group legend { padding: 0 4px; font: 600 11px var(--xb-sans); color: var(--xb-text); }
  .group .error, .group .warn { margin: 0; font-size: 12px; }
  .warn { color: color-mix(in srgb, var(--xb-coral) 60%, var(--xb-text)); }
  .check { display: flex; align-items: center; gap: 8px; color: var(--xb-text); }
  .check input { margin: 0; padding: 0; }
  .levels { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: var(--xb-r); background: var(--xb-hover); justify-self: start; }
  .levels button { border: 0; background: transparent; padding: 3px 8px; font-weight: 600; font-size: 11.5px; color: var(--xb-muted); }
  .levels button.on { background: var(--xb-bg); color: var(--xb-text); box-shadow: 0 1px 2px rgb(23 26 51 / 0.12); }
  .media { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .file { color: var(--xb-muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .focal {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0 8px;
    font-size: 12px;
  }
  .focal-pick {
    position: relative;
    padding: 0;
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-sm);
    background: var(--xb-stage);
    cursor: crosshair;
    line-height: 0;
    overflow: hidden;
  }
  /* The whole picture, so a click maps to the same point of the image. */
  .focal-pick img {
    display: block;
    width: 120px;
    height: auto;
  }
  .focal-pick .dot {
    position: absolute;
    width: 12px;
    height: 12px;
    margin: -6px 0 0 -6px;
    border-radius: 50%;
    border: 2px solid #fff;
    background: var(--xb-coral);
    box-shadow: 0 0 0 1px #171a33;
  }
</style>
