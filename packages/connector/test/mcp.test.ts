import { readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorClient } from "../src/client.js";
import { OFF_MESSAGE } from "../src/errors.js";
import { AGENT_DOCS, DOCS_URI_PREFIX } from "../src/docs.js";
import { PROTOTYPE_AI_MANUAL } from "../src/manual.js";
import { MANUAL_URI, MCP_INSTRUCTIONS, MCP_LINE_MAX_BYTES, MCP_MAX_IN_FLIGHT, runMcp } from "../src/mcp.js";
import { defaultResponder, type FakeApp, helloBody, removeDirectory, type Responder, startFakeApp, tempDirectory, waitFor } from "./fake-app.js";

type Message = Record<string, unknown> & { id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

/** runMcp on in-memory pipes: one JSON message per line in, every line out recorded and parsed. */
class Harness {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly lines: string[] = [];
  readonly messages: Message[] = [];
  readonly unparsable: string[] = [];
  readonly done: Promise<void>;

  constructor(client: ConnectorClient, dataDirectory: string) {
    let pending = "";
    this.output.setEncoding("utf8");
    this.output.on("data", (chunk: string) => {
      pending += chunk;
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        this.lines.push(line);
        try {
          this.messages.push(JSON.parse(line) as Message);
        } catch {
          this.unparsable.push(line);
        }
      }
    });
    this.done = runMcp({ dataDirectory, version: "9.9.9-test", input: this.input, output: this.output, cwd: dataDirectory, client });
  }

  send(message: Record<string, unknown>): void {
    this.input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  find(id: unknown): Message | undefined {
    return this.messages.find((message) => message.id === id);
  }

  async request(id: number | string, method: string, params?: Record<string, unknown>): Promise<Message> {
    this.send(params === undefined ? { id, method } : { id, method, params });
    await waitFor(() => this.find(id) !== undefined);
    return this.find(id) as Message;
  }

  async callTool(id: number | string, name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request(id, "tools/call", args === undefined ? { name } : { name, arguments: args });
    expect(response.error).toBeUndefined();
    return response.result as Record<string, unknown>;
  }

  async close(): Promise<void> {
    this.input.end();
    await this.done;
    // stdout carries only JSON-RPC 2.0 messages, one per line.
    expect(this.unparsable).toEqual([]);
    for (const message of this.messages) expect(message.jsonrpc).toBe("2.0");
  }
}

const textOf = (result: Record<string, unknown>): string => ((result.content as Array<{ text: string }>)[0] as { text: string }).text;

const directories: string[] = [];
const apps: FakeApp[] = [];

function closedApp(): { client: ConnectorClient; dataDirectory: string } {
  const dataDirectory = tempDirectory("mcp");
  directories.push(dataDirectory);
  return { client: new ConnectorClient({ dataDirectory }), dataDirectory };
}

async function openApp(respond: Responder): Promise<{ app: FakeApp; harness: Harness }> {
  const app = await startFakeApp({ respond });
  apps.push(app);
  return { app, harness: new Harness(new ConnectorClient({ dataDirectory: app.dataDirectory }), app.dataDirectory) };
}

/** Answers the hello and never the calls, like an app busy on a long build. */
const hangingCalls: Responder = (request, app) => (request.url === "/v1/hello" ? defaultResponder(request, app) : "hang");

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
    removeDirectory(app.dataDirectory);
  }
  for (const directory of directories.splice(0)) removeDirectory(directory);
});

describe("MCP with the app closed", () => {
  it("initializes with the instructions, its name and the client's protocol version", async () => {
    const { client, dataDirectory } = closedApp();
    const harness = new Harness(client, dataDirectory);
    const response = await harness.request(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } });
    expect(response.result).toEqual({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "histos-publish", version: "9.9.9-test" },
      instructions: MCP_INSTRUCTIONS,
    });
    expect(MCP_INSTRUCTIONS).toContain("hp_manual");
    expect(MCP_INSTRUCTIONS).toContain("connector-off");
    // A small model is sent to the short path first; the others to the map of the ecosystem, then the manual.
    expect(MCP_INSTRUCTIONS.indexOf("topic rapido")).toBeLessThan(MCP_INSTRUCTIONS.indexOf("topic ecosistema"));
    expect(MCP_INSTRUCTIONS.indexOf("topic ecosistema")).toBeLessThan(MCP_INSTRUCTIONS.indexOf("poi chiama hp_manual"));
    expect(MCP_INSTRUCTIONS).toContain("mestiere");
    const defaulted = await harness.request(2, "initialize", {});
    expect(defaulted.result?.protocolVersion).toBe("2025-06-18");
    const tooLong = await harness.request(3, "initialize", { protocolVersion: "x".repeat(41) });
    expect(tooLong.result?.protocolVersion).toBe("2025-06-18");
    // Notifications get no answer.
    harness.send({ method: "notifications/initialized" });
    expect((await harness.request(4, "ping")).result).toEqual({});
    await harness.close();
    expect(harness.messages.map((message) => message.id)).toEqual([1, 2, 3, 4]);
  });

  it("lists exactly the tools of the closed list", async () => {
    const { client, dataDirectory } = closedApp();
    const harness = new Harness(client, dataDirectory);
    const response = await harness.request(1, "tools/list");
    const tools = response.result?.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "hp_manual",
      "hp_docs",
      "hp_prototype_init",
      "hp_status",
      "hp_list_projects",
      "hp_project",
      "hp_check_prototype",
      "hp_import_prototype",
      "hp_import_choices",
      "hp_import_choices_answer",
      "hp_import_status",
      "hp_build",
      "hp_builds",
      "hp_build_file",
      "hp_export_xbsite",
      "hp_list_wordpress",
      "hp_wordpress_push",
      "hp_translation_brief",
      "hp_translation_work",
      "hp_translation_source",
      "hp_translation_save",
      "hp_translation_strings",
      "hp_translation_save_strings",
      "hp_article_read",
      "hp_article_propose",
      "hp_wordpress_push_status",
    ]);
    for (const tool of tools) expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
    await harness.close();
  });

  it("serves hp_manual without the app, whole or one chapter", async () => {
    const { client, dataDirectory } = closedApp();
    const harness = new Harness(client, dataDirectory);
    const whole = await harness.callTool(1, "hp_manual");
    expect(whole.isError).toBe(false);
    expect(textOf(whole)).toBe(PROTOTYPE_AI_MANUAL);
    const chapter = textOf(await harness.callTool(2, "hp_manual", { section: "connettore" }));
    expect(chapter).toContain("## 20. Con il connettore di Histeon Publish");
    expect(chapter).not.toContain("## 19.");
    expect(chapter).not.toContain("## 1. Il flusso");
    expect(chapter.startsWith("# Prototipo Histeon")).toBe(true);
    const first = textOf(await harness.callTool(3, "hp_manual", { section: "flusso" }));
    expect(first).toContain("## 1. Il flusso");
    expect(first).not.toContain("## 2.");
    await harness.close();
  });

  it("writes a kit with hp_prototype_init without the app: a new file, a new id, never over a file (doc 17)", async () => {
    const { client, dataDirectory } = closedApp();
    const harness = new Harness(client, dataDirectory);
    const folder = tempDirectory("kit");
    const file = path.join(folder, "sito.html");
    const written = await harness.callTool(1, "hp_prototype_init", { kit: "sito", path: file, name: "Prova" });
    expect(written.isError).toBe(false);
    const result = written.structuredContent as { kit: string; id: string; path: string; bytes: number };
    expect(result).toMatchObject({ kit: "sito", path: file });
    const html = readFileSync(file, "utf8");
    expect(html).toContain(`"id": "${result.id}"`);
    expect(html).toContain("<title>Prova</title>");
    expect(Buffer.byteLength(html)).toBe(result.bytes);
    const again = await harness.callTool(2, "hp_prototype_init", { path: file });
    expect(textOf(again)).toMatch(/^connector-invalid-arguments: Il file esiste già: .*il kit non sovrascrive nulla\.$/u);
    expect(readFileSync(file, "utf8")).toBe(html);
    for (const [id, bad] of [[3, path.join(folder, ".nascosta", "a.html")], [4, path.join(folder, "a.txt")], [5, path.join(folder, "manca", "a.html")]] as const) {
      expect(textOf(await harness.callTool(id, "hp_prototype_init", { path: bad })).startsWith("connector-invalid-arguments: ")).toBe(true);
    }
    // Without a path, the text: the minimal kit by default, with an id of its own.
    const text = (await harness.callTool(6, "hp_prototype_init")).structuredContent as { kit: string; id: string; html: string };
    expect(text.kit).toBe("minimo");
    expect(text.id).not.toBe(result.id);
    expect(text.html).toContain(`"id": "${text.id}"`);
    expect(PROTOTYPE_AI_MANUAL).toContain(text.html.replace(text.id, "3f6c2b1e-8a4d-4c7e-9b21-5d0e7a9c4f10"));
    await harness.close();
    removeDirectory(folder);
  });

  it("answers hp_status with the app closed as a result, not an error", async () => {
    const { client, dataDirectory } = closedApp();
    const harness = new Harness(client, dataDirectory);
    const result = await harness.callTool(1, "hp_status");
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ app: "chiuso o connettore spento", message: OFF_MESSAGE });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
    await harness.close();
  });

  it("answers any other tool with isError and connector-off", async () => {
    const { client, dataDirectory } = closedApp();
    const harness = new Harness(client, dataDirectory);
    const result = await harness.callTool(1, "hp_list_projects", { limit: 3 });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith("connector-off: ")).toBe(true);
    expect(result.structuredContent).toEqual({ error: { code: "connector-off", message: OFF_MESSAGE } });
    const invalid = await harness.callTool(2, "hp_project", { projectId: "../../etc" });
    expect(textOf(invalid)).toBe("connector-invalid-arguments: projectId non ha il formato atteso");
    const unknown = await harness.callTool(3, "hp_deploy", {});
    expect(textOf(unknown).startsWith("connector-unknown-tool: ")).toBe(true);
    const missingFile = await harness.callTool(4, "hp_check_prototype", { path: "manca.txt" });
    expect(textOf(missingFile).startsWith("connector-file-invalid: ")).toBe(true);
    await harness.close();
  });

  it("lists and reads the manual as a resource, identical to the source in packages/cms", async () => {
    const { client, dataDirectory } = closedApp();
    const harness = new Harness(client, dataDirectory);
    const list = await harness.request(1, "resources/list");
    // A7: the manual, then every topic of the documentation for agents.
    expect(list.result?.resources).toEqual([{ uri: MANUAL_URI, name: "Manuale del prototipo Histeon", description: expect.any(String), mimeType: "text/markdown" }, ...AGENT_DOCS.map((topic) => ({ uri: `${DOCS_URI_PREFIX}${topic.key}`, name: topic.title, description: topic.summary, mimeType: "text/markdown" }))]);
    const style = await harness.request(5, "resources/read", { uri: `${DOCS_URI_PREFIX}stile` });
    expect(style.result?.contents).toEqual([{ uri: `${DOCS_URI_PREFIX}stile`, mimeType: "text/markdown", text: AGENT_DOCS.find((topic) => topic.key === "stile")!.text }]);
    expect((await harness.request(6, "resources/read", { uri: `${DOCS_URI_PREFIX}../manuale` })).error?.code).toBe(-32602);
    const read = await harness.request(2, "resources/read", { uri: MANUAL_URI });
    expect(read.result?.contents).toEqual([{ uri: MANUAL_URI, mimeType: "text/markdown", text: PROTOTYPE_AI_MANUAL }]);
    expect(PROTOTYPE_AI_MANUAL).toBe(readFileSync(new URL("../../cms/assets/prototipo-ai.md", import.meta.url), "utf8"));
    const unknown = await harness.request(3, "resources/read", { uri: "file:///etc/passwd" });
    expect(unknown.error?.code).toBe(-32602);
    expect((await harness.request(4, "resources/templates/list")).result).toEqual({ resourceTemplates: [] });
    await harness.close();
  });

  it("lists and fills the prompt, refusing bad arguments", async () => {
    const { client, dataDirectory } = closedApp();
    const harness = new Harness(client, dataDirectory);
    const list = await harness.request(1, "prompts/list");
    const prompts = list.result?.prompts as Array<Record<string, unknown>>;
    expect(prompts.map((prompt) => prompt.name)).toEqual(["converti_proposta"]);
    const prompt = await harness.request(2, "prompts/get", { name: "converti_proposta", arguments: { file: "proposta-b.html" } });
    const messages = prompt.result?.messages as Array<{ role: string; content: { type: string; text: string } }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content.text).toContain("proposta-b.html");
    expect(messages[0]?.content.text).toContain("Non inviare a WordPress");
    for (const params of [{ name: "converti_proposta", arguments: {} }, { name: "altro", arguments: { file: "a.html" } }, { name: "converti_proposta", arguments: { file: "a\nb.html" } }, { name: "converti_proposta", arguments: { file: "  " } }]) {
      expect((await harness.request(`bad-${JSON.stringify(params)}`, "prompts/get", params)).error?.code).toBe(-32602);
    }
    await harness.close();
  });

  it("answers ping, unknown methods and malformed messages without stopping", async () => {
    const { client, dataDirectory } = closedApp();
    const harness = new Harness(client, dataDirectory);
    expect((await harness.request("p", "ping")).result).toEqual({});
    expect((await harness.request(2, "tools/destroy")).error?.code).toBe(-32601);
    harness.input.write("{non è json\n");
    harness.input.write("[1,2]\n");
    harness.input.write("\n   \n");
    harness.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5 })}\n`);
    harness.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: { nested: true }, method: "ping" })}\n`);
    expect((await harness.request(6, "ping")).result).toEqual({});
    const errors = harness.messages.filter((message) => message.error).map((message) => [message.id, message.error?.code]);
    expect(errors).toEqual([[2, -32601], [null, -32700], [null, -32600], [5, -32600], [null, -32600]]);
    await harness.close();
  });

  it("drops a line over 8 MiB with -32600 and keeps serving the next one", async () => {
    const { client, dataDirectory } = closedApp();
    const harness = new Harness(client, dataDirectory);
    // In two chunks, so the limit is enforced across chunks and not only per chunk.
    const half = Math.ceil(MCP_LINE_MAX_BYTES / 2);
    harness.input.write(Buffer.alloc(half, 0x61));
    harness.input.write(Buffer.alloc(MCP_LINE_MAX_BYTES - half + 1, 0x61));
    harness.input.write(`more of the same line${"b".repeat(1000)}\n`);
    expect((await harness.request(1, "ping")).result).toEqual({});
    // And in one chunk with the newline inside.
    harness.input.write(Buffer.concat([Buffer.alloc(MCP_LINE_MAX_BYTES + 10, 0x20), Buffer.from(`\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`)]));
    await waitFor(() => harness.find(2) !== undefined);
    const tooLong = harness.messages.filter((message) => message.error?.code === -32600);
    expect(tooLong).toHaveLength(2);
    expect(tooLong.every((message) => message.id === null && message.error?.message === "Messaggio troppo lungo.")).toBe(true);
    // A line just under the limit is still parsed (and refused as JSON, not as too long).
    harness.input.write(`${"{".repeat(MCP_LINE_MAX_BYTES - 1)}\n`);
    expect((await harness.request(3, "ping")).result).toEqual({});
    expect(harness.messages.filter((message) => message.error?.code === -32700)).toHaveLength(1);
    await harness.close();
  });

  it("handles the last message even without a final newline", async () => {
    const { client, dataDirectory } = closedApp();
    const harness = new Harness(client, dataDirectory);
    harness.input.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    await harness.done;
    expect(harness.find(1)?.result).toEqual({});
  });
});

describe("MCP with the app open", () => {
  it("passes the agent's name to the app and answers a call", async () => {
    const { app, harness } = await openApp(defaultResponder);
    await harness.request(1, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code‮", version: "2.1.0" } });
    const result = await harness.callTool(2, "hp_list_projects", { limit: 2 });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true, operation: "listProjects", arguments: { limit: 2 } });
    const status = await harness.callTool(3, "hp_status");
    expect(status.structuredContent).toMatchObject({ ok: true, app: "aperto" });
    expect(app.requests.map((request) => request.headers["x-hp-client"])).toEqual(["claude-code 2.1.0", "claude-code 2.1.0", "claude-code 2.1.0"]);
    await harness.close();
  });

  it("gives no answer to a call cancelled while in flight, and closes its connection", async () => {
    const { app, harness } = await openApp(hangingCalls);
    harness.send({ id: 7, method: "tools/call", params: { name: "hp_list_projects", arguments: {} } });
    await waitFor(() => app.requests.some((request) => request.url === "/v1/call"));
    harness.send({ method: "notifications/cancelled", params: { requestId: 7, reason: "l'utente ha annullato" } });
    const call = app.requests.find((request) => request.url === "/v1/call");
    await waitFor(() => call?.closed === true);
    expect((await harness.request(8, "ping")).result).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await harness.close();
    expect(harness.find(7)).toBeUndefined();
    expect(harness.messages.map((message) => message.id)).toEqual([8]);
  });

  it("gives no answer and sends no call when cancelled during the hello", async () => {
    // A slow hello: the cancel arrives before the server is proven, so the call body must never leave this process.
    const { app, harness } = await openApp((request, current) => (request.url === "/v1/hello" ? { status: 200, body: helloBody(current), delayMs: 200 } : defaultResponder(request, current)));
    harness.send({ id: "c", method: "tools/call", params: { name: "hp_status" } });
    await waitFor(() => app.requests.length === 1);
    harness.send({ method: "notifications/cancelled", params: { requestId: "c" } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await harness.request("after", "ping")).result).toEqual({});
    await harness.close();
    expect(harness.find("c")).toBeUndefined();
    expect(app.requests.map((request) => request.url)).toEqual(["/v1/hello"]);
  });

  it(`refuses a call over ${MCP_MAX_IN_FLIGHT} in flight and a duplicate id, then stops the rest on close`, async () => {
    const { app, harness } = await openApp(hangingCalls);
    for (let id = 1; id <= MCP_MAX_IN_FLIGHT; id++) harness.send({ id, method: "tools/call", params: { name: "hp_list_projects" } });
    await waitFor(() => app.requests.filter((request) => request.url === "/v1/call").length === MCP_MAX_IN_FLIGHT);
    const duplicate = await harness.request(1, "tools/call", { name: "hp_status" });
    expect(duplicate.error?.code).toBe(-32600);
    const busy = await harness.callTool(99, "hp_status");
    expect(busy.isError).toBe(true);
    expect(textOf(busy).startsWith("connector-busy: ")).toBe(true);
    await harness.close();
    // Closing stdin aborted the calls still running: their connections are gone and none of them was answered.
    await waitFor(() => app.requests.filter((item) => item.url === "/v1/call").every((request) => request.closed));
    expect(harness.messages.map((message) => message.id).sort()).toEqual([1, 99]);
  });
});

describe("MCP whose client went away", () => {
  it("stops when the client is gone even if the input stays open (doc 23 item 128)", async () => {
    let gone = false;
    const input = new PassThrough();
    const output = new PassThrough();
    const done = runMcp({ dataDirectory: "/nonexistent-xb-test", version: "9.9.9-test", input, output, orphaned: () => gone, watchMs: 10 });
    let finished = false;
    void done.then(() => (finished = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finished).toBe(false);
    gone = true;
    await done;
    expect(finished).toBe(true);
  });
});
