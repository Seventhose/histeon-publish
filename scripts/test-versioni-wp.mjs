// Doc 23, item 202: Histeon Publish and Histeon on WP of different versions. Run by scripts/test-cms-wordpress-local.mjs
// --versioni (npm run test:versioni-wp), which starts two disposable WP stacks: A with the previous Histeon (N−1), B with
// the Histeon this Publish knows (N). Two directions, each with what broke before:
//
//   1. Publish N → Histeon N−1. A project that uses what only Histeon N reads (url.path, loop groups…) stops before
//      anything is sent, with its code; the plain project goes and is published; reading it back finds no conflict.
//   2. Publish N−1 → Histeon N, then the same project in Publish N. The previous Publish (built from its release commit)
//      imports, sends and publishes; Publish N opens and builds the project database the previous one wrote (the 1.24.0
//      database), sends it again (the site's content rereads first, as with url.path in 1.25) and reads it back; then
//      the previous Publish downloads what Publish N sent.
//
// Environment from the runner: HISTOS_TEST_WP_URL / HISTOS_TEST_WP_CONTAINER (A), HISTOS_TEST_SECOND_WP_URL /
// HISTOS_TEST_SECOND_WP_CONTAINER (B), HISTOS_VERSIONS_OLD_HISTEON and HISTOS_VERSIONS_NEW_HISTEON (the plugin
// versions of the zips). HISTOS_VERSIONS_OLD_PUBLISH_REF picks the previous Publish (a commit; default: the release
// commit of the version before this one).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { step } from "./versioni-wp-steps.mjs";

const publishRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Manca ${name}: lancia la prova con npm run test:versioni-wp (docs/VERSIONI-WP.md).`);
  return value;
};
const sites = {
  old: { url: env("HISTOS_TEST_WP_URL"), container: env("HISTOS_TEST_WP_CONTAINER"), histeon: env("HISTOS_VERSIONS_OLD_HISTEON") },
  new: { url: env("HISTOS_TEST_SECOND_WP_URL"), container: env("HISTOS_TEST_SECOND_WP_CONTAINER"), histeon: env("HISTOS_VERSIONS_NEW_HISTEON") },
};
/** Only the disposable stacks the runner starts (…-cms-a-…-wordpress-1, …-cms-b-…), never a site of the user. */
const DISPOSABLE = /^[a-z0-9][a-z0-9-]*-cms-[ab]-\d+-[0-9a-f]{8}-wordpress-1$/u;
for (const site of Object.values(sites)) assert.match(site.container, DISPOSABLE, `${site.container} non è uno stack usa-e-getta della prova.`);

const temporary = await mkdtemp(path.join(os.tmpdir(), "histos-versioni-wp-"));
await chmod(temporary, 0o700);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}\n`);
};

function php(container, body) {
  return execFileSync("docker", ["exec", container, "php", "-d", "memory_limit=512M", "-r", String.raw`require "/var/www/html/wp-load.php"; $u = get_user_by("login", "admin"); if (!$u) { fwrite(STDERR, "admin user missing\n"); exit(20); } wp_set_current_user($u->ID); ` + body], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}

/** A link that reads, writes and publishes, as an administrator creates it in Histeon → Release → Histeon CMS. */
async function pairingCode(site, name) {
  const code = php(site.container, String.raw`echo \XB\Cms\Link::create("Prova di versioni diverse", true, true, true);`).trim();
  assert.ok(code.startsWith("histos-cms-1:"), "WP dà un codice di collegamento");
  const file = path.join(temporary, `${name}.code`);
  await writeFile(file, `${code}\n`, { mode: 0o600 });
  return file;
}

/** What the site's Histeon says it is, from inside the container. */
function siteHisteon(site) {
  return php(site.container, "echo defined('XB_VERSION') ? XB_VERSION : '';").trim();
}

// ---- The previous Publish, from the sources of its release commit, with this checkout's dependencies. ----

function git(...args) {
  return execFileSync("git", args, { cwd: publishRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** The release commit of the version before this one: the oldest commit whose package.json has that version. */
function previousReleaseCommit() {
  const current = JSON.parse(git("show", "HEAD:package.json")).version;
  let previous = null;
  let commit = null;
  for (const candidate of git("log", "--format=%H", "--", "package.json").split("\n").filter(Boolean)) {
    const version = JSON.parse(git("show", `${candidate}:package.json`)).version;
    if (version === current && previous === null) continue;
    if (previous === null) previous = version;
    if (version !== previous) break;
    commit = candidate;
  }
  if (!commit) throw new Error("Non trovo la release precedente di Publish nella storia del repository.");
  return commit;
}

/**
 * The previous Publish built in a folder of its own: `git archive` of its commit (nothing in this repository changes),
 * node_modules made of links to this checkout's third-party packages and to its OWN workspace packages, then the
 * builds its server needs.
 */
async function buildPreviousPublish(ref) {
  const root = path.join(temporary, "publish-precedente");
  await mkdir(root, { mode: 0o700 });
  const archive = spawnSync("git", ["archive", "--format=tar", ref], { cwd: publishRoot, maxBuffer: 1024 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive ${ref} non riuscito.`);
  const untar = spawnSync("tar", ["-x", "-C", root], { input: archive.stdout, maxBuffer: 1024 * 1024 * 1024 });
  if (untar.status !== 0) throw new Error("Non riesco a estrarre i sorgenti della release precedente.");
  const own = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).workspaces;
  const modules = path.join(root, "node_modules");
  await mkdir(modules);
  const workspaces = new Map();
  for (const workspace of own) {
    const pkg = JSON.parse(await readFile(path.join(root, workspace, "package.json"), "utf8").catch(() => "{}"));
    if (pkg.name) workspaces.set(pkg.name, workspace);
  }
  const scopes = new Set([...workspaces.keys()].filter((name) => name.startsWith("@")).map((name) => name.split("/")[0]));
  for (const entry of await readdir(path.join(publishRoot, "node_modules"))) {
    if (scopes.has(entry) || workspaces.has(entry)) continue;
    await symlink(path.join(publishRoot, "node_modules", entry), path.join(modules, entry));
  }
  for (const scope of scopes) {
    await mkdir(path.join(modules, scope));
    for (const entry of await readdir(path.join(publishRoot, "node_modules", scope)).catch(() => [])) {
      if (!workspaces.has(`${scope}/${entry}`)) await symlink(path.join(publishRoot, "node_modules", scope, entry), path.join(modules, scope, entry));
    }
  }
  for (const [name, workspace] of workspaces) await symlink(path.join(root, workspace), path.join(modules, name));
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Build della release precedente non riuscita (${[command, ...args].join(" ")}):\n${(result.stderr || result.stdout).slice(-2000)}`);
  };
  run("npm", ["run", "build:cms-dsl"]);
  run(process.execPath, ["packages/cms/build-behaviors.mjs"]);
  run(path.join(modules, ".bin", "tsc"), ["-b", "packages/core", "packages/histos-contract", "packages/cms", "packages/server"]);
  return root;
}

async function previous(root, operation, input) {
  const argumentsFile = path.join(temporary, `argomenti-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(argumentsFile, JSON.stringify(input), { mode: 0o600 });
  const child = spawnSync(process.execPath, [path.join(publishRoot, "scripts/versioni-wp-steps.mjs"), root, operation, argumentsFile], { cwd: temporary, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  await rm(argumentsFile, { force: true });
  const line = child.stdout.split("\n").find((item) => item.startsWith("RESULT "));
  if (child.status !== 0 || !line) throw new Error(`La release precedente di Publish si è fermata in «${operation}»:\n${(child.stderr || child.stdout).slice(-2000)}`);
  return JSON.parse(line.slice("RESULT ".length));
}
const current = (operation, input) => step(publishRoot, operation, input);

// ---- Prototypes: the plain example, and the same with what only a newer Histeon reads. ----

const UUID = "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10";
async function prototype(root, name, change = (html) => html) {
  const html = (await readFile(path.join(root, "packages/cms/test/fixtures/prototipo-esempio.html"), "utf8")).replace(UUID, crypto.randomUUID());
  const file = path.join(temporary, `${name}.html`);
  await writeFile(file, change(html), { mode: 0o600 });
  return file;
}
/** For each capability of a newer Histeon, a change of the example that needs it. */
const NEWER = {
  "histos-url-path-v1": { what: "url.path nella testata (voce 189)", change: (html) => html.replace('<a href="/">Home</a>', '<a href="/">Home</a>{#if url.path == "/"}<span class="qui">Sei qui</span>{/if}') },
  "histos-svg-text-v1": { what: "un disegno SVG con testo e sfumatura", change: (html) => html.replace('<a href="/">Home</a>', '<a href="/">Home</a><svg viewBox="0 0 40 12" width="40" height="12" aria-hidden="true"><defs><linearGradient id="sfumatura"><stop offset="0" stop-color="#16224a"/><stop offset="1" stop-color="#e3b55c"/></linearGradient></defs><rect width="40" height="12" fill="url(#sfumatura)"/><text x="20" y="9" text-anchor="middle" font-size="8">Qui</text></svg>') },
  "histos-loop-group-v1": { what: "un loop a gruppi su una query (voce 187)", change: (html) => html.replace('<section>{#loop opere_notte() as opera}', '<section>{#loop opere_recenti().groupBy("publishedAt", "Y") as gruppo}<h2>{gruppo.key}</h2>{/loop}</section>\n  <section>{#loop opere_notte() as opera}') },
};

let failure;
try {
  const ref = process.env.HISTOS_VERSIONS_OLD_PUBLISH_REF?.trim() || previousReleaseCommit();
  process.stdout.write(`Publish precedente: ${git("log", "-1", "--format=%h %s", ref).trim()}\nCostruisco i suoi moduli…\n`);
  const oldRoot = await buildPreviousPublish(ref);
  const versions = { current: await current("version", { dataDirectory: path.join(temporary, "versione-n") }), previous: await previous(oldRoot, "version", { dataDirectory: path.join(temporary, "versione-p") }) };
  process.stdout.write(`Publish ${versions.current.publish} (Histeon ${versions.current.histeon}) e Publish ${versions.previous.publish} (Histeon ${versions.previous.histeon}); sul sito A Histeon ${siteHisteon(sites.old)}, sul sito B Histeon ${siteHisteon(sites.new)}.\n`);
  assert.equal(siteHisteon(sites.old), sites.old.histeon, "il sito A ha lo zip vecchio");
  assert.equal(siteHisteon(sites.new), sites.new.histeon, "il sito B ha lo zip nuovo");

  // ---- 1. Publish N → Histeon N−1 (site A). ----
  process.stdout.write(`\n1. Publish ${versions.current.publish} → Histeon ${sites.old.histeon}\n`);
  const n = path.join(temporary, "publish-n");
  await mkdir(n, { mode: 0o700 });
  const toOld = await current("connect", { dataDirectory: n, codeFile: await pairingCode(sites.old, "a-n") });
  check("Publish N si collega a Histeon N−1", !toOld.refused, toOld.refused?.message ?? "");
  const { histeonSiteNotice } = await import(path.join(publishRoot, "packages/server/dist/histeon-version.js"));
  const missing = (histeonSiteNotice(sites.old.histeon)?.missing ?? []).filter((feature) => feature.capability);
  for (const feature of missing) {
    const newer = NEWER[feature.capability];
    if (!newer) {
      check(`${feature.id}: nessuna modifica di prova per ${feature.capability}`, false, "aggiungila a NEWER in scripts/test-versioni-wp.mjs");
      continue;
    }
    const project = await current("import", { dataDirectory: n, prototype: await prototype(publishRoot, `nuovo-${feature.id}`, newer.change) });
    check(`il prototipo con ${newer.what} si importa in Publish N`, !project.refused, project.refused?.message ?? "");
    if (project.refused) continue;
    const refused = await current("plan", { dataDirectory: n, connectionId: toOld.connectionId, projectId: project.projectId, action: "publish", apply: true });
    check(`${newer.what}: Publish N non lo manda a Histeon ${sites.old.histeon} e dice perché, prima di inviare`, refused.refused?.code === "cms-remote-markup-unavailable" && !refused.applied, refused.refused ? `${refused.refused.code}: ${refused.refused.message.slice(0, 160)}` : JSON.stringify(refused).slice(0, 200));
  }
  if (!missing.length) check(`Histeon ${sites.old.histeon} legge tutto ciò che Publish N conosce`, true);
  const stillEmpty = php(sites.old.container, String.raw`echo \XB\Remote\PageProfileAdapter::capabilities(\XB\Cms\Link::get())["canInitializeProject"] ? "vuoto" : "collegato";`).trim();
  check("dopo i rifiuti il sito A è ancora senza progetto: non è partito nulla", stillEmpty === "vuoto", stillEmpty);
  const plain = await current("import", { dataDirectory: n, prototype: await prototype(publishRoot, "semplice-n") });
  check("il prototipo semplice si importa in Publish N", !plain.refused, plain.refused?.message ?? "");
  const sentOld = await current("plan", { dataDirectory: n, connectionId: toOld.connectionId, projectId: plain.projectId, action: "publish", apply: true });
  check(`Publish N invia e pubblica su Histeon ${sites.old.histeon}`, sentOld.applied?.complete === true, sentOld.refused ? `${sentOld.refused.code}: ${sentOld.refused.message.slice(0, 300)}` : JSON.stringify(sentOld.plan?.counts));
  check("il piano dice la versione vecchia del sito e cosa non funziona", (sentOld.plan?.histeon?.site ?? null) === sites.old.histeon && Array.isArray(sentOld.plan?.histeon?.missing), JSON.stringify(sentOld.plan?.histeon ?? null).slice(0, 200));
  const backOld = await current("plan", { dataDirectory: n, connectionId: toOld.connectionId, action: "pull" });
  check("rilette da Histeon N−1, le stesse cose: nessun conflitto", backOld.plan?.counts.conflict === 0 && !backOld.refused, backOld.refused?.message ?? JSON.stringify(backOld.plan?.counts));
  const offerOld = await current("front-page", { dataDirectory: n, connectionId: toOld.connectionId, projectId: plain.projectId });
  const oldKnowsFront = php(sites.old.container, String.raw`echo class_exists("\\XB\\Cms\\FrontPage") ? "sì" : "no";`).trim() === "sì";
  check("la proposta della pagina iniziale (voce 201) c'è solo se Histeon la sa fare", oldKnowsFront ? offerOld.offer !== null && !offerOld.refused : offerOld.offer === null, JSON.stringify(offerOld).slice(0, 200));

  // ---- 2. Publish N−1 → Histeon N (site B), then the same project and site in Publish N. ----
  process.stdout.write(`\n2. Publish ${versions.previous.publish} → Histeon ${sites.new.histeon}, poi Publish ${versions.current.publish}\n`);
  const p = path.join(temporary, "publish-precedente-dati");
  await mkdir(p, { mode: 0o700 });
  const old = await previous(oldRoot, "import", { dataDirectory: p, prototype: await prototype(oldRoot, "semplice-precedente") });
  check("il prototipo si importa nella release precedente", !old.refused, old.refused?.message ?? "");
  const oldToNew = await previous(oldRoot, "connect", { dataDirectory: p, codeFile: await pairingCode(sites.new, "b-precedente") });
  check(`la release precedente si collega a Histeon ${sites.new.histeon}`, !oldToNew.refused, oldToNew.refused?.message ?? "");
  const sentNew = await previous(oldRoot, "plan", { dataDirectory: p, connectionId: oldToNew.connectionId, projectId: old.projectId, action: "publish", apply: true });
  check(`la release precedente invia e pubblica su Histeon ${sites.new.histeon}`, sentNew.applied?.complete === true, sentNew.refused ? `${sentNew.refused.code}: ${sentNew.refused.message.slice(0, 300)}` : JSON.stringify(sentNew.plan?.counts));

  // Publish N on a copy of the previous one's data: its project database and its catalog of links.
  const copy = path.join(temporary, "publish-n-sui-dati-precedenti");
  await cp(p, copy, { recursive: true });
  const listed = await current("projects", { dataDirectory: copy });
  check("Publish N apre il database del progetto scritto dalla release precedente", listed.projects.includes(old.projectId) && listed.unavailable.length === 0, JSON.stringify(listed.unavailable).slice(0, 300));
  const built = await current("build", { dataDirectory: copy, projectId: old.projectId });
  check("Publish N costruisce quel progetto (il difetto del database della 1.24.0)", built.status === "ready", built.refused ? `${built.refused.code}: ${built.refused.message.slice(0, 300)}` : `${built.status} ${JSON.stringify(built.findings).slice(0, 300)}`);
  const resent = await current("plan", { dataDirectory: copy, connectionId: oldToNew.connectionId, projectId: old.projectId, action: "push", apply: true });
  check("Publish N rimanda quel progetto allo stesso sito: rilettura del sito e invio senza conflitti (url.path, voce 189)", resent.applied?.complete === true && resent.plan?.counts.conflict === 0, resent.refused ? `${resent.refused.code}: ${resent.refused.message.slice(0, 300)}` : JSON.stringify(resent.plan));
  const backNew = await current("plan", { dataDirectory: copy, connectionId: oldToNew.connectionId, action: "pull" });
  check("Publish N rilegge il sito: nessun conflitto", backNew.plan?.counts.conflict === 0 && !backNew.refused, backNew.refused?.message ?? JSON.stringify(backNew.plan?.counts));
  const oldReads = await previous(oldRoot, "plan", { dataDirectory: p, connectionId: oldToNew.connectionId, action: "pull", apply: true });
  check("la release precedente scarica ciò che Publish N ha mandato, senza conflitti", !oldReads.refused && oldReads.plan?.counts.conflict === 0, oldReads.refused ? `${oldReads.refused.code}: ${oldReads.refused.message.slice(0, 300)}` : JSON.stringify(oldReads.plan?.counts));
} catch (error) {
  failure = error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
process.stdout.write(`\nProva di versioni diverse: ${results.length - failed.length} controlli su ${results.length} superati.\n`);
if (failure) throw failure;
if (failed.length) {
  process.exitCode = 1;
  process.stderr.write(`Non superati:\n${failed.map((item) => `- ${item.name}${item.detail ? `: ${item.detail}` : ""}`).join("\n")}\n`);
}
