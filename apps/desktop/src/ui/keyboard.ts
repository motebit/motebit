import type { SettingsAPI } from "./settings";
import { saveFocus, restoreFocus, focusFirst, trapFocus } from "./focus";

export interface KeyboardDeps {
  settings: SettingsAPI;
  goals: { open(): void; close(): void };
  memory: { open(): void; close(): void };
  conversations: { open(): void; close(): void };
}

// === Shortcut Overlay ===

const shortcutBackdrop = document.getElementById("shortcut-backdrop") as HTMLDivElement;

function openShortcutHelp(): void {
  saveFocus();
  shortcutBackdrop.classList.add("open");
  const dialog = document.getElementById("shortcut-dialog") as HTMLDivElement;
  focusFirst(dialog);
}

function closeShortcutHelp(): void {
  shortcutBackdrop.classList.remove("open");
  restoreFocus();
}

// === Init ===

export function initKeyboard(deps: KeyboardDeps): void {
  const { settings, goals, memory, conversations } = deps;

  const chatInput = document.getElementById("chat-input") as HTMLInputElement;
  const goalsPanel = document.getElementById("goals-panel") as HTMLDivElement;
  const memoryPanel = document.getElementById("memory-panel") as HTMLDivElement;
  const conversationsPanel = document.getElementById("conversations-panel") as HTMLDivElement;
  const settingsModal = document.getElementById("settings-modal") as HTMLDivElement;
  const pinDialog = document.getElementById("pin-dialog") as HTMLDivElement;
  const pairingDialog = document.getElementById("pairing-dialog") as HTMLDivElement;
  const welcomeDialog = document.getElementById("welcome-dialog") as HTMLDivElement;
  const shortcutDialog = document.getElementById("shortcut-dialog") as HTMLDivElement;

  // Close shortcut help
  document.getElementById("shortcut-dismiss")!.addEventListener("click", closeShortcutHelp);
  shortcutBackdrop.addEventListener("click", (e) => {
    if (e.target === shortcutBackdrop) closeShortcutHelp();
  });

  // Check if a text input is focused (to not hijack typing)
  function isTextInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el as HTMLInputElement).type.toLowerCase();
      return (
        type === "text" ||
        type === "password" ||
        type === "number" ||
        type === "search" ||
        type === "url" ||
        type === "email"
      );
    }
    return tag === "textarea" || (el as HTMLElement).isContentEditable;
  }

  const isMac = navigator.platform?.startsWith("Mac") ?? false;

  // Update Cmd/Ctrl labels in shortcut overlay on non-Mac
  if (!isMac) {
    document.querySelectorAll("#shortcut-dialog .shortcut-key").forEach((el) => {
      if (el.textContent === "Cmd") el.textContent = "Ctrl";
    });
  }

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;

    // Cmd/Ctrl + K -- Focus chat input
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      chatInput.focus();
      return;
    }

    // Cmd/Ctrl + , -- Open settings
    if (mod && e.key === ",") {
      e.preventDefault();
      settings.open();
      return;
    }

    // Cmd/Ctrl + / -- Toggle shortcut help
    if (mod && e.key === "/") {
      e.preventDefault();
      if (shortcutBackdrop.classList.contains("open")) {
        closeShortcutHelp();
      } else {
        openShortcutHelp();
      }
      return;
    }

    // Escape -- close shortcut help overlay
    if (e.key === "Escape" && shortcutBackdrop.classList.contains("open")) {
      closeShortcutHelp();
      return;
    }

    // Don't capture G/M/J if user is typing in a text input
    if (isTextInputFocused()) return;

    // Cmd/Ctrl + G -- Toggle goals panel
    if (mod && e.key.toLowerCase() === "g") {
      e.preventDefault();
      if (goalsPanel.classList.contains("open")) {
        goals.close();
      } else {
        goals.open();
      }
      return;
    }

    // Cmd/Ctrl + M -- Toggle memory panel
    if (mod && e.key.toLowerCase() === "m") {
      e.preventDefault();
      if (memoryPanel.classList.contains("open")) {
        memory.close();
      } else {
        memory.open();
      }
      return;
    }

    // Cmd/Ctrl + J -- Toggle conversations panel
    if (mod && e.key.toLowerCase() === "j") {
      e.preventDefault();
      if (conversationsPanel.classList.contains("open")) {
        conversations.close();
      } else {
        conversations.open();
      }
      return;
    }
  });

  // === Focus Trapping for Modals ===

  // Trap focus in settings modal
  document.addEventListener("keydown", (e) => {
    if (settingsModal.classList.contains("open") && !settings.isPinDialogOpen()) {
      trapFocus(settingsModal, e);
    }
  });

  // Trap focus in PIN dialog
  document.addEventListener("keydown", (e) => {
    if (settings.isPinDialogOpen()) {
      trapFocus(pinDialog, e);
    }
  });

  // Trap focus in pairing dialog
  const pairingBackdrop = document.getElementById("pairing-backdrop") as HTMLDivElement;
  document.addEventListener("keydown", (e) => {
    if (pairingBackdrop.classList.contains("open")) {
      trapFocus(pairingDialog, e);
    }
  });

  // Trap focus in welcome dialog
  const welcomeBackdrop = document.getElementById("welcome-backdrop") as HTMLDivElement;
  document.addEventListener("keydown", (e) => {
    if (welcomeBackdrop.classList.contains("open")) {
      trapFocus(welcomeDialog, e);
    }
  });

  // Trap focus in shortcut help
  document.addEventListener("keydown", (e) => {
    if (shortcutBackdrop.classList.contains("open")) {
      trapFocus(shortcutDialog, e);
    }
  });
}
