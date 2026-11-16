// Dragging a handle with the pointer (splitters, resize grips): the drag lasts exactly as long as the button is
// held on that handle. The browser can take the pointer away mid-drag (a native drag of a draggable element that
// ends up under the press point, touch scrolling, the window losing focus, a lost capture): every such way out ends
// the drag, so a handle never keeps following a pointer whose button is up. Native drags are refused while a
// handle is held.

export interface Hold {
  /** Every move while the button is held. */
  move: (event: PointerEvent) => void;
  /** Button released: keep what the moves did. */
  end?: () => void;
  /** Escape, the browser cancelled the pointer or the window lost focus: put back what was there before. */
  cancel?: () => void;
  /** Cursor shown everywhere until the drag ends, whatever is under the pointer. */
  cursor: string;
}

const STYLE_ID = 'xb-hold-style';
const STYLE = `html.xb-holding, html.xb-holding * { cursor: var(--xb-hold-cursor) !important; user-select: none !important; }
html.xb-holding iframe { pointer-events: none !important; }`;

/**
 * Starts a drag from a pointerdown on `handle` (by default the listener's element; React's delegated events pass
 * it); false if it is not a primary-button press.
 */
export function holdPointer(event: PointerEvent, hold: Hold, handle = event.currentTarget as HTMLElement): boolean {
  if (event.button !== 0 || !event.isPrimary) return false;
  const doc = handle.ownerDocument;
  const win = doc.defaultView ?? window;
  // The press still focuses the handle (keyboard resizing goes on from there); text selection is off through the
  // class below and native drags through the dragstart listener.
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // The pointer is already gone: the first move without a button ends the drag.
  }
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    doc.head.append(style);
  }
  const root = doc.documentElement;
  root.style.setProperty('--xb-hold-cursor', hold.cursor);
  root.classList.add('xb-holding');

  let done = false;
  const finish = (keep: boolean) => {
    if (done) return;
    done = true;
    handle.removeEventListener('pointermove', onmove);
    handle.removeEventListener('pointerup', onup);
    handle.removeEventListener('pointercancel', oncancel);
    handle.removeEventListener('lostpointercapture', onlost);
    win.removeEventListener('keydown', onkey, true);
    win.removeEventListener('blur', oncancel);
    // Cancelled with the button still down (Esc): that press must not turn into a native drag either. The capture
    // stays until the button goes up (releasing it mid-press leaves Chromium sending the page no mouse events);
    // the handle simply no longer listens.
    if (keep) release();
    else {
      win.addEventListener('pointerup', release, true);
      win.addEventListener('pointerdown', release, true);
      win.addEventListener('pointermove', releaseIfUp, true);
    }
    root.classList.remove('xb-holding');
    root.style.removeProperty('--xb-hold-cursor');
    if (keep) hold.end?.();
    else hold.cancel?.();
  };
  const onmove = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    // The release happened where the page could not see it.
    if ((e.buttons & 1) === 0) return finish(true);
    hold.move(e);
  };
  const onup = (e: PointerEvent) => {
    if (e.pointerId === event.pointerId) finish(true);
  };
  const oncancel = () => finish(false);
  // The handle went away (hidden, as the bottom edge at 0) or something else took the capture: keep what is done.
  const onlost = () => finish(true);
  const onkey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };
  // Refused before the page's own handlers see it: a panel or a row must not believe its drag started.
  const nodrag = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const release = () => {
    win.removeEventListener('dragstart', nodrag, true);
    win.removeEventListener('pointerup', release, true);
    win.removeEventListener('pointerdown', release, true);
    win.removeEventListener('pointermove', releaseIfUp, true);
  };
  const releaseIfUp = (e: PointerEvent) => {
    if ((e.buttons & 1) === 0) release();
  };
  handle.addEventListener('pointermove', onmove);
  handle.addEventListener('pointerup', onup);
  handle.addEventListener('pointercancel', oncancel);
  handle.addEventListener('lostpointercapture', onlost);
  win.addEventListener('keydown', onkey, true);
  win.addEventListener('blur', oncancel);
  win.addEventListener('dragstart', nodrag, true);
  return true;
}
