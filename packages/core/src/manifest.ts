import { createHash } from "node:crypto";
import { assetContentType, assetExtension } from "./asset-types.js";
import { safeBundlePath } from "./paths.js";
import type { BundleFile, ManifestEntry } from "./types.js";

/**
 * The 32-hex-digit hash Cloudflare stores an asset under: SHA-256 of `base64 + extension`, and of the Content-Type too
 * when given. Cloudflare keeps the type of the first upload of a hash and never asks for that hash again, so the type
 * must be part of the hash: a file uploaded once with a wrong type gets a new hash, and is uploaded again, when its
 * type is fixed.
 */
export function assetHash(contents: Buffer, extension: string, contentType?: string): string {
  const base64 = contents.toString("base64");
  const input = contentType === undefined ? base64 + extension : `${base64}${extension}\n${contentType}`;
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}

export function createManifest(files: readonly BundleFile[]): Record<string, ManifestEntry> {
  const manifest: Record<string, ManifestEntry> = {};
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    const bundlePath = `/${file.path}`;
    if (!safeBundlePath(bundlePath)) {
      throw new Error(`Percorso non valido nel manifest: ${file.path}`);
    }
    const manifestPath = `/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    if (Object.hasOwn(manifest, manifestPath)) {
      throw new Error(`Percorso duplicato nel manifest: ${file.path}`);
    }
    if (!file.bytes) {
      throw new Error(`Contenuto mancante per il manifest: ${file.path}`);
    }
    manifest[manifestPath] = { hash: assetHash(file.bytes, assetExtension(file.path), assetContentType(file.path)), size: file.bytes.byteLength };
  }
  return manifest;
}
