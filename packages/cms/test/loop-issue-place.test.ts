import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype, PrototypeError } from "../src/prototype-import.js";

/**
 * Review 7, group B1: a loop-source issue (an undeclared query, every main() refusal) is said at its own loop's
 * `{#loop`, also when that loop follows a text run in the same element. Before, the check placed it at the first
 * `{#loop` past the element's start, which is another, valid loop: an agent following the place edited the wrong one.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const LOOP = "{#loop opere_recenti() as opera}<CardOpera titolo={opera.title} immagine={opera.fields.immagine} url={opera.url} />{/loop}";
const VALID = "{#loop opere_recenti() as v}<p>{v.title}</p>{/loop}";

async function issues(replacement: string) {
  const html = (await readFile(new URL("fixtures/prototipo-esempio.html", import.meta.url), "utf8")).replace(LOOP, replacement);
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-loop-place-"));
  roots.push(root);
  const error = await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(root)).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(PrototypeError);
  return { html, issues: (error as PrototypeError).issues };
}

/** The line and column, 1-based, of the `nth` (0-based) occurrence of `marker` in the file. */
function place(html: string, marker: string, nth = 0): { line: number; column: number } {
  let at = -1;
  for (let count = 0; count <= nth; count++) at = html.indexOf(marker, at + 1);
  const before = html.slice(0, at);
  return { line: before.split("\n").length, column: at - before.lastIndexOf("\n") };
}

describe("un problema della sorgente di un loop si dice alla {#loop di quel loop (B1)", () => {
  it("due loop sulla stessa riga, con un testo fra loro: il problema è alla colonna del secondo", async () => {
    const { html, issues: found } = await issues(`${VALID} testo {#loop nonc() as a}<p>{a.title}</p>{/loop}`);
    // Before: the column of «{#loop opere_recenti() as v}», the valid loop.
    expect(found).toEqual([{ document: "template site/opere", ...place(html, "{#loop nonc()"), message: expect.stringMatching(/^\{#loop\}: la query nonc non è fra quelle dei contenuti/u) }]);
  });

  it("su righe diverse, con testo e loop validi prima e dopo: ogni problema alla sua riga e colonna", async () => {
    const { html, issues: found } = await issues(`\n  ${VALID}\n  testo\n  {#loop nonc() as a}<p>{a.title}</p>{/loop}\n  altro testo {#loop main(limit: 5) as b}<p>{b.title}</p>{/loop}\n  ${VALID}`);
    // Before: both at the line and column of the first valid loop.
    expect(found).toEqual([
      { document: "template site/opere", ...place(html, "{#loop nonc()"), message: expect.stringContaining("la query nonc non è fra quelle dei contenuti") },
      { document: "template site/opere", ...place(html, "{#loop main(limit: 5)"), message: expect.stringMatching(/^\{#loop main\(\)\}: main\(\) non accetta argomenti/u) },
    ]);
    expect(place(html, "{#loop nonc()").line).toBeGreaterThan(place(html, VALID).line);
  });

  it("due loop uguali con un testo fra loro, e un loop dentro un loop: ognuno alla sua {#loop", async () => {
    const twin = "{#loop nonc() as a}<p>{a.title}</p>{/loop}";
    const { html, issues: found } = await issues(`${twin} testo ${twin}<section>{#loop opere_recenti() as o}<p>{o.title}</p>{#loop nonc() as d}<i>{d.title}</i>{/loop}{/loop}</section>`);
    expect(found.map(({ line, column }) => ({ line, column }))).toEqual([place(html, twin, 0), place(html, twin, 1), place(html, "{#loop nonc() as d}")]);
  });

  it("una {#loop scritta come testo (in un commento, dopo \\{, in una stringa) non sposta il posto", async () => {
    const { html, issues: found } = await issues(`<!-- {#loop nonc() as a}{/loop} --> \\{#loop nonc() as a\\} {"{#loop nonc() as a}"} {#loop nonc() as a}<p>{a.title}</p>{/loop}`);
    expect(found).toEqual([{ document: "template site/opere", ...place(html, "{#loop nonc() as a}<p>"), message: expect.stringContaining("la query nonc") }]);
  });

  it("main() con argomenti: un loop, un problema, quello di main()", async () => {
    for (const head of ["{#loop main(colore: 1) as a}", "{#loop main(limit: 500, colore: ignoto.x) as a}"]) {
      const { html, issues: found } = await issues(`${head}<p>{a.title}</p>{/loop}`);
      // Before: «colore non è un argomento delle query» (and the limit, and «ignoto non è un dato») next to it.
      expect(found, head).toEqual([{ document: "template site/opere", ...place(html, head), message: expect.stringMatching(/^\{#loop main\(\)\}: main\(\) non accetta argomenti/u) }]);
    }
  });

  it("l'argomento sbagliato di una query si dice nel suo loop, non nel primo con lo stesso nome", async () => {
    const { html, issues: found } = await issues(`{#loop opere_recenti(limit: 3) as v}<p>{v.title}</p>{/loop} testo {#loop opere_recenti(limit: 500) as w}<p>{w.title}</p>{/loop}`);
    // Before: «limit» was searched from the element's start, and the first loop's «limit: 3» was named.
    expect(found).toEqual([{ document: "template site/opere", ...place(html, "500"), message: expect.stringContaining("limit è un numero intero da 1 a 100") }]);
  });
});
