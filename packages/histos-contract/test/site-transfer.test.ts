import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalizeJson } from "../src/canonical-json.js";
import { cssResourceReferences } from "../src/css-resources.js";
import { canonicalRevisionPayload, manifestHashInput, validateStaticPageProfile, validateTransferEntity, type JsonValue, type StaticPageProfile, type TransferEntity } from "../src/site-transfer.js";

const sharedFixture = JSON.parse(readFileSync(new URL("./fixtures/histos-static-page-v1.json", import.meta.url), "utf8")) as {
  profile: StaticPageProfile;
  files: Record<string, string>;
};
const sharedProjectFixture = JSON.parse(readFileSync(new URL("./fixtures/histos-static-project-v1.json", import.meta.url), "utf8")) as {
  profile: StaticPageProfile;
  files: Record<string, string>;
};
const sharedPostsFixture = JSON.parse(readFileSync(new URL("./fixtures/histos-static-project-v4.json", import.meta.url), "utf8")) as {
  profile: StaticPageProfile;
  files: Record<string, string>;
};
const sharedMarkupFixture = JSON.parse(readFileSync(new URL("./fixtures/histos-static-markup-v1.json", import.meta.url), "utf8")) as {
  profile: StaticPageProfile;
  files: Record<string, string>;
};
const sharedRelationalProjectFixture = JSON.parse(readFileSync(new URL("./fixtures/histos-static-project-v3.json", import.meta.url), "utf8")) as {
  profile: StaticPageProfile;
  files: Record<string, string>;
};

const projectId = "550e8400-e29b-41d4-a716-446655440000";
const pageId = "550e8400-e29b-41d4-a716-446655440001";
const stylesId = "550e8400-e29b-41d4-a716-446655440002";
const sha = "a".repeat(64);

function pageProfile(): StaticPageProfile {
  const profile: StaticPageProfile = {
    manifest: {
      format: "xb-site",
      version: 2,
      generator: { name: "Histos CMS", version: "0.1.0", engineCommit: "9bc212050403dd056ac21edfcff398b514e4a3c1" },
      project: { id: projectId, name: "Fixture Unicode 😀" },
      selection: { kind: "workspace-head", snapshot: "550e8400-e29b-41d4-a716-446655440003" },
      requiredCapabilities: ["documents:page:v1", "styles:global:v1", "media:asset:v1"],
      profile: "histos-static-page-v1",
      files: [
        { path: "entities.ndjson", bytes: 1, sha256: sha, mediaType: "application/x-ndjson" },
        { path: "references.ndjson", bytes: 0, sha256: sha, mediaType: "application/x-ndjson" },
      ],
      manifestHash: sha,
    },
    entities: [
      {
        id: pageId, kind: "document", schemaVersion: 1, revisionHash: sha,
        payload: { documentType: "page", title: "Pagina", slug: "pagina", status: "draft", content: "<h1 xb:label=\"Titolo\">Ciao</h1>", script: "" },
      },
      {
        id: stylesId, kind: "styles", schemaVersion: 1, revisionHash: sha,
        payload: { styles: [], globals: [], compiledCss: "" },
      },
    ],
    references: [],
  };
  for (const entity of profile.entities) {
    entity.revisionHash = createHash("sha256")
      .update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, entity.payload), "utf8")
      .digest("hex");
  }
  return profile;
}

function relationalProfile(filter: Record<string, unknown>): StaticPageProfile {
  const profile = structuredClone(sharedProjectFixture.profile);
  const entities: TransferEntity[] = [
    {
      id: "550e8400-e29b-41d4-a716-446655440031", kind: "content-type", schemaVersion: 1, revisionHash: sha,
      payload: { key: "article", label: "Articoli", fields: [{ key: "score", label: "Punteggio", type: "integer", required: false, public: true, multiple: false }] },
    },
    {
      id: "550e8400-e29b-41d4-a716-446655440032", kind: "content-record", schemaVersion: 1, revisionHash: sha,
      payload: { typeKey: "article", slug: "esempio", locale: "it-IT", title: "Esempio", status: "draft", publishedAt: null, excerpt: "", order: 0, values: { score: 5 }, terms: {} },
    },
    {
      id: "550e8400-e29b-41d4-a716-446655440033", kind: "query-preset", schemaVersion: 1, revisionHash: sha,
      payload: { key: "articles", label: "Articoli", typeKey: "article", limit: 10, orderBy: "order", order: "asc", filter },
    },
  ];
  for (const entity of entities) {
    const contentHash = createHash("sha256").update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, entity.payload), "utf8").digest("hex");
    entity.revisionHash = contentHash;
  }
  profile.entities.push(...entities);
  profile.manifest.profile = "histos-static-project-v3";
  profile.manifest.requiredCapabilities.push("content:types:v1", "content:records:v1", "content:queries:v1");
  profile.manifest.manifestHash = createHash("sha256").update(manifestHashInput(profile.manifest), "utf8").digest("hex");
  return profile;
}

function relationalQueryProfile(): { profile: StaticPageProfile; articleId: string; authorId: string } {
  const articleId = "550e8400-e29b-41d4-a716-446655440041";
  const authorId = "550e8400-e29b-41d4-a716-446655440042";
  const profile = relationalProfile({ field: "author", op: "eq", value: authorId });
  const articleType = profile.entities.find((entity) => entity.kind === "content-type" && entity.payload.key === "article");
  const article = profile.entities.find((entity) => entity.kind === "content-record" && entity.payload.typeKey === "article");
  const query = profile.entities.find((entity) => entity.kind === "query-preset" && entity.payload.key === "articles");
  if (!articleType || articleType.kind !== "content-type" || !article || article.kind !== "content-record" || !query || query.kind !== "query-preset") throw new Error("Il profilo di prova relazionale è incompleto.");
  articleType.payload.fields.push({ key: "author", label: "Autore", type: "relation", targetType: "author", required: false, public: true, multiple: false });
  article.payload.status = "published";
  article.payload.publishedAt = "2026-10-24T10:00:00.000Z";
  article.payload.values.author = authorId;
  profile.entities.push(
    { id: "550e8400-e29b-41d4-a716-446655440043", kind: "content-type", schemaVersion: 1, revisionHash: sha, payload: { key: "author", label: "Autori", fields: [] } },
    { id: authorId, kind: "content-record", schemaVersion: 1, revisionHash: sha, payload: { typeKey: "author", slug: "ada", locale: "it-IT", title: "Ada Lovelace", status: "published", publishedAt: "2026-10-24T10:00:00.000Z", excerpt: "", order: 0, values: {}, terms: {} } },
  );
  for (const entity of profile.entities) entity.revisionHash = createHash("sha256").update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, entity.payload), "utf8").digest("hex");
  profile.manifest.manifestHash = createHash("sha256").update(manifestHashInput(profile.manifest), "utf8").digest("hex");
  return { profile, articleId: String(article.id), authorId };
}

function nestedRelationalQueryProfile(): StaticPageProfile {
  const { profile } = relationalQueryProfile();
  const authorType = profile.entities.find((entity) => entity.kind === "content-type" && entity.payload.key === "author");
  const author = profile.entities.find((entity) => entity.kind === "content-record" && entity.payload.typeKey === "author");
  const query = profile.entities.find((entity) => entity.kind === "query-preset" && entity.payload.key === "articles");
  if (authorType?.kind !== "content-type" || author?.kind !== "content-record" || query?.kind !== "query-preset") throw new Error("Il profilo relazionale di prova è incompleto.");
  const organizationId = "550e8400-e29b-41d4-a716-446655440051";
  const regionId = "550e8400-e29b-41d4-a716-446655440052";
  const regionRecordId = "550e8400-e29b-41d4-a716-446655440053";
  authorType.payload.fields.push({ key: "organization", label: "Organizzazione", type: "relation", targetType: "organization", required: false, public: true, multiple: false });
  author.payload.values.organization = "550e8400-e29b-41d4-a716-446655440054";
  query.payload.filter = { field: "author.organization.region.code", op: "eq", value: "IT" };
  profile.entities.push(
    { id: organizationId, kind: "content-type", schemaVersion: 1, revisionHash: sha, payload: { key: "organization", label: "Organizzazione", fields: [{ key: "region", label: "Regione", type: "relation", targetType: "region", required: false, public: true, multiple: false }] } },
    { id: regionId, kind: "content-type", schemaVersion: 1, revisionHash: sha, payload: { key: "region", label: "Regione", fields: [{ key: "code", label: "Codice", type: "text", required: false, public: true, multiple: false }] } },
    { id: "550e8400-e29b-41d4-a716-446655440054", kind: "content-record", schemaVersion: 1, revisionHash: sha, payload: { typeKey: "organization", slug: "studio", locale: "it-IT", title: "Studio", status: "published", publishedAt: "2026-10-24T10:00:00.000Z", excerpt: "", order: 0, values: { region: regionRecordId }, terms: {} } },
    { id: regionRecordId, kind: "content-record", schemaVersion: 1, revisionHash: sha, payload: { typeKey: "region", slug: "italia", locale: "it-IT", title: "Italia", status: "published", publishedAt: "2026-10-24T10:00:00.000Z", excerpt: "", order: 0, values: { code: "IT" }, terms: {} } },
  );
  for (const entity of profile.entities) entity.revisionHash = createHash("sha256").update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, entity.payload), "utf8").digest("hex");
  profile.manifest.manifestHash = createHash("sha256").update(manifestHashInput(profile.manifest), "utf8").digest("hex");
  return profile;
}

describe("Histeon static page transfer profile", () => {
  it("validates the shared PHP and TypeScript interoperability fixture", () => {
    expect(() => validateStaticPageProfile(sharedFixture.profile)).not.toThrow();
    const { manifest, entities, references } = sharedFixture.profile;
    const bytesFor = (path: string) => Buffer.from(sharedFixture.files[path]!, "base64");
    for (const file of manifest.files) {
      const bytes = bytesFor(file.path);
      expect(bytes.byteLength).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    const entityLines = `${entities.map(canonicalizeJson).join("\n")}\n`;
    const referenceLines = `${references.map(canonicalizeJson).join("\n")}\n`;
    expect(bytesFor("entities.ndjson").toString("utf8")).toBe(entityLines);
    expect(bytesFor("references.ndjson").toString("utf8")).toBe(referenceLines);
  });

  it("takes the colour roles and every other Histeon CSS parameter in the styles design", () => {
    const profile = pageProfile();
    profile.entities[1]!.payload = { styles: [], globals: [], compiledCss: "", design: { primary: "oklch(55% 0.2 30)", role_bg: "neutral-50", role_heading: "primary-950", role_link: "primary", heading_case: "uppercase", text_min: 17 } };
    const styles = profile.entities[1]!;
    styles.revisionHash = createHash("sha256").update(canonicalRevisionPayload(styles.kind, styles.schemaVersion, styles.payload), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(profile)).not.toThrow();
  });

  it("says first what is wrong in the entity's own kind, with the key's name, not what the other kinds want", () => {
    const issuesOf = (run: () => void): string[] => {
      try { run(); } catch (error) { return (error as { issues: string[] }).issues; }
      throw new Error("non rifiutato");
    };
    const profile = pageProfile();
    profile.entities[1]!.payload = { styles: [], globals: [], compiledCss: "", design: { "Role-Bg": "neutral-50" }, extra: 1 };
    const issues = issuesOf(() => validateStaticPageProfile(profile));
    expect(issues.some((issue) => issue.startsWith("/entities/1/payload: must NOT have additional properties («extra»)"))).toBe(true);
    expect(issues.some((issue) => issue.includes("/entities/1/payload/design") && issue.includes("«Role-Bg»"))).toBe(true);
    expect(issues.filter((issue) => /\/kind: must be equal to constant|documentType/u.test(issue))).toEqual([]);
    expect(issues.length).toBeLessThan(6);
    const entityIssues = issuesOf(() => validateTransferEntity(profile.entities[1]!));
    expect(entityIssues.some((issue) => issue.startsWith("/payload: must NOT have additional properties («extra»)"))).toBe(true);
    expect(entityIssues.filter((issue) => /\/kind: must be equal to constant/u.test(issue))).toEqual([]);
    // An unknown kind has no branch of its own: what Ajv said stays.
    expect(issuesOf(() => validateTransferEntity({ ...profile.entities[1]!, kind: "galassia" } as never)).length).toBeGreaterThan(5);
  });

  it("names in the manifest what stayed out of a reading, in a closed shape", () => {
    const profile = pageProfile();
    profile.manifest.leftOut = [{ kind: "page", title: "Pagina dinamica", reason: "The attribute srcset must have a static value." }];
    profile.manifest.manifestHash = createHash("sha256").update(manifestHashInput(profile.manifest), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(profile)).not.toThrow();
    profile.manifest.leftOut = [{ kind: "page", title: "Pagina", reason: "Motivo", extra: true } as never];
    profile.manifest.manifestHash = createHash("sha256").update(manifestHashInput(profile.manifest), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(profile)).toThrow();
  });

  it("accepts a linked deletion only as an explicit tombstone with its last entity snapshot", () => {
    const profile = pageProfile();
    const previous = profile.entities[0]!;
    previous.revisionHash = createHash("sha256")
      .update(canonicalRevisionPayload(previous.kind, previous.schemaVersion, previous.payload), "utf8")
      .digest("hex");
    const replacement = structuredClone(previous);
    replacement.id = "550e8400-e29b-41d4-a716-446655440004";
    replacement.payload = { ...replacement.payload, title: "Pagina rimasta", slug: "pagina-rimasta" };
    replacement.revisionHash = createHash("sha256")
      .update(canonicalRevisionPayload(replacement.kind, replacement.schemaVersion, replacement.payload), "utf8")
      .digest("hex");
    const tombstone: TransferEntity = {
      id: previous.id,
      kind: "tombstone",
      schemaVersion: 1,
      revisionHash: sha,
      baseHash: sha,
      payload: {
        entityKind: previous.kind,
        deletedAt: "2026-10-24T12:00:00.000Z",
        label: "Pagina",
        previousRevisionHash: previous.revisionHash,
        previousPayload: previous.payload,
      },
    };
    tombstone.revisionHash = createHash("sha256")
      .update(canonicalRevisionPayload(tombstone.kind, tombstone.schemaVersion, tombstone.payload), "utf8")
      .digest("hex");
    profile.entities[0] = tombstone;
    profile.entities.push(replacement);
    expect(() => validateStaticPageProfile(profile)).not.toThrow();

    const unlinked = structuredClone(profile);
    delete unlinked.entities[0]!.baseHash;
    expect(() => validateStaticPageProfile(unlinked)).toThrow();

    const malformedSnapshot = structuredClone(profile);
    malformedSnapshot.entities[0]!.payload.previousPayload = {
      ...(malformedSnapshot.entities[0]!.payload.previousPayload as Record<string, unknown>),
      title: "Snapshot alterato",
    };
    malformedSnapshot.entities[0]!.revisionHash = createHash("sha256")
      .update(canonicalRevisionPayload(malformedSnapshot.entities[0]!.kind, 1, malformedSnapshot.entities[0]!.payload), "utf8")
      .digest("hex");
    expect(() => validateStaticPageProfile(malformedSnapshot)).toThrow(/snapshot precedente/u);

    const nonCanonicalDate = structuredClone(profile);
    nonCanonicalDate.entities[0]!.payload.deletedAt = "2026-10-24T12:00:00Z";
    nonCanonicalDate.entities[0]!.revisionHash = createHash("sha256")
      .update(canonicalRevisionPayload(nonCanonicalDate.entities[0]!.kind, 1, nonCanonicalDate.entities[0]!.payload), "utf8")
      .digest("hex");
    expect(() => validateStaticPageProfile(nonCanonicalDate)).toThrow(/tombstone non valida/u);

    const expandedYearDate = structuredClone(profile);
    const expandedTombstone = expandedYearDate.entities[0];
    if (expandedTombstone?.kind !== "tombstone") throw new Error("Manca la tombstone di prova.");
    expandedTombstone.payload.deletedAt = "+010000-01-01T00:00:00.000Z";
    expandedTombstone.revisionHash = createHash("sha256")
      .update(canonicalRevisionPayload(expandedTombstone.kind, 1, expandedTombstone.payload), "utf8")
      .digest("hex");
    expect(() => validateStaticPageProfile(expandedYearDate)).toThrow(/tombstone non valida/u);
  });

  it("validates the shared project fixture and its stable component reference", () => {
    expect(() => validateStaticPageProfile(sharedProjectFixture.profile)).not.toThrow();
    expect(sharedProjectFixture.profile.manifest.profile).toBe("histos-static-project-v1");
    const { manifest, entities, references } = sharedProjectFixture.profile;
    const bytesFor = (path: string) => Buffer.from(sharedProjectFixture.files[path]!, "base64");
    for (const file of manifest.files) {
      const bytes = bytesFor(file.path);
      expect(bytes.byteLength).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    expect(bytesFor("entities.ndjson").toString("utf8")).toBe(`${entities.map(canonicalizeJson).join("\n")}\n`);
    expect(bytesFor("references.ndjson").toString("utf8")).toBe(references.length ? `${references.map(canonicalizeJson).join("\n")}\n` : "");

    const invalidReference = structuredClone(sharedProjectFixture.profile);
    invalidReference.references[0]!.targetId = invalidReference.entities.find((entity) => entity.kind === "styles")!.id;
    expect(() => validateStaticPageProfile(invalidReference)).toThrow(/tipo, percorso o destinazione non validi/u);
  });

  it("validates the shared relational CMS project fixture and every bundled file", () => {
    expect(() => validateStaticPageProfile(sharedRelationalProjectFixture.profile)).not.toThrow();
    expect(sharedRelationalProjectFixture.profile.manifest.profile).toBe("histos-static-project-v3");
    const { manifest, entities, references } = sharedRelationalProjectFixture.profile;
    const bytesFor = (path: string) => Buffer.from(sharedRelationalProjectFixture.files[path]!, "base64");
    for (const file of manifest.files) {
      const bytes = bytesFor(file.path);
      expect(bytes.byteLength).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    expect(bytesFor("entities.ndjson").toString("utf8")).toBe(`${entities.map(canonicalizeJson).join("\n")}\n`);
    expect(bytesFor("references.ndjson").toString("utf8")).toBe(references.length ? `${references.map(canonicalizeJson).join("\n")}\n` : "");
    expect(entities.some((entity) => entity.kind === "content-type")).toBe(true);
    expect(entities.some((entity) => entity.kind === "content-record")).toBe(true);
    expect(entities.some((entity) => entity.kind === "taxonomy")).toBe(true);
    expect(entities.some((entity) => entity.kind === "term")).toBe(true);
    expect(entities.some((entity) => entity.kind === "query-preset")).toBe(true);
    const eventType = entities.find((entity) => entity.kind === "content-type" && entity.payload.key === "events");
    expect(eventType?.payload).toMatchObject({ singleTemplateRef: "content/event-single", archiveTemplateRef: "content/event-archive" });
    expect(entities.filter((entity) => entity.kind === "template").map((entity) => entity.payload.ref)).toEqual(expect.arrayContaining(["content/event-single", "content/event-archive"]));
  });

  it("validates the shared v4 fixture with posts, native taxonomies and template roles", () => {
    const { manifest, entities } = sharedPostsFixture.profile;
    expect(() => validateStaticPageProfile(sharedPostsFixture.profile)).not.toThrow();
    expect(manifest.profile).toBe("histos-static-project-v4");
    expect(manifest.requiredCapabilities).toEqual(expect.arrayContaining(["documents:post:v1", "templates:roles:v1"]));
    const bytes = Buffer.from(sharedPostsFixture.files["entities.ndjson"]!, "base64").toString("utf8");
    expect(bytes).toBe(`${entities.map(canonicalizeJson).join("\n")}\n`);
    const posts = entities.filter((entity) => entity.kind === "document" && entity.payload.documentType === "post");
    expect(posts.map((post) => post.payload.status).sort()).toEqual(["draft", "published"]);
    // An empty term map stays an object in the canonical bytes, so both runtimes hash it the same way.
    expect(bytes).toContain('"terms":{}');
    expect(entities.filter((entity) => entity.kind === "taxonomy").map((entity) => [entity.payload.key, entity.payload.types])).toEqual(expect.arrayContaining([["category", ["post"]], ["post_tag", ["post"]]]));
  });

  it("rifiuta un tipo che punta a un template assente dal trasferimento relazionale", () => {
    const invalid = structuredClone(sharedRelationalProjectFixture.profile);
    invalid.entities = invalid.entities.filter((entity) => !(entity.kind === "template" && entity.payload.ref === "content/event-single"));
    const entitiesBytes = `${invalid.entities.map(canonicalizeJson).join("\n")}\n`;
    const entityFile = invalid.manifest.files.find((file) => file.path === "entities.ndjson");
    if (!entityFile) throw new Error("Il fixture relazionale non contiene entities.ndjson.");
    entityFile.bytes = Buffer.byteLength(entitiesBytes);
    entityFile.sha256 = createHash("sha256").update(entitiesBytes).digest("hex");
    invalid.manifest.manifestHash = createHash("sha256").update(manifestHashInput(invalid.manifest), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(invalid)).toThrow(/template non incluso nel trasferimento/u);
  });

  it("accepts the executable v2 page profile", () => {
    expect(() => validateStaticPageProfile(pageProfile())).not.toThrow();
  });

  it("requires local CSS media and fonts to resolve to supported profile assets", () => {
    const profile = structuredClone(sharedFixture.profile);
    const styles = profile.entities.find((entity) => entity.kind === "styles");
    const asset = profile.entities.find((entity) => entity.kind === "asset");
    if (!styles || styles.kind !== "styles" || !asset || asset.kind !== "asset") throw new Error("Il fixture CSS deve contenere stili e un asset.");
    styles.payload.styles = [{
      id: "hero", selector: ".hero", css: "background-image:url(../media/hero.png?v=4)",
      assets: [{ reference: "../media/hero.png?v=4", assetId: asset.id }],
    }];
    styles.revisionHash = createHash("sha256").update(canonicalRevisionPayload(styles.kind, styles.schemaVersion, styles.payload), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(profile)).not.toThrow();

    const missingAsset = structuredClone(profile);
    const missingStyles = missingAsset.entities.find((entity) => entity.kind === "styles");
    if (!missingStyles || missingStyles.kind !== "styles") throw new Error("Manca lo snapshot degli stili.");
    const mappings = missingStyles.payload.styles as Array<Record<string, JsonValue>>;
    const mapping = mappings[0]!.assets as Array<Record<string, JsonValue>>;
    mapping[0]!.assetId = "550e8400-e29b-41d4-a716-446655440099";
    missingStyles.revisionHash = createHash("sha256").update(canonicalRevisionPayload(missingStyles.kind, missingStyles.schemaVersion, missingStyles.payload), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(missingAsset)).toThrow(/riferimento media CSS non risolto/u);

    const unlinked = structuredClone(profile);
    const unlinkedStyles = unlinked.entities.find((entity) => entity.kind === "styles");
    if (!unlinkedStyles || unlinkedStyles.kind !== "styles") throw new Error("Manca lo snapshot degli stili.");
    const unlinkedRules = unlinkedStyles.payload.styles as Array<Record<string, JsonValue>>;
    unlinkedRules[0]!.assets = [];
    unlinkedStyles.revisionHash = createHash("sha256").update(canonicalRevisionPayload(unlinkedStyles.kind, unlinkedStyles.schemaVersion, unlinkedStyles.payload), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(unlinked)).toThrow(/URL CSS locale senza media collegato/u);
  });

  it("accepts bundle-root CSS references created by flattening selected framework files", () => {
    const profile = structuredClone(sharedFixture.profile);
    const styles = profile.entities.find((entity) => entity.kind === "styles");
    const asset = profile.entities.find((entity) => entity.kind === "asset");
    if (!styles || styles.kind !== "styles" || !asset || asset.kind !== "asset") throw new Error("Il fixture CSS deve contenere stili e un asset.");
    const reference = "/framework/fonts/brand.woff2?v=3#latin";
    styles.payload.globals = [{
      id: "framework",
      css: `@font-face{font-family:Brand;src:url("${reference}")}`,
      assets: [{ reference, assetId: asset.id }],
    }];
    styles.revisionHash = createHash("sha256").update(canonicalRevisionPayload(styles.kind, styles.schemaVersion, styles.payload), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(profile)).not.toThrow();
  });

  it("shares CSS resource tokenization that ignores comments and quoted text", () => {
    expect(cssResourceReferences(`/* url(fake.png) */ .x{content:"url(text.png)";background:url(./real.png)}`)).toMatchObject([
      { value: "./real.png", kind: "url", external: false },
    ]);
  });

  it("keeps external CSS resources and rejects local stylesheet imports", () => {
    const profile = structuredClone(sharedFixture.profile);
    const styles = profile.entities.find((entity) => entity.kind === "styles");
    if (!styles || styles.kind !== "styles") throw new Error("Manca lo snapshot degli stili.");
    const configuration = '{\n  "tokens": {"space": "1rem"}\n}';
    styles.payload.globals = [{ id: "cdn", css: '@import url("https://cdn.example.test/base.css"); .hero{background:url(data:image/png;base64,AAAA)}', source: { kind: "user-css", frameworkId: "automatic-css", name: "Automatic.css", rightsConfirmed: true, configuration: { format: "opaque-utf8-v1", data: configuration } } }];
    styles.revisionHash = createHash("sha256").update(canonicalRevisionPayload(styles.kind, styles.schemaVersion, styles.payload), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(profile)).not.toThrow();

    const invalidConfiguration = structuredClone(profile);
    const invalidStyles = invalidConfiguration.entities.find((entity) => entity.kind === "styles");
    if (!invalidStyles || invalidStyles.kind !== "styles") throw new Error("Manca lo snapshot degli stili.");
    (invalidStyles.payload.globals[0]!.source as Record<string, unknown>).configuration = { format: "opaque-utf8-v1", data: "\0" };
    invalidStyles.revisionHash = createHash("sha256").update(canonicalRevisionPayload(invalidStyles.kind, invalidStyles.schemaVersion, invalidStyles.payload), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(invalidConfiguration)).toThrow(/nullo/u);

    const localImport = structuredClone(profile);
    const localStyles = localImport.entities.find((entity) => entity.kind === "styles");
    if (!localStyles || localStyles.kind !== "styles") throw new Error("Manca lo snapshot degli stili.");
    localStyles.payload.globals = [{ id: "local", css: '@import "./theme.css";' }];
    localStyles.revisionHash = createHash("sha256").update(canonicalRevisionPayload(localStyles.kind, localStyles.schemaVersion, localStyles.payload), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(localImport)).toThrow(/@import locale non trasferibile/u);
  });

  it("rifiuta URL di provenienza CSS non HTTP o contenenti credenziali come il plugin Histeon", () => {
    const invalidSourceUrls = [
      "", "nota-url", "ftp://example.com/css", "https:///host-mancante", "https://utente:segreto@example.com/css",
      "https://example.com/percorso con spazi", "https://example.com\\percorso", "https://example.com/css\\x",
      "https://example.com/css\n", "https://example.com/caffè", "https://foo_bar.example/css",
      "https://-foo.example/css", "https://foo..example/css", "https://%41.example/css",
      `https://example.com/${"a".repeat(2029)}`,
    ];
    for (const sourceUrl of invalidSourceUrls) {
      const profile = structuredClone(sharedFixture.profile);
      const styles = profile.entities.find((entity) => entity.kind === "styles");
      if (styles?.kind !== "styles") throw new Error("Manca lo snapshot degli stili.");
      styles.payload.globals = [{
        id: "framework",
        css: ":root{--space:1rem}",
        source: { kind: "user-css", frameworkId: "custom", name: "CSS di prova", rightsConfirmed: true, sourceUrl },
      }];
      styles.revisionHash = createHash("sha256").update(canonicalRevisionPayload(styles.kind, styles.schemaVersion, styles.payload), "utf8").digest("hex");
      if (sourceUrl.startsWith("https://") && sourceUrl.length <= 2048) expect(() => validateTransferEntity(styles), sourceUrl).toThrow(/URL di provenienza CSS non valida/u);
      else expect(() => validateTransferEntity(styles), sourceUrl).toThrow();
    }

    const profile = structuredClone(sharedFixture.profile);
    const styles = profile.entities.find((entity) => entity.kind === "styles");
    if (styles?.kind !== "styles") throw new Error("Manca lo snapshot degli stili.");
    const sourceUrl = `https://example.com/${"a".repeat(2028)}`;
    styles.payload.globals = [{ id: "framework", css: "", source: { kind: "user-css", frameworkId: "custom", name: "CSS di prova", rightsConfirmed: true, sourceUrl } }];
    expect(sourceUrl).toHaveLength(2048);
    expect(() => validateTransferEntity(styles)).not.toThrow();
  });

  it("validates query filter values with the same field types used by the CMS", () => {
    expect(() => validateStaticPageProfile(relationalProfile({ field: "score", op: "gte", value: 4 }))).not.toThrow();
    expect(() => validateStaticPageProfile(relationalProfile({ field: "score", op: "in", value: [1, 5, 9] }))).not.toThrow();
    expect(() => validateStaticPageProfile(relationalProfile({ field: "score", op: "eq", value: "cinque" }))).toThrow(/Valore non valido/u);
    expect(() => validateStaticPageProfile(relationalProfile({ field: "score", op: "in", value: [] }))).toThrow(/Filtro in non valido/u);
    expect(() => validateStaticPageProfile(relationalProfile({ field: "score", op: "exists", value: true }))).toThrow(/exists non accetta value/u);
  });

  it("preserves public single-record relation filters and rejects targets outside their type", () => {
    const { profile, articleId } = relationalQueryProfile();
    expect(() => validateStaticPageProfile(profile)).not.toThrow();
    const wrongTarget = structuredClone(profile);
    const query = wrongTarget.entities.find((entity) => entity.kind === "query-preset");
    if (!query || query.kind !== "query-preset") throw new Error("Manca la query di prova.");
    query.payload.filter = { field: "author", op: "eq", value: articleId };
    query.revisionHash = createHash("sha256").update(canonicalRevisionPayload(query.kind, query.schemaVersion, query.payload), "utf8").digest("hex");
    wrongTarget.manifest.manifestHash = createHash("sha256").update(manifestHashInput(wrongTarget.manifest), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(wrongTarget)).toThrow(/filtro relazione non valido/u);
  });

  it("valida i filtri pubblici che attraversano tre relazioni e rifiuta i campi privati", () => {
    const profile = nestedRelationalQueryProfile();
    expect(() => validateStaticPageProfile(profile)).not.toThrow();
    const privateField = structuredClone(profile);
    const regionType = privateField.entities.find((entity) => entity.kind === "content-type" && entity.payload.key === "region");
    if (regionType?.kind !== "content-type") throw new Error("Manca il tipo di prova regione.");
    const code = regionType.payload.fields.find((field) => field.key === "code");
    if (!code) throw new Error("Manca il campo di prova codice.");
    code.public = false;
    for (const entity of privateField.entities) entity.revisionHash = createHash("sha256").update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, entity.payload), "utf8").digest("hex");
    privateField.manifest.manifestHash = createHash("sha256").update(manifestHashInput(privateField.manifest), "utf8").digest("hex");
    expect(() => validateStaticPageProfile(privateField)).toThrow(/non pubblico/u);
  });

  it("validates the shared markup fixture: SVG, picture with indexed srcset media, details and textarea text", () => {
    const { manifest, entities, references } = sharedMarkupFixture.profile;
    expect(() => validateStaticPageProfile(sharedMarkupFixture.profile)).not.toThrow();
    const bytesFor = (path: string) => Buffer.from(sharedMarkupFixture.files[path]!, "base64");
    for (const file of manifest.files) {
      expect(bytesFor(file.path).byteLength).toBe(file.bytes);
      expect(createHash("sha256").update(bytesFor(file.path)).digest("hex")).toBe(file.sha256);
    }
    expect(bytesFor("entities.ndjson").toString("utf8")).toBe(`${entities.map(canonicalizeJson).join("\n")}\n`);
    expect(bytesFor("references.ndjson").toString("utf8")).toBe(`${references.map(canonicalizeJson).join("\n")}\n`);
    expect(references.filter((reference) => reference.path === "attrs.attributes.srcset").map((reference) => reference.index)).toEqual([0, 1, 0, 1]);
  });

  it("requires an index on srcset media references, none on src, and an asset as target", () => {
    const withReference = (change: (reference: StaticPageProfile["references"][number]) => void) => {
      const profile = structuredClone(sharedMarkupFixture.profile);
      const reference = profile.references.find((item) => item.path === "attrs.attributes.srcset")!;
      change(reference);
      return profile;
    };
    expect(() => validateStaticPageProfile(withReference((reference) => { delete reference.index; }))).toThrow(/percorso o destinazione non validi/u);
    expect(() => validateStaticPageProfile(withReference((reference) => { reference.path = "attrs.attributes.src"; }))).toThrow(/percorso o destinazione non validi/u);
    expect(() => validateStaticPageProfile(withReference((reference) => { reference.targetId = "550e8400-e29b-41d4-a716-446655440063"; }))).toThrow(/percorso o destinazione non validi/u);
    expect(() => validateStaticPageProfile(withReference((reference) => { reference.index = 1.5; }))).toThrow();
    expect(() => validateStaticPageProfile(withReference((reference) => { reference.index = -1; }))).toThrow();
  });

  it("rejects duplicate paths, unsupported payloads, and unresolved references", () => {
    const duplicatePath = pageProfile();
    duplicatePath.manifest.files[1] = { ...duplicatePath.manifest.files[0]! };
    expect(() => validateStaticPageProfile(duplicatePath)).toThrow(/duplicato/u);

    const unsupported = pageProfile();
    unsupported.entities[0]!.payload.script = "alert(1)";
    expect(() => validateStaticPageProfile(unsupported)).toThrow();

    const unresolved = pageProfile();
    unresolved.references.push({ ownerId: pageId, blockUid: "abcdefgh", path: "attrs.src", targetId: "550e8400-e29b-41d4-a716-446655440004", role: "media" });
    expect(() => validateStaticPageProfile(unresolved)).toThrow(/riferimento non risolto/u);
  });
});

describe("profile v4: posts and template roles", () => {
  const categoryId = "550e8400-e29b-41d4-a716-446655440061";
  const termId = "550e8400-e29b-41d4-a716-446655440062";
  const postId = "550e8400-e29b-41d4-a716-446655440063";
  const templateId = "550e8400-e29b-41d4-a716-446655440064";
  const slot = "<!-- wp:xb/slot {\"uid\":\"slotslot\",\"name\":\"default\"} /-->";

  function rehash(profile: StaticPageProfile): StaticPageProfile {
    for (const entity of profile.entities) entity.revisionHash = createHash("sha256").update(canonicalRevisionPayload(entity.kind, entity.schemaVersion, entity.payload), "utf8").digest("hex");
    profile.manifest.manifestHash = createHash("sha256").update(manifestHashInput(profile.manifest), "utf8").digest("hex");
    return profile;
  }

  function postProfile(): StaticPageProfile {
    const profile = pageProfile();
    profile.entities.push(
      { id: categoryId, kind: "taxonomy", schemaVersion: 1, revisionHash: sha, payload: { key: "category", label: "Categorie", types: ["post"] } },
      { id: termId, kind: "term", schemaVersion: 1, revisionHash: sha, payload: { taxonomyKey: "category", slug: "notizie", label: "Notizie", parentId: null } },
      { id: postId, kind: "document", schemaVersion: 1, revisionHash: sha, payload: { documentType: "post", title: "Primo", slug: "primo-articolo", status: "published", content: "", script: "", publishedAt: "2026-10-25T10:00:00Z", excerpt: "Breve.", terms: { category: [termId] }, templateRef: "theme-template/single" } },
      { id: templateId, kind: "template", schemaVersion: 1, revisionHash: sha, payload: { title: "Articolo", ref: "theme-template/single", schema: { props: {} }, content: slot, script: "", role: "single" } },
    );
    profile.manifest.profile = "histos-static-project-v4";
    profile.manifest.requiredCapabilities.push("templates:definition:v1", "content:taxonomies:v1", "documents:post:v1", "templates:roles:v1");
    return rehash(profile);
  }

  function mutate(change: (profile: StaticPageProfile) => void): StaticPageProfile {
    const profile = postProfile();
    change(profile);
    return rehash(profile);
  }
  const post = (profile: StaticPageProfile) => profile.entities.find((entity) => entity.id === postId)!;
  const template = (profile: StaticPageProfile) => profile.entities.find((entity) => entity.id === templateId)!;

  it("accepts a post with categories and a template with a role", () => {
    expect(() => validateStaticPageProfile(postProfile())).not.toThrow();
  });

  it("requires profile v4 and the exact capabilities", () => {
    expect(() => validateStaticPageProfile(mutate((profile) => { profile.manifest.profile = "histos-static-project-v3"; }))).toThrow(/capability/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { profile.manifest.requiredCapabilities = profile.manifest.requiredCapabilities.filter((item) => item !== "templates:roles:v1"); }))).toThrow(/capability/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { delete template(profile).payload.role; }))).toThrow(/capability/u);
  });

  it("needs a page besides the posts", () => {
    expect(() => validateStaticPageProfile(mutate((profile) => { profile.entities = profile.entities.filter((entity) => entity.id !== pageId); }))).toThrow(/almeno una pagina/u);
  });

  it("refuses invalid post dates, slugs, keys and terms", () => {
    for (const publishedAt of ["2026-02-30T10:00:00Z", "2026-10-25T10:00:00.000Z", "2026-10-25 10:00:00", null]) {
      expect(() => validateStaticPageProfile(mutate((profile) => { post(profile).payload.publishedAt = publishedAt; }))).toThrow();
    }
    expect(() => validateStaticPageProfile(mutate((profile) => { post(profile).payload.status = "draft"; }))).toThrow(/publishedAt/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { post(profile).payload.status = "draft"; post(profile).payload.publishedAt = null; }))).not.toThrow();
    expect(() => validateStaticPageProfile(mutate((profile) => { post(profile).payload.slug = "Primo_Articolo"; }))).toThrow();
    expect(() => validateStaticPageProfile(mutate((profile) => { post(profile).payload.slug = "a".repeat(201); }))).toThrow();
    expect(() => validateStaticPageProfile(mutate((profile) => { post(profile).payload.order = 1; }))).toThrow();
    expect(() => validateStaticPageProfile(mutate((profile) => { post(profile).payload.terms = { post_tag: [termId] }; }))).toThrow(/tassonomia/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { post(profile).payload.terms = { category: [pageId] }; }))).toThrow(/termine/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { post(profile).payload.templateRef = "theme-template/missing"; }))).toThrow(/template/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { profile.entities[0]!.payload.excerpt = ""; }))).toThrow();
  });

  it("keeps roles unique and on templates only, and reserves the built-in keys", () => {
    expect(() => validateStaticPageProfile(mutate((profile) => {
      profile.entities.push({ id: "550e8400-e29b-41d4-a716-446655440065", kind: "template", schemaVersion: 1, revisionHash: sha, payload: { title: "Altro", ref: "theme-template/other", schema: { props: {} }, content: slot, script: "", role: "single" } });
    }))).toThrow(/ruolo/u);
    expect(() => validateStaticPageProfile(mutate((profile) => { template(profile).payload.role = "author"; }))).toThrow();
    expect(() => validateStaticPageProfile(mutate((profile) => { profile.entities.find((entity) => entity.id === categoryId)!.payload.types = ["post", "event"]; }))).toThrow();
    expect(() => validateStaticPageProfile(mutate((profile) => {
      profile.entities.push({ id: "550e8400-e29b-41d4-a716-446655440066", kind: "content-type", schemaVersion: 1, revisionHash: sha, payload: { key: "post", label: "Articoli", fields: [] } });
      profile.manifest.requiredCapabilities.push("content:types:v1");
    }))).toThrow();
  });

  it("allows queries over posts filtered only by their taxonomies", () => {
    const query = (filter?: Record<string, JsonValue>) => mutate((profile) => {
      profile.entities.push({ id: "550e8400-e29b-41d4-a716-446655440067", kind: "query-preset", schemaVersion: 1, revisionHash: sha, payload: { key: "ultimi", label: "Ultimi articoli", typeKey: "post", limit: 5, orderBy: "publishedAt", order: "desc", ...(filter ? { filter } : {}) } });
      profile.manifest.requiredCapabilities.push("content:queries:v1");
    });
    expect(() => validateStaticPageProfile(query())).not.toThrow();
    expect(() => validateStaticPageProfile(query({ taxonomyKey: "category", termIds: [termId], operator: "IN" }))).not.toThrow();
    expect(() => validateStaticPageProfile(query({ field: "title", op: "eq", value: "x" }))).toThrow(/filtro/u);
  });
});

describe("revisione di un documento", () => {
  it("la barra scritta da WordPress 7.1 e quella delle versioni precedenti sono lo stesso documento", () => {
    const payload = (content: string) => ({ documentType: "post", title: "T", content });
    expect(canonicalRevisionPayload("document", 1, payload('<!-- wp:xb/text {"content":"\\u005c{x\\u005c}"} /-->')))
      .toBe(canonicalRevisionPayload("document", 1, payload('<!-- wp:xb/text {"content":"\\\\{x\\\\}"} /-->')));
  });
});
