import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestHashInput } from "../packages/histos-contract/dist/src/index.js";
import { createStaticPageProfile } from "../packages/cms/dist/page-transfer.js";
import { CmsProjectCatalog } from "../packages/cms/dist/project-repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(root, "packages/histos-contract/test/fixtures/histos-static-project-v3.json");
const output = path.resolve(process.argv[2] ?? defaultOutput);
const projectRoot = await mkdtemp(path.join(os.tmpdir(), "histos-project-v3-fixture-"));
const catalog = new CmsProjectCatalog(projectRoot);
const uuid = {
  project: "550e8400-e29b-41d4-a716-446655440100",
  page: "550e8400-e29b-41d4-a716-446655440101",
  styles: "550e8400-e29b-41d4-a716-446655440102",
  authorType: "550e8400-e29b-41d4-a716-446655440103",
  eventType: "550e8400-e29b-41d4-a716-446655440104",
  taxonomy: "550e8400-e29b-41d4-a716-446655440105",
  term: "550e8400-e29b-41d4-a716-446655440106",
  eventSingleTemplate: "550e8400-e29b-41d4-a716-446655440112",
  eventArchiveTemplate: "550e8400-e29b-41d4-a716-446655440113",
  speakerTaxonomy: "550e8400-e29b-41d4-a716-446655440110",
  speakerTerm: "550e8400-e29b-41d4-a716-446655440111",
  author: "550e8400-e29b-41d4-a716-446655440107",
  event: "550e8400-e29b-41d4-a716-446655440108",
};

try {
  const { project, store } = await catalog.createProject("Fixture CMS relazionale", {
    id: uuid.project,
    page: { id: uuid.page, title: "Home", slug: "home", content: "<!-- wp:xb/text {\"uid\":\"fixturehome01\",\"content\":\"Eventi\"} /-->", status: "published" },
    styles: { id: uuid.styles, content: JSON.stringify({ styles: [], globals: [], compiledCss: "", design: {}, tokenOverrides: {}, queries: {} }) },
  });
  store.setRenderSettings({ locale: "it-IT", timeZone: "Europe/Rome" });
  store.createTemplate({ id: uuid.eventSingleTemplate, title: "Scheda evento", ref: "content/event-single" });
  store.createTemplate({ id: uuid.eventArchiveTemplate, title: "Archivio eventi", ref: "content/event-archive" });
  const authorType = store.content.saveType({
    id: uuid.authorType, key: "speaker", label: "Relatori", expectedHead: null,
    fields: [
      { key: "biography", label: "Biografia", type: "rich-text", required: false, public: true, multiple: false },
      { key: "editor_note", label: "Nota redazione", type: "text", required: false, public: false, multiple: false },
    ],
  });
  const eventType = store.content.saveType({
    id: uuid.eventType, key: "events", label: "Eventi", expectedHead: null,
    singleTemplateRef: "content/event-single", archiveTemplateRef: "content/event-archive",
    fields: [
      { key: "starts_at", label: "Inizio", type: "datetime", required: true, public: true, multiple: false },
      { key: "speaker", label: "Relatore", type: "relation", targetType: "speaker", required: true, public: true, multiple: false },
      { key: "private_note", label: "Nota interna", type: "text", required: false, public: false, multiple: false },
    ],
  });
  assert.equal(authorType.status, "saved");
  assert.equal(eventType.status, "saved");

  const taxonomy = store.content.saveTaxonomy({ id: uuid.taxonomy, key: "event-category", label: "Categorie evento", types: ["events"], expectedHead: null });
  assert.equal(taxonomy.status, "saved");
  const term = store.content.saveTerm({ id: uuid.term, taxonomyKey: "event-category", slug: "formazione", label: "Formazione", expectedHead: null });
  assert.equal(term.status, "saved");
  const speakerTaxonomy = store.content.saveTaxonomy({ id: uuid.speakerTaxonomy, key: "speaker-topic", label: "Ambiti relatori", types: ["speaker"], expectedHead: null });
  assert.equal(speakerTaxonomy.status, "saved");
  const speakerTerm = store.content.saveTerm({ id: uuid.speakerTerm, taxonomyKey: "speaker-topic", slug: "ricerca", label: "Ricerca", expectedHead: null });
  assert.equal(speakerTerm.status, "saved");
  const author = store.content.saveRecord({
    id: uuid.author, typeKey: "speaker", slug: "ada-relatrice", locale: "en-US", title: "Ada Relatrice", status: "published",
    publishedAt: "2026-10-22T10:00:00.000Z", values: { biography: "Ricercatrice", editor_note: "Solo redazione" },
    terms: { "speaker-topic": [speakerTerm.term.alias] }, expectedHead: null,
  });
  assert.equal(author.status, "saved");
  const event = store.content.saveRecord({
    id: uuid.event, typeKey: "events", slug: "incontro-portabile", locale: "it-IT", title: "Incontro portabile", status: "published",
    publishedAt: "2026-10-22T11:00:00.000Z", values: { starts_at: "2026-11-15T09:30:00+01:00", speaker: uuid.author, private_note: "Non esportare nel frontend" },
    terms: { "event-category": [term.term.alias] }, expectedHead: null,
  });
  assert.equal(event.status, "saved");
  const query = store.content.saveQueryPreset({
    key: "upcoming_events", label: "Prossimi eventi", typeKey: "events", limit: 12, offset: 6, offsetParam: "start", orderBy: "publishedAt", order: "desc",
    filter: { taxonomyKey: "event-category", termIds: [uuid.term], operator: "IN" }, expectedHead: null,
  });
  assert.equal(query.status, "saved");
  store.content.saveQuerySources({ featured: { type: "json", data: [{ label: "In evidenza", href: "/eventi/" }] } });

  const { profile, files } = await createStaticPageProfile(project, store, "0.1.14");
  profile.manifest.selection.snapshot = "550e8400-e29b-41d4-a716-446655440109";
  profile.manifest.manifestHash = createHash("sha256").update(manifestHashInput(profile.manifest), "utf8").digest("hex");
  assert.equal(profile.manifest.profile, "histos-static-project-v3");
  const fixture = {
    profile,
    files: Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([filePath, bytes]) => [filePath, bytes.toString("base64")]))
  };
  const json = JSON.stringify(fixture, null, 2) + "\n";
  await mkdir(path.dirname(output), { recursive: true });
  // This fixture is read by the WordPress PHPUnit container (uid 33) through a bind mount.
  // It contains synthetic test data, so keep it readable across local and container users.
  await writeFile(output, json, { mode: 0o644 });
  process.stdout.write(`Fixture Histeon v3 scritta: ${output}\n`);
  store.close();
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}
