<script module lang="ts">
  export interface FrontPageOfferView {
    frontPage: { id: string; title: string };
    postsPage: { id: string; title: string } | null;
    postsWithoutPage: boolean;
    current: { showOnFront: "posts" | "page"; frontPageIsOther: boolean; postsPageIsOther: boolean };
  }
</script>

<script lang="ts">
  import type { Language } from "../lib/i18n.js";
  import { modal } from "../lib/modal.js";

  /**
   * Doc 23 item 201: after the first send with publishing, the proposal to make the project's home (and its «blog»
   * page) the site's home and posts page on WP. It changes the live site, so it waits for the user's yes; «No» is
   * remembered for this site, closing the window asks again at the next send with publishing.
   */
  let { language, host, offer, answer, onclose }: {
    language: Language;
    host: string;
    offer: FrontPageOfferView;
    answer: (accept: boolean) => Promise<void>;
    onclose: () => void;
  } = $props();
  const say = (italian: string, english: string) => language === "it" ? italian : english;
  let busy = $state(false);
  let failure = $state("");

  async function reply(accept: boolean): Promise<void> {
    busy = true;
    failure = "";
    try {
      await answer(accept);
    } catch (error) {
      failure = error instanceof Error ? error.message : say("Il sito non ha risposto.", "The site did not answer.");
    } finally {
      busy = false;
    }
  }
</script>

<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget && !busy) onclose(); }}>
  <div class="modal-card front-page-offer" role="dialog" aria-modal="true" aria-labelledby="front-page-offer-title" tabindex="-1" data-testid="cms-front-page-offer" use:modal={{ onClose: () => onclose(), canClose: () => !busy }}>
    <div class="eyebrow">{say("PAGINA INIZIALE", "HOME PAGE")}</div>
    <h2 id="front-page-offer-title">{say(`Vuoi che ${host} si apra su «${offer.frontPage.title}», come nel progetto?`, `Should ${host} open on “${offer.frontPage.title}”, as in the project?`)}</h2>
    {#if offer.current.frontPageIsOther}
      <p>{say("Oggi la pagina iniziale del sito è un’altra pagina, che non fa parte del progetto.", "Today the site’s home page is another page, which is not part of the project.")}</p>
    {:else if offer.current.showOnFront === "posts"}
      <p>{say(`Oggi l’indirizzo principale del sito mostra l’elenco degli articoli, e «${offer.frontPage.title}» si apre solo dal suo indirizzo. In Histeon Publish è la pagina iniziale.`, `Today the site’s main address shows the list of posts, and “${offer.frontPage.title}” only opens at its own address. In Histeon Publish it is the home page.`)}</p>
    {:else}
      <p>{say(`In Histeon Publish «${offer.frontPage.title}» è la pagina iniziale; sul sito non ancora.`, `In Histeon Publish “${offer.frontPage.title}” is the home page; on the site it is not yet.`)}</p>
    {/if}
    {#if offer.postsPage}
      <p>{say(`Gli articoli saranno elencati nella pagina «${offer.postsPage.title}», come nel progetto.`, `Posts will be listed on the page “${offer.postsPage.title}”, as in the project.`)}</p>
    {:else if offer.postsWithoutPage}
      <p>{say("Il progetto non ha una pagina «blog»: sul sito l’elenco di tutti gli articoli non avrà più un indirizzo suo. Ogni articolo resta dove si trova.", "The project has no “blog” page: on the site the list of all posts will no longer have an address of its own. Each post stays where it is.")}</p>
    {/if}
    <p class="muted">{say("Il sito online cambia subito. Si può cambiare di nuovo da WP, in Impostazioni → Lettura.", "The live site changes at once. It can be changed again in WP, under Settings → Reading.")}</p>
    {#if failure}<p class="front-page-offer-error" role="alert">{failure}</p>{/if}
    <div class="modal-actions">
      <button type="button" class="button outline" disabled={busy} data-testid="cms-front-page-decline" onclick={() => reply(false)}>{say("No, lascia così", "No, leave it")}</button>
      <button type="button" class="button dark" disabled={busy} data-testid="cms-front-page-accept" onclick={() => reply(true)}>{say("Sì, imposta come nel progetto", "Yes, set it as in the project")}</button>
    </div>
  </div>
</div>

<style>
  .front-page-offer p { margin: 0 0 10px; line-height: 1.55; }
  .front-page-offer-error { padding: 9px 11px; border-radius: 6px; background: #fdecec; color: #8a2a2a; }
  @media (prefers-color-scheme: dark) {
    .front-page-offer-error { background: #3a2323; color: #f2b8b8; }
  }
</style>
