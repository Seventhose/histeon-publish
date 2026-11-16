import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prototypeKit } from "@histos-publish/cms";
import { afterEach, describe, expect, it } from "vitest";
import { checkPrototypeBuild } from "../src/cms-api.js";
import { brokenLinkWarnings, checkBuiltLinks, pageLinks } from "../src/prototype-links.js";

/** Doc 17 item 4, without a browser: the internal links of a built preview that lead nowhere become warnings. */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-links-"));
  roots.push(root);
  return root;
}

describe("i link interni della build dell'anteprima (doc 17, voce 4)", () => {
  it("legge gli href come li scrive il renderer, con le entità", () => {
    expect(pageLinks('<a href="/a/">A</a><a class="x" href=\'/b/?q=1&amp;r=2#c\'>B</a><a href=/c/>C</a><a name="d">D</a><link href="/e.css">')).toEqual(["/a/", "/b/?q=1&r=2#c", "/c/"]);
  });

  it("trova gli indirizzi senza pagina, con le pagine che li linkano; il resto passa", async () => {
    const root = await scratch();
    await mkdir(path.join(root, "chi-siamo"), { recursive: true });
    await mkdir(path.join(root, "media"), { recursive: true });
    await writeFile(path.join(root, "media", "foto.jpg"), "x");
    await writeFile(path.join(root, "404.html"), '<a href="/">Home</a><a href="/manca/">Manca</a>');
    await writeFile(path.join(root, "chi-siamo", "index.html"), '<a href="/">Home</a><a href="/chi-siamo">Qui</a><a href="/manca/#x">Manca</a><a href="/../../etc/passwd">Fuori</a>');
    await writeFile(path.join(root, "index.html"), '<a href="/chi-siamo/?a=1#b">Chi</a><a href="/media/foto.jpg">Foto</a><a href="/404">404</a><a href="https://example.org/manca/">Fuori</a><a href="//cdn.example/x">Cdn</a><a href="mailto:a@b.it">Mail</a><a href="#su">Su</a><a href="/caf%C3%A9/">Café</a>');
    const check = await checkBuiltLinks(root);
    expect(check).toEqual({ pages: 3, brokenTotal: 3, brokenLinks: [{ href: "/manca/", pages: ["/404.html", "/chi-siamo/"], count: 2 }, { href: "/../../etc/passwd", pages: ["/chi-siamo/"], count: 1 }, { href: "/café/", pages: ["/"], count: 1 }] });
    expect(brokenLinkWarnings(check)[0]).toBe("Link interno rotto: /manca/ non porta a nessuna pagina del sito (da /404.html, /chi-siamo/). Correggi l'indirizzo o crea la pagina.");
    expect(brokenLinkWarnings({ brokenLinks: check.brokenLinks.slice(0, 1), brokenTotal: 12 }).at(-1)).toBe("Altri 11 link interni rotti: correggi questi e ricontrolla.");
  });

  it("un link rotto in un prototipo è un avviso del controllo con la build, e preview.verify lo dice", async () => {
    const { html } = prototypeKit("minimo");
    const broken = html.replace("<p>Graffa", '<p><a href="/chi-siamo/">Chi siamo</a></p><p>Graffa');
    expect(broken).not.toBe(html);
    const checked = await checkPrototypeBuild(broken, { scratchRoot: await scratch() });
    expect(checked.report.warnings).toEqual(["Link interno rotto: /chi-siamo/ non porta a nessuna pagina del sito (da /). Correggi l'indirizzo o crea la pagina."]);
    expect(checked.preview).toMatchObject({ status: "built", verify: { pages: expect.any(Number), brokenLinks: [{ href: "/chi-siamo/", pages: ["/"], count: 1 }] } });
  }, 60_000);
});
