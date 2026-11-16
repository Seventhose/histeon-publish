import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog, fontFamilies } from "@histos-publish/cms";
import { fontsData, importGoogleFont, parseVideo, removeFont, videoInfo, type VideoFetcher } from "../src/builder-extras.js";
import type { FontFetcher } from "../src/google-fonts.js";
import { withDocumentScripts } from "../src/cms-api.js";
import { BEHAVIORS_CSS, BEHAVIORS_SCRIPT } from "@histos-publish/cms";

/** The builder's «Font del sito» panel and Video window in Histeon Publish: the answers Histeon for WordPress gives. */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-extras-"));
  roots.push(root);
  return await new CmsProjectCatalog(root, { durable: false }).createProject("Extra");
}
const WOFF2 = (mark: number) => new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, mark]);
const JPEG = new Uint8Array(Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64"));

describe("font del sito nel builder di Publish", () => {
  it("scarica una famiglia del catalogo come media, solo con la licenza verificata, e la toglie", async () => {
    const { project: info, store } = await project();
    const asked: string[] = [];
    const fetcher: FontFetcher = async (url) => {
      asked.push(url);
      if (url === "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/METADATA.pb") return { status: 200, body: new TextEncoder().encode('name: "Inter"\nlicense: "OFL"\n') };
      if (url.startsWith("https://fonts.googleapis.com/css2?family=Inter:ital,wght@")) {
        const [style, weight] = url.split("@")[1]!.split("&")[0]!.split(",");
        const italic = style === "1" ? "italic" : "normal";
        return { status: 200, body: new TextEncoder().encode(`/* latin */\n@font-face {\n  font-family: 'Inter';\n  font-style: ${italic};\n  font-weight: ${weight};\n  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/inter/v1/${weight}${italic}.woff2) format('woff2');\n  unicode-range: U+0000-00FF;\n}\n`) };
      }
      if (url.startsWith("https://fonts.gstatic.com/")) return { status: 200, body: WOFF2(asked.length) };
      return { status: 404, body: new Uint8Array() };
    };
    const answer = await importGoogleFont(store, info.id, { family: "Inter", weights: [400, 700], italic: true }, fetcher);
    expect(answer.families).toEqual([{ family: "Inter", faces: [{ weight: "400", style: "normal" }, { weight: "400", style: "italic" }, { weight: "700", style: "normal" }, { weight: "700", style: "italic" }] }]);
    expect(answer.css).toContain(`/__cms-media/${info.id}/`);
    expect(answer.css).not.toContain("gstatic");
    expect(store.listAssets().filter((asset) => asset.mimeType === "font/woff2")).toHaveLength(4);
    // One request per weight and style: Google refuses a whole request when one of them is missing.
    expect(asked.filter((url) => url.startsWith("https://fonts.googleapis.com/"))).toHaveLength(4);
    expect(asked.every((url) => /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|raw\.githubusercontent\.com)\//u.test(url))).toBe(true);
    const listed = fontsData(store, info.id);
    expect(listed.canManage).toBe(true);
    expect(listed.catalog?.length).toBeGreaterThan(100);

    expect(fontFamilies(removeFont(store, info.id, "Inter") && store.getFontSheet())).toEqual([]);
    expect(() => removeFont(store, info.id, "Inter")).toThrow(/non è nel progetto/u);
    store.close();
  });

  it("rifiuta famiglie fuori dal catalogo, pesi che non ha e un corsivo che non esiste", async () => {
    const { project: info, store } = await project();
    const never: FontFetcher = async () => { throw new Error("nessuna richiesta"); };
    await expect(importGoogleFont(store, info.id, { family: "Inventata", weights: [400] }, never)).rejects.toThrow(/elenco/u);
    await expect(importGoogleFont(store, info.id, { family: "Inter", weights: [450] }, never)).rejects.toThrow(/pesi/u);
    await expect(importGoogleFont(store, info.id, { family: "Abel", weights: [400], italic: true }, never)).rejects.toThrow(/corsivo/u);
    store.close();
  });
});

describe("finestra Video del builder in Publish", () => {
  it("riconosce solo YouTube e Vimeo, con un id valido", () => {
    expect(parseVideo("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ provider: "youtube", id: "dQw4w9WgXcQ" });
    expect(parseVideo("https://youtu.be/dQw4w9WgXcQ")).toEqual({ provider: "youtube", id: "dQw4w9WgXcQ" });
    expect(parseVideo("https://vimeo.com/76979871")).toEqual({ provider: "vimeo", id: "76979871" });
    for (const url of ["https://www.youtube.com/watch?v=corto", "https://example.com/watch?v=dQw4w9WgXcQ", "javascript:alert(1)", "https://vimeo.com/abc"]) expect(parseVideo(url), url).toBeNull();
  });

  it("dà titolo, lettore senza cookie e copertina scaricata una volta nei media", async () => {
    const { project: info, store } = await project();
    const asked: string[] = [];
    const fetcher: VideoFetcher = async (url) => {
      asked.push(url);
      if (url.startsWith("https://www.youtube.com/oembed?")) return { status: 200, body: new TextEncoder().encode(JSON.stringify({ title: "Una <b>lezione</b>", thumbnail_url: "https://evil.example/x.jpg" })) };
      if (url === "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg") return { status: 200, body: JPEG };
      return { status: 404, body: new Uint8Array() };
    };
    const first = await videoInfo(store, info.id, { url: "https://youtu.be/dQw4w9WgXcQ" }, fetcher);
    expect(first).toMatchObject({ provider: "youtube", id: "dQw4w9WgXcQ", title: "Una b lezione /b", watch: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", embed: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", poster: { width: 1, height: 1 } });
    expect(first.poster?.url).toMatch(new RegExp(`^/__cms-media/${info.id}/`, "u"));
    // The poster comes from the provider's image host only, never from the address oEmbed names.
    expect(asked).not.toContain("https://evil.example/x.jpg");
    await videoInfo(store, info.id, { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, fetcher);
    expect(asked.filter((url) => url.includes("ytimg"))).toHaveLength(1);
    await expect(videoInfo(store, info.id, { url: "https://example.com/video" }, fetcher)).rejects.toThrow(/YouTube o Vimeo/u);
    store.close();
  });

  it("sul sito il riquadro del video ha il suo aspetto e diventa il lettore al clic", () => {
    const page = '<!doctype html><html><head><title>x</title></head><body><figure class="xb-video" data-xb-video="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"><a class="xb-video__play" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"><span class="xb-video__icon"></span></a></figure></body></html>';
    const html = withDocumentScripts(page, []);
    // Doc 23 item 120: Histeon's own behaviours, the same script and style as on WordPress.
    expect(html).toContain(`<style>${BEHAVIORS_CSS}</style>`);
    expect(html).toContain("document.querySelectorAll('[data-xb-video]')");
    // The script the page gets is JavaScript that parses.
    expect(() => new Function(BEHAVIORS_SCRIPT)).not.toThrow();
    // Tabs, toggles, reveal and maps get it too, and only the pages that use them.
    for (const attribute of ['data-xb-tabs', 'data-xb-toggle aria-controls="m"', 'data-xb-reveal', 'data-xb-map="https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,4"']) {
      expect(withDocumentScripts(`<html><head></head><body><div ${attribute}>x</div></body></html>`, [])).toContain("Histeon behaviours");
    }
    expect(withDocumentScripts("<html><head></head><body><p>x</p></body></html>", [])).toBe("<html><head></head><body><p>x</p></body></html>");
  });
});
