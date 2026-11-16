import { expect, test } from "@playwright/test";
import { VIDEO_PLAYER_SCRIPT } from "../../packages/cms/dist/video-player.js";

/** List item 84: a «Video» link becomes its player only on a click, and only for YouTube (no cookies) and Vimeo. */
test("un link video diventa il lettore solo al clic, e solo per YouTube senza cookie e Vimeo (voce 84)", async ({ page }) => {
  const requested: string[] = [];
  await page.route(/youtube|vimeo/u, async (route) => {
    requested.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>lettore</title>" });
  });
  await page.setContent(`<!doctype html><html><body>
    <a class="xb-art-video" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" rel="noopener">Concerto</a>
    <a class="xb-art-video" href="https://vimeo.com/76979871" rel="noopener">Conferenza</a>
    <a class="xb-art-video" href="https://example.org/video.mp4" rel="noopener">Altro</a>
    <a class="xb-art-video" href="https://www.youtube.com/watch?v=x%22onload%3Dalert(1)" rel="noopener">Strano</a>
    <script type="module">${VIDEO_PLAYER_SCRIPT}</script></body></html>`);
  await page.waitForTimeout(100);
  expect(requested, "nothing loads before a click").toEqual([]);
  await page.getByText("Concerto").click();
  await expect(page.locator("iframe.xb-art-video-frame").first()).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
  await expect(page.locator("iframe.xb-art-video-frame").first()).toHaveAttribute("title", "Concerto");
  await page.getByText("Conferenza").click();
  await expect(page.locator("iframe.xb-art-video-frame").nth(1)).toHaveAttribute("src", "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1");
  // Any other address, or an id that is not one, stays a link.
  for (const name of ["Altro", "Strano"]) {
    await page.getByText(name).evaluate((link) => link.addEventListener("click", (event) => event.preventDefault()));
    await page.getByText(name).click();
    await expect(page.getByRole("link", { name })).toBeVisible();
  }
  await expect(page.locator("iframe")).toHaveCount(2);
});

/** The builder's Video window: the link around the poster becomes the player on a click, only with a known player. */
test("il riquadro video del builder diventa il lettore al clic, solo con l'indirizzo di un lettore noto", async ({ page }) => {
  const requested: string[] = [];
  await page.route(/youtube|vimeo/u, async (route) => {
    requested.push(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>lettore</title>" });
  });
  await page.setContent(`<!doctype html><html><body>
    <figure class="xb-video" data-xb-video="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"><a class="xb-video__play" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" aria-label="Riproduci il video: Lezione"><span class="xb-video__icon">▶</span></a></figure>
    <figure class="xb-video" data-xb-video="https://evil.example/embed/x"><a class="xb-video__play" href="https://evil.example/" aria-label="Altro">x</a></figure>
    <script type="module">${VIDEO_PLAYER_SCRIPT}</script></body></html>`);
  await page.waitForTimeout(100);
  expect(requested).toEqual([]);
  await page.getByRole("link", { name: "Riproduci il video: Lezione" }).click();
  await expect(page.locator("iframe.xb-video__frame")).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0");
  await expect(page.locator("iframe.xb-video__frame")).toHaveAttribute("title", "Riproduci il video: Lezione");
  await page.getByRole("link", { name: "Altro" }).evaluate((link) => link.addEventListener("click", (event) => event.preventDefault()));
  await page.getByRole("link", { name: "Altro" }).click();
  await expect(page.locator("iframe")).toHaveCount(1);
});
