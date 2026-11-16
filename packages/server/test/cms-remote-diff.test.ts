import { describe, expect, it } from "vitest";
import type { StaticPageProfile } from "@histos-publish/histos-contract";
import { buildSyncDiff, profileFingerprint, pullFingerprint } from "../src/cms-remote-diff.js";

const profile = (baseHash?: string, revisionHash = "a".repeat(64)): StaticPageProfile => ({
  manifest: { format: "xb-site", version: 2, generator: { name: "Histos CMS", version: "0", engineCommit: "x" }, project: { id: "6b2f3c1e-1d3a-4c55-9a1b-2c3d4e5f6a7b", name: "P" }, selection: { kind: "workspace-head", snapshot: "s" } as never, requiredCapabilities: [], profile: "histos-static-project-v4", files: [], manifestHash: "h" },
  entities: [{ id: "11111111-1111-4111-8111-111111111111", kind: "document", schemaVersion: 1, revisionHash, ...(baseHash ? { baseHash } : {}), payload: {} }],
  references: [],
});

describe("impronte dei piani di sincronizzazione (C4)", () => {
  it("per scaricare non conta il file delle entità, che contiene le basi", () => {
    const withFiles = (sha: string) => ({ ...profile(), manifest: { ...profile().manifest, files: [{ path: "entities.ndjson", bytes: 1, sha256: sha }, { path: "assets/a.png", bytes: 1, sha256: "d".repeat(64) }] } });
    expect(pullFingerprint(withFiles("e".repeat(64)))).toBe(pullFingerprint(withFiles("f".repeat(64))));
    expect(profileFingerprint(withFiles("e".repeat(64)))).not.toBe(profileFingerprint(withFiles("f".repeat(64))));
  });

  it("per scaricare contano contenuti e riferimenti, non le basi che WordPress registra al primo export", () => {
    expect(pullFingerprint(profile())).toBe(pullFingerprint(profile("b".repeat(64))));
    expect(profileFingerprint(profile())).not.toBe(profileFingerprint(profile("b".repeat(64))));
    expect(pullFingerprint(profile(undefined, "c".repeat(64)))).not.toBe(pullFingerprint(profile()));
  });

  it("in un invio, la base di WordPress non basta: conta solo ciò che il progetto ha condiviso davvero", () => {
    const empty = { ...profile(), entities: [] };
    const id = "11111111-1111-4111-8111-111111111111";
    // WordPress marks everything it exports once, its default categories too.
    expect(buildSyncDiff("push", empty, profile("b".repeat(64))).counts).toMatchObject({ "remote-only": 1, conflict: 0 });
    // Sent from here and gone from the project without a deletion: that stays a conflict.
    expect(buildSyncDiff("push", empty, profile("b".repeat(64)), new Map([[id, "b".repeat(64)]])).counts).toMatchObject({ conflict: 1 });
  });
});
