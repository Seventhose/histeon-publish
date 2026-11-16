<script lang="ts">
  import { api, uploadTransferArchive } from "../lib/api.js";
  import type { Language } from "../lib/i18n.js";

  /**
   * «Importa token»: the design tokens of Figma or Penpot over the Histeon CSS design of the project. They come from
   * JSON files (read here, sent as text), from a whole `.penpot` or `.fig` file (uploaded, the server answers its
   * tokens) or from a file of Figma read by the server from its API. The server says what they give and saves only
   * when asked. The token of Figma is typed here once, kept in the keyring by the server and never shown again.
   */
  let { language, act, busy, projectId }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    projectId: string;
  } = $props();
  const say = (italian: string, english: string) => language === "it" ? italian : english;

  interface TokenImportView { applied: boolean; head: string; text: string; counts: { parameters: number; variables: number; replaced: number } }
  interface TokenProblem { token: string; why: string }
  /** What `tokens/source/file` and `tokens/source/figma` answer: the tokens as text and what was said beside them. */
  interface TokenSourceView { kind: string; summary: string; problems: TokenProblem[]; files: Array<{ name: string; text: string }> }
  interface FigmaTokenState { configured: boolean; source: "environment" | "keyring" | null; available: boolean }
  /** `whole`: tokens the server took from a design file or from Figma; their dark theme is inside, never in the name. */
  interface ChosenFile { name: string; text: string; whole?: boolean }

  /** The limit of the server for the whole request: the files of both themes together. */
  const FILES_MAX_BYTES = 8 * 1024 * 1024;
  /** The largest `.penpot` or `.fig` file the server reads. */
  const DESIGN_FILE_MAX_BYTES = 512 * 1024 * 1024;
  let input: HTMLInputElement | null = $state(null);
  let chosen: ChosenFile[] = $state([]);
  let sources: Array<{ summary: string; problems: TokenProblem[] }> = $state([]);
  let shownNames: string[] = $state([]);
  let outcome: TokenImportView | null = $state(null);
  let shownFor = $state("");

  let figmaToken: FigmaTokenState | null = $state(null);
  let figmaSecret = $state("");
  let figmaHandle = $state("");
  let figmaAddress = $state("");

  /** A file named dark, scuro, night or notte is the dark theme, as in the Histeon CSS panel of the builder. */
  const isDarkFile = (name: string) => /(^|[^a-z])(dark|scuro|night|notte)([^a-z]|$)/iu.test(name);

  /** True for a ZIP archive (`.penpot`, `.fig`) or a bare Figma document: told by the first bytes, never by the name. */
  async function isDesignFile(file: File): Promise<boolean> {
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    return (head[0] === 0x50 && head[1] === 0x4b) || new TextDecoder().decode(head) === "fig-kiwi";
  }

  /** The report of the files chosen, or with `apply` the save. The save is made on the revision the report was read on. */
  async function send(apply: boolean): Promise<void> {
    const dark = chosen.filter((file) => !file.whole && isDarkFile(file.name));
    const light = dark.length < chosen.length ? chosen.filter((file) => !dark.includes(file)) : chosen;
    const plain = (files: ChosenFile[]) => files.map(({ name, text }) => ({ name, text }));
    const head = apply && outcome ? outcome.head : (await api<{ head: string }>(`/api/cms/v1/projects/${projectId}/tokens`)).head;
    outcome = await api<TokenImportView>(`/api/cms/v1/projects/${projectId}/tokens/import`, {
      method: "POST",
      body: JSON.stringify({ head, files: plain(light), ...(light !== chosen ? { dark: plain(dark) } : {}), ...(sources.length ? { sources } : {}), apply }),
    });
    shownFor = projectId;
  }

  /** What a source answered becomes the files of the report; its summary and problems go on with the import. */
  function take(view: TokenSourceView): ChosenFile[] {
    if (view.summary || view.problems.length) sources = [...sources, { summary: view.summary, problems: view.problems }];
    return view.files.map((file) => ({ ...file, whole: true }));
  }

  async function pick(event: Event): Promise<void> {
    const field = event.currentTarget as HTMLInputElement;
    const files = [...(field.files ?? [])];
    field.value = "";
    if (!files.length) return;
    outcome = null;
    sources = [];
    chosen = [];
    const design = await Promise.all(files.map(isDesignFile));
    if (files.some((file, at) => design[at] && file.size > DESIGN_FILE_MAX_BYTES)) throw new Error(say("Un file di design supera 512 MB.", "A design file is over 512 MB."));
    if (files.reduce((sum, file, at) => sum + (design[at] ? 0 : file.size), 0) > FILES_MAX_BYTES) throw new Error(say("I file dei token superano 8 MB in tutto.", "The token files are over 8 MB in all."));
    const read: ChosenFile[] = [];
    // One after the other: a whole design file is large, and the order of the files is the order they apply.
    for (const [at, file] of files.entries()) {
      if (design[at]) read.push(...take(await uploadTransferArchive<TokenSourceView>(`/api/cms/v1/projects/${projectId}/tokens/source/file?name=${encodeURIComponent(file.name)}`, file, "application/octet-stream")));
      else read.push({ name: file.name, text: await file.text() });
    }
    chosen = read;
    shownNames = files.map((file) => file.name);
    await send(false);
  }

  async function loadFigmaToken(): Promise<void> {
    try {
      figmaToken = (await api<{ token: FigmaTokenState }>("/api/cms/v1/figma-token")).token;
    } catch {
      figmaToken = { configured: false, source: null, available: false };
    }
  }
  $effect(() => { void loadFigmaToken(); });

  /** Sends the token once: the server checks it with Figma and keeps it in the keyring. The field is emptied either way. */
  async function saveFigmaToken(): Promise<void> {
    const token = figmaSecret.trim();
    figmaSecret = "";
    figmaHandle = "";
    if (!token) throw new Error(say("Incolla il token di Figma.", "Paste the Figma token."));
    const saved = await api<{ token: FigmaTokenState; handle: string }>("/api/cms/v1/figma-token", { method: "POST", body: JSON.stringify({ token }) });
    figmaToken = saved.token;
    figmaHandle = saved.handle;
  }

  async function removeFigmaToken(): Promise<void> {
    figmaSecret = "";
    figmaHandle = "";
    figmaToken = (await api<{ token: FigmaTokenState }>("/api/cms/v1/figma-token", { method: "DELETE" })).token;
  }

  /** The styles and variables of a file of Figma, read by the server from its API: only the address leaves this page. */
  async function readFigma(): Promise<void> {
    const address = figmaAddress.trim();
    if (!address) throw new Error(say("Incolla l'indirizzo del file di Figma.", "Paste the address of the Figma file."));
    outcome = null;
    sources = [];
    chosen = [];
    chosen = take(await api<TokenSourceView>(`/api/cms/v1/projects/${projectId}/tokens/source/figma`, { method: "POST", body: JSON.stringify({ figma: address }) }));
    shownNames = [say("File di Figma, letto dalla sua API", "Figma file, read from its API")];
    await send(false);
  }

  function summary(view: TokenImportView): string {
    const { parameters, variables, replaced } = view.counts;
    if (!parameters && !variables) return say("Nessun token è stato riconosciuto: non c'è niente da applicare.", "No token was recognised: there is nothing to apply.");
    return say(
      `Parametri del design: ${parameters}. Variabili del sito: ${variables}. Valori del progetto che cambiano: ${replaced}.`,
      `Design parameters: ${parameters}. Site variables: ${variables}. Values of the project that change: ${replaced}.`,
    );
  }

  function figmaTokenText(state: FigmaTokenState): string {
    if (!state.available) return say("Il portachiavi di sistema non risponde: il token non si può salvare.", "The system keyring does not answer: the token cannot be saved.");
    if (state.source === "environment") return say("Token di Figma dato dalla variabile d'ambiente: non si cambia da qui.", "Figma token given by the environment variable: it cannot be changed here.");
    if (state.configured) return say("Token di Figma salvato nel portachiavi di questo computer.", "Figma token saved in the keyring of this computer.");
    return say("Nessun token di Figma salvato.", "No Figma token saved.");
  }
</script>

<section class="admin-block admin-form-block" data-testid="cms-token-import">
  <div>
    <h2>{say("Importa token di design", "Import design tokens")}</h2>
    <p class="muted">{say("I token esportati da Figma (Variabili → Esporta modi) o da Penpot (Token → Esporta), oppure un file .penpot o .fig intero, diventano i parametri di Histeon CSS e le variabili del sito. Di un file intero si leggono stili, colori, tipografie e variabili: pagine e componenti no. Un file JSON col nome «dark» o «scuro» è il tema scuro. Le misure di testo non diventano misure fisse: il rapporto dice il gradino più vicino.", "The tokens exported from Figma (Variables → Export modes) or Penpot (Tokens → Export), or a whole .penpot or .fig file, become the Histeon CSS parameters and the site variables. Of a whole file the styles, colours, typographies and variables are read: pages and components are not. A JSON file named “dark” is the dark theme. Text sizes never become fixed sizes: the report names the nearest step.")}</p>
  </div>
  <div>
  <div class="admin-actions">
    <input bind:this={input} class="visually-hidden" tabindex="-1" aria-hidden="true" type="file" accept=".json,application/json,.penpot,.fig" multiple data-testid="cms-token-import-file" onchange={(event) => void act(() => pick(event))} />
    <button class="button outline small" type="button" onclick={() => input?.click()} disabled={busy}>{say("Scegli i file dei token o del design", "Choose the token or design files")}</button>
    {#if outcome && shownFor === projectId && !outcome.applied && (outcome.counts.parameters || outcome.counts.variables)}
      <button class="button dark small" type="button" data-testid="cms-token-import-apply" onclick={() => void act(() => send(true))} disabled={busy}>{say("Applica al progetto", "Apply to the project")}</button>
    {/if}
  </div>
  <div class="token-import-figma" data-testid="cms-token-import-figma">
    <h3>{say("Da Figma", "From Figma")}</h3>
    <p class="muted">{say("Publish legge stili e variabili di un file dal servizio di Figma, col tuo token personale (in Figma: Impostazioni → Sicurezza → Token di accesso personali, permesso di lettura dei file). Il token resta nel portachiavi di questo computer, viaggia solo verso api.figma.com e qui non si rivede più. Le variabili Figma le dà solo ai piani Enterprise: negli altri si leggono gli stili.", "Publish reads the styles and variables of a file from the Figma service, with your personal token (in Figma: Settings → Security → Personal access tokens, file read permission). The token stays in the keyring of this computer, travels only to api.figma.com and is never shown here again. Figma gives variables to Enterprise plans only: on the others the styles are read.")}</p>
    {#if figmaToken}
      <p class="field-hint" role="status" data-testid="cms-figma-token-state">{figmaTokenText(figmaToken)}{figmaHandle ? ` ${say("Account:", "Account:")} ${figmaHandle}.` : ""}</p>
      {#if figmaToken.available && figmaToken.source !== "environment"}
        <form class="token-import-row" onsubmit={(event) => { event.preventDefault(); void act(saveFigmaToken); }}>
          <label class="field-label" for="cms-figma-token">{figmaToken.configured ? say("Sostituisci il token", "Replace the token") : say("Token di Figma", "Figma token")}</label>
          <input id="cms-figma-token" type="password" bind:value={figmaSecret} autocomplete="off" spellcheck="false" maxlength="512" data-testid="cms-figma-token" />
          <button class="button outline small" type="submit" data-testid="cms-figma-token-save" disabled={busy || !figmaSecret.trim()}>{say("Salva il token", "Save the token")}</button>
          {#if figmaToken.configured}<button class="button outline small" type="button" data-testid="cms-figma-token-remove" onclick={() => void act(removeFigmaToken)} disabled={busy}>{say("Rimuovi il token", "Remove the token")}</button>{/if}
        </form>
      {/if}
      {#if figmaToken.configured}
        <form class="token-import-row" onsubmit={(event) => { event.preventDefault(); void act(readFigma); }}>
          <label class="field-label" for="cms-figma-address">{say("Indirizzo del file di Figma", "Address of the Figma file")}</label>
          <input id="cms-figma-address" type="url" bind:value={figmaAddress} autocomplete="off" spellcheck="false" maxlength="2000" placeholder="https://www.figma.com/design/…" data-testid="cms-figma-address" />
          <button class="button outline small" type="submit" data-testid="cms-figma-read" disabled={busy || !figmaAddress.trim()}>{say("Leggi da Figma", "Read from Figma")}</button>
        </form>
      {/if}
    {/if}
  </div>
  </div>
  {#if outcome && shownFor === projectId}
    <div class="token-import-report" role="status" data-testid="cms-token-import-report">
      <p><strong>{outcome.applied ? say("Token applicati al progetto.", "Tokens applied to the project.") : say("Rapporto, niente è stato ancora salvato.", "Report, nothing has been saved yet.")}</strong> {summary(outcome)}</p>
      <p class="field-hint">{shownNames.join(", ")}</p>
      <details open={!outcome.applied}>
        <summary>{say("Che cosa è stato letto", "What was read")}</summary>
        <p class="token-import-text" lang="it">{outcome.text}</p>
      </details>
    </div>
  {/if}
</section>

<style>
  /* The block is a grid of two columns (admin.css): the buttons and Figma share the second, the report takes the whole row. */
  .token-import-figma { display: grid; gap: 8px; margin-top: 6px; padding-top: 12px; border-top: 1px solid var(--line); }
  .token-import-figma p { margin: 0; }
  .token-import-figma h3 { margin: 0; font-size: inherit; }
  .token-import-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .token-import-row .field-label { flex: 1 0 100%; }
  .token-import-row input { flex: 1 1 240px; min-width: 0; }
  .token-import-report { grid-column: 1 / -1; }
  .token-import-text { margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
