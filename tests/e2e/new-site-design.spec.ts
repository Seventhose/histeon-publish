import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { HAS_ZSTD, siteCanvas, zip as figZip } from "../../packages/cms/test/fig-writer.js";
import { id, siteEntries, siteShapes, zip } from "../../packages/cms/test/penpot-writer.js";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

async function openNewSite(page: Page) {
  const env = await state();
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  const block = page.getByTestId("new-site-design");
  await expect(block).toBeVisible();
  return block;
}

/** The page of penpot-writer.ts with three copies of its card in a row and a name of its own, so each run makes its own project. */
function threeCards(): Array<Record<string, unknown>> {
  const shapes = siteShapes().filter((shape) => ![id(60), id(61), id(62)].includes(String(shape.id)));
  const by = (n: number) => shapes.find((shape) => shape.id === id(n))!;
  const moved = (n: number, to: number, title?: string) => {
    const copy = JSON.parse(JSON.stringify(by(n))) as { id: string; x: number; selrect: { x: number }; shapes?: string[]; content?: { children: Array<{ children: Array<{ children: Array<{ text: string }> }> }> } };
    copy.id = id(to);
    copy.x += 324;
    copy.selrect.x += 324;
    if (copy.shapes) copy.shapes = [id(to + 1), id(to + 2)];
    if (title && copy.content) copy.content.children[0]!.children[0]!.children[0]!.text = title;
    return copy;
  };
  shapes.push(moved(44, 70), moved(45, 71, "Terza"), moved(46, 72));
  by(33).shapes = [id(70), id(44), id(40)];
  return shapes;
}

// Note penpot-figma-a-histeon.md, phase 6: «Nuovo sito» takes a whole .penpot or .fig file, lists its pages and
// frames, turns one frame into a prototype with its report, and hands it to the check of a prototype.
test("Nuovo sito da Penpot: il file dà pagine e riquadri, il riquadro diventa un prototipo e il prototipo un progetto", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const block = await openNewSite(page);
  const field = block.getByTestId("new-site-design-file");
  await expect(field).toHaveAttribute("accept", ".penpot,.fig");
  // Nothing to choose before a file is there.
  await expect(block.getByTestId("new-site-design-convert")).toHaveCount(0);

  const stamp = Date.now().toString(36);
  const fileName = `bottega-${stamp}.penpot`;
  const listedRequest = page.waitForRequest((request) => request.url().includes(`/api/cms/v1/design-file/pages?name=${fileName}`) && request.method() === "POST");
  await field.setInputFiles({ name: fileName, mimeType: "application/octet-stream", buffer: await zip(siteEntries(threeCards())) });
  expect((await listedRequest).headers()["content-type"]).toBe("application/octet-stream");
  await expect(block.getByTestId("new-site-design-summary")).toHaveText(`${fileName}: Penpot, 1 pagina con riquadri.`);
  await expect(block.getByTestId("new-site-design-page")).toHaveValue(/.+/u);
  await expect(block.getByTestId("new-site-design-page").locator("option")).toHaveText(["Home"]);
  await expect(block.getByTestId("new-site-design-frame").locator("option")).toHaveText([/^Home · 1200 × 760 px, \d+ livelli$/u]);

  // With the choices as they are: the cards of the design become a component, and the report says so.
  const report = block.getByTestId("new-site-design-report");
  const text = block.getByTestId("new-site-design-report-text");
  let converted = page.waitForRequest((request) => request.url().includes("/api/cms/v1/design-file/prototype?") && request.method() === "POST");
  await block.getByTestId("new-site-design-convert").click();
  let query = new URL((await converted).url()).searchParams;
  expect(Object.fromEntries(query)).toMatchObject({ name: fileName, components: "1", records: "1", uniform: "0" });
  await expect(report).toContainText("Prototipo pronto: riquadro «Home» della pagina «Home».");
  await expect(report).toContainText("Niente è stato ancora importato.");
  await expect(text).toContainText("Blocchi scritti: header, hero, cards, footer.");
  await expect(text).toContainText("Riconosciuti come componenti del prototipo: 1 («Card»).");
  await expect(text).toContainText("varianti come modificatori: --2");
  await expect(block.getByTestId("new-site-design-download")).toHaveAttribute("download", `bottega-${stamp}-home.html`);

  // A changed choice makes the prototype shown stale: it goes until the frame is converted again.
  await block.getByTestId("new-site-design-uniform").check();
  await expect(report).toHaveCount(0);
  converted = page.waitForRequest((request) => request.url().includes("/api/cms/v1/design-file/prototype?") && request.method() === "POST");
  await block.getByTestId("new-site-design-convert").click();
  expect(new URL((await converted).url()).searchParams.get("uniform")).toBe("1");
  await expect(text).toContainText("hanno preso tutte lo stile della prima");
  await block.getByTestId("new-site-design-uniform").uncheck();

  // The way to Etch + ACSS: without components and without records.
  await block.getByTestId("new-site-design-no-components").check();
  await block.getByTestId("new-site-design-no-records").check();
  converted = page.waitForRequest((request) => request.url().includes("/api/cms/v1/design-file/prototype?") && request.method() === "POST");
  await block.getByTestId("new-site-design-convert").click();
  query = new URL((await converted).url()).searchParams;
  expect(Object.fromEntries(query)).toMatchObject({ components: "0", records: "0", uniform: "0" });
  await expect(text).toContainText("Riconosciuti come componenti del prototipo: 0.");

  // «Controlla e importa»: the same check and preview as a prototype the user wrote, then the project.
  const checked = page.waitForRequest((request) => request.url().includes("/api/cms/v1/projects/import-prototype?check=1") && request.method() === "POST");
  await block.getByTestId("new-site-design-import").click();
  expect((await checked).headers()["content-type"]).toBe("text/html; charset=utf-8");
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 30_000 });
  await check.getByTestId("cms-prototype-import").click();
  await expect(page.getByRole("heading", { name: "Sito di prova · Home", exact: true })).toBeVisible({ timeout: 30_000 });
  expect(pageErrors).toEqual([]);
});

test("Nuovo sito da Figma: un .fig scelto dal selettore dei file del sito va a «Da Penpot o Figma», e un file che non è di design viene lasciato", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const block = await openNewSite(page);

  // A file with the name of a design and other bytes: the server says why, and no choice is shown.
  await block.getByTestId("new-site-design-file").setInputFiles({ name: "appunti.fig", mimeType: "application/octet-stream", buffer: Buffer.from("non sono un file di Figma") });
  await expect(page.locator(".toast.error-toast").filter({ hasText: "appunti.fig" }).first()).toBeVisible();
  await expect(block.getByTestId("new-site-design-summary")).toHaveCount(0);

  test.skip(!HAS_ZSTD, "questo Node non ha zstd: il file .fig di prova non si scrive");
  // The chooser of a single file of the static site: a .fig is no site, so the selection for a static site is emptied.
  const fig = await figZip({ "canvas.fig": siteCanvas(), "meta.json": JSON.stringify({ file_name: "Bottega dei vasi" }) });
  await page.locator("#file-html").setInputFiles({ name: "Bottega.fig", mimeType: "application/octet-stream", buffer: fig });
  await expect(block.getByTestId("new-site-design-summary")).toHaveText("Bottega.fig: Figma, 1 pagina con riquadri.");
  await expect(page.locator(".selection-summary")).toHaveCount(0);
  await expect(block.getByTestId("new-site-design-page").locator("option")).toHaveText(["Sito"]);
  const frames = block.getByTestId("new-site-design-frame");
  await expect(frames.locator("option").filter({ hasText: /^Home · 1440 × 900 px/u })).toHaveCount(1);
  // Two frames of the page have the same name: the list says which is which, and each one has its own prototype.
  await expect(frames.locator("option").filter({ hasText: /^Doppio /u })).toHaveText([/^Doppio \(1º di 2\) · 400 × 100 px, \d+ livelli$/u, /^Doppio \(2º di 2\) · 400 × 100 px, \d+ livelli$/u]);
  const twinIds: string[] = [];
  for (const [place, words] of [["1º di 2", "Primo"], ["2º di 2", "Secondo"]] as const) {
    await frames.selectOption({ label: await frames.locator("option").filter({ hasText: `Doppio (${place})` }).innerText() });
    const answered = page.waitForResponse((response) => response.url().includes("/api/cms/v1/design-file/prototype?") && response.request().method() === "POST");
    await block.getByTestId("new-site-design-convert").click();
    const made = await (await answered).json() as { id: string; html: string };
    expect(made.html).toContain(words);
    twinIds.push(made.id);
    await expect(block.getByTestId("new-site-design-report-text")).toContainText("2 riquadri della pagina hanno questo nome");
  }
  expect(new Set(twinIds).size).toBe(2);
  await frames.selectOption({ label: await frames.locator("option").filter({ hasText: /^Home · 1440 × 900 px/u }).innerText() });
  await block.getByTestId("new-site-design-convert").click();
  await expect(block.getByTestId("new-site-design-report-text")).toContainText("riquadro «Home» (Figma, 1440 px)");
  await expect(block.getByTestId("new-site-design-report-text")).toContainText("Blocchi scritti: header, hero, schede, disegni.");

  // «Togli il file» empties the card.
  await block.getByRole("button", { name: "Togli il file" }).click();
  await expect(block.getByTestId("new-site-design-summary")).toHaveCount(0);
  await expect(block.getByTestId("new-site-design-report")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("Nuovo sito da Penpot: un file rilasciato sulla scheda è letto come uno scelto, e un file di un altro tipo è rifiutato con il motivo", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const block = await openNewSite(page);
  const drop = async (name: string, bytes: Uint8Array) => {
    const transfer = await page.evaluateHandle(({ name, data }) => {
      const made = new DataTransfer();
      made.items.add(new File([new Uint8Array(data)], name, { type: "application/octet-stream" }));
      return made;
    }, { name, data: [...bytes] });
    await block.dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(block).toHaveClass(/\bover\b/u);
    await block.dispatchEvent("drop", { dataTransfer: transfer });
    await expect(block).not.toHaveClass(/\bover\b/u);
  };

  // A file that is no design, dropped on the card: nothing is sent, and the reason is said.
  await drop("appunti.txt", Buffer.from("appunti"));
  await expect(page.locator(".toast.error-toast").filter({ hasText: "Qui va un solo file .penpot o .fig." }).first()).toBeVisible();
  await expect(block.getByTestId("new-site-design-summary")).toHaveCount(0);

  const fileName = `rilasciato-${Date.now().toString(36)}.penpot`;
  const listed = page.waitForRequest((request) => request.url().includes(`/api/cms/v1/design-file/pages?name=${fileName}`) && request.method() === "POST");
  await drop(fileName, await zip(siteEntries(threeCards())));
  await listed;
  await expect(block.getByTestId("new-site-design-summary")).toHaveText(`${fileName}: Penpot, 1 pagina con riquadri.`);
  await expect(block.getByTestId("new-site-design-frame").locator("option")).toHaveText([/^Home · 1200 × 760 px, \d+ livelli$/u]);
  expect(pageErrors).toEqual([]);
});
