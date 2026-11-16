<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";

  /** The keyboard shortcuts. */
  let { language, onclose }: {
    language: Language;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) onclose(); }}>
  <div class="modal-card shortcuts-card" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" tabindex="-1" use:modal={{ onClose: () => onclose(), canClose: () => true }}>
    <button class="modal-close" aria-label={t("common.close")} onclick={() => onclose()}>×</button>
    <h2 id="shortcuts-title">{t("keys.title")}</h2>
    <dl class="shortcuts-list">
      {#each [["Ctrl K", "keys.search"], ["/", "keys.filter"], ["j  k", "keys.move"], ["Invio", "keys.open"], ["e", "keys.builder"], ["x", "keys.select"], ["Ctrl S", "keys.save"], ["Ctrl B  Ctrl I  Ctrl K", "keys.format"], ["Alt ↑  Alt ↓", "keys.blockMove"], ["?", "keys.help"]] as const as [combo, label] (label)}
        <dt><kbd>{combo}</kbd></dt><dd>{t(label)}</dd>
      {/each}
    </dl>
  </div>
</div>
