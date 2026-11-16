import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { askChoices, type ImportChoice } from "@histos-publish/cms";
import { afterEach, describe, expect, it } from "vitest";
import { anthropicChoicesAsk, CHOICES_ANTHROPIC_MODEL } from "../src/import-choices-anthropic.js";

/** Doc 27, G2: the Claude API provider of askChoices, against a fake Messages endpoint. */
const choices: ImportChoice[] = [
  { id: "classe:hero__div", kind: "classe", value: "hero__div", context: "<div> dentro <section.hero>; testo: «Pane»" },
];

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start(
  handler: (
    request: IncomingMessage,
    body: Record<string, unknown>,
  ) => { status: number; body: unknown; wait?: boolean },
): Promise<string> {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const answer = handler(request, JSON.parse(raw || "{}") as Record<string, unknown>);
      if (answer.wait) return;
      response.writeHead(answer.status, { "content-type": "application/json", "request-id": "req_prova" });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => (server as Server).listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const message = (text: string, stop = "end_turn") => ({
  id: "msg_prova",
  type: "message",
  role: "assistant",
  model: CHOICES_ANTHROPIC_MODEL,
  content: [{ type: "text", text }],
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

describe("Claude Haiku 5.5 per le scelte", () => {
  it("manda modello, sforzo basso e schema fisso; legge il JSON", async () => {
    let seen: { path?: string; key?: string; body?: Record<string, unknown> } = {};
    const url = await start((request, body) => {
      seen = { path: request.url, key: String(request.headers.authorization ?? request.headers["x-api-key"]), body };
      return { status: 200, body: message('{"scelte":[{"id":"classe:hero__div","valore":"hero__riquadro"}]}') };
    });
    const result = await askChoices(choices, anthropicChoicesAsk({ apiKey: "sk-ant-prova", baseURL: url }));
    expect(result.apply).toEqual({ "classe:hero__div": "hero__riquadro" });
    expect(seen.path).toBe("/v1/messages");
    // SDK 1.x sends the key as a bearer token.
    expect(seen.key).toMatch(/^(?:Bearer )?sk-ant-prova$/u);
    expect(seen.body?.model).toBe("claude-haiku-5-5");
    const config = seen.body?.output_config as {
      effort: string;
      format: {
        type: string;
        schema: { properties: { scelte: { items: { properties: { id: Record<string, unknown> } } } } };
      };
    };
    expect(config.effort).toBe("low");
    expect(config.format.type).toBe("json_schema");
    // The fixed schema: no enum of ids, so it stays the same from batch to batch.
    expect(config.format.schema.properties.scelte.items.properties.id).toEqual({ type: "string" });
    expect(typeof seen.body?.system).toBe("string");
  });

  it("un rifiuto, una risposta tagliata e una chiave sbagliata sono lotti falliti, senza la chiave nel motivo", async () => {
    for (const [status, body, error] of [
      [200, message("", "refusal"), "il modello ha rifiutato il lotto"],
      [200, message('{"scelte":[', "max_tokens"), "la risposta del modello è stata tagliata"],
      [
        401,
        { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
        "la chiave API di Anthropic non è valida",
      ],
      [
        429,
        { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
        "Anthropic chiede di aspettare (429)",
      ],
    ] as const) {
      const url = await start(() => ({ status, body }));
      const result = await askChoices(choices, anthropicChoicesAsk({ apiKey: "sk-ant-segreta", baseURL: url }));
      expect(result.batches[0]).toMatchObject({ ok: false, error });
      expect(JSON.stringify(result)).not.toContain("sk-ant-segreta");
      await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
      server = undefined;
    }
  });

  it("un lotto che non risponde scade senza nuovi tentativi", async () => {
    let calls = 0;
    const url = await start(() => {
      calls++;
      return { status: 200, body: null, wait: true };
    });
    // Long enough for the request to reach the local server also when the whole suite loads the machine (at 100 ms
    // the time ran out before the first call arrived, and the count below read 0).
    const result = await askChoices(choices, anthropicChoicesAsk({ apiKey: "sk-ant-prova", baseURL: url }), {
      timeoutMs: 1500,
    });
    expect(result.batches[0]).toMatchObject({ ok: false, error: "tempo scaduto" });
    expect(calls).toBe(1);
    server?.closeAllConnections();
  });
});
