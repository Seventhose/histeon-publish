export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function assertUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${label} contiene una coppia UTF-16 non valida.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contiene una coppia UTF-16 non valida.`);
    }
  }
}

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicode(value, "La stringa");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS non ammette NaN o Infinity.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") throw new TypeError("JCS ammette soltanto valori JSON.");
  if (ancestors.has(value)) throw new TypeError("JCS non ammette riferimenti circolari.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item, ancestors)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("JCS richiede oggetti JSON senza prototipo personalizzato.");
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, entry] of entries) {
      assertUnicode(key, "Una chiave");
      if (entry === undefined) throw new TypeError("JCS non ammette proprietà undefined.");
    }
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** RFC 8785 JSON Canonicalization Scheme, without implicit Unicode normalization. */
export function canonicalizeJson(value: JsonValue | unknown): string {
  return canonical(value, new Set());
}

class StrictJsonReader {
  private offset = 0;

  constructor(private readonly input: string) {}

  parse(): JsonValue {
    this.space();
    const value = this.value();
    this.space();
    if (this.offset !== this.input.length) this.fail("Testo dopo il valore JSON");
    return value;
  }

  private value(): JsonValue {
    const char = this.input[this.offset];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    if (char === "t") return this.literal("true", true);
    if (char === "f") return this.literal("false", false);
    if (char === "n") return this.literal("null", null);
    return this.number();
  }

  private object(): { [key: string]: JsonValue } {
    this.offset += 1;
    this.space();
    const result: { [key: string]: JsonValue } = {};
    const keys = new Set<string>();
    if (this.input[this.offset] === "}") { this.offset += 1; return result; }
    while (true) {
      if (this.input[this.offset] !== '"') this.fail("La chiave dell'oggetto deve essere una stringa");
      const key = this.string();
      if (keys.has(key)) this.fail(`Chiave JSON duplicata: ${key}`);
      keys.add(key);
      this.space();
      if (this.input[this.offset] !== ":") this.fail("Manca ':' dopo la chiave");
      this.offset += 1;
      this.space();
      const value = this.value();
      Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
      this.space();
      const delimiter = this.input[this.offset++];
      if (delimiter === "}") return result;
      if (delimiter !== ",") this.fail("Manca ',' o '}' nell'oggetto");
      this.space();
    }
  }

  private array(): JsonValue[] {
    this.offset += 1;
    this.space();
    const result: JsonValue[] = [];
    if (this.input[this.offset] === "]") { this.offset += 1; return result; }
    while (true) {
      result.push(this.value());
      this.space();
      const delimiter = this.input[this.offset++];
      if (delimiter === "]") return result;
      if (delimiter !== ",") this.fail("Manca ',' o ']' nell'array");
      this.space();
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.input.length) {
      const char = this.input[this.offset] as string;
      if (!escaped && char === '"') {
        this.offset += 1;
        let result: string;
        try { result = JSON.parse(this.input.slice(start, this.offset)) as string; }
        catch { return this.fail("Stringa JSON non valida"); }
        assertUnicode(result, "La stringa JSON");
        return result;
      }
      if (!escaped && char.charCodeAt(0) < 0x20) this.fail("Carattere di controllo non escapato in una stringa");
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
      this.offset += 1;
    }
    return this.fail("Stringa JSON non terminata");
  }

  private number(): number {
    const start = this.offset;
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.input.slice(this.offset));
    if (!match) return this.fail("Valore JSON non valido");
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("Numero fuori dal range IEEE 754");
    if (this.input[this.offset] === "." || /[0-9A-Za-z+-]/u.test(this.input[this.offset] ?? "")) this.fail("Numero JSON non valido");
    if (this.offset === start) this.fail("Valore JSON non valido");
    return value;
  }

  private literal<T extends JsonValue>(name: string, value: T): T {
    if (this.input.slice(this.offset, this.offset + name.length) !== name) return this.fail("Valore JSON non valido");
    this.offset += name.length;
    return value;
  }

  private space(): void {
    while (this.input[this.offset] === " " || this.input[this.offset] === "\n" || this.input[this.offset] === "\r" || this.input[this.offset] === "\t") this.offset += 1;
  }

  private fail(message: string): never {
    throw new SyntaxError(`${message} alla posizione ${this.offset}.`);
  }
}

/** Parses JSON while rejecting duplicate object keys and invalid UTF-8/Unicode. */
export function parseJsonStrict(input: string | Uint8Array): JsonValue {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  return new StrictJsonReader(text).parse();
}
