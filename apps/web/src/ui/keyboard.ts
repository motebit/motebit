// === Keyboard Shortcuts ===

export interface KeyboardCallbacks {
  focusInput(): void;
  openSettings(): void;
  openConversations(): void;
  newConversation(): void;
}

const shortcutBackdrop = document.getElementById("shortcut-backdrop") as HTMLDivElement;

export function initKeyboard(callbacks: KeyboardCallbacks): void {
  function openShortcuts(): void {
    shortcutBackdrop.classList.add("open");
  }

  function closeShortcuts(): void {
    shortcutBackdrop.classList.remove("open");
  }

  document.getElementById("shortcut-dismiss")!.addEventListener("click", closeShortcuts);
  shortcutBackdrop.addEventListener("click", (e) => {
    if (e.target === shortcutBackdrop) closeShortcuts();
  });

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    const meta = e.metaKey || e.ctrlKey;

    // Close shortcut dialog on Escape
    if (e.key === "Escape" && shortcutBackdrop.classList.contains("open")) {
      e.preventDefault();
      closeShortcuts();
      return;
    }

    // Don't fire shortcuts when typing in input fields (except meta combos)
    const target = e.target as HTMLElement;
    const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

    // Cmd+K — focus input (always)
    if (meta && e.key === "k") {
      e.preventDefault();
      callbacks.focusInput();
      return;
    }

    // Cmd+, — open settings (always)
    if (meta && e.key === ",") {
      e.preventDefault();
      callbacks.openSettings();
      return;
    }

    // Cmd+J — open conversations (always)
    if (meta && e.key === "j") {
      e.preventDefault();
      callbacks.openConversations();
      return;
    }

    // Cmd+Shift+N — new conversation
    if (meta && e.shiftKey && e.key === "N") {
      e.preventDefault();
      callbacks.newConversation();
      return;
    }

    // ? — show shortcut help (only when not in input)
    if (e.key === "?" && !isInput && !meta) {
      e.preventDefault();
      openShortcuts();
      return;
    }
  });

  // Export for use by slash commands
  return;
}

export function openShortcutDialog(): void {
  shortcutBackdrop.classList.add("open");
}
