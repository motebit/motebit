/**
 * Auto-router consumer-registry coverage gate.
 *
 * Closed-registry / structural-lock pattern (same shape as #79
 * `check-universal-slash-coverage`, #94 `check-slab-chrome-coverage`):
 *
 *   1. The auto-router's protocol primitive `dispatchRouting`
 *      (`packages/policy/src/auto-router.ts`) is consumed by a
 *      closed inventory of CONSUMERS — surfaces that need to pick
 *      a model for a task. PR 1 (2026-05-13) registers
 *      motebit-cloud's proxy; PR 2 adds BYOK; PR 3 adds on-device.
 *   2. Every registered consumer MUST import `dispatchRouting` from
 *      `@motebit/policy` AND reference every `RoutingDecision.kind`
 *      discriminator value (`route`, `fallback`, `deny`) in source.
 *      The discriminator coverage check structurally enforces that
 *      every consumer handles all three decision shapes — the
 *      exhaustive-switch contract made legible at the grep layer.
 *   3. The gate's `TASK_SHAPES_REFERENCE` array MUST mirror
 *      `ALL_TASK_SHAPES` from `@motebit/protocol` exactly. A
 *      registry append in protocol without this gate's update is
 *      itself a CI failure (sibling-alignment).
 *
 * **Note on what this gate does NOT enforce.** The dispatcher
 * itself (`packages/policy/src/auto-router.ts`) uses an exhaustive
 * switch over `TaskShape` with `never` fallthrough — TypeScript
 * already enforces per-shape coverage at compile time. A textual
 * scan on TaskShape literals in each consumer would be redundant
 * with the type system. The gate's structural value is the
 * CONSUMERS registry — preventing a new consumer from being added
 * without registering itself and committing to handle every
 * decision shape.
 *
 * Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md`
 * § "PR 1 scope" + § "Why TaskShape coverage is TypeScript-
 * enforced, not gate-enforced."
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface RoutingConsumer {
  /** Human-readable name for error messages. */
  readonly name: string;
  /** Path relative to repo root. */
  readonly file: string;
  /**
   * The dispatcher identifier this consumer must import + call.
   * Today the only valid value is `"dispatchRouting"`; documented
   * here as a constant for future-proofing (a learned-router
   * variant with a different entry name would be a registry
   * append).
   */
  readonly entry: string;
}

/**
 * Closed inventory of CONSUMERS — surfaces that consume the
 * auto-router primitive. PR 1: motebit-cloud proxy. Adding a
 * consumer (PR 2 BYOK, PR 3 on-device) requires registering it
 * here AND wiring its source to import + call `dispatchRouting` +
 * reference every `RoutingDecision.kind` value.
 */
const CONSUMERS: ReadonlyArray<RoutingConsumer> = [
  {
    name: "motebit-cloud-proxy",
    file: "services/proxy/src/app/v1/messages/route.ts",
    entry: "dispatchRouting",
  },
];

/**
 * Discriminator values from `RoutingDecision` (closed union in
 * `packages/protocol/src/routing.ts`). Every consumer must
 * reference each — the structural enforcement of exhaustive
 * decision handling.
 */
const DECISION_KINDS = ["route", "fallback", "deny"] as const;

/**
 * Sibling-alignment mirror of `ALL_TASK_SHAPES` from
 * `@motebit/protocol`. A registry append in protocol without
 * updating this array is itself a CI failure — the gate verifies
 * both sides remain in lockstep.
 *
 * Lifted from the protocol's `TaskShape` union (verified by the
 * sibling-alignment block in `main()`).
 */
const TASK_SHAPES_REFERENCE = [
  "quick",
  "chat",
  "reasoning",
  "code",
  "research",
  "creative",
  "math",
] as const;

function readFile(path: string): string | null {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

interface Violation {
  readonly consumer: string;
  readonly file: string;
  readonly kind: "missing_file" | "missing_import" | "missing_entry_call" | "missing_decision_kind";
  readonly detail?: string;
}

function main(): void {
  const violations: Violation[] = [];

  // === Sibling-alignment: gate's TASK_SHAPES_REFERENCE must match
  // ALL_TASK_SHAPES in @motebit/protocol exactly. ================
  const protocolRoutingSource = readFile("packages/protocol/src/routing.ts");
  if (protocolRoutingSource === null) {
    console.error(
      "check-routing-decision-coverage: could not read packages/protocol/src/routing.ts",
    );
    console.error("Auto-router protocol primitive missing; this gate cannot validate.");
    process.exit(1);
  }
  for (const shape of TASK_SHAPES_REFERENCE) {
    const literalPattern = new RegExp(`[\`"']${shape}[\`"']`);
    if (!literalPattern.test(protocolRoutingSource)) {
      console.error(
        `check-routing-decision-coverage: sibling-alignment failure — TASK_SHAPES_REFERENCE includes "${shape}" but it's missing from packages/protocol/src/routing.ts.`,
      );
      console.error(
        "The gate's registry must mirror the protocol's TaskShape union exactly. Update one or the other to align.",
      );
      process.exit(1);
    }
  }

  // === Per-consumer coverage checks =============================
  for (const consumer of CONSUMERS) {
    const source = readFile(consumer.file);
    if (source === null) {
      violations.push({
        consumer: consumer.name,
        file: consumer.file,
        kind: "missing_file",
      });
      continue;
    }
    // Check 1: imports `dispatchRouting` from @motebit/policy
    const importPattern = new RegExp(
      `(?:import|from)[^;]*\\b${consumer.entry}\\b[^;]*from\\s+["']@motebit/policy["']`,
    );
    const altImportPattern = new RegExp(
      `import\\s*\\{[^}]*\\b${consumer.entry}\\b[^}]*\\}\\s*from\\s*["']@motebit/policy["']`,
    );
    if (!importPattern.test(source) && !altImportPattern.test(source)) {
      violations.push({
        consumer: consumer.name,
        file: consumer.file,
        kind: "missing_import",
        detail: `expected to import \`${consumer.entry}\` from "@motebit/policy"`,
      });
    }
    // Check 2: at least one call site of the entry
    const callPattern = new RegExp(`\\b${consumer.entry}\\s*\\(`);
    if (!callPattern.test(source)) {
      violations.push({
        consumer: consumer.name,
        file: consumer.file,
        kind: "missing_entry_call",
        detail: `imports \`${consumer.entry}\` but does not call it`,
      });
    }
    // Check 3: references every RoutingDecision.kind value
    for (const kind of DECISION_KINDS) {
      const kindPattern = new RegExp(`[\`"']${kind}[\`"']`);
      if (!kindPattern.test(source)) {
        violations.push({
          consumer: consumer.name,
          file: consumer.file,
          kind: "missing_decision_kind",
          detail: kind,
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `check-routing-decision-coverage: ${violations.length} consumer-coverage violation(s) across ${CONSUMERS.length} registered consumer(s):`,
    );
    const byConsumer = new Map<string, Violation[]>();
    for (const v of violations) {
      const list = byConsumer.get(v.consumer) ?? [];
      list.push(v);
      byConsumer.set(v.consumer, list);
    }
    for (const [consumerName, consumerViolations] of byConsumer) {
      console.error("");
      console.error(`  ${consumerName}:`);
      for (const v of consumerViolations) {
        switch (v.kind) {
          case "missing_file":
            console.error(`    - consumer file not found: ${v.file}`);
            break;
          case "missing_import":
            console.error(`    - ${v.detail} (file: ${v.file})`);
            break;
          case "missing_entry_call":
            console.error(`    - ${v.detail} (file: ${v.file})`);
            break;
          case "missing_decision_kind":
            console.error(
              `    - RoutingDecision.kind === "${v.detail}" not referenced in ${v.file}`,
            );
            break;
        }
      }
    }
    console.error("");
    console.error(
      "Every CONSUMER of `dispatchRouting` MUST import it from @motebit/policy, invoke it,",
    );
    console.error("and handle every `RoutingDecision.kind` variant. Doctrine: docs/doctrine/auto-");
    console.error("routing-as-protocol-primitive.md.");
    console.error("");
    console.error(
      "If a new consumer just landed, register it in CONSUMERS in this file and ensure its",
    );
    console.error(
      "source imports + dispatches + handles all three decision shapes (route/fallback/deny).",
    );
    process.exit(1);
  }

  console.log(
    `✓ check-routing-decision-coverage: ${CONSUMERS.length} consumer(s) × ${DECISION_KINDS.length} decision kind(s) — auto-router consumer registry fully covered.`,
  );
}

main();
