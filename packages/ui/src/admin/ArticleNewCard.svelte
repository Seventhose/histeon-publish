<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../lib/api.js";
  import type { CardDefinition } from "../lib/article-schema.js";
  import { translate, type Language } from "../lib/i18n.js";

  /** A block of one's own without HTML: a name, its fields and a look among the library's. `card`: the one to change. */
  let { base, language, card, onCreated, onClose, onNotice }: { base: string; language: Language; card?: CardDefinition; onCreated: (card: CardDefinition) => void; onClose: () => void; onNotice: (text: string, failed?: boolean) => void } = $props();
  const t = (key: string) => translate(language, key);
  // The block being changed, as it was when the form opened: the form does not follow later changes of `card`.
  const changing = untrack(() => card);
  let title = $state(changing?.title ?? "");
  let look = $state(changing?.own?.look ?? "riquadro");
  let repeats = $state(Boolean(changing?.rows));
  let fields = $state<Array<{ name?: string; label: string; kind: string }>>(changing?.own?.fields.map((field) => ({ ...field })) ?? [{ label: "", kind: "text" }, { label: "", kind: "area" }]);

  async function create(event: Event): Promise<void> {
    event.preventDefault();
    try {
      onCreated(changing
        ? await api<CardDefinition>(`${base}/admin/article-card/own`, { method: "PUT", body: JSON.stringify({ ref: changing.ref, title, look, fields }) })
        : await api<CardDefinition>(`${base}/admin/article-card/new`, { method: "POST", body: JSON.stringify({ title, look, fields, repeats }) }));
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "", true);
    }
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div role="dialog" aria-modal="true" aria-label={t(changing ? "article.card.editTitle" : "article.card.newTitle")}>
  <form class="modal-card article-picker" data-testid="article-new-card" onsubmit={create}>
    <div class="article-picker-head">
      <h2>{t(changing ? "article.card.editTitle" : "article.card.newTitle")}</h2>
      <button type="button" class="admin-icon" aria-label={t("admin.detail.close")} onclick={onClose}>×</button>
    </div>
    <label class="field-label">{t("article.card.newName")}<input bind:value={title} required maxlength="80" data-testid="article-new-card-name" /></label>
    <label class="field-label">{t("article.card.newLook")}
      <select bind:value={look}>{#each ["riquadro", "scheda", "citazione"] as choice (choice)}<option value={choice}>{t(`article.card.look.${choice}`)}</option>{/each}</select>
    </label>
    <label class="check-label"><input type="checkbox" bind:checked={repeats} disabled={Boolean(changing)} data-testid="article-new-card-repeats" /> {t("article.card.newRepeats")}</label>
    <strong>{t("article.card.newFields")}</strong>
    {#each fields as field, position (position)}
      <div class="article-card-row plain">
        <input bind:value={field.label} aria-label={t("article.card.newField")} placeholder={t("article.card.newField")} data-testid="article-new-card-field" />
        <select bind:value={field.kind} aria-label={t("article.card.newFields")}>{#each ["text", "area", "link", "image"] as kind (kind)}<option value={kind}>{t(`article.card.kind.${kind}`)}</option>{/each}</select>
      </div>
    {/each}
    <button type="button" class="button text small" onclick={() => { fields = [...fields, { label: "", kind: "text" }]; }}>＋ {t("article.card.newAdd")}</button>
    <button class="button primary small" data-testid="article-new-card-create">{t(changing ? "article.card.editSave" : "article.card.newCreate")}</button>
  </form>
  </div>
</div>
