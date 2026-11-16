import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = promisify(execFile);

describe("histos-publish prototype", () => {
  it("l'aiuto manda al manuale che il comando stampa (hp_manual per un agente), non a un file del repository", async () => {
    // Before: «(docs/progettazione/histos-cms/14-prototipo-histos.md)», a path an agent outside the repository cannot read.
    const { stdout } = await run(process.execPath, [CLI, "prototype", "--help"]);
    // Commander wraps the help at the terminal's width.
    const help = stdout.replace(/\s+/gu, " ");
    expect(help).toContain("histos-publish prototype manual");
    expect(help).toContain("hp_manual");
    expect(help).not.toMatch(/docs\/|\.md\b/u);
    // The command it names is there and prints the manual.
    const manual = await run(process.execPath, [CLI, "prototype", "manual"], { maxBuffer: 16 * 1024 * 1024 });
    expect(manual.stdout).toMatch(/^# Prototipo Histeon/u);
  }, 30_000);

  it("l'aiuto di check dice che senza --preview non costruisce il sito, che --preview lo costruisce e dove c'è un'anteprima", async () => {
    // Before (round 6): no --preview, «Non costruisce il sito»; the errors of the build alone only in the app's check.
    const { stdout } = await run(process.execPath, [CLI, "prototype", "check", "--help"]);
    const help = stdout.replace(/\s+/gu, " ");
    expect(help).toContain("Senza --preview non costruisce il sito");
    expect(help).toContain("--preview costruisce anche il sito, come il controllo dell’app, senza un indirizzo di anteprima");
    expect(help).toContain("Qui non c’è un indirizzo di anteprima da aprire");
    expect(help).toContain("hp_check_prototype con preview: true");
    // The list of commands keeps the short line.
    const list = (await run(process.execPath, [CLI, "prototype", "--help"])).stdout.replace(/\s+/gu, " ");
    expect(list).toContain("check [options] <file> Controlla un prototipo come farebbe l’import, senza scrivere nulla");
    expect(list).not.toContain("Non costruisce il sito");
  }, 30_000);

  it("init crea un kit con un id nuovo, non sovrascrive e non è l'init di primo livello (doc 17, voce 3)", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "histos-cli-kit-"));
    try {
      const file = path.join(folder, "sito.html");
      const made = await run(process.execPath, [CLI, "prototype", "init", "--sito", "--name", "Prova", "-o", file]);
      expect(made.stdout).toMatch(/^Prototipo creato: .*sito\.html \(kit sito, id [0-9a-f-]{36}\)\./u);
      const html = await readFile(file, "utf8");
      expect(html).toContain("<title>Prova</title>");
      expect(html).toContain(`"id": "${/id ([0-9a-f-]{36})/u.exec(made.stdout)![1]}"`);
      const again = await run(process.execPath, [CLI, "prototype", "init", "-o", file]).catch((error: { code: number; stderr: string }) => error);
      expect(again).toMatchObject({ code: 2, stderr: expect.stringContaining("sito.html esiste già in quella cartella: scegli un altro nome.\n") });
      expect(await readFile(file, "utf8")).toBe(html);
      const both = await run(process.execPath, [CLI, "prototype", "init", "--minimo", "--sito"]).catch((error: { code: number; stderr: string }) => error);
      expect(both).toMatchObject({ code: 2, stderr: expect.stringContaining("Scegli un solo kit: --minimo o --sito.\n") });
      // Without -o, the minimal kit on stdout; as JSON with its id.
      const printed = await run(process.execPath, [CLI, "prototype", "init"], { maxBuffer: 4 * 1024 * 1024 });
      expect(printed.stdout).toMatch(/^<!doctype html>\n<html lang="it" data-histos-prototype="1">/u);
      const json = JSON.parse((await run(process.execPath, [CLI, "--json", "prototype", "init", "--sito"], { maxBuffer: 4 * 1024 * 1024 })).stdout) as { kit: string; id: string; html: string };
      expect(json.kit).toBe("sito");
      expect(json.html).toContain(`"id": "${json.id}"`);
      const help = (await run(process.execPath, [CLI, "prototype", "init", "--help"])).stdout.replace(/\s+/gu, " ");
      expect(help).toContain("Non è histos-publish init, che crea histos-publish.json");
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 30_000);
});
