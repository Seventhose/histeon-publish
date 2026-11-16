import { cssResourceReferences } from "@histos-publish/histos-contract/css-resources";

interface ImportStatement {
  value: string;
  external: boolean;
  start: number;
  end: number;
  conditions: string;
}

const MAX_IMPORTS = 128;
const MAX_IMPORT_DEPTH = 16;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function commentEnd(css: string, from: number): number {
  const end = css.indexOf("*/", from + 2);
  if (end < 0) throw new TypeError("Un commento CSS non è chiuso.");
  return end + 2;
}

function skipString(css: string, from: number): number {
  const quote = css[from];
  if (quote !== "'" && quote !== '"') return from;
  let index = from + 1;
  while (index < css.length) {
    if (css[index] === "\\") index += 2;
    else if (css[index] === quote) return index + 1;
    else index++;
  }
  return css.length;
}

function statementEnd(css: string, from: number, rule = "import"): number {
  let index = from;
  let depth = 0;
  while (index < css.length) {
    if (css.startsWith("/*", index)) {
      index = commentEnd(css, index);
      continue;
    }
    const current = css[index] ?? "";
    if (current === "'" || current === '"') {
      index = skipString(css, index);
      continue;
    }
    if (current === "(") depth++;
    else if (current === ")") {
      if (depth === 0) throw new TypeError(`La condizione CSS di @${rule} non è valida.`);
      depth--;
    } else if (current === ";" && depth === 0) return index + 1;
    index++;
  }
  throw new TypeError(`Una regola CSS @${rule} non termina con punto e virgola.`);
}

function importStatements(css: string): ImportStatement[] {
  const references = cssResourceReferences(css).filter((reference) => reference.kind === "import");
  const statements: ImportStatement[] = [];
  let referenceIndex = 0;
  let index = 0;

  while (index < css.length) {
    if (css.startsWith("/*", index)) {
      index = commentEnd(css, index);
      continue;
    }
    if (css[index] === "'" || css[index] === '"') {
      index = skipString(css, index);
      continue;
    }
    if (css[index] === "@" && css.slice(index + 1, index + 7).toLowerCase() === "import" && !/[\w-]/u.test(css[index + 7] ?? "")) {
      const start = index;
      const end = statementEnd(css, index + 7);
      while (referenceIndex < references.length) {
        const candidate = references[referenceIndex];
        if (!candidate || candidate.start >= index + 7) break;
        referenceIndex++;
      }
      const reference = references[referenceIndex];
      if (!reference || reference.start >= end - 1 || reference.end > end - 1) {
        throw new TypeError("Una regola CSS @import non contiene un file o URL valido.");
      }
      statements.push({
        value: reference.value,
        external: reference.external,
        start,
        end,
        conditions: css.slice(reference.end, end - 1).trim(),
      });
      referenceIndex++;
      index = end;
      continue;
    }
    index++;
  }

  return statements;
}

function skipSpace(value: string, from: number): number {
  let index = from;
  while (index < value.length) {
    if (/\s/u.test(value[index] ?? "")) index++;
    else if (value.startsWith("/*", index)) index = commentEnd(value, index);
    else break;
  }
  return index;
}

function stripUtf8Charset(css: string): string {
  const normalized = css.startsWith("\uFEFF") ? css.slice(1) : css;
  const charsetRules: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < normalized.length) {
    if (normalized.startsWith("/*", index)) {
      index = commentEnd(normalized, index);
      continue;
    }
    if (normalized[index] === "'" || normalized[index] === '"') {
      index = skipString(normalized, index);
      continue;
    }
    if (normalized[index] === "@" && normalized.slice(index + 1, index + 8).toLowerCase() === "charset" && !/[\w-]/u.test(normalized[index + 8] ?? "")) {
      const end = statementEnd(normalized, index + 8, "charset");
      charsetRules.push({ start: index, end });
      index = end;
      continue;
    }
    index++;
  }
  if (!charsetRules.length) return normalized;
  if (charsetRules.length !== 1 || charsetRules[0]?.start !== 0) {
    throw new TypeError("La dichiarazione CSS @charset è ammessa solo all'inizio del file.");
  }
  const charset = charsetRules[0];
  if (!charset) return normalized;
  const declaration = normalized.slice(charset.start, charset.end);
  const match = /^@charset "([^"\r\n]+)";$/u.exec(declaration);
  if (!match?.[1]) throw new TypeError("La dichiarazione CSS @charset non è valida.");
  const encoding = match[1].toLowerCase();
  if (encoding !== "utf-8") throw new TypeError("Sono supportati solo fogli CSS codificati in UTF-8.");
  return normalized.slice(0, charset.start) + normalized.slice(charset.end);
}

/** Decode a selected CSS file strictly as UTF-8 and remove its encoding marker. */
export function decodeCssSource(bytes: ArrayBuffer): string {
  let css: string;
  try {
    css = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Il file CSS non è codificato in UTF-8 valido.");
  }
  return stripUtf8Charset(css);
}

function readFunction(value: string, from: number, name: string): { content: string; end: number } | null {
  const word = value.slice(from, from + name.length);
  if (word.toLowerCase() !== name || /[\w-]/u.test(value[from + name.length] ?? "")) return null;
  const opening = skipSpace(value, from + name.length);
  if (value[opening] !== "(") return null;
  const contentStart = opening + 1;
  let depth = 1;
  let cursor = contentStart;
  while (cursor < value.length) {
    if (value.startsWith("/*", cursor)) {
      cursor = commentEnd(value, cursor);
      continue;
    }
    const current = value[cursor] ?? "";
    if (current === "'" || current === '"') {
      cursor = skipString(value, cursor);
      continue;
    }
    if (current === "(") depth++;
    else if (current === ")") {
      depth--;
      if (depth === 0) return { content: value.slice(contentStart, cursor).trim(), end: cursor + 1 };
    }
    cursor++;
  }
  throw new TypeError(`La funzione ${name}() nelle condizioni CSS di @import non è chiusa.`);
}

function startsKeyword(value: string, from: number, keyword: string): boolean {
  return value.slice(from, from + keyword.length).toLowerCase() === keyword && !/[\w-]/u.test(value[from + keyword.length] ?? "");
}

function topLevelBooleanOperator(condition: string): boolean {
  let depth = 0;
  let index = 0;
  while (index < condition.length) {
    if (condition.startsWith("/*", index)) {
      index = commentEnd(condition, index);
      continue;
    }
    const current = condition[index] ?? "";
    if (current === "'" || current === '"') {
      index = skipString(condition, index);
      continue;
    }
    if (current === "(") depth++;
    else if (current === ")") depth--;
    if (depth === 0 && /\s/u.test(current)) {
      const tail = condition.slice(index).match(/^\s+(?:and|or)\s+/iu)?.[0];
      if (tail) return true;
    }
    index++;
  }
  return false;
}

function supportsCondition(value: string): string {
  const condition = value.trim();
  if (!condition) throw new TypeError("La condizione supports() di @import è vuota.");
  if (/^[-\w]+\s*:/u.test(condition)) {
    if (topLevelBooleanOperator(condition)) throw new TypeError("Per importare una condizione supports() composta, racchiudi ogni verifica tra parentesi.");
    return `(${condition})`;
  }
  return condition;
}

function wrapImport(css: string, conditions: string): string {
  let index = skipSpace(conditions, 0);
  let layer: string | null | undefined;
  let supports: string | undefined;

  if (startsKeyword(conditions, index, "layer")) {
    const afterKeyword = index + "layer".length;
    const afterSpace = skipSpace(conditions, afterKeyword);
    if (conditions[afterSpace] === "(") {
      const parsed = readFunction(conditions, index, "layer");
      if (!parsed) throw new TypeError("La layer() di @import non è valida.");
      layer = parsed.content || null;
      index = skipSpace(conditions, parsed.end);
    } else {
      layer = null;
      index = afterSpace;
    }
  }

  if (startsKeyword(conditions, index, "supports")) {
    const parsed = readFunction(conditions, index, "supports");
    if (!parsed?.content) throw new TypeError("La condizione supports() di @import non è valida.");
    supports = supportsCondition(parsed.content);
    index = skipSpace(conditions, parsed.end);
  }

  const media = conditions.slice(index).trim();
  if (/^(?:layer|supports|scope)\b/iu.test(media) || /[{};]/u.test(media)) throw new TypeError("Le condizioni di @import non sono supportate in questa forma.");
  if (conditions.trim() && cssResourceReferences(css).some((reference) => reference.kind === "import" && reference.external)) {
    throw new TypeError("Un foglio condizionale contiene anche un @import remoto; per evitare di cambiare la cascata, importa una versione CSS senza quel collegamento remoto.");
  }
  let output = css;
  if (media) output = `@media ${media}{${output}}`;
  if (supports) output = `@supports ${supports}{${output}}`;
  if (layer !== undefined) output = layer ? `@layer ${layer}{${output}}` : `@layer{${output}}`;
  return output;
}

function resolveBundlePath(reference: string, parentPath: string): string | null {
  const pathPart = reference.split(/[?#]/u, 1)[0] ?? "";
  if (!pathPart || /^[a-z][a-z0-9+.-]*:/iu.test(pathPart) || pathPart.startsWith("//") || pathPart.includes("\\")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const parts = pathPart.startsWith("/") ? [] : parentPath.split("/").slice(0, -1).filter(Boolean);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/") || null;
}

function rebaseUrls(css: string, sourcePath: string, entryPath: string): string {
  const replacements = cssResourceReferences(css)
    .filter((reference) => reference.kind === "url" && !reference.external)
    .map((reference) => {
      const resolved = resolveBundlePath(reference.value, sourcePath);
      if (!resolved) throw new TypeError(`Il percorso CSS locale “${reference.value}” esce dalla cartella importata o non è valido.`);
      const suffixAt = [reference.value.indexOf("?"), reference.value.indexOf("#")].filter((offset) => offset >= 0).sort((left, right) => left - right)[0];
      const suffix = suffixAt === undefined ? "" : reference.value.slice(suffixAt);
      const encodedPath = resolved.split("/").map(encodeURIComponent).join("/");
      const target = `/${encodedPath}${suffix}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      return { start: reference.start, end: reference.end, value: `url("${target}")` };
    });
  let output = css;
  for (const replacement of replacements.reverse()) output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  if (new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES) throw new TypeError(`Il CSS importato da “${entryPath}” supera 8 MiB dopo la risoluzione delle risorse.`);
  return output;
}

/**
 * Inlines local CSS @imports selected from one directory and rebases every
 * relative url() to that directory's root. No network access or path traversal
 * is permitted; only CSS files supplied by the user are read.
 */
export async function flattenCssImportBundle(input: {
  css: string;
  entryPath: string;
  loadCss: (path: string) => Promise<string | undefined>;
}): Promise<string> {
  const entryPath = resolveBundlePath(input.entryPath, "");
  if (!entryPath?.toLowerCase().endsWith(".css")) throw new TypeError("Il percorso del foglio CSS principale non è valido.");
  const initialBytes = new TextEncoder().encode(input.css).byteLength;
  if (initialBytes > 1024 * 1024) throw new TypeError("Il foglio CSS iniziale supera 1 MiB.");
  const active = new Set<string>([entryPath]);
  let importCount = 0;
  let sourceBytes = initialBytes;

  const expand = async (css: string, sourcePath: string, depth: number): Promise<string> => {
    if (depth > MAX_IMPORT_DEPTH) throw new TypeError("Gli @import CSS superano 16 livelli.");
    const sourceCss = stripUtf8Charset(css);
    const rules = importStatements(sourceCss);
    if (!rules.length) return rebaseUrls(sourceCss, sourcePath, entryPath);
    let output = "";
    let cursor = 0;
    for (const rule of rules) {
      output += rebaseUrls(sourceCss.slice(cursor, rule.start), sourcePath, entryPath);
      if (rule.external) {
        output += sourceCss.slice(rule.start, rule.end);
        cursor = rule.end;
        continue;
      }
      importCount++;
      if (importCount > MAX_IMPORTS) throw new TypeError("Il CSS importato supera 128 fogli collegati.");
      const importedPath = resolveBundlePath(rule.value, sourcePath);
      if (!importedPath?.toLowerCase().endsWith(".css")) throw new TypeError(`Il percorso @import “${rule.value}” non è un file CSS locale valido.`);
      if (active.has(importedPath)) throw new TypeError(`Rilevato un ciclo CSS importando “${importedPath}”.`);
      const importedCss = await input.loadCss(importedPath);
      if (importedCss === undefined) throw new TypeError(`Manca il foglio CSS importato “${importedPath}”. Seleziona la cartella completa del framework.`);
      if (importedCss.includes("\0")) throw new TypeError(`Il foglio CSS importato “${importedPath}” non contiene testo valido.`);
      sourceBytes += new TextEncoder().encode(importedCss).byteLength;
      if (sourceBytes > MAX_SOURCE_BYTES) throw new TypeError("I fogli CSS collegati superano 8 MiB complessivi.");
      active.add(importedPath);
      const expanded = await expand(importedCss, importedPath, depth + 1);
      active.delete(importedPath);
      output += wrapImport(expanded, rule.conditions);
      cursor = rule.end;
    }
    output += rebaseUrls(sourceCss.slice(cursor), sourcePath, entryPath);
    if (new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES) throw new TypeError("Il CSS importato supera 8 MiB dopo la risoluzione delle risorse.");
    return output;
  };

  return expand(input.css, entryPath, 0);
}
