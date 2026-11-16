import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProposalsPage } from "../src/prototype-proposals.js";

const example = readFileSync(new URL("../../cms/test/fixtures/prototipo-esempio.html", import.meta.url), "utf8");
/** A second proposal: another project, another colour, two published pages linked from the home page. */
const bold = example
  .replace('"id": "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", "name": "Galleria"', '"id": "4c2e1f3a-7d66-4d2b-8e0f-7b8a8f4a3b21", "name": "Galleria audace"')
  .replace('"primary": "#c83c28"', '"primary": "#2850c8"')
  .replace(' data-status="draft"', "")
  .replace(/(<template data-histos="page" data-slug="home"[^>]*>)/u, '$1<nav><a href="/contatti/">Vai ai contatti</a></nav>');

const roots: string[] = [];
async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-proposals-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

interface PageData {
  id: string;
  title: string;
  contact: string | null;
  proposals: Array<{ key: string; name: string; sha256: string; design: Record<string, string>; pages: Array<{ slug: string; title: string; html: string }> }>;
  media: Record<string, string>;
}

function pageData(html: string): PageData {
  const match = /<script type="application\/json" id="histos-proposals-data">([^<]*)<\/script>/u.exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as PageData;
}

describe("pagina delle proposte (A4)", () => {
  it("affianca i prototipi in un file solo, con le pagine come le rende la build e i media una volta sola", async () => {
    const root = await scratch();
    const result = await buildProposalsPage([{ file: "/lavori/classica.html", html: example }, { file: "audace.html", html: bold }], { scratchRoot: root, title: "Proposte per Galleria", contact: "studio@example.com" });
    expect(result.proposals.map((proposal) => [proposal.name, proposal.file, proposal.pages])).toEqual([["Galleria", "classica.html", 1], ["Galleria audace", "audace.html", 2]]);
    expect(result.proposals[0]!.sha256).toBe(createHash("sha256").update(example).digest("hex"));
    const data = pageData(result.html);
    expect(data.title).toBe("Proposte per Galleria");
    expect(data.contact).toBe("studio@example.com");
    expect(data.proposals[1]!.pages.map((page) => page.slug)).toEqual(["home", "contatti"]);
    expect(data.proposals[1]!.design.primary).not.toBe(data.proposals[0]!.design.primary);
    // The home page as the build renders it: template, parts and styles.
    const home = data.proposals[0]!.pages[0]!.html;
    expect(home).toMatch(/^<!doctype html>/iu);
    expect(home).toContain("Studio Ehi");
    expect(home).toContain("<style>");
    // Media by content: both proposals use the same two images, inlined once.
    expect(home).toMatch(/histos-proposal-media:[0-9a-f]{64}/u);
    expect(home).not.toContain("__histos-proposal-media");
    expect(Object.keys(data.media)).toHaveLength(2);
    for (const uri of Object.values(data.media)) expect(uri).toMatch(/^data:image\/png;base64,/u);
    // The scratch folder is gone.
    expect((await readdir(root)).filter((name) => name.startsWith(".proposals-"))).toEqual([]);
  });

  it("il contatto può essere internazionale: nel link l'indirizzo è codificato e il dominio in punycode", async () => {
    const root = await scratch();
    const cases: Array<[string, string]> = [
      ["studio@example.com", "studio@example.com"],
      ["studio@università.it", "studio@xn--universit-y1a.it"],
      ["nicolò@esempio.it", "nicol%C3%B2@esempio.it"],
      // Legal in an address, harmless once encoded: it stays one address.
      ["x?bcc=evil%40y.com&a=@b.com", "x%3Fbcc%3Devil%2540y.com%26a%3D@b.com"],
    ];
    for (const [contact, address] of cases) {
      const { html } = await buildProposalsPage([{ file: "a.html", html: example }], { scratchRoot: root, contact });
      const data = pageData(html) as PageData & { contactAddress: string };
      expect(data.contact).toBe(contact);
      expect(data.contactAddress).toBe(address);
    }
  });

  it("la pagina non carica nulla da fuori ed esegue solo il proprio script, per hash", async () => {
    const root = await scratch();
    const { html } = await buildProposalsPage([{ file: "a.html", html: example }], { scratchRoot: root });
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/u.exec(html)?.[1] ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-src 'none'");
    expect(policy).toContain("img-src data: blob:;");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]!);
    expect(scripts).toHaveLength(1);
    expect(policy).toContain(`script-src 'sha256-${createHash("sha256").update(scripts[0]!).digest("base64")}'`);
    expect(html).not.toMatch(/(?:src|href)="https?:/u);
    // The Google Fonts link of the example stays out, as at import.
    expect(html).not.toContain("fonts.googleapis.com");
  });

  it("nomi e titoli restano testo: nessun markup dei prototipi entra nella pagina", async () => {
    const root = await scratch();
    // In the prototype's JSON, <\/script> is the escape that keeps its own <script> open.
    const hostile = example.replace('"name": "Galleria"', '"name": "Galleria<\\/script><img src=x onerror=alert(1)>"');
    const { html } = await buildProposalsPage([{ file: "<i>x.html", html: hostile }], { scratchRoot: root, title: "</title><script>alert(1)</script>" });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<i>x");
    expect(html).toContain("&lt;i&gt;x.html");
    expect(html.match(/<\/script>/gu)).toHaveLength(2);
    expect(html).toContain("<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>");
    expect(pageData(html).proposals[0]!.name).toBe("Galleria</script><img src=x onerror=alert(1)>");
  });

  it("rifiuta con il nome del file: troppe proposte, lo stesso file due volte, un contatto che non è un indirizzo, un prototipo non valido", async () => {
    const root = await scratch();
    await expect(buildProposalsPage([], { scratchRoot: root })).rejects.toMatchObject({ code: "cms-proposals-invalid" });
    await expect(buildProposalsPage(Array.from({ length: 7 }, (_, index) => ({ file: `${index}.html`, html: example })), { scratchRoot: root })).rejects.toMatchObject({ code: "cms-proposals-invalid" });
    await expect(buildProposalsPage([{ file: "a.html", html: example }, { file: "b.html", html: example }], { scratchRoot: root })).rejects.toThrow(/b\.html: lo stesso prototipo/u);
    // Another file with the same project id (a copy saved with other line ends, two proposals left with one id).
    await expect(buildProposalsPage([{ file: "a.html", html: example }, { file: "c.html", html: example.replaceAll("\n", "\r\n") }], { scratchRoot: root })).rejects.toThrow(/c\.html: ha lo stesso id di a\.html/u);
    for (const contact of ["studio", "a@b.c\r\nBcc: altri@example.com", "a@b.com?cc=x@y.com", "<a@b.com>", "studio@example.com#x.com", "studio@example.it?bcc=x.it", "a@b..com", "a b@example.com", ".a@example.com"]) {
      await expect(buildProposalsPage([{ file: "a.html", html: example }], { scratchRoot: root, contact })).rejects.toThrow(/indirizzo email/u);
    }
    await expect(buildProposalsPage([{ file: "rotto.html", html: "<html><body>niente</body></html>" }], { scratchRoot: root })).rejects.toMatchObject({ code: "cms-prototype-invalid", message: expect.stringMatching(/^rotto\.html: /u) });
    const noPages = example.replace(/<template data-histos="page" data-slug="home"/u, '<template data-histos="page" data-slug="home" data-status="draft"');
    await expect(buildProposalsPage([{ file: "bozze.html", html: noPages }], { scratchRoot: root })).rejects.toThrow(/bozze\.html: il prototipo non ha pagine pubblicate/u);
  });

  it("senza download i media remoti sono segnaposto, e la pagina lo dice; nessuna rete", async () => {
    const root = await scratch();
    const remote = example.replace('{ "name": "texture", "data": ', '{ "name": "remota", "url": "https://media.example.com/foto.jpg" },\n  { "name": "texture", "data": ');
    let fetched = 0;
    const result = await buildProposalsPage([{ file: "remota.html", html: remote }], { scratchRoot: root, fetchAsset: async () => { fetched++; throw new Error("rete"); } });
    expect(fetched).toBe(0);
    expect(result.notes.join("\n")).toMatch(/remota\.html: un'immagine remota è un segnaposto/u);
  });

  it("i link delle anteprime non portano fuori: puntano a un frammento, la destinazione la segue lo script", async () => {
    const root = await scratch();
    const linked = bold.replace("<nav>", '<nav><a href="https://example.com/" target="_blank" download="x">Fuori</a>');
    const { html } = await buildProposalsPage([{ file: "audace.html", html: linked }], { scratchRoot: root });
    const home = pageData(html).proposals[0]!.pages[0]!.html;
    expect(home).toMatch(/<a href="#histos-preview-link" data-histos-href="\/contatti\/"\s*>Vai ai contatti<\/a>/u);
    expect(home).toContain('data-histos-href="https://example.com/"');
    expect(home).not.toMatch(/\shref="(?!#histos-preview-link")|\sping=/u);
    // target and download stay, for the styles: the frame has no popups and no downloads.
    expect(home).toContain('target="_blank" download="x"');
  });

  it("si legge in qualunque charset: script e dati in ASCII, e il segno d'ordine dei byte in testa", async () => {
    const root = await scratch();
    const accented = example.replace('"name": "Galleria"', '"name": "Galleria è più 🎨 bella"');
    const { html } = await buildProposalsPage([{ file: "a.html", html: accented }], { scratchRoot: root, title: "Proposte per l’artista" });
    expect(html.charCodeAt(0)).toBe(0xfeff);
    const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? "";
    const data = /<script type="application\/json" id="histos-proposals-data">([^<]*)<\/script>/u.exec(html)?.[1] ?? "";
    // Printable ASCII and line breaks only.
    for (const part of [script, data]) expect(part).not.toMatch(/[^ -~\t\n\r]/u);
    expect(pageData(html).proposals[0]!.name).toBe("Galleria è più 🎨 bella");
    expect(pageData(html).title).toBe("Proposte per l’artista");
  });

  it("si ferma appena la pagina supererebbe il limite, senza costruirla in memoria", async () => {
    const root = await scratch();
    // The second file is not even a prototype: an early stop never reaches it.
    await expect(buildProposalsPage([{ file: "a.html", html: example }, { file: "rotto.html", html: "<html></html>" }], { scratchRoot: root, maxBytes: 20_000 })).rejects.toMatchObject({ code: "cms-proposals-too-large" });
    // What is counted is what is written: markup heavy in <, > and & is six times longer escaped.
    const heavy = bold.replace("<nav>", `<nav><p>${"<b>&amp;</b>".repeat(4000)}</p>`);
    const sized = await buildProposalsPage([{ file: "a.html", html: heavy }], { scratchRoot: root });
    const written = Buffer.byteLength(sized.html, "utf8");
    // The count before writing is within a few kilobytes of what is written.
    await expect(buildProposalsPage([{ file: "a.html", html: heavy }, { file: "rotto.html", html: "<html></html>" }], { scratchRoot: root, maxBytes: written - 4096 })).rejects.toMatchObject({ code: "cms-proposals-too-large" });
    expect((await buildProposalsPage([{ file: "a.html", html: heavy }], { scratchRoot: root, maxBytes: written + 4096 })).proposals).toHaveLength(1);
    // A limit that is not a positive number is the usual one.
    for (const maxBytes of [Number.NaN, -1, 0]) expect((await buildProposalsPage([{ file: "a.html", html: example }], { scratchRoot: root, maxBytes })).proposals).toHaveLength(1);
    // The limit can only go down.
    const result = await buildProposalsPage([{ file: "a.html", html: example }], { scratchRoot: root, maxBytes: 10 ** 12 });
    expect(result.proposals).toHaveLength(1);
  }, 120_000);

  it("le pagine seguono l'ordine del prototipo; oltre 12, l'avviso nomina quelle rimaste fuori", async () => {
    const root = await scratch();
    const slugs = ["zeta", "alfa", "mu", "beta", "omega", "kappa", "delta", "pi", "gamma", "rho", "eta", "tau", "sigma", "chi"];
    const pages = slugs.map((slug) => `<template data-histos="page" data-slug="${slug}" data-title="${slug.toUpperCase()}" data-template="site/page"><p>${slug}</p></template>`).join("\n");
    const many = example.replace("</body>", `${pages}\n</body>`);
    const result = await buildProposalsPage([{ file: "molte.html", html: many }], { scratchRoot: root });
    expect(pageData(result.html).proposals[0]!.pages.map((page) => page.slug)).toEqual(["home", ...slugs.slice(0, 11)]);
    expect(result.notes.join("\n")).toContain("restano fuori tau, sigma, chi.");
  });

  it("un link attorno a un blocco, che il parser ricrea, non ferma la pagina delle proposte", async () => {
    const root = await scratch();
    const card = bold.replace("<nav>", '<p><a href="/contatti/">Scrivimi<div>blocco</div></a></p><nav>');
    const { html } = await buildProposalsPage([{ file: "scheda.html", html: card }], { scratchRoot: root });
    const home = pageData(html).proposals[0]!.pages[0]!.html;
    expect(home.match(/data-histos-href="\/contatti\/"/gu)?.length).toBeGreaterThanOrEqual(1);
  });

  it("un titolo tagliato non spezza un carattere", async () => {
    const root = await scratch();
    const { html } = await buildProposalsPage([{ file: "a.html", html: example }], { scratchRoot: root, title: `${"x".repeat(199)}🎨🎨` });
    expect(pageData(html).title).toBe(`${"x".repeat(199)}🎨`);
  });
});
