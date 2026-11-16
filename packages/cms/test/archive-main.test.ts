import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, serializeXb } from "../.generated/histos-dsl/index.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype, PrototypeError } from "../src/prototype-import.js";
import { CMS_META_DESCRIPTION_MAX, cmsMetaDescription, renderCmsPage } from "../src/static-renderer.js";

/**
 * The renderer's side of the archives (D3, D6): `{#loop main()}` reads the archive the build gives it, and nothing
 * else; the head carries the excerpt as the meta description. And the prototype's own check of main() loops.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cms-main-"));
  roots.push(root);
  return (await new CmsProjectCatalog(root).createProject("Main")).store;
}

const content = (source: string) => serializeXb(parse(source).blocks);

describe("main() e descrizione nel renderer", () => {
  it("main() elenca ciò che la build dà per l'archivio; senza archivio o con argomenti si rifiuta con il motivo", async () => {
    const store = await newStore();
    const loop = content('{#loop main() as item}<a href="{item.url}">{item.title}</a>{/loop}');
    const items = [{ id: "a", typeKey: "opera", title: "Ehi", slug: "ehi", url: "/opera/ehi/", fields: {}, values: {}, terms: {} }];
    const rendered = await renderCmsPage({ store, projectId: "p", content: loop, page: { id: "x", title: "Opere", slug: "opera", url: "/opera/" }, mainQuery: () => items });
    expect(rendered.html).toContain('<a href="/opera/ehi/">Ehi</a>');
    // Before: «La query main non è configurata nel CMS relazionale M3.»
    await expect(renderCmsPage({ store, projectId: "p", content: loop, page: { id: "x", title: "Chi siamo", slug: "chi-siamo", url: "/chi-siamo/" } }))
      .rejects.toMatchObject({ code: "cms-capability-unavailable", message: expect.stringMatching(/^\{#loop main\(\)\}: main\(\) elenca i contenuti di un archivio e vale solo nei template d'archivio/u) });
    await expect(renderCmsPage({ store, projectId: "p", content: content("{#loop main(limit: 3) as item}<p>{item.title}</p>{/loop}"), mainQuery: () => items }))
      .rejects.toMatchObject({ code: "cms-capability-unavailable", message: expect.stringContaining("main() non accetta argomenti") });
  });

  it("il riassunto è la meta description: testo con escape, spazi uniti, al massimo 160 caratteri su una parola", async () => {
    expect(cmsMetaDescription(undefined)).toBe("");
    expect(cmsMetaDescription("   ")).toBe("");
    expect(cmsMetaDescription("Una\n notte\tin  galleria.")).toBe("Una notte in galleria.");
    const exact = "a".repeat(CMS_META_DESCRIPTION_MAX);
    expect(cmsMetaDescription(exact)).toBe(exact);
    const words = `${"parola ".repeat(30)}fine`;
    const cut = cmsMetaDescription(words);
    expect(Array.from(cut).length).toBeLessThanOrEqual(CMS_META_DESCRIPTION_MAX);
    expect(cut).toMatch(/^parola( parola)*…$/u);
    // A word longer than half the limit is cut where the limit falls, never dropped whole.
    expect(Array.from(cmsMetaDescription(`breve ${"x".repeat(300)}`)).length).toBe(CMS_META_DESCRIPTION_MAX);
    // Characters outside the BMP count as one and are never split.
    expect(cmsMetaDescription("🎨".repeat(200))).toBe(`${"🎨".repeat(CMS_META_DESCRIPTION_MAX - 1)}…`);

    const store = await newStore();
    const page = { id: "x", title: "Articolo", slug: "a", url: "/blog/a/", excerpt: 'Un "racconto" <breve> & \'sincero\'' };
    const rendered = await renderCmsPage({ store, projectId: "p", content: content("<p>Testo</p>"), page });
    // Before: no description in the head at all.
    expect(rendered.html).toContain('<title>Articolo</title><meta name="description" content="Un &quot;racconto&quot; &lt;breve&gt; &amp; &#39;sincero&#39;"><style>');
    const withoutExcerpt = await renderCmsPage({ store, projectId: "p", content: content("<p>Testo</p>"), page: { id: "x", title: "Pagina", slug: "p", url: "/p/" } });
    expect(withoutExcerpt.html).not.toContain('name="description"');
  });
});

const fixture = () => readFile(new URL("fixtures/prototipo-esempio.html", import.meta.url), "utf8");

async function refusal(html: string): Promise<PrototypeError> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cms-main-import-"));
  roots.push(root);
  const error = await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(root)).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(PrototypeError);
  return error as PrototypeError;
}

describe("main() nel prototipo: solo nei template d'archivio, senza argomenti", () => {
  it("il controllo accetta main() in un template d'archivio e lo rifiuta altrove, ognuno con il suo motivo", async () => {
    const html = (await fixture())
      // The archive role's template: accepted.
      .replace("{#loop opere_recenti() as opera}", "{#loop main() as opera}")
      // A page, a component, a template of a singular role, and arguments: refused, each with its reason.
      .replace("<p>Quadretti, libri, racconti.</p>", "<p>Quadretti, libri, racconti.</p>{#loop main() as x}<p>{x.title}</p>{/loop}")
      .replace("{@slot media}<h3>", "{@slot media}{#loop main() as x}<span>{x.title}</span>{/loop}<h3>")
      .replace("<article><h1>{page.title}</h1>{@slot}</article>", "<article><h1>{page.title}</h1>{#loop main() as x}<p>{x.title}</p>{/loop}{@slot}</article>")
      .replace("<main><h1>Pagina non trovata</h1>{@slot}</main>", "<main><h1>Pagina non trovata</h1>{#loop main(limit: 3) as x}<p>{x.title}</p>{/loop}{@slot}</main>");
    const error = await refusal(html);
    const byDocument = Object.fromEntries(error.issues.map((issue) => [issue.document, issue.message]));
    // Before: every main() was «la query main non è fra quelle dei contenuti», the archive's too.
    expect(Object.keys(byDocument).sort()).toEqual(["component card-opera", "page home", "template site/non-trovato", "template site/single"]);
    expect(byDocument["page home"]).toBe("{#loop main()}: main() elenca i contenuti di un archivio e vale solo nei template d'archivio, non in una pagina: qui usa una query dichiarata in queries.");
    expect(byDocument["component card-opera"]).toMatch(/^\{#loop main\(\)\}: main\(\) vale solo nei template d'archivio, non in un componente/u);
    expect(byDocument["template site/single"]).toMatch(/^\{#loop main\(\)\}: main\(\) elenca i contenuti di un archivio, e il ruolo single non è un archivio: usalo in un template con ruolo archive, category, tag o home, o nell'archiveTemplate di un tipo\.$/u);
    expect(byDocument["template site/non-trovato"]).toMatch(/^\{#loop main\(\)\}: main\(\) non accetta argomenti/u);
    expect(error.issues.every((issue) => typeof issue.line === "number")).toBe(true);
  });
});
