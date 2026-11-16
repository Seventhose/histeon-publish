import postcss, { type Rule } from "postcss";
import type { SiteElement, SiteNode } from "./site-structure.js";

/**
 * Doc 28, «Schede e menu da telefono di una proposta»: a captured proposal has lost its scripts, so its tabs and its
 * phone menu answer nothing. Here they get Histeon's own behaviours (behaviors.js of the builder: `data-xb-tabs`,
 * `data-xb-toggle`), and nothing else: no script of the site is written, no element moves, no declaration changes.
 *
 * - Tabs: a `role="tablist"` whose state is already written the way Histeon writes it (one `aria-selected="true"`,
 *   the other panels `hidden`) only gains attributes. Without the script the page is the proposal as it was.
 * - Tabs whose state is in a class (`.active` on the chosen tab and on its panel), only when the case is certain
 *   (classTabsOf and cssHidesPanels below): the class leaves the chosen tab and its panel, Histeon's state is written
 *   in its place (`aria-selected`, `hidden` on the other panels) and every selector that names the class gains
 *   Histeon's state beside it, for those tabs and panels only and with the weight of the class. Any doubt, and the
 *   tabs stay as they are, «da rifare».
 * - Phone menu: the button keeps its place and gains `data-xb-toggle` and `aria-controls`. The «open» state the
 *   proposal's script used to write (a class on the menu, a class or an attribute on an ancestor) is read from the
 *   proposal's CSS and written beside Histeon's (`[data-open]` on the menu, `aria-expanded="true"` on the button), in
 *   a form that weighs what the class did. With the menu closed neither form selects anything.
 *
 * The proposal is untrusted: a name read from its CSS enters a selector only when it is a plain identifier.
 */

const MENU_HINT = /menu|nav|burger|hamburger/iu;
const OPEN_HINT = /(?:^|[-_])(?:open|opened|aperto|aperta|active|attivo|attiva|show|shown|visible|expanded|toggled)(?:$|[-_])/iu;
/** A class that says «this one is the chosen one»: on one tab, on one panel. */
const STATE_HINT = /(?:^|[-_])(?:active|attivo|attiva|selected|selezionato|selezionata|current|corrente|scelto|scelta|open|aperto|aperta|show|shown|visible)(?:$|[-_])/iu;
const IDENT = /^-?[_a-zA-Z][\w-]{0,63}$/u;
const ATTRIBUTE_VALUE = /^[\w-]{1,64}$/u;
const REFERENCE = /^[A-Za-z][\w-]{0,127}$/u;
/** Tabs of one list, and toggles of one page, at most: beyond, the page is left as it is. */
const MAX_TABS = 50;
const MAX_TOGGLES = 40;
/** Lines of one kind in the report. */
const MAX_MARKS = 4;
/** Ids of tabs and of panels written in the selectors of one site, at most: beyond, class tabs stay as they are. */
const MAX_STATE_IDS = 400;

export interface ProposalRecipesApplied {
  /** Tab lists that became Histeon tabs. */
  tabs: number;
  /** Buttons that became Histeon toggles. */
  menus: number;
  /** Rules of the proposal's CSS that gained Histeon's state beside the proposal's. */
  rules: number;
  notes: string[];
}

const attributeOf = (node: SiteElement, name: string): string | undefined => node.attrs.find(([key]) => key === name)?.[1];
const classesOf = (node: SiteElement): string[] => (attributeOf(node, "class") ?? "").split(/\s+/u).filter(Boolean);
function setAttribute(node: SiteElement, name: string, value: string): void {
  const index = node.attrs.findIndex(([key]) => key === name);
  if (index < 0) node.attrs.push([name, value]);
  else node.attrs[index] = [name, value];
}
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
/** How an element is named in a line of the report: its first class, cleaned, or its tag. */
function mark(node: SiteElement): string {
  const first = classesOf(node).find((name) => IDENT.test(name));
  return first ? `.${first.slice(0, 40)}` : `<${node.tag}>`;
}

// ---------------------------------------------------------------- selectors

type Piece =
  | { kind: "class"; name: string; start: number; end: number }
  | { kind: "id"; name: string; start: number; end: number }
  | { kind: "attribute"; name: string; value: string | null; plain: boolean; start: number; end: number }
  | { kind: "other"; start: number; end: number }
  | { kind: "break"; start: number; end: number };

/**
 * The pieces of a selector in order: classes, ids, attribute selectors, anything else of a compound («other»), and
 * what ends a compound («break»: white space, a combinator, a parenthesis, a comma). Strings and escapes are skipped.
 */
function pieces(selector: string): Piece[] {
  const out: Piece[] = [];
  let index = 0;
  const ident = (from: number): number => {
    let at = from;
    while (at < selector.length && /[\w-]/u.test(selector[at] as string)) at++;
    return at;
  };
  while (index < selector.length) {
    const char = selector[index] as string;
    if (char === "\\") {
      out.push({ kind: "other", start: index, end: Math.min(selector.length, index + 2) });
      index += 2;
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < selector.length && selector[end] !== char) end += selector[end] === "\\" ? 2 : 1;
      out.push({ kind: "other", start: index, end: Math.min(selector.length, end + 1) });
      index = end + 1;
    } else if (char === "[") {
      let end = index + 1;
      let quote = "";
      for (; end < selector.length; end++) {
        const inner = selector[end] as string;
        if (quote) {
          if (inner === "\\") end++;
          else if (inner === quote) quote = "";
        } else if (inner === '"' || inner === "'") quote = inner;
        else if (inner === "]") break;
      }
      const text = selector.slice(index + 1, end);
      const match = /^\s*([\w-]+)\s*(?:=\s*(?:"([^"\\]*)"|'([^'\\]*)'|([\w-]+))\s*)?$/u.exec(text);
      out.push(match ? { kind: "attribute", name: (match[1] as string).toLowerCase(), value: match[2] ?? match[3] ?? match[4] ?? null, plain: true, start: index, end: Math.min(selector.length, end + 1) } : { kind: "attribute", name: "", value: null, plain: false, start: index, end: Math.min(selector.length, end + 1) });
      index = end + 1;
    } else if ((char === "." || char === "#") && /[-_a-zA-Z]/u.test(selector[index + 1] ?? "")) {
      const end = ident(index + 1);
      out.push({ kind: char === "." ? "class" : "id", name: selector.slice(index + 1, end), start: index, end });
      index = end;
    } else if (/[\s>+~(),]/u.test(char)) {
      out.push({ kind: "break", start: index, end: index + 1 });
      index++;
    } else {
      out.push({ kind: "other", start: index, end: index + 1 });
      index++;
    }
  }
  return out;
}

/** The compounds of a selector: runs of pieces between breaks. */
function compoundsOf(list: readonly Piece[]): Piece[][] {
  const out: Piece[][] = [];
  let current: Piece[] = [];
  for (const piece of list) {
    if (piece.kind === "break") {
      if (current.length) out.push(current);
      current = [];
    } else current.push(piece);
  }
  if (current.length) out.push(current);
  return out;
}

/** A state on an ancestor, as the key that names it: `.menu-open` → "menu-open", `[data-menu="aperto"]` → "data-menu-aperto". */
function ancestorKey(piece: Piece): string | null {
  if (piece.kind === "class") return IDENT.test(piece.name) && MENU_HINT.test(piece.name) && OPEN_HINT.test(piece.name) ? piece.name : null;
  if (piece.kind !== "attribute" || !piece.plain || !piece.name.startsWith("data-") || !IDENT.test(piece.name) || !MENU_HINT.test(piece.name)) return null;
  if (piece.value === null) return OPEN_HINT.test(piece.name) ? piece.name : null;
  return ATTRIBUTE_VALUE.test(piece.value) && OPEN_HINT.test(piece.value) ? `${piece.name}-${piece.value}`.slice(0, 64) : null;
}

/** What the pages have: a state the script wrote is one no page shows. */
interface PageFacts {
  classes: Set<string>;
  /** `name` and `name=value` of every data attribute. */
  attributes: Set<string>;
}

/** Tabs whose state is in a class: gathered page by page, decided with the CSS and the ids of the whole site. */
interface ClassTabs {
  page: number;
  list: SiteElement;
  tabs: SiteElement[];
  panels: SiteElement[];
  /** The tab and the panel the proposal shows. */
  chosen: number;
  /** The id each tab has, or will have. */
  tabIds: string[];
  panelIds: string[];
  /** The state class of the tabs, when they have one, and that of the panels. */
  tabClass: string | null;
  panelClass: string;
  /** Classes every panel has, the state class apart. */
  common: Set<string>;
}

interface Toggle {
  button: SiteElement;
  /** The element the button names with aria-controls, when it does and the page has it. */
  controlled: SiteElement | undefined;
  /** Every element of the button's page, in order. */
  all: SiteElement[];
  ids: Map<string, SiteElement>;
  slug: string;
}

/**
 * Applies the recipes in place: attributes on the pages' elements, selectors in the sheets. `rootClasses` are the
 * classes of the pages' `<body>` and `<html>`, which the elements do not carry.
 */
export function applyProposalRecipes(pages: ReadonlyArray<{ slug: string; nodes: SiteNode[] }>, sheets: Array<{ name: string; css: string }>, rootClasses: Iterable<string> = []): ProposalRecipesApplied {
  const applied: ProposalRecipesApplied = { tabs: 0, menus: 0, rules: 0, notes: [] };
  const left = new Map<string, { count: number; marks: Set<string> }>();
  const leave = (why: string, node: SiteElement): void => {
    const entry = left.get(why) ?? { count: 0, marks: new Set<string>() };
    entry.count++;
    if (entry.marks.size < MAX_MARKS) entry.marks.add(mark(node));
    left.set(why, entry);
  };

  const facts: PageFacts = { classes: new Set(rootClasses), attributes: new Set() };
  const toggles: Toggle[] = [];
  const classTabs: ClassTabs[] = [];
  const pageIds: Array<{ ids: Map<string, SiteElement>; repeated: Set<string> }> = [];
  for (const [pageIndex, page] of pages.entries()) {
    const all = everyElement(page.nodes);
    const ids = new Map<string, SiteElement>();
    const repeated = new Set<string>();
    for (const node of all) {
      for (const name of classesOf(node)) facts.classes.add(name);
      for (const [name, value] of node.attrs) {
        if (!name.startsWith("data-")) continue;
        facts.attributes.add(name);
        facts.attributes.add(`${name}=${value}`);
      }
      const id = attributeOf(node, "id");
      if (!id) continue;
      if (ids.has(id)) repeated.add(id);
      else ids.set(id, node);
    }
    for (const id of repeated) ids.delete(id);
    pageIds.push({ ids, repeated });
    /** Ids promised to class tabs not decided yet. */
    const reserved = new Set<string>();
    const newId = (wanted: string): string => {
      let id = wanted;
      for (let index = 2; ids.has(id) || repeated.has(id) || reserved.has(id); index++) id = `${wanted}-${index}`;
      return id;
    };

    // Tabs.
    for (const list of all) {
      if (attributeOf(list, "role") !== "tablist" || attributeOf(list, "data-xb-tabs") !== undefined) continue;
      const tabs = everyElement(list.children).filter((node) => attributeOf(node, "role") === "tab");
      const panelOf = (tab: SiteElement): SiteElement | undefined => {
        const reference = attributeOf(tab, "aria-controls") ?? attributeOf(tab, "data-tab") ?? attributeOf(tab, "data-bs-target")?.replace(/^#/u, "") ?? attributeOf(tab, "data-target")?.replace(/^#/u, "");
        return reference && REFERENCE.test(reference) ? ids.get(reference) : undefined;
      };
      const panels = tabs.map(panelOf);
      const inside = new Set(everyElement([list]));
      if (tabs.length < 2 || tabs.length > MAX_TABS) { leave("schede: l'elenco non ha da due a cinquanta schede", list); continue; }
      if (tabs.some((tab) => tab.tag !== "button")) { leave("schede: le schede non sono pulsanti", list); continue; }
      if (panels.some((panel) => !panel || inside.has(panel)) || new Set(panels).size !== panels.length) { leave("schede: una scheda non porta a un pannello suo della pagina", list); continue; }
      const selected = tabs.filter((tab) => attributeOf(tab, "aria-selected") === "true");
      const shown = panels.filter((panel) => panel && attributeOf(panel, "hidden") === undefined);
      if (selected.length !== 1 || shown.length !== 1 || panelOf(selected[0] as SiteElement) !== shown[0]) {
        const found = classTabsOf(list, tabs, panels as SiteElement[], pageIndex, (tab, panelId) => {
          const own = attributeOf(tab, "id");
          if (own && !repeated.has(own)) return own;
          const id = newId(`scheda-${panelId}`);
          reserved.add(id);
          return id;
        });
        if (typeof found === "string") leave(found, list);
        else classTabs.push(found);
        continue;
      }
      setAttribute(list, "data-xb-tabs", "");
      for (const [index, tab] of tabs.entries()) {
        const panel = panels[index] as SiteElement;
        const panelId = attributeOf(panel, "id") as string;
        setAttribute(tab, "aria-controls", panelId);
        if (attributeOf(tab, "aria-selected") === undefined) setAttribute(tab, "aria-selected", "false");
        let tabId = attributeOf(tab, "id");
        if (!tabId || repeated.has(tabId)) {
          tabId = newId(`scheda-${panelId}`);
          setAttribute(tab, "id", tabId);
          ids.set(tabId, tab);
        }
        if (attributeOf(panel, "role") === undefined) setAttribute(panel, "role", "tabpanel");
        if (attributeOf(panel, "aria-labelledby") === undefined) setAttribute(panel, "aria-labelledby", tabId);
      }
      applied.tabs++;
    }

    // Buttons that open something: gathered here, decided below with the CSS of the whole site.
    let count = 0;
    for (const button of all) {
      if (button.tag !== "button" || attributeOf(button, "aria-expanded") === undefined || attributeOf(button, "role") === "tab" || attributeOf(button, "data-xb-toggle") !== undefined) continue;
      if (++count > MAX_TOGGLES) break;
      const reference = attributeOf(button, "aria-controls");
      toggles.push({ button, controlled: reference && REFERENCE.test(reference) ? ids.get(reference) : undefined, all, ids, slug: page.slug });
    }
  }

  // The CSS of the site, read once and only when something asks for it.
  const parsed = toggles.length || classTabs.length ? sheets.map((sheet) => {
    try {
      return postcss.parse(sheet.css);
    } catch {
      return null;
    }
  }) : [];
  const eachRule = (visit: (rule: Rule) => void): void => {
    for (const root of parsed) root?.walkRules((rule) => {
      if (rule.parent?.type === "atrule" && /keyframes$/iu.test((rule.parent as { name: string }).name)) return;
      visit(rule);
    });
  };
  let written = false;

  if (toggles.length) {
    const selectors: Piece[][] = [];
    eachRule((rule) => { for (const selector of rule.selectors) selectors.push(pieces(selector)); });
    const absentClass = (name: string): boolean => IDENT.test(name) && !facts.classes.has(name);
    const absentAncestor = (piece: Piece): string | null => {
      const key = ancestorKey(piece);
      if (key === null) return null;
      if (piece.kind === "class") return facts.classes.has(piece.name) ? null : key;
      if (piece.kind !== "attribute") return null;
      return facts.attributes.has(piece.value === null ? piece.name : `${piece.name}=${piece.value}`) ? null : key;
    };
    const names = (compound: readonly Piece[], node: SiteElement): boolean => {
      const id = attributeOf(node, "id");
      const classes = new Set(classesOf(node));
      return compound.some((piece) => (piece.kind === "class" && classes.has(piece.name)) || (piece.kind === "id" && piece.name === id));
    };

    /** State classes on the menu itself → `[data-open]`. */
    const onTarget = new Set<string>();
    /** States on an ancestor (their key) → the value of the button's `data-xb-toggle`. */
    const onAncestor = new Set<string>();
    for (const toggle of toggles) {
      const { button } = toggle;
      if (attributeOf(button, "aria-expanded") === "true") { leave("pulsante fotografato aperto", button); continue; }
      const menuish = MENU_HINT.test(`${attributeOf(button, "class") ?? ""} ${attributeOf(button, "aria-label") ?? ""} ${button.attrs.map(([name]) => (name.startsWith("data-") ? name : "")).join(" ")}`);
      const own = new Set<string>();
      let key = "";
      let target = toggle.controlled;
      if (target && target !== button) {
        for (const selector of selectors) for (const compound of compoundsOf(selector)) {
          if (!names(compound, target)) continue;
          for (const piece of compound) if (piece.kind === "class" && absentClass(piece.name) && OPEN_HINT.test(piece.name)) own.add(piece.name);
        }
      }
      if (menuish) {
        // A state on an ancestor, before a compound that selects the menu (the one named, else a nav of the page).
        const candidates = target ? [target] : toggle.all.filter((node) => node !== button && (node.tag === "nav" || ((node.tag === "ul" || node.tag === "div" || node.tag === "aside") && MENU_HINT.test(attributeOf(node, "class") ?? ""))));
        search: for (const selector of selectors) {
          const compounds = compoundsOf(selector);
          for (const [index, compound] of compounds.entries()) {
            const found = compound.map(absentAncestor).find((item): item is string => item !== null);
            if (!found) continue;
            const chosen = candidates.find((node) => compounds.slice(index + 1).some((later) => names(later, node)));
            if (!chosen) continue;
            key = found;
            target = chosen;
            break search;
          }
        }
      }
      if (!target || target === button || (!own.size && !key)) {
        // A panel the script opened by taking `hidden` away: Histeon's toggle writes `data-open` and leaves `hidden`.
        if (toggle.controlled && toggle.controlled !== button && attributeOf(toggle.controlled, "hidden") !== undefined) leave("pulsante che apre un pannello chiuso con hidden: il comportamento di Histeon apre con data-open e non toglie hidden", button);
        else leave(menuish ? "pulsante del menu: il CSS della proposta non dice come si apre" : "pulsante che apre un pannello: il CSS della proposta non dice come si apre", button);
        continue;
      }
      let id = attributeOf(target, "id");
      if (!id || !REFERENCE.test(id) || toggle.ids.get(id) !== target) {
        id = "menu-principale";
        for (let index = 2; toggle.ids.has(id); index++) id = `menu-principale-${index}`;
        setAttribute(target, "id", id);
        toggle.ids.set(id, target);
      }
      setAttribute(button, "aria-controls", id);
      setAttribute(button, "data-xb-toggle", key);
      for (const name of own) onTarget.add(name);
      if (key) onAncestor.add(key);
      applied.menus++;
    }

    if (onTarget.size || onAncestor.size) {
      let skipped = 0;
      eachRule((rule) => {
        let changed = false;
        const written = rule.selectors.map((selector) => {
          const list = pieces(selector);
          const hits = list.filter((piece) => (piece.kind === "class" && onTarget.has(piece.name)) || (absentAncestor(piece) !== null && onAncestor.has(absentAncestor(piece) as string)));
          if (!hits.length) return selector;
          const ancestor = hits.some((piece) => !(piece.kind === "class" && onTarget.has(piece.name)));
          // `:has()` cannot hold another `:has()`: such a selector stays as it was.
          if (ancestor && /:has\(/iu.test(selector)) { skipped++; return selector; }
          let out = "";
          let last = 0;
          for (const piece of hits) {
            const text = selector.slice(piece.start, piece.end);
            const beside = piece.kind === "class" && onTarget.has(piece.name) ? "[data-open]" : `:where(:has([data-xb-toggle="${absentAncestor(piece)}"][aria-expanded="true"]))`;
            out += `${selector.slice(last, piece.start)}:is(${text}, ${beside})`;
            last = piece.end;
          }
          changed = true;
          return out + selector.slice(last);
        });
        if (!changed) return;
        rule.selectors = written;
        applied.rules++;
      });
      if (applied.rules) written = true;
      if (skipped) applied.notes.push(`menu da telefono: ${skipped} ${skipped === 1 ? "selettore con :has() non è stato riscritto" : "selettori con :has() non sono stati riscritti"}`);
    }
  }
  const menuRules = applied.rules;

  // Tabs whose state is in a class: the ones that are certain, with the CSS and the ids of the whole site.
  let classRules = 0;
  let classGroups = 0;
  if (classTabs.length) {
    let certain = classTabs.filter((group) => {
      if (cssHidesPanels(parsed, group)) return true;
      leave("schede con lo stato in una classe: il CSS non nasconde i pannelli con una regola semplice (display: none sulla classe che hanno tutti)", group.list);
      return false;
    });
    // An id of a tab or of a panel enters a selector: in every page it must be a tab, or a panel, of these groups.
    for (let again = true; again;) {
      again = false;
      const tabIds = new Map<string, Set<SiteElement>>();
      const panelIds = new Map<string, Set<SiteElement>>();
      const add = (map: Map<string, Set<SiteElement>>, id: string, node: SiteElement): void => { map.set(id, (map.get(id) ?? new Set()).add(node)); };
      for (const group of certain) {
        for (const [index, id] of group.tabIds.entries()) add(tabIds, id, group.tabs[index] as SiteElement);
        for (const [index, id] of group.panelIds.entries()) add(panelIds, id, group.panels[index] as SiteElement);
      }
      const elsewhere = (id: string, own: Map<string, Set<SiteElement>>): boolean => pageIds.some(({ ids, repeated }) => repeated.has(id) || (ids.has(id) && !own.get(id)?.has(ids.get(id) as SiteElement)));
      const kept = certain.filter((group) => {
        if (!group.tabIds.some((id) => elsewhere(id, tabIds)) && !group.panelIds.some((id) => elsewhere(id, panelIds))) return true;
        leave("schede con lo stato in una classe: un id delle schede o dei pannelli è di un altro elemento del sito", group.list);
        return false;
      });
      if (kept.length !== certain.length) again = true;
      certain = kept;
    }
    if (certain.reduce((sum, group) => sum + group.tabIds.length + group.panelIds.length, 0) > MAX_STATE_IDS) {
      for (const group of certain) leave("schede con lo stato in una classe: troppe schede in un sito solo", group.list);
      certain = [];
    }

    /** State class → what says the same in Histeon's words, for the tabs and the panels of these groups only. */
    const tabState = new Map<string, Set<string>>();
    const panelState = new Map<string, Set<string>>();
    const dropClass = (node: SiteElement, name: string): void => {
      const rest = classesOf(node).filter((item) => item !== name);
      if (rest.length) setAttribute(node, "class", rest.join(" "));
      else node.attrs = node.attrs.filter(([key]) => key !== "class");
    };
    for (const group of certain) {
      setAttribute(group.list, "data-xb-tabs", "");
      for (const [index, tab] of group.tabs.entries()) {
        const panel = group.panels[index] as SiteElement;
        const tabId = group.tabIds[index] as string;
        const panelId = group.panelIds[index] as string;
        setAttribute(tab, "aria-controls", panelId);
        setAttribute(tab, "aria-selected", index === group.chosen ? "true" : "false");
        setAttribute(tab, "id", tabId);
        if (attributeOf(panel, "role") === undefined) setAttribute(panel, "role", "tabpanel");
        if (attributeOf(panel, "aria-labelledby") === undefined) setAttribute(panel, "aria-labelledby", tabId);
        if (index !== group.chosen) setAttribute(panel, "hidden", "");
        if (group.tabClass) tabState.set(group.tabClass, (tabState.get(group.tabClass) ?? new Set()).add(tabId));
        panelState.set(group.panelClass, (panelState.get(group.panelClass) ?? new Set()).add(panelId));
      }
      if (group.tabClass) dropClass(group.tabs[group.chosen] as SiteElement, group.tabClass);
      dropClass(group.panels[group.chosen] as SiteElement, group.panelClass);
      applied.tabs++;
      classGroups++;
    }
    if (tabState.size || panelState.size) {
      const beside = (name: string): string => [
        ...(tabState.has(name) ? [`[aria-selected="true"]:where(${[...tabState.get(name) as Set<string>].map((id) => `#${id}`).join(", ")})`] : []),
        ...(panelState.has(name) ? [`:not([hidden]):where(${[...panelState.get(name) as Set<string>].map((id) => `#${id}`).join(", ")})`] : []),
      ].join(", ");
      eachRule((rule) => {
        let changed = false;
        const selectorsWritten = rule.selectors.map((selector) => {
          const hits = pieces(selector).filter((piece) => piece.kind === "class" && (tabState.has(piece.name) || panelState.has(piece.name)));
          if (!hits.length) return selector;
          let out = "";
          let last = 0;
          for (const piece of hits) {
            if (piece.kind !== "class") continue;
            out += `${selector.slice(last, piece.start)}:is(${selector.slice(piece.start, piece.end)}, ${beside(piece.name)})`;
            last = piece.end;
          }
          changed = true;
          return out + selector.slice(last);
        });
        if (!changed) return;
        rule.selectors = selectorsWritten;
        classRules++;
      });
      if (classRules) written = true;
    }
  }
  if (written) for (const [index, root] of parsed.entries()) if (root) (sheets[index] as { css: string }).css = root.toString();
  applied.rules = menuRules + classRules;

  if (classGroups) applied.notes.unshift(`schede con lo stato in una classe: in ${classGroups === 1 ? "1 gruppo" : `${classGroups} gruppi`} la classe della scheda scelta è diventata lo stato di Histeon (aria-selected sulla scheda, hidden sugli altri pannelli), affiancato alla classe in ${classRules === 1 ? "1 regola" : `${classRules} regole`}`);
  if (applied.tabs) applied.notes.unshift(`schede della proposta: ${applied.tabs === 1 ? "1 gruppo resta a schede" : `${applied.tabs} gruppi restano a schede`} con il comportamento di Histeon (un pannello alla volta, al clic, con Invio e con le frecce); senza script si vede il pannello che la proposta mostrava`);
  if (applied.menus) applied.notes.unshift(`menu della proposta: ${applied.menus === 1 ? "1 pulsante apre e chiude il suo menu" : `${applied.menus} pulsanti aprono e chiudono il loro menu`} con il comportamento di Histeon (clic, Invio, Esc per chiudere); lo stato aperto scritto dallo script della proposta è affiancato in ${menuRules === 1 ? "1 regola" : `${menuRules} regole`}; chiudere al clic fuori o su una voce non c'è`);
  for (const [why, entry] of left) applied.notes.push(`da rifare: ${why}, ${entry.count} ${entry.count === 1 ? "volta" : "volte"} (${[...entry.marks].join(", ")})`.slice(0, 400));
  return applied;
}

/** True for an element the proposal's recipes already gave a behaviour of Histeon: no other recipe is for it. */
export function hasHisteonBehaviour(node: SiteElement): boolean {
  return attributeOf(node, "data-xb-tabs") !== undefined || attributeOf(node, "data-xb-toggle") !== undefined;
}

/**
 * Doc 28, «Schede con lo stato in una classe»: the tabs of `list`, when what the page says leaves no doubt about which
 * class is the state; else the reason, in the report's words. Certain means: no panel is `hidden` and none carries
 * `aria-hidden` or `style` (nor a tab `style`): the state is in the classes alone; exactly one panel carries exactly
 * one class that reads as a state (STATE_HINT) and no other panel carries one; the tab of that panel is the only one
 * that may say `aria-selected="true"` or carry a state class, one at most; every panel shares a class with the others;
 * the ids of the tabs are plain names. The CSS is asked next (cssHidesPanels).
 */
function classTabsOf(list: SiteElement, tabs: SiteElement[], panels: SiteElement[], page: number, tabIdOf: (tab: SiteElement, panelId: string) => string): ClassTabs | string {
  const plain = "schede: la scheda scelta non è scritta con aria-selected e hidden (lo stato è in una classe)";
  const doubt = "schede con lo stato in una classe: non è certo quale classe lo scrive";
  if (panels.some((panel) => attributeOf(panel, "hidden") !== undefined || attributeOf(panel, "aria-hidden") !== undefined || attributeOf(panel, "style") !== undefined) || tabs.some((tab) => attributeOf(tab, "style") !== undefined)) return plain;
  const states = (node: SiteElement): string[] => classesOf(node).filter((name) => STATE_HINT.test(name));
  const panelStates = panels.map(states);
  if (!panelStates.some((names) => names.length)) return plain;
  const shown = panelStates.flatMap((names, index) => (names.length ? [index] : []));
  if (shown.length !== 1 || panelStates[shown[0] as number]?.length !== 1) return doubt;
  const chosen = shown[0] as number;
  const panelClass = (panelStates[chosen] as string[])[0] as string;
  if (!IDENT.test(panelClass)) return doubt;
  const tabStates = tabs.map(states);
  if (tabStates.some((names, index) => names.length > (index === chosen ? 1 : 0))) return doubt;
  const tabClass = (tabStates[chosen] as string[])[0] ?? null;
  if (tabClass !== null && !IDENT.test(tabClass)) return doubt;
  if (tabs.some((tab, index) => {
    const selected = attributeOf(tab, "aria-selected");
    return selected !== undefined && selected !== (index === chosen ? "true" : "false");
  })) return doubt;
  const common = new Set(classesOf(panels[0] as SiteElement).filter((name) => IDENT.test(name) && name !== panelClass && panels.every((panel) => classesOf(panel).includes(name))));
  if (!common.size) return "schede con lo stato in una classe: i pannelli non hanno una classe in comune";
  const panelIds = panels.map((panel) => attributeOf(panel, "id") as string);
  const tabIds = tabs.map((tab, index) => tabIdOf(tab, panelIds[index] as string));
  if (tabIds.some((id) => !REFERENCE.test(id)) || new Set(tabIds).size !== tabIds.length) return "schede con lo stato in una classe: un id non è un nome semplice";
  return { page, list, tabs, panels, chosen, tabIds, panelIds, tabClass, panelClass, common };
}

const CLASSES_ONLY = /^(?:\.-?[_a-zA-Z][\w-]*)+$/u;
const CLASSES_NOT = /^((?:\.-?[_a-zA-Z][\w-]*)+):not\(\s*\.(-?[_a-zA-Z][\w-]*)\s*\)$/u;

/**
 * Whether the proposal's CSS hides the panels that are not chosen with `display: none`, in a way that leaves no doubt:
 * a rule outside every at-rule whose selector is only classes every panel has, either with `:not(.state)` or alone;
 * alone, a rule as plain that names the state class must then set another `display` and win (more classes, or as many
 * and written after). Only then is `hidden` on those panels something the page already said, at every width. A rule
 * with an ancestor in it (`.js .panel`), one inside `@media`, an `!important`, panels hidden with `visibility` or
 * `opacity`: not certain.
 */
function cssHidesPanels(parsed: ReadonlyArray<postcss.Root | null>, group: ClassTabs): boolean {
  type Rank = { count: number; order: number };
  const found: { hide: Rank | null; show: Rank | null; byNot: boolean; doubt: boolean } = { hide: null, show: null, byNot: false, doubt: false };
  const stronger = (one: Rank, other: Rank | null): boolean => other === null || one.count > other.count || (one.count === other.count && one.order > other.order);
  let order = 0;
  for (const root of parsed) root?.each((node) => {
    if (node.type !== "rule") return;
    order++;
    const display: { value: string | null; important: boolean } = { value: null, important: false };
    node.each((inner) => {
      if (inner.type !== "decl" || inner.prop.toLowerCase() !== "display") return;
      display.value = inner.value.trim().toLowerCase();
      display.important = inner.important === true;
    });
    if (display.value === null) return;
    for (const selector of node.selectors) {
      const text = selector.trim();
      const negated = CLASSES_NOT.exec(text);
      const names = (negated ? negated[1] as string : CLASSES_ONLY.test(text) ? text : "").split(".").filter(Boolean);
      if (!names.length || !names.every((name) => group.common.has(name) || (!negated && name === group.panelClass))) continue;
      if (negated && negated[2] !== group.panelClass) continue;
      // An `!important` on these very classes: which rule wins is no longer read from here.
      if (display.important) { found.doubt = true; continue; }
      const here = { count: names.length, order };
      if (negated) {
        if (display.value === "none") found.byNot = true;
        else found.doubt = true;
      } else if (names.includes(group.panelClass)) {
        if (display.value === "none") found.doubt = true;
        else if (stronger(here, found.show)) found.show = here;
      } else if (display.value === "none" && stronger(here, found.hide)) found.hide = here;
    }
  });
  if (found.doubt) return false;
  return found.byNot || (found.hide !== null && found.show !== null && stronger(found.show, found.hide));
}
