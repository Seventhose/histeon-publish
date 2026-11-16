import { readFileSync } from "node:fs";
import type { StaticPageProfile } from "@histos-publish/cms";
import { describe, expect, it } from "vitest";
import { assertRemotePhp, assertRemoteSupportsMarkup, assertRemoteSupportsProducts, assertRemoteSupportsProfile } from "../src/cms-remote.js";
import { validateCapabilities } from "../src/cms-remote-transport.js";

describe("profilo v4 verso WordPress", () => {
  const capabilities = (profiles: string[]) => validateCapabilities({
    contractVersion: 2, profile: "histos-static-page-v1", siteId: "550e8400-e29b-41d4-a716-446655440301", projectId: null, canInitializeProject: true,
    projectName: "Sito", capabilities: { read: true, write: true, publish: false, profiles },
  });

  it("riconosce un sito che dichiara il profilo con articoli e ruoli", () => {
    const site = capabilities(["histos-static-page-v1", "histos-static-project-v3", "histos-static-project-v4", "histos-static-project-v9"]);
    expect(site.profiles).toEqual(["histos-static-page-v1", "histos-static-project-v3", "histos-static-project-v4"]);
    expect(() => assertRemoteSupportsProfile(site.profiles, "histos-static-project-v4")).not.toThrow();
  });

  it("non invia nulla a un sito che non legge articoli e ruoli", () => {
    const site = capabilities(["histos-static-page-v1", "histos-static-project-v3"]);
    expect(() => assertRemoteSupportsProfile(site.profiles, "histos-static-project-v4")).toThrow(/articoli e ruoli dei modelli.*non ho inviato nulla/u);
    expect(() => assertRemoteSupportsProfile(site.profiles, "histos-static-project-v3")).not.toThrow();
  });
});

describe("markup histos-transfer-markup-v1 verso WordPress", () => {
  const capabilities = (extra: Record<string, unknown>) => validateCapabilities({
    contractVersion: 2, profile: "histos-static-page-v1", siteId: "550e8400-e29b-41d4-a716-446655440301", projectId: null, canInitializeProject: true,
    projectName: "Sito", capabilities: { read: true, write: true, publish: false, profiles: ["histos-static-page-v1", "histos-static-project-v1"], ...extra },
  });
  const fixture = (name: string) => (JSON.parse(readFileSync(new URL(`../../histos-contract/test/fixtures/${name}`, import.meta.url), "utf8")) as { profile: StaticPageProfile }).profile;

  it("legge solo i markup noti dichiarati dal sito", () => {
    expect(capabilities({}).markup).toEqual([]);
    expect(capabilities({ markup: "histos-transfer-markup-v1" }).markup).toEqual([]);
    expect(capabilities({ markup: ["histos-transfer-markup-v1", "histos-transfer-markup-v9", 1, "histos-transfer-markup-v1"] }).markup).toEqual(["histos-transfer-markup-v1"]);
  });

  it("non invia SVG, picture, details o testo dei campi a un sito che non li dichiara, e invia il resto", () => {
    const markup = fixture("histos-static-markup-v1.json");
    expect(() => assertRemoteSupportsMarkup(capabilities({}).markup, markup)).toThrow(/non supporta SVG, immagini responsive, dettagli e testo nei campi.*non ho inviato nulla/u);
    expect(() => assertRemoteSupportsMarkup(capabilities({ markup: ["histos-transfer-markup-v1"] }).markup, markup)).not.toThrow();
    expect(() => assertRemoteSupportsMarkup([], fixture("histos-static-page-v1.json"))).not.toThrow();
  });
});

describe("prodotti verso WordPress (C6)", () => {
  const capabilities = (extra: Record<string, unknown>) => validateCapabilities({
    contractVersion: 2, profile: "histos-static-page-v1", siteId: "550e8400-e29b-41d4-a716-446655440301", projectId: null, canInitializeProject: true,
    projectName: "Sito", capabilities: { read: true, write: true, publish: false, profiles: ["histos-static-page-v1", "histos-static-project-v3"], ...extra },
  });
  const profile = (requiredCapabilities: string[]) => ({ manifest: { requiredCapabilities } }) as unknown as StaticPageProfile;

  it("invia i prodotti solo a un sito che dichiara commerce:products:v1, cioè con WooCommerce attivo", () => {
    expect(capabilities({}).commerce).toEqual([]);
    expect(capabilities({ commerce: ["commerce:products:v9", "commerce:products:v1", 1] }).commerce).toEqual(["commerce:products:v1"]);
    expect(() => assertRemoteSupportsProducts(capabilities({}).commerce, profile(["content:types:v1", "commerce:products:v1"]))).toThrow(/non ha WooCommerce attivo.*non ho inviato nulla/u);
    expect(() => assertRemoteSupportsProducts(capabilities({ commerce: ["commerce:products:v1"] }).commerce, profile(["content:types:v1", "commerce:products:v1"]))).not.toThrow();
    expect(() => assertRemoteSupportsProducts([], profile(["content:types:v1"]))).not.toThrow();
  });
});

describe("PHP del sito prima di un invio (doc 23, voce 125)", () => {
  const read = (environment: unknown) => validateCapabilities({
    contractVersion: 2, profile: "histos-static-page-v1", siteId: "550e8400-e29b-41d4-a716-446655440301", projectId: null, canInitializeProject: true,
    projectName: "Sito", capabilities: { read: true, write: true, publish: false, profiles: ["histos-static-page-v1"] }, ...(environment === undefined ? {} : { environment }),
  });

  it("legge PHP e Histeon quando il sito li dice, e niente altrimenti", () => {
    expect(read({ php: "8.4.18", histeon: "0.5.2" })).toMatchObject({ php: "8.4.18", histeon: "0.5.2" });
    expect(read(undefined)).toMatchObject({ php: null, histeon: null });
    expect(read({ php: "<script>", histeon: 5 })).toMatchObject({ php: null, histeon: null });
  });

  it("ferma l'invio a un sito con PHP più vecchio di 8.3, con la sua versione", () => {
    expect(() => assertRemotePhp("8.2.27")).toThrow(/PHP 8\.2\.27.*8\.3/u);
    expect(() => assertRemotePhp("7.4")).toThrow();
    for (const ok of ["8.3.0", "8.4.18", "8.5.1", "9.0"]) expect(() => assertRemotePhp(ok)).not.toThrow();
    expect(() => assertRemotePhp(null)).not.toThrow();
  });
});
