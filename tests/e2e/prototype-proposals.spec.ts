import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

/** Queue A4: the proposals page, opened as the client does, as a file with no server behind it. */
test("la pagina delle proposte affianca i prototipi, li mostra a misura e registra la scelta, senza rete (A4)", async ({ page }) => {
  const { buildProposalsPage } = await import(path.resolve("packages/server/dist/prototype-proposals.js"));
  const example = await readFile("packages/cms/test/fixtures/prototipo-esempio.html", "utf8");
  const bold = example
    .replace('"id": "3b1f0d2e-6c55-4c1a-9d9e-6a7f6f3f2a10", "name": "Galleria"', '"id": "4c2e1f3a-7d66-4d2b-8e0f-7b8a8f4a3b21", "name": "Galleria audace"')
    .replace(' data-status="draft"', "")
    // An element that names a global of the page (DOM clobbering): `name` on <img> is refused since item 172, an id does the same.
    .replace(/(<template data-histos="page" data-slug="home"[^>]*>)/u, '$1<nav><a href="/contatti/">Vai ai contatti</a> <a href="https://example.com/">Fuori</a> <a href="#fondo">Giù</a></nav><img src="asset:ehi" id="addEventListener" alt="Ehi"><p id="fondo" class="bersaglio">Fondo</p>')
    // :target works in the preview as on the site.
    .replace(/(<style data-histos="global"[^>]*>)/u, "$1\n.bersaglio:target { color: rgb(1, 2, 3); }\n");
  const root = await mkdtemp(path.join(tmpdir(), "histos-proposals-e2e-"));
  try {
    const result = await buildProposalsPage([{ file: "classica.html", html: example }, { file: "audace.html", html: bold }], { scratchRoot: path.join(root, "scratch"), title: "Proposte per Galleria", contact: "studio@example.com" });
    const file = path.join(root, "proposte.html");
    await writeFile(file, result.html);

    const problems: string[] = [];
    page.on("console", (message) => {
      // Playwright's trace recorder tries to run its snapshot script in every frame: the previews' sandbox blocks it.
      if (/^Blocked script execution in 'about:srcdoc(?:#[^']*)?'/u.test(message.text())) return;
      if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));
    // blob: addresses are the page's own media, decoded from the file.
    page.on("request", (request) => { if (!/^(?:data|file|about|blob):/u.test(request.url())) problems.push(`richiesta ${request.url()}`); });
    await page.goto(pathToFileURL(file).href);

    // Side by side: each card with the rendered home page.
    await expect(page.getByRole("heading", { level: 1, name: "Proposte per Galleria" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Galleria Scelta", "Galleria audace Scelta"]);
    await expect(page.locator(".card").nth(1).frameLocator("iframe").getByText("Studio Ehi")).toBeVisible();
    await expect(page.locator(".card iframe").first()).toHaveAttribute("sandbox", "allow-same-origin");
    // The thumbnails are pictures: inert, never usable.
    expect(await page.locator(".card iframe").evaluateAll((frames) => frames.map((frame) => (frame as HTMLIFrameElement).inert))).toEqual([true, true]);

    // One proposal: its pages, its links followed inside the page, the others reported.
    await page.getByRole("button", { name: "Guarda la proposta" }).nth(1).click();
    await expect(page.getByRole("heading", { level: 2, name: "Galleria audace" })).toBeFocused();
    const stage = page.frameLocator(".stage iframe");
    await stage.getByRole("link", { name: "Vai ai contatti" }).click();
    await expect(page.getByRole("group", { name: "Pagine" }).getByRole("button", { name: "Contatti" })).toHaveAttribute("aria-pressed", "true");
    await expect(stage.getByText("Scrivimi.")).toBeVisible();
    await page.getByRole("group", { name: "Pagine" }).getByRole("button", { name: "Home" }).click();
    await stage.getByRole("link", { name: "Fuori" }).click();
    await expect(page.getByRole("status").first()).toHaveText("Nell'anteprima i link verso altri siti non si aprono: https://example.com/");
    await stage.getByRole("link", { name: "Giù" }).click();
    await expect(stage.locator("#fondo")).toHaveCSS("color", "rgb(1, 2, 3)");
    // Media come from the file through blob: addresses, decoded once; the image named like a method changes nothing.
    const image = stage.getByRole("img", { name: "Ehi" }).last();
    await expect(image).toHaveAttribute("src", /^blob:/u);
    expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator(".stage iframe")).not.toHaveAttribute("inert", "");
    // A middle click opens nothing: no new tab, no request (the listener below counts them).
    let tabs = 0;
    page.context().on("page", () => { tabs++; });
    await stage.getByRole("link", { name: "Fuori" }).click({ button: "middle" });
    await stage.getByRole("link", { name: "Fuori" }).click({ modifiers: ["ControlOrMeta"] });
    await page.waitForTimeout(300);
    expect(tabs).toBe(0);

    // At phone width the frame is 390 px wide.
    await page.getByRole("button", { name: "Telefono · 390 px" }).click();
    await expect(page.locator(".stage iframe")).toHaveCSS("width", "390px");

    // The choice: an email ready to send, and the card marked when going back.
    await page.getByRole("button", { name: "Scelgo questa proposta" }).click();
    await expect(page.locator(".choice")).toContainText("Hai scelto «Galleria audace».");
    const mail = page.getByRole("link", { name: "Scrivilo a studio@example.com" });
    await expect(mail).toHaveAttribute("href", /^mailto:studio@example\.com\?subject=Scelgo%20la%20proposta%20%C2%ABGalleria%20audace%C2%BB&body=/u);
    await page.getByRole("button", { name: "← Tutte le proposte" }).click();
    await expect(page.locator(".card.chosen h2")).toHaveText("Galleria audace Scelta");
    await expect(page.locator(".card.chosen .badge")).toBeVisible();

    // At phone width the page itself does not scroll sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(problems).toEqual([]);

    // Served by a host that declares another charset: the page still works and the names read right.
    const named = await buildProposalsPage([{ file: "audace.html", html: bold.replace('"name": "Galleria audace"', '"name": "Galleria è più audace"') }], { scratchRoot: path.join(root, "scratch2") });
    await page.route("http://proposte.test/**", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=iso-8859-1" }, body: Buffer.from(named.html, "utf8") }));
    await page.goto("http://proposte.test/proposte.html");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("Galleria è più audace Scelta");
    await expect(page.locator(".card iframe")).toHaveCount(1);
    expect(problems.filter((problem) => !problem.startsWith("richiesta http://proposte.test/"))).toEqual([]);

    // A control character in a name never reaches the mail's subject or body as a line break.
    const tabbed = await buildProposalsPage([{ file: "tab.html", html: bold.replace('"name": "Galleria audace"', '"name": "Galleria\\tnotte\\u000bfonda"') }], { scratchRoot: path.join(root, "scratch3"), contact: "studio@example.com" });
    const tabbedFile = path.join(root, "tab.html");
    await writeFile(tabbedFile, tabbed.html);
    await page.goto(pathToFileURL(tabbedFile).href);
    await page.getByRole("button", { name: "Guarda la proposta" }).click();
    await page.getByRole("button", { name: "Scelgo questa proposta" }).click();
    const href = (await page.getByRole("link", { name: "Scrivilo a studio@example.com" }).getAttribute("href")) ?? "";
    expect(href).toContain("Galleria%20notte%20fonda");
    // Only the body's own line breaks are left.
    expect([...decodeURIComponent(href.split("?")[1] ?? "")].filter((char) => char.charCodeAt(0) < 0x20 && char !== "\n")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
