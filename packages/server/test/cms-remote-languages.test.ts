import { afterEach, describe, expect, it, vi } from "vitest";
import { sendLanguageLinks } from "../src/cms-remote.js";

const connection = { url: "https://esempio.it" } as Parameters<typeof sendLanguageLinks>[0];
const secret = Buffer.alloc(32, 1);
const links = [{ translationId: "a", sourceId: "b", language: "en", mode: "follow" }];

afterEach(() => { vi.unstubAllGlobals(); });

describe("legami delle lingue verso WordPress (doc 20 §5.9)", () => {
  it("manda i legami firmati e non aggiunge nulla se il sito li prende", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ taken: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await sendLanguageLinks(connection, secret, links)).toBe("");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(decodeURIComponent(String(url))).toContain("/xb/v1/cms/v1/languages");
    expect(init.headers["X-Histos-Signature"]).toBeTruthy();
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("dice che le traduzioni restano a sé quando il sito non ha il plugin o Histeon è vecchio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ taken: 0 }), { status: 200 })));
    expect(await sendLanguageLinks(connection, secret, links)).toContain("Lingua Bridge");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect(await sendLanguageLinks(connection, secret, links)).toContain("Lingua Bridge");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("rete"); }));
    expect(await sendLanguageLinks(connection, secret, links)).toContain("Lingua Bridge");
  });
});
