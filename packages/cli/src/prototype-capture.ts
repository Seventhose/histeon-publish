import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { HistosPublishError } from "@histos-publish/core";
import { captureFragment, captureProposal, RENDERED_CAPTURE_MAX_BYTES, type OpenPageProbe, type ProposalCaptured, type ProposalCapturePage } from "@histos-publish/server";

/**
 * `histos-publish prototype capture`: a proposal drawn by its scripts becomes a folder with the static site of its
 * pages (captureProposal), ready for the importer. Here: the file read from the disk, the pages as the command line
 * gives them, the folder written (never over an existing one) and the lines printed.
 */

export interface CaptureCommandOptions {
  pagina?: string[];
  out: string;
  radice?: string;
  togli?: string[];
  documento?: boolean;
  larghezza?: string;
}

export interface CaptureCommandResult {
  output: string;
  pages: Array<{ file: string; name: string; hash: string; bytes: number; links: number; notes: string[] }>;
  notes: string[];
}

/** `--pagina '#p03/home'` or `--pagina 'Menu=#p03/menu'`: the fragment, with the page's name before it when given. */
export function capturePageArgument(value: string): ProposalCapturePage {
  const named = /^([^#=]{1,80})=(#.*|)$/su.exec(value.trim());
  if (named) return { name: (named[1] ?? "").trim(), hash: captureFragment(named[2] ?? "") };
  return { hash: captureFragment(value) };
}

async function readProposalFile(file: string): Promise<{ name: string; bytes: Uint8Array }> {
  const target = path.resolve(file);
  const name = path.basename(target);
  const info = await lstat(target).catch(() => null);
  if (!info?.isFile()) throw new HistosPublishError(`${name}: la proposta deve essere un file normale (non una cartella o un collegamento).`, "proposal-capture-invalid", 2);
  if (!/\.html?$/iu.test(name)) throw new HistosPublishError(`${name}: la proposta è un file .html.`, "proposal-capture-invalid", 2);
  if (info.size > RENDERED_CAPTURE_MAX_BYTES) throw new HistosPublishError(`${name}: il file supera ${RENDERED_CAPTURE_MAX_BYTES / 1024 / 1024} MB.`, "proposal-capture-invalid", 2);
  return { name, bytes: await readFile(target) };
}

/** Captures the pages and writes the folder; on any failure the folder it created goes away. */
export async function runPrototypeCapture(file: string, options: CaptureCommandOptions, openProbe: OpenPageProbe): Promise<CaptureCommandResult> {
  const output = path.resolve(options.out);
  // Names, not whole paths: a folder that looks like a token would be hidden in the message as a secret.
  if (await lstat(output).catch(() => null)) throw new HistosPublishError(`${path.basename(output)} esiste già: scegli un altro nome.`, "proposal-capture-output-exists", 2);
  const parent = await stat(path.dirname(output)).catch(() => null);
  if (!parent?.isDirectory()) throw new HistosPublishError(parent ? `${path.basename(path.dirname(output))} non è una cartella.` : `La cartella ${path.basename(path.dirname(output))} non esiste.`, "proposal-capture-output-invalid", 2);
  const width = options.larghezza === undefined ? undefined : Number(options.larghezza);
  if (width !== undefined && (!Number.isInteger(width) || width < 320 || width > 2560)) throw new HistosPublishError("--larghezza: un numero intero di pixel fra 320 e 2560.", "proposal-capture-invalid", 2);
  const pages = (options.pagina ?? []).map(capturePageArgument);
  const proposal = await readProposalFile(file);
  let captured: ProposalCaptured;
  try {
    captured = await captureProposal(proposal, pages, openProbe, {
      ...(options.documento === true ? { root: "document" as const } : {}),
      ...(options.radice ? { rootSelector: options.radice } : {}),
      ...(options.togli?.length ? { remove: options.togli } : {}),
      ...(width !== undefined ? { width } : {}),
    });
  } catch (error) {
    if (error instanceof TypeError) throw new HistosPublishError(error.message, "proposal-capture-invalid", 2);
    throw error;
  }
  await mkdir(output, { mode: 0o755 });
  try {
    for (const item of captured.site.files) {
      const target = path.join(output, ...item.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, item.bytes, { flag: "wx", mode: 0o644 });
    }
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  return { output, pages: captured.pages.map((page) => ({ file: page.path, name: page.name, hash: page.hash, bytes: page.bytes, links: page.links, notes: page.notes })), notes: captured.notes };
}

export function prototypeCaptureText(result: CaptureCommandResult): string {
  const lines = [`Proposta fotografata: ${result.pages.length === 1 ? "1 pagina" : `${result.pages.length} pagine`} in ${result.output}`];
  for (const page of result.pages) {
    lines.push(`• ${page.file}: «${page.name}»${page.hash ? `, ${page.hash}` : ""}, ${Math.max(1, Math.round(page.bytes / 1024))} kB${page.links ? `, ${page.links === 1 ? "1 link collegato" : `${page.links} link collegati`}` : ""}`);
    for (const note of page.notes) lines.push(`  Nota: ${note}`);
  }
  for (const note of result.notes.slice(1)) lines.push(`Nota: ${note}`);
  lines.push("La cartella è un sito statico: trascinala su «Importa» in Histeon Publish, che la converte come ogni sito HTML.");
  return lines.join("\n");
}
