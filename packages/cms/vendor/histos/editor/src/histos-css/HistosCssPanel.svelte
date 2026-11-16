<script lang="ts">
  import type { ContrastPair, DesignParams } from '../lib/api.ts';
  import { oklchToHex } from '../lib/oklch.ts';
  import { t } from '../lib/i18n.ts';
  import { DTCG_FILES, toDtcg } from './dtcg.ts';
  import { TOKEN_FILE_MAX, importDesignTokens, readDesignTokens, textSizeSteps, tokenImportLines, type TokenFile } from './dtcg-import.ts';
  import type { PanelHost } from './host.ts';
  import { ALPHAS, FAMILY_LABELS, OPTIONS, SECTIONS, SHADES, SPACE_STEPS, TEXT_STEPS, differs, exportDesign, matches, parseImport, type ColorGroup, type PanelOption, type SectionId } from './options.ts';

  // The Histeon CSS panel (histos-publish doc 19 §5.1): one component for the builder's Design system and for the
  // drawer over any WordPress page. Its options come from options.ts; each change asks the host for a server-built
  // preview (validated there) and shows it at once. Saving belongs to the host: the builder saves the parameters
  // with the tokens, the drawer with its own button.
  let {
    host,
    design = $bindable(),
    defaults,
    contrast = $bindable([]),
    recipes = null,
    tab = $bindable('colors'),
    onsite,
  }: {
    host: PanelHost;
    design: DesignParams;
    defaults: DesignParams;
    contrast?: ContrastPair[];
    /** The recipes to search and copy (the drawer); null hides the section (the builder has its own). */
    recipes?: Record<string, string> | null;
    tab?: SectionId;
    /** Takes the tokens that became variables of the site (the builder's Design system); says how many it took. */
    onsite?: (variables: Record<string, string>) => number;
  } = $props();

  const sections = $derived(SECTIONS.filter(([id]) => id !== 'recipes' || recipes !== null));
  const FAMILIES = OPTIONS.filter((o) => o.kind === 'color' && o.group === 'families');
  const label = (o: PanelOption) => (o.format ? t(o.format, t(o.label)) : t(o.label));
  const isOn = (family: string) => Number(design[`${family}_on`] ?? 1) !== 0;
  const inGroup = (group: ColorGroup) => OPTIONS.filter((o) => o.section === 'colors' && o.group === group);
  const GROUPS: Array<[ColorGroup, string]> = [['palette', 'Palette'], ['roles', 'Ruoli dei colori'], ['dark', 'Tema scuro']];
  const SHAPE_GROUPS: Array<[ColorGroup, string, string]> = [
    ['border', 'Bordo predefinito', 'Lo usa la classe xb-border.'],
    ['buttons', 'Pulsanti', 'Valgono per xb-btn e per ogni variante: xb-btn-primary, xb-btn-primary-outline, -light, -dark per ogni famiglia; misure xb-btn-xs … xb-btn-xl.'],
    ['links', 'Link', 'Valgono per xb-link e per i link dei testi xb-prose; con gli stili predefiniti anche per i link senza classe.'],
    ['cards', 'Card', 'Classe xb-card; dentro, xb-card-media (a filo dei bordi, con le proporzioni scelte) e xb-card-body. xb-radius-inner dà a un elemento annidato il raggio concentrico.'],
    ['shadows', 'Ombre', 'I passi di xb-shadow e di xb-text-shadow: distanza, sfocatura e opacità.'],
    ['surfaces', 'Sovrapposizioni e superfici', 'xb-overlay e xb-overlay-gradient mettono il colore sopra uno sfondo; xb-surface-1, -2, -3 sono le superfici del sito, con il testo leggibile scelto da solo (Automatico = la superficie normale).'],
    ['icons', 'Icone', 'Classe xb-icon e misure xb-icon-xs … xb-icon-2xl; xb-icon-boxed in un riquadro; xb-list-icon per una lista con la spunta.'],
  ];
  /** The switches that style bare elements, gathered here; these three also sit with the options they use. */
  const DEFAULT_STYLES = ['headings_on', 'text_on', 'links_on'];
  const DETAIL_GROUPS: Array<[ColorGroup, string, string]> = [
    ['defaults', 'Stili predefiniti', 'Stilano gli elementi senza classe del sito: spenti di partenza, e ogni classe del sito li supera.'],
    ['forms', 'Moduli', 'I campi xb-input li seguono sempre; con gli stili predefiniti anche i campi senza classe e i moduli di Fluent Forms, con il pulsante d’invio come i pulsanti.'],
    ['access', 'Accessibilità e dettagli', 'Le colonne di testo si usano con la classe xb-columns.'],
    ['advanced', 'Avanzate', 'Un gruppo di variabili spento non si stampa: il foglio è più leggero, le classi che le usano tornano ai loro valori o non fanno nulla, e il pannello CSS segnala la variabile come sconosciuta. Lo stesso per i gruppi di classi: un gruppo spento non va nel foglio e non è proposto.'],
    ['motion', 'Movimento ed effetti', 'Classi xb-enter-fade, -up, -down, -left, -right, -grow, -shrink, -blur (e xb-exit-…) seguono lo scorrimento dove il browser lo sa fare; xb-hover-lift, -shadow, -glow, -scale, -bright, -fade, -underline al passaggio. Tutto si ferma per chi chiede meno movimento.'],
  ];
  const SPACE_GROUPS: Array<[ColorGroup, string, string]> = [
    ['sections', 'Sezioni', 'Con i moltiplicatori a 1 le sezioni usano i passi xl … 4xl degli spazi; con il margine laterale a 0 vale lo spazio m.'],
    ['gaps', 'Spazi fra gli elementi', ''],
    ['layout', 'Layout', 'La griglia dei contenuti (classe xb-content-grid) mette i figli nella colonna dei contenuti; xb-wide e xb-full li allargano.'],
  ];
  const TEXT_GROUPS: Array<[ColorGroup, string, string]> = [
    ['headings', 'Titoli', 'Valgono per le classi xb-h1 … xb-h6 e, con gli stili predefiniti, per gli elementi h1 … h6 del sito.'],
    ['levels', 'Titoli per livello', 'Con 0 il livello usa il valore di tutti i titoli.'],
    ['body', 'Testo e radice', 'Una dimensione radice diversa da 100% cambia ogni misura in rem del sito.'],
    ['steps', 'Misure dei singoli passi', 'Un passo con le due misure prende quelle, fluide fra le due viewport; con 0 segue la sua scala.'],
  ];
  /** What a role can be: automatic, white, black, a family switched on or one of its shades. */
  const roleChoices = $derived([
    ['auto', t('Automatico')],
    ['white', t('Bianco')],
    ['black', t('Nero')],
    ...FAMILY_LABELS.filter(([key]) => isOn(key)).flatMap(([key, name]) => [[key, t(name)], ...SHADES.map((s) => [`${key}-${s}`, `${t(name)} ${s}`])]),
  ]);
  let query = $state('');
  let recipeQuery = $state('');
  let values = $state<Record<string, string>>({});
  let openFamilies = $state<string[]>([]);
  let copied = $state('');
  let confirmReset = $state(false);
  let message = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
  let fileInput = $state<HTMLInputElement | undefined>();
  let tokenInput = $state<HTMLInputElement | undefined>();
  /** The lines of the last token import: what became what, and what was left out. */
  let report = $state<string[]>([]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const found = $derived(query.trim() ? OPTIONS.filter((o) => matches(o, query, label(o))) : []);
  const unreadable = $derived(contrast.filter((p) => !p.ok).length);
  const changedIn = (section: SectionId) => OPTIONS.filter((o) => o.section === section && differs(design[o.key], defaults[o.key])).length;

  /** The token values the swatches and samples show, read where the tokens live. */
  function refresh() {
    const names = [
      ...FAMILIES.flatMap((f) => [`xb-${f.key}`, `xb-on-${f.key}`, ...SHADES.map((s) => `xb-${f.key}-${s}`), ...ALPHAS.map((a) => `xb-${f.key}-a${a}`)]),
      ...TEXT_STEPS.map((s) => `xb-text-${s}`),
      ...SPACE_STEPS.map((s) => `xb-space-${s}`),
      ...['s', 'm', 'l'].flatMap((s) => [`xb-radius-${s}`, `xb-shadow-${s}`]),
      'xb-btn-radius', 'xb-btn-pad-y', 'xb-btn-pad-x', 'xb-btn-weight', 'xb-btn-case', 'xb-btn-tracking',
      ...contrast.flatMap((p) => [p.text, p.bg]),
    ];
    values = host.read([...new Set(names)]);
  }
  $effect(() => {
    refresh();
  });

  function preview() {
    clearTimeout(timer);
    // A change clears the message it finds, not one written while its preview was on the way (D7: «Token esportati»
    // vanished when the answer of a change made just before arrived after the export).
    const shown = message;
    timer = setTimeout(async () => {
      try {
        const r = await host.preview(design);
        if (message === shown) message = null;
        contrast = r.contrast ?? contrast;
        host.show(r.css, r.classesOff);
        requestAnimationFrame(refresh);
      } catch (e) {
        message = { kind: 'error', text: e instanceof Error ? e.message : String(e) };
      }
    }, 200);
  }

  function set(key: string, value: string | number) {
    design = { ...design, [key]: value };
    preview();
  }

  function reset(key: string) {
    set(key, defaults[key] ?? '');
  }

  /** A font chosen in the builder's fonts section: previewed like a value typed here. */
  export function useFont(key: 'font_body' | 'font_heading' | 'font_mono' | 'font_accent' | 'font_display', stack: string) {
    set(key, stack);
  }

  /** Everything back to the defaults, after the confirmation. */
  export function restore() {
    confirmReset = false;
    design = { ...defaults };
    preview();
  }

  const cssVar = (name: string) => `var(--${name})`;

  async function copy(name: string, text = cssVar(name)) {
    try {
      await navigator.clipboard.writeText(text);
      copied = name;
      setTimeout(() => copied === name && (copied = ''), 1200);
    } catch {
      /* clipboard refused: the name is in the tooltip */
    }
  }

  function toggleFamily(key: string) {
    openFamilies = openFamilies.includes(key) ? openFamilies.filter((k) => k !== key) : [...openFamilies, key];
  }

  /** A JSON file saved by the browser: nothing goes through the server. */
  function download(name: string, text: string) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportFile() {
    download('histos-css.json', exportDesign(design, defaults));
  }

  /** The tokens these parameters print, computed by the server, as two DTCG files: light and (if on) dark theme. */
  async function exportTokens() {
    try {
      const all = await host.tokens(design);
      let exported = 0;
      let left = 0;
      for (const scheme of ['light', 'dark'] as const) {
        const tokens = all[scheme];
        if (!tokens) continue;
        const title = scheme === 'light' ? t('Token di Histeon CSS, tema chiaro.') : t('Token di Histeon CSS, tema scuro.');
        const r = toDtcg(tokens, scheme, `${title} ${t('Quelli che il formato DTCG non può contenere (formule CSS, unità non ammesse, altri tipi) sono elencati in $extensions.')}`);
        download(DTCG_FILES[scheme], `${JSON.stringify(r.doc, null, 2)}\n`);
        exported = r.exported;
        left = r.skipped.formula.length + r.skipped.unit.length + r.skipped.type.length;
      }
      const text = t('Token esportati: {0}; lasciati fuori {1}, elencati nel file.', exported, left);
      message = { kind: 'ok', text: all.dark ? text : `${text} ${t('Il tema scuro è spento: solo il file del tema chiaro.')}` };
    } catch (e) {
      message = { kind: 'error', text: e instanceof Error ? e.message : String(e) };
    }
  }

  const IMPORT_ERRORS: Record<string, string> = {
    'too-large': 'Il file è troppo grande (al massimo 64 KB).',
    'not-json': 'Il file non è JSON.',
    'not-histos': 'Il file non contiene impostazioni di Histeon CSS.',
  };

  /** A file of settings: read here, validated by the server like a save, then taken as the panel's values. */
  async function importFile(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    try {
      const next = parseImport(await file.text(), defaults);
      const r = await host.preview(next);
      design = next;
      contrast = r.contrast ?? contrast;
      host.show(r.css, r.classesOff);
      requestAnimationFrame(refresh);
      message = { kind: 'ok', text: t('Impostazioni importate: salvale per tenerle.') };
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      message = { kind: 'error', text: code.startsWith('unknown:') ? t('Parametro sconosciuto: {0}', code.slice(8)) : IMPORT_ERRORS[code] ? t(IMPORT_ERRORS[code]) : code };
    }
  }

  const TOKEN_ERRORS: Record<string, string> = {
    'no-file': 'Scegli almeno un file di token.',
    'too-large': 'Un file di token è troppo grande (al massimo 8 MB).',
    'too-many': 'Troppi token (al massimo 5000).',
    'not-json': 'Il file non è JSON.',
  };
  const isDarkFile = (name: string) => /(^|[^a-z])(dark|scuro|night|notte)([^a-z]|$)/i.test(name);

  /**
   * Design tokens exported by Figma (one file per mode) or Penpot (one file with the sets): read here, turned into
   * parameters of this panel over the values it has, validated by the server like a save. A file named dark, scuro
   * or night is the dark mode; a file of token sets can hold its own. Text sizes are matched to a step, never copied.
   */
  async function importTokens(e: Event & { currentTarget: HTMLInputElement }) {
    const picked = [...(e.currentTarget.files ?? [])];
    e.currentTarget.value = '';
    if (!picked.length) return;
    try {
      if (picked.some((file) => file.size > TOKEN_FILE_MAX)) throw new Error('too-large');
      const files: TokenFile[] = [];
      for (const file of picked) files.push({ name: file.name, text: await file.text() });
      const darkFiles = files.filter((file) => isDarkFile(file.name));
      const lightFiles = darkFiles.length < files.length ? files.filter((file) => !isDarkFile(file.name)) : files;
      const read = readDesignTokens(lightFiles);
      const dark = lightFiles !== files && darkFiles.length ? readDesignTokens(darkFiles, { scheme: 'dark' }) : read.dark ? readDesignTokens(lightFiles, { scheme: 'dark' }) : null;
      const result = importDesignTokens(read, { dark });
      const next = { ...design, ...result.design };
      const r = await host.preview(next);
      design = next;
      contrast = r.contrast ?? contrast;
      host.show(r.css, r.classesOff);
      requestAnimationFrame(refresh);
      const steps = result.report.sizes.length ? textSizeSteps(result.report.sizes, (await host.tokens(next)).light) : [];
      const site = Object.keys(result.siteTokens).length;
      const taken = site && onsite ? onsite(result.siteTokens) : 0;
      report = tokenImportLines(result.report, steps);
      const text = t('Token importati: {0} parametri del design; {1} non convertiti. Salva per tenerli.', result.report.mapped.length, result.report.skipped.length);
      message = { kind: 'ok', text: site === 0 ? text : onsite ? `${text} ${t('Variabili del sito aggiunte: {0}.', taken)}` : `${text} ${t('Gli altri {0} token possono diventare variabili del sito: nel builder, Design system, «Importa variabili».', site)}` };
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      report = [];
      message = { kind: 'error', text: TOKEN_ERRORS[code] ? t(TOKEN_ERRORS[code]) : code };
    }
  }

  /** Names of the semantic tokens in the readability list. */
  const ROLES: Record<string, string> = {
    'xb-text': 'Testo', 'xb-heading': 'Titoli', 'xb-text-muted': 'Testo secondario', 'xb-link': 'Link',
    'xb-bg': 'sfondo', 'xb-surface': 'superficie', 'xb-surface-2': 'superficie 2',
  };
  function pairLabel(p: ContrastPair): string {
    const fam = FAMILIES.find((f) => p.bg === `xb-${f.key}`);
    const role = (token: string) => (ROLES[token] === undefined ? token : t(ROLES[token]));
    const text = fam && p.text === `xb-on-${fam.key}` ? t('Testo sul {0}', label(fam).toLowerCase()) : t('{0} su {1}', role(p.text), role(p.bg));
    return p.scheme === 'dark' ? t('{0}, tema scuro', text) : text;
  }

  const shownRecipes = $derived(recipes ? Object.keys(recipes).filter((n) => !recipeQuery || n.includes(recipeQuery.trim().toLowerCase().replace(/^@/, ''))).sort() : []);
</script>

{#snippet resetButton(o: PanelOption)}
  {@const changed = differs(design[o.key], defaults[o.key])}
  {#if changed}<span class="dot" title={t('Diverso dal predefinito')}></span>{/if}
  <button type="button" class="undo" disabled={!changed} aria-label={t('Torna al predefinito: {0}', label(o))} title={t('Torna al predefinito: {0}', String(defaults[o.key] ?? ''))} onclick={() => reset(o.key)}>↺</button>
{/snippet}

{#snippet colorRow(o: PanelOption)}
  {@const open = openFamilies.includes(o.key) || (query.trim() !== '' && found.includes(o))}
  {@const toggle = OPTIONS.find((x) => x.key === `${o.key}_on`)}
  <div class="family" class:off={!isOn(o.key)}>
    <input type="color" value={oklchToHex(String(design[o.key] ?? ''))} aria-label={t('Scegli {0}', label(o))} oninput={(e) => set(o.key, e.currentTarget.value)} />
    <div class="fam-main">
      <span class="fam-name"><span>{label(o)}</span> <code>--xb-{o.key}</code> {@render resetButton(o)}{#if toggle}<input type="checkbox" class="switch" checked={isOn(o.key)} aria-label={label(toggle)} onchange={(e) => set(toggle.key, e.currentTarget.checked ? 1 : 0)} />{/if}</span>
      <input type="text" value={String(design[o.key] ?? '')} aria-label={t('Valore di {0}', label(o))} spellcheck="false" onchange={(e) => set(o.key, e.currentTarget.value.trim())} />
    </div>
    <button type="button" class="strip" aria-expanded={open} aria-label={t('Sfumature e trasparenze di {0}', label(o))} onclick={() => toggleFamily(o.key)}>
      {#each SHADES as s (s)}<i style:background={values[`xb-${o.key}-${s}`] || 'transparent'}></i>{/each}
    </button>
    {#if open}
      <div class="variants">
        <div class="swatches">
          {#each SHADES as s (s)}
            {@const name = `xb-${o.key}-${s}`}
            <button type="button" class="sw" title={`--${name}`} aria-label={t('Copia {0}', cssVar(name))} style:background={values[name] || 'transparent'} onclick={() => copy(name)}><span>{copied === name ? '✓' : s}</span></button>
          {/each}
        </div>
        <div class="swatches checker">
          {#each ALPHAS as a (a)}
            {@const name = `xb-${o.key}-a${a}`}
            <button type="button" class="sw" title={`--${name}`} aria-label={t('Copia {0}', cssVar(name))} style:background={values[name] || 'transparent'} onclick={() => copy(name)}><span>{copied === name ? '✓' : `a${a}`}</span></button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet field(o: PanelOption)}
  {#if o.kind === 'color' && o.group === 'families'}
    {@render colorRow(o)}
  {:else if o.kind === 'color'}
    <div class="field">
      <span class="field-head"><span id={`hcp-${o.key}`}>{label(o)}</span> {@render resetButton(o)}</span>
      <span class="row">
        <input type="color" value={oklchToHex(String(design[o.key] || design[o.key.replace(/_dark$/, '')] || ''))} aria-label={t('Scegli {0}', label(o))} oninput={(e) => set(o.key, e.currentTarget.value)} />
        <input type="text" value={String(design[o.key] ?? '')} placeholder={t('automatico')} spellcheck="false" aria-labelledby={`hcp-${o.key}`} onchange={(e) => set(o.key, e.currentTarget.value.trim())} />
      </span>
    </div>
  {:else if o.kind === 'toggle'}
    <label class="field toggle"><input type="checkbox" checked={Number(design[o.key] ?? defaults[o.key]) === 1} onchange={(e) => set(o.key, e.currentTarget.checked ? 1 : 0)} /> <span>{label(o)}</span> {@render resetButton(o)}</label>
  {:else if o.kind === 'choice' || o.kind === 'role'}
    {@const choices = o.kind === 'choice' ? o.choices.map(([v, l]) => [v, t(l)]) : roleChoices}
    <div class="field">
      <span class="field-head"><span id={`hcp-${o.key}`}>{label(o)}</span> {@render resetButton(o)}</span>
      <select aria-labelledby={`hcp-${o.key}`} value={String(design[o.key] ?? defaults[o.key] ?? '')} onchange={(e) => set(o.key, e.currentTarget.value)}>
        {#each choices as [value, text] (value)}<option {value}>{text}</option>{/each}
      </select>
    </div>
  {:else if o.kind === 'number'}
    <div class="field">
      <span class="field-head"><span id={`hcp-${o.key}`}>{label(o)}</span> {@render resetButton(o)}</span>
      <span class="row">
        <input type="range" min={o.min} max={o.max} step={o.step} value={Number(design[o.key] ?? defaults[o.key] ?? o.min)} aria-labelledby={`hcp-${o.key}`} oninput={(e) => set(o.key, Number(e.currentTarget.value))} />
        <input type="number" min={o.min} max={o.max} step={o.step} value={Number(design[o.key] ?? defaults[o.key] ?? o.min)} aria-labelledby={`hcp-${o.key}`} onchange={(e) => set(o.key, Number(e.currentTarget.value))} />
      </span>
    </div>
  {:else}
    <div class="field">
      <span class="field-head"><span id={`hcp-${o.key}`}>{label(o)}</span> {@render resetButton(o)}</span>
      <input type="text" value={String(design[o.key] ?? '')} placeholder={o.kind === 'font' && o.optional ? t('nessuno') : undefined} spellcheck="false" aria-labelledby={`hcp-${o.key}`} onchange={(e) => set(o.key, e.currentTarget.value.trim())} />
      {#if o.kind === 'font'}<span class="sample" style:font-family={String(design[o.key] ?? '')}>Aa Bb Cc 123 — {t('tessere il web')}</span>{/if}
    </div>
  {/if}
{/snippet}

<div class="hcp">
  <div class="tools">
    <input type="search" class="search" placeholder={t('Cerca un’opzione…')} aria-label={t('Cerca un’opzione')} bind:value={query} />
    <button type="button" class="ghost" onclick={exportFile}>{t('Esporta')}</button>
    <button type="button" class="ghost" title={t('I token calcolati nel formato del Design Tokens Community Group, per Figma o Penpot: tokens.chiaro.json e tokens.scuro.json.')} onclick={exportTokens}>{t('Esporta i token (DTCG)')}</button>
    <button type="button" class="ghost" onclick={() => fileInput?.click()}>{t('Importa')}</button>
    <input type="file" accept="application/json,.json" hidden bind:this={fileInput} onchange={importFile} />
    <button type="button" class="ghost" title={t('I token esportati da Figma (un file per modo delle variabili) o da Penpot (Token → Esporta): colori di famiglia, caratteri, misura base e raggio diventano parametri; le misure di testo diventano il gradino più vicino, mai misure fisse.')} onclick={() => tokenInput?.click()}>{t('Importa i token (DTCG)')}</button>
    <input type="file" accept="application/json,.json" multiple hidden bind:this={tokenInput} onchange={importTokens} />
    {#if confirmReset}
      <span class="confirm">{t('Tutto ai valori predefiniti?')} <button type="button" class="ghost danger" onclick={restore}>{t('Sì')}</button> <button type="button" class="ghost" onclick={() => (confirmReset = false)}>{t('No')}</button></span>
    {:else}
      <button type="button" class="ghost" title={t('Torna ai valori predefiniti di Histeon CSS')} onclick={() => (confirmReset = true)}>{t('Predefiniti')}</button>
    {/if}
  </div>
  {#if message}<p class="msg" class:error={message.kind === 'error'} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p>{/if}
  {#if report.length}
    <details class="report">
      <summary>{t('Rapporto dei token importati')}</summary>
      <ul>{#each report as line, i (i)}<li>{line}</li>{/each}</ul>
    </details>
  {/if}

  {#if query.trim()}
    <div class="results">
      {#each found as o (o.key)}{@render field(o)}{:else}<p class="muted">{t('Nessuna opzione.')}</p>{/each}
    </div>
  {:else}
    <div class="tabs" role="tablist" aria-label={t('Sezioni')}>
      {#each sections as [id, name] (id)}
        <button type="button" role="tab" aria-selected={tab === id} onclick={() => (tab = id)}>{t(name)}{#if id !== 'recipes' && changedIn(id) > 0}<span class="dot" aria-hidden="true"></span>{/if}</button>
      {/each}
    </div>
    <div class="body" role="tabpanel">
      {#if tab === 'colors'}
        <div class="families">{#each FAMILIES as o (o.key)}{@render colorRow(o)}{/each}</div>
        {#each GROUPS as [group, title] (group)}
          <h4>{t(title)}</h4>
          {#if group === 'dark' && Number(design.dark_on) !== 1}
            {@render field(inGroup('dark')[0]!)}
            <p class="muted">{t('Acceso, il sito ha i ruoli e i colori del tema scuro: sotto la classe xb-scheme-dark, o per tutto il sito con lo schema scelto.')}</p>
          {:else}
            <div class="fields">{#each inGroup(group) as o (o.key)}{@render field(o)}{/each}</div>
          {/if}
        {/each}
        {#if contrast.length}
          <h4>{t('Leggibilità')} <span class="count" class:bad={unreadable > 0}>{unreadable === 0 ? t('tutto leggibile') : t('{0} da rivedere', unreadable)}</span></h4>
          <ul class="contrast" aria-label={t('Contrasto delle coppie di colori (serve almeno 4,5:1)')}>
            {#each contrast as p (`${p.scheme ?? ''}${p.text}/${p.bg}`)}
              <li class:bad={!p.ok}>
                <span class="pair-swatch" aria-hidden="true" style:background={values[p.bg] || 'transparent'} style:color={values[p.text] || 'inherit'}>Aa</span>
                <span>{pairLabel(p)}</span>
                <span class="ratio">{p.ratio.toFixed(2)}:1 {p.ok ? '✓' : '✗'}</span>
              </li>
            {/each}
          </ul>
        {/if}
      {:else if tab === 'text'}
        <div class="scale">
          {#each [...TEXT_STEPS].reverse() as s (s)}
            <div class="step"><code>{s}</code><span class="sample" style:font-size={values[`xb-text-${s}`] || undefined}>{t('Tessere il web')}</span></div>
          {/each}
        </div>
        <div class="fields">{#each OPTIONS.filter((o) => o.section === 'text' && !o.group) as o (o.key)}{@render field(o)}{/each}</div>
        {#each TEXT_GROUPS as [group, title, note] (group)}
          <h4>{t(title)}</h4>
          {#if note}<p class="muted">{t(note)}</p>{/if}
          <div class="fields">{#each OPTIONS.filter((o) => o.section === 'text' && o.group === group) as o (o.key)}{@render field(o)}{/each}</div>
        {/each}
      {:else if tab === 'space'}
        <div class="scale">
          {#each SPACE_STEPS as s (s)}
            <div class="step"><code>{s}</code><span class="bar" style:inline-size={values[`xb-space-${s}`] || '0'}></span></div>
          {/each}
        </div>
        <div class="fields">{#each OPTIONS.filter((o) => o.section === 'space' && !o.group) as o (o.key)}{@render field(o)}{/each}</div>
        {#each SPACE_GROUPS as [group, title, note] (group)}
          <h4>{t(title)}</h4>
          {#if note}<p class="muted">{t(note)}</p>{/if}
          <div class="fields">{#each OPTIONS.filter((o) => o.section === 'space' && o.group === group) as o (o.key)}{@render field(o)}{/each}</div>
        {/each}
      {:else if tab === 'shape'}
        <div class="shapes">
          {#each ['s', 'm', 'l'] as s (s)}
            <div class="shape" style:border-radius={values[`xb-radius-${s}`] || undefined} style:box-shadow={values[`xb-shadow-${s}`] || undefined}>{t('raggio {0}', s)}</div>
          {/each}
        </div>
        <div class="fields">{#each OPTIONS.filter((o) => o.section === 'shape' && !o.group) as o (o.key)}{@render field(o)}{/each}</div>
        <div class="btn-sample" aria-hidden="true"><span style:border-radius={values['xb-btn-radius'] || undefined} style:padding={values['xb-btn-pad-y'] ? `${values['xb-btn-pad-y']} ${values['xb-btn-pad-x']}` : undefined} style:font-weight={values['xb-btn-weight'] || undefined} style:text-transform={values['xb-btn-case'] || undefined} style:letter-spacing={values['xb-btn-tracking'] || undefined} style:background={values['xb-primary'] || undefined} style:color={values['xb-on-primary'] || undefined}>{t('Pulsante')}</span></div>
        {#each SHAPE_GROUPS as [group, title, note] (group)}
          <h4>{t(title)}</h4>
          {#if note}<p class="muted">{t(note)}</p>{/if}
          <div class="fields">{#each OPTIONS.filter((o) => o.section === 'shape' && o.group === group) as o (o.key)}{@render field(o)}{/each}</div>
        {/each}
      {:else if tab === 'details'}
        {#each DETAIL_GROUPS as [group, title, note] (group)}
          <h4>{t(title)}</h4>
          {#if note}<p class="muted">{t(note)}</p>{/if}
          <div class="fields">{#each OPTIONS.filter((o) => o.section === 'details' && o.group === group || (group === 'defaults' && DEFAULT_STYLES.includes(o.key))) as o (o.key)}{@render field(o)}{/each}</div>
        {/each}
      {:else if tab === 'fonts'}
        <div class="fields">{#each OPTIONS.filter((o) => o.section === 'fonts') as o (o.key)}{@render field(o)}{/each}</div>
        <p class="muted">{t('Nomi di caratteri separati da virgole; tra virgolette quelli con spazi.')}</p>
      {:else if tab === 'recipes' && recipes}
        <p class="muted">{t('Nel pannello CSS del builder scrivi @ e il nome: la ricetta si espande.')}</p>
        <input type="search" class="search" placeholder={t('Cerca una ricetta…')} aria-label={t('Cerca una ricetta')} bind:value={recipeQuery} />
        <div class="recipes">
          {#each shownRecipes as name (name)}
            <div class="recipe">
              <b>@{name}</b>
              <button type="button" class="ghost" onclick={() => copy(`recipe:${name}`, recipes?.[name] ?? '')}>{copied === `recipe:${name}` ? t('Copiata') : t('Copia')}</button>
              <pre>{recipes[name]}</pre>
            </div>
          {:else}
            <p class="muted">{t('Nessuna ricetta.')}</p>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .hcp { display: grid; gap: 10px; font: 13px/1.5 var(--xb-sans, system-ui, sans-serif); color: var(--xb-text); }
  .tools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .search { flex: 1 1 160px; }
  .confirm { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; }
  .tabs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid var(--xb-line); padding-bottom: 6px; }
  .tabs button { flex: none; position: relative; padding: 5px 11px; border: 0; border-radius: 999px; background: transparent; color: var(--xb-text); font: 600 12.5px var(--xb-sans, system-ui, sans-serif); cursor: pointer; }
  .tabs button:hover { background: color-mix(in srgb, var(--xb-text) 7%, transparent); }
  .tabs button[aria-selected='true'] { background: var(--xb-ink, var(--xb-text)); color: var(--xb-on-ink, var(--xb-bg)); }
  .tabs .dot { position: absolute; inset-block-start: 3px; inset-inline-end: 3px; }
  .body, .results { display: grid; gap: 10px; }
  h4 { margin: 6px 0 0; font: 600 11px var(--xb-sans, system-ui, sans-serif); text-transform: uppercase; letter-spacing: 0.06em; color: var(--xb-muted); }
  .families { display: grid; gap: 6px; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
  .family.off { border-style: dashed; }
  .family.off .strip { opacity: 0.25; }
  .switch { inline-size: 18px; block-size: 18px; margin: 0; accent-color: var(--xb-coral, #ff6f5e); }
  .toggle { display: flex; gap: 8px; align-items: center; font-weight: 600; font-size: 12px; }
  select { font: 12.5px var(--xb-sans, system-ui, sans-serif); padding: 4px 6px; border-radius: var(--xb-r-sm, 5px); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); min-width: 0; }
  .field input[type='color'] { width: 28px; height: 28px; padding: 0; border: 0; background: none; flex: none; }
  .family { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 4px 8px; align-items: center; padding: 6px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm, 5px); background: var(--xb-bg); }
  .family input[type='color'] { width: 32px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: none; cursor: pointer; }
  .fam-main { display: grid; gap: 2px; min-width: 0; }
  .fam-name, .field-head { font-size: 12px; font-weight: 600; display: flex; gap: 6px; align-items: center; }
  .fam-name code { margin-inline-start: auto; font: 11px var(--xb-mono, ui-monospace, monospace); color: var(--xb-muted); }
  .field-head > span:first-child { flex: 1; }
  .dot { inline-size: 7px; block-size: 7px; border-radius: 50%; background: var(--xb-coral, #ff6f5e); flex: none; }
  .undo { display: inline-grid; place-items: center; inline-size: 24px; block-size: 24px; border: 0; border-radius: 4px; background: transparent; color: var(--xb-muted); cursor: pointer; font-size: 14px; padding: 0; line-height: 1; }
  .undo:disabled { visibility: hidden; }
  .undo:hover { color: var(--xb-text); }
  .strip { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(11, 1fr); height: 24px; padding: 0; border: 0; border-radius: 4px; overflow: hidden; cursor: pointer; background: none; }
  .strip i { display: block; }
  .variants { grid-column: 1 / -1; display: grid; gap: 4px; }
  .swatches { display: grid; grid-template-columns: repeat(11, 1fr); gap: 2px; }
  .swatches.checker { grid-template-columns: repeat(9, 1fr); background: repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 10px 10px; border-radius: 4px; }
  .sw { block-size: 26px; padding: 0; border: 1px solid color-mix(in srgb, var(--xb-line) 60%, transparent); border-radius: 3px; cursor: pointer; font: 9px var(--xb-mono, ui-monospace, monospace); }
  .sw span { padding: 0 2px; border-radius: 2px; background: rgb(255 255 255 / 0.75); color: #111; }
  .count { margin-inline-start: 6px; text-transform: none; letter-spacing: 0; color: var(--xb-ok, #157f3c); font-weight: 500; }
  .count.bad { color: var(--xb-danger, #b42318); }
  .contrast { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
  .contrast li { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: 12px; padding: 3px 6px; border-radius: var(--xb-r-sm, 5px); }
  .contrast li.bad { background: color-mix(in srgb, var(--xb-danger, #b42318) 12%, transparent); }
  .pair-swatch { display: grid; place-items: center; block-size: 24px; border-radius: 5px; border: 1px solid var(--xb-line); font-weight: 700; }
  .ratio { font: 11.5px var(--xb-mono, ui-monospace, monospace); }
  .contrast li.bad .ratio { color: var(--xb-danger, #b42318); font-weight: 600; }
  .fields { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
  .field { display: grid; gap: 3px; }
  .row { display: flex; gap: 6px; align-items: center; }
  .row input[type='range'] { flex: 1; min-width: 0; accent-color: var(--xb-coral, #ff6f5e); }
  .row input[type='number'] { width: 76px; }
  input[type='text'], input[type='number'], input[type='search'] { font: 12.5px var(--xb-mono, ui-monospace, monospace); padding: 4px 7px; border-radius: var(--xb-r-sm, 5px); border: 1px solid var(--xb-line); background: var(--xb-bg); color: var(--xb-text); min-width: 0; }
  input[type='search'] { font-family: var(--xb-sans, system-ui, sans-serif); }
  .sample { font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
  .scale { display: grid; gap: 4px; padding: 8px 10px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm, 5px); background: var(--xb-bg); }
  .step { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 10px; align-items: center; }
  .step code { color: var(--xb-muted); font: 11px var(--xb-mono, ui-monospace, monospace); }
  .bar { display: block; block-size: 10px; max-inline-size: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--xb-coral, #ff6f5e), #ffb199); }
  .btn-sample { padding: 4px 0; }
  .btn-sample span { display: inline-block; padding: 0.75em 1.4em; border-radius: 6px; background: #3f4bc4; color: #fff; font-weight: 600; line-height: 1.2; }
  .shapes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .shape { display: grid; place-items: center; block-size: 60px; background: var(--xb-bg); border: 1px solid var(--xb-line); color: var(--xb-muted); font-size: 11px; }
  .recipes { display: grid; gap: 6px; }
  .recipe { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; padding: 8px 10px; border: 1px solid var(--xb-line); border-radius: var(--xb-r-sm, 5px); background: var(--xb-bg); }
  .recipe b { font: 600 12.5px var(--xb-mono, ui-monospace, monospace); }
  .recipe pre { grid-column: 1 / -1; margin: 0; max-block-size: 0; overflow: hidden; color: var(--xb-muted); font: 11px/1.5 var(--xb-mono, ui-monospace, monospace); white-space: pre-wrap; }
  .recipe:hover pre, .recipe:focus-within pre { max-block-size: 240px; }
  .ghost { font: 500 12px var(--xb-sans, system-ui, sans-serif); padding: 4px 10px; border-radius: var(--xb-r-sm, 5px); border: 1px solid var(--xb-line); background: transparent; color: var(--xb-text); cursor: pointer; }
  .ghost:hover { border-color: var(--xb-text); }
  .ghost.danger { color: var(--xb-danger, #b42318); }
  .muted { margin: 0; color: var(--xb-muted); font-size: 12px; }
  .msg { margin: 0; font-size: 12.5px; color: var(--xb-ok, #157f3c); }
  .msg.error { color: var(--xb-danger, #b42318); }
  .report { font-size: 12px; color: var(--xb-muted); }
  .report summary { cursor: pointer; }
  .report ul { margin: 4px 0 0; padding-inline-start: 18px; max-block-size: 220px; overflow: auto; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--xb-coral, #ff6f5e); outline-offset: 2px; }
</style>
