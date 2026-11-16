/**
 * An error the connector reports to the agent as `<code>: <message>`. `exitCode` follows the CLI convention of the
 * builder connector: 2 when the content was refused (invalid prototype, conflict, duplicate, scope), 1 for
 * operational problems (app closed, impostor, unauthorized, busy, timeout).
 */
export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: 1 | 2 = 1,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export const OFF_MESSAGE = "Histeon Publish è chiuso, oppure il connettore AI è spento: apri l'app → Agente AI → Attiva il connettore. Non riprovare finché l'utente non te lo dice.";

export function connectorOff(): ConnectorError {
  return new ConnectorError("connector-off", OFF_MESSAGE);
}

/**
 * Text that came from a prototype, a project or a WordPress site, made safe to show: no C0/C1 controls (except
 * newline and tab), no bidi overrides or isolates, no zero-width characters, and at most `max` characters.
 */
export function plain(value: unknown, max = 1000): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  let clean = "";
  for (const character of text) if (!hidden(character.codePointAt(0) as number)) clean += character;
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function hidden(code: number): boolean {
  return (code <= 0x1f && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
}

/** Any C0 control character or DEL: never accepted in paths or names an agent passes. */
export function hasControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
