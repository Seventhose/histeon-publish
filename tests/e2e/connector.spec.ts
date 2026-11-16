import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "@playwright/test";

interface E2EState { baseUrl: string; token: string; dataDirectory: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

/** The agent's side: the connector client the app copied into its data folder, spoken to over MCP stdio. */
class Agent {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();
  private nextId = 1;
  readonly stdout: string[] = [];

  constructor(dataDirectory: string) {
    this.child = spawn(process.execPath, [path.join(dataDirectory, "connector", "histos-publish-connector.mjs"), "mcp", "--data-dir", dataDirectory], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.stdout.push(line);
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === "number") this.waiting.get(message.id)?.(message);
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; value: Record<string, unknown> }> {
    const message = await this.request("tools/call", { name, arguments: args });
    const result = message.result as { isError: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
    return { isError: result.isError, text: result.content[0]?.text ?? "", value: result.structuredContent ?? {} };
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

test("connettore AI: l'agente controlla, importa e costruisce; Ferma lo spegne", async ({ page, browser }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  // E10: the catalog's prototype import points to the agent screen too.
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-agent").click();
  await expect(page.getByRole("heading", { name: "Agente AI", level: 1 })).toBeVisible();
  await openConnectorSection(page);
  await page.getByTestId("connector-enable").click();
  // The user's own action: a plain notice, not one marked as the agent's.
  const enabledToast = page.locator(".toast", { hasText: "Connettore attivo" });
  await expect(enabledToast).toBeVisible();
  await expect(enabledToast.locator(".toast-agent")).toHaveCount(0);
  // The guided connection: Node found (the commands use its absolute path), the command, then the agent.
  const guide = page.getByTestId("connector-guide");
  await expect(guide).toBeVisible();
  if ((await guide.getAttribute("open")) === null) await guide.locator("summary").click();
  await expect(page.getByTestId("connector-step-node")).toHaveAttribute("data-state", "done", { timeout: 15_000 });
  await expect(page.getByTestId("connector-step-node")).toContainText("Node.js v");
  await expect(page.getByTestId("connector-commands")).toContainText("histos-publish-connector.mjs");
  await expect(page.getByTestId("connector-commands")).toContainText("Il comando non contiene segreti");
  // ChatGPT desktop: a message to paste in its chat (register the server, or use the CLI), then the form and the file.
  await page.getByRole("tab", { name: "ChatGPT desktop" }).click();
  const chat = page.locator('[data-command="chatgptChat"]');
  await expect(chat).toContainText("Collegati a Histeon Publish");
  await expect(chat).toContainText("[mcp_servers.histos-publish]");
  await expect(chat).toContainText("histos-publish-connector.mjs");
  await expect(chat).toContainText(" help");
  await expect(page.locator('[data-command="chatgptToml"]')).toContainText("tool_timeout_sec = 180");
  await page.getByTestId("connector-prototype-path").fill("/home/me/Proposte/sito nuovo.html");
  await expect(page.getByTestId("connector-first-message")).toHaveText("Controlla «/home/me/Proposte/sito nuovo.html» e importalo in Histeon Publish");

  const folder = await mkdtemp(path.join(tmpdir(), "histos-publish-agent-"));
  const agent = new Agent(env.dataDirectory);
  try {
    const initialized = await agent.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "e2e-agent", version: "1.0" } });
    expect((initialized.result as { serverInfo: { name: string } }).serverInfo.name).toBe("histos-publish");

    const example = await readFile(path.resolve("packages/cms/test/fixtures/prototipo-esempio.html"), "utf8");
    const id = crypto.randomUUID();
    const name = `Galleria AI ${id.slice(0, 8)}`;
    const prototype = example.replace("3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", id).replace('"name": "Galleria"', `"name": "${name}"`);
    const file = path.join(folder, "sito.html");
    await writeFile(file, prototype.replace("<p>Scrivimi.</p>", '<p onclick="alert(1)">Scrivimi.</p>'));
    const broken = await agent.call("hp_check_prototype", { path: file });
    expect(broken.isError).toBe(true);
    expect(broken.text).toContain("cms-prototype-invalid");

    await writeFile(file, prototype);
    const checked = await agent.call("hp_check_prototype", { path: file, preview: true });
    expect(checked.isError).toBe(false);
    expect(checked.value).toMatchObject({ valid: true, outcome: "create", preview: { status: "ready" } });
    // A2: the throwaway preview reopens from the agent's log, with a fresh address.
    const checkEntry = page.getByTestId("connector-activity").locator('li[data-operation="checkPrototype"][data-outcome="ok"]').first();
    await expect(checkEntry.getByRole("button", { name: "Apri anteprima" })).toBeVisible({ timeout: 15_000 });
    const checkPreviewOpened = page.context().waitForEvent("page");
    await checkEntry.getByRole("button", { name: "Apri anteprima" }).click();
    const checkPreview = await checkPreviewOpened;
    await expect.poll(() => checkPreview.url(), { timeout: 15_000 }).toContain("/__preview/");
    await expect(checkPreview.locator("body")).toContainText("Studio Ehi");
    await checkPreview.close();

    const imported = await agent.call("hp_import_prototype", { path: file });
    expect(imported.isError).toBe(false);
    expect(imported.value).toMatchObject({ result: "creato", project: { id, name } });

    await expect(page.getByTestId("connector-activity")).toContainText(name, { timeout: 15_000 });
    // D1: "Vedi rapporto" opens the project with the agent's import report.
    const importEntry = page.getByTestId("connector-activity").locator('li[data-operation="importPrototype"]').first();
    await importEntry.getByRole("button", { name: "Vedi rapporto →" }).click();
    const agentReport = page.getByTestId("cms-import-report");
    await expect(agentReport).toBeFocused();
    await expect(agentReport).toContainText("importato da e2e-agent 1.0");
    await expect(agentReport).toContainText("sito.html");
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await openConnectorSection(page);
    await expect(page.locator(".toast", { hasText: name }).locator(".toast-agent")).toBeVisible();
    await expect(page.getByTestId("connector-step-agent")).toHaveAttribute("data-state", "done");
    await expect(page.getByTestId("connector-step-agent")).toContainText("e2e-agent 1.0 è collegato");
    await expect(page.getByTestId("connector-chip")).toBeVisible();

    // E5: a refused check reads as something to fix, with the reason, not as a red error code.
    const fixEntry = page.getByTestId("connector-activity").locator('li[data-operation="checkPrototype"][data-outcome="fix"]').first();
    await expect(fixEntry).toBeVisible({ timeout: 15_000 });
    await expect(fixEntry).toContainText("Da correggere");
    await expect(fixEntry).toContainText("onclick");

    const built = await agent.call("hp_build", { projectId: id });
    expect(built.isError).toBe(false);
    const buildEntry = page.getByTestId("connector-activity").locator('li[data-operation="build"]').first();
    await expect(buildEntry.getByRole("button", { name: "Apri anteprima" })).toBeVisible({ timeout: 15_000 });
    const opened = page.context().waitForEvent("page");
    await buildEntry.getByRole("button", { name: "Apri anteprima" }).click();
    const previewPage = await opened;
    await expect.poll(() => previewPage.url(), { timeout: 15_000 }).toContain("/__preview/");
    await previewPage.close();
    const previewUrl = String(built.value.previewUrl);
    const preview = await browser.newPage();
    const response = await preview.goto(previewUrl);
    expect(response?.status()).toBe(200);
    await preview.close();

    const html = await agent.call("hp_build_file", { projectId: id, buildId: String(built.value.buildId) });
    expect(html.isError).toBe(false);
    expect(String(html.value.text)).toContain("<html");

    // D2: an update the agent asks for waits in the banner, with what changes, until the user approves it.
    await writeFile(file, prototype.replace("<p>Quadretti, libri, racconti.</p>", "<p>Quadretti, libri, racconti e viaggi.</p>"));
    const asked = await agent.call("hp_import_prototype", { path: file, update: true });
    expect(asked.isError).toBe(false);
    expect(asked.value).toMatchObject({ result: "in-attesa", kind: "import", state: "pending" });
    const banner = page.getByTestId("connector-approval").filter({ hasText: "aggiornare" });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(name);
    await expect(banner).toContainText("sito.html");
    await expect(banner).toContainText("1 modificato");
    await banner.getByRole("button", { name: "Salva il backup e aggiorna" }).click();
    const followed = await agent.call("hp_import_status", { requestId: String(asked.value.requestId), waitSeconds: 20 });
    expect(followed.value).toMatchObject({ state: "applied", result: { result: "aggiornato" } });
    await expect(banner).toBeHidden();

    // Doc 23 item 94: the agent proposes a rewrite of a page; nothing changes until the writer accepts it, part by part.
    const summary = await agent.call("hp_project", { projectId: id });
    const target = (summary.value.pages as Array<{ alias: number; title: string }>)[0]!;
    const article = await agent.call("hp_article_read", { projectId: id, alias: target.alias });
    expect(article.isError).toBe(false);
    const readBlocks = article.value.blocks as Array<Record<string, unknown>>;
    const proposed = await agent.call("hp_article_propose", { projectId: id, alias: target.alias, head: String(article.value.head), title: "Titolo dell'agente", blocks: JSON.stringify([...readBlocks, { type: "paragraph", html: "Un paragrafo <strong>proposto</strong>." }, { type: "paragraph", html: "E poi un altro." }]), note: "Aggiungo due righe." });
    expect(proposed.isError, proposed.text).toBe(false);
    expect(proposed.value).toMatchObject({ status: "proposed", title: true });
    expect((await agent.call("hp_article_read", { projectId: id, alias: target.alias })).value).toMatchObject({ head: article.value.head, title: target.title, proposalWaiting: true });
    await page.goto(`${env.baseUrl}/#/cms/${id}/amministra/articolo-${target.alias}`);
    const proposalPanel = page.getByTestId("article-proposal");
    await expect(proposalPanel).toBeVisible({ timeout: 20_000 });
    await expect(proposalPanel).toContainText("Aggiungo due righe.");
    await expect(proposalPanel.getByTestId("proposal-block")).toHaveCount(2);
    await expect(proposalPanel.getByTestId("proposal-block").first()).toHaveAttribute("data-kind", "add");
    // The second first: it still lands after the text, and the first one before it.
    await proposalPanel.getByTestId("proposal-block").nth(1).getByTestId("proposal-accept").click();
    await proposalPanel.getByTestId("proposal-block").first().getByTestId("proposal-accept").click();
    await proposalPanel.getByTestId("proposal-title").getByTestId("proposal-accept").click();
    await expect(proposalPanel).toBeHidden();
    await expect(page.getByTestId("article-title")).toHaveValue("Titolo dell'agente");
    await expect(page.locator(".article-text")).toContainText("Un paragrafo proposto.");
    const sheet = await page.locator(".article-text").innerText();
    expect(sheet.indexOf("Un paragrafo proposto.")).toBeGreaterThan(0);
    expect(sheet.indexOf("Un paragrafo proposto.")).toBeLessThan(sheet.indexOf("E poi un altro."));
    await expect(page.getByTestId("article-saving")).toHaveText("Salvato", { timeout: 6000 });
    await expect.poll(async () => (await agent.call("hp_article_read", { projectId: id, alias: target.alias })).value, { timeout: 10_000 }).toMatchObject({ title: "Titolo dell'agente", proposalWaiting: false });
    expect(JSON.stringify((await agent.call("hp_article_read", { projectId: id, alias: target.alias })).value.blocks)).toContain("Un paragrafo <strong>proposto</strong>.");
    await page.goto(`${env.baseUrl}/`);
    await openConnectorSection(page);

    await page.getByTestId("connector-stop").click();
    await expect(page.getByTestId("connector-enable")).toBeVisible();
    const off = await agent.call("hp_list_projects", {});
    expect(off.isError).toBe(true);
    expect(off.text).toContain("connector-off");
    // Only JSON-RPC ever goes to the agent's stdout.
    for (const line of agent.stdout) expect(() => JSON.parse(line)).not.toThrow();
  } finally {
    agent.close();
    await rm(folder, { recursive: true, force: true });
  }
  expect(pageErrors).toEqual([]);
});

async function openConnectorSection(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Agente AI", exact: true }).click();
  await expect(page.getByTestId("connector-section")).toBeVisible();
}
