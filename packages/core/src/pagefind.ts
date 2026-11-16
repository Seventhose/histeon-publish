import * as parse5 from "parse5";
import { close, createIndex } from "pagefind";
import { HistosPublishError, throwIfAborted } from "./errors.js";
import type { SourceFile } from "./filesystem.js";

interface HtmlAttribute { name: string; value: string }
interface HtmlNode {
  tagName?: string;
  attrs?: HtmlAttribute[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
}

export interface PagefindBuildResult {
  files: SourceFile[];
  indexedPages: number;
  missingLanguage: string[];
}

let pagefindQueue = Promise.resolve();

function walk(node: HtmlNode, visit: (item: HtmlNode) => void): void {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function attribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value;
}

function isNoIndex(html: string): boolean {
  const document = parse5.parse(html) as unknown as HtmlNode;
  let noIndex = false;
  walk(document, (node) => {
    if (node.tagName?.toLowerCase() !== "meta") return;
    const name = (attribute(node, "name") ?? "").toLowerCase();
    const content = attribute(node, "content") ?? "";
    if (["robots", "googlebot", "bingbot"].includes(name) && /(?:^|[,\s])noindex(?:$|[,\s])/iu.test(content)) noIndex = true;
  });
  return noIndex;
}

function htmlLanguage(html: string): string | undefined {
  const document = parse5.parse(html) as unknown as HtmlNode;
  let language: string | undefined;
  walk(document, (node) => {
    if (!language && node.tagName?.toLowerCase() === "html") language = attribute(node, "lang")?.trim() || undefined;
  });
  return language;
}

function addBeforeClosingTag(html: string, tag: "head" | "body", markup: string): string {
  const closing = new RegExp(`</${tag}\\s*>`, "iu");
  if (closing.test(html)) return html.replace(closing, `${markup}</${tag}>`);
  if (tag === "head") return `${markup}${html}`;
  return `${html}${markup}`;
}

function addSearchUi(html: string): string {
  if (html.includes("pagefind-component-ui.js") || html.includes("pagefind-modal-trigger")) return html;
  const assets = '<link rel="stylesheet" href="/pagefind/pagefind-component-ui.css"><script type="module" src="/pagefind/pagefind-component-ui.js"></script>';
  const controls = '<div data-pagefind-ignore="all"><pagefind-modal-trigger></pagefind-modal-trigger><pagefind-modal></pagefind-modal></div>';
  return addBeforeClosingTag(addBeforeClosingTag(html, "head", assets), "body", controls);
}

function pagefindError(message: string): HistosPublishError {
  return new HistosPublishError(message, "pagefind-build-failed", 3);
}

export async function addPagefind(files: readonly SourceFile[], signal?: AbortSignal): Promise<PagefindBuildResult> {
  throwIfAborted(signal);
  const previous = pagefindQueue;
  let release!: () => void;
  pagefindQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await addPagefindExclusive(files, signal);
  } finally {
    release();
  }
}

async function addPagefindExclusive(files: readonly SourceFile[], signal?: AbortSignal): Promise<PagefindBuildResult> {
  throwIfAborted(signal);
  const htmlFiles = files.filter((file) => /\.html?$/iu.test(file.path));
  const indexable = htmlFiles.filter((file) => !/(?:^|\/)404\.html?$/iu.test(file.path) && !isNoIndex(file.bytes.toString("utf8")));
  if (indexable.length === 0) throw pagefindError("Pagefind non trova pagine HTML pubbliche indicizzabili. Disattiva la ricerca oppure verifica le pagine incluse.");

  let index: Awaited<ReturnType<typeof createIndex>>["index"];
  try {
    const created = await createIndex();
    if (created.errors.length || !created.index) throw pagefindError("Non riesco ad avviare l’indicizzatore Pagefind.");
    index = created.index;
    const missingLanguage: string[] = [];
    const rewritten = new Map<string, Buffer>();
    for (const file of htmlFiles) {
      throwIfAborted(signal);
      const html = file.bytes.toString("utf8");
      const prepared = addSearchUi(html);
      rewritten.set(file.path, Buffer.from(prepared, "utf8"));
      if (indexable.some((item) => item.path === file.path)) {
        if (!htmlLanguage(html)) missingLanguage.push(file.path);
        const result = await index.addHTMLFile({ sourcePath: file.path, content: prepared });
        if (result.errors.length) throw pagefindError("Pagefind non riesce a leggere una o più pagine HTML del bundle.");
      }
    }

    throwIfAborted(signal);
    const generated = await index.getFiles();
    if (generated.errors.length || generated.files.length === 0) throw pagefindError("Pagefind non ha generato un indice utilizzabile.");
    const rewrittenFiles = files.map((file) => {
      const bytes = rewritten.get(file.path);
      return bytes ? { ...file, bytes, size: bytes.byteLength } : file;
    });
    for (const generatedFile of generated.files) {
      const filePath = `pagefind/${generatedFile.path}`;
      rewrittenFiles.push({ path: filePath, size: generatedFile.content.byteLength, bytes: Buffer.from(generatedFile.content) });
    }
    await index.deleteIndex();
    return { files: rewrittenFiles, indexedPages: indexable.length, missingLanguage };
  } catch (error) {
    if (error instanceof HistosPublishError) throw error;
    throw pagefindError("Pagefind non è riuscito a creare l’indice. Verifica i file HTML o ripeti la build con Pagefind disattivato.");
  } finally {
    await close().catch(() => undefined);
  }
}
