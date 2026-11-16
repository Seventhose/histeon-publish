import { writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { GUIDE, main } from "../src/cli.js";
import { OFF_MESSAGE } from "../src/errors.js";
import { type FakeApp, removeDirectory, startFakeApp, tempDirectory, VALID_PROTOTYPE } from "./fake-app.js";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const directories: string[] = [];
const apps: FakeApp[] = [];

/** An empty data folder: Histeon Publish closed, connector off. Always passed with --data-dir, never the real one. */
function closedData(): string {
  const directory = tempDirectory("cli");
  directories.push(directory);
  return directory;
}

async function run(argv: string[], cwd = closedData()): Promise<Run> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  stdout.setEncoding("utf8").on("data", (chunk: string) => out.push(chunk));
  stderr.setEncoding("utf8").on("data", (chunk: string) => err.push(chunk));
  const code = await main(argv, { version: "9.9.9-test", stdout, stderr, cwd });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, stdout: out.join(""), stderr: err.join("") };
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
    removeDirectory(app.dataDirectory);
  }
  for (const directory of directories.splice(0)) removeDirectory(directory);
});

describe("histos-publish-connector CLI", () => {
  it.each([[[]], [["help"]], [["--help"]], [["-h"]]])("prints the guide and exits 0 for %j", async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(GUIDE);
    expect(result.stderr).toBe("");
  });

  it("prints the version", async () => {
    const result = await run(["version"]);
    expect(result).toEqual({ code: 0, stdout: "9.9.9-test\n", stderr: "" });
  });

  it("reports status with the app closed and exits 0", async () => {
    const result = await run(["status", "--data-dir", closedData()]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ app: "chiuso o connettore spento", message: OFF_MESSAGE });
    expect(result.stderr).toBe("");
  });

  it("exits 1 with connector-off for projects with the app closed", async () => {
    const result = await run(["projects", "--data-dir", closedData()]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`connector-off: ${OFF_MESSAGE}\n`);
  });

  it("exits 2 for check on a .txt file, without contacting the app", async () => {
    const app = await startFakeApp();
    apps.push(app);
    const cwd = closedData();
    writeFileSync(path.join(cwd, "prototipo.txt"), VALID_PROTOTYPE);
    const result = await run(["check", "prototipo.txt", "--data-dir", app.dataDirectory], cwd);
    expect(result.code).toBe(2);
    expect(result.stderr.startsWith("connector-file-invalid: ")).toBe(true);
    expect(app.requests).toHaveLength(0);
  });

  it("checks a prototype relative to its working directory when the app is open", async () => {
    const app = await startFakeApp();
    apps.push(app);
    const cwd = closedData();
    writeFileSync(path.join(cwd, "sito.html"), VALID_PROTOTYPE);
    const result = await run(["check", "sito.html", "--download", "--data-dir", app.dataDirectory], cwd);
    expect(result.code).toBe(0);
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(value).toMatchObject({ valid: true, query: "mode=check&update=0&download=1&source=sito.html", file: { name: "sito.html", path: path.join(cwd, "sito.html") } });
    expect(app.requests.map((request) => request.headers["x-hp-client"])).toEqual(["cli", "cli"]);
  });

  it("exits 1 for an unknown command", async () => {
    const result = await run(["deploy", "--data-dir", closedData()]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Comando sconosciuto: deploy. Vedi help.\n");
  });

  it("exits 1 for an unknown option, a missing option value or a missing argument", async () => {
    const data = closedData();
    const unknown = await run(["status", "--force", "--data-dir", data]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr.startsWith("connector-usage: Opzione sconosciuta: --force.")).toBe(true);
    const missingValue = await run(["status", "--data-dir"]);
    expect(missingValue.code).toBe(1);
    expect(missingValue.stderr).toBe("connector-usage: Manca il valore di --data-dir.\n");
    const missingArgument = await run(["project", "--data-dir", data]);
    expect(missingArgument.code).toBe(1);
    expect(missingArgument.stderr.startsWith("connector-usage: Manca l'id del progetto.")).toBe(true);
  });

  it("validates arguments like MCP: exit 2 for an invalid id or a bad page, exit 1 for bad JSON", async () => {
    const data = closedData();
    expect((await run(["project", "../x", "--data-dir", data])).code).toBe(2);
    const page = await run(["build", "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b", "--page", "abc", "--data-dir", data]);
    expect(page.code).toBe(2);
    expect(page.stderr).toContain("page deve essere un intero");
    const json = await run(["call", "hp_status", "{non json", "--data-dir", data]);
    expect(json.code).toBe(1);
    expect(json.stderr).toBe("connector-usage: Argomenti JSON non validi.\n");
  });

  it("prints a manual chapter as text", async () => {
    const result = await run(["manual", "connettore", "--data-dir", closedData()]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("## 20. Con il connettore di Histeon Publish");
    expect(result.stdout.endsWith("\n")).toBe(true);
  });

  it("prints a topic of the documentation for agents, or the index (A7)", async () => {
    const index = await run(["docs", "--data-dir", closedData()]);
    expect(index.code).toBe(0);
    expect(index.stdout).toContain("# Documentazione di Histeon per gli agenti");
    const style = await run(["docs", "stile", "--data-dir", closedData()]);
    expect(style.code).toBe(0);
    expect(style.stdout).toContain("selettor");
    const unknown = await run(["docs", "segreti", "--data-dir", closedData()]);
    expect(unknown.code).toBe(2);
  });

  it("runs any tool through call with JSON arguments", async () => {
    const result = await run(["call", "hp_manual", '{"section":"flusso"}', "--data-dir", closedData()]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("## 1. Il flusso");
  });
});
