<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { FolderInfo, ListKind } from "../lib/app-types.js";

  /** A list's folders: their cards at the top, the bar of the open one inside it. Cards drop onto them. */
  let { language, act, askFolder, busy, currentFolder, dropFolder = $bindable(), dropOnFolder, enterFolder, folderListOf, folderOf, overFolder, removeFolder, visibleItems, kind, list, onSpread }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    askFolder: (mode: "create" | "rename" | "move", kind: ListKind, items?: Array<{ id: string; name: string }>, folder?: FolderInfo) => void;
    busy: boolean;
    currentFolder: (kind: ListKind) => FolderInfo | null;
    dropFolder: string | null;
    dropOnFolder: (event: DragEvent, kind: ListKind, folderId: string | null) => Promise<void>;
    enterFolder: (kind: ListKind, id: string | null) => void;
    folderListOf: (kind: ListKind) => FolderInfo[];
    folderOf: (kind: ListKind, id: string) => string | null;
    overFolder: (event: DragEvent, kind: ListKind, folderId: string | null) => void;
    removeFolder: (folder: FolderInfo) => Promise<void>;
    visibleItems: <T extends { id: string; name?: string }>(kind: ListKind, list: T[]) => T[];
    kind: ListKind;
    list: Array<{ id: string; name: string }>;
    onSpread: (ids: string[]) => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const inside = $derived(currentFolder(kind));
</script>

{#if inside}
  <!-- Inside a folder: back to the top (also a drop target, to take projects out), its name, rename and delete. -->
  <div class="folder-bar" data-testid="folder-bar">
    <button class="button outline small" class:drop={dropFolder === ""} ondragover={(event) => overFolder(event, kind, null)} ondragleave={() => dropFolder = null} ondrop={(event) => void act(() => dropOnFolder(event, kind, null))} onclick={() => enterFolder(kind, null)}>← {t(kind === "cms" ? "folder.backProjects" : "folder.backSites")}</button>
    <h2><span aria-hidden="true">▤</span>{inside.name} <small>{visibleItems(kind, list).length}</small></h2>
    <span class="grow"></span>
    {#if kind === "cms" && visibleItems(kind, list).length > 1}<button class="button outline small" disabled={busy} onclick={() => onSpread(visibleItems(kind, list).map((item) => item.id))} data-testid="folder-spread">{t("spread.open")}</button>{/if}
    <button class="button outline small" disabled={busy} onclick={() => askFolder("rename", kind, [], inside)}>{t("folder.rename")}</button>
    <button class="button outline small" disabled={busy} onclick={() => void act(() => removeFolder(inside))}>{t("folder.delete")}</button>
  </div>
{:else if folderListOf(kind).length}
  <ul class="folder-grid" aria-label={t("folder.label")}>
    {#each folderListOf(kind) as folder (folder.id)}
      {@const count = list.filter((item) => folderOf(kind, item.id) === folder.id).length}
      <li><button class="folder-card" class:drop={dropFolder === folder.id} aria-label={t("folder.open", { name: folder.name, count })} ondragover={(event) => overFolder(event, kind, folder.id)} ondragleave={() => dropFolder = null} ondrop={(event) => void act(() => dropOnFolder(event, kind, folder.id))} onclick={() => enterFolder(kind, folder.id)}>
        <span class="folder-icon" aria-hidden="true">▤</span><strong>{folder.name}</strong><small>{count}</small>
      </button></li>
    {/each}
  </ul>
{/if}
