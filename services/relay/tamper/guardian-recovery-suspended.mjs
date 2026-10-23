#!/usr/bin/env node
/**
 * Tamper checks for the P0 containment of guardian recovery
 * (`guardian-recovery-containment.ts`, `GUARDIAN_RECOVERY_ENABLED`). Each entry
 * is (file, text to revert, test expected red), run by the shared runner
 * (scripts/lib/tamper-runner.ts) in an isolated copy of the tree:
 *
 *   - the switch flipped back on — the probe's takeovers (S1/S2/S4) must go red;
 *   - the `/rotate-key` gate removed — the takeovers must go red (the writer
 *     backstop still answers 503, but the refusal is not recorded and the
 *     guardian is read first);
 *   - the `/agents/register` gate removed — the register-door case must go red;
 *   - the `applySuccession` backstop removed — the writer case must go red;
 *   - a recovery recognised only as `recovery === true` (not the verifier's
 *     truthiness) — the truthy-recovery cases must go red.
 *
 * Exit 1 if any tamper stays green or cannot apply.
 *
 *   node services/relay/tamper/guardian-recovery-suspended.mjs [--concurrency=N]
 */
import { resolve } from "node:path";
import { runTampers } from "../../../scripts/lib/tamper-runner.ts";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");
const GATE = "services/relay/src/guardian-recovery-containment.ts";
const ROTATE = "services/relay/src/key-rotation.ts";
const AGENTS = "services/relay/src/agents.ts";
const APPLY = "services/relay/src/succession-apply.ts";
// Run as a command with a red marker, not as a vitest entry: the repo's vitest
// config pins the JSON reporter's outputFile (see federation-recipient-binding.mjs).
const CONTAINMENT = {
  command: [
    "pnpm",
    "--filter",
    "@motebit/relay",
    "exec",
    "vitest",
    "run",
    "src/__tests__/guardian-recovery-suspended.test.ts",
  ],
  redMarker: "Test Files  1 failed",
};

const TAMPERS = [
  {
    name: "the switch flipped back on (guardian recovery enabled)",
    edits: [
      {
        file: GATE,
        from: "export const GUARDIAN_RECOVERY_ENABLED: boolean = false;",
        to: "export const GUARDIAN_RECOVERY_ENABLED: boolean = true;",
      },
    ],
    ...CONTAINMENT,
  },
  {
    name: "the /rotate-key gate removed",
    edits: [
      {
        file: ROTATE,
        from:
          "    if (guardianRecoverySuspended(body)) {\n" +
          "      recordRefusal(GUARDIAN_RECOVERY_SUSPENDED_REASON);\n" +
          "      throw new GuardianRecoverySuspendedError();\n" +
          "    }\n",
        to: "    void guardianRecoverySuspended;\n    void GUARDIAN_RECOVERY_SUSPENDED_REASON;\n",
      },
    ],
    ...CONTAINMENT,
  },
  {
    name: "the /agents/register gate removed",
    edits: [
      {
        file: AGENTS,
        from: "    if (guardianRecoverySuspended((body as Record<string, unknown> | null)?.succession)) {",
        to: "    if (false as boolean) {",
      },
    ],
    ...CONTAINMENT,
  },
  {
    name: "the applySuccession backstop removed",
    edits: [
      {
        file: APPLY,
        from: "  if (guardianRecoverySuspended(record)) throw new GuardianRecoverySuspendedError();\n",
        to: "  void guardianRecoverySuspended;\n  void GuardianRecoverySuspendedError;\n",
      },
    ],
    ...CONTAINMENT,
  },
  {
    name: "a recovery recognised only as `recovery === true`",
    edits: [
      {
        file: GATE,
        from: "    Boolean((record as { recovery?: unknown }).recovery)",
        to: "    (record as { recovery?: unknown }).recovery === true",
      },
    ],
    ...CONTAINMENT,
  },
];

await runTampers(TAMPERS, { root: ROOT });
