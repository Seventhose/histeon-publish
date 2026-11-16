import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

const HASH = /^[0-9a-f]{64}$/u;
/** A conversion is checked and imported within minutes; two days leave room for a check left open overnight. */
const KEEP_MS = 2 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * Doc 23 item 109: the media of the sites converted in the app, kept by hash in `<data>/converted-media` (folder 700,
 * files 600) while the prototype names them by a converted-media address. Only the app's own check and import read
 * them, and they check the hash again. A file goes two days after its last use.
 */
export class ConvertedMedia {
  private readonly directory: string;
  private lastPrune = 0;

  constructor(dataDirectory: string) {
    this.directory = path.join(dataDirectory, "converted-media");
  }

  hold(bytes: Uint8Array, sha256: string): void {
    if (!HASH.test(sha256)) throw new TypeError("Impronta del media non valida.");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, sha256);
    try {
      // Already kept: only its time moves, so the cleaning leaves it alone.
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      // Written whole or not at all: a read never finds half a file.
      const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
      writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
      chmodSync(temporary, 0o600);
      renameSync(temporary, file);
    }
    this.prune();
  }

  /** The bytes kept under this hash, checked against it; null when there are none or they do not match. */
  read(sha256: string): Uint8Array | null {
    if (!HASH.test(sha256)) return null;
    try {
      const bytes = readFileSync(path.join(this.directory, sha256));
      return createHash("sha256").update(bytes).digest("hex") === sha256 ? new Uint8Array(bytes) : null;
    } catch {
      return null;
    }
  }

  private prune(): void {
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    for (const name of readdirSync(this.directory)) {
      const file = path.join(this.directory, name);
      try {
        const info = statSync(file);
        if (info.isFile() && now - info.mtimeMs > KEEP_MS) rmSync(file, { force: true });
      } catch {
        // Gone already, or being written: the next cleaning sees it.
      }
    }
  }
}
