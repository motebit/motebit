#!/usr/bin/env tsx
/**
 * check-loops-supervised — every relay background loop reports to the
 * LoopSupervisor.
 *
 * `setInterval` does NOT die on a thrown callback, so a relay background
 * loop can fail invisibly in three ways: a tick that throws/rejects every
 * cycle, a tick that hangs forever, or a loop never started because a
 * config branch was false. `superviseInterval` (services/relay/src/
 * loop-supervisor.ts) makes all three observable at
 * GET /api/v1/admin/health (`loops`). Phase 1 (2026-06-10) supervised the
 * four money-MOVEMENT loops; Phase 2 (2026-06-11) adopted the remaining
 * anchoring / reconciliation / federation / cleanup loops. This gate locks
 * the end state: a NEW raw `setInterval(` call in services/relay/src is a
 * regression to the pre-supervisor invisible-failure shape.
 *
 * The anchoring loops are why this is load-bearing and not hygiene: they
 * produce the on-chain roots behind the `anchored` identity-binding rung
 * and the operator-transparency declaration. A silently wedged anchor loop
 * quietly stops the relay EARNING those rungs — the same failure class as
 * the 2026-05-22 prod incident where every receipt silently degraded to
 * integrity-only.
 *
 * ## Detection
 *
 *   1. Walk `services/relay/src/**\/*.ts`, excluding `__tests__/`.
 *   2. Flag every `setInterval(` CALL (the `ReturnType<typeof setInterval>`
 *      type position is not a call and is not flagged) outside
 *      `loop-supervisor.ts` (the owner — the only file allowed to call it).
 *   3. Two narrow allowlisted shapes, matched by exact anchor:
 *      a. `deposit-detector.ts` disabled-path no-op handle
 *         (`setInterval(() => {}, 2_147_483_647)`) — returned so
 *         `clearInterval` stays a safe call when the chain has no USDC
 *         contract/RPC; registering a permanently-disabled loop with the
 *         supervisor would show `stale` forever (false alarm by design).
 *      b. `index.ts` WS-drain grace waiter (`const check = setInterval(`)
 *         — a bounded 250ms poll inside `close()` that self-clears when
 *         connections drain; it is shutdown choreography, not a
 *         background loop, and registering it would leave a dead `stale`
 *         entry after every drain.
 *   4. Exit 1 on any other raw call.
 *
 * Static text parse — no execution. Doctrine: `services/relay/CLAUDE.md`
 * rule 18.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const RELAY_SRC = resolve(REPO_ROOT, "services", "relay", "src");

/** Files allowed to contain raw setInterval calls, with the exact anchors. */
const ALLOWLIST: ReadonlyArray<{ file: string; anchor: string; reason: string }> = [
  {
    file: "loop-supervisor.ts",
    anchor: "", // the owner — every call allowed
    reason: "superviseInterval owns the canonical setInterval",
  },
  {
    file: "deposit-detector.ts",
    anchor: "return setInterval(() => {}, 2_147_483_647);",
    reason: "disabled-path no-op handle so clearInterval stays safe",
  },
  {
    file: "index.ts",
    anchor: "const check = setInterval(",
    reason: "bounded WS-drain grace waiter inside close(); self-clearing, not a loop",
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function main(): void {
  const violations: string[] = [];

  for (const file of walk(RELAY_SRC)) {
    const rel = relative(REPO_ROOT, file);
    const base = rel.split("/").pop()!;
    const src = readFileSync(file, "utf-8");

    const ownerEntry = ALLOWLIST.find((a) => a.file === base && a.anchor === "");
    if (ownerEntry) continue;

    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Call sites only — `ReturnType<typeof setInterval>` is a type position.
      if (!/(?<!typeof )setInterval\s*\(/.test(line)) continue;
      const allowed = ALLOWLIST.some(
        (a) => a.file === base && a.anchor !== "" && line.includes(a.anchor),
      );
      if (allowed) continue;
      violations.push(
        `${rel}:${i + 1} — raw setInterval() call. Relay background loops must go through ` +
          `superviseInterval (services/relay/src/loop-supervisor.ts) so tick liveness/errors ` +
          `surface at GET /api/v1/admin/health. If this is genuinely not a background loop ` +
          `(a bounded waiter, a no-op handle), add a narrowly-anchored ALLOWLIST entry in ` +
          `scripts/check-loops-supervised.ts with the reason.`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(`Loops-supervised violations (${violations.length}):\n`);
    for (const v of violations) console.error(`  ${v}\n`);
    console.error(
      "Doctrine: services/relay/CLAUDE.md rule 18 — background loops are supervised; " +
        "raw setInterval regressions reintroduce invisible loop failure.",
    );
    process.exit(1);
  }

  console.log(
    "Loops supervised — every relay setInterval call is superviseInterval-owned or narrowly allowlisted",
  );
}

main();
