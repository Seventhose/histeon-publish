import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { CmsProjectCatalog } from "@histos-publish/cms";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CmsRemoteCatalog } from "../src/cms-remote.js";
import { answerFrontPageOffer, frontPageOffer, parseSiteFrontPage } from "../src/cms-remote-front-page.js";

/**
 * Doc 23 item 201: after the first send with publishing, Publish proposes to make the project's home and «blog» page
 * the site's home and posts page, and sets them only on the user's yes. A fake site answers the signed bridge routes.
 */

const SITE_ID = "de7d1687-bf53-4b1e-8d96-43391da110f0";
const SECRET = Buffer.alloc(32, 7);

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

describe("pagina iniziale del sito dopo il primo invio con pubblicazione (voce 201)", () => {
  let root: string;
  let server: Server;
  let url: string;
  let projects: CmsProjectCatalog;
  let remotes: CmsRemoteCatalog;
  let projectId: string;
  let homeId: string;
  let blogId: string;
  let site: { showOnFront: string; frontPage: string | null; postsPage: string | null; frontPageOther: boolean; postsPageOther: boolean };
  let siteSettings: string[];
  let publish: boolean;
  let posted: Array<Record<string, unknown>>;
  let requests: string[];
  const secrets = new Map<string, string>();
  const storeFor = (account: string) => ({
    get: async () => secrets.get(account) ?? null,
    set: async (value: string) => { secrets.set(account, value); },
    delete: async () => { secrets.delete(account); },
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "histos-front-page-"));
    projects = new CmsProjectCatalog(path.join(root, "projects"));
    await projects.initialize();
    const created = await projects.createProject("Galleria");
    projectId = created.project.id;
    // createProject seeds a draft «home»: published here, as a send with publishing leaves it.
    homeId = created.store.listPages().find((page) => page.slug === "home")!.id;
    created.store.bulkSetStatus([homeId], "published");
    blogId = created.store.createPage({ title: "Blog", slug: "blog", status: "published" }).id;
    created.store.createPage({ title: "Chi siamo", slug: "chi-siamo", status: "published" });
    created.store.createPost({ title: "Il primo giorno", slug: "primo-giorno", status: "published", publishedAt: "2026-10-20T08:30:00Z" });
    created.store.close();
    site = { showOnFront: "posts", frontPage: null, postsPage: null, frontPageOther: false, postsPageOther: false };
    siteSettings = ["histos-front-page-v1"];
    publish = true;
    posted = [];
    requests = [];
    server = createServer((request, response) => {
      void (async () => {
        const body = await readBody(request);
        const route = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("rest_route") ?? "";
        const expected = createHmac("sha256", SECRET).update(`${request.method}\n${route}\n${request.headers["x-histos-time"]}\n${request.headers["x-histos-nonce"]}\n${createHash("sha256").update(body).digest("hex")}`).digest("hex");
        if (request.headers["x-histos-signature"] !== expected) return void response.writeHead(401).end();
        requests.push(`${request.method} ${route}`);
        const json = (value: unknown) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
        if (route === "/xb/v1/cms/v1/capabilities") {
          return json({ contractVersion: 2, profile: "histos-static-page-v1", siteId: SITE_ID, projectId, canInitializeProject: false, projectName: "Galleria", capabilities: { read: true, write: true, publish, profiles: ["histos-static-page-v1", "histos-static-project-v4"], siteSettings } });
        }
        if (route === "/xb/v1/cms/v1/front-page" && request.method === "GET") return json(site);
        if (route === "/xb/v1/cms/v1/front-page" && request.method === "POST") {
          expect(request.headers["content-type"]).toBe("application/json");
          const sent = JSON.parse(body.toString("utf8")) as { frontPage: string; postsPage: string | null };
          posted.push(sent);
          site = { ...site, showOnFront: "page", frontPage: sent.frontPage, postsPage: sent.postsPage ?? site.postsPage };
          return json(site);
        }
        response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ code: "rest_no_route", message: "Nessun percorso." }));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://localhost:${(server.address() as { port: number }).port}`;
    remotes = new CmsRemoteCatalog(root);
  });

  afterEach(async () => {
    remotes.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  function connect(options: { publish?: boolean; projectId?: string } = {}): string {
    const id = randomUUID();
    remotes.add({ id, url, siteId: SITE_ID, projectId: options.projectId ?? projectId, projectName: "Galleria", profile: "histos-static-page-v1", read: true, write: true, publish: options.publish ?? true });
    secrets.set(`cms-remote-${id}`, SECRET.toString("base64url"));
    return id;
  }

  it("propone home e blog del progetto, e solo il sì le imposta, con le pagine lette dal progetto", async () => {
    const connectionId = connect();
    const offer = await frontPageOffer({ connectionId, projectId }, remotes, projects, storeFor);
    expect(offer).toEqual({ frontPage: { id: homeId, title: "Home" }, postsPage: { id: blogId, title: "Blog" }, postsWithoutPage: false, current: { showOnFront: "posts", frontPageIsOther: false, postsPageIsOther: false } });
    expect(posted).toEqual([]);
    expect(await answerFrontPageOffer({ connectionId, projectId, accept: true }, remotes, projects, storeFor)).toEqual({ answer: "accepted", showOnFront: "page" });
    expect(posted).toEqual([{ frontPage: homeId, postsPage: blogId }]);
    // Asked once: after the answer, no proposal, and no request to the site either.
    requests = [];
    expect(await frontPageOffer({ connectionId, projectId }, remotes, projects, storeFor)).toBeNull();
    expect(requests).toEqual([]);
  });

  it("un no non tocca il sito e la proposta non torna", async () => {
    const connectionId = connect();
    expect(await frontPageOffer({ connectionId, projectId }, remotes, projects, storeFor)).not.toBeNull();
    requests = [];
    expect(await answerFrontPageOffer({ connectionId, projectId, accept: false }, remotes, projects, storeFor)).toEqual({ answer: "declined" });
    expect(requests).toEqual([]);
    expect(await frontPageOffer({ connectionId, projectId }, remotes, projects, storeFor)).toBeNull();
    expect(remotes.frontPageAnswer(connectionId)).toBe("declined");
  });

  it("niente proposta su un sito già a posto, senza il permesso di pubblicare o con un Histeon che non lo sa fare", async () => {
    const connectionId = connect();
    site = { showOnFront: "page", frontPage: homeId, postsPage: blogId, frontPageOther: false, postsPageOther: false };
    expect(await frontPageOffer({ connectionId, projectId }, remotes, projects, storeFor)).toBeNull();
    site = { showOnFront: "page", frontPage: null, postsPage: null, frontPageOther: true, postsPageOther: false };
    expect(await frontPageOffer({ connectionId, projectId }, remotes, projects, storeFor)).toMatchObject({ current: { showOnFront: "page", frontPageIsOther: true } });
    siteSettings = [];
    requests = [];
    expect(await frontPageOffer({ connectionId, projectId }, remotes, projects, storeFor)).toBeNull();
    expect(requests).toEqual(["GET /xb/v1/cms/v1/capabilities"]);
    siteSettings = ["histos-front-page-v1"];
    publish = false;
    expect(await frontPageOffer({ connectionId, projectId }, remotes, projects, storeFor)).toBeNull();
    requests = [];
    expect(await frontPageOffer({ connectionId: connect({ publish: false }), projectId }, remotes, projects, storeFor)).toBeNull();
    expect(requests).toEqual([]);
    await expect(answerFrontPageOffer({ connectionId: connect({ publish: false }), projectId, accept: true }, remotes, projects, storeFor)).rejects.toMatchObject({ code: "cms-remote-publish-scope-required" });
    // Another project's connection: refused, the site is never asked.
    await expect(frontPageOffer({ connectionId: connect({ projectId: randomUUID() }), projectId }, remotes, projects, storeFor)).rejects.toMatchObject({ code: "cms-remote-project-changed" });
    await expect(answerFrontPageOffer({ connectionId, projectId: randomUUID(), accept: true }, remotes, projects, storeFor)).rejects.toMatchObject({ code: "cms-remote-project-changed" });
    expect(posted).toEqual([]);
  });

  it("senza una pagina «blog» propone solo la home e dice che l'elenco degli articoli resta senza indirizzo", async () => {
    const fresh = await projects.createProject("Senza blog");
    projectId = fresh.project.id;
    homeId = fresh.store.listPages().find((page) => page.slug === "home")!.id;
    fresh.store.updatePageMetadata(homeId, { title: "Inizio", slug: "home", status: "published" });
    fresh.store.createPage({ title: "Blog in bozza", slug: "blog", status: "draft" });
    fresh.store.createPost({ title: "Il primo giorno", slug: "primo-giorno", status: "published", publishedAt: "2026-10-20T08:30:00Z" });
    fresh.store.close();
    const connectionId = connect();
    expect(await frontPageOffer({ connectionId, projectId }, remotes, projects, storeFor)).toEqual({ frontPage: { id: homeId, title: "Inizio" }, postsPage: null, postsWithoutPage: true, current: { showOnFront: "posts", frontPageIsOther: false, postsPageIsOther: false } });
    await answerFrontPageOffer({ connectionId, projectId, accept: true }, remotes, projects, storeFor);
    expect(posted).toEqual([{ frontPage: homeId, postsPage: null }]);
  });

  it("legge la risposta del sito come un dato non fidato", () => {
    const valid = { showOnFront: "page", frontPage: randomUUID(), postsPage: null, frontPageOther: false, postsPageOther: false };
    expect(parseSiteFrontPage(valid)).toEqual(valid);
    for (const bad of [null, [], "page", { ...valid, showOnFront: "static" }, { ...valid, frontPage: 12 }, { ...valid, frontPage: "home" }, { ...valid, postsPage: undefined }, { ...valid, frontPageOther: "no" }]) {
      expect(() => parseSiteFrontPage(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: "cms-remote-front-page-invalid" }));
    }
  });
});
