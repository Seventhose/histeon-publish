/**
 * XLIFF 1.2 for translators and agencies (doc 20 §12.1): one <file> per content, one <trans-unit> per segment. The file
 * read back is hostile like any other: no DOCTYPE or entities, a size limit, and a target is only text, which then
 * passes the same checks as every translation (assertSegmentText), so markup never comes from it.
 */

export interface XliffContent {
  sourceId: string;
  sourceHash: string;
  title: string;
  segments: ReadonlyArray<{ id: string; text: string }>;
  targets: Readonly<Record<string, string>>;
}

export interface XliffRead {
  sourceId: string;
  sourceHash: string;
  targetLanguage: string | null;
  segments: Record<string, string>;
  /** Targets with inner markup, which cannot be read as text. */
  unreadable: number;
}

export const MAX_XLIFF_BYTES = 64 * 1024 * 1024;
const MAX_XLIFF_CONTENTS = 20_000;

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/giu, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower[1] === "x" ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[lower] ?? whole;
  });
}

export function buildXliff(input: { sourceLanguage: string; targetLanguage: string; contents: readonly XliffContent[] }): string {
  const files = input.contents.map((content) => {
    const units = content.segments.map((segment) => {
      const target = content.targets[segment.id];
      return `<trans-unit id="${escapeXml(segment.id)}" xml:space="preserve"><source>${escapeXml(segment.text)}</source>${target === undefined ? "" : `<target state="translated">${escapeXml(target)}</target>`}</trans-unit>`;
    }).join("\n");
    return `<file original="histos:${escapeXml(content.sourceId)}" source-language="${escapeXml(input.sourceLanguage)}" target-language="${escapeXml(input.targetLanguage)}" datatype="plaintext"><header><note from="histos-source-hash">${escapeXml(content.sourceHash)}</note><note from="histos-title">${escapeXml(content.title)}</note></header><body>\n${units}\n</body></file>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">\n${files}\n</xliff>\n`;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "u").exec(tag);
  return match ? unescapeXml(match[1] ?? match[2] ?? "") : null;
}

/** The files of an XLIFF: what a segment says in <target>, a <target> with inner markup left out as unreadable. */
export function parseXliff(text: string): XliffRead[] {
  if (new TextEncoder().encode(text).length > MAX_XLIFF_BYTES) throw new RangeError("Il file XLIFF supera i 64 MB.");
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new TypeError("Il file XLIFF non può contenere DOCTYPE o ENTITY.");
  if (!/<xliff[\s>]/u.test(text)) throw new TypeError("Non è un file XLIFF.");
  const read: XliffRead[] = [];
  const fileTag = /<file\b[^>]*>/gu;
  for (let match = fileTag.exec(text); match; match = fileTag.exec(text)) {
    const end = text.indexOf("</file>", match.index);
    if (end < 0) throw new TypeError("Il file XLIFF è incompleto.");
    const original = attribute(match[0], "original") ?? "";
    if (!original.startsWith("histos:")) throw new TypeError("Questo file XLIFF non viene da Histeon Publish.");
    const body = text.slice(match.index + match[0].length, end);
    const hash = /<note\s+from="histos-source-hash">([^<]*)<\/note>/u.exec(body)?.[1] ?? "";
    const segments: Record<string, string> = {};
    let unreadable = 0;
    const unit = /<trans-unit\b[^>]*>/gu;
    for (let found = unit.exec(body); found; found = unit.exec(body)) {
      const close = body.indexOf("</trans-unit>", found.index);
      if (close < 0) throw new TypeError("Il file XLIFF è incompleto.");
      const id = attribute(found[0], "id");
      const unitBody = body.slice(found.index, close);
      const target = /<target\b[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/target>/u.exec(unitBody);
      if (!target && /<target\b[^>]*>[^<]*</u.test(unitBody) && !/<target\b[^>]*\/>/u.test(unitBody)) unreadable += 1;
      const value = target ? target[1] ?? unescapeXml(target[2] ?? "") : "";
      if (id && value.trim()) segments[id] = value;
    }
    read.push({ sourceId: original.slice("histos:".length), sourceHash: hash, targetLanguage: attribute(match[0], "target-language"), segments, unreadable });
    fileTag.lastIndex = end;
    if (read.length > MAX_XLIFF_CONTENTS) throw new RangeError(`Un file XLIFF ha al massimo ${MAX_XLIFF_CONTENTS} contenuti.`);
  }
  if (!read.length) throw new TypeError("Il file XLIFF non contiene contenuti.");
  return read;
}
