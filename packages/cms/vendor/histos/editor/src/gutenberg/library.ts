// «Histeon · Libreria» in Gutenberg (lista della spesa 136): the site's section library, inserted as the builder's
// paste dialog does it (docs/spec/library.md): the clip is restricted by the server first, the blocks get new uids,
// new classes bring their styles, classes that clash with this site's are imported under a new name, identical ones
// use the site's. The styles go to development at once, the blocks into the page after the selected block.
import { randomUid, reuid, serializeXb, type XbBlock } from '@xb/dsl';
import type { LibrarySection, StylesData } from '../lib/api.ts';
import { classesOf, clipBlocks, freeName, planClasses, readClip, renameClasses, renameSelector, type Clip } from '../lib/clip.ts';
import { restrictClip } from '../lib/pasteTrust.ts';
import { rulesFor } from '../lib/sheet.ts';
import { api, config, errorText } from './context.ts';
import { editStyles, saveStyles, useStyles } from './styles.ts';
import { __, h, useEffect, useState, wp } from './wp.ts';

export interface InsertPlan {
  blocks: XbBlock[];
  /** Styles to add or replace on this site: new classes and renamed ones. */
  styles: Array<{ selector: string; css: string }>;
  renames: Array<[string, string]>;
}

/** What inserting a clip does on this site, decided as the builder's paste dialog decides it by default. Pure. */
export function planInsert(clip: Clip, site: StylesData, uid: () => string = randomUid): InsertPlan {
  const blocks = reuid(clipBlocks(clip).blocks, uid);
  const sheetClasses = new Set<string>();
  for (const g of site.globals) for (const c of classesOf(blocks)) if (rulesFor(g.css, c).length) sheetClasses.add(c);
  const plan = planClasses(clip, site.styles, sheetClasses);
  const taken = new Set([...site.styles.map((s) => s.selector.replace(/^\./, '')), ...sheetClasses]);
  const map = new Map<string, string>();
  for (const p of plan) {
    if (p.fate !== 'conflict') continue;
    const fresh = freeName(p.name, taken);
    taken.add(fresh);
    map.set(p.name, fresh);
  }
  const styles: InsertPlan['styles'] = [];
  for (const s of clip.styles) {
    const fate = plan.find((p) => s.selector.includes(`.${p.name}`))?.fate;
    const renamed = renameSelector(s.selector, map);
    if (fate === 'new' || renamed !== s.selector) styles.push({ selector: renamed, css: s.css });
  }
  return { blocks: renameClasses(blocks, map), styles, renames: [...map] };
}

/** Adds or replaces styles in the shared store (one change for the whole section). */
function upsertStyles(entries: Array<{ selector: string; css: string }>) {
  if (!entries.length) return;
  editStyles((d) => {
    const next = [...d.styles];
    for (const e of entries) {
      const at = next.findIndex((s) => s.selector === e.selector);
      if (at >= 0) next[at] = { ...next[at]!, css: e.css };
      else next.push({ id: `${e.selector.replace(/[^a-z0-9_-]/gi, '')}-${Math.random().toString(36).slice(2, 8)}`, selector: e.selector, css: e.css });
    }
    return { ...d, styles: next };
  });
}

function LibraryPanel() {
  const state = useStyles();
  const [sections, setSections] = useState<LibrarySection[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    api?.listSections().then(
      (r) => setSections(r.sections),
      (e) => setError(errorText(e)),
    );
  }, []);

  const insert = async (section: LibrarySection) => {
    if (!api || !state.data || busy) return;
    setBusy(section.id);
    setError('');
    try {
      const read = readClip((await api.getSection(section.id)).clip);
      if (!read) throw new Error(__('Sezione illeggibile.'));
      const clip = await restrictClip(api, read);
      const plan = planInsert(clip, state.data);
      upsertStyles(plan.styles);
      if (plan.styles.length) await saveStyles();
      const editor = wp.data.select('core/block-editor');
      const selected = editor.getSelectedBlockClientId();
      const root = selected ? editor.getBlockRootClientId(selected) : undefined;
      const index = selected ? editor.getBlockIndex(selected) + 1 : undefined;
      wp.data.dispatch('core/block-editor').insertBlocks(wp.blocks.parse(serializeXb(plan.blocks)), index, root ?? undefined);
      const renames = plan.renames.map(([a, b]) => `${a} → ${b}`).join(', ');
      wp.data
        .dispatch('core/notices')
        .createSuccessNotice(renames ? __('Inserita «{0}»; classi rinominate per non toccare quelle del sito: {1}.', section.name, renames) : __('Inserita «{0}».', section.name), { type: 'snackbar' });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  };

  const shown = (sections ?? []).filter((s) => !search.trim() || s.name.toLowerCase().includes(search.trim().toLowerCase()));
  return h(
    'div',
    { className: 'xb-library' },
    h('p', { className: 'xb-insp-note' }, __('Le sezioni salvate nella libreria di Histeon. Si inseriscono dopo il blocco selezionato, con i loro stili.')),
    h(wp.components.SearchControl, { value: search, onChange: setSearch, label: __('Cerca una sezione'), __nextHasNoMarginBottom: true }),
    error ? h('p', { className: 'xb-insp-error', role: 'alert' }, error) : null,
    sections === null && !error ? h('p', { className: 'xb-insp-note' }, __('Caricamento della libreria…')) : null,
    sections !== null && !sections.length ? h('p', { className: 'xb-insp-note' }, __('La libreria è vuota: le sezioni si salvano dal builder.')) : null,
    h(
      'ul',
      { className: 'xb-library-list' },
      shown.map((s) =>
        h(
          'li',
          { key: s.id },
          h('span', { className: 'xb-library-name' }, s.name, s.origin ? h('small', null, s.origin) : null),
          h(wp.components.Button, { variant: 'secondary', size: 'compact', isBusy: busy === s.id, disabled: Boolean(busy) || !state.data, onClick: () => void insert(s) }, __('Inserisci')),
        ),
      ),
    ),
  );
}

/** The sidebar of the post editor, for whoever builds (a client never inserts sections). */
export function registerLibrary(): void {
  if (!api || config?.client) return;
  const Sidebar = wp.editor?.PluginSidebar ?? wp.editPost?.PluginSidebar;
  const MenuItem = wp.editor?.PluginSidebarMoreMenuItem ?? wp.editPost?.PluginSidebarMoreMenuItem;
  if (!Sidebar || !wp.plugins?.registerPlugin) return;
  wp.plugins.registerPlugin('xb-library', {
    icon: 'layout',
    render: () =>
      h(
        wp.element.Fragment,
        null,
        MenuItem ? h(MenuItem, { target: 'xb-library' }, __('Histeon · Libreria')) : null,
        h(Sidebar, { name: 'xb-library', title: __('Histeon · Libreria') }, h('div', { className: 'xb-insp-body', style: { padding: '16px' } }, h(LibraryPanel))),
      ),
  });
}
