<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import { modal } from "../lib/modal.js";
  import { searchable, type AdminIndex } from "../lib/admin-index.js";

  /** Ctrl+K: everything in the site, found in memory as it is typed (doc 21 §4). */
  let { index, language, sections, onPick, onClose }: { index: AdminIndex; language: Language; sections: Array<{ key: string; label: string }>; onPick: (kind: string, id: string) => void; onClose: () => void } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  let query = $state("");
  let cursor = $state(0);
  const entries = $derived([
    ...sections.map((section) => ({ kind: "section", id: section.key, label: section.label, detail: "" })),
    ...index.pages.map((item) => ({ kind: "page", id: item.id, label: item.title, detail: item.address })),
    ...index.posts.map((item) => ({ kind: "post", id: item.id, label: item.title, detail: item.address })),
    ...index.records.map((item) => ({ kind: "record", id: item.id, label: item.title, detail: item.typeKey })),
    ...index.assets.map((item) => ({ kind: "asset", id: item.id, label: item.filename, detail: item.alt })),
  ].map((entry) => ({ ...entry, text: searchable(`${entry.label} ${entry.detail}`) })));
  const found = $derived.by(() => {
    const needle = searchable(query.trim());
    return (needle ? entries.filter((entry) => entry.text.includes(needle)) : entries.filter((entry) => entry.kind === "section")).slice(0, 30);
  });
  function keydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown") { event.preventDefault(); cursor = Math.min(found.length - 1, cursor + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); cursor = Math.max(0, cursor - 1); }
    else if (event.key === "Enter") {
      event.preventDefault();
      const entry = found[cursor];
      if (entry) onPick(entry.kind, entry.id);
    }
  }
  $effect(() => { void query; cursor = 0; });
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
  <div class="admin-palette" role="dialog" aria-modal="true" aria-label={t("admin.palette.title")} use:modal={{ onClose }} tabindex="-1">
    <!-- svelte-ignore a11y_autofocus -->
    <input autofocus type="search" bind:value={query} placeholder={t("admin.palette.placeholder")} aria-label={t("admin.palette.title")} onkeydown={keydown} data-testid="admin-palette-input" />
    {#if found.length}
      <ul>
        {#each found as entry, place (`${entry.kind}:${entry.id}`)}
          <li class:cursor={place === cursor}><button onclick={() => onPick(entry.kind, entry.id)} onmousemove={() => { cursor = place; }}><span>{entry.label}</span><small>{t(`admin.palette.kind.${entry.kind}`)}{entry.detail ? ` · ${entry.detail}` : ""}</small></button></li>
        {/each}
      </ul>
    {:else}
      <p class="empty-note">{t("admin.palette.none")}</p>
    {/if}
  </div>
</div>
