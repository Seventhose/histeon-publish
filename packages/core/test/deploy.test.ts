import { describe, expect, it } from "vitest";
import { CLOUDFLARE_WORKER_SOURCE, createFormsWorkerSource, planCloudflareManifest } from "../src/deploy.js";

describe("preflight Cloudflare", () => {
  it("esclude _headers e _redirects dal manifest e mantiene le altre pagine", () => {
    const manifest = planCloudflareManifest([
      { path: "index.html", size: 13, bytes: Buffer.from("<main>ok</main>") },
      { path: "_headers", size: 29, bytes: Buffer.from("/*\n  X-Frame-Options: DENY\n") },
      { path: "_redirects", size: 26, bytes: Buffer.from("/old/ /new/ 301\n") },
    ]);
    expect(Object.keys(manifest)).toEqual(["/index.html"]);
  });

  it("blocca la pubblicazione se manca la home index.html", () => {
    expect(() => planCloudflareManifest([
      { path: "about.html", size: 4, bytes: Buffer.from("about") },
    ])).toThrowError(expect.objectContaining({ code: "cloudflare-home-missing" }));
  });

  it("rifiuta un numero di regole _headers oltre il limite documentato", () => {
    const rules = Array.from({ length: 101 }, (_, index) => `/path-${index}\n  X-Test: yes`).join("\n");
    expect(() => planCloudflareManifest([
      { path: "index.html", size: 4, bytes: Buffer.from("<h1>x</h1>") },
      { path: "_headers", size: Buffer.byteLength(rules), bytes: Buffer.from(rules) },
    ])).toThrow(/100 regole/iu);
  });

  it("rifiuta le regole _redirects dinamiche oltre il limite", () => {
    const rules = Array.from({ length: 101 }, (_, index) => `/old-${index}/* /new-${index}/:splat 301`).join("\n");
    expect(() => planCloudflareManifest([
      { path: "index.html", size: 4, bytes: Buffer.from("<h1>x</h1>") },
      { path: "_redirects", size: Buffer.byteLength(rules), bytes: Buffer.from(rules) },
    ])).toThrow(/limiti Cloudflare/iu);
  });

  it("applica il limite predefinito da 20.000 file senza conoscere il piano dell’account", () => {
    expect(() => planCloudflareManifest([
      { path: "index.html", size: 4, bytes: Buffer.from("<h1>x</h1>") },
      { path: "a.js", size: 1, bytes: Buffer.from("x") },
    ], 1)).toThrow(/oltre il limite configurato di 1/iu);
  });

  it("forza la home HTML inline in entrambi i Worker Cloudflare", async () => {
    const sources = [
      CLOUDFLARE_WORKER_SOURCE,
      createFormsWorkerSource({ restUrl: "https://wp.example.test/wp-json/", fluentFormIds: [123] }),
    ];

    for (const source of sources) {
      const worker = new Function(source.replace("export default {", "return {"))() as {
        fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }): Promise<Response>;
      };
      for (const pathname of ["/", "/index.html"]) {
        const response = await worker.fetch(new Request(`https://site.example.test${pathname}`), {
          ASSETS: {
            fetch: async () => new Response("<!doctype html><title>Histeon</title>", {
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Disposition": 'attachment; filename="download"',
                "X-Test-Asset": "preserved",
              },
            }),
          },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
        expect(response.headers.get("Content-Disposition")).toBeNull();
        expect(response.headers.get("X-Test-Asset")).toBe("preserved");
        await expect(response.text()).resolves.toBe("<!doctype html><title>Histeon</title>");
      }
    }
  });
});
