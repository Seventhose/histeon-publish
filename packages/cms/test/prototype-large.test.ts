import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { CmsProjectCatalog } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype, PrototypeError, type PrototypeImportProgress } from "../src/prototype-import.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newCatalog(): Promise<CmsProjectCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-prototype-large-"));
  roots.push(root);
  const catalog = new CmsProjectCatalog(root);
  await catalog.initialize();
  return catalog;
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function prototype(input: { pages: number; records: number; remote: number }): string {
  const assets = Array.from({ length: input.remote }, (_, index) => ({ name: `foto-${index}`, url: `https://example.com/foto-${index}.png`, alt: `Foto ${index}` }));
  const content = {
    types: [{ key: "opera", label: "Opere", fields: [{ key: "prezzo", label: "Prezzo", type: "decimal", required: false, public: true, multiple: false }] }],
    records: Array.from({ length: input.records }, (_, index) => ({ type: "opera", slug: `opera-${index}`, title: `Opera ${index}`, status: "published", publishedAt: "2026-10-02T09:00:00Z", order: index, values: { prezzo: index } })),
  };
  const pages = Array.from({ length: input.pages }, (_, index) => `<template data-histos="page" data-slug="${index === 0 ? "home" : `pagina-${index}`}" data-title="Pagina ${index}"><main><h1>Pagina ${index}</h1>${index < input.remote ? `<img src="asset:foto-${index}" alt="Foto">` : ""}</main></template>`).join("\n");
  return `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>Grande</title>
<script data-histos="manifest" type="application/json">{"format":"histos-prototype","version":1,"id":"6b2f3c1e-1d3a-4c55-9a1b-2c3d4e5f6a7b","name":"Grande","framework":"none","locale":"it-IT"}</script>
${assets.length ? `<script data-histos="assets" type="application/json">${JSON.stringify(assets)}</script>` : ""}
<script data-histos="content" type="application/json">${JSON.stringify(content)}</script>
</head><body>
${pages}
</body></html>`;
}

describe("prototipi grandi (D3)", () => {
  it("scarica i media quattro alla volta e dice a che punto è", async () => {
    let running = 0;
    let most = 0;
    const progress: PrototypeImportProgress[] = [];
    const built = await buildPrototypeProfile(parsePrototype(prototype({ pages: 12, records: 0, remote: 12 })), await newCatalog(), {
      fetchAsset: async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 15));
        running--;
        return PNG;
      },
      onProgress: (item) => progress.push(item),
    });
    expect(built.report.downloaded).toBe(12);
    expect(most).toBe(4);
    expect(progress.filter((item) => item.phase === "media").at(-1)).toEqual({ phase: "media", done: 12, total: 12 });
  });

  it("al primo media che non si scarica ferma gli altri e dice quale", async () => {
    const aborted: string[] = [];
    const attempt = buildPrototypeProfile(parsePrototype(prototype({ pages: 12, records: 0, remote: 12 })), await newCatalog(), {
      fetchAsset: async (url, _max, signal) => {
        if (url.endsWith("foto-2.png")) throw new Error("HTTP 404");
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (signal?.aborted) aborted.push(url);
        return PNG;
      },
    });
    await expect(attempt).rejects.toThrow(/Media foto-2: non scaricato \(HTTP 404\)/u);
    expect(aborted.length).toBeGreaterThan(0);
  });

  it("migliaia di record e pagine: avanza a gruppi e si può annullare a metà", async () => {
    const html = prototype({ pages: 300, records: 900, remote: 0 });
    const progress: PrototypeImportProgress[] = [];
    const built = await buildPrototypeProfile(parsePrototype(html), await newCatalog(), { onProgress: (item) => progress.push(item) });
    expect(built.report.counts).toMatchObject({ pages: 300, records: 900 });
    expect(progress.some((item) => item.phase === "records" && item.done === 900)).toBe(true);
    expect(progress.some((item) => item.phase === "documents" && item.total === 300)).toBe(true);

    const controller = new AbortController();
    const cancelled = buildPrototypeProfile(parsePrototype(html), await newCatalog(), {
      signal: controller.signal,
      onProgress: (item) => { if (item.phase === "records" && item.done >= 200) controller.abort(new Error("Import annullato.")); },
    });
    await expect(cancelled).rejects.toThrow(/annullato/u);
  });

  it("i limiti valgono mentre scarica: oltre 200 MB in tutto si ferma, senza scaricare il resto", async () => {
    // One 14 MB buffer returned every time: the test measures calls, not memory.
    const big = Buffer.alloc(14 * 1024 * 1024);
    PNG.copy(big);
    let calls = 0;
    const attempt = buildPrototypeProfile(parsePrototype(prototype({ pages: 1, records: 0, remote: 40 })), await newCatalog(), {
      fetchAsset: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 2));
        return big;
      },
    });
    await expect(attempt).rejects.toThrow(/superano 200 MB in tutto/u);
    // 15 downloads pass the limit; at most the three others already running finish.
    expect(calls).toBeLessThanOrEqual(18);
  });

  it("un media oltre i 15 MB ferma lo scaricamento, anche se chi scarica non rispetta il limite", async () => {
    const attempt = buildPrototypeProfile(parsePrototype(prototype({ pages: 1, records: 0, remote: 8 })), await newCatalog(), {
      fetchAsset: async () => Buffer.alloc(15 * 1024 * 1024 + 1),
    });
    await expect(attempt).rejects.toThrow(/Media foto-\d: supera 15 MB/u);
  });

  it("migliaia di problemi in tutti i documenti: tiene quelli da elencare e conta gli altri, senza tenerli", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    // 250 pages of 1,000 problems each: 250,000 problems, of which the report lists 100.
    const page = (index: number) => `<template data-histos="page" data-slug="${index === 0 ? "home" : `pagina-${index}`}" data-title="Pagina ${index}">${"<x/>".repeat(1_000)}</template>`;
    const html = prototype({ pages: 1, records: 0, remote: 0 }).replace(/<template data-histos="page"[\s\S]*<\/template>/u, Array.from({ length: 250 }, (_, index) => page(index)).join("\n"));
    const parsed = parsePrototype(html);
    gc();
    const before = process.memoryUsage().heapUsed;
    let held: number | undefined;
    const error = await buildPrototypeProfile(parsed, await newCatalog(), {
      onProgress: (item) => {
        // 199 documents read, nearly 200,000 problems met: what the build still holds of them.
        if (item.phase !== "documents" || item.done !== 200) return;
        gc();
        held = process.memoryUsage().heapUsed - before;
      },
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PrototypeError);
    expect((error as PrototypeError).total).toBe(250_000);
    expect((error as PrototypeError).issues).toHaveLength(100);
    // Holding every problem met took about 40 MB here; a hundred of them (and what the build holds anyway) nearly nothing.
    expect(held).toBeLessThan(12 * 1024 * 1024);
  }, 120_000);

  it("legge componenti e template lasciando rispondere il server: si può annullare a metà", async () => {
    // Tracks which components the build reads, and cancels while it reads them (no progress is reported there).
    const run = async (count: number, size: number, cancelAt: number) => {
      const components = Array.from({ length: count }, (_, index) => `<template data-histos="component" data-ref="c${index}"><p>${"a".repeat(size)}</p></template>`).join("\n");
      const parsed = parsePrototype(prototype({ pages: 1, records: 0, remote: 0 }).replace("</body>", `${components}\n</body>`));
      const controller = new AbortController();
      const read = new Set<number>();
      parsed.documents = parsed.documents.map((item) => {
        const index = item.kind === "component" ? Number(item.attributes["data-ref"]!.slice(1)) : -1;
        if (index < 0) return item;
        const source = item.source;
        return Object.defineProperty({ ...item }, "source", {
          get: () => {
            read.add(index);
            if (index === cancelAt) controller.abort(new Error("Import annullato."));
            return source;
          },
        });
      });
      await expect(buildPrototypeProfile(parsed, await newCatalog(), { signal: controller.signal })).rejects.toThrow(/annullato/u);
      return read;
    };
    // Every 100 components, as for pages and records.
    const many = await run(250, 10, 20);
    expect(many.has(98)).toBe(true);
    expect(many.has(150)).toBe(false);
    // And after every 256 KB of templates read, however few the components.
    const large = await run(6, 200_000, 0);
    expect(large.has(1)).toBe(true);
    expect(large.has(3)).toBe(false);
  }, 120_000);

  it("crea migliaia di componenti lasciando rispondere il server: si può annullare a metà", async () => {
    const components = Array.from({ length: 250 }, (_, index) => `<template data-histos="component" data-ref="c${index}" data-title="C${index}"><p>x</p></template>`).join("\n");
    const parsed = parsePrototype(prototype({ pages: 1, records: 0, remote: 0 }).replace("</body>", `${components}\n</body>`));
    const controller = new AbortController();
    const created = new Set<number>();
    parsed.documents = parsed.documents.map((item) => {
      const index = item.kind === "component" ? Number(item.attributes["data-ref"]!.slice(1)) : -1;
      if (index < 0) return item;
      // The title is first read where the component is created: that tells which ones were, and cancels at the 21st.
      const attributes = { ...item.attributes };
      const title = attributes["data-title"];
      Object.defineProperty(attributes, "data-title", {
        enumerable: true,
        get: () => {
          created.add(index);
          if (index === 20) controller.abort(new Error("Import annullato."));
          return title;
        },
      });
      return { ...item, attributes };
    });
    await expect(buildPrototypeProfile(parsed, await newCatalog(), { signal: controller.signal })).rejects.toThrow(/annullato/u);
    // Every 100 components, as for pages and records: before, all 250 were created in one stretch.
    expect(created.has(98)).toBe(true);
    expect(created.has(150)).toBe(false);
  }, 120_000);

  it("con il segnale già annullato non scarica nulla", async () => {
    const controller = new AbortController();
    controller.abort(new Error("già annullato"));
    let calls = 0;
    const attempt = buildPrototypeProfile(parsePrototype(prototype({ pages: 1, records: 0, remote: 8 })), await newCatalog(), {
      signal: controller.signal,
      fetchAsset: async () => {
        calls++;
        return PNG;
      },
    });
    await expect(attempt).rejects.toThrow(/già annullato/u);
    expect(calls).toBe(0);
  });
});
