<script module lang="ts">
  export type FolderChoice = { target: string | null | "new"; name: string };
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { modal } from "./lib/modal.js";
  import { translate, type Language } from "./lib/i18n.js";

  /**
   * Folders of CMS projects or sites: a new folder ("create"), another name ("rename"), or where the chosen items go
   * ("move": an existing folder, a new one named here, or out of any folder). `onsubmit` does it; the dialog closes
   * when it went, and shows the reason when it did not.
   */
  let { language, mode, folders, items, current = null, initialName = "", busy, onsubmit, onclose }: {
    language: Language;
    mode: "create" | "rename" | "move";
    folders: Array<{ id: string; name: string }>;
    /** What is being moved (move only). */
    items: Array<{ id: string; name: string }>;
    /** The folder the items are in, when they are all in the same one. */
    current?: string | null;
    initialName?: string;
    busy: boolean;
    onsubmit: (choice: FolderChoice) => Promise<string | null>;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);

  // The first folder that is not the current one, else a new folder.
  // The starting choice only: the dialog is mounted anew each time it opens.
  let target = $state<string | null | "new">(untrack(() => mode === "move" ? (folders.find((folder) => folder.id !== current)?.id ?? "new") : "new"));
  let name = $state(untrack(() => initialName));
  let error = $state("");
  const needsName = $derived(mode !== "move" || target === "new");
  const ready = $derived(!busy && (!needsName || name.trim().length > 0) && !(mode === "move" && target === current));

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!ready) return;
    error = (await onsubmit({ target, name: name.trim() })) ?? "";
  }
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !busy) onclose(); }}>
  <div class="modal-card folder-modal" role="dialog" aria-modal="true" use:modal={{ onClose: onclose, canClose: () => !busy }} aria-labelledby="folder-title" tabindex="-1" data-testid="folder-dialog"><form onsubmit={submit}>
    <button type="button" class="modal-close" aria-label={t("common.close")} disabled={busy} onclick={onclose}>×</button>
    <div class="modal-icon" aria-hidden="true">▤</div>
    <h2 id="folder-title">{mode === "create" ? t("folder.newTitle") : mode === "rename" ? t("folder.renameTitle") : items.length === 1 ? t("folder.moveTitleOne", { name: items[0]?.name ?? "" }) : t("folder.moveTitles", { count: items.length })}</h2>
    {#if mode === "move"}
      <fieldset class="folder-choices">
        <legend class="visually-hidden">{t("folder.label")}</legend>
        {#each folders as folder (folder.id)}
          <label class:current={folder.id === current}><input type="radio" name="folder-target" value={folder.id} checked={target === folder.id} disabled={busy || folder.id === current} onchange={() => target = folder.id} /><span aria-hidden="true">▤</span>{folder.name}{#if folder.id === current} <small>{t("folder.here")}</small>{/if}</label>
        {/each}
        <label><input type="radio" name="folder-target" value="new" checked={target === "new"} disabled={busy} onchange={() => target = "new"} /><span aria-hidden="true">＋</span>{t("folder.moveNew")}</label>
        {#if current !== null || items.length > 1}
          <label><input type="radio" name="folder-target" value="" checked={target === null} disabled={busy} onchange={() => target = null} /><span aria-hidden="true">↑</span>{t("folder.moveOut")}</label>
        {/if}
      </fieldset>
    {/if}
    {#if needsName}
      <label class="field-label">{t("folder.name")}
        <input type="text" bind:value={name} maxlength="80" disabled={busy} autocomplete="off" data-autofocus="" />
      </label>
    {/if}
    {#if error}<p class="delete-error" role="alert">{error}</p>{/if}
    <div class="modal-actions">
      <button type="button" class="button outline" disabled={busy} onclick={onclose}>{t("common.cancel")}</button>
      <button type="submit" class="button primary" disabled={!ready}>{mode === "create" ? t("folder.create") : mode === "rename" ? t("folder.renameConfirm") : t("folder.moveConfirm", { count: items.length })}</button>
    </div>
  </form></div>
</div>

<style>
  .folder-modal { width: min(480px, 100%); max-height: calc(100vh - 40px); overflow: auto; }
  .folder-choices { display: grid; gap: 6px; margin: 14px 0; padding: 0; border: 0; }
  .folder-choices label { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; }
  .folder-choices label:has(input:checked) { border-color: var(--coral); background: var(--panel-soft); }
  .folder-choices label.current { opacity: .65; cursor: default; }
  .folder-choices small { color: var(--muted); }
  .field-label input { width: 100%; }
  .delete-error { margin: 0; color: var(--danger); font-size: 14px; }
</style>
