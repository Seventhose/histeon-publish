import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { staticSiteProjectId, staticSiteToPrototype } from "../src/static-site-prototype.js";

const text = (value: string) => new TextEncoder().encode(value);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const page = `<!doctype html><html lang="it"><head><title>R</title><link rel="stylesheet" href="s.css"></head><body>
<header class="top"><button class="menu-toggle" aria-expanded="false" aria-controls="menu" onclick="apri()">Menu</button><nav id="menu" class="menu"><a href="#a">A</a><a href="#b">B</a></nav></header>
<div class="accordion"><div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button" data-bs-toggle="collapse" data-bs-target="#c1" aria-expanded="true" aria-controls="c1">Domanda 1</button></h2><div id="c1" class="accordion-collapse collapse show"><div class="accordion-body">Risposta 1</div></div></div>
<div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button" aria-expanded="false" aria-controls="c2">Domanda 2</button></h2><div id="c2" class="accordion-collapse collapse"><div class="accordion-body">Risposta 2</div></div></div></div>
<div class="tabs" role="tablist"><button role="tab" aria-selected="true" aria-controls="t1" class="tab">Uno</button><button role="tab" aria-controls="t2" class="tab">Due</button></div>
<div role="tabpanel" id="t1" class="panel">Primo</div><div role="tabpanel" id="t2" class="panel" hidden>Secondo</div>
<div class="swiper"><div class="swiper-wrapper"><div class="swiper-slide"><p>S1</p></div><div class="swiper-slide"><p>S2</p></div></div><div class="swiper-pagination"></div><div class="swiper-button-next"></div></div>
<button class="open-modal" data-modal="prenota">Prenota</button><dialog id="prenota" class="modal"><p>Chiama</p><button class="close-modal">Chiudi</button></dialog>
<script>function apri() {}</script></body></html>`;
const files = () => [{ path: "index.html", bytes: text(page) }, { path: "s.css", bytes: text(".menu-toggle{display:none}@media (width<48rem){.menu-toggle{display:block}.menu{display:none}}.swiper-wrapper{display:flex}") }];

describe("ricette senza JavaScript (doc 18 §6.6)", () => {
  it("senza la scelta sono solo proposte, e gli script restano", () => {
    const converted = staticSiteToPrototype({ projectId: staticSiteProjectId("r"), name: "R", files: files() });
    expect(converted.recipes).toBe(false);
    expect(converted.recipesAvailable).toBe(true);
    expect(converted.report.notes.join("\n")).toMatch(/proposta: menu mobile/u);
    expect(parsePrototype(converted.html).scripts?.pages.home).toContain("function apri()");
  });

  it("con la scelta menu, fisarmoniche, schede, carosello e modale diventano HTML e CSS, e la pagina non ha script", async () => {
    const converted = staticSiteToPrototype({ projectId: staticSiteProjectId("r"), name: "R", files: files(), recipes: true });
    const parsed = parsePrototype(converted.html);
    const home = (parsed.documents[0]?.source ?? "").replace(/\s+/gu, " ");
    expect(parsed.scripts).toBeUndefined();
    expect(home).not.toContain("data-histos-js");
    // Menu: a details where the button was (its class, so the site's CSS shows it only on phones) with a copy of the nav.
    expect(home).toMatch(/<details class="[^"]*menu-toggle[^"]*"><summary>Menu<\/summary><nav aria-label="Menu mobile"><a href="#a"/u);
    expect(home).toContain('<nav id="menu" class="menu">');
    // Accordion: one group, the first open.
    expect(home).toMatch(/<details class="[^"]*accordion-item[^"]*" name="fisarmonica-1" open=""><summary class="[^"]*accordion-button[^"]*">Domanda 1<\/summary><div class="[^"]*accordion-body/u);
    expect(home).toMatch(/<details class="[^"]*accordion-item[^"]*" name="fisarmonica-1"><summary/u);
    // Tabs: links to panels that all show.
    expect(home).toMatch(/<a href="#t1" class="[^"]*tab[^"]*">Uno<\/a><a href="#t2"/u);
    expect(home).toMatch(/<div id="t2" class="[^"]*panel[^"]*">Secondo<\/div>/u);
    // Carousel: no controls; the track scrolls (its styles moved into its class).
    expect(home).not.toMatch(/swiper-pagination|swiper-button/u);
    expect(parsed.selectors ?? "").toMatch(/scroll-snap-type: ?x mandatory/u);
    // Modal: a section in its place, the opener a link, no close button.
    expect(home).toMatch(/<a href="#prenota" class="[^"]*open-modal[^"]*">Prenota<\/a><div id="prenota" class="[^"]*modal[^"]*"><p>Chiama<\/p><\/div>/u);
    expect(converted.report.notes.join("\n")).toMatch(/ricette senza JavaScript applicate: 1 menu, 2 fisarmoniche, 1 gruppi di schede, 1 caroselli, 1 finestre modali; gli script del sito non sono tenuti/u);
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-recipes-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    await catalog.initialize();
    const built = await buildPrototypeProfile(parsed, catalog);
    expect(built.profile.manifest.requiredCapabilities).not.toContain("documents:script:v1");
  });
});
