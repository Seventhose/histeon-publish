import { createHash, randomUUID } from "node:crypto";
import { removeTemporary } from "./remove-temporary.js";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { domainToASCII } from "node:url";
import { HistosPublishError } from "@histos-publish/core";
import { buildPrototypeProfile, CmsProjectCatalog, inertPreviewLinks, parsePrototype, validateHistosDesign, verifyPrototypeProfile, type PrototypeAssetFetcher } from "@histos-publish/cms";
import { renderCmsDocumentPage } from "./cms-api.js";
import { fetchPrototypeAsset } from "./prototype-assets.js";
import { prototypeInvalid } from "./prototype-check.js";

/**
 * The proposals page (queue A4): several prototypes, one file to send to the client. Each proposal's pages are
 * rendered as the build renders them and shown side by side, then one at a time at computer, tablet and phone width;
 * the client picks one and, with a contact, writes it in an email. The chosen proposal is already a prototype: it is
 * imported as it is, with nothing to extract.
 *
 * The page is one self-contained file with no network at all. Its policy (CSP) allows only its own script, by hash,
 * and media from the file itself (data: in the file, blob: once the page has decoded them); the previews inherit it.
 * Each preview is a sandboxed frame without scripts, forms or popups; it shares the page's origin only so that the
 * page's script can catch link clicks inside it (a frame may never both run scripts and keep the origin). Their links
 * point at a fragment, with the address aside (inertPreviewLinks). Nothing in the previews reaches the page's own
 * markup: names and texts are set as text.
 */

export const PROPOSALS_MAX = 6;
const PAGES_PER_PROPOSAL = 12;
const MEDIA_MAX_BYTES = 16 * 1024 * 1024;
const OUTPUT_MAX_BYTES = 96 * 1024 * 1024;
const MEDIA_BASE = "/__histos-proposal-media";
/** The types the import produces (PrototypeMediaType): nothing else, SVG above all, ever becomes a media of the page. */
const MEDIA_TYPES = /^(?:image\/(?:png|jpeg|gif|webp|avif)|font\/woff2?)$/u;
/** An address's two halves: RFC 5322 atoms (letters of any script) and a domain of labels, also international. */
const CONTACT_LOCAL = /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-][\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]*(?:\.[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-][\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]*)*$/u;
/** Labels start with a letter or digit; then letters with their marks (Devanagari, decomposed accents), digits, "-". */
const CONTACT_DOMAIN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}-]{0,62}(?:\.[\p{L}\p{N}][\p{L}\p{M}\p{N}-]{0,62})+$/u;
const ASCII_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/u;

/**
 * The contact as shown and as written in the mailto: link, where the local part is percent-encoded and the domain is
 * in ASCII (punycode): nothing in it can become another field, a fragment or a second address. Null if it is not one.
 */
function contactAddress(written: string): { shown: string; address: string } | null {
  const value = written.normalize("NFC");
  if (value.length > 254) return null;
  const at = value.lastIndexOf("@");
  const local = value.slice(0, Math.max(0, at));
  const domain = value.slice(at + 1);
  if (at < 1 || local.length > 64 || !CONTACT_LOCAL.test(local) || !CONTACT_DOMAIN.test(domain)) return null;
  // Checked before converting: domainToASCII would quietly cut a domain at a "?" or a "#".
  const ascii = domainToASCII(domain);
  if (!ascii || ascii.length > 253 || !ASCII_DOMAIN.test(ascii)) return null;
  return { shown: `${local}@${domain}`, address: `${encodeURIComponent(local)}@${ascii}` };
}

export interface ProposalInput {
  /** The file name shown to whoever prepared the proposals (only its last part is kept). */
  file: string;
  html: string;
}

export interface ProposalSummary {
  key: string;
  name: string;
  projectId: string;
  file: string;
  sha256: string;
  pages: number;
}

export interface ProposalsPage {
  html: string;
  proposals: ProposalSummary[];
  notes: string[];
}

const PAGE_SCRIPT_SOURCE = String.raw`(() => {
  "use strict";
  const data = JSON.parse(document.getElementById("histos-proposals-data").textContent);
  const app = document.getElementById("proposte");
  const widths = [["Computer", 1280], ["Tablet", 768], ["Telefono", 390]];
  const storageKey = "histos-proposals:" + data.id;
  // The previews are written by others: what this script does with their documents goes through this page's own
  // prototypes, never through their properties, which an element named like a method (<img name="addEventListener">)
  // would replace.
  const listen = EventTarget.prototype.addEventListener;
  const matches = Element.prototype.matches;
  const readAttribute = Element.prototype.getAttribute;
  const selectAll = Document.prototype.querySelectorAll;
  const shadowOf = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot").get;
  const nodeType = Object.getOwnPropertyDescriptor(Node.prototype, "nodeType").get;
  const SITE = "https://anteprima.invalid";
  let chosen = null;
  try { chosen = window.localStorage.getItem(storageKey); } catch (error) { chosen = null; }
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // Each media becomes one blob: address, made the first time it is used. A data: URI pasted at every use could make
  // a page too long for the browser; a blob: address is short and, like data:, never reaches the network.
  const mediaUrls = new Map();
  const mediaUrl = (hash) => {
    if (mediaUrls.has(hash)) return mediaUrls.get(hash);
    let url = "";
    const source = Object.prototype.hasOwnProperty.call(data.media, hash) ? data.media[hash] : "";
    const comma = source.indexOf(",");
    const type = source.slice(5, comma - 7);
    // Only the image and font types the import makes: an SVG blob would run as this page if opened in a tab.
    const allowed = /^(?:image\/(?:png|jpeg|gif|webp|avif)|font\/woff2?)$/.test(type);
    if (allowed && source.slice(0, 5) === "data:" && source.slice(comma - 7, comma) === ";base64") {
      try {
        const text = atob(source.slice(comma + 1));
        const bytes = new Uint8Array(text.length);
        for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
        url = URL.createObjectURL(new Blob([bytes], { type }));
      } catch (error) {
        url = "";
      }
    }
    mediaUrls.set(hash, url);
    return url;
  };
  const withMedia = (html) => html.replace(/histos-proposal-media:([0-9a-f]{64})/g, (match, hash) => mediaUrl(hash));
  const frame = (label) => {
    const node = make("iframe");
    node.setAttribute("sandbox", "allow-same-origin");
    node.setAttribute("referrerpolicy", "no-referrer");
    node.title = label;
    // Nothing in it can be clicked or reached until this script listens to it (ready, below).
    node.inert = true;
    return node;
  };
  // false when the browser cannot hold the page: the others still show.
  const fill = (node, html) => {
    try {
      node.srcdoc = withMedia(html);
      return true;
    } catch (error) {
      return false;
    }
  };
  const fit = (box, node, width, height) => {
    // A hidden box has no size: it is laid out again when it shows.
    if (!box.clientWidth) return;
    const scale = Math.min(1, box.clientWidth / width);
    node.style.width = width + "px";
    node.style.height = (height || box.clientHeight / scale) + "px";
    node.style.transform = "scale(" + scale + ")";
  };
  const swatches = (proposal) => {
    const list = make("ul", "design");
    for (const [label, value] of [["Colore principale", proposal.design.primary], ["Colore secondario", proposal.design.secondary]]) {
      if (!value) continue;
      const item = make("li");
      const dot = make("span", "swatch");
      dot.style.setProperty("background-color", value);
      item.append(dot, make("span", "", label));
      list.append(item);
    }
    for (const [label, value] of [["Testo", proposal.design.fontBody], ["Titoli", proposal.design.fontHeading]]) {
      if (value) list.append(make("li", "", label + ": " + value.split(",")[0].replace(/["']/g, "").trim()));
    }
    return list;
  };

  const intro = make("p", "intro", data.proposals.length === 1 ? "Una proposta: guardala a misura di computer, tablet e telefono." : data.proposals.length + " proposte: guardale una per una a misura di computer, tablet e telefono, poi scegli quella che preferisci.");
  const grid = make("section", "grid");
  grid.setAttribute("aria-label", "Tutte le proposte");
  const detail = make("section", "detail");
  detail.hidden = true;
  const thumbs = [];
  const cards = new Map();
  app.append(intro, grid, detail);

  const markChosen = () => {
    for (const [key, card] of cards) card.classList.toggle("chosen", key === chosen);
  };

  data.proposals.forEach((proposal, index) => {
    const card = make("article", "card");
    const thumb = make("div", "thumb");
    // A picture of the home page: it stays inert, out of the tab order and of screen readers.
    const preview = frame("Anteprima della pagina iniziale di " + proposal.name);
    preview.tabIndex = -1;
    preview.setAttribute("aria-hidden", "true");
    if (fill(preview, proposal.pages[0].html)) {
      thumb.append(preview);
      thumbs.push([thumb, preview]);
    } else {
      thumb.append(make("p", "notice", "Anteprima non disponibile in questo browser."));
    }
    const heading = make("h2", "", proposal.name);
    const badge = make("span", "badge", "Scelta");
    heading.append(" ", badge);
    const open = make("button", "primary", "Guarda la proposta");
    open.type = "button";
    open.addEventListener("click", () => show(index, 0));
    card.append(thumb, heading, swatches(proposal), make("p", "pages", proposal.pages.length === 1 ? "1 pagina" : proposal.pages.length + " pagine"), open);
    cards.set(proposal.key, card);
    grid.append(card);
  });
  markChosen();

  let current = null;
  let width = 1280;
  let lastIndex = 0;
  const back = make("button", "back", "← Tutte le proposte");
  back.type = "button";
  const title = make("h2");
  title.tabIndex = -1;
  const pageBar = make("div", "toolbar");
  pageBar.setAttribute("role", "group");
  pageBar.setAttribute("aria-label", "Pagine");
  const widthBar = make("div", "toolbar");
  widthBar.setAttribute("role", "group");
  widthBar.setAttribute("aria-label", "Misura dello schermo");
  const stage = make("div", "stage");
  const notice = make("p", "notice");
  notice.setAttribute("role", "status");
  const choose = make("button", "primary", "Scelgo questa proposta");
  choose.type = "button";
  const choice = make("p", "choice");
  choice.setAttribute("role", "status");
  detail.append(back, title, swatches({ design: {} }), pageBar, widthBar, stage, notice, choose, choice);

  const layout = () => {
    if (current) fit(stage, current.frame, width, 0);
    for (const [box, node] of thumbs) fit(box, node, 1280, 800);
  };
  back.addEventListener("click", () => {
    detail.hidden = true;
    grid.hidden = false;
    intro.hidden = false;
    current = null;
    layout();
    const card = cards.get(data.proposals[lastIndex].key);
    if (card) card.querySelector("button").focus();
  });
  for (const [label, value] of widths) {
    const button = make("button", "", label + " · " + value + " px");
    button.type = "button";
    button.dataset.width = String(value);
    button.addEventListener("click", () => {
      width = value;
      for (const other of widthBar.children) other.setAttribute("aria-pressed", String(other === button));
      layout();
    });
    button.setAttribute("aria-pressed", String(value === width));
    widthBar.append(button);
  }

  // A real fragment navigation of the frame, as on the site: the browser scrolls and CSS :target applies. The address
  // is absolute (the frame's own), so it never resolves against this page's; replace() adds no history entries.
  const jump = (node, hash) => {
    try { node.contentWindow.location.replace("about:srcdoc" + (hash || "#")); } catch (error) { /* it stays where it is */ }
  };
  const linkOf = (event) => {
    for (const item of event.composedPath()) {
      let element = false;
      try { element = nodeType.call(item) === 1; } catch (error) { element = false; }
      if (element && matches.call(item, "a, area")) return item;
    }
    return null;
  };
  const follow = (event, node) => {
    const link = linkOf(event);
    if (!link) return;
    event.preventDefault();
    // The server moved each link's address to data-histos-href; its href only points at a fragment.
    const href = readAttribute.call(link, "data-histos-href");
    if (href === null) return;
    // Resolved as the published page would resolve it: schemes, //, backslashes and spaces read as browsers read them.
    const here = SITE + (current && current.slug !== "home" ? "/" + current.slug + "/" : "/");
    let url = null;
    try { url = new URL(href, here); } catch (error) { url = null; }
    if (!url || url.origin !== SITE) {
      notice.textContent = "Nell'anteprima i link verso altri siti non si aprono: " + href;
      return;
    }
    const page = /^\/(?:([a-z0-9-]+)\/?)?$/.exec(url.pathname);
    const slug = page ? page[1] || "home" : null;
    if (slug && current && slug === current.slug && url.search === "") {
      jump(node, url.hash);
      return;
    }
    if (slug && showPage(slug, url.hash)) return;
    notice.textContent = "Questa pagina non è nell'anteprima: " + href;
  };
  // The frame becomes usable only once this script listens to its clicks; if it cannot, it stays inert.
  const ready = (node, hash) => {
    try {
      const inner = node.contentDocument;
      if (!inner) throw new Error("no document");
      listen.call(inner, "click", (event) => follow(event, node), true);
      // A middle click would open the link's fragment in a new tab: nothing to see there.
      listen.call(inner, "auxclick", (event) => { if (linkOf(event)) event.preventDefault(); }, true);
      // A second guard on the server's rewrite: if a link of the frame still has another address (a markup two parsers
      // read differently), the frame stays inert.
      for (const link of selectAll.call(inner, "a[href], area[href]")) {
        if (readAttribute.call(link, "href") !== "#histos-preview-link") throw new Error("live link");
      }
      // Links in a shadow root are out of that check's sight (the server already turns declarative ones off).
      for (const element of selectAll.call(inner, "*")) if (shadowOf.call(element)) throw new Error("shadow root");
    } catch (error) {
      notice.textContent = "Questa anteprima non risponde ai link: usa i pulsanti delle pagine.";
      return;
    }
    node.inert = false;
    if (hash) jump(node, hash);
  };

  const showPage = (slug, hash) => {
    const proposal = data.proposals[lastIndex];
    const page = proposal.pages.find((item) => item.slug === slug);
    if (!page) return false;
    stage.replaceChildren();
    notice.textContent = "";
    const node = frame("Anteprima di " + proposal.name + ": " + page.title);
    node.addEventListener("load", () => ready(node, hash));
    if (fill(node, page.html)) {
      stage.append(node);
      current = { frame: node, slug };
    } else {
      current = null;
      notice.textContent = "Questa pagina è troppo grande per il browser: prova le altre.";
    }
    for (const button of pageBar.children) button.setAttribute("aria-pressed", String(button.dataset.slug === slug));
    layout();
    return true;
  };

  const show = (index, pageIndex) => {
    lastIndex = index;
    const proposal = data.proposals[index];
    title.textContent = proposal.name;
    detail.replaceChild(swatches(proposal), detail.children[2]);
    pageBar.replaceChildren();
    for (const page of proposal.pages) {
      const button = make("button", "", page.title || page.slug);
      button.type = "button";
      button.dataset.slug = page.slug;
      button.addEventListener("click", () => showPage(page.slug, ""));
      pageBar.append(button);
    }
    if (proposal.omittedPages) pageBar.append(make("span", "more", "e altre " + proposal.omittedPages));
    choice.replaceChildren();
    choose.hidden = false;
    grid.hidden = true;
    intro.hidden = true;
    detail.hidden = false;
    showPage(proposal.pages[pageIndex].slug, "");
    if (chosen === proposal.key) confirm(proposal);
    title.focus();
  };

  const confirm = (proposal) => {
    choice.replaceChildren(make("strong", "", "Hai scelto «" + proposal.name + "»."));
    if (data.contact) {
      const mail = make("a", "", "Scrivilo a " + data.contact);
      // Names on one line: a line break in a subject could read as another mail header in some clients.
      // Well formed too: a lone surrogate would make encodeURIComponent throw.
      const plain = (text) => (typeof text.toWellFormed === "function" ? text.toWellFormed() : text).replace(/[\u0000-\u001f\u007f]+/g, " ");
      const subject = "Scelgo la proposta «" + plain(proposal.name) + "»";
      const body = "Ho scelto la proposta «" + plain(proposal.name) + "» fra quelle di «" + plain(data.title) + "».\n\nRiferimento: " + proposal.sha256.slice(0, 12);
      // The address was checked and encoded on the server: its parts cannot add fields to the link.
      mail.href = "mailto:" + data.contactAddress + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
      choice.append(" ", mail);
    } else {
      choice.append(" Comunicalo a chi ti ha mandato le proposte.");
    }
  };

  choose.addEventListener("click", () => {
    const proposal = data.proposals[lastIndex];
    chosen = proposal.key;
    try { window.localStorage.setItem(storageKey, chosen); } catch (error) { /* a file opened without storage keeps the choice until it closes */ }
    markChosen();
    confirm(proposal);
  });

  new ResizeObserver(layout).observe(document.documentElement);
  layout();
})();`;

/** Each UTF-16 unit outside ASCII, surrogates of an emoji one by one: written as \uXXXX it reads the same in any charset. */
const ASCII_ONLY = /[\u007f-\uffff]/g;

/**
 * The script in ASCII only (its texts as \u escapes): a host that serves the page with another charset would read
 * other bytes, and the hash in the policy would no longer match.
 */
const PAGE_SCRIPT = PAGE_SCRIPT_SOURCE.replace(ASCII_ONLY, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
const PAGE_SCRIPT_HASH = createHash("sha256").update(PAGE_SCRIPT, "utf8").digest("base64");

const PAGE_STYLE = `
:root { color-scheme: light dark; --bg: #f7f6f3; --fg: #1d1c1a; --muted: #55524c; --card: #ffffff; --line: #d9d5cc; --accent: #1f5f8b; --accent-fg: #ffffff; --chosen: #1e6b3a; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #f1efea; --muted: #b9b4aa; --card: #22211f; --line: #3d3a35; --accent: #8cc4ec; --accent-fg: #0c1b26; --chosen: #7fd29b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
header, main, footer { max-width: 84rem; margin: 0 auto; padding: 1.5rem 1rem; }
h1 { font-size: 1.75rem; line-height: 1.2; margin: 0; }
.intro, .pages, .more, footer { color: var(--muted); }
.grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 0.75rem; padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
.card h2 { font-size: 1.25rem; margin: 0.5rem 0 0; }
.badge { display: none; font-size: 0.8rem; font-weight: 600; color: var(--chosen); border: 1px solid currentColor; border-radius: 999px; padding: 0 0.5rem; vertical-align: middle; }
.card.chosen { border-color: var(--chosen); box-shadow: 0 0 0 2px var(--chosen); }
.card.chosen .badge { display: inline-block; }
.thumb { aspect-ratio: 16 / 10; overflow: hidden; border: 1px solid var(--line); border-radius: 0.5rem; background: #fff; position: relative; }
.thumb iframe { pointer-events: none; }
iframe { border: 0; display: block; transform-origin: 0 0; background: #fff; }
.stage iframe { margin: 0 auto; }
.design { list-style: none; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; padding: 0; margin: 0; font-size: 0.9rem; }
.design li { display: flex; align-items: center; gap: 0.35rem; }
.swatch { width: 1rem; height: 1rem; border-radius: 50%; border: 1px solid var(--line); display: inline-block; }
button { font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.4rem 0.8rem; cursor: pointer; }
button[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; align-self: flex-start; }
button:focus-visible, a:focus-visible, h2:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.back { margin-bottom: 1rem; }
.detail h2 { font-size: 1.5rem; margin: 0 0 0.5rem; }
.toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0 0; align-items: center; }
.stage { height: 75vh; margin-top: 1rem; overflow: hidden; border: 1px solid var(--line); border-radius: 0.5rem; background: #fff; }
.notice:empty, .choice:empty { display: none; }
.notice { color: var(--muted); }
.choice { font-size: 1.1rem; }
a { color: var(--accent); }
[hidden] { display: none !important; }
`;

/** Text for HTML: names and titles come from the prototypes. */
function htmlText(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

const HEX = "0123456789abcdef";
const escaped = (code: number) => code === 0x3c || code === 0x3e || code === 0x26 || code >= 0x7f;

/**
 * JSON for inside a <script>, in ASCII: <, > and & and every UTF-16 unit outside ASCII (an emoji's two halves one by
 * one) become \uXXXX, so nothing can close the element and the text reads the same whatever charset a host declares.
 * Written into a buffer in one pass, without a regular expression: a page can hold millions of escapes.
 */
function asciiJson(value: unknown): string {
  const json = JSON.stringify(value) ?? "null";
  let count = 0;
  for (let index = 0; index < json.length; index++) if (escaped(json.charCodeAt(index))) count++;
  if (count === 0) return json;
  const out = Buffer.allocUnsafe(json.length + count * 5);
  let at = 0;
  for (let index = 0; index < json.length; index++) {
    const code = json.charCodeAt(index);
    if (!escaped(code)) {
      out[at++] = code;
      continue;
    }
    out[at++] = 0x5c;
    out[at++] = 0x75;
    for (const shift of [12, 8, 4, 0]) out[at++] = HEX.charCodeAt((code >> shift) & 15);
  }
  return out.toString("latin1");
}

const designText = (value: unknown): string | undefined => (typeof value === "string" && value.length <= 200 ? value : undefined);

export async function buildProposalsPage(inputs: readonly ProposalInput[], options: { scratchRoot: string; title?: string; contact?: string; download?: boolean; fetchAsset?: PrototypeAssetFetcher; signal?: AbortSignal; /** A lower size limit (tests); it can never go above 96 MB. */ maxBytes?: number }): Promise<ProposalsPage> {
  const limit = options.maxBytes;
  const maxBytes = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.min(OUTPUT_MAX_BYTES, limit) : OUTPUT_MAX_BYTES;
  if (inputs.length < 1 || inputs.length > PROPOSALS_MAX) throw new HistosPublishError(`La pagina delle proposte ne affianca da 1 a ${PROPOSALS_MAX}.`, "cms-proposals-invalid", 422);
  // Well formed (a lone surrogate would break the mail link) and cut by characters, not UTF-16 units.
  const title = Array.from(Buffer.from((options.title ?? "Proposte").trim(), "utf8").toString("utf8")).slice(0, 200).join("") || "Proposte";
  const written = options.contact?.trim() || null;
  const contact = written === null ? null : contactAddress(written);
  if (written !== null && contact === null) throw new HistosPublishError("Il contatto deve essere un indirizzo email, come nome@dominio.it.", "cms-proposals-invalid", 422);
  const seen = new Set<string>();
  const ids = new Map<string, string>();
  const notes: string[] = [];
  const media: Record<string, string> = {};
  let mediaBytes = 0;
  // The page's own script, style and frame are written too: they count from the start.
  let pageBytes = PAGE_SCRIPT.length + PAGE_STYLE.length + 4096 + title.length * 12 + asciiJson(contact).length;
  const tooLarge = () => new HistosPublishError(`La pagina delle proposte supererebbe i ${Math.round(maxBytes / 1024 / 1024)} MB (media ${Math.ceil(mediaBytes / 1024 / 1024)} MB): togli una proposta o alleggerisci i media.`, "cms-proposals-too-large", 413);
  /** Each page's html is kept as its JSON string, already escaped: what is counted is what is written. */
  const proposals: Array<Omit<ProposalSummary, "pages"> & { design: Record<string, string | undefined>; pages: Array<{ slug: string; title: string; json: string }>; omittedPages: number }> = [];
  await mkdir(options.scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = path.join(options.scratchRoot, `.proposals-${randomUUID()}`);
  try {
    for (const [index, input] of inputs.entries()) {
      options.signal?.throwIfAborted();
      const file = path.basename(input.file).slice(0, 200);
      const sha256 = createHash("sha256").update(input.html, "utf8").digest("hex");
      if (seen.has(sha256)) throw new HistosPublishError(`${file}: lo stesso prototipo è già fra le proposte.`, "cms-proposals-invalid", 422);
      seen.add(sha256);
      const where = path.join(scratch, String(index));
      let built: Awaited<ReturnType<typeof buildPrototypeProfile>>;
      let design: Record<string, unknown> = {};
      /** Each page's place in the file: the previews follow the prototype's order. */
      const order = new Map<string, number>();
      const catalog = new CmsProjectCatalog(path.join(where, "verify"), { durable: false });
      try {
        const parsed = parsePrototype(input.html);
        // Two proposals with one id would be one project in Publish: the second import would update the first.
        const twin = ids.get(parsed.manifest.id);
        if (twin) throw new HistosPublishError(`${file}: ha lo stesso id di ${twin}. Ogni proposta è un prototipo con il suo id.`, "cms-proposals-invalid", 422);
        ids.set(parsed.manifest.id, file);
        for (const document of parsed.documents) if (document.kind === "page") order.set(document.attributes["data-slug"] ?? "", order.size);
        if (parsed.manifest.design) design = validateHistosDesign(parsed.manifest.design);
        const signal = options.signal ? { signal: options.signal } : {};
        built = await buildPrototypeProfile(parsed, new CmsProjectCatalog(path.join(where, "build"), { durable: false }), options.download ? { fetchAsset: options.fetchAsset ?? fetchPrototypeAsset, ...signal } : { remotePlaceholders: true, ...signal });
        await verifyPrototypeProfile(built, catalog);
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) throw prototypeInvalid(error, file);
        throw error;
      }
      if (built.report.placeholders.length) notes.push(`${file}: ${built.report.placeholders.length === 1 ? "un'immagine remota è un segnaposto" : `${built.report.placeholders.length} immagini remote sono segnaposto`}; con il download si vedono quelle vere.`);
      const projectId = built.report.project.id;
      const opened = await catalog.openProject(projectId);
      if (!opened) throw new HistosPublishError(`${file}: il progetto controllato non è leggibile.`, "cms-proposals-failed", 500);
      const pages: Array<{ slug: string; title: string; json: string }> = [];
      const omitted: string[] = [];
      try {
        const { store } = opened;
        // In the prototype's order, the home page first.
        const place = (slug: string) => (slug === "home" ? -1 : order.get(slug) ?? Number.MAX_SAFE_INTEGER);
        const published = store.listPages().filter((page) => page.status === "published").sort((a, b) => place(a.slug) - place(b.slug));
        for (const page of published) {
          if (pages.length >= PAGES_PER_PROPOSAL) {
            omitted.push(page.slug);
            continue;
          }
          options.signal?.throwIfAborted();
          const revision = store.getHead(page.id);
          if (!revision) continue;
          let rendered: Awaited<ReturnType<typeof renderCmsDocumentPage>>;
          // Errors name the file and the page, for whoever prepares the proposals.
          const named = (error: unknown): never => {
            if (error instanceof HistosPublishError) throw new HistosPublishError(`${file}, pagina ${page.slug}: ${error.message}`, error.code, error.exitCode);
            if (error instanceof TypeError) throw new HistosPublishError(`${file}, pagina ${page.slug}: ${error.message}`, "cms-proposals-invalid", 422);
            throw error;
          };
          try {
            rendered = await renderCmsDocumentPage({ store, projectId, document: page, content: revision.content, mediaBase: MEDIA_BASE });
          } catch (error) {
            named(error);
            throw error;
          }
          let html = rendered.html;
          for (const asset of rendered.assets) {
            html = html.replaceAll(`${MEDIA_BASE}/${projectId}/${asset.id}`, `histos-proposal-media:${asset.sha256}`);
            if (media[asset.sha256] !== undefined) continue;
            // Its key and quotes in the data block, written once per media.
            mediaBytes += 70;
            if (!MEDIA_TYPES.test(asset.mimeType) || asset.bytes.byteLength > MEDIA_MAX_BYTES) {
              media[asset.sha256] = "";
              notes.push(`${file}: il media ${asset.filename} (${asset.mimeType}, ${Math.ceil(asset.bytes.byteLength / 1024 / 1024)} MB) non è nell'anteprima: la pagina delle proposte tiene media fino a 16 MB.`);
              continue;
            }
            const uri = `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
            media[asset.sha256] = uri;
            mediaBytes += uri.length;
            // Stop as soon as the page could no longer be written, not after building it in memory.
            if (mediaBytes + pageBytes > maxBytes) throw tooLarge();
          }
          // Whatever still points at the media address would be a request the page cannot make.
          let json: string;
          try {
            json = asciiJson(inertPreviewLinks(html.replaceAll(MEDIA_BASE, "histos-proposal-media:missing")));
          } catch (error) {
            named(error);
            throw error;
          }
          pageBytes += json.length + page.slug.length + page.title.length * 6 + 32;
          if (mediaBytes + pageBytes > maxBytes) throw tooLarge();
          pages.push({ slug: page.slug, title: page.title, json });
        }
      } finally {
        opened.store.close();
      }
      if (pages.length === 0) throw new HistosPublishError(`${file}: il prototipo non ha pagine pubblicate da mostrare.`, "cms-proposals-invalid", 422);
      if (omitted.length) notes.push(`${file}: nell'anteprima ci sono le prime ${PAGES_PER_PROPOSAL} pagine pubblicate, nell'ordine del prototipo; restano fuori ${omitted.slice(0, 5).join(", ")}${omitted.length > 5 ? ` e altre ${omitted.length - 5}` : ""}.`);
      // The name, file, digest and design appear in the data and in the footer.
      const designData = { primary: designText(design.primary), secondary: designText(design.secondary), fontBody: designText(design.font_body), fontHeading: designText(design.font_heading) };
      pageBytes += (built.report.project.name.length + file.length) * 12 + asciiJson(designData).length + 256;
      if (mediaBytes + pageBytes > maxBytes) throw tooLarge();
      proposals.push({
        key: `p${index + 1}`,
        name: built.report.project.name,
        projectId,
        file,
        sha256,
        pages,
        omittedPages: omitted.length,
        design: designData,
      });
      await rm(where, { recursive: true, force: true });
    }
  } finally {
    await removeTemporary(scratch);
  }
  const id = createHash("sha256").update(proposals.map((proposal) => proposal.sha256).join(":")).digest("hex").slice(0, 32);
  // The data block from pieces already escaped: the pages are never escaped (or copied) a second time.
  const proposalJson = (proposal: (typeof proposals)[number]) => `{"key":${asciiJson(proposal.key)},"name":${asciiJson(proposal.name)},"sha256":${asciiJson(proposal.sha256)},"design":${asciiJson(proposal.design)},"omittedPages":${proposal.omittedPages},"pages":[${proposal.pages.map((page) => `{"slug":${asciiJson(page.slug)},"title":${asciiJson(page.title)},"html":${page.json}}`).join(",")}]}`;
  const mediaJson = Object.entries(media).map(([hash, uri]) => `${asciiJson(hash)}:${asciiJson(uri)}`).join(",");
  const data = `{"id":${asciiJson(id)},"title":${asciiJson(title)},"contact":${asciiJson(contact?.shown ?? null)},"contactAddress":${asciiJson(contact?.address ?? null)},"proposals":[${proposals.map(proposalJson).join(",")}],"media":{${mediaJson}}}`;
  const policy = `default-src 'none'; script-src 'sha256-${PAGE_SCRIPT_HASH}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'`;
  const sources = proposals.map((proposal) => `<li>${htmlText(proposal.name)}: <code>${htmlText(proposal.file)}</code>, sha256 <code>${proposal.sha256}</code></li>`).join("");
  // The byte order mark makes browsers read UTF-8 even when a host declares another charset.
  const html = `\uFEFF<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Histeon Publish">
<title>${htmlText(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<header><h1>${htmlText(title)}</h1></header>
<main id="proposte"><noscript><p>Per vedere le anteprime serve JavaScript attivo nel browser.</p></noscript></main>
<footer><details><summary>Per chi ha preparato le proposte</summary><p>Ogni proposta è un prototipo Histeon: quella scelta si importa così com'è in Histeon Publish.</p><ul>${sources}</ul></details><p>Pagina creata con Histeon Publish.</p></footer>
<script type="application/json" id="histos-proposals-data">${data}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
  if (Buffer.byteLength(html, "utf8") > maxBytes) throw tooLarge();
  return { html, proposals: proposals.map(({ key, name, projectId, file, sha256, pages }) => ({ key, name, projectId, file, sha256, pages: pages.length })), notes };
}
