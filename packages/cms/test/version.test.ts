import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HISTOS_PUBLISH_VERSION } from "../src/version.js";

const version = (file: string): string => (JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as { version: string }).version;

describe("version", () => {
  it("is the one of package.json everywhere the app shows or writes it", () => {
    expect(HISTOS_PUBLISH_VERSION).toBe(version("../../../package.json"));
    expect(HISTOS_PUBLISH_VERSION).toBe(version("../../desktop/package.json"));
    // Doc 23 item 127: the lockfile too (scripts/set-version.mjs writes them all).
    const lock = JSON.parse(readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8")) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version).toBe(HISTOS_PUBLISH_VERSION);
    expect(lock.packages[""]?.version).toBe(HISTOS_PUBLISH_VERSION);
    expect(lock.packages["packages/desktop"]?.version).toBe(HISTOS_PUBLISH_VERSION);
  });
});
