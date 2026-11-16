import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorImports, type ConnectorImportOutcome } from "../src/connector-imports.js";
import type { PrototypeChanges } from "../src/prototype-check.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const PROJECT = "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10";
const changes: PrototypeChanges = { added: [], modified: [], removed: [], keptLocal: [], conflicts: [], unchanged: 3, omitted: 0, basis: { projectRevision: "r", profileDigest: "d" } };

/** An update waiting for the user, approved at once, and what the agent then reads with hp_import_status. */
async function approvedAndFailed(apply: () => Promise<ConnectorImportOutcome>) {
  const imports = new ConnectorImports({ active: () => true, apply });
  const asked = imports.request({ projectId: PROJECT, projectName: "Galleria", client: "vitest", html: "<!doctype html>", download: false, file: { name: "galleria.html", bytes: 15, sha256: "a".repeat(64) }, changes });
  imports.decide(asked.requestId, "approve");
  return imports.status(asked.requestId, 5);
}

describe("aggiornamenti approvati dell'agente", () => {
  it("con il connettore fermato la richiesta è rifiutata con un codice suo, non connector-off (app chiusa)", () => {
    const imports = new ConnectorImports({ active: () => false, apply: async (): Promise<ConnectorImportOutcome> => ({ status: 200, body: {} }) });
    expect(() => imports.request({ projectId: PROJECT, projectName: "Galleria", client: "vitest", html: "<!doctype html>", download: false, file: { name: "galleria.html", bytes: 15, sha256: "a".repeat(64) }, changes })).toThrow(expect.objectContaining({ code: "connector-stopped", exitCode: 503 }));
  });

  it("un errore di file dopo l'approvazione arriva all'agente senza la cartella dati né altri percorsi (16)", async () => {
    // The data folder of a real install sits in the user's home, with a space in it on macOS and Windows.
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "Histeon Publish "));
    roots.push(dataDirectory);
    const media = path.join(dataDirectory, "histos-projects", PROJECT, "media", "sha256", "53", "53f3f93f064436bdb5e6cc868d5b06808f5b8206ab4e2d03d26eb7b55f5d915f");
    // The backup measures every media file first: one gone from disk fails with Node's own error, path included.
    const view = await approvedAndFailed(async () => {
      await lstat(media);
      throw new Error("Il media doveva mancare.");
    });
    expect(view.state).toBe("failed");
    expect(view.error?.code).toBe("connector-import-failed");
    expect(view.error?.message).toBe("ENOENT: no such file or directory, lstat '[percorso rimosso]'");
    expect(JSON.stringify(view)).not.toContain(dataDirectory);
    expect(JSON.stringify(view)).not.toContain("Histeon Publish");
  });

  it("anche un rifiuto dell'aggiornamento con un percorso nel testo arriva pulito, nell'errore e nel risultato (16)", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-connector-imports-"));
    roots.push(dataDirectory);
    const view = await approvedAndFailed(async () => ({ status: 409, body: { error: `Non scrivo ${path.join(dataDirectory, "connector", "backups", "x.tmp")}: riprova.`, code: "connector-import-stale" } }));
    expect(view.state).toBe("failed");
    expect(view.error).toEqual({ code: "connector-import-stale", message: "Non scrivo [percorso rimosso]: riprova." });
    expect(view.result).toMatchObject({ code: "connector-import-stale", error: "Non scrivo [percorso rimosso]: riprova." });
    expect(JSON.stringify(view)).not.toContain(dataDirectory);
  });

  it("un percorso tra virgolette nella home arriva all'agente nascosto tutto, anche con uno spazio dopo la home (7)", async () => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    try {
      for (const [home, message, left] of [
        ["/home/anna", "ENOENT: no such file or directory, open '/home/anna/Documenti/Sito di Anna Rossi.html'", ["anna", "rossi"]],
        ["/home/anna rossi", "EACCES: permission denied, mkdir '/home/anna rossi/.local/share/Histos Publish'", ["anna", "rossi", "publish"]],
        ["/Users/anna", "EPERM: operation not permitted, rename '/Users/anna/Library/Application Support/Histos Publish/connector/x.tmp' -> '/Users/anna/Library/Application Support/Histos Publish'", ["anna", "support", "publish"]],
      ] as const) {
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        // As the update's API answers it, and as the update throws it (a message only: Node sets `path` on one path).
        const answered = await approvedAndFailed(async () => ({ status: 500, body: { error: message, code: "error" } }));
        const thrown = await approvedAndFailed(async () => { throw Object.assign(new Error(message), { code: "EPERM" }); });
        for (const view of [answered, thrown]) {
          // Before: «open '[percorso rimosso] di Anna Rossi.html'», «mkdir '[percorso rimosso] Publish'».
          expect(view.error?.message).toMatch(/^E[A-Z]+: [a-z ]+, [a-z]+ '\[percorso rimosso\]'(?: -> '\[percorso rimosso\]')?$/u);
          for (const name of left) expect(JSON.stringify(view).toLowerCase()).not.toContain(name);
        }
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("non nomina la cartella dati con cui è partita l'app, anche fuori dalla home e con spazi (7)", async () => {
    const dataDirectory = "/srv/Dati di Anna Rossi";
    const imports = new ConnectorImports({ active: () => true, privateFolders: [dataDirectory], apply: async () => ({ status: 409, body: { error: `Non scrivo ${dataDirectory}/connector/backups: riprova.`, code: "connector-import-stale" } }) });
    const asked = imports.request({ projectId: PROJECT, projectName: "Galleria", client: "vitest", html: "<!doctype html>", download: false, file: { name: "galleria.html", bytes: 15, sha256: "a".repeat(64) }, changes });
    imports.decide(asked.requestId, "approve");
    const view = await imports.status(asked.requestId, 5);
    // Without it: «Non scrivo [percorso rimosso] di Anna Rossi/connector/backups: riprova.».
    expect(view.error).toEqual({ code: "connector-import-stale", message: "Non scrivo [percorso rimosso]: riprova." });
    expect(JSON.stringify(view)).not.toMatch(/Anna|Rossi/u);
  });
});
