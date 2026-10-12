/**
 * relay-federation@1.5 §3.1/§3.5 — the peering handshake, model-checked.
 *
 * Two cold reviews found four peer-authority bypasses of ONE class: a request
 * carrying no proof under the right key moves who B believes relay A is. The
 * second round's two:
 *
 *   R1  M proposes at B as A under M's OWN key and endpoint (200), then signs
 *       a v2 peer-remove with that key (200): B's row for A is `removed`,
 *       never confirmed, under M's key — and every later propose by the real
 *       A is 409 "public_key differs", forever.
 *   R2  M proposes at B as A under A's key and A's REAL endpoint and gets N.
 *       A's operator runs `motebit federation peer <M-url>`; M's `/identity`
 *       claims B's relay id under M's key; M answers A's propose with N and a
 *       peer-challenge "from B" signed by M; A's tooling accepts it and A's
 *       relay mints a confirm to B over {N, A's url}; M forwards it to B: 200
 *       — none→active, suspended→active, removed→active.
 *
 * Root cause: relay ids are random, not bound to keys, and the confirm named
 * its recipient by id only. Project stop rule: after the second same-class
 * finding, enumerate instead of patching. This file is that enumeration.
 *
 * The THIRD cold review found the same class in every other kind (round 2
 * had bound only the confirm's body to the recipient's key):
 *
 *   F1  A's operator runs `peer-remove <M-url>`; M's `/identity` claims B's
 *       id; A's relay mints a peer-remove addressed to B by id; M forwards it
 *       to B within five minutes: A's row at B active→removed.
 *   F2  M holds B's never-confirmed relay id AT A (its own key, its own
 *       endpoint). A's heartbeat loop signs heartbeats to "B" by id and posts
 *       them to M; M relays them verbatim to B: A's row at B suspended→active.
 *   F3  A's re-handshake at B (A confirmed there, suspended) is in flight; M
 *       proposes 8× at B as A and evicts A's pending handshake: A's confirm 403.
 *   F4  31 proposes naming a never-peered relay_id spend its per-id budget:
 *       the real relay's propose is 429.
 *
 * So the model now lets M drive EVERY honest operator tool and loop as an
 * oracle against a lying counterparty (peer, peer-remove, the heartbeat
 * loop), relay anything it receives to any relay, and interleave inside A's
 * tooling runs; and it adds I-no-weaken.
 *
 * THE MODEL. Relays A and B are honest and real (in-process). M is the
 * attacker: it holds only its own key (A's and B's public keys are public);
 * it calls any public federation route at B with any body; it lies in its own
 * `/identity` (any relay id, any key); it can make A's operator run the real
 * peering tooling against M's URL (a signing oracle — A's relay mints what
 * its tooling decides to mint); it replays anything it has seen; it waits
 * past cooldowns and freshness (the clock is injected). A also acts honestly:
 * it peers with B, heartbeats B, and removes itself at B.
 *
 * START STATES of A's row at B: absent, pending-unconfirmed (a never-confirmed
 * pending row, as an earlier build wrote it), active, suspended, removed-by-A
 * (confirmed, cooldown running), removed-unconfirmed (R1's aftermath, under
 * M's key).
 *
 * INVARIANTS, checked after every step:
 *   I-auth          a row for A at B in state active / suspended / pending
 *                   with `peered_at` set, under key K at endpoint E, exists
 *                   only if the holder of K signed a peer-confirm naming B by
 *                   B's id AND B's public key, for endpoint E. "Signed" is
 *                   what the signer's tooling believed it was confirming to
 *                   (the ledger records the id and key it addressed), so a
 *                   confirm minted for an impersonated identity never
 *                   satisfies it, whatever the bytes carry.
 *   I-no-strengthen no attacker step moves A's row (A's key, confirmed) toward active,
 *                   changes its key, changes its endpoint or deletes it, and
 *                   no step makes a row under A's key confirmed — unless in
 *                   that step A's key holder itself confirmed to B (id + key).
 *   I-no-weaken     no attacker step moves A's confirmed row at B toward
 *                   suspended / removed, or makes A's honest in-flight
 *                   handshake fail — only A's own signed removal or B's own
 *                   observation may move it down. (Its mirror, a lowered
 *                   missed-heartbeat count from a heartbeat A never addressed
 *                   to B, is I-no-strengthen.)
 *   I-live          from every explored state, the real A reaches `active` at
 *                   B under its key at its endpoint by its own tooling within
 *                   one cooldown, unless B's operator acted (never, here) —
 *                   except where M itself confirmed A's never-confirmed
 *                   relay_id under M's OWN key first: relay ids are not
 *                   self-certifying, so a first-come confirm under another key
 *                   is indistinguishable from a legitimate peer (the deferred
 *                   deeper fix — docs/design/identity-authority-writers.md
 *                   §5.5). Those states are counted, never silently skipped.
 *
 * SEARCH. Breadth-first over action sequences up to MODEL_DEPTH (default 4),
 * from each start state. A state is the abstraction of everything the next
 * action can depend on: B's row for A (key/endpoint/nonce by role, cooldown
 * bucket), the attacker's handles (latest nonce, latest own-key nonce, latest
 * captured confirm — each with its age in cooldown periods), whether M owns
 * the id, and the confirm ledger. A sequence reaching a state already seen at
 * the same or a shallower depth is not extended (its continuations are the
 * earlier state's). `MODEL_FULL=1` disables merging (every sequence is
 * extended — exponential, for a deep local run). Each sequence is replayed
 * from its start state on a clock advanced one hour (limiter windows,
 * pending handshakes, freshness and nonces from earlier sequences are past).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  generateKeypair,
  signFederationMessage,
  verifyFederationMessage,
} from "@motebit/encryption";

import type { SyncRelay } from "../index.js";
import { initRelayIdentity, sendHeartbeats, type RelayIdentity } from "../federation.js";
import { setLogLevel } from "../logger.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import { heartbeatRequest, removeRequest } from "./federation-messages.js";

const URL_A = "http://relay-a.model.test:3000";
const URL_B = "http://relay-b.model.test:3001";
const URL_M = "http://relay-m.model.test:3666";
const COOLDOWN_MS = 6 * 60 * 1000; // one removed-peer cooldown (5 min) + margin
const MAX_DEPTH = Number(process.env["MODEL_DEPTH"] ?? 4);
const FULL = process.env["MODEL_FULL"] === "1";

const rand = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

// ── The byte format of the handshake bodies, as the tooling and B build them ─

/** The peer-challenge body (§3.1 step 2) a proposer verifies (its key is the envelope's). */
function challengeBody(args: {
  requestNonce: string;
  nonce: string;
  proposerEndpoint: string;
}): Record<string, string> {
  return {
    request_nonce: args.requestNonce,
    nonce: args.nonce,
    proposer_endpoint_url: args.proposerEndpoint,
  };
}

/** The peer-confirm body (§3.1 step 3) a signer commits to (the recipient's key is the envelope's). */
function confirmBody(args: { nonce: string; endpoint: string }): Record<string, string> {
  return { nonce: args.nonce, endpoint_url: args.endpoint };
}

/** A confirm request: the message, the nonce it answers, and the key and endpoint the propose named. */
function confirmRequest(
  message: unknown,
  nonce: string,
  publicKey: string,
  endpoint: string,
): { message: unknown; nonce: string; public_key: string; endpoint_url: string } {
  return { message, nonce, public_key: publicKey, endpoint_url: endpoint };
}

// ── Actions ─────────────────────────────────────────────────────────────────

const ATTACKER_ACTIONS = [
  "P_AK_ME", // M proposes at B as A: A's key, M's endpoint
  "P_AK_AE", // M proposes at B as A: A's key, A's endpoint
  "P_MK_ME", // M proposes at B as A: M's key, M's endpoint
  "C_MK", // M confirms at B as A, signed by M, for its latest own-key nonce (naming B by id and key)
  "C_BAD", // M confirms at B as A for its latest nonce, garbage signature
  "RM_MK", // M signs a v2 peer-remove as A with M's key
  "HB_MK", // M signs a v2 heartbeat as A with M's key
  "O_BM", // A peers with M; M's /identity: (B's id, M's key); answers with its latest nonce + a challenge it signs; forwards A's confirm to B
  "O_MM", // A peers with M; M's /identity: (M's id, M's key); answers with its latest nonce; forwards A's confirm to B
  "O_PX", // A peers with M; M's /identity: B's (id, key); relays A's propose to B with M's endpoint; forwards A's confirm to B
  "O_PV", // A peers with M; M's /identity: B's (id, key); relays A's propose to B verbatim; forwards A's confirm to B
  "REPLAY", // M re-sends the latest confirm of A's it has seen to B
  "WAIT", // the clock advances one cooldown
  // Round 3 — every honest operator tool and loop as an oracle against a
  // lying counterparty, and M relaying whatever it receives:
  "O_RM", // A's operator runs `peer-remove <M-url>`; M's /identity: (B's id, M's key); M forwards A's removal to B
  "SQ_BA", // M completes a handshake AT A as B (B's id, M's key, M's endpoint) — the non-self-certifying residual, at A
  "T_HB", // A's heartbeat loop ticks; what it posts to M's endpoint M relays verbatim to B (nothing else is delivered)
  "X_EVICT", // A's operator runs `peer <B>`; between its propose and its confirm M proposes 8× at B as A (A's key, M's endpoint)
] as const;
const HONEST_ACTIONS = [
  "H_PEER", // A's operator runs `motebit federation peer <B>`
  "H_PEER_BA", // B's operator runs its half against A (A then holds B, confirmed)
  "H_BEAT", // A heartbeats B (v2, signed by A)
  "H_REMOVE", // A's operator runs `peer-remove <B-url>`
] as const;
const ACTIONS = [...ATTACKER_ACTIONS, ...HONEST_ACTIONS] as const;
type Action = (typeof ACTIONS)[number];

const START = [
  "absent",
  "pending-unconfirmed",
  "active",
  "suspended",
  "removed-by-A",
  "removed-unconfirmed",
] as const;
type Start = (typeof START)[number];

// ── World ───────────────────────────────────────────────────────────────────

let a: SyncRelay;
let b: SyncRelay;
let idA: RelayIdentity;
let idB: RelayIdentity;
let m: { relayId: string; privateKey: Uint8Array; publicKeyHex: string };
let confirmedTemplate: Row;
let clockOffset = 0;
let ipSeq = 0;

type Row = Record<string, unknown> & {
  public_key: string;
  endpoint_url: string;
  state: string;
  nonce: string | null;
  peered_at: number | null;
  last_heartbeat_at: number | null;
  missed_heartbeats: number;
};

function rowOfA(): Row | undefined {
  return b.moteDb.db
    .prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ?")
    .get(idA.relayMotebitId) as Row | undefined;
}

async function request(
  relay: SyncRelay,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  ipSeq++;
  return relay.app.request(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...init.headers,
      "Content-Type": "application/json",
      "x-forwarded-for": `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const keyLabel = (k: string | null | undefined): string =>
  k == null
    ? "-"
    : k.toLowerCase() === idA.publicKeyHex.toLowerCase()
      ? "A"
      : k.toLowerCase() === idB.publicKeyHex.toLowerCase()
        ? "B"
        : k.toLowerCase() === m.publicKeyHex.toLowerCase()
          ? "M"
          : "?";
const urlLabel = (u: string | null | undefined): string =>
  u === URL_A ? "A" : u === URL_B ? "B" : u === URL_M ? "M" : u == null ? "-" : "?";
const idLabel = (id: string): string =>
  id === idA.relayMotebitId ? "A" : id === idB.relayMotebitId ? "B" : id === m.relayId ? "M" : "?";

// ── Per-sequence state ──────────────────────────────────────────────────────

interface Nonce {
  nonce: string;
  key: string; // label of the key the propose named
  endpoint: string; // label of the endpoint the propose named
  epoch: number;
}

interface Captured {
  request: { message: unknown; nonce: string; public_key: string; endpoint_url: string };
  recipientId: string; // label
  recipientKey: string; // label
  epoch: number;
}

interface Run {
  epoch: number;
  nonces: Nonce[];
  ownNonce: Nonce | null; // M's latest propose under M's key
  captured: Captured | null;
  /** Confirms signed, as the signer's tooling meant them: "signer>recipientId/recipientKey@endpoint". */
  ledger: Set<string>;
  /** M confirmed A's never-confirmed relay_id under M's own key (the non-self-certifying residual). */
  squatted: boolean;
  /** This step: A's key holder confirmed to B by id and key. */
  authorizedThisStep: boolean;
  /** M holds B's relay id at A under M's key (SQ_BA succeeded). */
  squattedAtA: boolean;
  /** This step: A's honest in-flight handshake at B was refused after it did everything right. */
  evictedThisStep: string | null;
}

function newRun(start: Start): Run {
  const ledger = new Set<string>();
  if (start === "active" || start === "suspended" || start === "removed-by-A")
    ledger.add("A>B/B@A"); // the handshake that confirmed the seeded row
  return {
    epoch: 0,
    nonces: [],
    ownNonce: null,
    captured: null,
    ledger,
    squatted: false,
    authorizedThisStep: false,
    squattedAtA: false,
    evictedThisStep: null,
  };
}

function latestNonce(r: Run): Nonce | null {
  return r.nonces.length > 0 ? r.nonces[r.nonces.length - 1]! : null;
}

function noteNonce(r: Run, n: Omit<Nonce, "epoch">): void {
  const full = { ...n, epoch: r.epoch };
  r.nonces.push(full);
  if (n.key === "M") r.ownNonce = full;
}

function seed(start: Start): void {
  const db = b.moteDb.db;
  db.prepare("DELETE FROM relay_peers WHERE peer_relay_id = ?").run(idA.relayMotebitId);
  db.prepare("DELETE FROM relay_federation_nonces").run();
  // A's own view of B starts empty in every start: B never ran its half.
  a.moteDb.db.prepare("DELETE FROM relay_peers WHERE peer_relay_id = ?").run(idB.relayMotebitId);
  a.moteDb.db.prepare("DELETE FROM relay_federation_nonces").run();
  if (start === "absent") return;
  const now = Date.now();
  const base: Row = { ...confirmedTemplate, last_heartbeat_at: now, peered_at: now - 60_000 };
  const row: Row =
    start === "active"
      ? { ...base, state: "active", nonce: null, missed_heartbeats: 0 }
      : start === "suspended"
        ? { ...base, state: "suspended", nonce: null, missed_heartbeats: 3 }
        : start === "removed-by-A"
          ? { ...base, state: "removed", nonce: null, missed_heartbeats: 0 }
          : start === "pending-unconfirmed"
            ? {
                ...base,
                state: "pending",
                nonce: rand(),
                peered_at: null,
                last_heartbeat_at: null,
                missed_heartbeats: 0,
              }
            : {
                // removed-unconfirmed: R1's aftermath on this branch
                ...base,
                public_key: m.publicKeyHex,
                endpoint_url: URL_M,
                state: "removed",
                nonce: null,
                peered_at: null,
                last_heartbeat_at: null,
                missed_heartbeats: 0,
              };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO relay_peers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...cols.map((k) => row[k] as never));
}

// ── A's operator tooling (mirrors apps/cli runHalf) ─────────────────────────

/** What sits at a URL the tooling talks to. */
type Endpoint = (path: string, body: unknown) => Promise<Response>;

const relayAt =
  (relay: SyncRelay): Endpoint =>
  (path, body) =>
    request(relay, path, body === undefined ? {} : { body });

/** One honest relay as its operator's tooling sees it. */
interface Side {
  relay: () => SyncRelay;
  id: () => RelayIdentity;
  url: string;
  label: "A" | "B";
}
const SIDE_A: Side = { relay: () => a, id: () => idA, url: URL_A, label: "A" };
const SIDE_B: Side = { relay: () => b, id: () => idB, url: URL_B, label: "B" };

/**
 * `self`'s half against `peer` (mirrors apps/cli runHalf): identity → propose
 * → verify the challenge under the key the identity advertised (the key the
 * confirm will commit to) → `self`'s operator mints → confirm. `between` runs
 * after the propose answered and before the operator mints (M interleaving
 * inside the run). Returns the confirm status, or null when the tooling
 * stopped before sending one.
 */
async function tooling(
  r: Run,
  self: Side,
  peer: Endpoint,
  between?: () => Promise<void>,
): Promise<{ status: number | null; minted: Captured | null }> {
  const sid = self.id();
  const idRes = await peer("/federation/v1/identity", undefined);
  if (idRes.status !== 200) return { status: null, minted: null };
  const pid = (await idRes.json()) as { relay_motebit_id: string; public_key: string };
  const ourNonce = rand();
  const prop = await peer("/federation/v1/peer/propose", {
    relay_id: sid.relayMotebitId,
    public_key: sid.publicKeyHex,
    endpoint_url: self.url,
    nonce: ourNonce,
  });
  if (prop.status !== 200) return { status: null, minted: null };
  const pb = (await prop.json()) as { nonce: string; challenge: unknown };
  const ch = await verifyFederationMessage(pb.challenge, {
    kind: "peer-challenge",
    self: sid.relayMotebitId,
    selfPublicKeyHex: sid.publicKeyHex,
    expectedSender: pid.relay_motebit_id,
    senderPublicKeyHex: pid.public_key,
    body: challengeBody({ requestNonce: ourNonce, nonce: pb.nonce, proposerEndpoint: self.url }),
  });
  if (!ch.ok) return { status: null, minted: null };
  if (between) await between();
  const mint = await request(self.relay(), "/api/v1/admin/federation/peer-confirm-signature", {
    body: {
      nonce: pb.nonce,
      recipient: pid.relay_motebit_id,
      recipient_public_key: pid.public_key,
      endpoint_url: self.url,
    },
    headers: AUTH_HEADER,
  });
  if (mint.status !== 200) return { status: null, minted: null };
  const mb = (await mint.json()) as {
    message: unknown;
    nonce: string;
    public_key: string;
    endpoint_url: string;
  };
  const minted: Captured = {
    request: confirmRequest(mb.message, mb.nonce, mb.public_key, mb.endpoint_url),
    recipientId: idLabel(pid.relay_motebit_id),
    recipientKey: keyLabel(pid.public_key),
    epoch: r.epoch,
  };
  r.ledger.add(`${self.label}>${minted.recipientId}/${minted.recipientKey}@${self.label}`);
  if (self.label === "A" && minted.recipientId === "B" && minted.recipientKey === "B")
    r.authorizedThisStep = true;
  const conf = await peer("/federation/v1/peer/confirm", minted.request);
  return { status: conf.status, minted };
}

/** A's half against `peer`. */
const aTooling = (
  r: Run,
  peer: Endpoint,
  between?: () => Promise<void>,
): ReturnType<typeof tooling> => tooling(r, SIDE_A, peer, between);

/**
 * A's operator runs `motebit federation peer-remove <peerUrl>` (mirrors
 * apps/cli handleFederationPeerRemove): have A's relay mint a v2 peer-remove
 * for the confirmed peer it holds at that endpoint — by the id and key A
 * verified it under, never the URL's self-description — and post it to the
 * peer. Returns the status the peer answered, or null when the tooling
 * stopped first (A holds no confirmed peer there).
 */
async function aRemoveTooling(peer: Endpoint, peerUrl: string): Promise<number | null> {
  const res = await request(
    a,
    `/api/v1/admin/federation/peer-removal-signature?endpoint_url=${encodeURIComponent(peerUrl)}`,
    { headers: AUTH_HEADER },
  );
  if (res.status !== 200) return null;
  const { message } = (await res.json()) as { message: unknown };
  return (await peer("/federation/v1/peer/remove", { message })).status;
}

/** A's row for B's relay id (whoever holds it at A). */
function rowOfBAtA(): Row | undefined {
  return a.moteDb.db
    .prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ?")
    .get(idB.relayMotebitId) as Row | undefined;
}

/** M's fake relay for one oracle run. */
function mRelay(
  r: Run,
  variant: "O_BM" | "O_MM" | "O_PX" | "O_PV" | "O_RM",
): { endpoint: Endpoint; forwarded: () => number | null } {
  let forwardedStatus: number | null = null;
  const claimsB = variant !== "O_MM";
  const claimedId = claimsB ? idB.relayMotebitId : m.relayId;
  const claimedKey = variant === "O_PX" || variant === "O_PV" ? idB.publicKeyHex : m.publicKeyHex;
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const endpoint: Endpoint = async (path, body) => {
    if (path === "/federation/v1/identity")
      return json({ relay_motebit_id: claimedId, public_key: claimedKey });
    if (path === "/federation/v1/peer/propose") {
      const p = body as { nonce: string; endpoint_url: string; public_key: string };
      if (variant === "O_PX" || variant === "O_PV") {
        const relayed = variant === "O_PX" ? { ...p, endpoint_url: URL_M } : p;
        const res = await request(b, "/federation/v1/peer/propose", { body: relayed });
        if (res.status === 200) {
          const text = await res.text();
          const nb = JSON.parse(text) as { nonce: string };
          noteNonce(r, { nonce: nb.nonce, key: "A", endpoint: urlLabel(relayed.endpoint_url) });
          return new Response(text, { status: 200 });
        }
        return res;
      }
      const issued = latestNonce(r)?.nonce ?? rand();
      const challenge = await signFederationMessage({
        kind: "peer-challenge",
        sender: claimedId,
        recipient: idA.relayMotebitId,
        recipientPublicKey: p.public_key,
        body: challengeBody({
          requestNonce: p.nonce,
          nonce: issued,
          proposerEndpoint: p.endpoint_url,
        }),
        privateKey: m.privateKey,
      });
      return json({
        relay_id: claimedId,
        public_key: claimedKey,
        endpoint_url: URL_M,
        nonce: issued,
        challenge,
      });
    }
    if (path === "/federation/v1/peer/confirm") {
      // M sees A's confirm and forwards it to B unchanged.
      const res = await request(b, "/federation/v1/peer/confirm", { body });
      forwardedStatus = res.status;
      return json({ status: "active" });
    }
    if (path === "/federation/v1/peer/remove") {
      // M sees A's removal and forwards it to B unchanged.
      const res = await request(b, "/federation/v1/peer/remove", { body });
      forwardedStatus = res.status;
      return json({ status: "removed" });
    }
    return new Response("not found", { status: 404 });
  };
  return { endpoint, forwarded: () => forwardedStatus };
}

async function propose(r: Run, key: string, endpoint: string): Promise<number> {
  const res = await request(b, "/federation/v1/peer/propose", {
    body: { relay_id: idA.relayMotebitId, public_key: key, endpoint_url: endpoint, nonce: rand() },
  });
  if (res.status === 200) {
    const nb = (await res.json()) as { nonce: string };
    noteNonce(r, { nonce: nb.nonce, key: keyLabel(key), endpoint: urlLabel(endpoint) });
  }
  return res.status;
}

async function act(r: Run, action: Action): Promise<number | null> {
  switch (action) {
    case "P_AK_ME":
      return propose(r, idA.publicKeyHex, URL_M);
    case "P_AK_AE":
      return propose(r, idA.publicKeyHex, URL_A);
    case "P_MK_ME":
      return propose(r, m.publicKeyHex, URL_M);
    case "C_MK": {
      const n = r.ownNonce;
      const nonce = n?.nonce ?? rand();
      const endpoint = n?.endpoint === "A" ? URL_A : URL_M;
      const message = await signFederationMessage({
        kind: "peer-confirm",
        sender: idA.relayMotebitId,
        recipient: idB.relayMotebitId,
        recipientPublicKey: idB.publicKeyHex,
        body: confirmBody({ nonce, endpoint }),
        privateKey: m.privateKey,
      });
      r.ledger.add(`M>B/B@${urlLabel(endpoint)}`);
      const res = await request(b, "/federation/v1/peer/confirm", {
        body: confirmRequest(message, nonce, m.publicKeyHex, endpoint),
      });
      if (res.status === 200 && keyLabel(rowOfA()?.public_key) === "M") r.squatted = true;
      return res.status;
    }
    case "C_BAD": {
      const latest = latestNonce(r);
      const nonce = latest?.nonce ?? rand();
      const key = latest?.key === "M" ? m.publicKeyHex : idA.publicKeyHex;
      const endpoint = latest?.endpoint === "A" ? URL_A : URL_M;
      const message = await signFederationMessage({
        kind: "peer-confirm",
        sender: idA.relayMotebitId,
        recipient: idB.relayMotebitId,
        recipientPublicKey: idB.publicKeyHex,
        body: confirmBody({ nonce, endpoint }),
        privateKey: m.privateKey,
      });
      return (
        await request(b, "/federation/v1/peer/confirm", {
          body: confirmRequest({ ...message, signature: rand() + rand() }, nonce, key, endpoint),
        })
      ).status;
    }
    case "RM_MK": {
      const req = await removeRequest({
        sender: idA.relayMotebitId,
        recipient: idB.relayMotebitId,
        recipientPublicKey: idB.publicKeyHex,
        privateKey: m.privateKey,
      });
      return (await request(b, "/federation/v1/peer/remove", { body: req })).status;
    }
    case "HB_MK": {
      const req = await heartbeatRequest({
        sender: idA.relayMotebitId,
        recipient: idB.relayMotebitId,
        recipientPublicKey: idB.publicKeyHex,
        privateKey: m.privateKey,
      });
      return (await request(b, "/federation/v1/peer/heartbeat", { body: req })).status;
    }
    case "O_BM":
    case "O_MM":
    case "O_PX":
    case "O_PV": {
      const fake = mRelay(r, action);
      const { minted } = await aTooling(r, fake.endpoint);
      if (minted) r.captured = minted;
      return fake.forwarded();
    }
    case "REPLAY": {
      if (r.captured === null) return null;
      return (await request(b, "/federation/v1/peer/confirm", { body: r.captured.request })).status;
    }
    case "O_RM": {
      const fake = mRelay(r, "O_RM");
      await aRemoveTooling(fake.endpoint, URL_M);
      return fake.forwarded();
    }
    case "SQ_BA": {
      // M proposes AT A as B under its own key and endpoint, then confirms
      // with that key: A now holds B's relay id under M's key (§13.2 residual
      // at A — B never ran its half there).
      const prop = await request(a, "/federation/v1/peer/propose", {
        body: {
          relay_id: idB.relayMotebitId,
          public_key: m.publicKeyHex,
          endpoint_url: URL_M,
          nonce: rand(),
        },
      });
      if (prop.status !== 200) return prop.status;
      const { nonce } = (await prop.json()) as { nonce: string };
      const message = await signFederationMessage({
        kind: "peer-confirm",
        sender: idB.relayMotebitId,
        recipient: idA.relayMotebitId,
        recipientPublicKey: idA.publicKeyHex,
        body: confirmBody({ nonce, endpoint: URL_M }),
        privateKey: m.privateKey,
      });
      const res = await request(a, "/federation/v1/peer/confirm", {
        body: confirmRequest(message, nonce, m.publicKeyHex, URL_M),
      });
      if (res.status === 200 && keyLabel(rowOfBAtA()?.public_key) === "M") r.squattedAtA = true;
      return res.status;
    }
    case "T_HB": {
      // A's own heartbeat loop: one tick. Only what it posts to M's endpoint
      // is delivered — M relays it to B verbatim. (A's honest heartbeat to
      // B is H_BEAT.)
      let relayed: number | null = null;
      const fetchVia = async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (!url.startsWith(URL_M)) throw new Error("unreachable in this step");
        const res = await request(b, "/federation/v1/peer/heartbeat", {
          body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown,
        });
        relayed = res.status;
        return res;
      };
      await sendHeartbeats(a.moteDb.db, idA, fetchVia as never);
      return relayed;
    }
    case "X_EVICT": {
      // A's honest run against B, with M interleaving 8 proposes at B as A
      // between A's propose and A's confirm. A did everything right: if its
      // propose was answered and its challenge verified, its confirm must land.
      let interleaved = false;
      const res = await aTooling(r, relayAt(b), async () => {
        interleaved = true;
        for (let i = 0; i < 8; i++) await propose(r, idA.publicKeyHex, URL_M);
      });
      if (interleaved && res.minted !== null && res.status !== 200)
        r.evictedThisStep = `A's in-flight handshake at B refused after ${String(8)} interleaved proposes (confirm ${String(res.status)})`;
      return res.status;
    }
    case "H_PEER_BA":
      return (await tooling(r, SIDE_B, relayAt(a))).status;
    case "WAIT":
      clockOffset += COOLDOWN_MS;
      r.epoch++;
      return null;
    case "H_PEER":
      return (await aTooling(r, relayAt(b))).status;
    case "H_BEAT": {
      const req = await heartbeatRequest({
        sender: idA.relayMotebitId,
        recipient: idB.relayMotebitId,
        recipientPublicKey: idB.publicKeyHex,
        privateKey: idA.privateKey,
      });
      return (await request(b, "/federation/v1/peer/heartbeat", { body: req })).status;
    }
    case "H_REMOVE":
      return aRemoveTooling(relayAt(b), URL_B);
  }
}

// ── Invariants ──────────────────────────────────────────────────────────────

const RANK: Record<string, number> = { removed: 0, suspended: 1, pending: 2, active: 3 };
const confirmedUnderA = (row: Row | undefined): boolean =>
  row !== undefined && row.peered_at != null && keyLabel(row.public_key) === "A";

function checkAuth(r: Run): string | null {
  const row = rowOfA();
  if (row === undefined || row.peered_at == null || row.state === "removed") return null;
  const k = keyLabel(row.public_key);
  const need = `${k}>B/B@${urlLabel(row.endpoint_url)}`;
  if (!r.ledger.has(need))
    return `I-auth: ${row.state} under ${k}'s key at ${urlLabel(row.endpoint_url)}'s endpoint, but ${k} never confirmed to B by id and key for it (ledger: ${[...r.ledger].join(" ") || "∅"})`;
  return null;
}

/**
 * I-no-weaken: no attacker-only step moves A's confirmed row at B toward
 * suspended / removed, or makes A's honest in-flight handshake fail — only
 * A's own signed removal, or B's own observation (its loop, not modelled
 * here), may.
 */
function checkNoWeaken(r: Run, before: Row | undefined): string | null {
  if (r.evictedThisStep !== null) return `I-no-weaken: ${r.evictedThisStep}`;
  const after = rowOfA();
  if (confirmedUnderA(before) && after !== undefined && keyLabel(after.public_key) === "A") {
    if ((RANK[after.state] ?? 9) < (RANK[before!.state] ?? 9))
      return `I-no-weaken: ${before!.state} → ${after.state}`;
  }
  return null;
}

function checkNoStrengthen(r: Run, before: Row | undefined): string | null {
  if (r.authorizedThisStep) return null;
  const after = rowOfA();
  if (confirmedUnderA(before)) {
    if (after === undefined) return "I-no-strengthen: A's confirmed row deleted";
    if (keyLabel(after.public_key) === "A" && after.missed_heartbeats < before!.missed_heartbeats)
      return `I-no-strengthen: missed heartbeats ${String(before!.missed_heartbeats)} → ${String(after.missed_heartbeats)}`;
    if (keyLabel(after.public_key) !== "A")
      return `I-no-strengthen: key ${keyLabel(after.public_key)}`;
    if (after.endpoint_url !== before!.endpoint_url)
      return `I-no-strengthen: endpoint ${urlLabel(before!.endpoint_url)} → ${urlLabel(after.endpoint_url)}`;
    if ((RANK[after.state] ?? 9) > (RANK[before!.state] ?? 9))
      return `I-no-strengthen: ${before!.state} → ${after.state}`;
    return null;
  }
  if (confirmedUnderA(after))
    return `I-no-strengthen: ${before ? `${before.state}/unconfirmed` : "absent"} → ${after!.state}/confirmed under A's key`;
  return null;
}

function healthy(): boolean {
  const row = rowOfA();
  return (
    row !== undefined &&
    row.state === "active" &&
    keyLabel(row.public_key) === "A" &&
    row.endpoint_url === URL_A
  );
}

async function checkLive(r: Run): Promise<string | null> {
  const trail: string[] = [];
  for (let round = 0; round < 2; round++) {
    if (healthy()) return null;
    trail.push(`H_PEER=${String(await act(r, "H_PEER"))}`);
    if (healthy()) return null;
    if (round === 0) await act(r, "WAIT");
  }
  const row = rowOfA();
  return `I-live: A locked out after one cooldown (${trail.join(" ")}; row ${
    row
      ? `${row.state} key=${keyLabel(row.public_key)} endpoint=${urlLabel(row.endpoint_url)} peered=${row.peered_at != null}`
      : "absent"
  })`;
}

// ── Abstraction ─────────────────────────────────────────────────────────────

function age(r: Run, epoch: number): number {
  return Math.min(r.epoch - epoch, 2);
}

function fingerprint(r: Run): string {
  const row = rowOfA();
  const latest = latestNonce(r);
  const nonceRole = (n: string | null): string =>
    n == null
      ? "-"
      : n === latest?.nonce
        ? "L"
        : n === r.ownNonce?.nonce
          ? "O"
          : r.nonces.some((x) => x.nonce === n)
            ? "K"
            : "U";
  const now = Date.now();
  const rowFp = row
    ? [
        row.state,
        keyLabel(row.public_key),
        urlLabel(row.endpoint_url),
        row.peered_at != null ? "c" : "u",
        nonceRole(row.nonce),
        row.last_heartbeat_at == null
          ? "-"
          : now - Number(row.last_heartbeat_at) < 5 * 60 * 1000
            ? "cool"
            : "warm",
        String(row.missed_heartbeats),
      ].join("/")
    : "∅";
  const n = (x: Nonce | null): string =>
    x ? `${x.key}${x.endpoint}${String(age(r, x.epoch))}` : "-";
  const cap = r.captured
    ? `${r.captured.recipientId}${r.captured.recipientKey}${String(age(r, r.captured.epoch))}`
    : "-";
  const atA = rowOfBAtA();
  const atAFp = atA
    ? `${atA.state}/${keyLabel(atA.public_key)}/${atA.peered_at != null ? "c" : "u"}/${String(atA.missed_heartbeats)}`
    : "∅";
  return [
    rowFp,
    atAFp,
    n(latest),
    n(r.ownNonce),
    cap,
    r.squatted ? "S" : "",
    r.squattedAtA ? "SA" : "",
    [...r.ledger].sort().join(","),
  ].join("|");
}

// ── Search ──────────────────────────────────────────────────────────────────

interface Violation {
  start: Start;
  seq: Action[];
  what: string;
}

interface Replay {
  violation: string | null;
  run: Run;
}

/** Replay `seq` from `start`, checking I-auth and I-no-strengthen after every step. */
async function replay(start: Start, seq: Action[]): Promise<Replay> {
  clockOffset += 60 * 60 * 1000;
  seed(start);
  const r = newRun(start);
  for (let i = 0; i < seq.length; i++) {
    const action = seq[i]!;
    const before = rowOfA();
    r.authorizedThisStep = false;
    r.evictedThisStep = null;
    const status = await act(r, action);
    const at = `step ${i + 1} ${action}`;
    if (status !== null && status >= 500) return { violation: `${at}: HTTP ${status}`, run: r };
    // I-no-strengthen is over the attacker's steps: A's own (a heartbeat
    // signed by A, its own peering) may move its row toward active.
    const attacker = (ATTACKER_ACTIONS as readonly Action[]).includes(action);
    const v =
      checkAuth(r) ??
      (attacker ? (checkNoStrengthen(r, before) ?? checkNoWeaken(r, before)) : null);
    if (v !== null) return { violation: `${at}: ${v}`, run: r };
  }
  return { violation: null, run: r };
}

interface Explored {
  states: number;
  transitions: number;
  squatExempt: number;
  violations: Violation[];
}

async function explore(start: Start, maxDepth: number): Promise<Explored> {
  const seen = new Map<string, number>();
  const out: Explored = { states: 0, transitions: 0, squatExempt: 0, violations: [] };
  const consider = async (seq: Action[]): Promise<boolean> => {
    out.transitions++;
    const { violation, run } = await replay(start, seq);
    if (violation !== null) {
      out.violations.push({ start, seq, what: violation });
      return false;
    }
    const fp = fingerprint(run);
    if (!FULL && seen.has(fp)) return false;
    seen.set(fp, seq.length);
    out.states++;
    if (run.squatted) out.squatExempt++;
    else {
      const live = await checkLive(run);
      if (live !== null) {
        out.violations.push({ start, seq, what: live });
        return false;
      }
    }
    return true;
  };
  let frontier: Action[][] = [];
  if (await consider([])) frontier.push([]);
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: Action[][] = [];
    for (const prefix of frontier)
      for (const action of ACTIONS) {
        const seq = [...prefix, action];
        if (await consider(seq)) next.push(seq);
      }
    frontier = next;
  }
  return out;
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  setLogLevel("error");
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  const neverFetch = (): Promise<Response> => new Promise<Response>(() => {});
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
  m = {
    relayId: crypto.randomUUID(),
    privateKey: kp.privateKey,
    publicKeyHex: bytesToHex(kp.publicKey),
  };
  // One real handshake gives the confirmed row the confirmed starts seed from.
  const r = newRun("absent");
  seed("absent");
  expect(await act(r, "H_PEER")).toBe(200);
  confirmedTemplate = rowOfA()!;
  expect(confirmedTemplate.state).toBe("active");
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  setLogLevel("info");
  await a?.close();
  await b?.close();
});

// ── The named findings, as cells ────────────────────────────────────────────

describe("the second cold review's findings, as model cells", () => {
  const cells: Array<[string, Start, Action[]]> = [
    ["R1: own-key propose + own-key remove locks A out (absent)", "absent", ["P_MK_ME", "RM_MK"]],
    [
      "R2: A's confirm, minted for an impersonated B, lands at B (absent)",
      "absent",
      ["P_AK_AE", "O_BM"],
    ],
    ["R2: … revives a suspended peer", "suspended", ["P_AK_AE", "O_BM"]],
    [
      "R2: … revives a removed peer after the cooldown",
      "removed-by-A",
      ["WAIT", "P_AK_AE", "O_BM"],
    ],
  ];
  for (const [name, start, seq] of cells) {
    it(name, async () => {
      const { violation, run } = await replay(start, seq);
      const what = violation ?? (run.squatted ? null : await checkLive(run));
      expect(what, `[${start}] ${seq.join(",")}`).toBeNull();
    });
  }
});

describe("the third cold review's findings, as model cells", () => {
  const cells: Array<[string, Start, Action[]]> = [
    [
      "F1: A's peer-remove, minted for an impersonated B, removes A at B (active)",
      "active",
      ["O_RM"],
    ],
    ["F1: … at a suspended peer", "suspended", ["O_RM"]],
    [
      "F1': … even where M holds B's id at A, so A mints for M's key (the envelope refuses it at B)",
      "active",
      ["SQ_BA", "O_RM"],
    ],
    [
      "F2: A's heartbeat to an id M holds at A, relayed to B, revives A at B (suspended)",
      "suspended",
      ["SQ_BA", "T_HB"],
    ],
    ["F2: … all the way to active", "suspended", ["SQ_BA", "T_HB", "T_HB", "T_HB"]],
    [
      "F3: 8 proposes naming a confirmed peer evict its in-flight re-handshake (suspended)",
      "suspended",
      ["X_EVICT"],
    ],
    ["F3: … after the removed peer's cooldown", "removed-by-A", ["WAIT", "X_EVICT"]],
  ];
  for (const [name, start, seq] of cells) {
    it(name, async () => {
      const { violation, run } = await replay(start, seq);
      const what = violation ?? (run.squatted ? null : await checkLive(run));
      expect(what, `[${start}] ${seq.join(",")}`).toBeNull();
    });
  }
});

describe("F4: proposes naming a never-peered relay_id never lock the real relay out (§3.1)", () => {
  const variants: Array<[string, () => Promise<string>]> = [
    ["under fresh keys of their own", async () => bytesToHex((await generateKeypair()).publicKey)],
    ["under the id's real (public) key", () => Promise.resolve(idA.publicKeyHex)],
  ];
  for (const [name, keyOf] of variants) {
    it(`31 proposes ${name}, then the real A peers`, async () => {
      clockOffset += 60 * 60 * 1000;
      seed("absent");
      const r = newRun("absent");
      for (let i = 0; i < 31; i++) await propose(r, await keyOf(), URL_M);
      expect(await act(r, "H_PEER")).toBe(200);
      expect(healthy()).toBe(true);
    });
  }
});

describe("a never-confirmed row is no peer (§3.1, §3.3)", () => {
  // The choice for a removal naming a never-confirmed row: REFUSE (403), not
  // delete. The row's key was never proven, so a removal signed under it
  // proves nothing about any peer; and the row is already inert — a propose
  // ignores it and a verified confirm replaces it — so there is nothing a
  // delete would free. Refusing keeps every request on that row a no-op.
  for (const start of ["removed-unconfirmed", "pending-unconfirmed"] as const) {
    it(`${start}: a removal or heartbeat signed under its key is 403 and writes nothing`, async () => {
      clockOffset += 60 * 60 * 1000;
      seed(start);
      const before = rowOfA();
      const key = start === "removed-unconfirmed" ? m.privateKey : idA.privateKey;
      const rm = await removeRequest({
        sender: idA.relayMotebitId,
        recipient: idB.relayMotebitId,
        recipientPublicKey: idB.publicKeyHex,
        privateKey: key,
      });
      expect((await request(b, "/federation/v1/peer/remove", { body: rm })).status).toBe(403);
      const hb = await heartbeatRequest({
        sender: idA.relayMotebitId,
        recipient: idB.relayMotebitId,
        recipientPublicKey: idB.publicKeyHex,
        privateKey: key,
      });
      expect((await request(b, "/federation/v1/peer/heartbeat", { body: hb })).status).toBe(403);
      expect(rowOfA()).toEqual(before);
    });
  }
});

// ── The model check ─────────────────────────────────────────────────────────

describe(`peering handshake model check (6 start states × action sequences ≤ ${MAX_DEPTH})`, () => {
  const totals = { states: 0, transitions: 0, squatExempt: 0 };
  for (const start of START) {
    it(
      `start ${start}`,
      async () => {
        const res = await explore(start, MAX_DEPTH);
        totals.states += res.states;
        totals.transitions += res.transitions;
        totals.squatExempt += res.squatExempt;
        const byKind = new Map<string, Violation>();
        for (const v of res.violations) {
          const kind = v.what.replace(/^step \d+ \w+: /, "").replace(/[:(].*$/, "");
          const prev = byKind.get(kind);
          if (prev === undefined || v.seq.length < prev.seq.length) byKind.set(kind, v);
        }
        console.log(
          `[handshake-model] start ${start}: ${res.states} states, ${res.transitions} sequences replayed, ${res.squatExempt} own-key-squat states exempt from I-live, ${res.violations.length} violating sequences` +
            [...byKind.values()]
              .map((v) => `\n  counterexample: [${v.start}] ${v.seq.join(",") || "∅"} — ${v.what}`)
              .join(""),
        );
        expect(
          res.violations.length,
          `${res.violations.length} violating sequences from ${start}; shortest per kind:\n${[
            ...byKind.values(),
          ]
            .map((v) => `[${v.start}] ${v.seq.join(",") || "∅"} — ${v.what}`)
            .join("\n")}`,
        ).toBe(0);
      },
      30 * 60 * 1000,
    );
  }
  afterAll(() => {
    console.log(
      `[handshake-model] explored ${totals.states} abstract states over ${totals.transitions} replayed sequences (depth ≤ ${MAX_DEPTH}, ${ACTIONS.length} actions${FULL ? ", no merging" : ""}); ${totals.squatExempt} own-key-squat states exempt from I-live`,
    );
  });
});
