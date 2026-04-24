import { defineMotebitTest } from "../../vitest.shared.js";

// Desktop is a Tauri app (Rust runtime + WebView frontend). After the
// DesktopApp kernel decomposition (T1-T8, index.ts 3,814 → 1,386) the
// logic lives in 8 sibling modules which are all unit-testable in node:
//
//   goal-scheduler, sync-controller, mcp-manager, identity-manager,
//   conversation-manager, renderer-commands, memory-commands,
//   tauri-system-adapters.
//
// Each is exercised via its own test file under src/__tests__/. The
// coverage floor reflects the honest post-extraction measurement:
// sibling modules individually at 70-100% (memory-commands 100%,
// renderer-commands 100%, tauri-system-adapters 100%, conversation-manager
// 99%, identity-manager 93%, mcp-manager 77%, sync-controller 70%,
// goal-scheduler 57%). The aggregate is pulled down by index.ts (the
// 1,386-line orchestrator that wires Tauri APIs) and tauri-storage.ts
// (the big SQL-IPC adapter).
export default defineMotebitTest({
  testExclude: ["**/src-tauri/**"],
  coverageExclude: [
    // Tauri's release-build codegen writes compiled asset artifacts into
    // src-tauri/target/**; v8 coverage tries to read their source maps
    // and crashes when it hits codegen outputs. They're not source —
    // exclude the whole directory from coverage collection.
    "**/src-tauri/**",
    // DOM entry point: references `document.getElementById`, binds the
    // canvas, initializes every UI module. Cannot run outside a browser
    // without wholesale jsdom + Tauri shims, which would be test-fiction.
    "src/main.ts",
    // All src/ui/*.ts DOM modules bind to document/window/HTMLElement and
    // drive click handlers, canvas, modal flows. They are genuinely
    // browser-coupled — running them in node would require full jsdom
    // plus @tauri-apps/api shims across 5,000+ lines of UI glue. The
    // three pure ones (slash-commands.ts, keyring-keys.ts, audit-utils.ts)
    // are tested directly; everything else is platform surface.
    "src/ui/agents.ts",
    "src/ui/chat.ts",
    "src/ui/color-picker.ts",
    "src/ui/config.ts",
    "src/ui/conversations.ts",
    "src/ui/focus.ts",
    "src/ui/goals.ts",
    "src/ui/keyboard.ts",
    "src/ui/memory.ts",
    "src/ui/pairing.ts",
    "src/ui/settings.ts",
    "src/ui/sovereign.ts",
    "src/ui/theme.ts",
    "src/ui/voice.ts",
  ],
  thresholds: { statements: 67, branches: 83, functions: 62, lines: 67 },
});
