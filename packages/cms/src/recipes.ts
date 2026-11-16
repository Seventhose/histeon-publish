import type { SiteElement, SiteNode } from "./site-structure.js";

/**
 * Doc 18 §6.6: the recipes of the AI manual (§6) applied to a converted site, when the user chooses them in the check
 * dialog. Each pattern a script drives becomes markup and CSS that work without JavaScript, in the builder's canvas too:
 * - a carousel (Swiper, Bootstrap, Splide, Glide, Slick) → a row that scrolls with `scroll-snap`, without its arrows
 *   and dots;
 * - an accordion (Bootstrap's `.accordion-item`, or a button with `aria-expanded` and `aria-controls` over its panel)
 *   → `<details name>`, one open at a time in a group;
 * - tabs (`role="tablist"`) → links to the panels, all shown one under the other;
 * - a menu toggle (a button with `aria-expanded` that opens a nav) → `<details>` with a copy of the menu, where the
 *   button was, so the site's CSS that showed the button only on phones does the same for it;
 * - a modal (a dialog the conversion kept) → a section shown in its place, and its openers → links to it.
 * The site's scripts then stay out of the page (static-site-prototype.ts). Every change is markup the import checks as
 * usual; styles are written as `style=""`, which the conversion moves into the element's class.
 */

const CAROUSEL = /(?:^|\s)(?:swiper|carousel|splide|glide|slick-slider)(?:\s|$)/u;
const TRACK = /(?:^|\s)(?:swiper-wrapper|carousel-inner|splide__list|glide__slides|slick-track)(?:\s|$)/u;
const CAROUSEL_CONTROLS = /(?:^|\s)(?:swiper-(?:pagination|button-prev|button-next|scrollbar)|carousel-(?:control-prev|control-next|indicators)|splide__(?:arrows|pagination)|glide__(?:arrows|bullets)|slick-(?:arrow|dots|prev|next))(?:\s|$)/u;
const MENU_HINT = /menu|nav|toggle|burger|hamburger/iu;
const CLOSE_HINT = /(?:^|\s|-|_)close(?:\s|-|_|$)/iu;

export interface RecipesApplied {
  carousels: number;
  accordions: number;
  tabs: number;
  menus: number;
  modals: number;
}

const attributeOf = (node: SiteElement, name: string): string | undefined => node.attrs.find(([key]) => key === name)?.[1];
const classesOf = (node: SiteElement): string[] => (attributeOf(node, "class") ?? "").split(/\s+/u).filter(Boolean);
const elementsOf = (nodes: readonly SiteNode[]): SiteElement[] => nodes.filter((node): node is SiteElement => node.kind === "element");
function withoutAttributes(node: SiteElement, names: readonly string[]): Array<[string, string]> {
  return node.attrs.filter(([name]) => !names.includes(name));
}
function addStyle(node: SiteElement, style: string): void {
  const index = node.attrs.findIndex(([name]) => name === "style");
  if (index < 0) node.attrs.push(["style", style]);
  else node.attrs[index] = ["style", `${(node.attrs[index]?.[1] ?? "").replace(/;\s*$/u, "")}; ${style}`];
}
/** Every element of a tree, without recursion. */
function everyElement(nodes: readonly SiteNode[]): SiteElement[] {
  const out: SiteElement[] = [];
  const stack = [...nodes].reverse();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.kind !== "element") continue;
    out.push(node);
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index] as SiteNode);
  }
  return out;
}
function copy(node: SiteNode): SiteNode {
  return node.kind === "text" ? { ...node } : { ...node, attrs: node.attrs.map(([name, value]) => [name, value] as [string, string]), children: node.children.map(copy) };
}
/** An element's content with the ids taken out, for a copy that must not repeat them. */
function withoutIds(nodes: readonly SiteNode[]): SiteNode[] {
  return nodes.map((node) => (node.kind === "text" ? node : { ...node, attrs: node.attrs.filter(([name]) => name !== "id"), children: withoutIds(node.children) }));
}

/** Applies the recipes to the pages in place; returns how many of each. */
export function applyRecipes(pages: ReadonlyArray<{ nodes: SiteNode[] }>): RecipesApplied {
  const applied: RecipesApplied = { carousels: 0, accordions: 0, tabs: 0, menus: 0, modals: 0 };
  for (const page of pages) {
    const all = everyElement(page.nodes);
    const byId = new Map(all.flatMap((node) => { const id = attributeOf(node, "id"); return id ? [[id, node] as const] : []; }));
    /** Elements that become part of a details, or are copied into one: they leave their place. */
    const moved = new Set<SiteElement>();
    const dialogs = new Set(all.filter((node) => attributeOf(node, "data-histos-dialog") !== undefined));
    /** The accordion group: each `.accordion` of the page names its items' details anew (one open at a time). */
    let group = 0;

    /** Panels of tabs that already are Histeon's (doc 28, proposal-recipes.ts): they stay as they are. */
    const histeonPanels = new Set(all.filter((node) => attributeOf(node, "data-xb-tabs") !== undefined).flatMap((list) => everyElement(list.children)).flatMap((tab) => attributeOf(tab, "aria-controls") ?? []));

    const targetOf = (node: SiteElement): SiteElement | undefined => {
      const reference = attributeOf(node, "aria-controls") ?? attributeOf(node, "data-bs-target")?.replace(/^#/u, "") ?? attributeOf(node, "data-target")?.replace(/^#/u, "") ?? attributeOf(node, "data-modal");
      return reference && /^[A-Za-z][\w-]*$/u.test(reference) ? byId.get(reference) : undefined;
    };

    const transform = (nodes: SiteNode[]): SiteNode[] => {
      const out: SiteNode[] = [];
      for (const node of nodes) {
        if (node.kind !== "element") {
          out.push(node);
          continue;
        }
        if (moved.has(node)) continue;
        const classes = classesOf(node);
        const classText = classes.join(" ");

        // Modal: the openers become links to the section the dialog becomes; its close buttons go.
        const target = targetOf(node);
        if (node.tag === "button" && target && dialogs.has(target)) {
          out.push({ kind: "element", tag: "a", attrs: [["href", `#${attributeOf(target, "id")}`], ...withoutAttributes(node, ["type", "aria-controls", "aria-expanded", "data-bs-target", "data-target", "data-modal", "data-bs-toggle", "data-histos-js", "name", "value", "disabled", "form"])], children: transform(node.children) });
          continue;
        }
        if (dialogs.has(node)) {
          applied.modals++;
          const children = node.children.filter((child) => !(child.kind === "element" && child.tag === "button" && CLOSE_HINT.test(`${attributeOf(child, "class") ?? ""} ${child.children.map((inner) => (inner.kind === "text" ? inner.text : "")).join("")}`)));
          out.push({ ...node, attrs: withoutAttributes(node, ["hidden", "data-histos-dialog", "role", "aria-modal"]), children: transform(children) });
          continue;
        }

        // Carousel: a row that scrolls, its controls gone.
        if (CAROUSEL.test(classText) && !TRACK.test(classText)) {
          applied.carousels++;
          const strip = (list: SiteNode[]): SiteNode[] => list.filter((child) => !(child.kind === "element" && CAROUSEL_CONTROLS.test(attributeOf(child, "class") ?? ""))).map((child) => (child.kind === "element" ? { ...child, children: strip(child.children) } : child));
          const container: SiteElement = { ...node, children: strip(node.children) };
          const track = everyElement(container.children).find((child) => TRACK.test(attributeOf(child, "class") ?? "")) ?? container;
          addStyle(track, "display: grid; grid-auto-flow: column; grid-auto-columns: 100%; overflow-x: auto; scroll-snap-type: x mandatory; transform: none");
          for (const slide of elementsOf(track.children)) addStyle(slide, "display: block; scroll-snap-align: start");
          out.push({ ...container, children: transform(container.children) });
          continue;
        }

        // Bootstrap accordion item: its header's button is the summary, its collapse the content.
        if (classes.includes("accordion-item")) {
          const button = everyElement(node.children).find((child) => child.tag === "button");
          const panel = everyElement(node.children).find((child) => /(?:^|\s)(?:accordion-)?collapse(?:\s|$)/u.test(attributeOf(child, "class") ?? ""));
          if (button && panel) {
            applied.accordions++;
            const name = `fisarmonica-${Math.max(1, group)}`;
            out.push({ kind: "element", tag: "details", attrs: [...withoutAttributes(node, ["role"]), ["name", name], ...(attributeOf(button, "aria-expanded") === "true" ? [["open", ""] as [string, string]] : [])], children: [
              { kind: "element", tag: "summary", attrs: withoutAttributes(button, ["type", "aria-controls", "aria-expanded", "data-bs-target", "data-bs-toggle", "data-target", "data-histos-js", "name", "value", "disabled", "form"]), children: transform(button.children) },
              ...transform(panel.children),
            ] });
            continue;
          }
        }

        // Tabs: links to the panels, which all show.
        if (attributeOf(node, "role") === "tablist" && attributeOf(node, "data-xb-tabs") === undefined) {
          applied.tabs++;
          const relink = (list: SiteNode[]): SiteNode[] => list.map((child) => {
            if (child.kind !== "element") return child;
            const panel = targetOf(child);
            if (attributeOf(child, "role") === "tab" && panel) return { kind: "element", tag: "a", attrs: [["href", `#${attributeOf(panel, "id")}`], ...withoutAttributes(child, ["role", "type", "aria-controls", "aria-selected", "tabindex", "data-bs-target", "data-bs-toggle", "data-target", "data-histos-js", "name", "value", "disabled", "form"])], children: child.children } as SiteElement;
            return { ...child, children: relink(child.children) };
          });
          out.push({ ...node, attrs: withoutAttributes(node, ["role"]), children: transform(relink(node.children)) });
          continue;
        }
        if (attributeOf(node, "role") === "tabpanel" && !histeonPanels.has(attributeOf(node, "id") ?? "")) {
          out.push({ ...node, attrs: withoutAttributes(node, ["role", "hidden", "aria-labelledby", "tabindex"]), children: transform(node.children) });
          continue;
        }

        // A button that opens something: a menu becomes a details with a copy of the menu; another panel, an accordion.
        if (node.tag === "button" && attributeOf(node, "aria-expanded") !== undefined && attributeOf(node, "data-xb-toggle") === undefined) {
          const controlled = targetOf(node);
          const menu = controlled && (controlled.tag === "nav" || controlled.tag === "ul" || MENU_HINT.test(attributeOf(controlled, "class") ?? "")) ? controlled : !controlled && MENU_HINT.test(`${classText} ${attributeOf(node, "aria-label") ?? ""}`) ? elementsOf(nodes).find((sibling) => sibling.tag === "nav") : undefined;
          const summary: SiteElement = { kind: "element", tag: "summary", attrs: [], children: node.children.length ? transform(node.children.map(copy)) : [{ kind: "text", text: attributeOf(node, "aria-label") ?? "Menu" }] };
          if (menu) {
            applied.menus++;
            out.push({ kind: "element", tag: "details", attrs: withoutAttributes(node, ["type", "aria-controls", "aria-expanded", "aria-label", "data-bs-target", "data-bs-toggle", "data-target", "data-histos-js", "name", "value", "disabled", "form", "id"]), children: [
              summary,
              { kind: "element", tag: "nav", attrs: [["aria-label", "Menu mobile"]], children: withoutIds(transform(menu.children.map(copy))) },
            ] });
            continue;
          }
          if (controlled && !dialogs.has(controlled) && !moved.has(controlled)) {
            applied.accordions++;
            moved.add(controlled);
            out.push({ kind: "element", tag: "details", attrs: [...withoutAttributes(node, ["type", "aria-controls", "aria-expanded", "data-bs-target", "data-bs-toggle", "data-target", "data-histos-js", "name", "value", "disabled", "form"]), ...(attributeOf(node, "aria-expanded") === "true" ? [["open", ""] as [string, string]] : [])], children: [
              summary,
              { kind: "element", tag: "div", attrs: withoutAttributes(controlled, ["hidden", "aria-labelledby", "role"]), children: transform(controlled.children) },
            ] });
            continue;
          }
        }
        if (classes.includes("accordion")) group++;
        out.push({ ...node, children: transform(node.children) });
      }
      return out;
    };
    page.nodes.splice(0, page.nodes.length, ...transform(page.nodes));
  }
  return applied;
}

/** The marks of the `on*` handlers (`data-histos-js`), which mean nothing once the scripts are left out. */
export function dropHandlerMarks(pages: ReadonlyArray<{ nodes: SiteNode[] }>): void {
  for (const node of everyElement(pages.flatMap((page) => page.nodes))) {
    const index = node.attrs.findIndex(([name]) => name === "data-histos-js");
    if (index >= 0) node.attrs.splice(index, 1);
  }
}
