import type { ConnectorClient } from "./client.js";
import { ConnectorError, OFF_MESSAGE } from "./errors.js";
import { inlinePrototype, readPrototypeFile } from "./files.js";
import { agentDoc } from "./docs.js";
import { manualSection } from "./manual.js";
import { prototypeKit, writePrototypeKit, type PrototypeKitKind } from "./kits.js";
import { schemaProblem, TOOLS, type ToolDefinition } from "./tools.js";

export interface ToolContext {
  client: ConnectorClient;
  /** Folder relative prototype paths are resolved against: the agent's working directory. */
  cwd: string;
  signal?: AbortSignal;
}

/** What a tool returns: the manual as text, anything else as a JSON object. */
export type ToolValue = string | Record<string, unknown>;

export function findTool(name: unknown): ToolDefinition | undefined {
  return typeof name === "string" ? TOOLS.find((tool) => tool.name === name) : undefined;
}

/**
 * Runs one tool for the MCP server and the CLI alike. Arguments are checked against the closed list here and again
 * in the app; prototypes are read and checked here, before anything is sent.
 */
export async function runTool(name: unknown, input: unknown, context: ToolContext): Promise<ToolValue> {
  const tool = findTool(name);
  if (!tool) throw new ConnectorError("connector-unknown-tool", `Strumento sconosciuto. Disponibili: ${TOOLS.map((item) => item.name).join(", ")}.`, 2);
  const args = input === undefined || input === null ? {} : input;
  const problem = schemaProblem(tool.inputSchema, args);
  if (problem) throw new ConnectorError("connector-invalid-arguments", problem, 2);
  const values = args as Record<string, unknown>;
  if (tool.via.kind === "local") {
    if (tool.name === "hp_docs") return agentDoc(values.topic as string | undefined);
    if (tool.name !== "hp_prototype_init") return manualSection(values.section as string | undefined);
    const kit = (values.kit ?? "minimo") as PrototypeKitKind;
    const made = prototypeKit(kit, typeof values.name === "string" ? { name: values.name } : {});
    if (typeof values.path !== "string") return { kit, id: made.id, html: made.html };
    const written = writePrototypeKit(values.path, made.html, context.cwd);
    return { kit, id: made.id, path: written, bytes: Buffer.byteLength(made.html, "utf8"), next: "Cambia name, <title>, design, contenuti e template con quelli veri, poi hp_check_prototype con path." };
  }
  if (tool.via.kind === "call") {
    if (tool.via.operation === "status") {
      try {
        return { ...(await context.client.call("status", {}, context.signal)), app: "aperto" };
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "connector-off") return { app: "chiuso o connettore spento", message: OFF_MESSAGE };
        if (error instanceof ConnectorError && error.code !== "connector-cancelled") return { app: "non raggiungibile", problem: `${error.code}: ${error.message}` };
        throw error;
      }
    }
    return context.client.call(tool.via.operation, values, context.signal);
  }
  const hasPath = typeof values.path === "string";
  const hasHtml = typeof values.html === "string";
  if (hasPath === hasHtml) throw new ConnectorError("connector-invalid-arguments", "Indica esattamente uno fra path (preferito) e html.", 2);
  const source = hasPath ? readPrototypeFile(values.path as string, context.cwd) : inlinePrototype(values.html as string);
  const result = await context.client.prototype(tool.via.mode, source, { update: values.update === true, download: values.downloadRemoteMedia === true, preview: values.preview === true, strict: values.strict === true }, context.signal);
  return { ...result, file: { name: source.name, ...(source.path ? { path: source.path } : {}), bytes: source.bytes.byteLength, sha256: source.sha256 } };
}
