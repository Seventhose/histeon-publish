/**
 * «Nuovo sito da Penpot o Figma» (note penpot-figma-a-histeon.md, phase 6): a whole `.penpot` or `.fig` file the app
 * uploads becomes the list of its pages and frames, then one frame becomes a Histeon prototype with its report. The
 * app sends the prototype on to `projects/import-prototype`, as it does with one the user wrote.
 *
 * Nothing is saved here and nothing leaves the computer: no network, no credentials. The file is read twice (once
 * for the list, once for the frame) because the server keeps nothing between the two requests.
 */

import { HistosPublishError } from "@histos-publish/core";
import { DESIGN_FILE_MAX, designFilePages, designFilePrototype, type DesignPageList } from "@histos-publish/cms";

/** The largest design file the app uploads: what `designFilePages` reads. */
export const DESIGN_SOURCE_FILE_MAX = DESIGN_FILE_MAX;
const NAME_MAX = 200;
const REF_MAX = 300;
const PAGES_MAX = 500;
const FRAMES_MAX = 2000;

/** What `design-file/pages` answers; `truncated` when the file has more pages or frames than the app lists. */
export interface DesignSourcePagesView extends DesignPageList {
  truncated: boolean;
}

/** The three choices of the command `design`, as the app sends them in the address. */
export interface DesignSourceChoice {
  page: string;
  frame: string;
  components: boolean;
  records: boolean;
  uniform: boolean;
}

/** What `design-file/prototype` answers: the prototype as text, the name to give its file, and the report in Italian. */
export interface DesignSourcePrototypeView {
  id: string;
  fileName: string;
  html: string;
  report: string;
  page: string;
  frame: string;
  source: DesignPageList["source"];
  components: boolean;
  records: boolean;
  uniform: boolean;
}

function invalid(message: string): HistosPublishError {
  return new HistosPublishError(message, "cms-design-source-invalid", 400);
}

/** The name the app gave for the uploaded file: shown in messages and in the id of the prototype, never a path. */
export function designSourceName(raw: string | null): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what the text must lose.
  const name = (raw ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").split(/[\\/]/u).at(-1)?.trim() ?? "";
  return name.slice(0, NAME_MAX) || "file di design";
}

/** "Kit del negozio.fig" and "Home / Desktop" → "kit-del-negozio-home-desktop.html". */
export function designSourceFileName(name: string, frame: string): string {
  const slug = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60).replace(/-+$/u, "");
  return `${[slug(name.replace(/\.(?:penpot|fig)$/iu, "")), slug(frame)].filter(Boolean).join("-") || "prototipo"}.html`;
}

/** Page, frame and the three choices from the address of the request. A page is always needed. */
export function designSourceChoice(params: URLSearchParams): DesignSourceChoice {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what the text must lose.
  const ref = (key: string) => (params.get(key) ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  const page = ref("page");
  const frame = ref("frame");
  if (!page) throw invalid("Scegli la pagina del design da convertire.");
  if (page.length > REF_MAX || frame.length > REF_MAX) throw invalid("Il nome della pagina o del riquadro è troppo lungo.");
  for (const key of ["components", "records", "uniform"]) {
    const value = params.get(key);
    if (value !== null && value !== "0" && value !== "1") throw invalid(`${key}: serve 0 oppure 1.`);
  }
  return { page, frame, components: params.get("components") !== "0", records: params.get("records") !== "0", uniform: params.get("uniform") === "1" };
}

/** The pages of an uploaded `.penpot` or `.fig` file and the frames at the top of each. A file that is not read is a 400. */
export async function designPagesFromFile(name: string, bytes: Uint8Array): Promise<DesignSourcePagesView> {
  let list: DesignPageList;
  try {
    list = await designFilePages(name, bytes);
  } catch (error) {
    if (error instanceof TypeError) throw invalid(error.message);
    throw error;
  }
  const pages = list.pages.slice(0, PAGES_MAX).map((page) => ({ ...page, frames: page.frames.slice(0, FRAMES_MAX) }));
  return { file: list.file, source: list.source, pages, truncated: list.pages.length > PAGES_MAX || list.pages.some((page) => page.frames.length > FRAMES_MAX) };
}

/** One frame of an uploaded design file as a prototype, with the report of what was deduced or left out. */
export async function designPrototypeFromFile(name: string, bytes: Uint8Array, choice: DesignSourceChoice): Promise<DesignSourcePrototypeView> {
  try {
    const made = await designFilePrototype(name, bytes, choice.page, choice.frame, { components: choice.components, records: choice.records, uniform: choice.uniform });
    return { id: made.id, fileName: designSourceFileName(name, made.details.frame), html: made.html, report: made.report, page: made.details.page, frame: made.details.frame, source: made.details.source, components: choice.components, records: choice.records, uniform: choice.uniform };
  } catch (error) {
    if (error instanceof TypeError) throw invalid(error.message);
    throw error;
  }
}
