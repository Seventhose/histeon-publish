/**
 * Choices of judgement in an HTML import (doc 27, "rifinitura con un modello"). The deterministic converter names what it
 * creates with prudent but generic names (`section__div-2`, component `scheda-a`, prop `testo_2`, `alt=""`); each of
 * those is a choice, with its default value and a short context. A model, or a person, may answer some of them; the
 * converter runs again with the answers and uses each one only where it passes the rules below and collides with
 * nothing. The model never writes markup or CSS: whatever it answers, the prototype stays the one the converter writes.
 *
 * The id of a choice is `<kind>:<default>`: the converter computes every default the same way with or without answers,
 * so the ids of the first run are those of the second. Isomorphic (no Node API): it also runs in the browser bundle.
 */

export type ImportChoiceKind = "classe" | "componente" | "prop" | "tipo" | "alt";

export interface ImportChoice {
  /** `<kind>:<key>`, the key being the default name (for a prop `<component>.<prop>`, for an alt the asset). */
  id: string;
  kind: ImportChoiceKind;
  /** The value the converter writes without an answer. */
  value: string;
  /** What the element is, at most CONTEXT_MAX characters: site text, so data and never an instruction. */
  context: string;
}

export interface ImportChoiceRejection {
  id: string;
  motivo: string;
}

export const CONTEXT_MAX = 300;
/** The answer to an `alt` choice that keeps `alt=""`: the image says nothing the text does not. */
export const ALT_DECORATIVE = "decorativa";

/**
 * Keys a content type of a conversion cannot have: Histeon's own types, the shop's catalog (whose fields are fixed) and
 * the taxonomies (content-model.ts, histos-contract commerce.ts). The converter avoids them for its defaults too.
 */
export const RESERVED_TYPE_KEYS: ReadonlySet<string> = new Set([
  "post",
  "page",
  "product",
  "category",
  "post_tag",
  "product_cat",
  "product_tag",
]);

/** Keys a prop of a converted component cannot have: the fields every record has already. */
export const RESERVED_PROP_KEYS: ReadonlySet<string> = new Set([
  "id",
  "slug",
  "locale",
  "title",
  "status",
  "excerpt",
  "order",
  "fields",
  "terms",
  "meta",
  "url",
]);

/**
 * The shape each kind of answer must have. The same table is the one the prompt describes and the tests use.
 * `pattern` is checked on the whole answer, `max` on its length, `check` for what a pattern cannot say.
 */
export const IMPORT_CHOICE_RULES: Readonly<
  Record<
    ImportChoiceKind,
    { pattern: RegExp; max: number; description: string; check?: (value: string) => string | null }
  >
> = {
  classe: {
    pattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/u,
    max: 60,
    description: "classe BEM: blocco oppure blocco__elemento, lettere minuscole, cifre e trattini",
    check: (value) =>
      /^xb-/u.test(value)
        ? "il prefisso xb- è di Histeon CSS"
        : /^(?:is-)?(?:active|current|selected)$/u.test(value)
          ? "è il nome di uno stato attivo"
          : null,
  },
  componente: {
    pattern: /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*){0,5}$/u,
    max: 48,
    description: "nome del componente: parole minuscole unite da trattini, ogni parola comincia con una lettera",
  },
  prop: {
    pattern: /^[a-z][a-z0-9_]*$/u,
    max: 30,
    description: "nome del campo: lettere minuscole, cifre e trattini bassi",
    check: (value) => (RESERVED_PROP_KEYS.has(value) ? "è un nome riservato dei record" : null),
  },
  tipo: {
    pattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u,
    max: 40,
    description: "tipo di contenuto: parole minuscole unite da trattini",
    check: (value) => (RESERVED_TYPE_KEYS.has(value) ? "è un tipo riservato di Histeon o del negozio" : null),
  },
  alt: {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what the rule refuses.
    pattern: /^[^<>{}\u0000-\u001f\u007f]+$/u,
    max: 125,
    description: `testo alternativo breve dell'immagine, oppure «${ALT_DECORATIVE}» se non dice nulla`,
  },
};

/** Why an answer cannot be a value of its kind, or null when its shape is right (collisions are checked later). */
export function choiceShapeProblem(kind: ImportChoiceKind, value: unknown): string | null {
  if (typeof value !== "string") return "la risposta non è un testo";
  const rule = IMPORT_CHOICE_RULES[kind];
  if (value.length === 0) return "la risposta è vuota";
  if (value.length > rule.max) return `più di ${rule.max} caratteri`;
  if (kind === "alt" && value.trim() !== value) return "spazi all'inizio o alla fine";
  if (!rule.pattern.test(value)) return `non è un nome ammesso (${rule.description})`;
  return rule.check?.(value) ?? null;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > CONTEXT_MAX ? `${flat.slice(0, CONTEXT_MAX - 1)}…` : flat;
}

/**
 * The book of one conversion: it records every choice the converter meets and gives back the answer to use, or the
 * default. Rejections say why an answer was not used.
 */
export class ImportChoiceBook {
  private readonly answers: ReadonlyMap<string, string>;
  private readonly recorded = new Map<string, ImportChoice>();
  private readonly refused = new Map<string, string>();

  constructor(answers: Readonly<Record<string, string>> = {}) {
    this.answers = new Map(Object.entries(answers).filter(([, value]) => typeof value === "string"));
  }

  get choices(): ImportChoice[] {
    return [...this.recorded.values()];
  }

  get rejected(): ImportChoiceRejection[] {
    return [...this.refused].map(([id, motivo]) => ({ id, motivo }));
  }

  private record(kind: ImportChoiceKind, key: string, value: string, context: string): string {
    const id = `${kind}:${key}`;
    if (!this.recorded.has(id)) this.recorded.set(id, { id, kind, value, context: clip(context) });
    return id;
  }

  /**
   * Names for a group whose names must stay distinct: from each other's defaults and answers, and from `taken` (names
   * that exist already). `extra` says what else an answer must not be (a component tag already used, say). Returns
   * default key → the name to write.
   */
  pickNames(
    kind: Exclude<ImportChoiceKind, "alt">,
    entries: ReadonlyArray<{ key: string; value: string; context: string }>,
    taken: ReadonlySet<string>,
    extra?: (value: string, finals: ReadonlySet<string>) => string | null,
  ): Map<string, string> {
    const out = new Map<string, string>();
    const defaults = new Set(entries.map((entry) => entry.value));
    const finals = new Set<string>();
    const wanted: Array<{ entry: (typeof entries)[number]; id: string; answer: string }> = [];
    for (const entry of entries) {
      const id = this.record(kind, entry.key, entry.value, entry.context);
      const answer = this.answers.get(id);
      if (answer === undefined || answer === entry.value) out.set(entry.key, entry.value);
      else wanted.push({ entry, id, answer });
    }
    for (const value of out.values()) finals.add(value);
    for (const { entry, id, answer } of wanted) {
      const problem =
        choiceShapeProblem(kind, answer) ??
        (taken.has(answer)
          ? "il nome c'è già nel sito"
          : defaults.has(answer) || finals.has(answer)
            ? "il nome è già di un altro elemento"
            : (extra?.(answer, finals) ?? null));
      if (problem) {
        this.refused.set(id, problem);
        out.set(entry.key, entry.value);
        finals.add(entry.value);
        continue;
      }
      out.set(entry.key, answer);
      finals.add(answer);
    }
    return out;
  }

  /** The alternative text of an image without one: the answer, or "" (also for «decorativa»). */
  pickAlt(asset: string, context: string): string {
    const id = this.record("alt", asset, "", context);
    const answer = this.answers.get(id);
    if (answer === undefined || answer === ALT_DECORATIVE) return "";
    const problem = choiceShapeProblem("alt", answer);
    if (problem) {
      this.refused.set(id, problem);
      return "";
    }
    return answer;
  }
}

/**
 * A model's answers, sorted before they reach the converter: the ones whose shape is right and that change something
 * go to `apply`, except alternative texts, which go to `suggestions` (a text model does not see the image: a person
 * accepts them one by one). Unknown ids, wrong shapes and duplicates are rejected with their reason.
 */
export function sortChoiceAnswers(
  choices: readonly ImportChoice[],
  answers: unknown,
): { apply: Record<string, string>; suggestions: Record<string, string>; rejected: ImportChoiceRejection[] } {
  const apply: Record<string, string> = {};
  const suggestions: Record<string, string> = {};
  const rejected: ImportChoiceRejection[] = [];
  const byId = new Map(choices.map((choice) => [choice.id, choice]));
  const list = Array.isArray(answers) ? answers : [];
  const seen = new Set<string>();
  for (const item of list) {
    const id =
      item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
        ? (item as { id: string }).id
        : null;
    if (id === null) {
      rejected.push({ id: "?", motivo: "risposta senza id" });
      continue;
    }
    const choice = byId.get(id);
    if (!choice) {
      rejected.push({ id: id.slice(0, 120), motivo: "id sconosciuto" });
      continue;
    }
    if (seen.has(id)) {
      rejected.push({ id, motivo: "id ripetuto" });
      continue;
    }
    seen.add(id);
    const value = (item as { valore?: unknown }).valore;
    if (value === choice.value) continue;
    if (choice.kind === "alt" && value === ALT_DECORATIVE) continue;
    const problem = choiceShapeProblem(choice.kind, value);
    if (problem) {
      rejected.push({ id, motivo: problem });
      continue;
    }
    if (choice.kind === "alt") suggestions[id] = value as string;
    else apply[id] = value as string;
  }
  return { apply, suggestions, rejected };
}
