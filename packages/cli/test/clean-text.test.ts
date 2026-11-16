import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { safeErrorMessage } from "../../server/src/http.js";
import { cleanText } from "../src/index.js";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** What the CLI prints for a command that fails: exit code, stdout and stderr. */
async function failing(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    await run(process.execPath, [CLI, ...args], { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
  throw new Error("Il comando doveva fallire.");
}

const slug = "storia-della-nostra-associazione";
const ref = "site/pagina-con-barra-laterale-sinistra";

describe("la pulizia dei testi della CLI", () => {
  it("tiene gli slug lunghi solo per un prototipo rifiutato, con la regola del connettore, e nasconde sempre i token", () => {
    const runs = [
      slug, "storiadellanostraassociazione", "covid19-aggiornamenti-della-settimana", "pagina-con-barra-laterale-sinistra",
      // A UUID alone (an identity, kept: voce 198); then tokens, slug-shaped or not: an id in a longer run, a random
      // word with digits, long hex, base64url, a service prefix, Bearer.
      "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", "token: 3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", "page-3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", "key-3ax6xnjp29jd6fds4gc373sgvjxteol0",
      "abcdef0123456789abcdef0123456789" + "-us6", "pagina-0123456789abcdef0123456789", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE",
      "xoxb-12345-abcdefghij-klmnopqrst-uvwxyz", "Bearer storia-della-nostra-associazione", "dodici-parole_con-un-trattino-basso-lungo",
      // A Worker name after «Worker» (voce 229), and a token after the same word.
      "Worker arcidiocesi-ortodossa-web-cloudflare-demo", "Worker “arcidiocesi-ortodossa-web-cloudflare-demo”", "Worker aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE",
    ];
    for (const value of runs) {
      const text = `page ${value}, riga 3: x`;
      // The same answer the connector gives an agent, for a refusal and for any other error.
      expect(cleanText(text, true), value).toBe(safeErrorMessage(new Error(text), { keepSlugs: true }));
      expect(cleanText(text), value).toBe(safeErrorMessage(new Error(text), { keepSlugs: false }));
    }
    // Before: «page [segreto rimosso], riga 3» in a refusal too.
    expect(cleanText(`page ${slug}, riga 3: usa ${ref}`, true)).toBe(`page ${slug}, riga 3: usa ${ref}`);
    expect(cleanText(`page ${slug}`)).toBe("page [segreto rimosso]");
    expect(cleanText("Bearer storia-della-nostra-associazione e xoxb-12345-abcdefghij", true)).toBe("[segreto rimosso] e [segreto rimosso]");
    expect(cleanText("not portable in 3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10: url")).toBe("not portable in 3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10: url");
    expect(cleanText("Bearer 3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10")).toBe("[segreto rimosso]");
  });

  it("prototype check: un rifiuto nomina gli slug e i ref del file, in testo e con --json; un altro errore no", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "histos-cli-slugs-"));
    roots.push(root);
    const example = await readFile(new URL("../../cms/test/fixtures/prototipo-esempio.html", import.meta.url), "utf8");
    const html = example
      .replaceAll('data-ref="site/page"', `data-ref="${ref}"`)
      .replaceAll('data-template="site/page"', `data-template="${ref}"`)
      .replace('data-slug="contatti"', `data-slug="${slug}"`)
      .replace("<p>Scrivimi.</p>", '<p onclick="a()">Scrivimi.</p>');
    const file = path.join(root, "prototipo.html");
    await writeFile(file, html);
    const text = await failing("prototype", "check", file);
    expect(text.code).toBe(2);
    expect(text.stderr).toContain(`page ${slug}`);
    expect(text.stderr).not.toContain("segreto rimosso");
    const json = await failing("--json", "prototype", "check", file);
    expect(json.code).toBe(2);
    const answer = JSON.parse(json.stdout) as { error: string; code: string; issues: Array<{ document?: string; message: string }> };
    expect(answer.code).toBe("cms-prototype-invalid");
    expect(answer.issues.map((issue) => issue.document)).toContain(`page ${slug}`);
    expect(json.stdout).not.toContain("segreto rimosso");
    // Not a refusal: a long run in its message is still hidden, slug-shaped or not.
    const missing = await failing("prototype", "check", path.join(root, `${slug}.html`));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("[segreto rimosso].html");
    expect(missing.stderr).not.toContain(slug);
    // Three runs of the whole CLI: load-safe under the full suite.
  }, 120_000);
});
