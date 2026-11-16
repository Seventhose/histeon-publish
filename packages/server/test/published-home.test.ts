import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { HttpResponseMetadata } from "@histos-publish/core";
import { checkPublishedHome } from "../src/published-home.js";

function response(status: number, headers: Record<string, string> = {}): HttpResponseMetadata {
  return { url: "https://site.example.test/", status, headers: headers as IncomingHttpHeaders };
}

describe("controllo della home pubblicata", () => {
  it("conferma HTML e non mostra parametri dell’indirizzo", async () => {
    const probe = vi.fn(async (url: URL) => ({ ...response(200, { "content-type": "text/html; charset=utf-8" }), url: url.href }));
    await expect(checkPublishedHome("https://site.example.test/?token=segreto", probe)).resolves.toMatchObject({
      status: "ok",
      url: "https://site.example.test/",
      contentType: "text/html",
    });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("segnala allegato, MIME non HTML e stato HTTP fallito", async () => {
    await expect(checkPublishedHome("https://site.example.test/", async () => response(200, {
      "content-type": "text/html",
      "content-disposition": "attachment; filename=download",
    }))).resolves.toMatchObject({ status: "warning", contentDisposition: expect.stringContaining("attachment"), message: expect.stringContaining("allegato") });

    await expect(checkPublishedHome("https://site.example.test/", async () => response(200, { "content-type": "application/octet-stream" })))
      .resolves.toMatchObject({ status: "warning", contentType: "application/octet-stream", message: expect.stringContaining("Content-Type") });

    await expect(checkPublishedHome("https://site.example.test/", async () => response(404, { "content-type": "text/html" })))
      .resolves.toMatchObject({ status: "warning", statusCode: 404 });

    await expect(checkPublishedHome("https://site.example.test/", async () => response(204, { "content-type": "text/html" })))
      .resolves.toMatchObject({ status: "warning", statusCode: 204, message: expect.stringContaining("pagina consultabile") });

    await expect(checkPublishedHome("https://site.example.test/", async () => response(206, { "content-type": "text/html" })))
      .resolves.toMatchObject({ status: "ok", statusCode: 206 });
  });

  it("segue pochi redirect HTTPS della stessa origine e blocca quelli esterni", async () => {
    const sameOrigin = vi.fn(async (url: URL) => url.pathname === "/"
      ? { ...response(302, { location: "/home/" }), url: url.href }
      : { ...response(200, { "content-type": "text/html" }), url: url.href });
    await expect(checkPublishedHome("https://site.example.test/", sameOrigin)).resolves.toMatchObject({ status: "ok", url: "https://site.example.test/home/" });
    expect(sameOrigin).toHaveBeenCalledTimes(2);

    const external = vi.fn(async (url: URL) => ({ ...response(302, { location: "https://other.example.test/" }), url: url.href }));
    await expect(checkPublishedHome("https://site.example.test/", external)).resolves.toMatchObject({ status: "warning", message: expect.stringContaining("non segue") });
    expect(external).toHaveBeenCalledOnce();
  });

  it("non controlla indirizzi privati né destinazioni senza HTTPS", async () => {
    await expect(checkPublishedHome("https://127.0.0.1/")).resolves.toMatchObject({ status: "warning", message: expect.stringContaining("in modo sicuro") });
    await expect(checkPublishedHome("http://site.example.test/")).resolves.toMatchObject({ status: "unavailable", message: expect.stringContaining("HTTPS") });
    await expect(checkPublishedHome()).resolves.toMatchObject({ status: "unavailable" });
  });
});
