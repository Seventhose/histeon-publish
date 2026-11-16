import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

/** The largest prototype the app reads, as the importer (PROTOTYPE_MAX_BYTES). */
export const PROTOTYPE_REREAD_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Opened without blocking and without taking a terminal: a FIFO named proto.html (the agent working in that folder can
 * swap the file for one) would otherwise hold the open until a writer comes, and with it «Ricontrolla» and every
 * control of the app; a tty would become the app's controlling terminal. On a regular file neither flag changes
 * anything, and the fstat below refuses whatever is not one. Never a stat() before the open: the file could be swapped
 * in between. Windows has neither flag (0).
 */
const REREAD_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);

/** How a file is opened; a test stands in for a folder that stops answering. */
export type RereadOpen = (file: string, flags: number) => Promise<FileHandle>;

/**
 * The reread still running, if any. A read cannot be stopped once the system has it: on a network folder that stopped
 * answering (an SMB or NFS hard mount, where O_NONBLOCK does nothing for a regular file) the open or the read holds one
 * of the threads (four, libuv's default) that every file access, hash, compression and name lookup of the main process
 * shares, the local server's included. The preload stops waiting after a minute and «Ricontrolla» works again: each
 * press would hold one more thread, until none is left for the server. So at most one reread runs at a time, and a
 * press while it still runs reads nothing (null: "sceglilo di nuovo"; a file chosen again is read by the window, not
 * here).
 */
let pending: Promise<Uint8Array | null> | null = null;

/**
 * E4 «Ricontrolla»: the bytes of a prototype the user chose or dropped, read again from disk, or null. The path comes
 * from the preload, which gets it only for a file of the user's (webUtils.getPathForFile); here it must still be an
 * absolute .html/.htm path of a regular file of at most 32 MB, or nothing is read. The preload applies the same name
 * test for canRereadPrototypeFile, so the app offers «Ricontrolla» only for a file this can read: keep the two in step.
 * Null too while an earlier reread has not finished (see `pending`).
 */
export async function rereadPrototypeFile(value: unknown, openFile: RereadOpen = open): Promise<Uint8Array | null> {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value) || !/\.html?$/iu.test(value)) return null;
  if (pending) return null;
  const reading = readPrototype(value, openFile);
  pending = reading;
  try {
    return await reading;
  } finally {
    pending = null;
  }
}

async function readPrototype(file: string, openFile: RereadOpen): Promise<Uint8Array | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await openFile(file, REREAD_FLAGS);
    const info = await handle.stat();
    if (!info.isFile() || info.size > PROTOTYPE_REREAD_MAX_BYTES) return null;
    const bytes = await handle.readFile();
    return bytes.length > PROTOTYPE_REREAD_MAX_BYTES ? null : new Uint8Array(bytes);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
