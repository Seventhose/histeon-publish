<script lang="ts">
  import { type Language } from "../lib/i18n.js";
  import type { Site } from "../lib/app-types.js";

  /** Replacing a site's source with an HTML or ZIP file, and its own server code (a Worker .js) next to it. */
  let { language, act, busy, handleSourceDragOver, handleSourceDrop, removeWorkerModule, replaceSourceFromInput, selectReplacementFile, selectWorkerFile, selectedSite, sourceDropActive = $bindable(), sourceReplacementProgress, workerFromInput }: {
    language: Language;
    act: (task: () => Promise<void>) => Promise<void>;
    busy: boolean;
    handleSourceDragOver: (event: DragEvent) => void;
    handleSourceDrop: (event: DragEvent) => Promise<void>;
    removeWorkerModule: () => Promise<void>;
    replaceSourceFromInput: (event: Event, kind: "html" | "zip") => Promise<void>;
    selectReplacementFile: (kind: "html" | "zip") => void;
    selectWorkerFile: () => void;
    selectedSite: Site;
    sourceDropActive: boolean;
    sourceReplacementProgress: number;
    workerFromInput: (event: Event) => Promise<void>;
  } = $props();
  const say = (italian: string, english: string) => language === "it" ? italian : english;
</script>

<section class="panel-card source-replacement-card">
  <div class="section-card-header"><div><div class="eyebrow">{say("SORGENTE DEL SITO", "SITE SOURCE")}</div><h2>{say("Vuoi aggiornare i file?", "Need to update the files?")}</h2></div><span class="settings-gear" aria-hidden="true">↥</span></div>
  <p class="field-hint">{say(`Sorgente attuale: ${selectedSite.source.label}. Carica un file HTML oppure uno ZIP per sostituirla. Se il sito usa immagini, CSS o JavaScript in file separati, scegli lo ZIP per includerli. La sorgente resta sul computer; crea una nuova build per pubblicare gli aggiornamenti.`, `Current source: ${selectedSite.source.label}. Upload an HTML file or ZIP to replace it. If the site uses separate image, CSS, or JavaScript files, choose the ZIP to include them. The source stays on this computer; create a new build to publish the update.`)}</p>
  <div class="source-drop-zone" class:active={sourceDropActive} role="region" aria-label={say("Area per trascinare un file HTML o ZIP", "Drop area for an HTML or ZIP file")} ondragover={handleSourceDragOver} ondragleave={() => sourceDropActive = false} ondrop={(event) => void handleSourceDrop(event)}>
    <span class="source-drop-icon" aria-hidden="true">⇩</span>
    <strong>{say("Trascina qui il file .zip o .html", "Drop the .zip or .html file here")}</strong>
    <small>{say("Un solo file, più se serve il .js del Worker. Oppure scegli qui sotto.", "One file, plus the Worker .js if needed. Or choose below.")}</small>
  </div>
  <div class="picker-actions"><button class="button outline" onclick={() => selectReplacementFile("html")} disabled={busy}>▤ {say("Sostituisci con HTML", "Replace with HTML")}</button><button class="button outline" onclick={() => selectReplacementFile("zip")} disabled={busy}>▧ {say("Sostituisci con ZIP", "Replace with ZIP")}</button></div>
  <input id="replace-source-html" class="visually-hidden" tabindex="-1" aria-hidden="true" type="file" accept=".html,.htm,text/html" onchange={(event) => void replaceSourceFromInput(event, "html")} />
  <input id="replace-source-zip" class="visually-hidden" tabindex="-1" aria-hidden="true" type="file" accept=".zip,application/zip" onchange={(event) => void replaceSourceFromInput(event, "zip")} />
  <div class="site-worker" data-testid="site-worker">
    <h3>{say("Codice del server (Worker)", "Server code (Worker)")}</h3>
    <p class="field-hint">{say("Un file .js con export default { fetch(request, env, ctx) }: risponde per primo a ogni richiesta, per esempio /api/…, e quando non restituisce niente la richiesta va ai file del sito (puoi anche chiamare env.ASSETS.fetch(request)). Funziona solo su Cloudflare e non diventa mai un file pubblico. In alternativa mettilo nello ZIP, nella radice, come _worker.js.", "A .js file with export default { fetch(request, env, ctx) }: it answers every request first, for example /api/…, and when it returns nothing the request goes to the site's files (you can also call env.ASSETS.fetch(request)). It runs on Cloudflare only and never becomes a public file. Or put it in the ZIP root as _worker.js.")}</p>
    <div class="wp-actions"><span class="muted">{selectedSite.workerModule ? say(`Caricato: ${selectedSite.workerModule.name}`, `Uploaded: ${selectedSite.workerModule.name}`) : say("Nessun codice caricato a parte", "No code uploaded apart")}</span><div><button class="button text small" onclick={() => void act(removeWorkerModule)} disabled={busy || !selectedSite.workerModule}>{say("Togli il codice", "Remove the code")}</button><button class="button outline small" onclick={selectWorkerFile} disabled={busy}>{selectedSite.workerModule ? say("Sostituisci il .js", "Replace the .js") : say("Carica il .js del Worker", "Upload the Worker .js")}</button></div></div>
    <input id="site-worker-js" class="visually-hidden" tabindex="-1" aria-hidden="true" type="file" accept=".js,.mjs,text/javascript,application/javascript" onchange={(event) => void workerFromInput(event)} />
  </div>
  {#if busy && sourceReplacementProgress > 0}<small class="field-hint">{say("File caricato; aggiorno la sorgente…", "File uploaded; updating the source…")}</small>{/if}
</section>
