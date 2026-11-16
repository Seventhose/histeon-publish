import { type ImportChoice, type ImportChoiceRejection, sortChoiceAnswers } from "./import-choices.js";
import {
  CHOICES_BATCH_SIZE,
  CHOICES_MAX_BATCHES,
  CHOICES_SYSTEM_PROMPT,
  choiceBatches,
  choicesResponseSchema,
  choicesUserMessage,
  parseChoicesReply,
} from "./import-choices-prompt.js";

/**
 * Doc 27, G2: asking a model the choices of an import. The provider is a function (`AskChoices`): one for an
 * OpenAI-compatible server here (llama-server, with fetch, isomorphic), one for the Claude API in the server package
 * (with the official SDK). Each batch is one request with its own time limit and no retry; a batch that fails leaves
 * its choices at their defaults, and the others still count.
 */

export interface AskChoicesRequest {
  system: string;
  user: string;
  /** The same for every batch. */
  schema: Record<string, unknown>;
  /** With the batch's ids as an enum. */
  idSchema: Record<string, unknown>;
  signal: AbortSignal;
}

/** Sends one batch and returns the model's text. */
export type AskChoices = (request: AskChoicesRequest) => Promise<string>;

export interface ChoiceBatchReport {
  size: number;
  ok: boolean;
  /** Why the batch gave nothing: time, HTTP status, not JSON. Never a key or a header. */
  error?: string;
  ms: number;
}

export interface AskedChoices {
  /** Answers to pass to the converter as `choices`. */
  apply: Record<string, string>;
  /** Alternative texts, for a person to accept one by one. */
  suggestions: Record<string, string>;
  rejected: ImportChoiceRejection[];
  batches: ChoiceBatchReport[];
  /** Choices past the last batch, left at their defaults. */
  skipped: number;
}

export const CHOICES_TIMEOUT_MS = 60_000;

export async function askChoices(
  choices: readonly ImportChoice[],
  ask: AskChoices,
  options: {
    timeoutMs?: number;
    batchSize?: number;
    maxBatches?: number;
    signal?: AbortSignal;
    now?: () => number;
  } = {},
): Promise<AskedChoices> {
  const now = options.now ?? (() => Date.now());
  const batches = choiceBatches(
    choices,
    options.batchSize ?? CHOICES_BATCH_SIZE,
    options.maxBatches ?? CHOICES_MAX_BATCHES,
  );
  const result: AskedChoices = {
    apply: {},
    suggestions: {},
    rejected: [],
    batches: [],
    skipped: choices.length - batches.reduce((sum, batch) => sum + batch.length, 0),
  };
  const schema = choicesResponseSchema();
  for (const batch of batches) {
    if (options.signal?.aborted) {
      result.batches.push({ size: batch.length, ok: false, error: "fermato", ms: 0 });
      continue;
    }
    const started = now();
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    const timer = setTimeout(stop, options.timeoutMs ?? CHOICES_TIMEOUT_MS);
    options.signal?.addEventListener("abort", stop, { once: true });
    try {
      const text = await ask({
        system: CHOICES_SYSTEM_PROMPT,
        user: choicesUserMessage(batch),
        schema,
        idSchema: choicesResponseSchema(batch.map((choice) => choice.id)),
        signal: controller.signal,
      });
      // Sorted against this batch only: an id of another batch is unknown here.
      const sorted = sortChoiceAnswers(batch, parseChoicesReply(text));
      Object.assign(result.apply, sorted.apply);
      Object.assign(result.suggestions, sorted.suggestions);
      result.rejected.push(...sorted.rejected);
      result.batches.push({ size: batch.length, ok: true, ms: now() - started });
    } catch (error) {
      const reason = controller.signal.aborted
        ? options.signal?.aborted
          ? "fermato"
          : "tempo scaduto"
        : error instanceof Error
          ? error.message.slice(0, 200)
          : "errore";
      result.batches.push({ size: batch.length, ok: false, error: reason, ms: now() - started });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    }
  }
  return result;
}

/**
 * An OpenAI-compatible chat server: llama-server (`/v1/chat/completions`, with `--api-key`), LM Studio, Ollama. The
 * answer is constrained by the batch's schema with its ids; Qwen3's reasoning is off, the names need no plan.
 */
export function openAiCompatibleAsk(options: {
  url: string;
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
  maxTokens?: number;
}): AskChoices {
  const endpoint = `${options.url.replace(/\/+$/u, "").replace(/\/v1$/u, "")}/v1/chat/completions`;
  const send = options.fetch ?? fetch;
  return async (request) => {
    const response = await send(endpoint, {
      method: "POST",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model ?? "locale",
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        temperature: 0,
        max_tokens: options.maxTokens ?? 2048,
        response_format: {
          type: "json_schema",
          json_schema: { name: "scelte", strict: true, schema: request.idSchema },
        },
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!response.ok) throw new Error(`il server del modello risponde ${response.status}`);
    const body = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new TypeError("il server del modello non ha dato un testo");
    return content;
  };
}
