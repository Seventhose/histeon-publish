/** `node:net` in the browser bundle (doc 18 F6): isIP, as Node answers it (4, 6 or 0). */
export function isIP(value: string): number {
  if (/^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/u.test(value)) return 4;
  if (!value.includes(":") || /[^0-9a-fA-F:.%]/u.test(value.split("%")[0] ?? "")) return 0;
  try {
    return new URL(`http://[${value.split("%")[0]}]/`).hostname ? 6 : 0;
  } catch {
    return 0;
  }
}
export default { isIP };
