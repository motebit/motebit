/**
 * Tamper checks for "a runtime that can verify a standing grant meters it
 * durably": the `motebit run` / `motebit serve` daemons set
 * `identityPublicKeyHex` but passed no `grantSpendStore`, so the money meter
 * fell back to the in-memory store and the grant's lifetime ceiling re-armed
 * on every restart. Each entry re-opens one door and must turn its test red.
 *
 *   - the shared builder drops the store: the behavioural test (a real
 *     MoteDb, a real MotebitRuntime, a restart) goes red;
 *   - each daemon site reverted to its pre-fix shape, and the REPL site
 *     dropping its store: check-money-authority assertion 7 goes red.
 *
 *   node scripts/tampers/daemon-grant-spend-store.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON = "apps/cli/src/daemon.ts";
const FACTORY = "apps/cli/src/runtime-factory.ts";

const GATE: Pick<TamperEntry, "command" | "redMarker"> = {
  command: ["npx", "tsx", "scripts/check-money-authority.ts"],
  redMarker: "but pass no `grantSpendStore`",
};

const STORE_ARG =
  "      relay,\n" +
  "      // The persistent spend store: the meter's ceilings survive a restart.\n" +
  "      moteDb.grantSpendStore,\n" +
  "    ),";

/** Revert one daemon site to `cliRuntimeConfig(...)` with no store (main's shape). */
function revertSite(head: string, identityLine: string): TamperEntry["edits"] {
  return [
    {
      file: DAEMON,
      from: `    daemonRuntimeConfig(\n${head}`,
      to: `    cliRuntimeConfig(\n${head}`,
    },
    {
      file: DAEMON,
      from: `${identityLine}\n          : {}),\n      },\n${STORE_ARG}`,
      to: `${identityLine}\n          : {}),\n      },\n      relay,\n    ),`,
    },
  ];
}

const TAMPERS: TamperEntry[] = [
  {
    name: "daemonRuntimeConfig drops the store (runtime falls back to in-memory)",
    edits: [
      {
        file: DAEMON,
        from: "  return cliRuntimeConfig({ ...base, grantSpendStore }, relay);",
        to: "  return cliRuntimeConfig({ ...base }, relay);",
      },
    ],
    pkg: "motebit",
    test: "src/__tests__/daemon-grant-spend-store.test.ts",
    red: "daemon runtime: the grant spend store is persistent a daemon restart does not re-arm the grant's lifetime ceiling",
  },
  {
    name: "`motebit run` site back to main's shape (identity key, no store)",
    edits: revertSite(
      "      {\n        motebitId,\n        mcpServers,\n        policy: {\n          operatorMode: config.operator,\n          maxRiskLevel: maxRiskAuto,",
      "          ? { identityPublicKeyHex: fullConfig.device_public_key }",
    ),
    ...GATE,
  },
  {
    name: "`motebit serve` site back to main's shape (identity key, no store)",
    edits: revertSite(
      "      {\n        motebitId,\n        mcpServers,\n        policy: {\n          operatorMode: config.operator,\n          pathAllowList: config.allowedPaths,",
      "          ? { identityPublicKeyHex: publicKeyHex }",
    ),
    ...GATE,
  },
  {
    name: "REPL runtime drops its store",
    edits: [
      {
        file: FACTORY,
        from: "        grantSpendStore: moteDb.grantSpendStore,\n",
        to: "",
      },
    ],
    ...GATE,
  },
];

void runTampers(TAMPERS, { root: ROOT });
