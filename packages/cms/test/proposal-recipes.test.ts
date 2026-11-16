import { describe, expect, it } from "vitest";
import { applyProposalRecipes } from "../src/proposal-recipes.js";
import { applyRecipes } from "../src/recipes.js";
import type { SiteElement, SiteNode } from "../src/site-structure.js";
import { staticSiteProjectId, staticSiteToPrototype } from "../src/static-site-prototype.js";

const el = (tag: string, attrs: Record<string, string> = {}, ...children: Array<SiteNode | string>): SiteElement => ({ kind: "element", tag, attrs: Object.entries(attrs), children: children.map((child) => (typeof child === "string" ? { kind: "text", text: child } : child)) });
const attr = (node: SiteElement, name: string): string | undefined => node.attrs.find(([key]) => key === name)?.[1];

function tabs(): { list: SiteElement; first: SiteElement; second: SiteElement; one: SiteElement; two: SiteElement; nodes: SiteNode[] } {
  const first = el("button", { class: "scheda", type: "button", role: "tab", "data-tab": "p-0", "aria-selected": "true" }, "Tavolo");
  const second = el("button", { class: "scheda", type: "button", role: "tab", "data-tab": "p-1", "aria-selected": "false" }, "Consegna");
  const list = el("div", { class: "schede", role: "tablist" }, first, second);
  const one = el("div", { id: "p-0", role: "tabpanel" }, "Uno");
  const two = el("div", { id: "p-1", role: "tabpanel", hidden: "" }, "Due");
  return { list, first, second, one, two, nodes: [el("div", {}, list, one, two)] };
}

describe("doc 28: le schede di una proposta restano schede", () => {
  it("uno stato scritto con aria-selected e hidden riceve soltanto attributi", () => {
    const { list, first, second, one, two, nodes } = tabs();
    const before = JSON.stringify(nodes);
    const applied = applyProposalRecipes([{ slug: "home", nodes }], []);
    expect(applied.tabs).toBe(1);
    expect(attr(list, "data-xb-tabs")).toBe("");
    expect(attr(list, "role")).toBe("tablist");
    expect([attr(first, "aria-controls"), attr(second, "aria-controls")]).toEqual(["p-0", "p-1"]);
    expect([attr(first, "id"), attr(second, "id")]).toEqual(["scheda-p-0", "scheda-p-1"]);
    expect([attr(one, "aria-labelledby"), attr(two, "aria-labelledby")]).toEqual(["scheda-p-0", "scheda-p-1"]);
    // Nothing moved and nothing was taken away: the hidden panel stays hidden, the tags and the classes are the same.
    expect(attr(two, "hidden")).toBe("");
    expect(attr(one, "hidden")).toBeUndefined();
    const strip = (text: string) => text.replace(/,\["(?:data-xb-tabs|aria-controls|id|aria-labelledby)","[^"]*"\]/gu, "");
    expect(strip(JSON.stringify(nodes))).toBe(strip(before));
    expect(applied.notes[0]).toContain("1 gruppo resta a schede");
    // A second run finds nothing to do.
    expect(applyProposalRecipes([{ slug: "home", nodes }], []).tabs).toBe(0);
  });

  it("lascia stare le schede che segnano lo stato in un altro modo, e lo dice", () => {
    const byClass = tabs();
    byClass.two.attrs = byClass.two.attrs.filter(([name]) => name !== "hidden");
    expect(applyProposalRecipes([{ slug: "home", nodes: byClass.nodes }], []).notes).toEqual(["da rifare: schede: la scheda scelta non è scritta con aria-selected e hidden (lo stato è in una classe), 1 volta (.schede)"]);
    expect(attr(byClass.list, "data-xb-tabs")).toBeUndefined();

    const links = tabs();
    links.first.tag = "a";
    expect(applyProposalRecipes([{ slug: "home", nodes: links.nodes }], []).notes[0]).toContain("le schede non sono pulsanti");

    const lost = tabs();
    lost.second.attrs = lost.second.attrs.map(([name, value]) => (name === "data-tab" ? [name, "manca"] : [name, value]));
    expect(applyProposalRecipes([{ slug: "home", nodes: lost.nodes }], []).notes[0]).toContain("non porta a un pannello suo");

    const twice = tabs();
    (twice.nodes[0] as SiteElement).children.push(el("div", { id: "p-1" }, "Doppione"));
    expect(applyProposalRecipes([{ slug: "home", nodes: twice.nodes }], []).tabs).toBe(0);
  });

  it("un id che la pagina ha già non viene ripetuto", () => {
    const { first, nodes } = tabs();
    (nodes[0] as SiteElement).children.push(el("p", { id: "scheda-p-0" }, "Preso"));
    applyProposalRecipes([{ slug: "home", nodes }], []);
    expect(attr(first, "id")).toBe("scheda-p-0-2");
  });

  it("le ricette senza JavaScript, se scelte, non disfano le schede di Histeon", () => {
    const { nodes } = tabs();
    const page = { slug: "home", nodes };
    applyProposalRecipes([page], []);
    const applied = applyRecipes([page]);
    expect(applied.tabs).toBe(0);
    const text = JSON.stringify(page.nodes);
    expect(text).toContain('"data-xb-tabs"');
    expect(text).toContain('["hidden",""]');
    expect(text).toContain('["role","tabpanel"]');
  });
});

describe("doc 28: il menu da telefono di una proposta", () => {
  const header = (buttonAttrs: Record<string, string>, navAttrs: Record<string, string>) => {
    const button = el("button", { type: "button", "aria-expanded": "false", ...buttonAttrs }, "Menu");
    const nav = el("nav", navAttrs, el("a", { href: "./" }, "Home"));
    return { button, nav, nodes: [el("header", { class: "testa" }, button, nav)] as SiteNode[] };
  };

  it("una classe sul menu: affiancata da [data-open], con lo stesso peso", () => {
    const { button, nav, nodes } = header({ class: "nav-toggle", "aria-controls": "nav-1" }, { id: "nav-1", class: "testa__nav" });
    const sheets = [{ name: "Sito", css: ":where(.testa__nav.is-open) { opacity: 1; }\n.testa__nav.is-open a { color: red; }\n.testa__nav.is-scrolled { top: 0; }\n@media (width < 48rem) { .nav-toggle { display: flex; } }" }];
    const applied = applyProposalRecipes([{ slug: "home", nodes }], sheets);
    expect(applied.menus).toBe(1);
    expect(applied.rules).toBe(2);
    expect(attr(button, "data-xb-toggle")).toBe("");
    expect(attr(button, "aria-controls")).toBe("nav-1");
    expect(attr(nav, "id")).toBe("nav-1");
    expect(sheets[0]?.css).toContain(":where(.testa__nav:is(.is-open, [data-open])) { opacity: 1; }");
    expect(sheets[0]?.css).toContain(".testa__nav:is(.is-open, [data-open]) a { color: red; }");
    // A class the script wrote for something else (scrolling) is not an «open» state.
    expect(sheets[0]?.css).toContain(".testa__nav.is-scrolled { top: 0; }");
    expect(applied.notes[0]).toContain("1 pulsante apre e chiude il suo menu");
  });

  it("una classe su un antenato, senza aria-controls: il pulsante prende il menu e la regola guarda il pulsante", () => {
    const { button, nav, nodes } = header({ class: "burger", "data-menu": "", "aria-label": "Apri il menu" }, { class: "nav" });
    const sheets = [{ name: "Sito", css: ".nav { transform: translateX(-100%); }\n.menu-open .nav { transform: none; }\n.menu-open .scrim, .drawer-open .scrim { display: block; }" }];
    const applied = applyProposalRecipes([{ slug: "home", nodes }], sheets, ["view-home"]);
    expect(applied.menus).toBe(1);
    expect(attr(button, "data-xb-toggle")).toBe("menu-open");
    expect(attr(nav, "id")).toBe("menu-principale");
    expect(attr(button, "aria-controls")).toBe("menu-principale");
    const state = ':is(.menu-open, :where(:has([data-xb-toggle="menu-open"][aria-expanded="true"])))';
    expect(sheets[0]?.css).toContain(`${state} .nav { transform: none; }`);
    expect(sheets[0]?.css).toContain(`${state} .scrim, .drawer-open .scrim { display: block; }`);
  });

  it("un attributo su un antenato", () => {
    const { button, nodes } = header({ class: "menu-btn", "aria-controls": "nav", "data-menu": "" }, { id: "nav", class: "sito-nav" });
    const sheets = [{ name: "Sito", css: '.sito[data-menu="aperto"] .sito-nav { display: block; }' }];
    expect(applyProposalRecipes([{ slug: "home", nodes }], sheets).menus).toBe(1);
    expect(attr(button, "data-xb-toggle")).toBe("data-menu-aperto");
    expect(sheets[0]?.css).toBe('.sito:is([data-menu="aperto"], :where(:has([data-xb-toggle="data-menu-aperto"][aria-expanded="true"]))) .sito-nav { display: block; }');
  });

  it("uno stato che una pagina mostra già non è lo stato scritto dallo script", () => {
    const { button, nodes } = header({ class: "burger", "data-menu": "" }, { class: "nav" });
    const sheets = [{ name: "Sito", css: ".menu-open .nav { transform: none; }" }];
    const applied = applyProposalRecipes([{ slug: "home", nodes }], sheets, ["menu-open"]);
    expect(applied.menus).toBe(0);
    expect(attr(button, "data-xb-toggle")).toBeUndefined();
    expect(sheets[0]?.css).toBe(".menu-open .nav { transform: none; }");
    expect(applied.notes).toEqual(["da rifare: pulsante del menu: il CSS della proposta non dice come si apre, 1 volta (.burger)"]);
  });

  it("un pannello che lo script apriva togliendo hidden resta com'è, e il rapporto dice perché", () => {
    const { button, nav, nodes } = header({ class: "nav__btn", "aria-controls": "pan" }, { id: "pan", class: "nav__pannello", hidden: "" });
    const sheets = [{ name: "Sito", css: '[aria-expanded="true"] > .nav__segno { transform: rotate(180deg); }\n.nav__pannello { padding: 1rem; }' }];
    const applied = applyProposalRecipes([{ slug: "home", nodes }], sheets);
    expect(applied.menus).toBe(0);
    expect(attr(button, "data-xb-toggle")).toBeUndefined();
    expect(attr(nav, "hidden")).toBe("");
    expect(sheets[0]?.css).toContain(".nav__pannello { padding: 1rem; }");
    expect(applied.notes).toEqual(["da rifare: pulsante che apre un pannello chiuso con hidden: il comportamento di Histeon apre con data-open e non toglie hidden, 1 volta (.nav__btn)"]);
  });

  it("nomi che non sono identificatori semplici non entrano in un selettore", () => {
    const { button, nodes } = header({ class: "menu-btn", "aria-controls": "nav", "data-menu": "" }, { id: "nav", class: "sito-nav" });
    const css = '.sito[data-menu="aperto\\"] x{}"] .sito-nav { display: block; }\n.sito[data-menu="open ]) *"] .sito-nav { display: block; }\n.sito-nav.is\\:open { display: block; }';
    const sheets = [{ name: "Sito", css }];
    expect(applyProposalRecipes([{ slug: "home", nodes }], sheets).menus).toBe(0);
    expect(attr(button, "data-xb-toggle")).toBeUndefined();
    expect(sheets[0]?.css).toBe(css);
  });

  it("un selettore che ha già :has() non è riscritto, e un pulsante fotografato aperto resta com'è", () => {
    const { nodes } = header({ class: "burger", "data-menu": "" }, { class: "nav" });
    const sheets = [{ name: "Sito", css: ".menu-open .nav { transform: none; }\n.menu-open:has(.nav) .nav a { color: red; }" }];
    const applied = applyProposalRecipes([{ slug: "home", nodes }], sheets);
    expect(applied.rules).toBe(1);
    expect(sheets[0]?.css).toContain(".menu-open:has(.nav) .nav a { color: red; }");
    expect(applied.notes.join("\n")).toContain("1 selettore con :has() non è stato riscritto");

    const open = header({ class: "nav-toggle", "aria-controls": "n", "aria-expanded": "true" }, { id: "n", class: "nav" });
    open.button.attrs = open.button.attrs.filter(([name, value]) => !(name === "aria-expanded" && value === "false"));
    expect(applyProposalRecipes([{ slug: "home", nodes: open.nodes }], [{ name: "Sito", css: ".nav.is-open { display: block; }" }]).notes[0]).toContain("pulsante fotografato aperto");
  });
});

describe("doc 28: le ricette della proposta nella conversione", () => {
  const page = '<!doctype html><html lang="it"><head><title>P</title><style>.testa__nav{opacity:0}.testa__nav.is-open{opacity:1}.scheda[aria-selected="true"]{font-weight:700}[hidden]{display:none}</style></head><body><header class="testa"><button class="nav-toggle" type="button" aria-expanded="false" aria-controls="nav-1" aria-label="Apri il menu">Menu</button><nav class="testa__nav" id="nav-1"><a href="./">Home</a></nav></header><main><div class="schede" role="tablist"><button class="scheda" type="button" role="tab" data-tab="p-0" aria-selected="true">Uno</button><button class="scheda" type="button" role="tab" data-tab="p-1" aria-selected="false">Due</button></div><div id="p-0" role="tabpanel"><p>Primo</p></div><div id="p-1" role="tabpanel" hidden><p>Secondo</p></div></main></body></html>';
  const files = [{ path: "index.html", bytes: new TextEncoder().encode(page) }];

  it("scatta solo per una proposta fotografata", () => {
    const captured = staticSiteToPrototype({ projectId: staticSiteProjectId("p"), name: "P", files, captured: true });
    expect(captured.html).toContain("data-xb-tabs");
    expect(captured.html).toContain("data-xb-toggle");
    expect(captured.html).toContain("[data-open]");
    expect(captured.html).toMatch(/id="p-1"[^>]*hidden|hidden[^>]*id="p-1"/u);
    const notes = captured.report.notes.join("\n");
    expect(notes).toContain("1 gruppo resta a schede");
    expect(notes).toContain("1 pulsante apre e chiude il suo menu");
    // What the recipes took is no longer proposed, nor listed to be done again.
    expect(notes).not.toContain("proposta: schede");
    expect(notes).not.toContain("proposta: menu mobile");

    const plain = staticSiteToPrototype({ projectId: staticSiteProjectId("p"), name: "P", files });
    expect(plain.html).not.toContain("data-xb-tabs");
    expect(plain.html).not.toContain("data-xb-toggle");
    expect(plain.html).not.toContain("[data-open]");
    expect(plain.report.notes.join("\n")).toContain("proposta: schede");
  });
});

function classTabs(): { list: SiteElement; first: SiteElement; second: SiteElement; one: SiteElement; two: SiteElement; nodes: SiteNode[] } {
  const first = el("button", { class: "tab active", type: "button", role: "tab", "data-tab": "p-0" }, "Tavolo");
  const second = el("button", { class: "tab", type: "button", role: "tab", "data-tab": "p-1" }, "Consegna");
  const list = el("div", { class: "tabs", role: "tablist" }, first, second);
  const one = el("div", { id: "p-0", class: "panel active" }, "Uno");
  const two = el("div", { id: "p-1", class: "panel" }, "Due");
  return { list, first, second, one, two, nodes: [el("div", {}, list, one, two)] };
}
const CLASS_TABS_CSS = ".tab{color:gray}.tab.active{color:red}.panel{display:none}.panel.active{display:block}.nav a.active::after{content:''}";

describe("doc 28: schede con lo stato in una classe, solo nel caso certo", () => {
  it("il caso certo: la classe lascia la scheda e il pannello scelti, lo stato di Histeon la affianca con lo stesso peso", () => {
    const { list, first, second, one, two, nodes } = classTabs();
    const sheets = [{ name: "Foglio", css: CLASS_TABS_CSS }];
    const applied = applyProposalRecipes([{ slug: "home", nodes }], sheets);
    expect(applied.tabs).toBe(1);
    expect(attr(list, "data-xb-tabs")).toBe("");
    expect([attr(first, "aria-selected"), attr(second, "aria-selected")]).toEqual(["true", "false"]);
    expect([attr(first, "class"), attr(second, "class")]).toEqual(["tab", "tab"]);
    expect([attr(first, "id"), attr(second, "id")]).toEqual(["scheda-p-0", "scheda-p-1"]);
    expect([attr(one, "class"), attr(two, "class")]).toEqual(["panel", "panel"]);
    expect([attr(one, "hidden"), attr(two, "hidden")]).toEqual([undefined, ""]);
    expect([attr(one, "role"), attr(two, "aria-labelledby")]).toEqual(["tabpanel", "scheda-p-1"]);
    const css = sheets[0]?.css ?? "";
    // Beside the class, for these tabs and these panels only; `:where()` weighs nothing, so each form weighs a class.
    const tab = '[aria-selected="true"]:where(#scheda-p-0, #scheda-p-1)';
    const panel = ":not([hidden]):where(#p-0, #p-1)";
    expect(css).toContain(`.tab:is(.active, ${tab}, ${panel}){color:red}`);
    expect(css).toContain(`.panel:is(.active, ${tab}, ${panel}){display:block}`);
    expect(css).toContain(`.nav a:is(.active, ${tab}, ${panel})::after`);
    expect(css).toContain(".tab{color:gray}");
    expect(css).toContain(".panel{display:none}");
    expect(applied.rules).toBe(3);
    expect(applied.notes.join("\n")).toContain("schede con lo stato in una classe: in 1 gruppo");
    // A second run finds Histeon's tabs.
    expect(applyProposalRecipes([{ slug: "home", nodes }], sheets).tabs).toBe(0);
  });

  it("il caso certo scritto con :not(), e una classe di stato solo sui pannelli", () => {
    const { first, second, one, two, nodes } = classTabs();
    first.attrs = first.attrs.map(([name, value]) => (name === "class" ? [name, "tab"] : [name, value]));
    one.attrs = one.attrs.map(([name, value]) => (name === "class" ? [name, "panel panel--attivo"] : [name, value]));
    const sheets = [{ name: "Foglio", css: ".panel:not(.panel--attivo){display:none}" }];
    const applied = applyProposalRecipes([{ slug: "home", nodes }], sheets);
    expect(applied.tabs).toBe(1);
    expect([attr(first, "aria-selected"), attr(second, "aria-selected")]).toEqual(["true", "false"]);
    expect([attr(one, "class"), attr(two, "hidden")]).toEqual(["panel", ""]);
    expect(sheets[0]?.css).toBe(".panel:not(:is(.panel--attivo, :not([hidden]):where(#p-0, #p-1))){display:none}");
  });

  it("il caso dubbio resta com'è: la classe della scheda e quella del pannello non dicono la stessa cosa", () => {
    for (const change of [
      // The state class is on the first tab and on the second panel.
      (t: ReturnType<typeof classTabs>) => { t.one.attrs = [["id", "p-0"], ["class", "panel"]]; t.two.attrs = [["id", "p-1"], ["class", "panel active"]]; },
      // Two panels carry it.
      (t: ReturnType<typeof classTabs>) => { t.two.attrs = [["id", "p-1"], ["class", "panel active"]]; },
      // Two state classes on the chosen panel.
      (t: ReturnType<typeof classTabs>) => { t.one.attrs = [["id", "p-0"], ["class", "panel active is-open"]]; },
      // aria-selected says another tab.
      (t: ReturnType<typeof classTabs>) => { t.second.attrs.push(["aria-selected", "true"]); },
    ]) {
      const built = classTabs();
      change(built);
      const before = JSON.stringify(built.nodes);
      const sheets = [{ name: "Foglio", css: CLASS_TABS_CSS }];
      const applied = applyProposalRecipes([{ slug: "home", nodes: built.nodes }], sheets);
      expect(applied.tabs).toBe(0);
      expect(applied.notes).toEqual(["da rifare: schede con lo stato in una classe: non è certo quale classe lo scrive, 1 volta (.tabs)"]);
      expect(JSON.stringify(built.nodes)).toBe(before);
      expect(sheets[0]?.css).toBe(CLASS_TABS_CSS);
    }
    // A class only one tab has that is not a state (a place in the row): no state class at all, the old reason.
    const place = classTabs();
    place.first.attrs = place.first.attrs.map(([name, value]) => (name === "class" ? [name, "tab tab--prima"] : [name, value]));
    place.one.attrs = [["id", "p-0"], ["class", "panel panel--prima"]];
    expect(applyProposalRecipes([{ slug: "home", nodes: place.nodes }], [{ name: "Foglio", css: CLASS_TABS_CSS }]).notes[0]).toContain("non è scritta con aria-selected e hidden");
  });

  it("sembra certo e non lo è: i pannelli non sono nascosti da un display: none semplice", () => {
    for (const css of [
      // Hidden without leaving the layout: `hidden` would take away the room they keep.
      ".panel{visibility:hidden;opacity:0}.panel.active{visibility:visible;opacity:1}",
      // Only where a script had marked the page, only at one width, or with an !important.
      ".js .panel{display:none}.js .panel.active{display:block}",
      "@media (min-width:600px){.panel{display:none}.panel.active{display:block}}",
      ".panel{display:none!important}.panel.active{display:block!important}",
      // The rule that shows loses against the one that hides.
      ".panel.active{display:block}.box.panel{display:none}",
      // Hidden, and nothing shows the chosen one.
      ".panel{display:none}",
    ]) {
      const built = classTabs();
      if (css.includes(".box")) for (const panel of [built.one, built.two]) panel.attrs = panel.attrs.map(([name, value]) => (name === "class" ? [name, `box ${value}`] : [name, value]));
      const before = JSON.stringify(built.nodes);
      const sheets = [{ name: "Foglio", css }];
      const applied = applyProposalRecipes([{ slug: "home", nodes: built.nodes }], sheets);
      expect(applied.tabs, css).toBe(0);
      expect(applied.notes[0], css).toContain("il CSS non nasconde i pannelli con una regola semplice");
      expect(JSON.stringify(built.nodes), css).toBe(before);
      expect(sheets[0]?.css, css).toBe(css);
    }
    // Something else of the state is written on the elements: not the class alone.
    const inline = classTabs();
    inline.two.attrs.push(["style", "display:none"]);
    expect(applyProposalRecipes([{ slug: "home", nodes: inline.nodes }], [{ name: "Foglio", css: CLASS_TABS_CSS }]).notes[0]).toContain("non è scritta con aria-selected e hidden");
  });

  it("un id delle schede che in un'altra pagina è di un altro elemento ferma tutto; lo stesso gruppo in due pagine no", () => {
    const here = classTabs();
    const before = JSON.stringify(here.nodes);
    const sheets = [{ name: "Foglio", css: CLASS_TABS_CSS }];
    const applied = applyProposalRecipes([{ slug: "home", nodes: here.nodes }, { slug: "altra", nodes: [el("section", { id: "p-1" }, "Altro")] }], sheets);
    expect(applied.tabs).toBe(0);
    expect(applied.notes[0]).toContain("un id delle schede o dei pannelli è di un altro elemento del sito");
    expect(JSON.stringify(here.nodes)).toBe(before);
    expect(sheets[0]?.css).toBe(CLASS_TABS_CSS);

    const one = classTabs();
    const two = classTabs();
    const both = [{ name: "Foglio", css: CLASS_TABS_CSS }];
    expect(applyProposalRecipes([{ slug: "home", nodes: one.nodes }, { slug: "altra", nodes: two.nodes }], both).tabs).toBe(2);
    expect(both[0]?.css).toContain(".panel:is(.active, [aria-selected=\"true\"]:where(#scheda-p-0, #scheda-p-1), :not([hidden]):where(#p-0, #p-1)){display:block}");
  });

  it("passa per tutta la conversione di una proposta fotografata", async () => {
    const page = `<!doctype html><html lang="it"><head><style>${CLASS_TABS_CSS}</style></head><body><main>
<div class="tabs" role="tablist"><button class="tab active" type="button" role="tab" data-tab="p-0">Tavolo</button><button class="tab" type="button" role="tab" data-tab="p-1">Consegna</button></div>
<div id="p-0" class="panel active"><p>Uno</p></div><div id="p-1" class="panel"><p>Due</p></div></main></body></html>`;
    const captured = staticSiteToPrototype({ projectId: staticSiteProjectId("c"), name: "C", files: [{ path: "index.html", bytes: new TextEncoder().encode(page) }], captured: true });
    expect(captured.html).toContain("data-xb-tabs");
    expect(captured.html).toMatch(/id="p-1"[^>]*hidden|hidden[^>]*id="p-1"/u);
    expect(captured.html).toContain(":not([hidden]):where(#p-0, #p-1)");
    expect(captured.html).toContain('[aria-selected="true"]:where(#scheda-p-0, #scheda-p-1)');
    expect(captured.report.notes.join("\n")).toContain("schede con lo stato in una classe: in 1 gruppo");
  });
});
