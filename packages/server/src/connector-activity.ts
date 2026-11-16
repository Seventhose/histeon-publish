import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * What the AI connector did, for the user: in memory (the last 200) and in `connector/activity.jsonl` (0600, rotated
 * at 1 MiB). Only facts the app produced go in: operation, outcome, code, duration, project name and counts, a file
 * name with its size and hash prefix. Never prototype HTML, keys or full paths.
 */

export const ACTIVITY_KEPT = 200;
export const ACTIVITY_FILE_MAX_BYTES = 1024 * 1024;

export interface ConnectorActivityEntry {
  seq: number;
  at: string;
  client: string;
  operation: string;
  outcome: "ok" | "error" | "pending";
  code?: string;
  durationMs: number;
  project?: { id: string; name: string };
  file?: { name: string; bytes: number; sha256: string };
  /** For a failure: the first line of the message the agent got, cleaned and at most 160 characters. */
  message?: string;
  /** Small facts the UI turns into a sentence: counts, valid/outcome, build status, host. */
  facts?: Record<string, string | number | boolean>;
}

export class ConnectorActivity {
  private readonly entries: ConnectorActivityEntry[] = [];
  private seq = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string | null) {}

  add(entry: Omit<ConnectorActivityEntry, "seq" | "at">): ConnectorActivityEntry {
    const item: ConnectorActivityEntry = { seq: ++this.seq, at: new Date().toISOString(), ...entry };
    this.entries.push(item);
    if (this.entries.length > ACTIVITY_KEPT) this.entries.shift();
    if (this.directory) {
      const line = `${JSON.stringify(item)}\n`;
      this.writing = this.writing.then(() => this.append(line)).catch(() => undefined);
    }
    return item;
  }

  list(after = 0): ConnectorActivityEntry[] {
    return this.entries.filter((entry) => entry.seq > after);
  }

  get lastSeq(): number {
    return this.seq;
  }

  async clear(): Promise<void> {
    this.entries.length = 0;
    await this.writing;
    if (!this.directory) return;
    await rm(path.join(this.directory, "activity.jsonl"), { force: true });
    await rm(path.join(this.directory, "activity.1.jsonl"), { force: true });
  }

  /** Waits for pending writes (tests, shutdown). */
  async flush(): Promise<void> {
    await this.writing;
  }

  private async append(line: string): Promise<void> {
    const directory = this.directory as string;
    const file = path.join(directory, "activity.jsonl");
    try {
      const stats = await lstat(file);
      if (stats.isSymbolicLink() || !stats.isFile()) await rm(file, { force: true });
      else if (stats.size + Buffer.byteLength(line) > ACTIVITY_FILE_MAX_BYTES) await rename(file, path.join(directory, "activity.1.jsonl"));
    } catch {
      // No log yet.
    }
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(line);
    } finally {
      await handle.close();
    }
  }
}
