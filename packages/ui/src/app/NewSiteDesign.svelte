<script lang="ts">
  import { untrack } from "svelte";
  import { uploadTransferArchive } from "../lib/api.js";
  import type { Language } from "../lib/i18n.js";

  /**
   * «Nuovo sito da Penpot o Figma»: a whole `.penpot` or `.fig` file is uploaded to the local server, which answers
   * its pages and frames; one frame then becomes a Histeon prototype with the report of what was deduced or left out.
   * Nothing is imported here: «Controlla e importa» hands the prototype to the same check as one the user wrote.
   * The file may also come from the drop zone or the file chooser of the screen (`file` is bound), or be dropped on
   * the card itself.
   */
  let { language, act, busy, file = $bindable(), onPrototype }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    file: File | null;
    onPrototype: (prototype: File) => Promise<void>;
  } = $props();
  const say = (italian: string, english: string) => language === "it" ? italian : english;

  interface DesignFrame { id: string; name: string; width: number; height: number; layers: number }
  interface DesignPages { file: string; source: "penpot" | "figma"; truncated: boolean; pages: Array<{ id: string; name: string; frames: DesignFrame[] }> }
  interface DesignPrototype { id: string; fileName: string; html: string; report: string; page: string; frame: string }

  /** The largest `.penpot` or `.fig` file the server reads. */
  const DESIGN_FILE_MAX_BYTES = 512 * 1024 * 1024;
  let input = $state<HTMLInputElement | null>(null);
  let listed = $state<DesignPages | null>(null);
  let listedFor = $state<File | null>(null);
  let pageId = $state("");
  let frameId = $state("");
  let noComponents = $state(false);
  let noRecords = $state(false);
  let uniform = $state(false);
  let made = $state<DesignPrototype | null>(null);
  let links = $state<{ html: string; report: string } | null>(null);

  // Only the pages with a frame at their top can be converted.
  const pages = $derived(listed?.pages.filter((page) => page.frames.length) ?? []);
  const page = $derived(pages.find((item) => item.id === pageId) ?? null);

  function pick(event: Event): void {
    const field = event.currentTarget as HTMLInputElement;
    const chosen = field.files?.[0] ?? null;
    field.value = "";
    if (chosen) file = chosen;
  }

  /** True while files are dragged over the card. */
  let over = $state(false);

  // The names of dragged files cannot be read before the drop: any file is let in, and the drop decides.
  function dragOver(event: DragEvent): void {
    if (busy || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    over = true;
  }

  /** One `.penpot` or `.fig` file dropped on the card is taken like one chosen with the button; anything else is refused with its reason. */
  function drop(event: DragEvent): void {
    over = false;
    if (!event.dataTransfer?.types.includes("Files")) return;
    // Without this the window would open the dropped file in place of the app.
    event.preventDefault();
    if (busy) return;
    const dropped = [...event.dataTransfer.files];
    const one = dropped.length === 1 && /\.(?:penpot|fig)$/iu.test(dropped[0]?.name ?? "") ? dropped[0] : undefined;
    if (one) file = one;
    else void act(async () => { throw new Error(say("Qui va un solo file .penpot o .fig.", "Only one .penpot or .fig file goes here.")); });
  }

  /** The pages and the frames of the chosen file. A file the server does not read is let go, with its reason. */
  async function list(chosen: File): Promise<void> {
    listedFor = chosen;
    listed = null;
    made = null;
    try {
      if (chosen.size > DESIGN_FILE_MAX_BYTES) throw new Error(say("Il file di design supera 512 MB.", "The design file is over 512 MB."));
      const view = await uploadTransferArchive<DesignPages>(`/api/cms/v1/design-file/pages?name=${encodeURIComponent(chosen.name)}`, chosen, "application/octet-stream");
      if (file !== chosen) return;
      const first = view.pages.find((item) => item.frames.length);
      if (!first) throw new Error(say("Il file non ha riquadri da convertire: in ogni pagina serve almeno un riquadro.", "The file has no frames to convert: each page needs at least one frame."));
      listed = view;
      pageId = first.id;
      frameId = first.frames[0]?.id ?? "";
    } catch (error) {
      if (file === chosen) file = null;
      throw error;
    }
  }

  // A file chosen here, dropped on the screen or picked by its file chooser: all of them are listed the same way.
  $effect(() => {
    const chosen = file;
    if (!chosen) {
      listed = null;
      made = null;
      listedFor = null;
    } else if (chosen !== untrack(() => listedFor)) void act(() => list(chosen));
  });

  function choosePage(): void {
    frameId = page?.frames[0]?.id ?? "";
    made = null;
  }

  /** One frame as a prototype: the server reads the file again, because it keeps nothing between two requests. */
  async function convert(): Promise<void> {
    const chosen = file;
    if (!chosen || !pageId || !frameId) return;
    made = null;
    const query = new URLSearchParams({ name: chosen.name, page: pageId, frame: frameId, components: noComponents ? "0" : "1", records: noRecords ? "0" : "1", uniform: uniform ? "1" : "0" });
    const view = await uploadTransferArchive<DesignPrototype>(`/api/cms/v1/design-file/prototype?${query.toString()}`, chosen, "application/octet-stream");
    if (file === chosen) made = view;
  }

  // The links to save the prototype and its report live as long as the prototype shown.
  $effect(() => {
    const view = made;
    if (!view) {
      links = null;
      return;
    }
    const html = URL.createObjectURL(new Blob([view.html], { type: "text/html" }));
    const report = URL.createObjectURL(new Blob([`${view.report}\n`], { type: "text/plain" }));
    links = { html, report };
    return () => {
      URL.revokeObjectURL(html);
      URL.revokeObjectURL(report);
    };
  });

  /** Frames of the page with the same name are told apart by their place among them: «Home (2º di 4)». */
  function framePlace(frame: DesignFrame, frames: readonly DesignFrame[]): string {
    const twins = frames.filter((item) => item.name === frame.name);
    return twins.length > 1 ? ` (${twins.indexOf(frame) + 1}${say("º di", " of")} ${twins.length})` : "";
  }
  const frameLabel = (frame: DesignFrame, frames: readonly DesignFrame[]) => `${frame.name}${framePlace(frame, frames)} · ${Math.round(frame.width)} × ${Math.round(frame.height)} px, ${frame.layers} ${say(frame.layers === 1 ? "livello" : "livelli", frame.layers === 1 ? "layer" : "layers")}`;
</script>

<!-- A section with a name is a region already, and the drop is a second way beside the button, which the keyboard reaches. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<section class="panel-card new-way-design" class:over aria-labelledby="new-design-title" data-testid="new-site-design" ondragover={dragOver} ondragleave={() => { over = false; }} ondrop={drop}>
  <div class="new-design-head">
    <div>
      <h2 id="new-design-title">{say("Da Penpot o Figma", "From Penpot or Figma")}</h2>
      <p class="muted">{say("Un riquadro di un file .penpot (esportato da Penpot) o .fig (salvato da Figma) diventa un prototipo Histeon: sezioni, righe e colonne, testi sul gradino più vicino della scala, immagini e icone. Il file si legge su questo computer, senza rete e senza credenziali.", "One frame of a .penpot file (exported from Penpot) or a .fig file (saved from Figma) becomes a Histeon prototype: sections, rows and columns, texts on the nearest step of the scale, pictures and icons. The file is read on this computer, with no network and no credentials.")}</p>
    </div>
    <div class="admin-actions">
      <input bind:this={input} class="visually-hidden" tabindex="-1" aria-hidden="true" type="file" accept=".penpot,.fig" data-testid="new-site-design-file" onchange={pick} />
      <button class="button outline" type="button" onclick={() => input?.click()} disabled={busy}>{say("Scegli un file .penpot o .fig", "Choose a .penpot or .fig file")}</button>
    </div>
  </div>
  {#if file && listed}
    <div class="new-design-choice">
      <p class="field-hint" role="status" data-testid="new-site-design-summary">{file.name}: {listed.source === "figma" ? "Figma" : "Penpot"}, {pages.length} {say(pages.length === 1 ? "pagina con riquadri" : "pagine con riquadri", pages.length === 1 ? "page with frames" : "pages with frames")}.{listed.truncated ? ` ${say("Il file ne ha altre: l’elenco è troncato.", "The file has more: the list is cut short.")}` : ""}</p>
      <div class="new-design-fields">
        <label class="field-label" for="new-design-page">{say("Pagina del design", "Page of the design")}</label>
        <select id="new-design-page" bind:value={pageId} onchange={choosePage} disabled={busy} data-testid="new-site-design-page">
          {#each pages as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
        </select>
        <label class="field-label" for="new-design-frame">{say("Riquadro da convertire", "Frame to convert")}</label>
        <select id="new-design-frame" bind:value={frameId} onchange={() => { made = null; }} disabled={busy} data-testid="new-site-design-frame">
          {#each page?.frames ?? [] as frame (frame.id)}<option value={frame.id}>{frameLabel(frame, page?.frames ?? [])}</option>{/each}
        </select>
      </div>
      <fieldset class="new-design-options">
        <legend>{say("Come convertire", "How to convert")}</legend>
        <label><input type="checkbox" bind:checked={noComponents} onchange={() => { made = null; }} disabled={busy} data-testid="new-site-design-no-components" /> <span><strong>{say("Senza componenti", "Without components")}</strong>: {say("ciò che si ripete non viene riunito, ogni copia resta nel markup del suo blocco.", "what repeats is not gathered, each copy stays in the markup of its block.")}</span></label>
        <label><input type="checkbox" bind:checked={noRecords} onchange={() => { made = null; }} disabled={busy} data-testid="new-site-design-no-records" /> <span><strong>{say("Senza record", "Without records")}</strong>: {say("le schede in fila restano usi del loro componente, senza record e loop.", "cards in a row stay uses of their component, without records and loops.")}</span></label>
        <label><input type="checkbox" bind:checked={uniform} onchange={() => { made = null; }} disabled={busy} data-testid="new-site-design-uniform" /> <span><strong>{say("Schede uniformi", "Uniform cards")}</strong>: {say("le schede in fila prendono tutte lo stile della prima, così diventano record anche se il design mette ogni immagine a mano. Cambia l’aspetto.", "cards in a row all take the style of the first one, so they become records even when the design places each picture by hand. It changes how they look.")}</span></label>
        <p class="field-hint">{say("Per portare poi il sito verso Etch + ACSS scegli «Senza componenti» e «Senza record»: l’esportazione verso Etch non porta componenti e record.", "To take the site on to Etch + ACSS choose «Without components» and «Without records»: the export to Etch does not carry components and records.")}</p>
      </fieldset>
      <div class="admin-actions">
        <button class="button dark" type="button" onclick={() => void act(convert)} disabled={busy || !pageId || !frameId} data-testid="new-site-design-convert">{say("Converti in prototipo", "Convert to a prototype")}</button>
        <button class="button text" type="button" onclick={() => { file = null; }} disabled={busy}>{say("Togli il file", "Remove the file")}</button>
      </div>
    </div>
  {/if}
  {#if made}
    <div class="new-design-report" role="status" data-testid="new-site-design-report">
      <p><strong>{say(`Prototipo pronto: riquadro «${made.frame}» della pagina «${made.page}».`, `Prototype ready: frame «${made.frame}» of page «${made.page}».`)}</strong> {say("Niente è stato ancora importato.", "Nothing has been imported yet.")}</p>
      <details open>
        <summary>{say("Che cosa è stato scritto, dedotto o lasciato fuori", "What was written, deduced or left out")}</summary>
        <p class="new-design-text" lang="it" data-testid="new-site-design-report-text">{made.report}</p>
      </details>
      <div class="admin-actions">
        <button class="button primary" type="button" onclick={() => { const view = made; if (view) void act(() => onPrototype(new File([view.html], view.fileName, { type: "text/html" }))); }} disabled={busy} data-testid="new-site-design-import">{say("Controlla e importa", "Check and import")}</button>
        {#if links}
          <a class="button outline" href={links.html} download={made.fileName} data-testid="new-site-design-download">{say("Scarica il prototipo", "Download the prototype")}</a>
          <a class="button text" href={links.report} download={made.fileName.replace(/\.html$/u, ".rapporto.txt")}>{say("Scarica il rapporto", "Download the report")}</a>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  /* The card takes the whole row of «Nuovo sito»: its choices and its report need the width. */
  .new-way-design { grid-column: 1 / -1; display: grid; gap: 14px; }
  /* A file dragged over the card: the same sign as the drop zone of the screen. */
  .new-way-design.over { border-color: var(--coral); background: #fff9f4; }
  .new-design-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 24px; }
  .new-design-head > div:first-child { flex: 1 1 420px; min-width: 0; }
  .new-design-head p { margin: 0; }
  .new-design-choice, .new-design-report { display: grid; gap: 10px; padding-top: 14px; border-top: 1px solid var(--line); }
  .new-design-choice p, .new-design-report p { margin: 0; }
  .new-design-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 4px 16px; }
  .new-design-fields label { grid-row: 1; }
  .new-design-fields select { grid-row: 2; min-width: 0; }
  .new-design-options { display: grid; gap: 6px; margin: 0; padding: 0; border: 0; }
  .new-design-options legend { padding: 0; margin-bottom: 4px; font-weight: 600; }
  .new-design-options label { display: flex; align-items: baseline; gap: 8px; }
  /* The checkbox keeps its own size: the fields of the app fill their row. */
  .new-design-options input { flex: none; width: auto; min-height: 0; margin: 0; }
  .new-design-options span { flex: 1 1 0; min-width: 0; }
  .new-design-text { max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  @media (max-width: 760px) {
    .new-design-fields { grid-template-columns: 1fr; }
    .new-design-fields label, .new-design-fields select { grid-row: auto; }
  }
</style>
