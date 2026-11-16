import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse as parseDsl } from "../.generated/histos-dsl/index.js";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype } from "../src/prototype-import.js";
import { prototypeQualityWarnings } from "../src/prototype-quality.js";

// Every parse of the template language is counted: the import's and any other.
vi.mock("../.generated/histos-dsl/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../.generated/histos-dsl/index.js")>();
  return { ...original, parse: vi.fn(original.parse) };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("D4 legge ogni documento dai blocchi che l'import ha già, senza analizzarlo una seconda volta (review 5, Q4)", async () => {
  // Round 4 parsed every page, post, component and template again for the accessibility and SEO warnings, in one
  // synchronous call at the end: on a 30 MB prototype the server could not answer for seconds.
  const html = await readFile(new URL("fixtures/prototipo-esempio.html", import.meta.url), "utf8");
  const parsed = parsePrototype(html);
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-quality-parse-"));
  roots.push(root);
  const parse = vi.mocked(parseDsl);
  parse.mockClear();
  const built = await buildPrototypeProfile(parsed, new CmsProjectCatalog(root));
  // A template made by the store starts from its own document, parsed once each: that is not one of the prototype's.
  const sources = parse.mock.calls.map(([source]) => source).filter((source) => source !== "<main>{@slot}</main>");
  expect(sources).toHaveLength(parsed.documents.length);
  expect(new Set(sources).size).toBe(parsed.documents.length);
  // And the warnings are those of the documents parsed on their own.
  const alone = prototypeQualityWarnings({ locale: "it-IT", documents: parsed.documents, content: parsed.content });
  expect(alone.length).toBeGreaterThan(1);
  expect(built.report.warnings.filter((warning) => /^(Accessibilità|SEO)/u.test(warning))).toEqual(alone);
});
