import { describe, expect, it } from "vitest";
import { HistosPublishError } from "@histos-publish/core";
import { claimRemotePairing, pendingPairingSite, startRemotePairing } from "../src/cms-remote.js";
import type { CmsRemoteCatalog } from "../src/cms-remote-catalog.js";

const nowhere = {} as CmsRemoteCatalog;
const noStore = () => ({ get: async () => null, set: async () => undefined, delete: async () => undefined });

describe("abbinamento in un clic (doc 23, voce 237)", () => {
  it("apre la pagina di Histeon del sito con la sfida, mai con il verificatore", () => {
    const started = startRemotePairing("https://www.esempio.it/");
    const page = new URL(started.url);
    expect(page.origin + page.pathname).toBe("https://www.esempio.it/wp-admin/admin.php");
    expect(page.searchParams.get("page")).toBe("xb-releases");
    expect(page.searchParams.get("xb_pair_state")).toBe(started.state);
    expect(page.searchParams.get("xb_pair")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(page.hash).toBe("#xb-cms");
    expect(pendingPairingSite(started.state)).toBe("https://www.esempio.it");
  });

  it("rifiuta un sito senza HTTPS che non è locale", () => {
    expect(() => startRemotePairing("http://www.esempio.it")).toThrow(HistosPublishError);
    expect(pendingPairingSite("6c1d2e8f-4b7a-4f3e-9a21-0b5c7d9e2f41")).toBeNull();
  });

  it("un ritiro per un abbinamento che Publish non ha avviato, o già scaduto, non chiede nulla al sito", async () => {
    const unknown = await claimRemotePairing({ state: "6c1d2e8f-4b7a-4f3e-9a21-0b5c7d9e2f41", claim: "a".repeat(32) }, nowhere, noStore).catch((error: unknown) => error);
    expect((unknown as HistosPublishError).code).toBe("cms-pairing-unknown");
    const started = startRemotePairing("http://sito.local", 1_000);
    const expired = await claimRemotePairing({ state: started.state, claim: "a".repeat(32) }, nowhere, noStore, 1_000 + 10 * 60_000).catch((error: unknown) => error);
    expect((expired as HistosPublishError).code).toBe("cms-pairing-unknown");
    const malformed = await claimRemotePairing({ state: started.state, claim: "../x" }, nowhere, noStore).catch((error: unknown) => error);
    expect((malformed as HistosPublishError).code).toBe("cms-pairing-invalid");
  });

  it("al massimo cinque abbinamenti in attesa", () => {
    const later = Date.now() + 60 * 60_000;
    for (let i = 0; i < 5; i++) startRemotePairing("http://sito.local", later);
    expect(() => startRemotePairing("http://sito.local", later)).toThrow(/cinque abbinamenti/u);
  });
});
