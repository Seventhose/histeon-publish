<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";

  /** The first site, by three questions: name, kind, language. */
  let { language, act, busy, finishFirstSite, answers = $bindable(), onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    finishFirstSite: () => Promise<void>;
    answers: { step: number; name: string; kind: "rivista" | "negozio" | "vuoto"; locale: string };
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal-card first-site" role="dialog" aria-modal="true" aria-labelledby="first-site-title" tabindex="-1" data-testid="first-site" use:modal={{ onClose: () => onclose(), canClose: () => !busy }}>
    <button class="modal-close" aria-label={t("common.close")} onclick={() => onclose()}>×</button>
    <small class="muted">{t("first.step", { n: answers.step + 1 })}</small>
    {#if answers.step === 0}
      <h2 id="first-site-title">{t("first.name")}</h2>
      <input bind:value={answers.name} maxlength="120" placeholder={t("first.namePlaceholder")} aria-label={t("first.name")} data-testid="first-site-name" />
    {:else if answers.step === 1}
      <h2 id="first-site-title">{t("first.kind")}</h2>
      <div class="first-site-choices">{#each [["rivista", "first.kindMagazine", "first.kindMagazineHint"], ["negozio", "first.kindShop", "first.kindShopHint"], ["vuoto", "first.kindEmpty", "first.kindEmptyHint"]] as const as [key, label, hint] (key)}<button class:active={answers.kind === key} aria-pressed={answers.kind === key} onclick={() => { answers.kind = key; }}><strong>{t(label)}</strong><span>{t(hint)}</span></button>{/each}</div>
    {:else}
      <h2 id="first-site-title">{t("first.language")}</h2>
      <select bind:value={answers.locale} aria-label={t("first.language")} data-testid="first-site-language">{#each [["it-IT", "Italiano"], ["en-GB", "English"], ["fr-FR", "Français"], ["de-DE", "Deutsch"], ["es-ES", "Español"]] as const as [code, label] (code)}<option value={code}>{label}</option>{/each}</select>
    {/if}
    <div class="modal-actions">
      {#if answers.step}<button class="button text" onclick={() => { answers.step -= 1; }}>{t("first.back")}</button>{/if}
      {#if answers.step < 2}<button class="button primary" disabled={!answers.name.trim()} onclick={() => { answers.step += 1; }} data-testid="first-site-next">{t("first.next")}</button>{:else}<button class="button primary" disabled={busy} onclick={() => void act(finishFirstSite)} data-testid="first-site-create">{t("first.create")}</button>{/if}
    </div>
  </div>
</div>
