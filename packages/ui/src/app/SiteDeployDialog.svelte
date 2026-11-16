<script lang="ts">
  import { modal } from "../lib/modal.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { BuildResult, DeployTarget, Site } from "../lib/app-types.js";
  import { formatBytes as formatBytesIn } from "../lib/app-format.js";

  /** A static site's ready build, waiting for «Conferma e pubblica» (E6). */
  let { language, act, busy, confirmSiteDeploy, siteDeployOpener, summary, site, onclose }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    confirmSiteDeploy: () => Promise<void>;
    siteDeployOpener: HTMLElement | null;
    summary: { siteId: string; build: BuildResult; target: DeployTarget; destination: string; label: string };
    site: Site;
    onclose: () => void;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const formatBytes = (bytes?: number) => formatBytesIn(language, bytes);
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !busy) onclose(); }}>
  <div class="modal-card" role="dialog" aria-modal="true" use:modal={{ onClose: () => onclose(), canClose: () => !busy, returnFocus: siteDeployOpener }} aria-labelledby="site-deploy-summary-title" tabindex="-1" data-testid="site-deploy-summary">
    <button class="modal-close" aria-label={t("common.close")} onclick={() => { if (!busy) onclose(); }}>×</button>
    <div class="eyebrow">{site.name}</div>
    <h2 id="site-deploy-summary-title">{t("site.deploySummary")}</h2>
    <dl class="site-deploy-facts">
      <div><dt>{t("site.target")}</dt><dd>{summary.label}</dd></div>
      <div><dt>{t("site.files")}</dt><dd>{summary.build.files ?? 0} · {formatBytes(summary.build.totalBytes)}</dd></div>
      <div><dt>{t("site.pages")}</dt><dd>{summary.build.pages ?? 0}</dd></div>
    </dl>
    <div class="modal-warning"><span>!</span>{summary.target === "cloudflare" ? t("site.noReal") : t("site.deployFtpNote")}</div>
    <div class="modal-actions">
      <button class="button outline" disabled={busy} onclick={() => { if (!busy) onclose(); }}>{t("common.cancel")}</button>
      <button class="button dark" data-testid="site-deploy-confirm" disabled={busy} onclick={() => void act(confirmSiteDeploy)}>{busy ? t("site.preparing") : t("site.confirmDeploy")} →</button>
    </div>
  </div>
</div>
