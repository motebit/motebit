/**
 * Tamper checks for "a FAILED relay revocation pull presents no grant"
 * (apps/cli/src/subcommands/grant.ts: `pullRelayRevocations`,
 * `createGrantPresenter`). The pull used to map every failure to an empty
 * list, so a grant revoked on another machine verified on any turn the relay
 * could not be reached. Each entry re-opens one door and must turn its test
 * red:
 *
 *   - a thrown pull (network error, timeout, unparseable body) read as an
 *     empty feed: the presenter case, the owner chat turn over a real runtime
 *     (the R4 call auto-executes) and the `serve --direct --grant` task;
 *   - the presenter's "withhold on a failed pull" branch removed;
 *   - the non-2xx check dropped (an error status with a feed-shaped body);
 *   - a 200 body that is not the feed read as an empty feed;
 *   - the once-per-outage latch removed, or never re-armed (not a safety
 *     property: calm);
 *   - the pull following redirects, or accepting a redirected answer;
 *   - the relay set captured once at startup instead of asked each turn;
 *   - `/connect` no longer adding its relay to the session, `SessionRelays`
 *     replacing instead of accumulating, or the relay the saved config named
 *     before `/connect` overwrote it being forgotten;
 *   - each term of the daemon's set dropped, isolated;
 *   - "any failed pull withholds" weakened to "all must fail";
 *   - the REPL's or the daemon's relay set back to first-wins (`namedRelayUrl`:
 *     the winning source only), or the saved config dropped from it;
 *   - the notice latch ignoring WHICH relay is failing;
 *   - the presenter falling back to the environment by itself;
 *   - the raw error text restored in the failure reason.
 *
 *   node_modules/.bin/tsx scripts/tampers/grant-revocation-pull-fail-closed.ts
 *   (plain `node` cannot resolve the runner's `.js` import specifier)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = "apps/cli/src/subcommands/grant.ts";
const SLASH = "apps/cli/src/slash-commands.ts";
const PKG = "motebit";
const TEST = "src/__tests__/grant-presenter-pull-fail-closed.test.ts";

const PRESENTER = "revocation pull: a failed pull presents no grant";
const UNION = "revocation pull: every known relay is asked, any failure withholds";
const CONNECT =
  "revocation pull: the relay delegation submits to is always pulled (/connect adds, never replaces)";
const DAEMON = "revocation pull: serve --direct --grant asks the relay `grant revoke` posts to";
const REASON = "revocation pull: the reason never carries a URL or an error's own text";
const NOTICE = "revocation pull: the notice fires once per outage";
const FOLLOWS = "revocation pull: the notice follows the failing relay";
const SOURCES = "revocation pull: every source that names a relay is asked, not the winner";
const BOTH = "both relays are asked, either failing withholds, either's revocation refuses";
const CHAT =
  "revocation pull: the runtime path (owner chat turn) failed pull: the R4 call does not auto-execute — it pauses for approval, zero payments built";
const DIRECT =
  "revocation pull: serve --direct --grant inherits it failed pull: the R4 task is refused and the tool never runs";

function entry(name: string, from: string, to: string, red: string, file = SRC): TamperEntry {
  return { name, edits: [{ file, from, to }], pkg: PKG, test: TEST, red };
}

const THROWN_FAILED = "    return failed(thrownPullKind(err));\n";
const THROWN_EMPTY = '    return { status: "ok", records: [] };\n';
const NON_2XX = "    if (!res.ok) return failed(`HTTP ${res.status}`);\n";
const WITHHOLD = '      return { status: "withheld", reason: "revocation_unconfirmed" };\n';
const ASK_NOW = "      relayUrls = options.relayUrls?.() ?? [];\n";
const ANY_FAILS = "  if (failures.length > 0) {";
const REPL_ALL =
  "  return [\n    ...session.urls,\n    config.syncUrl,\n" +
  '    process.env["MOTEBIT_SYNC_URL"],\n    loadFullConfig().sync_url,\n  ];\n';
const REPL_WINNER = "  return [...session.urls, namedRelayUrl(config, loadFullConfig())];\n";
const DAEMON_NO_SAVED_CONFIG =
  "  return [\n    relay.intentUrl,\n    relay.syncUrl,\n    config.syncUrl,\n" +
  '    process.env["MOTEBIT_SYNC_URL"],\n  ];\n';
const ACCUMULATE = "    this.#urls.push(normalized);\n";
const REPLACE = "    this.#urls.splice(0, this.#urls.length, normalized);\n";
const DAEMON_ALL =
  "  return [\n    relay.intentUrl,\n    relay.syncUrl,\n    config.syncUrl,\n" +
  '    process.env["MOTEBIT_SYNC_URL"],\n    loadFullConfig().sync_url,\n  ];\n';
const DAEMON_WINNER =
  "  return [relay.intentUrl, relay.syncUrl, namedRelayUrl(config, loadFullConfig())];\n";

const TAMPERS: TamperEntry[] = [
  entry(
    "a thrown pull is read as an empty feed (presenter: network error)",
    THROWN_FAILED,
    THROWN_EMPTY,
    `${PRESENTER} a network error: no grant is presented`,
  ),
  entry(
    "a thrown pull is read as an empty feed (presenter: timeout)",
    THROWN_FAILED,
    THROWN_EMPTY,
    `${PRESENTER} a timeout: no grant is presented`,
  ),
  entry(
    "a thrown pull is read as an empty feed (serve --direct --grant task)",
    THROWN_FAILED,
    THROWN_EMPTY,
    DIRECT,
  ),
  entry(
    "the withhold branch is removed (presenter: HTTP 500)",
    WITHHOLD,
    "",
    `${PRESENTER} HTTP 500: no grant is presented`,
  ),
  entry("the withhold branch is removed (owner chat turn, real runtime)", WITHHOLD, "", CHAT),
  entry("the withhold branch is removed (serve --direct --grant task)", WITHHOLD, "", DIRECT),
  entry(
    "the withhold branch is removed (a local revocation + a failed pull)",
    WITHHOLD,
    "",
    `${PRESENTER} a local revocation + a failed pull: no authority`,
  ),
  entry(
    "the non-2xx check is dropped (HTTP 429 with a feed-shaped body)",
    NON_2XX,
    "",
    `${PRESENTER} HTTP 429 with a feed-shaped body: no grant is presented`,
  ),
  entry(
    "the non-2xx check is dropped (owner chat turn, real runtime)",
    NON_2XX,
    '    if (!res.ok) return { status: "ok", records: [] };\n',
    CHAT,
  ),
  entry(
    "a 200 body that is not the feed is read as an empty feed",
    '      return failed("not a revocation feed");\n',
    '      return { status: "ok", records: [] };\n',
    `${PRESENTER} a 200 body with no records array: no grant is presented`,
  ),
  entry(
    "the once-per-outage notice latch is removed",
    "        announced = failing;\n",
    "",
    `${NOTICE} consecutive failed-pull turns call onRevocationUnconfirmed exactly once, with the reason`,
  ),
  entry(
    "the notice latch is never re-armed after a successful pull (once per process)",
    '    if (pull.status === "ok") announced = null;\n',
    "",
    `${NOTICE} failure, success, failure: each outage is announced once`,
  ),
  entry(
    "the pull follows redirects again",
    '      redirect: "error",\n',
    "",
    `${PRESENTER} a redirected answer: no grant is presented`,
  ),
  entry(
    "a redirected answer is accepted",
    '    if (res.redirected) return failed("redirected");\n',
    "",
    `${UNION} an answer that was redirected (a fetch that followed one anyway) is a failed pull`,
  ),
  // ── which relays are asked ──
  {
    name: "the relay set is captured once at startup (/connect is not seen)",
    edits: [
      {
        file: SRC,
        from: "  let announced: string | null = null;\n",
        to: "  let announced: string | null = null;\n  const startupRelayUrls = options.relayUrls?.() ?? [];\n",
      },
      { file: SRC, from: ASK_NOW, to: "      relayUrls = startupRelayUrls;\n" },
    ],
    pkg: PKG,
    test: TEST,
    red: `${CONNECT} no relay at start, /connect B: delegation submits to B; B answering 500 withholds`,
  },
  {
    name: "the relay set is captured once at startup (a later change is not seen)",
    edits: [
      {
        file: SRC,
        from: "  let announced: string | null = null;\n",
        to: "  let announced: string | null = null;\n  const startupRelayUrls = options.relayUrls?.() ?? [];\n",
      },
      { file: SRC, from: ASK_NOW, to: "      relayUrls = startupRelayUrls;\n" },
    ],
    pkg: PKG,
    test: TEST,
    red: `${UNION} the set is asked again at EACH presentation, never captured`,
  },
  entry(
    "/connect no longer adds its relay to the session",
    "      repl.sessionRelay?.add(connectUrl);\n",
    "",
    `${CONNECT} --sync-url A at start, /connect B, saved config then removed: B stays in the set (the session keeps it)`,
    SLASH,
  ),
  entry(
    "any failed pull withholds -> all must fail (two relays, one fails)",
    ANY_FAILS,
    "  if (failures.length === pulls.length) {",
    `${UNION} two relays, one fails: withheld, and the notice names the failing host only`,
  ),
  entry(
    "any failed pull withholds -> all must fail (/connect: A ok + B 500)",
    ANY_FAILS,
    "  if (failures.length === pulls.length) {",
    `${CONNECT} (c) flag=A, /connect B: delegation submits to A; both are pulled; B failing withholds`,
  ),
  // ── the session's relays accumulate ──
  entry(
    "SessionRelays.add replaces instead of accumulating: (a) config=A, /connect B",
    ACCUMULATE,
    REPLACE,
    `${CONNECT} (a) config=A at start, /connect B: delegation still submits to A, and A is still pulled`,
  ),
  entry(
    "SessionRelays.add replaces instead of accumulating: (b) /connect B, /connect C",
    ACCUMULATE,
    REPLACE,
    `${CONNECT} (b) no relay at start, /connect B, then /connect C: delegation submits to B, and B is still pulled`,
  ),
  entry(
    "/connect no longer keeps the relay the saved config named before overwriting it",
    "      repl.sessionRelay?.add(savedRelayUrl());\n",
    "",
    `${CONNECT} the relay the saved config names when /connect overwrites it stays in the set`,
    SLASH,
  ),
  // ── the daemon set, each term isolated ──
  entry(
    "relay.intentUrl is dropped from the daemon's set",
    "    relay.intentUrl,\n",
    "",
    `${DAEMON} a relay named only by relay.intentUrl is asked, and its failure withholds`,
  ),
  entry(
    "relay.syncUrl is dropped from the daemon's set",
    "    relay.syncUrl,\n",
    "",
    `${DAEMON} a relay named only by relay.syncUrl is asked, and its failure withholds`,
  ),
  entry(
    "the flag (config.syncUrl) is dropped from the daemon's set",
    "    relay.syncUrl,\n    config.syncUrl,\n",
    "    relay.syncUrl,\n",
    `${DAEMON} a relay named only by config.syncUrl (the flag) is asked, and its failure withholds`,
  ),
  // ── every source, not the winner ──
  entry(
    "REPL set back to first-wins (namedRelayUrl): flag=A + config=B",
    REPL_ALL,
    REPL_WINNER,
    `${SOURCES} REPL: flag=A + config=B: ${BOTH}`,
  ),
  entry(
    "REPL set back to first-wins (namedRelayUrl): flag=A + env=B",
    REPL_ALL,
    REPL_WINNER,
    `${SOURCES} REPL: flag=A + env=B: ${BOTH}`,
  ),
  entry(
    "REPL set back to first-wins (namedRelayUrl): env=A + config=B",
    REPL_ALL,
    REPL_WINNER,
    `${SOURCES} REPL: env=A + config=B: ${BOTH}`,
  ),
  entry(
    "REPL set back to first-wins (namedRelayUrl): config B saved mid-session under flag A",
    REPL_ALL,
    REPL_WINNER,
    `${SOURCES} REPL: started with flag=A, config B saved by another process mid-session: B is asked on the next turn`,
  ),
  entry(
    "daemon set back to first-wins (namedRelayUrl): serve http, flag=A + config=B",
    DAEMON_ALL,
    DAEMON_WINNER,
    `${SOURCES} serve (http): flag=A + config=B: ${BOTH}`,
  ),
  entry(
    "daemon set back to first-wins (namedRelayUrl): serve http, flag=A + env=B",
    DAEMON_ALL,
    DAEMON_WINNER,
    `${SOURCES} serve (http): flag=A + env=B: ${BOTH}`,
  ),
  entry(
    "daemon set back to first-wins (namedRelayUrl): serve stdio, env=A + config=B",
    DAEMON_ALL,
    DAEMON_WINNER,
    `${SOURCES} serve (stdio): env=A + config=B: ${BOTH}`,
  ),
  entry(
    "daemon set back to first-wins (namedRelayUrl): serve stdio, config B saved mid-session under env A",
    DAEMON_ALL,
    DAEMON_WINNER,
    `${SOURCES} serve (stdio): started with env=A, config B saved by another process mid-session: B is asked on the next turn`,
  ),
  entry(
    'the saved config is dropped from the daemon\'s set (MOTEBIT_SYNC_URL="" + config)',
    DAEMON_ALL,
    DAEMON_NO_SAVED_CONFIG,
    `${DAEMON} MOTEBIT_SYNC_URL="" + config sync_url: the daemon names no relay, the config relay is still asked, a failed pull withholds`,
  ),
  entry(
    "the notice latch ignores which relay is failing (announces once until all recover)",
    "      if (failing !== announced) {\n",
    "      if (announced === null) {\n",
    `${FOLLOWS} A fails, then A recovers while B fails: announced again, naming B`,
  ),
  entry(
    "the presenter falls back to the environment when its caller gave no set",
    ASK_NOW,
    '      relayUrls = options.relayUrls?.() ?? [process.env["MOTEBIT_SYNC_URL"]];\n',
    `${UNION} no relayUrls given + a relay named only in the environment: nothing is fetched`,
  ),
  entry(
    "merged records are dropped (only the first relay's records are kept)",
    '  return { status: "ok", records: pulls.flatMap((p) => (p.status === "ok" ? p.records : [])) };\n',
    '  return { status: "ok", records: pulls[0]?.status === "ok" ? pulls[0].records : [] };\n',
    `${UNION} two relays, both ok: the records are merged (a revocation on either one refuses)`,
  ),
  entry(
    "the raw error text is restored in the failure reason",
    THROWN_FAILED,
    "    return failed(err instanceof Error ? err.message : String(err));\n",
    `${REASON} a thrown error quoting the credentialed URL: host only, a fixed word`,
  ),
];

void runTampers(TAMPERS, { root: ROOT });
