import type { PrototypeImportProgress } from "@histos-publish/cms";

/**
 * Where a prototype check or import is (queue D3), for the app to read while the request runs. The app names the
 * entry with a random token; an entry lives a few minutes after its last update, and only a few are kept.
 */
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEEP_MS = 5 * 60_000;
const MAX_ENTRIES = 32;

export class ImportProgressBoard {
  private readonly entries = new Map<string, { progress: PrototypeImportProgress; updated: number }>();

  /** The token the app sent, when it is one: a random UUID v4. */
  static token(value: string | null): string | null {
    return value && TOKEN.test(value) ? value : null;
  }

  set(token: string, progress: PrototypeImportProgress): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (now - entry.updated > KEEP_MS) this.entries.delete(key);
    if (!this.entries.has(token) && this.entries.size >= MAX_ENTRIES) {
      const oldest = [...this.entries].sort((left, right) => left[1].updated - right[1].updated)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    this.entries.set(token, { progress: { phase: progress.phase, done: progress.done, total: progress.total }, updated: now });
  }

  get(token: string): PrototypeImportProgress | null {
    const entry = this.entries.get(token);
    return entry && Date.now() - entry.updated <= KEEP_MS ? { ...entry.progress } : null;
  }

  finish(token: string): void {
    this.entries.delete(token);
  }
}
