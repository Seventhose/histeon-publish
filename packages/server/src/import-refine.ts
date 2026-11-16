import {
  askChoices,
  CHOICES_MAX_BATCHES,
  CHOICES_BATCH_SIZE,
  openAiCompatibleAsk,
  staticSiteProjectId,
  staticSiteToPrototype,
  type AskChoices,
  type ChoiceBatchReport,
  type ImportChoice,
  type ImportChoiceKind,
  type ImportChoiceRejection,
  type StaticSiteFile,
} from "@histos-publish/cms";
import { HistosPublishError } from "@histos-publish/core";
import { anthropicChoicesAsk, CHOICES_ANTHROPIC_MODEL } from "./import-choices-anthropic.js";

/**
 * Doc 27, G3: «Rifinisci i nomi con un modello» in Publish. The provider is one for the whole app (the «Agente AI»
 * screen): the Claude of the user's plan through the AI connector (the default since the real test, G5: only Claude
 * made the names clearer), a local OpenAI-compatible server (llama-server) or Claude Haiku 5.5 with the user's API key. The keys live in the system keyring, never in the settings or in an answer.
 *
 * The refinement never changes a prototype by itself: it gives rows «prima → dopo» that a person applies (all of them or
 * some), and alternative texts that a person accepts one by one. The conversion then runs again with those `choices`.
 */

/** «connettore»: the Claude of the user's plan, through the AI connector (hp_import_choices); no key here. */
export type RefineProvider = "connettore" | "locale" | "haiku";

export interface RefineSettings {
  provider: RefineProvider;
  /** The OpenAI-compatible server, `http(s)://host:port` (the `/v1` is added). */
  localUrl: string;
  /** The model name the local server is asked for (llama-server serves the one it loaded, whatever the name). */
  localModel: string;
}

export const REFINE_SETTINGS_KEY = "importRefine";
export const REFINE_LOCAL_KEY_ACCOUNT = "import-refine-local";
export const REFINE_HAIKU_KEY_ACCOUNT = "import-refine-anthropic";
export const REFINE_DEFAULTS: Readonly<RefineSettings> = { provider: "connettore", localUrl: "http://127.0.0.1:18080", localModel: "qwen3-8b" };
/** Answers a conversion takes at most (the model's are at most 10 batches of 20; a person adds alternative texts). */
export const REFINE_CHOICES_MAX = 400;

const URL_MAX = 200;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/u;
const KEY_MAX = 400;

/** The address of a local model server: http or https, with no user, password, query or fragment. */
export function refineUrlProblem(value: string): string | null {
  if (value.length > URL_MAX) return "l’indirizzo è troppo lungo";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "non è un indirizzo";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "l’indirizzo deve cominciare con http:// o https://";
  if (url.username || url.password) return "l’indirizzo non può contenere nome utente o password: la chiave va nel suo campo";
  if (url.search || url.hash) return "l’indirizzo non può avere ? o #";
  return null;
}

/** The settings as saved, with the defaults for anything missing or no longer valid. */
export function readRefineSettings(saved: unknown): RefineSettings {
  const value = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const provider = value.provider === "haiku" || value.provider === "locale" || value.provider === "connettore" ? value.provider : REFINE_DEFAULTS.provider;
  const localUrl = typeof value.localUrl === "string" && refineUrlProblem(value.localUrl) === null ? value.localUrl : REFINE_DEFAULTS.localUrl;
  const localModel = typeof value.localModel === "string" && MODEL_PATTERN.test(value.localModel) ? value.localModel : REFINE_DEFAULTS.localModel;
  return { provider, localUrl, localModel };
}

/**
 * A change of the settings from the «Agente AI» screen. `localKey` and `haikuKey`: a string saves it, `null` removes
 * it, absent leaves it as it is. Anything that does not fit is refused with the reason, nothing is half saved.
 */
export function parseRefineSettingsChange(body: Record<string, unknown>, current: RefineSettings): {
  settings: RefineSettings;
  localKey?: string | null;
  haikuKey?: string | null;
} {
  const fail = (message: string): never => {
    throw new HistosPublishError(message, "cms-import-refine-settings-invalid", 400);
  };
  const settings = { ...current };
  if (body.provider !== undefined) {
    if (body.provider !== "connettore" && body.provider !== "locale" && body.provider !== "haiku") fail("Il fornitore è «connettore», «locale» o «haiku».");
    settings.provider = body.provider as RefineProvider;
  }
  if (body.localUrl !== undefined) {
    const url = typeof body.localUrl === "string" ? body.localUrl.trim().replace(/\/+$/u, "") : "";
    const problem = refineUrlProblem(url);
    if (problem) fail(`Indirizzo del modello locale: ${problem}.`);
    settings.localUrl = url;
  }
  if (body.localModel !== undefined) {
    const model = typeof body.localModel === "string" ? body.localModel.trim() : "";
    if (!MODEL_PATTERN.test(model)) fail("Il nome del modello locale ha lettere, cifre e . _ : / - (al massimo 80).");
    settings.localModel = model;
  }
  const key = (name: string, value: unknown): string | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > KEY_MAX || /\s/u.test(text)) fail(`La chiave ${name} non è valida.`);
    return text;
  };
  const localKey = key("del modello locale", body.localKey);
  const haikuKey = key("di Anthropic", body.haikuKey);
  return { settings, ...(localKey === undefined ? {} : { localKey }), ...(haikuKey === undefined ? {} : { haikuKey }) };
}

/** The model the refinement uses with these settings, as the table names it. */
export function refineModelName(settings: RefineSettings): string {
  return settings.provider === "haiku" ? CHOICES_ANTHROPIC_MODEL : settings.provider === "connettore" ? "Claude" : settings.localModel;
}

/**
 * The provider for these settings. A local server that does not answer says so in plain words (fetch only says
 * «fetch failed»); the Claude API errors are already translated by its adapter. Never the key in a message.
 */
export function refineAsk(settings: RefineSettings, key: string | null, seams: { fetch?: typeof fetch; anthropicBaseUrl?: string } = {}): AskChoices {
  if (settings.provider === "connettore") throw new HistosPublishError("Claude dal connettore risponde solo nell’app, con il connettore AI acceso: dal terminale usa --fornitore=locale o haiku.", "cms-import-refine-connector-only", 409);
  if (settings.provider === "haiku") {
    if (!key) throw new HistosPublishError("Manca la chiave API di Anthropic: aggiungila in Agente AI → Rifinitura dei nomi.", "cms-import-refine-key-missing", 409);
    return anthropicChoicesAsk({ apiKey: key, ...(seams.anthropicBaseUrl ? { baseURL: seams.anthropicBaseUrl } : {}) });
  }
  const ask = openAiCompatibleAsk({ url: settings.localUrl, model: settings.localModel, ...(key ? { apiKey: key } : {}), ...(seams.fetch ? { fetch: seams.fetch } : {}) });
  const host = new URL(settings.localUrl).host;
  return async (request) => {
    try {
      return await ask(request);
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (error instanceof TypeError && /fetch failed|ECONNREFUSED|network/iu.test(`${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`)) {
        throw new Error(`il modello locale su ${host} non risponde: è acceso?`);
      }
      if (error instanceof Error && /risponde 401/u.test(error.message)) throw new Error(`il modello locale su ${host} rifiuta la chiave (401)`);
      throw error;
    }
  };
}

/** One row of the table «prima → dopo»: a name the model proposes and the converter would accept. */
export interface RefineRow {
  id: string;
  kind: ImportChoiceKind;
  before: string;
  after: string;
  /** What the element is: site text, shown as text. */
  context: string;
}

export interface RefineReport {
  provider: RefineProvider;
  model: string;
  /** Choices the conversion had, and how many were asked. */
  choices: number;
  asked: number;
  rows: RefineRow[];
  /** Alternative texts, never applied by themselves: a person accepts them one by one. */
  suggestions: RefineRow[];
  /** Answers left out, with the reason (wrong shape, a name already in the site, a clash). */
  rejected: Array<ImportChoiceRejection & { after?: string }>;
  batches: ChoiceBatchReport[];
  skipped: number;
  ms: number;
}

/**
 * Asks the model the choices of a conversion and keeps only what a second conversion would use: `trial` converts with
 * the answers and says which ones it rejected (a clash with another name, a swap). Nothing of the prototype changes.
 */
export async function refineImportChoices(input: {
  choices: readonly ImportChoice[];
  ask: AskChoices;
  settings: RefineSettings;
  trial?: (answers: Record<string, string>) => ImportChoiceRejection[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** One batch of up to 200 for the connector: the agent answers one question, not ten. */
  batchSize?: number;
  maxBatches?: number;
  now?: () => number;
}): Promise<RefineReport> {
  const now = input.now ?? (() => Date.now());
  const started = now();
  const asked = await askChoices(input.choices, input.ask, { ...(input.signal ? { signal: input.signal } : {}), ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}), ...(input.batchSize ? { batchSize: input.batchSize } : {}), ...(input.maxBatches ? { maxBatches: input.maxBatches } : {}), now });
  const byId = new Map(input.choices.map((choice) => [choice.id, choice]));
  const trialRejected = new Map<string, string>();
  if (input.trial && Object.keys(asked.apply).length + Object.keys(asked.suggestions).length) {
    for (const item of input.trial({ ...asked.apply, ...asked.suggestions })) trialRejected.set(item.id, item.motivo);
  }
  const row = (id: string, after: string): RefineRow | null => {
    const choice = byId.get(id);
    return choice ? { id, kind: choice.kind, before: choice.value, after, context: choice.context } : null;
  };
  const rows: RefineRow[] = [];
  const suggestions: RefineRow[] = [];
  const rejected: RefineReport["rejected"] = asked.rejected.map((item) => ({ ...item }));
  for (const [answers, list] of [[asked.apply, rows], [asked.suggestions, suggestions]] as const) {
    for (const [id, after] of Object.entries(answers)) {
      const reason = trialRejected.get(id);
      if (reason) rejected.push({ id, motivo: reason, after });
      else {
        const made = row(id, after);
        if (made) list.push(made);
      }
    }
  }
  return {
    provider: input.settings.provider,
    model: refineModelName(input.settings),
    choices: input.choices.length,
    asked: Math.min(input.choices.length, (input.batchSize ?? CHOICES_BATCH_SIZE) * (input.maxBatches ?? CHOICES_MAX_BATCHES)),
    rows,
    suggestions,
    rejected: rejected.slice(0, 200),
    batches: asked.batches,
    skipped: asked.skipped,
    ms: now() - started,
  };
}

/** The answers a person applied, from a request: at most REFINE_CHOICES_MAX, ids and values of plain text. */
export function parseChoiceAnswers(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new HistosPublishError("Le scelte sono un oggetto id → valore.", "cms-site-choices-invalid", 400);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > REFINE_CHOICES_MAX) throw new HistosPublishError(`Al massimo ${REFINE_CHOICES_MAX} scelte per conversione.`, "cms-site-choices-invalid", 400);
  const answers: Record<string, string> = {};
  for (const [id, answer] of entries) {
    if (id.length > 400 || !/^(?:classe|componente|prop|tipo|alt):/u.test(id) || typeof answer !== "string" || answer.length > 200) {
      throw new HistosPublishError("Una scelta non è valida: id del convertitore e un valore di al massimo 200 caratteri.", "cms-site-choices-invalid", 400);
    }
    answers[id] = answer;
  }
  return answers;
}

/**
 * `histos-publish prototype rifinisci`: a site's files converted, the model asked, and with `write` the prototype
 * converted again with every row of the table. Alternative texts are never applied here: they are printed, for a
 * person to accept in the app. No remote media is downloaded (the app's conversion does that).
 */
export async function refineStaticSite(input: {
  /** Stable for the same source, so a prototype written twice updates the same project. */
  sourceKey: string;
  name: string;
  files: readonly StaticSiteFile[];
  structure: boolean;
  settings: RefineSettings;
  ask: AskChoices;
  write: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ report: RefineReport; prototype: string | null; choicesRejected: ImportChoiceRejection[] }> {
  const structure = { parts: input.structure, components: input.structure, lists: input.structure };
  const convert = (choices: Record<string, string>) => {
    try {
      return staticSiteToPrototype({ projectId: staticSiteProjectId(`cli:${input.sourceKey}`), name: input.name, files: input.files, structure, ...(Object.keys(choices).length ? { choices } : {}) });
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) throw new HistosPublishError(error.message, "cms-site-conversion-invalid", 2);
      throw error;
    }
  };
  const first = convert({});
  const report = await refineImportChoices({
    choices: first.choices,
    ask: input.ask,
    settings: input.settings,
    trial: (extra) => convert(extra).choicesRejected.filter((item) => item.id in extra),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  if (!input.write) return { report, prototype: null, choicesRejected: [] };
  const applied = convert(Object.fromEntries(report.rows.map((row) => [row.id, row.after])));
  return { report, prototype: applied.html, choicesRejected: applied.choicesRejected };
}

/** The table «prima → dopo» as the CLI prints it: one line per name, then the texts and what was left out. */
export function refineReportText(report: RefineReport): string {
  const lines = [`Rifinitura con ${report.model} (${report.provider === "haiku" ? "Claude API" : report.provider === "connettore" ? "dal connettore" : "modello locale"}): ${report.choices} scelte, ${report.rows.length} nomi proposti, ${report.suggestions.length} testi alternativi, ${Math.max(1, Math.round(report.ms / 1000))} s.`];
  const failed = report.batches.filter((batch) => !batch.ok);
  if (failed.length) lines.push(`Lotti senza risposta: ${failed.length} su ${report.batches.length} (${failed[0]?.error ?? "errore"}): quei nomi restano quelli del convertitore.`);
  if (report.skipped) lines.push(`${report.skipped} scelte oltre le prime ${report.asked} restano coi nomi del convertitore.`);
  if (report.rows.length) {
    const width = Math.min(40, Math.max(5, ...report.rows.map((row) => row.before.length)));
    lines.push("", `${"prima".padEnd(width)}  →  dopo`);
    for (const row of report.rows) lines.push(`${row.before.padEnd(width)}  →  ${row.after}   (${row.kind})`);
  }
  if (report.suggestions.length) {
    lines.push("", "Testi alternativi suggeriti (il modello non vede le immagini: si accettano uno per uno nell’app, qui non si applicano):");
    for (const row of report.suggestions) lines.push(`• ${row.id.slice("alt:".length)}: «${row.after}»`);
  }
  if (report.rejected.length) {
    lines.push("", `Risposte lasciate fuori: ${report.rejected.length}`);
    for (const item of report.rejected.slice(0, 30)) lines.push(`• ${item.id}${item.after ? ` → ${item.after}` : ""}: ${item.motivo}`);
  }
  return lines.join("\n");
}
