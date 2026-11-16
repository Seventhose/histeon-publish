import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALT_DECORATIVE,
  choiceShapeProblem,
  IMPORT_CHOICE_RULES,
  type ImportChoice,
  ImportChoiceBook,
  sortChoiceAnswers,
} from "../src/import-choices.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { type StaticSiteFile, staticSiteToPrototype } from "../src/static-site-prototype.js";

/**
 * Doc 27, G1: the choices of judgement of an HTML import. Without answers the converter writes what it wrote before;
 * with good answers only the names change; with bad answers nothing changes and each one says why.
 */
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const corpus = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "import-corpus");
const SITES = ["landing-bootstrap", "webflow-like", "utility-tailwind", "blog-statico", "moduli-svg", "script-cdn"];
const STRUCTURE = { parts: true, components: true, lists: true };

function filesOf(root: string): StaticSiteFile[] {
  const out: StaticSiteFile[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else
        out.push({
          path: path.relative(root, full).split(path.sep).join("/"),
          bytes: new Uint8Array(readFileSync(full)),
        });
    }
  };
  walk(root);
  return out;
}

/** As the corpus test: remote media answered with small files, in two rounds; then the conversion with `choices`. */
function converter(site: string) {
  const input = {
    projectId: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4",
    name: site,
    files: filesOf(path.join(corpus, site)),
    structure: STRUCTURE,
  };
  const remote = new Map<string, Uint8Array>();
  let prototype = staticSiteToPrototype(input);
  for (let round = 0; round < 2 && prototype.remoteMedia.some((url) => !remote.has(url)); round++) {
    for (const url of prototype.remoteMedia)
      remote.set(
        url,
        /\.css(?:[?#]|$)/u.test(url)
          ? new TextEncoder().encode(".remote-cdn{color:red}")
          : /\.js(?:[?#]|$)/u.test(url)
            ? new TextEncoder().encode("window.Swiper = function () {};")
            : PNG,
      );
    prototype = staticSiteToPrototype({ ...input, remoteMedia: remote });
  }
  return {
    first: prototype,
    again: (choices: Record<string, string>) => staticSiteToPrototype({ ...input, remoteMedia: remote, choices }),
  };
}

const tagOf = (ref: string): string =>
  ref
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
function letters(index: number): string {
  let out = "";
  let value = index;
  do {
    out = String.fromCharCode(97 + (value % 26)) + out;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return out;
}

/**
 * Good answers for the choices of some kinds, all different, made of tokens no site uses (`zq…`); `tokens` maps each
 * token back to the part of the default it stands for (the CSS nests `&__element`, so a class goes back part by part).
 */
function goodAnswers(
  choices: readonly ImportChoice[],
  kinds: ReadonlyArray<ImportChoice["kind"]>,
): { answers: Record<string, string>; tokens: Array<[string, string]> } {
  const answers: Record<string, string> = {};
  const tokens: Array<[string, string]> = [];
  choices.forEach((choice, index) => {
    if (!kinds.includes(choice.kind)) return;
    const tail = letters(index);
    if (choice.kind === "classe") {
      const [block, element] = choice.value.split("__") as [string, string | undefined];
      if (element === undefined) {
        answers[choice.id] = `zqc${tail}`;
        tokens.push([`zqc${tail}`, block]);
      } else {
        answers[choice.id] = `${block}__zqe${tail}`;
        tokens.push([`zqe${tail}`, element]);
      }
    }
    if (choice.kind === "componente") {
      answers[choice.id] = `zqk-${tail}`;
      tokens.push([`zqk-${tail}`, choice.value], [tagOf(`zqk-${tail}`), tagOf(choice.value)]);
    }
    if (choice.kind === "prop") {
      answers[choice.id] = `zqp_${tail}`;
      tokens.push([`zqp_${tail}`, choice.value], [`zqp ${tail}`, choice.value.replaceAll("_", " ")]);
    }
    if (choice.kind === "tipo") answers[choice.id] = `zqt${tail}`;
  });
  return { answers, tokens };
}

/** The html with every token back to its default: equal to the first conversion when only names changed. */
function backToDefaults(html: string, tokens: ReadonlyArray<[string, string]>): string {
  let out = html;
  for (const [token, value] of [...tokens].sort((left, right) => right[0].length - left[0].length))
    out = out.replaceAll(token, value);
  return out;
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function importable(html: string): Promise<number> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-choices-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  await catalog.initialize();
  const built = await buildPrototypeProfile(parsePrototype(html), catalog);
  return built.profile.entities.length;
}

describe("scelte dell'importazione HTML (doc 27, G1)", () => {
  it("ogni sito del corpus ha scelte stabili, con contesti brevi e valori che rispettano le regole", () => {
    const summary: Record<string, Record<string, number>> = {};
    for (const site of SITES) {
      const { first, again } = converter(site);
      const counts: Record<string, number> = {};
      for (const choice of first.choices) {
        counts[choice.kind] = (counts[choice.kind] ?? 0) + 1;
        expect(choice.id).toBe(`${choice.kind}:${choice.id.slice(choice.kind.length + 1)}`);
        expect(choice.context.length).toBeLessThanOrEqual(300);
        if (choice.kind !== "alt")
          expect(choiceShapeProblem(choice.kind, choice.value), `${site} ${choice.id}`).toBeNull();
      }
      summary[site] = counts;
      // The same input gives the same choices, and an empty answer list the same prototype, byte for byte.
      const second = again({});
      expect(second.choices).toEqual(first.choices);
      expect(second.html).toBe(first.html);
      expect(second.choicesRejected).toEqual([]);
    }
    expect(summary).toMatchSnapshot();
    // The corpus has every kind somewhere but alt (its images all have one: the alt test has its own site).
    for (const kind of Object.keys(IMPORT_CHOICE_RULES).filter((name) => name !== "alt"))
      expect(
        Object.values(summary).some((counts) => (counts[kind] ?? 0) > 0),
        kind,
      ).toBe(true);
  });

  it.each(SITES)("%s: classi rinominate ovunque e nient'altro cambia", async (site) => {
    const { first, again } = converter(site);
    const { answers, tokens } = goodAnswers(first.choices, ["classe"]);
    const result = again(answers);
    expect(result.choicesRejected).toEqual([]);
    // Ids and defaults stay; a context may show the new name of a class nearby.
    const ids = (list: readonly ImportChoice[]) => list.map((choice) => [choice.id, choice.value]);
    expect(ids(result.choices)).toEqual(ids(first.choices));
    if (Object.keys(answers).length) expect(result.html).not.toBe(first.html);
    expect(backToDefaults(result.html, tokens)).toBe(first.html);
    expect(await importable(result.html)).toBeGreaterThan(0);
  });

  it.each(SITES)("%s: componenti e campi rinominati ovunque e nient'altro cambia", async (site) => {
    const { first, again } = converter(site);
    const { answers, tokens } = goodAnswers(first.choices, ["componente", "prop"]);
    const result = again(answers);
    expect(result.choicesRejected).toEqual([]);
    expect(backToDefaults(result.html, tokens)).toBe(first.html);
    expect(await importable(result.html)).toBeGreaterThan(0);
  });

  it.each(SITES)("%s: tutte le risposte insieme danno un prototipo che si importa", async (site) => {
    const { first, again } = converter(site);
    const { answers } = goodAnswers(first.choices, ["classe", "componente", "prop", "tipo"]);
    const result = again(answers);
    expect(result.choicesRejected).toEqual([]);
    expect(await importable(result.html)).toBeGreaterThan(0);
    const types = first.choices.filter((choice) => choice.kind === "tipo");
    const content = /<script data-histos="content" type="application\/json">(.*?)<\/script>/u.exec(result.html)?.[1];
    if (types.length) {
      const parsed = JSON.parse(content ?? "{}") as {
        types: Array<{ key: string; label: string }>;
        queries: Array<{ key: string; type: string }>;
        records: Array<{ type: string }>;
      };
      for (const choice of types) {
        const answer = answers[choice.id] as string;
        expect(parsed.types.map((type) => type.key)).toContain(answer);
        expect(parsed.queries.find((query) => query.type === answer)?.key).toBe(`${answer}_elenco`);
        expect(result.html).toContain(`{#loop ${answer}_elenco() as item}`);
      }
      expect(parsed.records.every((record) => !types.some((choice) => record.type === choice.value))).toBe(true);
    }
  });

  it("le risposte sbagliate non cambiano nulla e dicono perché", () => {
    const site = SITES.find((name) => {
      const kinds = new Set(converter(name).first.choices.map((choice) => choice.kind));
      return kinds.has("classe") && kinds.has("componente") && kinds.has("prop");
    }) as string;
    const { first, again } = converter(site);
    const classes = first.choices.filter((choice) => choice.kind === "classe");
    const component = first.choices.find((choice) => choice.kind === "componente") as ImportChoice;
    const props = first.choices.filter((choice) => choice.kind === "prop");
    const siteClass = /class="([a-z][a-z0-9-]*)[ "]/u.exec(first.html.split("<template")[1] ?? "")?.[1] ?? "";
    const bad: Record<string, string> = {
      [classes[0]?.id]: "</style><script>alert(1)</script>",
      ...(classes[1] ? { [classes[1].id]: "a__b__c" } : {}),
      ...(classes[2] ? { [classes[2].id]: "flex" } : {}),
      ...(classes[3] ? { [classes[3].id]: "xb-card" } : {}),
      ...(classes[4] ? { [classes[4].id]: "x".repeat(10_000) } : {}),
      ...(classes[5] ? { [classes[5].id]: classes[6]?.value ?? "a__b__c" } : {}),
      ...(classes[7] && siteClass ? { [classes[7].id]: siteClass } : {}),
      [component.id]: "Scheda Evento",
      [props[0]?.id]: "title",
      "classe:non-esiste": "nuovo",
    };
    const result = again(bad);
    expect(result.html).toBe(first.html);
    const reasons = new Map(result.choicesRejected.map((item) => [item.id, item.motivo]));
    expect(reasons.get(classes[0]?.id)).toMatch(/non è un nome ammesso/u);
    if (classes[2]) expect(reasons.get(classes[2].id)).toMatch(/utility/u);
    if (classes[3]) expect(reasons.get(classes[3].id)).toMatch(/xb-/u);
    if (classes[4]) expect(reasons.get(classes[4].id)).toMatch(/più di 60/u);
    if (classes[5] && classes[6]) expect(reasons.get(classes[5].id)).toMatch(/già di un altro/u);
    if (classes[7] && siteClass) expect(reasons.get(classes[7].id)).toMatch(/c'è già nel sito/u);
    expect(reasons.get(component.id)).toMatch(/non è un nome ammesso/u);
    expect(reasons.get(props[0]?.id)).toMatch(/riservato/u);
    // An id no choice has is not answered by the converter: sortChoiceAnswers says so before.
    expect(reasons.has("classe:non-esiste")).toBe(false);
  });

  it("un testo alternativo accettato entra nell'immagine, «decorativa» lascia alt vuoto", () => {
    const html =
      '<!doctype html><html lang="it"><head><title>Forno</title></head><body><main><figure><img src="forno.png"><figcaption>Il forno all\'alba</figcaption></figure></main></body></html>';
    const input = {
      projectId: "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      name: "forno",
      files: [
        { path: "index.html", bytes: new TextEncoder().encode(html) },
        { path: "forno.png", bytes: PNG },
      ],
    };
    const first = staticSiteToPrototype(input);
    const alt = first.choices.find((choice) => choice.kind === "alt") as ImportChoice;
    expect(alt.context).toContain("file: forno.png");
    expect(alt.context).toContain("testo vicino: «Il forno all'alba»");
    const asset = alt.id.slice("alt:".length);
    const accepted = staticSiteToPrototype({ ...input, choices: { [alt.id]: "Il forno a legna acceso" } });
    expect(accepted.html).toMatch(new RegExp(`<img src="asset:${asset}"[^>]* alt="Il forno a legna acceso"`, "u"));
    expect(accepted.report.notes.some((note) => note.includes("alt vuoto"))).toBe(false);
    expect(staticSiteToPrototype({ ...input, choices: { [alt.id]: ALT_DECORATIVE } }).html).toBe(first.html);
    const refused = staticSiteToPrototype({ ...input, choices: { [alt.id]: "<b>no</b>" } });
    expect(refused.html).toBe(first.html);
    expect(refused.choicesRejected.map((item) => item.id)).toEqual([alt.id]);
  });
});

describe("risposte di un modello, smistate", () => {
  const choices: ImportChoice[] = [
    { id: "classe:hero__div", kind: "classe", value: "hero__div", context: "<div> dentro <section.hero>" },
    { id: "componente:card-a", kind: "componente", value: "card-a", context: "3 usi" },
    { id: "alt:foto", kind: "alt", value: "", context: "file: foto.jpg" },
  ];

  it("le buone vanno applicate, gli alt diventano suggerimenti, le altre sono scartate col motivo", () => {
    const sorted = sortChoiceAnswers(choices, [
      { id: "classe:hero__div", valore: "hero__riquadro" },
      { id: "componente:card-a", valore: "card-a" },
      { id: "alt:foto", valore: "Una foto del forno" },
      { id: "classe:hero__div", valore: "altro" },
      { id: "classe:inventata", valore: "x" },
      { valore: "senza id" },
      "testo",
    ]);
    expect(sorted.apply).toEqual({ "classe:hero__div": "hero__riquadro" });
    expect(sorted.suggestions).toEqual({ "alt:foto": "Una foto del forno" });
    expect(sorted.rejected).toEqual([
      { id: "classe:hero__div", motivo: "id ripetuto" },
      { id: "classe:inventata", motivo: "id sconosciuto" },
      { id: "?", motivo: "risposta senza id" },
      { id: "?", motivo: "risposta senza id" },
    ]);
  });

  it("una risposta che non è un elenco non applica nulla", () => {
    expect(sortChoiceAnswers(choices, { scelte: "no" })).toEqual({ apply: {}, suggestions: {}, rejected: [] });
    expect(sortChoiceAnswers(choices, [{ id: "alt:foto", valore: ALT_DECORATIVE }]).suggestions).toEqual({});
  });

  it("il registro rifiuta gli scambi di nome e i nomi presi", () => {
    const book = new ImportChoiceBook({ "classe:a": "b", "classe:b": "a", "classe:c": "preso" });
    const names = book.pickNames(
      "classe",
      ["a", "b", "c"].map((name) => ({ key: name, value: name, context: "" })),
      new Set(["preso"]),
    );
    expect([...names.values()]).toEqual(["a", "b", "c"]);
    expect(book.rejected.map((item) => item.id)).toEqual(["classe:a", "classe:b", "classe:c"]);
  });
});
