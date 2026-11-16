import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_BYTES, HistosPublishError, inspectZipSource, normalizeRelativePath, readDirectorySource, readZipSource } from "@histos-publish/core";

export type LocalImportKind = "directory" | "html" | "zip";

export interface ImportFilePlan {
  path: string;
  size: number;
}

interface ImportSession {
  id: string;
  name: string;
  kind: LocalImportKind;
  targetSiteId?: string;
  directory: string;
  expected: Map<string, number>;
  received: Map<string, number>;
  totalBytes: number;
  receivedBytes: number;
  inFlight: Set<string>;
  /** «Fotografa la proposta»: what the capture says of these files, shown before the conversion's own notes. */
  notes?: string[];
  /** The pages captured from a proposal drawn by scripts, when the files are those (adopt): name, file, fragment. */
  captured?: Array<{ name: string; path: string; hash: string }>;
}

export interface CompletedImport {
  siteId: string;
  replaceExisting: boolean;
  name: string;
  kind: LocalImportKind;
  sourcePath: string;
  rootPath: string;
  fileCount: number;
  totalBytes: number;
}

const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024;

export class ImportManager {
  private readonly sessions = new Map<string, ImportSession>();
  private readonly directory: string;

  constructor(private readonly dataDirectory: string) {
    this.directory = path.join(dataDirectory, "imports");
  }

  async start(input: { name: unknown; kind: unknown; files: unknown; targetSiteId?: unknown }): Promise<{ id: string; fileCount: number; totalBytes: number }> {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const kind = input.kind;
    if (name.length < 1 || name.length > 80) throw new HistosPublishError("Il nome del sito deve contenere da 1 a 80 caratteri.", "site-invalid", 2);
    if (kind !== "directory" && kind !== "html" && kind !== "zip") throw new HistosPublishError("Tipo di file locale non valido.", "import-invalid", 2);
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > DEFAULT_MAX_FILES) {
      throw new HistosPublishError(`Seleziona da 1 a ${DEFAULT_MAX_FILES} file.`, "import-limit", 3);
    }
    const expected = new Map<string, number>();
    let totalBytes = 0;
    for (const item of input.files) {
      if (typeof item !== "object" || item === null) throw new HistosPublishError("Elenco dei file non valido.", "import-invalid", 2);
      const file = item as Record<string, unknown>;
      if (typeof file.path !== "string" || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_IMPORT_FILE_BYTES) {
        throw new HistosPublishError("Un file supera il limite di importazione di 100 MiB o ha una dimensione non valida.", "import-limit", 3);
      }
      const normalized = normalizeRelativePath(file.path);
      if (!normalized || expected.has(normalized.path)) throw new HistosPublishError(`Percorso non valido o duplicato: ${file.path}`, "import-path-invalid", 2);
      expected.set(normalized.path, file.size);
      totalBytes += file.size;
      if (totalBytes > DEFAULT_MAX_TOTAL_BYTES) throw new HistosPublishError("La selezione supera il limite di importazione di 512 MiB.", "import-limit", 3);
    }
    if (kind === "html" && expected.size !== 1) throw new HistosPublishError("Seleziona un solo file HTML.", "import-invalid", 2);
    if (kind === "zip" && (expected.size !== 1 || !/\.zip$/iu.test([...expected.keys()][0] ?? ""))) {
      throw new HistosPublishError("Seleziona un solo archivio ZIP.", "import-invalid", 2);
    }
    const targetSiteId = input.targetSiteId;
    if (targetSiteId !== undefined && (typeof targetSiteId !== "string" || !/^[0-9a-f-]{36}$/iu.test(targetSiteId))) {
      throw new HistosPublishError("Il progetto da aggiornare non è valido.", "site-invalid", 2);
    }
    const id = randomUUID();
    const directory = path.join(this.directory, id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: false, mode: 0o700 });
    this.sessions.set(id, { id, name, kind, directory, ...(typeof targetSiteId === "string" ? { targetSiteId } : {}), expected, received: new Map(), totalBytes, receivedBytes: 0, inFlight: new Set() });
    return { id, fileCount: expected.size, totalBytes };
  }

  async receive(id: string, encodedPath: string, request: IncomingMessage): Promise<{ path: string; bytes: number }> {
    const session = this.requireSession(id);
    let relativePath: string;
    try { relativePath = encodedPath.split("/").map(decodeURIComponent).join("/"); }
    catch { throw new HistosPublishError("Il percorso del file caricato non è valido.", "import-path-invalid", 2); }
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized || normalized.path !== relativePath) throw new HistosPublishError("Il percorso del file caricato non è sicuro.", "import-path-invalid", 2);
    const expectedSize = session.expected.get(relativePath);
    if (expectedSize === undefined) throw new HistosPublishError("Il file non era incluso nella selezione iniziale.", "import-unplanned-file", 2);
    if (session.received.has(relativePath) || session.inFlight.has(relativePath)) throw new HistosPublishError("Il file è già stato caricato.", "import-duplicate-file", 2);
    session.inFlight.add(relativePath);
    const destination = path.resolve(session.directory, ...relativePath.split("/"));
    const boundary = `${path.resolve(session.directory)}${path.sep}`;
    if (!destination.startsWith(boundary)) {
      session.inFlight.delete(relativePath);
      throw new HistosPublishError("Il file caricato esce dalla cartella di importazione.", "import-path-invalid", 2);
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let received = 0;
    try {
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      handle = await open(destination, "wx", 0o600);
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.byteLength;
        if (received > expectedSize || received > MAX_IMPORT_FILE_BYTES || session.receivedBytes + received > DEFAULT_MAX_TOTAL_BYTES) {
          throw new HistosPublishError("Il contenuto caricato supera la dimensione dichiarata.", "import-size-mismatch", 3);
        }
        await handle.write(bytes);
      }
      if (received !== expectedSize) throw new HistosPublishError("La dimensione del file caricato non corrisponde alla selezione.", "import-size-mismatch", 2);
      session.received.set(relativePath, received);
      session.receivedBytes += received;
      return { path: relativePath, bytes: received };
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await handle?.close();
      session.inFlight.delete(relativePath);
    }
  }

  async complete(id: string): Promise<CompletedImport> {
    const session = this.requireSession(id);
    if (session.inFlight.size > 0 || session.received.size !== session.expected.size) {
      throw new HistosPublishError("Il caricamento non è completo. Riprova a inviare i file mancanti.", "import-incomplete", 2);
    }
    if (session.kind === "directory" && !session.received.has("index.html")) {
      throw new HistosPublishError("La cartella non contiene index.html. Seleziona la cartella principale del sito.", "import-index-missing", 2);
    }
    const siteId = session.targetSiteId ?? randomUUID();
    const sourceDirectory = session.targetSiteId
      ? path.join(this.dataDirectory, "sites", siteId, "sources", session.id)
      : path.join(this.dataDirectory, "sites", siteId, "source");
    await mkdir(path.dirname(sourceDirectory), { recursive: true, mode: 0o700 });
    await rename(session.directory, sourceDirectory);
    this.sessions.delete(id);

    let sourcePath = sourceDirectory;
    if (session.kind === "html" || session.kind === "zip") {
      const [relativePath] = [...session.expected.keys()];
      if (!relativePath) throw new HistosPublishError("La selezione è vuota.", "import-incomplete", 2);
      sourcePath = path.join(sourceDirectory, ...relativePath.split("/"));
    }
    return {
      siteId,
      replaceExisting: Boolean(session.targetSiteId),
      name: session.name,
      kind: session.kind,
      sourcePath,
      rootPath: sourceDirectory,
      fileCount: session.received.size,
      totalBytes: session.receivedBytes,
    };
  }

  /**
   * The files of a finished upload, read without creating a site (the CMS catalog converts them straight into a
   * project, doc 18 F1): an HTML page alone, a folder, or the files of a ZIP. The session stays until it is aborted,
   * so the conversion can be run again with other options; ZIPs are read with the same checks as a site's.
   */
  async sourceFiles(id: string, maxBytes: number): Promise<{ name: string; kind: LocalImportKind; notes: string[]; captured: boolean; capturedPages: Array<{ name: string; path: string; hash: string }>; files: Array<{ path: string; bytes: Uint8Array }> }> {
    const session = this.requireSession(id);
    const about = { name: session.name, kind: session.kind, notes: session.notes ?? [], captured: session.captured !== undefined, capturedPages: session.captured ?? [] };
    if (session.inFlight.size > 0 || session.received.size !== session.expected.size) {
      throw new HistosPublishError("Il caricamento non è completo. Riprova a inviare i file mancanti.", "import-incomplete", 2);
    }
    if (session.kind === "zip") {
      const [relativePath] = [...session.expected.keys()];
      if (!relativePath) throw new HistosPublishError("L’archivio ZIP è vuoto.", "import-incomplete", 2);
      const zip = await readZipSource(path.join(session.directory, ...relativePath.split("/")), { maxBytes });
      return { ...about, files: zip.files.map((file) => ({ path: file.path, bytes: file.bytes })) };
    }
    const source = await readDirectorySource(session.directory, { maxBytes });
    if (session.kind === "html") {
      // One page: it becomes the home page, whatever its file name.
      const [page] = source.files;
      if (!page) throw new HistosPublishError("La selezione è vuota.", "import-incomplete", 2);
      return { ...about, files: [{ path: "index.html", bytes: page.bytes }] };
    }
    if (!source.files.some((file) => file.path === "index.html")) throw new HistosPublishError("La cartella non contiene index.html. Seleziona la cartella principale del sito.", "import-index-missing", 2);
    return { ...about, files: source.files.map((file) => ({ path: file.path, bytes: file.bytes })) };
  }

  /**
   * «Fotografa la proposta»: the pages captured from the upload `from` become an upload of their own, complete, as
   * if the person had chosen that folder. They are files like any other: the conversion reads them with every check.
   */
  async adopt(from: string, files: ReadonlyArray<{ path: string; bytes: Uint8Array }>, notes: readonly string[], pages: ReadonlyArray<{ name: string; path: string; hash: string }>): Promise<{ id: string; fileCount: number; totalBytes: number }> {
    const origin = this.requireSession(from);
    if (files.length < 1 || files.length > DEFAULT_MAX_FILES) throw new HistosPublishError(`Seleziona da 1 a ${DEFAULT_MAX_FILES} file.`, "import-limit", 3);
    const expected = new Map<string, number>();
    let totalBytes = 0;
    for (const file of files) {
      const normalized = normalizeRelativePath(file.path);
      if (!normalized || normalized.path !== file.path || expected.has(file.path)) throw new HistosPublishError(`Percorso non valido o duplicato: ${file.path}`, "import-path-invalid", 2);
      if (file.bytes.byteLength > MAX_IMPORT_FILE_BYTES) throw new HistosPublishError("Un file supera il limite di importazione di 100 MiB o ha una dimensione non valida.", "import-limit", 3);
      expected.set(file.path, file.bytes.byteLength);
      totalBytes += file.bytes.byteLength;
      if (totalBytes > DEFAULT_MAX_TOTAL_BYTES) throw new HistosPublishError("La selezione supera il limite di importazione di 512 MiB.", "import-limit", 3);
    }
    if (!expected.has("index.html")) throw new HistosPublishError("La cartella non contiene index.html. Seleziona la cartella principale del sito.", "import-index-missing", 2);
    const id = randomUUID();
    const directory = path.join(this.directory, id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: false, mode: 0o700 });
    try {
      const boundary = `${path.resolve(directory)}${path.sep}`;
      for (const file of files) {
        const destination = path.resolve(directory, ...file.path.split("/"));
        if (!destination.startsWith(boundary)) throw new HistosPublishError("Il file caricato esce dalla cartella di importazione.", "import-path-invalid", 2);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 });
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    this.sessions.set(id, { id, name: origin.name, kind: "directory", directory, expected, received: new Map(expected), totalBytes, receivedBytes: totalBytes, inFlight: new Set(), notes: notes.slice(0, 200).map((note) => note.slice(0, 400)), captured: pages.map((page) => ({ name: page.name, path: page.path, hash: page.hash })) });
    return { id, fileCount: expected.size, totalBytes };
  }

  async inspectZip(id: string): Promise<Awaited<ReturnType<typeof inspectZipSource>>> {
    const session = this.requireSession(id);
    if (session.kind !== "zip") throw new HistosPublishError("Il controllo ZIP è disponibile solo per un archivio.", "import-invalid", 2);
    if (session.inFlight.size > 0 || session.received.size !== session.expected.size) {
      throw new HistosPublishError("Completa il caricamento prima di controllare lo ZIP.", "import-incomplete", 2);
    }
    const [relativePath] = [...session.expected.keys()];
    if (!relativePath) throw new HistosPublishError("L’archivio ZIP è vuoto.", "import-incomplete", 2);
    return inspectZipSource(path.join(session.directory, ...relativePath.split("/")));
  }

  async abort(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await rm(session.directory, { recursive: true, force: true });
  }

  async cleanup(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.abort(id);
  }

  private requireSession(id: string): ImportSession {
    const session = this.sessions.get(id);
    if (!session) throw new HistosPublishError("Sessione di importazione non trovata o scaduta.", "import-missing", 404);
    return session;
  }
}
