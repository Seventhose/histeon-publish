import { describe, expect, it } from "vitest";
import { CloudflareClient } from "../src/cloudflare.js";

const account = "9f8e6accf10cbbfa9bc0a4f15b0e441a";

/** A Cloudflare that answers 404 to script-settings and, for the versions, what the case says. */
function client(versions: "exists" | "missing"): { client: CloudflareClient; paths: string[] } {
  const paths: string[] = [];
  const answer = (status: number, result: unknown) => new Response(JSON.stringify(status < 300
    ? { success: true, errors: [], result }
    : { success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }], result: null }), { status });
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    if (url.pathname.endsWith("/script-settings")) return answer(404, null);
    if (url.pathname.endsWith("/versions")) return versions === "exists" ? answer(200, []) : answer(404, null);
    return answer(500, null);
  }) as typeof fetch;
  return { client: new CloudflareClient({ token: "token-di-prova-abcdef", fetch: fetcher, rateLimitRetries: 0 }), paths };
}

describe("verifica del Worker (voce 227)", () => {
  it("un Worker senza versioni pubblicate non risulta inesistente", async () => {
    const { client: cf, paths } = client("exists");
    await expect(cf.verifyWorkerScript(account, "appaoi-esempio-prova-works"))
      .rejects.toThrow("Il Worker “appaoi-esempio-prova-works” esiste ma non ha ancora una versione pubblicata: premi Prepara e pubblica.");
    expect(paths.at(-1)).toBe(`/client/v4/accounts/${account}/workers/scripts/appaoi-esempio-prova-works/versions`);
  });

  it("un Worker che non c'è resta «non esiste»", async () => {
    const { client: cf } = client("missing");
    await expect(cf.verifyWorkerScript(account, "appaoi-esempio-prova-works")).rejects.toThrow("non esiste nell’account Cloudflare selezionato");
  });
});
