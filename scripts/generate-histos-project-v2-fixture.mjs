import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestHashInput } from "../packages/histos-contract/dist/src/index.js";
import { createStaticPageProfile } from "../packages/cms/dist/page-transfer.js";
import { CmsProjectCatalog } from "../packages/cms/dist/project-repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(root, "packages/histos-contract/test/fixtures/histos-static-project-v2.json");
const output = path.resolve(process.argv[2] ?? defaultOutput);
const projectRoot = await mkdtemp(path.join(os.tmpdir(), "histos-project-v2-fixture-"));
const catalog = new CmsProjectCatalog(projectRoot);
const ids = {
  project: "550e8400-e29b-41d4-a716-446655440120",
  page: "550e8400-e29b-41d4-a716-446655440121",
  styles: "550e8400-e29b-41d4-a716-446655440122",
  part: "550e8400-e29b-41d4-a716-446655440123",
  template: "550e8400-e29b-41d4-a716-446655440124",
  snapshot: "550e8400-e29b-41d4-a716-446655440125",
};

try {
  const { project, store } = await catalog.createProject("Fixture CMS template", {
    id: ids.project,
    page: {
      id: ids.page,
      title: "Pagina modello",
      slug: "pagina-modello",
      content: '<!-- wp:xb/element {"uid":"fixturepage01","tag":"main"} --><!-- wp:xb/text {"uid":"fixturepage02","content":"Test template"} /--><!-- /wp:xb/element -->',
      status: "published",
    },
    styles: {
      id: ids.styles,
      content: JSON.stringify({ styles: [], globals: [], compiledCss: "", design: {}, tokenOverrides: {}, queries: {} }),
    },
  });
  const part = store.createTemplatePart({
    id: ids.part,
    ref: "site/header",
    title: "Intestazione",
    area: "header",
    content: '<!-- wp:xb/element {"uid":"fixturehead01","tag":"header"} --><!-- wp:xb/text {"uid":"fixturehead02","content":"Sito"} /--><!-- /wp:xb/element -->',
  });
  const template = store.createTemplate({
    id: ids.template,
    ref: "site/page",
    title: "Pagina",
    content: '<!-- wp:xb/component {"uid":"fixturepart01","ref":"site/header"} /--><!-- wp:xb/slot {"uid":"fixtureslot01","name":"default"} /-->',
  });
  assert.equal(part.id, ids.part);
  assert.equal(template.id, ids.template);
  store.updatePageMetadata(ids.page, { title: "Pagina modello", slug: "pagina-modello", status: "published", templateRef: "site/page" });

  const { profile, files } = await createStaticPageProfile(project, store, "0.1.14");
  profile.manifest.selection.snapshot = ids.snapshot;
  profile.manifest.manifestHash = createHash("sha256").update(manifestHashInput(profile.manifest), "utf8").digest("hex");
  assert.equal(profile.manifest.profile, "histos-static-project-v2");
  const fixture = {
    profile,
    files: Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([filePath, bytes]) => [filePath, bytes.toString("base64")])),
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`Fixture Histeon v2 scritta: ${output}\n`);
  store.close();
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}
