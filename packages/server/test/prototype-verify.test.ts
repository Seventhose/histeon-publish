import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserCheckWarnings, checkBuiltPages, type OpenPageProbe, type PageProbeInput } from "../src/prototype-verify.js";

/**
 * Doc 17 item 4, with a browser: the module serves the built bundle on 127.0.0.1, opens each page at 1440 and 390 px
 * in the caller's browser and gathers overflow and axe. Here the browser is a stand-in that reads the page from the
 * server and answers as the page would; prototype verify (packages/cli/test) and the app (tests/electron) use real ones.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bundle(pages: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-verify-"));
  roots.push(root);
  for (const [file, html] of Object.entries(pages)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), html);
  }
  return root;
}

const AXE = { source: "/* axe */" };

describe("le pagine della build dell'anteprima in un browser (doc 17, voce 4)", () => {
  it("serve la build, apre ogni pagina alle due larghezze e raccoglie scorrimento e regole axe", async () => {
    const root = await bundle({
      "index.html": "<p>home</p>",
      "chi-siamo/index.html": "<p>chi</p>",
      "404.html": "<p>404</p>",
      ".histos-publish/meta.json": "{}",
    });
    const seen: string[] = [];
    let origin = "";
    let closed = false;
    const open: OpenPageProbe = async (input) => {
      origin = input.origin;
      return {
        probe: async ({ url, width, expression }: PageProbeInput) => {
          expect(expression.startsWith("/* axe */;")).toBe(true);
          const response = await fetch(url);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
          const page = new URL(url).pathname;
          seen.push(`${page} ${width} ${await response.text()}`);
          const narrow = width === 390;
          return {
            width,
            scrollWidth: narrow && page === "/" ? 512 : width,
            elements: narrow && page === "/" ? ["div.hero__titolo"] : [],
            // The same element at both widths counts once; another page adds its own.
            violations: page === "/404.html" ? [] : [{ id: "color-contrast", impact: "serious", help: "Contrasto insufficiente.", helpUrl: "https://example.org/color-contrast", targets: [page === "/" ? ".hero__testo" : ".piede__nota"] }, ...(narrow && page === "/" ? [{ id: "label", impact: "critical", help: "Etichette", helpUrl: "https://example.org/label", targets: ["input"] }] : [])],
          };
        },
        close: async () => { closed = true; },
      };
    };
    const check = await checkBuiltPages(root, open, { axe: AXE });
    expect(seen).toEqual(["/ 1440 <p>home</p>", "/ 390 <p>home</p>", "/404.html 1440 <p>404</p>", "/404.html 390 <p>404</p>", "/chi-siamo/ 1440 <p>chi</p>", "/chi-siamo/ 390 <p>chi</p>"]);
    expect(closed).toBe(true);
    // The server is gone with the check.
    await expect(fetch(`${origin}/`)).rejects.toThrow();
    expect(check).toEqual({
      opened: 3,
      total: 3,
      overflow: [{ page: "/", width: 390, scrollWidth: 512, elements: ["div.hero__titolo"] }],
      axe: [
        { id: "label", impact: "critical", help: "Etichette", helpUrl: "https://example.org/label", pages: ["/"], targets: ["input"], count: 1 },
        { id: "color-contrast", impact: "serious", help: "Contrasto insufficiente.", helpUrl: "https://example.org/color-contrast", pages: ["/", "/chi-siamo/"], targets: [".hero__testo", ".piede__nota"], count: 2 },
      ],
    });
    expect(browserCheckWarnings(check)).toEqual([
      "Scorrimento orizzontale a 390 px: la pagina / è larga 512 px (sporge div.hero__titolo). Restringi quegli elementi a quella larghezza (max-width: 100%, flex-wrap, overflow-wrap: anywhere).",
      "Accessibilità, regola axe label, gravità critica: Etichette. 1 elemento in / (per esempio input). https://example.org/label",
      "Accessibilità, regola axe color-contrast, gravità seria: Contrasto insufficiente. 2 elementi in /, /chi-siamo/ (per esempio .hero__testo, .piede__nota). https://example.org/color-contrast",
    ]);
  });

  it("immagini che il browser non mostra e testo attaccato al bordo (doc 23, voce 242)", async () => {
    const root = await bundle({ "index.html": "<p>home</p>", "chi-siamo/index.html": "<p>chi</p>", "contatti/index.html": "<p>contatti</p>" });
    const open: OpenPageProbe = async () => ({
      probe: async ({ url, width }: PageProbeInput) => {
        const page = new URL(url).pathname;
        const narrow = width === 390;
        return {
          width,
          // A page that scrolls sideways says that already: its text at the edge is not said twice.
          scrollWidth: narrow && page === "/contatti/" ? 480 : width,
          elements: narrow && page === "/contatti/" ? ["table"] : [],
          violations: [],
          // Broken at both widths: said once for the page.
          broken: page === "/" ? ["/media/logo.webp"] : [],
          edges: narrow && page !== "/" ? ["p.lead", "h1"] : [],
        };
      },
      close: async () => undefined,
    });
    const check = await checkBuiltPages(root, open, { axe: AXE });
    expect(check.brokenImages).toEqual([{ page: "/", images: ["/media/logo.webp"] }]);
    expect(check.edges).toEqual([{ page: "/chi-siamo/", width: 390, elements: ["p.lead", "h1"] }]);
    expect(browserCheckWarnings(check)).toEqual([
      "Scorrimento orizzontale a 390 px: la pagina /contatti/ è larga 480 px (sporge table). Restringi quegli elementi a quella larghezza (max-width: 100%, flex-wrap, overflow-wrap: anywhere).",
      "Immagini che il browser non mostra nella pagina /: /media/logo.webp. Il file non si legge (dati inventati o tagliati): usa il file vero, o togli l'immagine.",
      "Testo attaccato al bordo a 390 px nella pagina /chi-siamo/ (p.lead, h1): manca lo spazio ai lati. Dai al contenitore un padding-inline con un token (per esempio var(--xb-gutter) o var(--xb-space-m)).",
    ]);
  });

  it("il server: niente di nascosto, niente fuori dalla build, solo il suo nome; /a è a.html, una cartella senza / va con la /", async () => {
    const root = await bundle({ "index.html": "home", "a.html": "a", "b/index.html": "b", ".histos-publish/meta.json": "{}" });
    const answers: Record<string, number | string> = {};
    const open: OpenPageProbe = async ({ origin }) => ({
      probe: async () => {
        for (const address of ["/a", "/b", "/b/", "/.histos-publish/meta.json", "/%2e%2e/%2e%2e/etc/passwd", "/manca/"]) {
          const response = await fetch(`${origin}${address}`, { redirect: "manual" });
          answers[address] = response.status === 308 ? `308 ${response.headers.get("location")}` : response.status;
        }
        const port = new URL(origin).port;
        answers.host = (await fetch(`http://localhost:${port}/`).catch(() => null))?.status ?? "refused";
        answers.post = (await fetch(`${origin}/`, { method: "POST" })).status;
        return { width: 1440, scrollWidth: 1440, elements: [], violations: [] };
      },
      close: async () => undefined,
    });
    await checkBuiltPages(root, open, { axe: AXE, pageLimit: 1 });
    expect(answers).toEqual({ "/a": 200, "/b": "308 /b/", "/b/": 200, "/.histos-publish/meta.json": 404, "/%2e%2e/%2e%2e/etc/passwd": 404, "/manca/": 404, host: expect.toBeOneOf([404, "refused"]), post: 404 });
  });

  it("una pagina che non si apre si riprova una volta; poi è un avviso, come un browser che non parte; troppe pagine sono una nota", async () => {
    const root = await bundle({ "index.html": "home", "a/index.html": "a", "b/index.html": "b", "b/c/index.html": "c" });
    const tries: Record<string, number> = {};
    const open: OpenPageProbe = async () => ({
      probe: async ({ url, width }) => {
        const page = new URL(url).pathname;
        tries[page] = (tries[page] ?? 0) + 1;
        if (page === "/a/" && tries[page] === 1) throw new Error("navigation dropped");
        if (page === "/b/") throw new Error("net::ERR_FAILED\nstack");
        return { width, scrollWidth: width, elements: [], violations: [] };
      },
      close: async () => undefined,
    });
    const check = await checkBuiltPages(root, open, { axe: AXE, pageLimit: 3 });
    expect(tries).toEqual({ "/": 2, "/a/": 3, "/b/": 2 });
    expect(check).toEqual({ opened: 2, total: 4, overflow: [], axe: [], note: "Aperte nel browser 3 pagine su 4: la pagina iniziale e le meno profonde.", failures: ["La pagina /b/ non si è aperta nel browser (net::ERR_FAILED): le altre sono controllate."] });
    expect(browserCheckWarnings(check)).toEqual(check.failures);

    const broken = await checkBuiltPages(root, async () => { throw new Error("Chromium non parte"); }, { axe: AXE });
    expect(broken).toEqual({ opened: 0, total: 4, overflow: [], axe: [], failures: ["Il browser per il controllo delle pagine non è partito: scorrimento e accessibilità non controllati (Chromium non parte)."] });
  });

  it("annullato, si ferma e chiude browser e server", async () => {
    const root = await bundle({ "index.html": "home", "a/index.html": "a" });
    const controller = new AbortController();
    let closed = false;
    const open: OpenPageProbe = async () => ({
      probe: async ({ width }) => {
        controller.abort();
        return { width, scrollWidth: width, elements: [], violations: [] };
      },
      close: async () => { closed = true; },
    });
    await expect(checkBuiltPages(root, open, { axe: AXE, signal: controller.signal })).rejects.toThrow();
    expect(closed).toBe(true);
  });
});
