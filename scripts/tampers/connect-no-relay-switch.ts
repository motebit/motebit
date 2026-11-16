/**
 * Tamper checks for "`/connect` does not change relay in a running session and
 * never sends an operator token" (apps/cli/src/slash-commands.ts: the
 * `connect` case and `operatorTokenSource`). Each entry re-opens one door and
 * must turn its test red:
 *
 *   - the refusal for a session already on ANOTHER relay removed (the command
 *     runs the full connect again: registers with B, saves B);
 *   - startup no longer binding the runtime to its relay (both enable calls in
 *     the key-open branch of `startReplRelay` removed: either one alone still
 *     binds), so the runtime reports no relay and `/connect B` runs;
 *   - `/connect <the session's own relay>` falling through to the full connect;
 *   - the operator-token refusal removed;
 *   - each of the three token sources dropped from the shared helper;
 *   - the runtime's `getDelegationRelay()` always reporting null (the CLI
 *     tests load `@motebit/runtime` through its build output, so these entries
 *     rebuild it).
 *
 * `apps/cli/src/repl-relay.ts` is a tamper TARGET here; the fix does not edit it.
 *
 *   node_modules/.bin/tsx scripts/tampers/connect-no-relay-switch.ts
 *   (plain `node` cannot resolve the runner's `.js` import specifier)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SLASH = "apps/cli/src/slash-commands.ts";
const REPL_RELAY = "apps/cli/src/repl-relay.ts";
const RUNTIME = "packages/runtime/src/motebit-runtime.ts";
const PKG = "motebit";
const TEST = "src/__tests__/connect-no-relay-switch.test.ts";

const BOUND = "/connect in a session already on a relay: nothing sent, nothing changed";
const TOKEN = "/connect never sends an operator token";
const FIRST = "/connect in a session with no relay and no operator token";

const FROM_CONFIG = `${BOUND} bound to A from the saved config, /connect B: refused with R1`;
const FROM_FLAG = `${BOUND} bound to A from --sync-url, /connect B: refused with R1`;
const FROM_ENV = `${BOUND} bound to A from MOTEBIT_SYNC_URL, /connect B: refused with R1`;
const SAME_RELAY = `${BOUND} bound to A, /connect A and /connect A/: the already-on-A line, nothing sent to A, nothing changed`;
const BOUND_WITH_TOKEN = `${BOUND} bound to A with an operator token set, /connect B: R1, not R2 (the session's relay is checked first)`;
const TOKEN_FLAG = `${TOKEN} no relay, operator token from --sync-token: /connect X sends nothing and prints R2`;
const TOKEN_API = `${TOKEN} no relay, operator token from MOTEBIT_API_TOKEN: /connect X sends nothing and prints R2`;
const TOKEN_SYNC = `${TOKEN} no relay, operator token from MOTEBIT_SYNC_TOKEN (MOTEBIT_API_TOKEN unset): /connect X sends nothing and prints R2`;
const THEN_REFUSED = `${FIRST} /connect A succeeds on a 409 bootstrap with device-signed requests only; then /connect B is refused with R1`;

function entry(name: string, edits: TamperEdit[], red: string, rebuild?: string[]): TamperEntry {
  return { name, edits, pkg: PKG, test: TEST, red, ...(rebuild ? { rebuild } : {}) };
}

// Row 3: a session on A, another relay named.
const ROW_3: TamperEdit[] = [
  {
    file: SLASH,
    from: "      if (bound !== null) {\n",
    to: "      if (bound !== null && false) {\n",
  },
];
// Row 2 falls through to the full connect: its own branch is skipped, and the
// row-3 refusal no longer catches the session's own relay.
const ROW_2_FALLS_THROUGH: TamperEdit[] = [
  { file: SLASH, from: "      if (sameRelay) {\n", to: "      if (sameRelay && false) {\n" },
  {
    file: SLASH,
    from: "      if (bound !== null) {\n",
    to: "      if (bound !== null && !sameRelay) {\n",
  },
];
// Row 4: no relay yet, an operator token set.
const ROW_4: TamperEdit[] = [
  {
    file: SLASH,
    from: '      if (operatorToken !== undefined && operatorToken.value !== "") {\n',
    to: '      if (operatorToken !== undefined && operatorToken.value !== "" && false) {\n',
  },
];
// The bare enable calls occur twice in repl-relay.ts; the preceding line
// anchors this edit to the key-open branch.
const STARTUP_BINDS_NOTHING: TamperEdit[] = [
  {
    file: REPL_RELAY,
    from:
      "    const delegationCfg = { ...shared, authToken };\n" +
      "    runtime.enableInteractiveDelegation(delegationCfg);\n" +
      "    runtime.enableInvokeCapability(delegationCfg);\n",
    to: "    const delegationCfg = { ...shared, authToken };\n",
  },
];
const GETTER_NULL: TamperEdit[] = [
  {
    file: RUNTIME,
    from: "    return coords === null ? null : { url: coords.syncUrl };\n",
    to: "    return coords === null ? null : null;\n",
  },
];
const dropSource = (line: string): TamperEdit[] => [{ file: SLASH, from: line, to: "" }];

const TAMPERS: TamperEntry[] = [
  // ── row 3: the refusal for another relay ──
  entry("the another-relay refusal is removed (A from the saved config)", ROW_3, FROM_CONFIG),
  entry("the another-relay refusal is removed (A from --sync-url)", ROW_3, FROM_FLAG),
  entry("the another-relay refusal is removed (A from MOTEBIT_SYNC_URL)", ROW_3, FROM_ENV),
  entry(
    "the another-relay refusal is removed (operator token set: R2 is printed, not R1)",
    ROW_3,
    BOUND_WITH_TOKEN,
  ),
  entry("the another-relay refusal is removed (A from a first /connect)", ROW_3, THEN_REFUSED),
  // ── the startup binding rule 1 depends on ──
  entry(
    "startup binds the runtime to no relay (A from the saved config)",
    STARTUP_BINDS_NOTHING,
    FROM_CONFIG,
  ),
  entry(
    "startup binds the runtime to no relay (A from --sync-url)",
    STARTUP_BINDS_NOTHING,
    FROM_FLAG,
  ),
  entry(
    "startup binds the runtime to no relay (A from MOTEBIT_SYNC_URL)",
    STARTUP_BINDS_NOTHING,
    FROM_ENV,
  ),
  // ── row 2: the session's own relay ──
  entry(
    "/connect <the session's own relay> falls through to the full connect",
    ROW_2_FALLS_THROUGH,
    SAME_RELAY,
  ),
  // ── row 4 and the token sources ──
  entry("the operator-token refusal is removed", ROW_4, TOKEN_FLAG),
  entry(
    "--sync-token is dropped from the token-source helper",
    dropSource('    ["--sync-token", config.syncToken],\n'),
    TOKEN_FLAG,
  ),
  entry(
    "MOTEBIT_API_TOKEN is dropped from the token-source helper",
    dropSource('    ["MOTEBIT_API_TOKEN", process.env["MOTEBIT_API_TOKEN"]],\n'),
    TOKEN_API,
  ),
  entry(
    "MOTEBIT_SYNC_TOKEN is dropped from the token-source helper",
    dropSource('    ["MOTEBIT_SYNC_TOKEN", process.env["MOTEBIT_SYNC_TOKEN"]],\n'),
    TOKEN_SYNC,
  ),
  // ── the runtime getter, through the build output the CLI loads ──
  entry(
    "getDelegationRelay always reports null (A from the saved config)",
    GETTER_NULL,
    FROM_CONFIG,
    ["@motebit/runtime"],
  ),
  entry("getDelegationRelay always reports null (A from --sync-url)", GETTER_NULL, FROM_FLAG, [
    "@motebit/runtime",
  ]),
  entry("getDelegationRelay always reports null (A from MOTEBIT_SYNC_URL)", GETTER_NULL, FROM_ENV, [
    "@motebit/runtime",
  ]),
  entry("getDelegationRelay always reports null (/connect <own relay>)", GETTER_NULL, SAME_RELAY, [
    "@motebit/runtime",
  ]),
];

void runTampers(TAMPERS, { root: ROOT });
