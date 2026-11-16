import { lstat, rm } from "node:fs/promises";
import path from "node:path";

/** How long a throwaway prototype preview stays on disk; each address to it still expires after 5 minutes. */
export const PROTOTYPE_PREVIEW_TTL_MS = 15 * 60 * 1000;
/** How many of them stay at once: the oldest goes first. */
export const PROTOTYPE_PREVIEWS_KEPT = 3;

const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Throwaway builds of checked prototypes (queue A2), in `<data>/histos-cms-builds/.prototype-previews/<build>`. They
 * are never registered as builds, so they can never be published or exported. Each one goes after
 * PROTOTYPE_PREVIEW_TTL_MS, beyond the last PROTOTYPE_PREVIEWS_KEPT, when the app closes and, after a crash, at the
 * next start.
 */
export class PrototypePreviews {
  readonly root: string;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(dataDirectory: string, private readonly ttlMs = PROTOTYPE_PREVIEW_TTL_MS, private readonly kept = PROTOTYPE_PREVIEWS_KEPT) {
    this.root = path.join(dataDirectory, "histos-cms-builds", ".prototype-previews");
  }

  /** Removes what a previous run left (the folder is only ever this class's). */
  async reset(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await rm(this.root, { recursive: true, force: true });
  }

  /** The folder of a preview that still exists, or null. */
  async folder(buildId: string): Promise<string | null> {
    if (!BUILD_ID.test(buildId) || !this.timers.has(buildId)) return null;
    const folder = path.join(this.root, buildId);
    const info = await lstat(folder).catch(() => null);
    return info?.isDirectory() && !info.isSymbolicLink() ? folder : null;
  }

  /** A preview just built: it goes after the lifetime, or sooner when newer ones push it out. */
  track(buildId: string): void {
    if (!BUILD_ID.test(buildId)) return;
    const timer = setTimeout(() => void this.discard(buildId), this.ttlMs);
    timer.unref?.();
    this.timers.set(buildId, timer);
    for (const old of [...this.timers.keys()].slice(0, Math.max(0, this.timers.size - this.kept))) void this.discard(old);
  }

  async discard(buildId: string): Promise<void> {
    clearTimeout(this.timers.get(buildId));
    this.timers.delete(buildId);
    if (!BUILD_ID.test(buildId)) return;
    await rm(path.join(this.root, buildId), { recursive: true, force: true }).catch(() => undefined);
  }
}
