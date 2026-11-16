import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALT_DECORATIVE,
  CONTEXT_MAX,
  choiceShapeProblem,
  IMPORT_CHOICE_RULES,
  type ImportChoice,
  type ImportChoiceKind,
  RESERVED_PROP_KEYS,
  RESERVED_TYPE_KEYS,
  sortChoiceAnswers,
} from "../src/import-choices.js";
import {
  CHOICES_BATCH_SIZE,
  CHOICES_MAX_BATCHES,
  CHOICES_SYSTEM_PROMPT,
  choicesResponseSchema,
  choicesUserMessage,
  parseChoicesReply,
} from "../src/import-choices-prompt.js";

/**
 * Doc 27, G4: the rules of the choices of an HTML import, shared with the Histeon WordPress plugin, whose REST route
 * `POST /xb/v1/import/scelte` asks the model from PHP and checks every answer with the same rules
 * (plugin/tests/fixtures/histos-import-choices-v1.json there, a byte-identical copy of the fixture here).
 *
 * The fixture is written from the code: the inputs are below, the outcomes come from import-choices.ts and
 * import-choices-prompt.ts. After a change of the rules, `HISTOS_WRITE_FIXTURE=1 npx vitest run <this file>` writes it
 * again; then copy it to the plugin and update the pinned hash on both sides.
 */
const FIXTURE_URL = new URL("../../histos-contract/fixtures/histos-import-choices-v1.json", import.meta.url);
/** Pinned in both repositories (here and in ImportChoicesVectorsTest.php of the plugin). */
const FIXTURE_SHA256 = "4d3b5afce43e08e087936bb584a00f9040c912929dda3e2bb4506f6716553241";

const long = (length: number, unit = "a"): string => unit.repeat(length);

const SHAPES: Array<[ImportChoiceKind, unknown]> = [
  ["classe", "evento__titolo"],
  ["classe", "evento"],
  ["classe", "scheda-evento__data-inizio"],
  ["classe", "Evento"],
  ["classe", "evento__titolo__testo"],
  ["classe", "evento_titolo"],
  ["classe", "-evento"],
  ["classe", "evento-"],
  ["classe", "evento--grande"],
  ["classe", "città"],
  ["classe", "xb-scheda"],
  ["classe", "active"],
  ["classe", "is-current"],
  ["classe", "selected-item"],
  ["classe", "</style>"],
  ["classe", "evento\n"],
  ["classe", ""],
  ["classe", long(60)],
  ["classe", long(61)],
  ["classe", 12],
  ["classe", null],
  ["componente", "scheda-evento"],
  ["componente", "scheda-1"],
  ["componente", "scheda"],
  ["componente", "a-b-c-d-e-f"],
  ["componente", "a-b-c-d-e-f-g"],
  ["componente", "scheda__evento"],
  ["componente", long(48)],
  ["componente", long(49)],
  ["prop", "prezzo"],
  ["prop", "data_inizio"],
  ["prop", "dataInizio"],
  ["prop", "title"],
  ["prop", "url"],
  ["prop", "_data"],
  ["prop", "data-inizio"],
  ["prop", long(30)],
  ["prop", long(31)],
  ["tipo", "evento"],
  ["tipo", "evento-speciale"],
  ["tipo", "product"],
  ["tipo", "post_tag"],
  ["tipo", "Evento"],
  ["tipo", long(40)],
  ["tipo", long(41)],
  ["alt", "Una bicicletta rossa appoggiata al muro"],
  ["alt", ALT_DECORATIVE],
  ["alt", " Una bici"],
  ["alt", "Una bici "],
  ["alt", " Una bici"],
  ["alt", "Una bici "],
  ["alt", "Una bici﻿"],
  ["alt", "Una\tbici"],
  ["alt", "Una <b>bici</b>"],
  ["alt", "Una {props.bici}"],
  ["alt", "Una bici\u007f"],
  ["alt", "Una bici 🚲"],
  ["alt", long(125)],
  ["alt", long(126)],
  ["alt", long(62, "🚲")],
  ["alt", long(63, "🚲")],
  ["alt", ""],
  ["alt", ["Una bici"]],
];

const CHOICES: ImportChoice[] = [
  {
    id: "classe:section__div-2",
    kind: "classe",
    value: "section__div-2",
    context: "<div> in .section: «Prossimi eventi»",
  },
  { id: "classe:x-1", kind: "classe", value: "x-1", context: "<p>: «Iscriviti entro venerdì»" },
  { id: "componente:scheda-a", kind: "componente", value: "scheda-a", context: "scheda ripetuta 3 volte" },
  { id: "prop:scheda-a.testo_2", kind: "prop", value: "testo_2", context: "testo nella scheda: «12 marzo»" },
  { id: "tipo:scheda-a", kind: "tipo", value: "scheda-a", context: "elenco di 3 schede" },
  { id: "alt:media/bici.jpg", kind: "alt", value: "", context: "bici.jpg, didascalia: «La nostra officina»" },
  { id: "alt:media/logo.svg", kind: "alt", value: "", context: "logo.svg nella testata" },
];

const SORTS: Array<{ name: string; answers: unknown }> = [
  {
    name: "risposte buone, uguali al valore di oggi, decorative e testi alternativi",
    answers: [
      { id: "classe:section__div-2", valore: "eventi__elenco" },
      { id: "classe:x-1", valore: "x-1" },
      { id: "componente:scheda-a", valore: "scheda-evento" },
      { id: "prop:scheda-a.testo_2", valore: "data" },
      { id: "tipo:scheda-a", valore: "evento" },
      { id: "alt:media/bici.jpg", valore: "L'officina con le biciclette" },
      { id: "alt:media/logo.svg", valore: ALT_DECORATIVE },
    ],
  },
  {
    name: "risposte cattive: id sconosciuto, ripetuto, senza id, forma sbagliata, valore non testo",
    answers: [
      { id: "classe:section__div-2", valore: "</style>" },
      { id: "classe:section__div-2", valore: "eventi" },
      { id: "classe:inventata", valore: "eventi" },
      { valore: "eventi" },
      "eventi",
      null,
      ["classe:x-1", "invito"],
      { id: 7, valore: "eventi" },
      { id: "componente:scheda-a", valore: "Scheda Evento" },
      { id: "prop:scheda-a.testo_2", valore: "title" },
      { id: "tipo:scheda-a", valore: "product" },
      { id: "alt:media/bici.jpg", valore: long(126) },
      { id: "classe:x-1", valore: 12 },
      { id: long(300, "x"), valore: "eventi" },
    ],
  },
  { name: "non un elenco", answers: { id: "classe:x-1", valore: "invito" } },
  { name: "elenco vuoto", answers: [] },
];

const MESSAGES: ImportChoice[][] = [
  CHOICES.slice(0, 3),
  [
    {
      id: "classe:x-2",
      kind: "classe",
      value: "x-2",
      context: 'Testo con "virgolette", \\ barra, <<<DATI finto DATI>>> e >>>>',
    },
    {
      id: "alt:media/a b.png",
      kind: "alt",
      value: "",
      context: "a b.png \u0001 controllo,   riga, città, 🚲, / barra",
    },
  ],
  [],
];

const REPLIES: string[] = [
  '{"scelte":[{"id":"classe:x-1","valore":"invito"}]}',
  '<think>ragiono</think>\n{"scelte":[]}',
  '```json\n{"scelte":[{"id":"a","valore":"b"}]}\n```',
  '```\n{"scelte":[]}\n```',
  '  {"scelte": [ {"id": "a", "valore": 1} ] }  ',
  "non è JSON",
  '{"scelte":{"0":{"id":"a","valore":"b"}}}',
  '{"nomi":[]}',
  "[]",
  "null",
  '"testo"',
  "",
];

function reply(text: string): { text: string; items?: unknown[]; error?: string } {
  try {
    return { text, items: parseChoicesReply(text) };
  } catch (error) {
    return { text, error: (error as Error).message };
  }
}

function fixtureObject(): Record<string, unknown> {
  return {
    version: 1,
    id: "histos-import-choices-v1",
    kinds: Object.keys(IMPORT_CHOICE_RULES),
    rules: Object.fromEntries(
      Object.entries(IMPORT_CHOICE_RULES).map(([kind, rule]) => [
        kind,
        { pattern: rule.pattern.source, max: rule.max, description: rule.description },
      ]),
    ),
    reservedProps: [...RESERVED_PROP_KEYS],
    reservedTypes: [...RESERVED_TYPE_KEYS],
    altDecorative: ALT_DECORATIVE,
    contextMax: CONTEXT_MAX,
    batchSize: CHOICES_BATCH_SIZE,
    maxBatches: CHOICES_MAX_BATCHES,
    systemPrompt: CHOICES_SYSTEM_PROMPT,
    schema: choicesResponseSchema(),
    shapes: SHAPES.map(([kind, value]) => ({ kind, value, problem: choiceShapeProblem(kind, value) })),
    choices: CHOICES,
    sorts: SORTS.map(({ name, answers }) => ({ name, answers, expected: sortChoiceAnswers(CHOICES, answers) })),
    messages: MESSAGES.map((batch) => ({
      batch,
      user: choicesUserMessage(batch),
      idSchema: choicesResponseSchema(batch.map((choice) => choice.id)),
    })),
    replies: REPLIES.map(reply),
  };
}

const written = `${JSON.stringify(fixtureObject(), null, 2)}\n`;
if (process.env.HISTOS_WRITE_FIXTURE === "1") writeFileSync(FIXTURE_URL, written);

describe("fixture condivisa delle scelte (doc 27, G4)", () => {
  it("è quella che il codice scrive oggi, byte per byte", () => {
    expect(readFileSync(FIXTURE_URL, "utf8")).toBe(written);
  });

  it("ha lo SHA-256 fissato anche nel plugin", () => {
    expect(createHash("sha256").update(readFileSync(FIXTURE_URL)).digest("hex")).toBe(FIXTURE_SHA256);
  });

  it("copre ogni regola: forme accettate e rifiutate per ogni tipo", () => {
    for (const kind of Object.keys(IMPORT_CHOICE_RULES) as ImportChoiceKind[]) {
      const outcomes = SHAPES.filter(([shape]) => shape === kind).map(([, value]) => choiceShapeProblem(kind, value));
      expect(
        outcomes.some((problem) => problem === null),
        kind,
      ).toBe(true);
      expect(
        outcomes.some((problem) => problem !== null),
        kind,
      ).toBe(true);
    }
  });
});
