import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROTOTYPE_AI_MANUAL } from "@histos-publish/cms";
import { afterEach, describe, expect, it } from "vitest";
import { checkPrototypeBuild } from "../src/cms-api.js";

/**
 * Doc 17 item 1: the CSS that leaves the images with only their `src` is a warning of the report. The check without a
 * build names the rules that reach every image, with the sheet and the line; the build names the others, with how many
 * images each one reaches, and never a rule twice.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-image-css-"));
  roots.push(root);
  return root;
}

const kit = /```html\n([\s\S]*?data-histos-prototype="1"[\s\S]*?)```/u.exec(PROTOTYPE_AI_MANUAL)![1]!;
const base = '<style data-histos="global" data-name="Base">:root { --esempio-giallo: #f8ce3c; } body { margin: 0; font-family: var(--xb-font-body); } main { padding-inline: var(--xb-gutter); }</style>';

describe("avvisi per il CSS che toglie i formati moderni (doc 17, voce 1)", () => {
  it("::selection: un avviso del controllo con il foglio e la riga, non ripetuto dalla build", async () => {
    expect(kit).toContain(base);
    const html = kit.replace(base, base.replace("</style>", "\n::selection { background: var(--esempio-giallo); }</style>"));
    const line = html.split("\n").findIndex((text) => text.startsWith("::selection")) + 1;
    const checked = await checkPrototypeBuild(html, { scratchRoot: await scratch() });
    const found = checked.report.warnings.filter((warning) => warning.includes("formati moderni"));
    expect(found).toEqual([`Il foglio globale «Base», riga ${line}: ::selection toglie i formati moderni (JPEG XL, AVIF, WebP) a tutte le immagini delle pagine: toglila (manuale, §3.1).`]);
  }, 60_000);

  it("una regola di una classe: la dice la build, con quante immagini", async () => {
    const html = kit.replace(".testata {", ".pagina > img { display: block; } .testata {");
    const checked = await checkPrototypeBuild(html, { scratchRoot: await scratch() });
    expect(checked.report.warnings.filter((warning) => warning.includes("formati moderni"))).toEqual([
      "Immagini moderne: la regola .pagina > img toglie i formati moderni (JPEG XL, AVIF, WebP) a un'immagine: cambiala come dice il manuale, §3.1.",
    ]);
  }, 60_000);
});
