/**
 * P2P fee rate comes from the PINNED relay's SIGNED metadata.
 *
 * spec/market-v1.md §5.1: "Relays MAY set different fee rates; the rate used
 * MUST be declared". A relay declares it as `fee_rate` in its signed
 * `/.well-known/motebit.json` (spec/discovery-v1.md §3.2). The delegator client
 * used to hardcode the protocol's reference default (0.05), so against a relay
 * running any other rate every paid P2P proof was rejected AFTER the
 * irreversible broadcast.
 *
 * The rate is a money input on an irreversible path, so it is trusted exactly
 * like the treasury: only from metadata signed by the PINNED relay key, never
 * from an unsigned or unpinned fetch. Absent field → the reference default.
 * Malformed / out of [0,1) / unverifiable → refuse before any payment.
 * Federated: each hop's rate comes from THAT hop's signed metadata
 * (spec/relay-federation-v1.md §7.1 — "each relay applies its own rate").
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import {
  generateKeypair,
  signBySuite,
  canonicalJson,
  bytesToHex,
  deriveSovereignMotebitId,
} from "@motebit/crypto";
import {
  base58Encode,
  computeP2pFeeMicro,
  computeFederatedFeeSplit,
  toMicro,
  PLATFORM_FEE_RATE,
} from "@motebit/protocol";
import { resolveP2pPaymentRequest } from "../relay-delegation.js";

const RELAY_URL = "https://relay.test";
const PEER_URL = "https://peer.test";
const RELAY_ID = "relay-a-id";
const PEER_ID = "relay-b-id";

interface Keys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  hex: string;
}
let relay: Keys;
let peer: Keys;
let impostor: Keys;
let worker: Keys;
let WORKER_ID: string;

async function keys(): Promise<Keys> {
  const kp = await generateKeypair();
  return { ...kp, hex: bytesToHex(kp.publicKey) };
}

beforeAll(async () => {
  relay = await keys();
  peer = await keys();
  impostor = await keys();
  worker = await keys();
  WORKER_ID = await deriveSovereignMotebitId(worker.hex);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Signed RelayMetadata (discovery-v1 §3.3). `feeRate: undefined` omits the field. */
async function signedMetadata(opts: {
  signer: Keys;
  claimedKeyHex?: string;
  relayId: string;
  endpoint: string;
  feeRate?: unknown;
  peers?: Array<{ relay_id: string; endpoint_url: string }>;
}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    protocol_version: "1.0",
    relay_id: opts.relayId,
    public_key: opts.claimedKeyHex ?? opts.signer.hex,
    endpoint_url: opts.endpoint,
    capabilities: ["task_routing", "federation", "settlement"],
    ...(opts.feeRate !== undefined ? { fee_rate: opts.feeRate } : {}),
    federation_peers: opts.peers ?? [],
    agent_count: 1,
    suite: "motebit-jcs-ed25519-hex-v1",
  };
  const sig = await signBySuite(
    "motebit-jcs-ed25519-hex-v1",
    new TextEncoder().encode(canonicalJson(body)),
    opts.signer.privateKey,
  );
  return { ...body, signature: bytesToHex(sig) };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function stubFetch(handlers: {
  relayMetadata?: () => Response | Promise<Response>;
  peerMetadata?: () => Response | Promise<Response>;
  discover: () => Response;
  eligibility?: () => Response;
  listing?: () => Response;
}) {
  const fn = vi.fn(async (url: string) => {
    if (url === `${RELAY_URL}/.well-known/motebit.json`) return handlers.relayMetadata!();
    if (url === `${PEER_URL}/.well-known/motebit.json`) return handlers.peerMetadata!();
    if (url.includes("/api/v1/agents/discover")) return handlers.discover();
    if (url.includes("/p2p-eligibility"))
      return (handlers.eligibility ?? (() => json(200, { allowed: true })))();
    if (url.includes("/listing")) return handlers.listing!();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const localWorker = () =>
  json(200, {
    agents: [{ motebit_id: "bob", settlement_address: "BobAddr", settlement_modes: "p2p" }],
  });

const params = () => ({
  motebitId: "alice",
  syncUrl: RELAY_URL,
  authToken: vi.fn(async (aud?: string) => `tok-${aud}`),
  capability: "web_search",
  relayPublicKeyHex: relay.hex,
});

describe("single-operator P2P — fee rate from the pinned relay's signed metadata", () => {
  it("a relay advertising fee_rate 0.03 is paid a 3% fee leg (listing-priced path)", async () => {
    stubFetch({
      relayMetadata: async () =>
        json(
          200,
          await signedMetadata({
            signer: relay,
            relayId: RELAY_ID,
            endpoint: RELAY_URL,
            feeRate: 0.03,
          }),
        ),
      discover: localWorker,
      listing: () => json(200, { pricing: [{ capability: "web_search", unit_cost: 0.5 }] }),
    });
    const r = await resolveP2pPaymentRequest(params());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.paymentRequest.amountMicro).toBe(toMicro(0.5));
    expect(r.paymentRequest.feeAmountMicro).toBe(computeP2pFeeMicro(toMicro(0.5), 0.03));
    expect(r.paymentRequest.feeAmountMicro).not.toBe(
      computeP2pFeeMicro(toMicro(0.5), PLATFORM_FEE_RATE),
    );
  });

  it("an ABSENT fee_rate uses the protocol reference default (0.05)", async () => {
    stubFetch({
      relayMetadata: async () =>
        json(200, await signedMetadata({ signer: relay, relayId: RELAY_ID, endpoint: RELAY_URL })),
      discover: localWorker,
      listing: () => json(200, { pricing: [{ capability: "web_search", unit_cost: 0.5 }] }),
    });
    const r = await resolveP2pPaymentRequest(params());
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.paymentRequest.feeAmountMicro).toBe(
        computeP2pFeeMicro(toMicro(0.5), PLATFORM_FEE_RATE),
      );
  });

  for (const [label, bad] of [
    ["≥ 1", 1],
    ["negative", -0.01],
    ["a string", "0.03"],
    ["null", null],
  ] as const) {
    it(`a malformed fee_rate (${label}) refuses BEFORE any payment is priced`, async () => {
      stubFetch({
        relayMetadata: async () =>
          json(
            200,
            await signedMetadata({
              signer: relay,
              relayId: RELAY_ID,
              endpoint: RELAY_URL,
              feeRate: bad,
            }),
          ),
        discover: localWorker,
        listing: () => json(200, { pricing: [{ capability: "web_search", unit_cost: 0.5 }] }),
      });
      const r = await resolveP2pPaymentRequest(params());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("relay_fee_rate_unverified");
    });
  }

  it("metadata NOT signed by the pinned key is refused (a MITM cannot set the rate)", async () => {
    stubFetch({
      relayMetadata: async () =>
        json(
          200,
          await signedMetadata({
            signer: impostor,
            claimedKeyHex: relay.hex,
            relayId: RELAY_ID,
            endpoint: RELAY_URL,
            feeRate: 0.5,
          }),
        ),
      discover: localWorker,
      listing: () => json(200, { pricing: [{ capability: "web_search", unit_cost: 0.5 }] }),
    });
    const r = await resolveP2pPaymentRequest(params());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("relay_fee_rate_unverified");
  });

  it("validly-signed metadata for a DIFFERENT key than the pin is refused", async () => {
    stubFetch({
      relayMetadata: async () =>
        json(
          200,
          await signedMetadata({
            signer: impostor,
            relayId: RELAY_ID,
            endpoint: RELAY_URL,
            feeRate: 0.03,
          }),
        ),
      discover: localWorker,
      listing: () => json(200, { pricing: [{ capability: "web_search", unit_cost: 0.5 }] }),
    });
    const r = await resolveP2pPaymentRequest(params());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("relay_fee_rate_unverified");
  });

  it("unreachable metadata refuses (never silently assumes a rate)", async () => {
    stubFetch({
      relayMetadata: () => json(503, {}),
      discover: localWorker,
      listing: () => json(200, { pricing: [{ capability: "web_search", unit_cost: 0.5 }] }),
    });
    const r = await resolveP2pPaymentRequest(params());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("relay_fee_rate_unverified");
  });
});

describe("federated P2P — each hop's rate from THAT hop's signed metadata", () => {
  const federatedWorker = () =>
    json(200, {
      agents: [
        {
          motebit_id: WORKER_ID,
          public_key: worker.hex,
          settlement_address: base58Encode(worker.publicKey),
          settlement_modes: "p2p",
          source_relay: PEER_ID,
          source_relay_public_key: peer.hex,
          pricing: [{ capability: "web_search", unit_cost: 1 }],
        },
      ],
    });

  const originMetadata = (feeRate: unknown) => async () =>
    json(
      200,
      await signedMetadata({
        signer: relay,
        relayId: RELAY_ID,
        endpoint: RELAY_URL,
        feeRate,
        peers: [{ relay_id: PEER_ID, endpoint_url: PEER_URL }],
      }),
    );

  it("origin 0.03 + executor 0.02: the split applies each relay's own rate", async () => {
    stubFetch({
      relayMetadata: originMetadata(0.03),
      peerMetadata: async () =>
        json(
          200,
          await signedMetadata({
            signer: peer,
            relayId: PEER_ID,
            endpoint: PEER_URL,
            feeRate: 0.02,
          }),
        ),
      discover: federatedWorker,
    });
    const r = await resolveP2pPaymentRequest(params());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const budget = toMicro(1);
    const originFee = Math.round(budget * 0.03);
    const executorFee = Math.round((budget - originFee) * 0.02);
    expect(r.paymentRequest.feeAmountMicro).toBe(originFee);
    expect(r.paymentRequest.executorFeeAmountMicro).toBe(executorFee);
    expect(r.paymentRequest.amountMicro).toBe(budget - originFee - executorFee);
    expect(computeFederatedFeeSplit(budget, 0.03, 0.02)).toEqual({
      originFeeMicro: originFee,
      executorFeeMicro: executorFee,
      workerNetMicro: budget - originFee - executorFee,
    });
  });

  it("both rates absent → the reference default on both hops (today's split)", async () => {
    stubFetch({
      relayMetadata: originMetadata(undefined),
      peerMetadata: async () =>
        json(200, await signedMetadata({ signer: peer, relayId: PEER_ID, endpoint: PEER_URL })),
      discover: federatedWorker,
    });
    const r = await resolveP2pPaymentRequest(params());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const split = computeFederatedFeeSplit(toMicro(1), PLATFORM_FEE_RATE);
    expect(r.paymentRequest.feeAmountMicro).toBe(split.originFeeMicro);
    expect(r.paymentRequest.executorFeeAmountMicro).toBe(split.executorFeeMicro);
  });

  it("executor metadata not signed by the peer key the pinned origin vouched for is refused", async () => {
    stubFetch({
      relayMetadata: originMetadata(0.03),
      peerMetadata: async () =>
        json(
          200,
          await signedMetadata({
            signer: impostor,
            claimedKeyHex: peer.hex,
            relayId: PEER_ID,
            endpoint: PEER_URL,
            feeRate: 0,
          }),
        ),
      discover: federatedWorker,
    });
    const r = await resolveP2pPaymentRequest(params());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("relay_fee_rate_unverified");
  });

  it("a malformed executor fee_rate refuses before any payment is priced", async () => {
    stubFetch({
      relayMetadata: originMetadata(0.03),
      peerMetadata: async () =>
        json(
          200,
          await signedMetadata({ signer: peer, relayId: PEER_ID, endpoint: PEER_URL, feeRate: 2 }),
        ),
      discover: federatedWorker,
    });
    const r = await resolveP2pPaymentRequest(params());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("relay_fee_rate_unverified");
  });

  it("an executor relay the pinned origin does not list as a peer is refused", async () => {
    stubFetch({
      relayMetadata: originMetadata(0.03).bind(null),
      discover: () =>
        json(200, {
          agents: [
            {
              motebit_id: WORKER_ID,
              public_key: worker.hex,
              settlement_address: base58Encode(worker.publicKey),
              settlement_modes: "p2p",
              source_relay: "unlisted-relay",
              source_relay_public_key: peer.hex,
              pricing: [{ capability: "web_search", unit_cost: 1 }],
            },
          ],
        }),
    });
    const r = await resolveP2pPaymentRequest(params());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("relay_fee_rate_unverified");
  });
});
