import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_DOCS, AGENT_DOC_TOPICS, agentDoc } from "../src/docs.js";
import { runTool } from "../src/runner.js";
import { schemaProblem, TOOLS } from "../src/tools.js";

const schema = TOOLS.find((tool) => tool.name === "hp_docs")!.inputSchema;

describe("documentazione per gli agenti (A7)", () => {
  it("ha l'indice per primo e ogni argomento con titolo, sintesi e testo, senza segnaposto rimasti", () => {
    expect(AGENT_DOC_TOPICS[0]).toBe("indice");
    expect(new Set(AGENT_DOC_TOPICS).size).toBe(AGENT_DOC_TOPICS.length);
    // After the index: the short path for small models, then the map of the ecosystem that every other path starts from.
    expect(AGENT_DOC_TOPICS[1]).toBe("rapido");
    expect(AGENT_DOC_TOPICS[2]).toBe("ecosistema");
    expect(agentDoc()).toContain("comincia sempre da `ecosistema`, poi `metodo`");
    for (const key of ["rapido", "ecosistema", "mestiere", "progettare", "metodo", "sintassi", "dati", "componenti", "stile", "histos-css", "acss", "core-framework", "etch", "markup", "prototipi", "wordpress", "accessibilita", "errori-tipici", "controllo", "design"]) expect(AGENT_DOC_TOPICS).toContain(key);
    for (const topic of AGENT_DOCS) {
      expect(topic.title.trim(), topic.key).not.toBe("");
      expect(topic.summary.trim(), topic.key).not.toBe("");
      expect(topic.text, topic.key).not.toMatch(/\{\{[a-z-]+:[a-z-]+\}\}/u);
      // A small model reads one topic at a time: none grows past what a small context holds.
      expect(topic.text.length, topic.key).toBeLessThan(40_000);
    }
    const index = agentDoc();
    for (const topic of AGENT_DOCS.slice(1)) expect(index).toContain(`**${topic.key}**`);
  });

  it("gli elenchi vengono dai dati: i token, la tabella ACSS e i tag ammessi ci sono", () => {
    expect(agentDoc("histos-css")).toContain("--xb-space-N");
    expect(agentDoc("acss")).toContain("| `var(--primary-dark)` | `var(--xb-primary-800)` |");
    expect(agentDoc("markup")).toContain("`details`");
  });

  it("hp_docs dà l'argomento chiesto e rifiuta quelli che non esistono", async () => {
    const client = {} as never;
    expect(await runTool("hp_docs", { topic: "stile" }, { client, cwd: "/" })).toBe(agentDoc("stile"));
    expect(await runTool("hp_docs", {}, { client, cwd: "/" })).toBe(agentDoc("indice"));
    expect(schemaProblem(schema, { topic: "segreti" })).not.toBeNull();
    expect(schemaProblem(schema, { topic: "stile", altro: 1 })).not.toBeNull();
  });

  it("la copia per il builder è la stessa, nel file condiviso", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/fixtures/histos-agent-docs-v1.json", import.meta.url), "utf8")) as { format: string; version: number; topics: typeof AGENT_DOCS };
    expect(fixture.format).toBe("histos-agent-docs");
    expect(fixture.version).toBe(1);
    expect(fixture.topics).toEqual(AGENT_DOCS);
  });
});
