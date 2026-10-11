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
 * confirmed keeps first-come semantics and is not asserted on.
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bytesToHex, generateKeypair, sign } from "@motebit/encryption";

import type { SyncRelay } from "../index.js";
import { initRelayIdentity, sendHeartbeats, type RelayIdentity } from "../federation.js";
import { setLogLevel } from "../logger.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import {
  ackingFetch,
  heartbeatRequest,
  operatorConfirm,
  removeRequest,
} from "./federation-messages.js";

const URL_A = "http://relay-a.authority.test:3000";
const URL_B = "http://relay-b.authority.test:3001";
const ATTACKER_URL = "http://attacker.authority.test:3666";
const SUITE = "motebit-concat-ed25519-hex-v1";
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

function confirm(challengeResponse: string): Promise<Response> {
  return post("/federation/v1/peer/confirm", {
    relay_id: idA.relayMotebitId,
    challenge_response: challengeResponse,
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
  const ack = ackingFetch(new Map([[idA.relayMotebitId, idA.privateKey]]));
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
      const sig = await sign(
        new TextEncoder().encode(`${idA.relayMotebitId}:${nonce}:${SUITE}`),
        attacker.privateKey,
      );
      const res = await confirm(bytesToHex(sig));
      if (
        res.status === 200 &&
        rowOfA()?.public_key === attacker.publicKeyHex &&
        !s.confirmedByLegit
      )
        s.attackerOwned = true;
      return res.status;
    }
    case "AC_BAD":
      return (await confirm(rand() + rand())).status;
    case "LP": {
      const res = await propose(idA.publicKeyHex, URL_A);
      if (res.status === 200) s.legitNonce = ((await res.json()) as { nonce: string }).nonce;
      return res.status;
    }
    case "LC": {
      if (s.legitNonce === null) return null;
      const res = await confirm(await operatorConfirm(a, s.legitNonce, AUTH_HEADER));
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
        privateKey: action === "HB_L" ? idA.privateKey : attacker.privateKey,
      });
      return (await post("/federation/v1/peer/heartbeat", req)).status;
    }
    case "RM_L":
    case "RM_F": {
      const req = await removeRequest({
        sender: idA.relayMotebitId,
        recipient: idB.relayMotebitId,
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
