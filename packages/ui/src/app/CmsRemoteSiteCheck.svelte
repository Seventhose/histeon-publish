<script lang="ts">
  import { api } from "../lib/api.js";
  import { translate, type Language } from "../lib/i18n.js";
  import { formatDate as formatDateIn } from "../lib/app-format.js";
  import type { CmsRemoteBrowserCheck, CmsRemoteConnection, CmsRemoteSiteCheck, CmsRemoteSiteProblem } from "../lib/app-types.js";
  import { groupByKind, kindName } from "../lib/site-content-kinds.js";

  /**
   * Doc 23 item 197, «Controlla il sito» (here «Controlla il sito WP»: the Pubblica section has a «Controlla il sito» of
   * its own, for the static version), in the linked site's own row: the reading a send starts from, done before
   * any send, with every content that cannot travel named, why, and what to do. It only reads the site. What the site
   * says is shown as text only.
   *
   * V1.6: after it, «Verifica nel browser» opens the pages that change in development in the app's hidden window (axe
   * and the external links). The answer names the pages without the preview token: the signed links never reach here.
   */
  let { language, act, busy, connection, projectId }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    connection: CmsRemoteConnection;
    projectId: string | null;
  } = $props();
  const say = (italian: string, english: string) => language === "it" ? italian : english;

  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);

  let result = $state<CmsRemoteSiteCheck | null>(null);
  let browser = $state<CmsRemoteBrowserCheck | null>(null);
  $effect(() => { void connection.id; result = null; browser = null; });

  const blocking = $derived(result ? result.problems.filter((problem) => problem.blocking) : []);
  const leftOut = $derived(result ? result.problems.filter((problem) => !problem.blocking) : []);

  function check(): void {
    void act(async () => {
      result = null;
      browser = null;
      result = await api<CmsRemoteSiteCheck>(`/api/cms/v1/connections/${encodeURIComponent(connection.id)}/check`, { method: "POST", body: JSON.stringify(projectId ? { projectId } : {}) });
    });
  }

  function verify(): void {
    void act(async () => {
      browser = null;
      browser = await api<CmsRemoteBrowserCheck>(`/api/cms/v1/connections/${encodeURIComponent(connection.id)}/check/browser`, { method: "POST", body: "{}" });
    });
  }

  const linkGroups = $derived(browser ? [
    { id: "broken", items: browser.links.broken, title: t("wpcheck.broken", { n: browser.links.broken.length }) },
    { id: "unreachable", items: browser.links.unreachable, title: t("wpcheck.unreachable", { n: browser.links.unreachable.length }) },
    { id: "untested", items: browser.links.untested, title: t("wpcheck.untested", { n: browser.links.untested.length }) },
  ].filter((group) => group.items.length) : []);

  function where(problem: CmsRemoteSiteProblem): string {
    return problem.where === "project" ? say("Nel progetto", "In the project") : kindName(language, problem.kind);
  }
</script>

<div class="site-check" data-testid="cms-site-check">
  <div class="site-check-head">
    <button type="button" class="button outline small" onclick={check} disabled={busy || !connection.read} data-testid="cms-site-check-run">{say("Controlla il sito WP", "Check the WP site")}</button>
    <span class="field-hint">{connection.read ? say("Rilegge il sito come prima di un invio e dice per nome cosa non può viaggiare. Non cambia nulla.", "Reads the site as a send would and names what cannot travel. It changes nothing.") : say("Il collegamento non permette di leggere il sito.", "This link cannot read the site.")}</span>
  </div>
  {#if result}
    <div class="site-check-result" role="status" aria-live="polite">
      {#if !result.problems.length}
        <p class="site-check-ok">✓ {say(`Tutto il sito può viaggiare: ${result.read} contenuti letti, nessuno fuori.`, `The whole site can travel: ${result.read} items read, none left out.`)}</p>
      {:else}
        <p class:site-check-ok={result.canSend} class:site-check-stop={!result.canSend}>
          {#if result.canSend}✓ {say(`Si può inviare. ${leftOut.length === 1 ? "Un contenuto del sito resta fuori" : `${leftOut.length} contenuti del sito restano fuori`}: sul sito non cambia${leftOut.length === 1 ? "" : "no"}.`, `You can send. ${leftOut.length} item(s) of the site stay out: they do not change on the site.`)}{:else}! {say(`${blocking.length === 1 ? "Un problema ferma" : `${blocking.length} problemi fermano`} l'invio.`, `${blocking.length} problem(s) stop the send.`)}{/if}
        </p>
        {#if result.stoppedEarly}<p class="field-hint">{say("Il sito si è fermato al primo contenuto che blocca la rilettura: correggilo e ricontrolla, potrebbero essercene altri.", "The site stopped at the first item that blocks its reading: fix it and check again, there may be more.")}</p>{/if}
        {#each [{ items: blocking, title: say("Fermano l'invio", "Stop the send"), id: "blocking" }, { items: leftOut, title: say("Restano fuori dall'invio (sul sito non cambiano)", "Stay out of the send (unchanged on the site)"), id: "left-out" }] as section (section.id)}
          {#if section.items.length}
            <section class="site-check-section" aria-label={section.title}>
              <h4>{section.title}</h4>
              {#each groupByKind(section.items, (problem) => problem.where === "project" ? "project" : problem.kind) as group (group.kind)}
                <ul class="site-check-list">
                  {#each group.items as problem, index (`${group.kind}-${index}`)}
                    <li data-testid="cms-site-check-problem">
                      <span class="site-check-kind">{where(problem)}</span>
                      <strong>{problem.title}</strong>
                      <span>{problem.reason}</span>
                      <span class="site-check-remedy"><b>{say("Cosa fare:", "What to do:")}</b> {problem.remedy}</span>
                      {#if problem.message && problem.message !== problem.reason}<small class="muted">{say("Messaggio del sito:", "The site says:")} <span lang="en">{problem.message}</span></small>{/if}
                    </li>
                  {/each}
                </ul>
              {/each}
            </section>
          {/if}
        {/each}
      {/if}
      <small class="muted">{say("Controllato", "Checked")} {formatDateIn(language, result.checkedAt)} · {result.host}</small>
      <div class="site-check-head">
        <button type="button" class="button outline small" onclick={verify} disabled={busy || !connection.read} data-testid="cms-site-check-browser">{t("wpcheck.verify")}</button>
        <span class="field-hint">{t("wpcheck.verifyHint")}</span>
      </div>
    </div>
  {/if}
  {#if browser}
    <section class="site-check-result" aria-label={t("wpcheck.title")} role="status" aria-live="polite" data-testid="cms-site-check-browser-result">
      <h4>{t("wpcheck.title")}</h4>
      {#if !browser.pages.length}
        <p>{t("wpcheck.none")}</p>
      {:else}
        <p>{t("wpcheck.opened", { n: browser.opened, total: browser.pages.length })}</p>
        <ul class="site-check-pages">
          {#each browser.pages as page (page.page)}<li><strong>{page.title}</strong> <span class="muted">{page.page}</span></li>{/each}
        </ul>
      {/if}
      {#if browser.skipped}<p class="field-hint">{t("wpcheck.skipped", { n: browser.skipped })}</p>{/if}
      {#if browser.opened}
        {#if !browser.axe.length}
          <p class="site-check-ok">✓ {t("wpcheck.axeNone")}</p>
        {:else}
          <ul class="site-check-list">
            {#each browser.axe as rule (rule.id)}
              <li data-testid="cms-site-check-axe">
                <strong>{t("wpcheck.axe", { rule: rule.id, n: rule.count })}</strong>
                <span lang="it">{rule.help}</span>
                <small class="muted">{t("wpcheck.in")} {rule.pages.join(", ")}{rule.targets.length ? ` · ${rule.targets.slice(0, 3).join(", ")}` : ""}</small>
              </li>
            {/each}
          </ul>
        {/if}
        {#if browser.overflow.length}<p>{t("wpcheck.overflow", { n: new Set(browser.overflow.map((item) => item.page)).size })}</p>{/if}
        {#if !browser.links.found}
          <p>{t("wpcheck.linksNone")}</p>
        {:else}
          <p>{t("wpcheck.linksChecked", { n: browser.links.checked })}{#if browser.links.found > browser.links.checked} {t("wpcheck.linksOver", { checked: browser.links.checked, found: browser.links.found })}{/if}</p>
          {#if !linkGroups.length}<p class="site-check-ok">✓ {t("wpcheck.linksOk")}</p>{/if}
          {#each linkGroups as group (group.id)}
            <h5>{group.title}</h5>
            <ul class="site-check-list">
              {#each group.items as link (link.url)}
                <li data-testid={`cms-site-check-link-${group.id}`}><span>{link.url}{link.status ? ` (${link.status})` : ""}</span><small class="muted">{t("wpcheck.in")} {link.pages.join(", ")}</small></li>
              {/each}
            </ul>
          {/each}
        {/if}
      {/if}
      {#if browser.failures?.length}
        <p class="field-hint">{t("wpcheck.failures")}</p>
        <ul class="site-check-list">{#each browser.failures as failure, index (index)}<li>{failure}</li>{/each}</ul>
      {/if}
      <small class="muted">{t("wpcheck.checkedAt", { at: formatDateIn(language, browser.checkedAt), host: browser.host })}</small>
    </section>
  {/if}
</div>

<style>
  .site-check { display: grid; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
  .site-check-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .site-check-head .field-hint { margin: 0; }
  .site-check-result { display: grid; gap: 8px; }
  .site-check-result p { margin: 0; }
  .site-check-ok { color: var(--mint-ink, #2f6b4f); font-weight: 700; }
  .site-check-stop { color: #9a3b26; font-weight: 700; }
  .site-check-section h4, .site-check-result h4 { margin: 4px 0; font-size: 14px; }
  .site-check-result h5 { margin: 2px 0; font-size: inherit; }
  .site-check-pages { display: grid; gap: 2px; margin: 0; padding-left: 18px; overflow-wrap: anywhere; }
  .site-check-list { display: grid; gap: 8px; margin: 0 0 6px; padding: 0; list-style: none; }
  .site-check-list li { display: grid; gap: 2px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; overflow-wrap: anywhere; }
  .site-check-kind { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted, #6b6b6b); }
  .site-check-remedy b { font-weight: 700; }
  @media (prefers-color-scheme: dark) {
    .site-check-stop { color: #f0a58f; }
  }
</style>
