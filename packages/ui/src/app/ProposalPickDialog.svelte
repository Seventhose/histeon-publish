<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { ProposalChoice } from "../lib/proposals-file.js";

  /** A kit proposte file: the client's choice of one proposal, which becomes the prototype to check. */
  let { language, busy, cmsImportOpener, title, groups, proposals, onconvert, onclose }: {
    language: Language;
    busy: boolean;
    cmsImportOpener: HTMLElement | null;
    title: string;
    groups: Array<{ id: string; name: string }>;
    proposals: ProposalChoice[];
    onconvert: (id: string) => void;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);

  /** The first proposal is chosen when the dialog opens; a click on another one changes the choice. */
  let picked = $state<string | null>(null);
  const chosen = $derived(proposals.find((proposal) => proposal.id === picked) ?? proposals[0] ?? null);
  const groupName = (id: string): string => groups.find((group) => group.id === id)?.name ?? "";
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !busy) onclose(); }}>
  <div class="modal-card proposal-card" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy, returnFocus: cmsImportOpener }} aria-labelledby="cms-proposal-pick-title" tabindex="-1" data-testid="cms-proposal-pick">
    <button class="modal-close" aria-label={t("common.close")} onclick={() => { if (!busy) onclose(); }}>×</button>
    <div class="eyebrow">HISTOS CMS</div>
    <h2 id="cms-proposal-pick-title">{t("cms.proposalTitle")}</h2>
    <p>{t("cms.proposalFile", { title, n: proposals.length })}</p>
    <p class="proposal-hint">{t("cms.proposalHint")}</p>
    <div class="proposal-body">
      <div class="proposal-options">
        {#each proposals as proposal (proposal.id)}
          {@const details = [groupName(proposal.group), proposal.idea].filter((part) => part !== "").join(" · ")}
          <label class="proposal-option">
            <input type="radio" name="cms-proposal" value={proposal.id} checked={chosen?.id === proposal.id} disabled={busy} onchange={() => { picked = proposal.id; }} />
            <span>
              <strong>{proposal.id.toUpperCase()} · {proposal.name}</strong>
              {#if details}<small>{details}</small>{/if}
            </span>
          </label>
        {/each}
      </div>
      {#if chosen}
        <div class="proposal-preview">
          <span class="proposal-preview-label">{t("cms.proposalPreview")}</span>
          <!-- The proposal comes from the file: an empty sandbox keeps its scripts from running. -->
          <iframe sandbox="" srcdoc={chosen.doc} title={t("cms.proposalPreview")} data-testid="cms-proposal-preview"></iframe>
        </div>
      {/if}
    </div>
    <div class="modal-actions">
      <button class="button outline" disabled={busy} onclick={() => { if (!busy) onclose(); }}>{t("common.cancel")}</button>
      <button class="button dark" data-testid="cms-proposal-convert" disabled={busy || !chosen} onclick={() => { if (chosen) onconvert(chosen.id); }}>{t("cms.proposalConvert")} →</button>
    </div>
  </div>
</div>

<style>
  .proposal-card { width: min(880px, 100%); }
  .proposal-hint { color: var(--muted); font-size: 14px; line-height: 1.5; }
  .proposal-body { display: grid; grid-template-columns: minmax(220px, 300px) minmax(0, 1fr); gap: 16px; margin: 14px 0 6px; }
  .proposal-options { display: grid; align-content: start; gap: 8px; }
  .proposal-option { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
  .proposal-option input { flex: none; width: 17px; height: 17px; min-height: 0; margin: 3px 0 0; padding: 0; accent-color: var(--coral); }
  .proposal-option:has(input:checked) { border-color: currentColor; }
  .proposal-option strong { display: block; font-size: 15px; }
  .proposal-option small { display: block; margin-top: 2px; color: var(--muted); font-size: 13px; line-height: 1.4; }
  .proposal-preview { display: grid; gap: 6px; min-width: 0; }
  .proposal-preview-label { color: var(--muted); font-size: 13px; }
  .proposal-preview iframe { width: 100%; height: min(58vh, 520px); border: 1px solid var(--line); border-radius: 8px; background: #fff; }
  @media (max-width: 720px) {
    .proposal-body { grid-template-columns: 1fr; }
  }
</style>
