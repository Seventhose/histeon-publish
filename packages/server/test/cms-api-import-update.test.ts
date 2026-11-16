import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CmsProjectCatalog, encodeStaticPageProfileArchive } from "@histos-publish/cms";
import type { StaticPageProfile } from "@histos-publish/histos-contract";
import { startLocalServer, type LocalServerHandle } from "../src/server.js";

// Chosen media files can be measured bigger than they are (lstat only, as the backup check measures): the bytes read
// stay the real ones, so a project "over 512 MiB" costs nothing on disk.
const fsHooks = vi.hoisted(() => ({ inflated: new Set<string>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (async (...args: unknown[]) => {
      const info = await (actual.lstat as (...input: unknown[]) => Promise<{ size: number | bigint }>)(...args);
      const name = /[0-9a-f]{64}$/u.exec(String(args[0]))?.[0];
      if (typeof info.size === "number" && name && fsHooks.inflated.has(name)) info.size = 513 * 1024 * 1024;
      return info;
    }) as typeof actual.lstat,
  };
});

const example = readFileSync(new URL("../../cms/test/fixtures/prototipo-esempio.html", import.meta.url), "utf8");
/** The example's "texture" image: what the remote media below downloads as. */
const texture = new Uint8Array(Buffer.from(/"name": "texture", "data": "data:image\/png;base64,([^"]+)"/u.exec(example)?.[1] ?? "", "base64"));
/** The example with its media "ehi" given by URL instead of inline. */
const remote = example.replace(/"data": "data:image\/png;base64,[^"]+"(, "alt": "Ehi, con cornice")/u, '"url": "https://example.com/ehi.png"$1');

describe("aggiornamenti dall'app: confronto e backup", () => {
  let server: LocalServerHandle | null = null;
  let dataDirectory: string;
  let uiDirectory: string;
  let base: string;
  let fetched: string[];

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-import-update-data-"));
    uiDirectory = await mkdtemp(path.join(os.tmpdir(), "histos-import-update-ui-"));
    await writeFile(path.join(uiDirectory, "index.html"), "<!doctype html><title>Test</title>");
    fetched = [];
    server = await startLocalServer({ dataDirectory, uiDirectory, openBrowser: false, cmsPrototypeAssetFetcher: async (url) => { fetched.push(url); return texture; } });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    fsHooks.inflated.clear();
    await server?.close();
    server = null;
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(uiDirectory, { recursive: true, force: true });
  });

  const headers = () => ({ "X-Histos-Token": server?.token ?? "", Origin: base });

  interface CheckBody {
    outcome: string;
    report: { placeholders: string[]; downloaded: number };
    changes?: { added: unknown[]; modified: Array<{ kind: string; label: string }>; removed: unknown[]; keptLocal: Array<{ kind: string; label: string }>; conflicts: Array<{ kind: string; label: string }> };
    changesNeedDownload?: boolean;
  }

  it("le impostazioni si salvano tutte o nessuna, e il nome non resta vuoto", async () => {
    const created = await fetch(`${base}/api/cms/v1/projects`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ name: "Prima" }) });
    const { project } = await created.json() as { project: { id: string } };
    const root = `${base}/api/cms/v1/projects/${project.id}`;
    const json = { ...headers(), "Content-Type": "application/json" };
    const patch = (body: Record<string, unknown>) => fetch(`${root}/settings`, { method: "PATCH", headers: json, body: JSON.stringify({ locale: "it-IT", timeZone: "Europe/Rome", ...body }) });
    expect((await patch({})).status).toBe(200);
    expect((await patch({ timeZone: "Asia/Tokyo", siteUrl: "http://esterno.it" })).status).toBe(400);
    expect((await patch({ timeZone: "Asia/Tokyo", name: "\u0001" })).status).toBe(400);
    const after = await (await fetch(root, { headers: headers() })).json() as { project: { name: string }; renderSettings: { timeZone: string } };
    expect(after).toMatchObject({ project: { name: "Prima" }, renderSettings: { timeZone: "Europe/Rome" } });
    expect((await patch({ name: "Dopo" })).status).toBe(200);
    const renamed = await (await fetch(root, { headers: headers() })).json() as { project: { name: string } };
    expect(renamed.project.name).toBe("Dopo");
  });

  it("aggiornare un prototipo tiene le traduzioni e le lingue (doc 20 §5.9)", async () => {
    const prototype = (query: string, body: string) => fetch(`${base}/api/cms/v1/projects/import-prototype${query}`, { method: "POST", headers: { ...headers(), "Content-Type": "text/html; charset=utf-8" }, body });
    const first = await prototype("", example);
    expect(first.status, await first.clone().text()).toBe(201);
    const { project, pages } = await first.json() as { project: { id: string }; pages: Array<{ id: string; slug: string }> };
    const json = { ...headers(), "Content-Type": "application/json" };
    const root = `${base}/api/cms/v1/projects/${project.id}`;
    expect((await fetch(`${root}/languages`, { method: "PUT", headers: json, body: JSON.stringify({ languages: [{ code: "en" }] }) })).status).toBe(200);
    const created = await fetch(`${root}/translations`, { method: "POST", headers: json, body: JSON.stringify({ sourceId: pages[0]!.id, language: "en" }) });
    expect(created.status).toBe(201);
    const { translation } = await created.json() as { translation: { translationId: string } };
    const updated = await prototype("?update=1", example.replace("Contatti", "Scrivici"));
    expect(updated.ok, await updated.clone().text()).toBe(true);
    const listed = await (await fetch(`${root}/translations`, { headers: headers() })).json() as { translations: Array<{ translationId: string }> };
    expect(listed.translations.map((item) => item.translationId)).toEqual([translation.translationId]);
    const details = await (await fetch(root, { headers: headers() })).json() as { pages: Array<{ id: string; locale: string | null }> };
    expect(details.pages.find((page) => page.id === translation.translationId)?.locale).toBe("en");
  });

  it("il progetto conserva i rapporti d'import, con la parte della conversione, e li dà in JSON (doc 18 §9, F7)", async () => {
    const prototype = (query: string) => fetch(`${base}/api/cms/v1/projects/import-prototype${query}`, { method: "POST", headers: { ...headers(), "Content-Type": "text/html; charset=utf-8" }, body: remote });
    const imported = await prototype("");
    expect(imported.status, await imported.clone().text()).toBe(201);
    const { project } = await imported.json() as { project: { id: string } };
    const reportsPath = `${base}/api/cms/v1/projects/${project.id}/import-reports`;
    const json = { ...headers(), "Content-Type": "application/json" };
    const listed = await (await fetch(reportsPath, { headers: headers() })).json() as { reports: Array<{ id: string; result: string | null }> };
    expect(listed.reports).toHaveLength(1);
    expect(listed.reports[0]?.result).toBe("created");
    const refused = await fetch(`${reportsPath}/conversion`, { method: "POST", headers: json, body: JSON.stringify({ framework: "histos-css", notes: ["x"], comando: "rm -rf" }) });
    expect(refused.status).toBe(400);
    const attached = await fetch(`${reportsPath}/conversion`, { method: "POST", headers: json, body: JSON.stringify({ file: "sito.zip", framework: "histos-css", notes: ["17 classi utility convertite"], selectable: { original: 40, selectable: 40, share: 1 }, structure: { parts: true, components: false, lists: false } }) });
    expect(attached.status).toBe(200);
    const download = await fetch(`${reportsPath}/${listed.reports[0]!.id}`, { headers: headers() });
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="rapporto-import-[0-9a-f]{8}\.json"$/u);
    const report = await download.json() as Record<string, unknown>;
    expect(report).toMatchObject({ format: "histos-import-report", version: 1, projectId: project.id, result: "created", conversion: { framework: "histos-css", file: "sito.zip", notes: ["17 classi utility convertite"], selectable: { share: 1 } } });
    expect((await fetch(`${reportsPath}/00000000-0000-4000-8000-000000000000`, { headers: headers() })).status).toBe(404);
  });

  it("un aggiornamento con media remoti non si confronta con i segnaposto: il controllo chiede di scaricarli (15)", async () => {
    const prototype = (query: string, body = remote) => fetch(`${base}/api/cms/v1/projects/import-prototype${query}`, { method: "POST", headers: { ...headers(), "Content-Type": "text/html; charset=utf-8" }, body });
    // A new project: placeholders are fine, there is nothing to compare with.
    const fresh = await (await prototype("?check=1&preview=1")).json() as CheckBody;
    expect(fresh).toMatchObject({ outcome: "create", report: { placeholders: ["ehi"] } });
    expect(fresh.changesNeedDownload).toBeUndefined();
    const imported = await prototype("");
    expect(imported.status, await imported.clone().text()).toBe(201);
    const { project } = await imported.json() as { project: { id: string } };
    expect(fetched).toEqual(["https://example.com/ehi.png"]);

    // The same file, checked as the app checks it (no ?download=1): no list built on placeholders, which would call the
    // unchanged image modified; the server asks for the check with the media.
    const appCheck = await (await prototype("?check=1&preview=1")).json() as CheckBody;
    expect(appCheck).toMatchObject({ outcome: "update", changesNeedDownload: true, report: { placeholders: ["ehi"] } });
    expect(appCheck.changes).toBeUndefined();
    const withMedia = await (await prototype("?check=1&download=1&preview=1")).json() as CheckBody;
    expect(withMedia.changesNeedDownload).toBeUndefined();
    expect(withMedia.changes).toMatchObject({ added: [], modified: [], removed: [], conflicts: [] });

    // Its alt text changed in Publish: the update keeps the local one. Compared with a placeholder it was a conflict,
    // which hid «Aggiorna»; with the media downloaded it is what it is.
    const media = await (await fetch(`${base}/api/cms/v1/projects/${project.id}/media`, { headers: headers() })).json() as Array<{ id: number; title: { rendered: string } }>;
    const ehi = media.find((item) => item.title.rendered.startsWith("ehi"));
    if (!ehi) throw new Error("Media «ehi» non trovato.");
    const alt = await fetch(`${base}/api/cms/v1/projects/${project.id}/media/${ehi.id}`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ alt_text: "Alt cambiato in Publish" }) });
    expect(alt.status).toBe(200);
    const edited = await (await prototype("?check=1&preview=1")).json() as CheckBody;
    expect(edited).toMatchObject({ outcome: "update", changesNeedDownload: true });
    expect(edited.changes).toBeUndefined();
    const editedWithMedia = await (await prototype("?check=1&download=1")).json() as CheckBody;
    expect(editedWithMedia.changes?.conflicts).toEqual([]);
    expect(editedWithMedia.changes?.keptLocal).toEqual([expect.objectContaining({ kind: "asset", label: "ehi.png" })]);
    // And the update the dialog then offers runs.
    const updated = await prototype("?update=1");
    expect(updated.status, await updated.clone().text()).toBe(200);

    // A prototype with no remote media is compared at once, as before.
    const inline = await (await prototype("?check=1&preview=1", example)).json() as CheckBody;
    expect(inline.changesNeedDownload).toBeUndefined();
    expect(inline.changes).toBeDefined();
  }, 30_000);

  it("il controllo che chiede i media non fa il confronto né l'anteprima, poi buttati: li fa una volta il controllo con i media (8)", async () => {
    const prototype = (query: string) => fetch(`${base}/api/cms/v1/projects/import-prototype${query}`, { method: "POST", headers: { ...headers(), "Content-Type": "text/html; charset=utf-8" }, body: remote });
    const imported = await prototype("");
    expect(imported.status, await imported.clone().text()).toBe(201);
    const { project } = await imported.json() as { project: { id: string; name: string } };
    fetched.length = 0;
    const compared = vi.spyOn(CmsProjectCatalog.prototype, "copyProjectForComparison");
    try {
      // The app's first check: enough to decide (an update of that project, which needs the media), and nothing more.
      // Before, the dry run on a copy of the project and a throwaway preview build ran here, and the app threw both away.
      const appCheck = await (await prototype("?check=1&preview=1")).json() as CheckBody & { valid: boolean; existingProject?: { id: string }; preview?: { status: string } };
      expect(appCheck).toMatchObject({ valid: true, outcome: "update", changesNeedDownload: true, existingProject: { id: project.id, name: project.name }, report: { placeholders: ["ehi"] } });
      expect(appCheck.changes).toBeUndefined();
      expect(appCheck.preview).toBeUndefined();
      expect(compared).not.toHaveBeenCalled();
      expect(fetched).toEqual([]);
      // The check the app then asks for does all of it, once.
      const withMedia = await (await prototype("?check=1&download=1&preview=1")).json() as CheckBody & { preview?: { status: string } };
      expect(withMedia.changes).toMatchObject({ added: [], modified: [], removed: [], conflicts: [] });
      expect(withMedia.preview).toMatchObject({ status: "ready" });
      expect(compared).toHaveBeenCalledTimes(1);
      expect(fetched).toEqual(["https://example.com/ehi.png"]);
    } finally {
      compared.mockRestore();
    }
  }, 30_000);

  it("il primo controllo dell'app ferma subito un progetto danneggiato e dice di un backup troppo grande, senza scaricare i media (8)", async () => {
    const prototype = (query: string) => fetch(`${base}/api/cms/v1/projects/import-prototype${query}`, { method: "POST", headers: { ...headers(), "Content-Type": "text/html; charset=utf-8" }, body: remote });
    const imported = await prototype("");
    expect(imported.status, await imported.clone().text()).toBe(201);
    const { project } = await imported.json() as { project: { id: string } };
    const sha256 = createHash("sha256").update(texture).digest("hex");
    const media = path.join(dataDirectory, "histos-projects", project.id, "media", "sha256", sha256.slice(0, 2), sha256);
    await writeFile(media, texture.subarray(0, Math.floor(texture.byteLength / 2)));
    fetched.length = 0;
    // As App.svelte checks: ?check=1, then ?download=1 only if the answer asks for it. Before, the first answer was
    // changesNeedDownload and the second, after downloading every remote media, the 422.
    const damaged = await prototype("?check=1&preview=1");
    expect(damaged.status).toBe(422);
    const refused = await damaged.json() as { code: string; error: string; changesNeedDownload?: boolean };
    expect(refused.code).toBe("cms-backup-unrestorable");
    expect(refused.error).toMatch(/è danneggiato: .*Per ripararlo carica di nuovo lo stesso file/u);
    expect(refused.changesNeedDownload).toBeUndefined();
    expect(fetched).toEqual([]);

    // Repaired as the message says (the same bytes uploaded again), the first check asks for the downloads.
    const repaired = await fetch(`${base}/api/cms/v1/projects/${project.id}/media?filename=ehi.png`, { method: "POST", headers: { ...headers(), "Content-Type": "image/png" }, body: texture });
    expect(repaired.status).toBe(201);
    expect(await (await prototype("?check=1&preview=1")).json()).toMatchObject({ outcome: "update", changesNeedDownload: true });
    expect(fetched).toEqual([]);

    // A backup over its limits: the reason at once, no «Aggiorna», and nothing to download for it.
    fsHooks.inflated.add(sha256);
    const tooLarge = await prototype("?check=1&preview=1");
    expect(tooLarge.status).toBe(200);
    const answer = await tooLarge.json() as CheckBody & { backupUnavailable?: string; preview?: unknown };
    expect(answer).toMatchObject({ outcome: "update", backupUnavailable: "Il progetto supera il limite di 512 MiB." });
    expect(answer.changesNeedDownload).toBeUndefined();
    expect(answer.changes).toBeUndefined();
    expect(answer.preview).toBeUndefined();
    expect(fetched).toEqual([]);
  }, 30_000);

  it("un .xbsite che aggiornerebbe un progetto il cui backup non sta nei limiti si ferma subito, senza chiedere conferma (18)", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../../histos-contract/test/fixtures/histos-static-project-v4.json", import.meta.url), "utf8")) as { profile: StaticPageProfile; files: Record<string, string> };
    const archive = await encodeStaticPageProfileArchive(fixture.profile, new Map(Object.entries(fixture.files).map(([name, value]) => [name, Buffer.from(value, "base64")])));
    const upload = (query = "") => fetch(`${base}/api/cms/v1/projects/import${query}`, { method: "POST", headers: { ...headers(), "Content-Type": "application/zip" }, body: archive });
    const first = await upload();
    expect(first.status, await first.clone().text()).toBe(201);
    const { project } = await first.json() as { project: { id: string } };
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pF8AAAAASUVORK5CYII=", "base64");
    const uploaded = await fetch(`${base}/api/cms/v1/projects/${project.id}/media?filename=foto.png`, { method: "POST", headers: { ...headers(), "Content-Type": "image/png" }, body: png });
    expect(uploaded.status).toBe(201);

    // The photos of the project now measure over 512 MiB: the update could not save its backup.
    fsHooks.inflated.add(createHash("sha256").update(png).digest("hex"));
    const unconfirmed = await upload();
    expect(unconfirmed.status).toBe(413);
    const refused = await unconfirmed.json() as { code: string; error: string };
    expect(refused.code).toBe("cms-backup-too-large");
    expect(refused.error).toContain("512 MiB");
    expect(refused.error).toContain("l'aggiornamento non si può fare");
    expect(await readdir(dataDirectory)).not.toContain("backups");
    // The confirmed update still measures again (the project may grow after the first answer).
    expect((await upload("?update=1")).status).toBe(413);
    expect(await readdir(dataDirectory)).not.toContain("backups");

    // Within the limits, the request to confirm comes as before.
    fsHooks.inflated.clear();
    const fits = await upload();
    expect(fits.status).toBe(409);
    expect(await fits.json()).toMatchObject({ code: "cms-import-update-requires-confirmation", project: { id: project.id } });
  }, 30_000);
});
