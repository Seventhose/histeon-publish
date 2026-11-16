import { randomUUID } from "node:crypto";
import { HistosPublishError } from "@histos-publish/core";
import type { AskChoices } from "@histos-publish/cms";

/**
 * Doc 27, after G5: «Claude dal connettore». The names of an HTML import are asked to the Claude the user already has
 * (Claude Code or Claude Desktop, with the AI connector of the app), not to a model with an API key. The conversion puts
 * its question here and waits; the agent reads it with hp_import_choices and answers with hp_import_choices_answer. The
 * answer goes through the converter's checks like any provider's, and the person still applies the rows by hand.
 *
 * One question at a time: the import dialog asks for one site. Nothing is written to disk.
 */

/** How long a question waits for the agent before the refinement gives up (the person can stop it before). */
export const CONNECTOR_CHOICES_WAIT_MS = 15 * 60_000;
/** The answer's text, as the agent sends it: the JSON of up to 200 names with their context-free values. */
export const CONNECTOR_CHOICES_ANSWER_MAX = 256 * 1024;

interface ChoicesQuestion {
  requestId: string;
  site: string;
  system: string;
  user: string;
  count: number;
  createdAt: number;
  expiresAt: number;
  settle: (answer: { text: string } | { error: Error }) => void;
}

/** What the agent reads: the fixed prompt, the choices as data, and how to answer. */
export interface ConnectorChoicesView {
  requestId: string;
  site: string;
  count: number;
  expiresAt: string;
  system: string;
  choices: string;
  answer: string;
}

export class ConnectorChoices {
  private question: ChoicesQuestion | null = null;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly options: { now?: () => number; waitMs?: number } = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * A provider for askChoices that asks the agent: each batch is a question that waits for its answer, the person's
   * «Annulla» or the time limit. The converter asks with one batch (refineImportChoices with batchSize 200).
   */
  ask(site: string): AskChoices {
    return (request) =>
      new Promise<string>((resolve, reject) => {
        if (request.signal.aborted) {
          reject(new Error("fermato"));
          return;
        }
        // A new import replaces a question nobody answered: the dialog that asked it has gone.
        this.question?.settle({ error: new Error("sostituita da un'altra importazione") });
        const ids = (request.idSchema as { properties?: { scelte?: { items?: { properties?: { id?: { enum?: unknown[] } } } } } } | undefined)?.properties?.scelte?.items?.properties?.id?.enum;
        const created = this.now();
        let timer: NodeJS.Timeout | undefined;
        const question: ChoicesQuestion = {
          requestId: randomUUID(),
          site: site.slice(0, 120),
          system: request.system,
          user: request.user,
          count: Array.isArray(ids) ? ids.length : 0,
          createdAt: created,
          expiresAt: created + (this.options.waitMs ?? CONNECTOR_CHOICES_WAIT_MS),
          settle: (answer) => {
            if (this.question === question) this.question = null;
            clearTimeout(timer);
            request.signal.removeEventListener("abort", stop);
            if ("text" in answer) resolve(answer.text);
            else reject(answer.error);
          },
        };
        const stop = (): void => question.settle({ error: new Error("fermato") });
        timer = setTimeout(() => question.settle({ error: new Error("Claude non ha risposto in tempo dal connettore") }), question.expiresAt - created);
        request.signal.addEventListener("abort", stop, { once: true });
        this.question = question;
        for (const wake of [...this.waiters]) wake();
      });
  }

  /** Whether a question waits, for the app's status line. */
  get waiting(): boolean {
    return this.question !== null;
  }

  /** The question that waits, or null; with waitSeconds the agent waits for one to arrive. */
  async next(waitSeconds: number, signal?: AbortSignal): Promise<ConnectorChoicesView | null> {
    if (!this.question && waitSeconds > 0) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitSeconds * 1000);
        signal?.addEventListener("abort", done, { once: true });
        this.waiters.add(done);
      });
    }
    const question = this.question;
    if (!question) return null;
    return {
      requestId: question.requestId,
      site: question.site,
      count: question.count,
      expiresAt: new Date(question.expiresAt).toISOString(),
      system: question.system,
      choices: question.user,
      answer: 'Rispondi con hp_import_choices_answer: requestId e scelte, il testo JSON {"scelte":[{"id":"…","valore":"…"}]} con una voce per ogni id.',
    };
  }

  /**
   * The agent's answer. Only its shape is checked here (the JSON, at most one entry per asked choice, strings): the
   * converter sorts and checks every name, as it does for any provider.
   */
  answer(requestId: string, text: string): { received: number } {
    const question = this.question;
    if (!question || question.requestId !== requestId) throw new HistosPublishError("Nessuna domanda in attesa con questo id: forse è scaduta o la persona l'ha annullata. Chiedi di nuovo con hp_import_choices.", "connector-choices-missing", 404);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HistosPublishError('scelte non è JSON: serve {"scelte":[{"id":"…","valore":"…"}]}.', "connector-choices-invalid", 400);
    }
    const list = parsed && typeof parsed === "object" && Array.isArray((parsed as { scelte?: unknown }).scelte) ? (parsed as { scelte: unknown[] }).scelte : null;
    if (!list) throw new HistosPublishError('Manca l\'elenco «scelte»: serve {"scelte":[{"id":"…","valore":"…"}]}.', "connector-choices-invalid", 400);
    if (list.length > Math.max(question.count, 1)) throw new HistosPublishError(`Troppe voci: la domanda ha ${question.count} scelte.`, "connector-choices-invalid", 400);
    if (!list.every((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && typeof (item as { valore?: unknown }).valore === "string")) {
      throw new HistosPublishError("Ogni voce ha id e valore, tutti e due testo.", "connector-choices-invalid", 400);
    }
    question.settle({ text: JSON.stringify({ scelte: list }) });
    return { received: list.length };
  }
}
