import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUPS_KEPT, prepareBackup, readBuildTextFile, requirePrivateDataDirectory } from "../src/connector-files.js";

/**
 * Unit tests of the connector's file helpers (docs/progettazione/histos-cms/16-connettore-ai.md §3.2): backups that
 * only count once the update committed, the real-path check of build files and the private data folder.
 */

/**
 * Real paths the file system would report for an alias: on Windows a short 8.3 name (HISTOS~1) passes every check on
 * the requested segments and only its real path shows the hidden ".histos" entry. POSIX has no such alias, so
 * realpath maps one folder by hand; everything else goes to the real function.
 */
const aliases = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { sep } = await import("node:path");
  const realpath = (async (target: Parameters<typeof actual.realpath>[0], options?: Parameters<typeof actual.realpath>[1]) => {
    const real = String(await actual.realpath(target, options));
    for (const [alias, hidden] of aliases) if (real === alias || real.startsWith(`${alias}${sep}`)) return `${hidden}${real.slice(alias.length)}`;
    return real;
  }) as typeof actual.realpath;
  return { ...actual, realpath, default: { ...actual, realpath } };
});

const POSIX = process.platform !== "win32";
const PROJECT_ID = "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10";
const BACKUP_NAME = /^\d{8}-\d{6}Z-[0-9a-f]{6}\.histosproject$/u;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "histos-connector-files-"));
  aliases.clear();
});

afterEach(async () => {
  vi.useRealTimers();
  aliases.clear();
  await chmod(root, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe("prepareBackup", () => {
  const connectorDirectory = () => path.join(root, "connector");
  const projectBackups = () => path.join(connectorDirectory(), "backups", PROJECT_ID);
  const archive = Buffer.from("archivio .histosproject di prova");

  async function names(): Promise<string[]> {
    return (await readdir(projectBackups())).sort();
  }

  async function existing(list: string[]): Promise<void> {
    await mkdir(projectBackups(), { recursive: true, mode: 0o700 });
    for (const name of list) await writeFile(path.join(projectBackups(), name), name, { mode: 0o600 });
  }

  it("names the backup with a UTC stamp, whatever the local time zone", async () => {
    const zone = process.env.TZ;
    // The night the clocks go forward in Rome: a local name would read 03:30.
    process.env.TZ = "Europe/Rome";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-29T01:30:05.000Z"));
    try {
      const pending = await prepareBackup(connectorDirectory(), PROJECT_ID, archive);
      expect(pending.name).toMatch(BACKUP_NAME);
      expect(pending.name.startsWith("20260329-013005Z-")).toBe(true);
      await pending.discard();
    } finally {
      vi.useRealTimers();
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("writes a hidden pending file and gives it its name only at commit", async () => {
    const pending = await prepareBackup(connectorDirectory(), PROJECT_ID, archive);
    const before = await names();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatch(/^\.pending-[0-9a-f]{12}\.histosproject$/u);
    expect(before).not.toContain(pending.name);

    await pending.commit();
    expect(await names()).toEqual([pending.name]);
    const file = path.join(projectBackups(), pending.name);
    expect(await readFile(file)).toEqual(archive);
    if (POSIX) expect((await lstat(file)).mode & 0o777).toBe(0o600);
  });

  it("keeps five backups and never deletes the one just committed, even when the others sort after it", async () => {
    const future = [0, 1, 2, 3, 4].map((index) => `29990101-000000Z-00000${index}.histosproject`);
    // Another update's backup still pending, and a file that is not a backup: neither is touched.
    await existing([...future, ".pending-aaaaaaaaaaaa.histosproject", "leggimi.txt"]);
    const pending = await prepareBackup(connectorDirectory(), PROJECT_ID, archive);
    await pending.commit();
    const kept = (await names()).filter((name) => BACKUP_NAME.test(name));
    expect(kept).toHaveLength(BACKUPS_KEPT);
    expect(kept).toContain(pending.name);
    // The oldest name goes, so that with the new one there are five.
    expect(kept.filter((name) => name !== pending.name)).toEqual(future.slice(1));
    expect(await names()).toEqual(expect.arrayContaining([".pending-aaaaaaaaaaaa.histosproject", "leggimi.txt"]));
    expect(await readFile(path.join(projectBackups(), pending.name))).toEqual(archive);
  });

  it("prunes older backups down to the newest four plus the new one", async () => {
    const old = [1, 2, 3, 4, 5, 6].map((day) => `2020010${day}-120000Z-abcdef.histosproject`);
    await existing(old);
    const pending = await prepareBackup(connectorDirectory(), PROJECT_ID, archive);
    await pending.commit();
    expect((await names()).filter((name) => BACKUP_NAME.test(name))).toEqual([...old.slice(2), pending.name].sort());
  });

  it("discard removes only the pending file and leaves the existing backups as they were", async () => {
    const old = [1, 2, 3, 4, 5].map((day) => `2020010${day}-120000Z-abcdef.histosproject`);
    await existing(old);
    const before = await names();
    const pending = await prepareBackup(connectorDirectory(), PROJECT_ID, archive);
    expect((await names()).some((name) => name.startsWith(".pending-"))).toBe(true);
    await pending.discard();
    expect(await names()).toEqual(before);
    for (const name of old) expect(await readFile(path.join(projectBackups(), name), "utf8")).toBe(name);
  });

  it("refuses a project id that is not a lowercase UUID, before creating anything", async () => {
    for (const projectId of ["../../etc", "", "not-a-uuid", PROJECT_ID.toUpperCase(), `${PROJECT_ID}/../x`, `${PROJECT_ID}\n`]) {
      await expect(prepareBackup(connectorDirectory(), projectId, archive), JSON.stringify(projectId)).rejects.toMatchObject({ code: "connector-backup-invalid" });
    }
    expect(await readdir(root)).toEqual([]);
  });
});

describe("readBuildTextFile", () => {
  const buildId = "b6d0c1f2-3a4e-4f5a-8b6c-7d8e9f0a1b2c";
  const buildRoot = () => path.join(root, "histos-cms-builds", PROJECT_ID, buildId);

  beforeEach(async () => {
    await mkdir(path.join(buildRoot(), "HISTOS~1"), { recursive: true });
    await writeFile(path.join(buildRoot(), "HISTOS~1", "index.html"), "SEGRETO-NASCOSTO");
    await mkdir(path.join(buildRoot(), ".histos"));
    await writeFile(path.join(buildRoot(), ".histos", "index.html"), "SEGRETO-NASCOSTO");
    await writeFile(path.join(buildRoot(), "index.html"), "<h1>Home</h1>");
  });

  const read = (relative: string) => readBuildTextFile({ dataDirectory: root, projectId: PROJECT_ID, buildId, path: relative });

  // Simulates Windows on another system; on Windows itself the request check refuses the short name first.
  it.runIf(process.platform !== "win32")("refuses a file whose real path passes through a folder starting with «.»", async () => {
    // Without the alias the folder is an ordinary one and its file is readable: the refusal below is the real path's.
    expect(await read("HISTOS~1/index.html")).toMatchObject({ path: "HISTOS~1/index.html", text: "SEGRETO-NASCOSTO" });
    const realRoot = await realpath(buildRoot());
    aliases.set(path.join(realRoot, "HISTOS~1"), path.join(realRoot, ".histos"));
    const refused = await read("HISTOS~1/index.html").catch((reason: unknown) => reason);
    expect(refused).toMatchObject({ code: "connector-build-file-missing", exitCode: 404 });
    expect((refused as Error).message).not.toContain("SEGRETO");
    expect(await read("index.html")).toMatchObject({ text: "<h1>Home</h1>" });
  });

  // Simulates Windows on another system; on Windows itself the request check refuses the short name first.
  it.runIf(process.platform !== "win32")("on Windows refuses a short 8.3 name in the request before touching the disk", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    let refused: Promise<unknown>;
    // The check runs before the first await, so the platform is only swapped for this synchronous part.
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    try {
      refused = read("HISTOS~1/index.html");
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
    await expect(refused).rejects.toMatchObject({ code: "connector-build-path-invalid", exitCode: 400 });
    expect(await read("HISTOS~1/index.html")).toMatchObject({ text: "SEGRETO-NASCOSTO" });
  });

  it.runIf(POSIX)("a build folder that is a link elsewhere says the file is missing, and a build that is not there says so", async () => {
    const elsewhere = path.join(root, "altrove");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, "index.html"), "ALTROVE");
    await rm(buildRoot(), { recursive: true });
    await symlink(elsewhere, buildRoot(), "dir");
    const refused = await read("index.html").catch((reason: unknown) => reason);
    expect(refused).toMatchObject({ code: "connector-build-file-missing", exitCode: 404 });
    await rm(buildRoot());
    await expect(read("index.html")).rejects.toMatchObject({ code: "cms-build-missing", exitCode: 404 });
  });
});

describe.runIf(POSIX)("requirePrivateDataDirectory", () => {
  it("accepts a data folder of this user closed to writes by others (0700, 0755)", async () => {
    for (const mode of [0o700, 0o755]) {
      await chmod(root, mode);
      await expect(requirePrivateDataDirectory(root), mode.toString(8)).resolves.toBeUndefined();
    }
  });

  it("refuses a data folder writable by group or others, or a link to one", async () => {
    for (const mode of [0o777, 0o770, 0o720, 0o702]) {
      await chmod(root, mode);
      await expect(requirePrivateDataDirectory(root), mode.toString(8)).rejects.toMatchObject({ code: "connector-unsafe-directory", exitCode: 409 });
    }
    await chmod(root, 0o700);
    const real = path.join(root, "vera");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, path.join(root, "collegata"), "dir");
    await expect(requirePrivateDataDirectory(path.join(root, "collegata"))).rejects.toMatchObject({ code: "connector-unsafe-directory" });
    await writeFile(path.join(root, "file"), "");
    await expect(requirePrivateDataDirectory(path.join(root, "file"))).rejects.toMatchObject({ code: "connector-unsafe-directory" });
  });
});
