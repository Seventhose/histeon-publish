import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { measureSelectable } from "../src/import-measure.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { staticSiteToPrototype, type StaticSiteFile } from "../src/static-site-prototype.js";

/**
 * The importer's corpus (doc 18, F0): six sites written for the tests, each converted as «Converti in progetto
 * Histeon» does today, and measured. The measure is the share of the original elements that stay selectable in the
 * canvas (`xb/element` in the converted pages). The floors below hold today's values, so nothing gets worse; the
 * target of doc 18 §9 (95%), reached by every site of the corpus with F4 (the dialog of script-cdn), is a plain test.
 */
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const corpus = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "import-corpus");

function filesOf(root: string): StaticSiteFile[] {
  const out: StaticSiteFile[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: path.relative(root, full).split(path.sep).join("/"), bytes: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(root);
  return out;
}

function convert(site: string) {
  const files = filesOf(path.join(corpus, site));
  const pages = files.filter((file) => /\.html?$/u.test(file.path) && !/(^|\/)404\.html?$/u.test(file.path)).map((file) => new TextDecoder().decode(file.bytes));
  const input = { projectId: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4", name: site, files };
  // As the app does: what the site takes from other sites is downloaded (here a stylesheet answers with a small CSS
  // that names a font, every other address with a small PNG), then the site is converted again, in two rounds.
  const remote = new Map<string, Uint8Array>();
  let prototype = staticSiteToPrototype(input);
  for (let round = 0; round < 2 && prototype.remoteMedia.some((url) => !remote.has(url)); round++) {
    for (const url of prototype.remoteMedia) remote.set(url, /\.css(?:[?#]|$)/u.test(url) ? new TextEncoder().encode(".remote-cdn{color:red}") : /\.js(?:[?#]|$)/u.test(url) ? new TextEncoder().encode("window.Swiper = function () {};") : PNG);
    prototype = staticSiteToPrototype({ ...input, remoteMedia: remote });
  }
  return { pages, prototype };
}
function measure(site: string) {
  const { pages, prototype } = convert(site);
  return measureSelectable(pages, prototype.html);
}
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The shares measured after each phase (doc 18, 18-stato-avanzamento.md), rounded down: a conversion may only do better. */
const FLOORS: Record<string, number> = {
  "landing-bootstrap": 0.99,
  "webflow-like": 0.98,
  "utility-tailwind": 0.99,
  "blog-statico": 0.99,
  "moduli-svg": 0.98,
  "script-cdn": 1,
};

describe("corpus dell'importatore", () => {
  it.each(Object.keys(FLOORS))("%s: la quota selezionabile non scende", (site) => {
    const result = measure(site);
    console.info(`${site}: ${result.selectable}/${result.original} = ${(result.share * 100).toFixed(1)}%`);
    expect(result.original).toBeGreaterThan(10);
    expect(result.share).toBeGreaterThanOrEqual(FLOORS[site]!);
  });

  it.each(Object.keys(FLOORS))("%s: il sito convertito passa il controllo dell'import (markup trasferibile)", async (site) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-corpus-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    await catalog.initialize();
    const built = await buildPrototypeProfile(parsePrototype(convert(site).prototype.html), catalog);
    expect(built.profile.entities.length).toBeGreaterThan(0);
  });

  it("ogni sito arriva almeno al 95% di elementi selezionabili (obiettivo del doc 18, §9)", () => {
    for (const site of Object.keys(FLOORS)) expect(measure(site).share, site).toBeGreaterThanOrEqual(0.95);
  });
});

describe("il contatore degli elementi selezionabili (V5.3c)", () => {
  it("non supera mai il totale: un link di una frase che il CSS stila conta nel totale quando diventa selezionabile", () => {
    // `.testo a` styles the link: the conversion gives it a class and the builder can select it, while the original
    // count leaves out a plain inline tag inside a sentence.
    const page = '<!doctype html><html><head><style>.testo a{color:#1d6b4a}</style></head><body><main><div class="testo"><p>Scrivici <a href="#contatti">qui</a> per le date.</p></div></main></body></html>';
    const files: StaticSiteFile[] = [{ path: "index.html", bytes: new TextEncoder().encode(page) }];
    const prototype = staticSiteToPrototype({ projectId: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c5", name: "Frase", files });
    const measured = measureSelectable([page], prototype.html);
    expect(measured.selectable).toBeLessThanOrEqual(measured.original);
    expect(measured).toEqual({ original: 4, selectable: 4, share: 1 });
  });

  it("un sito che perde elementi resta sotto il totale come prima", () => {
    const page = "<!doctype html><html><body><main><p>Uno</p><p>Due <em>bene</em></p></main></body></html>";
    const measured = measureSelectable([page], '<!doctype html><html data-histos-prototype="1"><body><template data-histos="page" data-slug="home" data-title="Home">\n<main><p>Uno</p></main>\n</template></body></html>');
    expect(measured).toEqual({ original: 3, selectable: 2, share: 2 / 3 });
  });
});
