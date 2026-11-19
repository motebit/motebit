/**
 * Tamper checks for "the CLI sends an operator token only to the relay URL it
 * is bound to" (apps/cli/src/relay-operator-token.ts, `motebit relay
 * bind-token`, and every send site). Each entry re-opens one door and must
 * turn its test red:
 *
 *   - each branch of `operatorTokenFor`: the hash comparison, the per-relay
 *     lookup, the unbound case, a URL that cannot be bound, the empty-value
 *     rule (both halves), the sources a site names, the withheld line (said,
 *     said once, keyed by the relay, without control characters), and the
 *     record's refusals (version, a non-string entry, the one damage line);
 *   - each refusal and each promise of `bind-token`: no URL flag, `--sync`,
 *     an unbindable URL, no token, an empty token, a damaged record, the hash
 *     and never the token, owner-only, the replacement and the two warnings,
 *     and no network request;
 *   - every send site put back on its OWN read of the flag and variables: the
 *     subcommand helper, the REPL helper, REPL startup sync and discovery,
 *     REPL delegation wiring, `delegate --plan`, `smoke`, `doctor`,
 *     `federation mesh`, and each channel of `motebit run` and `motebit
 *     serve` (event sync, the socket's first frame, the task-receipt POST) —
 *     the daemon channels caught by the subprocess rows, not by the gate;
 *   - a call site that ASKS about one URL and SENDS to another: `migrate`,
 *     `federation peer`, `federation peer-remove` (their two URLs swapped),
 *     and for each of the three helpers one caller that asks about the saved
 *     relay while requesting the resolved one;
 *   - `/connect` asking whether the token is bound instead of whether it is set;
 *   - the reader gate's four rules, each weakened;
 *   - the gate's stated blind spot: a daemon that hands the whole environment
 *     to code outside apps/cli/src and picks the token out by a name built at
 *     run time. The gate stays GREEN on that edit — recorded by the gate's
 *     own test ("stays GREEN on the whole-environment pass-through…"), which
 *     plants the same text — and the subprocess row goes red, here.
 *
 * NOT in this catalog, because no behaviour reaches them on either tree and
 * so no test can go red for them (see the note in
 * apps/cli/src/__tests__/operator-token.probe.ts):
 *   - `motebit run`'s plan-delegation token factory (apps/cli/src/daemon.ts):
 *     nothing in `motebit run` drives the runtime's plan engine;
 *   - `motebit serve --self-test`'s token fallback (same file): self-test runs
 *     only after a registration that needs the key and device id the fallback
 *     is for the absence of.
 * Both are held by `check-cli-operator-token-reader` ALONE. Its own test
 * plants a direct read at each ("the two sites no behaviour reaches are held
 * here") and requires the gate to fail.
 *
 *   node_modules/.bin/tsx scripts/tampers/cli-operator-token-per-relay.ts
 *   (plain `node` cannot resolve the runner's `.js` import specifier)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG = "motebit";

const MODULE = "apps/cli/src/relay-operator-token.ts";
const BIND = "apps/cli/src/subcommands/relay-bind-token.ts";
const HELPERS = "apps/cli/src/subcommands/_helpers.ts";
const SLASH = "apps/cli/src/slash-commands.ts";
const FACTORY = "apps/cli/src/runtime-factory.ts";
const REPL_RELAY = "apps/cli/src/repl-relay.ts";
const DAEMON = "apps/cli/src/daemon.ts";
const DELEGATE = "apps/cli/src/subcommands/delegate.ts";
const SMOKE = "apps/cli/src/subcommands/smoke.ts";
const DOCTOR = "apps/cli/src/subcommands/doctor.ts";
const FEDERATION = "apps/cli/src/subcommands/federation.ts";
const MIGRATE = "apps/cli/src/subcommands/migrate.ts";
const MARKET = "apps/cli/src/subcommands/market.ts";
const GATE = "scripts/check-cli-operator-token-reader.ts";

const UNIT = "src/__tests__/relay-operator-token.test.ts";
const BIND_TEST = "src/__tests__/relay-bind-token.test.ts";
const SUBCOMMANDS = "src/__tests__/operator-token-subcommands.test.ts";
const DAEMONS = "src/__tests__/operator-token-daemons.test.ts";
const REPL = "src/__tests__/operator-token-repl.test.ts";
const EDGES = "src/__tests__/operator-token-edges.test.ts";
const GATE_TEST = "scripts/__tests__/check-cli-operator-token-reader.test.ts";

const edit = (file: string, from: string, to: string): TamperEdit => ({ file, from, to });

/** A fast in-process test of the CLI package. */
const unit = (name: string, test: string, red: string, edits: TamperEdit[]): TamperEntry => ({
  name,
  edits,
  pkg: PKG,
  test,
  red,
});

/** A subprocess row: run only that row. */
const row = (name: string, test: string, red: string, edits: TamperEdit[]): TamperEntry => ({
  name,
  edits,
  pkg: PKG,
  test,
  red,
  only: true,
});

const leak = (kind: "subcommand" | "daemon" | "repl", site: string, route: string): string =>
  `operator token per relay: ${kind} send sites leak | ${site} | B named by ${route}`;

const RECORD = "the operator token record";
const FOR = "operatorTokenFor";
const SPELLINGS = `${FOR} which spellings of a URL share an entry (relayPinKey)`;
const SOURCES = `${FOR} sources`;
const WITHHELD = `${FOR} the withheld line`;
const REFUSALS = "motebit relay bind-token — refusals write nothing";
const BINDING = "motebit relay bind-token — binding";

/** The token read each site made before, spelled as it was. */
const ALL_THREE =
  'config.syncToken ?? process.env["MOTEBIT_API_TOKEN"] ?? process.env["MOTEBIT_SYNC_TOKEN"]';
const RUN_READ = 'config.syncToken ?? process.env["MOTEBIT_SYNC_TOKEN"]';
const SERVE_READ = 'config.syncToken ?? process.env["MOTEBIT_API_TOKEN"]';
/** An unchecked token dressed as a bound one, for sites that call `bearerHeaders`. */
const asBound = (url: string): string =>
  `(own ? { relayUrl: ${url}, token: own } : undefined) as ReturnType<typeof operatorTokenFor>`;

// ── operatorTokenFor ────────────────────────────────────────────────────────

const HASH_NOT_COMPARED = [
  edit(
    MODULE,
    "    if (entry !== undefined && entry === hashToken(found.value)) {\n",
    "    if (entry !== undefined) {\n",
  ),
];
const ANY_ENTRY = [
  edit(
    MODULE,
    "    const entry = entriesForRead().get(pinKey);\n",
    "    const entry = [...entriesForRead().values()][0];\n",
  ),
];
const UNBOUND_SENT = [
  edit(
    MODULE,
    "  sayWithheld(relayUrl, pinKey, found.source);\n  return undefined;\n",
    "  return { relayUrl, token: found.value } as BoundOperatorToken;\n",
  ),
];
const UNBINDABLE_LOOKED_UP = [
  edit(
    MODULE,
    "  if (pinKey !== null) {\n    const entry = entriesForRead().get(pinKey);\n",
    "  {\n    const entry = entriesForRead().get(pinKey ?? relayUrl);\n",
  ),
];
const EMPTY_IS_A_TOKEN = [
  edit(
    MODULE,
    '  const found = firstDefined(sources, config);\n  if (found === undefined || found.value === "") return undefined;\n  const pinKey',
    "  const found = firstDefined(sources, config);\n  if (found === undefined) return undefined;\n  const pinKey",
  ),
];
const EMPTY_DOES_NOT_HIDE = [
  edit(
    MODULE,
    "    if (value != null) return { source, value };\n",
    '    if (value != null && value !== "") return { source, value };\n',
  ),
];
const SOURCES_IGNORED = [
  edit(
    MODULE,
    '  const found = firstDefined(sources, config);\n  if (found === undefined || found.value === "") return undefined;\n  const pinKey',
    '  const found = firstDefined(ALL_OPERATOR_TOKEN_SOURCES, config);\n  if (found === undefined || found.value === "") return undefined;\n  const pinKey',
  ),
];
const WITHHELD_NOT_SAID = [
  edit(
    MODULE,
    "  sayWithheld(relayUrl, pinKey, found.source);\n  return undefined;\n",
    "  return undefined;\n",
  ),
];
const WITHHELD_EVERY_TIME = [edit(MODULE, "  if (withheldSaid.has(memo)) return;\n", "")];
const WITHHELD_PER_SPELLING = [
  edit(MODULE, "  const memo = pinKey ?? relayUrl;\n", "  const memo = relayUrl;\n"),
];
const WITHHELD_RAW_URL = [
  edit(
    MODULE,
    "  withheldSaid.add(memo);\n  const shown = sanitizeRelayText(relayUrl);\n",
    "  withheldSaid.add(memo);\n  const shown = relayUrl;\n",
  ),
];
const VERSION_NOT_CHECKED = [
  edit(
    MODULE,
    '  if (!Object.hasOwn(doc, "version") || doc["version"] !== 1) {\n',
    '  if (!Object.hasOwn(doc, "version")) {\n',
  ),
];
const BAD_ENTRY_SKIPPED = [
  edit(
    MODULE,
    '      return { status: "damaged", cause: "an entry is not a string" };\n',
    "      continue;\n",
  ),
];
const DAMAGE_SAID_EVERY_TIME = [
  edit(MODULE, "  if (!damagedSaid.has(file)) {\n", "  if (true as boolean) {\n"),
];

// ── bind-token ──────────────────────────────────────────────────────────────

const BIND_URL = "  const url = config.syncUrlFlag;\n";
const BIND_EMPTY_URL_SAYS_SYNC = [
  edit(BIND, '    if (url === "") {\n', '    if (url === "" && config.syncUrl == null) {\n'),
];
const SMOKE_NO_TOKEN_TEXT_CHANGED = [
  edit(
    MODULE,
    '  if (operatorTokenIsSet(sources, config) !== undefined) {\n    return (\n      "Error: motebit smoke reconciliation',
    '  if (true as boolean) {\n    return (\n      "Error: motebit smoke reconciliation',
  ),
];
const BIND_READS_ENV_URL = [
  edit(BIND, BIND_URL, '  const url = config.syncUrlFlag ?? process.env["MOTEBIT_SYNC_URL"];\n'),
];
const BIND_ACCEPTS_SYNC = [
  edit(BIND, BIND_URL, "  const url = config.syncUrlFlag ?? config.syncUrl;\n"),
];
const BIND_ANY_URL = [
  edit(
    MODULE,
    "  const pinKey = relayPinKey(relayUrl);\n  if (pinKey === null) {\n",
    "  const pinKey = relayPinKey(relayUrl) ?? relayUrl;\n  if ((pinKey as string | null) === null) {\n",
  ),
];
const BIND_INVENTS_A_TOKEN = [
  edit(
    MODULE,
    "  const found = firstDefined(ALL_OPERATOR_TOKEN_SOURCES, config);\n  if (found === undefined) {\n",
    '  const found: { source: OperatorTokenSource; value: string } | undefined = firstDefined(\n    ALL_OPERATOR_TOKEN_SOURCES,\n    config,\n  ) ?? { source: "flag", value: "placeholder" };\n  if (found === undefined) {\n',
  ),
];
const BIND_EMPTY_TOKEN = [
  edit(
    MODULE,
    '  if (found.value === "") {\n',
    '  if (found.value === "" && (false as boolean)) {\n',
  ),
];
const BIND_OVERWRITES_DAMAGE = [
  edit(
    MODULE,
    '        const read = readRecord(file);\n        if (read.status === "damaged") return unusable(read.cause);\n',
    '        const read0 = readRecord(file);\n        const read =\n          read0.status === "damaged"\n            ? { status: "ok" as const, tokens: new Map<string, string>() }\n            : read0;\n',
  ),
];
const BIND_STORES_TOKEN = [
  edit(
    MODULE,
    "        read.tokens.set(pinKey, hash);\n",
    "        read.tokens.set(pinKey, found.value);\n",
  ),
];
const BIND_WORLD_READABLE = [
  edit(MODULE, "tokens }, null, 2)}\\n`, 0o600);\n", "tokens }, null, 2)}\\n`, 0o644);\n"),
];
const BIND_SILENT_REPLACE = [
  edit(MODULE, "          replaced: previous !== undefined,\n", "          replaced: false,\n"),
];
const BIND_NO_SHARED_WARNING = [
  edit(
    MODULE,
    "        if (sharedWith.length > 0) {\n",
    "        if (sharedWith.length > 0 && (false as boolean)) {\n",
  ),
];
const BIND_NO_VARIABLES_WARNING = [
  edit(MODULE, "api !== sync) {\n", "api !== sync && (false as boolean)) {\n"),
];
const BIND_MAKES_A_REQUEST = [
  edit(
    BIND,
    "  const result = bindOperatorToken(url, config);\n",
    "  const result = bindOperatorToken(url, config);\n  void fetch(`${url}/health`);\n",
  ),
];

// ── every send site back on its own read ────────────────────────────────────

const HELPER_OWN_READ = [
  edit(
    HELPERS,
    "  const operator = operatorTokenFor(relayUrl, ALL_OPERATOR_TOKEN_SOURCES, config);\n  if (operator !== undefined) return { ...headers, ...bearerHeaders(operator) };\n",
    `  const master =\n    ${ALL_THREE};\n  if (master) return { ...headers, Authorization: \`Bearer \${master}\` };\n`,
  ),
];
const SLASH_OWN_READ = [
  edit(
    SLASH,
    "  const operator = operatorTokenFor(relayUrl, ALL_OPERATOR_TOKEN_SOURCES, config);\n  if (operator !== undefined) return operator.token;\n",
    `  const master =\n    ${ALL_THREE};\n  if (master) return master;\n`,
  ),
];
const REPL_SYNC_OWN_READ = [
  edit(
    FACTORY,
    "    const operator = operatorTokenFor(syncUrl, ALL_OPERATOR_TOKEN_SOURCES, config);\n",
    `    const own =\n      ${ALL_THREE};\n    const operator = own ? { relayUrl: syncUrl, token: own } : undefined;\n`,
  ),
];
const REPL_DISCOVERY_OWN_READ = [
  edit(
    REPL_RELAY,
    "    const operator = operatorTokenFor(syncUrl, REPL_RELAY_TOKEN_SOURCES, config);\n    const resp = await",
    `    const own = ${SERVE_READ};\n    const operator = ${asBound("syncUrl")};\n    const resp = await`,
  ),
];
const REPL_WIRING_OWN_READ = [
  edit(
    REPL_RELAY,
    "    const operator = operatorTokenFor(syncUrl, REPL_RELAY_TOKEN_SOURCES, config);\n    if (operator !== undefined) {\n",
    `    const own = ${SERVE_READ};\n    const operator = own ? { relayUrl: syncUrl, token: own } : undefined;\n    if (operator !== undefined) {\n`,
  ),
];
const DELEGATE_PLAN_OWN_READ = [
  edit(
    DELEGATE,
    "  const operator = operatorTokenFor(relayUrl, ALL_OPERATOR_TOKEN_SOURCES, config);\n  const eventSync",
    `  const own =\n    ${ALL_THREE};\n  const operator = own ? { relayUrl, token: own } : undefined;\n  const eventSync`,
  ),
];
const SMOKE_OWN_READ = [
  edit(
    SMOKE,
    "  const operator = operatorTokenFor(relayUrl, ALL_OPERATOR_TOKEN_SOURCES, config);\n",
    `  const own =\n    ${ALL_THREE};\n  const operator = ${asBound("relayUrl")};\n`,
  ),
];
const DOCTOR_OWN_READ = [
  edit(
    DOCTOR,
    "      const operator = operatorTokenFor(probeUrl, DOCTOR_TOKEN_SOURCES, NO_FLAG_CONFIG);\n",
    `      const own = process.env["MOTEBIT_API_TOKEN"] ?? process.env["MOTEBIT_SYNC_TOKEN"];\n      const operator = ${asBound("probeUrl")};\n`,
  ),
];
const MESH_ONE_TOKEN_FOR_ALL = [
  edit(
    FEDERATION,
    "    const operator = operatorTokenFor(url, ALL_OPERATOR_TOKEN_SOURCES, config);\n",
    `    const own =\n      ${ALL_THREE};\n    const operator = ${asBound("url")};\n`,
  ),
];

// `motebit run`, channel by channel.
const RUN_SYNC_OWN_READ = [
  edit(
    DAEMON,
    "      ...(operator !== undefined\n        ? { syncUrl: operator.relayUrl, configuredToken: operator.token }\n        : { syncUrl }),\n      motebitId,\n      deviceId: fullConfig.device_id ?? undefined,\n",
    `      syncUrl,\n      configuredToken: ${RUN_READ} ?? "",\n      motebitId,\n      deviceId: fullConfig.device_id ?? undefined,\n`,
  ),
];
const RUN_SOCKET_OWN_READ = [
  edit(
    DAEMON,
    "    wsAdapter = createRelaySyncSocket({\n      ...(operator !== undefined\n        ? { syncUrl: operator.relayUrl, fallbackToken: operator.token }\n        : { syncUrl }),\n",
    `    wsAdapter = createRelaySyncSocket({\n      syncUrl,\n      fallbackToken: ${RUN_READ} ?? "",\n`,
  ),
];
const RUN_RECEIPT_OWN_READ = [
  edit(
    DAEMON,
    "                  masterToken: operator?.token,\n                  mintTaskResult:\n                    deviceId != null\n",
    `                  masterToken: ${RUN_READ},\n                  mintTaskResult:\n                    deviceId != null\n`,
  ),
];
// `motebit serve`, channel by channel.
const SERVE_SYNC_OWN_READ = [
  edit(
    DAEMON,
    "      ...(operator !== undefined\n        ? { syncUrl: operator.relayUrl, configuredToken: operator.token }\n        : { syncUrl }),\n      motebitId,\n      deviceId: fullConfigForServe.device_id ?? undefined,\n",
    `      syncUrl,\n      configuredToken: ${SERVE_READ} ?? "",\n      motebitId,\n      deviceId: fullConfigForServe.device_id ?? undefined,\n`,
  ),
];
const SERVE_SOCKET_OWN_READ = [
  edit(
    DAEMON,
    "      serveWsAdapter = createRelaySyncSocket({\n        ...(operator !== undefined\n          ? { syncUrl: operator.relayUrl, fallbackToken: operator.token }\n          : { syncUrl }),\n",
    `      serveWsAdapter = createRelaySyncSocket({\n        syncUrl,\n        fallbackToken: ${SERVE_READ} ?? "",\n`,
  ),
];
const SERVE_RECEIPT_OWN_READ = [
  edit(
    DAEMON,
    "                masterToken: operator?.token,\n                mintTaskResult:\n                  serveKey != null && serveDeviceId != null\n",
    `                masterToken: ${SERVE_READ},\n                mintTaskResult:\n                  serveKey != null && serveDeviceId != null\n`,
  ),
];
// The gate's blind spot: the whole environment handed to code outside
// apps/cli/src, the token picked out by a name built at run time. The same
// text is planted by the gate's own test, which requires the gate to PASS.
const SERVE_WHOLE_ENV_PASS_THROUGH = [
  edit(
    DAEMON,
    "    const operator = operatorTokenFor(syncUrl, SERVE_TOKEN_SOURCES, config);\n",
    '    const own = Object.fromEntries(Object.entries(process.env))[["MOTEBIT", "API", "TOKEN"].join("_")];\n' +
      `    const operator = ${asBound("syncUrl")};\n`,
  ),
];

// ── asks about one URL, sends to another ────────────────────────────────────

const MIGRATE_ASKS_DESTINATION = [
  edit(
    MIGRATE,
    "  const sourceHeaders = await getRelayAuthHeaders(config, sourceRelayUrl, { json: true });\n",
    "  const sourceHeaders = await getRelayAuthHeaders(config, destinationUrl, { json: true });\n",
  ),
];
const PEER_ASKS_PEER = [
  edit(
    FEDERATION,
    "  const ownHeaders = await getRelayAuthHeaders(config, relayUrl);\n",
    "  const ownHeaders = await getRelayAuthHeaders(config, peerEndpoint);\n",
  ),
];
const PEER_REMOVE_ASKS_PEER = [
  edit(
    FEDERATION,
    "  const headers = await getRelayAuthHeaders(config, relayUrl);\n  const sigRes = await fetchRelayJson(\n",
    "  const headers = await getRelayAuthHeaders(config, peerEndpoint);\n  const sigRes = await fetchRelayJson(\n",
  ),
];
const BALANCE_ASKS_SAVED = [
  edit(
    MARKET,
    '  const headers = await getRelayAuthHeaders(config, relayUrl, { aud: "account:balance" });\n',
    '  const headers = await getRelayAuthHeaders(config, loadFullConfig().sync_url ?? relayUrl, {\n    aud: "account:balance",\n  });\n',
  ),
];
const SLASH_LEDGER_ASKS_SAVED = [
  edit(
    SLASH,
    "        const ledgerToken = await getRelayToken(config, repl, ledgerSyncUrl);\n",
    "        const ledgerToken = await getRelayToken(\n          config,\n          repl,\n          fullConfig?.sync_url ?? ledgerSyncUrl,\n        );\n",
  ),
];
const SLASH_DEPOSITS_ASKS_SAVED = [
  edit(
    SLASH,
    "        const depHeaders = await makeRelayHeaders(config, repl, depSyncUrl, {\n",
    "        const depHeaders = await makeRelayHeaders(config, repl, fullConfig?.sync_url ?? depSyncUrl, {\n",
  ),
];

// ── /connect ────────────────────────────────────────────────────────────────

const CONNECT_ASKS_BOUND = [
  edit(
    SLASH,
    "      const operatorToken = operatorTokenIsSet(ALL_OPERATOR_TOKEN_SOURCES, config);\n",
    "      const operatorToken =\n        operatorTokenFor(connectUrl, ALL_OPERATOR_TOKEN_SOURCES, config) !== undefined\n          ? operatorTokenIsSet(ALL_OPERATOR_TOKEN_SOURCES, config)\n          : undefined;\n",
  ),
];

// ── the gate ────────────────────────────────────────────────────────────────

const GATE_NAME = "check-cli-operator-token-reader";
const R1 = `${GATE_NAME} R1 — a reader added to another file`;
const gate = (name: string, red: string, edits: TamperEdit[]): TamperEntry => ({
  name,
  edits,
  test: GATE_TEST,
  red,
  only: true,
});

const TAMPERS: TamperEntry[] = [
  // ── operatorTokenFor ──
  unit(
    "the token's hash is not compared with the entry",
    UNIT,
    `${FOR} returns nothing when the token changed after binding`,
    HASH_NOT_COMPARED,
  ),
  unit(
    "any relay's entry is taken for this relay",
    UNIT,
    `${FOR} returns nothing for ANOTHER relay's URL`,
    ANY_ENTRY,
  ),
  unit(
    "an unbound token is returned anyway",
    UNIT,
    `${FOR} returns nothing for a relay with no entry`,
    UNBOUND_SENT,
  ),
  unit(
    "a URL that cannot be bound is looked up by its raw spelling",
    UNIT,
    `${SPELLINGS} a URL with userinfo gets no token, whatever the record holds`,
    UNBINDABLE_LOOKED_UP,
  ),
  unit(
    "an empty first source is treated as a token (and announced)",
    UNIT,
    `${SOURCES} an empty flag hides the variables and then counts as unset — nothing sent, nothing said`,
    EMPTY_IS_A_TOKEN,
  ),
  unit(
    "an empty first source no longer hides the sources after it",
    UNIT,
    `${SOURCES} an empty flag hides the variables and then counts as unset — nothing sent, nothing said`,
    EMPTY_DOES_NOT_HIDE,
  ),
  unit(
    "a site's sources are ignored: every site reads all three",
    UNIT,
    `${SOURCES} a site reads only the sources it names: [flag, sync] never reads the api variable`,
    SOURCES_IGNORED,
  ),
  unit(
    "a withheld token is not announced",
    UNIT,
    `${WITHHELD} names the source, the URL and the bind command, and never the token`,
    WITHHELD_NOT_SAID,
  ),
  unit(
    "the withheld line is printed on every call",
    UNIT,
    `${WITHHELD} is printed once per process and relay, however the URL is spelled`,
    WITHHELD_EVERY_TIME,
  ),
  unit(
    "the withheld line is remembered per spelling, not per relay",
    UNIT,
    `${WITHHELD} is printed once per process and relay, however the URL is spelled`,
    WITHHELD_PER_SPELLING,
  ),
  unit(
    "the withheld line prints the relay URL raw",
    UNIT,
    `${WITHHELD} prints the URL without its control characters`,
    WITHHELD_RAW_URL,
  ),
  unit(
    "the record's version is not checked",
    UNIT,
    `${RECORD} another version is no entries, even when it holds a matching entry`,
    VERSION_NOT_CHECKED,
  ),
  unit(
    "a non-string entry is skipped instead of refusing the file",
    UNIT,
    `${RECORD} a non-string value is no entries for the whole file, the good entry included`,
    BAD_ENTRY_SKIPPED,
  ),
  unit(
    "the damaged-record line is printed on every read",
    UNIT,
    `${RECORD} a file that does not parse is no entries, with one line naming the file, and never an exit`,
    DAMAGE_SAID_EVERY_TIME,
  ),

  // ── bind-token ──
  unit(
    "bind-token takes the relay URL from MOTEBIT_SYNC_URL",
    BIND_TEST,
    `${REFUSALS} no --sync-url, with MOTEBIT_SYNC_URL and a saved sync_url both naming a bindable relay`,
    BIND_READS_ENV_URL,
  ),
  unit(
    "an empty --sync-url gets the --sync refusal",
    BIND_TEST,
    `${REFUSALS} an empty --sync-url: its own refusal, not the --sync one`,
    BIND_EMPTY_URL_SAYS_SYNC,
  ),
  unit(
    "smoke prints the set-but-unbound text when no token is set at all",
    UNIT,
    "smokeTokenRequiredMessage (motebit smoke reconciliation) with NO token set: exactly main's text, with no bind instruction",
    SMOKE_NO_TOKEN_TEXT_CHANGED,
  ),
  unit(
    "bind-token accepts --sync",
    BIND_TEST,
    `${REFUSALS} --sync instead of --sync-url`,
    BIND_ACCEPTS_SYNC,
  ),
  unit(
    "bind-token binds a URL relayPinKey refuses",
    BIND_TEST,
    `${REFUSALS} a relay URL with userinfo`,
    BIND_ANY_URL,
  ),
  unit(
    "bind-token binds with no token given",
    BIND_TEST,
    `${REFUSALS} no token anywhere`,
    BIND_INVENTS_A_TOKEN,
  ),
  unit(
    "bind-token binds an empty token",
    BIND_TEST,
    `${REFUSALS} an empty token from the flag, even with a variable set (the flag hides it)`,
    BIND_EMPTY_TOKEN,
  ),
  unit(
    "bind-token overwrites a damaged record",
    BIND_TEST,
    `${REFUSALS} a record that is not JSON: named, and not overwritten`,
    BIND_OVERWRITES_DAMAGE,
  ),
  unit(
    "bind-token stores the token itself",
    BIND_TEST,
    `${BINDING} writes the hash only, owner-only, and says the source and six characters of the hash`,
    BIND_STORES_TOKEN,
  ),
  unit(
    "the record is written world-readable",
    UNIT,
    `${RECORD} is written owner-only (0600), holding the hash and never the token`,
    BIND_WORLD_READABLE,
  ),
  unit(
    "a replaced entry is not announced",
    BIND_TEST,
    `${BINDING} replaces an existing entry (a rotated token) and says so`,
    BIND_SILENT_REPLACE,
  ),
  unit(
    "the same-token-on-another-relay warning is dropped",
    BIND_TEST,
    `${BINDING} the same token already bound to another relay: says so, and still binds`,
    BIND_NO_SHARED_WARNING,
  ),
  unit(
    "the variables-differ warning is dropped",
    BIND_TEST,
    `${BINDING} the two variables set and different: says so, names the one bound, and what run and serve read`,
    BIND_NO_VARIABLES_WARNING,
  ),
  unit(
    "bind-token makes a network request",
    BIND_TEST,
    `${BINDING} writes the hash only, owner-only, and says the source and six characters of the hash`,
    BIND_MAKES_A_REQUEST,
  ),

  // ── send sites back on their own read ──
  row(
    "the subcommand helper reads the token itself (balance, B by flag)",
    SUBCOMMANDS,
    leak("subcommand", "balance", "flag"),
    HELPER_OWN_READ,
  ),
  row(
    "the subcommand helper reads the token itself (ledger, B by variable)",
    SUBCOMMANDS,
    leak("subcommand", "ledger", "env"),
    HELPER_OWN_READ,
  ),
  row(
    "the subcommand helper reads the token itself (federation peers, B by saved config)",
    SUBCOMMANDS,
    leak("subcommand", "federation peers", "saved"),
    HELPER_OWN_READ,
  ),
  row(
    "delegate --plan's event sync reads the token itself",
    SUBCOMMANDS,
    leak("subcommand", "delegate --plan", "flag"),
    DELEGATE_PLAN_OWN_READ,
  ),
  row(
    "smoke reconciliation reads the token itself",
    SUBCOMMANDS,
    leak("subcommand", "smoke reconciliation", "flag"),
    SMOKE_OWN_READ,
  ),
  row(
    "doctor reads the token itself",
    SUBCOMMANDS,
    leak("subcommand", "doctor", "env"),
    DOCTOR_OWN_READ,
  ),
  row(
    "federation mesh sends the one configured token to every URL (the row)",
    SUBCOMMANDS,
    leak("subcommand", "federation mesh", "flag"),
    MESH_ONE_TOKEN_FOR_ALL,
  ),
  row(
    "federation mesh sends the one configured token to every URL (three relays, one bound)",
    EDGES,
    "federation mesh (6) three relays, the token bound to one: only that relay receives it; the others get the device token",
    MESH_ONE_TOKEN_FOR_ALL,
  ),
  row(
    "the REPL helper reads the token itself (/balance)",
    REPL,
    leak("repl", "repl /balance", "flag"),
    SLASH_OWN_READ,
  ),
  row(
    "the REPL helper reads the token itself (/sync, B by saved config)",
    REPL,
    leak("repl", "repl /sync", "saved"),
    SLASH_OWN_READ,
  ),
  row(
    "REPL startup sync reads the token itself",
    REPL,
    leak("repl", "repl startup event sync", "flag"),
    REPL_SYNC_OWN_READ,
  ),
  row(
    "REPL startup discovery reads the token itself",
    REPL,
    leak("repl", "repl startup agent discovery", "flag"),
    REPL_DISCOVERY_OWN_READ,
  ),
  row(
    "REPL delegation wiring reads the token itself",
    REPL,
    leak("repl", "repl delegation wiring (key, no device id)", "flag"),
    REPL_WIRING_OWN_READ,
  ),
  row(
    "motebit run's event sync reads the token itself",
    DAEMONS,
    leak("daemon", "run event sync", "flag"),
    RUN_SYNC_OWN_READ,
  ),
  row(
    "motebit run's socket reads the token itself",
    DAEMONS,
    leak("daemon", "run WebSocket first frame (key, no device id)", "flag"),
    RUN_SOCKET_OWN_READ,
  ),
  row(
    "motebit run's socket reads the token itself (the key does not open)",
    DAEMONS,
    leak("daemon", "run WebSocket first frame (wrong passphrase)", "flag"),
    RUN_SOCKET_OWN_READ,
  ),
  row(
    "motebit run's task-receipt POST reads the token itself",
    DAEMONS,
    leak("daemon", "run task-receipt POST", "flag"),
    RUN_RECEIPT_OWN_READ,
  ),
  row(
    "motebit serve's event sync reads the token itself",
    DAEMONS,
    leak("daemon", "serve event sync", "flag"),
    SERVE_SYNC_OWN_READ,
  ),
  row(
    "motebit serve's socket reads the token itself",
    DAEMONS,
    leak("daemon", "serve WebSocket first frame (key, no device id)", "flag"),
    SERVE_SOCKET_OWN_READ,
  ),
  row(
    "motebit serve's task-receipt POST reads the token itself",
    DAEMONS,
    leak("daemon", "serve task-receipt POST", "flag"),
    SERVE_RECEIPT_OWN_READ,
  ),
  row(
    "motebit serve hands the whole environment to outside code (the gate's blind spot)",
    DAEMONS,
    leak("daemon", "serve event sync", "env"),
    SERVE_WHOLE_ENV_PASS_THROUGH,
  ),

  // ── asks about one URL, sends to another ──
  row(
    "migrate asks about the destination and sends to the source",
    SUBCOMMANDS,
    leak("subcommand", "migrate", "flag"),
    MIGRATE_ASKS_DESTINATION,
  ),
  row(
    "federation peer asks about the peer and sends to its own relay",
    SUBCOMMANDS,
    leak("subcommand", "federation peer", "flag"),
    PEER_ASKS_PEER,
  ),
  row(
    "federation peer-remove asks about the peer and sends to its own relay",
    SUBCOMMANDS,
    leak("subcommand", "federation peer-remove", "flag"),
    PEER_REMOVE_ASKS_PEER,
  ),
  row(
    "a getRelayAuthHeaders caller asks about the saved relay (balance, B by flag)",
    SUBCOMMANDS,
    leak("subcommand", "balance", "flag"),
    BALANCE_ASKS_SAVED,
  ),
  row(
    "a getRelayAuthHeaders caller asks about the saved relay (balance, B by variable)",
    SUBCOMMANDS,
    leak("subcommand", "balance", "env"),
    BALANCE_ASKS_SAVED,
  ),
  row(
    "a getRelayToken caller asks about the saved relay (/ledger)",
    REPL,
    leak("repl", "repl /ledger", "flag"),
    SLASH_LEDGER_ASKS_SAVED,
  ),
  row(
    "a makeRelayHeaders caller asks about the saved relay (/deposits)",
    REPL,
    leak("repl", "repl /deposits", "flag"),
    SLASH_DEPOSITS_ASKS_SAVED,
  ),

  // ── /connect ──
  row(
    "/connect refuses only a BOUND token",
    EDGES,
    "/connect refuses on an operator token being set, bound or not (7) a session with no relay, a token bound to nothing: /connect sends nothing and says why",
    CONNECT_ASKS_BOUND,
  ),

  // ── the gate ──
  gate("the gate allows subcommands/relay.ts", `${R1} any match in subcommands/relay.ts`, [
    edit(
      GATE,
      "const ALLOWED_READERS: readonly string[] = [MODULE, ARGS];\n",
      "const ALLOWED_READERS: readonly string[] = [MODULE, ARGS, RELAY_SERVER];\n",
    ),
  ]),
  gate("the gate no longer matches the identifier", `${R1} as a destructured read`, [
    edit(
      GATE,
      "        if (n.text === FLAG_IDENTIFIER) named = `the identifier \\`${FLAG_IDENTIFIER}\\``;\n",
      "        if ((false as boolean) && n.text === FLAG_IDENTIFIER)\n          named = `the identifier \\`${FLAG_IDENTIFIER}\\``;\n",
    ),
  ]),
  gate("the gate no longer matches the flag's name in a string", `${R1} as an index read`, [
    edit(
      GATE,
      'const SOURCE_TEXT: readonly string[] = [FLAG_IDENTIFIER, "sync-token", ...VARIABLE_NAMES];\n',
      'const SOURCE_TEXT: readonly string[] = ["sync-token", ...VARIABLE_NAMES];\n',
    ),
  ]),
  gate(
    "the gate no longer matches the sync variable",
    `${R1} as a string naming the sync variable`,
    [
      edit(
        GATE,
        'const VARIABLE_NAMES: readonly string[] = ["MOTEBIT_API_TOKEN", "MOTEBIT_SYNC_TOKEN"];\n',
        'const VARIABLE_NAMES: readonly string[] = ["MOTEBIT_API_TOKEN"];\n',
      ),
    ],
  ),
  gate(
    "the gate lets any file name bindOperatorToken",
    `${GATE_NAME} R2 — the record has one writer and one caller a second file imports bindOperatorToken`,
    [
      edit(
        GATE,
        "        if (file !== BIND_HANDLER) {\n",
        "        if (file !== BIND_HANDLER && (false as boolean)) {\n",
      ),
    ],
  ),
  gate(
    "the gate lets any file name resolveRelayApiToken",
    `${GATE_NAME} R3 — the relay server's resolver stays in its file another file references resolveRelayApiToken`,
    [
      edit(
        GATE,
        "      if (spelled === SERVER_RESOLVER && file !== RELAY_SERVER) {\n",
        "      if (spelled === SERVER_RESOLVER && file !== RELAY_SERVER && (false as boolean)) {\n",
      ),
    ],
  ),
  gate(
    "the gate lets any file import @motebit/relay",
    `${GATE_NAME} R4 — the relay package has one importer another file imports @motebit/relay`,
    [
      edit(
        GATE,
        "        file !== RELAY_SERVER\n      ) {\n",
        "        file !== RELAY_SERVER &&\n        (false as boolean)\n      ) {\n",
      ),
    ],
  ),
];

void runTampers(TAMPERS, { root: ROOT });
