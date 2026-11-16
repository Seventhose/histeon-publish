import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPrototypeProfile, CmsProjectCatalog, decodeStaticPageArchive, parsePrototype } from "@histos-publish/cms";
import { HistosPublishError } from "@histos-publish/core";
import { exportPrototypeXbsite, exportXbsiteArchive } from "../src/cms-api.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const scratch = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-export-"));
  roots.push(root);
  return root;
};
const fixture = () => readFile(new URL("../../connector/test/fixtures/progettare.html", import.meta.url), "utf8");
const entities = async (archive: Buffer) => (await decodeStaticPageArchive(archive)).profile.entities.map((entity) => `${entity.kind} ${entity.id} ${entity.revisionHash}`).sort();

describe("dal prototipo al .xbsite senza progetto nell'app (doc 23, voce 238)", () => {
  it("dà lo stesso pacchetto che l'app esporterebbe per il progetto creato dall'import, e non lascia nulla", async () => {
    const html = await fixture();
    const root = await scratch();
    const { archive, report } = await exportPrototypeXbsite(html, { scratchRoot: root });
    expect(report.project.id).toBe("6c1d2e8f-4b7a-4f3e-9a21-0b5c7d9e2f41");
    const decoded = await decodeStaticPageArchive(archive);
    expect(decoded.profile.manifest.project.id).toBe(report.project.id);
    expect(decoded.profile.entities.some((entity) => entity.kind === "query-preset")).toBe(true);

    // The app's way: import the prototype into a catalog, then export the project.
    const app = await scratch();
    const built = await buildPrototypeProfile(parsePrototype(html), new CmsProjectCatalog(path.join(app, "build"), { durable: false }));
    const imported = await new CmsProjectCatalog(path.join(app, "projects"), { durable: false }).importStaticPageProfile(built.profile, built.files);
    try {
      expect(await entities(archive)).toEqual(await entities(await exportXbsiteArchive(imported.project, imported.store)));
    } finally {
      imported.store.close();
    }
    // The private folder under the scratch root is gone.
    await expect((await import("node:fs/promises")).readdir(root)).resolves.toEqual([]);
  });

  it("un media remoto ferma l'export senza --download, come ferma l'import: mai un segnaposto nel pacchetto", async () => {
    const html = (await fixture()).replace('{ "name": "organo", "data": "data:image/webp;base64,UklGRjQAAABXRUJQVlA4ICgAAACQAQCdASoQAAwAAoBCJaACdLoAA5gA/vD6K/8Q50OdDmtz15T4laAA"', '{ "name": "organo", "url": "https://example.com/organo.webp"');
    expect(html).not.toBe(await fixture());
    const error = await exportPrototypeXbsite(html, { scratchRoot: await scratch() }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HistosPublishError);
    expect((error as HistosPublishError).code).toBe("cms-prototype-invalid");
  });

  it("un prototipo non valido dice i suoi problemi, come il controllo", async () => {
    const error = await exportPrototypeXbsite((await fixture()).replace('"types": [', '"posts": [], "types": ['), { scratchRoot: await scratch() }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HistosPublishError);
    expect((error as Error).message).toMatch(/sezione sconosciuta posts/u);
  });
});
