// The class attribute of an element as chips: static tokens can be added and removed; a token with an
// expression ({…}) stays as written, shown but not editable here.

const NAME = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;

export function validClass(name: string): boolean {
  return NAME.test(name) && name.length <= 100;
}

/** Splits a class attribute into tokens, keeping `{…}` groups whole. */
export function classTokens(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const out: string[] = [];
  let current = '';
  let depth = 0;
  for (const c of value) {
    if (c === '{') depth++;
    if (c === '}') depth = Math.max(0, depth - 1);
    if (/\s/.test(c) && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else current += c;
  }
  if (current) out.push(current);
  return out;
}

export const isDynamic = (token: string): boolean => token.includes('{');

export function withClass(value: unknown, name: string): string {
  const tokens = classTokens(value);
  return (tokens.includes(name) ? tokens : [...tokens, name]).join(' ');
}

export function withoutClass(value: unknown, name: string): string {
  return classTokens(value)
    .filter((t) => t !== name)
    .join(' ');
}
