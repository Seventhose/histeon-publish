import { rm } from "node:fs/promises";

/**
 * Removes a temporary folder of a build, check or import. A write still finishing inside it (for example after a
 * render refusal ended the build early) makes rm fail with ENOTEMPTY or EBUSY: Node retries those itself. Cleanup
 * never replaces the error the caller is already throwing: if the folder still cannot go, one later try is
 * scheduled, and the folder is a throwaway one under the data or temporary directory either way.
 */
export async function removeTemporary(folder: string): Promise<void> {
  try {
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    setTimeout(() => void rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined), 2_000).unref?.();
  }
}
