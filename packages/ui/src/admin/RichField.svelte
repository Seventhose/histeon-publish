<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { baseKeymap, toggleMark } from "prosemirror-commands";
  import { history, redo, undo } from "prosemirror-history";
  import { keymap } from "prosemirror-keymap";
  import { EditorState } from "prosemirror-state";
  import { EditorView } from "prosemirror-view";
  import { articleSchema as schema, fromDocument, toDocument } from "../lib/article-schema.js";
  import { translate, type Language } from "../lib/i18n.js";

  /** A short text with its formats inside a block: the same marks as the article, a line break instead of new paragraphs. */
  let { value, language, name, onChange }: { value: string; language: Language; name: string; onChange: (html: string) => void } = $props();
  const t = (key: string) => translate(language, key);
  let host = $state<HTMLDivElement | null>(null);
  let view: EditorView | null = null;
  let linking = $state<string | null>(null);
  /** A link the field refused stays in the box with the same warning as the article editor. */
  let linkRefused = $state(false);
  const marks = schema.marks;

  function command(run: ReturnType<typeof toggleMark>): void {
    if (view) run(view.state, view.dispatch);
    view?.focus();
  }
  function current(): string {
    return view ? fromDocument(view.state.doc).map((block) => block.html ?? "").join("<br>") : value;
  }
  function applyLink(event: Event): void {
    event.preventDefault();
    if (!view || linking === null) return;
    const { from, to } = view.state.selection;
    const href = linking.trim();
    linkRefused = Boolean(href) && !/^(?:https?:\/\/|mailto:|tel:|\/(?!\/)|#)/iu.test(href);
    if (linkRefused) return;
    linking = null;
    const tr = view.state.tr.removeMark(from, to, marks.link!);
    if (href) tr.addMark(from, to, marks.link!.create({ href }));
    view.dispatch(tr);
    view.focus();
  }
  onMount(() => {
    view = new EditorView(host, {
      state: EditorState.create({
        doc: toDocument([{ type: "paragraph", html: value }]),
        plugins: [
          keymap({
            "Mod-z": undo, "Mod-y": redo,
            "Mod-b": toggleMark(marks.strong!), "Mod-i": toggleMark(marks.em!),
            Enter: (state, dispatch) => { dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break!.create()).scrollIntoView()); return true; },
          }),
          keymap(baseKeymap),
          history(),
        ],
      }),
      attributes: { "aria-label": name, "data-field": name, role: "textbox", "aria-multiline": "true" },
      handleDOMEvents: { blur: () => { const html = current(); if (html !== value) onChange(html); return false; } },
    });
  });
  onDestroy(() => view?.destroy());
</script>

<div class="article-rich-tools" role="toolbar">
  {#if linking !== null}
    <form onsubmit={applyLink} style:display="contents"><input bind:value={linking} placeholder="https://…" aria-label={t("article.link")} /><button>{t("article.apply")}</button></form>
    {#if linkRefused}<span class="field-hint delete-error" role="alert">{t("article.linkInvalid")}</span>{/if}
  {:else}
    <button aria-label={t("article.bold")} title="Ctrl+B" onmousedown={(event) => { event.preventDefault(); command(toggleMark(marks.strong!)); }}><strong>G</strong></button>
    <button aria-label={t("article.italic")} title="Ctrl+I" onmousedown={(event) => { event.preventDefault(); command(toggleMark(marks.em!)); }}><em>C</em></button>
    <button aria-label={t("article.link")} onmousedown={(event) => { event.preventDefault(); linking = ""; linkRefused = false; }}>🔗</button>
  {/if}
</div>
<div class="article-rich" bind:this={host}></div>
