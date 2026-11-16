import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse, serializeXb } from "../.generated/histos-dsl/index.js";
import { ARTICLE_LIBRARY } from "../src/article-cards.js";
import { readArticle } from "../src/article-document.js";
import { makeArticleProposal } from "../src/article-proposal.js";
import { CmsProjectCatalog } from "../src/project-repository.js";

const content = serializeXb(parse('<p>Primo paragrafo.</p><p>Secondo.</p>').blocks);
const options = { post: true, mediaBase: "/__cms-media/p", rulesOf: (ref: string) => ARTICLE_LIBRARY.find((entry) => entry.ref === ref) ?? null, now: () => new Date("2026-11-02T12:00:00Z") };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("proposta dell'agente per un articolo (doc 23, voce 94)", () => {
  it("tiene titolo, riassunto e blocchi letti come li salverebbe l'editor", () => {
    const blocks = readArticle(content).blocks;
    const changed = [{ ...blocks[0], html: "Primo paragrafo, <strong>riscritto</strong>." }, blocks[1], { type: "paragraph", html: "Un paragrafo nuovo." }];
    const proposal = makeArticleProposal(content, "h1", { head: "h1", title: "Un titolo  migliore", excerpt: "In breve.", blocks: changed, note: "Più chiaro." }, options);
    expect(proposal).toMatchObject({ head: "h1", title: "Un titolo migliore", excerpt: "In breve.", note: "Più chiaro.", createdAt: "2026-11-02T12:00:00.000Z" });
    expect(proposal.blocks?.map((block) => block.type === "paragraph" ? block.html : block.type)).toEqual(["Primo paragrafo, <strong>riscritto</strong>.", "Secondo.", "Un paragrafo nuovo."]);
    expect(proposal.blocks?.[0]?.uid).toBe(blocks[0]?.uid);
  });

  it("rifiuta una proposta su un articolo cambiato, vuota, con tag nel titolo o un riassunto per una pagina", () => {
    expect(() => makeArticleProposal(content, "h2", { head: "h1", title: "X" }, options)).toThrow(/cambiato/u);
    expect(() => makeArticleProposal(content, "h1", { head: "h1" }, options)).toThrow(/vuota/u);
    expect(() => makeArticleProposal(content, "h1", { head: "h1", title: "<script>alert(1)</script>" }, options)).toThrow(/senza tag/u);
    expect(() => makeArticleProposal(content, "h1", { head: "h1", excerpt: "Riassunto" }, { ...options, post: false })).toThrow(/pagina/u);
    expect(() => makeArticleProposal(content, "h1", { head: "h1", title: "x".repeat(501) }, options)).toThrow(/500/u);
  });

  it("i blocchi passano gli stessi controlli di un salvataggio: niente markup, immagini solo dai media", () => {
    expect(() => makeArticleProposal(content, "h1", { head: "h1", blocks: [{ type: "paragraph", html: '<img src=x onerror="alert(1)">Ciao' }] }, options)).toThrow(/formato non ammesso/u);
    expect(() => makeArticleProposal(content, "h1", { head: "h1", blocks: [{ type: "paragraph", html: 'Ciao <a href="javascript:alert(1)">qui</a>' }] }, options)).toThrow();
    expect(() => makeArticleProposal(content, "h1", { head: "h1", blocks: [{ type: "image", src: "https://altro.example/x.png", alt: "" }] }, options)).toThrow();
    expect(() => makeArticleProposal(content, "h1", { head: "h1", blocks: [{ type: "kept", uid: "inventato" }] }, options)).not.toThrow();
    expect(makeArticleProposal(content, "h1", { head: "h1", blocks: [{ type: "kept", uid: "inventato" }] }, options).blocks).toEqual([]);
  });

  it("si conserva nel progetto senza cambiarne la revisione, e si toglie", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-proposal-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    const { store } = await catalog.createProject("Proposte");
    const post = store.createPost({ title: "Articolo", slug: "articolo", status: "draft" });
    const revision = store.getProjectRevision();
    const proposal = makeArticleProposal("", store.getHead(post.id)!.id, { head: store.getHead(post.id)!.id, title: "Nuovo" }, options);
    store.setArticleProposal(post.id, proposal);
    expect(store.getArticleProposal(post.id)).toEqual(proposal);
    expect(store.getProjectRevision()).toBe(revision);
    store.setArticleProposal(post.id, null);
    expect(store.getArticleProposal(post.id)).toBeNull();
    expect(() => store.setArticleProposal("00000000-0000-4000-8000-000000000000", proposal)).toThrow();
    store.close();
  });
});
