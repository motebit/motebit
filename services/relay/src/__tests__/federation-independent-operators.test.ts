/**
 * Drift guard — two INDEPENDENT relay operators federate with NO shared secret.
 *
 * The "second relay operator" sprint's load-bearing question (proven once by
 * `scripts/two-operator-e2e.ts`, EXIT=0): can two relays run by different
 * operators peer without sharing an admin token? They must — a protocol is a
 * protocol only if independent parties operate it, and a shared `apiToken`
 * would make federation a single-trust-domain shortcut.
 *
 * This is the in-process, deterministic CI guard for that invariant: two relays
 * with DISTINCT admin tokens complete the signed peering handshake — each
 * operator authorizing only its OWN relay's confirm, with its own token — and
 * the `/federation/v1/*` routes are NOT gated by the admin token (they are
 * signature-authed). The regression it forecloses: someone later couples
 * federation auth to the bearer token — this test goes red the moment a peer
 * route starts requiring it.
 *
 * The real-process / real-HTTP / settlement version lives in
 * `scripts/two-operator-e2e.ts` (human-run; not CI — real ports + testnet).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import { createTestRelay } from "./test-helpers.js";

const A_URL = "http://relay-a.test:3000";
const B_URL = "http://relay-b.test:3001";
// DISTINCT admin tokens — the whole point. No shared secret.
const TOKEN_A = "ADMIN-TOKEN-OPERATOR-A";
const TOKEN_B = "ADMIN-TOKEN-OPERATOR-B";

function installFetchInterceptor(relayA: SyncRelay, relayB: SyncRelay): void {
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(A_URL))
      return relayA.app.request(
        url.slice(A_URL.length),
        init as RequestInit,
      ) as unknown as Response;
    if (url.startsWith(B_URL))
      return relayB.app.request(
        url.slice(B_URL.length),
        init as RequestInit,
      ) as unknown as Response;
    return originalFetch(input, init);
  });
}

const rand = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

/** POST/GET a federation route with NO Authorization header — proves the route is not token-gated. */
async function fed(relay: SyncRelay, method: string, path: string, body?: unknown) {
  const res = await relay.app.request(path, {
    method,
    headers: body != null ? { "Content-Type": "application/json" } : {},
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

/**
 * Bilateral signed handshake, v2. Each operator authorizes ITS OWN relay's
 * confirm with ITS OWN admin token (the only producer of a confirm); the
 * federation routes themselves carry no auth header. No shared secret.
 */
async function handshake(a: SyncRelay, b: SyncRelay) {
  const idA = (await fed(a, "GET", "/federation/v1/identity")).body as {
    relay_motebit_id: string;
    public_key: string;
  };
  const idB = (await fed(b, "GET", "/federation/v1/identity")).body as {
    relay_motebit_id: string;
    public_key: string;
  };

  async function peerOnto(
    prover: SyncRelay,
    proverId: { relay_motebit_id: string; public_key: string },
    proverUrl: string,
    proverToken: string,
    verifier: SyncRelay,
    verifierId: string,
  ): Promise<number> {
    const { nonce } = (
      await fed(verifier, "POST", "/federation/v1/peer/propose", {
        handshake_version: "v2",
        relay_id: proverId.relay_motebit_id,
        public_key: proverId.public_key,
        endpoint_url: proverUrl,
        nonce: rand(),
      })
    ).body as { nonce: string };
    const signed = await prover.app.request("/api/v1/admin/federation/peer-confirm-signature", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${proverToken}` },
      body: JSON.stringify({ verifier_relay_id: verifierId, nonce, endpoint_url: proverUrl }),
    });
    expect(signed.status).toBe(200);
    return (await fed(verifier, "POST", "/federation/v1/peer/confirm", await signed.json())).status;
  }

  const confirmB = await peerOnto(a, idA, A_URL, TOKEN_A, b, idB.relay_motebit_id);
  const confirmA = await peerOnto(b, idB, B_URL, TOKEN_B, a, idA.relay_motebit_id);
  return { idA, idB, confirmA, confirmB };
}

describe("federation — two independent operators, no shared admin token", () => {
  let a: SyncRelay;
  let b: SyncRelay;

  beforeEach(async () => {
    a = await createTestRelay({
      apiToken: TOKEN_A,
      enableDeviceAuth: false,
      federation: { endpointUrl: A_URL, displayName: "Operator A" },
    });
    b = await createTestRelay({
      apiToken: TOKEN_B,
      enableDeviceAuth: false,
      federation: { endpointUrl: B_URL, displayName: "Operator B" },
    });
    installFetchInterceptor(a, b);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("two relays with DISTINCT admin tokens complete the signed handshake and end mutually peered", async () => {
    expect(TOKEN_A).not.toBe(TOKEN_B); // the premise: no shared secret

    const { idA, idB, confirmA, confirmB } = await handshake(a, b);
    expect(confirmB).toBe(200);
    expect(confirmA).toBe(200);

    const peersA = (await fed(a, "GET", "/federation/v1/peers")).body as {
      peers: Array<{ peer_relay_id: string }>;
    };
    const peersB = (await fed(b, "GET", "/federation/v1/peers")).body as {
      peers: Array<{ peer_relay_id: string }>;
    };
    expect(peersA.peers.some((p) => p.peer_relay_id === idB.relay_motebit_id)).toBe(true);
    expect(peersB.peers.some((p) => p.peer_relay_id === idA.relay_motebit_id)).toBe(true);
  });

  it("the /federation/v1 peer routes are NOT gated by the admin token (signature-authed, public)", async () => {
    // No Authorization header → must NOT 401. If a peer route ever requires the
    // bearer token, this is where it goes red (the regression this guard exists for).
    expect((await fed(a, "GET", "/federation/v1/identity")).status).toBe(200);

    const idB = (await fed(b, "GET", "/federation/v1/identity")).body as {
      relay_motebit_id: string;
      public_key: string;
    };
    const proposeNoAuth = await a.app.request("/federation/v1/peer/propose", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer a-totally-wrong-token",
      },
      body: JSON.stringify({
        handshake_version: "v2",
        relay_id: idB.relay_motebit_id,
        public_key: idB.public_key,
        endpoint_url: B_URL,
        nonce: rand(),
      }),
    });
    // A wrong token does not change the outcome — the route never consults it.
    expect(proposeNoAuth.status).not.toBe(401);
  });

  it("one operator's token never mints the other relay's confirm", async () => {
    const res = await b.app.request("/api/v1/admin/federation/peer-confirm-signature", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ verifier_relay_id: a.relayIdentity.relayMotebitId, nonce: rand() }),
    });
    expect(res.status).toBe(401);
  });
});
