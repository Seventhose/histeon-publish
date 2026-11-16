<script lang="ts">
  import { untrack } from 'svelte';
  import { comboOf, commandOf, isBound } from '../lib/shortcuts.ts';
  import { safeUrl, type TemplateInfo } from '../lib/config.ts';
  import { allowedOrigin, canvasCsp, originsOf } from '../lib/canvasPolicy.ts';
  import type { BuilderState } from '../lib/state.svelte.ts';
  import { describe, roleName, staticClasses } from '../lib/tree.ts';
  import { CanvasOverlay } from '../lib/overlay.ts';
  import { scalesFrom } from '../lib/miniGui.ts';
  import { draftCode, inlineContent, inlineRefusal, inlineTarget, tidyInline } from '../lib/inlineText.ts';
  import { breakpointsFrom, clampWidth, MAX_WIDTH, MIN_WIDTH } from '../lib/canvasWidth.ts';
  import { t } from '../lib/i18n.ts';
  import { holdPointer } from '../lib/pointerHold.ts';
  import ContextMenu from './ContextMenu.svelte';
  import PathBar from './PathBar.svelte';

  let { app, template = null, origins = [] }: { app: BuilderState; template?: TemplateInfo | null; origins?: string[] } = $props();

  function pickSample(event: Event) {
    app.contextId = Number((event.currentTarget as HTMLSelectElement).value) || 0;
    void app.refreshPreview();
  }

  let frame: HTMLIFrameElement;
  /** The context menu opened on an element of the canvas (E3). */
  let canvasMenu = $state({ open: false, uid: '', x: 0, y: 0 });
  let ready = $state(false);
  /**
   * The page is laid out at the width chosen by dragging the handles (or typed in): no fixed devices.
   * Dragging stops at the edge of the stage (no zoom by accident). A wider width can still be chosen on purpose,
   * typed in or from a breakpoint button: then the page is scaled down to fit, and the bar says by how much, so
   * the site's breakpoints see the real width whatever the window.
   * Without a chosen width it fits the stage. The ruler marks where the site's named queries switch.
   */
  let stageWidth = $state(0);
  let stageHeight = $state(0);
  const available = $derived(Math.max(MIN_WIDTH, Math.floor(stageWidth - 48)));
  const layoutWidth = $derived(app.canvasWidth ?? available);
  const scale = $derived(Math.min(1, available / layoutWidth));
  /** One button per width: `tablet` (width < 64em) and `desktop` (width >= 64em) switch at the same 1024px. */
  const breakpoints = $derived.by(() => {
    const byPx = new Map<number, string[]>();
    for (const bp of breakpointsFrom(app.queries)) byPx.set(bp.px, [...(byPx.get(bp.px) ?? []), bp.name]);
    return [...byPx].map(([px, names]) => ({ px, name: names.join(' · '), names }));
  });
  $effect(() => {
    app.layoutWidth = layoutWidth;
  });
  // The chosen width is remembered per browser.
  untrack(() => {
    try {
      const saved = Number(localStorage.getItem('xb-canvas-width'));
      if (saved) app.canvasWidth = clampWidth(saved);
    } catch {
      /* storage unavailable */
    }
  });
  function setWidth(width: number | null) {
    // Exactly the stage's width is "fit": it follows the window.
    app.canvasWidth = width === null || Math.round(width) === available ? null : clampWidth(width);
    try {
      if (width === null) localStorage.removeItem('xb-canvas-width');
      else localStorage.setItem('xb-canvas-width', String(app.canvasWidth));
    } catch {
      /* ignore */
    }
  }
  /** Both handles resize around the centre: a drag of dx on screen changes the width by 2·dx. */
  function startDrag(event: PointerEvent, side: -1 | 1) {
    const startX = event.clientX;
    const start = layoutWidth;
    const before = app.canvasWidth;
    // Never past the stage while dragging; from a wider chosen width, a drag brings it back within the stage.
    // Esc puts back the width it had.
    dragging = holdPointer(event, {
      cursor: 'ew-resize',
      move: (e) => setWidth(Math.min(available, Math.min(start, available) + side * 2 * (e.clientX - startX))),
      end: () => (dragging = false),
      cancel: () => {
        dragging = false;
        setWidth(before);
      },
    });
  }
  function handleKey(event: KeyboardEvent, side: -1 | 1) {
    const step = event.shiftKey ? 100 : 10;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      setWidth(Math.min(available, Math.min(layoutWidth, available) + (event.key === 'ArrowRight' ? side : -side) * step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setWidth(MIN_WIDTH);
    } else if (event.key === 'Escape' || event.key === 'End') {
      event.preventDefault();
      setWidth(null);
    }
  }
  let dragging = $state(false);
  let typed = $state('');

  const UI_CSS = `
    [data-xb-embed] { background: repeating-linear-gradient(45deg, #eee 0 10px, #e2e2e2 10px 20px); }
    [data-xb-uid] { cursor: default; }
    a[data-xb-uid], a [data-xb-uid] { cursor: default; }
    [data-xb-editing] { outline: 2px solid #ff6f5e !important; outline-offset: 2px; cursor: text !important; caret-color: currentColor; }
  `;

  /**
   * A component open by itself (E5): what the page would hide shows, outlined and labelled, and an empty box says
   * it is empty (or that a script fills it), instead of a white page. Only in the canvas: nothing is saved.
   */
  const SAMPLE_CSS = `
    [data-xb-hidden] { outline: 1px dashed #c2410c !important; outline-offset: 2px; }
    [data-xb-hidden]::before, [data-xb-empty]::before { content: attr(data-xb-hidden) attr(data-xb-empty); display: block; width: max-content; max-width: 100%; margin: 2px 0; padding: 1px 6px; border-radius: 3px; font: 11px/1.5 system-ui, sans-serif; letter-spacing: 0; text-transform: none; color: #9a3412; background: #fff7ed; }
    [data-xb-empty] { min-height: 40px; outline: 1px dashed #a8a29e !important; outline-offset: -1px; }
    [data-xb-empty]::before { color: #57534e; background: #f5f5f4; }
  `;
  /** Boxes a script may fill: an empty one gets a placeholder in a component's canvas. */
  const FILLABLE = new Set(['div', 'section', 'article', 'aside', 'nav', 'main', 'header', 'footer', 'ul', 'ol', 'dl', 'p', 'figure', 'form', 'span']);

  /** What an image from an origin the canvas may not load becomes: a grey picture, so the layout stays (S5). */
  const BLOCKED_IMAGE = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#e7e5e4"/><path d="M110 140l36-44 28 32 20-24 46 36z" fill="#a8a29e"/></svg>');

  /**
   * Media from origins the canvas may not load are taken out before the page enters the frame, so not even a
   * request leaves (the CSP would block it anyway): an image shows a placeholder that names its origin.
   */
  function blockOutside(root: DocumentFragment) {
    const base = window.location.href;
    const origin = (value: string) => {
      try {
        return new URL(value, base).origin;
      } catch {
        return value;
      }
    };
    for (const el of root.querySelectorAll('img, source, video, audio, track, input[type="image"]')) {
      const blocked = new Set<string>();
      for (const name of ['src', 'poster']) {
        const value = el.getAttribute(name);
        if (!value || allowedOrigin(value, allowedOrigins, base)) continue;
        blocked.add(origin(value));
        if (el.tagName === 'IMG' && name === 'src') el.setAttribute('src', BLOCKED_IMAGE);
        else el.removeAttribute(name);
      }
      const set = el.getAttribute('srcset');
      if (set) {
        const outside = set.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '').filter((url) => url && !allowedOrigin(url, allowedOrigins, base));
        if (outside.length) {
          el.removeAttribute('srcset');
          outside.forEach((url) => blocked.add(origin(url)));
        }
      }
      if (blocked.size) {
        const from = [...blocked].join(', ');
        el.setAttribute('data-xb-blocked', from);
        el.setAttribute('title', t('Da {0}: la tela carica solo i media del sito e delle origini ammesse in Histeon → Impostazioni.', from));
      }
    }
  }

  function markSamples(root: DocumentFragment) {
    root.querySelectorAll('[hidden]').forEach((el) => {
      el.removeAttribute('hidden');
      el.setAttribute('data-xb-hidden', t('nascosto nella pagina'));
    });
    const empty = app.script.trim() ? t('vuoto: lo riempie uno script') : t('vuoto');
    root.querySelectorAll('[data-xb-uid]').forEach((el) => {
      if (FILLABLE.has(el.tagName.toLowerCase()) && !el.firstElementChild && !el.textContent?.trim()) el.setAttribute('data-xb-empty', empty);
    });
  }

  /**
   * Text written in the page (docs/spec/inline-text.md): the element becomes editable in place. Enter or a click
   * elsewhere keeps it (through the DSL parser: only text with inline formatting), Esc puts it back, Shift+Enter
   * breaks the line. Plain value, not state: a commit must not repaint the old preview before the new one.
   */
  let editing: { uid: string; el: HTMLElement; before: string; done: (keep: boolean) => void } | null = null;
  /** Spacing handles and the drag grip on the selection (docs/spec/canvas-handles.md). */
  let overlay: CanvasOverlay | null = null;

  function startInline(el: HTMLElement, uid: string, point?: { x: number; y: number }) {
    // A client's page seen only (voce 186): no text opens for writing.
    if (app.viewOnly) return false;
    if (editing) editing.done(true);
    const d = el.ownerDocument;
    const block = inlineTarget(app.find(uid));
    if (!block || d.querySelectorAll(`[data-xb-uid="${CSS.escape(uid)}"]`).length !== 1) return false;
    const before = el.innerHTML;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('data-xb-editing', '');
    overlay?.place();
    el.focus();
    // The caret where the double click was, else at the end.
    const range = point ? d.caretRangeFromPoint?.(point.x, point.y) : null;
    const sel = d.getSelection();
    if (sel) {
      sel.removeAllRanges();
      if (range && el.contains(range.startContainer)) sel.addRange(range);
      else {
        const end = d.createRange();
        end.selectNodeContents(el);
        end.collapse(false);
        sel.addRange(end);
      }
    }
    const onkey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        done(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        d.execCommand('insertLineBreak');
      } else if (commandOf(comboOf(e)) === 'save') {
        // The user's own keys for saving (Ctrl+S unless changed), as everywhere else.
        e.preventDefault();
        done(true);
        void app.save();
      }
    };
    // Pasted text arrives as text: no foreign markup in the page.
    const onpaste = (e: ClipboardEvent) => {
      e.preventDefault();
      d.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
    };
    const onblur = () => done(true);
    const done = (keep: boolean) => {
      if (editing?.el !== el) return;
      editing = null;
      el.removeEventListener('keydown', onkey, true);
      el.removeEventListener('paste', onpaste);
      el.removeEventListener('blur', onblur);
      el.removeAttribute('contenteditable');
      el.removeAttribute('data-xb-editing');
      overlay?.place();
      const pending = swapLater;
      swapLater = false;
      if (!keep) {
        el.innerHTML = before;
        const d = doc();
        if (pending && d && app.preview) swapBody(d, app.preview);
        return;
      }
      tidyInline(el);
      const content = inlineContent(block.attrs.tag, el.innerHTML);
      if (content === null) {
        // Not thrown away: the code panel takes it as typed (client mode has none: the clipboard does).
        const typed = el.innerHTML;
        const words = el.innerText;
        el.innerHTML = before;
        if (app.contentOnly) {
          void navigator.clipboard?.writeText(words).catch(() => {});
          app.status = { kind: 'error', message: t('Questo testo non si può scrivere così: l’ho copiato negli appunti') };
        } else {
          app.htmlDraft = { uid, code: draftCode(block, typed) };
          app.status = { kind: 'error', message: t('Questo testo non si può scrivere nella pagina: è nel pannello HTML, da completare lì') };
        }
        return;
      }
      app.setTextContent(uid, content);
      // A drawing that waited: the new one for this text follows anyway; apply the waiting one only if nothing changed.
      if (pending && content === (block.children[0]?.name === 'xb/text' ? block.children[0].attrs.content : null)) {
        const d = doc();
        if (d && app.preview) swapBody(d, app.preview);
      }
    };
    el.addEventListener('keydown', onkey, true);
    el.addEventListener('paste', onpaste);
    el.addEventListener('blur', onblur);
    editing = { uid, el, before, done };
    return true;
  }

  // Context menu or palette: write in the selected element's text.
  $effect(() => {
    const uid = app.inlineRequest;
    const d = doc();
    if (!uid || !d) return;
    app.inlineRequest = null;
    const el = d.querySelector<HTMLElement>(`[data-xb-uid="${CSS.escape(uid)}"]`);
    if (!el || !startInline(el, uid)) app.status = { kind: 'error', message: inlineRefusal(app.find(uid)) ?? t('Questo elemento non ha un testo da scrivere qui') };
  });

  /** No scripts, plugins, frames, forms or base URL in the preview, on top of the sandbox and the page CSP. */
  // What the canvas may load (S5): the site, the declared origins and those of the page's stylesheets, nothing else.
  const allowedOrigins = $derived(originsOf([...origins, ...(app.preview?.stylesheets ?? [])]));

  /** Elements that can navigate the frame or change how URLs resolve. Forms stay: the sandbox has no allow-forms. */
  const STRIPPED = 'script, meta, base, link, frame, frameset, applet, portal, noscript';
  /** Embedded documents become inert placeholders of the same size (selection still works through data-xb-uid). */
  const EMBEDS = 'iframe, object, embed';

  const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  function documentFor(): string {
    const p = app.preview;
    const links = (p?.stylesheets ?? [])
      .map((href) => safeUrl(href))
      .filter((href): href is string => href !== null)
      .map((href) => `<link rel="stylesheet" href="${escapeAttr(href)}">`)
      .join('');
    // Styles are inserted as text nodes below, never through this string.
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttr(canvasCsp(allowedOrigins))}">${links}<style id="xb-global"></style><style id="xb-live"></style><style id="xb-ui"></style><style id="xb-marks"></style></head><body></body></html>`;
  }

  /** The shell, and only the shell: if the frame ever navigated elsewhere, nothing is written into it. */
  function isShell(d: Document | null | undefined): d is Document {
    return !!d && d.URL === 'about:srcdoc' && d.getElementById('xb-live')?.tagName === 'STYLE';
  }

  function doc(): Document | null {
    const d = ready && frame ? frame.contentDocument : null;
    return isShell(d) ? d : null;
  }

  /** Server-rendered HTML, parsed inert (template content does not load or run anything), minus active elements. */
  function fragmentFor(d: Document, html: string): DocumentFragment {
    const template = d.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll(STRIPPED).forEach((el) => el.remove());
    template.content.querySelectorAll(EMBEDS).forEach((el) => {
      const box = d.createElement('div');
      for (const name of ['class', 'style', 'data-xb-uid']) {
        const value = el.getAttribute(name);
        if (value !== null) box.setAttribute(name, value);
      }
      box.setAttribute('data-xb-embed', el.tagName.toLowerCase());
      box.style.width ||= /^\d+$/.test(el.getAttribute('width') ?? '') ? `${el.getAttribute('width')}px` : '100%';
      box.style.height ||= /^\d+$/.test(el.getAttribute('height') ?? '') ? `${el.getAttribute('height')}px` : '150px';
      el.replaceWith(box);
    });
    // A named <img> or <form> becomes a property of the document (document.getElementById, document.body…): the
    // canvas's own code reads those, so the page's markup must not be able to stand in for them.
    template.content.querySelectorAll('img[name], form[name]').forEach((el) => el.removeAttribute('name'));
    template.content.querySelectorAll('[http-equiv], [srcdoc], [formaction]').forEach((el) => {
      el.removeAttribute('http-equiv');
      el.removeAttribute('srcdoc');
      el.removeAttribute('formaction');
    });
    if (app.isComponent) markSamples(template.content);
    blockOutside(template.content);
    return template.content;
  }

  function onload(event: Event) {
    const iframe = event.currentTarget as HTMLIFrameElement;
    // The initial about:blank load fires before the shell document exists: ignore it.
    let d: Document | null = null;
    try {
      d = iframe.srcdoc ? iframe.contentDocument : null;
    } catch {
      d = null;
    }
    if (!isShell(d)) {
      ready = false;
      return;
    }
    ready = true;
    overlay?.destroy();
    overlay = new CanvasOverlay(d, {
      scale: () => scalesFrom(app.framework.variables).space,
      commit: (side, value) => {
        const uid = app.selected;
        const block = uid ? app.find(uid) : null;
        const cls = staticClasses(block)[0];
        if (!cls) {
          app.status = { kind: 'error', message: t('Per salvare la spaziatura serve una classe: aggiungila nel pannello CSS') };
          return;
        }
        const at = app.canvasPrelude;
        app.setDeclarationOn(`.${cls}`, side, value, at ? [at] : []);
        app.status = { kind: 'idle', message: at ? `.${cls} { ${at} { ${side}: ${value} } }` : `.${cls} { ${side}: ${value} }` };
      },
      canDrop: (target, position) => app.canDrop(target, position),
      drop: (target, position) => {
        if (app.dragging) app.moveTo(app.dragging, target, position);
      },
      dragging: (uid) => (app.dragging = uid),
      label: (uid) => {
        const block = app.find(uid);
        return block ? (roleName(block) ?? describe(block)) : uid;
      },
    });
    d.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
        if (editing && editing.el.contains(event.target as Node)) return;
        // The handles and the grip are the builder's, not the page's: a click on them keeps the selection.
        if ((event.target as Element | null)?.closest?.('xb-overlay')) return;
        const target = (event.target as Element | null)?.closest?.('[data-xb-uid]');
        const uid = target?.getAttribute('data-xb-uid') ?? null;
        pickedHere = uid; // already in view where it was clicked: never scroll for it
        // Ctrl/Cmd+click adds to the selection or takes away, Shift+click takes the siblings in between (E7).
        // An element of the page's template (Histeon Publish marks them: a part such as the header, or the template
        // itself) is not in this document: the status says what it is instead of selecting nothing.
        if (uid && !app.find(uid) && target) {
          const part = target.closest('[data-xb-part]')?.getAttribute('data-xb-part');
          const template = target.closest('[data-xb-template]')?.getAttribute('data-xb-template');
          if (part || template) {
            app.select(null);
            app.status = { kind: 'idle', message: part ? t('Fa parte di {0}, una parte del template: doppio clic per aprirla e modificarla.', part) : t('Fa parte del template {0}: si modifica in «Template e parti».', template ?? '') };
            return;
          }
        }
        // «Rendi elemento» (doc 18 F5): Alt+click on a link or a span inside a sentence makes it an element of its own.
        if (uid && event.altKey && target && event.target !== target && event.target instanceof d.defaultView!.Element) {
          const inline = event.target as Element;
          const tag = inline.tagName.toLowerCase();
          const index = [...target.querySelectorAll(tag)].indexOf(inline);
          if (index >= 0 && app.promoteInline(uid, tag, index)) return;
        }
        if (uid && (event.ctrlKey || event.metaKey)) return app.toggleSelect(uid);
        if (uid && event.shiftKey) return app.selectRange(uid);
        app.select(uid);
        // Client mode (L2): one tap writes in a text, as the invitation says; elsewhere it takes a double click.
        if (app.contentOnly && uid && target instanceof d.defaultView!.HTMLElement && inlineTarget(app.find(uid))) {
          startInline(target, uid, { x: event.clientX, y: event.clientY });
        }
      },
      true,
    );
    // After a click the focus is inside the preview, whose keys never reach the builder window: hand over the
    // builder's shortcuts (Esc clears the selection, and every combination bound in docs/spec/shortcuts.md).
    d.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' && !isBound(comboOf(event))) return;
      event.preventDefault();
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey }),
      );
    });
    d.addEventListener('submit', (event) => event.preventDefault(), true);
    // Right click on an element: the structure's menu, there (E3). Shift+right click keeps the browser's own.
    d.addEventListener('contextmenu', (event) => {
      if (event.shiftKey) return;
      const uid = (event.target as Element | null)?.closest?.('[data-xb-uid]')?.getAttribute('data-xb-uid') ?? null;
      if (!uid || !app.find(uid) || !frame) return;
      event.preventDefault();
      // On one of several selected elements the menu acts on all of them (E7).
      if (!app.selection.includes(uid)) app.select(uid);
      // From the frame's coordinates to the window's, the frame possibly scaled down to fit.
      const box = frame.getBoundingClientRect();
      const scale = frame.offsetWidth ? box.width / frame.offsetWidth : 1;
      canvasMenu = { open: true, uid, x: box.left + event.clientX * scale, y: box.top + event.clientY * scale };
    });
    // The menu listens on the builder's window; a click or a scroll in the frame closes it too.
    d.addEventListener('pointerdown', (event) => {
      if (event.button !== 2) canvasMenu.open = false;
    }, true);
    d.addEventListener('scroll', () => (canvasMenu.open = false), true);
    // Double click: a component opens in place (component session); a text is written in the page.
    d.addEventListener('dblclick', (event) => {
      const el = (event.target as Element | null)?.closest?.('[data-xb-uid]') as HTMLElement | null;
      const uid = el?.getAttribute('data-xb-uid');
      const block = uid ? app.find(uid) : null;
      // A part of the page's template (its header, its footer) opens in place, as a component does.
      const part = el && uid && !block ? el.closest('[data-xb-part]')?.getAttribute('data-xb-part') : null;
      if (part) {
        event.preventDefault();
        void app.openComponent(part);
        return;
      }
      if (!el || !uid || !block) return;
      if (block.name === 'xb/component') {
        event.preventDefault();
        void app.openComponent(block.attrs.ref);
      } else if (!startInline(el, uid, { x: event.clientX, y: event.clientY })) {
        const why = inlineRefusal(block);
        if (why) app.status = { kind: 'idle', message: why };
      }
    });
    d.addEventListener('mouseover', (event) => {
      const target = (event.target as Element | null)?.closest?.('[data-xb-uid]');
      app.hovered = target?.getAttribute('data-xb-uid') ?? null;
    });
    d.addEventListener('mouseleave', () => (app.hovered = null));
  }

  // First paint: the shell document (stylesheets). Later updates only swap the body: no flicker, scroll kept.
  // null, not '': a site without stylesheets has the key '', and the first preview must still write the shell,
  // or the canvas stays an empty about:blank (Histeon Publish, whose /render always answers stylesheets: [], hit it).
  let shellFor: string | null = null;
  $effect(() => {
    const p = app.preview;
    if (!p || !frame) return;
    const key = p.stylesheets.join('|');
    if (key !== shellFor) {
      shellFor = key;
      ready = false;
      frame.srcdoc = documentFor();
    }
  });

  /** A new drawing that arrived while a text was being written in the page: applied when the writing ends. */
  let swapLater = false;
  function swapBody(d: Document, p: NonNullable<typeof app.preview>) {
    d.body.replaceChildren(fragmentFor(d, p.html));
    // Site-wide CSS rarely changes: rewriting it would make the frame restyle everything for nothing.
    const global = d.getElementById('xb-global') as HTMLStyleElement;
    if (global.textContent !== p.globalCss) global.textContent = p.globalCss;
    (d.getElementById('xb-ui') as HTMLStyleElement).textContent = UI_CSS + (app.isComponent ? SAMPLE_CSS : '');
    // The handles follow the new elements in the same moment (no frame without them).
    overlay?.place();
  }
  $effect(() => {
    const d = doc();
    const p = app.preview;
    if (!d || !p) return;
    // Never under the writer's hands: a late drawing of an earlier edit waits for this one to end.
    if (editing) {
      swapLater = true;
      return;
    }
    swapBody(d, p);
  });

  $effect(() => {
    const d = doc();
    const css = app.liveCss;
    if (d) (d.getElementById('xb-live') as HTMLStyleElement).textContent = css;
  });

  $effect(() => {
    const d = doc();
    void app.preview;
    const selected = app.selected;
    const others = app.selection.slice(1);
    const hovered = app.hovered;
    if (!d) return;
    const rule = (uid: string, color: string, style: string) =>
      `[data-xb-uid="${CSS.escape(uid)}"] { outline: 2px ${style} ${color} !important; outline-offset: -2px; }`;
    (d.getElementById('xb-marks') as HTMLStyleElement).textContent =
      (hovered && hovered !== selected ? rule(hovered, '#8a92e6', 'dashed') : '') + (selected ? rule(selected, '#3f4bc4', 'solid') : '') + others.map((uid) => rule(uid, '#5c67d6', 'solid')).join('');
  });

  $effect(() => {
    const d = doc();
    void app.preview;
    void app.liveCss;
    const selected = app.selected;
    if (!d || !overlay) return;
    // After the body swap and the new CSS are in.
    requestAnimationFrame(() => overlay?.show(selected));
  });

  // Bring a selection into view once, when it changes and was made elsewhere (structure, code, palette).
  // Never on hover, edits or reloads of the preview: the user's own scrolling must stay where it is.
  let pickedHere: string | null = null;
  let shown: string | null = null;
  $effect(() => {
    const d = doc();
    const selected = app.selected;
    if (!d || selected === shown) return;
    shown = selected;
    if (!selected || selected === pickedHere) return;
    pickedHere = null;
    d.querySelector(`[data-xb-uid="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' });
  });
</script>

<section class="canvas" aria-label={t('Anteprima')}>
  <div class="bar">
    <form class="width" onsubmit={(e) => (e.preventDefault(), typed && setWidth(Number(typed)), (typed = ''))}>
      <label>
        <input
          type="number"
          min={MIN_WIDTH}
          max={MAX_WIDTH}
          aria-label={t("Larghezza dell'anteprima in pixel")}
          placeholder={String(layoutWidth)}
          value={typed}
          oninput={(e) => (typed = e.currentTarget.value)}
          onblur={() => (typed && setWidth(Number(typed)), (typed = ''))}
        />
        px
      </label>
      {#if scale < 1}<span class="zoom" title={t("Più larga dello spazio dell'anteprima: la pagina è ridotta per entrare")}>{t('ridotta al {0}%', Math.round(scale * 100))}</span>{/if}
      <button type="button" disabled={app.canvasWidth === null} onclick={() => setWidth(null)} title={t('Torna alla larghezza dello spazio disponibile (Esc su una maniglia)')}>{t('Adatta')}</button>
    </form>
    {#if app.canvasWidth !== null}
      <button type="button" class="follow" class:on={app.followCanvas} aria-pressed={app.followCanvas} onclick={() => (app.followCanvas = !app.followCanvas)} title={app.followCanvas ? t('Le modifiche di stile vanno in questa @media: un clic per scriverle per tutte le larghezze') : t('Le modifiche valgono per tutte le larghezze: un clic per scriverle alla larghezza della tela')}>
        {app.followCanvas && app.canvasPrelude ? t('Modifiche in {0}', app.canvasPrelude) : t('Modifiche per tutte le larghezze')}
      </button>
    {/if}
    {#if breakpoints.length}
      <div class="marks" role="group" aria-label={t('Punti di rottura del sito')}>
        {#each breakpoints as bp (bp.px)}
          <button
            class:active={layoutWidth === bp.px}
            onclick={() => setWidth(bp.px)}
            title={t("Media query con nome {0}: porta l'anteprima a {1}px", bp.names.map((n) => `--${n}`).join(', '), bp.px) + (bp.px > available ? ' ' + t('(più larga dello spazio: la pagina viene ridotta)') : '')}
          >{bp.name} {bp.px}</button>
        {/each}
      </div>
    {/if}
    {#if template}
      <label class="sample">
        {template.samples.length ? t('Anteprima con') : t('Anteprima')}
        {#if template.samples.length}
          <select onchange={pickSample} value={String(app.contextId || template.samples[0]?.id || 0)}>
            {#each template.samples as sample (sample.id)}<option value={String(sample.id)}>{sample.title}</option>{/each}
          </select>
        {:else}
          <span class="hint">{t('elenco degli ultimi articoli')}</span>
        {/if}
      </label>
    {/if}
    {#if app.previewError}<span class="error">{t('Anteprima non aggiornata: {0}', app.previewError)}</span>{/if}
    <PathBar {app} />
  </div>
  <div class="stage" bind:clientWidth={stageWidth} bind:clientHeight={stageHeight}>
    <div class="frame-box" class:dragging style:width="{layoutWidth * scale}px" style:height="{Math.max(0, stageHeight - 24)}px">
      <div class="handle left" role="slider" tabindex="0" aria-label={t("Larghezza dell'anteprima (maniglia sinistra)")} aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={layoutWidth} aria-valuetext={t('{0} pixel', layoutWidth)} onpointerdown={(e) => startDrag(e, -1)} onkeydown={(e) => handleKey(e, -1)} ondblclick={() => setWidth(null)}></div>
      <div class="handle right" role="slider" tabindex="0" aria-label={t("Larghezza dell'anteprima")} aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={layoutWidth} aria-valuetext={t('{0} pixel', layoutWidth)} onpointerdown={(e) => startDrag(e, 1)} onkeydown={(e) => handleKey(e, 1)} ondblclick={() => setWidth(null)}></div>
      {#if dragging}<span class="readout" aria-hidden="true">{layoutWidth} px</span>{/if}
      <iframe
        bind:this={frame}
        {onload}
        title={t('Anteprima della pagina')}
        data-xb-canvas
        sandbox="allow-same-origin"
        style:width="{layoutWidth}px"
        style:height="{Math.max(0, stageHeight - 24) / scale}px"
        style:transform="scale({scale})"
      ></iframe>
    </div>
  </div>
<!-- The menu runs its action after closing, so what it acts on outlives the open flag. -->
{#if canvasMenu.open}
  <ContextMenu
    {app}
    uid={canvasMenu.uid}
    x={canvasMenu.x}
    y={canvasMenu.y}
    onclose={() => (canvasMenu.open = false)}
    onrename={() => {
      app.renameRequest = canvasMenu.uid;
      canvasMenu.open = false;
    }}
  />
{/if}
</section>

<style>
  .canvas {
    display: grid;
    grid-template-rows: auto 1fr;
    height: 100%;
    min-width: 0;
    background: var(--xb-stage);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--xb-line);
    background: var(--xb-panel);
  }
  .width {
    display: flex;
    align-items: center;
    gap: 6px;
    font: 12px var(--xb-mono);
    color: var(--xb-muted);
  }
  .width input {
    width: 72px;
    font: 12px var(--xb-mono);
    padding: 2px 4px;
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-sm);
    background: var(--xb-bg);
    color: var(--xb-text);
  }
  .width input::placeholder {
    color: var(--xb-text);
  }
  .width button,
  .marks button {
    font: 12px var(--xb-sans);
    padding: 2px 8px;
    border-radius: var(--xb-r-sm);
    border: 1px solid var(--xb-line);
    background: transparent;
    color: var(--xb-muted);
    cursor: pointer;
  }
  .width button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .follow {
    font: 12px var(--xb-mono);
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--xb-line);
    background: transparent;
    color: var(--xb-muted);
    cursor: pointer;
    white-space: nowrap;
  }
  .follow.on {
    border-color: var(--xb-coral);
    color: var(--xb-text);
    background: color-mix(in srgb, var(--xb-coral) 10%, transparent);
  }
  .marks {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .marks button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .marks button.active {
    color: var(--xb-text);
    border-color: var(--xb-accent);
  }
  .handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 12px;
    z-index: 2;
    cursor: ew-resize;
    touch-action: none;
  }
  .handle::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 4px;
    width: 4px;
    height: 40px;
    margin-top: -20px;
    border-radius: 2px;
    background: var(--xb-muted);
    opacity: 0.6;
  }
  .handle:hover::after,
  .handle:focus-visible::after,
  .dragging .handle::after {
    background: var(--xb-accent);
    opacity: 1;
  }
  .handle:focus-visible {
    outline: none;
  }
  .handle.left {
    left: -14px;
  }
  .handle.right {
    right: -14px;
  }
  /* While dragging, the page must not swallow the pointer. */
  .dragging iframe {
    pointer-events: none;
  }
  .readout {
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 3;
    padding: 2px 8px;
    border-radius: var(--xb-r-sm);
    background: var(--xb-text);
    color: var(--xb-bg);
    font: 12px var(--xb-mono);
  }
  .error {
    color: var(--xb-danger);
    font-size: 12px;
  }
  .stage {
    overflow: hidden;
    display: flex;
    justify-content: center;
    padding: 12px;
    min-height: 0;
  }
  .frame-box {
    position: relative;
    flex: none;
  }
  iframe {
    position: absolute;
    top: 0;
    left: 0;
    border: 0;
    background: #fff;
    transform-origin: 0 0;
    box-shadow: 0 0 0 1px var(--xb-line);
  }
  .zoom {
    font: 12px var(--xb-mono);
    color: var(--xb-muted);
  }
  .sample {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--xb-muted);
  }
  .sample select {
    font: 12px var(--xb-sans);
    max-width: 260px;
    background: var(--xb-bg);
    color: var(--xb-text);
    border: 1px solid var(--xb-line);
    border-radius: var(--xb-r-sm);
    padding: 2px 4px;
  }
  .hint {
    font-style: italic;
  }
</style>
