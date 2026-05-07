/**
 * Drop-handlers drift gate.
 *
 * Enforces two arms of the drag-drop substrate landed alongside
 * `motebit-computer.md` §"Perception input — drop kinds and handlers":
 *
 *   1. **Coverage** — every entry in the `DropPayloadKind` closed
 *      union (in `packages/protocol/src/perception.ts`) MUST be
 *      either registered in `DropDispatcher`'s constructor (in
 *      `packages/runtime/src/perception.ts`) OR named on the
 *      `ALLOWLIST` below with a deferral reason. Same shape as the
 *      `check-mode-contract-readers` allowlist pattern (#76):
 *      visible debt that future PRs eat down.
 *
 *   2. **Routing** — every per-surface file that captures DOM
 *      drag-drop (or React Native PanResponder drop) MUST route
 *      through `runtime.feedPerception(payload)`. Surface drop
 *      handlers MUST NOT construct a prompt string and call
 *      `sendMessage` / `sendMessageStreaming` — that's the
 *      "prompt-backdoor gesture" failure mode named in the doctrine.
 *      Extends `surface-determinism.md` to drag-drop.
 *
 * Same load-bearing shape as the other agility-as-role gates
 * (#12 suite-dispatch, #36 tool-modes, #76 mode-contract-readers):
 * closure on the protocol surface + drift gate that asks role
 * questions, not instance questions.
 *
 * Exit 1 on any violation. Runs in `pnpm check`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PERCEPTION_PROTOCOL_PATH = resolve(ROOT, "packages/protocol/src/perception.ts");
const PERCEPTION_RUNTIME_PATH = resolve(ROOT, "packages/runtime/src/perception.ts");

interface AllowlistEntry {
  kind: string;
  reason: string;
}

/**
 * Drop kinds that ship in the closed union but intentionally do NOT
 * have a v1 handler. Each entry names the consumer it's waiting on.
 *
 *   - `file` — file-format proliferation is unbounded. Ships when a
 *     concrete handler-extension consumer (PDF reader, code-file
 *     viewer, audio player) drives the within-kind handler-registry
 *     extension surface.
 *   - `artifact` — motebit-to-motebit drag depends on multi-motebit
 *     UX which isn't yet shipped (no second motebit on the same
 *     surface to drag from).
 */
const ALLOWLIST: ReadonlyArray<AllowlistEntry> = [
  {
    kind: "file",
    reason:
      "deferred until a concrete file-handler consumer drives the within-kind extension surface (PDF reader, code-file viewer, audio player) — file-format proliferation is unbounded so v1 keeps the substrate without committing handler-shape choices",
  },
  {
    kind: "artifact",
    reason:
      "deferred until multi-motebit UX ships — there is no second motebit on the user's surface today to drag a signed artifact from, so the handler has no consumer driver",
  },
];

// ── Coverage arm ────────────────────────────────────────────────────

function extractDropPayloadKinds(): string[] {
  const src = readFileSync(PERCEPTION_PROTOCOL_PATH, "utf8");
  const m = src.match(/export\s+type\s+DropPayloadKind\s*=([^;]+);/);
  if (m === null) {
    throw new Error(
      `check-drop-handlers: could not locate \`export type DropPayloadKind\` union in ${PERCEPTION_PROTOCOL_PATH}`,
    );
  }
  // Parse the union body — pick out every "literal" between quotes.
  const literalRe = /"([a-z][a-z0-9-]*)"/g;
  const kinds: string[] = [];
  let lit: RegExpExecArray | null;
  while ((lit = literalRe.exec(m[1]!)) !== null) {
    kinds.push(lit[1]!);
  }
  if (kinds.length === 0) {
    throw new Error(
      "check-drop-handlers: parsed DropPayloadKind body but found no string literals — extraction regex needs an update",
    );
  }
  return kinds;
}

function findRegisteredHandlers(): Set<string> {
  const src = readFileSync(PERCEPTION_RUNTIME_PATH, "utf8");
  // Strip block + line comments so a comment naming a kind doesn't count.
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const registered = new Set<string>();
  // The dispatcher's constructor calls `this.registerHandler("kind", handler)`.
  const re = /registerHandler\s*\(\s*"([a-z][a-z0-9-]*)"\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    registered.add(m[1]!);
  }
  return registered;
}

function checkCoverage(): string[] {
  const violations: string[] = [];
  const kinds = extractDropPayloadKinds();
  const registered = findRegisteredHandlers();
  const allowlisted = new Set(ALLOWLIST.map((e) => e.kind));

  for (const kind of kinds) {
    const isRegistered = registered.has(kind);
    const isAllowlisted = allowlisted.has(kind);
    if (!isRegistered && !isAllowlisted) {
      violations.push(
        `DropPayloadKind \`${kind}\` has no handler registered in DropDispatcher AND is not on ALLOWLIST — either register a handler in packages/runtime/src/perception.ts or add an ALLOWLIST entry naming the deferred consumer`,
      );
    }
    if (isRegistered && isAllowlisted) {
      violations.push(
        `DropPayloadKind \`${kind}\` is BOTH on ALLOWLIST AND has a registered handler — entry is stale, remove from ALLOWLIST`,
      );
    }
  }

  // Reverse direction: an allowlisted kind that's no longer in the union
  // means the entry is stale.
  for (const entry of ALLOWLIST) {
    if (!kinds.includes(entry.kind)) {
      violations.push(
        `ALLOWLIST entry for \`${entry.kind}\` does not match any DropPayloadKind union member — entry is stale, remove`,
      );
    }
  }
  return violations;
}

// ── Routing arm ─────────────────────────────────────────────────────

const SURFACE_ROOTS = ["apps/web/src", "apps/desktop/src", "apps/mobile/src", "apps/spatial/src"];

const DRAG_EVENT_PATTERNS: RegExp[] = [
  // DOM-level drop event handlers
  /\bdocument\.addEventListener\s*\(\s*['"](drop|dragover|dragenter|dragleave)['"]/g,
  /\bwindow\.addEventListener\s*\(\s*['"](drop|dragover|dragenter|dragleave)['"]/g,
  /\bon\s*=\s*['"]drop['"]/g,
  // DataTransfer reads
  /\bdataTransfer\.(?:getData|files|items)\b/g,
  // React Native gesture-handler drop callbacks (future mobile)
  /\bonDragEnd\b|\bonDrop\b/g,
];

const ROUTING_PATTERN = /\bfeedPerception\s*\(/g;

interface SurfaceFile {
  path: string;
  source: string;
  stripped: string;
}

function walkSurfaceFiles(): SurfaceFile[] {
  const out: SurfaceFile[] = [];
  for (const root of SURFACE_ROOTS) {
    const dir = join(ROOT, root);
    if (!existsSync(dir)) continue;
    walk(dir, out);
  }
  return out;
}

function walk(dir: string, out: SurfaceFile[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "coverage" ||
      entry === "__tests__"
    )
      continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(full, out);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".generated.ts")
    ) {
      const source = readFileSync(full, "utf8");
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      out.push({ path: full, source, stripped });
    }
  }
}

function fileHasDragHandler(stripped: string): boolean {
  return DRAG_EVENT_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(stripped);
  });
}

function fileRoutesThroughFeedPerception(stripped: string): boolean {
  ROUTING_PATTERN.lastIndex = 0;
  return ROUTING_PATTERN.test(stripped);
}

function checkRouting(): string[] {
  const violations: string[] = [];
  const files = walkSurfaceFiles();
  for (const file of files) {
    if (!fileHasDragHandler(file.stripped)) continue;
    if (!fileRoutesThroughFeedPerception(file.stripped)) {
      violations.push(
        `${relative(ROOT, file.path)} — captures drag-drop events but does not call \`runtime.feedPerception(...)\`. Surface drop handlers MUST route through the canonical typed input. Constructing a prompt string and calling sendMessage is the prompt-backdoor failure mode named in motebit-computer.md.`,
      );
    }
  }
  return violations;
}

// ── Main ────────────────────────────────────────────────────────────

function main(): void {
  if (!existsSync(PERCEPTION_PROTOCOL_PATH)) {
    console.error(
      `✗ check-drop-handlers: protocol perception file missing: ${PERCEPTION_PROTOCOL_PATH}`,
    );
    process.exit(1);
  }
  if (!existsSync(PERCEPTION_RUNTIME_PATH)) {
    console.error(
      `✗ check-drop-handlers: runtime perception file missing: ${PERCEPTION_RUNTIME_PATH}`,
    );
    process.exit(1);
  }

  const violations = [...checkCoverage(), ...checkRouting()];

  if (violations.length === 0) {
    const kinds = extractDropPayloadKinds();
    const handlers = findRegisteredHandlers();
    const allowlisted = ALLOWLIST.map((e) => e.kind);
    console.log(
      `✓ check-drop-handlers: every DropPayloadKind is either registered or allowlisted, and every per-surface drag handler routes through runtime.feedPerception. ` +
        `Kinds: ${kinds.length} (${handlers.size} handler(s), ${allowlisted.length} allowlisted [${allowlisted.join(", ")}]).\n`,
    );
    return;
  }

  console.error(`\n✗ check-drop-handlers: ${violations.length} violation(s).\n`);
  for (const v of violations) {
    console.error(`  ${v}\n`);
  }
  console.error(
    'Doctrine reference: docs/doctrine/motebit-computer.md §"Supervised agency / minimum gesture set" + §"Failure modes specific to supervised agency" (prompt-backdoor gestures).\n',
  );
  process.exit(1);
}

main();
