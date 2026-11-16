<script lang="ts">
  import { modal } from "./lib/modal.js";
  import { translate, type Language } from "./lib/i18n.js";

  /**
   * Moving CMS projects or sites to the Cestino (`mode` "trash"), or deleting them from it for good ("purge"), one or
   * many: nothing goes until the name of each one is typed or pasted next to it, exactly as written (the «Copia» button
   * beside the name puts it on the clipboard). `ondelete` does it and reports what failed; the dialog stays open on
   * failures, with them listed, and closes when everything went.
   */
  let { language, mode = "trash", kind, items, days = 30, busy, ondelete, onclose }: {
    language: Language;
    mode?: "trash" | "purge";
    /** "mixed" when «Svuota il Cestino» takes projects and sites together. */
    kind: "project" | "site" | "mixed";
    items: Array<{ id: string; name: string }>;
    /** How long the Cestino keeps what it gets. */
    days?: number;
    busy: boolean;
    ondelete: (items: Array<{ id: string; name: string }>) => Promise<Array<{ id: string; message: string }>>;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);

  let typed = $state<Record<string, string>>({});
  let failures = $state<Array<{ id: string; message: string }>>([]);
  let copied = $state("");
  const matches = (item: { id: string; name: string }) => (typed[item.id] ?? "").trim() === item.name;
  const ready = $derived(items.length > 0 && items.every(matches));

  async function copy(name: string, id: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(name);
      copied = id;
      setTimeout(() => { if (copied === id) copied = ""; }, 1500);
    } catch {
      copied = "";
    }
  }

  const title = $derived(mode === "purge"
    ? t(items.length === 1 ? "purge.titleOne" : "purge.titles", { count: items.length, name: items[0]?.name ?? "" })
    : t(`delete.title${kind === "project" ? "Project" : "Site"}${items.length === 1 ? "One" : "s"}`, { count: items.length, name: items[0]?.name ?? "" }));
  const body = $derived(mode === "purge" ? t("purge.body") : t(kind === "project" ? "delete.bodyProjects" : "delete.bodySites", { days }));
  const action = $derived(mode === "purge" ? t("purge.confirm", { count: items.length }) : t(kind === "project" ? "delete.confirmProjects" : "delete.confirmSites", { count: items.length }));

  async function confirm(): Promise<void> {
    if (!ready || busy) return;
    failures = await ondelete(items);
  }
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !busy) onclose(); }}>
  <div class="modal-card delete-modal" role="dialog" aria-modal="true" use:modal={{ onClose: onclose, canClose: () => !busy }} aria-labelledby="delete-title" tabindex="-1" data-testid="delete-dialog">
    <button class="modal-close" aria-label={t("common.close")} disabled={busy} onclick={onclose}>×</button>
    <div class="modal-icon warning-icon">!</div>
    <h2 id="delete-title">{title}</h2>
    <p>{body}</p>
    <ul class="delete-list">
      {#each items as item (item.id)}
        {@const failed = failures.find((failure) => failure.id === item.id)}
        <li class:ok={matches(item)}>
          <div class="delete-name"><code>{item.name}</code><button type="button" class="button outline small" onclick={() => void copy(item.name, item.id)}>{copied === item.id ? t("delete.copied") : t("delete.copy")}</button></div>
          <input type="text" value={typed[item.id] ?? ""} disabled={busy} autocomplete="off" spellcheck="false" placeholder={t("delete.typeName")} aria-label={t("delete.typeNameFor", { name: item.name })} data-autofocus={items[0]?.id === item.id ? "" : undefined} oninput={(event) => typed = { ...typed, [item.id]: (event.currentTarget as HTMLInputElement).value }} />
          {#if failed}<p class="delete-error" role="alert">{failed.message}</p>{/if}
        </li>
      {/each}
    </ul>
    <div class="modal-actions">
      <button class="button outline" disabled={busy} onclick={onclose}>{t("common.cancel")}</button>
      <button class="button danger" disabled={!ready || busy} onclick={() => void confirm()}>{busy ? t(mode === "purge" ? "purge.deleting" : "delete.deleting") : action}</button>
    </div>
  </div>
</div>

<style>
  .delete-modal { width: min(560px, 100%); max-height: calc(100vh - 40px); overflow: auto; }
  .delete-list { display: grid; gap: 12px; margin: 14px 0 0; padding: 0; list-style: none; }
  .delete-list li { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; }
  .delete-list li.ok { border-color: var(--danger-line); background: var(--danger-soft); }
  .delete-name { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .delete-name code { overflow-wrap: anywhere; font-size: 14px; font-weight: 650; }
  .delete-list input { width: 100%; }
  .delete-error { margin: 0; color: var(--danger); font-size: 14px; }
</style>
