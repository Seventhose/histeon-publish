<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { CmsProject, FolderInfo, ListKind, Site } from "../lib/app-types.js";

  /** The bar of «Seleziona»: how many are picked, and what to do with them. */
  let { language, askDelete, askFolder, busy, cmsProjects, picked = $bindable(), pickedItems, sites, stopPicking, visibleItems, kind }: {
    language: Language;
    askDelete: (kind: "cms" | "sites", items: Array<{ id: string; name: string }>) => void;
    askFolder: (mode: "create" | "rename" | "move", kind: ListKind, items?: Array<{ id: string; name: string }>, folder?: FolderInfo) => void;
    busy: boolean;
    cmsProjects: CmsProject[];
    picked: string[];
    pickedItems: (kind: "cms" | "sites") => Array<{ id: string; name: string }>;
    sites: Site[];
    stopPicking: () => void;
    visibleItems: <T extends { id: string; name?: string }>(kind: ListKind, list: T[]) => T[];
    kind: "cms" | "sites";
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const all = $derived(visibleItems<{ id: string }>(kind, kind === "cms" ? cmsProjects : sites));
</script>

<div class="pick-bar" role="region" aria-label={t("delete.selection")} data-testid="pick-bar">
  <span>{t("delete.pickedCount", { count: picked.length })}</span><small class="pick-hint">{t("delete.escHint")}</small>
  <button class="button outline small" onclick={() => picked = picked.length === all.length ? [] : all.map((item) => item.id)}>{picked.length === all.length ? t("delete.pickNone") : t("delete.pickAll")}</button>
  <span class="grow"></span>
  <button class="button outline small" disabled={!picked.length || busy} onclick={() => askFolder("move", kind, pickedItems(kind))}>▤ {t("folder.move")}</button>
  <button class="button danger small" disabled={!picked.length || busy} onclick={() => askDelete(kind, pickedItems(kind))}>{t("delete.deletePicked", { count: picked.length })}</button>
  <button class="button outline small" onclick={stopPicking}>{t("common.cancel")}</button>
</div>
