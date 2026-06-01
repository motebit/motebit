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
 * with DISTINCT admin tokens complete the signed peering handshake, and the
 * `/federation/v1/*` routes are NOT gated by the admin token (they are
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
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

/** Bilateral signed handshake (the sequence proven green in scripts/two-operator-e2e.ts). No auth headers. */
async function handshake(a: SyncRelay, b: SyncRelay) {
  const idA = (await fed(a, "GET", "/federation/v1/identity")).body as {
    relay_motebit_id: string;
    public_key: string;
  };
  const idB = (await fed(b, "GET", "/federation/v1/identity")).body as {
    relay_motebit_id: string;
    public_key: string;
  };

  const nB = (
    await fed(b, "POST", "/federation/v1/peer/propose", {
      relay_id: idA.relay_motebit_id,
      public_key: idA.public_key,
      endpoint_url: A_URL,
      display_name: "Operator A",
      nonce: rand(),
    })
  ).body as { nonce: string };
  const nA = (
    await fed(a, "POST", "/federation/v1/peer/propose", {
      relay_id: idB.relay_motebit_id,
      public_key: idB.public_key,
      endpoint_url: B_URL,
      display_name: "Operator B",
      nonce: rand(),
    })
  ).body as { nonce: string };
  const sigA = (
    await fed(a, "POST", "/federation/v1/peer/propose", {
      relay_id: idA.relay_motebit_id,
      public_key: idA.public_key,
      endpoint_url: A_URL,
      nonce: nB.nonce,
    })
  ).body as { challenge: string };
  const sigB = (
    await fed(b, "POST", "/federation/v1/peer/propose", {
      relay_id: idB.relay_motebit_id,
      public_key: idB.public_key,
      endpoint_url: B_URL,
      nonce: nA.nonce,
    })
  ).body as { challenge: string };
  const confirmB = await fed(b, "POST", "/federation/v1/peer/confirm", {
    relay_id: idA.relay_motebit_id,
    challenge_response: sigA.challenge,
  });
  const confirmA = await fed(a, "POST", "/federation/v1/peer/confirm", {
    relay_id: idB.relay_motebit_id,
    challenge_response: sigB.challenge,
  });
  return { idA, idB, confirmA: confirmA.status, confirmB: confirmB.status };
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
        relay_id: idB.relay_motebit_id,
        public_key: idB.public_key,
        endpoint_url: B_URL,
        nonce: rand(),
      }),
    });
    // A wrong token does not change the outcome — the route never consults it.
    expect(proposeNoAuth.status).not.toBe(401);
  });
});
