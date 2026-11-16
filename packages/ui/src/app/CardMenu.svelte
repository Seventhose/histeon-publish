<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { FolderInfo, ListKind } from "../lib/app-types.js";

  /** The menu of a card: a click anywhere else or Escape closes it. */
  let { language, act, askDelete, askFolder, openCmsProject, openSite, pickMode, picked, pickedItems, startPicking, togglePicked, menu, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    askDelete: (kind: "cms" | "sites", items: Array<{ id: string; name: string }>) => void;
    askFolder: (mode: "create" | "rename" | "move", kind: ListKind, items?: Array<{ id: string; name: string }>, folder?: FolderInfo) => void;
    openCmsProject: (projectId: string, navigation?: number) => Promise<void>;
    openSite: (id: string, navigateToSite?: boolean) => Promise<void>;
    pickMode: "cms" | "sites" | null;
    picked: string[];
    pickedItems: (kind: "cms" | "sites") => Array<{ id: string; name: string }>;
    startPicking: (kind: "cms" | "sites", first?: string) => void;
    togglePicked: (id: string, on: boolean) => void;
    menu: { x: number; y: number; kind: "cms" | "sites"; id: string; name: string };
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
</script>

<!-- The menu of a card: a click anywhere else or Escape closes it. -->
<div class="card-menu-shield" role="presentation" onclick={() => onclose()} oncontextmenu={(event) => { event.preventDefault(); onclose(); }}></div>
<div class="card-menu" role="menu" aria-label={menu.name} style="left: {menu.x}px; top: {menu.y}px" tabindex="-1" onkeydown={(event) => { if (event.key === "Escape") onclose(); }}>
  <button role="menuitem" onclick={() => { const { kind, id } = menu; onclose(); void act(() => kind === "cms" ? openCmsProject(id) : openSite(id)); }}>{t("delete.menuOpen")}</button>
  {#if pickMode === menu.kind && picked.includes(menu.id)}
    <button role="menuitem" onclick={() => { togglePicked(menu.id, false); onclose(); }}>{t("delete.menuUnpick")}</button>
  {:else}
    <button role="menuitem" onclick={() => { if (pickMode === menu.kind) togglePicked(menu.id, true); else startPicking(menu.kind, menu.id); onclose(); }}>{t("delete.menuPick")}</button>
  {/if}
  <button role="menuitem" onclick={() => askFolder("move", menu.kind, pickMode === menu.kind && picked.includes(menu.id) && picked.length > 1 ? pickedItems(menu.kind) : [{ id: menu.id, name: menu.name }])}>{t("folder.move")}</button>
  <button role="menuitem" class="danger" onclick={() => askDelete(menu.kind, pickMode === menu.kind && picked.includes(menu.id) && picked.length > 1 ? pickedItems(menu.kind) : [{ id: menu.id, name: menu.name }])}>{pickMode === menu.kind && picked.includes(menu.id) && picked.length > 1 ? t("delete.deletePicked", { count: picked.length }) : t("delete.menuDelete")}</button>
</div>
