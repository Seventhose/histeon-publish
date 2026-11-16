// Doc 23, item 202: the steps of the version test (scripts/test-versioni-wp.mjs) with the modules of ONE Publish: this
// checkout, or a previous release built from its own sources. Used in-process for this Publish, and as a child process
// for the previous one, so each runs its own code on its own data:
//   node scripts/versioni-wp-steps.mjs <publish root> <operation> <arguments.json>
// prints one line «RESULT <json>». Only test data: disposable WordPress stacks, secrets in a 0600 file of the test's
// temporary folder, removed with it.
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function modules(root) {
  const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
  const [api, remote, cms] = await Promise.all([load("packages/server/dist/cms-api.js"), load("packages/server/dist/cms-remote.js"), load("packages/cms/dist/index.js")]);
  return { api, remote, cms };
}

/** The link secrets of one data folder, as the keychain would keep them. */
function secretStore(dataDirectory) {
  const file = path.join(dataDirectory, "secrets.json");
  const read = async () => JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
  return (account) => ({
    get: async () => (await read())[account] ?? null,
    set: async (value) => {
      const all = await read();
      all[account] = value;
      await writeFile(file, JSON.stringify(all), { mode: 0o600 });
      await chmod(file, 0o600);
    },
    delete: async () => {
      const all = await read();
      delete all[account];
      await writeFile(file, JSON.stringify(all), { mode: 0o600 });
    },
  });
}

/** A refusal as data: its code and message, so the caller can say what stopped and where. */
function refusal(error) {
  return { code: typeof error?.code === "string" ? error.code : error instanceof Error ? error.name : "error", message: error instanceof Error ? error.message.slice(0, 800) : String(error) };
}

const counts = (plan) => Object.fromEntries(Object.entries(plan.counts ?? {}).map(([key, value]) => [key, Number(value) || 0]));

export async function step(root, operation, input) {
  const { api, remote, cms } = await modules(root);
  const dataDirectory = input.dataDirectory;
  const catalog = new cms.CmsProjectCatalog(path.join(dataDirectory, "publish"));
  await catalog.initialize();
  const context = { catalog, dataDirectory, port: 1, registerPreview: () => undefined, registerBuild: () => undefined };
  const storeFor = secretStore(dataDirectory);
  const remotes = () => new remote.CmsRemoteCatalog(dataDirectory);
  switch (operation) {
    case "version": {
      const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      return { publish: pkg.version, histeon: remote.HISTEON_VERSION ?? null };
    }
    case "import": {
      const html = await readFile(input.prototype, "utf8");
      try {
        const imported = await api.importPrototypeHtml(context, html, { download: false, allowUpdate: false });
        if (imported.status !== 201) return { refused: { code: String(imported.body?.code ?? imported.status), message: JSON.stringify(imported.body).slice(0, 800) } };
        return { projectId: String(imported.body.project.id) };
      } catch (error) {
        return { refused: refusal(error) };
      }
    }
    case "connect": {
      const catalogRemote = remotes();
      try {
        const code = (await readFile(input.codeFile, "utf8")).trim();
        const connection = await remote.connectRemoteSite(code, catalogRemote, storeFor, input.connectionId);
        return { connectionId: connection.id, projectId: connection.projectId, publish: connection.publish };
      } catch (error) {
        return { refused: refusal(error) };
      } finally {
        catalogRemote.close();
      }
    }
    case "plan": {
      // A plan and, when it can be applied and the caller wants it, its application: what «Rivedi» then «Conferma» do.
      const catalogRemote = remotes();
      try {
        let plan;
        try {
          plan = await remote.createRemoteSyncPlan({ action: input.action, connectionId: input.connectionId, ...(input.projectId ? { projectId: input.projectId } : {}) }, catalogRemote, catalog, storeFor);
        } catch (error) {
          return { refused: refusal(error) };
        }
        const shown = { counts: counts(plan), applyAllowed: plan.applyAllowed === true, initializingRemote: plan.initializingRemote === true, histeon: plan.histeon ?? null, conflicts: (plan.entities ?? []).filter((entity) => entity.status === "conflict").slice(0, 20).map((entity) => `${entity.kind} ${entity.label}`) };
        if (!input.apply || !plan.applyAllowed || !plan.planId) {
          if (plan.planId) catalogRemote.takeSyncPlan(plan.planId);
          return { plan: shown };
        }
        try {
          const applied = await remote.applyRemoteSyncPlan({ connectionId: input.connectionId, planId: plan.planId, ...(input.projectId ? { expectedProjectId: input.projectId } : {}) }, catalogRemote, catalog, storeFor);
          return { plan: shown, applied: { complete: applied.complete === true, projectId: applied.projectId ?? applied.project?.id ?? null } };
        } catch (error) {
          return { plan: shown, refused: refusal(error) };
        }
      } finally {
        catalogRemote.close();
      }
    }
    case "build": {
      const opened = await catalog.openProject(input.projectId);
      if (!opened) return { refused: { code: "cms-project-missing", message: "Il progetto non si apre." } };
      try {
        const built = await api.buildCmsProject(context, opened);
        return { status: built.status, findings: (built.findings ?? []).slice(0, 5) };
      } catch (error) {
        return { refused: refusal(error) };
      } finally {
        opened.store.close();
      }
    }
    case "projects": {
      const listed = await catalog.listProjectsWithProblems();
      return { projects: listed.projects.map((project) => project.id), unavailable: listed.unavailable };
    }
    case "front-page": {
      const front = await import(pathToFileURL(path.join(root, "packages/server/dist/cms-remote-front-page.js")).href).catch(() => null);
      if (!front) return { offer: "unsupported" };
      const catalogRemote = remotes();
      try {
        return { offer: await front.frontPageOffer({ connectionId: input.connectionId, projectId: input.projectId }, catalogRemote, catalog, storeFor) };
      } catch (error) {
        return { refused: refusal(error) };
      } finally {
        catalogRemote.close();
      }
    }
    default:
      throw new Error(`Operazione sconosciuta: ${operation}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, operation, argumentsFile] = process.argv.slice(2);
  const input = JSON.parse(await readFile(argumentsFile, "utf8"));
  const result = await step(path.resolve(root), operation, input);
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
}
