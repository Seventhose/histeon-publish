/**
 * Folders that group CMS projects (kind "cms") or sites ("sites"), one level deep: often they are versions of one
 * project, proposals 10 and 20 of the same thing. A folder holds nothing itself: it is a name, and each project or site
 * says which folder it is in (or none). Deleting a folder puts what it held back at the top; nothing else is touched.
 * Stored as one setting; pure functions over it, so the server and the tests read the same rules.
 */
import { randomUUID } from "node:crypto";
import { HistosPublishError } from "@histos-publish/core";

export type FolderKind = "cms" | "sites";
export interface Folder { id: string; kind: FolderKind; name: string; createdAt: string }
export interface FolderState { version: 1; folders: Folder[]; members: Record<FolderKind, Record<string, string>> }

export const FOLDERS_SETTING = "folders";
export const FOLDER_NAME_MAX = 80;
export const FOLDERS_MAX = 500;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const emptyFolders = (): FolderState => ({ version: 1, folders: [], members: { cms: {}, sites: {} } });

/** What the setting holds, read defensively: anything malformed is left out, never trusted. */
export function readFolders(raw: unknown): FolderState {
  const state = emptyFolders();
  if (!raw || typeof raw !== "object") return state;
  const value = raw as { folders?: unknown; members?: unknown };
  if (Array.isArray(value.folders)) {
    for (const item of value.folders.slice(0, FOLDERS_MAX)) {
      const folder = item as Partial<Folder>;
      if (typeof folder.id !== "string" || !ID.test(folder.id) || !isKind(folder.kind) || typeof folder.name !== "string") continue;
      if (state.folders.some((other) => other.id === folder.id)) continue;
      state.folders.push({ id: folder.id, kind: folder.kind, name: folder.name.slice(0, FOLDER_NAME_MAX), createdAt: typeof folder.createdAt === "string" ? folder.createdAt : "" });
    }
  }
  const members = value.members as Partial<Record<FolderKind, unknown>> | undefined;
  for (const kind of ["cms", "sites"] as const) {
    const map = members?.[kind];
    if (!map || typeof map !== "object") continue;
    for (const [item, folderId] of Object.entries(map as Record<string, unknown>)) {
      if (ID.test(item) && typeof folderId === "string" && state.folders.some((folder) => folder.id === folderId && folder.kind === kind)) state.members[kind][item] = folderId;
    }
  }
  return state;
}

export function isKind(value: unknown): value is FolderKind {
  return value === "cms" || value === "sites";
}

/** A folder name: trimmed, 1–80 characters, no control characters. */
export function folderName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  if (!name || name.length > FOLDER_NAME_MAX || /\p{Cc}/u.test(name)) throw new HistosPublishError(`Il nome della cartella deve avere da 1 a ${FOLDER_NAME_MAX} caratteri.`, "folder-invalid", 400);
  return name;
}

export function createFolder(state: FolderState, kind: unknown, name: unknown, now = new Date()): Folder {
  if (!isKind(kind)) throw new HistosPublishError("Tipo di cartella non valido.", "folder-invalid", 400);
  if (state.folders.length >= FOLDERS_MAX) throw new HistosPublishError(`Ci sono già ${FOLDERS_MAX} cartelle.`, "folder-invalid", 400);
  const folder: Folder = { id: randomUUID(), kind, name: folderName(name), createdAt: now.toISOString() };
  state.folders.push(folder);
  return folder;
}

export function requireFolder(state: FolderState, id: string): Folder {
  const folder = state.folders.find((item) => item.id === id);
  if (!folder) throw new HistosPublishError("La cartella non esiste più.", "folder-missing", 404);
  return folder;
}

export function renameFolder(state: FolderState, id: string, name: unknown): Folder {
  const folder = requireFolder(state, id);
  folder.name = folderName(name);
  return folder;
}

/** The folder goes; what it held is back at the top. */
export function deleteFolder(state: FolderState, id: string): void {
  const folder = requireFolder(state, id);
  state.folders = state.folders.filter((item) => item.id !== id);
  const members = state.members[folder.kind];
  for (const [item, folderId] of Object.entries(members)) if (folderId === id) delete members[item];
}

/** Moves projects or sites into a folder of their kind, or out of any (`folderId` null). Ids must be known. */
export function moveToFolder(state: FolderState, kind: unknown, ids: unknown, folderId: unknown, known: ReadonlySet<string>): number {
  if (!isKind(kind)) throw new HistosPublishError("Tipo di cartella non valido.", "folder-invalid", 400);
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every((id) => typeof id === "string" && known.has(id))) throw new HistosPublishError("Elementi da spostare non validi.", "folder-invalid", 400);
  if (folderId !== null) {
    if (typeof folderId !== "string") throw new HistosPublishError("Cartella non valida.", "folder-invalid", 400);
    if (requireFolder(state, folderId).kind !== kind) throw new HistosPublishError("La cartella è di un altro elenco.", "folder-invalid", 400);
  }
  for (const id of ids as string[]) {
    if (folderId === null) delete state.members[kind][id];
    else state.members[kind][id] = folderId;
  }
  return ids.length;
}

/** A project or site deleted for good leaves its folder. */
export function dropMember(state: FolderState, kind: FolderKind, id: string): boolean {
  if (!(id in state.members[kind])) return false;
  delete state.members[kind][id];
  return true;
}
