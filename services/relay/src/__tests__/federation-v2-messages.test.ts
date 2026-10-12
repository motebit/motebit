/**
 * relay-federation@1.5 — v1 heartbeat / peer-remove / self-propose refused,
 * v2 signed messages end to end between in-process relays
 * (docs/design/identity-authority-writers.md Inc 1b; spec §3.1–§3.5).
 *
 * Three relays, A–B and A–C peered through the real handshake (each relay's
 * step-3 confirm minted by its operator, since self-propose is refused).
 * Every request between them goes through the real routes, routed in-process
 * by URL.
 *
 * What must hold:
 *   - a captured v1 heartbeat / removal / self-propose is refused at any relay
 *     and changes no row (the peer table is snapshotted before and after);
 *   - a v2 heartbeat signed for B is refused at C, and a replay at B is
 *     refused, each changing no row;
 *   - legit v2 peering, heartbeat (with a verified ack) and removal work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToHex, sign } from "@motebit/encryption";

import type { SyncRelay } from "../index.js";
import { initRelayIdentity, sendHeartbeats, type RelayIdentity } from "../federation.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import { heartbeatRequest, operatorConfirm, removeRequest } from "./federation-messages.js";

const URLS = {
  a: "http://relay-a.v2.test:3000",
  b: "http://relay-b.v2.test:3001",
  c: "http://relay-c.v2.test:3002",
} as const;
type Name = keyof typeof URLS;

const SUITE = "motebit-concat-ed25519-hex-v1";
const rand = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

let relays: Record<Name, SyncRelay>;
let ids: Record<Name, RelayIdentity>;

function routeFetch(): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const n of Object.keys(URLS) as Name[]) {
      if (url.startsWith(URLS[n])) {
        return relays[n].app.request(url.slice(URLS[n].length), {
          method: init?.method ?? "GET",
          headers: init?.headers as Record<string, string>,
          body: init?.body as string,
        });
      }
    }
    throw new Error(`unrouted fetch: ${url}`);
  });
}

let ipSeq = 0;
/** A POST from a fresh source address, so the per-IP tier never masks the per-peer one. */
async function post(n: Name, path: string, body: unknown): Promise<Response> {
  ipSeq++;
  return relays[n].app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": `198.51.${ipSeq >> 8}.${ipSeq & 255}`,
    },
    body: JSON.stringify(body),
  });
}

/** The real 1.5 handshake: cross-propose, operator-minted confirms, confirm both ways. */
async function peer(x: Name, y: Name): Promise<void> {
  const nonceAtY = (
    (await (
      await post(y, "/federation/v1/peer/propose", {
        relay_id: ids[x].relayMotebitId,
        public_key: ids[x].publicKeyHex,
        endpoint_url: URLS[x],
        nonce: rand(),
      })
    ).json()) as { nonce: string }
  ).nonce;
  const nonceAtX = (
    (await (
      await post(x, "/federation/v1/peer/propose", {
        relay_id: ids[y].relayMotebitId,
        public_key: ids[y].publicKeyHex,
        endpoint_url: URLS[y],
        nonce: rand(),
      })
    ).json()) as { nonce: string }
  ).nonce;
  const atY = await post(y, "/federation/v1/peer/confirm", {
    relay_id: ids[x].relayMotebitId,
    ...(await operatorConfirm(relays[x], nonceAtY, AUTH_HEADER, {
      id: ids[y].relayMotebitId,
      publicKey: ids[y].publicKeyHex,
    })),
  });
  const atX = await post(x, "/federation/v1/peer/confirm", {
    relay_id: ids[y].relayMotebitId,
    ...(await operatorConfirm(relays[y], nonceAtX, AUTH_HEADER, {
      id: ids[x].relayMotebitId,
      publicKey: ids[x].publicKeyHex,
    })),
  });
  expect([atY.status, atX.status]).toEqual([200, 200]);
}

/** Every peer row at relay `n`, byte for byte. */
function peerRows(n: Name): unknown[] {
  return relays[n].moteDb.db.prepare("SELECT * FROM relay_peers ORDER BY peer_relay_id").all();
}

function peerRow(
  n: Name,
  of: Name,
): { state: string; missed_heartbeats: number; last_heartbeat_at: number | null } {
  return relays[n].moteDb.db
    .prepare(
      "SELECT state, missed_heartbeats, last_heartbeat_at FROM relay_peers WHERE peer_relay_id = ?",
    )
    .get(ids[of].relayMotebitId) as {
    state: string;
    missed_heartbeats: number;
    last_heartbeat_at: number | null;
  };
}

function setPeer(n: Name, of: Name, state: string, missed: number): void {
  relays[n].moteDb.db
    .prepare(
      "UPDATE relay_peers SET state = ?, missed_heartbeats = ?, last_heartbeat_at = 1 WHERE peer_relay_id = ?",
    )
    .run(state, missed, ids[of].relayMotebitId);
}

beforeEach(async () => {
  relays = {} as Record<Name, SyncRelay>;
  ids = {} as Record<Name, RelayIdentity>;
  for (const n of Object.keys(URLS) as Name[]) {
    relays[n] = await createTestRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: URLS[n], displayName: `Relay ${n}` },
    });
    // The full identity (private key included) the relay booted with.
    ids[n] = await initRelayIdentity(relays[n].moteDb.db);
    expect(ids[n].relayMotebitId).toBe(relays[n].relayIdentity.relayMotebitId);
  }
  routeFetch();
  await peer("a", "b");
  await peer("a", "c");
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const r of Object.values(relays)) await r.close();
});

describe("v1 messages are refused and change nothing", () => {
  it("a captured v1 heartbeat (as the old sender signed it) is refused at every relay", async () => {
    setPeer("b", "a", "suspended", 3);
    const ts = Date.now();
    const sig = await sign(
      new TextEncoder().encode(`${ids.a.relayMotebitId}|${ts}|${SUITE}`),
      ids.a.privateKey,
    );
    const v1 = {
      relay_id: ids.a.relayMotebitId,
      timestamp: ts,
      agent_count: 7,
      signature: bytesToHex(sig),
    };
    for (const n of ["b", "c"] as const) {
      const before = peerRows(n);
      // Replayed far past the per-peer limit: no slot is spent, no row moves.
      for (let i = 0; i < 31; i++) {
        const res = await post(n, "/federation/v1/peer/heartbeat", v1);
        expect(res.status).toBe(400);
        expect(await res.text()).toMatch(/v2 `heartbeat`/);
      }
      expect(peerRows(n)).toEqual(before);
    }
    expect(peerRow("b", "a").state).toBe("suspended");
    // ...and A's real v2 heartbeat to B still gets through afterwards.
    await sendHeartbeats(relays.a.moteDb.db, ids.a);
    expect(peerRow("b", "a").missed_heartbeats).toBe(2);
  });

  it("a v1 removal (signature over the bare relay_id) is refused at every relay", async () => {
    const sig = await sign(new TextEncoder().encode(ids.a.relayMotebitId), ids.a.privateKey);
    for (const n of ["b", "c"] as const) {
      const before = peerRows(n);
      const res = await post(n, "/federation/v1/peer/remove", {
        relay_id: ids.a.relayMotebitId,
        signature: bytesToHex(sig),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(/v2 `peer-remove`/);
      expect(peerRows(n)).toEqual(before);
    }
  });

  it("self-propose is refused, signs nothing and stores nothing", async () => {
    for (const n of ["a", "b", "c"] as const) {
      const before = peerRows(n);
      const res = await post(n, "/federation/v1/peer/propose", {
        relay_id: ids[n].relayMotebitId,
        public_key: ids[n].publicKeyHex,
        endpoint_url: "https://attacker.example",
        nonce: rand(),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toMatch(/self-propose is refused/);
      expect(text).not.toMatch(/challenge/);
      expect(peerRows(n)).toEqual(before);
    }
  });

  it("the operator's confirm mint is master-token only", async () => {
    const res = await relays.a.app.request("/api/v1/admin/federation/peer-confirm-signature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: rand() }),
    });
    expect(res.status).toBe(401);
  });
});

describe("v2 heartbeat", () => {
  it("A's heartbeat loop reaches B and C, and each ack verifies", async () => {
    setPeer("a", "b", "suspended", 3);
    setPeer("b", "a", "active", 1);
    await sendHeartbeats(relays.a.moteDb.db, ids.a);
    // A counted B's heartbeat delivered only because B's ack verified.
    expect(peerRow("a", "b")).toMatchObject({ state: "suspended", missed_heartbeats: 2 });
    expect(peerRow("a", "c").missed_heartbeats).toBe(0);
    // B applied A's heartbeat.
    expect(peerRow("b", "a")).toMatchObject({ state: "active", missed_heartbeats: 0 });
    expect(peerRow("b", "a").last_heartbeat_at).toBeGreaterThan(1);
  });

  it("an unverifiable ack is a missed heartbeat", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ agent_count: 1, message: { nope: true } }), { status: 200 }),
    );
    await sendHeartbeats(relays.a.moteDb.db, ids.a);
    expect(peerRow("a", "b").missed_heartbeats).toBe(1);
  });

  it("a heartbeat signed for B is refused at C and changes no row", async () => {
    const forB = await heartbeatRequest({
      sender: ids.a.relayMotebitId,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      privateKey: ids.a.privateKey,
    });
    setPeer("c", "a", "suspended", 3);
    const before = peerRows("c");
    const res = await post("c", "/federation/v1/peer/heartbeat", forB);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/wrong_recipient/);
    expect(peerRows("c")).toEqual(before);
  });

  it("a replayed v2 heartbeat is refused at its own recipient and changes no row", async () => {
    setPeer("b", "a", "suspended", 3);
    const beat = await heartbeatRequest({
      sender: ids.a.relayMotebitId,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      privateKey: ids.a.privateKey,
    });
    expect((await post("b", "/federation/v1/peer/heartbeat", beat)).status).toBe(200);
    const before = peerRows("b");
    for (let i = 0; i < 31; i++) {
      expect((await post("b", "/federation/v1/peer/heartbeat", beat)).status).toBe(409);
    }
    expect(peerRows("b")).toEqual(before);
    expect(peerRow("b", "a")).toMatchObject({ state: "suspended", missed_heartbeats: 2 });
    // The replays spent none of A's per-peer budget: A's next real beat lands.
    await sendHeartbeats(relays.a.moteDb.db, ids.a);
    expect(peerRow("b", "a").missed_heartbeats).toBe(1);
  });

  it("a heartbeat whose body was altered after signing is refused", async () => {
    const beat = await heartbeatRequest({
      sender: ids.a.relayMotebitId,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      privateKey: ids.a.privateKey,
      agentCount: 1,
    });
    const before = peerRows("b");
    const res = await post("b", "/federation/v1/peer/heartbeat", { ...beat, agent_count: 999 });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/body_mismatch/);
    expect(peerRows("b")).toEqual(before);
  });

  it("a stale heartbeat is refused", async () => {
    const beat = await heartbeatRequest({
      sender: ids.a.relayMotebitId,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      privateKey: ids.a.privateKey,
      now: Date.now() - 301_000,
    });
    const res = await post("b", "/federation/v1/peer/heartbeat", beat);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/stale/);
  });
});

describe("v2 removal", () => {
  async function operatorRemoval(of: Name, at: Name): Promise<unknown> {
    const res = await relays[of].app.request(
      `/api/v1/admin/federation/peer-removal-signature?recipient=${ids[at].relayMotebitId}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { message: unknown }).message;
  }

  it("removes A at B only, once; the same message is refused at C and on replay", async () => {
    const message = await operatorRemoval("a", "b");

    const beforeC = peerRows("c");
    const atC = await post("c", "/federation/v1/peer/remove", { message });
    expect(atC.status).toBe(400);
    expect(await atC.text()).toMatch(/wrong_recipient/);
    expect(peerRows("c")).toEqual(beforeC);

    expect((await post("b", "/federation/v1/peer/remove", { message })).status).toBe(200);
    expect(peerRow("b", "a").state).toBe("removed");
    expect(peerRow("c", "a").state).toBe("active");

    const replay = await post("b", "/federation/v1/peer/remove", { message });
    expect(replay.status).toBe(409);
  });

  it("the operator's removal mint names one recipient and is master-token only", async () => {
    const noRecipient = await relays.a.app.request(
      "/api/v1/admin/federation/peer-removal-signature",
      { headers: AUTH_HEADER },
    );
    expect(noRecipient.status).toBe(400);
    const noAuth = await relays.a.app.request(
      `/api/v1/admin/federation/peer-removal-signature?recipient=${ids.b.relayMotebitId}`,
    );
    expect(noAuth.status).toBe(401);
  });

  it("the removal mint addresses only a confirmed peer it holds, by the key it holds (round 3, F1)", async () => {
    const mint = (q: string) =>
      relays.a.app.request(`/api/v1/admin/federation/peer-removal-signature?${q}`, {
        headers: AUTH_HEADER,
      });
    const byUrl = await mint(`endpoint_url=${encodeURIComponent(URLS.b)}`);
    expect(byUrl.status).toBe(200);
    const body = (await byUrl.json()) as {
      recipient: string;
      recipient_public_key: string;
      message: { envelope: { recipient: string; recipient_public_key: string } };
    };
    expect(body.recipient).toBe(ids.b.relayMotebitId);
    expect(body.recipient_public_key).toBe(ids.b.publicKeyHex.toLowerCase());
    expect(body.message.envelope).toMatchObject({
      recipient: ids.b.relayMotebitId,
      recipient_public_key: ids.b.publicKeyHex.toLowerCase(),
    });
    // No confirmed peer there — an endpoint or id A holds none for (whatever
    // that URL's /identity would claim): nothing is minted.
    expect((await mint(`endpoint_url=${encodeURIComponent("http://nowhere.test:9")}`)).status).toBe(
      404,
    );
    expect((await mint(`recipient=relay-unknown-${rand().slice(0, 8)}`)).status).toBe(404);
    expect(
      (await mint(`endpoint_url=${encodeURIComponent(URLS.b)}&recipient=${ids.c.relayMotebitId}`))
        .status,
    ).toBe(404);
  });

  it("a removal signed by a stranger's key is refused", async () => {
    const { generateKeypair } = await import("@motebit/encryption");
    const stranger = await generateKeypair();
    const forged = await removeRequest({
      sender: ids.a.relayMotebitId,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      privateKey: stranger.privateKey,
    });
    const before = peerRows("b");
    const res = await post("b", "/federation/v1/peer/remove", forged);
    expect(res.status).toBe(403);
    expect(peerRows("b")).toEqual(before);
  });
});

// §3.5's verifier order: parse, kind, recipient = self, THEN the sender's key
// in relay_peers — an unknown sender is 403, and a message for another relay
// is 400 `wrong_recipient` whether or not this relay knows its sender.
describe("§3.5 order: recipient before lookup; unknown sender is 403", () => {
  async function stranger(): Promise<{ id: string; privateKey: Uint8Array }> {
    const { generateKeypair } = await import("@motebit/encryption");
    const kp = await generateKeypair();
    return { id: `relay-stranger-${rand().slice(0, 12)}`, privateKey: kp.privateKey };
  }

  it("a heartbeat from a sender B holds no peer for is 403, and changes nothing", async () => {
    const s = await stranger();
    const beat = await heartbeatRequest({
      sender: s.id,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      privateKey: s.privateKey,
    });
    const before = peerRows("b");
    const res = await post("b", "/federation/v1/peer/heartbeat", beat);
    expect(res.status).toBe(403);
    expect(peerRows("b")).toEqual(before);
  });

  it("a removal from a sender B holds no peer for is 403, and changes nothing", async () => {
    const s = await stranger();
    const removal = await removeRequest({
      sender: s.id,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      privateKey: s.privateKey,
    });
    const before = peerRows("b");
    const res = await post("b", "/federation/v1/peer/remove", removal);
    expect(res.status).toBe(403);
    expect(peerRows("b")).toEqual(before);
  });

  it("a message for another relay is 400 wrong_recipient before any key lookup", async () => {
    const s = await stranger();
    const beat = await heartbeatRequest({
      sender: s.id,
      recipient: ids.c.relayMotebitId,
      recipientPublicKey: ids.c.publicKeyHex,
      privateKey: s.privateKey,
    });
    const hb = await post("b", "/federation/v1/peer/heartbeat", beat);
    expect(hb.status).toBe(400);
    expect(await hb.text()).toMatch(/wrong_recipient/);
    const removal = await removeRequest({
      sender: s.id,
      recipient: ids.c.relayMotebitId,
      recipientPublicKey: ids.c.publicKeyHex,
      privateKey: s.privateKey,
    });
    const rm = await post("b", "/federation/v1/peer/remove", removal);
    expect(rm.status).toBe(400);
    expect(await rm.text()).toMatch(/wrong_recipient/);
  });

  it("a peer-remove sent to the heartbeat route is 400 kind_mismatch before any key lookup", async () => {
    const s = await stranger();
    const removal = await removeRequest({
      sender: s.id,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      privateKey: s.privateKey,
    });
    const res = await post("b", "/federation/v1/peer/heartbeat", {
      ...removal,
      agent_count: 0,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/kind_mismatch/);
  });
});
