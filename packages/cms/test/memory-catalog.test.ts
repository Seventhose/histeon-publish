import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { canonicalizeJson } from "@histos-publish/histos-contract";
import { afterEach, describe, expect, it } from "vitest";
import { memoryProjectCatalog } from "../src/memory-catalog.js";
import { wasmProjectDatabaseOpener, type WasmSqlite } from "../src/project-database-wasm.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { staticSiteToPrototype, type StaticSiteFile } from "../src/static-site-prototype.js";

/**
 * Doc 18 F6: the prototype import on SQLite for WebAssembly, in memory, as the WordPress administrator's browser runs
 * it, gives the same transfer profile as on node:sqlite and the disk, entity by entity and file by file.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function filesOf(root: string): StaticSiteFile[] {
  const out: StaticSiteFile[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: path.relative(root, full).split(path.sep).join("/"), bytes: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(root);
  return out;
}

describe("import in memoria su SQLite WebAssembly (F6)", () => {
  it.each(["blog-statico", "landing-bootstrap", "script-cdn"])("%s: stesso profilo che su disco", async (site) => {
    const converted = staticSiteToPrototype({ projectId: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4", name: site, files: filesOf(path.join(here, "fixtures/import-corpus", site)), structure: { parts: true, components: true, lists: true } });
    const parsed = parsePrototype(converted.html);
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-memory-"));
    roots.push(root);
    const catalog = new CmsProjectCatalog(root);
    await catalog.initialize();
    const disk = await buildPrototypeProfile(parsed, catalog);
    const sqlite = (await sqlite3InitModule()) as unknown as WasmSqlite;
    const opener = wasmProjectDatabaseOpener(sqlite);
    try {
      const memory = await buildPrototypeProfile(parsePrototype(converted.html), memoryProjectCatalog(opener.open));
      expect(canonicalizeJson(memory.profile.entities as never)).toBe(canonicalizeJson(disk.profile.entities as never));
      expect(canonicalizeJson(memory.profile.references as never)).toBe(canonicalizeJson(disk.profile.references as never));
      expect(memory.profile.manifest.requiredCapabilities).toEqual(disk.profile.manifest.requiredCapabilities);
      expect([...memory.files.keys()].sort()).toEqual([...disk.files.keys()].sort());
      for (const [name, bytes] of disk.files) expect(Buffer.compare(Buffer.from(memory.files.get(name)!), Buffer.from(bytes)), name).toBe(0);
    } finally {
      opener.dispose();
    }
  }, 60_000);
});
