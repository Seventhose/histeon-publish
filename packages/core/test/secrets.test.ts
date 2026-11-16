import { describe, expect, it } from "vitest";
import { readCloudflareToken, SystemKeyringSecretStore, type KeyringEntryConstructor } from "../src/secrets.js";

const state = new Map<string, string>();

class FakeEntry {
  constructor(_service: string, account: string) { this.account = account; }
  private account: string;
  getPassword(): string | null { return state.get(this.account) ?? null; }
  setPassword(password: string): void { state.set(this.account, password); }
  deletePassword(): void { state.delete(this.account); }
}

const FakeEntryConstructor = FakeEntry as unknown as KeyringEntryConstructor;

describe("portachiavi Cloudflare", () => {
  it("salva, legge e rimuove il token senza usare un file", async () => {
    state.clear();
    const store = new SystemKeyringSecretStore(FakeEntryConstructor);
    await store.set("synthetic-cloudflare-token");
    expect(await store.get()).toBe("synthetic-cloudflare-token");
    await store.delete();
    expect(await store.get()).toBeNull();
  });

  it("preferisce la variabile d’ambiente e non interroga il portachiavi", async () => {
    const entry = class extends FakeEntry { getPassword(): string | null { throw new Error("non deve essere chiamato"); } };
    const store = new SystemKeyringSecretStore(entry as unknown as KeyringEntryConstructor);
    await expect(readCloudflareToken(store, { HISTOS_CLOUDFLARE_API_TOKEN: "environment-token" } as NodeJS.ProcessEnv))
      .resolves.toEqual({ token: "environment-token", source: "environment" });
  });
});
