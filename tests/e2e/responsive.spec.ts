import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { newProject } from "./cms-helpers.js";

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

async function expectNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(sizes.document, `overflow orizzontale a ${width}px: ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.viewport + 1);
}

async function checkSupportedWidths(page: Page): Promise<void> {
  for (const width of [320, 390, 768, 1280]) await expectNoHorizontalOverflow(page, width);
}

test("schermate Publish e CMS restano usabili su mobile e i controlli sono raggiungibili da tastiera", async ({ page }) => {
  const env = await state();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();

  await checkSupportedWidths(page);

  await page.setViewportSize({ width: 390, height: 844 });
  const typography = await page.evaluate(() => ({
    body: Number.parseFloat(getComputedStyle(document.body).fontSize),
    nav: [...document.querySelectorAll<HTMLElement>(".main-nav button")].map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    action: Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>(".button")!).fontSize),
  }));
  expect(typography.body).toBeGreaterThanOrEqual(16);
  expect(typography.nav.length).toBeGreaterThan(0);
  expect(Math.min(...typography.nav)).toBeGreaterThanOrEqual(14);
  expect(typography.action).toBeGreaterThanOrEqual(14);

  await page.keyboard.press("Tab");
  const focusRing = await page.locator(":focus-visible").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: Number.parseFloat(style.outlineWidth), style: style.outlineStyle };
  });
  expect(focusRing.width).toBeGreaterThanOrEqual(3);
  expect(focusRing.style).not.toBe("none");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await expectNoHorizontalOverflow(page, 390);
  await newProject(page, `E2E responsive ${Date.now()}`);
  await expect(page.getByRole("heading", { name: "Bacheca" })).toBeVisible();
  await checkSupportedWidths(page);

  await page.getByRole("button", { name: "Attività" }).click();
  await expect(page.getByRole("heading", { name: "Attività" })).toBeVisible();
  await checkSupportedWidths(page);

  await page.getByRole("button", { name: "Impostazioni", exact: true }).click();
  await expect(page.getByLabel("ID account Cloudflare")).toBeVisible();
  await checkSupportedWidths(page);
  await page.locator(".settings-tabs").getByRole("button", { name: "MySQL / MariaDB" }).click();
  await expect(page.getByRole("heading", { name: "MySQL / MariaDB" })).toBeVisible();
  await checkSupportedWidths(page);
  await page.locator(".settings-tabs").getByRole("button", { name: "Dati e privacy" }).click();
  await checkSupportedWidths(page);

  await page.getByRole("button", { name: "Agente AI", exact: true }).click();
  await expect(page.getByTestId("connector-section")).toBeVisible();
  await checkSupportedWidths(page);

  await page.getByRole("button", { name: "I tuoi siti", exact: true }).click();
  await page.getByRole("button", { name: "Nuovo sito" }).first().click();
  await expect(page.getByLabel("Indirizzo del sito")).toBeVisible();
  await checkSupportedWidths(page);
});

/**
 * WCAG AA contrast of every visible text on a screen: 4.5:1, or 3:1 for large text (24px, or 18.66px bold). The
 * background is the first opaque one up the tree, with semi-transparent layers blended over it.
 */
async function lowContrastTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const parse = (value: string): [number, number, number, number] | null => {
      const match = /rgba?\(([^)]+)\)/u.exec(value);
      if (!match) return null;
      const parts = (match[1] as string).split(/[\s,/]+/u).filter(Boolean).map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    const luminance = ([r, g, b]: number[]): number => {
      const channel = (value: number) => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
    };
    const background = (element: Element): number[] => {
      const layers: Array<[number, number, number, number]> = [];
      for (let current: Element | null = element; current; current = current.parentElement) {
        const color = parse(getComputedStyle(current).backgroundColor);
        if (color && color[3] > 0) {
          layers.push(color);
          if (color[3] >= 1) break;
        }
      }
      let base: number[] = [255, 255, 255];
      for (const [r, g, b, a] of layers.reverse()) base = [r * a + (base[0] as number) * (1 - a), g * a + (base[1] as number) * (1 - a), b * a + (base[2] as number) * (1 - a)];
      return base;
    };
    const failures: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      if (!element.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) continue;
      // Decorative glyphs hidden from assistive technology are exempt (WCAG 1.4.3), like disabled controls.
      if (element.closest("[disabled], [aria-disabled='true'], [aria-hidden='true'], iframe, svg, .preview-frame")) continue;
      const ownText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
      if (!ownText) continue;
      const style = getComputedStyle(element);
      const color = parse(style.color);
      if (!color) continue;
      const back = background(element);
      const front = [color[0] * color[3] + (back[0] as number) * (1 - color[3]), color[1] * color[3] + (back[1] as number) * (1 - color[3]), color[2] * color[3] + (back[2] as number) * (1 - color[3])];
      const [light, dark] = [luminance(front), luminance(back)].sort((left, right) => right - left) as [number, number];
      const ratio = (light + 0.05) / (dark + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) failures.push(`${element.tagName.toLowerCase()}.${[...element.classList].join(".")} «${element.textContent?.trim().slice(0, 40)}» ${ratio.toFixed(2)}:1`);
    }
    return failures;
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`contrasti AA sulle schermate principali, tema ${colorScheme === "light" ? "chiaro" : "scuro"}`, async ({ page }) => {
    const env = await state();
    const failures: string[] = [];
    const check = async (screen: string) => failures.push(...(await lowContrastTexts(page)).map((item) => `${screen}: ${item}`));
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${env.baseUrl}/#token=${env.token}`);
    await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
    await check("I tuoi siti");
    await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
    await check("Nuovo progetto, home");
    await newProject(page, `E2E contrasto ${colorScheme} ${Date.now()}`);
    await expect(page.getByRole("heading", { name: "Bacheca" })).toBeVisible();
    await check("progetto");
    await page.getByRole("button", { name: "Attività" }).click();
    await expect(page.getByRole("heading", { name: "Attività" })).toBeVisible();
    await check("Attività");
    await page.getByRole("button", { name: "Impostazioni", exact: true }).click();
    await expect(page.getByLabel("ID account Cloudflare")).toBeVisible();
    await check("Impostazioni, account");
    await page.locator(".settings-tabs").getByRole("button", { name: "MySQL / MariaDB" }).click();
    await expect(page.getByRole("heading", { name: "MySQL / MariaDB" })).toBeVisible();
    await check("Impostazioni, database");
    await page.locator(".settings-tabs").getByRole("button", { name: "Dati e privacy" }).click();
    await check("Impostazioni, dati");
    await page.getByRole("button", { name: "Agente AI", exact: true }).click();
    await expect(page.getByTestId("connector-section")).toBeVisible();
    await check("Agente AI");
    await page.getByRole("button", { name: "I tuoi siti", exact: true }).click();
    await page.getByRole("button", { name: "Nuovo sito" }).first().click();
    await expect(page.getByLabel("Indirizzo del sito")).toBeVisible();
    await check("Nuovo sito");
    expect([...new Set(failures)]).toEqual([]);
  });
}
