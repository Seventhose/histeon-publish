import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { findSystemBrowser } from "@histos-publish/core";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `histos-publish prototype verify` (doc 17 item 4): the check with the build, and the built pages opened in Chrome or
 * Chromium at 1440 and 390 px. A page wider than 390 px and an axe violation are warnings; the manual's kit has none.
 * Without a browser on the machine there is nothing to run.
 */

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const KIT = fileURLToPath(new URL("../../cms/assets/kit-minimo.html", import.meta.url));
const run = promisify(execFile);
const browserFound = await findSystemBrowser().then(() => true, () => existsSync(chromium.executablePath()));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function verify(html: string, json = false): Promise<{ code: number; stdout: string; stderr: string; left: string[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-cli-verify-"));
  roots.push(root);
  const file = path.join(root, "prototipo.html");
  await writeFile(file, html);
  const tmp = path.join(root, "tmp");
  await mkdir(tmp, { mode: 0o700 });
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...(json ? ["--json"] : []), "prototype", "verify", file], { env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp }, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout, stderr, left: await readdir(tmp) };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", left: await readdir(tmp) };
  }
}

describe.skipIf(!browserFound)("histos-publish prototype verify", () => {
  it("una pagina che scorre a 390 px e un campo senza etichetta sono avvisi, con le pagine aperte", async () => {
    const kit = await readFile(KIT, "utf8");
    const broken = kit.replace("<p>Graffa", '<img src="asset:f1" width="900" height="600" alt="Larga"/><input name="cognome"/><p>Graffa');
    expect(broken).not.toBe(kit);
    const text = await verify(broken);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/^Browser: \d+ pagine aperte a 1440 e 390 px, 1 pagina scorre in orizzontale, 1 regola di accessibilità non rispettata \(fra gli avvisi\)\.$/mu);
    expect(text.stdout).toContain("Avviso: Scorrimento orizzontale a 390 px: la pagina / è larga 916 px (sporge img).");
    expect(text.stdout).toMatch(/^Avviso: Accessibilità, regola axe label, gravità critica: .+\. 1 elemento in \/ \(per esempio input\[name="cognome"\]\)\. https:\/\/dequeuniversity\.com\/rules\/axe\/.+\/label/mu);
    // The temporary build and its server are gone.
    expect(text.left).toEqual([]);

    const json = await verify(broken, true);
    const result = JSON.parse(json.stdout) as { preview: { status: string; verify: { opened: number; overflow: unknown[]; axe: { id: string; impact: string; pages: string[]; count: number }[] } } };
    expect(result.preview.status).toBe("built");
    expect(result.preview.verify.opened).toBeGreaterThan(5);
    expect(result.preview.verify.overflow).toEqual([{ page: "/", width: 390, scrollWidth: 916, elements: ["img"] }]);
    expect(result.preview.verify.axe).toMatchObject([{ id: "label", impact: "critical", pages: ["/"], count: 1 }]);
  }, 120_000);

  it("il testo dentro una striscia che scorre di lato non è testo attaccato al bordo", async () => {
    const kit = await readFile(KIT, "utf8");
    // Six cards 300 px wide in a row that scrolls: at both widths a card is cut by the edge of the window.
    const cards = Array.from({ length: 6 }, (_, n) => `<p class="striscia__voce">Scheda numero ${n + 1} della striscia</p>`).join("");
    const strip = kit
      .replace('<style data-histos="selectors">', '<style data-histos="selectors">.striscia { display: flex; gap: var(--xb-space-m); overflow-x: auto; margin-inline: var(--xb-space-m); &__voce { flex: none; inline-size: 18.75rem; } } ')
      .replace("<p>Graffa", `<div class="striscia" tabindex="0" role="group" aria-label="Schede">${cards}</div><p>Graffa`);
    expect(strip).not.toBe(kit);
    const text = await verify(strip);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/nessuno scorrimento orizzontale, nessuna violazione axe, nessuna immagine rotta, nessun testo attaccato al bordo\.$/mu);
    expect(text.stdout).not.toContain("Avviso:");
  }, 120_000);

  it("il kit del manuale non dà avvisi", async () => {
    const text = await verify(await readFile(KIT, "utf8"));
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/^Browser: \d+ pagine aperte a 1440 e 390 px, nessuno scorrimento orizzontale, nessuna violazione axe, nessuna immagine rotta, nessun testo attaccato al bordo\.$/mu);
    expect(text.stdout).not.toContain("Avviso:");
  }, 120_000);
});
