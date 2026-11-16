import postcss, { type AtRule, type Rule } from "postcss";

function splitSelectorList(selectorList: string): string[] {
  const selectors: string[] = [];
  let start = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote = "";
  let comment = false;

  for (let index = 0; index < selectorList.length; index += 1) {
    const current = selectorList[index] ?? "";
    const next = selectorList[index + 1] ?? "";
    if (comment) {
      if (current === "*" && next === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === "\\") index += 1;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "/" && next === "*") {
      comment = true;
      index += 1;
    } else if (current === "\"" || current === "'") quote = current;
    else if (current === "[") brackets += 1;
    else if (current === "]") brackets = Math.max(0, brackets - 1);
    else if (brackets === 0 && current === "(") parentheses += 1;
    else if (brackets === 0 && current === ")") parentheses = Math.max(0, parentheses - 1);
    else if (brackets === 0 && parentheses === 0 && current === ",") {
      selectors.push(selectorList.slice(start, index).trim());
      start = index + 1;
    }
  }

  selectors.push(selectorList.slice(start).trim());
  return selectors.filter(Boolean);
}

function findFunctionEnd(selector: string, openIndex: number): number {
  let depth = 0;
  let brackets = 0;
  let quote = "";
  let comment = false;
  for (let index = openIndex; index < selector.length; index += 1) {
    const current = selector[index] ?? "";
    const next = selector[index + 1] ?? "";
    if (comment) {
      if (current === "*" && next === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === "\\") index += 1;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "/" && next === "*") {
      comment = true;
      index += 1;
    } else if (current === "\"" || current === "'") quote = current;
    else if (current === "[") brackets += 1;
    else if (current === "]") brackets = Math.max(0, brackets - 1);
    else if (brackets === 0 && current === "\\") index += 1;
    else if (brackets === 0 && current === "(") depth += 1;
    else if (brackets === 0 && current === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return selector.length;
}

function hasHoverOutsideNot(selector: string): boolean {
  const functions: Array<{ name: string; openIndex: number }> = [];
  let brackets = 0;
  let quote = "";
  let comment = false;

  for (let index = 0; index < selector.length; index += 1) {
    const current = selector[index] ?? "";
    const next = selector[index + 1] ?? "";
    if (comment) {
      if (current === "*" && next === "/") {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === "\\") index += 1;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === "\"" || current === "'") {
      quote = current;
      continue;
    }
    if (current === "/" && next === "*") {
      comment = true;
      index += 1;
      continue;
    }
    if (current === "[") {
      brackets += 1;
      continue;
    }
    if (current === "]") {
      brackets = Math.max(0, brackets - 1);
      continue;
    }
    if (brackets > 0) continue;

    if (current === "\\") {
      index += 1;
      continue;
    }
    if (current === "(" || current === ")") {
      if (current === ")") functions.pop();
      continue;
    }

    if (current !== ":" || selector[index + 1] === ":") continue;
    let end = index + 1;
    while (/[\w-]/u.test(selector[end] ?? "")) end += 1;
    const pseudo = selector.slice(index + 1, end).toLowerCase();
    if (pseudo === "hover") {
      const parent = functions.at(-1);
      if (parent?.name !== "not") return true;
      const closeIndex = findFunctionEnd(selector, parent.openIndex);
      const rest = `${selector.slice(parent.openIndex + 1, index)}${selector.slice(end, closeIndex)}`
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .trim();
      if (rest) return true;
    }

    let afterName = end;
    while (/\s/u.test(selector[afterName] ?? "")) afterName += 1;
    if (selector[afterName] === "(") {
      functions.push({ name: pseudo, openIndex: afterName });
      index = afterName;
    } else {
      index = end - 1;
    }
  }

  return false;
}

function isNestedInHoverMedia(rule: Rule): boolean {
  let parent = rule.parent;
  while (parent && parent.type !== "root") {
    if (parent.type === "atrule" && (parent as AtRule).params.includes("hover: hover")) return true;
    parent = parent.parent;
  }
  return false;
}

/** Apply Core Framework 1.1.0's opt-in hover media transformation without network access. */
export function applyCoreHoverMedia(css: string): string {
  const root = postcss.parse(css, { from: undefined });
  root.walkRules((rule: Rule) => {
    const fallbackSelector = "html:not(.supports-touch)";
    if (!rule.selector.includes(":hover") || isNestedInHoverMedia(rule) || rule.selector.includes(fallbackSelector)) return;

    const selectors = splitSelectorList(rule.selector);
    const hoverSelectors = selectors.filter(hasHoverOutsideNot);
    if (hoverSelectors.length === 0) return;
    const nonHoverSelectors = selectors.filter((selector) => !hoverSelectors.includes(selector));

    const media = postcss.atRule({ name: "media", params: "(hover: hover)" });
    if (rule.source) media.source = rule.source;
    media.append(rule.clone({ selector: hoverSelectors.join(", ") }));
    rule.after(media);

    if (nonHoverSelectors.length > 0) rule.selector = nonHoverSelectors.join(", ");
    else rule.remove();
  });
  return root.toString();
}
