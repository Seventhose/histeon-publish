import { describe, expect, it } from "vitest";
import { articleFromHtml, isWxr, parseWxr } from "../src/wxr-import.js";
import { readArticle, writeArticle } from "../src/article-document.js";

const wxr = (items: string, head = "") => `<?xml version="1.0" encoding="UTF-8" ?>
<!-- generator="WordPress/6.8" -->
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>Il mio &amp; sito</title><link>https://esempio.it</link><language>it-IT</language>
<wp:wxr_version>1.2</wp:wxr_version>
<wp:category><wp:term_id>2</wp:term_id><wp:category_nicename><![CDATA[notizie]]></wp:category_nicename><wp:category_parent><![CDATA[]]></wp:category_parent><wp:cat_name><![CDATA[Notizie]]></wp:cat_name></wp:category>
<wp:tag><wp:term_id>3</wp:term_id><wp:tag_slug><![CDATA[libri]]></wp:tag_slug><wp:tag_name><![CDATA[Libri]]></wp:tag_name></wp:tag>${head}
${items}
</channel></rss>`;
const post = `<item><title><![CDATA[Primo]]></title><content:encoded><![CDATA[<!-- wp:paragraph --><p>Ciao <strong>mondo</strong></p><!-- /wp:paragraph -->
<!-- wp:code --><pre><code>&lt;/content:encoded&gt;</code></pre><!-- /wp:code -->]]></content:encoded><excerpt:encoded><![CDATA[Breve]]></excerpt:encoded><wp:post_id>10</wp:post_id><wp:post_date_gmt><![CDATA[2024-05-06 07:08:09]]></wp:post_date_gmt><wp:post_name><![CDATA[primo]]></wp:post_name><wp:status><![CDATA[publish]]></wp:status><wp:post_type><![CDATA[post]]></wp:post_type><category domain="category" nicename="notizie"><![CDATA[Notizie]]></category><category domain="post_tag" nicename="libri"><![CDATA[Libri]]></category><wp:postmeta><wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key><wp:meta_value><![CDATA[11]]></wp:meta_value></wp:postmeta></item>`;

describe("esportazione di WordPress (WXR)", () => {
  it("legge sito, termini e contenuti", () => {
    const file = parseWxr(wxr(post));
    expect(file).toMatchObject({ title: "Il mio & sito", link: "https://esempio.it", language: "it-IT" });
    expect(file.terms).toEqual([{ kind: "category", slug: "notizie", name: "Notizie", parent: "" }, { kind: "post_tag", slug: "libri", name: "Libri", parent: "" }]);
    expect(file.items[0]).toMatchObject({ id: "10", type: "post", title: "Primo", slug: "primo", status: "publish", date: "2024-05-06T07:08:09Z", excerpt: "Breve", thumbnailId: "11", terms: [{ kind: "category", slug: "notizie" }, { kind: "post_tag", slug: "libri" }] });
  });

  it("riconosce il file e rifiuta il resto, e le dichiarazioni XML", () => {
    expect(isWxr(wxr(""))).toBe(true);
    expect(isWxr("<html></html>")).toBe(false);
    expect(() => parseWxr("<rss></rss>")).toThrow("non è un'esportazione");
    expect(() => parseWxr(wxr("").replace("<channel>", "<!DOCTYPE x [<!ENTITY a \"b\">]><channel>"))).toThrow("non ammessa");
  });

  it("un testo che cita un tag di chiusura resta intero, e il CDATA spezzato si ricompone", () => {
    const split = post.replace("<![CDATA[Primo]]>", "<![CDATA[a]]]]><![CDATA[>b]]>");
    expect(parseWxr(wxr(split)).items[0]?.title).toBe("a]]>b");
    expect(parseWxr(wxr(post.replace("<p>Ciao", "<p></content:encoded>Ciao"))).items[0]?.content).toContain("</content:encoded>Ciao");
  });
});

describe("HTML di WordPress in blocchi", () => {
  const types = (html: string) => articleFromHtml(html).blocks.map((block) => block.type);

  it("editor a blocchi: paragrafi, titoli, elenchi, citazioni, immagini, separatori", () => {
    const { blocks, images } = articleFromHtml(`<!-- wp:paragraph --><p>Uno <em>due</em> <a href="https://esempio.it/x">tre</a></p><!-- /wp:paragraph -->
<h1>Grande</h1><h3>Medio</h3><h6>Piccolo</h6><ul><li>a</li><li>b</li></ul><ol><li>c</li></ol><blockquote class="wp-block-quote"><p>Cit</p></blockquote>
<figure class="wp-block-image"><img src="https://esempio.it/a.jpg" alt="Foto" width="10" height="20"/><figcaption>Una <em>foto</em></figcaption></figure><hr class="wp-block-separator"/>`);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "heading", "heading", "heading", "list", "list", "quote", "image", "separator"]);
    expect(blocks[0]).toMatchObject({ html: "Uno <em>due</em> <a href=\"https://esempio.it/x\">tre</a>" });
    expect(blocks.slice(1, 4).map((block) => (block as { level: number }).level)).toEqual([2, 3, 4]);
    expect(blocks[7]).toMatchObject({ src: "https://esempio.it/a.jpg", alt: "Foto", width: 10, height: 20, caption: "Una <em>foto</em>" });
    expect(images).toEqual(["https://esempio.it/a.jpg"]);
  });

  it("editor classico: righe vuote come paragrafi", () => {
    expect(articleFromHtml("Prima riga\ncon a capo\n\nSeconda").blocks).toMatchObject([{ type: "paragraph", html: "Prima riga<br>con a capo" }, { type: "paragraph", html: "Seconda" }]);
  });

  it("un'immagine dentro un paragrafo o un link diventa un blocco suo", () => {
    expect(types("<p>Prima <img src=\"https://e.it/a.png\"> dopo</p>")).toEqual(["paragraph", "image", "paragraph"]);
    expect(types("<a href=\"https://e.it/g.png\"><img src=\"https://e.it/a.png\"></a>")).toEqual(["image"]);
  });

  it("niente di eseguibile passa, e ciò che resta fuori si conta", () => {
    const { blocks, lost } = articleFromHtml(`<script>alert(1)</script><p onclick="x()" style="color:red">Testo <a href="javascript:alert(1)">qui</a></p><iframe src="https://y.t/x"></iframe><form><input></form><p>[gallery ids="1"]</p>`);
    expect(JSON.stringify(blocks)).not.toMatch(/script|onclick|style|iframe|javascript/u);
    expect(blocks[0]).toMatchObject({ html: "Testo qui" });
    expect(lost).toEqual({ iframe: 1, form: 1, shortcode: 1 });
  });

  it("una tabella semplice resta una tabella; con le celle unite resta come righe di testo", () => {
    const plain = articleFromHtml("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><strong>C</strong></td><td>D</td></tr></tbody></table>");
    expect(plain.blocks).toMatchObject([{ type: "table", rows: [["A", "B"], ["<strong>C</strong>", "D"]], header: true }]);
    expect(plain.lost).toEqual({});
    const joined = articleFromHtml('<table><tr><th colspan="2">A</th></tr><tr><td>C</td><td>D</td></tr></table>');
    expect(joined.blocks).toMatchObject([{ html: "A" }, { html: "C · D" }]);
    expect(joined.lost).toEqual({ tabella: 1 });
  });

  it("i video e gli audio restano come blocchi che portano al loro indirizzo", () => {
    const { blocks, lost } = articleFromHtml(`<figure><iframe title="Il discorso" src="https://www.youtube.com/embed/abc123XYZ?feature=oembed"></iframe></figure><p><iframe src="https://player.vimeo.com/video/42"></iframe></p><video src="https://esempio.it/uploads/incontro.mp4"></video><audio><source src="https://esempio.it/uploads/voce.mp3"></audio><iframe src="https://altro.it/x"></iframe>`);
    expect(blocks).toMatchObject([
      { type: "card", ref: "articolo/video", props: { url: "https://www.youtube.com/watch?v=abc123XYZ", title: "Il discorso" } },
      { type: "card", ref: "articolo/video", props: { url: "https://vimeo.com/42" } },
      { type: "card", ref: "articolo/video", props: { url: "https://esempio.it/uploads/incontro.mp4", title: "incontro.mp4" } },
      { type: "card", ref: "articolo/audio", props: { url: "https://esempio.it/uploads/voce.mp3" } },
    ]);
    expect(lost).toEqual({ iframe: 1 });
  });

  it("un indirizzo con le graffe resta lo stesso indirizzo e non ferma la costruzione del sito", () => {
    const { blocks } = articleFromHtml('<p><a href="https://esempio.it/#{%20%22a%22:1}">Prova</a></p>');
    const written = writeArticle("", blocks, { mediaBase: "/__cms-media/p" });
    expect(readArticle(written).blocks[0]).toMatchObject({ html: '<a href="https://esempio.it/#%7B%20%22a%22:1%7D">Prova</a>' });
  });

  it("le parentesi di una trascrizione non sono codici brevi, e un'immagine con // è un'immagine", () => {
    const { blocks, lost, images } = articleFromHtml('<p>[Anna 00:12] Buongiorno</p><img src="//i0.wp.com/x.png" alt="">');
    expect(lost).toEqual({});
    expect(images).toEqual(["https://i0.wp.com/x.png"]);
    expect(blocks).toHaveLength(2);
  });

  it("ciò che esce passa i controlli dell'editor e si rilegge uguale", () => {
    const html = `<p>Uno &amp; due {tre} <strong>forte</strong></p><h2>Titolo</h2><ul><li>Voce</li></ul><blockquote><p>Cit</p></blockquote><hr>`;
    const { blocks } = articleFromHtml(html);
    const written = writeArticle("", blocks, { mediaBase: "/__cms-media/p" });
    expect(readArticle(written).blocks.map((block) => block.type)).toEqual(["paragraph", "heading", "list", "quote", "separator"]);
    expect(readArticle(written).blocks[0]).toMatchObject({ html: "Uno &amp; due {tre} <strong>forte</strong>" });
  });
});
