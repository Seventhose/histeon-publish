import { findClosingBrace } from './expr.ts';

/** `{` not preceded by a backslash. */
export function hasInterpolation(value: string): boolean {
  return /(^|[^\\])\{/.test(value);
}

/** True when the whole value is exactly one `{expression}`. */
export function isSingleInterpolation(value: string): boolean {
  return value.startsWith('{') && findClosingBrace(value, 0) === value.length - 1;
}

/** Applies `fn` to the parts of `value` that are outside `{…}` interpolations and `\{` / `\}` escapes. */
export function mapOutsideInterpolations(value: string, fn: (text: string) => string): string {
  let out = '';
  let text = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (c === '\\' && (value.charAt(i + 1) === '{' || value.charAt(i + 1) === '}')) {
      out += fn(text) + value.slice(i, i + 2);
      text = '';
      i++;
    } else if (c === '{') {
      const close = findClosingBrace(value, i);
      out += fn(text) + value.slice(i, close + 1);
      text = '';
      i = close;
    } else {
      text += c;
    }
  }
  return out + fn(text);
}
