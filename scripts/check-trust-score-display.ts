/**
 * Routing-input surface-display gate (invariant #64).
 *
 * Self-attesting-system doctrine
 * (`docs/doctrine/self-attesting-system.md`): every routing-input the
 * runtime computes against MUST be visible to the user. Two inputs
 * factor into peer ranking today and the Agents-panel renderer is the
 * surface for both:
 *
 *   - **Hardware attestation** — `HardwareAttestationSemiring`
 *     (`packages/semiring/src/hardware-attestation.ts`) scores peers
 *     on their attestation platform. Ship 1 (`756a38c3`) added the
 *     panel-controller types/helpers; ship 2 (`c8c6312d`) lit up the
 *     runtime + relay data flow; ship 3 added per-surface render and
 *     this gate.
 *   - **Observed latency** — `agent-graph.ts` weights routing on the
 *     local `LatencyStatsStore`'s avg_ms (default 3000ms when stats
 *     are absent). The latency arm of this gate landed 2026-04-30
 *     after the same five-step pattern: protocol/panels types →
 *     runtime projection → relay enricher → per-surface render → gate
 *     extension.
 *
 * ── Rule ─────────────────────────────────────────────────────────────
 *
 * Every registered Agents-panel renderer file MUST:
 *
 *   1. Reference the field name `hardware_attestation` (proves the
 *      renderer reads the projected HA claim), AND
 *   2. Import `formatHardwarePlatform` from `@motebit/panels` (proves
 *      the renderer surfaces the verifier name — "why did motebit
 *      prefer that peer"), AND
 *   3. Reference the field name `latency_stats` (proves the renderer
 *      reads the observed-latency snapshot), AND
 *   4. Import `formatLatency` from `@motebit/panels` (proves the
 *      renderer surfaces the avg/p95 readout — same probe as
 *      `formatHardwarePlatform`: a routing input the user sees the
 *      shape of, not just its existence).
 *
 * All four conditions must hold. A renderer that reads a field but
 * skips its formatter is a partial surface — the user can see the
 * field exists but can't see the value in the form the runtime ranks
 * against. A renderer that imports a formatter but never references
 * the field is dead import; the gate would miss it but lint catches it.
 *
 * ── Scope ────────────────────────────────────────────────────────────
 *
 * The renderer registry is exhaustive — three surfaces, three files.
 * Adding a fourth surface (a fourth motebit-canonical Agents UI) means
 * adding a fourth entry to RENDERERS. Spatial / inspector / operator
 * are intentionally excluded today: spatial has no panels (per
 * `apps/spatial/CLAUDE.md`), inspector reads relay state but doesn't
 * embody the user's motebit, operator is the relay-operator console
 * not the agent panel.
 *
 * Test files and renderers behind feature flags don't enter scope —
 * the gate inspects committed renderer source only.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface Renderer {
  surface: string;
  path: string;
}

const RENDERERS: ReadonlyArray<Renderer> = [
  { surface: "desktop", path: "apps/desktop/src/ui/agents.ts" },
  { surface: "web", path: "apps/web/src/ui/gated-panels.ts" },
  { surface: "mobile", path: "apps/mobile/src/components/AgentsPanel.tsx" },
];

interface Violation {
  surface: string;
  path: string;
  reason: string;
}

function check(): Violation[] {
  const violations: Violation[] = [];
  for (const r of RENDERERS) {
    const abs = resolve(ROOT, r.path);
    if (!existsSync(abs)) {
      violations.push({ surface: r.surface, path: r.path, reason: "file missing" });
      continue;
    }
    const src = readFileSync(abs, "utf-8");
    if (!src.includes("hardware_attestation")) {
      violations.push({
        surface: r.surface,
        path: r.path,
        reason:
          "no `hardware_attestation` reference — renderer doesn't read the projected HA claim",
      });
    }
    if (!/\bformatHardwarePlatform\b/.test(src)) {
      violations.push({
        surface: r.surface,
        path: r.path,
        reason:
          "no `formatHardwarePlatform` import/use — renderer doesn't surface the verifier name",
      });
    }
    if (!src.includes("latency_stats")) {
      violations.push({
        surface: r.surface,
        path: r.path,
        reason:
          "no `latency_stats` reference — renderer doesn't read the projected observed-latency snapshot",
      });
    }
    if (!/\bformatLatency\b/.test(src)) {
      violations.push({
        surface: r.surface,
        path: r.path,
        reason: "no `formatLatency` import/use — renderer doesn't surface the avg/p95 readout",
      });
    }
  }
  return violations;
}

function main(): void {
  const violations = check();
  if (violations.length === 0) {
    console.log(
      `✓ check-trust-score-display: every Agents-panel renderer (${RENDERERS.map((r) => r.surface).join(", ")}) reads \`hardware_attestation\` + \`latency_stats\` and surfaces them via \`formatHardwarePlatform\` + \`formatLatency\`.\n`,
    );
    return;
  }
  console.error(
    `\n✗ check-trust-score-display: ${violations.length} routing-input surface contract violation(s).\n\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.surface} (${v.path}):`);
    console.error(`    ${v.reason}\n`);
  }
  console.error(
    "Per `docs/doctrine/self-attesting-system.md`: every routing-input the runtime computes against MUST be visible to the user. The Agents-panel renderer is the surface for HA + latency; a renderer that reads a field without surfacing its formatted value (or that skips the field entirely) leaves a doctrine breach where the runtime ranks peers on data the user can't see.\n",
  );
  process.exit(1);
}

main();
