import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ZipFile } from "yazl";
import { HistosPublishError } from "./errors.js";
import { isPathInside, normalizeRelativePath } from "./paths.js";
import { scanFiles } from "./scanner.js";
import type { BundleMeta } from "./types.js";

interface ExportFile { path: string; bytes: Buffer }

async function collectBundleFiles(root: string): Promise<ExportFile[]> {
  const files: ExportFile[] = [];
  const visit = async (directory: string, relative: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const normalized = normalizeRelativePath(rel);
      if (!normalized || normalized.path !== rel) throw new HistosPublishError("Il bundle contiene un percorso non sicuro.", "unsafe-bundle", 2);
      const target = path.resolve(directory, entry.name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) throw new HistosPublishError("Il bundle contiene un collegamento simbolico.", "unsafe-bundle", 2);
      if (stat.isDirectory()) await visit(target, rel);
      else if (stat.isFile()) {
        if (!isPathInside(root, target)) throw new HistosPublishError("Un file del bundle esce dalla cartella.", "unsafe-bundle", 2);
        files.push({ path: rel, bytes: await readFile(target) });
      }
    }
  };
  await visit(root, "");
  return files;
}

function waitForZip(zip: ZipFile, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath, { flags: "wx" });
    let done = false;
    const fail = (error: Error): void => {
      if (done) return;
      done = true;
      output.destroy();
      reject(error);
    };
    output.once("error", fail);
    zip.outputStream.once("error", fail);
    output.once("close", () => {
      if (!done) { done = true; resolve(); }
    });
    zip.outputStream.pipe(output);
    zip.end();
  });
}

export async function exportBundle(bundleDirectory: string, outputPath: string): Promise<{ outputPath: string; files: number; bytes: number }> {
  const root = path.resolve(bundleDirectory);
  const meta = JSON.parse(await readFile(path.join(root, ".histos-publish", "meta.json"), "utf8")) as BundleMeta;
  if (meta.status !== "ready") throw new HistosPublishError("Il bundle è bloccato dallo scanner e non può essere esportato.", "scan-blocked", 3);
  const files = await collectBundleFiles(root);
  if (files.length === 0) throw new HistosPublishError("Il bundle non contiene file da esportare.", "bundle-empty", 2);
  const staticFiles = files.filter((file) => !file.path.startsWith(".histos-publish/"));
  if (staticFiles.length === 0) throw new HistosPublishError("Il bundle non contiene file statici da esportare.", "bundle-empty", 2);
  const findings = scanFiles(staticFiles.map((file) => ({ path: file.path, size: file.bytes.byteLength, contents: file.bytes })));
  if (findings.some((finding) => finding.severity === "block")) throw new HistosPublishError("Il bundle è cambiato dopo il controllo e ora contiene elementi bloccanti.", "scan-blocked", 3);
  const target = path.resolve(outputPath);
  if (isPathInside(root, target) || isPathInside(target, root)) throw new HistosPublishError("L’esportazione non può sovrapporsi al bundle.", "output-overlaps-bundle", 2);
  const bytes = staticFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0);

  if (target.toLowerCase().endsWith(".zip")) {
    const zip = new ZipFile();
    for (const file of staticFiles) zip.addBuffer(file.bytes, file.path, { compress: true });
    await mkdir(path.dirname(target), { recursive: true });
    await waitForZip(zip, target).catch(() => {
      throw new HistosPublishError("Non è stato possibile creare il file ZIP di esportazione.", "export-failed", 1);
    });
  } else {
    await mkdir(target, { recursive: false }).catch(() => {
      throw new HistosPublishError("La cartella di esportazione esiste già o non è scrivibile.", "output-exists", 2);
    });
    for (const file of staticFiles) {
      const destination = path.resolve(target, ...file.path.split("/"));
      if (!isPathInside(target, destination)) throw new HistosPublishError("Percorso di esportazione non sicuro.", "unsafe-output-path", 2);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes, { flag: "wx" });
    }
  }
  return { outputPath: target, files: staticFiles.length, bytes };
}
