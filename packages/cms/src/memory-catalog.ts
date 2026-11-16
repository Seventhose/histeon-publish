import { memoryMediaFiles, type ProjectDatabaseOpener } from "./project-database.js";
import { CmsProjectStore, type CmsProject, type CmsProjectCatalog } from "./project-repository.js";

/**
 * A catalog that makes projects in memory (doc 18 F6): what the prototype import needs of a catalog
 * (`createProject`), with the same project store as Histeon Publish, on the database `openDatabase` gives (SQLite for
 * WebAssembly, in the browser) and media kept in memory. Nothing is written to a disk; the project lives as long as
 * the conversion that makes its `.xbsite`.
 */
export function memoryProjectCatalog(openDatabase: ProjectDatabaseOpener): Pick<CmsProjectCatalog, "createProject"> {
  return {
    async createProject(name, seed = {}) {
      const cleanName = name.trim();
      if (!cleanName || cleanName.length > 120) throw new TypeError("Il nome del progetto deve contenere da 1 a 120 caratteri.");
      const id = seed.id ?? globalThis.crypto.randomUUID();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) throw new TypeError("Identificativo progetto non valido.");
      const now = new Date().toISOString();
      const project: CmsProject = { id, name: cleanName, directory: `/histos-memory/${id}`, createdAt: now, updatedAt: now, schemaVersion: 1 };
      const store = new CmsProjectStore(project, { durable: false, openDatabase, mediaFiles: memoryMediaFiles() });
      store.createPage(seed.page ?? { title: "Home", slug: "home" });
      store.createStyles(seed.styles?.content, seed.styles?.id);
      return { project, store };
    },
  };
}
