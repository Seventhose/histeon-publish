import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, parseXb, serializeXb } from "../.generated/histos-dsl/index.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { renderCmsPage } from "../src/static-renderer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cms-components-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  const created = await catalog.createProject("Runtime componenti");
  return { ...created, catalog };
}

describe("runtime CMS M2 per componenti Histeon", () => {
  it("nell'HTML libero ferma un campo password e un modulo che invia a un altro sito, non i moduli del builder", async () => {
    const { project, store } = await newStore();
    try {
      const raw = (content: string) => serializeXb([{ name: "xb/raw", attrs: { uid: "freehtml0001", content } }]);
      for (const content of [
        '<form action="/accesso/" method="post"><input type="password" name="p"></form>',
        '<form action="/accesso/" method="post"><input type=" PassWord " name="p"></form>',
        '<p>Accedi</p><input type="password">',
      ]) await expect(renderCmsPage({ store, projectId: project.id, content: raw(content) })).rejects.toThrow(/campo password/u);
      for (const action of ["https://raccolta.example/c", "HTTPS://raccolta.example/c", "//raccolta.example/c", "\\\\raccolta.example/c", "\thttps://raccolta.example/c"]) {
        await expect(renderCmsPage({ store, projectId: project.id, content: raw(`<form action="${action}" method="post"><input name="email"></form>`) })).rejects.toThrow(/invia i dati a un altro sito|endpoint del modulo/u);
      }
      // The plain HTTPS case is this rule's own (the endpoint check alone accepts it).
      await expect(renderCmsPage({ store, projectId: project.id, content: raw('<form action="https://raccolta.example/c" method="post"><input name="email"></form>') })).rejects.toThrow(/invia i dati a un altro sito/u);
      // What stays free: a site path, text fields, and the builder's own form with a declared HTTPS endpoint.
      const local = await renderCmsPage({ store, projectId: project.id, content: raw('<form action="/cerca/" method="get"><input type="search" name="q"></form>') });
      expect(local.html).toContain('<form action="/cerca/" method="get">');
      const structured = await renderCmsPage({ store, projectId: project.id, content: serializeXb(parse('<form action="https://servizio.example/invia" method="post"><input type="email" name="email"></form>').blocks) });
      expect(structured.html).toContain('<form action="https://servizio.example/invia" method="post">');
    } finally {
      store.close();
    }
  });

  it("renderizza HTML grezzo e blocchi WordPress statici con una allowlist sicura", async () => {
    const { project, store } = await newStore();
    const raw = serializeXb([{ name: "xb/raw", attrs: { uid: "raw00000001", content: '<article class="card"><p>Testo &amp; <strong>markup</strong></p><img src="/immagini/a.jpg" srcset="/immagini/a-small.jpg 1x, /immagini/a-large.jpg 2x" alt="Foto"></article>' } }]);
    const rendered = await renderCmsPage({ store, projectId: project.id, content: raw });
    expect(rendered.html).toContain('<article class="card"><p>Testo &amp; <strong>markup</strong></p><img src="/immagini/a.jpg" srcset="/immagini/a-small.jpg 1x, /immagini/a-large.jpg 2x" alt="Foto"></article>');

    const core = serializeXb(parseXb('<!-- wp:paragraph {"className":"wp-block-paragraph"} --><p class="wp-block-paragraph">Blocco <em>statico</em></p><!-- /wp:paragraph -->').blocks);
    const coreRendered = await renderCmsPage({ store, projectId: project.id, content: core });
    expect(coreRendered.html).toContain('<p class="wp-block-paragraph">Blocco <em>statico</em></p>');

    const staticForm = serializeXb(parse('<form><label for="message">Messaggio</label><textarea id="message" rows="4">Testo</textarea><input type="email" required></form>').blocks);
    const staticFormRendered = await renderCmsPage({ store, projectId: project.id, content: staticForm });
    expect(staticFormRendered.html).toContain('<form><label for="message">Messaggio</label><textarea id="message" rows="4">Testo</textarea><input type="email" required></form>');
    const formAction = serializeXb(parse('<form action="https://example.test/submit"><textarea>Testo</textarea></form>').blocks);
    const previewForm = await renderCmsPage({ store, projectId: project.id, content: formAction });
    expect(previewForm.html).toContain('<form action="https://example.test/submit">');
    expect(previewForm.formCount).toBe(1);
    await expect(renderCmsPage({ store, projectId: project.id, content: formAction, requireFormEndpoints: true })).rejects.toThrow(/scegli GET o POST/u);

    const configuredForm = serializeXb(parse('<form action="/api/contact" method="post"><label for="email">Email</label><input id="email" name="email" type="email" required><button type="submit">Invia</button></form>').blocks);
    const compiledForm = await renderCmsPage({ store, projectId: project.id, content: configuredForm, requireFormEndpoints: true });
    expect(compiledForm.html).toContain('<form action="/api/contact" method="post">');
    expect(compiledForm.formCount).toBe(1);

    for (const action of ["http://example.test/contact", "https:example.test/contact", "//example.test/contact", "javascript:alert(1)", "https://user:secret@example.test/contact", "https://example.test/contact#thanks", "https://example.test/contact\u0001", "https://example.test/contact\u0085"]) {
      const unsafe = serializeXb(parse(`<form action="${action}" method="post"><button type="submit">Invia</button></form>`).blocks);
      await expect(renderCmsPage({ store, projectId: project.id, content: unsafe, requireFormEndpoints: true })).rejects.toThrow(/endpoint del modulo/i);
    }
    const invalidMethod = serializeXb(parse('<form action="/api/contact" method="dialog"><button type="submit">Invia</button></form>').blocks);
    await expect(renderCmsPage({ store, projectId: project.id, content: invalidMethod, requireFormEndpoints: true })).rejects.toThrow(/metodo del modulo deve essere GET o POST/u);
    const missingAction = serializeXb(parse('<form method="post"><button type="submit">Invia</button></form>').blocks);
    await expect(renderCmsPage({ store, projectId: project.id, content: missingAction, requireFormEndpoints: true })).rejects.toThrow(/imposta l’endpoint del modulo/u);
    const actionOnDiv = serializeXb(parse('<div action="/api/contact">No</div>').blocks);
    await expect(renderCmsPage({ store, projectId: project.id, content: actionOnDiv })).rejects.toThrow(/action è ammesso soltanto su <form>/u);

    const activeMarkup = (content: string) => serializeXb([{ name: "xb/raw", attrs: { uid: "raw00000002", content } }]);
    // Free HTML that sends a form to another site stops the build (2026-10-28): the builder's own form keeps its HTTPS endpoint.
    await expect(renderCmsPage({ store, projectId: project.id, content: activeMarkup('<form action="https://forms.example/submit" method="post"><input name="email"></form>'), requireFormEndpoints: true })).rejects.toThrow(/invia i dati a un altro sito/u);
    const rawForm = await renderCmsPage({ store, projectId: project.id, content: activeMarkup('<form action="/iscriviti/" method="post"><input name="email"></form>'), requireFormEndpoints: true });
    expect(rawForm.formCount).toBe(1);
    expect(rawForm.html).toContain('<form action="/iscriviti/" method="post">');
    await expect(renderCmsPage({ store, projectId: project.id, content: activeMarkup('<form method="post"><input name="email"></form>'), requireFormEndpoints: true })).rejects.toThrow(/imposta l’endpoint del modulo/u);
    await expect(renderCmsPage({ store, projectId: project.id, content: activeMarkup('<script>alert(1)</script>') })).rejects.toThrow(/elemento <script> non supportato/u);
    await expect(renderCmsPage({ store, projectId: project.id, content: activeMarkup('<p onclick="alert(1)">Click</p>') })).rejects.toThrow(/attributo onclick non supportato/u);
    await expect(renderCmsPage({ store, projectId: project.id, content: activeMarkup('<img srcset="javascript:alert(1) 1x" alt="x">') })).rejects.toThrow(/URL attivo non supportato/u);
    await expect(renderCmsPage({ store, projectId: project.id, content: activeMarkup('<div style="background:u\\72l(https://example.test/x)">x</div>') })).rejects.toThrow(/comportamento attivo/u);
    const malformed = await renderCmsPage({ store, projectId: project.id, content: activeMarkup("<p>Uno<p>Due") });
    expect(malformed.html.split("<body>")[1]?.split("</body>")[0]).toBe("<p>Uno</p><p>Due</p>");
    await expect(renderCmsPage({ store, projectId: project.id, content: activeMarkup('<p>Testo<img src=/ok onerror=alert(1)></p>') })).rejects.toThrow(/attributo onerror non supportato/u);
    const dynamic = serializeXb(parseXb('<!-- wp:shortcode --><p>[contact-form]</p><!-- /wp:shortcode -->').blocks);
    await expect(renderCmsPage({ store, projectId: project.id, content: dynamic })).rejects.toThrow(/core\/shortcode è dinamico/u);
    store.close();
  });

  it("controlla gli attributi come li legge il browser: entità, tab e a capo non aggirano i controlli", async () => {
    const { project, store } = await newStore();
    const element = (tag: string, attributes: Record<string, string>) => serializeXb([{ name: "xb/element", attrs: { uid: "attr00000001", tag, attributes }, children: [{ name: "xb/text", attrs: { uid: "attr00000002", content: "Vai" } }] }]);
    const raw = (content: string) => serializeXb([{ name: "xb/raw", attrs: { uid: "attr00000003", content } }]);
    for (const href of ["javascript&colon;alert(1)", "java&Tab;script:alert(1)", "java&NewLine;script:alert(1)", "&#106;avascript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)"]) {
      await expect(renderCmsPage({ store, projectId: project.id, content: element("a", { href }) }), href).rejects.toThrow(/URL attivo non supportato/u);
    }
    for (const action of ["javascript&colon;alert(1)", "java&Tab;script:alert(1)", "https:///evil.example/x", "/invio\u00a0segreto"]) {
      await expect(renderCmsPage({ store, projectId: project.id, content: element("form", { action, method: "post" }) }), action).rejects.toThrow(/endpoint del modulo/u);
    }
    // A query string keeps its &, escaped once on the way out.
    const query = await renderCmsPage({ store, projectId: project.id, content: element("form", { action: "/invio?a=1&amp;b=2", method: "post" }) });
    expect(query.html).toContain('<form action="/invio?a=1&amp;b=2" method="post">');
    // parse5 has already decoded a fragment once: what is left is literal text, never a second, live entity.
    const fragment = await renderCmsPage({ store, projectId: project.id, content: raw('<form action="javascript&amp;colon;alert(1)" method="post"><input name="q"></form>') });
    expect(fragment.html).toContain('action="javascript&amp;colon;alert(1)"');
    expect(fragment.html).not.toContain('action="javascript&colon;');
    await expect(renderCmsPage({ store, projectId: project.id, content: raw('<a href="javascript&colon;alert(1)">x</a>') })).rejects.toThrow(/URL attivo non supportato/u);
    await expect(renderCmsPage({ store, projectId: project.id, content: element("form", { METHOD: "dialog", method: "post", action: "/invio" }) })).rejects.toThrow(/compare più volte/u);
    await expect(renderCmsPage({ store, projectId: project.id, content: raw('<form action="/invio" method="post"><button formmethod="dialog">Invia</button></form>') })).rejects.toThrow(/attributo formmethod non supportato/u);
    store.close();
  });

  it("converte i riferimenti media locali in raw, srcset ed elementi Histeon durante il build", async () => {
    const { project, store } = await newStore();
    const asset = store.saveAsset({ bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png", filename: "foto.png", alt: "Foto" });
    const reference = `/__cms-media/${project.id}/${asset.id}`;
    const content = serializeXb([
      ...parse(`<img src="${reference}" alt="Elemento"><picture><img src="${reference}" srcset="${reference} 1x, ${reference} 2x" alt="Elemento"></picture>`).blocks,
      { name: "xb/raw", attrs: { uid: "rawmedia0001", content: `<img src="${reference}" alt="Raw">` } },
    ]);
    const buildMediaDirectory = path.join(project.directory, "build-media");
    const rendered = await renderCmsPage({ store, projectId: project.id, content, buildMediaDirectory });
    const imageUrl = `/media/${asset.sha256}.png`;
    expect(rendered.html.match(new RegExp(imageUrl.replaceAll("/", "\\/"), "gu"))).toHaveLength(5);
    expect(rendered.assets.map(({ id }) => id)).toEqual([asset.id]);
    expect(await readdir(buildMediaDirectory)).toEqual([`${asset.sha256}.png`]);
    expect([...(await readFile(path.join(buildMediaDirectory, `${asset.sha256}.png`)))]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    store.close();
  });

  it("renderizza campi pubblici e media di una relazione CMS annidata nei loop statici", async () => {
    const { project, store } = await newStore();
    // An Italian project on any computer: the records below are saved without a locale and rendered it-IT.
    store.setRenderSettings({ ...store.getRenderSettings(), locale: "it-IT" });
    store.content.saveType({ key: "writer", label: "Autore", expectedHead: null, fields: [
      { key: "bio", label: "Biografia", type: "text", public: true },
      { key: "photo", label: "Foto", type: "asset", public: true },
    ] });
    store.content.saveType({ key: "article", label: "Articolo", expectedHead: null, fields: [
      { key: "author", label: "Autore", type: "relation", targetType: "writer", public: true },
    ] });
    const image = store.saveAsset({ bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png", filename: "autore.png", alt: "Ritratto" });
    const writer = store.content.createRecord({ typeKey: "writer", title: "Autrice", status: "published", values: { bio: "Biografia leggibile nel loop", photo: image.id } });
    if (writer.status !== "saved") throw new Error("Il record autore avrebbe dovuto essere salvato.");
    store.content.createRecord({ typeKey: "article", title: "Articolo CMS", status: "published", values: { author: writer.record.id } });
    store.content.saveQueryPreset({ key: "articles_with_writer", label: "Articoli con autore", typeKey: "article", limit: 10, expectedHead: null });
    const content = serializeXb([{
      name: "xb/loop",
      attrs: { uid: "nestedrel0001", as: "item", source: { kind: "preset", id: "articles_with_writer" } },
      children: parse(`<p>{item.fields.author.fields.bio}</p><img src="{item.fields.author.fields.photo}" alt="Autore">`).blocks,
    }]);
    const buildMediaDirectory = path.join(project.directory, "nested-relation-media");

    const rendered = await renderCmsPage({ store, projectId: project.id, content, buildMediaDirectory, locale: "it-IT" });

    expect(rendered.html).toContain("<p>Biografia leggibile nel loop</p>");
    expect(rendered.html).toContain(`<img src="/media/${image.sha256}.png" alt="Autore">`);
    expect(rendered.assets.map(({ id }) => id)).toEqual([image.id]);
    expect(await readdir(buildMediaDirectory)).toEqual([`${image.sha256}.png`]);
    store.close();
  });

  it("blocca preview e build se un foglio CSS usa un file locale non collegato", async () => {
    const { project, store } = await newStore();
    const styles = store.getStyles();
    if (!styles) throw new Error("Gli stili del progetto non sono inizializzati.");
    const head = store.getHead(styles.id);
    if (!head) throw new Error("La revisione degli stili non è inizializzata.");
    store.saveDocument({ entityId: styles.id, expectedHead: head.id, content: JSON.stringify({ styles: [], globals: [{ id: "framework-core", css: "@font-face{src:url(../fonts/brand.woff2)}", source: { kind: "user-css", frameworkId: "core-framework", name: "Core Framework", rightsConfirmed: true } }], compiledCss: "" }) });
    await expect(renderCmsPage({ store, projectId: project.id, content: "" })).rejects.toThrow(/Core Framework.*\.\.\/fonts\/brand\.woff2.*non è ancora incluso/u);
    store.close();
  });

  it("pubblica i font locali collegati al CSS e conserva la query nell'URL", async () => {
    const { project, store } = await newStore();
    const font = store.saveAsset({ bytes: new Uint8Array([119, 79, 70, 50, 0, 0]), mimeType: "font/woff2", filename: "brand.woff2" });
    const styles = store.getStyles();
    if (!styles) throw new Error("Gli stili del progetto non sono inizializzati.");
    const head = store.getHead(styles.id);
    if (!head) throw new Error("La revisione degli stili non è inizializzata.");
    const css = "@font-face{font-family:Brand;src:url('../fonts/brand.woff2?v=3#latin')}";
    const assets = [{ reference: "../fonts/brand.woff2?v=3#latin", assetId: font.id }];
    store.saveDocument({ entityId: styles.id, expectedHead: head.id, content: JSON.stringify({ styles: [], globals: [{ id: "framework-fonts", css, source: { kind: "user-css", frameworkId: "custom", name: "Font del progetto", rightsConfirmed: true }, assets }], compiledCss: "" }) });

    const preview = await renderCmsPage({ store, projectId: project.id, content: "", mediaBase: "/__cms-media" });
    expect(preview.html).toContain(`/__cms-media/${project.id}/${font.id}?v=3#latin`);
    expect(preview.assets.map((asset) => asset.id)).toContain(font.id);

    const buildMediaDirectory = path.join(project.directory, "build-media-fonts");
    const built = await renderCmsPage({ store, projectId: project.id, content: "", buildMediaDirectory });
    expect(built.html).toContain(`/media/${font.sha256}.woff2?v=3#latin`);
    expect([...(await readFile(path.join(buildMediaDirectory, `${font.sha256}.woff2`)))]).toEqual([119, 79, 70, 50, 0, 0]);
    store.close();
  });

  it("pubblica le immagini locali collegate al CSS di un selettore", async () => {
    const { project, store } = await newStore();
    const image = store.saveAsset({ bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png", filename: "brand.png" });
    const styles = store.getStyles();
    if (!styles) throw new Error("Gli stili del progetto non sono inizializzati.");
    const head = store.getHead(styles.id);
    if (!head) throw new Error("La revisione degli stili non è inizializzata.");
    const css = "background-image:url('../images/brand.png?v=2')";
    store.saveDocument({ entityId: styles.id, expectedHead: head.id, content: JSON.stringify({ styles: [{ id: "brand", selector: ".brand", css, assets: [{ reference: "../images/brand.png?v=2", assetId: image.id }] }], globals: [], compiledCss: "" }) });

    const preview = await renderCmsPage({ store, projectId: project.id, content: "", mediaBase: "/__cms-media" });
    expect(preview.styleCss).toContain(`/__cms-media/${project.id}/${image.id}?v=2`);
    expect(preview.assets.map((asset) => asset.id)).toContain(image.id);

    const buildMediaDirectory = path.join(project.directory, "build-media-selector-fonts");
    const built = await renderCmsPage({ store, projectId: project.id, content: "", buildMediaDirectory });
    expect(built.styleCss).toContain(`/media/${image.sha256}.png?v=2`);
    expect([...(await readFile(path.join(buildMediaDirectory, `${image.sha256}.png`)))]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    store.close();
  });

  it("risolve il contenuto corrente dentro i template Histeon e impedisce la ricorsione", async () => {
    const { project, store } = await newStore();
    const template = store.createTemplate({ ref: "site/content-template", title: "Template contenuto", content: serializeXb(parse("<main>{@slot}{@content}</main>").blocks) });
    const page = store.listPages()[0]!;
    const pageContent = serializeXb(parse("<article>Corpo della pagina</article>{@content}").blocks);
    store.updatePageMetadata(page.id, { title: "Pagina", slug: "pagina", status: "published", templateRef: template.ref });
    const rendered = await renderCmsPage({ store, projectId: project.id, content: pageContent, templateRef: template.ref, page: { id: page.id, title: "Pagina", slug: "pagina", url: "/pagina/" } });
    expect(rendered.html).toContain("<main><article>Corpo della pagina</article><article>Corpo della pagina</article></main>");
    expect(rendered.html).not.toContain("{@content}");
    store.close();
  });

  it("url.path è il percorso della pagina costruita, anche dentro la testata del template (voce 189)", async () => {
    const { project, store } = await newStore();
    store.createComponent({ ref: "site/menu", title: "Menu", content: serializeXb(parse('<nav>{#if url.path == "/festival/"}<a aria-current="page">Festival</a>{:else}<a>Festival</a>{/if} {url.path}</nav>').blocks), schema: { props: {} } });
    const template = store.createTemplate({ ref: "site/con-menu", title: "Con menu", content: serializeXb([{ name: "xb/component", attrs: { uid: "menu00000001", ref: "site/menu", props: {} }, children: [] }, ...parse("<main>{@slot}</main>").blocks] as Parameters<typeof serializeXb>[0]) });
    const page = store.listPages()[0]!;
    store.updatePageMetadata(page.id, { title: "Festival", slug: "festival", status: "published", templateRef: template.ref });
    const render = (url: string) => renderCmsPage({ store, projectId: project.id, content: serializeXb(parse("<p>{url.path}</p>").blocks), templateRef: template.ref, page: { id: page.id, title: "Festival", slug: "festival", url } });
    const active = await render("/festival/");
    expect(active.html).toContain('<a aria-current="page">Festival</a> /festival/');
    expect(active.html).toContain("<p>/festival/</p>");
    const other = await render("/annata/2015/page/2/");
    expect(other.html).toContain("<a>Festival</a> /annata/2015/page/2/");
    expect((await render("https://esempio.it/blog/?x=1")).html).toContain("<p>/blog/</p>");
    store.close();
  });

  it("un loop a gruppi sul risultato di una query fa una query sola e ripete i gruppi {key, items} (voce 187)", async () => {
    const { project, store } = await newStore();
    store.content.saveType({ key: "foto", label: "Foto", expectedHead: null, fields: [] });
    store.content.saveQueryPreset({ key: "foto_recenti", label: "Foto recenti", typeKey: "foto", limit: 20, expectedHead: null });
    const rows = [
      { title: "Mare", date: "2025-08-01T10:00:00Z", fields: { autore: "Bruno" } },
      { title: "Neve", date: "2025-01-10T10:00:00Z", fields: { autore: "anna" } },
      { title: "Fiume", date: "2024-05-02T10:00:00Z", fields: { autore: "Bruno" } },
      { title: "9 vite", date: "2023-03-03T10:00:00Z", fields: { autore: "Carla" } },
    ];
    const calls: Array<Record<string, unknown>> = [];
    const resolveQuery = (_id: string, args: Record<string, unknown>) => {
      calls.push(args);
      return rows.slice(0, typeof args.limit === "number" ? args.limit : rows.length);
    };
    const body = (rendered: { html: string }) => /<body>(.*)<\/body>/su.exec(rendered.html)?.[1];
    const render = (source: string) => renderCmsPage({ store, projectId: project.id, content: serializeXb(parse(source).blocks), timeZone: "Europe/Rome", resolveQuery });
    const byYear = await render('<main>{#loop foto_recenti(limit: 20).groupBy("date", "Y") as anno, i}<h2>{i}:{anno.key} ({anno.items.length()})</h2>{#loop anno.items as f}<p>{f.title}</p>{/loop}{/loop}</main>');
    expect(body(byYear)).toBe("<main><h2>0:2025 (2)</h2><p>Mare</p><p>Neve</p><h2>1:2024 (1)</h2><p>Fiume</p><h2>2:2023 (1)</h2><p>9 vite</p></main>");
    expect(calls).toEqual([{ limit: 20 }]);
    const byLetter = await render('<ul>{#loop foto_recenti(limit: 3).groupBy("title", "letter") as l}<li>{l.key}:{l.items.pluck("title").join("+")}</li>{/loop}</ul>');
    expect(body(byLetter)).toBe("<ul><li>M:Mare</li><li>N:Neve</li><li>F:Fiume</li></ul>");
    const byField = await render('<ul>{#loop foto_recenti().groupBy("fields.autore") as a}<li>{a.key}={a.items.length()}</li>{:else}<li>niente</li>{/loop}</ul>');
    expect(body(byField)).toBe("<ul><li>Bruno=2</li><li>anna=1</li><li>Carla=1</li></ul>");
    // The same groups as the groupBy modifier on a written list: the group shape is the modifier's.
    const written = await render(`<ul>{#loop ${JSON.stringify(rows)}.groupBy("fields.autore") as a}<li>{a.key}={a.items.length()}</li>{/loop}</ul>`.replace(/"([a-z]+)":/gu, "$1:"));
    expect(body(written)).toBe(body(byField));
    const none = await renderCmsPage({ store, projectId: project.id, content: serializeXb(parse('<ul>{#loop foto_recenti().groupBy("date", "Y") as a}<li>{a.key}</li>{:else}<li>niente</li>{/loop}</ul>').blocks), resolveQuery: () => [] });
    expect(body(none)).toBe("<ul><li>niente</li></ul>");
    store.close();
  });

  it("solo per la tela dell'editor segna ogni elemento con il suo uid, e dentro un componente con quello dell'istanza", async () => {
    const { project, store } = await newStore();
    store.createComponent({ ref: "ui/badge", title: "Badge", content: serializeXb(parse("<div><p>{props.label}</p></div>").blocks), schema: { props: { label: { type: "string", default: "x" } } } });
    const content = serializeXb([
      { name: "xb/element", attrs: { uid: "sezione00001", tag: "section" }, children: [
        { name: "xb/element", attrs: { uid: "titolo000001", tag: "h1" }, children: [{ name: "xb/text", attrs: { uid: "testo0000001", content: "Ciao" } }] },
        { name: "xb/element", attrs: { uid: "immagine0001", tag: "img", attributes: { src: "/foto.webp", alt: "Foto" } }, children: [] },
        { name: "xb/component", attrs: { uid: "istanza00001", ref: "ui/badge", props: { label: "Nuovo" } }, children: [] },
        { name: "xb/loop", attrs: { uid: "loop00000001", source: { expr: "[1, 2]" }, as: "n" }, children: [{ name: "xb/element", attrs: { uid: "voce00000001", tag: "p" }, children: [{ name: "xb/text", attrs: { uid: "testo0000002", content: "{n}" } }] }] },
      ] },
    ] as Parameters<typeof serializeXb>[0]);
    const canvas = await renderCmsPage({ store, projectId: project.id, content, annotate: true });
    expect(canvas.html).toContain('<section data-xb-uid="sezione00001"><h1 data-xb-uid="titolo000001">Ciao</h1>');
    expect(canvas.html).toContain('alt="Foto" data-xb-uid="immagine0001">');
    expect(canvas.html, "a click inside a component selects its instance").toContain('<div data-xb-uid="istanza00001"><p data-xb-uid="istanza00001">Nuovo</p></div>');
    expect(canvas.html.match(/data-xb-uid="voce00000001"/gu), "each item of a loop is the same block").toHaveLength(2);
    const build = await renderCmsPage({ store, projectId: project.id, content });
    expect(build.html, "a page that gets built or published never carries the builder's annotation").not.toContain("data-xb-uid");
  });

  it("renderizza componenti upstream con props letterali, markup inline, condizioni e slot", async () => {
    const { project, store } = await newStore();
    const component = store.createComponent({
      ref: "ui/card",
      title: "Card",
      content: serializeXb(parse('<section><h2>{props.title}</h2><p>Testo <strong>in evidenza</strong> — {props.count}; <a href="https://example.test" target="_blank" rel="noopener">link</a> <time datetime="2026-10-23">oggi</time></p>{#if props.showFooter}<footer>{@slot footer}</footer>{/if}<div>{@slot}</div></section>').blocks),
      schema: { props: {
        title: { type: "string", default: "Predefinito" },
        count: { type: "number", default: 1 },
        showFooter: { type: "boolean", default: false },
      } },
    });
    const page = serializeXb(parse('<Ui.Card title="A & B" count={4} showFooter><p>Corpo</p>{#slot footer}<small>Piede</small>{/slot}</Ui.Card>').blocks);
    const rendered = await renderCmsPage({ store, projectId: project.id, content: page });
    expect(rendered.html).toContain("<h2>A &amp; B</h2>");
    expect(rendered.html).toContain("Testo <strong>in evidenza</strong> — 4");
    expect(rendered.html).toContain('<a href="https://example.test" target="_blank" rel="noopener">link</a>');
    expect(rendered.html).toContain('<time datetime="2026-10-23">oggi</time>');
    expect(rendered.html).toContain("<footer><small>Piede</small></footer>");
    expect(rendered.html).toContain("<div><p>Corpo</p></div>");

    const rootPreview = await renderCmsPage({ store, projectId: project.id, content: component.content, rootComponentAlias: component.alias });
    expect(rootPreview.html).toContain("<h2>Predefinito</h2>");
    expect(rootPreview.html).not.toContain("<footer>");
    store.close();
  });

  it("applica il limite PHP di 16 componenti annidati", async () => {
    const { project, store } = await newStore();
    const chain = (count: number) => {
      let childRef: string | null = null;
      for (let index = count - 1; index >= 0; index--) {
        const ref = `depth/c${count}-node-n${index}`;
        const content = childRef
          ? serializeXb([{ name: "xb/component", attrs: { uid: `depth${String(index).padStart(6, "0")}`, ref: childRef }, children: [] }])
          : serializeXb(parse("<p>Limite rispettato</p>").blocks);
        store.createComponent({ ref, title: `Livello ${index}`, content, schema: { props: {} } });
        childRef = ref;
      }
      return serializeXb([{ name: "xb/component", attrs: { uid: `root${String(count).padStart(6, "0")}`, ref: childRef! }, children: [] }]);
    };

    const sixteen = await renderCmsPage({ store, projectId: project.id, content: chain(16) });
    expect(sixteen.html).toContain("Limite rispettato");
    await expect(renderCmsPage({ store, projectId: project.id, content: chain(17) })).rejects.toThrow(/profondità massima di 16/u);
    store.close();
  });

  it("ammette condizioni con soli literal fuori dai componenti e rifiuta espressioni con scope mancante", async () => {
    const { project, store } = await newStore();
    const literal = serializeXb(parse("{#if true}<strong>Visibile</strong>{:else}<em>No</em>{/if}").blocks);
    const rendered = await renderCmsPage({ store, projectId: project.id, content: literal });
    expect(rendered.html).toContain("<strong>Visibile</strong>");
    expect(rendered.html).not.toContain("<em>No</em>");
    const dynamic = serializeXb(parse("<p>{props.title}</p>").blocks);
    await expect(renderCmsPage({ store, projectId: project.id, content: dynamic })).rejects.toThrow(/espressione senza scope/u);
    store.close();
  });

  it("esegue loop locali, scope annidato, props dinamiche e modifier senza eval", async () => {
    const { project, store } = await newStore();
    const list = store.createComponent({
      ref: "ui/list",
      title: "List",
      schema: { props: {
        items: { type: "array", default: [] },
        title: { type: "string", default: "voci" },
      } },
      content: serializeXb(parse('<section><h2>{props.title.upper()}</h2><ul>{#loop props.items as item, idx}<li data-index={idx} class={item.active ? "attivo" : "normale"}>{item.name.capitalize()} — {item.tags.join(", ")}</li>{/loop}</ul>{#if slots.default.empty}<p>Nessun contenuto aggiuntivo</p>{:else}{@slot}{/if}</section>').blocks),
    });
    const wrapper = store.createComponent({
      ref: "ui/wrapper",
      title: "Wrapper",
      schema: { props: {
        heading: { type: "string", default: "elenco" },
        cards: { type: "array", default: [
          { name: "prima", active: true, tags: ["uno", "due"] },
          { name: "seconda", active: false, tags: ["tre"] },
        ] },
      } },
      content: serializeXb(parse('<Ui.List title={props.heading} items={props.cards}/>').blocks),
    });
    const rendered = await renderCmsPage({ store, projectId: project.id, content: wrapper.content, rootComponentAlias: wrapper.alias });
    expect(rendered.html).toContain("<h2>ELENCO</h2>");
    expect(rendered.html).toContain('<li data-index="0" class="attivo">Prima — uno, due</li>');
    expect(rendered.html).toContain('<li data-index="1" class="normale">Seconda — tre</li>');
    expect(rendered.html).toContain("<p>Nessun contenuto aggiuntivo</p>");
    expect(list.alias).toBeGreaterThanOrEqual(1_000_000_000);
    store.close();
  });

  it("applica sei livelli e mille elementi come limiti massimi dei loop locali", async () => {
    const { project, store } = await newStore();
    const nestedLoop = (depth: number) => {
      let content = "<p>Limite rispettato</p>";
      for (let index = 0; index < depth; index++) content = `{#loop [1] as item${index}}${content}{/loop}`;
      return serializeXb(parse(content).blocks);
    };

    const sixLevels = await renderCmsPage({ store, projectId: project.id, content: nestedLoop(6) });
    expect(sixLevels.html).toContain("Limite rispettato");
    await expect(renderCmsPage({ store, projectId: project.id, content: nestedLoop(7) })).rejects.toThrow(/loop annidati superano il limite di 6/u);
    // Loops side by side are not nested: twelve of them, each holding five more levels, all render (doc 23 item 116).
    const sideBySide = serializeXb(parse(Array.from({ length: 12 }, (_, index) => `<section>{#loop [1, 2] as a${index}}{#loop [1] as b}{#loop [1] as c}{#loop [1] as d}{#loop [1] as e}{#loop [1] as f}<i>x</i>{/loop}{/loop}{/loop}{/loop}{/loop}{/loop}</section>`).join("")).blocks);
    expect(((await renderCmsPage({ store, projectId: project.id, content: sideBySide })).html.match(/<i>x<\/i>/gu) ?? []).length).toBe(24);

    store.content.saveType({ key: "loop_item", label: "Elemento", expectedHead: null, fields: [] });
    store.content.saveQueryPreset({ key: "all_items", label: "Tutti gli elementi", typeKey: "loop_item", limit: 1, expectedHead: null });
    const itemLoop = serializeXb([{
      name: "xb/loop",
      attrs: { uid: "limitloop0001", as: "item", source: { kind: "preset", id: "all_items" } },
      children: parse("<i>{item.title}</i>").blocks,
    }]);
    const renderItems = (count: number) => Array.from({ length: count }, (_, index) => ({ title: String(index + 1) }));
    const withinLimit = await renderCmsPage({ store, projectId: project.id, content: itemLoop, resolveQuery: () => renderItems(1000) });
    expect(withinLimit.html.match(/<i>/gu)).toHaveLength(1000);
    expect(withinLimit.html).toContain("<i>1000</i>");
    await expect(renderCmsPage({ store, projectId: project.id, content: itemLoop, resolveQuery: () => renderItems(1001) })).rejects.toThrow(/loop supera il limite di 1\.000 elementi/u);
    store.close();
  });

  it("formatta date e numeri secondo le impostazioni locali passate al renderer", async () => {
    const { project, store } = await newStore();
    const component = store.createComponent({
      ref: "ui/format",
      title: "Format",
      schema: { props: {
        amount: { type: "number", default: 1234.5 },
        when: { type: "string", default: "2026-10-23" },
      } },
      content: serializeXb(parse("<p>{props.amount.number(2)}</p><time>{props.when.date('d/m/Y')}</time>").blocks),
    });
    const rendered = await renderCmsPage({ store, projectId: project.id, content: component.content, rootComponentAlias: component.alias });
    const italian = await renderCmsPage({ store, projectId: project.id, content: component.content, rootComponentAlias: component.alias, locale: "it-IT", timeZone: "Europe/Rome" });
    expect(rendered.html).toContain("<p>1,234.50</p>");
    expect(rendered.html).toContain("<time>23/10/2026</time>");
    expect(italian.html).toContain("<p>1.234,50</p>");
    store.close();
  });

  it("interpreta date locali e transizioni del fuso come il runtime WordPress", async () => {
    const { project, store } = await newStore();
    const component = store.createComponent({
      ref: "ui/dates",
      title: "Date",
      schema: { props: {
        spring: { type: "string", default: "2026-03-29 02:30:00" },
        autumn: { type: "string", default: "2026-10-25 02:30:00" },
        utc: { type: "string", default: "2026-10-23T00:30:00Z" },
      } },
      content: serializeXb(parse("<p>{props.spring.date('Y-m-d H:i P I W z L t')}</p><p>{props.autumn.date('H:i P I')}</p><p>{props.utc.date('Y-m-d H:i P')}</p>").blocks),
    });
    const rendered = await renderCmsPage({ store, projectId: project.id, content: component.content, rootComponentAlias: component.alias, locale: "it-IT", timeZone: "Europe/Rome" });
    expect(rendered.html).toContain("2026-03-29 03:30 +02:00 1 13 87 0 31");
    expect(rendered.html).toContain("02:30 +01:00 0");
    expect(rendered.html).toContain("2026-10-23 02:30 +02:00");
    store.close();
  });

  it("segue la fixture condivisa per i confini di data e i cambi d’ora", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/fixtures/histos-runtime-dates-m2-v1.json", import.meta.url), "utf8")) as {
      locale: string;
      timeZone: string;
      props: Record<string, string>;
      expressions: string[];
      expectedText: string;
    };
    const { project, store } = await newStore();
    const component = store.createComponent({
      ref: "ui/date-boundaries",
      title: "Date di confine",
      schema: { props: Object.fromEntries(Object.entries(fixture.props).map(([key, value]) => [key, { type: "string", default: value }])) },
      content: serializeXb(parse(`<p>{${fixture.expressions.join("}|{")}}</p>`).blocks),
    });
    const rendered = await renderCmsPage({ store, projectId: project.id, content: component.content, rootComponentAlias: component.alias, locale: fixture.locale, timeZone: fixture.timeZone });
    const body = /<body>([\s\S]*)<\/body>/u.exec(rendered.html)?.[1];
    expect(body).toBe(`<p>${fixture.expectedText}</p>`);
    store.close();
  });

  it("mantiene le regole di valore PHP per logica, slice, numeri e array", async () => {
    const { project, store } = await newStore();
    const component = store.createComponent({
      ref: "ui/value-parity",
      title: "Value parity",
      schema: { props: { values: { type: "array", default: [1, 2, 3] }, flag: { type: "boolean", default: true } } },
      content: serializeXb(parse('<p>{[] || "fallback"}|{[] && "fallback"}|{props.values.slice(1, -1).join("|")}|{"uno due tre".truncateWords(2)}|{props.flag.number(0)}|{{"a":1,"b":2} == {"b":2,"a":1}}</p>').blocks),
    });
    const rendered = await renderCmsPage({ store, projectId: project.id, content: component.content, rootComponentAlias: component.alias });
    expect(rendered.html).toContain("true|false|2|uno due…|0|false");
    store.close();
  });

  it("segue la fixture condivisa di rendering PHP/TypeScript per componenti Histeon", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/fixtures/histos-runtime-m2-v1.json", import.meta.url), "utf8")) as {
      locale: string;
      timeZone: string;
      components: Array<{ ref: string; title: string; schema: unknown; content: string }>;
      instance: string;
      expectedBody: string;
    };
    const { project, store } = await newStore();
    for (const component of fixture.components) store.createComponent(component);
    const rendered = await renderCmsPage({ store, projectId: project.id, content: fixture.instance, locale: fixture.locale, timeZone: fixture.timeZone });
    const body = /<body>([\s\S]*)<\/body>/u.exec(rendered.html)?.[1];
    expect(body).toBe(fixture.expectedBody);
    store.close();
  });

  it("segue la fixture condivisa per l’intero registro dei modifier Histeon", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/fixtures/histos-runtime-modifiers-m2-v1.json", import.meta.url), "utf8")) as {
      expressions: string[];
      expectedText: string;
    };
    const { project, store } = await newStore();
    const component = store.createComponent({
      ref: "ui/modifier-parity",
      title: "Modifier parity",
      schema: { props: {} },
      content: serializeXb(parse(`<p>{${fixture.expressions.join("}|{")}}</p>`).blocks),
    });
    const rendered = await renderCmsPage({ store, projectId: project.id, content: component.content, rootComponentAlias: component.alias, locale: "en-US", timeZone: "UTC" });
    const body = /<body>([\s\S]*)<\/body>/u.exec(rendered.html)?.[1];
    expect(body).toBe(`<p>${fixture.expectedText}</p>`);
    store.close();
  });

  it("mantiene la fixture condivisa per HTML grezzo e blocchi WordPress statici", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/fixtures/histos-runtime-static-m2-v1.json", import.meta.url), "utf8")) as { content: string; expectedBody: string };
    const { project, store } = await newStore();
    const rendered = await renderCmsPage({ store, projectId: project.id, content: fixture.content });
    const body = /<body>([\s\S]*)<\/body>/u.exec(rendered.html)?.[1];
    expect(body).toBe(fixture.expectedBody);
    store.close();
  });

  it("segue i vettori di rendering della fixture histos-transfer-markup-v1", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/fixtures/histos-transfer-markup-v1.json", import.meta.url), "utf8")) as { documents: Array<{ name: string; content: string; expectedBody?: string }> };
    const { project, store } = await newStore();
    try {
      const vectors = fixture.documents.filter((vector) => vector.expectedBody !== undefined);
      expect(vectors.length).toBeGreaterThanOrEqual(3);
      for (const vector of vectors) {
        const rendered = await renderCmsPage({ store, projectId: project.id, content: vector.content });
        expect(/<body>([\s\S]*)<\/body>/u.exec(rendered.html)?.[1], vector.name).toBe(vector.expectedBody);
      }
    } finally {
      store.close();
    }
  });

  it("renderizza il sottoinsieme SVG statico con i nomi canonici e rifiuta il resto", async () => {
    const { project, store } = await newStore();
    const render = (source: string) => renderCmsPage({ store, projectId: project.id, content: serializeXb(parse(source).blocks) });
    const svgBlock = (attributes: Record<string, string>, children: Parameters<typeof serializeXb>[0] = []) => serializeXb([{ name: "xb/element", attrs: { uid: "svgraw000001", tag: "svg", attributes }, children }]);
    try {
      const icon = await render('<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" aria-hidden="true"> {#if 1 == 1}<path d="M3 12h18" pathLength="10"/>{/if}</svg>');
      expect(icon.html).toContain('<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" aria-hidden="true"> <path d="M3 12h18" pathLength="10"></path></svg>');
      await expect(render('<svg viewBox="0 0 24 24"><use href="#a"/></svg>')).rejects.toThrow(/<use> non è trasferibile/u);
      await expect(render('<svg viewBox="0 0 24 24"><foreignObject></foreignObject></svg>')).rejects.toThrow(/non è trasferibile/u);
      await expect(render('<svg viewBox="0 0 24 24"><p>Testo</p></svg>')).rejects.toThrow(/solo gli elementi SVG statici/u);
      await expect(render('<svg viewBox="0 0 24 24">Testo</svg>')).rejects.toThrow(/solo in <title>, <desc>, <text> e <tspan>/u);
      await expect(render('<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"></svg>')).rejects.toThrow(/xmlns non è ammesso/u);
      // histos-svg-text-v1: text, gradients, inline style and states are rendered as stored; what loads stays out.
      const drawing = await render('<svg viewBox="0 0 24 24" style="--k:0" data-stato="aperto"><defs><linearGradient id="a" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/></linearGradient></defs><circle r="2" fill="url(#a)"/><text x="1" y="2" text-anchor="middle">Uno <tspan dy="1em">due</tspan> tre</text></svg>');
      expect(drawing.html).toContain('<svg viewBox="0 0 24 24" style="--k:0" data-stato="aperto"><defs><linearGradient id="a" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"></stop></linearGradient></defs><circle r="2" fill="url(#a)"></circle><text x="1" y="2" text-anchor="middle">Uno <tspan dy="1em">due</tspan> tre</text></svg>');
      await expect(render('<svg viewBox="0 0 24 24" style="fill:url(#a)"></svg>')).rejects.toThrow(/carica una risorsa/u);
      await expect(render('<svg viewBox="0 0 24 24"><circle fill="url(https://esempio.test/a.svg#a)"/></svg>')).rejects.toThrow(/fill su <circle> non è ammesso/u);
      await expect(render('<svg viewBox="0 0 24 24"><g><tspan>x</tspan></g></svg>')).rejects.toThrow(/solo dentro <text>/u);
      await expect(render('<svg viewBox="0 0 24 24"><svg viewBox="0 0 1 1"></svg></svg>')).rejects.toThrow(/dentro un altro <svg>/u);
      await expect(render("<path d=\"M0 0\"/>")).rejects.toThrow(/solo dentro <svg>/u);
      await expect(renderCmsPage({ store, projectId: project.id, content: svgBlock({ viewBox: "0 0 24 24" }, [{ name: "xb/raw", attrs: { uid: "svgraw000002", content: "<b>x</b>" } }]) })).rejects.toThrow(/senza HTML, componenti o slot/u);
      await expect(renderCmsPage({ store, projectId: project.id, content: svgBlock({ viewbox: "0 0 24 24" }) })).rejects.toThrow(/viewbox non è ammesso/u);
      // SVG stays out of raw HTML: only the checked block form renders.
      await expect(renderCmsPage({ store, projectId: project.id, content: serializeXb([{ name: "xb/raw", attrs: { uid: "svgraw000003", content: '<svg viewBox="0 0 1 1"></svg>' } }]) })).rejects.toThrow(/nodo non supportato/u);
    } finally {
      store.close();
    }
  });

  it("stampa il testo iniziale di una textarea così com'è, senza valutare espressioni", async () => {
    const { project, store } = await newStore();
    const content = serializeXb(parse('<form action="/invio" method="post"><textarea name="t">{page.title} & <b>x</b></textarea></form>').blocks);
    try {
      for (const page of [undefined, { id: "pagina", title: "Titolo", slug: "home", url: "/" }]) {
        const rendered = await renderCmsPage({ store, projectId: project.id, content, ...(page ? { page } : {}) });
        expect(rendered.html).toContain('<textarea name="t">{page.title} &amp; &lt;b&gt;x&lt;/b&gt;</textarea>');
      }
      const outside = serializeXb([{ name: "xb/element", attrs: { uid: "verbatim0001", tag: "div" }, children: [{ name: "xb/text", attrs: { uid: "verbatim0002", content: "x", verbatim: true } }] }]);
      await expect(renderCmsPage({ store, projectId: project.id, content: outside })).rejects.toThrow(/testo letterale è ammesso solo/u);
    } finally {
      store.close();
    }
  });

  it("rifiuta image-set e le altre funzioni che caricano risorse negli stili in linea", async () => {
    const { project, store } = await newStore();
    const styled = (style: string) => serializeXb([{ name: "xb/element", attrs: { uid: "style0000001", tag: "div", attributes: { style } }, children: [] }]);
    try {
      for (const style of ["background-image: image-set('a.png' 1x)", "background: -webkit-image-set('a.png' 1x)", "background: cross-fade(a, b)", "background: &#117;rl(x.png)"]) {
        await expect(renderCmsPage({ store, projectId: project.id, content: styled(style) }), style).rejects.toThrow(/comportamento attivo/u);
      }
      expect((await renderCmsPage({ store, projectId: project.id, content: styled("color: var(--xb-primary)") })).html).toContain('<div style="color: var(--xb-primary)"></div>');
      await expect(renderCmsPage({ store, projectId: project.id, content: serializeXb(parse('<form action="/a" method="post"><input name="x" form="altro"></form>').blocks) })).rejects.toThrow(/attributo form non è supportato/u);
    } finally {
      store.close();
    }
  });

  it("rifiuta costrutti, props e cicli non supportati invece di appiattirli", async () => {
    const { project, store } = await newStore();
    const loop = serializeXb(parse("{#loop posts() as post}<p>{post.title}</p>{/loop}").blocks);
    await expect(renderCmsPage({ store, projectId: project.id, content: loop })).rejects.toThrow(/CMS relazionale M3/u);

    const first = store.createComponent({ ref: "ui/first", title: "First", schema: { props: { title: { type: "string" } } }, content: serializeXb(parse("<p>{props.title}</p>").blocks) });
    store.createComponent({ ref: "ui/second", title: "Second", content: serializeXb(parse("<Ui.First/>").blocks) });
    expect(() => store.saveComponent({
      alias: first.alias,
      expectedHead: first.headRevision,
      ref: first.ref,
      content: serializeXb(parse("<Ui.Second/>").blocks),
      schema: first.schema,
    })).toThrow(/non possono richiamarsi/u);

    const badProp = serializeXb(parse("<Ui.First title={props.secret}/>").blocks);
    const rendered = await renderCmsPage({ store, projectId: project.id, content: badProp });
    expect(rendered.html).toContain("<p></p>");
    expect(first.alias).toBeGreaterThanOrEqual(1_000_000_000);
    store.close();
  });

  it("applica un limite finito ai nodi per fermare documenti esplosivi", async () => {
    const { project, store } = await newStore();
    const content = Array.from({ length: 50_001 }, (_, index) => `<!-- wp:xb/text {\"uid\":\"x${index.toString().padStart(9, "0")}\",\"content\":\"x\"} /-->`).join("");
    await expect(renderCmsPage({ store, projectId: project.id, content })).rejects.toThrow(/limite di 50000 nodi/u);
    store.close();
  });

  // Renders past 32 MiB twice: a busy machine needs more than the default.
  it("blocca il lavoro oltre 32 MiB e l’HTML finale oltre 32 MiB", { timeout: 60_000 }, async () => {
    const { project, store } = await newStore();
    try {
      const workContent = serializeXb([{ name: "xb/raw", attrs: { uid: "worklimit0001", content: "x".repeat(32 * 1024 * 1024 + 1) } }]);
      await expect(renderCmsPage({ store, projectId: project.id, content: workContent })).rejects.toThrow(/limite di 32 MiB di lavoro/u);

      const expansionContent = serializeXb([{ name: "xb/text", attrs: { uid: "htmllimit001", content: "<".repeat(8 * 1024 * 1024 + 1) } }]);
      await expect(renderCmsPage({ store, projectId: project.id, content: expansionContent })).rejects.toThrow(/HTML supera il limite di 32 MiB/u);
    } finally {
      store.close();
    }
  });
});
