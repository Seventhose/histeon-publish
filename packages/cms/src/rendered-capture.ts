import { parse as parseHtml, serialize, type DefaultTreeAdapterMap } from "parse5";

/**
 * «Fotografa la proposta»: a proposal whose pages are drawn by its own scripts (a viewer with the proposal inside)
 * shows the importer an empty viewer, since the importer never runs a script. The capture is the step before it: the
 * proposal is opened in an isolated browser (a sandboxed frame of the app, the hidden window of the desktop app,
 * Playwright in the CLI), left to draw, and the page as it is at that moment is copied without its scripts.
 *
 * This module holds what does not depend on the browser that runs it: the script that copies the page
 * (RENDERED_CAPTURE_SCRIPT), the reading of what it returns, the sign that a file is drawn by scripts, and the static
 * site made of the captured pages, with the links between them. It is pure: no file system, no network.
 *
 * The captured HTML is untrusted like any uploaded file: it goes through every check of the importer
 * (staticSiteToPrototype). What the script removes (scripts, handlers) is a convenience, never the protection.
 */

/** A captured page is refused over this size: the limit of one imported file. */
export const RENDERED_CAPTURE_MAX_BYTES = 100 * 1024 * 1024;
/** The pages of one proposal. */
export const RENDERED_CAPTURE_MAX_PAGES = 20;

export interface RenderedCaptureOptions {
  /** Where the proposal is: "auto" (the same-document frame that fills the window, else the page) or "document". */
  root?: "auto" | "document";
  /** The element that is the proposal, when it is a part of the page: a CSS selector in the document chosen. */
  rootSelector?: string;
  /** Elements of the viewer to leave out of the copy: CSS selectors. */
  remove?: readonly string[];
  /** How long the page's scripts get before the copy, in milliseconds (600 when not given). */
  settleMs?: number;
  /** Refuse a page over this many characters (RENDERED_CAPTURE_MAX_BYTES when not given). */
  maxBytes?: number;
}

export interface RenderedCapture {
  /** The title of the document copied. */
  title: string;
  /** The fragment of the viewer's address when the page was copied ("#p03/home"): what tells the pages apart. */
  hash: string;
  /** The static document: no script, no handler. Untrusted. */
  html: string;
  /** What the copy changed or left out, for the report. */
  notes: string[];
  /** True when the proposal was inside a frame of the viewer. */
  frame: boolean;
  /** The height of the page copied, in CSS pixels. */
  height: number;
}

/**
 * What runs in the page: an async function of RenderedCaptureOptions that returns a RenderedCapture, or
 * `{ error: "root-missing" | "too-large" }`. It only reads the page and builds the copy on a clone; the one thing it
 * changes in the live page is the scroll position (to the bottom and back) and `loading` of lazy images.
 *
 * Kept as text: it is evaluated in a browser, never here. No backtick and no `${` inside.
 */
export const RENDERED_CAPTURE_SCRIPT = String.raw`(async (options) => {
  options = options || {};
  const notes = [];
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  await sleep(typeof options.settleMs === "number" ? Math.max(0, Math.min(10000, options.settleMs)) : 600);
  // 1. Where the proposal is: a frame of this same document that fills the window, or the document itself.
  let doc = document;
  const frames = [...document.querySelectorAll("iframe")].filter((frame) => {
    try {
      const box = frame.getBoundingClientRect();
      return frame.contentDocument && frame.contentDocument.body && box.width * box.height > 0.3 * innerWidth * innerHeight;
    } catch (error) { return false; }
  });
  if (options.root !== "document" && frames.length) doc = frames[0].contentDocument;
  let rootElement = null;
  if (options.rootSelector) {
    try { rootElement = doc.querySelector(options.rootSelector); } catch (error) { rootElement = null; }
    if (!rootElement || rootElement === doc.documentElement || rootElement === doc.body) {
      if (!rootElement) return { error: "root-missing" };
      rootElement = null;
    }
  }
  const win = doc.defaultView;
  // 2. Settling: fonts, then a walk to the bottom and back (reveals on scroll, lazy images), then the images.
  await Promise.race([doc.fonts ? doc.fonts.ready : null, sleep(3000)]);
  const scroller = doc.scrollingElement || doc.documentElement;
  const step = Math.max(200, win.innerHeight - 100);
  for (let y = 0; y < scroller.scrollHeight && y < 60000; y += step) { win.scrollTo({ top: y, behavior: "instant" }); await sleep(90); }
  win.scrollTo({ top: scroller.scrollHeight, behavior: "instant" }); await sleep(150);
  win.scrollTo({ top: 0, behavior: "instant" }); await sleep(250);
  for (const image of doc.images) if (image.loading === "lazy") image.loading = "eager";
  await Promise.race([Promise.all([...doc.images].map((image) => image.complete ? null : new Promise((done) => { image.addEventListener("load", done, { once: true }); image.addEventListener("error", done, { once: true }); }))), sleep(4000)]);
  // 3. The copy, element by element beside the live one: the state only the live page knows goes into attributes.
  const live = rootElement || doc.documentElement;
  const clone = live.cloneNode(true);
  const pairs = [];
  const walk = (a, b) => { pairs.push([a, b]); const ac = a.children, bc = b.children; for (let i = 0; i < ac.length && i < bc.length; i++) walk(ac[i], bc[i]); };
  walk(live, clone);
  let canvases = 0, handlers = 0, shadow = 0, sheets = 0;
  const rulesOf = (sheet) => { try { return [...sheet.cssRules].map((rule) => rule.cssText).join("\n"); } catch (error) { return null; } };
  for (const [a, b] of pairs) {
    const tag = a.localName;
    if (a.shadowRoot) {
      shadow++;
      // A host with nothing of its own showed only its shadow tree, which is not copied: it would be an empty box.
      if (!a.children.length && !a.textContent.trim()) { b.remove(); continue; }
    }
    if (tag === "canvas") {
      let data = "";
      try { data = a.toDataURL("image/png"); } catch (error) { data = ""; }
      const image = doc.createElement("img");
      for (const attr of b.attributes) if (attr.name !== "width" && attr.name !== "height") image.setAttribute(attr.name, attr.value);
      image.setAttribute("src", data); image.setAttribute("alt", "");
      image.setAttribute("width", String(a.width)); image.setAttribute("height", String(a.height));
      b.replaceWith(image); canvases++;
      continue;
    }
    if (tag === "input") {
      if (a.type === "checkbox" || a.type === "radio") { if (a.checked) b.setAttribute("checked", ""); else b.removeAttribute("checked"); }
      else if (a.type !== "password" && a.type !== "file" && a.type !== "hidden" && a.value !== (a.getAttribute("value") || "")) b.setAttribute("value", a.value);
    } else if (tag === "textarea") b.textContent = a.value;
    else if (tag === "option") { if (a.selected) b.setAttribute("selected", ""); else b.removeAttribute("selected"); }
    else if (tag === "details") { if (a.open) b.setAttribute("open", ""); else b.removeAttribute("open"); }
    else if (tag === "style" || (tag === "link" && /(^|\s)stylesheet(\s|$)/i.test(a.getAttribute("rel") || ""))) {
      // A sheet switched off by a script (a theme not chosen) must not come back on in the copy.
      if (a.sheet && a.sheet.disabled) { b.remove(); sheets++; continue; }
      const written = tag === "style" && !a.textContent.trim() && a.sheet ? rulesOf(a.sheet) : null;
      if (written !== null) b.textContent = written;
      else if (tag === "link" && /^blob:/i.test(a.getAttribute("href") || "") && a.sheet) {
        const text = rulesOf(a.sheet);
        if (text !== null) { const style = doc.createElement("style"); style.textContent = text; b.replaceWith(style); continue; }
      }
    }
    for (const attr of [...b.attributes]) {
      if (/^on/i.test(attr.name)) { b.removeAttribute(attr.name); handlers++; }
      else if (/^(href|src|action|formaction|xlink:href)$/i.test(attr.name) && /^[\s\u0000-\u001f]*javascript:/i.test(attr.value)) b.setAttribute(attr.name, "#");
    }
  }
  const dropped = "script, noscript, template, base, meta[http-equiv='refresh' i], link[rel~='preload' i], link[rel~='modulepreload' i], link[rel~='prefetch' i]";
  for (const node of clone.querySelectorAll(dropped)) {
    if (node.localName === "script" && /ld\+json/i.test(node.getAttribute("type") || "")) continue;
    node.remove();
  }
  let removed = 0;
  for (const selector of Array.isArray(options.remove) ? options.remove : []) {
    let found = [];
    try { found = [...clone.querySelectorAll(selector)]; } catch (error) { found = []; }
    for (const node of found) { node.remove(); removed++; }
  }
  const quoted = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  // The attributes of an element kept as a box; "extra" goes after its own inline style, which may hold variables.
  const attributes = (element, extra) => [...element.attributes].filter((attr) => !/^on/i.test(attr.name) && !(extra && attr.name === "style")).map((attr) => " " + attr.name + '="' + quoted(attr.value) + '"').join("") + (extra ? ' style="' + quoted((element.getAttribute("style") || "").replace(/;?\s*$/, ";") + extra) + '"' : "");
  let html;
  if (rootElement) {
    // The proposal is a part of the page. Its ancestors stay around it as empty boxes, so what they give it still
    // holds (selectors, inherited values, variables, a container for @container), without their own measures.
    const flat = "position:static!important;transform:none!important;filter:none!important;contain:none!important;overflow:visible!important;padding:0!important;margin:0!important;border:0!important;max-width:none!important;width:auto!important;height:auto!important;max-height:none!important;min-height:0!important;box-shadow:none!important;border-radius:0!important;display:block!important";
    let inner = clone.outerHTML;
    let kept = 0;
    for (let node = rootElement.parentElement; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
      inner = "<" + node.localName + attributes(node, flat) + ">" + inner + "</" + node.localName + ">";
      kept++;
    }
    const head = [...doc.querySelectorAll("style, link[rel~='stylesheet' i], meta[charset], meta[name='viewport' i], title")].filter((node) => !(node.sheet && node.sheet.disabled)).map((node) => node.localName === "style" && !node.textContent.trim() && node.sheet && rulesOf(node.sheet) !== null ? "<style>" + rulesOf(node.sheet) + "</style>" : node.outerHTML).join("\n");
    html = "<!doctype html><html" + attributes(doc.documentElement) + "><head>" + head + "</head><body" + attributes(doc.body) + ">" + inner + "</body></html>";
    notes.push("la proposta è una parte della pagina (" + options.rootSelector + "): il resto della pagina non è nella cattura" + (kept ? "; " + kept + (kept === 1 ? " contenitore tenuto attorno, senza le sue misure" : " contenitori tenuti attorno, senza le loro misure") : ""));
    // Variables the page wrote on <html> or <body> (a viewer's --doc-alto) stay in this copy, while the converted
    // site keeps only the classes and the language of those two: the proposal's rules that read them may differ there.
    const variables = [];
    for (const [element, name] of [[doc.documentElement, "<html>"], [doc.body, "<body>"]]) {
      const style = element && element.style;
      for (let index = 0; style && index < style.length; index++) {
        if (style[index].startsWith("--")) variables.push(style[index].slice(0, 40) + " (" + style.getPropertyValue(style[index]).trim().slice(0, 30) + ") su " + name);
      }
    }
    if (variables.length) notes.push((variables.length === 1 ? "1 variabile scritta" : variables.length + " variabili scritte") + " dalla pagina su <html> o <body>: " + variables.slice(0, 3).join(", ") + (variables.length > 3 ? "…" : "") + ". Restano nella copia della proposta, il sito costruito non le ha");
  } else {
    if (doc.adoptedStyleSheets && doc.adoptedStyleSheets.length) {
      const style = doc.createElement("style");
      style.textContent = [...doc.adoptedStyleSheets].map((sheet) => rulesOf(sheet) || "").join("\n");
      (clone.querySelector("head") || clone).appendChild(style);
    }
    html = "<!doctype html>" + clone.outerHTML;
  }
  const limit = typeof options.maxBytes === "number" && options.maxBytes > 0 ? options.maxBytes : 104857600;
  if (html.length > limit) return { error: "too-large" };
  if (canvases) notes.push(canvases === 1 ? "1 canvas diventato un'immagine ferma" : canvases + " canvas diventati immagini ferme");
  if (handlers) notes.push(handlers === 1 ? "1 gestore on… tolto" : handlers + " gestori on… tolti");
  if (sheets) notes.push(sheets === 1 ? "1 foglio di stile spento lasciato fuori" : sheets + " fogli di stile spenti lasciati fuori");
  if (removed) notes.push(removed === 1 ? "1 elemento del visore tolto" : removed + " elementi del visore tolti");
  if (shadow) notes.push(shadow === 1 ? "1 elemento con shadow DOM: il suo contenuto non è nella cattura" : shadow + " elementi con shadow DOM: il loro contenuto non è nella cattura");
  return { title: String(doc.title || "").slice(0, 300), hash: String(location.hash || "").slice(0, 500), html, notes, frame: doc !== document, height: scroller.scrollHeight };
})`;

/** The expression a browser evaluates for one capture: the script called with `options`. Its value is a promise. */
export function renderedCaptureExpression(options: RenderedCaptureOptions = {}): string {
  const given: Record<string, unknown> = {};
  if (options.root === "document") given.root = "document";
  if (typeof options.rootSelector === "string" && options.rootSelector.trim() !== "") given.rootSelector = options.rootSelector.trim().slice(0, 300);
  if (options.remove?.length) given.remove = options.remove.slice(0, 20).map((selector) => String(selector).slice(0, 300));
  if (typeof options.settleMs === "number" && Number.isFinite(options.settleMs)) given.settleMs = options.settleMs;
  given.maxBytes = typeof options.maxBytes === "number" && options.maxBytes > 0 ? Math.min(options.maxBytes, RENDERED_CAPTURE_MAX_BYTES) : RENDERED_CAPTURE_MAX_BYTES;
  return `(${RENDERED_CAPTURE_SCRIPT})(${JSON.stringify(given)})`;
}

/**
 * What the script returned, checked: the page ran it beside the proposal's own scripts, so nothing of it is taken on
 * trust. Throws a TypeError with a message for the person when the capture did not happen.
 */
export function readRenderedCapture(value: unknown, options: { maxBytes?: number; rootSelector?: string } = {}): RenderedCapture {
  const max = Math.min(options.maxBytes ?? RENDERED_CAPTURE_MAX_BYTES, RENDERED_CAPTURE_MAX_BYTES);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("La pagina non ha restituito la cattura.");
  const result = value as Record<string, unknown>;
  if (result.error === "root-missing") throw new TypeError(`Il selettore${options.rootSelector ? ` «${options.rootSelector.slice(0, 120)}»` : ""} non trova niente nella pagina: la proposta non è stata catturata.`);
  if (result.error === "too-large") throw new TypeError(`La pagina catturata supera ${Math.round(max / 1024 / 1024)} MB.`);
  const html = result.html;
  if (typeof html !== "string" || html.trim() === "") throw new TypeError("La pagina non ha restituito la cattura.");
  if (html.length > max) throw new TypeError(`La pagina catturata supera ${Math.round(max / 1024 / 1024)} MB.`);
  const text = (item: unknown, limit: number): string => (typeof item === "string" ? item.replace(/\p{Cc}+/gu, " ").trim().slice(0, limit) : "");
  return {
    title: text(result.title, 300),
    hash: text(result.hash, 500),
    html,
    notes: Array.isArray(result.notes) ? result.notes.slice(0, 20).map((note) => text(note, 300)).filter(Boolean) : [],
    frame: result.frame === true,
    height: typeof result.height === "number" && Number.isFinite(result.height) ? Math.max(0, Math.round(result.height)) : 0,
  };
}

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

/** Every element of a parsed document, without recursion (a captured page can nest deep); templates are not entered. */
function elementsOf(root: Node): Element[] {
  const found: Element[] = [];
  const stack: Node[] = [root];
  while (stack.length) {
    const node = stack.pop() as Node;
    if (isElement(node)) found.push(node);
    if ("childNodes" in node) for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push(node.childNodes[index] as Node);
  }
  return found;
}

export interface ScriptRenderedSigns {
  /** True when the file looks drawn by its scripts: converting it as it is would give an empty page. */
  scripted: boolean;
  /** Why, in the person's words; empty when not scripted. */
  reasons: string[];
}

const SCRIPT_BYTES_MIN = 4 * 1024;
const BODY_TEXT_MIN = 400;

/**
 * The signs that an HTML file is a page drawn by scripts (a viewer with the proposal inside): scripts of some size
 * written in the page, and with them a frame without an address, a body with almost no text, or many templates. Only
 * a hint for the app, which then offers the capture beside the plain conversion: nothing is decided on it.
 */
export function scriptRenderedSigns(html: string): ScriptRenderedSigns {
  const document = parseHtml(html);
  let scriptBytes = 0;
  let frames = 0;
  let templates = 0;
  let text = 0;
  const stack: Array<{ node: Node; inBody: boolean }> = [{ node: document, inBody: false }];
  while (stack.length) {
    const { node, inBody } = stack.pop() as { node: Node; inBody: boolean };
    if (node.nodeName === "#text") {
      if (inBody) text += (node as DefaultTreeAdapterMap["textNode"]).value.replace(/\s+/gu, " ").trim().length;
      continue;
    }
    if (!isElement(node)) {
      if ("childNodes" in node) for (const child of node.childNodes) stack.push({ node: child as Node, inBody });
      continue;
    }
    const attr = (name: string): string | undefined => node.attrs.find((item) => item.name === name)?.value;
    if (node.tagName === "script") {
      const type = (attr("type") ?? "").trim().toLowerCase();
      if (attr("src") === undefined && (type === "" || type === "module" || /(?:java|ecma)script/u.test(type))) for (const child of node.childNodes) if (child.nodeName === "#text") scriptBytes += (child as DefaultTreeAdapterMap["textNode"]).value.length;
      continue;
    }
    if (node.tagName === "style" || node.tagName === "noscript") continue;
    if (node.tagName === "template") {
      templates++;
      continue;
    }
    if (node.tagName === "iframe") {
      const src = (attr("src") ?? "").trim().toLowerCase();
      if (src === "" || src === "about:blank" || attr("srcdoc") !== undefined) frames++;
      continue;
    }
    for (const child of node.childNodes) stack.push({ node: child as Node, inBody: inBody || node.tagName === "body" });
  }
  const reasons: string[] = [];
  if (scriptBytes >= SCRIPT_BYTES_MIN) {
    if (frames) reasons.push("la pagina ha un riquadro (iframe) che i suoi script riempiono");
    if (text < BODY_TEXT_MIN) reasons.push("il corpo della pagina è quasi vuoto: il contenuto lo scrivono gli script");
    if (templates >= 3) reasons.push(`la pagina tiene il contenuto in ${templates} modelli (template) che gli script copiano`);
  }
  return { scripted: reasons.length > 0, reasons };
}

export interface CapturedPage {
  /** The name the person gave the page ("Menu"). */
  name: string;
  /** The fragment of the viewer's address the page was captured at ("#p03/menu"), or "". */
  hash: string;
  /** The captured document (RenderedCapture.html). */
  html: string;
}

export interface CapturedSite {
  /** A static site: `index.html` for the first page, `<slug>/index.html` for each other one. */
  files: Array<{ path: string; bytes: Uint8Array }>;
  /** The pages in the order given, with the file of each. */
  pages: Array<{ name: string; slug: string; path: string; hash: string; links: number }>;
  notes: string[];
}

/** A name for a captured page, from the last part of its fragment ("#p03/product/ehi" → "Ehi"), else its title. */
export function capturedPageName(input: { hash?: string; title?: string; index: number }): string {
  if (input.index === 0) return "Home";
  const parts = routeParts(input.hash ?? "");
  const last = parts[parts.length - 1];
  if (last && !/^\d+$/u.test(last)) {
    const words = last.replace(/[-_]+/gu, " ").trim();
    if (words) return `${words.charAt(0).toUpperCase()}${words.slice(1)}`.slice(0, 80);
  }
  const title = (input.title ?? "").replace(/\s+/gu, " ").trim();
  return (title || `Pagina ${input.index + 1}`).slice(0, 80);
}

/** The parts of a route a script reads ("#p03/product/ehi", "product:ehi", "/menu"), lower case. */
function routeParts(route: string): string[] {
  return route.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
}

function slugOf(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60);
}

/**
 * The captured pages as a static site the importer reads: the first is the home page, each other one a folder with
 * its name. A link of a page that pointed to another captured page through the viewer's script now points to that
 * page's file: an `<a>` whose `href` fragment, or one of whose `data-*` values, names the page (the last parts of the
 * fragment it was captured at, or its slug). A fragment that is an anchor of the page itself is left alone, and so is
 * a link that could mean two pages. Everything else stays as captured: the importer decides.
 */
export function capturedSiteFiles(input: readonly CapturedPage[]): CapturedSite {
  if (input.length < 1) throw new TypeError("Serve almeno una pagina catturata.");
  if (input.length > RENDERED_CAPTURE_MAX_PAGES) throw new TypeError(`Una proposta porta al più ${RENDERED_CAPTURE_MAX_PAGES} pagine.`);
  const used = new Set<string>(["index"]);
  const pages = input.map((page, index) => {
    const name = page.name.replace(/\s+/gu, " ").trim().slice(0, 80) || (index === 0 ? "Home" : `Pagina ${index + 1}`);
    let slug = "";
    if (index > 0) {
      const base = slugOf(name) || `pagina-${index + 1}`;
      slug = base;
      for (let count = 2; used.has(slug); count++) slug = `${base}-${count}`;
      used.add(slug);
    }
    return { name, slug, path: index === 0 ? "index.html" : `${slug}/index.html`, hash: page.hash.trim(), parts: routeParts(page.hash), links: 0 };
  });
  /** The one page a route names, or null: a whole fragment first, then the tail of a fragment, then a slug. */
  const pageOf = (route: string): number | null => {
    const value = route.trim();
    if (value === "" || value === "#" || value.length > 200) return null;
    const exact = pages.flatMap((page, index) => (page.hash !== "" && page.hash === value ? [index] : []));
    if (exact.length === 1) return exact[0] as number;
    const parts = routeParts(value);
    if (!parts.length) return null;
    const tail = pages.flatMap((page, index) => (page.parts.length >= parts.length && parts.every((part, at) => page.parts[page.parts.length - parts.length + at] === part) ? [index] : []));
    if (tail.length === 1) return tail[0] as number;
    if (tail.length > 1) return null;
    const named = parts.length === 1 ? pages.flatMap((page, index) => ((index === 0 ? "home" : page.slug) === parts[0] ? [index] : [])) : [];
    return named.length === 1 ? (named[0] as number) : null;
  };
  const addressFrom = (from: number, to: number): string => (from === 0 ? (to === 0 ? "./" : `${pages[to]?.slug}/`) : to === 0 ? "../" : to === from ? "./" : `../${pages[to]?.slug}/`);
  const encoder = new TextEncoder();
  const files = input.map((page, index) => {
    const document = parseHtml(page.html);
    const elements = elementsOf(document);
    const ids = new Set(elements.flatMap((element) => element.attrs.filter((attr) => attr.name === "id").map((attr) => attr.value)));
    for (const element of elements) {
      if (element.tagName !== "a") continue;
      const href = element.attrs.find((attr) => attr.name === "href");
      if (!href) continue;
      const value = href.value.trim();
      if (!value.startsWith("#")) continue;
      let target: number | null = null;
      if (value.length > 1 && !ids.has(value.slice(1))) target = pageOf(value);
      if (target === null && (value === "#" || !ids.has(value.slice(1)))) {
        const named = [...new Set(element.attrs.filter((attr) => attr.name.startsWith("data-") && attr.value.trim() !== "").map((attr) => pageOf(attr.value)).filter((found): found is number => found !== null))];
        if (named.length === 1) target = named[0] as number;
      }
      if (target === null) continue;
      href.value = addressFrom(index, target);
      (pages[index] as { links: number }).links++;
    }
    return { path: (pages[index] as { path: string }).path, bytes: encoder.encode(serialize(document)) };
  });
  const linked = pages.reduce((sum, page) => sum + page.links, 0);
  const notes = [
    `proposta fotografata: ${pages.length === 1 ? "1 pagina" : `${pages.length} pagine`} (${pages.map((page) => page.name).join(", ")})`.slice(0, 400),
    ...(linked ? [`${linked === 1 ? "1 link della proposta collegato" : `${linked} link della proposta collegati`} alle pagine fotografate`] : []),
    "gli script della proposta non sono nel sito: schede e menu da telefono tornano a rispondere con i comportamenti di Histeon dove si può; il resto (filtri, carrelli, moduli) è nell'elenco «da rifare»",
  ];
  return { files, pages: pages.map(({ parts: _parts, ...page }) => page), notes };
}
