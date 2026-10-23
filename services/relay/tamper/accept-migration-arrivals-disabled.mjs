#!/usr/bin/env node
/**
 * Tamper checks for the P0 containment of `POST /api/v1/agents/accept-migration`
 * (migration.ts `MIGRATION_ARRIVALS_ENABLED`). Each entry is (file, text to
 * revert, test expected red), run by the shared runner
 * (scripts/lib/tamper-runner.ts) in an isolated copy of the tree:
 *
 *   - the gate flipped back on — the takeover reproductions (forged guardian
 *     with an ordinary token, retired genesis, revocation lifted) must go red;
 *   - the gate removed outright — the same;
 *   - the gate moved after body parsing — the "refuses before body parsing"
 *     case (no body / malformed JSON) must go red.
 *
 * Exit 1 if any tamper stays green or cannot apply.
 *
 *   node services/relay/tamper/accept-migration-arrivals-disabled.mjs [--concurrency=N]
 */
import { resolve } from "node:path";
import { runTampers } from "../../../scripts/lib/tamper-runner.ts";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../..");
const MIG = "services/relay/src/migration.ts";
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
    "src/__tests__/accept-migration-arrivals-disabled.test.ts",
  ],
  redMarker: "Test Files  1 failed",
};

const GATE =
  "    if (!MIGRATION_ARRIVALS_ENABLED) {\n" +
  '      logger.warn("migration.accept.disabled");\n' +
  "      return c.json({ error: MIGRATION_ARRIVALS_DISABLED_MESSAGE }, 503);\n" +
  "    }\n";
const BODY_PARSE = "    const body = await c.req.json<{";

const TAMPERS = [
  {
    name: "the gate flipped back on (arrivals enabled)",
    edits: [
      {
        file: MIG,
        from: "const MIGRATION_ARRIVALS_ENABLED: boolean = false;",
        to: "const MIGRATION_ARRIVALS_ENABLED: boolean = true;",
      },
    ],
    ...CONTAINMENT,
  },
  {
    name: "the gate removed from the handler",
    edits: [{ file: MIG, from: GATE, to: "    void MIGRATION_ARRIVALS_DISABLED_MESSAGE;\n" }],
    ...CONTAINMENT,
  },
  {
    name: "the gate moved after body parsing",
    edits: [
      { file: MIG, from: GATE + BODY_PARSE, to: BODY_PARSE },
      {
        file: MIG,
        from: "    // The id arrival writes a registry row and a key record under (#814) —",
        to: GATE + "    // The id arrival writes a registry row and a key record under (#814) —",
      },
    ],
    ...CONTAINMENT,
  },
];

await runTampers(TAMPERS, { root: ROOT });
