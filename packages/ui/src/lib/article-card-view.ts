import type { Node as ProseNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import type { CardProps, CardRow } from "./article-schema.js";

/** Only what a component of an article prints, read in a document with no browsing context: nothing in it loads or runs. */
const TAGS = new Set(["DIV", "SPAN", "P", "A", "IMG", "FIGURE", "FIGCAPTION", "BLOCKQUOTE", "ASIDE", "SECTION", "H2", "H3", "H4", "UL", "OL", "LI", "DL", "DT", "DD", "STRONG", "EM", "TIME", "DETAILS", "SUMMARY", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
function cleaned(html: string): Node[] {
  const inert = new DOMParser().parseFromString(html, "text/html");
  for (const element of [...inert.body.querySelectorAll("*")]) {
    if (!TAGS.has(element.tagName)) { element.remove(); continue; }
    for (const { name, value } of [...element.attributes]) {
      if (name === "class" || name === "alt" || (name === "src" && value.startsWith("/__cms-media/"))) continue;
      element.removeAttribute(name);
    }
  }
  return [...inert.body.childNodes];
}

/** A block for writers on the sheet: the server's rendering of its component, as the page will show it. */
export function cardView(render: (ref: string, props: CardProps, rows: CardRow[]) => Promise<string>, emptyWords: (ref: string, props: CardProps, rows: CardRow[]) => string) {
  return (first: ProseNode): NodeView => {
    const dom = document.createElement("div");
    dom.className = "article-card";
    let current = first;
    let turn = 0;
    const draw = (node: ProseNode): void => {
      const ref = node.attrs.ref as string;
      const props = node.attrs.props as CardProps;
      const entries = node.attrs.entries as CardRow[];
      const words = emptyWords(ref, props, entries);
      turn += 1;
      const mine = turn;
      dom.toggleAttribute("data-empty", Boolean(words));
      if (words) { dom.textContent = words; return; }
      void render(ref, props, entries).then((html) => { if (mine === turn) dom.replaceChildren(...cleaned(html)); }).catch((error: unknown) => {
        if (mine === turn) dom.textContent = error instanceof Error ? error.message : ref;
      });
    };
    draw(first);
    return {
      dom,
      update(next) {
        if (next.type !== current.type) return false;
        const same = next.attrs.ref === current.attrs.ref && JSON.stringify([next.attrs.props, next.attrs.entries]) === JSON.stringify([current.attrs.props, current.attrs.entries]);
        current = next;
        if (!same) draw(next);
        return true;
      },
      ignoreMutation: () => true,
    };
  };
}
