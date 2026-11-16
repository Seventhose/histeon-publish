/**
 * What the canvas may load (S5, docs/spec/security.md): the site itself and the origins the administrator declares
 * (Histeon → Impostazioni, plus the origins of the stylesheets the page uses), never any address on the web. An
 * image from elsewhere would hand the administrator's IP address to a third party.
 */

/** Origins only: https, or http for a local or private site; no paths, no wildcards, nothing else in the string. */
export function originsOf(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!/^https?:\/\/[^\s;,'"*]+$/i.test(value)) continue;
    try {
      const origin = new URL(value).origin;
      if (origin !== 'null' && !out.includes(origin)) out.push(origin);
    } catch {
      /* not an address */
    }
  }
  return out;
}

export function canvasCsp(origins: string[]): string {
  const list = originsOf(origins).join(' ');
  const more = list ? ` ${list}` : '';
  return [
    "default-src 'none'",
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `style-src 'self' 'unsafe-inline'${more}`,
    `img-src 'self' data: blob:${more}`,
    `font-src 'self' data:${more}`,
    `media-src 'self'${more}`,
  ].join('; ') + ';';
}

/** Whether an address in the page may be loaded in the canvas: relative, the site's own, data/blob, or an allowed origin. */
export function allowedOrigin(value: string, allowed: string[], base: string): boolean {
  if (/^(data|blob):/i.test(value.trim())) return true;
  try {
    const url = new URL(value, base);
    return url.origin === new URL(base).origin || allowed.includes(url.origin);
  } catch {
    return false;
  }
}
