export interface CssResourceReference {
  value: string;
  kind: "url" | "import";
  external: boolean;
  start: number;
  end: number;
}

/** A CSS url() dependency owned by a Histeon project media entity. */
export interface CssAssetReference {
  reference: string;
  assetId: string;
}

/**
 * Finds CSS resource references without treating comments, ordinary strings, or
 * text such as `content: "url(image.png)"` as actual dependencies.
 */
export function cssResourceReferences(css: string): CssResourceReference[] {
  const found: CssResourceReference[] = [];
  let index = 0;

  const whitespace = (from: number): number => {
    let cursor = from;
    while (cursor < css.length) {
      if (/\s/u.test(css[cursor]!)) cursor++;
      else if (css.startsWith("/*", cursor)) {
        const end = css.indexOf("*/", cursor + 2);
        cursor = end < 0 ? css.length : end + 2;
      } else break;
    }
    return cursor;
  };

  const readString = (from: number): { value: string; end: number } | null => {
    const quote = css[from];
    if (quote !== "'" && quote !== '"') return null;
    let cursor = from + 1;
    let value = "";
    while (cursor < css.length) {
      const char = css[cursor]!;
      if (char === quote) return { value, end: cursor + 1 };
      if (char === "\\") {
        if (cursor + 1 >= css.length) return null;
        value += css[cursor + 1]!;
        cursor += 2;
      } else {
        value += char;
        cursor++;
      }
    }
    return null;
  };

  const readUrl = (from: number): { value: string; start: number; end: number } | null => {
    if (css.slice(from, from + 3).toLowerCase() !== "url" || /[\w-]/u.test(css[from - 1] ?? "") || /[\w-]/u.test(css[from + 3] ?? "")) return null;
    let cursor = whitespace(from + 3);
    if (css[cursor] !== "(") return null;
    cursor = whitespace(cursor + 1);
    const quoted = readString(cursor);
    if (quoted) {
      cursor = whitespace(quoted.end);
      return css[cursor] === ")" ? { value: quoted.value, start: from, end: cursor + 1 } : null;
    }
    let value = "";
    let escaped = false;
    while (cursor < css.length) {
      const current = css[cursor] ?? "";
      if (escaped) {
        value += current;
        escaped = false;
        cursor++;
      } else if (current === "\\") {
        escaped = true;
        cursor++;
      } else if (current === ")") {
        return { value, start: from, end: cursor + 1 };
      } else {
        value += current;
        cursor++;
      }
    }
    return null;
  };

  const external = (value: string): boolean =>
    /^(?:https?:)?\/\//iu.test(value) || /^(?:data:|#)/iu.test(value);
  const add = (value: string, kind: CssResourceReference["kind"], start: number, end: number): void => {
    const normalized = value.trim();
    if (normalized) found.push({ value: normalized, kind, external: external(normalized), start, end });
  };

  while (index < css.length) {
    if (css.startsWith("/*", index)) {
      const end = css.indexOf("*/", index + 2);
      index = end < 0 ? css.length : end + 2;
      continue;
    }
    const char = css[index]!;
    if (char === "'" || char === '"') {
      const string = readString(index);
      index = string?.end ?? css.length;
      continue;
    }
    if (char === "@" && css.slice(index + 1, index + 7).toLowerCase() === "import" && !/[\w-]/u.test(css[index + 7] ?? "")) {
      const afterKeyword = whitespace(index + 7);
      const imported = readString(afterKeyword);
      if (imported) {
        add(imported.value, "import", afterKeyword, imported.end);
        index = imported.end;
        continue;
      }
      const importedUrl = readUrl(afterKeyword);
      if (importedUrl) {
        add(importedUrl.value, "import", importedUrl.start, importedUrl.end);
        index = importedUrl.end;
        continue;
      }
    }
    if (/[a-z-]/iu.test(char) && css.slice(index, index + 3).toLowerCase() === "url" && !/[\w-]/u.test(css[index - 1] ?? "")) {
      const resource = readUrl(index);
      if (resource) {
        add(resource.value, "url", resource.start, resource.end);
        index = resource.end;
        continue;
      }
    }
    index++;
  }
  return found;
}
