import { DatabaseSync } from "node:sqlite";
import type { ProjectDatabase, ProjectDatabaseOpener } from "./project-database.js";

/** The project database in Histeon Publish: a file opened with `node:sqlite` (project-database.ts). */
export const openNodeProjectDatabase: ProjectDatabaseOpener = (file, options = {}) => new DatabaseSync(file, options.readOnly ? { readOnly: true } : {}) as unknown as ProjectDatabase;
