import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, parseXb, serializeXb } from "../.generated/histos-dsl/index.js";
import { createStaticPageProfile } from "../src/page-transfer.js";
import { encodeNativeProjectArchive } from "../src/project-archive.js";
import { CmsProjectCatalog, componentCalls, scanComponentCalls, type CmsProjectStore } from "../src/project-repository.js";
import { buildPrototypeProfile, parsePrototype, verifyPrototypeProfile } from "../src/prototype-import.js";

/** How many times the store called parseXb (counted, then passed on to the real one). */
const dsl = vi.hoisted(() => ({ parseXbCalls: 0 }));
vi.mock("../.generated/histos-dsl/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../.generated/histos-dsl/index.js")>();
  return { ...original, parseXb: (...args: Parameters<typeof original.parseXb>) => { dsl.parseXbCalls++; return original.parseXb(...args); } };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newCatalog() {
  const root = await mkdtemp(path.join(os.tmpdir(), "histos-component-graph-"));
  roots.push(root);
  return new CmsProjectCatalog(root);
}

async function newStore() {
  return (await (await newCatalog()).createProject("Grafo dei componenti")).store;
}

const calling = (...refs: string[]) => serializeXb(parse(refs.map((ref) => `<${ref.split("/").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(".")} />`).join("") || "<p>x</p>").blocks);

/** A recoverable local deletion, as the app's local Trash writes it (the row stays, hidden). */
function deleteLocally(store: CmsProjectStore, ...ids: string[]): void {
  const database = new DatabaseSync(path.join(store.directory, "content.sqlite"));
  try {
    for (const id of ids) database.prepare("INSERT INTO transfer_tombstones(id, entity_kind, deleted_at, entity_json, scope) SELECT id, kind, ?, '{}', 'local' FROM cms_components WHERE id = ?").run(new Date().toISOString(), id);
  } finally { database.close(); }
}

function save(store: CmsProjectStore, ref: string, content: string) {
  const component = store.getComponentByRef(ref);
  if (!component) throw new Error(`Manca ${ref}.`);
  return store.saveComponent({ alias: component.alias, expectedHead: component.headRevision, ref, content, schema: component.schema });
}

/** The refs a document calls, in order (its block uids are random). */
const refsIn = (content: string | undefined) => [...(content ?? "").matchAll(/"ref":"([^"]+)"/gu)].map((match) => match[1]);

/** Ids in the order a profile lists its entities, so that a caller can come before what it calls. */
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

describe("grafo dei componenti (coda D3: migliaia di componenti)", () => {
  it("rifiuta come prima chiamate a componenti che non esistono e cicli, diretti, indiretti o attraverso una parte", async () => {
    const store = await newStore();
    expect(() => store.createComponent({ ref: "ui/a", title: "A", content: calling("ui/nessuno") })).toThrow(/ui\/a richiama ui\/nessuno, che non esiste nel progetto/u);
    const a = store.createComponent({ ref: "ui/a", title: "A" });
    // A component that calls itself, at its creation or once saved.
    expect(() => store.createComponent({ ref: "ui/self", title: "Sé", content: calling("ui/self") })).toThrow(/non possono richiamarsi/u);
    expect(() => store.saveComponent({ alias: a.alias, expectedHead: a.headRevision, ref: a.ref, content: calling("ui/a"), schema: a.schema })).toThrow(/non possono richiamarsi/u);
    // a → b → part c → a.
    const c = store.createTemplatePart({ ref: "site/c", title: "C", content: calling("ui/a") });
    store.createComponent({ ref: "ui/b", title: "B", content: calling("site/c") });
    expect(() => store.saveComponent({ alias: a.alias, expectedHead: a.headRevision, ref: a.ref, content: calling("ui/b"), schema: a.schema })).toThrow(/non possono richiamarsi/u);
    // Nothing of the refused saves stays; a call that closes no cycle is saved.
    expect(store.getComponentById(a.id)?.content).toBe("");
    const d = store.createComponent({ ref: "ui/d", title: "D" });
    expect(store.saveComponent({ alias: a.alias, expectedHead: a.headRevision, ref: a.ref, content: calling("ui/d", "ui/d"), schema: a.schema }).status).toBe("saved");
    expect(() => store.saveComponent({ alias: d.alias, expectedHead: d.headRevision, ref: d.ref, content: calling("site/c"), schema: d.schema })).toThrow(/non possono richiamarsi/u);
    expect(() => store.saveComponent({ alias: c.alias, expectedHead: c.headRevision, ref: c.ref, content: calling("ui/nessuno"), schema: c.schema })).toThrow(/site\/c richiama ui\/nessuno, che non esiste/u);
    // A template is no node of the graph: it calls components, nothing calls it.
    expect(store.createTemplate({ ref: "site/page", title: "Pagina", content: serializeXb(parse("<Ui.A /><main>{@slot}</main>").blocks) }).ref).toBe("site/page");
    store.close();
  });

  it("un salvataggio legge solo i componenti che raggiunge, non tutti quelli del progetto ogni volta", async () => {
    const store = await newStore();
    for (let index = 0; index < 300; index++) store.createComponent({ ref: `ui/c${index}`, title: `C${index}` });
    const leaf = store.createComponent({ ref: "ui/leaf", title: "Foglia" });
    const top = store.createComponent({ ref: "ui/top", title: "Cima" });
    // Statements prepared by one save: before, every save read every component of the project (two queries each).
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(store.saveComponent({ alias: top.alias, expectedHead: top.headRevision, ref: top.ref, content: calling("ui/leaf"), schema: top.schema }).status).toBe("saved");
    expect(prepare.mock.calls.length).toBeLessThan(40);
    prepare.mockClear();
    store.createComponent({ ref: "ui/new", title: "Nuovo", content: calling("ui/top", "ui/leaf") });
    expect(prepare.mock.calls.length).toBeLessThan(40);
    prepare.mockRestore();
    expect(store.getComponentById(leaf.id)?.ref).toBe("ui/leaf");
    store.close();
  });

  it("un componente che chiama un componente cancellato non blocca il salvataggio degli altri", async () => {
    const store = await newStore();
    const gone = store.createComponent({ ref: "ui/gone", title: "Cancellato" });
    store.createComponent({ ref: "ui/user", title: "Lo usa", content: calling("ui/gone") });
    const other = store.createComponent({ ref: "ui/other", title: "Altro" });
    // A transfer deletion keeps the row and hides it: ui/user now calls nothing.
    const database = new DatabaseSync(path.join(store.directory, "content.sqlite"));
    database.prepare("INSERT INTO transfer_tombstones(id, entity_kind, deleted_at, entity_json, scope) VALUES (?, 'component', ?, '{}', 'local')").run(gone.id, new Date().toISOString());
    database.close();
    // Before, every save checked every component, so this one failed on ui/user's call.
    expect(store.saveComponent({ alias: other.alias, expectedHead: other.headRevision, ref: other.ref, content: serializeXb(parse("<p>nuovo</p>").blocks), schema: other.schema }).status).toBe("saved");
    store.close();
  });

  it("rifiuta il ripristino di un componente che chiuderebbe un ciclo, e la cancellazione resta com'era", async () => {
    const store = await newStore();
    try {
      store.createComponent({ ref: "ui/c", title: "C" });
      const b = store.createComponent({ ref: "ui/b", title: "B", content: calling("ui/c") });
      const a = store.createComponent({ ref: "ui/a", title: "A", content: calling("ui/b") });
      const part = store.createTemplatePart({ ref: "site/p", title: "P", content: calling("ui/a") });
      deleteLocally(store, a.id, b.id, part.id);
      // ui/a calls ui/b, still deleted: that call is no edge, and the user restores them in any order.
      expect(store.restoreTransferTombstone(a.id)).toBe(true);
      // While ui/b is deleted nothing reaches ui/c from ui/a, so ui/c may call ui/a.
      expect(save(store, "ui/c", calling("ui/a")).status).toBe("saved");
      // Before: restored, leaving ui/a → ui/b → ui/c → ui/a; every later save of one of them was refused, nothing else saw it.
      expect(() => store.restoreTransferTombstone(b.id)).toThrow("Non è possibile ripristinare il componente ui/b: chiuderebbe un ciclo di richiami (ui/b → ui/c → ui/a → ui/b), e i componenti Histeon non possono richiamarsi in modo ricorsivo. Togli prima uno di questi richiami, per esempio quello a ui/b in ui/a, poi ripristinalo.");
      expect(store.isTransferEntityDeleted(b.id)).toBe(true);
      expect(store.getComponentById(b.id)).toBeNull();
      // A part is restored under the same check: site/p → ui/a → ui/b (deleted) closes nothing.
      expect(store.restoreTransferTombstone(part.id)).toBe(true);
      // Once a call of the cycle is gone, ui/b comes back with its calls.
      expect(save(store, "ui/c", calling()).status).toBe("saved");
      expect(store.restoreTransferTombstone(b.id)).toBe(true);
      expect(refsIn(store.getComponentById(b.id)?.content)).toEqual(["ui/c"]);
      expect(() => save(store, "ui/c", calling("site/p"))).toThrow(/non possono richiamarsi/u);
    } finally { store.close(); }
  });

  it("un template cerca solo i componenti che richiama, non legge tutti quelli del progetto", async () => {
    const store = await newStore();
    try {
      for (let index = 0; index < 300; index++) store.createComponent({ ref: `ui/c${index}`, title: `C${index}` });
      const deleted = store.createComponent({ ref: "ui/gone", title: "Cancellato" });
      deleteLocally(store, deleted.id);
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const template = store.createTemplate({ ref: "site/page", title: "Pagina", content: serializeXb(parse("<Ui.C7 /><Ui.C7 /><main>{@slot}</main>").blocks) });
      // Before: listComponents, two statements for each of the 301 components, at each template created or saved.
      expect(prepare.mock.calls.length).toBeLessThan(30);
      prepare.mockClear();
      expect(save(store, template.ref, serializeXb(parse("<Ui.C8 /><main>{@slot}</main>").blocks)).status).toBe("saved");
      expect(prepare.mock.calls.length).toBeLessThan(30);
      prepare.mockRestore();
      // Still refused: a ref that names nothing, or a deleted component.
      expect(() => save(store, template.ref, serializeXb(parse("<Ui.Nessuno /><main>{@slot}</main>").blocks))).toThrow("Il template richiama ui/nessuno, che non è un componente o una parte del template di questo progetto.");
      expect(() => save(store, template.ref, serializeXb(parse("<Ui.Gone /><main>{@slot}</main>").blocks))).toThrow(/Il template richiama ui\/gone, che non è un componente/u);
    } finally { store.close(); }
  });

  it("in una transazione controlla in tempo lineare una catena creata in ordine di dipendenza, senza perdere cicli", async () => {
    const store = await newStore();
    const count = 600;
    try {
      const reads = vi.spyOn(StatementSync.prototype, "get");
      await store.atomic(() => {
        for (let index = 0; index < count; index++) store.createComponent({ ref: `ui/c${index}`, title: `C${index}`, content: index ? calling(`ui/c${index - 1}`) : calling() });
      });
      // Before: each creation walked every component before it, about 180,000 reads; now a few per creation.
      expect(reads.mock.calls.length).toBeLessThan(count * 15);
      reads.mockRestore();
      await store.atomic(async () => {
        // The transaction's checks read the chain until its index of calls is built (each component has a caller).
        for (const index of [count - 1, count - 2, count - 3]) save(store, `ui/c${index}`, calling(`ui/c${index - 1}`, `ui/c${index - 1}`));
        expect((store as unknown as { graphIndex: unknown }).graphIndex).toBeTruthy();
        // A new component's calls enter the index: ui/top calls ui/c599, which nothing else calls, so ui/c599 cannot
        // call ui/top (an index without them would see no caller of ui/c599 and skip the walk).
        store.createComponent({ ref: "ui/top", title: "Cima", content: calling(`ui/c${count - 1}`) });
        expect((store as unknown as { graphIndex: unknown }).graphIndex).toBeTruthy();
        expect(() => save(store, `ui/c${count - 1}`, calling("ui/top"))).toThrow(/non possono richiamarsi/u);
        expect(() => save(store, "ui/c0", calling("ui/top"))).toThrow(/non possono richiamarsi/u);
        // A save undone with its savepoint: ui/c300 calls ui/c299 again, and the index must not still say it does not.
        await expect(store.atomic(() => {
          save(store, "ui/c300", calling());
          throw new Error("annulla");
        })).rejects.toThrow("annulla");
        expect(refsIn(store.getComponentByRef("ui/c300")?.content)).toEqual(["ui/c299"]);
        expect(() => save(store, "ui/c299", calling("ui/c300"))).toThrow(/non possono richiamarsi/u);
        expect(save(store, "ui/top", calling()).status).toBe("saved");
        expect(save(store, "ui/c0", calling("ui/top")).status).toBe("saved");
      });
    } finally { store.close(); }
  });

  it("un ripristino dentro una transazione rimette nel controllo i richiami del componente ripristinato", async () => {
    const store = await newStore();
    try {
      for (let index = 0; index < 300; index++) store.createComponent({ ref: `ui/c${index}`, title: `C${index}`, content: index ? calling(`ui/c${index - 1}`) : calling() });
      const middle = store.getComponentByRef("ui/c150")!;
      deleteLocally(store, middle.id);
      await store.atomic(() => {
        // Enough reading for the index: built without ui/c150, which is deleted.
        for (const index of [299, 298, 297]) save(store, `ui/c${index}`, calling(`ui/c${index - 1}`, `ui/c${index - 1}`));
        expect((store as unknown as { graphIndex: unknown }).graphIndex).toBeTruthy();
        expect(store.restoreTransferTombstone(middle.id)).toBe(true);
        // ui/c150 calls ui/c149 again: an index without its calls would let ui/c149 call ui/c150 unchecked.
        expect(() => save(store, "ui/c149", calling("ui/c150"))).toThrow(/non possono richiamarsi/u);
      });
    } finally { store.close(); }
  });

  it("importa un progetto i cui componenti e parti si richiamano, qualunque sia l'ordine dei loro id", async () => {
    const origin = await (await newCatalog()).createProject("Componenti annidati");
    const target = await newCatalog();
    const remoteSite = "6b2f3c1e-1d3a-4c55-9a1b-2c3d4e5f6a7c";
    try {
      // A profile lists entities by id: here every caller comes before what it calls, and a component calls a part.
      origin.store.createTemplatePart({ id: id(4), ref: "site/p", title: "P" });
      origin.store.createComponent({ id: id(3), ref: "ui/c", title: "C", content: calling("site/p") });
      origin.store.createComponent({ id: id(2), ref: "ui/b", title: "B", content: calling("ui/c") });
      origin.store.createComponent({ id: id(1), ref: "ui/a", title: "A", content: calling("ui/b", "ui/c") });
      origin.store.createTemplate({ id: id(0), ref: "site/page", title: "Pagina", content: serializeXb(parse("<Ui.A /><main>{@slot}</main>").blocks) });
      const first = await createStaticPageProfile(origin.project, origin.store);
      // Before: «Il componente ui/a richiama ui/b, che non esiste nel progetto.»
      const imported = await target.importRemoteStaticPageProfile(first.profile, first.files, remoteSite);
      const opened = await target.openProject(imported.project.id);
      try {
        expect(refsIn(opened?.store.getComponentByRef("ui/a")?.content)).toEqual(["ui/b", "ui/c"]);
        expect(refsIn(opened?.store.getComponentByRef("ui/c")?.content)).toEqual(["site/p"]);
      } finally { opened?.store.close(); }
      // An update that adds components calling each other, and an existing one calling a new part.
      origin.store.createComponent({ id: id(6), ref: "ui/e", title: "E" });
      origin.store.createComponent({ id: id(5), ref: "ui/d", title: "D", content: calling("ui/e") });
      origin.store.createTemplatePart({ id: id(7), ref: "site/q", title: "Q" });
      expect(save(origin.store, "ui/b", calling("ui/c", "ui/d", "site/q")).status).toBe("saved");
      const second = await createStaticPageProfile(origin.project, origin.store);
      const updated = await target.importRemoteStaticPageProfile(second.profile, second.files, remoteSite);
      expect(updated.changed).toEqual(expect.arrayContaining([id(2), id(5), id(6), id(7)]));
      const reopened = await target.openProject(imported.project.id);
      try {
        expect(refsIn(reopened?.store.getComponentByRef("ui/b")?.content)).toEqual(["ui/c", "ui/d", "site/q"]);
        expect(refsIn(reopened?.store.getComponentByRef("ui/d")?.content)).toEqual(["ui/e"]);
      } finally { reopened?.store.close(); }
    } finally { origin.store.close(); }
  });

  it("un prototipo con componenti che si richiamano supera il controllo del suo profilo", async () => {
    const tag = (index: number) => `<C${String(index).padStart(4, "0")} />`;
    const prototype = (count: number) => `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>R</title>
<script data-histos="manifest" type="application/json">{"format":"histos-prototype","version":1,"id":"6b2f3c1e-1d3a-4c55-9a1b-2c3d4e5f6a7b","name":"R","framework":"none"}</script>
</head><body>
<template data-histos="page" data-slug="home" data-title="P"><p>x</p>${tag(count - 1)}</template>
${Array.from({ length: count }, (_, index) => `<template data-histos="component" data-ref="c${String(index).padStart(4, "0")}"><div><p>${index}</p>${index ? tag(index - 1) : ""}</div></template>`).join("\n")}
</body></html>`;
    for (const count of [6, 200]) {
      const built = await buildPrototypeProfile(parsePrototype(prototype(count)), await newCatalog());
      // Before: refused by the check of its own profile whenever a caller's id came first («richiama …, che non esiste»).
      await expect(verifyPrototypeProfile(built, await newCatalog())).resolves.toBeUndefined();
    }
  });

  it("un backup con componenti che si richiamano in un ciclo non si salva e non si ripristina, con i ref di qualunque lunghezza", async () => {
    // Refs over 128 characters (a ref has no length limit). Before: the check cut them to 128 and looked the calls up
    // whole, so this cycle was saved in a backup and restored.
    for (const [a, b] of [["ui/a", "ui/b"], [`ui/a${"x".repeat(140)}`, `ui/b${"y".repeat(140)}`]] as const) {
      const { project, store } = await (await newCatalog()).createProject("Ciclo nel backup");
      const target = await newCatalog();
      const shown = (ref: string) => ref.length > 128 ? `${ref.slice(0, 128)}…` : ref;
      const cycle = `${shown(b)} → ${shown(a)} → ${shown(b)}`;
      const files = new Map<string, Buffer>();
      try {
        const created = store.createComponent({ ref: b, title: "B" });
        store.createComponent({ ref: a, title: "A", content: calling(b) });
        // A cycle the app never saves, written into the database directly (as a backup made elsewhere may hold it).
        const database = new DatabaseSync(path.join(project.directory, "content.sqlite"));
        database.prepare("UPDATE cms_component_revisions SET content = ? WHERE id = ?").run(calling(a), created.headRevision);
        database.close();
        // The backup of a project: its user can break the cycle in the builder.
        await expect(encodeNativeProjectArchive(project, store, "test")).rejects.toMatchObject({
          code: "cms-backup-unrestorable",
          status: 422,
          message: `Il database del backup contiene componenti che si richiamano in un ciclo (${cycle}): i componenti Histeon non possono richiamarsi in modo ricorsivo. Togli uno di questi richiami nel builder.`,
        });
        files.set("content.sqlite", await store.createDatabaseSnapshot());
      } finally { store.close(); }
      // A restore has no project to open in the builder: it says so, and what can be done instead. Before: «Togli uno di
      // questi richiami nel builder», with nothing to open.
      const metadata = { id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, schemaVersion: 1 as const };
      const refusal = await target.importNativeProjectBackup({ project: metadata, files }).then(() => null, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(TypeError);
      expect((refusal as TypeError).message).toBe(`Il backup non si può ripristinare: il suo database contiene componenti che si richiamano in un ciclo (${cycle}), e i componenti Histeon non possono richiamarsi in modo ricorsivo. Non è stato creato nessun progetto. Ripristina un altro backup di questo progetto, se ne hai uno (per esempio uno più vecchio).`);
      expect((refusal as TypeError).message).not.toContain("builder");
      expect(await target.listProjects()).toEqual([]);
    }
  });

  it("il controllo di un backup legge i richiami dei componenti senza ricostruirne l'albero (parseXb)", async () => {
    const { project, store } = await (await newCatalog()).createProject("Backup senza parseXb");
    try {
      const body = (index: number) => serializeXb(parse(`<section><h2>Titolo ${index}</h2><ul><li><a href="/x">voce</a></li></ul>${index ? `<Ui.C${index - 1} />` : ""}</section>`).blocks);
      await store.atomic(() => { for (let index = 0; index < 40; index++) store.createComponent({ ref: `ui/c${index}`, title: `C${index}`, content: body(index) }); });
      dsl.parseXbCalls = 0;
      await encodeNativeProjectArchive(project, store, "test");
      // Before: once per component, on every backup the app saves (the one before each update too), each time
      // building and validating the whole tree; the scan reads the same calls in about a quarter of the time.
      expect(dsl.parseXbCalls).toBe(0);
    } finally { store.close(); }
  });

  it("legge i richiami di un documento come parseXb, anche malformato, troppo annidato o con blocchi d'altro tipo", () => {
    // A small deterministic generator (mulberry32): the same documents on every run.
    let seed = 20_261_027;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const xb = ["xb/element", "xb/text", "xb/if", "xb/branch", "xb/loop", "xb/component", "xb/slot", "xb/slot-fill", "xb/raw", "xb/post-content"];
    const others = ["xb/passthrough", "xb/mystery", "paragraph", "core/group", "acme/box"];
    const refAttributes = ['{"ref":"ui/a"}', '{"uid":"abcdefgh12","ref":"ui/b"}', '{"ref":"site/c"}', '{"ref":"UI/x"}', `{"ref":"ui/a${"x".repeat(140)}"}`, '{"ref":7}', "[1,2]", '{"ref": ui/a}', '{"ref":"a--b"}', '{"ref":"ns/a/b"}', '{"ref":"ui/a","props":{"n":{"expr":"1"}}}', '{"ref":"ui/b"} '];
    const otherAttributes = ['{"uid":"abcdefgh12"}', '{"tag":"div"}', "{x}", '{"attributes":{"class":"y"}}', '{"test":"true"}'];
    const name = () => random() < 0.9 ? pick(xb) : pick(others);
    const delimiter = (blockName: string, kind: "open" | "close" | "void") => {
      const attributes = kind === "close" || random() < 0.3 ? "" : blockName === "xb/component" ? `${pick(refAttributes)} ` : `${pick(otherAttributes)} `;
      const space = random() < 0.1 ? "   " : " ";
      const written = blockName.startsWith("core/") && random() < 0.5 ? blockName.slice(5) : blockName;
      return kind === "close" ? `<!--${space}/wp:${written}${space}-->` : `<!--${space}wp:${written} ${attributes}${kind === "void" ? "/" : ""}-->`;
    };
    const documents: string[] = [];
    for (let count = 0; count < 3000; count++) {
      const open: string[] = [];
      let content = "";
      for (let step = Math.floor(random() * 40); step > 0; step--) {
        const roll = random();
        if (roll < 0.3) {
          const blockName = name();
          open.push(blockName);
          content += delimiter(blockName, "open");
        } else if (roll < 0.55) {
          // A closer ends the innermost open block whatever it names, or the parse when none is open.
          const ended = open.pop() ?? name();
          content += delimiter(random() < 0.9 ? ended : name(), "close");
        } else if (roll < 0.85) content += delimiter(name(), "void");
        else if (roll < 0.95) content += pick(["testo", "\n", "  ", "<p>html</p>", "<!-- un commento -->", "<!-- wp:xb/element-->"]);
        else content += '<!-- wp:xb/component {"ref":"ui/a"} /-->';
      }
      if (random() < 0.7) for (let blockName = open.pop(); blockName !== undefined; blockName = open.pop()) content += delimiter(blockName, "close");
      documents.push(content);
    }
    // Nesting around the depth the scan leaves to parseXb (64) and the one past which parseXb refuses (128).
    for (const depth of [62, 63, 64, 65, 66, 126, 127, 128, 129, 130]) {
      const opened = '<!-- wp:xb/element {"tag":"div"} -->'.repeat(depth);
      const call = '<!-- wp:xb/component {"ref":"ui/a"} /-->';
      const closed = "<!-- /wp:xb/element -->".repeat(depth);
      documents.push(opened + call + closed, opened + call, `<!-- wp:xb/text -->${opened}${call}${closed}<!-- /wp:xb/text -->`, `<!-- wp:paragraph -->${opened}${closed}<!-- /wp:paragraph -->${call}`);
    }
    // A loop's branches (D1): parseXb keeps only its {:else}, a last branch without a test, and drops the others.
    const loop = (inner: string) => `<!-- wp:xb/loop {"source":{"kind":"expr","expr":"page.items"},"as":"x"} -->${inner}<!-- /wp:xb/loop -->`;
    const branch = (attributes: string, ref: string) => `<!-- wp:xb/branch ${attributes}--><!-- wp:xb/component {"ref":"${ref}"} /--><!-- /wp:xb/branch -->`;
    const item = '<!-- wp:xb/component {"ref":"ui/a"} /-->';
    documents.push(
      loop(item + branch("", "ui/b")),
      loop(item + branch('{"test":"x"} ', "ui/b")),
      loop(branch("", "ui/b") + item),
      loop(item + branch("", "ui/b") + branch("", "ui/c")),
      loop(item + branch('{"test":7} ', "ui/b")),
    );
    // Documents as the app writes them.
    documents.push(calling("ui/a", "ui/b", "ui/a"), serializeXb(parse("<section><Ui.A /><div><Ui.B /></div></section>").blocks));
    const reference = (content: string) => {
      const refs: string[] = [];
      const pending = [...parseXb(content).blocks].reverse();
      for (let block = pending.pop(); block !== undefined; block = pending.pop()) {
        if (block.name === "xb/component") refs.push(block.attrs.ref);
        if ("children" in block) for (let index = block.children.length - 1; index >= 0; index--) pending.push(block.children[index]!);
      }
      return refs;
    };
    const outcome = (read: () => string[]) => {
      try { return { refs: read() }; }
      catch (error) { return { error: `${(error as Error).constructor.name}: ${(error as Error).message}` }; }
    };
    let scanned = 0;
    for (const content of documents) {
      expect(outcome(() => componentCalls(content)), content).toEqual(outcome(() => reference(content)));
      if (scanComponentCalls(content)) scanned++;
    }
    // Most documents are read by the scan itself, not left to parseXb.
    expect(scanned).toBeGreaterThan(documents.length / 3);
    expect(scanComponentCalls(documents.at(-1)!)).toEqual(["ui/a", "ui/b"]);
  });

  it("legge i delimitatori dei blocchi come il parser WordPress installato", async () => {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("@wordpress/block-serialization-default-parser/package.json");
    const exported = (JSON.parse(await readFile(manifest, "utf8")) as { exports: { ".": { import: string; require: string } } }).exports["."];
    const source = await readFile(fileURLToPath(new URL("../src/project-repository.ts", import.meta.url)), "utf8");
    const delimiter = /^const BLOCK_DELIMITER = (\/.+\/g);$/mu.exec(source)?.[1];
    expect(delimiter).toBeDefined();
    // The tokenizer of the parser parseXb runs: an update of the package must update the scan too.
    for (const entry of [exported.import, exported.require]) expect(await readFile(path.join(path.dirname(manifest), entry), "utf8")).toContain(`var tokenizer = ${delimiter};`);
  });
});
