import Anthropic from "@anthropic-ai/sdk";
import type { AskChoices } from "@histos-publish/cms";

/**
 * Doc 27, G2: the choices of an HTML import asked to Claude Haiku 5.5, with the user's API key. Structured outputs
 * constrain the answer to the schema (the same for every batch, so the provider compiles it once); low effort, since
 * the names need no long plan; no retry, as for every provider of askChoices.
 */
export const CHOICES_ANTHROPIC_MODEL = "claude-haiku-5-5";

export function anthropicChoicesAsk(options: {
  apiKey: string;
  model?: string;
  baseURL?: string;
  maxTokens?: number;
}): AskChoices {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    maxRetries: 0,
  });
  return async (request) => {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create(
        {
          model: options.model ?? CHOICES_ANTHROPIC_MODEL,
          max_tokens: options.maxTokens ?? 4096,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
          output_config: { effort: "low", format: { type: "json_schema", schema: request.schema } },
        },
        { signal: request.signal },
      );
    } catch (error) {
      // Typed errors, most specific first; the message never carries the key.
      if (error instanceof Anthropic.AuthenticationError) throw new Error("la chiave API di Anthropic non è valida");
      if (error instanceof Anthropic.RateLimitError) throw new Error("Anthropic chiede di aspettare (429)");
      if (error instanceof Anthropic.APIError && typeof error.status === "number")
        throw new Error(`Anthropic risponde ${error.status}`);
      if (error instanceof Anthropic.APIConnectionError) throw new Error("Anthropic non si raggiunge");
      throw error;
    }
    if (response.stop_reason === "refusal") throw new Error("il modello ha rifiutato il lotto");
    if (response.stop_reason === "max_tokens") throw new Error("la risposta del modello è stata tagliata");
    return response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  };
}
