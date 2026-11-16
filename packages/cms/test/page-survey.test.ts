import { describe, expect, it } from "vitest";
import { alignSurveys, PAGE_SURVEY_MAX_ELEMENTS, PAGE_SURVEY_SCRIPT, readPageSurvey, surveyDifferences, type PageSurvey, type SurveyedElement } from "../src/page-survey.js";

// «Uguale alla proposta», il perché degli scarti: la parte che non dipende dal browser. Lo script gira nell'app (tests/electron).
const element = (tag: string, text = "", props: Record<string, string> = {}, rect: [number, number, number, number] = [0, 0, 100, 20], cls = ""): SurveyedElement => ({ tag, cls, text, rect, props });
const survey = (elements: SurveyedElement[], fonts: PageSurvey["fonts"] = [], height = 900): PageSurvey => ({ width: 1280, height, elements, fonts });

describe("PAGE_SURVEY_SCRIPT", () => {
  it("è una funzione sola, senza accenti gravi né segnaposto, con il suo limite di elementi", () => {
    expect(PAGE_SURVEY_SCRIPT).not.toContain("`");
    expect(PAGE_SURVEY_SCRIPT).not.toContain("${");
    expect(PAGE_SURVEY_SCRIPT).toContain(`const MAX = ${PAGE_SURVEY_MAX_ELEMENTS};`);
    expect(typeof new Function(`return ${PAGE_SURVEY_SCRIPT}`)()).toBe("function");
  });
});

// Lo script fuori dal browser: un documento finto con un elemento solo e una tela che «dipinge» i colori dati.
type Pixel = [number, number, number, number];
async function surveyed(style: Record<string, string>, pixels: Record<string, Pixel>, withCanvas = true): Promise<Record<string, string>> {
  const element = { localName: "div", childNodes: [], children: [], getAttribute: () => "wall", getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) };
  let fill = "#000";
  const pen = { clearRect() {}, fillRect() {}, set fillStyle(value: string) { if (value === "#000" || value in pixels) fill = value; }, getImageData: () => ({ data: pixels[fill] ?? [0, 0, 0, 255] }) };
  const computed = (_element: unknown, which?: string) => (which ? { content: "none" } : new Proxy(style, { get: (target, name) => target[String(name)] ?? "" }));
  const doc = { body: element, querySelector: () => null, createElement: () => ({ getContext: () => (withCanvas ? pen : null) }), fonts: [], scrollingElement: { scrollHeight: 100 }, defaultView: { scrollY: 0, innerWidth: 1280, getComputedStyle: computed } };
  const run = new Function("document", `return ${PAGE_SURVEY_SCRIPT}`)(doc) as (options: object) => Promise<unknown>;
  const read = readPageSurvey(await run({}));
  expect(read?.elements).toHaveLength(1);
  return read?.elements[0]?.props ?? {};
}
const CREAM: Record<string, Pixel> = { "rgb(241, 229, 207)": [241, 229, 207, 255], "oklch(0.926 0.032 82.8)": [242, 229, 206, 255], "rgba(0, 0, 0, 0)": [0, 0, 0, 0], "rgb(90, 20, 20)": [90, 20, 20, 255] };
const causes = async (left: Record<string, string>, right: Record<string, string>, pixels = CREAM) => surveyDifferences(survey([element("div", "", await surveyed(left, pixels))]), survey([element("div", "", await surveyed(right, pixels))])).properties;

describe("PAGE_SURVEY_SCRIPT, i colori dentro gradienti e ombre", () => {
  it("lo stesso colore scritto rgb da un lato e oklch dall'altro non è uno scarto", async () => {
    const left = { backgroundImage: "radial-gradient(at 30% 20%, rgb(241, 229, 207), rgba(0, 0, 0, 0) 60%), none" };
    const right = { backgroundImage: "radial-gradient(at 30% 20%, oklch(0.926 0.032 82.8), rgba(0, 0, 0, 0) 60%), none" };
    expect((await surveyed(left, CREAM)).backgroundImage).toBe("radial-gradient(at 30% 20%, rgba(241,229,207,1.00), rgba(0,0,0,0.00) 60%), none");
    expect(await causes(left, right)).toEqual([]);
    // Un altro colore, o lo stesso colore in un altro punto, resta uno scarto.
    expect(await causes(left, { backgroundImage: "radial-gradient(at 30% 20%, rgb(90, 20, 20), rgba(0, 0, 0, 0) 60%), none" })).toEqual([{ property: "backgroundImage", count: 1, examples: ["div: radial-gradient(at 30% 20%, rgba(241,229,207,1.00), rgba(0,0,0,0.00) 60%), none → radial-gradient(at 30% 20%, rgba(90,20,20,1.00), rgba(0,0,0,0.00) 60%), none"] }]);
    expect((await causes(left, { backgroundImage: "radial-gradient(at 30% 20%, oklch(0.926 0.032 82.8), rgba(0, 0, 0, 0) 50%), none" })).map((item) => item.property)).toEqual(["backgroundImage"]);
  });

  it("un valore lungo porta l'impronta della forma e i colori: si confronta allo stesso modo", async () => {
    const stops = (color: string, last = color) => `repeating-linear-gradient(0deg, ${Array.from({ length: 6 }, (_, index) => `${index === 5 ? last : color} ${index * 7}px`).join(", ")}), linear-gradient(rgba(0, 0, 0, 0), ${color})`;
    const left = await surveyed({ backgroundImage: stops("rgb(241, 229, 207)") }, CREAM);
    expect(left.backgroundImage).toMatch(/^repeating-linear-gradient\(0deg, rgba\(241…#[0-9a-z]+¦(?:f1e5cfff){6}00000000f1e5cfff$/u);
    expect(await causes({ backgroundImage: stops("rgb(241, 229, 207)") }, { backgroundImage: stops("oklch(0.926 0.032 82.8)") })).toEqual([]);
    const other = await causes({ backgroundImage: stops("rgb(241, 229, 207)") }, { backgroundImage: stops("oklch(0.926 0.032 82.8)", "rgb(90, 20, 20)") });
    expect(other).toEqual([{ property: "backgroundImage", count: 1, examples: ["div: repeating-linear-gradient(0deg, rgba(241… → repeating-linear-gradient(0deg, rgba(242…"] }]);
    // La forma: gli stessi colori con un passo spostato.
    expect((await causes({ backgroundImage: stops("rgb(241, 229, 207)") }, { backgroundImage: stops("rgb(241, 229, 207)").replace("7px", "8px") })).map((item) => item.property)).toEqual(["backgroundImage"]);
  });

  it("oltre diciassette colori i restanti entrano in un'impronta, e il valore resta sotto il taglio del rilievo", async () => {
    const many = (color: string) => `linear-gradient(${Array.from({ length: 24 }, (_, index) => `${color} ${index}%`).join(", ")})`;
    const value = (await surveyed({ backgroundImage: many("rgb(241, 229, 207)") }, CREAM)).backgroundImage ?? "";
    expect(value).toMatch(/¦(?:f1e5cfff){17}\+[0-9a-z]+$/u);
    expect(value.length).toBeLessThanOrEqual(200);
    expect(await causes({ backgroundImage: many("rgb(241, 229, 207)") }, { backgroundImage: many("rgb(241, 229, 207)") })).toEqual([]);
    expect((await causes({ backgroundImage: many("rgb(241, 229, 207)") }, { backgroundImage: many("rgb(90, 20, 20)") })).map((item) => item.property)).toEqual(["backgroundImage"]);
  });

  it("ombre e filtri: il colore in testa o in coda, come dipinto", async () => {
    const pixels: Record<string, Pixel> = { "rgba(60, 40, 20, 0.3)": [60, 40, 20, 77], "oklch(0.3 0.04 70 / 0.3)": [63, 40, 17, 77], "rgb(255, 255, 255)": [255, 255, 255, 255] };
    expect(await causes({ boxShadow: "rgba(60, 40, 20, 0.3) 0px 1px 2px 0px, rgb(255, 255, 255) 0px 0px 0px 1px inset", textShadow: "rgba(60, 40, 20, 0.3) 1px 1px 0px", filter: "drop-shadow(rgba(60, 40, 20, 0.3) 0px 2px 4px)" }, { boxShadow: "oklch(0.3 0.04 70 / 0.3) 0px 1px 2px 0px, rgb(255, 255, 255) 0px 0px 0px 1px inset", textShadow: "oklch(0.3 0.04 70 / 0.3) 1px 1px 0px", filter: "drop-shadow(oklch(0.3 0.04 70 / 0.3) 0px 2px 4px)" }, pixels)).toEqual([]);
    expect((await causes({ boxShadow: "rgba(60, 40, 20, 0.3) 0px 1px 2px 0px" }, { boxShadow: "rgba(60, 40, 20, 0.3) 0px 1px 6px 0px" }, pixels)).map((item) => item.property)).toEqual(["boxShadow"]);
  });

  it("un'immagine di sfondo è «un'immagine» anche quando il suo indirizzo contiene parentesi e apici", async () => {
    const left = { backgroundImage: "url(\"data:image/svg+xml,%3Csvg fill='rgb(0,0,0)' d='M0 0(1)'/%3E\"), radial-gradient(rgb(241, 229, 207), rgba(0, 0, 0, 0))" };
    const right = { backgroundImage: "url(\"https://sito.example/media/sfondo-1a2b.svg\"), radial-gradient(oklch(0.926 0.032 82.8), rgba(0, 0, 0, 0))" };
    expect((await surveyed(left, CREAM)).backgroundImage).toBe("url(…), radial-gradient(rgba(241,229,207,1.00), rgba(0,0,0,0.00))");
    expect(await causes(left, right)).toEqual([]);
  });

  it("senza tela i valori restano come scritti: diversi nel testo, diversi nel rilievo", async () => {
    const value = "radial-gradient(rgb(241, 229, 207), rgba(0, 0, 0, 0))";
    expect((await surveyed({ backgroundImage: value }, CREAM, false)).backgroundImage).toBe(value);
  });
});

describe("readPageSurvey", () => {
  it("prende solo ciò che ha la forma di un rilievo e taglia ogni testo", () => {
    const read = readPageSurvey({ width: 1280, height: 2000, elements: [{ tag: "h1", cls: "c".repeat(200), text: "t".repeat(200), rect: [0, 0, 10, 10], props: { color: "x".repeat(500), strano: 7 }, altro: "via" }], fonts: [{ family: "inter", loaded: true }, "no", { family: 3 }] });
    expect(read?.elements).toHaveLength(1);
    expect(read?.elements[0]?.cls).toHaveLength(80);
    expect(read?.elements[0]?.text).toHaveLength(40);
    expect(read?.elements[0]?.props).toEqual({ color: "x".repeat(200) });
    expect(read?.fonts).toEqual([{ family: "inter", loaded: true }]);
  });

  it("rifiuta ciò che non è un rilievo", () => {
    for (const value of [null, "testo", 3, {}, { width: 1, height: 1 }, { width: "1", height: 1, elements: [] }, { width: 1, height: 1, elements: [null] }, { width: 1, height: 1, elements: [{ tag: "p", rect: [0, 0, 1], props: {} }] }, { width: 1, height: 1, elements: [{ tag: "p", rect: [0, 0, 1, Number.NaN], props: {} }] }, { width: 1, height: 1, elements: [{ tag: 1, rect: [0, 0, 1, 1], props: {} }] }]) expect(readPageSurvey(value)).toBeNull();
  });

  it("non tiene più elementi del limite", () => {
    const many = Array.from({ length: PAGE_SURVEY_MAX_ELEMENTS + 50 }, () => ({ tag: "p", rect: [0, 0, 1, 1], props: {} }));
    expect(readPageSurvey({ width: 1, height: 1, elements: many })?.elements).toHaveLength(PAGE_SURVEY_MAX_ELEMENTS);
  });
});

describe("alignSurveys", () => {
  it("appaia gli elementi uguali anche con qualche elemento in più da un lato", () => {
    const left = [element("header"), element("h1", "Trattoria"), element("p", "Benvenuti"), element("footer")];
    const right = [element("header"), element("div"), element("h1", "Trattoria"), element("p", "Benvenuti"), element("footer")];
    const aligned = alignSurveys(left, right);
    expect(aligned.pairs).toHaveLength(4);
    expect(aligned.onlyLeft).toHaveLength(0);
    expect(aligned.onlyRight.map((item) => item.tag)).toEqual(["div"]);
  });

  it("senza un uguale vicino appaia due elementi dello stesso tag, e lascia soli gli altri", () => {
    const aligned = alignSurveys([element("p", "uno"), element("img")], [element("p", "due"), element("svg")]);
    expect(aligned.pairs).toHaveLength(1);
    expect(aligned.onlyLeft.map((item) => item.tag)).toEqual(["img"]);
    expect(aligned.onlyRight.map((item) => item.tag)).toEqual(["svg"]);
  });
});

describe("surveyDifferences", () => {
  it("raggruppa gli scarti per proprietà, i più frequenti prima, con esempi «elemento: prima → dopo»", () => {
    const left = survey([element("h1", "Trattoria", { fontSize: "40px", color: "rgba(10,10,10,1.00)" }, [0, 0, 600, 48], "hero__title grande"), element("p", "Uno", { fontSize: "17px" }), element("p", "Due", { fontSize: "17px" })], [{ family: "playfair display", loaded: true }], 1800);
    const right = survey([element("h1", "Trattoria", { fontSize: "36px", color: "rgba(11,10,9,1.00)" }, [0, 0, 600, 44], "hero__title"), element("p", "Uno", { fontSize: "16px" }), element("p", "Due", { fontSize: "16px" })], [{ family: "playfair display", loaded: false }], 1750);
    const found = surveyDifferences(left, right);
    expect(found.paired).toBe(3);
    expect(found.properties).toEqual([{ property: "fontSize", count: 3, examples: ["h1.hero__title «Trattoria»: 40px → 36px", "p «Uno»: 17px → 16px", "p «Due»: 17px → 16px"] }]);
    expect(found.boxes).toBe(1);
    expect(found.boxExamples).toEqual(["h1.hero__title «Trattoria»: 600×48 → 600×44"]);
    expect(found.fontsMissing).toEqual(["playfair display"]);
    expect(found.heights).toEqual([1800, 1750]);
  });

  it("mezzo pixel e due livelli di colore non sono uno scarto; una proprietà che un lato non ha lo è", () => {
    const left = survey([element("p", "a", { marginTop: "16.4px", color: "rgba(0,0,0,1.00)", "::before content": "\"•\"" })]);
    const right = survey([element("p", "a", { marginTop: "16px", color: "rgba(2,1,0,0.99)" })]);
    expect(surveyDifferences(left, right).properties).toEqual([{ property: "::before content", count: 1, examples: ["p «a»: \"•\" → —"] }]);
  });

  it("un colore trasparente si confronta come dipinto: due livelli sulla pagina, non due livelli del colore", () => {
    const pair = (a: string, b: string) => surveyDifferences(survey([element("p", "a", { color: a })]), survey([element("p", "a", { color: b })])).properties.length;
    // Al 30 % un passo della tela vale tre livelli del colore; al 100 % tre livelli sono uno scarto.
    expect(pair("rgba(60,40,20,0.30)", "rgba(63,40,17,0.30)")).toBe(0);
    expect(pair("rgba(60,40,20,1.00)", "rgba(63,40,17,1.00)")).toBe(1);
    expect(pair("rgba(60,40,20,0.30)", "rgba(80,40,20,0.30)")).toBe(1);
    expect(pair("rgba(60,40,20,0.30)", "rgba(60,40,20,0.40)")).toBe(1);
    // Del tutto trasparente: il colore non si vede.
    expect(pair("rgba(0,0,0,0.00)", "rgba(255,255,255,0.00)")).toBe(0);
  });

  it("la misura del testo si distingue al ventesimo di pixel, anche in uno pseudo-elemento", () => {
    const left = survey([element("p", "a", { fontSize: "18px", paddingTop: "18px", "::after fontSize": "12px" })]);
    const right = survey([element("p", "a", { fontSize: "18.3px", paddingTop: "18.3px", "::after fontSize": "12.02px" })]);
    expect(surveyDifferences(left, right).properties).toEqual([{ property: "fontSize", count: 1, examples: ["p «a»: 18px → 18.3px"] }]);
  });

  it("le misure che la conversione dà a un'immagine caricata non sono uno scarto: la sua forma resta la sua", () => {
    const image = (aspectRatio: string, loaded = "true", naturalSize = "1200x800") => element("img", "", { aspectRatio, loaded, naturalSize });
    expect(surveyDifferences(survey([image("auto")]), survey([image("auto 1200 / 800")])).properties).toEqual([]);
    // Not loaded, another image, or proportions the page forces: the box can change, so it is said.
    expect(surveyDifferences(survey([image("auto")]), survey([image("auto 1200 / 800", "false")])).properties.map((item) => item.property)).toEqual(["aspectRatio", "loaded"]);
    expect(surveyDifferences(survey([image("auto")]), survey([image("auto 600 / 600", "true", "600x600")])).properties.map((item) => item.property)).toEqual(["aspectRatio", "naturalSize"]);
    expect(surveyDifferences(survey([image("auto")]), survey([image("1 / 1")])).properties.map((item) => item.property)).toEqual(["aspectRatio"]);
    expect(surveyDifferences(survey([element("div", "", { aspectRatio: "auto" })]), survey([element("div", "", { aspectRatio: "auto 3 / 2" })])).properties.map((item) => item.property)).toEqual(["aspectRatio"]);
  });

  it("tiene al più le proprietà chieste e tre esempi ciascuna", () => {
    const names = Array.from({ length: 20 }, (_, index) => `prop${String(index).padStart(2, "0")}`);
    const side = (value: string) => survey(Array.from({ length: 5 }, (_, index) => element("p", `riga ${index}`, Object.fromEntries(names.map((name) => [name, value])))));
    const found = surveyDifferences(side("a"), side("b"), 4);
    expect(found.properties).toHaveLength(4);
    expect(found.properties[0]?.count).toBe(5);
    expect(found.properties[0]?.examples).toHaveLength(3);
  });
});
