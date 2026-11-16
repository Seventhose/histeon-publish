import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { readFile } from "node:fs/promises";

const ftp = vi.hoisted(() => ({
  access: vi.fn(),
  ensureDir: vi.fn(),
  list: vi.fn(),
  pwd: vi.fn(),
  uploadFrom: vi.fn(),
  remove: vi.fn(),
  cd: vi.fn(),
  close: vi.fn(),
  clients: [] as Array<{ ftp: { verbose: boolean } }>,
  remoteFiles: new Set<string>(),
}));

const ssh = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  files: new Map<string, Buffer>(),
  directories: new Set<string>(["/", "."]),
  hostKeyHex: "",
  rejectUploadPath: "",
  sftpOperations: [] as string[],
}));

vi.mock("basic-ftp", () => ({
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 3 },
  Client: class {
    ftp = { verbose: true };
    access = ftp.access;
    ensureDir = ftp.ensureDir;
    list = ftp.list;
    pwd = ftp.pwd;
    uploadFrom = ftp.uploadFrom;
    remove = ftp.remove;
    cd = ftp.cd;
    close = ftp.close;

    constructor() { ftp.clients.push(this); }
  },
}));

vi.mock("ssh2", async (importOriginal) => {
  const original = await importOriginal<typeof import("ssh2")>();
  const { EventEmitter } = await import("node:events");
  class MockClient extends EventEmitter {
    connect(config: Record<string, unknown>) {
      ssh.configs.push(config);
      setImmediate(() => {
        const verifier = config.hostVerifier as ((hash: string) => boolean) | undefined;
        if (verifier && !verifier(ssh.hostKeyHex)) {
          this.emit("error", new Error("Host denied"));
          this.emit("close");
          return;
        }
        this.emit("ready");
      });
    }

    end() { setImmediate(() => this.emit("close")); }

    sftp(callback: (error: Error | undefined, sftp: unknown) => void) {
      callback(undefined, this.wrapper());
    }

    private wrapper() {
      const readDirectory = (directory: string) => {
        const prefix = directory === "/" ? "/" : `${directory.replace(/\/$/u, "")}/`;
        const names = new Set<string>();
        for (const name of ssh.directories) {
          if (!name.startsWith(prefix) || name === directory) continue;
          const tail = name.slice(prefix.length);
          if (tail && !tail.includes("/")) names.add(tail);
        }
        for (const name of ssh.files.keys()) {
          if (!name.startsWith(prefix)) continue;
          const tail = name.slice(prefix.length);
          if (tail && !tail.includes("/")) names.add(tail);
        }
        return [...names].map((filename) => {
          const remotePath = directory === "." ? filename : posix.join(directory, filename);
          const directoryEntry = ssh.directories.has(remotePath);
          return { filename, attrs: { mode: directoryEntry ? 0o040755 : 0o100644, size: ssh.files.get(remotePath)?.byteLength ?? 0 } };
        });
      };
      return {
        readdir: (directory: string, callback: (error: Error | undefined, entries?: Array<{ filename: string; attrs?: { mode?: number; size?: number } }>) => void) => {
          ssh.sftpOperations.push(`readdir:${directory}`);
          if (!ssh.directories.has(directory)) callback(new Error("No such directory"));
          else callback(undefined, readDirectory(directory));
        },
        mkdir: (directory: string, callback: (error?: Error) => void) => {
          ssh.sftpOperations.push(`mkdir:${directory}`);
          if (ssh.directories.has(directory)) { callback(new Error("Already exists")); return; }
          if (!ssh.directories.has(posix.dirname(directory))) { callback(new Error("Parent directory missing")); return; }
          ssh.directories.add(directory);
          callback();
        },
        stat: (directory: string, callback: (error: Error | undefined, stats?: { isDirectory: () => boolean }) => void) => {
          ssh.sftpOperations.push(`stat:${directory}`);
          if (ssh.directories.has(directory)) callback(undefined, { isDirectory: () => true });
          else callback(new Error("No such path"));
        },
        fastPut: async (localPath: string, remotePath: string, callback: (error?: Error) => void) => {
          ssh.sftpOperations.push(`fastPut:${remotePath}`);
          if (remotePath === ssh.rejectUploadPath) { callback(new Error("connection dropped")); return; }
          try { ssh.files.set(remotePath, await readFile(localPath)); callback(); }
          catch (error) { callback(error instanceof Error ? error : new Error(String(error))); }
        },
        unlink: (remotePath: string, callback: (error?: Error) => void) => {
          ssh.sftpOperations.push(`unlink:${remotePath}`);
          ssh.files.delete(remotePath);
          callback();
        },
      };
    }
  }
  return { ...original, Client: MockClient };
});

import { inspectStaticHostingDirectory, parseStaticHostingSettings, publishStaticBundle, uploadStaticHostingFiles, verifyStaticHostingConnection, withTemporaryStaticHostingFile } from "../src/static-hosting.js";

const settings = () => parseStaticHostingSettings({
  protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/public_html/site", publicUrl: "https://site.example.test/",
});
const credentials = { username: "publisher", password: "synthetic-password" };
const sftpKey = Buffer.from("synthetic-sftp-host-key").toString("base64");
const sftpHostKeyHex = createHash("sha256").update(Buffer.from(sftpKey, "base64")).digest("hex");
const sftpFingerprint = `SHA256:${Buffer.from(sftpHostKeyHex, "hex").toString("base64").replace(/=+$/u, "")}`;
const sftpSettings = () => parseStaticHostingSettings({
  protocol: "sftp", host: "publish.example.test", port: 2222, remoteDirectory: "/public/site", publicUrl: "https://publish.example.test",
  username: "publisher", hostKeyFingerprint: sftpFingerprint,
});

describe("pubblicazione su FTP/FTPS", () => {
  beforeEach(() => {
    ftp.access.mockResolvedValue(undefined);
    ftp.ensureDir.mockResolvedValue(undefined);
    ftp.remoteFiles.clear();
    ftp.list.mockImplementation(async () => [...ftp.remoteFiles].filter((name) => !name.includes("/")).map((name) => ({ name, type: 1, size: 0 })));
    ftp.pwd.mockResolvedValue("/");
    ftp.uploadFrom.mockImplementation(async (_stream: unknown, name: string) => { ftp.remoteFiles.add(name); });
    ftp.remove.mockImplementation(async (name: string) => { ftp.remoteFiles.delete(name); });
    ftp.cd.mockResolvedValue(undefined);
    ssh.configs.length = 0;
    ssh.files.clear();
    ssh.directories = new Set(["/", ".", "/public", "/public/site"]);
    ssh.hostKeyHex = sftpHostKeyHex;
    ssh.rejectUploadPath = "";
    ssh.sftpOperations.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
    ftp.clients.length = 0;
    ssh.configs.length = 0;
    ssh.sftpOperations.length = 0;
  });

  it("rifiuta FTP in chiaro se l’utente non lo abilita esplicitamente", () => {
    expect(() => parseStaticHostingSettings({ protocol: "ftp", host: "ftp.example.test", port: 21, remoteDirectory: "/site" }))
      .toThrow("FTP senza cifratura");
    expect(parseStaticHostingSettings({ protocol: "ftp", host: "ftp.example.test", port: 21, remoteDirectory: "/site", allowInsecureFtp: true }))
      .toMatchObject({ protocol: "ftp", allowInsecureFtp: true });
  });

  it("accetta solo CA PEM valide per FTPS e passa il certificato alla verifica TLS", async () => {
    const ca = await readFile(new URL("../../../scripts/fixtures/certs/ftps-test-cert.pem", import.meta.url), "utf8");
    const ftpsSettings = parseStaticHostingSettings({ protocol: "ftps", host: "127.0.0.1", port: 2121, remoteDirectory: "/site", tlsCaCertificate: ca });

    await verifyStaticHostingConnection(ftpsSettings, credentials);

    expect(ftp.access).toHaveBeenCalledWith(expect.objectContaining({
      secure: true,
      secureOptions: { ca: expect.stringContaining("BEGIN CERTIFICATE") },
    }));
    expect(() => parseStaticHostingSettings({ protocol: "ftps", host: "ftp.example.test", port: 21, remoteDirectory: "/site", tlsCaCertificate: "not a PEM" }))
      .toThrow("certificato CA in formato PEM");
    expect(() => parseStaticHostingSettings({ protocol: "sftp", host: "ssh.example.test", port: 22, remoteDirectory: "/site", tlsCaCertificate: ca }))
      .toThrow("si usa solo con FTPS");
  });

  it("verifica la scrittura su FTPS e rimuove il file temporaneo", async () => {
    await verifyStaticHostingConnection(settings(), credentials);

    expect(ftp.access).toHaveBeenCalledWith(expect.objectContaining({ host: "ftp.example.test", user: "publisher", secure: true }));
    expect(ftp.ensureDir).toHaveBeenCalledWith("/public_html/site");
    expect(ftp.uploadFrom).toHaveBeenCalledOnce();
    expect(ftp.remove).toHaveBeenCalledWith(expect.stringMatching(/^\.histos-publish-test-/u));
    expect(ftp.close).toHaveBeenCalledOnce();
  });

  it("controlla una cartella FTPS in sola lettura e segnala gli indizi WordPress", async () => {
    const rootEntries = [
      { name: ".", type: 2, size: 0 }, { name: "..", type: 2, size: 0 }, { name: "wp-admin", type: 2, size: 0 },
      { name: "wp-config.php", type: 1, size: 14 }, { name: "note.txt", type: 1, size: 4 },
    ];
    ftp.list.mockImplementation(async (remotePath: string) => remotePath === "/public_html/site" ? rootEntries : []);

    await expect(inspectStaticHostingDirectory(settings(), credentials)).resolves.toEqual({
      entryCount: 3,
      isEmpty: false,
      wordpressSignals: ["wp-admin", "wp-config.php"],
      remoteFiles: [{ path: "wp-config.php", size: 14 }, { path: "note.txt", size: 4 }],
      remoteInventoryComplete: true,
    });
    expect(ftp.access).toHaveBeenCalledOnce();
    expect(ftp.list).toHaveBeenCalledWith("/public_html/site");
    expect(ftp.list).toHaveBeenCalledWith("/public_html/site/wp-admin");
    expect(ftp.ensureDir).not.toHaveBeenCalled();
    expect(ftp.uploadFrom).not.toHaveBeenCalled();
    expect(ftp.remove).not.toHaveBeenCalled();
    expect(ftp.close).toHaveBeenCalledOnce();
  });

  it("riconosce la cartella vuota senza creare la destinazione", async () => {
    ftp.list.mockResolvedValue([{ name: ".", type: 2, size: 0 }, { name: "..", type: 2, size: 0 }]);

    await expect(inspectStaticHostingDirectory(settings(), credentials)).resolves.toEqual({
      entryCount: 0,
      isEmpty: true,
      wordpressSignals: [],
      remoteFiles: [],
      remoteInventoryComplete: true,
    });
    expect(ftp.ensureDir).not.toHaveBeenCalled();
  });

  it("confronta ricorsivamente percorso e dimensione e segnala collegamenti non seguiti", async () => {
    ftp.list.mockImplementation(async (remotePath: string) => {
      if (remotePath === "/public_html/site") return [
        { name: "assets", type: 2, size: 0 },
        { name: "index.html", type: 1, size: 120 },
        { name: "old.css", type: 1, size: 30 },
        { name: "linked", type: 3, size: 0 },
      ];
      if (remotePath === "/public_html/site/assets") return [{ name: "site.css", type: 1, size: 64 }];
      return [];
    });

    await expect(inspectStaticHostingDirectory(settings(), credentials)).resolves.toMatchObject({
      entryCount: 4,
      isEmpty: false,
      remoteFiles: [
        { path: "index.html", size: 120 },
        { path: "old.css", size: 30 },
        { path: "assets/site.css", size: 64 },
      ],
      remoteInventoryComplete: false,
    });
    expect(ftp.list).toHaveBeenCalledWith("/public_html/site/assets");
    expect(ftp.ensureDir).not.toHaveBeenCalled();
    expect(ftp.uploadFrom).not.toHaveBeenCalled();
    expect(ftp.remove).not.toHaveBeenCalled();
  });

  it("limita la scansione quando la directory remota ha troppi elementi", async () => {
    ftp.list.mockResolvedValue(Array.from({ length: 2_005 }, (_, index) => ({ name: `file-${index}.txt`, type: 1, size: index })));

    await expect(inspectStaticHostingDirectory(settings(), credentials)).resolves.toMatchObject({
      entryCount: 2_000,
      remoteFiles: expect.arrayContaining([{ path: "file-0.txt", size: 0 }]),
      remoteInventoryComplete: false,
    });
    expect(ftp.list).toHaveBeenCalledTimes(1);
  });

  it("tratta un elenco remoto non leggibile come errore, senza tentare di creare o ripulire la cartella", async () => {
    ftp.list.mockRejectedValueOnce(new Error("550 directory unavailable"));

    await expect(inspectStaticHostingDirectory(settings(), credentials)).rejects.toThrow("senza modificarla");
    expect(ftp.ensureDir).not.toHaveBeenCalled();
    expect(ftp.uploadFrom).not.toHaveBeenCalled();
    expect(ftp.remove).not.toHaveBeenCalled();
    expect(ftp.close).toHaveBeenCalledOnce();
  });

  it("carica il probe temporaneo nella cartella esistente e ne verifica la rimozione", async () => {
    const fileName = `histos-runtime-check-${"a".repeat(32)}.php`;
    const result = await withTemporaryStaticHostingFile({
      settings: settings(),
      credentials,
      fileName,
      bytes: Buffer.from("<?php echo 'temporary';"),
      run: async () => {
        expect(ftp.remoteFiles.has(fileName)).toBe(true);
        return { phpVersion: "8.3.1" };
      },
    });

    expect(result).toEqual({ phpVersion: "8.3.1" });
    expect(ftp.ensureDir).not.toHaveBeenCalled();
    expect(ftp.uploadFrom).toHaveBeenCalledOnce();
    expect(ftp.remove).toHaveBeenCalledWith(fileName);
    expect(ftp.remoteFiles.size).toBe(0);
    expect(ftp.close).toHaveBeenCalledOnce();
  });

  it("rimuove il file temporaneo anche se il controllo runtime fallisce", async () => {
    const fileName = `histos-runtime-check-${"b".repeat(32)}.php`;
    await expect(withTemporaryStaticHostingFile({
      settings: settings(), credentials, fileName, bytes: Buffer.from("probe"),
      run: async () => { throw new Error("runtime probe failed"); },
    })).rejects.toThrow("runtime probe failed");
    expect(ftp.remoteFiles.size).toBe(0);
    expect(ftp.remove).toHaveBeenCalledWith(fileName);
  });

  it("blocca il seguito se non può confermare la rimozione del PHP temporaneo", async () => {
    const fileName = `histos-runtime-check-${"c".repeat(32)}.php`;
    ftp.remove.mockRejectedValueOnce(new Error("permission denied"));
    await expect(withTemporaryStaticHostingFile({
      settings: settings(), credentials, fileName, bytes: Buffer.from("probe"), run: async () => "ran",
    })).rejects.toMatchObject({ code: "hosting-temporary-file-cleanup-failed" });
    expect(ftp.remoteFiles.has(fileName)).toBe(true);
    expect(ftp.close).toHaveBeenCalledOnce();
  });

  it("chiede di confermare l’impronta SFTP senza inviare password o chiave privata", async () => {
    const unpinned = parseStaticHostingSettings({
      protocol: "sftp", host: "publish.example.test", port: 2222, remoteDirectory: "/public/site", username: "publisher",
    });
    await expect(verifyStaticHostingConnection(unpinned, { username: "publisher", password: "synthetic-password" }))
      .resolves.toEqual({ hostKeyConfirmationRequired: true, hostKeyFingerprint: sftpFingerprint });
    expect(ssh.configs).toHaveLength(1);
    expect(ssh.configs[0]).toMatchObject({ username: "publisher" });
    expect(ssh.configs[0]).not.toHaveProperty("password");
    expect(ssh.configs[0]).not.toHaveProperty("privateKey");
    expect(ssh.sftpOperations).toEqual([]);
  });

  it("pubblica una build SFTP con chiave host fissata, crea directory e conserva i nomi con spazi", async () => {
    const progress: Array<{ phase: string; completed: number; total: number }> = [];
    const result = await publishStaticBundle({
      settings: sftpSettings(), credentials: { username: "publisher", password: "synthetic-password" },
      files: [
        { path: "index.html", bytes: Buffer.from("home") },
        { path: "assets con spazi/site.css", bytes: Buffer.from("body{}") },
      ],
      onProgress: (event) => progress.push(event),
    });

    expect(result).toEqual({ uploaded: 2, files: 2, publicUrl: "https://publish.example.test" });
    expect(ssh.configs).toHaveLength(1);
    expect(ssh.configs[0]).toMatchObject({ host: "publish.example.test", port: 2222, username: "publisher", password: "synthetic-password" });
    expect(ssh.files.get("/public/site/index.html")?.toString()).toBe("home");
    expect(ssh.files.get("/public/site/assets con spazi/site.css")?.toString()).toBe("body{}");
    expect(ssh.directories.has("/public/site/assets con spazi")).toBe(true);
    expect(progress).toEqual([
      { phase: "connect", completed: 0, total: 2 },
      { phase: "upload", completed: 0, total: 2 },
      { phase: "upload", completed: 1, total: 2 },
      { phase: "upload", completed: 2, total: 2 },
    ]);
  });

  it("una chiave host mai confermata ha un codice suo, non quello della chiave cambiata", async () => {
    const unconfirmed = parseStaticHostingSettings({ protocol: "sftp", host: "publish.example.test", port: 2222, remoteDirectory: "/public/site" });
    const refused = await publishStaticBundle({
      settings: unconfirmed, credentials: { username: "publisher", password: "synthetic-password" },
      files: [{ path: "index.html", bytes: Buffer.from("home") }],
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "hosting-hostkey-unconfirmed" });
    expect((refused as Error).message).toContain(sftpFingerprint);
    expect(ssh.files.size).toBe(0);
  });

  it("blocca il deploy SFTP se la chiave host del server non coincide con quella confermata", async () => {
    ssh.hostKeyHex = createHash("sha256").update("different-host-key").digest("hex");
    const changedSettings = parseStaticHostingSettings({
      protocol: "sftp", host: "publish.example.test", port: 2222, remoteDirectory: "/public/site",
      hostKeyFingerprint: sftpFingerprint,
    });
    await expect(publishStaticBundle({
      settings: changedSettings, credentials: { username: "publisher", password: "synthetic-password" },
      files: [{ path: "index.html", bytes: Buffer.from("home") }],
    })).rejects.toMatchObject({ code: "hosting-hostkey-changed" });
    expect(ssh.sftpOperations).toEqual([]);
    expect(ssh.files.size).toBe(0);
  });

  it("verifica la scrittura SFTP con chiave privata e rimuove il probe remoto", async () => {
    await expect(verifyStaticHostingConnection(sftpSettings(), {
      username: "publisher", authMethod: "privateKey", privateKey: "synthetic-private-key", passphrase: "synthetic-passphrase",
    })).resolves.toEqual({ verified: true, hostKeyFingerprint: sftpFingerprint });
    expect(ssh.configs[0]).toMatchObject({
      username: "publisher", privateKey: "synthetic-private-key", passphrase: "synthetic-passphrase",
    });
    expect(ssh.configs[0]).not.toHaveProperty("password");
    expect([...ssh.files.keys()]).toEqual([]);
    expect(ssh.sftpOperations.some((operation) => operation.startsWith("unlink:/public/site/.histos-publish-test-"))).toBe(true);
  });

  it("ispeziona la cartella SFTP senza scrivere né crearne il percorso", async () => {
    ssh.files.set("/public/site/wp-config.php", Buffer.from("redacted"));
    ssh.directories.add("/public/site/wp-admin");
    ssh.directories.add("/public/site/assets");
    ssh.files.set("/public/site/assets/site.css", Buffer.from("body{}"));
    await expect(inspectStaticHostingDirectory(sftpSettings(), credentials)).resolves.toEqual({
      entryCount: 3, isEmpty: false, wordpressSignals: ["wp-admin", "wp-config.php"],
      remoteFiles: [{ path: "wp-config.php", size: 8 }, { path: "assets/site.css", size: 6 }], remoteInventoryComplete: true,
    });
    expect(ssh.sftpOperations).toEqual(["readdir:/public/site", "readdir:/public/site/wp-admin", "readdir:/public/site/assets"]);
  });

  it("carica ricorsivamente i file della build, segnala l’avanzamento e restituisce l’URL", async () => {
    const progress: Array<{ phase: string; completed: number; total: number }> = [];
    const result = await publishStaticBundle({
      settings: settings(), credentials,
      files: [
        { path: "index.html", bytes: Buffer.from("home") },
        { path: "assets/site.css", bytes: Buffer.from("body{}") },
      ],
      onProgress: (event) => progress.push(event),
    });

    expect(ftp.access).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
    expect(ftp.ensureDir).toHaveBeenCalledWith("assets");
    expect(ftp.uploadFrom).toHaveBeenCalledTimes(2);
    expect(ftp.cd).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([
      { phase: "connect", completed: 0, total: 2 },
      { phase: "upload", completed: 1, total: 2 },
      { phase: "upload", completed: 2, total: 2 },
    ]);
    expect(result).toEqual({ uploaded: 2, files: 2, publicUrl: "https://site.example.test" });
    expect(ftp.close).toHaveBeenCalledOnce();
  });

  it("segnala un upload interrotto senza fingere il rollback e un nuovo invio completa i file mancanti", async () => {
    const files = [
      { path: "index.html", bytes: Buffer.from("home v2") },
      { path: "assets/site.css", bytes: Buffer.from("body{color:red}") },
    ];
    ftp.uploadFrom
      .mockImplementationOnce(async (_stream: unknown, name: string) => { ftp.remoteFiles.add(name); })
      .mockRejectedValueOnce(new Error("connection dropped"));
    const progress: Array<{ phase: string; completed: number; total: number }> = [];

    await expect(publishStaticBundle({ settings: settings(), credentials, files, onProgress: (event) => progress.push(event) }))
      .rejects.toThrow("Ho caricato 1 file; quelli già aggiornati restano sul server.");
    expect(ftp.remoteFiles).toEqual(new Set(["index.html"]));
    expect(progress).toEqual([
      { phase: "connect", completed: 0, total: 2 },
      { phase: "upload", completed: 1, total: 2 },
    ]);

    await expect(publishStaticBundle({ settings: settings(), credentials, files }))
      .resolves.toMatchObject({ uploaded: 2, files: 2, publicUrl: "https://site.example.test" });
    expect(ftp.remoteFiles).toEqual(new Set(["index.html", "site.css"]));
  });

  it("carica un set WordPress senza index.html e mantiene i limiti del trasporto", async () => {
    const result = await uploadStaticHostingFiles({
      settings: settings(), credentials,
      files: [
        { path: "index.php", bytes: Buffer.from("<?php") },
        { path: "wp-admin/install.php", bytes: Buffer.from("<?php") },
      ],
    });

    expect(result).toMatchObject({ uploaded: 2, files: 2 });
    expect(ftp.uploadFrom).toHaveBeenCalledTimes(2);
    expect(ftp.ensureDir).toHaveBeenCalledWith("wp-admin");
    await expect(uploadStaticHostingFiles({ settings: settings(), credentials, files: [{ path: "../outside.php", bytes: Buffer.from("x") }] }))
      .rejects.toMatchObject({ code: "hosting-file-path-invalid" });
    await expect(uploadStaticHostingFiles({ settings: settings(), credentials, files: [{ path: "a.php", bytes: Buffer.from("x") }, { path: "A.php", bytes: Buffer.from("y") }] }))
      .rejects.toMatchObject({ code: "hosting-file-path-collision" });
  });

  it("rifiuta build senza index.html o percorsi che escono dalla radice", async () => {
    await expect(publishStaticBundle({ settings: settings(), credentials, files: [{ path: "about.html", bytes: Buffer.from("x") }] }))
      .rejects.toThrow("non contiene index.html");
    await expect(publishStaticBundle({ settings: settings(), credentials, files: [
      { path: "index.html", bytes: Buffer.from("x") }, { path: "../secret", bytes: Buffer.from("x") },
    ] })).rejects.toThrow("percorso non valido");
    expect(ftp.access).not.toHaveBeenCalled();
  });

  it("redige username e password dagli errori del server", async () => {
    ftp.access.mockRejectedValueOnce(new Error("login publisher rejected synthetic-password"));

    await expect(verifyStaticHostingConnection(settings(), credentials))
      .rejects.toThrow("login [omesso] rejected [omesso]");
    expect(ftp.close).toHaveBeenCalledOnce();
  });
});
