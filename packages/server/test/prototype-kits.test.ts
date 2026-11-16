import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROTOTYPE_AI_MANUAL, PROTOTYPE_KIT_KINDS, PROTOTYPE_KITS, parsePrototype, prototypeKit } from "@histos-publish/cms";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOTYPE_KITS as CONNECTOR_KITS } from "../../connector/src/kits.generated.js";
import { prototypeKit as connectorKit } from "../../connector/src/kits.js";
import { checkPrototypeBuild } from "../src/cms-api.js";

/**
 * Doc 17 item 3: the kits of `prototype init` and hp_prototype_init. A small model copies them as they are, so each one
 * must pass the check with the build, with no warning, as the import and the build change.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("i kit del prototipo (doc 17, voce 3)", () => {
  for (const kind of PROTOTYPE_KIT_KINDS) {
    it(`il kit ${kind} passa il controllo con la build, valido e senza avvisi`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "histos-kit-"));
      roots.push(root);
      const { html, id } = prototypeKit(kind);
      const checked = await checkPrototypeBuild(html, { scratchRoot: root });
      expect(checked).toMatchObject({ valid: true, outcome: "create", preview: { status: "built" }, report: { project: { id } } });
      expect(checked.report.warnings).toEqual([]);
    }, 60_000);
  }

  it("il kit minimo è il prototipo d'esempio del manuale, e il connettore ha gli stessi kit", () => {
    expect(PROTOTYPE_AI_MANUAL).toContain(`\`\`\`html\n${PROTOTYPE_KITS.minimo}\`\`\``);
    expect(CONNECTOR_KITS).toEqual(PROTOTYPE_KITS);
  });

  it("ogni kit ha un id nuovo, e il nome va nel manifest e nel <title>", () => {
    const first = prototypeKit("sito");
    const second = prototypeKit("sito");
    expect(first.id).not.toBe(second.id);
    expect(parsePrototype(first.html).manifest.id).toBe(first.id);
    expect(first.html).not.toContain(parsePrototype(PROTOTYPE_KITS.sito).manifest.id);
    const named = prototypeKit("minimo", { id: "0b7c2c8e-4f1a-4d3b-9a6e-1c2d3e4f5a6b", name: "Bar \"Sole\" & <Luna>" });
    expect(parsePrototype(named.html).manifest).toMatchObject({ id: "0b7c2c8e-4f1a-4d3b-9a6e-1c2d3e4f5a6b", name: "Bar \"Sole\" & <Luna>" });
    expect(named.html).toContain("<title>Bar \"Sole\" &amp; &lt;Luna&gt;</title>");
    // The connector's copy makes the same file.
    expect(connectorKit("minimo", { id: named.id, name: "Bar \"Sole\" & <Luna>" }).html).toBe(named.html);
    expect(() => prototypeKit("minimo", { name: " " })).toThrow(/da 1 a 120 caratteri/u);
  });
});
