import { createHash } from "node:crypto";
import { canonicalizeJson, canonicalRevisionPayload, type JsonValue } from "@histos-publish/histos-contract";
import yazl from "yazl";
import { describe, expect, it } from "vitest";
import { inspectStaticPageArchive } from "../src/index.js";

/** Doc 23 item 197: an archive of a site read content by content, every unreadable one named. */

function entity(id: string, kind: string, payload: Record<string, JsonValue>) {
  const revisionHash = createHash("sha256").update(canonicalRevisionPayload(kind as never, 1, payload), "utf8").digest("hex");
  return { id, kind, schemaVersion: 1, revisionHash, payload };
}

async function zip(files: Record<string, Buffer>): Promise<Buffer> {
  const archive = new yazl.ZipFile();
  for (const [name, bytes] of Object.entries(files)) archive.addBuffer(bytes, name, { mtime: new Date(0) });
  archive.end();
  const chunks: Buffer[] = [];
  for await (const chunk of archive.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("inspectStaticPageArchive", () => {
  it("names every content Publish cannot read, and what the site left out", async () => {
    const page = entity("550e8400-e29b-41d4-a716-446655440001", "document", { documentType: "page", title: "Home", slug: "home", status: "published", content: '<!-- wp:xb/text {"uid":"hometext1","content":"Ciao"} /-->', script: "" });
    const template = entity("550e8400-e29b-41d4-a716-446655440002", "template", { title: "Archivio senza contenuto", ref: "archivio", schema: { props: {} }, content: '<!-- wp:xb/text {"uid":"archtext1","content":"Elenco"} /-->', script: "" });
    const broken = entity("550e8400-e29b-41d4-a716-446655440003", "component", { title: "Scheda rotta", ref: "ui/rotta", schema: { props: {} }, content: '<!-- wp:core/paragraph --><p>x</p><!-- /wp:core/paragraph -->', script: "" });
    const entities = Buffer.from(`${[page, template, broken].map((item) => canonicalizeJson(item)).join("\n")}\n`, "utf8");
    const manifest = { format: "xb-site", version: 2, leftOut: [{ kind: "page", title: "Contatti", reason: "The page profile cannot transfer external, embedded or unresolved media URLs." }, { kind: 7, title: "x", reason: "y" }] };
    const archive = await zip({ "site.json": Buffer.from(JSON.stringify(manifest)), "entities.ndjson": entities, "references.ndjson": Buffer.alloc(0) });

    const inspection = await inspectStaticPageArchive(archive);
    expect(inspection.entities).toBe(3);
    expect(inspection.leftOut).toEqual([{ kind: "page", title: "Contatti", reason: "The page profile cannot transfer external, embedded or unresolved media URLs.", blocks: false }]);
    expect(inspection.problems.map((problem) => problem.title)).toEqual(["Archivio senza contenuto", "Scheda rotta"]);
    expect(inspection.problems[0]?.reason).toContain("slot predefinito");
    expect(inspection.whole).toBeNull();
  });

  it("says why the whole archive does not read when no content explains it", async () => {
    const page = entity("550e8400-e29b-41d4-a716-446655440001", "document", { documentType: "page", title: "Home", slug: "home", status: "published", content: "", script: "" });
    const archive = await zip({ "site.json": Buffer.from("{}"), "entities.ndjson": Buffer.from(`${canonicalizeJson(page)}\n`) });
    const inspection = await inspectStaticPageArchive(archive);
    expect(inspection.problems).toEqual([]);
    expect(inspection.whole).toBeTruthy();
  });
});
