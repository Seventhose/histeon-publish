<script lang="ts">
  import { translate, type Language } from "../lib/i18n.js";
  import type { DeleteKind, TrashEntry } from "../lib/app-types.js";
  import { formatDate as formatDateIn } from "../lib/app-format.js";

  /** The Cestino: what is in it, to restore or to delete for good. */
  let { language, act, askPurge, busy, restoreItem, trash, trashDays, trashItems }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    askPurge: (items: Array<{ id: string; name: string; kind: DeleteKind }>) => void;
    busy: boolean;
    restoreItem: (item: { id: string; name: string; kind: DeleteKind }) => Promise<void>;
    trash: { retentionDays: number; projects: TrashEntry[]; sites: TrashEntry[] } | null;
    trashDays: number;
    trashItems: Array<TrashEntry & { kind: DeleteKind }>;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const formatDate = (value?: string) => formatDateIn(language, value);
</script>

<section class="page-wrap narrow" data-testid="trash">
  <div class="page-heading"><div><div class="eyebrow">{t("trash.eyebrow")}</div><h1>{t("trash.title")}</h1><p>{t("trash.subtitle", { days: trashDays })}</p></div>{#if trashItems.length}<button class="button danger" disabled={busy} onclick={() => askPurge(trashItems)}>{t("trash.emptyAll")}</button>{/if}</div>
  {#if !trash}<p class="empty-note">{t("trash.loading")}</p>
  {:else if !trashItems.length}<div class="panel-card"><p class="empty-note">{t("trash.empty")}</p></div>
  {:else}
    {#each [{ kind: "project" as const, heading: t("trash.projects") }, { kind: "site" as const, heading: t("trash.sites") }] as group (group.kind)}
      {@const list = trashItems.filter((item) => item.kind === group.kind)}
      {#if list.length}
        <h2 class="trash-heading">{group.heading} <small>{list.length}</small></h2>
        <ul class="trash-list">
          {#each list as item (item.id)}
            <li class="trash-row">
              <div class="grow"><strong>{item.name}</strong><small>{t("trash.deletedAt", { date: formatDate(item.deletedAt) })} · {t("trash.expires", { date: formatDate(new Date(new Date(item.deletedAt).getTime() + trashDays * 86_400_000).toISOString()) })}</small></div>
              <button class="button outline small" disabled={busy} onclick={() => void act(() => restoreItem(item))}>{t("trash.restore")}</button>
              <button class="button danger small" disabled={busy} onclick={() => askPurge([item])}>{t("trash.purge")}</button>
            </li>
          {/each}
        </ul>
      {/if}
    {/each}
  {/if}
</section>
