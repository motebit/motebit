/**
 * relay-federation@1.5 §3.1/§3.5 — a peer-key confirm is accepted only at the
 * relay it was meant for, for the endpoint it was meant to confirm.
 *
 * The class (cold review F1): a message signed under a peer's key accepted at
 * a relay it was not meant for. The 1.4 confirm bytes `{relay_id}:{nonce}:{suite}`
 * name no recipient and no endpoint, and the operator's tooling signed
 * whatever nonce the counterparty returned. So:
 *
 *   relays A, B, M. M proposes at B AS A (A's public key, M's endpoint); B
 *   answers with nonce N. A's operator peers with M; M answers A's propose
 *   with N. A's tooling signs a confirm over N; M posts it to B — and B makes
 *   A's row active at M's endpoint. Works on a peer B holds suspended (a
 *   revival at the wrong endpoint) and on an id B never peered.
 *
 * What must hold: every variant ends refused at B with B's row for A exactly
 * as it was before M's confirm, and the legitimate lifecycle (propose →
 * confirm → heartbeat → remove → re-peer) still works.
 *
 * The tooling is driven as `motebit federation peer` drives it: it asks its
 * own relay's operator route to mint the confirm, naming the nonce, the
 * counterparty it proposed to and its own endpoint, and hands the counterparty
 * whatever the route returned. M forwards that output to B unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToHex, sign } from "@motebit/encryption";

import type { SyncRelay } from "../index.js";
import { initRelayIdentity, type RelayIdentity } from "../federation.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import { heartbeatRequest, signedConfirm } from "./federation-messages.js";

const URLS = {
  a: "http://relay-a.bind.test:3000",
  b: "http://relay-b.bind.test:3001",
  m: "http://relay-m.bind.test:3666",
} as const;
type Name = keyof typeof URLS;

const rand = (): string => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

let relays: Record<Name, SyncRelay>;
let ids: Record<Name, RelayIdentity>;
let clockOffset = 0;

let ipSeq = 0;
async function post(n: Name, path: string, body: unknown, headers?: Record<string, string>) {
  ipSeq++;
  return relays[n].app.request(path, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "x-forwarded-for": `203.0.${ipSeq >> 8}.${ipSeq & 255}`,
    },
    body: JSON.stringify(body),
  });
}

/** A propose at `at` claiming to be `as`, at `endpoint`. */
async function propose(at: Name, as: Name, endpoint: string): Promise<string> {
  const res = await post(at, "/federation/v1/peer/propose", {
    relay_id: ids[as].relayMotebitId,
    public_key: ids[as].publicKeyHex,
    endpoint_url: endpoint,
    nonce: rand(),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { nonce: string }).nonce;
}

/**
 * `op`'s operator tooling: mint `op`'s confirm for `nonce`, naming the
 * counterparty it proposed to and its own endpoint. Returns the route's
 * output verbatim.
 */
async function mint(
  op: Name,
  nonce: string,
  counterparty: { id: string; publicKey: string },
): Promise<Record<string, unknown>> {
  const res = await post(
    op,
    "/api/v1/admin/federation/peer-confirm-signature",
    {
      nonce,
      recipient: counterparty.id,
      recipient_public_key: counterparty.publicKey,
      endpoint_url: URLS[op],
    },
    AUTH_HEADER,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** Deliver a minted confirm to `at`, the way the tooling (or M) does: as minted. */
async function confirm(
  at: Name,
  from: Name,
  nonce: string,
  minted: Record<string, unknown>,
): Promise<Response> {
  return post(at, "/federation/v1/peer/confirm", {
    relay_id: ids[from].relayMotebitId,
    nonce,
    ...minted,
  });
}

/** One half: `from` proposes at `at` and confirms with its operator's mint. */
async function half(from: Name, at: Name): Promise<void> {
  const n = await propose(at, from, URLS[from]);
  const res = await confirm(
    at,
    from,
    n,
    await mint(from, n, { id: ids[at].relayMotebitId, publicKey: ids[at].publicKeyHex }),
  );
  expect(res.status).toBe(200);
}

function rowAt(n: Name, of: Name): Record<string, unknown> | undefined {
  return relays[n].moteDb.db
    .prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ?")
    .get(ids[of].relayMotebitId) as Record<string, unknown> | undefined;
}

beforeEach(async () => {
  clockOffset = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  relays = {} as Record<Name, SyncRelay>;
  ids = {} as Record<Name, RelayIdentity>;
  for (const n of Object.keys(URLS) as Name[]) {
    relays[n] = await createTestRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: URLS[n], displayName: `Relay ${n}` },
    });
    ids[n] = await initRelayIdentity(relays[n].moteDb.db);
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of Object.values(relays)) await r.close();
});

describe("F1: A's confirm, obtained by M, is refused at B", () => {
  /**
   * M proposes at B as A at M's endpoint and gets N; A's operator peers with
   * M (M answers A's propose with N); A's tooling mints its confirm naming
   * `counterparty` (M's own id, or B's id if M claims to be B); M posts it to
   * B. Returns B's response; B's row for A must not have changed.
   */
  async function attack(counterparty: "m-id" | "claims-b"): Promise<{
    status: number;
    before: Record<string, unknown> | undefined;
    after: Record<string, unknown> | undefined;
  }> {
    const N = await propose("b", "a", URLS.m); // M, as A, at B
    // A's operator runs `motebit federation peer <M>`: A proposes at M, and M
    // (malicious) answers with N instead of a nonce of its own.
    await propose("m", "a", URLS.a);
    // Either way M's /identity advertises M's own key — the key A's tooling
    // verified M's challenge under, so the key A's confirm commits to.
    const recipient = counterparty === "m-id" ? ids.m.relayMotebitId : ids.b.relayMotebitId;
    const minted = await mint("a", N, { id: recipient, publicKey: ids.m.publicKeyHex });
    const before = rowAt("b", "a");
    const res = await confirm("b", "a", N, minted); // M forwards it to B
    return { status: res.status, before, after: rowAt("b", "a") };
  }

  describe("A is B's peer, suspended", () => {
    beforeEach(async () => {
      await half("a", "b");
      relays.b.moteDb.db
        .prepare(
          "UPDATE relay_peers SET state = 'suspended', missed_heartbeats = 3 WHERE peer_relay_id = ?",
        )
        .run(ids.a.relayMotebitId);
    });

    it("M names itself as the counterparty: refused, B's row unchanged", async () => {
      const r = await attack("m-id");
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.after).toEqual(r.before);
      expect(r.after).toMatchObject({ state: "suspended", endpoint_url: URLS.a });
    });

    it("M claims B's identity: refused, B's row unchanged", async () => {
      const r = await attack("claims-b");
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.after).toEqual(r.before);
      expect(r.after).toMatchObject({ state: "suspended", endpoint_url: URLS.a });
    });
  });

  describe("A never peered with B", () => {
    it("M names itself as the counterparty: refused, B's row unchanged", async () => {
      const r = await attack("m-id");
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.after).toEqual(r.before);
      expect(r.after?.state).not.toBe("active");
    });

    it("A's confirm names B by id AND key, over a nonce M obtained at M's endpoint: the endpoint check alone refuses it", async () => {
      // Recipient id and key are both right here (as if A's operator minted
      // without the tooling's challenge check), so only the endpoint binding
      // stands between M and A active at M's endpoint: B issued the nonce for
      // M's endpoint only (the handshake is the nonce), and A's confirm names
      // A's endpoint — so it answers no handshake B issued (403); presented
      // as M's endpoint, its signed body disagrees (400 body_mismatch).
      const N = await propose("b", "a", URLS.m);
      const minted = await mint("a", N, {
        id: ids.b.relayMotebitId,
        publicKey: ids.b.publicKeyHex,
      });
      const before = rowAt("b", "a");
      const res = await confirm("b", "a", N, minted);
      expect(res.status).toBe(403);
      const asM = await confirm("b", "a", N, { ...minted, endpoint_url: URLS.m });
      expect(asM.status).toBe(400);
      expect(await asM.text()).toMatch(/body_mismatch/);
      expect(rowAt("b", "a")).toEqual(before);
    });

    it("M claims B's identity: refused, and A is never active at B", async () => {
      const r = await attack("claims-b");
      expect(r.status).toBeGreaterThanOrEqual(400);
      // A propose writes no row, so a never-peered id has none — before or
      // after the refused confirm (§3.1).
      expect(r.after === undefined || r.after.state !== "active").toBe(true);
      expect(r.after?.peered_at ?? null).toBeNull();
    });
  });
});

describe("the legitimate lifecycle still works", () => {
  it("propose → confirm → heartbeat → remove → re-peer", async () => {
    await half("a", "b");
    await half("b", "a");
    expect(rowAt("b", "a")).toMatchObject({ state: "active", endpoint_url: URLS.a });
    expect(rowAt("a", "b")).toMatchObject({ state: "active", endpoint_url: URLS.b });

    const beat = await heartbeatRequest({
      sender: ids.a.relayMotebitId,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      privateKey: ids.a.privateKey,
      agentCount: 2,
    });
    expect((await post("b", "/federation/v1/peer/heartbeat", beat)).status).toBe(200);

    const removal = await relays.a.app.request(
      `/api/v1/admin/federation/peer-removal-signature?recipient=${ids.b.relayMotebitId}`,
      { headers: AUTH_HEADER },
    );
    const { message } = (await removal.json()) as { message: unknown };
    expect((await post("b", "/federation/v1/peer/remove", { message })).status).toBe(200);
    expect(rowAt("b", "a")?.state).toBe("removed");

    clockOffset += 6 * 60 * 1000; // past the removed-peer cooldown
    await half("a", "b");
    expect(rowAt("b", "a")).toMatchObject({ state: "active", endpoint_url: URLS.a });
  });
});

describe("the 1.0–1.4 confirm is refused by name", () => {
  it("{ relay_id, challenge_response } over {relay_id}:{nonce}:{suite}, signed by A: 400, nothing changes", async () => {
    const N = await propose("b", "a", URLS.a);
    const before = rowAt("b", "a");
    const sig = await sign(
      new TextEncoder().encode(`${ids.a.relayMotebitId}:${N}:motebit-concat-ed25519-hex-v1`),
      ids.a.privateKey,
    );
    const res = await post("b", "/federation/v1/peer/confirm", {
      relay_id: ids.a.relayMotebitId,
      challenge_response: bytesToHex(sig),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/confirm v1 .* is refused/);
    expect(rowAt("b", "a")).toEqual(before);
  });
});

// Round 3 (F3, F4): no pending handshake is stored — the nonce IS the
// handshake, recognised only for the relay_id, key and endpoint its propose
// named, so nothing a caller proposes can evict or exhaust another's.
describe("the handshake is its nonce: bound to what the propose named, never evictable", () => {
  const confirmBy = (
    nonce: string,
    endpointUrl: string,
    extra: { proposedEndpointUrl?: string; proposedPublicKey?: string } = {},
  ) =>
    signedConfirm({
      sender: ids.a.relayMotebitId,
      recipient: ids.b.relayMotebitId,
      recipientPublicKey: ids.b.publicKeyHex,
      nonce,
      endpointUrl,
      privateKey: ids.a.privateKey,
      ...extra,
    });

  it("a confirm for an endpoint the propose did not name is refused, even signed by the key holder", async () => {
    const N = await propose("b", "a", URLS.a);
    const before = rowAt("b", "a");
    const other = "http://elsewhere.bind.test:3002";
    // Signed for the other endpoint and claiming it in the request: the nonce
    // was issued for URLS.a only.
    const res = await post("b", "/federation/v1/peer/confirm", await confirmBy(N, other));
    expect(res.status).toBe(403);
    // Claiming the named endpoint in the request but signed for another: the
    // body digest disagrees.
    const res2 = await post(
      "b",
      "/federation/v1/peer/confirm",
      await confirmBy(N, other, { proposedEndpointUrl: URLS.a }),
    );
    expect(res2.status).toBe(400);
    expect(await res2.text()).toMatch(/body_mismatch/);
    expect(rowAt("b", "a")).toEqual(before);
  });

  it("a confirm under a key the propose did not name is refused", async () => {
    const N = await propose("b", "a", URLS.a);
    // Claiming M's key but signed by A: the signature does not verify.
    const res = await post(
      "b",
      "/federation/v1/peer/confirm",
      await confirmBy(N, URLS.a, { proposedPublicKey: ids.m.publicKeyHex }),
    );
    expect(res.status).toBe(403);
    // M holds A's nonce and signs under its OWN key, which it names: every
    // signature verifies, so only the nonce's binding to the key its propose
    // named refuses it (the handshake MAC's key term).
    const res2 = await post(
      "b",
      "/federation/v1/peer/confirm",
      await signedConfirm({
        sender: ids.a.relayMotebitId,
        recipient: ids.b.relayMotebitId,
        recipientPublicKey: ids.b.publicKeyHex,
        nonce: N,
        endpointUrl: URLS.a,
        privateKey: ids.m.privateKey,
      }),
    );
    expect(res2.status).toBe(403);
    expect(rowAt("b", "a")).toBeUndefined();
  });

  it("40 proposes naming A (under A's public key and others) evict nothing: A's earlier nonce still confirms", async () => {
    const N = await propose("b", "a", URLS.a);
    for (let i = 0; i < 20; i++) {
      await propose("b", "a", `http://relay-m.bind.test:${String(4000 + i)}`);
      const res = await post("b", "/federation/v1/peer/propose", {
        relay_id: ids.a.relayMotebitId,
        public_key: ids.m.publicKeyHex,
        endpoint_url: URLS.m,
        nonce: rand(),
      });
      expect(res.status).toBe(200);
    }
    const res = await post("b", "/federation/v1/peer/confirm", await confirmBy(N, URLS.a));
    expect(res.status).toBe(200);
    expect(rowAt("b", "a")).toMatchObject({ state: "active", public_key: ids.a.publicKeyHex });
  });

  it("a nonce lapses after its window (at most ten minutes)", async () => {
    const N = await propose("b", "a", URLS.a);
    clockOffset += 11 * 60 * 1000;
    const res = await post("b", "/federation/v1/peer/confirm", await confirmBy(N, URLS.a));
    expect(res.status).toBe(403);
    expect(rowAt("b", "a")).toBeUndefined();
  });

  it("a nonce taken before a removal does not skip the removed-peer cooldown", async () => {
    await half("a", "b");
    await half("b", "a");
    relays.b.moteDb.db
      .prepare("UPDATE relay_peers SET state = 'suspended' WHERE peer_relay_id = ?")
      .run(ids.a.relayMotebitId);
    const N = await propose("b", "a", URLS.a);
    const removal = await relays.a.app.request(
      `/api/v1/admin/federation/peer-removal-signature?endpoint_url=${encodeURIComponent(URLS.b)}`,
      { headers: AUTH_HEADER },
    );
    expect(removal.status).toBe(200);
    const { message } = (await removal.json()) as { message: unknown };
    expect((await post("b", "/federation/v1/peer/remove", { message })).status).toBe(200);
    const res = await post("b", "/federation/v1/peer/confirm", await confirmBy(N, URLS.a));
    expect(res.status).toBe(429);
    expect(rowAt("b", "a")?.state).toBe("removed");
  });
});
