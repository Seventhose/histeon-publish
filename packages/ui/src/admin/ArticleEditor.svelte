<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { baseKeymap, chainCommands, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
  import { dropCursor } from "prosemirror-dropcursor";
  import { gapCursor } from "prosemirror-gapcursor";
  import { history, redo, redoDepth, undo, undoDepth } from "prosemirror-history";
  import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
  import { keymap } from "prosemirror-keymap";
  import type { MarkType, Node as ProseNode, NodeType } from "prosemirror-model";
  import { liftListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
  import { EditorState, NodeSelection, Plugin, TextSelection, type Transaction } from "prosemirror-state";
  import { EditorView } from "prosemirror-view";
  import "prosemirror-gapcursor/style/gapcursor.css";
  import { api, uploadMedia } from "../lib/api.js";
  import { articleSchema as schema, type CardDefinition, cardFilled, cardLibrary, type CardProps, type CardRow, fromDocument, type KeptField, savedIds, toDocument, type ArticleBlock } from "../lib/article-schema.js";
  import { cardView } from "../lib/article-card-view.js";
  import { translate, type Language } from "../lib/i18n.js";
  import type { AdminDocument, AdminIndex } from "../lib/admin-index.js";
  import { articleModels } from "../lib/article-models.js";
  import ArticleCardFields from "./ArticleCardFields.svelte";
  import ArticleNewCard from "./ArticleNewCard.svelte";
  import ContentDetail from "./ContentDetail.svelte";

  /** An article written as text and images, as in a block editor: no HTML, no CSS, and the site's one article template (doc 21 §13). */
  let { document: item, index, language, projectId, onBack, onChanged, onNotice, onOpenBuilder, onPreview, onOpen, onTrash }: {
    document: AdminDocument;
    index: AdminIndex;
    language: Language;
    projectId: string;
    onBack: () => void;
    onChanged: () => void;
    onNotice: (text: string, failed?: boolean) => void;
    onOpenBuilder: (alias: number) => void;
    onPreview: (alias: number) => void;
    onOpen: (id: string) => void;
    onTrash: (ids: string[]) => Promise<void>;
  } = $props();
  const t = (key: string, values: Record<string, string | number> = {}) => translate(language, key, values);
  const base = $derived(`/api/cms/v1/projects/${encodeURIComponent(projectId)}`);
  type Saving = "saved" | "dirty" | "saving" | "failed";

  // svelte-ignore state_referenced_locally
  let title = $state(item.title);
  let host = $state<HTMLDivElement | null>(null);
  let page = $state<HTMLDivElement | null>(null);
  let titleField = $state<HTMLTextAreaElement | null>(null);
  let view: EditorView | null = null;
  let head = "";
  let saving = $state<Saving>("saved");
  let loaded = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  let canUndo = $state(false);
  let canRedo = $state(false);
  /** What floats over the text: the format bar on a selection, the block menu on an empty line or after «/». */
  let bar = $state<{ top: number; left: number } | null>(null);
  let adder = $state<{ top: number; query: string } | null>(null);
  let adderIndex = $state(0);
  let handle = $state<{ top: number } | null>(null);
  let active = $state<Record<string, boolean>>({});
  let linkEdit = $state<{ href: string } | null>(null);
  let picking = $state(false);
  let pickSearch = $state("");
  let inTable = $state(false);
  let words = $state(0);
  let comparing = $state<{ when: string; added: string[]; removed: string[] } | null>(null);
  /** Doc 23 item 94: the agent's proposal and what of it is still to decide, block by block. */
  interface Proposal { head: string; title?: string | undefined; excerpt?: string | undefined; blocks?: ArticleBlock[]; note?: string }
  /** `after`: the blocks before it in the proposal, nearest first; the first of them on the sheet is where it goes. */
  interface ProposalItem { key: string; kind: "change" | "add" | "remove"; uid: string; after: string[]; block: ArticleBlock | null; before: string; now: string }
  let proposal = $state<Proposal | null>(null);
  let proposalItems = $state<ProposalItem[]>([]);
  let proposalHeadChanged = $state(false);
  let selectedImage = $state<{ pos: number; alt: string; caption: string } | null>(null);
  let selectedCard = $state<{ pos: number; top: number; ref: string; props: CardProps; entries: CardRow[] } | null>(null);
  let creatingCard = $state(false);
  let changingCard = $state<CardDefinition | null>(null);
  /** The page inside the editor: scripts off, so nothing of it runs, and a click on a text comes to the sheet. */
  let pagePreview = $state<string | null>(null);
  let empty = $state(false);
  let selectedKept = $state<{ pos: number; top: number; fields: KeptField[]; convert: ArticleBlock[] } | null>(null);
  /** The blocks for writers of this project, offered with the others. */
  let cards = $state<CardDefinition[]>([]);
  /** The image picker fills this prop of the selected block instead of adding an image to the text. */
  let pickingFor: ((src: string, alt: string) => void) | null = null;
  /** Where the cursor was before going down to write a note. */
  let noteReturn = $state<number | null>(null);
  let uploading = $state(false);
  let picker = $state<HTMLInputElement | null>(null);
  /** The sheet can wear the site's own styles, so it reads as the page will. */
  let siteLook = $state(storedLook());
  let wrapperClass = $state("");
  let lookCss = "";
  let lookTag: HTMLStyleElement | null = null;
  let history_ = $state<Array<{ id: string; createdAt: string; source: string; words: number }> | null>(null);

  function storedLook(): boolean {
    try { return localStorage.getItem("histos-article-look") !== "off"; } catch { return true; }
  }
  /** Styles of the site, kept to the sheet: tokens declared on :root reach it through :scope. */
  function applyLook(): void {
    lookTag?.remove();
    lookTag = null;
    if (!siteLook || !lookCss) return;
    const fonts = lookCss.match(/@font-face\s*\{[^}]*\}/gu) ?? [];
    const rest = lookCss.replace(/@font-face\s*\{[^}]*\}/gu, "").replace(/:root\b/gu, ":scope").replace(/\b(?:html|body)\b(?=[^{}]*\{)/gu, ":scope");
    lookTag = document.createElement("style");
    lookTag.textContent = `${fonts.join("\n")}\n@scope (.article-look) {\n${rest}\n}`;
    document.head.append(lookTag);
  }
  function toggleLook(): void {
    siteLook = !siteLook;
    try { localStorage.setItem("histos-article-look", siteLook ? "on" : "off"); } catch { /* It is only a preference. */ }
    applyLook();
  }
  async function loadHistory(): Promise<void> {
    history_ = history_ ? null : (await api<{ revisions: NonNullable<typeof history_> }>(`${base}/admin/article/${item.alias}/revisions`)).revisions;
  }
  /** What a saved version has of different from the text on the sheet, paragraph by paragraph. */
  async function compareRevision(id: string, when: string): Promise<void> {
    if (!view) return;
    const old = (await api<{ document: { blocks: ArticleBlock[] } }>(`${base}/admin/article/${item.alias}/revisions/${id}`)).document.blocks;
    const lines = (blocks: ArticleBlock[]): string[] => blocks.flatMap((block) => [block.html ?? "", ...(block.items ?? []).map((entry) => entry.html), ...(block.rows ?? []).flat(), ...[block.props ?? {}, ...(block.entries ?? []).map((row) => row.props)].flatMap((props) => Object.values(props).map(String))]).map((text) => text.replace(/<[^>]*>/gu, "").trim()).filter(Boolean);
    const before = lines(old);
    const now = lines(fromDocument(view.state.doc));
    comparing = { when, added: now.filter((line) => !before.includes(line)), removed: before.filter((line) => !now.includes(line)) };
  }
  async function restoreRevision(id: string): Promise<void> {
    await flush();
    const answer = await api<{ head: string; document: { blocks: ArticleBlock[] } }>(`${base}/admin/article/${item.alias}/revisions`, { method: "POST", body: JSON.stringify({ revision: id, head }) });
    head = answer.head;
    if (view) view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, toDocument(answer.document.blocks).content).setMeta("savedIds", true));
    history_ = null;
    saving = "saved";
    onNotice(t("article.restored"));
    onChanged();
  }
  /** The words of a block, as the comparison shows them. */
  function blockText(block: ArticleBlock): string {
    return [block.html ?? "", ...(block.items ?? []).map((entry) => entry.html), ...(block.rows ?? []).flat(), ...[block.props ?? {}, ...(block.entries ?? []).map((row) => row.props)].flatMap((props) => Object.values(props).map(String))].map((text) => text.replace(/<[^>]*>/gu, "").trim()).filter(Boolean).join(" · ");
  }
  /** What a block says, without where it stands: two blocks with the same facts need no decision. */
  function blockFacts(block: ArticleBlock): string {
    const { uid: _uid, container: _container, ...facts } = block;
    return JSON.stringify(facts, Object.keys(facts).sort());
  }
  /** The decisions the proposal asks for, against the text on the sheet now: changed, new and removed blocks. */
  function computeProposal(): void {
    if (!view || !proposal?.blocks) { proposalItems = []; return; }
    const current = fromDocument(view.state.doc);
    const byUid = new Map(current.filter((block) => block.uid).map((block) => [block.uid!, block]));
    const proposed = new Set(proposal.blocks.map((block) => block.uid));
    const items: ProposalItem[] = [];
    const preceding: string[] = [];
    for (const block of proposal.blocks) {
      const uid = block.uid ?? "";
      const now = byUid.get(uid);
      if (block.type !== "kept") {
        if (!now) items.push({ key: `add:${uid}`, kind: "add", uid, after: [...preceding], block, before: "", now: blockText(block) });
        else if (blockFacts(now) !== blockFacts(block)) items.push({ key: `change:${uid}`, kind: "change", uid, after: [...preceding], block, before: blockText(now), now: blockText(block) });
      }
      preceding.unshift(uid);
    }
    for (const block of current) if (block.uid && block.type !== "kept" && !proposed.has(block.uid)) items.push({ key: `remove:${block.uid}`, kind: "remove", uid: block.uid, after: [], block: null, before: blockText(block), now: "" });
    proposalItems = items;
  }
  /** The top-level node with this id: its position and size, or null. */
  function nodeOf(uid: string): { pos: number; size: number; container: string | null } | null {
    if (!view) return null;
    let found: { pos: number; size: number; container: string | null } | null = null;
    view.state.doc.forEach((node, offset) => {
      if (!found && node.attrs.uid === uid) found = { pos: offset, size: node.nodeSize, container: (node.attrs.container as string | null) ?? null };
    });
    return found;
  }
  function applyProposalItem(entry: ProposalItem): void {
    if (!view) return;
    const at = nodeOf(entry.uid);
    if (entry.kind === "remove") {
      if (at) view.dispatch(view.state.tr.delete(at.pos, at.pos + at.size));
    } else if (entry.block) {
      // The nearest block before it that is on the sheet: a new block whose neighbour is not accepted yet goes after
      // the one before that, never to the top.
      const before = entry.after.map(nodeOf).find(Boolean) ?? null;
      const container = at?.container ?? before?.container ?? null;
      const fragment = toDocument([{ ...entry.block, ...(container ? { container } : {}) }]).content;
      if (entry.kind === "change" && at) view.dispatch(view.state.tr.replaceWith(at.pos, at.pos + at.size, fragment));
      else view.dispatch(view.state.tr.insert(before ? before.pos + before.size : 0, fragment));
    }
    proposalItems = proposalItems.filter((item) => item.key !== entry.key);
    void finishProposal();
  }
  function skipProposalItem(entry: ProposalItem): void {
    proposalItems = proposalItems.filter((item) => item.key !== entry.key);
    void finishProposal();
  }
  function acceptProposalTitle(): void {
    if (!proposal?.title) return;
    title = proposal.title;
    proposal = { ...proposal, title: undefined };
    void tick().then(fitTitle);
    touched();
    void finishProposal();
  }
  async function acceptProposalExcerpt(): Promise<void> {
    if (!proposal?.excerpt) return;
    await flush();
    await api(`${base}/posts/${item.alias}`, { method: "PATCH", body: JSON.stringify({ head, status: item.status, excerpt: proposal.excerpt }) });
    proposal = { ...proposal, excerpt: undefined };
    onChanged();
    void finishProposal();
  }
  function skipProposalPart(part: "title" | "excerpt"): void {
    if (!proposal) return;
    proposal = { ...proposal, [part]: undefined };
    void finishProposal();
  }
  async function acceptWholeProposal(): Promise<void> {
    for (const entry of [...proposalItems]) applyProposalItem(entry);
    if (proposal?.title) acceptProposalTitle();
    if (proposal?.excerpt) await acceptProposalExcerpt();
  }
  /** Once nothing is left to decide, or when the writer discards it, the proposal goes. */
  async function finishProposal(discard = false): Promise<void> {
    if (!proposal) return;
    if (!discard && (proposalItems.length || proposal.title || proposal.excerpt)) return;
    proposal = null;
    proposalItems = [];
    await api(`${base}/admin/article/${item.alias}/proposal`, { method: "DELETE" }).catch(() => undefined);
  }
  /** The handle drags the block it stands beside, as a block. */
  function dragBlock(event: DragEvent): void {
    if (!view) return;
    const { state } = view;
    const place = state.selection instanceof NodeSelection ? state.selection.from : state.selection.$from.before(1);
    const selection = NodeSelection.create(state.doc, place);
    view.dispatch(state.tr.setSelection(selection));
    const slice = selection.content();
    const { dom, text } = view.serializeForClipboard(slice);
    event.dataTransfer?.clearData();
    event.dataTransfer?.setData("text/html", dom.innerHTML);
    event.dataTransfer?.setData("text/plain", text);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    view.dragging = { slice, move: true };
  }

  const images = $derived(index.assets.filter((asset) => asset.mimeType.startsWith("image/")));
  const shownImages = $derived(images.filter((asset) => !pickSearch.trim() || `${asset.filename} ${asset.alt}`.toLowerCase().includes(pickSearch.trim().toLowerCase())).slice(0, 120));

  const nodes = schema.nodes as Record<string, NodeType>;
  const marks = schema.marks as Record<string, MarkType>;
  const choices = $derived([
    { key: "paragraph", label: t("article.block.paragraph"), hint: "", run: () => setBlock(nodes.paragraph!) },
    { key: "h2", label: t("article.block.h2"), hint: "##", run: () => setBlock(nodes.heading!, { level: 2 }) },
    { key: "h3", label: t("article.block.h3"), hint: "###", run: () => setBlock(nodes.heading!, { level: 3 }) },
    { key: "list", label: t("article.block.list"), hint: "-", run: () => command(wrapInList(nodes.bullet_list!)) },
    { key: "ordered", label: t("article.block.ordered"), hint: "1.", run: () => command(wrapInList(nodes.ordered_list!)) },
    { key: "quote", label: t("article.block.quote"), hint: ">", run: () => command(wrapIn(nodes.blockquote!)) },
    { key: "image", label: t("article.block.image"), hint: "", run: () => { pickingFor = null; picking = true; } },
    { key: "table", label: t("article.block.table"), hint: "", run: insertTable },
    { key: "separator", label: t("article.block.separator"), hint: "---", run: insertSeparator },
    ...cards.filter((card) => !card.row).map((card) => ({ key: card.ref, label: cardName(card), hint: "", run: () => insertCard(card.ref) })),
    { key: "new-card", label: t("article.card.new"), hint: "", run: () => { creatingCard = true; } },
    ...cards.filter((card) => card.own && !card.row).map((card) => ({ key: `edit:${card.ref}`, label: t("article.card.edit", { name: card.title }), hint: "", run: () => { changingCard = card; } })),
  ]);
  const shownChoices = $derived(choices.filter((choice) => !adder?.query || choice.label.toLowerCase().includes(adder.query.toLowerCase())));

  function command(run: (state: EditorState, dispatch?: EditorView["dispatch"]) => boolean): void {
    if (view) run(view.state, view.dispatch);
    view?.focus();
  }
  function setBlock(type: NodeType, attrs: Record<string, unknown> = {}): void {
    if (!view) return;
    const current = view.state.selection.$from.parent.attrs as Record<string, unknown>;
    command(setBlockType(type, { uid: current.uid ?? null, container: current.container ?? null, ...attrs }));
  }
  function insertNode(node: ProseNode): number {
    if (!view) return 0;
    const { state } = view;
    const at = state.selection.$from;
    const empty = at.depth === 1 && !at.parent.content.size;
    const place = empty ? at.before(1) : at.depth ? at.after(1) : state.selection.to;
    const tr = empty ? state.tr.replaceRangeWith(at.before(1), at.after(1), node) : state.tr.insert(place, node);
    view.dispatch(tr.scrollIntoView());
    view.focus();
    return place;
  }
  /** A structure to start from, on an empty sheet. */
  function startFrom(blocks: ArticleBlock[]): void {
    if (!view) return;
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, toDocument(blocks).content));
    view.focus();
  }
  async function openPagePreview(): Promise<void> {
    await flush();
    // Typing during a save leaves new blocks without their ids: the page must find them on the sheet.
    applySavedIds((await api<{ document: { blocks: ArticleBlock[] } }>(`${base}/admin/article/${item.alias}`)).document.blocks);
    pagePreview = (await api<{ html: string }>(`${base}/admin/article/${item.alias}/preview`)).html;
  }
  /** A part of the template (or the template) in the builder, found by its ref among the project's templates. */
  async function openTemplateDocument(ref: string): Promise<void> {
    try {
      const { items } = await api<{ items: Array<{ slug: string; post: number }> }>(`${base}/templates`);
      const found = items.find((entry) => entry.slug === ref);
      if (found) onOpenBuilder(found.post);
      else onNotice(t("article.templateMissing"), true);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "", true);
    }
  }
  /** From a clicked element to its block on the sheet. */
  function previewLoaded(event: Event): void {
    const frame = event.currentTarget as HTMLIFrameElement;
    frame.contentDocument?.addEventListener("click", (click) => {
      click.preventDefault();
      // The header and footer come from the template (list item 93): a click there opens that part, or the template.
      // Only the nearest marked element counts: the article's own text sits inside the template's elements too.
      const owner = (click.target as Element | null)?.closest?.("[data-xb-uid]");
      const ownerRef = owner?.getAttribute("data-xb-part") ?? owner?.getAttribute("data-xb-template");
      if (ownerRef) {
        void openTemplateDocument(ownerRef);
        return;
      }
      // Not `instanceof Element`: what is inside the frame has the classes of the frame.
      const target = (click.target as Element | null)?.closest?.("[data-xb-uid]");
      const uid = target?.getAttribute("data-xb-uid");
      if (!view || !uid) return;
      let place = -1;
      view.state.doc.descendants((node, pos) => { if (place < 0 && node.attrs.uid === uid) place = pos; });
      if (place < 0) return;
      pagePreview = null;
      const node = view.state.doc.nodeAt(place);
      view.dispatch(view.state.tr.setSelection(node?.isAtom ? NodeSelection.create(view.state.doc, place) : TextSelection.near(view.state.doc.resolve(place + 1))).scrollIntoView());
      view.focus();
    });
  }
  function cardCreated(card: CardDefinition): void {
    cardLibrary.set(card.ref, card);
    cards = [...cards, card];
    creatingCard = false;
    insertCard(card.ref);
  }
  function cardChanged(card: CardDefinition): void {
    cardLibrary.set(card.ref, card);
    cards = cards.map((entry) => (entry.ref === card.ref ? card : entry));
    changingCard = null;
    onNotice(t("article.card.changed"));
  }
  /** The block's name in the user's language, or the one its definition gives. */
  function cardName(card: CardDefinition): string {
    const key = `article.card.${card.ref.split("/")[1]}`;
    const word = t(key);
    return word === key ? card.title : word;
  }
  /** A new block opens with its fields, ready to fill in. */
  function insertCard(ref: string): void {
    if (!view) return;
    const place = insertNode(nodes.card!.create({ ref }));
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, place)));
  }
  function setKept(position: number, value: string): void {
    if (!view || !selectedKept) return;
    const node = view.state.doc.nodeAt(selectedKept.pos);
    if (!node) return;
    const fields = (node.attrs.fields as KeptField[]).map((field, at) => (at === position ? { ...field, value } : field));
    const summary = fields.filter((field) => field.kind === "text").map((field) => field.value).join(" ").slice(0, 140);
    const tr = view.state.tr.setNodeMarkup(selectedKept.pos, undefined, { ...node.attrs, fields, summary });
    view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, selectedKept.pos)));
  }
  /** Doc 23 item 111: the kept block replaced by the article blocks it says, in its place and its wrapper. */
  function convertKept(): void {
    if (!view || !selectedKept) return;
    const node = view.state.doc.nodeAt(selectedKept.pos);
    const convert = node?.attrs.convert as ArticleBlock[] | undefined;
    if (!node || !convert?.length) return;
    const container = (node.attrs.container as string | null) ?? undefined;
    const replacement = toDocument(convert.map((block) => ({ ...block, ...(container ? { container } : {}) }))).content;
    view.dispatch(view.state.tr.replaceWith(selectedKept.pos, selectedKept.pos + node.nodeSize, replacement));
    view.focus();
  }
  function setCard(change: { props?: CardProps; entries?: CardRow[] }): void {
    if (!view || !selectedCard) return;
    const node = view.state.doc.nodeAt(selectedCard.pos);
    if (!node) return;
    const tr = view.state.tr.setNodeMarkup(selectedCard.pos, undefined, { ...node.attrs, ...change });
    view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, selectedCard.pos)));
  }
  /**
   * Notes are numbered in the order they stand in the text: each number is rewritten, the list follows it, and a note
   * no number points to stays at the end.
   */
  function renumberNotes(tr: Transaction): Transaction {
    const links: Array<{ from: number; to: number; old: string }> = [];
    tr.doc.descendants((node, pos) => {
      const mark = node.marks.find((entry) => entry.type === marks.link && /^#nota-(?:\d+|nuova)$/u.test(String(entry.attrs.href)));
      if (node.isText && mark) links.push({ from: pos, to: pos + node.nodeSize, old: String(mark.attrs.href).slice(6) });
    });
    let listPlace = -1;
    tr.doc.forEach((node, offset) => { if (node.type === nodes.note_list) listPlace = offset; });
    const list = listPlace < 0 ? null : tr.doc.nodeAt(listPlace);
    const lines: ProseNode[] = [];
    list?.forEach((line) => lines.push(line));
    const blank = () => nodes.list_item!.create(null, nodes.paragraph!.create());
    const firstStep = tr.steps.length;
    const used = new Set(links.map((link) => Number(link.old) - 1));
    const next = [...links.map((link) => lines[Number(link.old) - 1] ?? blank()), ...lines.filter((_line, position) => !used.has(position))];
    [...links].reverse().forEach((link, position) => {
      const number = links.length - position;
      tr.replaceWith(link.from, link.to, schema.text(String(number), [marks.link!.create({ href: `#nota-${number}` }), marks.sup!.create()]));
    });
    if (listPlace >= 0) {
      const place = tr.mapping.slice(firstStep).map(listPlace);
      tr.replaceWith(place, place + tr.doc.nodeAt(place)!.nodeSize, nodes.note_list!.create(list!.attrs, next));
    } else if (next.length) tr.insert(tr.doc.content.size, nodes.note_list!.create(null, next));
    return tr;
  }
  /** A line of the notes taken away takes its number from the text, and those after it move up. */
  function followRemovedNotes(old: ProseNode, next: EditorState): Transaction | null {
    const lines = (doc: ProseNode): ProseNode[] => {
      const out: ProseNode[] = [];
      doc.forEach((node) => { if (node.type === nodes.note_list) node.forEach((line) => out.push(line)); });
      return out;
    };
    const before = lines(old);
    const after = lines(next.doc);
    if (after.length >= before.length) return null;
    const first = before.findIndex((line, position) => !after[position]?.eq(line));
    const gone = before.length - after.length;
    const links: Array<{ from: number; to: number; number: number }> = [];
    next.doc.descendants((node, pos) => {
      const mark = node.marks.find((entry) => entry.type === marks.link && /^#nota-\d+$/u.test(String(entry.attrs.href)));
      if (node.isText && mark) links.push({ from: pos, to: pos + node.nodeSize, number: Number(String(mark.attrs.href).slice(6)) });
    });
    const tr = next.tr;
    for (const link of links.reverse()) {
      if (link.number > first && link.number <= first + gone) tr.delete(link.from, link.to);
      else if (link.number > first + gone) {
        const number = link.number - gone;
        tr.replaceWith(link.from, link.to, schema.text(String(number), [marks.link!.create({ href: `#nota-${number}` }), marks.sup!.create()]));
      }
    }
    return tr.docChanged ? tr : null;
  }
  /** A note at the cursor: its number in the text, and the cursor on its line at the end of the article. */
  function addNote(): void {
    if (!view) return;
    const { state } = view;
    const end = state.selection.$to;
    if (!end.parent.inlineContent || end.parent.type === nodes.table_cell || end.node(1)?.type === nodes.note_list) { onNotice(t("article.noteWhere"), true); return; }
    const at = state.selection.to;
    let number = 1;
    state.doc.nodesBetween(0, at, (node) => { if (node.marks.some((mark) => mark.type === marks.link && String(mark.attrs.href).startsWith("#nota-"))) number += 1; });
    const tr = renumberNotes(state.tr.insert(at, schema.text("•", [marks.link!.create({ href: "#nota-nuova" }), marks.sup!.create()])));
    let inner = -1;
    tr.doc.forEach((node, offset) => {
      if (node.type !== nodes.note_list) return;
      let position = offset + 1;
      node.forEach((line, _at, index) => { if (index === number - 1) inner = position + 2; position += line.nodeSize; });
    });
    noteReturn = tr.mapping.map(at, 1);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, inner)).scrollIntoView());
    view.focus();
  }
  function backFromNote(): void {
    if (!view || noteReturn === null) return;
    const place = Math.min(noteReturn, view.state.doc.content.size);
    noteReturn = null;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(place))).scrollIntoView());
    view.focus();
  }
  function insertSeparator(): void { insertNode(nodes.separator!.create()); }
  function insertTable(): void {
    const cell = (header: boolean) => nodes.table_cell!.create({ header });
    insertNode(nodes.table!.create(null, [nodes.table_row!.create(null, [cell(true), cell(true)]), nodes.table_row!.create(null, [cell(false), cell(false)])]));
  }
  /** Where the cursor is inside a table: the block's position, its row and its cell. */
  function tableHere(): { pos: number; row: number; cell: number } | null {
    const at = view?.state.selection.$from;
    if (!at || at.depth < 3 || at.node(1).type !== nodes.table) return null;
    return { pos: at.before(1), row: at.index(1), cell: at.index(2) };
  }
  /** Rows and columns are added by rewriting the table: there is no cell that joins others here. */
  function changeTable(change: (rows: ProseNode[][]) => ProseNode[][]): void {
    const here = tableHere();
    if (!view || !here) return;
    const table = view.state.doc.nodeAt(here.pos);
    if (!table) return;
    const rows: ProseNode[][] = [];
    table.forEach((row) => { const cells: ProseNode[] = []; row.forEach((cell) => cells.push(cell)); rows.push(cells); });
    const next = change(rows);
    if (!next.length || !next[0]?.length) { removeBlock(); return; }
    view.dispatch(view.state.tr.replaceWith(here.pos, here.pos + table.nodeSize, table.type.create(table.attrs, next.map((row) => nodes.table_row!.create(null, row)))));
    view.focus();
  }
  const addRow = () => { const at = tableHere(); changeTable((rows) => [...rows.slice(0, (at?.row ?? 0) + 1), (rows[0] ?? []).map(() => nodes.table_cell!.create()), ...rows.slice((at?.row ?? 0) + 1)]); };
  const addColumn = () => { const at = tableHere(); changeTable((rows) => rows.map((row, position) => [...row.slice(0, (at?.cell ?? 0) + 1), nodes.table_cell!.create({ header: position === 0 && Boolean(row[0]?.attrs.header) }), ...row.slice((at?.cell ?? 0) + 1)])); };
  const removeRow = () => { const at = tableHere(); changeTable((rows) => rows.filter((_row, position) => position !== at?.row)); };
  const removeColumn = () => { const at = tableHere(); changeTable((rows) => rows.map((row) => row.filter((_cell, position) => position !== at?.cell))); };
  function clearSlash(): void {
    if (!view || !adder?.query && !view.state.selection.$from.parent.textContent.startsWith("/")) return;
    const at = view.state.selection.$from;
    if (at.parent.textContent.startsWith("/")) view.dispatch(view.state.tr.delete(at.start(), at.end()));
  }
  function pickChoice(choice: { run: () => void }): void {
    clearSlash();
    adder = null;
    choice.run();
  }

  /** The buttons under the text: a new block after the last one, or the last one if it is empty. */
  function addAtEnd(choice: { key: string; run: () => void }): void {
    if (!view) return;
    let tr = view.state.tr;
    const last = view.state.doc.lastChild;
    if (!last || last.type !== nodes.paragraph || last.content.size) tr = tr.insert(tr.doc.content.size, nodes.paragraph!.create());
    view.dispatch(tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView());
    view.focus();
    choice.run();
  }

  /** The block under the cursor moves over its neighbour, whole. */
  function moveBlock(direction: number): void {
    if (!view) return;
    const { state } = view;
    const place = state.selection instanceof NodeSelection ? state.selection.from : state.selection.$from.before(1);
    const node = state.doc.nodeAt(place);
    if (!node) return;
    const at = state.doc.resolve(place).index(0);
    const neighbour = direction < 0 ? state.doc.maybeChild(at - 1) : state.doc.maybeChild(at + 1);
    if (!neighbour) return;
    const offset = state.selection.from - place;
    const target = direction < 0 ? place - neighbour.nodeSize : place + neighbour.nodeSize;
    const tr = state.tr.delete(place, place + node.nodeSize).insert(target, node);
    tr.setSelection(state.selection instanceof NodeSelection ? NodeSelection.create(tr.doc, target) : TextSelection.create(tr.doc, target + offset));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }
  function removeBlock(): void {
    if (!view) return;
    const { state } = view;
    const place = state.selection instanceof NodeSelection ? state.selection.from : state.selection.$from.before(1);
    const node = state.doc.nodeAt(place);
    if (!node) return;
    view.dispatch(state.doc.childCount > 1 ? state.tr.delete(place, place + node.nodeSize) : state.tr.replaceWith(place, place + node.nodeSize, nodes.paragraph!.create()));
    view.focus();
  }

  const isActive = (mark: MarkType, state: EditorState): boolean => {
    const { from, to, empty } = state.selection;
    return empty ? Boolean(mark.isInSet(state.storedMarks ?? state.selection.$from.marks())) : state.doc.rangeHasMark(from, to, mark);
  };
  function linkAt(state: EditorState): string {
    const mark = state.selection.$from.marks().find((entry) => entry.type === marks.link) ?? state.doc.nodeAt(state.selection.from)?.marks.find((entry) => entry.type === marks.link);
    return (mark?.attrs.href as string | undefined) ?? "";
  }
  function refreshOverlays(): void {
    if (!view || !page) return;
    const { state } = view;
    const box = page.getBoundingClientRect();
    const { selection } = state;
    inTable = Boolean(tableHere());
    empty = !state.doc.textContent.trim() && state.doc.childCount === 1 && state.doc.firstChild?.type === nodes.paragraph;
    words = (state.doc.textBetween(0, state.doc.content.size, " ", " ").match(/\p{L}+/gu) ?? []).length;
    canUndo = undoDepth(state) > 0;
    canRedo = redoDepth(state) > 0;
    active = { strong: isActive(marks.strong!, state), em: isActive(marks.em!, state), link: isActive(marks.link!, state), heading2: selection.$from.parent.type === nodes.heading && selection.$from.parent.attrs.level === 2, heading3: selection.$from.parent.type === nodes.heading && selection.$from.parent.attrs.level === 3 };
    const node = selection instanceof NodeSelection ? selection.node : null;
    selectedImage = node && node.type === nodes.image ? { pos: selection.from, alt: node.attrs.alt as string, caption: (node.attrs.caption as string).replace(/<[^>]*>/gu, "") } : null;
    const keptNode = node && node.type === nodes.kept && ((node.attrs.fields as KeptField[]).length || (node.attrs.convert as ArticleBlock[]).length) ? node : null;
    const keptDom = keptNode ? view.nodeDOM(selection.from) : null;
    selectedKept = keptNode ? { pos: selection.from, top: (keptDom instanceof HTMLElement ? keptDom.getBoundingClientRect().bottom : 0) - box.top + 8, fields: keptNode.attrs.fields as KeptField[], convert: keptNode.attrs.convert as ArticleBlock[] } : null;
    const cardNode = node?.type === nodes.card ? node : null;
    const cardDom = cardNode ? view.nodeDOM(selection.from) : null;
    selectedCard = cardNode ? { pos: selection.from, top: (cardDom instanceof HTMLElement ? cardDom.getBoundingClientRect().bottom : 0) - box.top + 8, ref: cardNode.attrs.ref as string, props: cardNode.attrs.props as CardProps, entries: cardNode.attrs.entries as CardRow[] } : null;
    const block = selection instanceof NodeSelection ? selection.from : selection.$from.depth ? selection.$from.before(1) : null;
    const dom = block === null ? null : view.nodeDOM(block);
    handle = dom instanceof HTMLElement ? { top: dom.getBoundingClientRect().top - box.top } : null;
    if (!selection.empty && !(selection instanceof NodeSelection)) {
      const start = view.coordsAtPos(selection.from);
      const end = view.coordsAtPos(selection.to);
      bar = { top: Math.min(start.top, end.top) - box.top - 44, left: Math.max(0, Math.min((start.left + end.left) / 2 - box.left - 150, box.width - 330)) };
    } else { bar = null; linkEdit = null; }
    const parent = selection.$from.parent;
    const typing = selection.empty && parent.type === nodes.paragraph && selection.$from.depth === 1;
    if (typing && (parent.textContent.startsWith("/") || !parent.content.size) && !picking) {
      const query = parent.textContent.slice(1);
      if (adder?.query !== query) adderIndex = 0;
      adder = parent.content.size ? { top: view.coordsAtPos(selection.from).bottom - box.top + 6, query } : (adder && !adder.query ? adder : null);
    } else adder = null;
  }

  function applySavedIds(blocks: ArticleBlock[]): void {
    if (!view) return;
    const tr = view.state.tr.setMeta("addToHistory", false).setMeta("savedIds", true);
    for (const change of savedIds(view.state.doc, blocks)) {
      tr.setNodeAttribute(change.pos, "uid", change.uid);
      if (view.state.doc.nodeAt(change.pos)?.type.spec.attrs?.container) tr.setNodeAttribute(change.pos, "container", change.container ?? null);
    }
    if (tr.docChanged) view.dispatch(tr);
  }
  async function write(): Promise<void> {
    if (!view) return;
    clearTimeout(timer);
    saving = "saving";
    const sent = view.state.doc;
    const blocks: ArticleBlock[] = fromDocument(sent);
    const sentTitle = title.trim() || item.title;
    try {
      const saved = await api<{ head: string; document: { blocks: ArticleBlock[] } }>(`${base}/admin/article/${item.alias}`, { method: "PUT", body: JSON.stringify({ head, blocks }) });
      head = saved.head;
      if (view?.state.doc.eq(sent)) applySavedIds(saved.document.blocks);
      if (sentTitle !== item.title) await api(`${base}/${item.kind === "post" ? "posts" : "pages"}/${item.alias}`, { method: "PATCH", body: JSON.stringify({ head, ...(item.kind === "post" ? { status: item.status } : {}), title: sentTitle }) });
      saving = saving === "saving" ? "saved" : saving;
      onChanged();
    } catch (error) {
      saving = "failed";
      onNotice(t("article.saveFailed", { message: error instanceof Error ? error.message : "" }), true);
    }
  }
  /** One save at a time: the next starts from the revision the last one left. */
  function save(): Promise<void> {
    running = running.then(write);
    return running;
  }
  function touched(): void {
    saving = "dirty";
    clearTimeout(timer);
    timer = setTimeout(() => void save(), 1200);
  }
  async function flush(): Promise<void> {
    if (saving === "dirty" || saving === "failed") await save();
    else await running;
  }
  async function back(): Promise<void> {
    await flush();
    onBack();
  }
  async function builder(alias = item.alias): Promise<void> {
    await flush();
    onOpenBuilder(alias);
  }
  async function preview(): Promise<void> {
    await flush();
    onPreview(item.alias);
  }
  function fitTitle(): void {
    if (!titleField) return;
    titleField.style.height = "auto";
    titleField.style.height = `${titleField.scrollHeight}px`;
  }

  async function insertImage(asset: { id: string; alt: string }): Promise<void> {
    picking = false;
    const src = `/__cms-media/${encodeURIComponent(projectId)}/${asset.id}`;
    if (pickingFor) { pickingFor(src, asset.alt); return; }
    const size = await new Promise<{ width: number | null; height: number | null }>((done) => {
      const probe = new Image();
      probe.onload = () => done({ width: probe.naturalWidth || null, height: probe.naturalHeight || null });
      probe.onerror = () => done({ width: null, height: null });
      probe.src = src;
    });
    clearSlash();
    insertNode(nodes.image!.create({ src, alt: asset.alt, ...size }));
  }
  /** A document for a block: its address on the site. */
  async function uploadDocument(file: File): Promise<string> {
    const id = (await uploadMedia(projectId, file))?.id;
    onChanged();
    return id ? `/__cms-media/${encodeURIComponent(projectId)}/${id}` : "";
  }
  async function uploadImages(files: Iterable<File>): Promise<void> {
    uploading = true;
    try {
      for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        const id = (await uploadMedia(projectId, file))?.id;
        if (id) await insertImage({ id, alt: "" });
      }
      onChanged();
    } catch (error) {
      onNotice(t("admin.reverted", { message: error instanceof Error ? error.message : "" }), true);
    }
    uploading = false;
  }
  function setImage(fields: { alt?: string; caption?: string }): void {
    if (!view || !selectedImage) return;
    const node = view.state.doc.nodeAt(selectedImage.pos);
    if (!node) return;
    const caption = fields.caption === undefined ? node.attrs.caption : fields.caption.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const tr = view.state.tr.setNodeMarkup(selectedImage.pos, undefined, { ...node.attrs, ...fields, caption });
    tr.setSelection(NodeSelection.create(tr.doc, selectedImage.pos));
    view.dispatch(tr);
  }
  function applyLink(event: Event): void {
    event.preventDefault();
    if (!view || !linkEdit) return;
    const href = linkEdit.href.trim();
    const { from, to } = view.state.selection;
    const tr = view.state.tr.removeMark(from, to, marks.link);
    if (href) {
      if (!/^(?:https?:\/\/|mailto:|tel:|\/(?!\/)|#)/iu.test(href)) { onNotice(t("article.linkInvalid"), true); return; }
      tr.addMark(from, to, marks.link!.create({ href }));
    }
    view.dispatch(tr);
    linkEdit = null;
    view.focus();
  }

  onMount(() => {
    void (async () => {
      const answer = await api<{ head: string; cards: CardDefinition[]; document: { blocks: ArticleBlock[]; containers: Array<{ className: string }> }; proposal?: Proposal }>(`${base}/admin/article/${item.alias}`);
      head = answer.head;
      proposal = answer.proposal ?? null;
      proposalHeadChanged = Boolean(proposal && proposal.head !== answer.head);
      cardLibrary.clear();
      for (const card of answer.cards) cardLibrary.set(card.ref, card);
      cards = answer.cards;
      wrapperClass = answer.document.containers[0]?.className ?? "";
      void api<{ css: string; globalCss: string }>(`${base}/render`, { method: "POST", body: JSON.stringify({ content: "", post_id: item.alias }) }).then((rendered) => {
        lookCss = `${rendered.globalCss ?? ""}\n${rendered.css ?? ""}`;
        applyLook();
      }).catch(() => undefined);
      const rules = inputRules({ rules: [
        textblockTypeInputRule(/^##\s$/u, nodes.heading!, { level: 2 }),
        textblockTypeInputRule(/^###\s$/u, nodes.heading!, { level: 3 }),
        wrappingInputRule(/^\s*[-*]\s$/u, nodes.bullet_list!),
        wrappingInputRule(/^1\.\s$/u, nodes.ordered_list!),
        wrappingInputRule(/^>\s$/u, nodes.blockquote!),
        new InputRule(/^---$/u, (state, _match, start, end) => state.tr.replaceRangeWith(start - 1, end + 1, nodes.separator!.create())),
      ] });
      const lists = chainCommands(liftListItem(nodes.list_item!), lift);
      const state = EditorState.create({
        doc: toDocument(answer.document.blocks),
        plugins: [
          rules,
          keymap({
            "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo,
            "Mod-b": toggleMark(marks.strong!), "Mod-i": toggleMark(marks.em!),
            "Mod-s": () => { void save(); return true; },
            "Mod-Alt-n": () => { addNote(); return true; },
            "Mod-k": () => { if (view && !view.state.selection.empty) linkEdit = { href: linkAt(view.state) }; return true; },
            "Alt-ArrowUp": () => { moveBlock(-1); return true; },
            "Alt-ArrowDown": () => { moveBlock(1); return true; },
            "Shift-Enter": (current, dispatch) => { dispatch?.(current.tr.replaceSelectionWith(nodes.hard_break!.create()).scrollIntoView()); return true; },
            Enter: splitListItem(nodes.list_item!),
            Backspace: (current, dispatch) => current.selection.empty && current.selection.$from.parentOffset === 0 && current.selection.$from.depth > 1 ? lists(current, dispatch) : false,
            Escape: () => { adder = null; return false; },
          }),
          keymap(baseKeymap),
          history(),
          dropCursor({ color: "var(--coral)" }),
          gapCursor(),
          new Plugin({ view: () => ({ update: () => { refreshOverlays(); } }), appendTransaction: (transactions, old, next) => (transactions.some((tr) => tr.docChanged) ? followRemovedNotes(old.doc, next) : null) }),
        ],
      });
      view = new EditorView(host, {
        state,
        attributes: { "aria-label": t("article.body"), role: "textbox", "aria-multiline": "true", class: "article-text" },
        nodeViews: { card: cardView((ref, props, entries) => api<{ html: string }>(`${base}/admin/article-card`, { method: "POST", body: JSON.stringify({ ref, props, entries, known: [props, ...entries.map((row) => row.props)].flatMap((values) => Object.values(values).map(String)) }) }).then((answer) => answer.html), (ref, props, entries) => (cardFilled(ref, props, entries) ? "" : t("article.card.empty", { name: cardLibrary.get(ref) ? cardName(cardLibrary.get(ref)!) : ref }))) },
        dispatchTransaction(transaction) {
          if (!view) return;
          view.updateState(view.state.apply(transaction));
          if (transaction.docChanged && !transaction.getMeta("savedIds")) touched();
          refreshOverlays();
        },
        handleDrop(_view, event) {
          const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
          if (!files.length) return false;
          event.preventDefault();
          void uploadImages(files);
          return true;
        },
        handlePaste(_view, event) {
          const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
          if (!files.length) return false;
          void uploadImages(files);
          return true;
        },
        handleKeyDown(_view, event) {
          if (!adder || !shownChoices.length) return false;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            adderIndex = (adderIndex + (event.key === "ArrowDown" ? 1 : shownChoices.length - 1)) % shownChoices.length;
            return true;
          }
          if (event.key === "Enter") { pickChoice(shownChoices[adderIndex] ?? shownChoices[0]!); return true; }
          return false;
        },
      });
      loaded = true;
      computeProposal();
      await tick();
      fitTitle();
      if (!item.title.trim() || index.posts.length === 0) titleField?.focus();
      else if (!view.state.doc.textContent.trim()) view.focus();
    })().catch((error: unknown) => onNotice(t("admin.reverted", { message: error instanceof Error ? error.message : "" }), true));
  });
  onDestroy(() => {
    lookTag?.remove();
    clearTimeout(timer);
    if (saving === "dirty" || saving === "failed") void save().finally(() => view?.destroy());
    else view?.destroy();
  });
  function keydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  }
  function beforeUnload(event: BeforeUnloadEvent): void {
    if (saving === "dirty" || saving === "saving") event.preventDefault();
  }
</script>

<svelte:window onkeydown={keydown} onbeforeunload={beforeUnload} />

<div class="article-editor" data-testid="article-editor">
  <header class="article-bar">
    <button class="button text small" onclick={() => void back()} data-testid="article-back">← {t(item.kind === "page" ? "admin.pages" : "admin.posts")}</button>
    <span class="article-status {saving}" role="status" data-testid="article-saving">{t(`article.state.${saving}`)}</span>
    <small class="muted" data-testid="article-words">{t("article.words", { n: words })}</small>
    <span class="admin-grow"></span>
    {#if inTable}
      <span class="article-table-tools" role="group" aria-label={t("article.block.table")}>
        <button class="button text small" onmousedown={(event) => { event.preventDefault(); addRow(); }}>{t("article.addRow")}</button>
        <button class="button text small" onmousedown={(event) => { event.preventDefault(); addColumn(); }}>{t("article.addColumn")}</button>
        <button class="button text small" onmousedown={(event) => { event.preventDefault(); removeRow(); }}>{t("article.removeRow")}</button>
        <button class="button text small" onmousedown={(event) => { event.preventDefault(); removeColumn(); }}>{t("article.removeColumn")}</button>
      </span>
    {/if}
    <button class="button text small" title="Ctrl+Alt+N" onmousedown={(event) => { event.preventDefault(); addNote(); }} data-testid="article-add-note">＋ {t("article.addNote")}</button>
    {#if noteReturn !== null}<button class="button text small" onclick={backFromNote} data-testid="article-note-back">↩ {t("article.noteBack")}</button>{/if}
    <button class="admin-icon" aria-label={t("article.undo")} title={t("article.undo")} disabled={!canUndo} onclick={() => { if (view) { undo(view.state, view.dispatch); view.focus(); } }}>↶</button>
    <button class="admin-icon" aria-label={t("article.redo")} title={t("article.redo")} disabled={!canRedo} onclick={() => { if (view) { redo(view.state, view.dispatch); view.focus(); } }}>↷</button>
    <button class="button text small" aria-pressed={siteLook} onclick={toggleLook} data-testid="article-look">{t("article.look")}</button>
    <button class="button text small" aria-pressed={history_ !== null} onclick={() => void loadHistory()} data-testid="article-history">{t("article.history")}</button>
    <button class="button text small" aria-pressed={pagePreview !== null} onclick={() => { if (pagePreview === null) void openPagePreview(); else pagePreview = null; }} data-testid="article-page-preview">{t("article.pagePreview")}</button>
    <button class="button outline small" onclick={() => void preview()}>{t("admin.detail.preview")}</button>
  </header>
  {#if history_}
    <section class="article-history" aria-label={t("article.history")} data-testid="article-history-list">
      {#each history_ as revision, position (revision.id)}
        <div><span>{new Date(revision.createdAt).toLocaleString(language === "it" ? "it-IT" : "en-GB", { dateStyle: "medium", timeStyle: "short" })}</span><small class="muted">{t("article.words", { n: revision.words })}</small>{#if position === 0}<small class="muted">{t("article.current")}</small>{:else}<button class="button text small" onclick={() => void compareRevision(revision.id, new Date(revision.createdAt).toLocaleString(language === "it" ? "it-IT" : "en-GB", { dateStyle: "medium", timeStyle: "short" }))}>{t("article.compare")}</button><button class="button text small" onclick={() => void restoreRevision(revision.id)}>{t("article.restore")}</button>{/if}</div>
      {/each}
      {#if comparing}
        <div class="article-compare" data-testid="article-compare">
          <strong>{t("article.compareWith", { when: comparing.when })}</strong>
          {#if !comparing.added.length && !comparing.removed.length}<p class="muted">{t("article.compareSame")}</p>{/if}
          {#each comparing.removed as line (line)}<del>{line}</del>{/each}
          {#each comparing.added as line (line)}<ins>{line}</ins>{/each}
        </div>
      {/if}
    </section>
  {/if}
  {#if pagePreview !== null}
    <iframe class="article-page-frame" title={t("article.pagePreview")} sandbox="allow-same-origin" srcdoc={pagePreview} onload={previewLoaded} data-testid="article-page-frame"></iframe>
  {/if}
  {#if proposal && loaded}
    <section class="article-proposal" aria-label={t("article.proposal.title")} data-testid="article-proposal">
      <div class="article-proposal-head">
        <strong>{t("article.proposal.title")}</strong>
        <span class="admin-grow"></span>
        <button class="button small" data-testid="proposal-accept-all" onclick={() => void acceptWholeProposal()}>{t("article.proposal.acceptAll")}</button>
        <button class="button text small" data-testid="proposal-discard-all" onclick={() => void finishProposal(true)}>{t("article.proposal.discardAll")}</button>
      </div>
      {#if proposal.note}<p class="muted">{proposal.note}</p>{/if}
      {#if proposalHeadChanged}<p class="muted">{t("article.proposal.changed")}</p>{/if}
      {#if proposal.title}
        <div class="article-proposal-item" data-testid="proposal-title">
          <span class="article-proposal-kind">{t("article.proposal.newTitle")}</span>
          <del>{title}</del><ins>{proposal.title}</ins>
          <span><button class="button text small" data-testid="proposal-accept" onclick={acceptProposalTitle}>{t("article.proposal.accept")}</button><button class="button text small" onclick={() => skipProposalPart("title")}>{t("article.proposal.skip")}</button></span>
        </div>
      {/if}
      {#if proposal.excerpt}
        <div class="article-proposal-item" data-testid="proposal-excerpt">
          <span class="article-proposal-kind">{t("article.proposal.newExcerpt")}</span>
          <ins>{proposal.excerpt}</ins>
          <span><button class="button text small" data-testid="proposal-accept" onclick={() => void acceptProposalExcerpt()}>{t("article.proposal.accept")}</button><button class="button text small" onclick={() => skipProposalPart("excerpt")}>{t("article.proposal.skip")}</button></span>
        </div>
      {/if}
      {#each proposalItems as entry (entry.key)}
        <div class="article-proposal-item" data-testid="proposal-block" data-kind={entry.kind}>
          <span class="article-proposal-kind">{t(`article.proposal.${entry.kind}`)}</span>
          {#if entry.before}<del>{entry.before}</del>{/if}
          {#if entry.now}<ins>{entry.now}</ins>{/if}
          <span><button class="button text small" data-testid="proposal-accept" onclick={() => applyProposalItem(entry)}>{t("article.proposal.accept")}</button><button class="button text small" onclick={() => skipProposalItem(entry)}>{t("article.proposal.skip")}</button></span>
        </div>
      {/each}
    </section>
  {/if}
  <div class="article-work" hidden={pagePreview !== null}>
    <div class="article-scroll">
      <div class="article-page" bind:this={page}>
        <textarea class="article-title" rows="1" bind:this={titleField} bind:value={title} placeholder={t("article.titleHint")} aria-label={t("admin.detail.title")} maxlength="500" data-testid="article-title" oninput={() => { fitTitle(); touched(); }} onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); view?.focus(); } }}></textarea>
        <div class="article-host article-look {siteLook ? wrapperClass : ''}" bind:this={host} data-testid="article-text"></div>
        {#if !loaded}<div class="admin-skeleton" role="status" aria-label={t("admin.loading")}>{#each [1, 2, 3] as line (line)}<span></span>{/each}</div>{/if}

        {#if handle}
          <div class="article-handle" style:top="{handle.top}px">
            <button class="article-grip" draggable="true" aria-label={t("article.drag")} title={t("article.drag")} ondragstart={dragBlock}>⠿</button>
            <button aria-label={t("article.moveUp")} title={t("article.moveUp")} onmousedown={(event) => { event.preventDefault(); moveBlock(-1); }}>↑</button>
            <button aria-label={t("article.moveDown")} title={t("article.moveDown")} onmousedown={(event) => { event.preventDefault(); moveBlock(1); }}>↓</button>
            <button aria-label={t("article.remove")} title={t("article.remove")} onmousedown={(event) => { event.preventDefault(); removeBlock(); }}>×</button>
          </div>
        {/if}
        {#if bar}
          <div class="article-bubble" role="toolbar" aria-label={t("article.format")} style:top="{bar.top}px" style:left="{bar.left}px" data-testid="article-bubble">
            {#if linkEdit}
              <form onsubmit={applyLink}><input bind:value={linkEdit.href} placeholder="https://…" aria-label={t("article.link")} /><button class="active">{t("article.apply")}</button></form>
            {:else}
              <button class:active={active.strong} aria-pressed={active.strong} aria-label={t("article.bold")} title="Ctrl+B" onmousedown={(event) => { event.preventDefault(); command(toggleMark(marks.strong!)); }}><strong>G</strong></button>
              <button class:active={active.em} aria-pressed={active.em} aria-label={t("article.italic")} title="Ctrl+I" onmousedown={(event) => { event.preventDefault(); command(toggleMark(marks.em!)); }}><em>C</em></button>
              <button class:active={active.link} aria-pressed={active.link} aria-label={t("article.link")} title="Ctrl+K" onmousedown={(event) => { event.preventDefault(); if (view) linkEdit = { href: linkAt(view.state) }; }}>🔗</button>
              <span class="article-bubble-line"></span>
              <button class:active={active.heading2} aria-pressed={active.heading2} onmousedown={(event) => { event.preventDefault(); if (active.heading2) setBlock(nodes.paragraph!); else setBlock(nodes.heading!, { level: 2 }); }}>{t("article.h2Short")}</button>
              <button class:active={active.heading3} aria-pressed={active.heading3} onmousedown={(event) => { event.preventDefault(); if (active.heading3) setBlock(nodes.paragraph!); else setBlock(nodes.heading!, { level: 3 }); }}>{t("article.h3Short")}</button>
            {/if}
          </div>
        {/if}
        {#if adder && shownChoices.length}
          <ul class="article-menu" role="listbox" aria-label={t("article.addBlock")} style:top="{adder.top}px" data-testid="article-menu">
            {#each shownChoices as choice, position (choice.key)}
              <li role="option" aria-selected={position === adderIndex}><button class:active={position === adderIndex} onmousedown={(event) => { event.preventDefault(); pickChoice(choice); }}><span>{choice.label}</span>{#if choice.hint}<kbd>{choice.hint}</kbd>{/if}</button></li>
            {/each}
          </ul>
        {/if}
        {#if selectedKept}
          <div class="article-card-fields" style:top="{selectedKept.top}px" data-testid="article-kept-fields">
            {#if selectedKept.convert.length}
              <p class="muted">{t("article.kept.convertHint")}</p>
              <button class="button small" data-testid="article-kept-convert" onclick={convertKept}>{t("article.kept.convert")}</button>
            {/if}
            {#each selectedKept.fields as field, position (field.kind + field.uid)}
              <label class="field-label">{t(field.kind === "link" ? "article.field.link" : "article.field.text")}<input value={field.value} onchange={(event) => setKept(position, event.currentTarget.value)} /></label>
            {/each}
          </div>
        {/if}
        {#if selectedCard && cardLibrary.get(selectedCard.ref)}
          {#key selectedCard.pos}
            <ArticleCardFields card={selectedCard} definition={cardLibrary.get(selectedCard.ref)!} rowDefinition={cardLibrary.get(cardLibrary.get(selectedCard.ref)!.rows ?? "")} name={cardName(cardLibrary.get(selectedCard.ref)!)} {language} onChange={setCard} onPickImage={(chosen) => { pickingFor = chosen; picking = true; }} onUpload={uploadDocument} onClose={() => view?.focus()} />
          {/key}
        {/if}
        {#if selectedImage}
          <div class="article-image-fields" data-testid="article-image-fields">
            <label class="field-label">{t("admin.media.alt")}<input value={selectedImage.alt} onchange={(event) => setImage({ alt: event.currentTarget.value })} /></label>
            <label class="field-label">{t("admin.media.caption")}<input value={selectedImage.caption} onchange={(event) => setImage({ caption: event.currentTarget.value })} /></label>
          </div>
        {/if}
        {#if empty && loaded}
          <div class="article-adds" data-testid="article-models">
            <span class="muted">{t("article.model.start")}</span>
            {#each articleModels(language) as model (model.key)}
              <button class="button text small" onclick={() => startFrom(model.blocks)}>{model.name}</button>
            {/each}
          </div>
        {/if}
        <div class="article-adds">
          <span class="muted">{t("article.hint")}</span>
          <span class="admin-grow"></span>
          {#each choices.filter((choice) => ["h2", "list", "image", "table"].includes(choice.key)) as choice (choice.key)}
            <button class="button text small" onclick={() => addAtEnd(choice)}>＋ {choice.label}</button>
          {/each}
        </div>
      </div>
    </div>
    <ContentDetail document={item} {index} {language} {projectId} embedded {onChanged} {onNotice} onOpenBuilder={(alias) => void builder(alias)} onPreview={() => void preview()} onClose={() => undefined} onStep={() => undefined} {onOpen} {onTrash} />
  </div>
</div>

{#if changingCard}
  <ArticleNewCard {base} {language} card={changingCard} onCreated={cardChanged} onClose={() => { changingCard = null; view?.focus(); }} {onNotice} />
{/if}
{#if creatingCard}
  <ArticleNewCard {base} {language} onCreated={cardCreated} onClose={() => { creatingCard = false; view?.focus(); }} {onNotice} />
{/if}

{#if picking}
  <div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) picking = false; }}>
    <div class="modal-card article-picker" role="dialog" aria-modal="true" aria-label={t("article.pickImage")} data-testid="article-picker">
      <div class="article-picker-head">
        <h2>{t("article.pickImage")}</h2>
        <button class="admin-icon" aria-label={t("admin.detail.close")} onclick={() => { picking = false; }}>×</button>
      </div>
      <div class="article-picker-tools">
        <input class="admin-search-field" type="search" bind:value={pickSearch} placeholder={t("admin.media.searchLabel")} aria-label={t("admin.media.searchLabel")} />
        <button class="button primary small" disabled={uploading} onclick={() => picker?.click()}>＋ {t("admin.media.upload")}</button>
        <input type="file" accept="image/*" multiple hidden bind:this={picker} onchange={(event) => { const files = event.currentTarget.files; if (files) { picking = false; void uploadImages(files); } }} />
      </div>
      {#if shownImages.length}
        <ul class="article-picker-grid">
          {#each shownImages as asset (asset.id)}
            <li><button aria-label={asset.alt || asset.filename} onclick={() => void insertImage(asset)}><img src="/__cms-media/{encodeURIComponent(projectId)}/{asset.id}" alt="" loading="lazy" /></button></li>
          {/each}
        </ul>
      {:else}
        <p class="muted">{t("admin.media.empty")}</p>
      {/if}
    </div>
  </div>
{/if}
