export type UidFactory = () => string;

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Matches docs/spec/blocks.md §2: lowercase base36, 8–16 chars. */
export const UID_PATTERN = /^[a-z0-9]{8,16}$/;

export const randomUid: UidFactory = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
};

/** Deterministic factory for tests and fixtures. */
export function sequentialUids(prefix = 'u'): UidFactory {
  let n = 0;
  return () => prefix + (n++).toString(36).padStart(8 - prefix.length, '0');
}
