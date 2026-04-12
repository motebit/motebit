import { defineMotebitTest } from "../../vitest.shared.js";

// Floor thresholds anchored to the actual baseline at first measurement
// (lines 16.31%, branches 76.23%, functions 45.04%). This establishes
// the first enforceable floor for a surface that previously had
// `test:coverage` silently not running with --coverage at all.
//
// The DesktopApp kernel decomposition (T1-T8, index.ts 3,814 → 1,386)
// moved logic into 8 purpose-built sibling modules (goal-scheduler,
// sync-controller, mcp-manager, identity-manager, conversation-manager,
// renderer-commands, memory-commands, tauri-system-adapters). These are
// now directly testable — raise these thresholds as each gains tests.
export default defineMotebitTest({
  testExclude: ["**/src-tauri/**"],
  // Tauri's release-build codegen writes compiled asset artifacts into
  // src-tauri/target/**; v8 coverage tries to read their source maps
  // and crashes when it hits codegen outputs. They're not source —
  // exclude the whole directory from coverage collection.
  coverageExclude: ["**/src-tauri/**"],
  thresholds: { statements: 16, branches: 75, functions: 45, lines: 16 },
});
