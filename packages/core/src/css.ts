import postcss from "postcss";
import valueParser from "postcss-value-parser";

export function collectCssUrls(css: string): string[] {
  const urls: string[] = [];
  const root = postcss.parse(css);
  root.walkDecls((declaration) => {
    const value = valueParser(declaration.value);
    value.walk((node) => {
      if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
      const child = node.nodes.find((item) => item.type === "word" || item.type === "string");
      if (child && (child.type === "word" || child.type === "string")) urls.push(child.value);
    });
  });
  root.walkAtRules("import", (rule) => {
    const parsed = valueParser(rule.params);
    const first = parsed.nodes.find((node) => node.type !== "space" && node.type !== "comment");
    if (first?.type === "string" || first?.type === "word") urls.push(first.value);
    else if (first?.type === "function" && first.value.toLowerCase() === "url") {
      const child = first.nodes.find((node) => node.type === "word" || node.type === "string");
      if (child && (child.type === "word" || child.type === "string")) urls.push(child.value);
    }
  });
  return [...new Set(urls)];
}

export function rewriteCssUrls(css: string, replacements: ReadonlyMap<string, string>): string {
  const root = postcss.parse(css);
  root.walkDecls((declaration) => {
    const value = valueParser(declaration.value);
    value.walk((node) => {
      if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
      const child = node.nodes.find((item) => item.type === "word" || item.type === "string");
      if (child && (child.type === "word" || child.type === "string")) {
        const replacement = replacements.get(child.value);
        if (replacement !== undefined) child.value = replacement;
      }
    });
    declaration.value = value.toString();
  });
  root.walkAtRules("import", (rule) => {
    const parsed = valueParser(rule.params);
    const first = parsed.nodes.find((node) => node.type !== "space" && node.type !== "comment");
    if (first?.type === "string" || first?.type === "word") {
      const replacement = replacements.get(first.value);
      if (replacement !== undefined) first.value = replacement;
    } else if (first?.type === "function" && first.value.toLowerCase() === "url") {
      const child = first.nodes.find((node) => node.type === "word" || node.type === "string");
      if (child && (child.type === "word" || child.type === "string")) {
        const replacement = replacements.get(child.value);
        if (replacement !== undefined) child.value = replacement;
      }
    }
    rule.params = parsed.toString();
  });
  return root.toString();
}
