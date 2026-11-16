import { describe, expect, it } from "vitest";
import { downloadGoogleFonts, fetchGoogleFontResource, googleFontFamilies, otherScriptCodePoints, type FontFetcher } from "../src/google-fonts.js";

const WOFF2 = new Uint8Array([...Buffer.from("wOF2"), ...new Uint8Array(32)]);
const CSS = `/* cyrillic */
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/inter/cyr.woff2) format('woff2'); unicode-range: U+0400-045F; }
/* latin */
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/inter/latin-400.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131; }
/* latin */
@font-face { font-family: 'Inter'; font-style: normal; font-weight: 700; src: url(https://fonts.gstatic.com/s/inter/latin-700.woff2) format('woff2'); unicode-range: U+0000-00FF; }
/* latin */
@font-face { font-family: 'Sconosciuto'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/s/x/latin.woff2) format('woff2'); unicode-range: U+0000-00FF; }`;

function fakeFetcher(calls: Array<{ url: string; userAgent?: string }>): FontFetcher {
  return async (url, options) => {
    calls.push({ url, ...(options.userAgent ? { userAgent: options.userAgent } : {}) });
    if (url === "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/METADATA.pb") return { status: 200, body: new TextEncoder().encode('name: "Inter"\nlicense: "OFL"\n') };
    if (url.startsWith("https://raw.githubusercontent.com/")) return { status: 404, body: new Uint8Array() };
    if (url.startsWith("https://fonts.googleapis.com/css2")) return { status: 200, body: new TextEncoder().encode(CSS) };
    if (url.startsWith("https://fonts.gstatic.com/")) return { status: 200, body: WOFF2 };
    throw new Error(`host non previsto: ${url}`);
  };
}

describe("Google Fonts come media (B5)", () => {
  it("legge le famiglie dagli indirizzi di Google Fonts e ignora il resto", () => {
    expect(googleFontFamilies([
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Roboto+Slab&display=swap",
      "https://fonts.googleapis.com/css?family=Lato:400,700|Open+Sans",
      "https://evil.example/css2?family=Inter",
      "https://fonts.googleapis.com/css2?family=<script>",
    ])).toEqual(["Inter", "Roboto Slab", "Lato", "Open Sans"]);
  });

  it("scarica solo i WOFF2 latin delle famiglie con licenza verificata, dai soli host ammessi", async () => {
    const calls: Array<{ url: string; userAgent?: string }> = [];
    const result = await downloadGoogleFonts({ cssUrls: ["https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Sconosciuto&display=swap"], fetcher: fakeFetcher(calls) });
    expect(result.files.map((file) => file.path)).toEqual(["histos-fonts/inter-400-normal-latin.woff2", "histos-fonts/inter-700-normal-latin.woff2", "histos-fonts/google-fonts.css"]);
    const css = new TextDecoder().decode(result.files.at(-1)?.bytes);
    expect(css).toContain('src: url("inter-400-normal-latin.woff2") format("woff2");');
    expect(css).toContain("unicode-range: U+0000-00FF, U+0131;");
    expect(css).not.toContain("Sconosciuto");
    expect(result.notes.join("\n")).toContain("«Sconosciuto» non scaricato: licenza non verificata");
    expect(result.notes.join("\n")).toContain("SIL Open Font License");
    // Never the cyrillic subset nor an unverified family; the stylesheet is asked for as a browser.
    expect(calls.map((call) => call.url)).not.toContain("https://fonts.gstatic.com/s/inter/cyr.woff2");
    expect(calls.map((call) => call.url)).not.toContain("https://fonts.gstatic.com/s/x/latin.woff2");
    expect(calls.find((call) => call.url.startsWith("https://fonts.googleapis.com/"))?.userAgent).toMatch(/Chrome/u);
    for (const call of calls) expect(new URL(call.url).hostname).toMatch(/^(fonts\.googleapis\.com|fonts\.gstatic\.com|raw\.githubusercontent\.com)$/u);
  });

  it("senza famiglie verificate non scarica nulla e un file che non è WOFF2 non diventa media", async () => {
    const calls: Array<{ url: string }> = [];
    const none = await downloadGoogleFonts({ cssUrls: ["https://fonts.googleapis.com/css2?family=Sconosciuto"], fetcher: fakeFetcher(calls) });
    expect(none.files).toEqual([]);
    expect(calls.some((call) => call.url.includes("fonts.gstatic.com"))).toBe(false);
    const fake: FontFetcher = async (url, options) => (url.includes("fonts.gstatic.com") ? { status: 200, body: new TextEncoder().encode("<html>") } : fakeFetcher([])(url, options));
    const notWoff = await downloadGoogleFonts({ cssUrls: ["https://fonts.googleapis.com/css2?family=Inter"], fetcher: fake });
    expect(notWoff.files).toEqual([]);
    // A verified family left without files says so: the page would show a fallback font in silence.
    expect(notWoff.notes).toContain("font «Inter»: nessun file scaricato, il sito userà il carattere di ripiego");
    expect(notWoff.notes).toContain("file del font «Inter» non scaricato (non è un WOFF2)");
    expect(notWoff.missing).toEqual(notWoff.notes);
  });

  it("legge anche gli indirizzi «kit» che Google scrive per i file tagliati su richiesta, senza nome .woff2", async () => {
    const kit = (weight: number, range: string, id: string) => `@font-face { font-family: 'Inter'; font-style: normal; font-weight: ${weight}; font-display: swap; src: url(https://fonts.gstatic.com/l/font?kit=${id}&skey=7833cd5b856b60c9&v=v23) format('woff2'); unicode-range: ${range}; }`;
    const calls: string[] = [];
    const fetcher: FontFetcher = async (url, options) => {
      calls.push(url);
      return url.startsWith("https://fonts.googleapis.com/") ? { status: 200, body: new TextEncoder().encode([kit(500, "U+43, U+61", "aaa"), kit(700, "U+43, U+61", "aaa"), kit(700, "U+0400-045F", "bbb")].join("\n")) } : fakeFetcher([])(url, options);
    };
    const result = await downloadGoogleFonts({ cssUrls: ["https://fonts.googleapis.com/css2?family=Inter:wght@500;700&text=Ca"], fetcher });
    // Faces without the comment of their subset: told apart by their range, none hides another.
    expect(result.files.map((file) => file.path)).toEqual(["histos-fonts/inter-500-normal-latin.woff2", "histos-fonts/inter-700-normal-latin.woff2", "histos-fonts/inter-700-normal-latin-2.woff2", "histos-fonts/google-fonts.css"]);
    expect(calls.filter((url) => url.startsWith("https://fonts.gstatic.com/l/font?kit="))).toHaveLength(3);
    expect(result.missing).toEqual([]);
    expect(result.notes).toHaveLength(1);
    const css = new TextDecoder().decode(result.files.at(-1)?.bytes);
    expect(css).toContain('src: url("inter-700-normal-latin-2.woff2") format("woff2");\n  unicode-range: U+0400-045F;');
    expect(css).not.toContain("gstatic");
  });

  it("una variante di una famiglia verificata che non si legge non passa in silenzio", async () => {
    const face = (source: string, range = "U+0000-00FF") => `/* latin */\n@font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; src: ${source}; unicode-range: ${range}; }`;
    const answer = (css: string): FontFetcher => async (url, options) => (url.startsWith("https://fonts.googleapis.com/") ? { status: 200, body: new TextEncoder().encode(css) } : fakeFetcher([])(url, options));
    const cssUrls = ["https://fonts.googleapis.com/css2?family=Inter"];
    // Another host, another format, a range that is not one: never downloaded, and said.
    for (const css of [face("url(https://altrove.example/inter.woff2) format('woff2')"), face("url(https://fonts.gstatic.com/s/inter/a.ttf) format('truetype')"), face("url(https://fonts.gstatic.com/s/inter/a.woff2) format('woff2')", "expression(1)")]) {
      const result = await downloadGoogleFonts({ cssUrls, fetcher: answer(css) });
      expect(result.files).toEqual([]);
      expect(result.missing).toEqual(["font «Inter»: una variante ha un indirizzo o un intervallo di caratteri che non si legge, e non è stata scaricata", "font «Inter»: nessun file scaricato, il sito userà il carattere di ripiego"]);
    }
  });

  it("un file o un foglio che non arriva si chiede una seconda volta; se manca ancora la nota dice perché", async () => {
    const failing = (times: number, how: "rete" | "503") => {
      const failed = new Map<string, number>();
      const calls: string[] = [];
      const fetcher: FontFetcher = async (url, options) => {
        calls.push(url);
        const count = failed.get(url) ?? 0;
        if (!url.startsWith("https://raw.githubusercontent.com/") && count < times) {
          failed.set(url, count + 1);
          if (how === "rete") throw new Error("connect ETIMEDOUT");
          return { status: 503, body: new Uint8Array() };
        }
        return fakeFetcher([])(url, options);
      };
      return { fetcher, calls };
    };
    const cssUrls = ["https://fonts.googleapis.com/css2?family=Inter:wght@400;700"];
    for (const how of ["rete", "503"] as const) {
      const once = failing(1, how);
      const recovered = await downloadGoogleFonts({ cssUrls, fetcher: once.fetcher, retryDelayMs: 0 });
      expect(recovered.files).toHaveLength(3);
      expect(recovered.missing).toEqual([]);
      expect(once.calls.filter((url) => url === "https://fonts.gstatic.com/s/inter/latin-400.woff2")).toHaveLength(2);
    }
    const twice = failing(2, "rete");
    // The stylesheet comes at the third request, which is never made: nothing is downloaded.
    const lost = await downloadGoogleFonts({ cssUrls, fetcher: twice.fetcher, retryDelayMs: 0 });
    expect(lost.files).toEqual([]);
    expect(lost.missing).toEqual(["foglio dei font non scaricato (connect ETIMEDOUT)", "font «Inter»: nessun file scaricato, il sito userà il carattere di ripiego"]);
    // Files that never come: one note for the family, not one for each file, and the success is not among what is missing.
    const never: FontFetcher = async (url, options) => (url === "https://fonts.gstatic.com/s/inter/latin-700.woff2" ? { status: 503, body: new Uint8Array() } : fakeFetcher([])(url, options));
    const partial = await downloadGoogleFonts({ cssUrls, fetcher: never, retryDelayMs: 0 });
    expect(partial.files.map((file) => file.path)).toEqual(["histos-fonts/inter-400-normal-latin.woff2", "histos-fonts/google-fonts.css"]);
    expect(partial.missing).toEqual(["file del font «Inter» non scaricato (HTTP 503)"]);
    expect(partial.notes).toHaveLength(2);
  });

  it("un indirizzo non ammesso non si richiede, e un'interruzione ferma tutto", async () => {
    const calls: string[] = [];
    const refused: FontFetcher = async (url, options) => { calls.push(url); return fetchGoogleFontResource(url.replace("https://raw.githubusercontent.com/", "https://evil.example/"), options); };
    const result = await downloadGoogleFonts({ cssUrls: ["https://fonts.googleapis.com/css2?family=Inter"], fetcher: refused, retryDelayMs: 0 });
    expect(result.files).toEqual([]);
    expect(calls).toHaveLength(3);
    const stop = new AbortController();
    const aborting: FontFetcher = async (url, options) => { if (url.startsWith("https://fonts.googleapis.com/")) { stop.abort(); throw new Error("interrotta"); } return fakeFetcher([])(url, options); };
    await expect(downloadGoogleFonts({ cssUrls: ["https://fonts.googleapis.com/css2?family=Inter"], fetcher: aborting, signal: stop.signal, retryDelayMs: 0 })).rejects.toThrow();
  });

  it("un sottoinsieme non latino si scarica solo se il testo delle pagine usa i suoi caratteri", async () => {
    const cssUrls = ["https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap"];
    expect([...otherScriptCodePoints(["<p>Ciao, perché no?</p>", "<p>Добро</p>"])].map((code) => String.fromCodePoint(code)).join("")).toBe("Добр");
    const latin = await downloadGoogleFonts({ cssUrls, fetcher: fakeFetcher([]), codePoints: otherScriptCodePoints(["<p>Ciao, perché no? Ἀγνή</p>"]) });
    expect(latin.files.map((file) => file.path)).toEqual(["histos-fonts/inter-400-normal-latin.woff2", "histos-fonts/inter-700-normal-latin.woff2", "histos-fonts/google-fonts.css"]);
    const calls: Array<{ url: string }> = [];
    const cyrillic = await downloadGoogleFonts({ cssUrls, fetcher: fakeFetcher(calls), codePoints: otherScriptCodePoints(["<p>Добро пожаловать</p>"]) });
    expect(cyrillic.files.map((file) => file.path)).toEqual(["histos-fonts/inter-400-normal-cyrillic.woff2", "histos-fonts/inter-400-normal-latin.woff2", "histos-fonts/inter-700-normal-latin.woff2", "histos-fonts/google-fonts.css"]);
    expect(new TextDecoder().decode(cyrillic.files.at(-1)?.bytes)).toContain("unicode-range: U+0400-045F;");
    expect(calls.map((call) => call.url)).toContain("https://fonts.gstatic.com/s/inter/cyr.woff2");
  });

  it("il fetcher predefinito rifiuta ogni altro host", async () => {
    await expect(fetchGoogleFontResource("https://evil.example/x.woff2", { maxBytes: 10, accept: "font/woff2" })).rejects.toMatchObject({ code: "fonts-url-invalid" });
    await expect(fetchGoogleFontResource("http://fonts.gstatic.com/x.woff2", { maxBytes: 10, accept: "font/woff2" })).rejects.toMatchObject({ code: "fonts-url-invalid" });
  });
});
