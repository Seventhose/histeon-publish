// The layer over the canvas page with the selection's spacing handles and its drag grip
// (docs/spec/canvas-handles.md). It lives in the canvas document but outside <body>, so a new render of the page
// (which swaps the body) keeps it; its parts are in a shadow root, so the site's CSS never reaches them, and a
// pointer move only changes their position.
import { dropAt, grow, SIDES, snap, type DropPosition, type Side, type Step } from './handles.ts';
import { t } from './i18n.ts';

export interface OverlayHost {
  /** The framework's spacing scale (`var(--space-m)`…), measured in the page when a drag starts. */
  scale(): Array<{ label: string; value: string }>;
  /** A side was dragged to `value`: write it in the selection's CSS. */
  commit(side: Side, value: string): void;
  /** The node under the pointer allows a drop of the selection there. */
  canDrop(target: string, position: DropPosition): boolean;
  drop(target: string, position: DropPosition): void;
  dragging(uid: string | null): void;
  label(uid: string): string;
}

const CORAL = '#ff6f5e';

const SHADOW_CSS = `
  :host { all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
  * { box-sizing: border-box; user-select: none; -webkit-user-select: none; -webkit-user-drag: none; touch-action: none; }
  xb-handle, xb-grip, xb-readout, xb-marker, xb-probe, xb-frame { position: absolute; display: none; }
  /* The selection in two tones, white around indigo: it shows on light, dark and indigo sections alike. */
  xb-frame { border: 2px solid #3f4bc4; box-shadow: 0 0 0 1px #fff, inset 0 0 0 1px #fff; border-radius: 1px; }
  xb-handle { border-radius: 3px; border: 1px solid #fff; pointer-events: auto; }
  xb-handle[data-axis='x'] { width: 6px; height: 22px; cursor: ew-resize; }
  xb-handle[data-axis='y'] { width: 22px; height: 6px; cursor: ns-resize; }
  xb-handle[data-kind='padding'] { background: ${'#ff6f5e'}; }
  xb-handle[data-kind='margin'] { background: ${'#3f4bc4'}; }
  xb-grip { pointer-events: auto; cursor: grab; padding: 2px 7px; border-radius: 5px 5px 0 0; background: #171a33; color: #f3ece1; font: 600 11px/16px system-ui, sans-serif; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
  xb-readout { padding: 3px 7px; border-radius: 5px; background: #171a33; color: #f3ece1; font: 600 11px/16px ui-monospace, monospace; white-space: nowrap; }
  xb-probe { display: block; visibility: hidden; left: -9999px; top: 0; }
`;

function el(doc: Document, tag: string): HTMLElement {
  return doc.createElement(tag);
}

export class CanvasOverlay {
  private root: HTMLElement;
  private shadow: ShadowRoot;
  private target: HTMLElement | null = null;
  private uid: string | null = null;
  private handles = new Map<Side, HTMLElement>();
  private grip: HTMLElement;
  private readout: HTMLElement;
  private marker: HTMLElement;
  /** The two-tone box around the selection (A3). */
  private frame: HTMLElement;
  private busy = false;
  /** While one of our drags runs, the page's own drag and selection are off. */
  private readonly noNative = (e: Event) => e.preventDefault();
  private readonly onScroll = () => this.place();

  constructor(
    private readonly doc: Document,
    private readonly host: OverlayHost,
  ) {
    this.root = el(doc, 'xb-overlay');
    this.root.setAttribute('aria-hidden', 'true');
    this.shadow = this.root.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = SHADOW_CSS;
    this.shadow.append(style);
    for (const side of SIDES) {
      const h = el(doc, 'xb-handle');
      h.dataset.side = side;
      h.dataset.axis = side.endsWith('left') || side.endsWith('right') ? 'x' : 'y';
      h.dataset.kind = side.startsWith('padding') ? 'padding' : 'margin';
      h.title = side;
      h.addEventListener('pointerdown', (e) => this.startSpacing(e, side));
      this.shadow.append(h);
      this.handles.set(side, h);
    }
    this.grip = el(doc, 'xb-grip');
    this.grip.title = t('Trascina per spostare');
    this.grip.addEventListener('pointerdown', (e) => this.startMove(e));
    this.readout = el(doc, 'xb-readout');
    this.marker = el(doc, 'xb-marker');
    this.frame = el(doc, 'xb-frame');
    // Under the handles and the grip: drawn first.
    this.shadow.prepend(this.frame);
    this.shadow.append(this.grip, this.readout, this.marker);
    // A drag of ours must never turn into the browser's own drag (of text or an element) or a text selection.
    this.shadow.addEventListener('dragstart', (e) => e.preventDefault());
    this.shadow.addEventListener('selectstart', (e) => e.preventDefault());
    doc.documentElement.append(this.root);
    doc.defaultView?.addEventListener('scroll', this.onScroll, { passive: true });
    doc.defaultView?.addEventListener('resize', this.onScroll);
  }

  destroy(): void {
    this.doc.defaultView?.removeEventListener('scroll', this.onScroll);
    this.doc.defaultView?.removeEventListener('resize', this.onScroll);
    this.root.remove();
  }

  /** Shows the handles on the selection (null: hides them). */
  show(uid: string | null): void {
    if (this.busy) return;
    this.uid = uid;
    const found = uid ? this.doc.querySelectorAll<HTMLElement>(`[data-xb-uid="${CSS.escape(uid)}"]`) : null;
    // A node repeated by a loop has many boxes: no handles (which one would they be?).
    this.target = found && found.length === 1 ? (found[0] as HTMLElement) : null;
    if (this.target && !this.root.isConnected) this.doc.documentElement.append(this.root);
    this.place();
  }

  place(): void {
    // A new drawing of the page replaced the element: find it again at once, so the handles never blink away.
    if (this.uid && !this.target?.isConnected && !this.busy) {
      const found = this.doc.querySelectorAll<HTMLElement>(`[data-xb-uid="${CSS.escape(this.uid)}"]`);
      this.target = found.length === 1 ? (found[0] as HTMLElement) : null;
    }
    const t = this.target?.isConnected ? this.target : null;
    const visible = !!t && !t.hasAttribute('data-xb-editing');
    for (const h of this.handles.values()) h.style.display = visible ? 'block' : 'none';
    this.grip.style.display = visible ? 'block' : 'none';
    this.frame.style.display = visible ? 'block' : 'none';
    if (!t || !visible || !this.uid) return;
    const r = t.getBoundingClientRect();
    Object.assign(this.frame.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const cs = t.ownerDocument.defaultView?.getComputedStyle(t);
    const px = (v: string | undefined) => Number.parseFloat(v ?? '0') || 0;
    const pad = { top: px(cs?.paddingTop), right: px(cs?.paddingRight), bottom: px(cs?.paddingBottom), left: px(cs?.paddingLeft) };
    const mar = { top: px(cs?.marginTop), bottom: px(cs?.marginBottom) };
    const at = (h: HTMLElement | undefined, x: number, y: number) => {
      if (!h) return;
      h.style.left = `${x - h.offsetWidth / 2}px`;
      h.style.top = `${y - h.offsetHeight / 2}px`;
    };
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    at(this.handles.get('padding-top'), cx, r.top + pad.top);
    at(this.handles.get('padding-bottom'), cx, r.bottom - pad.bottom);
    at(this.handles.get('padding-left'), r.left + pad.left, cy);
    at(this.handles.get('padding-right'), r.right - pad.right, cy);
    at(this.handles.get('margin-top'), cx + 30, r.top - mar.top);
    at(this.handles.get('margin-bottom'), cx + 30, r.bottom + mar.bottom);
    this.grip.textContent = `⠿ ${this.host.label(this.uid)}`;
    this.grip.style.left = `${r.left}px`;
    this.grip.style.top = `${Math.max(0, r.top - 20)}px`;
  }

  /**
   * Keys during a drag, from the preview and from the builder around it: the press on a handle does not move the
   * focus, so Esc may reach either document. Returns the remover.
   */
  private listenKeys(onkey: (ev: KeyboardEvent) => void): () => void {
    const outer = this.doc.defaultView?.parent;
    this.doc.addEventListener('keydown', onkey, true);
    if (outer && outer !== this.doc.defaultView) outer.addEventListener('keydown', onkey, true);
    return () => {
      this.doc.removeEventListener('keydown', onkey, true);
      outer?.removeEventListener('keydown', onkey, true);
    };
  }

  private lockNative(on: boolean): void {
    for (const type of ['dragstart', 'selectstart']) {
      if (on) this.doc.addEventListener(type, this.noNative, true);
      else this.doc.removeEventListener(type, this.noNative, true);
    }
    if (on) this.doc.getSelection()?.removeAllRanges();
  }

  /** The scale measured here: each step's value resolved by the page's own CSS. */
  private steps(prop: Side): Step[] {
    const probe = el(this.doc, 'xb-probe');
    this.shadow.append(probe);
    const out: Step[] = [{ label: '0', value: '0', px: 0 }];
    for (const s of this.host.scale()) {
      probe.style.setProperty(prop, s.value);
      const v = Number.parseFloat(this.doc.defaultView?.getComputedStyle(probe).getPropertyValue(prop) ?? '');
      if (Number.isFinite(v)) out.push({ ...s, px: v });
    }
    probe.remove();
    return out.sort((a, b) => a.px - b.px);
  }

  private startSpacing(e: PointerEvent, side: Side): void {
    const t = this.target;
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    this.lockNative(true);
    this.busy = true;
    const steps = this.steps(side);
    const start = Number.parseFloat(this.doc.defaultView?.getComputedStyle(t).getPropertyValue(side) ?? '0') || 0;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const before = t.style.getPropertyValue(side);
    let current: Step | null = null;
    const move = (ev: PointerEvent) => {
      // The release happened where the page could not see it.
      if ((ev.buttons & 1) === 0) return up();
      current = snap(start + grow(side, ev.clientX - x0, ev.clientY - y0), steps, ev.altKey);
      t.style.setProperty(side, current.value);
      this.readout.textContent = `${side}: ${current.label}${current.value.startsWith('var(') ? ` · ${Math.round(current.px)}px` : ''}`;
      this.readout.style.display = 'block';
      this.readout.style.left = `${ev.clientX + 12}px`;
      this.readout.style.top = `${ev.clientY + 12}px`;
      this.place();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.removeEventListener('lostpointercapture', up);
      stopKeys();
      this.readout.style.display = 'none';
      this.lockNative(false);
      this.busy = false;
      if (before) t.style.setProperty(side, before);
      else t.style.removeProperty(side);
      if (!t.getAttribute('style')) t.removeAttribute('style');
      if (current) this.host.commit(side, current.value);
      this.place();
    };
    // Esc: the value it had, nothing written.
    const onkey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      current = null;
      up();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    handle.addEventListener('lostpointercapture', up);
    const stopKeys = this.listenKeys(onkey);
  }

  private startMove(e: PointerEvent): void {
    const uid = this.uid;
    if (!uid || !this.target) return;
    e.preventDefault();
    e.stopPropagation();
    this.grip.setPointerCapture(e.pointerId);
    this.lockNative(true);
    this.busy = true;
    this.host.dragging(uid);
    this.grip.style.cursor = 'grabbing';
    let drop: { target: string; position: DropPosition } | null = null;
    const move = (ev: PointerEvent) => {
      if ((ev.buttons & 1) === 0) return end(false);
      const under = this.doc.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-xb-uid]') as HTMLElement | null;
      const target = under?.getAttribute('data-xb-uid') ?? null;
      drop = null;
      this.marker.style.display = 'none';
      if (!under || !target || target === uid) return;
      const r = under.getBoundingClientRect();
      const position = dropAt(ev.clientY, r.top, r.height, (p) => this.host.canDrop(target, p));
      if (!position) return;
      drop = { target, position };
      const m = this.marker.style;
      m.display = 'block';
      m.left = `${r.left}px`;
      m.width = `${r.width}px`;
      if (position === 'inside') {
        m.top = `${r.top}px`;
        m.height = `${r.height}px`;
        m.outline = `2px dashed ${CORAL}`;
        m.background = 'rgb(255 111 94 / 0.08)';
      } else {
        m.top = `${(position === 'before' ? r.top : r.bottom) - 2}px`;
        m.height = '4px';
        m.outline = 'none';
        m.background = CORAL;
      }
    };
    const end = (keep: boolean) => {
      this.grip.removeEventListener('pointermove', move);
      this.grip.removeEventListener('pointerup', onup);
      this.grip.removeEventListener('pointercancel', oncancel);
      this.grip.removeEventListener('lostpointercapture', oncancel);
      stopKeys();
      this.marker.style.display = 'none';
      this.grip.style.cursor = 'grab';
      this.lockNative(false);
      this.busy = false;
      const d = drop;
      if (keep && d) this.host.drop(d.target, d.position);
      this.host.dragging(null);
      this.place();
    };
    const onup = () => end(true);
    const oncancel = () => end(false);
    const onkey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        end(false);
      }
    };
    this.grip.addEventListener('pointermove', move);
    this.grip.addEventListener('pointerup', onup);
    this.grip.addEventListener('pointercancel', oncancel);
    this.grip.addEventListener('lostpointercapture', oncancel);
    const stopKeys = this.listenKeys(onkey);
  }
}
