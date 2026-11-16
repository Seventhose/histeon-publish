import type { PrototypeReport } from "@histos-publish/cms";

/** How many projects keep their last import report. In memory only: the app forgets them when it closes. */
export const IMPORT_REPORTS_KEPT = 30;
/** Items and characters kept per list, so a huge prototype cannot fill the memory with its report. */
const ITEMS_KEPT = 500;
const TEXT_KEPT = 400;

/** The last prototype import of a project, as the app and the agent's log show it (queue D1). */
export interface ImportReport {
  projectId: string;
  at: string;
  /** Who imported: the user in the app, or an agent through the connector (the name it gives itself). */
  source: { kind: "app" } | { kind: "agent"; client: string };
  file: string | null;
  result: "created" | "updated";
  counts: Record<string, number>;
  downloaded: number;
  placeholders: string[];
  /** With the line of the file (D1) when the import knew it. */
  ignored: Array<{ what: string; why: string; line?: number }>;
  warnings: string[];
  /** Items beyond ITEMS_KEPT, per list. */
  omitted: { placeholders: number; ignored: number; warnings: number };
  /** B6: the images that will have modern variants at the build, and what the encoder's cache measured. */
  images?: { files: number; uses: number; skipped: Array<{ asset: string; why: string }>; note: string };
  /** For an update: how many entities changed, kept the user's edits, or stayed as they were. */
  changed?: number;
  keptLocal?: number;
  unchanged?: number;
}

const text = (value: unknown): string => String(value ?? "").slice(0, TEXT_KEPT);

export class ImportReports {
  private readonly reports = new Map<string, ImportReport>();

  /** Keeps the report of a successful import, replacing the project's previous one. */
  record(input: { projectId: string; source: ImportReport["source"]; file: string | null; report: PrototypeReport; body: Record<string, unknown> }): ImportReport {
    const { report, body } = input;
    const updated = Array.isArray(body.changed);
    const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
    const counts = Object.fromEntries(Object.entries(report.counts ?? {}).filter(([, value]) => Number.isSafeInteger(value)).map(([key, value]) => [text(key), value]));
    const placeholders = Array.isArray(report.placeholders) ? report.placeholders : [];
    const stored: ImportReport = {
      projectId: input.projectId,
      at: new Date().toISOString(),
      source: input.source.kind === "agent" ? { kind: "agent", client: text(input.source.client).slice(0, 120) } : { kind: "app" },
      file: input.file === null ? null : text(input.file).slice(0, 120),
      result: updated ? "updated" : "created",
      counts,
      downloaded: Number.isSafeInteger(report.downloaded) ? report.downloaded : 0,
      placeholders: placeholders.slice(0, ITEMS_KEPT).map(text),
      ignored: report.ignored.slice(0, ITEMS_KEPT).map((item) => ({ what: text(item.what), why: text(item.why), ...(Number.isSafeInteger(item.line) && (item.line ?? 0) > 0 ? { line: item.line } : {}) })),
      warnings: report.warnings.slice(0, ITEMS_KEPT).map(text),
      omitted: {
        placeholders: Math.max(0, placeholders.length - ITEMS_KEPT),
        ignored: Math.max(0, report.ignored.length - ITEMS_KEPT),
        warnings: Math.max(0, report.warnings.length - ITEMS_KEPT),
      },
      ...(report.images ? { images: { files: report.images.files, uses: report.images.uses, skipped: report.images.skipped.slice(0, ITEMS_KEPT).map((item) => ({ asset: text(item.asset), why: text(item.why) })), note: String(report.images.note ?? "").slice(0, 3 * TEXT_KEPT) } } : {}),
      ...(updated ? { changed: count(body.changed), keptLocal: count(body.keptLocal), unchanged: count(body.unchanged) } : {}),
    };
    this.reports.delete(input.projectId);
    this.reports.set(input.projectId, stored);
    for (const oldest of [...this.reports.keys()].slice(0, Math.max(0, this.reports.size - IMPORT_REPORTS_KEPT))) this.reports.delete(oldest);
    return stored;
  }

  get(projectId: string): ImportReport | null {
    return this.reports.get(projectId) ?? null;
  }
}
