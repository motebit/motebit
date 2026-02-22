/** Selector for all focusable elements within a container. */
const FOCUSABLE_SELECTOR = 'button:not([disabled]):not([tabindex="-1"]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Get all visible focusable elements within a container. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(el => el.offsetParent !== null); // visible only
}

/** Trap focus within a container when Tab is pressed. */
export function trapFocus(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== "Tab") return;

  const focusable = getFocusableElements(container);
  if (focusable.length === 0) return;

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;

  if (e.shiftKey) {
    if (document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

// === Focus Management State ===

let previousFocusElement: HTMLElement | null = null;

/** Save the currently focused element so we can restore it later. */
export function saveFocus(): void {
  previousFocusElement = document.activeElement as HTMLElement | null;
}

/** Restore focus to the previously saved element. */
export function restoreFocus(): void {
  if (previousFocusElement && typeof previousFocusElement.focus === "function") {
    previousFocusElement.focus();
    previousFocusElement = null;
  }
}

/** Focus the first focusable element within a container. */
export function focusFirst(container: HTMLElement): void {
  const focusable = getFocusableElements(container);
  if (focusable.length > 0) {
    focusable[0]!.focus();
  }
}
