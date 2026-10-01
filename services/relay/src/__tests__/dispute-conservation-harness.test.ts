/**
 * Dispute conservation harness — exhaustive differential over the REAL routes.
 *
 * A dispute moves money out of ONE allocation. Whatever sequence of filings,
 * verdicts, appeals and appeal-window expiries the parties and the operator
 * produce, the escrow is paid out at most once. Two money findings in the
 * dispute path (filer authority, then one allocation paying out repeatedly)
 * both broke that, and neither was visible to a single-scenario test. So this
 * file enumerates every action sequence up to length {@link MAX_DEPTH} from
 * every allocation starting state, drives each step through the real HTTP
 * routes, and checks the conservation law after EVERY step:
 *
 *   L1  payout ≤ locked. For the allocation: every credit/debit the ledger
 *       recorded after the delegator's lock (settlement payout, refund,
 *       dispute redistribution; the platform fee is part of the settlement
 *       payout) sums to at most what the delegator actually locked.
 *   L2  Each dispute-driven ledger row references exactly one dispute, and
 *       the rows of at most one dispute per allocation move money.
 *   L3  An allocation is resolved by at most one fund action: at most one
 *       dispute on it reaches `final` (legacy duplicate rows a start state
 *       already holds are counted as given, never as licence for more).
 *   L4  A rejected request (non-2xx) writes nothing to the ledger.
 *
 * Alphabet: delegator files, worker files, operator upholds / overturns /
 * splits dispute k (fund_action + split_ratio per dispute-v1 §7.2 from the
 * filer role), the losing side appeals dispute k (§8; single-relay appeals
 * park in `appealed`), and the appeal window expires (every `resolved`
 * dispute is back-dated 25h and read — the lazy-finalize path, §3.3). Time is
 * the only thing the harness moves by hand; every fund movement is the
 * relay's own.
 *
 * Starting states: locked (pre-settlement escrow), settled (relay-custody,
 * through the real receipt route), released (refunded by the real stale-
 * allocation releaser), p2p settled (trust-layer only, zero escrow), disputed
 * (locked + one delegator dispute already filed), and legacy duplicates
 * (locked or settled + two live disputes a pre-fix relay admitted, with the
 * one-dispute-per-task index unbuildable) — the state in which only the
 * fund-movement chokepoint stands between the escrow and a second payout.
 *
 * Enumeration is a memoized DFS over normalized observable states (see
 * `fingerprint`): a step that is rejected, or accepted but changes nothing
 * observable, is a leaf — its continuations equal the parent's, which are
 * enumerated anyway — and a state already expanded with at least the same
 * remaining depth is not expanded again. Every sequence up to the depth is
 * thereby covered, each distinct state once. A world (fresh relay + replayed
 * prefix) is rebuilt only after a step that changed the state. Aperture: the federation (§6.2) resolution/appeal path needs
 * peer relays and is not driven here; it shares the fund-movement chokepoint
 * this harness exercises.
 */
import { appendFileSync } from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";
import type { SyncRelay } from "../index.js";
import { releaseStaleAllocations } from "../index.js";
import {
  generateKeypair,
  bytesToHex,
  signDisputeRequest,
  signDisputeAppeal,
  signExecutionReceipt,
  hash as sha256,
} from "@motebit/encryption";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import { AUTH_HEADER, JSON_AUTH, createTestRelay, seedX402PaidTask } from "./test-helpers.js";

const MAX_DEPTH = Number(process.env.DISPUTE_HARNESS_DEPTH ?? 6);
const DELEGATOR = "del-cons";
const WORKER = "wrk-cons";

type Keypair = { publicKey: Uint8Array; privateKey: Uint8Array };
type StartState =
  | "locked"
  | "settled"
  | "released"
  | "p2p"
  | "disputed"
  | "legacy-dup-locked"
  | "legacy-dup-settled";
type Action =
  | { kind: "fileD" }
  | { kind: "fileW" }
  | { kind: "upheld" | "overturned" | "split"; k: number }
  | { kind: "appeal"; k: number }
  | { kind: "expire" };

const START_STATES: StartState[] = [
  "locked",
  "settled",
  "released",
  "p2p",
  "disputed",
  "legacy-dup-locked",
  "legacy-dup-settled",
];

function label(a: Action): string {
  return "k" in a ? `${a.kind}(${a.k})` : a.kind;
}

interface World {
  relay: SyncRelay;
  taskId: string;
  allocationId: string;
  /** Dispute ids in filing order — the `k` of the alphabet. */
  disputes: string[];
  /** Live disputes the start state already held (legacy duplicates). */
  startLive: number;
}

interface Violation {
  start: StartState;
  sequence: string;
  law: string;
  detail: string;
}

let delegatorKp: Keypair;
let workerKp: Keypair;
let seq = 0;

async function register(relay: SyncRelay, motebitId: string, kp: Keypair): Promise<void> {
  const res = await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: bytesToHex(kp.publicKey),
    }),
  });
  if (res.status !== 200) throw new Error(`register ${motebitId}: ${res.status}`);
}

async function settleViaReceipt(relay: SyncRelay, taskId: string): Promise<void> {
  const enc = new TextEncoder();
  const receipt = await signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: WORKER as unknown as MotebitId,
      device_id: "svc" as unknown as DeviceId,
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: "completed" as const,
      result: "done",
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: await sha256(enc.encode("search for something")),
      result_hash: await sha256(enc.encode("done")),
    },
    workerKp.privateKey,
  );
  const res = await relay.app.request(`/agent/${WORKER}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(receipt),
  });
  if (res.status !== 200) throw new Error(`receipt: ${res.status} ${await res.text()}`);
}

async function fileDispute(w: World, by: "D" | "W"): Promise<Response> {
  seq += 1;
  const filedBy = by === "D" ? DELEGATOR : WORKER;
  const respondent = by === "D" ? WORKER : DELEGATOR;
  const disputeId = `dsp-cons-${seq}`;
  const signed = await signDisputeRequest(
    {
      dispute_id: disputeId,
      task_id: w.taskId,
      allocation_id: w.allocationId,
      filed_by: filedBy,
      respondent,
      category: "quality",
      description: "contested",
      evidence_refs: ["receipt-1"],
      filed_at: Date.now(),
    },
    (by === "D" ? delegatorKp : workerKp).privateKey,
  );
  const res = await w.relay.app.request(`/api/v1/allocations/${w.allocationId}/dispute`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(signed),
  });
  if (res.status === 200) w.disputes.push(disputeId);
  return res;
}

async function buildWorld(start: StartState): Promise<World> {
  const relay = await createTestRelay({ enableDeviceAuth: false });
  await register(relay, DELEGATOR, delegatorKp);
  await register(relay, WORKER, workerKp);
  if (start === "p2p") {
    const taskId = "task-p2p-cons";
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_settlements
         (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
          amount_settled, platform_fee, platform_fee_rate, status, settled_at,
          settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id)
         VALUES ('stl-p2p-cons', 'p2p-alloc-cons', ?, ?, '', 0, 0, 0, 'completed', ?,
                 'p2p', 'fakeTxHash', 'pending', ?)`,
      )
      .run(taskId, WORKER, Date.now(), DELEGATOR);
    return { relay, taskId, allocationId: "p2p-alloc-cons", disputes: [], startLive: 0 };
  }
  const taskId = seedX402PaidTask(relay, {
    workerId: WORKER,
    delegatorId: DELEGATOR,
    prompt: "search for something",
    unitCostUsd: 1.0,
  });
  const w: World = {
    relay,
    taskId,
    allocationId: `x402-${taskId}`,
    disputes: [],
    startLive: 0,
  };
  if (start === "settled" || start === "legacy-dup-settled") await settleViaReceipt(relay, taskId);
  if (start === "released") {
    const n = releaseStaleAllocations(relay.moteDb.db, Date.now() + 1000, 0, () => DELEGATOR);
    if (n !== 1) throw new Error(`release: ${n}`);
  }
  if (start === "disputed") {
    const res = await fileDispute(w, "D");
    if (res.status !== 200) throw new Error(`pre-dispute: ${res.status}`);
    w.startLive = 1;
  }
  if (start === "legacy-dup-locked" || start === "legacy-dup-settled") {
    // Two live disputes on one allocation, as a pre-fix relay admitted them:
    // the delegator's through the route, the worker's written in the route's
    // exact row shape. A database holding such rows cannot build the
    // one-dispute-per-task index (it is dropped here to model that), so the
    // fund-movement chokepoint is the only line left.
    const res = await fileDispute(w, "D");
    if (res.status !== 200) throw new Error(`pre-dispute: ${res.status}`);
    const db = relay.moteDb.db;
    db.exec("DROP INDEX IF EXISTS idx_disputes_one_per_task");
    const first = db
      .prepare("SELECT amount_locked, filing_fee FROM relay_disputes WHERE dispute_id = ?")
      .get(w.disputes[0]) as { amount_locked: number; filing_fee: number };
    seq += 1;
    const legacyId = `dsp-cons-${seq}`;
    db.prepare(
      `INSERT INTO relay_disputes
       (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state,
        amount_locked, filing_fee, filed_at, evidence_deadline, body_json, filer_role)
       VALUES (?, ?, ?, ?, ?, 'quality', 'contested', 'evidence', ?, ?, ?, ?, '', 'worker')`,
    ).run(
      legacyId,
      taskId,
      w.allocationId,
      WORKER,
      DELEGATOR,
      first.amount_locked,
      first.filing_fee,
      Date.now(),
      Date.now() + 48 * 3600_000,
    );
    w.disputes.push(legacyId);
    w.startLive = 2;
  }
  return w;
}

function filerOf(w: World, k: number): "delegator" | "worker" {
  const row = w.relay.moteDb.db
    .prepare("SELECT filed_by FROM relay_disputes WHERE dispute_id = ?")
    .get(w.disputes[k]) as { filed_by: string };
  return row.filed_by === WORKER ? "worker" : "delegator";
}

/** One step through the real routes. Returns the HTTP status (200 for expiry). */
async function step(w: World, a: Action): Promise<number> {
  const app = w.relay.app;
  switch (a.kind) {
    case "fileD":
      return (await fileDispute(w, "D")).status;
    case "fileW":
      return (await fileDispute(w, "W")).status;
    case "upheld":
    case "overturned":
    case "split": {
      // dispute-v1 §7.2: fund action from (resolution, filer_role).
      const workerWins =
        a.kind === "split" ? null : (a.kind === "upheld") === (filerOf(w, a.k) === "worker");
      const body =
        workerWins === null
          ? { resolution: "split", fund_action: "split", split_ratio: 0.5 }
          : workerWins
            ? { resolution: a.kind, fund_action: "release_to_worker", split_ratio: 1 }
            : { resolution: a.kind, fund_action: "refund_to_delegator", split_ratio: 0 };
      const res = await app.request(`/api/v1/disputes/${w.disputes[a.k]}/resolve`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ ...body, rationale: "operator verdict" }),
      });
      return res.status;
    }
    case "appeal": {
      const d = w.relay.moteDb.db
        .prepare("SELECT respondent FROM relay_disputes WHERE dispute_id = ?")
        .get(w.disputes[a.k]) as { respondent: string };
      const kp = d.respondent === WORKER ? workerKp : delegatorKp;
      const signed = await signDisputeAppeal(
        {
          dispute_id: w.disputes[a.k]!,
          appealed_by: d.respondent,
          reason: "disagree",
          appealed_at: Date.now(),
        },
        kp.privateKey,
      );
      const res = await app.request(`/api/v1/disputes/${w.disputes[a.k]}/appeal`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(signed),
      });
      return res.status;
    }
    case "expire": {
      const past = Date.now() - 25 * 60 * 60 * 1000;
      w.relay.moteDb.db
        .prepare(
          "UPDATE relay_disputes SET resolved_at = ? WHERE state = 'resolved' AND appealed_at IS NULL",
        )
        .run(past);
      for (const id of w.disputes) {
        const res = await app.request(`/api/v1/disputes/${id}`, { headers: AUTH_HEADER });
        if (res.status !== 200) return res.status;
      }
      return 200;
    }
  }
}

function alphabet(w: World): Action[] {
  const out: Action[] = [{ kind: "fileD" }, { kind: "fileW" }, { kind: "expire" }];
  for (let k = 0; k < w.disputes.length; k++) {
    out.push({ kind: "upheld", k }, { kind: "overturned", k }, { kind: "split", k });
    out.push({ kind: "appeal", k });
  }
  return out;
}

/**
 * Observable state, normalized: parties as roles, dispute ids as their filing
 * index, random settlement ids erased. Two prefixes with the same fingerprint
 * have the same continuations, so a state is expanded once per remaining
 * depth budget (memoized DFS) — exhaustive over sequences, not over replays.
 */
function fingerprint(w: World): string {
  const db = w.relay.moteDb.db;
  const role = (id: string): string => (id === DELEGATOR ? "D" : id === WORKER ? "W" : "o");
  const ref = (id: string): string => {
    const k = w.disputes.indexOf(id);
    if (k >= 0) return `d${k}`;
    return id === w.allocationId ? "A" : "x";
  };
  const txns = (
    db
      .prepare(
        "SELECT motebit_id, type, amount, reference_id FROM relay_transactions ORDER BY rowid",
      )
      .all() as Array<{ motebit_id: string; type: string; amount: number; reference_id: string }>
  ).map((t) => `${role(t.motebit_id)}:${t.type}:${t.amount}:${ref(t.reference_id)}`);
  const alloc = db
    .prepare("SELECT status FROM relay_allocations WHERE allocation_id = ?")
    .get(w.allocationId) as { status: string } | undefined;
  const disputes = w.disputes.map((id) => {
    const d = db
      .prepare(
        "SELECT filed_by, state, appealed_at, fund_action, split_ratio FROM relay_disputes WHERE dispute_id = ?",
      )
      .get(id) as {
      filed_by: string;
      state: string;
      appealed_at: number | null;
      fund_action: string | null;
      split_ratio: number | null;
    };
    return `${role(d.filed_by)}:${d.state}:${d.appealed_at != null}:${d.fund_action}:${d.split_ratio}`;
  });
  return JSON.stringify({ txns, alloc: alloc?.status ?? null, disputes });
}

function txnCount(w: World): number {
  return (
    w.relay.moteDb.db.prepare("SELECT COUNT(*) AS n FROM relay_transactions").get() as {
      n: number;
    }
  ).n;
}

/** L1–L3 over the current state. */
function checkLaws(w: World): Array<{ law: string; detail: string }> {
  const db = w.relay.moteDb.db;
  const out: Array<{ law: string; detail: string }> = [];
  const txns = db
    .prepare("SELECT motebit_id, type, amount, reference_id FROM relay_transactions")
    .all() as Array<{ motebit_id: string; type: string; amount: number; reference_id: string }>;

  // What the delegator actually locked: the allocation_hold debits.
  const locked = -txns
    .filter((t) => t.type === "allocation_hold" && t.reference_id === w.allocationId)
    .reduce((s, t) => s + t.amount, 0);
  // Everything after the lock, net, across every account (deposits are the
  // delegator's external money in; the hold is the lock itself).
  const ledgerOut = txns
    .filter((t) => t.type !== "deposit" && t.type !== "allocation_hold")
    .reduce((s, t) => s + t.amount, 0);
  // The platform fee leaves escrow as part of the settlement payout.
  const fees = (
    db
      .prepare(
        "SELECT COALESCE(SUM(platform_fee), 0) AS f FROM relay_settlements WHERE COALESCE(settlement_mode, 'relay') = 'relay'",
      )
      .get() as { f: number }
  ).f;
  const paidOut = ledgerOut + fees;
  if (paidOut > locked) {
    out.push({
      law: "L1 payout<=locked",
      detail: `paid out ${paidOut} (ledger ${ledgerOut} + fee ${fees}) from ${locked} locked`,
    });
  }

  const disputeIds = new Set(
    (
      db
        .prepare("SELECT dispute_id FROM relay_disputes WHERE allocation_id = ?")
        .all(w.allocationId) as Array<{ dispute_id: string }>
    ).map((r) => r.dispute_id),
  );
  const moving = new Set(
    txns.filter((t) => disputeIds.has(t.reference_id)).map((t) => t.reference_id),
  );
  if (moving.size > 1) {
    out.push({
      law: "L2 one-dispute-moves-money",
      detail: `${moving.size} disputes moved money: ${[...moving].join(",")}`,
    });
  }

  const finals = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM relay_disputes WHERE allocation_id = ? AND state = 'final'",
      )
      .get(w.allocationId) as { n: number }
  ).n;
  // A start state that already held N live disputes (legacy rows) cannot be
  // made to have fewer; the law is that resolution adds no further one.
  if (finals > Math.max(1, w.startLive)) {
    out.push({ law: "L3 one-fund-action", detail: `${finals} disputes reached final` });
  }
  return out;
}

interface Stats {
  /** Distinct (state, remaining-depth) nodes expanded. */
  states: number;
  /** Transitions driven (each one a fresh relay replaying its prefix). */
  transitions: number;
  violations: Violation[];
  /** fingerprint → largest remaining depth already expanded from it. */
  seen: Map<string, number>;
}

async function replay(start: StartState, prefix: Action[]): Promise<World> {
  const w = await buildWorld(start);
  for (const a of prefix) await step(w, a);
  return w;
}

async function explore(
  start: StartState,
  prefix: Action[],
  fp: string,
  actions: Action[],
  stats: Stats,
  given: World | null,
): Promise<void> {
  const remaining = MAX_DEPTH - prefix.length;
  if (remaining <= 0 || (stats.seen.get(fp) ?? 0) >= remaining) {
    if (given) await given.relay.close();
    return;
  }
  stats.seen.set(fp, remaining);
  stats.states += 1;

  // `w` is a world standing in this node's state. A step that leaves the
  // state unchanged (rejected, or a no-op) keeps it for the next sibling; a
  // step that changes it hands the world to the child and the next sibling
  // replays the prefix on a fresh relay.
  let w = given;
  for (const a of actions) {
    w ??= await replay(start, prefix);
    const txBefore = txnCount(w);
    const status = await step(w, a);
    stats.transitions += 1;
    const sequence = [...prefix, a].map(label).join(" → ");
    if (status >= 300 && txnCount(w) !== txBefore) {
      stats.violations.push({
        start,
        sequence,
        law: "L4 rejected-writes-nothing",
        detail: `HTTP ${status} appended ledger rows`,
      });
    }
    const broken = checkLaws(w);
    for (const v of broken) stats.violations.push({ start, sequence, ...v });
    const childFp = fingerprint(w);
    if (childFp === fp) continue;
    // A rejected step's continuations are the parent's (enumerated here); a
    // state that already breaks the law is a counterexample and adds none.
    if (status < 300 && broken.length === 0) {
      // Alphabet depends on the prefix (k ranges over disputes filed so far).
      await explore(start, [...prefix, a], childFp, alphabet(w), stats, w);
    } else {
      await w.relay.close();
    }
    w = null;
  }
  if (w) await w.relay.close();
}

describe("Dispute conservation harness (exhaustive, real routes)", () => {
  beforeAll(async () => {
    delegatorKp = await generateKeypair();
    workerKp = await generateKeypair();
  });

  for (const start of START_STATES) {
    it(`conserves escrow from a ${start} allocation over every sequence ≤ ${MAX_DEPTH}`, async () => {
      const stats: Stats = { states: 0, transitions: 0, violations: [], seen: new Map() };
      // The starting state itself must already satisfy the law.
      const w0 = await buildWorld(start);
      for (const v of checkLaws(w0)) stats.violations.push({ start, sequence: "∅", ...v });
      await explore(start, [], fingerprint(w0), alphabet(w0), stats, w0);

      // Shortest counterexample per law first.
      const byLaw = new Map<string, Violation>();
      for (const v of stats.violations) {
        const prev = byLaw.get(v.law);
        if (!prev || v.sequence.length < prev.sequence.length) byLaw.set(v.law, v);
      }
      const report = [...byLaw.values()]
        .map((v) => `[${v.law}] ${v.start}: ${v.sequence} — ${v.detail}`)
        .join("\n");
      const summary = `[conservation] ${start}: ${stats.states} states, ${stats.transitions} transitions, ${stats.violations.length} violations${report ? `\n${report}` : ""}`;
      console.info(summary);
      // Opt-in record of the explored size (vitest hides passing tests' logs).
      const statsFile = process.env.DISPUTE_HARNESS_STATS;
      if (statsFile) appendFileSync(statsFile, `${summary}\n`);
      expect(stats.transitions).toBeGreaterThan(0);
      expect(report).toBe("");
    }, 600_000);
  }
});
