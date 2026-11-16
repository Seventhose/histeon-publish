import { expect, type Locator, type Page } from "@playwright/test";

export async function expectScreenFitsSupportedWidths(page: Page): Promise<void> {
  const originalViewport = page.viewportSize();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
    expect(sizes.document, `overflow orizzontale a ${width}px: ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.viewport + 1);
  }
  if (originalViewport) await page.setViewportSize(originalViewport);
}

export async function expectDialogFitsMobile(page: Page, dialog: Locator, width = 320): Promise<void> {
  await page.setViewportSize({ width, height: 720 });
  await expect(dialog).toBeVisible();
  const [measurement, documentWidth] = await Promise.all([
    dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const clippedControls = [...element.querySelectorAll<HTMLElement>("button, a, input, select, textarea")]
        .filter((control) => {
          const box = control.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
        })
        .map((control) => control.innerText.trim() || control.getAttribute("aria-label") || control.id || control.tagName);
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        clippedControls,
        overflowSources: [...document.querySelectorAll<HTMLElement>("body *")]
          .map((node) => ({ node, rect: node.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 0 && rect.right > window.innerWidth + 1)
          .sort((a, b) => b.rect.right - a.rect.right)
          .slice(0, 8)
          .map(({ node, rect }) => ({ tag: node.tagName, className: node.className, id: node.id, left: rect.left, right: rect.right, scrollWidth: node.scrollWidth })),
      };
    }),
    page.evaluate(() => document.documentElement.scrollWidth),
  ]);

  expect(documentWidth, JSON.stringify({ ...measurement, documentWidth })).toBeLessThanOrEqual(width + 1);
  expect(measurement.left, JSON.stringify(measurement)).toBeGreaterThanOrEqual(-1);
  expect(measurement.right, JSON.stringify(measurement)).toBeLessThanOrEqual(width + 1);
  expect(measurement.top, JSON.stringify(measurement)).toBeGreaterThanOrEqual(-1);
  expect(measurement.bottom, JSON.stringify(measurement)).toBeLessThanOrEqual(721);
  expect(measurement.clippedControls, JSON.stringify(measurement)).toEqual([]);
}
