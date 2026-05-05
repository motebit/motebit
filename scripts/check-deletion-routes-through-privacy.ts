/**
 * Deletion-routes-through-privacy check.
 *
 * Sovereignty doctrine: the user owns their data. Every user-driven
 * deletion of memory or conversation MUST exit through the privacy
 * layer's choke point (`runtime.privacy.deleteMemory`,
 * `runtime.privacy.deleteConversation`, or the runtime's
 * `deleteConversation` wrapper which delegates to the same), so the
 * action is signed (mutable_pruning / consolidation_flush cert),
 * audited, and event-logged with `DeleteRequested`.
 *
 * Pre-gate, web and mobile bypassed the privacy layer:
 * `runtime.memory.deleteMemory(nodeId)` returned silently, no cert,
 * no audit. Desktop got it right; the asymmetry made
 * "deletion is sovereign" architecturally true on one surface and
 * aspirational on two. See docs/doctrine/retention-policy.md
 * §"Decision 5" (signing authority by reason×mode) and the audit
 * findings the gate locks.
 *
 * ── Scope ─────────────────────────────────────────────────────────
 *
 * Scanned: every `.ts` / `.tsx` under `apps/<app>/src/` and
 * `packages/<pkg>/src/` excluding tests, dist, build artifacts, and the
 * canonical implementation sites (privacy-layer itself, the runtime's
 * conversation manager, persistence adapters that legitimately
 * IMPLEMENT the storage methods being routed AROUND elsewhere).
 *
 * Forbidden patterns (case-sensitive, single regex per pattern):
 *
 *   `<receiver>.memory.deleteMemory(` — direct storage delete that
 *   bypasses the privacy layer's signed-cert path. The choke point
 *   is `<receiver>.privacy.deleteMemory(...)`.
 *
 *   `<receiver>.eraseMessage(` outside the consolidation cycle and
 *   privacy layer — single-row erase is a privacy-layer-only
 *   primitive paired with `signFlushCert`.
 *
 * Exit 1 on violation. Runs alongside other drift gates in
 * `pnpm check`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SCAN_ROOTS = [resolve(ROOT, "apps"), resolve(ROOT, "packages")];

// Files that legitimately implement the storage-side deletion (they
// are the implementation behind the privacy-layer choke point) or that
// own the privacy-layer + flush-cycle choke points themselves. Scoped
// by suffix match — these names are unambiguous in the repo.
const ALLOW_FILE_SUFFIXES: ReadonlyArray<string> = [
  // Storage adapter implementations of `deleteConversation` /
  // `eraseMessage` — these are the bytes the privacy layer drives.
  "/packages/persistence/src/index.ts",
  "/packages/browser-persistence/src/conversation-store.ts",
  "/apps/desktop/src/tauri-storage.ts",
  "/apps/mobile/src/adapters/expo-sqlite.ts",
  // Privacy-layer itself — the choke point.
  "/packages/privacy-layer/src/index.ts",
  // Runtime conversation manager — orchestrates load/reset state, no
  // longer touches the storage delete (post-fix it only clears
  // in-memory history when the active conversation was erased).
  "/packages/runtime/src/conversation.ts",
  // Consolidation cycle's flush phase — auto-flush calls eraseMessage
  // after signing per-record certs. Same choke pattern, retention-
  // driven instead of user-driven.
  "/packages/runtime/src/consolidation-cycle.ts",
];

// Subpath fragments that exclude a file outright (tests, dist, etc).
const EXCLUDE_SUBPATHS: ReadonlyArray<string> = [
  "/__tests__/",
  "/dist/",
  "/coverage/",
  "/node_modules/",
  "/etc/",
  ".test.ts",
  ".test.tsx",
  ".d.ts",
];

interface Violation {
  file: string;
  line: number;
  match: string;
  detail: string;
}

const PATTERNS: ReadonlyArray<{ regex: RegExp; detail: string }> = [
  {
    regex: /\.memory\.deleteMemory\s*\(/,
    detail:
      'user-driven memory delete bypasses the privacy layer — replace with `<receiver>.privacy.deleteMemory(nodeId, "user_request")` so the action is signed, audited, and event-logged',
  },
  {
    regex: /\.eraseMessage\s*\(/,
    detail:
      "single-row erase is a privacy-layer / consolidation-cycle primitive — drive it through `runtime.privacy.deleteConversation` or the flush phase, never inline",
  },
];

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
      out.push(...walkTypeScript(path));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push(path);
    }
  }
  return out;
}

function isAllowed(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  if (EXCLUDE_SUBPATHS.some((s) => norm.includes(s))) return true;
  if (ALLOW_FILE_SUFFIXES.some((s) => norm.endsWith(s))) return true;
  return false;
}

function scanFile(file: string): Violation[] {
  const src = readFileSync(file, "utf-8");
  const violations: Violation[] = [];
  const shortPath = relative(ROOT, file);
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip comment-only lines so doctrine prose doesn't trip the gate.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    for (const { regex, detail } of PATTERNS) {
      const m = regex.exec(line);
      if (m !== null) {
        violations.push({ file: shortPath, line: i + 1, match: m[0], detail });
      }
    }
  }
  return violations;
}

function main(): void {
  const all: Violation[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walkTypeScript(root)) {
      if (isAllowed(file)) continue;
      all.push(...scanFile(file));
    }
  }
  if (all.length === 0) {
    console.log(
      "Deletion-routing check passed — every user-driven memory/conversation delete exits through `runtime.privacy.*`.",
    );
    return;
  }
  console.error(`Deletion-routing violations (${all.length}):\n`);
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}  ${v.match}`);
    console.error(`    ${v.detail}\n`);
  }
  process.exit(1);
}

main();
