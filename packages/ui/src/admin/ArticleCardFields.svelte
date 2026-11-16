<script lang="ts">
  import type { CardDefinition, CardProps, CardPropDefinition, CardRow } from "../lib/article-schema.js";
  import { translate, type Language } from "../lib/i18n.js";
  import RichField from "./RichField.svelte";

  /** The fields of the selected block, from its component's own definition: plain words and addresses, never markup (doc 24). */
  let { card, definition, rowDefinition, name, language, onChange, onPickImage, onUpload, onClose }: {
    card: { top: number; props: CardProps; entries: CardRow[] };
    definition: CardDefinition;
    rowDefinition: CardDefinition | undefined;
    name: string;
    language: Language;
    onChange: (change: { props?: CardProps; entries?: CardRow[] }) => void;
    onPickImage: (chosen: (src: string, alt: string) => void) => void;
    onUpload: (file: File) => Promise<string>;
    onClose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  /** The definition's word for a prop, in the user's language when the app knows it. */
  function label(prop: string, entry: CardPropDefinition): string {
    const key = `article.field.${prop}`;
    const word = t(key);
    return language !== "it" && word !== key ? word : entry.label ?? (word === key ? prop : word);
  }
  const option = (value: string) => { const key = `article.variant.${value}`; const word = t(key); return word === key ? value : word; };
  const stringOf = (value: CardProps[string] | undefined): string => (typeof value === "string" ? value : "");

  function setProp(prop: string, value: CardProps[string]): void {
    const props = { ...card.props, [prop]: value };
    // The words of a link come by themselves: a link without any shows nothing on the page.
    if (prop === "link" && typeof value === "string" && value.trim() && !stringOf(card.props.linkLabel).trim() && definition.schema.props.linkLabel) props.linkLabel = t("article.card.linkLabelDefault");
    onChange({ props });
  }
  const setRow = (at: number, prop: string, value: CardProps[string]) => onChange({ entries: card.entries.map((row, position) => (position === at ? { ...row, props: { ...row.props, [prop]: value } } : row)) });
  const removeRow = (at: number) => onChange({ entries: card.entries.filter((_row, position) => position !== at) });
  const rowImage = $derived(Object.entries(rowDefinition?.schema.props ?? {}).find(([, entry]) => entry.type === "image")?.[0]);
  function addRow(): void {
    if (!rowImage) { onChange({ entries: [...card.entries, { props: {} }] }); return; }
    const altProp = rowDefinition?.schema.props.alt ? "alt" : null;
    onPickImage((src, alt) => onChange({ entries: [...card.entries, { props: { [rowImage]: src, ...(altProp ? { [altProp]: alt } : {}) } }] }));
  }
</script>

{#snippet field(owner: CardDefinition, prop: string, entry: CardPropDefinition, value: CardProps[string] | undefined, set: (value: CardProps[string]) => void)}
  {#if entry.type === "image"}
    <div class="article-card-row">
      {#if stringOf(value)}<img src={stringOf(value)} alt="" />{:else}<span></span>{/if}
      <button class="button outline small" onclick={() => onPickImage((src) => set(src))} data-testid="article-card-image">{label(prop, entry)}</button>
      {#if stringOf(value)}<button class="admin-icon" aria-label={t("article.card.remove")} onclick={() => set("")}>×</button>{/if}
    </div>
  {:else if entry.type === "enum"}
    <label class="field-label">{label(prop, entry)}
      <select value={stringOf(value) || String(entry.default ?? entry.options?.[0] ?? "")} onchange={(event) => set(event.currentTarget.value)}>
        {#each entry.options ?? [] as choice (choice)}<option value={choice}>{option(choice)}</option>{/each}
      </select>
    </label>
  {:else if entry.type === "boolean"}
    <label class="check-label"><input type="checkbox" checked={value === true} onchange={(event) => set(event.currentTarget.checked)} /> {label(prop, entry)}</label>
  {:else if entry.type === "number"}
    <label class="field-label">{label(prop, entry)}<input type="number" value={value ?? ""} onchange={(event) => set(Number(event.currentTarget.value))} /></label>
  {:else if entry.type === "rich-text"}
    <div class="field-label">{label(prop, entry)}<RichField value={stringOf(value)} {language} name={prop} onChange={(next) => set(next)} /></div>
  {:else if owner.areas.includes(prop)}
    <label class="field-label">{label(prop, entry)}<textarea value={stringOf(value)} data-field={prop} onchange={(event) => set(event.currentTarget.value)}></textarea></label>
  {:else if prop === "href"}
    <label class="field-label">{label(prop, entry)}<input value={stringOf(value)} data-field={prop} onchange={(event) => set(event.currentTarget.value)} /></label>
    <input type="file" accept="application/pdf,.pdf" aria-label={t("article.card.uploadPdf")} data-testid="article-card-pdf" onchange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void onUpload(file).then(set); }} />
  {:else if ["string", "url", "rich-text"].includes(entry.type)}
    <label class="field-label">{label(prop, entry)}<input value={stringOf(value)} data-field={prop} onchange={(event) => set(event.currentTarget.value)} /></label>
  {/if}
{/snippet}

<div class="article-card-fields" style:top="{card.top}px" data-testid="article-card-fields">
  <header>
    <span>{name}</span>
    <button class="button text small" onclick={onClose}>{t("article.card.done")}</button>
  </header>
  {#each Object.entries(definition.schema.props) as [prop, entry] (prop)}
    {@render field(definition, prop, entry, card.props[prop], (value) => setProp(prop, value))}
  {/each}
  {#if definition.auto}
    <p class="muted">{t("article.card.auto")}</p>
  {:else if rowDefinition}
    {#each card.entries as row, at (row.uid ?? at)}
      <div class="article-card-row plain">
        <div class="article-card-row-fields">
          {#each Object.entries(rowDefinition.schema.props) as [prop, entry] (prop)}
            {@render field(rowDefinition, prop, entry, row.props[prop], (value) => setRow(at, prop, value))}
          {/each}
        </div>
        <button class="admin-icon" aria-label={t("article.card.remove")} onclick={() => removeRow(at)}>×</button>
      </div>
    {/each}
    <button class="button outline small" onclick={addRow} data-testid="article-card-add-row">＋ {t(rowImage ? "article.card.addImage" : "article.card.addRow")}</button>
  {/if}
</div>
