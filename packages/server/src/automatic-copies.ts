import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type CmsProjectCatalog, encodeNativeProjectArchive } from "@histos-publish/cms";

/**
 * A copy of each site that changed, once a day, the last three kept: a mistake or a broken disk costs a day at most.
 * One site at a time and in the background: the app stays free, and a copy that fails only leaves the older ones.
 */

const KEPT = 3;
const DAY = 24 * 60 * 60 * 1000;
const SEALED = Buffer.from("HISTOSCOPY1\n");
const SEALED_NAME = ".histosproject.sealed";
/** The largest sealed copy: a project backup at its limit (512 MiB, cms project-archive.ts) plus header, salt, iv and tag. */
export const SEALED_COPY_MAX_BYTES = 512 * 1024 * 1024 + SEALED.byteLength + 44;
/** The JSON that brings a sealed copy to open: the copy in base64 and room for its passphrase. */
export const OPEN_COPY_BODY_MAX_BYTES = Math.ceil(SEALED_COPY_MAX_BYTES / 3) * 4 + 64 * 1024;

/** A folder outside the computer in practice, one a sync client carries away, and the passphrase of what goes there. */
export interface OutsideCopies { folder: string; passphrase: string }

const keyOf = (passphrase: string, salt: Buffer): Promise<Buffer> => new Promise((done, failed) => {
  scrypt(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? failed(error) : done(key)));
});

/** AES-256-GCM with a key from the passphrase: without it, a copy says nothing, and any change to the file is refused. */
export async function sealCopy(bytes: Uint8Array, passphrase: string): Promise<Buffer> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await keyOf(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([SEALED, salt, iv, cipher.getAuthTag(), body]);
}

export async function openSealedCopy(sealed: Buffer, passphrase: string): Promise<Buffer> {
  const start = SEALED.byteLength;
  if (sealed.byteLength < start + 44 || !sealed.subarray(0, start).equals(SEALED)) throw new TypeError("Il file non è una copia cifrata di Histeon Publish.");
  const decipher = createDecipheriv("aes-256-gcm", await keyOf(passphrase, sealed.subarray(start, start + 16)), sealed.subarray(start + 16, start + 28));
  decipher.setAuthTag(sealed.subarray(start + 28, start + 44));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(start + 44)), decipher.final()]);
  } catch {
    throw new TypeError("La frase non apre questa copia, o il file è stato alterato.");
  }
}

export async function copyChangedSites(input: { catalog: CmsProjectCatalog; folder: string; now?: Date; outside?: OutsideCopies | null }): Promise<number> {
  const today = (input.now ?? new Date()).toISOString().slice(0, 10);
  let copied = 0;
  for (const project of await input.catalog.listProjects()) {
    const folder = path.join(input.folder, project.id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const existing = (await readdir(folder)).filter((name) => name.endsWith(".histosproject")).sort();
    const latest = existing.at(-1)?.slice(0, 10);
    if (latest === today || (latest && latest >= project.updatedAt.slice(0, 10))) continue;
    const opened = await input.catalog.openProject(project.id);
    if (!opened) continue;
    try {
      const archive = await encodeNativeProjectArchive(opened.project, opened.store);
      await writeFile(path.join(folder, `${today}.histosproject`), archive, { mode: 0o600 });
      copied += 1;
      // Old copies go only once the copy of the day exists: a day that fails keeps them all.
      for (const old of existing.slice(0, Math.max(0, existing.length + 1 - KEPT))) await rm(path.join(folder, old), { force: true });
      if (input.outside) {
        const away = path.join(input.outside.folder, "histos-publish", project.id);
        await mkdir(away, { recursive: true, mode: 0o700 });
        await writeFile(path.join(away, `${today}${SEALED_NAME}`), await sealCopy(archive, input.outside.passphrase), { mode: 0o600 });
        const older = (await readdir(away)).filter((name) => name.endsWith(SEALED_NAME)).sort();
        for (const old of older.slice(0, Math.max(0, older.length - KEPT))) await rm(path.join(away, old), { force: true });
      }
    } catch { /* Too large for an archive, or busy: the next day tries again. */ } finally {
      opened.store.close();
    }
  }
  return copied;
}

/**
 * Whether the saved passphrase still opens the newest copy in the folder: a phrase changed by mistake or a copy that
 * came back damaged is better found now than on the day it is needed.
 */
export async function checkOutsideCopy(outside: OutsideCopies): Promise<"ok" | "wrong" | "none"> {
  const root = path.join(outside.folder, "histos-publish");
  const projects = await readdir(root).catch(() => [] as string[]);
  const copies: Array<{ name: string; file: string }> = [];
  for (const project of projects) {
    for (const name of await readdir(path.join(root, project)).catch(() => [] as string[])) {
      if (name.endsWith(SEALED_NAME)) copies.push({ name, file: path.join(root, project, name) });
    }
  }
  const newest = copies.sort((a, b) => a.name.localeCompare(b.name)).at(-1);
  if (!newest) return "none";
  try {
    await openSealedCopy(await readFile(newest.file), outside.passphrase);
    return "ok";
  } catch {
    return "wrong";
  }
}

export function startAutomaticCopies(input: { catalog: CmsProjectCatalog; folder: string; outside?: () => Promise<OutsideCopies | null>; checked?: (result: "ok" | "wrong" | "none") => void }): () => void {
  const run = (): void => {
    void (input.outside?.() ?? Promise.resolve(null)).then(async (outside) => {
      await copyChangedSites({ catalog: input.catalog, folder: input.folder, outside });
      if (outside) input.checked?.(await checkOutsideCopy(outside));
    }).catch(() => undefined);
  };
  const first = setTimeout(run, 5 * 60 * 1000);
  const daily = setInterval(run, DAY);
  first.unref();
  daily.unref();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
