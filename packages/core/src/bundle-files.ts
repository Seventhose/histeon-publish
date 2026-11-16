import { readDirectorySource } from "./filesystem.js";
import type { BundleFile } from "./types.js";

export async function loadBundleFiles(bundlePath: string): Promise<BundleFile[]> {
  const result = await readDirectorySource(bundlePath);
  return result.files.map((file) => ({ path: file.path, size: file.bytes.byteLength, bytes: file.bytes }));
}
