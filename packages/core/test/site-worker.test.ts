import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { addFoundKvDeclarations, buildBundle, createSiteWorkerWrapperSource, kvBindingsForDeploy, kvDeclarationForFound, kvBindingsInWorker, planCloudflareManifest, SITE_WORKER_PATH, validateKvBindingNames, validateSiteWorker } from "../src/index.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "histos-site-worker-"));
  temporary.push(directory);
  return directory;
}

/** A site Worker in the shape of the logo vote: KV VOTI, /api/voto, everything else to the static files. */
const VOTE_WORKER = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/voto") return;
    const who = request.headers.get("x-votante") || "anonimo";
    if (request.method === "POST") {
      const body = await request.json();
      await env.VOTI.put("voto:" + who, String(body.logo));
    }
    const mio = await env.VOTI.get("voto:" + who);
    return Response.json({ mio });
  }
};
`;

/** Loads Publish's wrapper and a site Worker as real ES modules, the way Cloudflare links them. */
async function loadWorker(siteWorker: string, forms?: { restUrl: string; fluentFormIds: number[] }) {
  const directory = await folder();
  await writeFile(path.join(directory, "worker.mjs"), createSiteWorkerWrapperSource(forms).replace('"./_worker.js"', '"./_worker.mjs"'));
  await writeFile(path.join(directory, "_worker.mjs"), siteWorker);
  const module = await import(pathToFileURL(path.join(directory, "worker.mjs")).href) as { default: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>; scheduled?: unknown } };
  return module.default;
}

function environment() {
  const store = new Map<string, string>();
  const assetRequests: string[] = [];
  return {
    store,
    assetRequests,
    env: {
      ASSETS: {
        async fetch(input: Request | string) {
          const url = typeof input === "string" ? input : input.url;
          assetRequests.push(new URL(url).pathname);
          const pathname = new URL(url).pathname;
          if (pathname === "/" || pathname === "/index.html") return new Response("<h1>voto</h1>", { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment" } });
          return new Response("non trovato", { status: 404 });
        },
      },
      VOTI: {
        async get(key: string) { return store.get(key) ?? null; },
        async put(key: string, value: string) { store.set(key, value); },
      },
    },
  };
}

describe("codice del Worker del sito", () => {
  it("accetta un modulo con export default e rifiuta il resto con un messaggio chiaro", () => {
    expect(validateSiteWorker(Buffer.from(VOTE_WORKER))).toBe(VOTE_WORKER);
    expect(() => validateSiteWorker(Buffer.alloc(0))).toThrow(/vuoto/u);
    expect(() => validateSiteWorker(Buffer.from("addEventListener('fetch', () => {})"))).toThrow(/export default/u);
    expect(() => validateSiteWorker(Buffer.from('import x from "./altro.js";\nexport default { fetch() {} };'))).toThrow(/un solo file/u);
    expect(() => validateSiteWorker(Buffer.from([0xff, 0xfe, 0x00]))).toThrow(/UTF-8/u);
    expect(() => validateSiteWorker(Buffer.alloc(3 * 1024 * 1024 + 1, 32))).toThrow(/3 MiB/u);
    expect(validateSiteWorker(Buffer.from('import { DurableObject } from "cloudflare:workers";\nexport default { fetch() {} };'))).toContain("cloudflare:workers");
  });

  it("controlla i nomi degli archivi KV", () => {
    expect(validateKvBindingNames(["VOTI", " VOTI ", "Cache_2", "ARCHIVIO = voti-logo"])).toEqual(["VOTI", "Cache_2", "ARCHIVIO=voti-logo"]);
    expect(() => validateKvBindingNames(["due parole"])).toThrow(/non è un archivio KV valido/u);
    expect(() => validateKvBindingNames(["VOTI=a=b"])).toThrow(/non è un archivio KV valido/u);
    expect(() => validateKvBindingNames(["VOTI", "VOTI=voti-logo"])).toThrow(/due volte/u);
    expect(() => validateKvBindingNames(["ASSETS"])).toThrow(/riservato/u);
  });

  it("trova nel codice gli archivi KV che usa, senza confonderli con gli altri collegamenti", () => {
    expect(kvBindingsInWorker(VOTE_WORKER)).toEqual(["VOTI"]);
    const code = `export default { async fetch(request, env) {
      const a = await env?.CACHE?.getWithMetadata("k");
      await env . Note_2 . list({ prefix: "n:" });
      await env.SESSIONI.delete("s");
      await env.ASSETS.fetch(request);
      await env.ASSETS.get?.("x");
      const file = await env.FOTO.get("a.jpg"); await env.FOTO.head("a.jpg");
      const stanza = env.STANZE.get(env.STANZE.idFromName("x"));
      await env.DB.prepare("select 1").all();
      await env.CODA.send({});
      env.SEGRETO; env.altro.fetch("x"); environment.FINTO.get("x"); myenv.FINTO2.put("x");
    } };`;
    expect(kvBindingsInWorker(code)).toEqual(["CACHE", "Note_2", "SESSIONI"]);
    expect(kvBindingsInWorker("export default { fetch() {} };")).toEqual([]);
  });

  it("unisce gli archivi dichiarati a quelli trovati nel codice, e la dichiarazione vince", () => {
    expect(kvBindingsForDeploy([], VOTE_WORKER)).toEqual(["VOTI"]);
    expect(kvBindingsForDeploy(["VOTI=voti-logo"], VOTE_WORKER)).toEqual(["VOTI=voti-logo"]);
    expect(kvBindingsForDeploy(["ALTRO"], VOTE_WORKER)).toEqual(["ALTRO", "VOTI"]);
    expect(kvBindingsForDeploy(["ALTRO"])).toEqual(["ALTRO"]);
  });

  it("scrive per ogni archivio trovato nel codice la dichiarazione con il titolo, senza toccare quelle scritte a mano", () => {
    expect(kvDeclarationForFound("VOTI", "loghi", [])).toBe("VOTI=loghi-VOTI");
    expect(kvDeclarationForFound("VOTI", "loghi", [{ title: "voti-logo" }, { title: "altro" }])).toBe("VOTI=voti-logo");
    expect(kvDeclarationForFound("VOTI", "loghi", [{ title: "voti-logo" }, { title: "loghi-VOTI" }])).toBe("VOTI=loghi-VOTI");
    expect(kvDeclarationForFound("VOTI", "loghi", [{ title: "voti-a" }, { title: "voti_b" }])).toBe("VOTI=loghi-VOTI");
    expect(kvDeclarationForFound("VOTI", "loghi", [{ title: "votinuovi" }])).toBe("VOTI=loghi-VOTI");
    expect(kvDeclarationForFound("VOTI", undefined, [{ title: "voti-logo" }])).toBe("VOTI");

    expect(addFoundKvDeclarations([], ["VOTI"], "loghi", [])).toEqual({ kv: ["VOTI=loghi-VOTI"], added: ["VOTI=loghi-VOTI"] });
    expect(addFoundKvDeclarations(["VOTI=mio"], ["VOTI", "CACHE"], "loghi", [])).toEqual({ kv: ["VOTI=mio", "CACHE=loghi-CACHE"], added: ["CACHE=loghi-CACHE"] });
    expect(addFoundKvDeclarations(["VOTI"], ["VOTI"], "loghi", [])).toEqual({ kv: ["VOTI"], added: [] });
  });

  it("passa ogni richiesta al codice del sito e i file statici quando non risponde", async () => {
    const worker = await loadWorker(VOTE_WORKER);
    const { env, store, assetRequests } = environment();
    const vote = await worker.fetch(new Request("https://loghi.example/api/voto", { method: "POST", headers: { "x-votante": "a1", "Content-Type": "application/json" }, body: JSON.stringify({ logo: "05" }) }), env, {});
    expect(await vote.json()).toEqual({ mio: "05" });
    expect(store.get("voto:a1")).toBe("05");

    const again = await worker.fetch(new Request("https://loghi.example/api/voto", { headers: { "x-votante": "a1" } }), env, {});
    expect(await again.json()).toEqual({ mio: "05" });

    const home = await worker.fetch(new Request("https://loghi.example/"), env, {});
    expect(home.status).toBe(200);
    expect(home.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(home.headers.get("Content-Disposition")).toBeNull();
    expect(await home.text()).toBe("<h1>voto</h1>");
    expect(assetRequests).toEqual(["/"]);
    expect(worker.scheduled).toBeUndefined();
  });

  it("dà al codice del sito un env.ASSETS che corregge la home, e lascia /xb-form ai moduli", async () => {
    const worker = await loadWorker(`export default {
  async fetch(request, env) { return env.ASSETS.fetch(request); },
  async scheduled() {}
};
`, { restUrl: "https://wp.example/wp-json/", fluentFormIds: [3] });
    const { env } = environment();
    const home = await worker.fetch(new Request("https://loghi.example/index.html"), env, {});
    expect(home.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const form = await worker.fetch(new Request("https://loghi.example/xb-form"), env, {});
    expect(form.status).toBe(405);
    expect(typeof worker.scheduled).toBe("function");
  });

  it("rifiuta una risposta che non è una Response", async () => {
    const worker = await loadWorker("export default { fetch() { return \"testo\"; } };\n");
    const { env } = environment();
    await expect(worker.fetch(new Request("https://loghi.example/"), env, {})).rejects.toThrow(/Response/u);
  });

  it("aggiunge alla build il file caricato a parte come _worker.js, fuori dagli asset pubblici", async () => {
    const source = await folder();
    await writeFile(path.join(source, "voto.html"), "<!doctype html><html lang=\"it\"><title>Voto</title><h1>Voto</h1></html>");
    const workerFile = path.join(await folder(), "worker.js");
    await writeFile(workerFile, VOTE_WORKER);
    const output = path.join(await folder(), "bundle");
    const result = await buildBundle({ source: { kind: "html", path: path.join(source, "voto.html"), root: source }, workerPath: workerFile, outputDirectory: output });
    expect(result.status).toBe("ready");
    expect(result.worker).toEqual({ origin: "file", bytes: Buffer.byteLength(VOTE_WORKER), kv: ["VOTI"] });
    expect(await readFile(path.join(output, SITE_WORKER_PATH), "utf8")).toBe(VOTE_WORKER);
    const files = [
      { path: "index.html", size: 10, bytes: Buffer.from("<h1>x</h1>") },
      { path: SITE_WORKER_PATH, size: Buffer.byteLength(VOTE_WORKER), bytes: Buffer.from(VOTE_WORKER) },
    ];
    expect(Object.keys(planCloudflareManifest(files))).toEqual(["/index.html"]);
  });

  it("riconosce _worker.js in una cartella, rifiuta il doppione e avvisa per un worker.js pubblico", async () => {
    const site = await folder();
    await writeFile(path.join(site, "index.html"), "<!doctype html><html lang=\"it\"><title>Voto</title></html>");
    await writeFile(path.join(site, SITE_WORKER_PATH), VOTE_WORKER);
    const own = await buildBundle({ source: { kind: "directory", path: site }, checkOnly: true });
    expect(own.worker).toEqual({ origin: "source", bytes: Buffer.byteLength(VOTE_WORKER), kv: ["VOTI"] });

    const extra = path.join(await folder(), "altro.js");
    await writeFile(extra, VOTE_WORKER);
    await expect(buildBundle({ source: { kind: "directory", path: site }, workerPath: extra, checkOnly: true })).rejects.toThrow(/tieni uno dei due/u);

    const plain = await folder();
    await mkdir(path.join(plain, "js"));
    await writeFile(path.join(plain, "index.html"), "<!doctype html><html lang=\"it\"><title>Voto</title></html>");
    await writeFile(path.join(plain, "worker.js"), VOTE_WORKER);
    const warned = await buildBundle({ source: { kind: "directory", path: plain }, checkOnly: true });
    expect(warned.worker).toBeUndefined();
    expect(warned.findings.some((finding) => finding.code === "worker-js-public" && finding.severity === "warn")).toBe(true);
  });
});
