/**
 * «Importa token» of a CMS project (note penpot-figma-a-histeon.md, phase 1b.3): the design tokens of Figma or Penpot,
 * read by packages/cms/src/design-tokens.ts, laid over the design and the site variables the project has.
 *
 * Pure: it receives the request body and the saved styles, and returns what to show and what to save. The route in
 * cms-api.ts reads, saves and answers. No network, no credentials, no file is written here.
 */

import { HistosPublishError } from "@histos-publish/core";
import {
  changedHistosDesign,
  type HistosDesign,
  importDesignTokens,
  readDesignTokens,
  TOKEN_FILE_MAX,
  type TokenFile,
  type TokenImportReport,
  tokenImportText,
  validateHistosDesign,
  validateSiteTokens,
} from "@histos-publish/cms";
import { tokenSourceNotes } from "./cms-token-source.js";

/** The whole request: the files of both themes, as JSON text inside JSON, and what their sources said. */
export const TOKEN_IMPORT_BODY_MAX = TOKEN_FILE_MAX + 1024 * 1024;
const FILES_MAX = 12;
const NAME_MAX = 200;

export interface TokenImportPlan {
  /** False: only the report is wanted, nothing is saved. */
  apply: boolean;
  /** The revision of the styles the request was made on. */
  head: string;
  /** The design to save: what the project had, with the imported parameters over it; only what differs from the defaults. */
  design: HistosDesign;
  /** The site variables to save: what the project had, with the imported ones over them. */
  siteTokens: Record<string, string>;
  /** What the request answers. */
  view: {
    design: HistosDesign;
    siteTokens: Record<string, string>;
    /** The parameters and the variables the files gave, before they were laid over the saved ones. */
    imported: { design: HistosDesign; siteTokens: Record<string, string> };
    /** How many of them change a value the project has, and how many are new. */
    counts: { parameters: number; variables: number; replaced: number };
    report: TokenImportReport;
    text: string;
  };
}

function invalid(message: string): HistosPublishError {
  return new HistosPublishError(message, "cms-tokens-import-invalid", 400);
}

/** The files of one theme from the body: a list of `{ name, text }`, or nothing. */
function tokenFiles(raw: unknown, what: string): TokenFile[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > FILES_MAX) throw invalid(`${what}: serve un elenco di file, al massimo ${FILES_MAX}.`);
  return raw.map((item) => {
    const file = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    if (typeof file.name !== "string" || typeof file.text !== "string" || !file.name || file.name.length > NAME_MAX) throw invalid(`${what}: ogni file ha un nome e un testo.`);
    return { name: file.name, text: file.text };
  });
}

/**
 * What an import of tokens does to the saved styles. `current` is the data of the styles document (its `design` and
 * `siteTokens`). Throws a 400 error for a body or for tokens that are not valid; never saves.
 */
export function planTokenImport(body: Record<string, unknown>, current: { design?: unknown; siteTokens?: unknown }): TokenImportPlan {
  if (typeof body.head !== "string" || !body.head) throw new HistosPublishError("La revisione degli stili non è valida.", "cms-styles-head-required", 400);
  const light = tokenFiles(body.files, "File dei token");
  const dark = tokenFiles(body.dark, "File del tema scuro");
  if (!light.length) throw invalid("Scegli almeno un file di token.");
  // What a .penpot file, a .fig file or the API of Figma said beside the tokens (cms-token-source.ts).
  const sources = tokenSourceNotes(body.sources);
  try {
    const read = readDesignTokens(light);
    // A file of token sets can hold its dark theme: without dark files it is read from the same files (as the CLI does).
    const darkRead = dark.length ? readDesignTokens(dark, { scheme: "dark" }) : read.dark ? readDesignTokens(light, { scheme: "dark" }) : null;
    const result = importDesignTokens(read, darkRead ? { dark: darkRead } : {});
    result.report.skipped.push(...sources.flatMap((source) => source.problems));
    const summaries = sources.map((source) => source.summary).filter(Boolean);
    const before = validateHistosDesign(current.design ?? {});
    const savedTokens = validateSiteTokens(current.siteTokens ?? {});
    const design = changedHistosDesign(validateHistosDesign({ ...changedHistosDesign(before), ...result.design }));
    const siteTokens = validateSiteTokens({ ...savedTokens, ...result.siteTokens });
    const replaced = Object.entries(result.design).filter(([key, value]) => String(before[key]) !== String(value)).length
      + Object.entries(result.siteTokens).filter(([name, value]) => name in savedTokens && savedTokens[name] !== value).length;
    return {
      apply: body.apply === true,
      head: body.head,
      design,
      siteTokens,
      view: {
        design,
        siteTokens,
        imported: { design: result.design, siteTokens: result.siteTokens },
        counts: { parameters: Object.keys(result.design).length, variables: Object.keys(result.siteTokens).length, replaced },
        report: result.report,
        text: [...summaries, ...(summaries.length ? [""] : []), tokenImportText(result.report, { fromDesign: summaries.length > 0 })].join("\n"),
      },
    };
  } catch (error) {
    if (error instanceof TypeError) throw invalid(error.message);
    throw error;
  }
}
