import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { graphicPixels, jpeg, photoPixels, png } from "../../packages/server/test/support/test-images.js";

// The check builds a throwaway preview and encodes its images: under load it can take a minute.
test.describe.configure({ timeout: 180_000 });

interface E2EState { baseUrl: string; token: string }

async function state(): Promise<E2EState> {
  const stateFile = process.env.HISTOS_PUBLISH_E2E_STATE ?? path.join(tmpdir(), "histos-publish-e2e-43129.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as E2EState;
}

const TYPES: Record<string, string> = { avif: "image/avif", webp: "image/webp", jxl: "image/jxl", jpg: "image/jpeg", png: "image/png" };

test("la build dà alle immagini JPEG XL, AVIF e WebP: Chromium sceglie un formato moderno, con il tipo giusto e senza spostare la pagina (B6)", async ({ page, request }) => {
  const env = await state();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const photo = await jpeg(photoPixels(1200, 800));
  const graphic = await png(graphicPixels(640, 400));
  const id = crypto.randomUUID();
  const prototype = `<!doctype html><html lang="it" data-histos-prototype="1"><head><meta charset="utf-8"><title>Immagini</title>
<script type="application/json" data-histos="manifest">{"format":"histos-prototype","version":1,"id":"${id}","name":"Immagini ${id.slice(0, 8)}","framework":"none","locale":"it-IT"}</script>
<script type="application/json" data-histos="assets">[{"name":"foto","data":"data:image/jpeg;base64,${photo.toString("base64")}","alt":"Una foto"},{"name":"grafica","data":"data:image/png;base64,${graphic.toString("base64")}","alt":"Una grafica"}]</script>
<style data-histos="global" data-name="Base">img { max-width: 100%; height: auto; } .card > img { border-radius: 8px; }</style>
</head><body>
<template data-histos="page" data-slug="home" data-title="Home"><main><h1>Immagini</h1>
<p><img src="asset:foto" width="600" height="400" alt="Foto" data-test="foto"></p>
<p><img src="asset:grafica" width="640" height="400" alt="Grafica" data-test="grafica"></p>
<div class="card"><img src="asset:foto" width="300" height="200" alt="Nella card" data-test="card"></div>
</main></template>
</body></html>`;
  await page.goto(`${env.baseUrl}/#token=${env.token}`);
  await page.locator(".main-nav").getByRole("button", { name: "I tuoi siti" }).click();
  await page.getByTestId("cms-import-input").setInputFiles({ name: "immagini.html", mimeType: "text/html", buffer: Buffer.from(prototype) });
  const check = page.getByTestId("cms-prototype-check");
  await expect(check).toBeVisible({ timeout: 120_000 });
  // The check says what the build measured: two files with variants, two <picture>, the card's image left as it is.
  const images = check.getByTestId("cms-prototype-images");
  await expect(images).toContainText("Immagini moderne: 2 immagini hanno le varianti (2 <picture>;");
  await expect(images).toContainText("il CSS della pagina selezionerebbe altri elementi (.card > img)");
  const href = new URL((await check.getByTestId("cms-prototype-preview").getAttribute("href"))!, env.baseUrl);
  const preview = await page.context().newPage();
  await preview.setViewportSize({ width: 1280, height: 900 });
  await preview.goto(href.toString());
  await preview.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
  const shown = await preview.evaluate(() => [...document.images].map((image) => ({
    name: image.dataset.test,
    src: image.getAttribute("src"),
    currentSrc: new URL(image.currentSrc).pathname,
    parent: image.parentElement?.tagName.toLowerCase(),
    sources: [...(image.parentElement?.querySelectorAll("source") ?? [])].map((source) => source.type),
    width: image.getBoundingClientRect().width,
    height: image.getBoundingClientRect().height,
  })));
  const foto = shown.find((item) => item.name === "foto")!;
  const grafica = shown.find((item) => item.name === "grafica")!;
  const card = shown.find((item) => item.name === "card")!;
  // Chromium shows AVIF (and JPEG XL only where it decodes it): the JPEG's first source it can show is modern.
  expect(foto.parent).toBe("picture");
  expect(foto.sources).toContain("image/avif");
  expect(foto.currentSrc).toMatch(/\/media\/[0-9a-f]{64}\.(?:avif|jxl)$/u);
  // The PNG stays lossless: no AVIF; Chromium takes WebP (or JPEG XL).
  expect(grafica.parent).toBe("picture");
  expect(grafica.sources).not.toContain("image/avif");
  expect(grafica.currentSrc).toMatch(/\/media\/[0-9a-f]{64}\.(?:webp|jxl)$/u);
  // The card's image keeps only its original: its CSS selects it as a child.
  expect(card.parent).toBe("div");
  expect(card.currentSrc).toBe(card.src);
  // The page does not move: each image is as wide and high as its attributes say.
  expect([foto.width, foto.height]).toEqual([600, 400]);
  expect([grafica.width, grafica.height]).toEqual([640, 400]);
  // Every file is served with the type its name says, the variants and the originals.
  const files = await preview.evaluate(() => [...new Set([...document.querySelectorAll("source")].flatMap((source) => source.srcset.split(",").map((part) => part.trim().split(/\s+/u)[0]!)).concat([...document.images].map((image) => image.getAttribute("src")!)))]);
  expect(files.some((file) => file.endsWith(".avif"))).toBe(true);
  expect(files.some((file) => file.endsWith(".webp"))).toBe(true);
  for (const file of files) {
    const response = await request.get(new URL(file, href).toString());
    expect(response.status(), file).toBe(200);
    expect(response.headers()["content-type"], file).toBe(TYPES[file.split(".").pop()!]);
  }
  await preview.close();
  expect(pageErrors).toEqual([]);
});
