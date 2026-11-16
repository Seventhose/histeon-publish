<script lang="ts">
  import { parse } from '@xb/dsl';
  import type { ContentData, ProviderField } from '../lib/api.ts';
  import {
    FIELD_TYPES,
    ICONS,
    MAX_SUB,
    SUB_FIELD_TYPES,
    INNER_SUB_FIELD_TYPES,
    SUPPORTS,
    blankField,
    blankSubField,
    blankTaxonomy,
    blankType,
    emptyDefs,
    fieldExpression,
    fieldNameProblem,
    moveField,
    nameProblem,
    optionsText,
    parseOptions,
    problems,
    providerExpression,
    removeTaxonomy,
    removeType,
    renameType,
    targetOf,
    retypeField,
    retypeSub,
    MULTIPLE_LABELS,
    slugify,
    statusOf,
    type ContentDefs,
    type ContentField,
    type FieldGroup,
    type FieldType,
    type SubField,
    type SubFieldType,
  } from '../lib/contentHub.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import ContentTable from './ContentTable.svelte';
  import TermTable from './TermTable.svelte';
  import { t, tn } from '../lib/i18n.ts';

  // Content Hub — docs/spec/content.md. Content types, taxonomies and fields, saved in dev with the site settings
  // and registered in WordPress with the next release; and which fields of ACF, SCF, JetEngine or Meta Box pages may read.
  let { app, visible, adminUrl }: { app: BuilderState; visible: boolean; adminUrl: string | null } = $props();

  type Selection = { kind: 'type' | 'taxonomy' | 'fields' | 'provider' | 'group'; name: string } | null;

  let data = $state<ContentData | null>(null);
  let defs = $state<ContentDefs>(emptyDefs());
  let publicFields = $state<string[]>([]);
  let saved = $state('');
  let selection = $state<Selection>(null);
  let message = $state('');
  let busy = $state(false);
  let creating = $state<'type' | 'taxonomy' | null>(null);
  /** A published type just removed with contents: what to do with them (they stay in the database otherwise). */
  let orphans = $state<{ type: string; label: string; count: number; to: string } | null>(null);
  let newSingular = $state('');
  let newPlural = $state('');
  let newField = $state('');
  let newFieldType = $state<FieldType>('text');

  const canManage = $derived(data?.canManage ?? false);
  const snapshot = $derived(JSON.stringify([defs, [...publicFields].sort()]));
  const dirty = $derived(saved !== '' && snapshot !== saved);
  const issues = $derived(problems(defs));
  const typeNames = $derived(Object.keys(defs.types).sort());
  const taxonomyNames = $derived(Object.keys(defs.taxonomies).sort());
  const live = $derived(data?.live ?? emptyDefs());
  const taken = $derived([...typeNames, ...taxonomyNames, ...(data?.postTypes ?? []).filter((ty) => !ty.own).map((ty) => ty.name)]);
  const providers = $derived((data?.providers ?? []).filter((p) => p.fields.length > 0));
  /** Content types a relation field can point to: the ones created here and those loops may list. */
  const targets = $derived([...typeNames.map((n) => ({ name: n, label: defs.types[n]?.singular ?? n })), ...(data?.postTypes ?? []).filter((ty) => !defs.types[ty.name])]);

  async function refresh() {
    try {
      const fresh = await app.api.getContent();
      data = fresh;
      defs = JSON.parse(JSON.stringify({ ...emptyDefs(), ...fresh.content })) as ContentDefs;
      publicFields = [...fresh.publicFields];
      saved = JSON.stringify([defs, [...publicFields].sort()]);
      if (selection?.kind === 'type' && !defs.types[selection.name]) selection = null;
      if (selection?.kind === 'taxonomy' && !defs.taxonomies[selection.name]) selection = null;
    } catch (e) {
      message = errorText(e);
    }
  }

  $effect(() => {
    if (visible && !data) void refresh();
  });

  const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  function startCreate(kind: 'type' | 'taxonomy') {
    creating = kind;
    newSingular = '';
    newPlural = '';
    message = '';
  }

  function create(event: SubmitEvent) {
    event.preventDefault();
    if (!creating) return;
    const name = slugify(newSingular, creating === 'type' ? 20 : 32);
    const problem = nameProblem(name, taken, creating === 'type' ? 20 : 32);
    if (problem) {
      message = problem;
      return;
    }
    const plural = newPlural.trim() || newSingular.trim();
    if (creating === 'type') defs = { ...defs, types: { ...defs.types, [name]: blankType(newSingular.trim(), plural) } };
    else defs = { ...defs, taxonomies: { ...defs.taxonomies, [name]: blankTaxonomy(newSingular.trim(), plural, selection?.kind === 'type' ? [selection.name] : []) } };
    selection = { kind: creating, name };
    creating = null;
  }

  function setType<K extends keyof ContentDefs['types'][string]>(key: K, value: ContentDefs['types'][string][K]) {
    if (selection?.kind !== 'type') return;
    const current = defs.types[selection.name];
    if (current) defs = { ...defs, types: { ...defs.types, [selection.name]: { ...current, [key]: value } } };
  }

  function setTaxonomy<K extends keyof ContentDefs['taxonomies'][string]>(key: K, value: ContentDefs['taxonomies'][string][K]) {
    if (selection?.kind !== 'taxonomy') return;
    const current = defs.taxonomies[selection.name];
    if (current) defs = { ...defs, taxonomies: { ...defs.taxonomies, [selection.name]: { ...current, [key]: value } } };
  }

  function toggleIn(list: string[], value: string, on: boolean): string[] {
    return on ? [...new Set([...list, value])] : list.filter((v) => v !== value);
  }

  /** The type whose fields are being edited: a type created here, or posts and pages. */
  /** A content type: its definition, or its contents as a table. */
  let view = $state<'definition' | 'contents'>('definition');
  $effect(() => {
    void selection;
    view = 'definition';
  });
  /** The REST route of a registered type the user can edit (null: not live yet, or not editable). */
  const routeOf = (name: string): string | null => data?.postTypes.find((ty) => ty.name === name)?.rest ?? null;
  /** The terms of a taxonomy this user manages (doc 26 voce 212), by its name or by a `term:` key. */
  const termsOf = (name: string) => data?.termTaxonomies?.find((tx) => tx.name === name.replace(/^term:/, '')) ?? null;

  const fieldsOf = $derived(selection?.kind === 'type' || selection?.kind === 'fields' ? selection.name : selection?.kind === 'taxonomy' ? `term:${selection.name}` : selection?.kind === 'group' ? `group:${selection.name}` : null);
  /** Field types the selected target takes: rows (repeater) only in content. */
  const fieldTypes = $derived(fieldsOf && !targetOf(fieldsOf).repeater ? FIELD_TYPES.filter((ty) => ty.value !== 'repeater') : FIELD_TYPES);
  const EXISTING: Array<[string, string]> = [['post', t('Articoli')], ['page', t('Pagine')], ['term:category', t('Categorie')], ['term:post_tag', t('Tag')], ['user', t('Utenti (profilo pubblico)')]];
  const existingLabel = (key: string): string => EXISTING.find(([k]) => k === key)?.[1] ?? key;
  /** The fields edited here: a group's own, or a type's without those of its groups (edited in the group). */
  const fieldList = $derived(!fieldsOf ? [] : fieldsOf.startsWith('group:') ? (defs.groups?.[fieldsOf.slice(6)]?.fields ?? []) : (defs.fields[fieldsOf] ?? []).filter((f) => !f.group));
  /** The fields a type takes from groups, shown as a note. */
  const groupFields = $derived(fieldsOf && !fieldsOf.startsWith('group:') ? (defs.fields[fieldsOf] ?? []).filter((f) => f.group) : []);

  function setFields(list: ContentField[]) {
    if (!fieldsOf) return;
    if (fieldsOf.startsWith('group:')) {
      const name = fieldsOf.slice(6);
      const group = defs.groups?.[name];
      if (group) defs = { ...defs, groups: { ...defs.groups, [name]: { ...group, fields: list } } };
      return;
    }
    const { [fieldsOf]: old, ...rest } = defs.fields;
    const all = [...list, ...(old ?? []).filter((f) => f.group)];
    defs = { ...defs, fields: all.length ? { ...rest, [fieldsOf]: all } : rest };
  }

  /** Groups of fields (doc 26 voce 213). */
  const groupNames = $derived(Object.keys(defs.groups ?? {}).sort());
  /** Types a group can name: the contents created here, posts and pages. */
  const groupTargets = $derived<Array<[string, string]>>([...typeNames.map((n): [string, string] => [n, defs.types[n]?.plural ?? n]), ['post', t('Articoli')], ['page', t('Pagine')]]);
  let newGroup = $state('');
  function addGroup(event: SubmitEvent) {
    event.preventDefault();
    const label = newGroup.trim();
    if (!label) return;
    const name = slugify(label, 40).replace(/-/g, '_').replace(/^[^a-z]+/, '') || 'gruppo';
    const taken = new Set(groupNames);
    let unique = name;
    for (let i = 2; taken.has(unique); i++) unique = `${name}_${i}`;
    defs = { ...defs, groups: { ...(defs.groups ?? {}), [unique]: { label, all: false, types: [], except: [], fields: [] } } };
    newGroup = '';
    selection = { kind: 'group', name: unique };
  }
  function setGroup(patch: Partial<FieldGroup>) {
    if (selection?.kind !== 'group') return;
    const group = defs.groups?.[selection.name];
    if (group) defs = { ...defs, groups: { ...defs.groups, [selection.name]: { ...group, ...patch } } };
  }
  function removeGroup() {
    if (selection?.kind !== 'group') return;
    const { [selection.name]: _gone, ...rest } = defs.groups ?? {};
    defs = { ...defs, groups: rest };
    selection = null;
  }

  function addField(event: SubmitEvent) {
    event.preventDefault();
    const label = newField.trim();
    if (!label) return;
    setFields([...fieldList, blankField(label, newFieldType, fieldList.map((f) => f.name))]);
    newField = '';
  }

  function setField(index: number, patch: Partial<ContentField>) {
    setFields(fieldList.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function setFieldType(index: number, type: FieldType) {
    setFields(fieldList.map((f, i) => (i === index ? retypeField(f, type) : f)));
  }

  /** The fields of each row of a repeater. */
  function setSubs(index: number, sub: SubField[]) {
    setField(index, { sub });
  }

  function setSub(index: number, j: number, patch: Partial<SubField>) {
    const f = fieldList[index];
    if (f) setSubs(index, f.sub.map((s, k) => (k === j ? { ...s, ...patch } : s)));
  }

  let newSub = $state<Record<number, string>>({});
  let newSubType = $state<Record<number, SubFieldType>>({});
  function addSub(event: SubmitEvent, index: number) {
    event.preventDefault();
    const f = fieldList[index];
    const label = (newSub[index] ?? '').trim();
    if (!f || !label || f.sub.length >= MAX_SUB) return;
    setSubs(index, [...f.sub, blankSubField(label, newSubType[index] ?? 'text', f.sub.map((s) => s.name))]);
    newSub = { ...newSub, [index]: '' };
  }

  function rename(to: string) {
    if (selection?.kind !== 'type' || to === selection.name) return;
    const problem = nameProblem(to, taken.filter((ty) => ty !== selection?.name), 20);
    if (problem) {
      message = problem;
      return;
    }
    defs = renameType(defs, selection.name, to);
    selection = { kind: 'type', name: to };
  }

  function remove() {
    if (!selection) return;
    const isLive = selection.kind === 'type' ? !!live.types[selection.name] : !!live.taxonomies[selection.name];
    const what = selection.kind === 'type' ? t('il tipo "{0}"', defs.types[selection.name]?.plural ?? '') : t('la tassonomia "{0}"', defs.taxonomies[selection.name]?.plural ?? '');
    const count = selection.kind === 'type' ? (data?.postTypes.find((ty) => ty.name === selection!.name)?.count ?? 0) : 0;
    const note = isLive
      ? '\n\n' +
        (count > 0
          ? tn('C’è {0} contenuto di questo tipo: resta nel database, ma WordPress non lo mostrerà più finché il tipo non viene ricreato con lo stesso nome tecnico. Dopo potrai spostarlo in un altro tipo o metterlo nel Cestino.', 'Ci sono {0} contenuti di questo tipo: restano nel database, ma WordPress non li mostrerà più finché il tipo non viene ricreato con lo stesso nome tecnico. Dopo potrai spostarli in un altro tipo o metterli nel Cestino.', count, count)
          : t('I contenuti già creati restano nel database, ma WordPress non li mostrerà più finché il tipo non viene ricreato con lo stesso nome tecnico.'))
      : '';
    if (!window.confirm(t('Eliminare {0}?', what) + note)) return;
    if (selection.kind === 'type' && isLive && count > 0) orphans = { type: selection.name, label: defs.types[selection.name]?.plural ?? selection.name, count, to: '' };
    defs = selection.kind === 'type' ? removeType(defs, selection.name) : removeTaxonomy(defs, selection.name);
    selection = null;
  }

  /** Moves or trashes the contents of the removed type, 200 at a time, until none are left or nothing moves. */
  async function settleOrphans(action: 'trash' | 'move') {
    if (!orphans || (action === 'move' && !orphans.to)) return;
    if (action === 'trash' && !window.confirm(tn('Mettere nel Cestino {0} contenuto di «{1}»?', 'Mettere nel Cestino {0} contenuti di «{1}»?', orphans.count, orphans.count, orphans.label))) return;
    busy = true;
    let done = 0;
    try {
      for (;;) {
        const step = await app.api.moveContentItems(orphans.type, action, orphans.to);
        done += step.done;
        if (step.left === 0 || step.done === 0) {
          message =
            step.left === 0
              ? tn('{0} contenuto sistemato.', '{0} contenuti sistemati.', done, done)
              : tn('{0} contenuto sistemato; {1} non si possono spostare con i tuoi permessi.', '{0} contenuti sistemati; {1} non si possono spostare con i tuoi permessi.', done, done, step.left);
          break;
        }
      }
      orphans = null;
    } catch (e) {
      message = errorText(e);
    } finally {
      busy = false;
    }
  }

  function setReadable(field: ProviderField, on: boolean) {
    publicFields = toggleIn(publicFields, field.id, on);
  }

  function setGroupReadable(fields: ProviderField[], on: boolean) {
    let next = publicFields;
    for (const f of fields) if (!f.rest && f.supported && f.type !== 'password') next = toggleIn(next, f.id, on);
    publicFields = next;
  }

  async function save() {
    if (!data || issues.length) return;
    busy = true;
    message = '';
    try {
      const done = await app.api.saveContent(defs, publicFields, data.head, data.base);
      data = { ...data, head: done.head, base: done.base };
      saved = snapshot;
      message = t('Salvato in sviluppo. I tipi e i campi nuovi esistono in WordPress dopo la pubblicazione (Pubblica… in alto); i campi resi pubblici si vedono già in anteprima.');
      void app.refreshPreview();
    } catch (e) {
      message = errorText(e);
    } finally {
      busy = false;
    }
  }

  function insertExpression(expression: string) {
    try {
      app.insert(parse(expression).blocks);
    } catch (e) {
      message = errorText(e);
    }
  }

  let copied = $state('');
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard: the expression stays visible, to select by hand.
    }
    copied = text;
    setTimeout(() => (copied === text ? (copied = '') : null), 1500);
  }

  const adminLink = (path: string): string | null => {
    if (!adminUrl) return null;
    try {
      return new URL(path, adminUrl).toString();
    } catch {
      return null;
    }
  };

  const STATUS = { new: t('Da pubblicare'), changed: t('Modificato'), live: t('Online') } as const;
  const groups = (fields: ProviderField[]) => {
    const out = new Map<string, { label: string; types: string[]; fields: ProviderField[] }>();
    for (const f of fields) {
      const g = out.get(f.group) ?? { label: f.groupLabel, types: f.optionsPage ? [t('pagina di opzioni «{0}»', f.optionsPage)] : f.postTypes, fields: [] };
      g.fields.push(f);
      out.set(f.group, g);
    }
    return [...out.values()];
  };
  const readable = (f: ProviderField) => f.rest || publicFields.includes(f.id);
</script>

<div class="panel">
  <header>
    <div class="row">
      {#if canManage}
        <button onclick={() => startCreate('type')}>+ {t('Tipo di contenuto')}</button>
        <button onclick={() => startCreate('taxonomy')}>+ {t('Tassonomia')}</button>
      {/if}
    </div>
    {#if canManage}<button class="primary" onclick={save} disabled={!dirty || busy || issues.length > 0}>{t('Salva tipi e campi')}{dirty ? ' •' : ''}</button>{/if}
  </header>

  {#if message}<p class="message" role="status">{message}</p>{/if}
  {#if orphans}
    <div class="orphans" role="group" aria-label={t('Contenuti del tipo eliminato')}>
      <p>{tn('{0} contenuto di «{1}» resterebbe nel database senza tipo.', '{0} contenuti di «{1}» resterebbero nel database senza tipo.', orphans.count, orphans.count, orphans.label)}</p>
      <label>{t('Sposta in')}
        <select bind:value={orphans.to}>
          <option value="">{t('Scegli un tipo')}</option>
          {#each (data?.postTypes ?? []).filter((ty) => ty.name !== orphans?.type && ty.name !== 'page' && ty.name !== 'attachment') as ty (ty.name)}<option value={ty.name}>{ty.label}</option>{/each}
        </select>
      </label>
      <button onclick={() => settleOrphans('move')} disabled={busy || !orphans.to}>{t('Sposta')}</button>
      <button class="danger" onclick={() => settleOrphans('trash')} disabled={busy}>{t('Metti nel Cestino')}</button>
      <button onclick={() => (orphans = null)}>{t('Lasciali')}</button>
    </div>
  {/if}
  {#if !canManage && data}<p class="message">{t('Solo un amministratore può creare tipi di contenuto e decidere quali campi leggono le pagine. Puoi vedere i campi e usarne le espressioni.')}</p>{/if}
  {#if issues.length && dirty}<ul class="issues" aria-label={t('Da correggere prima di salvare')}>{#each issues as issue (issue)}<li>{issue}</li>{/each}</ul>{/if}

  {#if creating}
    <form class="create" onsubmit={create}>
      <strong>{creating === 'type' ? t('Nuovo tipo di contenuto') : t('Nuova tassonomia')}</strong>
      <label>{t('Nome singolare')} <input bind:value={newSingular} placeholder={creating === 'type' ? t('Evento') : t('Luogo')} /></label>
      <label>{t('Plurale')} <input bind:value={newPlural} placeholder={creating === 'type' ? t('Eventi') : t('Luoghi')} /></label>
      <span class="muted">{t('Nome tecnico:')} <code>{slugify(newSingular, creating === 'type' ? 20 : 32) || '…'}</code></span>
      <button type="submit" class="primary" disabled={!newSingular.trim()}>{t('Crea')}</button>
      <button type="button" onclick={() => (creating = null)}>{t('Annulla')}</button>
    </form>
  {/if}

  <div class="body">
    <ul class="list" aria-label={t('Tipi e campi')}>
      <li class="group">{t('Tipi di contenuto')}</li>
      {#each typeNames as name (name)}
        {@const ty = defs.types[name]}
        {@const status = statusOf('types', name, defs, live)}
        <li>
          <button class:active={selection?.kind === 'type' && selection.name === name} onclick={() => (selection = { kind: 'type', name })}>
            <span class="label">{ty?.plural}</span>
            <small><code>{name}</code> · {tn('{0} campo', '{0} campi', (defs.fields[name] ?? []).length, (defs.fields[name] ?? []).length)} <span class="badge {status}">{STATUS[status]}</span></small>
          </button>
        </li>
      {:else}
        <li class="empty">{t('Eventi, sedi, prodotti, persone… Ogni tipo ha i suoi campi e, se vuoi, le sue pagine.')}</li>
      {/each}

      <li class="group">{t('Tassonomie')}</li>
      {#each taxonomyNames as name (name)}
        {@const ty = defs.taxonomies[name]}
        {@const status = statusOf('taxonomies', name, defs, live)}
        <li>
          <button class:active={selection?.kind === 'taxonomy' && selection.name === name} onclick={() => (selection = { kind: 'taxonomy', name })}>
            <span class="label">{ty?.plural}</span>
            <small><code>{name}</code> · {ty?.hierarchical ? t('categorie') : t('tag')} <span class="badge {status}">{STATUS[status]}</span></small>
          </button>
        </li>
      {:else}
        <li class="empty">{t('Per raggruppare i contenuti: categorie (annidate) o tag.')}</li>
      {/each}

      <li class="group">{t('Gruppi di campi')}</li>
      {#each groupNames as name (name)}
        {@const g = defs.groups?.[name]}
        <li>
          <button class:active={selection?.kind === 'group' && selection.name === name} onclick={() => (selection = { kind: 'group', name })}>
            <span class="label">{g?.label}</span>
            <small>{tn('{0} campo', '{0} campi', g?.fields.length ?? 0, g?.fields.length ?? 0)} · {g?.all ? t('tutti i tipi tranne {0}', g.except.length) : tn('{0} tipo', '{0} tipi', g?.types.length ?? 0, g?.types.length ?? 0)}</small>
          </button>
        </li>
      {/each}
      {#if canManage}
        <li><form class="new-group" onsubmit={addGroup}><input bind:value={newGroup} placeholder={t('Nuovo gruppo (es. Contatti)')} aria-label={t('Nome del nuovo gruppo di campi')} /><button type="submit" disabled={!newGroup.trim()}>+</button></form></li>
      {/if}

      <li class="group">{t('Campi di contenuti, categorie e utenti')}</li>
      {#each EXISTING as [name, label] (name)}
        <li>
          <button class:active={selection?.kind === 'fields' && selection.name === name} onclick={() => (selection = { kind: 'fields', name: name as string })}>
            <span class="label">{label}</span>
            <small>{tn('{0} campo', '{0} campi', (defs.fields[name as string] ?? []).length, (defs.fields[name as string] ?? []).length)}</small>
          </button>
        </li>
      {/each}

      {#if providers.length}
        <li class="group">{t('Campi di altri plugin')}</li>
        {#each providers as p (p.id)}
          <li>
            <button class:active={selection?.kind === 'provider' && selection.name === p.id} onclick={() => (selection = { kind: 'provider', name: p.id })}>
              <span class="label">{p.label}</span>
              <small>{t('{0} di {1} leggibili', p.fields.filter(readable).length, p.fields.length)}</small>
            </button>
          </li>
        {/each}
      {/if}
    </ul>

    {#if (selection?.kind === 'type' || (selection?.kind === 'fields' && targetOf(selection.name).kind === 'post')) && view === 'contents' && routeOf(selection.name)}
      <section class="edit wide" aria-label={t('Contenuti di {0}', (selection.kind === 'type' ? defs.types[selection.name]?.plural : existingLabel(selection.name)) ?? '')}>
        {@render views(selection.name)}
        <ContentTable api={app.api} route={routeOf(selection.name) ?? ''} label={selection.kind === 'type' ? (defs.types[selection.name]?.plural ?? selection.name) : existingLabel(selection.name)} fields={live.fields[selection.name] ?? []} {adminUrl} routeFor={routeOf} />
      </section>
    {:else if (selection?.kind === 'taxonomy' || (selection?.kind === 'fields' && targetOf(selection.name).kind === 'term')) && view === 'contents' && termsOf(selection.name)}
      {@const tx = termsOf(selection.name)!}
      {@const txLabel = selection.kind === 'taxonomy' ? (defs.taxonomies[selection.name]?.plural ?? tx.label) : existingLabel(selection.name)}
      <section class="edit wide" aria-label={t('Termini di {0}', txLabel)}>
        {@render views(selection.name)}
        <TermTable api={app.api} route={tx.rest} taxonomy={tx.name} label={txLabel} hierarchical={tx.hierarchical} fields={live.fields[selection.kind === 'taxonomy' ? `term:${selection.name}` : selection.name] ?? []} {adminUrl} />
      </section>
    {:else if selection?.kind === 'type' && defs.types[selection.name]}
      {@const ty = defs.types[selection.name]!}
      {@const isLive = !!live.types[selection.name]}
      <section class="edit" aria-label={t('Tipo {0}', ty.plural)}>
        {@render views(selection.name)}
        <fieldset disabled={!canManage}>
          <div class="grid">
            <label>{t('Singolare')} <input value={ty.singular} oninput={(e) => setType('singular', e.currentTarget.value)} /></label>
            <label>{t('Plurale')} <input value={ty.plural} oninput={(e) => setType('plural', e.currentTarget.value)} /></label>
            <label>
              {t('Nome tecnico')}
              <input class="mono" value={selection.name} readonly={isLive} onchange={(e) => rename(e.currentTarget.value.trim())} title={isLive ? t('Già online: cambiarlo staccherebbe i contenuti esistenti') : ''} />
            </label>
            <label>{t('Icona')}
              <select value={ty.icon} onchange={(e) => setType('icon', e.currentTarget.value)}>
                {#each ICONS as icon (icon)}<option value={icon}>{icon.replace('dashicons-', '')}</option>{/each}
              </select>
            </label>
          </div>
          <div class="switches">
            <label><input type="checkbox" checked={ty.public} onchange={(e) => setType('public', e.currentTarget.checked)} /> {ty.archive ? t('Pagine proprie (singolo e archivio)') : t('Pagine proprie (singolo)')}</label>
            {#if ty.public}
              <label><input type="checkbox" checked={ty.archive} onchange={(e) => setType('archive', e.currentTarget.checked)} /> {t('Archivio')}</label>
              <label class="slug">{t('Indirizzo')} <span class="muted">/</span><input class="mono" value={ty.slug} onchange={(e) => setType('slug', slugify(e.currentTarget.value, 60).replace(/_/g, '-'))} /><span class="muted">/</span></label>
            {/if}
            <label><input type="checkbox" checked={ty.hierarchical} onchange={(e) => setType('hierarchical', e.currentTarget.checked)} /> {t('Con genitori (come le pagine)')}</label>
            <label>{t('Gestito come')}
              <select value={ty.capability} onchange={(e) => setType('capability', e.currentTarget.value === 'page' ? 'page' : 'post')}>
                <option value="post">{t('articoli (anche gli autori)')}</option>
                <option value="page">{t('pagine (redattori e amministratori)')}</option>
              </select>
            </label>
          </div>
          {#if !ty.public}<p class="help">{t("Senza pagine proprie i contenuti non hanno un indirizzo e non compaiono nella ricerca né nell'API pubblica: si mostrano solo dove li metti con un loop.")}</p>{/if}
          <div class="chips" role="group" aria-label={t('Cosa si modifica')}>
            {#each SUPPORTS as s (s.value)}
              <label class="chip"><input type="checkbox" checked={ty.supports.includes(s.value)} onchange={(e) => setType('supports', toggleIn(ty.supports, s.value, e.currentTarget.checked))} /> {s.label}</label>
            {/each}
          </div>
        </fieldset>
        {@render fieldsEditor()}
        {#if canManage}
          <div class="row end"><button class="danger" onclick={remove}>{t('Elimina il tipo')}</button></div>
        {/if}
      </section>
      {@render usage(selection.name, isLive, ty.public)}
    {:else if selection?.kind === 'taxonomy' && defs.taxonomies[selection.name]}
      {@const ty = defs.taxonomies[selection.name]!}
      <section class="edit" aria-label={t('Tassonomia {0}', ty.plural)}>
        {@render views(selection.name)}
        <fieldset disabled={!canManage}>
          <div class="grid">
            <label>{t('Singolare')} <input value={ty.singular} oninput={(e) => setTaxonomy('singular', e.currentTarget.value)} /></label>
            <label>{t('Plurale')} <input value={ty.plural} oninput={(e) => setTaxonomy('plural', e.currentTarget.value)} /></label>
            <label>{t('Nome tecnico')} <input class="mono" value={selection.name} readonly /></label>
          </div>
          <div class="segmented" role="tablist" aria-label={t('Forma')}>
            <button role="tab" aria-selected={ty.hierarchical} class:active={ty.hierarchical} onclick={() => setTaxonomy('hierarchical', true)}>{t('Categorie (annidate)')}</button>
            <button role="tab" aria-selected={!ty.hierarchical} class:active={!ty.hierarchical} onclick={() => setTaxonomy('hierarchical', false)}>{t('Tag')}</button>
          </div>
          <div class="switches">
            <label><input type="checkbox" checked={ty.public} onchange={(e) => setTaxonomy('public', e.currentTarget.checked)} /> {t('Pagine proprie (archivio di ogni termine)')}</label>
            {#if ty.public}<label class="slug">{t('Indirizzo')} <span class="muted">/</span><input class="mono" value={ty.slug} onchange={(e) => setTaxonomy('slug', slugify(e.currentTarget.value, 60).replace(/_/g, '-'))} /><span class="muted">{t('/termine/')}</span></label>{/if}
          </div>
          <div class="chips" role="group" aria-label={t('Si usa con')}>
            <span class="muted">{t('Si usa con:')}</span>
            {#each [...typeNames.map((n) => [n, defs.types[n]?.plural ?? n]), ['post', t('Articoli')], ['page', t('Pagine')]] as [name, label] (name)}
              <label class="chip"><input type="checkbox" checked={ty.types.includes(name as string)} onchange={(e) => setTaxonomy('types', toggleIn(ty.types, name as string, e.currentTarget.checked))} /> {label}</label>
            {/each}
          </div>
        </fieldset>
        <p class="help">{t('Campi dei termini: si compilano nella schermata del termine in WordPress e si leggono con')} <code>{`{item.fields.nome}`}</code> {t('in un loop di termini.')}</p>
        {@render fieldsEditor()}
        {#if canManage}<div class="row end"><button class="danger" onclick={remove}>{t('Elimina la tassonomia')}</button></div>{/if}
      </section>
      {@render usage(`term:${selection.name}`, !!live.taxonomies[selection.name], false)}
    {:else if selection?.kind === 'group' && defs.groups?.[selection.name]}
      {@const g = defs.groups[selection.name]!}
      <section class="edit" aria-label={t('Gruppo di campi {0}', g.label)}>
        <fieldset disabled={!canManage}>
          <div class="grid">
            <label>{t('Nome')} <input value={g.label} oninput={(e) => setGroup({ label: e.currentTarget.value })} /></label>
            <label>{t('Nome tecnico')} <input class="mono" value={selection.name} readonly /></label>
          </div>
          <div class="segmented" role="tablist" aria-label={t('Vale per')}>
            <button role="tab" aria-selected={!g.all} class:active={!g.all} onclick={() => setGroup({ all: false })}>{t('Solo questi tipi')}</button>
            <button role="tab" aria-selected={g.all} class:active={g.all} onclick={() => setGroup({ all: true })}>{t('Tutti tranne')}</button>
          </div>
          <div class="chips" role="group" aria-label={g.all ? t('Tipi esclusi') : t('Tipi del gruppo')}>
            {#each groupTargets as [name, label] (name)}
              {@const list = g.all ? g.except : g.types}
              <label class="chip"><input type="checkbox" checked={list.includes(name)} onchange={(e) => setGroup(g.all ? { except: toggleIn(g.except, name, e.currentTarget.checked) } : { types: toggleIn(g.types, name, e.currentTarget.checked) })} /> {label}</label>
            {/each}
          </div>
        </fieldset>
        <p class="help">{t('I campi del gruppo vanno in ogni tipo scelto, e si leggono come i suoi: {0}. Se un tipo ha già un campo con lo stesso nome, vale il suo. Un tipo creato dopo riceve i campi quando salvi.', '{this.fields.nome}')}</p>
        {@render fieldsEditor()}
        {#if canManage}<div class="row end"><button class="danger" onclick={removeGroup}>{t('Elimina il gruppo')}</button></div>{/if}
      </section>
    {:else if selection?.kind === 'fields'}
      {@const target = targetOf(selection.name)}
      <section class="edit" aria-label={t('Campi di {0}', existingLabel(selection.name))}>
        {#if target.kind === 'post' || target.kind === 'term'}{@render views(selection.name)}{/if}
        <p class="help">
          {t('Campi in più per {0}:', existingLabel(selection.name).toLowerCase())}
          {#if target.kind === 'post'}{t("si compilano nell'editor a blocchi (pannello «Campi»)")}{:else if target.kind === 'term'}{t('si compilano nella schermata del termine in WordPress')}{:else}{t("si compilano nel profilo dell'utente e si vedono solo nei profili pubblici (autori), mai per chi visita")}{/if}
          {t('e si leggono con')} <code>{`{${target.single}.fields.nome}`}</code>.
        </p>
        {@render fieldsEditor()}
      </section>
      {@render usage(selection.name, true, true)}
    {:else if selection?.kind === 'provider'}
      {@const p = providers.find((x) => x.id === selection?.name)}
      {#if p}
        <section class="edit wide" aria-label={t('Campi di {0}', p.label)}>
          <p class="help">
            {t('I campi di {0} possono contenere anche dati interni: una pagina ne legge uno solo se lo rendi leggibile qui (vale dalla prossima release, in anteprima subito).', p.label)}
            {t("Quelli che {0} pubblica già nell'API REST sono leggibili di loro. I campi password non lo sono mai.", p.label)}
          </p>
          {#each groups(p.fields) as g (g.label)}
            {@const optional = g.fields.filter((f) => !f.rest && f.supported && f.type !== 'password')}
            <div class="provider-group">
              <div class="row">
                <strong>{g.label}</strong>
                {#if g.types.length}<span class="muted">· {g.types.join(', ')}</span>{/if}
                {#if canManage && optional.length}
                  <label class="all"><input type="checkbox" checked={optional.every((f) => publicFields.includes(f.id))} onchange={(e) => setGroupReadable(g.fields, e.currentTarget.checked)} /> {t('tutti leggibili')}</label>
                {/if}
              </div>
              <table>
                <tbody>
                  {#each g.fields as f (f.id)}
                    <tr class:off={!readable(f)}>
                      <td class="check">
                        <input type="checkbox" checked={readable(f)} disabled={!canManage || f.rest || !f.supported || f.type === 'password'} onchange={(e) => setReadable(f, e.currentTarget.checked)} aria-label={t('Leggibile dalle pagine: {0}', f.label)} />
                      </td>
                      <td>{f.label}<br /><small class="muted">{f.type}{f.rest ? ' · ' + t('pubblico via REST') : ''}{!f.supported || f.type === 'password' ? ' · ' + t('non leggibile') : ''}{f.sub.length ? ` · ${f.sub.map((s) => s.name).join(', ')}` : ''}</small></td>
                      <td class="expr">
                        {#if readable(f) && f.supported}
                          {@const expression = providerExpression(f)}
                          <code>{expression}</code>
                          <button onclick={() => copy(expression)}>{copied === expression ? '✓' : t('Copia')}</button>
                          {#if app.selected}<button onclick={() => insertExpression(expression)}>{t('Inserisci')}</button>{/if}
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/each}
        </section>
      {/if}
    {:else}
      <div class="placeholder">
        <p><strong>{t('I tuoi contenuti, con i loro campi.')}</strong></p>
        <p>{t("Crea un tipo di contenuto (Eventi, Sedi, Prodotti…) con i campi che servono: data, prezzo, immagine, contenuto collegato. Si compilano nell'editor a blocchi e le pagine li leggono con")} <code>{'{this.fields.nome}'}</code>, {t('o')} <code>{'{item.fields.nome}'}</code> {t('in un loop.')}</p>
        <p>{t('Usi già ACF, Secure Custom Fields, JetEngine o Meta Box? I loro campi compaiono qui: scegli quali possono leggere le pagine.')}</p>
        <p class="muted">{t('Tutto si salva in sviluppo e va online con la prossima release, come il resto del sito.')}</p>
      </div>
    {/if}
  </div>
</div>

{#snippet fieldsEditor()}
  <div class="fields">
    <h4>{t('Campi')}</h4>
    {#if groupFields.length}<p class="help">{t('Dai gruppi di campi: {0}. Si cambiano nel loro gruppo.', [...new Set(groupFields.map((f) => defs.groups?.[f.group ?? '']?.label ?? f.group))].join(', '))}</p>{/if}
    {#each fieldList as f, i (f.name + i)}
      <div class="field">
        <div class="field-head">
          <input class="flabel" value={f.label} disabled={!canManage} oninput={(e) => setField(i, { label: e.currentTarget.value })} aria-label={t('Etichetta del campo {0}', f.name)} />
          <input class="mono fname" value={f.name} disabled={!canManage} onchange={(e) => {
            const name = e.currentTarget.value.trim();
            const problem = fieldNameProblem(name, fieldList.filter((_, j) => j !== i).map((x) => x.name));
            if (problem) { message = problem; e.currentTarget.value = f.name; } else setField(i, { name });
          }} aria-label={t('Nome del campo {0}', f.label)} />
          <select value={f.type} disabled={!canManage} onchange={(e) => setFieldType(i, e.currentTarget.value as FieldType)} aria-label={t('Tipo del campo {0}', f.label)}>
            {#each fieldTypes as ft (ft.value)}<option value={ft.value}>{ft.label}</option>{/each}
          </select>
          {#if canManage}
            <span class="tools">
              <button class="icon" onclick={() => setFields(moveField(fieldList, i, -1))} disabled={i === 0} aria-label={t('Sposta su {0}', f.label)}>▴</button>
              <button class="icon" onclick={() => setFields(moveField(fieldList, i, 1))} disabled={i === fieldList.length - 1} aria-label={t('Sposta giù {0}', f.label)}>▾</button>
              <button class="icon" onclick={() => setFields(fieldList.filter((_, j) => j !== i))} aria-label={t('Elimina il campo {0}', f.label)}>×</button>
            </span>
          {/if}
        </div>
        {#if MULTIPLE_LABELS[f.type] && fieldsOf && targetOf(fieldsOf).kind === 'post'}
          <label class="sub check"><input type="checkbox" checked={f.multiple === true} disabled={!canManage} onchange={(e) => setField(i, e.currentTarget.checked ? { multiple: true, radio: false } : { multiple: false })} /> {MULTIPLE_LABELS[f.type]} <span class="muted">{t('nella pagina si leggono con un loop')}</span></label>
        {/if}
        {#if f.type === 'select'}
          {#if !f.multiple}<label class="sub check"><input type="checkbox" checked={f.radio === true} disabled={!canManage} onchange={(e) => setField(i, { radio: e.currentTarget.checked })} /> {t('Pulsanti di scelta invece del menu')}</label>{/if}
          <label class="sub">{t('Opzioni, una per riga')} (<code>{t('valore: Etichetta')}</code>)
            <textarea rows="3" disabled={!canManage} value={optionsText(f.options)} onchange={(e) => setField(i, { options: parseOptions(e.currentTarget.value) })}></textarea>
          </label>
        {:else if f.type === 'post'}
          <label class="sub">{t('Collega un contenuto di tipo')}
            <select value={f.postType} disabled={!canManage} onchange={(e) => setField(i, { postType: e.currentTarget.value })}>
              <option value="">{t('— scegli —')}</option>
              {#each targets as ty (ty.name)}<option value={ty.name}>{ty.label}</option>{/each}
            </select>
          </label>
        {:else if f.type === 'repeater'}
          <div class="subs" role="group" aria-label={t('Campi di ogni riga di {0}', f.label)}>
            <span class="sub">{t('Campi di ogni riga (al massimo {0}); nella pagina:', MAX_SUB)} <code>{fieldExpression('this', f.name, f.type, f.sub)}</code></span>
            {#each f.sub as s, j (s.name + j)}
              <div class="subfield">
                <div class="field-head">
                  <input value={s.label} disabled={!canManage} oninput={(e) => setSub(i, j, { label: e.currentTarget.value })} aria-label={t('Etichetta di {0} in {1}', s.name, f.label)} />
                  <input class="mono" value={s.name} disabled={!canManage} onchange={(e) => {
                    const name = e.currentTarget.value.trim();
                    const problem = fieldNameProblem(name, f.sub.filter((_, k) => k !== j).map((x) => x.name));
                    if (problem) { message = problem; e.currentTarget.value = s.name; } else setSub(i, j, { name });
                  }} aria-label={t('Nome di {0} in {1}', s.label, f.label)} />
                  <select value={s.type} disabled={!canManage} onchange={(e) => setSubs(i, f.sub.map((x, k) => (k === j ? retypeSub(x, e.currentTarget.value as SubFieldType) : x)))} aria-label={t('Tipo di {0} in {1}', s.label, f.label)}>
                    {#each SUB_FIELD_TYPES as ft (ft.value)}<option value={ft.value}>{ft.label}</option>{/each}
                  </select>
                  {#if canManage}
                    <span class="tools">
                      <button class="icon" onclick={() => setSubs(i, moveField(f.sub, j, -1))} disabled={j === 0} aria-label={t('Sposta su {0} in {1}', s.label, f.label)}>▴</button>
                      <button class="icon" onclick={() => setSubs(i, moveField(f.sub, j, 1))} disabled={j === f.sub.length - 1} aria-label={t('Sposta giù {0} in {1}', s.label, f.label)}>▾</button>
                      <button class="icon" onclick={() => setSubs(i, f.sub.filter((_, k) => k !== j))} disabled={f.sub.length === 1} aria-label={t('Elimina {0} da {1}', s.label, f.label)}>×</button>
                    </span>
                  {/if}
                </div>
                {#if s.type === 'select'}
                  <label class="sub">{t('Opzioni, una per riga')} (<code>{t('valore: Etichetta')}</code>)
                    <textarea rows="2" disabled={!canManage} value={optionsText(s.options)} onchange={(e) => setSub(i, j, { options: parseOptions(e.currentTarget.value) })}></textarea>
                  </label>
                {:else if s.type === 'repeater'}
                  <!-- A repeater inside the row (D6): its own fields, one level only. -->
                  {@const inner = s.sub ?? []}
                  <div class="subs inner" role="group" aria-label={t('Campi di ogni riga di {0}', s.label)}>
                    {#each inner as x, k (x.name + k)}
                      <div class="field-head">
                        <input value={x.label} disabled={!canManage} oninput={(e) => setSub(i, j, { sub: inner.map((y, m) => (m === k ? { ...y, label: e.currentTarget.value } : y)) })} aria-label={t('Etichetta di {0} in {1}', x.name, s.label)} />
                        <input class="mono" value={x.name} disabled={!canManage} onchange={(e) => {
                          const name = e.currentTarget.value.trim();
                          const problem = fieldNameProblem(name, inner.filter((_, m) => m !== k).map((y) => y.name));
                          if (problem) { message = problem; e.currentTarget.value = x.name; } else setSub(i, j, { sub: inner.map((y, m) => (m === k ? { ...y, name } : y)) });
                        }} aria-label={t('Nome di {0} in {1}', x.label, s.label)} />
                        <select value={x.type} disabled={!canManage} onchange={(e) => setSub(i, j, { sub: inner.map((y, m) => (m === k ? retypeSub(y, e.currentTarget.value as SubFieldType) : y)) })} aria-label={t('Tipo di {0} in {1}', x.label, s.label)}>
                          {#each INNER_SUB_FIELD_TYPES as ft (ft.value)}<option value={ft.value}>{ft.label}</option>{/each}
                        </select>
                        {#if canManage}<button class="icon" onclick={() => setSub(i, j, { sub: inner.filter((_, m) => m !== k) })} disabled={inner.length === 1} aria-label={t('Elimina {0} da {1}', x.label, s.label)}>×</button>{/if}
                      </div>
                    {/each}
                    {#if canManage && inner.length < MAX_SUB}
                      <button class="add-inner" onclick={() => setSub(i, j, { sub: [...inner, blankSubField(t('Campo'), 'text', inner.map((y) => y.name))] })}>+ {t('Campo della riga di {0}', s.label)}</button>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
            {#if canManage && f.sub.length < MAX_SUB}
              <form class="row" onsubmit={(e) => addSub(e, i)}>
                <input value={newSub[i] ?? ''} oninput={(e) => (newSub = { ...newSub, [i]: e.currentTarget.value })} placeholder={t('Etichetta (es. Giorno)')} aria-label={t('Etichetta del nuovo campo di {0}', f.label)} />
                <select value={newSubType[i] ?? 'text'} onchange={(e) => (newSubType = { ...newSubType, [i]: e.currentTarget.value as SubFieldType })} aria-label={t('Tipo del nuovo campo di {0}', f.label)}>
                  {#each SUB_FIELD_TYPES as ft (ft.value)}<option value={ft.value}>{ft.label}</option>{/each}
                </select>
                <button type="submit" disabled={!(newSub[i] ?? '').trim()}>+ {t('Campo della riga')}</button>
              </form>
            {/if}
          </div>
        {/if}
        <input class="help-input" value={f.help} disabled={!canManage} placeholder={t('Aiuto per chi compila (facoltativo)')} oninput={(e) => setField(i, { help: e.currentTarget.value })} aria-label={t('Aiuto del campo {0}', f.label)} />
      </div>
    {:else}
      <p class="help">{t('Nessun campo: aggiungine uno qui sotto.')}</p>
    {/each}
    {#if canManage}
      <form class="row" onsubmit={addField}>
        <input bind:value={newField} placeholder={t('Etichetta del nuovo campo (es. Prezzo)')} aria-label={t('Etichetta del nuovo campo')} />
        <select bind:value={newFieldType} aria-label={t('Tipo del nuovo campo')}>
          {#each fieldTypes as ft (ft.value)}<option value={ft.value}>{ft.label} — {ft.hint}</option>{/each}
        </select>
        <button type="submit" disabled={!newField.trim()}>+ {t('Campo')}</button>
      </form>
    {/if}
  </div>
{/snippet}

{#snippet views(type: string)}
  {#if routeOf(type) || termsOf(type)}
    <div class="segmented" role="tablist" aria-label={t('Vista')}>
      <button role="tab" aria-selected={view === 'definition'} class:active={view === 'definition'} onclick={() => (view = 'definition')}>{t('Definizione')}</button>
      <button role="tab" aria-selected={view === 'contents'} class:active={view === 'contents'} onclick={() => (view = 'contents')}>{routeOf(type) ? t('Contenuti') : t('Termini')}</button>
    </div>
  {/if}
{/snippet}

{#snippet usage(type: string, isLive: boolean, hasPages: boolean)}
  {@const target = targetOf(type)}
  {@const link = adminLink(target.kind === 'user' ? 'users.php' : target.kind === 'term' ? `edit-tags.php?taxonomy=${type.slice(5)}` : `edit.php?post_type=${type}`)}
  <aside class="data">
    <h4>{t('Usali nella pagina')}</h4>
    {#if (defs.fields[type] ?? []).length}
      <table class="exprs">
        <tbody>
          {#each defs.fields[type] ?? [] as f (f.name)}
            {@const single = fieldExpression(targetOf(type).single, f.name, f.type, f.sub)}
            {@const loop = fieldExpression(targetOf(type).loop, f.name, f.type, f.sub)}
            <tr>
              <td>{f.label}</td>
              <td><code>{single}</code><br /><code class="muted">{loop}</code></td>
              <td class="actions">
                <button onclick={() => copy(single)}>{copied === single ? '✓' : t('Copia')}</button>
                {#if app.selected}<button onclick={() => insertExpression(single)} title={t("Inserisci come testo nell'elemento selezionato")}>{t('Inserisci')}</button>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if targetOf(type).kind === 'post'}
        <p class="help"><code>this</code> {t('nel modello di un singolo contenuto;')} <code>item</code> {t('dentro un loop (Dati e query → una query di questo tipo).')}</p>
      {:else if targetOf(type).kind === 'term'}
        <p class="help">{t('Il primo termine di un contenuto, oppure')} <code>item</code> {t('in un loop di termini (Dati e query → «Categorie e termini»).')}</p>
      {:else}
        <p class="help">{t("L'autore di un contenuto, oppure")} <code>item</code> {t('in un loop di utenti (Dati e query → «Utenti»).')}</p>
      {/if}
    {:else}
      <p class="help">{t('Aggiungi dei campi: qui compaiono le espressioni per mostrarli.')}</p>
    {/if}
    {#if isLive && link}
      <p><a href={link} target="_top">{target.kind === 'user' ? t('Apri gli utenti in WordPress') : target.kind === 'term' ? t('Apri i termini in WordPress') : t('Apri i contenuti in WordPress')} ↗</a></p>
    {:else if !isLive}
      <p class="help">{t('Esisterà in WordPress dopo la pubblicazione: salva, poi')} <strong>{t('Pubblica…')}</strong> {t('in alto.')}</p>
    {/if}
    {#if hasPages && defs.types[type]?.public}
      <p class="help">{t('Pagine:')} <code>/{defs.types[type]?.slug}/</code> ({t('archivio')}) {t('e')} <code>/{defs.types[type]?.slug}/{t('nome-del-contenuto')}/</code>. {t('I loro modelli sono in')} <em>{t('Template')}</em>.</p>
    {/if}
  </aside>
{/snippet}

<style>
  .new-group { display: flex; gap: 4px; padding: 2px 4px; }
  .new-group input { flex: 1; min-width: 0; }
  .panel { display: grid; grid-template-rows: auto auto auto auto 1fr; height: 100%; min-height: 0; font-size: 13px; }
  header { display: flex; gap: 8px; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--xb-line); }
  input, select, textarea { font: 12.5px var(--xb-sans); padding: 5px 7px; background: var(--xb-bg); color: var(--xb-text); border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm); }
  .mono { font-family: var(--xb-mono); }
  button { font: 12px var(--xb-sans); padding: 4px 10px; border-radius: var(--xb-r-sm); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  button.primary { background: var(--xb-ink); border-color: var(--xb-ink); color: var(--xb-on-ink); font-weight: 600; }
  button.danger { color: var(--xb-danger); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.icon { border: 0; padding: 2px 5px; color: var(--xb-muted); }
  .message { margin: 0; padding: 6px 12px; color: var(--xb-muted); }
  .orphans { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0 12px 8px; padding: 8px 10px; border: 1px solid var(--xb-line); border-radius: var(--xb-r); }
  .orphans p { flex-basis: 100%; margin: 0; }
  .issues { margin: 0; padding: 6px 12px 6px 28px; color: var(--xb-danger); font-size: 12px; }
  .create { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--xb-line); background: var(--xb-panel); }
  .create label { display: flex; gap: 6px; align-items: center; color: var(--xb-muted); }
  .body { display: grid; grid-template-columns: 230px minmax(360px, 1.3fr) minmax(280px, 1fr); min-height: 0; }
  .list { list-style: none; margin: 0; padding: 8px; border-right: 1px solid var(--xb-line); overflow: auto; }
  .list button { width: 100%; text-align: left; border-color: transparent; padding: 7px 10px; border-radius: var(--xb-r); }
  .list button.active { background: var(--xb-accent-bg); border-color: var(--xb-accent); }
  .list .label { font-weight: 600; }
  .list small { display: block; margin-top: 2px; color: var(--xb-muted); }
  .group { padding: 10px 8px 4px; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-muted); }
  .empty { color: var(--xb-muted); padding: 4px 8px; font-size: 12px; }
  .badge { display: inline-block; margin-left: 4px; padding: 0 6px; border-radius: 9px; font-size: 10.5px; background: var(--xb-hover); }
  .badge.new { background: color-mix(in srgb, var(--xb-warn) 14%, transparent); color: var(--xb-warn); }
  .badge.changed { background: color-mix(in srgb, var(--xb-info) 14%, transparent); color: var(--xb-info); }
  .badge.live { background: color-mix(in srgb, var(--xb-ok) 14%, transparent); color: var(--xb-ok); }
  .edit { display: grid; align-content: start; gap: 12px; padding: 12px 14px; overflow: auto; min-height: 0; }
  .edit.wide { grid-column: 2 / -1; }
  fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: 12px; min-width: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .grid label, .sub { display: grid; gap: 4px; color: var(--xb-muted); font-size: 12px; }
  .subs.inner { margin: 6px 0 0 16px; padding-left: 10px; border-left: 2px solid var(--xb-line); display: grid; gap: 4px; }
  .add-inner { justify-self: start; font-size: 12px; }
  .switches { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
  .switches label { display: flex; gap: 6px; align-items: center; }
  .slug input { width: 140px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .chip { display: inline-flex; gap: 5px; align-items: center; padding: 3px 9px; border: 1px solid var(--xb-line); border-radius: 14px; font-size: 12px; }
  .segmented { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--xb-hover); justify-self: start; }
  .segmented button { border: 0; padding: 4px 10px; border-radius: var(--xb-r); color: var(--xb-muted); }
  .segmented button.active { background: var(--xb-bg); color: var(--xb-text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.1); }
  h4 { margin: 0; font: 600 11px var(--xb-sans); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-muted); }
  .fields { display: grid; gap: 8px; padding-top: 10px; border-top: 1px solid var(--xb-line); }
  .field { display: grid; gap: 6px; padding: 8px; border: 1px solid var(--xb-line); border-radius: 8px; background: var(--xb-bg); }
  .field-head { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) auto; gap: 6px; align-items: center; }
  .field-head .tools { grid-column: 3; grid-row: 1; }
  .field-head select { grid-column: 1 / 3; }
  .flabel { font-weight: 600; }
  .subs { display: grid; gap: 6px; padding: 6px 0 0 10px; border-left: 2px solid var(--xb-line); }
  .subfield { display: grid; gap: 4px; padding: 6px; border: 1px dashed var(--xb-line); border-radius: var(--xb-r); }
  .tools { display: inline-flex; }
  .help-input { font-size: 12px; color: var(--xb-muted); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .row input { flex: 1; min-width: 140px; }
  .row select { max-width: 100%; }
  .end { justify-content: flex-end; }
  .help { margin: 0; color: var(--xb-muted); font-size: 12px; }
  .muted { color: var(--xb-muted); }
  .data { padding: 12px 14px; border-left: 1px solid var(--xb-line); overflow: auto; display: grid; gap: 10px; align-content: start; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 6px 6px; border-bottom: 1px solid var(--xb-line); vertical-align: middle; }
  td code { font: 11.5px var(--xb-mono); color: var(--xb-syn-class); word-break: break-all; }
  .actions, .expr { white-space: nowrap; text-align: right; }
  .expr code { margin-right: 6px; }
  .check { width: 28px; }
  tr.off td:not(.check) { opacity: 0.6; }
  .provider-group { display: grid; gap: 6px; padding: 10px; border: 1px solid var(--xb-line); border-radius: 8px; }
  .all { margin-left: auto; display: flex; gap: 5px; align-items: center; font-size: 12px; color: var(--xb-muted); }
  .placeholder { grid-column: 2 / -1; padding: 24px; color: var(--xb-muted); max-width: 600px; }
  .placeholder p { margin: 0 0 8px; }
</style>
