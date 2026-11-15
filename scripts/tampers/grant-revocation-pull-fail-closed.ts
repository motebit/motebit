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
 *   - the once-per-session latch removed (not a safety property: calm).
 *
 *   npx tsx scripts/tampers/grant-revocation-pull-fail-closed.ts
 *   (plain `node` cannot resolve the runner's `.js` import specifier)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = "apps/cli/src/subcommands/grant.ts";
const PKG = "motebit";
const TEST = "src/__tests__/grant-presenter-pull-fail-closed.test.ts";

const PRESENTER = "revocation pull: a failed pull presents no grant";
const CHAT =
  "revocation pull: the runtime path (owner chat turn) failed pull: the R4 call does not auto-execute — it pauses for approval, zero payments built";
const DIRECT =
  "revocation pull: serve --direct --grant inherits it failed pull: the R4 task is refused and the tool never runs";

function entry(name: string, from: string, to: string, red: string): TamperEntry {
  return { name, edits: [{ file: SRC, from, to }], pkg: PKG, test: TEST, red };
}

const THROWN_FAILED =
  '    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };\n';
const THROWN_EMPTY = '    return { status: "ok", records: [] };\n';

const WITHHOLD = '      return { status: "withheld", reason: "revocation_unconfirmed" };\n';

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
    "the non-2xx check is dropped (HTTP 429 with a feed-shaped body)",
    '    if (!res.ok) return { status: "failed", reason: `HTTP ${res.status}` };\n',
    "",
    `${PRESENTER} HTTP 429 with a feed-shaped body: no grant is presented`,
  ),
  entry(
    "the non-2xx check is dropped (owner chat turn, real runtime)",
    '    if (!res.ok) return { status: "failed", reason: `HTTP ${res.status}` };\n',
    '    if (!res.ok) return { status: "ok", records: [] };\n',
    CHAT,
  ),
  entry(
    "a 200 body that is not the feed is read as an empty feed",
    '      return { status: "failed", reason: "response is not a revocation feed" };\n',
    '      return { status: "ok", records: [] };\n',
    `${PRESENTER} a 200 body with no records array: no grant is presented`,
  ),
  entry(
    "the once-per-session notice latch is removed",
    "        notified = true;\n",
    "",
    "revocation pull: the notice fires once per session several failed-pull turns call onRevocationUnconfirmed exactly once",
  ),
];

void runTampers(TAMPERS, { root: ROOT });
