import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPARE_TOLERANCE, compareProposal, differentPixels, ProposalOriginals, readProposalCompare, saveProposalCompare, stillFile, stillPolicy, type OpenPagePhotos, type PagePhoto, type ProposalCompareResult } from "../src/proposal-compare.js";
import { readKeptSiteFiles } from "../src/proposal-store.js";
import { startLocalServer, type LocalServerHandle, type LocalServerOptions } from "../src/server.js";
import { proposalMissingNote } from "../src/cms-api.js";

/**
 * «Uguale alla proposta»: the counting, the still sites and the routes, with a browser that is invented (it asks
 * each page over HTTP as the hidden window would, and answers with a painted rectangle). The real window is in
 * tests/electron/proposal-compare.spec.ts.
 */
const page = (title: string, body: string): string => `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${title}</title><style>h1{color:#a22}</style></head><body>${body}</body></html>`;
const photo = (width: number, height: number, paint: (x: number, y: number) => [number, number, number] = () => [255, 255, 255]): PagePhoto => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...paint(x, y), 255], (y * width + x) * 4);
  return { width, height, data };
};

describe("il conteggio dei pixel", () => {
  it("due pixel sono uguali fino a 48 di scarto sulla somma dei tre colori", () => {
    expect(COMPARE_TOLERANCE).toBe(48);
    const white = photo(4, 2);
    expect(differentPixels(white, photo(4, 2))).toEqual({ differentPixels: 0, totalPixels: 8 });
    expect(differentPixels(white, photo(4, 2, () => [239, 239, 239]))).toEqual({ differentPixels: 0, totalPixels: 8 });
    expect(differentPixels(white, photo(4, 2, (x) => (x === 0 ? [238, 239, 239] : [255, 255, 255])))).toEqual({ differentPixels: 2, totalPixels: 8 });
    // One colour alone may move by 48; the opacity is not read.
    expect(differentPixels(white, photo(4, 2, () => [207, 255, 255])).differentPixels).toBe(0);
    expect(differentPixels(white, photo(4, 2, () => [206, 255, 255])).differentPixels).toBe(8);
  });

  it("l'area che una fotografia non ha conta come diversa", () => {
    expect(differentPixels(photo(4, 2), photo(4, 5))).toEqual({ differentPixels: 12, totalPixels: 20 });
    expect(differentPixels(photo(6, 2), photo(4, 2))).toEqual({ differentPixels: 4, totalPixels: 12 });
  });
});

describe("il sito servito fermo", () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), "histos-still-"));
    await mkdir(path.join(folder, "menu"));
    await mkdir(path.join(folder, ".histos-publish"));
    await writeFile(path.join(folder, "index.html"), page("Home", "<h1>Trattoria</h1>"));
    await writeFile(path.join(folder, "menu", "index.html"), page("Menu", "<h1>Menu</h1>"));
    await writeFile(path.join(folder, "chi-siamo.html"), page("Chi siamo", "<h1>Noi</h1>"));
    await writeFile(path.join(folder, ".histos-publish", "report.json"), "{}");
  });
  afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

  it("serve cartelle, pagine senza estensione e niente di nascosto o fuori dalla cartella", async () => {
    expect(await stillFile(folder, "/")).toMatchObject({ type: "text/html; charset=utf-8" });
    expect(await stillFile(folder, "/menu/")).toMatchObject({ absolute: path.join(folder, "menu", "index.html") });
    expect(await stillFile(folder, "/menu")).toEqual({ redirect: true });
    expect(await stillFile(folder, "/chi-siamo")).toMatchObject({ absolute: path.join(folder, "chi-siamo.html") });
    for (const address of ["/manca/", "/.histos-publish/report.json", "/../index.html", "/menu/../../index.html", "menu/", "/menu\\index.html", "/a\0b"]) expect(await stillFile(folder, address)).toBeNull();
  });

  it("la politica non lascia partire nessuno script e chiude connessioni, moduli e riquadri", () => {
    const policy = stillPolicy();
    for (const part of ["default-src 'none'", "script-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "img-src 'self' https: data: blob:"]) expect(policy).toContain(part);
    expect(policy).not.toContain("sandbox");
    expect(policy).not.toContain("unsafe-eval");
    const sealed = stillPolicy({ ancestors: ["app:"], sealed: true });
    expect(sealed).toContain("frame-ancestors app:; sandbox");
    expect(sealed.endsWith("; sandbox")).toBe(true);
  });

  it("i biglietti dell'originale valgono per la loro cartella e scadono", () => {
    const originals = new ProposalOriginals();
    const ticket = originals.open(folder, 1_000);
    expect(originals.resolve(`/__original/${ticket}/menu/`, 2_000)).toEqual({ root: folder, ticket, pathname: "/menu/" });
    expect(originals.resolve(`/__original/${ticket}`, 2_000)).toBeNull();
    expect(originals.resolve(`/__original/${"a".repeat(32)}/`, 2_000)).toBeNull();
    expect(originals.resolve(`/altro/${ticket}/`, 2_000)).toBeNull();
    // Five minutes after its last file.
    expect(originals.resolve(`/__original/${ticket}/`, 2_000 + 5 * 60_000 + 1)).toBeNull();
    const kept = Array.from({ length: 9 }, () => originals.open(folder, 5_000));
    expect(originals.resolve(`/__original/${kept[0]}/`, 5_001)).toBeNull();
    expect(originals.resolve(`/__original/${kept[8]}/`, 5_001)).not.toBeNull();
  });

  it("fotografa ogni pagina nei tre siti, dice quella che un sito non ha e non conta le fotografie fallite", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "histos-still-built-"));
    try {
      await writeFile(path.join(other, "index.html"), page("Home", "<h1>Trattoria</h1>"));
      const asked: string[] = [];
      const policies = new Set<string | null>();
      let closed = 0;
      const openPhotos: OpenPagePhotos = async ({ origins }) => ({
        photograph: async ({ url, width, expression }) => {
          asked.push(`${origins.indexOf(new URL(url).origin)} ${new URL(url).pathname} ${width}`);
          expect(expression).toContain("getComputedStyle");
          const response = await fetch(url);
          policies.add(response.headers.get("content-security-policy"));
          if (response.status !== 200) throw new Error("non trovata");
          if (width === 390 && origins.indexOf(new URL(url).origin) === 2) throw new Error("finestra chiusa");
          // The site «con i token» (the second origin) is painted with ten darker pixels.
          return photo(width, 3, (x, y) => (origins.indexOf(new URL(url).origin) === 1 && y === 0 && x < 10 ? [0, 0, 0] : [255, 255, 255]));
        },
        close: async () => { closed += 1; },
      });
      const pages = [{ name: "Home", path: "index.html", hash: "" }, { name: "Menu", path: "menu/index.html", hash: "" }];
      const compared = await compareProposal({ pages, original: folder, withTokens: other, withoutTokens: folder, openPhotos });
      expect(compared.pages).toEqual([
        { name: "Home", path: "/", found: { withTokens: true, withoutTokens: true }, widths: [
          { width: 1280, withTokens: { differentPixels: 10, totalPixels: 3840 }, withoutTokens: { differentPixels: 0, totalPixels: 3840 } },
          { width: 390, withTokens: { differentPixels: 10, totalPixels: 1170 }, withoutTokens: null },
        ] },
        { name: "Menu", path: "/menu/", found: { withTokens: false, withoutTokens: true }, widths: [
          { width: 1280, withTokens: null, withoutTokens: { differentPixels: 0, totalPixels: 3840 } },
          { width: 390, withTokens: null, withoutTokens: null },
        ] },
      ]);
      expect(compared.notes).toEqual(["2 fotografie non sono riuscite: i numeri che mancano non sono stati misurati."]);
      // The page a site lacks is never asked of it.
      expect(asked).not.toContain("1 /menu/ 1280");
      expect([...policies]).toEqual([stillPolicy()]);
      expect(closed).toBe(1);

      // Without the site «senza token» only the first number is measured.
      const alone = await compareProposal({ pages: pages.slice(0, 1), original: folder, withTokens: other, withoutTokens: null, openPhotos, widths: [1280] });
      expect(alone.pages[0]).toMatchObject({ found: { withTokens: true, withoutTokens: false }, widths: [{ width: 1280, withTokens: { differentPixels: 10 }, withoutTokens: null }] });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("l'esito salvato si rilegge; uno che non ha la forma no", async () => {
    const result: ProposalCompareResult = { schemaVersion: 1, checkedAt: "2026-11-13T18:00:00.000Z", buildAt: "2026-11-13T17:00:00.000Z", pages: [{ name: "Home", path: "/", found: { withTokens: true, withoutTokens: true }, widths: [{ width: 1280, withTokens: { differentPixels: 10, totalPixels: 3840 }, withoutTokens: null }] }], notes: ["una nota"] };
    expect(await readProposalCompare(folder)).toBeNull();
    await saveProposalCompare(folder, result);
    expect(await readProposalCompare(folder)).toEqual(result);
    await writeFile(path.join(folder, "compare.json"), JSON.stringify({ ...result, pages: [{ name: "Home", path: "/", widths: [{ width: 1280, withTokens: { differentPixels: 9, totalPixels: 3 } }] }] }));
    expect((await readProposalCompare(folder))?.pages[0]).toEqual({ name: "Home", path: "/", found: { withTokens: false, withoutTokens: false }, widths: [{ width: 1280, withTokens: null, withoutTokens: null }] });
    await writeFile(path.join(folder, "compare.json"), "{");
    expect(await readProposalCompare(folder)).toBeNull();
  });

  it("i file conservati si rileggono senza quelli nascosti", async () => {
    expect((await readKeptSiteFiles(folder)).map((file) => file.path)).toEqual(["chi-siamo.html", "index.html", "menu/index.html"]);
  });
});

describe("la nota di ciò che la conversione «senza» non ha scaricato", () => {
  it("la nota di ciò che manca dice le prime tre cose e sta nel taglio delle note salvate", () => {
    const many = Array.from({ length: 7 }, (_, index) => `font «Famiglia ${index}»: nessun file scaricato,\n il sito userà il carattere di ripiego e altro testo lungo`);
    const note = proposalMissingNote(many);
    expect(note).toContain("ripiego; font «Famiglia 2»: nessun file scaricato, il sito userà il carattere di ripiego; e altre 4. Rifai il confronto per riprovare.");
    expect(note).not.toContain("Famiglia 3");
    expect(note.length).toBeLessThanOrEqual(400);
  });
});

describe("le rotte del confronto", () => {
  let server: LocalServerHandle;
  let dataDirectory: string;
  let base: string;
  const asked: string[] = [];

  /** The invented browser: every page asked over HTTP; the site «con i token» comes out with a hundred darker pixels. */
  const photographPages: OpenPagePhotos = async ({ origins }) => ({
    photograph: async ({ url, width }) => {
      const origin = origins.indexOf(new URL(url).origin);
      const response = await fetch(url);
      asked.push(`${origin} ${new URL(url).pathname} ${width} ${response.status} ${response.headers.get("content-security-policy")?.includes("script-src 'none'") ? "fermo" : "vivo"}`);
      return photo(width, 2, (x, y) => (origin === 1 && y === 0 && x < 100 ? [0, 0, 0] : [255, 255, 255]));
    },
    close: async () => undefined,
  });

  async function start(options: LocalServerOptions = {}): Promise<void> {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-compare-"));
    const uiDirectory = path.join(dataDirectory, "ui");
    await mkdir(uiDirectory);
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>App</title><p>APP-SHELL</p>");
    server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false, ...options });
    base = `http://127.0.0.1:${server.port}`;
  }

  beforeEach(() => { asked.length = 0; });
  afterEach(async () => {
    await server.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  async function api(pathname: string, init: { method?: string; body?: string | Buffer; type?: string } = {}): Promise<Response> {
    return fetch(`${base}${pathname}`, {
      method: init.method ?? "GET",
      headers: { "X-Histos-Token": server.token, Origin: base, ...(init.type ? { "Content-Type": init.type } : {}) },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  }
  const json = { method: "POST", type: "application/json" } as const;

  /** A project born from a captured proposal of two pages, as the app makes it. */
  async function capturedProject(head = ""): Promise<string> {
    const bytes = Buffer.from(page("Proposte", "<h1>Visore</h1>"));
    const plan = await (await api("/api/imports", { ...json, body: JSON.stringify({ name: "Trattoria", kind: "html", files: [{ path: "proposta.html", size: bytes.byteLength }] }) })).json() as { id: string };
    expect((await api(`/api/imports/${plan.id}/files/proposta.html`, { method: "PUT", type: "application/octet-stream", body: bytes })).status).toBe(201);
    const pages = [
      { name: "Home", hash: "#p01/home", html: page("Trattoria", '<h1>Trattoria</h1><p><a href="#p01/menu">Il menu</a></p>').replace("</head>", `${head}</head>`) },
      { name: "Menu", hash: "#p01/menu", html: page("Menu", '<h1>Menu</h1><p><a href="#p01/home">Home</a></p>').replace("</head>", `${head}</head>`) },
    ];
    const site = await (await api(`/api/imports/${plan.id}/captured-site`, { ...json, body: JSON.stringify({ pages }) })).json() as { id: string };
    const converted = await (await api(`/api/imports/${site.id}/cms-prototype`, { ...json, body: JSON.stringify({ fonts: true }) })).json() as { prototype: string };
    const imported = await (await api("/api/cms/v1/projects/import-prototype", { method: "POST", type: "text/html", body: converted.prototype })).json() as { project: { id: string } };
    expect((await api(`/api/imports/${site.id}/keep-proposal`, { ...json, body: JSON.stringify({ projectId: imported.project.id }) })).status).toBe(201);
    return imported.project.id;
  }

  interface Answer { kept: boolean; available: boolean; running: boolean; failed: string | null; built: boolean; current: boolean; result: ProposalCompareResult | null }
  const state = async (projectId: string): Promise<Answer> => await (await api(`/api/cms/v1/projects/${projectId}/admin/proposal-compare`)).json() as Answer;

  it("fuori dall'app desktop il confronto non c'è: la sezione dice «non controllata»", async () => {
    await start();
    const projectId = await capturedProject();
    expect(await state(projectId)).toEqual({ kept: true, available: false, running: false, failed: null, built: false, current: false, result: null });
    // Nothing to photograph before a version exists, and no browser here after.
    const early = await api(`/api/cms/v1/projects/${projectId}/admin/proposal-compare`, { ...json, body: "{}" });
    expect(early.status).toBe(409);
    expect((await early.json() as { code: string }).code).toBe("cms-site-check-no-build");
    expect((await api(`/api/cms/v1/projects/${projectId}/build`, { ...json, body: "{}" })).status).toBe(200);
    const refused = await api(`/api/cms/v1/projects/${projectId}/admin/proposal-compare`, { ...json, body: "{}" });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { code: string }).code).toBe("cms-proposal-compare-no-browser");
    expect(await state(projectId)).toMatchObject({ kept: true, available: false, built: true, result: null });

    // A project that keeps no capture has nothing to compare.
    const plain = await (await api("/api/cms/v1/projects", { ...json, body: JSON.stringify({ name: "Senza proposta" }) })).json() as { project: { id: string } };
    expect(await state(plain.project.id)).toMatchObject({ kept: false, result: null });
    expect((await api(`/api/cms/v1/projects/${plain.project.id}/admin/proposal-compare`, { ...json, body: "{}" })).status).toBe(404);
    expect((await api(`/api/cms/v1/projects/${plain.project.id}/admin/proposal-compare/view`, { ...json, body: "{}" })).status).toBe(404);
  });

  it("doc 28: una proposta fotografata tiene sempre le misure esatte; un file qualunque solo se la persona lo sceglie", async () => {
    await start();
    const sized = "<style>h1{font-size:44px}p{font:400 17px/1.5 sans-serif;margin:0 0 36px}</style>";
    const upload = async (pages: Array<{ name: string; hash: string; html: string }> | null, choice: Record<string, unknown> = {}) => {
      const bytes = Buffer.from(page("Proposte", "<h1>Visore</h1><p>Testo</p>").replace("</head>", `${sized}</head>`));
      const plan = await (await api("/api/imports", { ...json, body: JSON.stringify({ name: "Trattoria", kind: "html", files: [{ path: "proposta.html", size: bytes.byteLength }] }) })).json() as { id: string };
      expect((await api(`/api/imports/${plan.id}/files/proposta.html`, { method: "PUT", type: "application/octet-stream", body: bytes })).status).toBe(201);
      const id = pages ? (await (await api(`/api/imports/${plan.id}/captured-site`, { ...json, body: JSON.stringify({ pages }) })).json() as { id: string }).id : plan.id;
      // The dialog may ask again with another framework or without the exact sizes: a proposal stays exact.
      return await (await api(`/api/imports/${id}/cms-prototype`, { ...json, body: JSON.stringify({ framework: "histos-css", ...choice }) })).json() as { prototype: string; exact: boolean; exactChoice: string; siteVariables: number; report: { notes: string[] } };
    };
    // The request says «not exact»: for a captured proposal the server does not listen.
    const captured = await upload([{ name: "Home", hash: "#p01/home", html: page("Trattoria", "<h1>Trattoria</h1><p>Benvenuti</p>").replace("</head>", `${sized}</head>`) }], { exact: false });
    expect(captured.exact).toBe(true);
    expect(captured.exactChoice).toBe("always");
    expect(captured.siteVariables).toBe(3);
    expect(captured.prototype).toContain('"siteTokens":{"spazio-36":"36px","testo-17":"17px","testo-44":"44px"}');
    expect(captured.prototype).toContain("font-size:var(--xb-site-testo-44)");
    expect(captured.prototype).toContain("font:400 var(--xb-site-testo-17)/1.5 sans-serif;margin:0 0 var(--xb-site-spazio-36)");
    expect(captured.prototype).not.toMatch(/var\(--xb-(?:text|space)-/u);
    expect(captured.report.notes.join("\n")).toContain("misure scritte a mano tenute esatte come variabili del sito: 2 misure di testo");

    // In the project the variables are the site's own: the Design panel lists them and every page prints them.
    const imported = await (await api("/api/cms/v1/projects/import-prototype", { method: "POST", type: "text/html", body: captured.prototype })).json() as { project: { id: string }; report: { warnings: string[] } };
    expect(imported.report.warnings.join("\n")).not.toContain("Variabili senza valore");
    const framework = await (await api(`/api/cms/v1/projects/${imported.project.id}/framework`)).json() as { variables: Array<{ name: string; value?: string }> };
    expect(framework.variables.filter((variable) => variable.name.startsWith("xb-site-")).map((variable) => variable.name).sort()).toEqual(["xb-site-spazio-36", "xb-site-testo-17", "xb-site-testo-44"]);

    // Any other upload: as before unless the person turns the choice on, and only the literal `true` turns it on.
    for (const choice of [{}, { exact: false }, { exact: "true" }, { exact: 1 }, { captured: true }]) {
      const plain = await upload(null, choice);
      expect(plain.exact).toBe(false);
      expect(plain.exactChoice).toBe("choice");
      expect(plain.siteVariables).toBe(0);
      expect(plain.prototype).not.toContain("siteTokens");
      expect(plain.prototype).not.toContain("--xb-site-");
      expect(plain.prototype).toMatch(/var\(--xb-(?:text|space)-/u);
    }
    const chosen = await upload(null, { exact: true, captured: true });
    expect(chosen.exact).toBe(true);
    expect(chosen.exactChoice).toBe("choice");
    expect(chosen.siteVariables).toBe(3);
    expect(chosen.prototype).toContain("font-size:var(--xb-site-testo-44)");
    expect(chosen.prototype).not.toMatch(/var\(--xb-(?:text|space)-/u);
    // The choice gives the sizes and nothing else: the upload is not a captured proposal, whatever the request says.
    expect(chosen.report.notes.join("\n")).not.toContain("da rifare");
    expect(chosen.prototype).not.toContain("data-xb-");
    // Without a framework of tokens there is nothing to keep exact, and the dialog has no choice to show.
    const none = await upload(null, { exact: true, framework: "none" });
    expect(none.exact).toBe(false);
    expect(none.exactChoice).toBe("none");
  });

  it("nell'app fotografa l'originale, la versione con i token e quella senza, e salva i due numeri per pagina", async () => {
    await start({ photographPages });
    const projectId = await capturedProject();
    expect((await api(`/api/cms/v1/projects/${projectId}/build`, { ...json, body: "{}" })).status).toBe(200);
    const started = await api(`/api/cms/v1/projects/${projectId}/admin/proposal-compare`, { ...json, body: "{}" });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ kept: true, available: true, running: true, failed: null });
    // One at a time for each project.
    expect((await api(`/api/cms/v1/projects/${projectId}/admin/proposal-compare`, { ...json, body: "{}" })).status).toBe(409);
    let answer = await state(projectId);
    for (let turn = 0; turn < 300 && answer.running; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      answer = await state(projectId);
    }
    expect(answer).toMatchObject({ kept: true, available: true, running: false, failed: null, built: true, current: true });
    expect(answer.result?.notes).toEqual([]);
    expect(answer.result?.pages).toEqual([
      { name: "Home", path: "/", found: { withTokens: true, withoutTokens: true }, widths: [
        { width: 1280, withTokens: { differentPixels: 100, totalPixels: 2560 }, withoutTokens: { differentPixels: 0, totalPixels: 2560 } },
        { width: 390, withTokens: { differentPixels: 100, totalPixels: 780 }, withoutTokens: { differentPixels: 0, totalPixels: 780 } },
      ] },
      { name: "Menu", path: "/menu/", found: { withTokens: true, withoutTokens: true }, widths: [
        { width: 1280, withTokens: { differentPixels: 100, totalPixels: 2560 }, withoutTokens: { differentPixels: 0, totalPixels: 2560 } },
        { width: 390, withTokens: { differentPixels: 100, totalPixels: 780 }, withoutTokens: { differentPixels: 0, totalPixels: 780 } },
      ] },
    ]);
    // Three sites, two pages, two widths: every page found and served without scripts.
    expect(asked).toHaveLength(12);
    expect(asked.every((line) => line.endsWith(" 200 fermo"))).toBe(true);
    // Saved beside the capture; the throwaway build «senza token» is gone.
    const saved = JSON.parse(await readFile(path.join(dataDirectory, "histos-projects", projectId, "proposal", "compare.json"), "utf8")) as ProposalCompareResult;
    expect(saved.pages).toHaveLength(2);
    // A new version of the project: the saved comparison is of the one before.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await api(`/api/cms/v1/projects/${projectId}/build`, { ...json, body: "{}" })).status).toBe(200);
    expect(await state(projectId)).toMatchObject({ current: false, result: { pages: [{ name: "Home" }, { name: "Menu" }] } });
  });

  it("un carattere che la conversione «senza» non scarica è una nota del confronto, accanto ai numeri", async () => {
    // Google answers the licence and the stylesheet; the file of the font does not come.
    const text = (value: string) => ({ status: 200, body: new TextEncoder().encode(value) });
    const fontFetcher: NonNullable<LocalServerOptions["fontFetcher"]> = async (url) => {
      if (url === "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/METADATA.pb") return text('name: "Inter"\nlicense: "OFL"\n');
      if (url.startsWith("https://fonts.googleapis.com/css2")) return text("/* latin */\n@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/inter/latin-400.woff2) format('woff2'); unicode-range: U+0000-00FF; }");
      return { status: 404, body: new Uint8Array() };
    };
    await start({ photographPages, fontFetcher });
    const projectId = await capturedProject('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400&amp;display=swap">');
    expect((await api(`/api/cms/v1/projects/${projectId}/build`, { ...json, body: "{}" })).status).toBe(200);
    expect((await api(`/api/cms/v1/projects/${projectId}/admin/proposal-compare`, { ...json, body: "{}" })).status).toBe(202);
    let answer = await state(projectId);
    for (let turn = 0; turn < 300 && answer.running; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      answer = await state(projectId);
    }
    expect(answer).toMatchObject({ running: false, failed: null, current: true });
    // The numbers are there, and the note says what they are numbers of.
    expect(answer.result?.pages.map((item) => item.found)).toEqual([{ withTokens: true, withoutTokens: true }, { withTokens: true, withoutTokens: true }]);
    expect(answer.result?.notes).toEqual(["La versione «senza» non ha scaricato tutto, e il suo numero può essere più alto per questo: file del font «Inter» non scaricato (HTTP 404); font «Inter»: nessun file scaricato, il sito userà il carattere di ripiego. Rifai il confronto per riprovare."]);
  });

  it("i due siti per l'occhio: l'originale fermo e sigillato sull'origine di cattura, la versione in anteprima", async () => {
    await start({ photographPages });
    const projectId = await capturedProject();
    const before = await (await api(`/api/cms/v1/projects/${projectId}/admin/proposal-compare/view`, { ...json, body: "{}" })).json() as { original: string; built: string | null; pages: Array<{ name: string; path: string }> };
    expect(before.built).toBeNull();
    expect(before.pages).toEqual([{ name: "Home", path: "/" }, { name: "Menu", path: "/menu/" }]);
    expect(before.original).toMatch(new RegExp(`^${server.captureOrigin}/__original/[A-Za-z0-9_-]{32}/$`, "u"));

    const home = await fetch(before.original);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-security-policy")).toBe(stillPolicy({ ancestors: [base, `http://localhost:${server.port}`, "app:"], sealed: true }));
    expect(await home.text()).toContain("Trattoria");
    expect(await (await fetch(`${before.original}menu/`)).text()).toContain("<h1>Menu</h1>");
    const folder = await fetch(`${before.original}menu`, { redirect: "manual" });
    expect(folder.status).toBe(308);
    expect(folder.headers.get("location")).toBe(`${new URL(before.original).pathname}menu/`);
    // Read-only, nothing outside the captured site, and not on the app's own port.
    expect((await fetch(before.original, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${before.original}..%2Fcapture.json`)).status).toBe(404);
    expect((await fetch(`${before.original}%2e%2e/capture.json`)).status).toBe(404);
    expect((await fetch(`${server.captureOrigin}/__original/${"a".repeat(32)}/`)).status).toBe(404);
    expect(await (await fetch(`${base}${new URL(before.original).pathname}`)).text()).toContain("APP-SHELL");

    expect((await api(`/api/cms/v1/projects/${projectId}/build`, { ...json, body: "{}" })).status).toBe(200);
    const after = await (await api(`/api/cms/v1/projects/${projectId}/admin/proposal-compare/view`, { ...json, body: "{}" })).json() as { original: string; built: string };
    expect(after.built).toMatch(/^\/__preview\/[A-Za-z0-9_-]{32}\/[0-9a-f-]{36}\/$/u);
    const built = await fetch(`${base}${after.built}`);
    expect(built.status).toBe(200);
    expect(await built.text()).toContain("Trattoria");
    expect((await fetch(`${base}${after.built}menu/`)).status).toBe(200);
  });
});
