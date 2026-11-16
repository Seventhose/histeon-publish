import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCACertificates } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLocalHost, localRequest, requestRemote, unreachable } from "../src/cms-remote-transport.js";

let openssl = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  openssl = false;
}

describe("the remote transport", () => {
  it("knows the development hosts of this computer", () => {
    for (const host of ["localhost", "sito.localhost", "sito-di-prova.local", "127.0.0.1", "[::1]"]) expect(isLocalHost(host)).toBe(true);
    for (const host of ["example.com", "local.example.com", "localhost.example.com", "10.0.0.1"]) expect(isLocalHost(host)).toBe(false);
  });

  it("says why a site cannot be reached instead of «fetch failed»", () => {
    const failed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code }) });
    expect(unreachable(failed("DEPTH_ZERO_SELF_SIGNED_CERT"))).toMatchObject({ code: "cms-remote-certificate", message: expect.stringContaining("DEPTH_ZERO_SELF_SIGNED_CERT") });
    expect(unreachable(failed("ECONNREFUSED"))).toMatchObject({ code: "cms-remote-unreachable", message: expect.stringContaining("ECONNREFUSED") });
    expect(unreachable(failed("<b>no</b>")).message).not.toContain("<b>");
    expect(unreachable(Object.assign(new Error("late"), { name: "TimeoutError" }))).toMatchObject({ code: "cms-remote-timeout" });
  });
});

describe.skipIf(!openssl)("a local site with a certificate only the system trusts", () => {
  let directory = "";
  let certificate = "";
  let server: Server;
  let origin = "";

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "histos-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem")], { stdio: "ignore" });
    certificate = readFileSync(path.join(directory, "cert.pem"), "utf8");
    server = createServer({ key: readFileSync(path.join(directory, "key.pem")), cert: certificate }, (request, response) => {
      if (request.url?.startsWith("/moved")) {
        response.writeHead(302, { Location: "https://example.com/" }).end();
        return;
      }
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        response.setHeader("Set-Cookie", ["a=1", "b=2"]);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ method: request.method, body, signed: request.headers["x-histos-signature"] ?? "" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const init = (method: string, body?: Buffer) => ({ method, headers: { Accept: "application/json" }, ...(body ? { body } : {}), signal: AbortSignal.timeout(10_000) });

  it("is reached with the certificates it is given, as a fetch Response", async () => {
    const response = await localRequest(new URL(`${origin}/?rest_route=x`), init("POST", Buffer.from("ciao")), [certificate]);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe("a=1, b=2");
    expect(await response.json()).toEqual({ method: "POST", body: "ciao", signed: "" });
  });

  it("does not follow a redirect", async () => {
    const response = await localRequest(new URL(`${origin}/moved`), init("GET"), [certificate]);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/");
  });

  it("is refused with Node's bundle alone, and the refusal says so", async () => {
    const error = await localRequest(new URL(`${origin}/`), init("GET"), getCACertificates("bundled")).catch((caught: unknown) => caught);
    expect(unreachable(error)).toMatchObject({ code: "cms-remote-certificate" });
  });

  it("goes through the local path in requestRemote, signed", async () => {
    // The test certificate is in no system store: the signed request reaches the local path and is refused by it.
    await expect(requestRemote({ url: origin }, Buffer.alloc(32), "GET", "/xb/v1/cms/v1/capabilities")).rejects.toMatchObject({ code: "cms-remote-certificate" });
  });
});
