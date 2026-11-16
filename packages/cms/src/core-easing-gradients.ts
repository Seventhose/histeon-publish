import chroma from "chroma-js";
import { easingCoordinates } from "easing-coordinates";
import postcss, { type Declaration } from "postcss";
import valueParser from "postcss-value-parser";

const TIMING_FUNCTIONS = new Set(["ease", "ease-in", "ease-out", "ease-in-out", "cubic-bezier", "steps"]);

function functionName(value: string): string {
  return value.split("(", 1)[0] ?? value;
}

function isTimingFunction(value: string): boolean {
  return TIMING_FUNCTIONS.has(functionName(value));
}

function gradientParameters(node: valueParser.FunctionNode): string[] {
  return valueParser.stringify(
    node.nodes.map((child) => child.type === "div" ? { ...child, value: ";" } : child),
  ).split(";").map((value) => value.trim());
}

function transparentFix(colors: string[]): string[] {
  return colors.map((color, index) => color === "transparent"
    ? chroma(colors[Math.abs(index - 1)] ?? "transparent").alpha(0).css("hsl")
    : color);
}

function roundHslAlpha(color: string, alphaDecimals: number): string {
  const openingParenthesis = color.indexOf("(");
  const prefix = openingParenthesis === -1 ? color : color.slice(0, openingParenthesis);
  const values = color.slice(openingParenthesis + 1, -1).split(",").map((value) => (
    value.includes("%") ? value.trim() : Number(value).toFixed(alphaDecimals).replace(/\.?0+$/u, "")
  ));
  return `${prefix}(${values.join(", ")})`;
}

function colorStops(colors: string[], coordinates: ReturnType<typeof easingCoordinates>): string[] {
  const normalizedColors = transparentFix(colors);
  return coordinates.map((coordinate) => {
    const color = roundHslAlpha(
      chroma.mix(normalizedColors[0] ?? "transparent", normalizedColors[1] ?? "transparent", coordinate.y, "lrgb").css("hsl"),
      5,
    );
    if (coordinate.x === 0 || coordinate.x === 1) return color;
    return `${color} ${Number((coordinate.x * 100).toFixed(2))}%`;
  });
}

function transformDeclaration(declaration: Declaration): number {
  if (!declaration.value.includes("-gradient")) return 0;
  const parsed = valueParser(declaration.value);
  let unsupported = 0;

  parsed.walk((node) => {
    if (node.type !== "function" || !["linear-gradient", "radial-gradient"].includes(node.value)) return;
    const parameters = gradientParameters(node);
    const easingIndices = parameters.map((parameter, index) => isTimingFunction(parameter) ? index : -1).filter((index) => index >= 0);
    if (easingIndices.length === 0) return;
    if (easingIndices.length !== 1) {
      unsupported += 1;
      return;
    }
    if (parameters.length !== 3 && parameters.length !== 4) {
      unsupported += 1;
      return;
    }
    const index = easingIndices[0] ?? -1;
    const expectedIndex = parameters.length === 4 ? 2 : 1;
    if (index !== expectedIndex || (parameters.length === 4 && chroma.valid(parameters[0] ?? ""))) {
      unsupported += 1;
      return;
    }
    const timing = parameters[index];
    const before = parameters[index - 1];
    const after = parameters[index + 1];
    if (!timing || !before || !after) {
      unsupported += 1;
      return;
    }
    try {
      const coordinates = easingCoordinates(timing, 12);
      const stops = colorStops([before, after], coordinates);
      const direction = parameters.length === 4 ? `${parameters[0]}, ` : "";
      Object.assign(node, {
        type: "word",
        value: `${node.value}(${direction}${stops.join(", ")})`,
      });
      declaration.value = parsed.toString();
      return false;
    } catch {
      // Keep the original expression and report it below; Core leaves invalid gradients unchanged.
      unsupported += 1;
    }
  });
  return unsupported;
}

/**
 * Adapt the opt-in easing-gradient expansion from Core Framework 1.1.0 at
 * 9e7390a2959fe73c62dcb39107f4b4158e7daab5 (MIT); preserve unsupported input.
 */
export function applyCoreEasingGradients(css: string): { css: string; unsupported: number } {
  const postcssRoot = postcss.parse(css, { from: undefined });
  let unsupported = 0;
  postcssRoot.walkDecls((declaration) => {
    unsupported += transformDeclaration(declaration);
  });
  return { css: postcssRoot.toString(), unsupported };
}
