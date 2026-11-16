import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { newProject, openBuilder } from "./cms-helpers.js";

interface E2EState { baseUrl: string; token: string; mockUrl: string }

test("l'editor visuale Histeon resta leggibile e utilizzabile nei viewport stretti", async ({ page }) => {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  const env = JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
  const projectName = `E2E viewport builder ${Date.now()}`;
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await expect(page.getByRole("heading", { name: "I tuoi siti" })).toBeVisible();
  await newProject(page, projectName);
  await expect(page.getByRole("heading", { name: projectName, exact: true })).toBeVisible();
  await openBuilder(page, "Home");
  await expect(page.getByRole("button", { name: "Nuovo componente" })).toBeVisible();

  const measurements: Array<{ width: number; document: number; builder: number; topbar: number; clippedControls: string[] }> = [];
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 820 });
    await page.waitForTimeout(100);
    measurements.push(await page.evaluate(() => {
      const builder = document.querySelector<HTMLElement>(".xb");
      const topbar = document.querySelector<HTMLElement>(".topbar");
      const clippedControls = [...(topbar?.querySelectorAll<HTMLElement>("button, a") ?? [])]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.left < 0 || rect.right > window.innerWidth + 1);
        })
        .map((element) => element.innerText.trim() || element.getAttribute("aria-label") || element.className.toString());
      return {
        width: window.innerWidth,
        document: document.documentElement.scrollWidth,
        builder: builder?.scrollWidth ?? 0,
        topbar: topbar?.scrollWidth ?? 0,
        clippedControls,
      };
    }));
  }
  expect(measurements.filter((item) => item.builder > item.width || item.topbar > item.width || item.clippedControls.length > 0), JSON.stringify(measurements)).toEqual([]);

  await page.setViewportSize({ width: 320, height: 820 });
  const rightPanelToggle = page.getByRole("button", { name: "Pannelli a destra" });
  await expect(rightPanelToggle).toBeVisible();
  await expect(rightPanelToggle).toHaveAttribute("aria-expanded", "false");
  await rightPanelToggle.click();
  await expect(page.locator(".column.right [data-panel='properties']")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(rightPanelToggle).toHaveAttribute("aria-expanded", "true");
  await rightPanelToggle.click();
  await expect(page.locator(".column.right")).toBeHidden();

  const leftPanelToggle = page.getByRole("button", { name: "Pannelli a sinistra" });
  await expect(leftPanelToggle).toBeVisible();
  await leftPanelToggle.click();
  await expect(page.locator(".column.left [data-panel='structure']")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await leftPanelToggle.click();
  await expect(page.locator(".column.left")).toBeHidden();

  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      label: element.innerText.trim() || element.getAttribute("aria-label"),
      outline: style.outlineStyle,
      shadow: style.boxShadow,
      inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
    };
  });
  expect(focus?.outline === "none" && focus.shadow === "none", JSON.stringify(focus)).toBe(false);
  expect(focus?.inViewport, JSON.stringify(focus)).toBe(true);
});
