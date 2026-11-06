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
 *     dropping its store, passing `grantSpendStore: undefined`, or naming it
 *     only in a string, the serve site reverted behind a `const MR =
 *     MotebitRuntime` alias, an opaque `...NO_STORE` spread after the store,
 *     a store on one conditional branch only, and a local same-named
 *     `cliRuntimeConfig` that drops the store: check-money-authority
 *     assertion 7 goes red;
 *   - the daemon builder deciding `syncConfigured` itself (ignoring the
 *     intent relay, #962 round 5): the behavioural case and the AST guard in
 *     cli-sync-configured-962.test.ts each go red.
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
  redMarker: "assertion 7:",
};

const RUN_HEAD =
  "      {\n        motebitId,\n        mcpServers,\n        policy: {\n          operatorMode: config.operator,\n          maxRiskLevel: maxRiskAuto,";
const SERVE_HEAD =
  "      {\n        motebitId,\n        mcpServers,\n        policy: {\n          operatorMode: config.operator,\n          pathAllowList: config.allowedPaths,";
const SERVE_IDENTITY = "          ? { identityPublicKeyHex: publicKeyHex }";
const SITE_OPEN =
  "  const runtime = new MotebitRuntime(\n" +
  "    // #962: `syncConfigured` is decided by `cliRuntimeConfig`, last.\n";

const STORE_ARG =
  "      relay,\n" +
  "      // The persistent spend store: the meter's ceilings survive a restart.\n" +
  "      { grantSpendStore: moteDb.grantSpendStore },\n" +
  "    ),";

const BUILDER_RETURN =
  "  return cliRuntimeConfig({ ...base, grantSpendStore: durable.grantSpendStore }, relay);";
const SELF_DECIDED =
  "  return {\n" +
  "    ...base,\n" +
  "    grantSpendStore: durable.grantSpendStore,\n" +
  '    syncConfigured: relay.syncUrl != null && relay.syncUrl !== "",\n' +
  "  };";
const REPL_STORE = "        grantSpendStore: moteDb.grantSpendStore,\n";

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
        from: BUILDER_RETURN,
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
      RUN_HEAD,
      "          ? { identityPublicKeyHex: fullConfig.device_public_key }",
    ),
    ...GATE,
  },
  {
    name: "`motebit serve` site back to main's shape (identity key, no store)",
    edits: revertSite(SERVE_HEAD, SERVE_IDENTITY),
    ...GATE,
  },
  {
    name: "`motebit serve` site back to main's shape, constructed through `const MR = MotebitRuntime`",
    edits: [
      {
        file: DAEMON,
        from: `${SITE_OPEN}    daemonRuntimeConfig(\n${SERVE_HEAD}`,
        to:
          "  const MR = MotebitRuntime;\n" +
          `${SITE_OPEN.replace("new MotebitRuntime(", "new MR(")}    cliRuntimeConfig(\n${SERVE_HEAD}`,
      },
      revertSite(SERVE_HEAD, SERVE_IDENTITY)[1]!,
    ],
    ...GATE,
  },
  {
    name: "REPL spreads an opaque `...NO_STORE` after its store",
    edits: [
      {
        file: FACTORY,
        from: 'import { cliRuntimeConfig } from "./sync-configured.js";\n',
        to:
          'import { cliRuntimeConfig } from "./sync-configured.js";\n' +
          "const NO_STORE: { grantSpendStore?: undefined } = {};\n",
      },
      { file: FACTORY, from: REPL_STORE, to: `${REPL_STORE}        ...NO_STORE,\n` },
    ],
    ...GATE,
  },
  {
    name: "REPL builds through a local same-named `cliRuntimeConfig` that drops the store",
    edits: [
      {
        file: FACTORY,
        from: 'import { cliRuntimeConfig } from "./sync-configured.js";\n',
        to:
          "function cliRuntimeConfig(\n" +
          '  base: Omit<import("@motebit/runtime").RuntimeConfig, "syncConfigured">,\n' +
          "  relay: { syncUrl: string | undefined; intentUrl?: string | undefined },\n" +
          '): import("@motebit/runtime").RuntimeConfig {\n' +
          "  const { grantSpendStore: _dropped, ...rest } = base;\n" +
          "  return { ...rest, syncConfigured: relay.syncUrl != null };\n" +
          "}\n",
      },
    ],
    ...GATE,
  },
  {
    name: "REPL passes its store on one conditional branch only",
    edits: [
      {
        file: FACTORY,
        from: REPL_STORE,
        to: '        ...(process.env["MOTEBIT_TAMPER"] ? { grantSpendStore: moteDb.grantSpendStore } : {}),\n',
      },
    ],
    ...GATE,
  },
  {
    name: "REPL runtime drops its store",
    edits: [
      {
        file: FACTORY,
        from: REPL_STORE,
        to: "",
      },
    ],
    ...GATE,
  },
  {
    name: "REPL passes `grantSpendStore: undefined` (the word, no store)",
    edits: [
      {
        file: FACTORY,
        from: REPL_STORE,
        to: "        grantSpendStore: undefined,\n",
      },
    ],
    ...GATE,
  },
  {
    name: "REPL drops its store and mentions it only in a string",
    edits: [
      { file: FACTORY, from: REPL_STORE, to: "" },
      {
        file: FACTORY,
        from: "        motebitId,\n        mcpServers,\n        // Renderer-aware logger",
        to: '        motebitId: motebitId || "grantSpendStore",\n        mcpServers,\n        // Renderer-aware logger',
      },
    ],
    ...GATE,
  },
  // #962: the daemon builder deciding syncConfigured itself (ignoring the
  // intent relay) instead of returning cliRuntimeConfig(...).
  {
    name: "daemonRuntimeConfig decides syncConfigured itself (behaviour: intent-only relay)",
    edits: [{ file: DAEMON, from: BUILDER_RETURN, to: SELF_DECIDED }],
    pkg: "motebit",
    test: "src/__tests__/cli-sync-configured-962.test.ts",
    red: "#962 C2 — the CLI's syncConfigured wiring daemonRuntimeConfig is cliRuntimeConfig: the relay decides syncConfigured, last",
  },
  {
    name: "daemonRuntimeConfig decides syncConfigured itself (AST guard)",
    edits: [{ file: DAEMON, from: BUILDER_RETURN, to: SELF_DECIDED }],
    pkg: "motebit",
    test: "src/__tests__/cli-sync-configured-962.test.ts",
    red: "#962 C2 — the CLI's syncConfigured wiring every `new MotebitRuntime(` in apps/cli/src builds its config with cliRuntimeConfig",
  },
];

void runTampers(TAMPERS, { root: ROOT });
