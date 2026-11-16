import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = promisify(execFile);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The CLI's exit code and output, whether it succeeds or not. */
async function cli(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "" };
  }
}

describe("histos-publish prototype check --severo (F1)", () => {
  it("il kit passa con esito 0; una classe non BEM dà esito 1 con regola, riga e rimedio, anche in JSON; senza --severo nulla cambia", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "histos-cli-strict-"));
    roots.push(folder);
    const kit = path.join(folder, "kit.html");
    expect((await cli(["prototype", "init", "-o", kit])).code).toBe(0);
    const passed = await cli(["prototype", "check", "--severo", kit]);
    expect(passed.code).toBe(0);
    expect(passed.stdout).toMatch(/^Controllo severo: superato/mu);

    const bad = path.join(folder, "blu.html");
    const html = (await readFile(kit, "utf8")).replace(
      '<footer class="piede"><p>Piede</p></footer>',
      '<footer class="piede"><p class="blueText">Piede</p></footer>',
    );
    await writeFile(bad, html);
    const line = html.split("\n").findIndex((text) => text.includes('class="blueText"')) + 1;
    const failed = await cli(["prototype", "check", "--severo", bad]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("Prototipo valido");
    expect(failed.stdout).toMatch(/^Controllo severo: \d+ problemi \((?:un errore|\d+ errori)/mu);
    expect(failed.stdout).toContain(
      `- classe-non-bem (errore) part site/footer, riga ${line}: la classe blueText non è BEM. Rimedio: `,
    );

    const json = await cli(["--json", "prototype", "check", "--severo", bad]);
    expect(json.code).toBe(1);
    const result = JSON.parse(json.stdout) as {
      valid: boolean;
      strict: { passed: boolean; problems: Array<{ rule: string; level: string; document?: string; line?: number }> };
    };
    expect(result.valid).toBe(true);
    expect(result.strict.passed).toBe(false);
    expect(result.strict.problems).toContainEqual(
      expect.objectContaining({ rule: "classe-non-bem", level: "errore", document: "part site/footer", line }),
    );

    const plain = await cli(["prototype", "check", bad]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).not.toContain("Controllo severo");
    const plainJson = JSON.parse((await cli(["--json", "prototype", "check", bad])).stdout) as Record<string, unknown>;
    expect(Object.keys(plainJson)).not.toContain("strict");
  }, 60_000);
});
