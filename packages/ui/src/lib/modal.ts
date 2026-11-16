/**
 * A Svelte action for dialogs (queue E7): focus moves inside on open (to the element marked data-autofocus, else the
 * first button of .modal-actions, usually "Annulla"), Tab and Shift+Tab stay inside, Escape closes unless an
 * operation is running, and focus returns to the control that opened the dialog when it closes.
 */
export interface ModalOptions {
  onClose?: () => void;
  /** False while closing would interrupt something (a busy operation). */
  canClose?: () => boolean;
  /** Where the focus goes back when the control that opened the dialog was disabled meanwhile (it lost the focus). */
  returnFocus?: HTMLElement | null;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function modal(node: HTMLElement, initial: ModalOptions = {}) {
  let options = initial;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusable = () => [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
  // The dialog may open while its buttons are still disabled (the operation that opened it is finishing): the focus
  // goes to the dialog itself, then to the first enabled action as soon as there is one (a few frames at most).
  let frames = 0;
  let stopped = false;
  const placeFocus = (): void => {
    if (stopped) return;
    const target = node.querySelector<HTMLElement>("[data-autofocus]:not([disabled])") ?? node.querySelector<HTMLElement>(".modal-actions button:not([disabled])");
    if (target) {
      if (!node.contains(document.activeElement) || document.activeElement === node) target.focus();
      return;
    }
    if (document.activeElement !== node && !node.contains(document.activeElement)) node.focus();
    if (frames++ < 30) requestAnimationFrame(placeFocus);
  };
  queueMicrotask(placeFocus);
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (options.canClose?.() !== false) options.onClose?.();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable();
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
      node.focus();
      return;
    }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  node.addEventListener("keydown", onKeydown);
  return {
    update(next: ModalOptions) {
      options = next;
    },
    destroy() {
      stopped = true;
      node.removeEventListener("keydown", onKeydown);
      const target = previous && previous !== document.body && previous.isConnected ? previous : options.returnFocus;
      if (target?.isConnected) requestAnimationFrame(() => target.focus());
    },
  };
}
