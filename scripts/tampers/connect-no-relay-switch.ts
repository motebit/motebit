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
 *   - the identity-key check moved below the relay and token checks;
 *   - either half of that check (the signing key, the device id) dropped by
 *     itself, in a session on no relay;
 *   - the relay comparison loosened (case-insensitive, or a prefix match);
 *   - a relay URL printed without `sanitizeRelayText`;
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

const NO_KEY = `${BOUND} bound to A with an operator token set and no open identity key, /connect B: the no-signing-keys error, not R1 or R2`;
const NO_DEVICE_ID = `${FIRST} a signing key and no device id: /connect X sends nothing, changes nothing, and prints the no-signing-keys error`;
const NO_SIGNING_KEY = `${FIRST} a device id and no signing key: /connect X sends nothing, changes nothing, and prints the no-signing-keys error`;
const UPPER_SCHEME = `${BOUND} bound to A, /connect with A's scheme in upper case: a different spelling is a different relay, refused with R1, nothing sent`;
const EXTRA_SEGMENT = `${BOUND} bound to A, /connect A/x: an extra path segment is a different relay, refused with R1, nothing sent`;
const CLEAN_ALREADY = `${BOUND} the already-on line prints the session's relay without an escape sequence or a zero-width character`;
const CLEAN_R1 = `${BOUND} R1 prints the session's relay and the named relay without an escape sequence or a zero-width character`;
const CLEAN_R2 = `${TOKEN} R2 prints the named relay without an escape sequence or a zero-width character`;

function entry(name: string, edits: TamperEdit[], red: string, rebuild?: string[]): TamperEntry {
  return { name, edits, pkg: PKG, test: TEST, red, ...(rebuild ? { rebuild } : {}) };
}

// Row 3: a session on A, another relay named.
const ROW_3: TamperEdit[] = [
  {
    file: SLASH,
    from: "      if (bound !== null) {\n",
    to: "      if (bound !== null && (false as boolean)) {\n",
  },
];
// Row 2 falls through to the full connect: its own branch is skipped, and the
// row-3 refusal no longer catches the session's own relay.
const ROW_2_FALLS_THROUGH: TamperEdit[] = [
  {
    file: SLASH,
    from: "      if (sameRelay) {\n",
    to: "      if (sameRelay && (false as boolean)) {\n",
  },
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
    to: '      if (operatorToken !== undefined && operatorToken.value !== "" && (false as boolean)) {\n',
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
// Row 1 (the key check) moved from before the relay and token checks to after
// them. The same check occurs in another command; the comment that follows it
// anchors the removal to `/connect`.
const KEY_CHECK =
  "      if (!repl?.privateKeyBytes || !repl?.deviceId) {\n" +
  '        console.log("Error: no signing keys available — cannot authenticate with relay.");\n' +
  "        break;\n" +
  "      }\n";
const AFTER_KEY_CHECK =
  "\n      // The relay this session's runtime is bound to (startup wiring, or an\n";
const CONNECTING = "\n      console.log(dim(`Connecting to ${connectUrl}...`));\n";
const KEY_CHECK_LAST: TamperEdit[] = [
  { file: SLASH, from: KEY_CHECK + AFTER_KEY_CHECK, to: AFTER_KEY_CHECK },
  { file: SLASH, from: CONNECTING, to: "\n" + KEY_CHECK + CONNECTING },
];
// Each half of the key check dropped by itself, in a session on no relay. The
// dropped half becomes a type guard that always holds: a plain removal leaves
// `repl.deviceId` / `repl.privateKeyBytes` possibly undefined further down and
// does not type-check. The line occurs in another command too; the line after
// it anchors the edit to `/connect`.
const KEY_CHECK_HEAD = "      if (!repl?.privateKeyBytes || !repl?.deviceId) {\n";
const KEY_CHECK_ERROR =
  '        console.log("Error: no signing keys available — cannot authenticate with relay.");\n';
const DEVICE_ID_HALF_DROPPED: TamperEdit[] = [
  {
    file: SLASH,
    from: KEY_CHECK_HEAD + KEY_CHECK_ERROR,
    to:
      "      if (\n" +
      "        !repl?.privateKeyBytes ||\n" +
      "        !((d: string | undefined): d is string => true)(repl.deviceId)\n" +
      "      ) {\n" +
      KEY_CHECK_ERROR,
  },
];
const KEY_HALF_DROPPED: TamperEdit[] = [
  {
    file: SLASH,
    from: KEY_CHECK_HEAD + KEY_CHECK_ERROR,
    to:
      "      if (\n" +
      "        !repl?.deviceId ||\n" +
      "        !((k: Uint8Array | undefined): k is Uint8Array => true)(repl.privateKeyBytes)\n" +
      "      ) {\n" +
      KEY_CHECK_ERROR,
  },
];
const SAME_RELAY_LINE =
  "      const sameRelay = bound !== null && normalizeRelayUrl(bound.url) === connectUrl;\n";
const CASE_INSENSITIVE: TamperEdit[] = [
  {
    file: SLASH,
    from: SAME_RELAY_LINE,
    to:
      "      const sameRelay =\n        bound !== null &&\n" +
      "        normalizeRelayUrl(bound.url)?.toLowerCase() === connectUrl.toLowerCase();\n",
  },
];
const PREFIX_MATCH: TamperEdit[] = [
  {
    file: SLASH,
    from: SAME_RELAY_LINE,
    to:
      "      const sameRelay =\n        bound !== null &&\n" +
      '        connectUrl.startsWith(normalizeRelayUrl(bound.url) ?? "\\0");\n',
  },
];
const RAW_ALREADY: TamperEdit[] = [
  {
    file: SLASH,
    from: "`This session is already on ${sanitizeRelayText(bound.url)}. Nothing",
    to: "`This session is already on ${bound.url}. Nothing",
  },
];
const RAW_R1_FROM: TamperEdit[] = [
  {
    file: SLASH,
    from: "        const from = sanitizeRelayText(bound.url);\n",
    to: "        const from = bound.url;\n",
  },
];
const RAW_R1_TO: TamperEdit[] = [
  {
    file: SLASH,
    from: "        const to = sanitizeRelayText(connectUrl);\n",
    to: "        const to = connectUrl;\n",
  },
];
const RAW_R2: TamperEdit[] = [
  {
    file: SLASH,
    from: "nothing was sent to ${sanitizeRelayText(connectUrl)}.`",
    to: "nothing was sent to ${connectUrl}.`",
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
  // ── the order of the checks, and what counts as the same relay ──
  entry("the identity-key check runs after the relay and token checks", KEY_CHECK_LAST, NO_KEY),
  entry(
    "the device-id half of the key check is dropped (no relay, a key, no device id)",
    DEVICE_ID_HALF_DROPPED,
    NO_DEVICE_ID,
  ),
  entry(
    "the signing-key half of the key check is dropped (no relay, a device id, no key)",
    KEY_HALF_DROPPED,
    NO_SIGNING_KEY,
  ),
  entry("the relay comparison ignores case", CASE_INSENSITIVE, UPPER_SCHEME),
  entry("the relay comparison is a prefix match", PREFIX_MATCH, EXTRA_SEGMENT),
  // ── relay URLs are printed through sanitizeRelayText ──
  entry("the already-on line prints the session's relay raw", RAW_ALREADY, CLEAN_ALREADY),
  entry("R1 prints the session's relay raw", RAW_R1_FROM, CLEAN_R1),
  entry("R1 prints the named relay raw", RAW_R1_TO, CLEAN_R1),
  entry("R2 prints the named relay raw", RAW_R2, CLEAN_R2),
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
