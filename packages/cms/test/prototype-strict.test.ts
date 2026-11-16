import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseDsl } from "../.generated/histos-dsl/index.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { prototypeKit } from "../src/prototype-kits.js";
import {
  type PrototypeStrictResult,
  type StrictProblem,
  strictResult,
  strictWarningCounts,
} from "../src/prototype-strict.js";

// Every parse of the template language is counted: the strict check must read the blocks the import already has.
vi.mock("../.generated/histos-dsl/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../.generated/histos-dsl/index.js")>();
  return { ...original, parse: vi.fn(original.parse) };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const KIT = prototypeKit("minimo", { id: "5f0c2a4e-7b1d-4c3e-9a2f-1d2e3f4a5b6c" }).html;
const KIT_SELECTORS_END = ".piede { padding: var(--xb-space-m); }</style>";

/** The minimal kit with a page more (`page`, on a line of its own), CSS added to the selector styles and other changes. */
function variant(input: { page?: string; css?: string; change?: (html: string) => string }): string {
  let html = KIT;
  expect(html).toContain(KIT_SELECTORS_END);
  if (input.css)
    html = html.replace(KIT_SELECTORS_END, `.piede { padding: var(--xb-space-m); }\n${input.css}\n</style>`);
  if (input.page)
    html = html.replace(
      "</body>",
      `<template data-histos="page" data-slug="prova" data-title="Prova" data-template="site/page">${input.page}</template>\n</body>`,
    );
  return input.change ? input.change(html) : html;
}

async function built(html: string, strict = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-strict-"));
  roots.push(root);
  return buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(root), {
    remotePlaceholders: true,
    ...(strict ? { strict: true } : {}),
  });
}

async function check(html: string): Promise<PrototypeStrictResult> {
  const result = await built(html);
  return strictResult(result.strict ?? [], result.report.warnings);
}

const of = (result: PrototypeStrictResult, rule: StrictProblem["rule"]) =>
  result.problems.filter((problem) => problem.rule === rule);
const errors = (result: PrototypeStrictResult) => result.problems.filter((problem) => problem.level === "errore");
/** The file's line of the first line holding `text`. */
const lineOf = (html: string, text: string) => html.split("\n").findIndex((line) => line.includes(text)) + 1;

/** The defects of F1's «Il problema»: what `prototype check` passes as valid today. */
const BAD_CSS = [
  ".blueText { color: #123456; font-size: 18px; }",
  ".card1 { padding: 17px; margin-top: 23px; border-radius: 7px; &__testo { color: var(--xb-text); } }",
  ".mt-4 { margin-top: 1rem; }",
  ".flex { display: flex; }",
  ".Card_Title-big { font-size: 31px; }",
].join("\n");
const card =
  '<div class="card1"><h3 class="Card_Title-big">Scheda</h3><p class="card1__testo">Siamo leader del settore dal 1987 con oltre 500 clienti soddisfatti.</p></div>';
const BAD_PAGE = `<h1>Prova</h1><div class="flex mt-4"><p class="blueText" style="color:red">Lorem ipsum dolor sit amet</p></div>${card}${card}${card}<p>Testo segnaposto</p><ul>{#loop scrittori_a() as s}<li>{s.title}</li>{/loop}</ul>`;
const BAD = variant({ page: BAD_PAGE, css: BAD_CSS });
/** A loop over a field the type does not have (it has `anni`), without {:else}. */
const BROKEN = variant({
  change: (html) =>
    html.replace(
      "{#loop page.fields.anni as a}<li>Edizione {a}</li>{:else}<li>Nessuna</li>{/loop}",
      "{#loop page.fields.anno as a}<li>{a.nome}</li>{/loop}",
    ),
});

describe("controllo severo del prototipo (F1)", () => {
  it("i due kit passano senza errori", async () => {
    const minimo = await check(KIT);
    expect(errors(minimo)).toEqual([]);
    expect(minimo.passed).toBe(true);
    const sito = await check(prototypeKit("sito", { id: "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }).html);
    expect(sito.problems).toEqual([]);
    expect(sito.passed).toBe(true);
  });

  it("il prototipo «cattivo» dà almeno 8 errori di almeno 6 regole, con documento, riga e rimedio", async () => {
    const result = await check(BAD);
    expect(result.passed).toBe(false);
    const found = errors(result);
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(new Set(found.map((problem) => problem.rule)).size).toBeGreaterThanOrEqual(6);
    for (const rule of [
      "classe-non-bem",
      "utility",
      "stile-in-linea",
      "testo-segnaposto",
      "schede-a-mano",
      "loop-senza-else",
      "avviso-del-controllo",
    ] as const)
      expect(of(result, rule).length, rule).toBeGreaterThan(0);
    for (const problem of result.problems) {
      expect(problem.message).not.toBe("");
      expect(problem.fix).toMatch(/\.$/u);
    }
    // The fixed values are listed, as warnings.
    expect(of(result, "valore-fisso").map((problem) => problem.level)).toContain("avviso");
    expect(
      of(result, "valore-fisso")
        .map((problem) => problem.message)
        .join("\n"),
    ).toMatch(/17px[\s\S]*#123456|#123456[\s\S]*17px/u);
  });

  it("il prototipo «rotto» dà loop senza {:else} e campo che non esiste", async () => {
    const result = await check(BROKEN);
    expect(result.passed).toBe(false);
    expect(errors(result).length).toBeGreaterThanOrEqual(2);
    expect(of(result, "loop-senza-else")).toHaveLength(1);
    const [field] = of(result, "campo-che-non-esiste");
    expect(field).toMatchObject({
      level: "errore",
      document: "template site/scrittore",
      line: lineOf(BROKEN, 'data-ref="site/scrittore"'),
    });
    expect(field!.message).toContain("il tipo scrittore non ha il campo anno (ha anni)");
  });

  it("senza il modo severo il risultato non cambia e il modo severo non analizza i documenti una seconda volta", async () => {
    const parse = vi.mocked(parseDsl);
    parse.mockClear();
    const strict = await built(BAD);
    const parses = parse.mock.calls.length;
    parse.mockClear();
    const plain = await built(BAD, false);
    expect(parse.mock.calls.length).toBe(parses);
    expect(plain.strict).toBeUndefined();
    expect(Object.keys(plain)).not.toContain("strict");
    expect(plain.report).toEqual(strict.report);
    expect(plain.report.warnings).toEqual(strict.report.warnings);
  });

  describe("una regola alla volta: un caso che passa e uno che fallisce", () => {
    it("classe-non-bem: nel markup e nel CSS, con riga; le classi scritte con un'espressione no", async () => {
      const bad = variant({
        page: '<h1>Prova</h1><p class="blueText">Testo</p>',
        css: ".blueText { color: var(--xb-primary); }\n.Foo .riquadro { color: var(--xb-text); }\n.riquadro { color: var(--xb-text); }",
      });
      const result = await check(bad);
      const problems = of(result, "classe-non-bem");
      expect(problems.map((problem) => problem.message)).toEqual([
        expect.stringContaining("la classe blueText non è BEM"),
        expect.stringContaining("la classe Foo"),
      ]);
      expect(problems[0]).toMatchObject({
        level: "errore",
        document: "page prova",
        line: lineOf(bad, 'data-slug="prova"'),
      });
      expect(problems[0]!.fix).toContain("blue-text, e cambia la sua regola.");
      // Without a rule of its own there is no rule to change.
      const bare = await check(variant({ page: '<h1>Prova</h1><p class="rossoTesto">Testo</p>' }));
      expect(of(bare, "classe-non-bem")[0]!.fix).toMatch(/per esempio rosso-testo\.$/u);
      expect(problems[1]).toMatchObject({ document: "stili per selettore", line: lineOf(bad, ".Foo .riquadro") });
      const good = await check(
        variant({
          page: '<h1>Prova</h1><p class="testo-blu testo-blu--forte {page.slug} riquadro--{page.slug}">Testo</p>',
          css: ".testo-blu { color: var(--xb-primary); &--forte { font-weight: 700; } }",
        }),
      );
      expect(of(good, "classe-non-bem")).toEqual([]);
    });

    it("utility: flex e mt-4 sì, un blocco BEM di una dichiarazione no; una catena di classi xb-* sì, una sola no", async () => {
      const bad = await check(
        variant({
          page: '<h1>Prova</h1><div class="flex mt-4">Uno</div><p class="fs-2">Due</p><p class="xb-p-m xb-bg-surface xb-rounded-m">Tre</p>',
          css: ".flex { display: flex; }\n.mt-4 { margin-top: 1rem; }\n.fs-2 { font-size: var(--xb-text-l); }",
        }),
      );
      expect(of(bad, "utility").map((problem) => problem.message)).toEqual([
        expect.stringContaining("una catena di classi utility"),
        expect.stringContaining("flex è una classe utility (.flex { display: flex })"),
        expect.stringContaining("mt-4 è una classe utility"),
        expect.stringContaining("fs-2 è una classe utility (.fs-2 { font-size: var(--xb-text-l) })"),
      ]);
      expect(bad.passed).toBe(false);
      // A utility is said once: not again as a class without a rule.
      expect(
        of(bad, "classe-senza-regola")
          .map((problem) => problem.message)
          .join("\n"),
      ).not.toMatch(/\b(?:flex|mt-4|fs-2)\b/u);
      const good = await check(
        variant({
          page: '<h1>Prova</h1><div class="riquadro">Uno</div><p class="riquadro__testo xb-text-l">Due</p>',
          css: ".riquadro { display: flex; &__testo { color: var(--xb-text); } }",
        }),
      );
      expect(of(good, "utility")).toEqual([]);
      expect(good.passed).toBe(true);
      // A framework's name that is the project's own block: with its parts, or a rule of more than one declaration.
      const blocks = await check(
        variant({
          page: '<h1>Prova</h1><div class="grid"><p class="grid__item">Uno</p></div><p class="hidden">Due</p>',
          css: ".grid { display: grid; &__item { color: var(--xb-text); } }\n.hidden { position: absolute; clip-path: inset(50%); }",
        }),
      );
      expect(of(blocks, "utility")).toEqual([]);
    });

    it("stile-in-linea: style sì, una sola variabile no", async () => {
      const bad = await check(
        variant({ page: '<h1>Prova</h1><p style="color:red">Uno</p><p style="padding: 4px">Due</p>' }),
      );
      expect(of(bad, "stile-in-linea")).toEqual([
        expect.objectContaining({ level: "errore", message: expect.stringContaining("2 attributi style") }),
      ]);
      const good = await check(
        variant({ page: '<h1>Prova</h1><p class="foto-card" style="--progresso: 40%">Uno</p>' }),
      );
      expect(of(good, "stile-in-linea")).toEqual([]);
    });

    it("testo-segnaposto è un errore, «[testo da scrivere]» un avviso", async () => {
      const bad = await check(
        variant({
          page: '<h1>Prova</h1><p>Lorem ipsum dolor sit amet.</p><img src="asset:f1" width="16" height="12" alt="Testo segnaposto"/>',
        }),
      );
      expect(of(bad, "testo-segnaposto")).toEqual([
        expect.objectContaining({ level: "errore", message: expect.stringContaining("2 testi di riempimento") }),
      ]);
      const honest = await check(
        variant({ page: "<h1>Prova</h1><p>[testo da scrivere]</p><p>Le edizioni dal 2009.</p>" }),
      );
      expect(of(honest, "testo-segnaposto")).toEqual([]);
      expect(of(honest, "testo-da-scrivere")).toEqual([expect.objectContaining({ level: "avviso" })]);
      expect(honest.passed).toBe(true);
    });

    it("schede-a-mano: tre schede copiate sì, le voci di un menu e due schede no", async () => {
      const scheda =
        '<div class="scheda"><h2 class="scheda__titolo">Titolo</h2><p class="scheda__testo">Testo</p></div>';
      const css =
        ".scheda { display: grid; &__titolo { margin: 0; } &__testo { margin: 0; } }\n.voce { display: block; &__link { color: var(--xb-link); } }";
      const bad = await check(variant({ page: `<h1>Prova</h1>${scheda}${scheda}${scheda}`, css }));
      expect(of(bad, "schede-a-mano")).toEqual([
        expect.objectContaining({ level: "errore", message: expect.stringContaining("3 div.scheda fratelli") }),
      ]);
      const voce = '<li class="voce"><a class="voce__link" href="/">Voce</a></li>';
      const good = await check(
        variant({ page: `<h1>Prova</h1><ul>${voce}${voce}${voce}${voce}</ul>${scheda}${scheda}`, css }),
      );
      expect(of(good, "schede-a-mano")).toEqual([]);
    });

    it("loop-senza-else: una query senza {:else} sì; con {:else}, contata prima o sui termini di un articolo no", async () => {
      const bad = await check(
        variant({ page: "<h1>Prova</h1><ul>{#loop scrittori_a() as s}<li>{s.title}</li>{/loop}</ul>" }),
      );
      expect(of(bad, "loop-senza-else")).toEqual([
        expect.objectContaining({
          level: "errore",
          message: expect.stringContaining("{#loop scrittori_a() as s} non ha {:else}"),
        }),
      ]);
      // The kit's own: {:else} on every query, the terms of a post and the links of a pagination without one.
      expect(of(await check(KIT), "loop-senza-else")).toEqual([]);
      const counted = await check(
        variant({
          change: (html) =>
            html.replace(
              "{#loop main() as x}<FotoCard immagine={x.fields.immagine} titolo={x.title} url={x.url} />{:else}<p>Vuoto</p>{/loop}",
              "{#if page.totalRecords}{#loop main() as x}<FotoCard immagine={x.fields.immagine} titolo={x.title} url={x.url} />{/loop}{:else}<p>Vuoto</p>{/if}",
            ),
        }),
      );
      expect(of(counted, "loop-senza-else")).toEqual([]);
    });

    it("campo-che-non-esiste: sul record di un tipo certo e sulla variabile di una query; dove il tipo non è certo no", async () => {
      const bad = await check(
        variant({
          page: "<h1>Prova</h1><ul>{#loop scrittori_a() as s}<li>{s.fields.eta}</li>{:else}<li>Nessuno</li>{/loop}</ul>",
        }),
      );
      expect(of(bad, "campo-che-non-esiste")).toEqual([
        expect.objectContaining({
          level: "errore",
          document: "page prova",
          message: expect.stringContaining("{s.fields.eta}: il tipo scrittore non ha il campo eta"),
        }),
      ]);
      // site/page has a role and pages render with it: `page` is no record there. And main() of an archive two types share.
      const uncertain = await check(
        variant({
          change: (html) =>
            html
              .replace(
                '<main class="pagina">{@slot}</main>',
                '<main class="pagina"><p>{page.fields.inventato}</p>{@slot}</main>',
              )
              .replace(
                "titolo={x.title} url={x.url} />{:else}<p>Vuoto</p>",
                "titolo={x.fields.inventato} url={x.url} />{:else}<p>Vuoto</p>",
              ),
        }),
      );
      expect(of(uncertain, "campo-che-non-esiste")).toEqual([]);
    });

    it("avviso-del-controllo: un avviso da correggere sì, un'informazione o una nota no", async () => {
      const bad = await check(variant({ page: "<h1>Prova</h1><h3>Salto</h3>" }));
      expect(of(bad, "avviso-del-controllo")).toEqual([
        expect.objectContaining({
          level: "errore",
          message: expect.stringContaining("i titoli saltano un livello in prova (da h1 a h3)"),
        }),
      ]);
      expect(strictWarningCounts("Accessibilità: 2 immagini senza alt (in home).")).toBe(true);
      for (const information of [
        "Nota: ACSS → Histeon CSS: un nome convertito (--space-m → --xb-space-m).",
        "Il media f1 non è usato: è comunque nella libreria.",
        "Controllo rapido: 2 media remoti non scaricati (a, b).",
        "un documento ha JavaScript: gira nel sito pubblicato e nell'anteprima isolata, mai nel builder; su WordPress lo salva solo chi ha il permesso unfiltered_html.",
        "page contatti: il modulo invia i dati (POST) a example.org.",
      ])
        expect(strictWarningCounts(information), information).toBe(false);
      expect(strictResult([], ["Il media f1 non è usato: è comunque nella libreria."])).toEqual({
        passed: true,
        problems: [],
      });
      expect(strictResult([], ["Link interno rotto: /x/ non porta a nessuna pagina del sito (da /)."])).toMatchObject({
        passed: false,
        problems: [{ rule: "avviso-del-controllo", level: "errore" }],
      });
    });

    it("valore-fisso: px, rem e colori a mano sì, come avviso; token, 0, 1px dei bordi, percentuali, min() e :root no", async () => {
      const bad = await check(
        variant({
          page: '<h1>Prova</h1><div class="riquadro">Uno</div>',
          css: ".riquadro { padding: 17px; color: #123456; box-shadow: 0 2px 8px rgb(0 0 0 / 20%); }",
        }),
      );
      expect(of(bad, "valore-fisso").map((problem) => problem.message)).toEqual([
        ".riquadro: padding: 17px scrive a mano 17px.",
        ".riquadro: color: #123456 scrive a mano #123456.",
        ".riquadro: box-shadow: 0 2px 8px rgb(0 0 0 / 20%) scrive a mano 2px, 8px, rgb(…).",
      ]);
      expect(bad.passed).toBe(true);
      const good = await check(
        variant({
          page: '<h1>Prova</h1><div class="riquadro">Uno</div>',
          css: ".riquadro { padding: var(--xb-space-m, 1rem); margin: 0; border-top: 1px solid currentColor; width: 100%; max-width: 72rem; grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr)); --spazio: 12px; &:focus-visible { outline: 2px solid var(--xb-primary); } @media (width < 48rem) { padding: var(--xb-space-s); } }\n:root { --colore: #123456; }",
        }),
      );
      expect(of(good, "valore-fisso")).toEqual([]);
    });

    it("classe-senza-regola: un blocco che nessuna regola stila sì, come avviso; una parte di un blocco stilato no", async () => {
      const result = await check(
        variant({
          page: '<h1>Prova</h1><div class="riquadro"><p class="riquadro__corpo">Uno</p></div><div class="nessuno">Due</div>',
          css: ".riquadro { display: grid; }",
        }),
      );
      const names = of(result, "classe-senza-regola").map((problem) => problem.message);
      expect(names).toContain("la classe nessuno non ha nessuna regola nel CSS del progetto.");
      expect(names.join("\n")).not.toContain("riquadro__corpo");
      expect(of(result, "classe-senza-regola").every((problem) => problem.level === "avviso")).toBe(true);
    });
  });
});
