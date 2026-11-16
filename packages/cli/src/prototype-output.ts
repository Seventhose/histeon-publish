import { HistosPublishError } from "@histos-publish/core";
import { VERIFY_VIEWPORTS, type PreviewVerify, type PrototypePreview } from "@histos-publish/server";

/**
 * The line `prototype check --preview` prints for its build (checkPrototypeBuild): the site builds, with no address to
 * open (the note says so and where a preview is), or why it was not built whole («Build del sito: <reason>»: only
 * drafts, a bundle publishing would block, the machine's failure). A site that does not build is no line: the check
 * refuses it, exit code 2.
 */
export function prototypePreviewText(preview: PrototypePreview): string {
  if (preview.status === "built") return `${preview.note}${preview.findings > 0 ? ` Avvisi della build: ${preview.findings}.` : ""}`;
  if (preview.status === "unavailable") return `Build del sito: ${preview.reason}`;
  return `Anteprima: ${preview.previewUrl}`;
}

/**
 * The line `prototype verify` prints for its browser (doc 17 item 4): the pages opened at each width and what they
 * gave; the problems themselves are warnings of the report. Null without a browser check.
 */
export function prototypeVerifyText(verify: PreviewVerify | undefined): string | null {
  if (verify?.opened === undefined) return null;
  const widths = VERIFY_VIEWPORTS.map((viewport) => `${viewport.width}`).join(" e ");
  const opened = verify.opened === 1 ? "1 pagina" : `${verify.opened} pagine`;
  const overflow = new Set(verify.overflow?.map((item) => item.page)).size;
  const axe = verify.axe?.length ?? 0;
  // Doc 23 item 242: images the browser cannot show, text touching a side.
  const broken = verify.brokenImages?.length ?? 0;
  const edges = new Set(verify.edges?.map((item) => item.page)).size;
  const parts = [
    overflow ? `${overflow === 1 ? "1 pagina scorre" : `${overflow} pagine scorrono`} in orizzontale` : "",
    axe ? `${axe === 1 ? "1 regola" : `${axe} regole`} di accessibilità non ${axe === 1 ? "rispettata" : "rispettate"}` : "",
    broken ? `${broken === 1 ? "1 pagina" : `${broken} pagine`} con immagini rotte` : "",
    edges ? `${edges === 1 ? "1 pagina" : `${edges} pagine`} con testo attaccato al bordo` : "",
  ].filter(Boolean);
  const found = parts.length ? `${parts.join(", ")} (fra gli avvisi)` : "nessuno scorrimento orizzontale, nessuna violazione axe, nessuna immagine rotta, nessun testo attaccato al bordo";
  return `Browser: ${opened} aperte a ${widths} px, ${found}.${verify.note ? ` ${verify.note}` : ""}`;
}

/** One problem of a refused prototype as the check reports it (E4): the document and the place in the file, when known. */
export interface PrototypeIssueOutput {
  document?: string;
  line?: number;
  column?: number;
  message: string;
}

/**
 * A prototype the check refused, as `histos-publish prototype check` reports it: exit code 2 and, with --json, every
 * problem with its document, line and column next to the message, as hp_check_prototype gives them (A7 trial: the JSON
 * held the message alone). `total` counts them all when `issues` holds only the first ones.
 */
export class PrototypeRefusedError extends HistosPublishError {
  constructor(message: string, readonly issues: readonly PrototypeIssueOutput[], readonly total: number) {
    super(message, "cms-prototype-invalid", 2);
    this.name = "PrototypeRefusedError";
  }
}

const isIssue = (value: unknown): value is PrototypeIssueOutput => !!value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string";
const position = (value: unknown): number | undefined => (Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined);

/** The refusal the server's check throws (its PrototypeInvalidError), with the problems it carries: only their fields, typed. */
export function prototypeRefused(error: HistosPublishError): PrototypeRefusedError {
  const carried = (error as { issues?: unknown }).issues;
  const issues = (Array.isArray(carried) ? carried.filter(isIssue) : []).map((issue) => {
    const line = position(issue.line);
    const column = position(issue.column);
    return { ...(typeof issue.document === "string" ? { document: issue.document } : {}), ...(line ? { line } : {}), ...(line && column ? { column } : {}), message: issue.message };
  });
  const listed = issues.length ? issues : [{ message: error.message }];
  const total = (error as { total?: unknown }).total;
  return new PrototypeRefusedError(error.message, listed, typeof total === "number" && Number.isSafeInteger(total) && total >= listed.length ? total : listed.length);
}

/** What --json adds to an error object for a refused prototype: its problems, cleaned as the message is, and their count. */
export function refusalDetails(error: unknown, clean: (text: string) => string): { issues?: PrototypeIssueOutput[]; total?: number } {
  if (!(error instanceof PrototypeRefusedError)) return {};
  return {
    issues: error.issues.map((issue) => ({ ...issue, ...(issue.document !== undefined ? { document: clean(issue.document) } : {}), message: clean(issue.message) })),
    total: error.total,
  };
}
