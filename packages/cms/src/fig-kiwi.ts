/**
 * The binary of a Figma file, `canvas.fig` (note penpot-figma-a-histeon.md, phase 2): the «fig-kiwi» container, the
 * schema it carries, and the message decoded with that schema.
 *
 * Publish reads the `.fig` files saved by Figma; when a file has a shape it does not recognise, it says so and converts
 * nothing. The container is eight bytes of signature, a version, then pieces each with its length; the first piece is a schema (the definitions of every
 * enum, struct and message, with their fields), the second is one message written with that schema. Because the
 * schema travels with the file, no field name is assumed here: a file of another version brings its own.
 *
 * The file comes from outside: every read is checked against the end of the buffer, lengths and depths are capped,
 * and decoded objects have no prototype (a field of the schema may be called anything). Node only (zlib). No
 * network, no credentials; nothing is written to disk.
 */

import zlib from "node:zlib";

export type KiwiValue = boolean | number | bigint | string | Uint8Array | KiwiValue[] | KiwiRecord;
export interface KiwiRecord {
  [field: string]: KiwiValue;
}

export interface KiwiField {
  name: string;
  /** Below zero a primitive (−1 bool, −2 byte, −3 int, −4 uint, −5 float, −6 string, −7 int64, −8 uint64), otherwise the index of a definition. */
  type: number;
  array: boolean;
  /** The value of an enum member, or the number a message writes before the field. */
  value: number;
}
export interface KiwiDefinition {
  name: string;
  kind: "enum" | "struct" | "message";
  fields: KiwiField[];
}

export interface FigContainer {
  /** The version the file declares after its signature. */
  version: number;
  schema: Buffer;
  message: Buffer;
}

export const FIG_SIGNATURE = "fig-kiwi";
/** The schema of a file inflates to some tens of kilobytes. */
const SCHEMA_MAX = 16 * 1024 * 1024;
/** The message of a large file inflates to some tens of megabytes. */
export const FIG_MESSAGE_MAX = 256 * 1024 * 1024;
/** Objects and list items decoded from one message: a file of 18.000 layers has under three million. */
const VALUES_MAX = 40_000_000;
const DEFINITIONS_MAX = 20_000;
const FIELDS_MAX = 20_000;
const DEPTH_MAX = 64;
const KINDS = ["enum", "struct", "message"] as const;

const broken = (what: string) => new TypeError(`Il file di Figma non si legge: ${what}.`);

/** True for the first bytes of a `canvas.fig`. */
export function isFigKiwi(bytes: Uint8Array): boolean {
  if (bytes.byteLength < FIG_SIGNATURE.length) return false;
  for (let index = 0; index < FIG_SIGNATURE.length; index += 1) if (bytes[index] !== FIG_SIGNATURE.charCodeAt(index)) return false;
  return true;
}

/** One piece of the container, inflated: zstd when it starts with the zstd frame mark, raw deflate otherwise. */
function inflatePiece(piece: Buffer, max: number): Buffer {
  const zstd = piece.length >= 4 && piece[0] === 0x28 && piece[1] === 0xb5 && piece[2] === 0x2f && piece[3] === 0xfd;
  try {
    if (!zstd) return zlib.inflateRawSync(piece, { maxOutputLength: max });
    const inflate = (zlib as { zstdDecompressSync?: (data: Buffer, options: { maxOutputLength: number }) => Buffer }).zstdDecompressSync;
    if (typeof inflate !== "function") throw new TypeError("Questo file di Figma è compresso con zstd: serve Node 22.15 o più recente.");
    return inflate(piece, { maxOutputLength: max });
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("Questo file")) throw error;
    throw broken((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "una volta aperto è troppo grande" : "i dati compressi sono rovinati");
  }
}

/** Opens the container: signature, version, then the pieces (`uint32` length, little endian, and the bytes). */
export function readFigContainer(bytes: Uint8Array): FigContainer {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isFigKiwi(buffer) || buffer.length < 12) throw broken("non comincia con la firma fig-kiwi");
  const version = buffer.readUInt32LE(8);
  const pieces: Buffer[] = [];
  let at = 12;
  while (at + 4 <= buffer.length && pieces.length < 2) {
    const size = buffer.readUInt32LE(at);
    at += 4;
    if (size > buffer.length - at) throw broken("un pezzo è più lungo del file");
    pieces.push(buffer.subarray(at, at + size));
    at += size;
  }
  if (pieces.length < 2) throw broken("mancano lo schema o i dati");
  return { version, schema: inflatePiece(pieces[0]!, SCHEMA_MAX), message: inflatePiece(pieces[1]!, FIG_MESSAGE_MAX) };
}

/** A cursor over the bytes; every read past the end throws. */
class Cursor {
  at = 0;
  private readonly view: DataView;
  constructor(readonly bytes: Buffer) {
    this.view = new DataView(new ArrayBuffer(4));
  }
  get left(): number {
    return this.bytes.length - this.at;
  }
  byte(): number {
    if (this.at >= this.bytes.length) throw broken("finisce prima del previsto");
    return this.bytes[this.at++]!;
  }
  /** Seven bits a byte, low bits first, the high bit says another byte follows; at most five bytes. */
  uint(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) break;
    }
    return value % 2 ** 32;
  }
  /** The sign is the lowest bit. */
  int(): number {
    const value = this.uint();
    return value % 2 === 1 ? -(value - 1) / 2 - 1 : value / 2;
  }
  /** As `uint`, up to nine bytes: the ninth gives all its eight bits. */
  uint64(): bigint {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.byte();
      if (!(byte & 128) || shift >= 56n) return value | (BigInt(byte) << shift);
      value |= BigInt(byte & 127) << shift;
      shift += 7n;
    }
  }
  int64(): bigint {
    const value = this.uint64();
    return value & 1n ? ~(value >> 1n) : value >> 1n;
  }
  /** One zero byte for zero; otherwise the four bytes of a 32 bit float with its bits turned by nine places. */
  float(): number {
    if (this.at >= this.bytes.length) throw broken("finisce prima del previsto");
    if (this.bytes[this.at] === 0) {
      this.at += 1;
      return 0;
    }
    if (this.left < 4) throw broken("finisce prima del previsto");
    const bits = this.bytes.readUInt32LE(this.at);
    this.at += 4;
    this.view.setUint32(0, ((bits << 23) | (bits >>> 9)) >>> 0);
    return this.view.getFloat32(0);
  }
  /** UTF-8 up to a zero byte. */
  text(): string {
    const end = this.bytes.indexOf(0, this.at);
    if (end < 0) throw broken("un testo non finisce");
    const value = this.bytes.toString("utf8", this.at, end);
    this.at = end + 1;
    return value;
  }
  take(size: number): Buffer {
    if (size > this.left) throw broken("finisce prima del previsto");
    this.at += size;
    return this.bytes.subarray(this.at - size, this.at);
  }
}

/** The definitions of the schema, in the order the file numbers them. */
export function readKiwiSchema(bytes: Uint8Array): KiwiDefinition[] {
  const cursor = new Cursor(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const count = cursor.uint();
  if (count > DEFINITIONS_MAX) throw broken("lo schema ha troppe definizioni");
  const definitions: KiwiDefinition[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = cursor.text();
    const kind = KINDS[cursor.byte()];
    const size = cursor.uint();
    if (!kind || size > FIELDS_MAX) throw broken("lo schema ha una definizione non valida");
    const fields: KiwiField[] = [];
    for (let field = 0; field < size; field += 1) fields.push({ name: cursor.text(), type: cursor.int(), array: (cursor.byte() & 1) === 1, value: cursor.uint() });
    definitions.push({ name, kind, fields });
  }
  for (const definition of definitions) {
    for (const field of definition.fields) if (field.type < -8 || field.type >= definitions.length) throw broken("lo schema nomina un tipo che non ha");
  }
  return definitions;
}

/**
 * Decodes one value of the definition `root` (a message of a Figma file is `Message`). An enum becomes the name of
 * its member, a struct and a message an object without prototype, an array of bytes a view on the buffer.
 */
export function decodeKiwi(definitions: readonly KiwiDefinition[], bytes: Uint8Array, root: string): KiwiRecord {
  const cursor = new Cursor(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const start = definitions.findIndex((definition) => definition.name === root && definition.kind !== "enum");
  if (start < 0) throw broken(`lo schema non ha «${root}»`);
  // For a message: the number written before a field → the field.
  const byNumber = definitions.map((definition) => (definition.kind === "enum" ? null : new Map(definition.fields.map((field) => [field.value, field]))));
  const members = definitions.map((definition) => (definition.kind === "enum" ? new Map(definition.fields.map((field) => [field.value, field.name])) : null));

  let made = 0;

  const value = (type: number, depth: number): KiwiValue => {
    switch (type) {
      case -1: return cursor.byte() !== 0;
      case -2: return cursor.byte();
      case -3: return cursor.int();
      case -4: return cursor.uint();
      case -5: return cursor.float();
      case -6: return cursor.text();
      case -7: return cursor.int64();
      case -8: return cursor.uint64();
      default: break;
    }
    const definition = definitions[type]!;
    if (definition.kind === "enum") {
      const member = cursor.uint();
      return members[type]!.get(member) ?? member;
    }
    if (depth >= DEPTH_MAX) throw broken("i dati sono annidati oltre il limite");
    made += 1;
    if (made > VALUES_MAX) throw broken("ha troppi dati");
    const record = Object.create(null) as KiwiRecord;
    if (definition.kind === "struct") {
      for (const field of definition.fields) record[field.name] = one(field, depth + 1);
      return record;
    }
    for (;;) {
      const number = cursor.uint();
      if (number === 0) return record;
      const field = byNumber[type]!.get(number);
      if (!field) throw broken(`un campo di «${definition.name}» non è nello schema`);
      record[field.name] = one(field, depth + 1);
    }
  };
  const one = (field: KiwiField, depth: number): KiwiValue => {
    if (!field.array) return value(field.type, depth);
    const size = cursor.uint();
    if (field.type === -2) return cursor.take(size);
    // Every element takes at least one byte.
    if (size > cursor.left) throw broken("una lista è più lunga dei dati");
    made += size;
    if (made > VALUES_MAX) throw broken("una lista è più lunga dei dati");
    const list: KiwiValue[] = [];
    for (let index = 0; index < size; index += 1) list.push(value(field.type, depth));
    return list;
  };
  return value(start, 0) as KiwiRecord;
}
