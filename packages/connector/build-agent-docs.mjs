import { realpathSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The documentation for AI agents (queue A7), topic by topic, for both connectors: Histeon Publish's (`hp_docs`) and the
 * builder's (`xb_docs`). The topics are written in `agent-docs/NN-<key>.md`; the lists that come from data (Histeon CSS
 * tokens, classes and recipes, the ACSS correspondences, the markup of the transfer profile) are filled in here from
 * the files Publish already ships, so they never go stale. Two outputs: the connector's embedded copy and the shared
 * fixture the builder copies byte for byte (`histos-contract/fixtures/histos-agent-docs-v1.json`).
 */
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.join(packageRoot, "../..");
const assets = path.join(repositoryRoot, "packages/cms/assets/histos-css");
const [tokensCss, utilitiesCss, recipesJson, acssJson, markupJson] = await Promise.all([
  readFile(path.join(assets, "xb-tokens.css"), "utf8"),
  readFile(path.join(assets, "histos.css"), "utf8"),
  readFile(path.join(assets, "recipes.json"), "utf8"),
  readFile(path.join(assets, "acss-map.json"), "utf8"),
  readFile(path.join(repositoryRoot, "packages/histos-contract/fixtures/histos-transfer-markup-v1.json"), "utf8"),
]);
const recipes = JSON.parse(recipesJson);
const acss = JSON.parse(acssJson);
const markup = JSON.parse(markupJson).lists;

const code = (value) => `\`${value}\``;
/** Steps a name may end with: a family's shades and transparencies, a scale's sizes. */
const STEP = /^(?:\d{2,3}|a\d{2}|[2-9]?xs|s|m|l|xl|xxl|[2-9]xl|full|none)$/u;

/** Names grouped by stem: `--xb-primary` with -50 -100 … on one line, so a long list stays readable. */
function compact(names, prefix) {
  const stems = new Map();
  for (const name of names) {
    const parts = name.split("-");
    const last = parts.at(-1) ?? "";
    const stem = parts.length > 2 && STEP.test(last) ? parts.slice(0, -1).join("-") : name;
    const steps = stems.get(stem) ?? [];
    if (stem !== name) steps.push(last);
    else if (!steps.includes("")) steps.unshift("");
    stems.set(stem, steps);
  }
  return [...stems].map(([stem, steps]) => {
    const own = steps.includes("") ? code(`${prefix}${stem}`) : "";
    const rest = steps.filter(Boolean);
    // One pattern and its values: a small model reads `--xb-space-N` (N: s m l) better than a wall of names.
    return rest.length ? `${own ? `${own} · ` : ""}${code(`${prefix}${stem}-N`)} (N: ${rest.join(" ")})` : own;
  }).join(" · ");
}

const tokenNames = [...new Set([...tokensCss.matchAll(/(?<![\w-])--(xb-[a-z0-9-]+)\s*:/gu)].map((match) => match[1]))];
/** Colour families: those with a 500 shade (primary, secondary…). */
const families = tokenNames.filter((name) => /^xb-[a-z]+-500$/u.test(name)).map((name) => name.slice(3, -4));

/** Whether `pattern`, with `<famiglia>` in it, names an existing entry for every colour family. */
const everyFamily = (present, pattern) => families.length > 0 && families.every((family) => present.has(pattern.replace("<famiglia>", family)));

function tokenList() {
  const all = new Set(tokenNames);
  // Colour families are told once as a pattern, with their shades, transparencies and text colour: `<famiglia>`
  // stands for every family, so a step enters the pattern only when each family has it. A family's other tokens
  // (`--xb-primary-light`) and any step a family lacks stay in the groups below, under their own names.
  const first = `xb-${families[0]}-`;
  const stepsOf = (pattern, wrap) => [...new Set(tokenNames.map((name) => name.startsWith(first) ? pattern.exec(name.slice(first.length))?.[1] : undefined).filter(Boolean))]
    .filter((step) => everyFamily(all, `xb-<famiglia>-${wrap(step)}`));
  const shades = stepsOf(/^(\d{2,3})$/u, (step) => step);
  const alphas = stepsOf(/^a(\d{2})$/u, (step) => `a${step}`);
  const base = everyFamily(all, "xb-<famiglia>");
  const on = everyFamily(all, "xb-on-<famiglia>");
  const hover = everyFamily(all, "xb-<famiglia>-hover");
  const covered = new Set(families.flatMap((family) => [
    ...(base ? [`xb-${family}`] : []),
    ...shades.map((step) => `xb-${family}-${step}`),
    ...alphas.map((step) => `xb-${family}-a${step}`),
    ...(on ? [`xb-on-${family}`] : []),
    ...(hover ? [`xb-${family}-hover`] : []),
  ]));
  const names = tokenNames.filter((name) => !covered.has(name));
  const parts = [
    base ? code("--xb-<famiglia>") : "",
    shades.length ? `${code("--xb-<famiglia>-N")} (N: ${shades.join(" ")})` : "",
    alphas.length ? `${code("--xb-<famiglia>-aN")}, trasparenze (N: ${alphas.join(" ")})` : "",
    on ? `${code("--xb-on-<famiglia>")}, il testo sopra quel colore` : "",
    hover ? `${code("--xb-<famiglia>-hover")}, il colore al passaggio del mouse` : "",
  ].filter(Boolean);
  const examples = ["xb-primary-700", "xb-accent-a20"].filter((name) => covered.has(name)).map((name) => code(`--${name}`));
  const familyLine = parts.length ? `- **Famiglie di colore** (${families.map(code).join(" ")}): ${parts.join(" · ")}.${examples.length ? ` Esempi: ${examples.join(", ")}.` : ""}` : "";
  // In order, each token in the first group that matches. Colour names that also start other tokens are anchored:
  // `--xb-border` and `--xb-heading` are colours, `--xb-border-width` a shape, `--xb-heading-weight` a text weight.
  const groups = [
    ["Colori", /^xb-(?:primary|secondary|tertiary|accent|neutral|success|warning|danger|info|white|black|bg|surface|text$|text-muted|heading$|link$|link-hover$|focus$|border$|color)/u],
    ["Testo e titoli", /^xb-(?:text-(?!shadow)|h[1-6]|heading-|font|leading|tracking|weight|measure)/u],
    ["Spazi e sezioni", /^xb-(?:space|section|gutter|gap|width|content|container|grid|header|sticky|flow-|boxed-)/u],
    ["Forme", /^xb-(?:radius|shadow|text-shadow|drop-shadow|border-width|border-style|divider-)/u],
    ["Pulsanti e link", /^xb-(?:btn-|link-)/u],
    ["Moduli e dettagli", /^xb-(?:field-|label-|focus-|selection-|columns-)/u],
    ["Movimento", /^xb-(?:enter-|hover-)/u],
    ["Card e icone", /^xb-(?:card-|icon-|list-icon-|radius-inner)/u],
    ["Sovrapposizioni e superfici", /^xb-(?:overlay|surface-[1-3]-)/u],
  ];
  const lines = familyLine ? [familyLine] : [];
  const used = new Set();
  for (const [label, pattern] of groups) {
    const group = names.filter((name) => !used.has(name) && pattern.test(name));
    for (const name of group) used.add(name);
    if (group.length) lines.push(`- **${label}:** ${compact(group, "--")}`);
  }
  const rest = names.filter((name) => !used.has(name));
  if (rest.length) lines.push(`- **Altri:** ${compact(rest, "--")}`);
  return lines.join("\n");
}

/** The same groups as the CSS panel (packages/cms/src/histos-css.ts). */
const CLASS_GROUPS = [
  ["Layout", /^xb-(container|section|stack|cluster|flow|center|grid)/u],
  ["Spazi", /^xb-(p|px|py|mt|mb|gap)-/u],
  ["Testo", /^xb-(text-|h[1-6]$|font-|weight-|align-|balance|measure|muted|prose)/u],
  ["Colori", /^xb-(color-|bg-|border-[a-z]|scheme-)/u],
  ["Visibilità", /^xb-hide-/u],
  ["Forme", /^xb-(rounded-|shadow-|border$)/u],
  ["Interfaccia", /^xb-(btn|card|badge|link)/u],
  ["Moduli", /^xb-(field|label|input)/u],
  ["Altre", /./u],
];

function classList() {
  const names = [...new Set([...utilitiesCss.matchAll(/\.(xb-[a-z0-9-]+)/gu)].map((match) => match[1]))];
  const present = new Set(names);
  // One line per pattern for the colour families too: `.xb-bg-<famiglia>-N`. `<famiglia>` stands for every family,
  // so a class is folded only when each family has it: histos.css has `.xb-btn-primary` but no `.xb-btn-danger`.
  const family = new RegExp(`-(?:${families.join("|")})(?=-|$)`, "u");
  const fold = (name) => {
    const folded = name.replace(family, "-<famiglia>");
    return folded !== name && everyFamily(present, folded) ? folded : name;
  };
  const used = new Set();
  const lines = [];
  for (const [label, pattern] of CLASS_GROUPS) {
    // Grouped on the real names, as the panel groups them, and folded afterwards: `.xb-border-primary` is a colour.
    const real = names.filter((name) => !used.has(name) && pattern.test(name));
    for (const name of real) used.add(name);
    const group = [...new Set(real.map(fold))];
    if (group.length) lines.push(`- **${label}:** ${compact(group, ".")}${group.some((name) => name.includes("<famiglia>")) ? ` (<famiglia>: ${families.join(" ")})` : ""}`);
  }
  return lines.join("\n");
}

const recipeList = () => Object.keys(recipes).map((name) => code(`@${name}`)).join(" ");

/** ACSS variable → Histeon CSS token: the first token of a variable wins, as in AcssImport::variables(). */
function acssVariables() {
  const seen = new Map();
  for (const [token, variable] of Object.entries(acss.tokens)) if (!seen.has(variable)) seen.set(variable, token);
  return ["| ACSS | Histeon CSS |", "|---|---|", ...[...seen].map(([variable, token]) => `| ${code(`var(--${variable})`)} | ${code(`var(--${token})`)} |`)].join("\n");
}

const acssClasses = () => ["| Classe ACSS | Classe Histeon CSS |", "|---|---|", ...Object.entries(acss.classes).map(([from, to]) => `| ${code(from)} | ${code(to)} |`)].join("\n");

const markupTags = () => [
  `- **HTML:** ${markup.htmlTags.map(code).join(" ")}`,
  `- **Senza chiusura (void):** ${markup.voidTags.map(code).join(" ")}`,
  `- **Formattazione dentro il testo:** ${Object.keys(markup.inlineTags).map(code).join(" ")}`,
].join("\n");

/** The profile drops the global attributes on some elements (`source`): the docs say so where an agent looks. */
const markupAttributes = () => {
  const bare = new Set(markup.elementsWithoutGlobalAttributes);
  return [
    `- **Su ogni elemento HTML${bare.size ? ` tranne ${[...bare].map((tag) => code(`<${tag}>`)).join(" ")}` : ""}:** ${markup.globalAttributes.map(code).join(" ")}, più ${markup.globalAttributePrefixes.map((prefix) => code(`${prefix}*`)).join(" e ")}`,
    ...Object.entries(markup.elementAttributes).filter(([tag, names]) => names.length || bare.has(tag)).map(([tag, names]) => `- **${code(`<${tag}>`)}:** ${bare.has(tag)
      ? `${names.length ? `solo ${names.map(code).join(" ")}` : "nessun attributo"}: niente attributi globali, né ${code("class")} ${code("id")} ${code("style")} né ${markup.globalAttributePrefixes.map((prefix) => code(`${prefix}*`)).join(" ")}`
      : names.map(code).join(" ")}`),
    // Doc 23 item 172: every element has its closed list; most of the older tags have only the global attributes.
    `- **Solo quelli globali:** ${Object.entries(markup.elementAttributes).filter(([tag, names]) => !names.length && !bare.has(tag)).map(([tag]) => code(`<${tag}>`)).join(" ")}`,
    `- **Mai:** ${markup.blockedAttributes.map(code).join(" ")}, e gli attributi che iniziano con ${markup.blockedPrefixes.map(code).join(" ")}`,
    `- **Indirizzi:** solo ${markup.urlSchemes.map(code).join(", ")} o percorsi del sito`,
  ].join("\n");
};

const markupSvg = () => [
  `- **Elementi:** ${markup.svgTags.map(code).join(" ")}`,
  `- **Attributi comuni** (su ${markup.svgTagsWithCommonAttributes.map(code).join(" ")}): ${[...markup.svgCommonAttributes, ...markup.svgTextAttributes].map(code).join(" ")}, e i nomi che iniziano con ${markup.svgAttributePrefixes.map((prefix) => code(`${prefix}*`)).join(" ")}`,
  `- **Testo:** solo dentro ${markup.svgTextParents.map((tag) => code(`<${tag}>`)).join(" ")}, senza markup`,
  `- **Con Histeon 0.5.14 o successivo su WordPress:** ${markup.svgTextTags.map((tag) => code(`<${tag}>`)).join(" ")}, ${markup.svgTextAttributes.map(code).join(" ")}, ${code("data-*")}, gli altri ${code("aria-*")} e ${code("fill")} o ${code("stroke")} con ${code("url(#id)")}`,
  ...Object.entries(markup.svgAttributes).filter(([, names]) => names.length).map(([tag, names]) => `- **${code(`<${tag}>`)}:** ${names.map(code).join(" ")}`),
].join("\n");

const PLACEHOLDERS = {
  "histos-css:tokens": tokenList,
  "histos-css:classes": classList,
  "histos-css:recipes": recipeList,
  "acss:variables": acssVariables,
  "acss:classes": acssClasses,
  "markup:tags": markupTags,
  "markup:attributes": markupAttributes,
  "markup:svg": markupSvg,
};

const KEY = /^[a-z][a-z0-9-]{1,30}$/u;

/**
 * The short path for small models (`rapido`): the parts of the topics between a `<!-- rapido -->` line and a
 * `<!-- /rapido -->` line, in topic order. Written once, inside the full topics, so the two can never disagree; the
 * markers themselves are taken out of the full topics. A model with little context reads this topic and nothing else.
 */
const QUICK_KEY = "rapido";
const QUICK_OPEN = "<!-- rapido -->";
const QUICK_CLOSE = "<!-- /rapido -->";
/** Words the short path may hold: with its rules and examples it must fit a 16,000-token context with room to work. */
export const QUICK_MAX_WORDS = 4500;

/** The text without the markers, and the marked parts. */
function quickParts(where, text) {
  const parts = [];
  const kept = [];
  let open = null;
  // The heading a marked part sits under goes with it, one level down, so the short path keeps its sections.
  let heading = "";
  let given = "";
  let fence = false;
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === QUICK_OPEN) {
      if (open) throw new Error(`${where}, riga ${index + 1}: ${QUICK_OPEN} dentro un'altra parte rapida.`);
      open = heading && heading !== given ? [`#${heading}`, ""] : [];
      given = heading;
      continue;
    }
    if (line.startsWith("```")) fence = !fence;
    if (!fence && /^#{2,3} /u.test(line)) heading = line;
    if (line.trim() === QUICK_CLOSE) {
      if (!open) throw new Error(`${where}, riga ${index + 1}: ${QUICK_CLOSE} senza ${QUICK_OPEN}.`);
      parts.push(open.join("\n").trim());
      open = null;
      continue;
    }
    if (line.includes("<!-- rapido") || line.includes("<!-- /rapido")) throw new Error(`${where}, riga ${index + 1}: il segno della parte rapida va da solo sulla sua riga.`);
    kept.push(line);
    // Inside the short path every heading of a part goes one level down, under the title of its topic.
    open?.push(!fence && /^#{2,5} /u.test(line) ? `#${line}` : line);
  }
  if (open) throw new Error(`${where}: ${QUICK_OPEN} senza ${QUICK_CLOSE}.`);
  return { text: kept.join("\n").replace(/\n{3,}/gu, "\n\n"), parts };
}

const words = (text) => text.split(/\s+/u).filter(Boolean).length;

/**
 * Recipes (`ricetta-<lavoro>`): one recurring job on one short page, for the small model that read `rapido` and was
 * asked for that job. Each has the same four sections, in this order, and stays short enough to read whole. They are
 * never part of the short path, so `rapido` does not grow with them.
 */
const RECIPE_PREFIX = "ricetta-";
export const RECIPE_MAX_WORDS = 500;
export const RECIPE_HEADINGS = ["## Quando", "## Passi", "## Fermati e chiedi", "## Alla fine di'"];

function checkRecipe(name, key, text, quick) {
  if (quick.length) throw new Error(`${name}: la ricetta ${key} non entra nel percorso rapido: togli i segni ${QUICK_OPEN}.`);
  const lines = text.split("\n").map((line) => line.trimEnd());
  let previous = -1;
  for (const heading of RECIPE_HEADINGS) {
    const at = lines.indexOf(heading);
    if (at < 0) throw new Error(`${name}: alla ricetta ${key} manca il titolo «${heading}».`);
    if (at < previous) throw new Error(`${name}: nella ricetta ${key} il titolo «${heading}» è fuori ordine (${RECIPE_HEADINGS.join(", ")}).`);
    previous = at;
  }
  const count = words(text);
  if (count > RECIPE_MAX_WORDS) throw new Error(`${name}: la ricetta ${key} ha ${count} parole, il limite è ${RECIPE_MAX_WORDS}: accorciala.`);
}

/**
 * Characters a reader does not see but a model reads, or that end a `//` comment where the builder embeds these texts
 * in JavaScript (its scripts/sync-manual.mjs): controls, bidi marks and overrides, zero-width characters, line and
 * paragraph separators, variation selectors and the tag characters used to hide text from a reviewer. A topic with one
 * is refused, so what a person reviews is all an agent reads. Built from code points, so this file holds none of them.
 */
const INVISIBLE = new RegExp(`[${[
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
  [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
].map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join("")}]`, "u");

function refuseInvisible(where, text) {
  const found = INVISIBLE.exec(text);
  if (!found) return;
  const point = found[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
  throw new Error(`${where}, riga ${text.slice(0, found.index).split("\n").length}: carattere invisibile U+${point}. Toglilo: chi rilegge la documentazione deve vedere tutto ciò che legge un agente.`);
}

/** The bundle made from the topics in `sourceDirectory` (`NN-<key>.md`), with the index first. */
export async function agentDocsBundle(sourceDirectory = path.join(packageRoot, "agent-docs")) {
  const files = (await readdir(sourceDirectory)).filter((name) => /^\d{2}-[a-z0-9-]+\.md$/u.test(name)).sort();
  const topics = [];
  for (const name of files) {
    const raw = (await readFile(path.join(sourceDirectory, name), "utf8")).replace(/\r\n?/gu, "\n");
    refuseInvisible(name, raw);
    const header = /^---\nkey: (.+)\ntitle: (.+)\nsummary: (.+)\n---\n/u.exec(raw);
    if (!header) throw new Error(`${name}: manca l'intestazione key/title/summary.`);
    const [, key, title, summary] = header.map((part) => part.trim());
    if (!KEY.test(key) || `${name.slice(3, -3)}` !== key) throw new Error(`${name}: la chiave ${key} non corrisponde al nome del file.`);
    if (topics.some((topic) => topic.key === key)) throw new Error(`${name}: chiave ripetuta.`);
    const text = raw.slice(header[0].length).replace(/^\{\{([a-z-]+:[a-z-]+)\}\}$/gmu, (match, placeholder) => {
      const fill = PLACEHOLDERS[placeholder];
      if (!fill) throw new Error(`${name}: segnaposto sconosciuto ${match}.`);
      return fill();
    });
    if (/\{\{[a-z-]+:[a-z-]+\}\}/u.test(text)) throw new Error(`${name}: un segnaposto deve stare da solo sulla sua riga.`);
    // The lists filled in from the CSS and JSON files Publish ships pass the same check.
    refuseInvisible(`${name} (con gli elenchi generati)`, text);
    if (key === QUICK_KEY) throw new Error(`${name}: la chiave ${QUICK_KEY} è del percorso rapido, che si costruisce da solo.`);
    const quick = quickParts(name, text);
    if (key.startsWith(RECIPE_PREFIX)) checkRecipe(name, key, quick.text.trim(), quick.parts);
    topics.push({ key, title, summary, text: quick.text.trim() + "\n", quick: quick.parts });
  }
  // The index comes first and is made from the topics themselves. Without MCP both clients run with `node`: neither
  // file is a command on the PATH. Recipes get their own section, after the topics.
  const recipeTopics = topics.filter((topic) => topic.key.startsWith(RECIPE_PREFIX));
  const index = {
    key: "indice",
    title: "Indice della documentazione",
    summary: "Da leggere per primo: gli argomenti e quando leggerli.",
    text: [
      "# Documentazione di Histeon per gli agenti",
      "",
      "Scegli il percorso secondo quanto contesto hai:",
      "",
      recipeTopics.length
        ? "- **Modello piccolo o poco contesto** (fino a 8 miliardi di parametri, o meno di 32.000 token): leggi `rapido`, poi solo la ricetta del lavoro che ti hanno chiesto (sotto, «Ricette: un lavoro, una pagina»). Nient'altro."
        : "- **Modello piccolo o poco contesto** (fino a 8 miliardi di parametri, o meno di 32.000 token): leggi solo `rapido`. Basta da solo.",
      "- **Modello medio** (da 12 a 30 miliardi circa): comincia sempre da `ecosistema`, poi `metodo`, `mestiere` e `progettare`, poi l'argomento del lavoro, uno alla volta.",
      "- **Modello grande:** comincia sempre da `ecosistema`, poi `metodo` e `mestiere`, poi tutti gli argomenti che servono al lavoro.",
      "",
      "In ogni percorso: prima di dire «fatto» leggi `controllo` (nel percorso rapido la lista è già dentro).",
      "",
      "- **rapido** — Percorso rapido per i modelli piccoli. Le regole essenziali e i modelli pronti di tutti gli argomenti, in un argomento solo.",
      "",
      ...topics.filter((topic) => !recipeTopics.includes(topic)).map((topic) => `- **${topic.key}** — ${topic.title}. ${topic.summary}`),
      "",
      "Nel builder: `xb_docs` con `topic`; senza MCP `node histos-connector.mjs docs <argomento>`. In Histeon Publish: `hp_docs` con `topic`; senza MCP `node <dati>/connector/histos-publish-connector.mjs docs <argomento>`.",
      "",
      ...(recipeTopics.length ? [
        "## Ricette: un lavoro, una pagina",
        "",
        `Ogni ricetta è un lavoro che torna spesso, in al più ${RECIPE_MAX_WORDS} parole: quando vale, le chiamate in ordine con l'esito atteso, quando fermarti, che cosa dire alla fine. Leggi solo quella del lavoro che ti hanno chiesto e copia le chiamate. Le ricette sono di Histeon Publish (connettore hp): nel builder non valgono.`,
        "",
        ...recipeTopics.map((topic) => `- **${topic.key}** — ${topic.summary}`),
        "",
      ] : []),
    ].join("\n"),
  };
  const quickText = [
    "# Percorso rapido",
    "",
    "Questo argomento basta da solo a un modello piccolo o con poco contesto. Contiene le regole che non si rompono mai e i modelli pronti, presi dagli argomenti completi. Copia i modelli e cambia solo nomi e testi.",
    "",
    "Lavora così: una cosa alla volta; prima di scrivere rispondi alle sei domande; alla fine controlla la lista «Prima di dire fatto».",
    "",
    ...topics.filter((topic) => topic.quick.length).flatMap((topic) => [`## ${topic.title}`, "", `(Dall'argomento \`${topic.key}\`.)`, "", topic.quick.join("\n\n"), ""]),
  ].join("\n");
  const quickWords = words(quickText);
  if (quickWords > QUICK_MAX_WORDS) throw new Error(`Il percorso rapido ha ${quickWords} parole, il limite è ${QUICK_MAX_WORDS}: togli un segno <!-- rapido --> o accorcia le parti segnate.`);
  const quickTopic = {
    key: QUICK_KEY,
    title: "Percorso rapido per i modelli piccoli",
    summary: "Se sei un modello piccolo (fino a 8 miliardi di parametri) o hai meno di 32.000 token di contesto: leggi solo questo. Regole essenziali e modelli pronti da copiare.",
    text: quickText.trim() + "\n",
  };
  const full = topics.map(({ quick, ...topic }) => topic);
  return { format: "histos-agent-docs", version: 1, topics: [index, quickTopic, ...full] };
}

// Run as a program (npm run build:cms-dsl, the --check in npm test), not when a test imports agentDocsBundle.
// Run as a program, also through a symlink: node loads the module from its real path, argv keeps the one typed.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const bundle = await agentDocsBundle();
  const fixture = `${JSON.stringify(bundle, null, 2)}\n`;
  const generated = [
    "// Generated by packages/connector/build-agent-docs.mjs from packages/connector/agent-docs. Do not edit.",
    `export const AGENT_DOCS: ReadonlyArray<{ readonly key: string; readonly title: string; readonly summary: string; readonly text: string }> = ${JSON.stringify(bundle.topics)};`,
    `export const AGENT_DOC_TOPICS = ${JSON.stringify(bundle.topics.map((topic) => topic.key))} as const;`,
    "",
  ].join("\n");
  const targets = [
    [path.join(packageRoot, "src/agent-docs.generated.ts"), generated],
    [path.join(repositoryRoot, "packages/histos-contract/fixtures/histos-agent-docs-v1.json"), fixture],
  ];
  if (process.argv.includes("--check")) {
    for (const [target, output] of targets) {
      if ((await readFile(target, "utf8").catch(() => "")) !== output) {
        process.stderr.write(`${path.relative(repositoryRoot, target)} non corrisponde a packages/connector/agent-docs: esegui node packages/connector/build-agent-docs.mjs.\n`);
        process.exit(1);
      }
    }
  } else {
    for (const [target, output] of targets) await writeFile(target, output, "utf8");
    process.stdout.write(`Documentazione per gli agenti: ${bundle.topics.length - 1} argomenti e l'indice.\n`);
  }
}
