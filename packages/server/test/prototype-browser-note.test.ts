import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserCheckNote, checkPrototype } from "../src/prototype-check.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = () => readFile(new URL("../../connector/test/fixtures/progettare.html", import.meta.url), "utf8");
const check = async (html: string, verify: { opened: number; overflow: number; axe: number }) => {
  const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "histos-browser-note-"));
  roots.push(scratchRoot);
  return checkPrototype(html, {
    scratchRoot,
    preview: async () => ({
      status: "built" as const,
      findings: 0,
      note: "",
      verify: {
        pages: verify.opened,
        brokenLinks: [],
        opened: verify.opened,
        overflow: Array.from({ length: verify.overflow }, (_, i) => ({ page: `/p${i}/`, width: 390, scrollWidth: 420, elements: [] })),
        axe: Array.from({ length: verify.axe }, (_, i) => ({ id: `regola-${i}`, impact: "serious", help: "x", helpUrl: "https://dequeuniversity.com/rules/axe/4.10/x", pages: ["/"], targets: ["#x"], count: 1 })),
      },
    }) as never,
  });
};

describe("l'import dice se il file è stato aperto in un browser (doc 23, voce 239)", () => {
  it("un file mai aperto in un browser lo dice, con come farlo", async () => {
    const html = (await fixture()).replace("Coro di prova", "Coro di prova mai aperto");
    expect(browserCheckNote(html)).toMatch(/^Verifica nel browser: questo file non è stato aperto in un browser .*prototype verify\.$/u);
  });

  it("dopo un controllo pulito non dice nulla; dopo uno con problemi li conta", async () => {
    const clean = (await fixture()).replace("Coro di prova", "Coro di prova pulito");
    await check(clean, { opened: 12, overflow: 0, axe: 0 });
    expect(browserCheckNote(clean)).toBeNull();
    const broken = (await fixture()).replace("Coro di prova", "Coro di prova con problemi");
    await check(broken, { opened: 12, overflow: 1, axe: 2 });
    expect(browserCheckNote(broken)).toBe("Verifica nel browser: il controllo di questo file ha trovato 2 regole di accessibilità non rispettate e una pagina che scorre di lato. I dettagli sono negli avvisi del controllo: correggili prima di pubblicare.");
  });

  it("un controllo che non ha aperto pagine non conta come verifica", async () => {
    const html = (await fixture()).replace("Coro di prova", "Coro di prova senza browser");
    await check(html, { opened: 0, overflow: 0, axe: 0 });
    expect(browserCheckNote(html)).toMatch(/non è stato aperto in un browser/u);
  });
});
