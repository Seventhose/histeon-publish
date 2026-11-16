export interface Location {
  offset: number;
  line: number;
  column: number;
}

export function locate(source: string, offset: number): Location {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { offset, line, column: offset - lineStart + 1 };
}

/** Error with a source position; messages are user-facing (Italian, like the rest of the UI). */
export class XbSyntaxError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, source: string, offset: number) {
    const loc = locate(source, offset);
    super(`${message} (riga ${loc.line}, colonna ${loc.column})`);
    this.name = 'XbSyntaxError';
    this.offset = loc.offset;
    this.line = loc.line;
    this.column = loc.column;
  }
}

export interface Warning {
  message: string;
  offset: number;
}
