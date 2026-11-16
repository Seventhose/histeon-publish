import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentDocsBundle, RECIPE_HEADINGS, RECIPE_MAX_WORDS } from "../build-agent-docs.mjs";
import { AGENT_DOCS, agentDoc } from "../src/docs.js";
import { TOOLS } from "../src/tools.js";

/**
 * The recipes (`ricetta-*`): one recurring job on one page, for a small model that copies the calls literally. So every
 * tool, argument and enum value a recipe names must be real, and no step may tell it to publish, delete or approve.
 */

const RECIPES = [
  "ricetta-scrivere",
  "ricetta-importare",
  "ricetta-aggiornare",
  "ricetta-wordpress",
  "ricetta-tradurre",
  "ricetta-correggere",
  "ricetta-design",
];
const toolNames = new Set(TOOLS.map((tool) => tool.name));
const words = (text: string) => text.split(/\s+/u).filter(Boolean).length;
/** Tools no recipe may call: exporting is only on the user's explicit request and has no recipe. */
const NEVER_CALLED = new Set(["hp_export_xbsite"]);
/** Tools only one recipe may call. */
const ONLY_IN: Record<string, string> = {
  hp_wordpress_push: "ricetta-wordpress",
  hp_wordpress_push_status: "ricetta-wordpress",
};

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  const next = text.indexOf("\n## ", start + heading.length + 2);
  return text.slice(start, next < 0 ? undefined : next);
}

/** Each `Chiama `hp_x` con {…}` of the steps, with the JSON of its arguments (same line or the next). */
function calls(steps: string): Array<{ tool: string; args: Record<string, unknown> | null }> {
  const lines = steps.split("\n");
  const found: Array<{ tool: string; args: Record<string, unknown> | null }> = [];
  for (const [index, line] of lines.entries()) {
    const call = /[Cc]hiama `(hp_[a-z_]+)` con/u.exec(line);
    if (!call?.[1]) continue;
    const json = /`(\{.*\})`/u.exec(line.slice(call.index)) ?? /^\s*`(\{.*\})`\s*$/u.exec(lines[index + 1] ?? "");
    found.push({ tool: call[1], args: json?.[1] ? (JSON.parse(json[1]) as Record<string, unknown>) : null });
  }
  return found;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ricette per i lavori ricorrenti (S1)", () => {
  it("ci sono le sette ricette, nell'indice con la loro sezione, e il percorso del modello piccolo le nomina", () => {
    const keys = AGENT_DOCS.map((topic) => topic.key);
    for (const key of RECIPES) expect(keys).toContain(key);
    expect(keys.filter((key) => key.startsWith("ricetta-")).sort()).toEqual([...RECIPES].sort());
    const index = agentDoc();
    expect(index).toContain("## Ricette: un lavoro, una pagina");
    for (const key of RECIPES) expect(index.slice(index.indexOf("## Ricette"))).toContain(`**${key}**`);
    expect(index).toContain("leggi `rapido`, poi solo la ricetta del lavoro che ti hanno chiesto");
    // The recipes stay out of the short path.
    expect(agentDoc("rapido")).not.toMatch(/ricetta-/u);
  });

  it(`ogni ricetta ha al più ${RECIPE_MAX_WORDS} parole e i quattro titoli, in ordine`, () => {
    for (const key of RECIPES) {
      const text = agentDoc(key);
      expect(words(text), key).toBeLessThanOrEqual(RECIPE_MAX_WORDS);
      const lines = text.split("\n");
      const at = RECIPE_HEADINGS.map((heading) => lines.indexOf(heading));
      expect(
        at.every((line) => line >= 0),
        `${key}: ${RECIPE_HEADINGS.join(", ")}`,
      ).toBe(true);
      expect(
        [...at].sort((left, right) => left - right),
        key,
      ).toEqual(at);
    }
  });

  it("ogni hp_… nominato è uno strumento vero, con argomenti e valori veri", () => {
    for (const key of RECIPES) {
      const text = agentDoc(key);
      for (const [name] of text.matchAll(/\bhp_[a-z_]+/gu)) expect(toolNames.has(name), `${key}: ${name}`).toBe(true);
      const steps = calls(section(text, "## Passi"));
      expect(steps.length, key).toBeGreaterThan(0);
      for (const { tool, args } of steps) {
        expect(args, `${key}: ${tool} senza gli argomenti scritti per esteso`).not.toBeNull();
        const schema = TOOLS.find((item) => item.name === tool)?.inputSchema;
        if (!schema || !args) continue;
        for (const [name, value] of Object.entries(args)) {
          const property = schema.properties[name];
          expect(property, `${key}: ${tool} non ha l'argomento ${name}`).toBeDefined();
          if (property?.type === "boolean") expect(typeof value, `${key}: ${tool}.${name}`).toBe("boolean");
          // A value written out (not a <placeholder>) must be one the schema accepts.
          if (property?.type === "string" && property.enum && typeof value === "string" && !value.startsWith("<")) {
            expect(property.enum, `${key}: ${tool}.${name}`).toContain(value);
          }
        }
        for (const name of schema.required ?? [])
          expect(Object.hasOwn(args, name), `${key}: ${tool} senza ${name}`).toBe(true);
      }
    }
  });

  it("nessuna ricetta fa pubblicare, esportare, cancellare o approvare, e ognuna ripete le regole", () => {
    for (const key of RECIPES) {
      const text = agentDoc(key);
      const steps = section(text, "## Passi");
      for (const { tool } of calls(steps)) {
        expect(NEVER_CALLED.has(tool), `${key}: ${tool}`).toBe(false);
        if (ONLY_IN[tool]) expect(key, tool).toBe(ONLY_IN[tool]);
      }
      expect(text, key).not.toMatch(/"dryRun":\s*false/u);
      // What the agent is told to do, without the messages it writes to the user («…») and the names in code.
      for (const line of steps
        .replace(/«[^»]*»/gu, "")
        .replace(/`[^`]*`/gu, "")
        .split("\n")) {
        if (/\b(?:pubblica|pubblicare|deploy|elimina|cancella|approva|forza)\b/iu.test(line))
          expect(line, key).toMatch(/\b(?:non|mai)\b/iu);
      }
      expect(text, key).toMatch(/non pubblichi mai/iu);
      expect(text, key).toContain("`connector-off`");
      expect(text, key).toMatch(/non (?:un'istruzione|istruzioni)/u);
    }
  });

  it("lo script rifiuta una ricetta troppo lunga, senza un titolo o con segni del percorso rapido", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "histos-recipes-"));
    roots.push(directory);
    const header = "---\nkey: ricetta-prova\ntitle: Ricetta: prova\nsummary: Prova.\n---\n";
    const body = (extra: string) =>
      `# Ricetta: prova\n\n## Quando\n\nVale.\n\n## Passi\n\n1. Uno.${extra}\n\n## Fermati e chiedi\n\n- Sempre.\n\n## Alla fine di'\n\n- Fatto.\n`;
    const file = path.join(directory, "20-ricetta-prova.md");
    await writeFile(file, header + body(""));
    expect((await agentDocsBundle(directory)).topics.map((topic: { key: string }) => topic.key)).toEqual([
      "indice",
      "rapido",
      "ricetta-prova",
    ]);
    await writeFile(file, header + body(` ${"parola ".repeat(600)}`));
    await expect(agentDocsBundle(directory)).rejects.toThrow(
      /la ricetta ricetta-prova ha 6\d\d parole, il limite è 500/u,
    );
    await writeFile(file, header + body("").replace("## Fermati e chiedi", "## Fermati"));
    await expect(agentDocsBundle(directory)).rejects.toThrow("manca il titolo «## Fermati e chiedi»");
    await writeFile(file, header + body("\n\n<!-- rapido -->\nA\n<!-- /rapido -->"));
    await expect(agentDocsBundle(directory)).rejects.toThrow("non entra nel percorso rapido");
  });
});
