/**
 * relay-federation@1.5 §3.1 — peer row authority, exhaustively.
 *
 * The invariant (see docs/design/identity-authority-writers.md, Inc 1 note
 * "Peer row authority"): for a relay_id that was ever confirmed (`peered_at`
 * set), no unauthenticated request changes its `public_key` or
 * `endpoint_url`, or moves its `state` to `active` or `pending`. Those move
 * only on a message verified under the peer's CURRENT stored key (a v2
 * heartbeat or remove, a verified heartbeat-ack, a confirm signed under the
 * stored key) or by the operator. The peer that holds its key always
 * recovers — re-handshakes to `active` at its own endpoint — within a bounded
 * number of steps and at most one cooldown period, whatever an attacker did
 * first, so no attacker action creates or extends a lockout. A relay_id never
 * confirmed has no row (a propose records only a pending handshake) and is
 * not asserted on here — `federation-handshake-model.test.ts` model-checks it.
 *
 * Two findings of the same class preceded this harness (an unauthenticated
 * propose replacing a known peer's key; a same-key propose redirecting a
 * suspended peer's endpoint and locking it out). This enumerates instead of
 * patching: initial state × every action sequence up to length 3, checked
 * after every step, then a bounded recovery by the real peer.
 *
 * Relay B is the subject; relay A is the legitimate peer (its identity, its
 * operator's confirm route); the attacker holds only A's PUBLIC key and its
 * own keypair. Time is driven through `Date.now`, so the per-peer limiter,
 * the removed-peer cooldown, v2 freshness and handshake expiry all move with
 * the harness clock.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bytesToHex, generateKeypair } from "@motebit/encryption";

import type { SyncRelay } from "../index.js";
import {
  initRelayIdentity,
  peerRowTransition,
  readPeerRow,
  sendHeartbeats,
  writePeerRow,
  type PeerRow,
  type PeerRowWrite,
  type PeerWriteAuthority,
  type RelayIdentity,
} from "../federation.js";
import { setLogLevel } from "../logger.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import {
  ackingFetch,
  heartbeatRequest,
  operatorConfirm,
  signedConfirm,
  type ConfirmRequest,
  removeRequest,
} from "./federation-messages.js";
import {
  COUNTER_TRUST_COLUMNS,
  PEER_ROW_WRITER,
  scanPeerRowWrites,
} from "./peer-row-writer-scan.js";

const URL_A = "http://relay-a.authority.test:3000";
const URL_B = "http://relay-b.authority.test:3001";
const ATTACKER_URL = "http://attacker.authority.test:3666";
const COOLDOWN_STEP_MS = 6 * 60 * 1000; // one removed-peer cooldown (5 min) + margin

const rand = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

const ACTIONS = [
  "AP_SAME", // attacker propose: A's (public) key, attacker endpoint
  "AP_DIFF", // attacker propose: attacker key, attacker endpoint
  "AC_GOOD", // attacker confirm: valid under the ATTACKER key, for the nonce it was given
  "AC_BAD", // attacker confirm: garbage signature
  "LP", // legit propose: A's key, A's endpoint
  "LC", // legit confirm: A's operator signs the nonce A was given
  "HB_L", // v2 heartbeat from A, signed by A
  "HB_F", // v2 heartbeat naming A as sender, signed by the attacker
  "RM_L", // v2 peer-remove from A, signed by A
  "RM_F", // v2 peer-remove naming A, signed by the attacker
  "TICK_OK", // B's outbound heartbeat tick; A's endpoint acks under A's key
  "TICK_FAIL", // B's outbound heartbeat tick; nobody answers
  "TICK_RACE", // B's tick; an AP_SAME lands while the tick awaits A's ack
  "TIME", // the clock advances one cooldown period
] as const;
type Action = (typeof ACTIONS)[number];

/** Actions that carry no proof under A's stored key. */
const UNAUTHENTICATED: ReadonlySet<Action> = new Set([
  "AP_SAME",
  "AP_DIFF",
  "AC_GOOD",
  "AC_BAD",
  "HB_F",
  "RM_F",
]);

const INITIAL = ["none", "pending", "active", "suspended", "removed"] as const;
type Initial = (typeof INITIAL)[number];

const MAX_LEN = 3;

type Row = Record<string, unknown> & {
  public_key: string;
  endpoint_url: string;
  state: string;
  peered_at: number | null;
};

let a: SyncRelay;
let b: SyncRelay;
let idA: RelayIdentity;
let idB: RelayIdentity;
let attacker: { privateKey: Uint8Array; publicKeyHex: string };
let confirmedTemplate: Row;
let clockOffset = 0;
let ipSeq = 0;

const neverFetch = (): Promise<Response> => new Promise<Response>(() => {});

function rowOfA(): Row | undefined {
  return b.moteDb.db
    .prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ?")
    .get(idA.relayMotebitId) as Row | undefined;
}

async function post(path: string, body: unknown): Promise<Response> {
  ipSeq++;
  return b.app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`,
    },
    body: JSON.stringify(body),
  });
}

function propose(publicKeyHex: string, endpoint: string): Promise<Response> {
  return post("/federation/v1/peer/propose", {
    relay_id: idA.relayMotebitId,
    public_key: publicKeyHex,
    endpoint_url: endpoint,
    nonce: rand(),
  });
}

function confirm(req: ConfirmRequest): Promise<Response> {
  return post("/federation/v1/peer/confirm", req);
}

/** A v2 confirm naming A as sender, to B, for `endpoint`, signed by the attacker. */
function attackerConfirm(nonce: string, endpoint = ATTACKER_URL): Promise<ConfirmRequest> {
  return signedConfirm({
    sender: idA.relayMotebitId,
    recipient: idB.relayMotebitId,
    recipientPublicKey: idB.publicKeyHex,
    nonce,
    endpointUrl: endpoint,
    privateKey: attacker.privateKey,
  });
}

/** Seed A's row at B for one cell. Every confirmed state shares one handshake's row. */
function seed(initial: Initial): void {
  const db = b.moteDb.db;
  db.prepare("DELETE FROM relay_peers WHERE peer_relay_id = ?").run(idA.relayMotebitId);
  if (initial === "none") return;
  const now = Date.now();
  const row: Row = {
    ...confirmedTemplate,
    state: initial,
    nonce: initial === "pending" ? rand() : null,
    missed_heartbeats: initial === "suspended" ? 3 : initial === "removed" ? 5 : 0,
    last_heartbeat_at: now,
    peered_at: now - 60_000,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO relay_peers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...cols.map((k) => row[k] as never));
}

interface Cell {
  initial: Initial;
  seq: Action[];
}

interface CellState {
  legitNonce: string | null;
  attackerNonce: string | null;
  /** A's relay_id has been confirmed under A's key (seeded, or a legit LC landed). */
  confirmedByLegit: boolean;
  /** First-come: the attacker confirmed A's never-confirmed relay_id under its own key. */
  attackerOwned: boolean;
}

function ackFetchFor(urlOk: (url: string) => boolean, before?: () => Promise<void>) {
  const ack = ackingFetch(new Map([[idA.relayMotebitId, idA.privateKey]]), idB.publicKeyHex);
  return async (input: unknown, init?: RequestInit): Promise<Response> => {
    if (before) await before();
    const url = String(input);
    if (!urlOk(url)) throw new Error(`unreachable: ${url}`);
    return ack(input, init);
  };
}

async function runAction(action: Action, s: CellState): Promise<number | null> {
  switch (action) {
    case "AP_SAME":
    case "AP_DIFF": {
      const key = action === "AP_SAME" ? idA.publicKeyHex : attacker.publicKeyHex;
      const res = await propose(key, ATTACKER_URL);
      if (res.status === 200) s.attackerNonce = ((await res.json()) as { nonce: string }).nonce;
      return res.status;
    }
    case "AC_GOOD": {
      const nonce = s.attackerNonce ?? ((rowOfA()?.nonce as string | null) || rand());
      const res = await confirm(await attackerConfirm(nonce));
      if (
        res.status === 200 &&
        rowOfA()?.public_key === attacker.publicKeyHex &&
        !s.confirmedByLegit
      )
        s.attackerOwned = true;
      return res.status;
    }
    case "AC_BAD": {
      // A well-formed v2 confirm whose signature is garbage.
      const req = await attackerConfirm(s.attackerNonce ?? rand());
      return (await confirm({ ...req, message: { ...req.message, signature: rand() + rand() } }))
        .status;
    }
    case "LP": {
      const res = await propose(idA.publicKeyHex, URL_A);
      if (res.status === 200) s.legitNonce = ((await res.json()) as { nonce: string }).nonce;
      return res.status;
    }
    case "LC": {
      if (s.legitNonce === null) return null;
      const res = await confirm(
        await operatorConfirm(a, s.legitNonce, AUTH_HEADER, {
          id: idB.relayMotebitId,
          publicKey: idB.publicKeyHex,
        }),
      );
      if (res.status === 200) {
        s.legitNonce = null;
        if (rowOfA()?.public_key === idA.publicKeyHex) s.confirmedByLegit = true;
      }
      return res.status;
    }
    case "HB_L":
    case "HB_F": {
      const req = await heartbeatRequest({
        sender: idA.relayMotebitId,
        recipient: idB.relayMotebitId,
        recipientPublicKey: idB.publicKeyHex,
        privateKey: action === "HB_L" ? idA.privateKey : attacker.privateKey,
      });
      return (await post("/federation/v1/peer/heartbeat", req)).status;
    }
    case "RM_L":
    case "RM_F": {
      const req = await removeRequest({
        sender: idA.relayMotebitId,
        recipient: idB.relayMotebitId,
        recipientPublicKey: idB.publicKeyHex,
        privateKey: action === "RM_L" ? idA.privateKey : attacker.privateKey,
      });
      return (await post("/federation/v1/peer/remove", req)).status;
    }
    case "TICK_OK":
      await sendHeartbeats(
        b.moteDb.db,
        idB,
        ackFetchFor((u) => u.startsWith(URL_A)),
      );
      return null;
    case "TICK_FAIL":
      await sendHeartbeats(
        b.moteDb.db,
        idB,
        ackFetchFor(() => false),
      );
      return null;
    case "TICK_RACE": {
      let raced = false;
      await sendHeartbeats(
        b.moteDb.db,
        idB,
        ackFetchFor(
          (u) => u.startsWith(URL_A),
          async () => {
            if (raced) return;
            raced = true;
            const res = await propose(idA.publicKeyHex, ATTACKER_URL);
            if (res.status === 200)
              s.attackerNonce = ((await res.json()) as { nonce: string }).nonce;
          },
        ),
      );
      return null;
    }
    case "TIME":
      clockOffset += COOLDOWN_STEP_MS;
      return null;
  }
}

function healthy(): boolean {
  const row = rowOfA();
  return (
    row !== undefined &&
    row.state === "active" &&
    row.public_key.toLowerCase() === idA.publicKeyHex.toLowerCase() &&
    row.endpoint_url === URL_A
  );
}

/**
 * The real peer re-handshakes: at most two rounds of propose + confirm with
 * ONE cooldown period between them. Anything slower is a lockout the
 * attacker created or extended.
 */
async function recover(s: CellState): Promise<string | null> {
  const trail: string[] = [];
  for (let round = 0; round < 2; round++) {
    if (healthy()) return null;
    s.legitNonce = null;
    const lp = await runAction("LP", s);
    trail.push(`LP=${lp}`);
    if (lp === 200) trail.push(`LC=${await runAction("LC", s)}`);
    if (healthy()) return null;
    if (round === 0) await runAction("TIME", s);
  }
  const row = rowOfA();
  return `no recovery (${trail.join(" ")}; row ${row ? `${row.state} @ ${row.endpoint_url}` : "absent"})`;
}

async function runCell(cell: Cell): Promise<string[]> {
  clockOffset += 60 * 60 * 1000; // a fresh hour: limiter windows, nonces and handshakes from earlier cells are past
  seed(cell.initial);
  const s: CellState = {
    legitNonce: null,
    attackerNonce: null,
    confirmedByLegit: cell.initial !== "none",
    attackerOwned: false,
  };
  const out: string[] = [];
  for (let i = 0; i < cell.seq.length; i++) {
    const action = cell.seq[i]!;
    const guarded = s.confirmedByLegit && !s.attackerOwned;
    const before = rowOfA();
    const status = await runAction(action, s);
    if (status !== null && status >= 500) out.push(`step ${i + 1} ${action}: HTTP ${status}`);
    if (!guarded) continue;
    const after = rowOfA();
    const at = `step ${i + 1} ${action}`;
    if (after === undefined) {
      out.push(`${at}: confirmed row deleted`);
      break;
    }
    if (after.public_key.toLowerCase() !== idA.publicKeyHex.toLowerCase())
      out.push(`${at}: public_key replaced`);
    if (after.endpoint_url !== URL_A) out.push(`${at}: endpoint_url → ${after.endpoint_url}`);
    if (
      UNAUTHENTICATED.has(action) &&
      before !== undefined &&
      after.state !== before.state &&
      (after.state === "active" || after.state === "pending")
    )
      out.push(`${at}: unauthenticated ${before.state} → ${after.state}`);
    if (out.length > 0) break;
  }
  if (out.length === 0 && s.confirmedByLegit && !s.attackerOwned) {
    const failed = await recover(s);
    if (failed) out.push(failed);
  }
  return out;
}

function* sequences(maxLen: number): Generator<Action[]> {
  yield [];
  let layer: Action[][] = [[]];
  for (let len = 1; len <= maxLen; len++) {
    const next: Action[][] = [];
    for (const prefix of layer) for (const act of ACTIONS) next.push([...prefix, act]);
    yield* next;
    layer = next;
  }
}

beforeAll(async () => {
  // ~10^5 requests: the relay's info/warn lines would bury the cell report.
  setLogLevel("error");
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  a = await createTestRelay({
    enableDeviceAuth: false,
    federation: { endpointUrl: URL_A, displayName: "Relay A" },
    federationPeerFetch: neverFetch,
  });
  b = await createTestRelay({
    enableDeviceAuth: false,
    federation: { endpointUrl: URL_B, displayName: "Relay B" },
    federationPeerFetch: neverFetch,
  });
  idA = await initRelayIdentity(a.moteDb.db);
  idB = await initRelayIdentity(b.moteDb.db);
  const kp = await generateKeypair();
  attacker = { privateKey: kp.privateKey, publicKeyHex: bytesToHex(kp.publicKey) };

  // One real handshake at B for A gives the confirmed row every cell seeds from.
  const s: CellState = {
    legitNonce: null,
    attackerNonce: null,
    confirmedByLegit: false,
    attackerOwned: false,
  };
  expect(await runAction("LP", s)).toBe(200);
  expect(await runAction("LC", s)).toBe(200);
  confirmedTemplate = rowOfA()!;
  expect(confirmedTemplate.state).toBe("active");
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  setLogLevel("info");
  await a?.close();
  await b?.close();
});

describe("peer row authority — exhaustive (initial state × action sequences ≤ 3)", () => {
  for (const initial of INITIAL) {
    it(
      `initial ${initial}`,
      async () => {
        const failures: string[] = [];
        let cells = 0;
        for (const seq of sequences(MAX_LEN)) {
          cells++;
          const out = await runCell({ initial, seq });
          if (out.length > 0) failures.push(`[${initial}] ${seq.join(",") || "∅"} — ${out[0]}`);
        }
        if (failures.length > 0) {
          const byKind = new Map<string, number>();
          for (const f of failures) {
            const kind = f.replace(/^.*? — (step \d+ \w+: )?/, "").replace(/ \(.*$/, "");
            byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
          }
          console.log(
            `[peer-row-authority] initial ${initial}: ${failures.length}/${cells} cells fail\n` +
              [...byKind].map(([k, n]) => `  ${n} × ${k}`).join("\n") +
              "\n  first:\n" +
              failures
                .slice(0, 12)
                .map((f) => `    ${f}`)
                .join("\n"),
          );
        }
        expect(
          failures.length,
          `${failures.length}/${cells} cells violate peer row authority; first:\n${failures
            .slice(0, 20)
            .join("\n")}`,
        ).toBe(0);
      },
      30 * 60 * 1000,
    );
  }
});

describe("an unauthenticated flood cannot rate-limit the real peer out", () => {
  for (const initial of ["pending", "active", "suspended", "removed"] as const) {
    it(`initial ${initial}: 40 attacker proposes + 40 bad confirms, then the peer recovers`, async () => {
      clockOffset += 60 * 60 * 1000;
      seed(initial);
      // A removed row's cooldown is the peer's own, not the attacker's: start past it.
      if (initial === "removed") clockOffset += COOLDOWN_STEP_MS;
      const s: CellState = {
        legitNonce: null,
        attackerNonce: null,
        confirmedByLegit: true,
        attackerOwned: false,
      };
      for (let i = 0; i < 40; i++) {
        await runAction("AP_SAME", s);
        await runAction("AC_BAD", s);
      }
      if (initial === "active") {
        expect(healthy()).toBe(true);
        return;
      }
      expect(await runAction("LP", s)).toBe(200);
      expect(await runAction("LC", s)).toBe(200);
      expect(healthy()).toBe(true);
    });
  }
});

/** Every column the guarded writer compares the row against. */
const COMPARED: ReadonlyArray<[keyof PeerRow, unknown]> = [
  ["public_key", "ab".repeat(32)],
  ["endpoint_url", ATTACKER_URL],
  ["state", "removed"],
  ["nonce", "n-other"],
  ["peered_at", 1],
  ["last_heartbeat_at", 2],
  ["missed_heartbeats", 4],
];

describe("writePeerRow: a write decided on a stale read never lands", () => {
  for (const [col, value] of COMPARED) {
    for (const op of ["update", "delete"] as const) {
      it(`${op} after ${col} changed under it`, () => {
        clockOffset += 60 * 60 * 1000;
        seed("suspended");
        const db = b.moteDb.db;
        // A never-confirmed read, so authority never refuses: only the compare-and-set can.
        db.prepare("UPDATE relay_peers SET peered_at = NULL WHERE peer_relay_id = ?").run(
          idA.relayMotebitId,
        );
        const read = readPeerRow(db, idA.relayMotebitId)!;
        db.prepare(`UPDATE relay_peers SET ${col} = ? WHERE peer_relay_id = ?`).run(
          value as never,
          idA.relayMotebitId,
        );
        const now = rowOfA();
        const write: PeerRowWrite =
          op === "delete" ? { op } : { op, row: { ...read, state: "active", nonce: null } };
        expect(writePeerRow(db, read, write, "peer-key")).toBe(false);
        expect(rowOfA()).toEqual(now);
      });
    }
  }
});

describe("peerRowTransition: every (row, write, authority) against the invariant", () => {
  const AUTHORITIES: PeerWriteAuthority[] = ["unauthenticated", "observed", "peer-key"];
  const STATES = ["pending", "active", "suspended", "removed"];
  const base = (state: string, peered: boolean): PeerRow => ({
    peer_relay_id: "relay-x",
    public_key: "aa".repeat(32),
    endpoint_url: URL_A,
    display_name: null,
    state,
    nonce: null,
    peered_at: peered ? 1000 : null,
    last_heartbeat_at: 1000,
    missed_heartbeats: 0,
    agent_count: 0,
    peer_protocol_version: null,
    handshake_protocol_version: null,
  });
  const CHANGES: Array<[string, (r: PeerRow) => PeerRow]> = [
    ["nothing", (r) => ({ ...r })],
    ["counters", (r) => ({ ...r, missed_heartbeats: r.missed_heartbeats + 1, agent_count: 7 })],
    ["key", (r) => ({ ...r, public_key: "bb".repeat(32) })],
    ["id", (r) => ({ ...r, peer_relay_id: "relay-y" })],
    ["endpoint", (r) => ({ ...r, endpoint_url: ATTACKER_URL })],
    ["peered_at", (r) => ({ ...r, peered_at: 2000 })],
    ["peered_at→null", (r) => ({ ...r, peered_at: null })],
    ...STATES.map((to): [string, (r: PeerRow) => PeerRow] => [
      `state→${to}`,
      (r) => ({ ...r, state: to }),
    ]),
  ];

  /** The invariant, stated independently of the code under test. */
  function allowed(
    before: PeerRow | undefined,
    write: PeerRowWrite,
    authority: PeerWriteAuthority,
  ): boolean {
    // A row is born only from a confirm verified under its key (§3.1).
    if (write.op === "insert")
      return before === undefined && write.row.peered_at !== null && authority === "peer-key";
    if (before === undefined) return false;
    // A never-confirmed row is inert: only a verified confirm replaces it.
    if (before.peered_at === null) return write.op === "delete" && authority === "peer-key";
    if (
      write.op === "update" &&
      (write.row.public_key !== before.public_key ||
        write.row.peer_relay_id !== before.peer_relay_id ||
        write.row.peered_at === null)
    )
      return false;
    if (write.op === "delete" || authority === "unauthenticated") return false;
    if (authority === "peer-key") return true;
    const n = write.row;
    const towardLive = n.state !== before.state && (n.state === "active" || n.state === "pending");
    return (
      n.endpoint_url === before.endpoint_url && n.peered_at === before.peered_at && !towardLive
    );
  }

  it("matches on every cell", () => {
    const mismatches: string[] = [];
    let cells = 0;
    for (const authority of AUTHORITIES) {
      for (const born of [base("pending", false), base("active", true)]) {
        const insert: PeerRowWrite = { op: "insert", row: born };
        for (const before of [undefined, base("pending", false)]) {
          cells++;
          if (
            (peerRowTransition(before, insert, authority) === null) !==
            allowed(before, insert, authority)
          )
            mismatches.push(
              `${authority} insert ${born.peered_at === null ? "unconfirmed" : "confirmed"} over ${before ? "row" : "nothing"}`,
            );
        }
      }
      for (const peered of [false, true]) {
        for (const state of STATES) {
          const before = base(state, peered);
          const writes: Array<[string, PeerRowWrite]> = [
            ["delete", { op: "delete" }],
            ...CHANGES.map(([n, f]): [string, PeerRowWrite] => [
              n,
              { op: "update", row: f(before) },
            ]),
          ];
          for (const [name, write] of writes) {
            cells++;
            const got = peerRowTransition(before, write, authority) === null;
            if (got !== allowed(before, write, authority))
              mismatches.push(
                `${authority} ${peered ? "confirmed" : "unconfirmed"} ${state} ${name}: code ${got ? "allows" : "refuses"}`,
              );
          }
        }
      }
    }
    expect(mismatches, `${mismatches.length}/${cells} cells`).toEqual([]);
  });
});

// ── Every relay_peers writer, statically ────────────────────────────────────
//
// The dynamic harness above proves `writePeerRow` keeps the invariant; this
// proves nothing else writes the row. Any SQL under services/relay/src that
// writes `relay_peers` outside `writePeerRow` is red, unless it is an UPDATE
// assigning only columns `COUNTER_TRUST_COLUMNS` names (each with a reason) —
// allowed by column, never by file.
describe("relay_peers writers: only writePeerRow writes authority columns", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  // Paths are given to the scanner repo-relative: the writer is recognised
  // only at exactly `PEER_ROW_WRITER.file`.
  const REPO = fileURLToPath(new URL("../../../..", import.meta.url));

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") out.push(...sources(p));
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
    }
    return out;
  }

  it("the relay source tree: every write is the writer or counter/trust-only", () => {
    const files = sources(SRC);
    const sites = files.flatMap((f) =>
      scanPeerRowWrites(relative(REPO, f).split("\\").join("/"), readFileSync(f, "utf8")),
    );
    const red = sites.filter((s) => s.refusal !== null);
    expect(
      red.map((s) => `${s.file}:${s.line} (${s.fn ?? "module"}) ${s.refusal} — ${s.sql}`),
    ).toEqual([]);
    // Aperture: the writer's three statements are seen, so the scan reads SQL at all.
    const writer = sites.filter((s) => s.fn === PEER_ROW_WRITER.fn);
    expect(writer.map((s) => s.verb).sort()).toEqual(["DELETE", "INSERT", "UPDATE"]);
    console.log(
      `relay_peers writers: ${files.length} files scanned, ${sites.length} write sites (${writer.length} in ${PEER_ROW_WRITER.fn}, ${sites.length - writer.length} counter/trust-only)`,
    );
  });

  // Tamper fixtures: each must be red. The scanner that misses one is the
  // scanner that would miss it in the tree.
  const RED: Array<[string, string, string]> = [
    [
      "a circuit-breaker suspend outside the writer",
      "task-routing.ts",
      `function f(db) { db.prepare("UPDATE relay_peers SET state = 'suspended' WHERE peer_relay_id = ?").run(id); }`,
    ],
    [
      "lowercase, no spaces",
      "a.ts",
      `const g = () => db.prepare("update relay_peers set state='active' where peer_relay_id=?");`,
    ],
    [
      "a quoted table",
      "a.ts",
      "db.prepare('UPDATE \"relay_peers\" SET endpoint_url = ? WHERE 1');",
    ],
    ["a bracketed table", "a.ts", 'db.prepare("UPDATE [relay_peers] SET public_key = ?");'],
    ["a schema prefix", "a.ts", 'db.prepare("UPDATE main.relay_peers SET peered_at = ?");'],
    ["a + chain", "a.ts", 'db.prepare("UPDATE relay_peers SET " + "public_key = ? WHERE x = ?");'],
    ["a parenthesised chain", "a.ts", 'db.prepare(("UPDATE relay_peers SET ") + ("nonce = ?"));'],
    [
      "an interpolated column (not statically known)",
      "a.ts",
      "db.prepare(`UPDATE relay_peers SET ${col} = ${col} + 1 WHERE endpoint_url = ?`);",
    ],
    [
      "a counter beside an authority column",
      "a.ts",
      'db.prepare("UPDATE relay_peers SET failed_forwards = 0, state = ? WHERE x = ?");',
    ],
    [
      "an authority column after a subquery's WHERE",
      "a.ts",
      'db.prepare("UPDATE relay_peers SET trust_score = (SELECT s FROM t WHERE k = 1), missed_heartbeats = 0");',
    ],
    [
      "a row-value target",
      "a.ts",
      'db.prepare("UPDATE relay_peers SET (trust_score, state) = (?, ?)");',
    ],
    [
      "an INSERT elsewhere",
      "a.ts",
      'db.prepare("INSERT INTO relay_peers (peer_relay_id) VALUES (?)");',
    ],
    [
      "an INSERT OR REPLACE elsewhere",
      "a.ts",
      'db.prepare("INSERT OR REPLACE INTO relay_peers (peer_relay_id) VALUES (?)");',
    ],
    ["a REPLACE INTO elsewhere", "a.ts", 'db.prepare("REPLACE INTO relay_peers VALUES (?)");'],
    [
      "a DELETE elsewhere",
      "a.ts",
      'db.prepare("DELETE FROM relay_peers WHERE peer_relay_id = ?");',
    ],
    [
      "a function named writePeerRow in another file",
      "task-routing.ts",
      'function writePeerRow() { db.prepare("UPDATE relay_peers SET state = ?"); }',
    ],
    [
      "a block comment between the verb and the table",
      "a.ts",
      "db.prepare(\"UPDATE/**/relay_peers SET state = 'active' WHERE peer_relay_id = ?\");",
    ],
    [
      "a line comment between the verb and the table",
      "a.ts",
      "db.prepare(`UPDATE -- a peer\n relay_peers SET state = 'active' WHERE peer_relay_id = ?`);",
    ],
    [
      "a block comment holding a WHERE that ends the SET list early",
      "a.ts",
      "db.prepare(\"UPDATE relay_peers SET trust_score = 1 /* WHERE */, state = 'active'\");",
    ],
    [
      "a line comment holding a WHERE that ends the SET list early",
      "a.ts",
      "db.prepare(`UPDATE relay_peers SET trust_score = 1 -- WHERE\n, endpoint_url = ?`);",
    ],
    [
      "an array join building the statement",
      "a.ts",
      `db.prepare(["UPDATE", "relay_peers SET state = 'active'", "WHERE peer_relay_id = ?"].join(" "));`,
    ],
    [
      "an array join with no separator argument",
      "a.ts",
      `db.prepare(["UPDATE relay_peers SET trust_score = 1", " state = ?"].join());`,
    ],
    [
      "a concat building the statement",
      "a.ts",
      `db.prepare("UPDATE ".concat("relay_peers SET ", "public_key = ?"));`,
    ],
    [
      "a += accumulation building the statement",
      "a.ts",
      `let q = "UPDATE "; q += "relay_peers SET state = ?"; db.prepare(q).run(s);`,
    ],
    [
      "the table name held in a const",
      "a.ts",
      'const T = "relay_peers"; db.prepare(`UPDATE ${T} SET endpoint_url = ?`);',
    ],
    [
      "a nested function named writePeerRow inside federation.ts",
      "services/relay/src/federation.ts",
      'function outer() { function writePeerRow() { db.prepare("UPDATE relay_peers SET state = ?"); } }',
    ],
    [
      "a const arrow named writePeerRow in federation.ts",
      "services/relay/src/federation.ts",
      'export const writePeerRow = () => db.prepare("DELETE FROM relay_peers WHERE 1");',
    ],
    [
      "a top-level writePeerRow in another federation.ts (basename is not identity)",
      "services/relay/src/sub/federation.ts",
      'export function writePeerRow() { db.prepare("UPDATE relay_peers SET state = ?"); }',
    ],
    [
      "a top-level writePeerRow in federation.ts, given a relative path",
      "federation.ts",
      'export function writePeerRow() { db.prepare("UPDATE relay_peers SET state = ?"); }',
    ],
    [
      "a second top-level writePeerRow in federation.ts (not exactly one declaration)",
      "services/relay/src/federation.ts",
      'export function writePeerRow() { db.prepare("UPDATE relay_peers SET state = ?"); }\nexport function writePeerRow() {}',
    ],
    [
      "a trigger body",
      "a.ts",
      "db.exec(\"CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE relay_peers SET state = 'active'; END\");",
    ],
  ];
  // F5 (third cold review): an SQL string literal is data, never syntax — a
  // WHERE / FROM / `;` / `(` / `,` inside '…' must neither end the SET list
  // nor hide the authority column after it.
  const LITERAL_RED: Array<[string, string, string]> = [
    [
      "a string literal holding WHERE ends the SET list early",
      "a.ts",
      `db.prepare("UPDATE relay_peers SET trust_score = 'x where', state = 'active'");`,
    ],
    [
      "a string literal holding ; ends the SET list early",
      "a.ts",
      `db.prepare("UPDATE relay_peers SET trust_level = ';', public_key = ? WHERE 1");`,
    ],
    [
      "a string literal holding ( hides the next column",
      "a.ts",
      `db.prepare("UPDATE relay_peers SET trust_level = '(', state = ? WHERE 1");`,
    ],
    [
      "a string literal holding FROM ends the SET list early",
      "a.ts",
      `db.prepare("UPDATE relay_peers SET trust_level = 'from', endpoint_url = ? WHERE 1");`,
    ],
    [
      "an escaped quote inside a literal does not end it",
      "a.ts",
      `db.prepare("UPDATE relay_peers SET trust_level = 'it''s where', state = 'active'");`,
    ],
    [
      "a comment marker inside a literal does not comment out the next column",
      "a.ts",
      `db.prepare("UPDATE relay_peers SET trust_level = '--', public_key = ?");`,
    ],
    [
      "an unterminated literal (cannot be read)",
      "a.ts",
      `db.prepare("UPDATE relay_peers SET trust_level = 'x, state = ?");`,
    ],
  ];
  for (const [name, file, src] of LITERAL_RED) {
    it(`tamper: ${name} is red`, () => {
      const sites = scanPeerRowWrites(file, src);
      expect(sites.length).toBeGreaterThan(0);
      expect(sites.every((s) => s.refusal !== null)).toBe(true);
    });
  }

  for (const [name, file, src] of RED) {
    it(`tamper: ${name} is red`, () => {
      const sites = scanPeerRowWrites(file, src);
      expect(sites.length).toBeGreaterThan(0);
      expect(sites.every((s) => s.refusal !== null)).toBe(true);
    });
  }

  it("tamper: the real federation.ts with writePeerRow renamed is red at all three statements", () => {
    const real = readFileSync(join(SRC, "federation.ts"), "utf8");
    const renamed = real.replace("export function writePeerRow(", "export function writePeerRowX(");
    expect(renamed).not.toBe(real);
    const red = scanPeerRowWrites(PEER_ROW_WRITER.file, renamed).filter((s) => s.refusal !== null);
    expect(red.map((s) => s.verb).sort()).toEqual(["DELETE", "INSERT", "UPDATE"]);
  });

  it("the real federation.ts as written: the writer's three statements are recognised, nothing else in it writes", () => {
    const real = readFileSync(join(SRC, "federation.ts"), "utf8");
    const sites = scanPeerRowWrites(PEER_ROW_WRITER.file, real);
    expect(sites.filter((s) => s.refusal !== null)).toEqual([]);
    expect(
      sites
        .filter((s) => s.fn === PEER_ROW_WRITER.fn)
        .map((s) => s.verb)
        .sort(),
    ).toEqual(["DELETE", "INSERT", "UPDATE"]);
  });

  it("a literal holding SQL syntax in a counter/trust-only update is still counter/trust-only", () => {
    const sites = scanPeerRowWrites(
      "anywhere.ts",
      `db.prepare("UPDATE relay_peers SET trust_level = 'a, b where (', trust_score = ? WHERE x = '; state'");`,
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]!.columns).toEqual(["trust_level", "trust_score"]);
    expect(sites[0]!.refusal).toBeNull();
  });

  it("counter/trust-only updates are allowed by column, with a reason for each", () => {
    const sites = scanPeerRowWrites(
      "anywhere.ts",
      'db.prepare("UPDATE relay_peers SET successful_forwards = successful_forwards + 1, failed_forwards = 0, trust_level = ?, trust_score = ? WHERE peer_relay_id = ?");',
    );
    expect(sites).toHaveLength(1);
    expect(sites[0]!.refusal).toBeNull();
    for (const c of sites[0]!.columns!)
      expect(COUNTER_TRUST_COLUMNS[c]).toMatch(/never read by peer authority/);
  });
});
