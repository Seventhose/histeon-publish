import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { HistosPublishError, normalizeRelativePath } from "@histos-publish/core";

/**
 * «Fotografa la proposta»: the captured pages kept with the project they became, in `<project>/proposal/`. They are
 * the original the comparison «Uguale alla proposta» photographs beside the built site. The folder goes with the
 * project (deleted, moved to the bin and restored with it); a backup file does not carry it.
 *
 * `site/` is the static site as captured: untrusted, without scripts by construction but never served as if it were.
 */
const PROPOSAL_FOLDER = "proposal";
const SITE_FOLDER = "site";
const ABOUT_FILE = "capture.json";
const PAGES_MAX = 20;

export interface KeptProposalPage {
  /** The name the person gave the page. */
  name: string;
  /** Its file in the captured site: `index.html`, `menu/index.html`. */
  path: string;
  /** The fragment of the viewer's address it was captured at, or "". */
  hash: string;
}

export interface KeptProposal {
  schemaVersion: 1;
  capturedAt: string;
  pages: KeptProposalPage[];
  files: number;
  bytes: number;
}

const refused = (message: string): HistosPublishError => new HistosPublishError(message, "proposal-capture-invalid", 2);

function pagesOf(value: unknown): KeptProposalPage[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > PAGES_MAX) return null;
  const pages: KeptProposalPage[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const page = item as Record<string, unknown>;
    if (typeof page.name !== "string" || typeof page.path !== "string" || typeof page.hash !== "string") return null;
    const normalized = normalizeRelativePath(page.path);
    if (!normalized || normalized.path !== page.path || !/(?:^|\/)index\.html$/u.test(page.path) || seen.has(page.path)) return null;
    seen.add(page.path);
    pages.push({ name: page.name.replace(/[\s\p{Cc}]+/gu, " ").trim().slice(0, 80), path: page.path, hash: page.hash.replace(/[\s\p{Cc}]+/gu, "").slice(0, 500) });
  }
  return pages[0]?.path === "index.html" ? pages : null;
}

/** The address of a kept page in the site, as a browser asks for it: `/`, `/menu/`. */
export function keptPageAddress(page: Pick<KeptProposalPage, "path">): string {
  return `/${page.path.replace(/index\.html$/u, "")}`;
}

/**
 * Keeps the captured site in the project's folder, replacing the one it had. Written beside and moved in place, so a
 * failure half way leaves the previous capture.
 */
export async function keepProposal(projectDirectory: string, files: ReadonlyArray<{ path: string; bytes: Uint8Array }>, pages: unknown, capturedAt = new Date().toISOString()): Promise<KeptProposal> {
  const listed = pagesOf(pages);
  if (!listed) throw refused("Le pagine della proposta fotografata non sono valide.");
  const paths = new Set(files.map((file) => file.path));
  if (listed.some((page) => !paths.has(page.path))) throw refused("Una pagina della proposta fotografata non ha il suo file.");
  const staging = path.join(projectDirectory, `.proposal-${randomUUID()}`);
  const site = path.join(staging, SITE_FOLDER);
  const boundary = `${path.resolve(site)}${path.sep}`;
  let bytes = 0;
  await mkdir(site, { recursive: true, mode: 0o700 });
  try {
    for (const file of files) {
      const normalized = normalizeRelativePath(file.path);
      const destination = path.resolve(site, ...file.path.split("/"));
      if (!normalized || normalized.path !== file.path || !destination.startsWith(boundary)) throw refused(`Percorso non valido nella proposta fotografata: ${file.path.slice(0, 120)}`);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 });
      bytes += file.bytes.byteLength;
    }
    const about: KeptProposal = { schemaVersion: 1, capturedAt, pages: listed, files: files.length, bytes };
    await writeFile(path.join(staging, ABOUT_FILE), `${JSON.stringify(about, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const target = path.join(projectDirectory, PROPOSAL_FOLDER);
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return about;
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** The capture a project keeps, with the folder of its site; null when it keeps none, or one that does not read. */
export async function readKeptProposal(projectDirectory: string): Promise<{ about: KeptProposal; folder: string; siteDirectory: string } | null> {
  const folder = path.join(projectDirectory, PROPOSAL_FOLDER);
  try {
    const about = JSON.parse(await readFile(path.join(folder, ABOUT_FILE), "utf8")) as Partial<KeptProposal>;
    const pages = pagesOf(about.pages);
    if (about.schemaVersion !== 1 || typeof about.capturedAt !== "string" || !pages) return null;
    const siteDirectory = path.join(folder, SITE_FOLDER);
    for (const page of pages) if (!(await stat(path.join(siteDirectory, ...page.path.split("/")))).isFile()) return null;
    return { about: { schemaVersion: 1, capturedAt: about.capturedAt.slice(0, 40), pages, files: Number.isSafeInteger(about.files) ? about.files as number : pages.length, bytes: Number.isSafeInteger(about.bytes) ? about.bytes as number : 0 }, folder, siteDirectory };
  } catch {
    return null;
  }
}

const SITE_FILES_MAX = 5000;
const SITE_BYTES_MAX = 512 * 1024 * 1024;

/**
 * The files of a kept site, as the importer takes them (paths with `/`, from the site's root), to convert it again.
 * Hidden entries and links are left out; a site past 5,000 files or 512 MB is refused.
 */
export async function readKeptSiteFiles(siteDirectory: string): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  let bytes = 0;
  const walk = async (folder: string, prefix: string): Promise<void> => {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), relative);
      else if (entry.isFile()) {
        const content = await readFile(path.join(folder, entry.name));
        bytes += content.byteLength;
        if (files.length >= SITE_FILES_MAX || bytes > SITE_BYTES_MAX) throw refused("La proposta fotografata è troppo grande per essere convertita di nuovo.");
        files.push({ path: relative, bytes: content });
      }
    }
  };
  await walk(siteDirectory, "");
  return files;
}
