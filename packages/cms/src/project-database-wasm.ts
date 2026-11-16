import type { ProjectDatabase, ProjectDatabaseOpener, ProjectSqlValue, ProjectStatement } from "./project-database.js";

/**
 * The project database on the official SQLite build for WebAssembly (`@sqlite.org/sqlite-wasm`), in memory: what the
 * project store runs on in the WordPress administrator's browser (doc 18 F6). The store and its rules are the same
 * code as in Histeon Publish; this adapter gives the build's `oo1` API the shape of `node:sqlite` the store uses
 * (project-database.ts). Rows come back as plain objects, numbers as numbers (big ones as bigint), blobs as bytes.
 */

/** The part of the initialized SQLite module this adapter uses. */
export interface WasmSqlite {
  oo1: { DB: new (filename: string, flags?: string) => WasmDb };
  capi: { sqlite3_get_autocommit(pointer: unknown): number; sqlite3_last_insert_rowid(pointer: unknown): number | bigint };
}
interface WasmDb {
  pointer: unknown;
  exec(sql: string): unknown;
  prepare(sql: string): WasmStatement;
  changes(total?: boolean, sixtyFour?: boolean): number | bigint;
  close(): void;
}
interface WasmStatement {
  bind(values: ProjectSqlValue[]): unknown;
  step(): boolean;
  get(target: object): Record<string, unknown>;
  reset(clearBindings?: boolean): unknown;
  clearBindings(): unknown;
}

class WasmProjectStatement implements ProjectStatement {
  constructor(private readonly sqlite: WasmSqlite, private readonly db: WasmDb, private readonly statement: WasmStatement) {}

  private bound(parameters: ProjectSqlValue[]): WasmStatement {
    this.statement.reset(true);
    if (parameters.length) this.statement.bind(parameters);
    return this.statement;
  }

  run(...parameters: ProjectSqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    try {
      this.bound(parameters).step();
    } finally {
      this.statement.reset(true);
    }
    return { changes: this.db.changes(), lastInsertRowid: this.sqlite.capi.sqlite3_last_insert_rowid(this.db.pointer) };
  }

  get(...parameters: ProjectSqlValue[]): unknown {
    try {
      const statement = this.bound(parameters);
      return statement.step() ? statement.get({}) : undefined;
    } finally {
      this.statement.reset(true);
    }
  }

  all(...parameters: ProjectSqlValue[]): unknown[] {
    const rows: unknown[] = [];
    try {
      const statement = this.bound(parameters);
      while (statement.step()) rows.push(statement.get({}));
    } finally {
      this.statement.reset(true);
    }
    return rows;
  }
}

class WasmProjectDatabase implements ProjectDatabase {
  constructor(private readonly sqlite: WasmSqlite, private readonly db: WasmDb) {}

  get isTransaction(): boolean {
    return this.sqlite.capi.sqlite3_get_autocommit(this.db.pointer) === 0;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): ProjectStatement {
    return new WasmProjectStatement(this.sqlite, this.db, this.db.prepare(sql));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * An opener for one project that lives in memory: the first open makes the database, the later ones (the catalog
 * closes and reopens a new project) find it again, until `dispose`. Read-only opens are not used in the browser.
 */
export function wasmProjectDatabaseOpener(sqlite: WasmSqlite): { open: ProjectDatabaseOpener; dispose: () => void } {
  const open = new Map<string, WasmDb>();
  return {
    open: (file) => {
      let db = open.get(file);
      if (!db) {
        db = new sqlite.oo1.DB(":memory:", "c");
        open.set(file, db);
      }
      const shared = db;
      // Closing the store's handle keeps the memory database: it is the project's only copy.
      return Object.assign(new WasmProjectDatabase(sqlite, shared), { close: () => undefined });
    },
    dispose: () => {
      for (const db of open.values()) db.close();
      open.clear();
    },
  };
}
