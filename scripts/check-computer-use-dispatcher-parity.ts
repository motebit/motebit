/**
 * `check-computer-use-dispatcher-parity` — every `ComputerActionKind`
 * declared in `@motebit/protocol::computer-use` MUST be handled by
 * BOTH `ComputerPlatformDispatcher` producers:
 *
 *   - desktop Tauri Rust:    `apps/desktop/src-tauri/src/computer_use.rs`
 *   - cloud Playwright:      `services/browser-sandbox/src/action-executor.ts`
 *
 * Why this gate exists. Two dispatchers implementing the same wire
 * format is the v1 architecture (`spec/computer-use-v1.md` §8.1 +
 * `docs/doctrine/motebit-computer.md` v1-status paragraph). The
 * symmetry is load-bearing — a desktop-only kind silently breaking
 * on web, or a cloud-only kind silently failing on desktop, would
 * fragment the audit trail at the format boundary. The protocol
 * type union prevents the compiler from missing a kind in TS, but
 * the Rust dispatcher is outside the TS type system and the
 * Playwright executor's `default: never` arm only fires at runtime —
 * neither catches the case where one producer adds a kind the other
 * forgot.
 *
 * What this gate enforces.
 *   - Discovery: parse the action interfaces in
 *     `packages/protocol/src/computer-use.ts` (everything before
 *     `export type ComputerAction`) for `readonly kind: "<name>"`.
 *     The set is the universe.
 *   - Coverage A (Rust): parse the `match action_kind {}` block in
 *     `computer_use.rs` for `"<name>" =>` arms.
 *   - Coverage B (TS): parse the `executeAction` switch in
 *     `services/browser-sandbox/src/action-executor.ts` for
 *     `case "<name>":` arms.
 *   - Match: every kind in the universe must appear in BOTH coverages
 *     OR have an explicit `ALLOWLIST` entry naming why it's pending.
 *
 * Allowlist is empty at landing (both producers cover all 9 v1 kinds:
 * screenshot, cursor_position, click, double_click, mouse_move, drag,
 * type, key, scroll). Future kinds added to the protocol enter via
 * the desktop Tauri Rust + cloud Playwright in the same PR, or with
 * an allowlist entry naming the missing producer + reason.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PROTOCOL_FILE = "packages/protocol/src/computer-use.ts";
const RUST_FILE = "apps/desktop/src-tauri/src/computer_use.rs";
const TS_FILE = "services/browser-sandbox/src/action-executor.ts";

/**
 * Allowlist entries: a kind whose absence from one producer is
 * deliberate. Each entry MUST name the missing producer and a
 * `deferred until X` reason. Empty at landing.
 *
 * Shape: `{ kind, missingFrom: "rust" | "ts", reason }`. A kind
 * absent from both producers can't be allowlisted — that means the
 * protocol declared a kind nobody implements, which is the failure
 * mode this gate prevents.
 */
const ALLOWLIST: ReadonlyArray<{
  readonly kind: string;
  readonly missingFrom: "rust" | "ts";
  readonly reason: string;
}> = [];

interface ParseResult {
  readonly kinds: ReadonlySet<string>;
  readonly count: number;
}

function readFile(relative: string): string {
  const full = resolve(ROOT, relative);
  if (!existsSync(full)) {
    throw new Error(`check-computer-use-dispatcher-parity: missing file ${relative}`);
  }
  return readFileSync(full, "utf8");
}

/**
 * Parse `readonly kind: "<name>"` declarations from the protocol
 * file, but only those before `export type ComputerAction = ...` —
 * action kinds, not observation kinds (which reuse the same names
 * but live below the type union declaration).
 */
function parseProtocolKinds(): ParseResult {
  const source = readFile(PROTOCOL_FILE);
  const cutoffMatch = /export\s+type\s+ComputerAction\s*=/.exec(source);
  if (cutoffMatch === null) {
    throw new Error(
      `check-computer-use-dispatcher-parity: could not locate \`export type ComputerAction\` in ${PROTOCOL_FILE} — the protocol file shape changed`,
    );
  }
  const actionSection = source.slice(0, cutoffMatch.index);
  const kinds = new Set<string>();
  const re = /readonly\s+kind\s*:\s*"([a-z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(actionSection)) !== null) {
    kinds.add(m[1]!);
  }
  return { kinds, count: kinds.size };
}

/**
 * Parse `"<name>" =>` match arms from the Rust dispatcher's
 * `computer_execute` function. Only arms inside that function's
 * `match` block, not arbitrary `"name"` strings elsewhere in the
 * file.
 */
function parseRustKinds(): ParseResult {
  const source = readFile(RUST_FILE);
  const fnMatch = /fn\s+computer_execute\s*\([^)]*\)[^{]*\{/.exec(source);
  if (fnMatch === null) {
    throw new Error(
      `check-computer-use-dispatcher-parity: could not locate \`fn computer_execute\` in ${RUST_FILE}`,
    );
  }
  // Walk braces from after the fn signature to find the matching closer.
  const start = fnMatch.index + fnMatch[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  const fnBody = source.slice(start, i - 1);
  const kinds = new Set<string>();
  const re = /"([a-z_]+)"\s*=>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnBody)) !== null) {
    kinds.add(m[1]!);
  }
  return { kinds, count: kinds.size };
}

/**
 * Parse `case "<name>":` arms from the TS executor's `executeAction`
 * switch only — not from helper switches elsewhere in the file
 * (`translateModifier` has `case "cmd": return "Meta"` arms that
 * would over-match if the regex weren't scoped). Walks braces from
 * the `executeAction` signature to find the matching closer.
 */
function parseTsKinds(): ParseResult {
  const source = readFile(TS_FILE);
  const fnMatch = /export\s+async\s+function\s+executeAction\s*\([^)]*\)[^{]*\{/.exec(source);
  if (fnMatch === null) {
    throw new Error(
      `check-computer-use-dispatcher-parity: could not locate \`export async function executeAction\` in ${TS_FILE}`,
    );
  }
  // Walk braces from after the fn signature to find the matching closer.
  const start = fnMatch.index + fnMatch[0].length;
  let depth = 1;
  let i = start;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  const fnBody = source.slice(start, i - 1);
  const kinds = new Set<string>();
  const re = /case\s+"([a-z_]+)"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fnBody)) !== null) {
    kinds.add(m[1]!);
  }
  return { kinds, count: kinds.size };
}

function main(): void {
  const protocol = parseProtocolKinds();
  const rust = parseRustKinds();
  const ts = parseTsKinds();

  if (protocol.count === 0) {
    console.error(
      `check-computer-use-dispatcher-parity: parsed 0 action kinds from ${PROTOCOL_FILE} — extraction regex needs an update`,
    );
    process.exit(1);
  }

  const missing: Array<{ kind: string; missingFrom: "rust" | "ts" }> = [];
  for (const kind of protocol.kinds) {
    if (!rust.kinds.has(kind)) missing.push({ kind, missingFrom: "rust" });
    if (!ts.kinds.has(kind)) missing.push({ kind, missingFrom: "ts" });
  }

  // Apply allowlist — entries with matching {kind, missingFrom} are tolerated.
  const allowed = new Set(ALLOWLIST.map((e) => `${e.kind}::${e.missingFrom}`));
  const remaining = missing.filter((m) => !allowed.has(`${m.kind}::${m.missingFrom}`));

  // Stale-allowlist detection: an allowlisted entry whose producer
  // now covers the kind. Eat it down — visible debt becomes invisible.
  const stale: Array<{ kind: string; missingFrom: "rust" | "ts" }> = [];
  for (const entry of ALLOWLIST) {
    const producer = entry.missingFrom === "rust" ? rust.kinds : ts.kinds;
    if (producer.has(entry.kind)) {
      stale.push({ kind: entry.kind, missingFrom: entry.missingFrom });
    }
  }

  // Symmetric inverse: a kind handled by a producer but not declared
  // in the protocol (orphan action). Means the producer is exposing
  // an off-spec kind — the audit trail is fractured at the format
  // boundary in a way the protocol doesn't ratify.
  const orphans: Array<{ kind: string; in: "rust" | "ts" }> = [];
  for (const kind of rust.kinds) {
    if (!protocol.kinds.has(kind)) orphans.push({ kind, in: "rust" });
  }
  for (const kind of ts.kinds) {
    if (!protocol.kinds.has(kind)) orphans.push({ kind, in: "ts" });
  }

  if (remaining.length === 0 && stale.length === 0 && orphans.length === 0) {
    console.log(
      `check-computer-use-dispatcher-parity: ${protocol.count} action kinds, both dispatchers in parity`,
    );
    return;
  }

  if (remaining.length > 0) {
    console.error(
      `check-computer-use-dispatcher-parity: ${remaining.length} kind(s) missing from a dispatcher:`,
    );
    for (const m of remaining) {
      console.error(`  - ${m.kind} not handled in ${m.missingFrom} dispatcher`);
    }
  }

  if (stale.length > 0) {
    console.error(
      `check-computer-use-dispatcher-parity: ${stale.length} stale ALLOWLIST entry/entries — the producer now covers the kind, remove the entry:`,
    );
    for (const m of stale) {
      console.error(`  - ${m.kind} (allowlisted as missing-from-${m.missingFrom}) is now handled`);
    }
  }

  if (orphans.length > 0) {
    console.error(
      `check-computer-use-dispatcher-parity: ${orphans.length} orphan kind(s) — handled by a dispatcher but not declared in @motebit/protocol:`,
    );
    for (const o of orphans) {
      console.error(`  - "${o.kind}" handled in ${o.in} but absent from ${PROTOCOL_FILE}`);
    }
  }

  process.exit(1);
}

main();
