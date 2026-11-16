import { AGENT_DOCS, AGENT_DOC_TOPICS } from "./agent-docs.generated.js";

export { AGENT_DOCS, AGENT_DOC_TOPICS };

/** The resource address of a topic, for MCP clients that read resources. */
export const DOCS_URI_PREFIX = "histos-publish://docs/";

/**
 * One topic of the documentation for agents (queue A7), the same text the builder's `xb_docs` gives; nothing or
 * `indice` gives the index, which says what each topic is for.
 */
export function agentDoc(topic?: string): string {
  return (AGENT_DOCS.find((item) => item.key === (topic || "indice")) ?? AGENT_DOCS[0]!).text;
}
