import { randomBytes } from "node:crypto";
import { capturedSiteFiles, readRenderedCapture, RENDERED_CAPTURE_MAX_BYTES, RENDERED_CAPTURE_MAX_PAGES, RENDERED_CAPTURE_SCRIPT, type CapturedSite } from "@histos-publish/cms";
import { HistosPublishError } from "@histos-publish/core";

/**
 * «Fotografa la proposta» with the person: the proposal's file, alive, inside a frame of the app. The person browses
 * it as the client would and presses «Aggiungi questa pagina»; the frame answers with the page as it is drawn at that
 * moment, without scripts (RENDERED_CAPTURE_SCRIPT). The proposal's scripts run only in that frame, which is sealed:
 * an origin of its own (a port of 127.0.0.1 that serves nothing but the proposal), no connection, no form, no window
 * of its own. What the frame sends back is untrusted like any uploaded file and goes through the whole importer.
 *
 * Why an origin of its own and not an opaque one (`sandbox allow-scripts` alone): a viewer writes the proposal into a
 * frame of its own document, and in a page with an opaque origin that inner frame gets another opaque origin, so the
 * viewer's scripts cannot write into it and the proposal stays blank. `allow-same-origin` gives the page the origin
 * it is served from, which is not the app's: it reads nothing of the app, of its storage or of its token.
 */

/** Where the capture origin serves the frame: `/__capture/<ticket>/`. */
export const PROPOSAL_FRAME_PREFIX = "/__capture/";

/**
 * Stricter than the site preview's: no `'self'`, so the frame asks nothing of the server it comes from; scripts only
 * those written in the file; images, style sheets, fonts and media from the network (https) so the proposal looks as
 * the client sees it; no connection, no form, no plugin, no other page inside but the ones its scripts write.
 * `ancestors` are the app's origins: only the app may frame the proposal.
 */
export function proposalFrameCsp(ancestors: readonly string[]): string {
  return `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline' https: data:; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors ${ancestors.length ? ancestors.join(" ") : "'none'"}; sandbox allow-scripts allow-same-origin`;
}

/** The messages between the app and the frame. Anything else is ignored on both sides. */
export const PROPOSAL_FRAME_ASK = "histos-capture";
export const PROPOSAL_FRAME_ANSWER = "histos-captured";
export const PROPOSAL_FRAME_READY = "histos-capture-ready";

/**
 * The bridge, first script of the served page: it answers the app's «capture» with the page as it is now. Only a
 * message from the parent window counts. The target of the answer is `*`: the frame is not told the app's origin,
 * and who may frame this page is decided by `frame-ancestors`.
 */
const BRIDGE = `(() => {
  const capture = ${RENDERED_CAPTURE_SCRIPT};
  const text = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : "");
  let busy = false;
  addEventListener("message", (event) => {
    const data = event.data;
    if (parent === window || event.source !== parent || !data || data.type !== "${PROPOSAL_FRAME_ASK}" || typeof data.id !== "string") return;
    const answer = (value) => parent.postMessage({ type: "${PROPOSAL_FRAME_ANSWER}", id: data.id.slice(0, 64), value }, "*");
    if (busy) { answer({ error: "busy" }); return; }
    busy = true;
    const options = { settleMs: 0, maxBytes: ${RENDERED_CAPTURE_MAX_BYTES} };
    if (data.root === "document") options.root = "document";
    if (text(data.rootSelector, 300).trim()) options.rootSelector = text(data.rootSelector, 300).trim();
    if (Array.isArray(data.remove)) options.remove = data.remove.slice(0, 20).map((selector) => text(selector, 300)).filter(Boolean);
    capture(options).then(answer, (error) => answer({ error: "failed", message: text(String(error && error.message || error), 300) })).finally(() => { busy = false; });
  });
  addEventListener("load", () => { if (parent !== window) parent.postMessage({ type: "${PROPOSAL_FRAME_READY}" }, "*"); });
})();`;

/** The proposal's file with the bridge before everything of its own: after the doctype, so the page keeps its mode. */
export function proposalFrameDocument(html: string): string {
  const bridge = `<script data-histos-capture-bridge>${BRIDGE}</script>`;
  const doctype = /^﻿?(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/iu.exec(html);
  return doctype ? `${html.slice(0, doctype[0].length)}${bridge}${html.slice(doctype[0].length)}` : `${bridge}${html}`;
}

const TICKET = /^[A-Za-z0-9_-]{32}$/u;
const TICKETS_KEPT = 8;

/** The open frames: a ticket names the upload it shows. In memory; a ticket dies with its upload. */
export class ProposalFrames {
  private readonly tickets = new Map<string, string>();

  /** A new ticket for the upload; the one it had, if any, stops working. */
  open(importId: string): string {
    this.closeFor(importId);
    while (this.tickets.size >= TICKETS_KEPT) {
      const oldest = this.tickets.keys().next().value;
      if (oldest === undefined) break;
      this.tickets.delete(oldest);
    }
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, importId);
    return ticket;
  }

  /** The upload a frame address shows, or null: only `/__capture/<ticket>/`, nothing under it. */
  importOf(pathname: string): string | null {
    if (!pathname.startsWith(PROPOSAL_FRAME_PREFIX)) return null;
    const rest = pathname.slice(PROPOSAL_FRAME_PREFIX.length);
    const ticket = rest.endsWith("/") ? rest.slice(0, -1) : "";
    if (!TICKET.test(ticket)) return null;
    return this.tickets.get(ticket) ?? null;
  }

  closeFor(importId: string): void {
    for (const [ticket, id] of this.tickets) if (id === importId) this.tickets.delete(ticket);
  }

  clear(): void {
    this.tickets.clear();
  }
}

/** The headers of the served frame: its policy, never cached, framed by the app only (`ancestors`). */
export function proposalFrameHeaders(bytes: number, ancestors: readonly string[]): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(bytes),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": proposalFrameCsp(ancestors),
  };
}

const refused = (message: string): HistosPublishError => new HistosPublishError(message, "proposal-capture-invalid", 2);

export interface CapturedProposalSite {
  site: CapturedSite;
  /** The site's notes, then each page's own («Menu: 2 canvas diventati immagini ferme»). */
  notes: string[];
}

/**
 * The pages the frame sent back, as the app posts them: `[{ name, hash, html, title?, notes? }]`, the first is the
 * home page. Each one is read as untrusted (readRenderedCapture); the result is the static site the importer converts.
 */
export function capturedProposalSite(input: unknown): CapturedProposalSite {
  if (!Array.isArray(input) || input.length < 1) throw refused("Aggiungi almeno una pagina della proposta.");
  if (input.length > RENDERED_CAPTURE_MAX_PAGES) throw refused(`Una proposta porta al più ${RENDERED_CAPTURE_MAX_PAGES} pagine.`);
  const pages: Array<{ name: string; hash: string; html: string; notes: string[] }> = [];
  for (const [index, item] of input.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw refused(`Pagina ${index + 1}: non è una pagina catturata.`);
    const page = item as Record<string, unknown>;
    const name = typeof page.name === "string" ? page.name.replace(/[\s\p{Cc}]+/gu, " ").trim().slice(0, 80) : "";
    let capture: ReturnType<typeof readRenderedCapture>;
    try {
      capture = readRenderedCapture({ html: page.html, hash: page.hash, title: page.title, notes: page.notes });
    } catch (error) {
      throw refused(`Pagina ${name || index + 1}: ${error instanceof Error ? error.message : "cattura non riuscita."}`);
    }
    if (capture.hash !== "" && (!capture.hash.startsWith("#") || /\s/u.test(capture.hash))) capture.hash = "";
    pages.push({ name, hash: capture.hash, html: capture.html, notes: capture.notes });
  }
  let site: CapturedSite;
  try {
    site = capturedSiteFiles(pages.map((page) => ({ name: page.name, hash: page.hash, html: page.html })));
  } catch (error) {
    throw refused(error instanceof Error ? error.message : "Le pagine catturate non sono valide.");
  }
  const pageNotes = pages.flatMap((page, index) => page.notes.map((note) => `${site.pages[index]?.name ?? page.name}: ${note}`.slice(0, 400)));
  return { site, notes: [...site.notes, ...pageNotes].slice(0, 200) };
}
