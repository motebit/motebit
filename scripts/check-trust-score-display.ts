/**
 * Hardware-attestation surface-display gate (invariant #64).
 *
 * Self-attesting-system doctrine
 * (`docs/doctrine/self-attesting-system.md`): every routing-input claim
 * the runtime computes against MUST be visible to the user. Hardware
 * attestation factors into peer ranking through
 * `HardwareAttestationSemiring`
 * (`packages/semiring/src/hardware-attestation.ts`); the Agents-panel
 * badge is the user-facing surface for that input.
 *
 * Ship 1 (`756a38c3`) added the panel-controller types and helpers
 * (`AgentHardwareAttestation`, `formatHardwarePlatform`,
 * `scoreHardwareAttestation`). Ship 2 (`c8c6312d`) lit up the data
 * flow — runtime `listTrustedAgents` and relay `/api/v1/agents/discover`
 * project the latest verified claim onto records. Ship 3 closes the loop
 * by rendering the badge on every surface; this gate locks that
 * rendering in.
 *
 * ── Rule ─────────────────────────────────────────────────────────────
 *
 * Every registered Agents-panel renderer file MUST:
 *
 *   1. Reference the field name `hardware_attestation` (proves the
 *      renderer reads the projected claim, not just the trust badge),
 *      AND
 *   2. Import `formatHardwarePlatform` from `@motebit/panels` (proves
 *      the renderer surfaces the verifier name — the canonical
 *      doctrine-completeness probe per `ha_surface_badge_agents_panel_gap`
 *      project memory: "why did motebit prefer that peer").
 *
 * Both conditions must hold. A renderer that reads
 * `hardware_attestation` but skips `formatHardwarePlatform` is a partial
 * surface — the user can see the field exists but can't see WHICH
 * verifier attested it. A renderer that imports
 * `formatHardwarePlatform` but never references the field is dead
 * import; the gate would miss it but lint catches it.
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
  }
  return violations;
}

function main(): void {
  const violations = check();
  if (violations.length === 0) {
    console.log(
      `✓ check-trust-score-display: every Agents-panel renderer (${RENDERERS.map((r) => r.surface).join(", ")}) reads \`hardware_attestation\` and surfaces the verifier name via \`formatHardwarePlatform\`.\n`,
    );
    return;
  }
  console.error(
    `\n✗ check-trust-score-display: ${violations.length} renderer(s) miss the hardware-attestation surface contract.\n\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.surface} (${v.path}):`);
    console.error(`    ${v.reason}\n`);
  }
  console.error(
    "Per `docs/doctrine/self-attesting-system.md`: every routing-input claim MUST be visible to the user. The Agents-panel badge is the surface for hardware attestation; a renderer that reads the field without surfacing the verifier (or that skips the field entirely) leaves a doctrine breach where the runtime ranks peers on data the user can't see.\n",
  );
  process.exit(1);
}

main();
