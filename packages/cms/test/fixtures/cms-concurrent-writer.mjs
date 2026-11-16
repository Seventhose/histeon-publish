import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CmsProjectCatalog } from "../../dist/project-repository.js";

const [dataDirectory, projectId, entityId, label, synchronizationDirectory] = process.argv.slice(2);
if (!dataDirectory || !projectId || !entityId || !label || !synchronizationDirectory) throw new Error("Argomenti del writer concorrente mancanti.");

const writeArtifact = async (kind, value) => {
  const destination = path.join(synchronizationDirectory, `${kind}-${label}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await rename(temporary, destination);
};
let store;
try {
  const catalog = new CmsProjectCatalog(dataDirectory);
  const opened = await catalog.openProject(projectId);
  if (!opened) throw new Error("Il writer concorrente non ha trovato il progetto.");
  store = opened.store;
  const head = store.getHead(entityId);
  if (!head) throw new Error("Il writer concorrente non ha trovato la revisione iniziale.");
  await writeArtifact("ready", { kind: "ready", head: head.id, label });

  const startFile = path.join(synchronizationDirectory, "save");
  const deadline = Date.now() + 15_000;
  let released = false;
  while (Date.now() < deadline) {
    try {
      await readFile(startFile);
      released = true;
      break;
    } catch (error) {
      if ((error && typeof error === "object" && "code" in error ? error.code : null) !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!released) throw new Error("Il writer non ha ricevuto il via libera al salvataggio.");

  const result = store.saveDocument({ entityId, expectedHead: head.id, content: `${head.content}<!-- ${label} -->` });
  await writeArtifact("result", { kind: "result", label, status: result.status });
} catch (error) {
  await writeArtifact("error", { kind: "error", label, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  store?.close();
}
