import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Doc 17 item 4, the part without a browser: the internal links of a built preview that lead nowhere. Every
 * `<a href>` of the bundle's pages that starts with one `/` must have its page (`index.html` of the folder, or the file
 * itself, or `<path>.html` and `<path>/index.html` as a static host serves them). A link with `?` or `#` is checked
 * for its path; an address another host serves (`//…`, `https:`), `mailto:` and the like are not this check's.
 */

/** One address that has no page, the pages that link to it (at most PAGES_KEPT), and how many there are. */
export interface BrokenLink {
  href: string;
  pages: string[];
  count: number;
}

export interface LinkCheck {
  /** The pages read. */
  pages: number;
  /** At most LINKS_KEPT addresses, those linked from most pages first. */
  brokenLinks: BrokenLink[];
  /** How many addresses have no page, in all. */
  brokenTotal: number;
}

const PAGES_READ = 20_000;
const PAGE_BYTES_READ = 8 * 1024 * 1024;
const LINKS_KEPT = 50;
const PAGES_KEPT = 5;

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", quot: "\"", apos: "'", lt: "<", gt: ">" };

function decodeAttribute(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/giu, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal || hex) {
      const code = Number.parseInt(decimal ?? hex ?? "", decimal ? 10 : 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[(name ?? "").toLowerCase()] ?? whole;
  });
}

/** The `href` of each `<a>` of a page as the renderer writes it: attributes in quotes, or without them. */
export function pageLinks(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.matchAll(/<a\b[^>]*>/giu)) {
    const found = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/iu.exec(tag[0]);
    if (found) out.push(decodeAttribute(found[1] ?? found[2] ?? found[3] ?? "").trim());
  }
  return out;
}

/** The page address of a bundle file (`a/index.html` is `/a/`, `404.html` is `/404.html`). */
function pageAddress(file: string): string {
  const posix = file.split(path.sep).join("/");
  if (posix === "index.html") return "/";
  return posix.endsWith("/index.html") ? `/${posix.slice(0, -"index.html".length)}` : `/${posix}`;
}

/** The internal path of a link, decoded, or null when it is not one this check reads. */
function internalPath(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/\\")) return null;
  const bare = href.split(/[?#]/u, 1)[0] ?? "";
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

async function htmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (out.length >= PAGES_READ) return;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.html?$/iu.test(entry.name)) out.push(full);
    }
  };
  await walk(root);
  return out.sort();
}

/** The page addresses of the built bundle in `root` (prototype-verify.ts opens them in a browser). */
export async function builtPages(root: string): Promise<string[]> {
  return (await htmlFiles(root)).map((file) => pageAddress(path.relative(root, file)));
}

/** The internal links of the built bundle in `root` that have no page there. */
export async function checkBuiltLinks(root: string, signal?: AbortSignal): Promise<LinkCheck> {
  const files = await htmlFiles(root);
  const exists = new Map<string, boolean>();
  const isFile = async (relative: string): Promise<boolean> => {
    const known = exists.get(relative);
    if (known !== undefined) return known;
    // Inside the bundle only: `..` never leaves it.
    const full = path.join(root, relative);
    const inside = full === root || full.startsWith(`${root}${path.sep}`);
    const found = inside && (await stat(full).catch(() => null))?.isFile() === true;
    exists.set(relative, found);
    return found;
  };
  const resolves = async (address: string): Promise<boolean> => {
    const relative = address.replace(/^\/+/u, "");
    if (address.endsWith("/")) return isFile(`${relative}index.html`);
    return (await isFile(relative)) || (await isFile(`${relative}.html`)) || (await isFile(`${relative}/index.html`));
  };
  const broken = new Map<string, { pages: Set<string>; count: number }>();
  for (const file of files) {
    signal?.throwIfAborted();
    const info = await stat(file);
    if (info.size > PAGE_BYTES_READ) continue;
    const page = pageAddress(path.relative(root, file));
    for (const href of new Set(pageLinks(await readFile(file, "utf8")))) {
      const address = internalPath(href);
      if (address === null || (await resolves(address))) continue;
      const item = broken.get(address) ?? { pages: new Set<string>(), count: 0 };
      item.count++;
      if (item.pages.size < PAGES_KEPT) item.pages.add(page);
      broken.set(address, item);
    }
  }
  const brokenLinks = [...broken].map(([href, item]) => ({ href, pages: [...item.pages], count: item.count })).sort((left, right) => right.count - left.count || left.href.localeCompare(right.href));
  return { pages: files.length, brokenLinks: brokenLinks.slice(0, LINKS_KEPT), brokenTotal: brokenLinks.length };
}

/** The report warnings for the broken links of a preview: one per address, at most 10, then how many more. */
export function brokenLinkWarnings(check: Pick<LinkCheck, "brokenLinks" | "brokenTotal">): string[] {
  const shown = check.brokenLinks.slice(0, 10).map((link) => {
    const more = link.count - link.pages.length;
    return `Link interno rotto: ${link.href} non porta a nessuna pagina del sito (da ${link.pages.join(", ")}${more > 0 ? ` e altre ${more}` : ""}). Correggi l'indirizzo o crea la pagina.`;
  });
  const rest = check.brokenTotal - shown.length;
  return rest > 0 ? [...shown, `Altri ${rest} link interni rotti: correggi questi e ricontrolla.`] : shown;
}
