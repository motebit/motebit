/**
 * Adversarial model of the federation peering handshake.
 *
 * Two REAL relays: the victim V (a relay that peers, or once peered, with
 * the target) and the target T. The attacker holds its own keys and V's
 * PUBLIC key, and may call every public endpoint of both relays — including
 * V's own (a relay's public surface is an oracle if it signs anything a
 * verifier accepts). It never holds V's private key or either operator's
 * admin token.
 *
 * For every state of V's row on T × every attacker action, the invariant:
 *
 *   V's row on T is BYTE-IDENTICAL after the attack, unless V's private key
 *   signed a role-bound message naming T (which only V's operator can ask V
 *   to produce) — and V's own next legitimate step (confirm, re-peer,
 *   heartbeat) still succeeds.
 *
 * States: none (V never peered), pending (V proposed, has not confirmed),
 * active, suspended, removed, and the two re-peering interleavings
 * (suspended / removed, V re-proposed and has not yet confirmed — the
 * attacker acts between V's propose and V's confirm).
 *
 * Actions: propose V's id under the attacker's key (then confirm under it),
 * propose V's id under V's key (×9 — past any per-id proposal cap),
 * the signing oracle (propose V's id under V's key at T, carry T's nonce to
 * every public V endpoint that signs, replay each signature at T's confirm in
 * every wire shape), replay of V's earlier confirm bodies (as sent and with
 * the endpoint swapped), and a heartbeat flood claiming V.
 *
 * Stated boundary (not a cell): relay ids are random strings, not derived
 * from a key, so an id that never completed a confirm belongs to no one and
 * the first verified confirm takes it. "propose under the attacker's own key"
 * against `none`/`pending` is therefore expected to succeed and is asserted
 * only not to touch a row holding V's key.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { createTestRelay, AUTH_HEADER } from "./test-helpers.js";
// eslint-disable-next-line no-restricted-imports -- the attacker and V's heartbeat need raw key material
import { generateKeypair, sign, bytesToHex, hexToBytes } from "@motebit/encryption";

const SUITE = "motebit-concat-ed25519-hex-v1";
const V_URL = "http://victim-relay.test:4000";
const T_URL = "http://target-relay.test:3000";
const ATTACKER_URL = "http://attacker-relay.test:6666";
const V_IP = "198.51.100.7";
const ATTACKER_IP = "203.0.113.66";

const rand = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

interface Res {
  status: number;
  body: Record<string, unknown> | null;
}

async function post(
  relay: SyncRelay,
  path: string,
  body: unknown,
  ip: string,
  extra: Record<string, string> = {},
): Promise<Res> {
  const res = await relay.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": ip, ...extra },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

// ── Every confirm message shape a verifier has ever accepted (v1) or accepts (v2) ──

const v1ConfirmMessage = (prover: string, _verifier: string, nonce: string, _endpoint: string) =>
  `${prover}:${nonce}:${SUITE}`;
const v2ConfirmMessage = (prover: string, verifier: string, nonce: string, endpoint: string) =>
  `motebit-federation-confirm:v2:${prover}:${verifier}:${nonce}:${SUITE}:${endpoint}`;

function confirmBodies(
  prover: string,
  proverKeyHex: string,
  nonce: string,
  endpoint: string,
  signatureHex: string,
): unknown[] {
  return [
    { relay_id: prover, challenge_response: signatureHex },
    {
      handshake_version: "v2",
      relay_id: prover,
      public_key: proverKeyHex,
      endpoint_url: endpoint,
      nonce,
      challenge_response: signatureHex,
    },
  ];
}

interface World {
  v: SyncRelay;
  t: SyncRelay;
  vId: string;
  vPub: string;
  vPriv: Uint8Array;
  tId: string;
  /** Every confirm body V's operator ever sent T (the replay corpus). */
  sentConfirms: unknown[];
}

// ── V's operator: the legitimate handshake (protocol-version specific) ──

async function vPropose(w: World): Promise<Res> {
  return post(
    w.t,
    "/federation/v1/peer/propose",
    {
      handshake_version: "v2",
      relay_id: w.vId,
      public_key: w.vPub,
      endpoint_url: V_URL,
      display_name: "Victim",
      nonce: rand(),
    },
    V_IP,
  );
}

async function vConfirm(w: World, proposal: Res): Promise<Res> {
  const nonce = (proposal.body as { nonce: string }).nonce;
  // V's operator asks V (authenticated) for V's confirm over T's nonce.
  const signed = await post(
    w.v,
    "/api/v1/admin/federation/peer-confirm-signature",
    { verifier_relay_id: w.tId, nonce, endpoint_url: V_URL },
    V_IP,
    AUTH_HEADER,
  );
  let body: unknown;
  if (signed.status === 200) {
    body = signed.body;
  } else {
    // v1: V's public self-propose produced the confirm signature.
    const self = await post(
      w.v,
      "/federation/v1/peer/propose",
      { relay_id: w.vId, public_key: w.vPub, endpoint_url: V_URL, nonce },
      V_IP,
    );
    body = { relay_id: w.vId, challenge_response: (self.body as { challenge: string }).challenge };
  }
  w.sentConfirms.push(body);
  return post(w.t, "/federation/v1/peer/confirm", body, V_IP);
}

async function vPeer(w: World): Promise<void> {
  const p = await vPropose(w);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const c = await vConfirm(w, p);
  expect(c.status, JSON.stringify(c.body)).toBe(200);
}

async function vHeartbeat(w: World): Promise<Res> {
  const ts = Date.now();
  const sig = await sign(new TextEncoder().encode(`${w.vId}|${ts}|${SUITE}`), w.vPriv);
  return post(
    w.t,
    "/federation/v1/peer/heartbeat",
    { relay_id: w.vId, timestamp: ts, agent_count: 0, signature: bytesToHex(sig) },
    V_IP,
  );
}

// ── States ──

type State =
  | "none"
  | "pending"
  | "active"
  | "suspended"
  | "removed"
  | "suspended+repeering"
  | "removed+repeering";
const STATES: State[] = [
  "none",
  "pending",
  "active",
  "suspended",
  "removed",
  "suspended+repeering",
  "removed+repeering",
];

/** Brings V's row on T to `state`. Returns V's outstanding proposal, if any. */
async function enter(w: World, state: State): Promise<Res | undefined> {
  if (state === "none") return undefined;
  if (state === "pending") {
    const p = await vPropose(w);
    expect(p.status).toBe(200);
    return p;
  }
  await vPeer(w);
  w.t.moteDb.db
    .prepare("UPDATE relay_peers SET trust_score = 0.9 WHERE peer_relay_id = ?")
    .run(w.vId);
  if (state === "active") return undefined;
  const s = state.startsWith("suspended") ? "suspended" : "removed";
  // last_heartbeat_at = 1: a removed peer is past its re-peering cooldown.
  w.t.moteDb.db
    .prepare(
      "UPDATE relay_peers SET state = ?, last_heartbeat_at = 1, missed_heartbeats = 3 WHERE peer_relay_id = ?",
    )
    .run(s, w.vId);
  if (!state.endsWith("+repeering")) return undefined;
  const p = await vPropose(w);
  expect(p.status).toBe(200);
  return p;
}

/** V's own next legitimate step from `state` — must still succeed after any attack. */
async function vNextStep(w: World, state: State, outstanding: Res | undefined): Promise<void> {
  switch (state) {
    case "none":
      await vPeer(w);
      break;
    case "pending":
    case "suspended+repeering":
    case "removed+repeering": {
      const c = await vConfirm(w, outstanding!);
      expect(c.status, `V's confirm after the attack: ${JSON.stringify(c.body)}`).toBe(200);
      break;
    }
    case "active": {
      const h = await vHeartbeat(w);
      expect(h.status, `V's heartbeat after the attack: ${JSON.stringify(h.body)}`).toBe(200);
      break;
    }
    case "suspended": {
      const h = await vHeartbeat(w);
      expect(h.status, `V's heartbeat after the attack: ${JSON.stringify(h.body)}`).toBe(200);
      await vPeer(w);
      break;
    }
    case "removed":
      await vPeer(w);
      break;
  }
  const r = row(w)!;
  expect(r["public_key"]).toBe(w.vPub);
  expect(r["endpoint_url"]).toBe(V_URL);
  if (state !== "suspended" && state !== "active") expect(r["state"]).toBe("active");
}

function row(w: World): Record<string, unknown> | undefined {
  return w.t.moteDb.db.prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ?").get(w.vId) as
    Record<string, unknown> | undefined;
}

// ── Attacker actions (public endpoints + its own keys + V's PUBLIC key only) ──

type Action =
  "propose-own-key" | "propose-victim-key-x9" | "oracle" | "confirm-replay" | "heartbeat-flood";
const ACTIONS: Action[] = [
  "propose-own-key",
  "propose-victim-key-x9",
  "oracle",
  "confirm-replay",
  "heartbeat-flood",
];

function attackerPropose(w: World, publicKey: string, nonce = rand()): Promise<Res> {
  return post(
    w.t,
    "/federation/v1/peer/propose",
    {
      handshake_version: "v2",
      relay_id: w.vId,
      public_key: publicKey,
      endpoint_url: ATTACKER_URL,
      nonce,
    },
    ATTACKER_IP,
  );
}

async function attack(w: World, action: Action): Promise<void> {
  switch (action) {
    case "propose-own-key": {
      const kp = await generateKeypair();
      const pub = bytesToHex(kp.publicKey);
      const p = await attackerPropose(w, pub);
      if (p.status !== 200) return;
      const nonce = (p.body as { nonce: string }).nonce;
      for (const msg of [v1ConfirmMessage, v2ConfirmMessage]) {
        const sig = bytesToHex(
          await sign(
            new TextEncoder().encode(msg(w.vId, w.tId, nonce, ATTACKER_URL)),
            kp.privateKey,
          ),
        );
        for (const b of confirmBodies(w.vId, pub, nonce, ATTACKER_URL, sig)) {
          await post(w.t, "/federation/v1/peer/confirm", b, ATTACKER_IP);
        }
      }
      return;
    }
    case "propose-victim-key-x9": {
      for (let i = 0; i < 9; i++) await attackerPropose(w, w.vPub);
      return;
    }
    case "oracle": {
      const p = await attackerPropose(w, w.vPub);
      if (p.status !== 200) return;
      const nonce = (p.body as { nonce: string }).nonce;
      // Every public V endpoint that signs something a caller chooses.
      const asks: Array<Record<string, unknown>> = [
        { relay_id: w.vId, public_key: w.vPub, endpoint_url: ATTACKER_URL, nonce },
        { relay_id: w.tId, public_key: w.vPub, endpoint_url: ATTACKER_URL, nonce },
        {
          relay_id: `relay-${crypto.randomUUID()}`,
          public_key: w.vPub,
          endpoint_url: ATTACKER_URL,
          nonce,
        },
      ];
      const sigs: string[] = [];
      for (const a of asks) {
        for (const hv of [undefined, "v2"]) {
          const r = await post(
            w.v,
            "/federation/v1/peer/propose",
            hv ? { ...a, handshake_version: hv } : a,
            ATTACKER_IP,
          );
          const ch = (r.body as { challenge?: unknown } | null)?.challenge;
          if (typeof ch === "string") sigs.push(ch);
        }
      }
      for (const sig of sigs) {
        for (const b of confirmBodies(w.vId, w.vPub, nonce, ATTACKER_URL, sig)) {
          await post(w.t, "/federation/v1/peer/confirm", b, ATTACKER_IP);
        }
      }
      return;
    }
    case "confirm-replay": {
      for (const b of w.sentConfirms) {
        await post(w.t, "/federation/v1/peer/confirm", b, ATTACKER_IP);
        await post(
          w.t,
          "/federation/v1/peer/confirm",
          { ...(b as Record<string, unknown>), endpoint_url: ATTACKER_URL },
          ATTACKER_IP,
        );
      }
      return;
    }
    case "heartbeat-flood": {
      for (let i = 0; i < 31; i++) {
        await post(
          w.t,
          "/federation/v1/peer/heartbeat",
          { relay_id: w.vId, timestamp: Date.now(), agent_count: 999, signature: "00".repeat(64) },
          ATTACKER_IP,
        );
      }
      return;
    }
  }
}

describe("federation handshake — adversarial state × action model", () => {
  const open: SyncRelay[] = [];
  afterEach(async () => {
    while (open.length) await open.pop()!.close();
  });

  async function world(): Promise<World> {
    const v = await createTestRelay({ federation: { endpointUrl: V_URL, displayName: "Victim" } });
    const t = await createTestRelay({ federation: { endpointUrl: T_URL, displayName: "Target" } });
    open.push(v, t);
    const priv = (
      v.moteDb.db.prepare("SELECT private_key_hex FROM relay_identity").get() as {
        private_key_hex: string;
      }
    ).private_key_hex;
    return {
      v,
      t,
      vId: v.relayIdentity.relayMotebitId,
      vPub: v.relayIdentity.publicKeyHex,
      vPriv: hexToBytes(priv),
      tId: t.relayIdentity.relayMotebitId,
      sentConfirms: [],
    };
  }

  for (const state of STATES) {
    for (const action of ACTIONS) {
      it(`${state} × ${action}: V's row is untouched and V's next step succeeds`, async () => {
        const w = await world();
        const outstanding = await enter(w, state);
        const before = row(w);

        await attack(w, action);

        const firstCome = action === "propose-own-key" && (state === "none" || state === "pending");
        if (firstCome) {
          // Stated boundary: an id never confirmed belongs to no one.
          if (before) expect(row(w)).toEqual(before);
          return;
        }
        expect(row(w)).toEqual(before);
        await vNextStep(w, state, outstanding);
      });
    }
  }
});
