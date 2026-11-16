/**
 * The database a CMS project keeps its content in, as the project store and the content model use it: SQL statements
 * that run, read one row or read them all. In Histeon Publish it is `node:sqlite` (project-database-node.ts); in the
 * WordPress administrator's browser (doc 18 F6) the official SQLite build for WebAssembly, in memory. The store and
 * its rules are the same code in both: only this connection changes.
 */

/** A value SQLite takes as a parameter. */
export type ProjectSqlValue = null | number | bigint | string | Uint8Array;

export interface ProjectStatement {
  run(...parameters: ProjectSqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...parameters: ProjectSqlValue[]): unknown;
  all(...parameters: ProjectSqlValue[]): unknown[];
}

export interface ProjectDatabase {
  /** Whether a transaction is open (SQLite's autocommit is off). */
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): ProjectStatement;
  close(): void;
}

/** Opens the database of a project from its file; `readOnly` for the checks that must not change it. */
export type ProjectDatabaseOpener = (file: string, options?: { readOnly?: boolean }) => ProjectDatabase;

/**
 * Where a project's media bytes live when they are not files on disk (doc 18 F6, the browser): by their SHA-256, the
 * same bytes once. Without it the store keeps them in its `media` folder, as always.
 */
export interface ProjectMediaFiles {
  store(sha256: string, bytes: Uint8Array): void;
  read(sha256: string): Uint8Array | undefined;
}

/** Media kept in memory, for a project that lives only as long as one conversion in the browser. */
export function memoryMediaFiles(): ProjectMediaFiles {
  const files = new Map<string, Uint8Array>();
  return {
    store: (sha256, bytes) => {
      if (!files.has(sha256)) files.set(sha256, bytes.slice());
    },
    read: (sha256) => files.get(sha256),
  };
}
