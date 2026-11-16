import { describe, expect, it } from "vitest";
import { assetContentType, assetExtension } from "../src/asset-types.js";
import { assetHash, createManifest } from "../src/manifest.js";

describe("estensione e tipo degli asset", () => {
  it("dà l'estensione dopo l'ultimo punto del nome del file, vuota senza estensione", () => {
    expect(assetExtension("js/app.mjs")).toBe("mjs");
    expect(assetExtension("vendor/pdfjs/LICENSE")).toBe("");
    expect(assetExtension("a.b/file")).toBe("");
    expect(assetExtension("CNAME")).toBe("");
    expect(assetExtension("archivio.tar.gz")).toBe("gz");
  });

  it("il manifest usa la stessa estensione dell'upload, anche per i file senza estensione", () => {
    const bytes = Buffer.from("licenza");
    const manifest = createManifest([{ path: "vendor/pdfjs/LICENSE", size: bytes.byteLength, bytes }]);
    expect(manifest["/vendor/pdfjs/LICENSE"]?.hash).toBe(assetHash(bytes, "", "application/octet-stream"));
  });

  it("il tipo entra nell'impronta: un file caricato col tipo sbagliato viene ricaricato col tipo giusto", () => {
    const bytes = Buffer.from("export const a = 1;");
    const manifest = createManifest([{ path: "js/app.mjs", size: bytes.byteLength, bytes }]);
    expect(manifest["/js/app.mjs"]?.hash).toBe(assetHash(bytes, "mjs", "text/javascript; charset=utf-8"));
    expect(manifest["/js/app.mjs"]?.hash).not.toBe(assetHash(bytes, "mjs"));
    expect(assetHash(bytes, "mjs", "text/javascript; charset=utf-8")).not.toBe(assetHash(bytes, "mjs", "application/octet-stream"));
  });

  it("dà il tipo con cui Cloudflare servirà il file, octet-stream per l'ignoto", () => {
    expect(assetContentType("js/app.mjs")).toBe("text/javascript; charset=utf-8");
    expect(assetContentType("css/arch.css")).toBe("text/css; charset=utf-8");
    expect(assetContentType("index.HTML")).toBe("text/html; charset=utf-8");
    expect(assetContentType("manifest.webmanifest")).toBe("application/manifest+json; charset=utf-8");
    expect(assetContentType("icons/icon-192.png")).toBe("image/png");
    expect(assetContentType("fonts/a.woff2")).toBe("font/woff2");
    expect(assetContentType("vendor/pdfjs/LICENSE")).toBe("application/octet-stream");
  });
});
