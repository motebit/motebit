/**
 * M3 — "No payment is broadcast unless the task it pays for has already
 * secured admission; a payment can never precede the authority to submit."
 *
 * Evidence cells for the paid-never-submitted window in
 * `resolveAndSubmitP2pDelegation`: the resolver prices a payment, the rail
 * BROADCASTS it, and only then does the client mint its `task:submit`
 * credential and ask the relay to admit the task. Anything that fails in
 * between (the credential is gone, the relay refuses, the network throws)
 * leaves the worker paid and the task never submitted.
 *
 * The fix is NOT a client reorder: the relay admits a P2P task only after it
 * has read the payment's payer from the chain at `confirmed` commitment
 * (spec/delegation-v1.md §3.3, 503 `TASK_P2P_PROOF_UNVERIFIED` otherwise), so
 * admission structurally REQUIRES a landed transaction. Closing the window
 * needs a protocol decision (a pre-broadcast admission step) — see the M3
 * design note. Until then the invariant cells are `it.fails("GAP: …")`: they
 * pass while the gap is open and turn red the day it closes, at which point
 * `.fails` is removed.
 *
 * M3a (option D, client-only interim) closed the cells it can: the
 * `task:submit` credential is minted at pricing and held across the
 * broadcast, the pre-flight is re-run immediately before the broadcast (the
 * federated path re-discovers its pinned worker), and the abort signal is
 * re-checked last. Those cells are now plain tests. The cells still
 * `it.fails` — (b) for a refusal no pre-flight mirrors, and (c) — are the
 * founder-decision backlog: docs/proposals/admission-before-broadcast-m3.md.
 *
 * Probe shape (founder report, 2026-10-12): a FEDERATED worker is priced from
 * discovery + signed metadata alone — no credential is minted anywhere in the
 * resolver — so a delegation whose credentials vanish mid-discover still
 * resolves a fully priced request and reaches the broadcast.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  canonicalJson,
  deriveSovereignMotebitId,
  generateKeypair,
  signBySuite,
} from "@motebit/crypto";
import type { P2pPaymentProof, SovereignP2pPaymentRequest } from "@motebit/protocol";
import { base58Encode } from "@motebit/protocol";
import { resolveAndSubmitP2pDelegation, resolveP2pPaymentRequest } from "../relay-delegation.js";
import type { P2pBroadcastHooks } from "../relay-delegation.js";

const RELAY_URL = "https://relay.test";
const PEER_URL = "https://peer.test";
const RELAY_ID = "relay-a-id";
const PEER_ID = "relay-b-id";
const ME = "alice-m3";

interface Keys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  hex: string;
}
let relay: Keys;
let peer: Keys;
/** A second federation peer that also lists the same worker. */
let otherPeer: Keys;
let worker: Keys;
let WORKER_ID: string;

async function keys(): Promise<Keys> {
  const kp = await generateKeypair();
  return { ...kp, hex: bytesToHex(kp.publicKey) };
}

beforeAll(async () => {
  relay = await keys();
  peer = await keys();
  otherPeer = await keys();
  worker = await keys();
  WORKER_ID = await deriveSovereignMotebitId(worker.hex);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signedMetadata(opts: {
  signer: Keys;
  relayId: string;
  endpoint: string;
  peers?: Array<{ relay_id: string; endpoint_url: string }>;
}): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    protocol_version: "1.0",
    relay_id: opts.relayId,
    public_key: opts.signer.hex,
    endpoint_url: opts.endpoint,
    capabilities: ["task_routing", "federation", "settlement"],
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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type SubmitAnswer = "201" | "403" | "throw";

/** Everything the relay saw, and every payment the rail sent. */
interface World {
  /** Payments the rail actually sent (the irreversible act). */
  broadcasts: P2pPaymentProof[];
  /** Task submissions that reached the relay, with the proof they carried. */
  submits: Array<{ txHash: string; authorization: string | undefined }>;
  /** True once the delegation's credentials are gone (mobile Relay OFF). */
  credentialsGone: boolean;
}

/**
 * The origin relay + its federated peer. `loseCredentialsDuringDiscover`
 * removes the credentials while the discovery read is in flight — the
 * founder's probe shape.
 */
function world(opts: {
  submit: SubmitAnswer;
  loseCredentialsDuringDiscover?: boolean;
  /** What the relay's discovery answers on its SECOND read (the pre-broadcast re-check). */
  rediscover?: "same" | "gone" | "repriced" | "address_changed" | "other_peer";
  /** A worker hosted by the origin relay (2-leg path) instead of a federated one. */
  local?: boolean;
  /** The local `/p2p-eligibility` answer on its SECOND read. */
  reEligibility?: "allowed" | "refused" | "address_changed" | "amounts_changed";
}): World {
  const w: World = { broadcasts: [], submits: [], credentialsGone: false };
  let discovers = 0;
  let eligibilityReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      if (url === `${RELAY_URL}/.well-known/motebit.json`) {
        return json(
          200,
          await signedMetadata({
            signer: relay,
            relayId: RELAY_ID,
            endpoint: RELAY_URL,
            peers: [{ relay_id: PEER_ID, endpoint_url: PEER_URL }],
          }),
        );
      }
      if (url === `${PEER_URL}/.well-known/motebit.json`) {
        return json(
          200,
          await signedMetadata({ signer: peer, relayId: PEER_ID, endpoint: PEER_URL }),
        );
      }
      if (url.includes("/api/v1/agents/discover")) {
        if (opts.loseCredentialsDuringDiscover === true) w.credentialsGone = true;
        discovers++;
        const again = discovers > 1 ? (opts.rediscover ?? "same") : "same";
        if (again === "gone") return json(200, { agents: [] });
        const placement =
          opts.local === true
            ? { hop_distance: 0 }
            : again === "other_peer"
              ? // The same worker, relisted through a DIFFERENT peer relay.
                {
                  source_relay: "relay-c-id",
                  source_relay_public_key: otherPeer.hex,
                  hop_distance: 1,
                }
              : { source_relay: PEER_ID, source_relay_public_key: peer.hex, hop_distance: 1 };
        return json(200, {
          agents: [
            {
              motebit_id: WORKER_ID,
              public_key: worker.hex,
              settlement_address:
                again === "address_changed"
                  ? base58Encode(otherPeer.publicKey)
                  : base58Encode(worker.publicKey),
              settlement_modes: "p2p",
              ...placement,
              pricing: [{ capability: "web_search", unit_cost: again === "repriced" ? 2 : 1 }],
            },
          ],
        });
      }
      if (url.includes(`/api/v1/agents/${WORKER_ID}/p2p-eligibility`)) {
        eligibilityReads++;
        const again = eligibilityReads > 1 ? (opts.reEligibility ?? "allowed") : "allowed";
        const refused = again === "refused";
        return json(200, {
          allowed: !refused,
          ...(refused ? { reason: "Active dispute d-1 between agents" } : {}),
          expected_amount_micro: again === "amounts_changed" ? 2_000_000 : 1_000_000,
          expected_fee_micro: again === "amounts_changed" ? 100_000 : 50_000,
          settlement_address:
            again === "address_changed"
              ? base58Encode(otherPeer.publicKey)
              : base58Encode(worker.publicKey),
        });
      }
      if (method === "POST" && url.endsWith(`/agent/${ME}/task`)) {
        const body = JSON.parse(init!.body as string) as { payment_proof: P2pPaymentProof };
        const headers = init!.headers as Record<string, string>;
        w.submits.push({
          txHash: body.payment_proof.tx_hash,
          authorization: headers.Authorization,
        });
        if (opts.submit === "throw") throw new TypeError("fetch failed: ECONNRESET");
        if (opts.submit === "403") {
          return json(403, { code: "TASK_P2P_INELIGIBLE", error: "pair not P2P-eligible" });
        }
        return json(201, { task_id: "task-1" });
      }
      if (method === "GET" && url.endsWith(`/agent/${ME}/task/task-1`)) {
        return json(200, {
          task: { status: "completed" },
          receipt: {
            task_id: "task-1",
            relay_task_id: "task-1",
            motebit_id: WORKER_ID,
            device_id: "d",
            submitted_at: 1,
            completed_at: 2,
            status: "completed",
            result: "done",
            tools_used: [],
            memories_formed: 0,
            prompt_hash: "a".repeat(64),
            result_hash: "b".repeat(64),
            suite: "motebit-jcs-ed25519-b64-v1",
            signature: "s",
          },
        });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return w;
}

let txCounter = 0;

/** A rail that "sends" the payment: every call is one irreversible broadcast. */
function rail(w: World) {
  return vi.fn(async (request: SovereignP2pPaymentRequest): Promise<P2pPaymentProof> => {
    const proof: P2pPaymentProof = {
      tx_hash: `${"5".repeat(80)}${String(++txCounter).padStart(8, "1")}`,
      chain: "solana",
      network: "solana:test",
      to_address: request.workerAddress,
      amount_micro: request.amountMicro,
      fee_to_address: request.treasuryAddress,
      fee_amount_micro: request.feeAmountMicro,
      ...(request.executorTreasuryAddress != null
        ? {
            b_fee_to_address: request.executorTreasuryAddress,
            b_fee_amount_micro: request.executorFeeAmountMicro ?? 0,
          }
        : {}),
    };
    w.broadcasts.push(proof);
    return proof;
  });
}

function delegate(
  w: World,
  overrides: {
    signal?: AbortSignal;
    buildP2pPayment?: (
      request: SovereignP2pPaymentRequest,
      hooks?: P2pBroadcastHooks,
    ) => Promise<P2pPaymentProof>;
  } = {},
) {
  return resolveAndSubmitP2pDelegation({
    motebitId: ME,
    syncUrl: RELAY_URL,
    // The delegation's credential source: fails once the credentials are gone.
    authToken: vi.fn(async (aud?: string) => {
      if (w.credentialsGone) throw new Error("relay credentials unavailable (Relay OFF)");
      return `tok-${aud}`;
    }),
    prompt: "find the thing",
    capability: "web_search",
    relayPublicKeyHex: relay.hex,
    buildP2pPayment: rail(w),
    logger: { warn: () => {} },
    submitRetry: { delaysMs: [0, 0, 0], sleep: async () => {} },
    timeoutMs: 10_000,
    ...overrides,
  });
}

describe("M3 — a federated payment is never priced without the credential to submit it", () => {
  it("credentials gone before resolve: no priced request comes back (probe shape, M3a)", async () => {
    const w = world({ submit: "201" });
    w.credentialsGone = true;
    const authToken = vi.fn(async () => {
      throw new Error("relay credentials unavailable (Relay OFF)");
    });
    const r = await resolveP2pPaymentRequest({
      motebitId: ME,
      syncUrl: RELAY_URL,
      authToken,
      capability: "web_search",
      relayPublicKeyHex: relay.hex,
    });
    // M3a: the resolver mints the task:submit credential once priced; none ⇒ no request.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("auth_expired");
    expect(authToken).toHaveBeenCalledWith("task:submit");
  });

  it("a resolved payment request does not survive credential loss", async () => {
    const w = world({ submit: "201", loseCredentialsDuringDiscover: true });
    const r = await resolveP2pPaymentRequest({
      motebitId: ME,
      syncUrl: RELAY_URL,
      authToken: vi.fn(async (aud?: string) => {
        if (w.credentialsGone) throw new Error("relay credentials unavailable");
        return `tok-${aud}`;
      }),
      capability: "web_search",
      relayPublicKeyHex: relay.hex,
    });
    expect(r.ok).toBe(false);
  });
});

describe("M3 — invariant: broadcasts == 0 whenever admission was not secured", () => {
  it("(a) credentials lost between resolve and submit ⇒ nothing broadcast (M3a)", async () => {
    const w = world({ submit: "201", loseCredentialsDuringDiscover: true });
    const result = await delegate(w);
    expect(w.broadcasts).toHaveLength(0);
    expect(w.submits).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("auth_expired");
      expect(result.error.settledPayment).toBeUndefined();
    }
  });

  it("(a′) credentials lost DURING the broadcast: the held credential still submits it (M3a)", async () => {
    const w = world({ submit: "201" });
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const resp = await inner(input, init);
        // The credentials come back only once the submission has been made,
        // so the submission itself can only have used the held credential.
        if (init?.method === "POST") w.credentialsGone = false;
        return resp;
      }),
    );
    const send = rail(w);
    const result = await delegate(w, {
      buildP2pPayment: async (request) => {
        const proof = await send(request);
        w.credentialsGone = true;
        return proof;
      },
    });
    expect(w.broadcasts).toHaveLength(1);
    expect(w.submits).toHaveLength(1);
    expect(w.submits[0]!.txHash).toBe(w.broadcasts[0]!.tx_hash);
    expect(w.submits[0]!.authorization).toBe("Bearer tok-task:submit");
    expect(result.ok).toBe(true);
  }, 15_000);

  it("(b) the relay refuses admission (4xx) — today: refused AFTER the broadcast", async () => {
    const w = world({ submit: "403" });
    const result = await delegate(w);
    expect(w.broadcasts).toHaveLength(1);
    expect(w.submits).toHaveLength(1);
    expect(w.submits[0]!.txHash).toBe(w.broadcasts[0]!.tx_hash);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payment_not_admitted");
  });

  // STAYS OPEN under M3a: this refusal is one no pre-flight mirrors (the
  // pre-broadcast re-check saw an admissible worker). Closing it needs the
  // founder-chosen protocol option — docs/proposals/admission-before-broadcast-m3.md.
  it.fails("GAP (b): the relay refuses admission (4xx) ⇒ nothing broadcast", async () => {
    const w = world({ submit: "403" });
    await delegate(w);
    expect(w.broadcasts).toHaveLength(0);
  });

  it("(b, narrowed) federated worker gone from discovery before broadcast ⇒ nothing broadcast (M3a)", async () => {
    const w = world({ submit: "201", rediscover: "gone" });
    const result = await delegate(w);
    expect(w.broadcasts).toHaveLength(0);
    expect(w.submits).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("p2p_ineligible");
  });

  it("(b, narrowed) federated worker repriced before broadcast ⇒ nothing broadcast (M3a)", async () => {
    const w = world({ submit: "201", rediscover: "repriced" });
    const result = await delegate(w);
    expect(w.broadcasts).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("p2p_ineligible");
  });

  it("(b, narrowed) local pair turned ineligible before broadcast ⇒ nothing broadcast (M3a)", async () => {
    const w = world({ submit: "201", local: true, reEligibility: "refused" });
    const result = await delegate(w);
    expect(w.broadcasts).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("p2p_ineligible");
      expect(result.error.message).toContain("Active dispute");
    }
  });

  it("(b, narrowed) local worker's registered address changed before broadcast ⇒ nothing broadcast (M3a)", async () => {
    const w = world({ submit: "201", local: true, reEligibility: "address_changed" });
    const result = await delegate(w);
    expect(w.broadcasts).toHaveLength(0);
    expect(w.submits).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("p2p_ineligible");
      expect(result.error.message).toContain("registered settlement address changed");
    }
  });

  it("(b, narrowed) local worker's expected amounts changed before broadcast ⇒ nothing broadcast (M3a)", async () => {
    const w = world({ submit: "201", local: true, reEligibility: "amounts_changed" });
    const result = await delegate(w);
    expect(w.broadcasts).toHaveLength(0);
    expect(w.submits).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("p2p_ineligible");
      expect(result.error.message).toContain("expected amounts changed");
    }
  });

  it("(b, narrowed) federated worker's address changed before broadcast ⇒ nothing broadcast (M3a)", async () => {
    const w = world({ submit: "201", rediscover: "address_changed" });
    const result = await delegate(w);
    expect(w.broadcasts).toHaveLength(0);
    expect(w.submits).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("p2p_ineligible");
      expect(result.error.message).toContain("settlement address changed");
    }
  });

  it("(b, narrowed) federated worker relisted through a DIFFERENT peer before broadcast ⇒ nothing broadcast (M3a)", async () => {
    const w = world({ submit: "201", rediscover: "other_peer" });
    const result = await delegate(w);
    expect(w.broadcasts).toHaveLength(0);
    expect(w.submits).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("p2p_ineligible");
      expect(result.error.message).toContain("same peer relay");
    }
  });

  it("(c) a throw between broadcast and submit — today: paid, admission unconfirmed", async () => {
    const w = world({ submit: "throw" });
    const result = await delegate(w);
    expect(w.broadcasts).toHaveLength(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("payment_admission_unconfirmed");
  });

  // STAYS OPEN under M3a: a network failure after the broadcast is outside
  // anything a client pre-flight can see. Founder-decision backlog —
  // docs/proposals/admission-before-broadcast-m3.md.
  it.fails("GAP (c): a throw between broadcast and submit ⇒ nothing broadcast", async () => {
    const w = world({ submit: "throw" });
    await delegate(w);
    expect(w.broadcasts).toHaveLength(0);
  });

  it("abort during discovery stops before pricing (the signal reaches discover) — holds on main", async () => {
    const w = world({ submit: "201" });
    const controller = new AbortController();
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.includes("/api/v1/agents/discover")) {
          controller.abort();
          if (init?.signal?.aborted === true) {
            throw new DOMException("Aborted", "AbortError");
          }
        }
        return inner(input, init);
      }),
    );
    const result = await delegate(w, { signal: controller.signal });
    expect(w.broadcasts).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
  });

  it("(abort) a delegation cancelled after its last pricing read broadcasts nothing (M3a)", async () => {
    const w = world({ submit: "201" });
    const controller = new AbortController();
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const resp = await inner(input, init);
        // Cancelled the moment the last pricing read (the executor relay's
        // signed metadata) has answered. This stub ignores the signal, so
        // only the re-check immediately before the broadcast can stop it.
        if (input === `${PEER_URL}/.well-known/motebit.json`) controller.abort();
        return resp;
      }),
    );
    const result = await delegate(w, { signal: controller.signal });
    expect(w.broadcasts).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
  });
});

describe("M3 — the last abort check sits immediately before the send", () => {
  it("(abort) a delegation cancelled while the builder awaits, before it sends, broadcasts nothing (CP2)", async () => {
    const w = world({ submit: "201" });
    const controller = new AbortController();
    const send = rail(w);
    const result = await delegate(w, {
      signal: controller.signal,
      // The window the cold review named: the M2 meter and the rail's own
      // pre-send work run after every pre-broadcast check in the delegator.
      buildP2pPayment: async (request, hooks) => {
        await Promise.resolve();
        controller.abort();
        // A rail honouring the hooks contract: a throw here means "not sent".
        await hooks?.beforeBroadcast?.({ signature: "sig-cp2", lastValidBlockHeight: 100 });
        return send(request);
      },
    });
    expect(w.broadcasts).toHaveLength(0);
    expect(w.submits).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("timeout");
      expect(result.error.settledPayment).toBeUndefined();
    }
  });
});

describe("M3 — the legitimate flow", () => {
  it("admission granted ⇒ exactly one broadcast, and the submit carries THAT payment", async () => {
    const w = world({ submit: "201" });
    const result = await delegate(w);
    expect(w.broadcasts).toHaveLength(1);
    expect(w.submits).toHaveLength(1);
    expect(w.submits[0]!.txHash).toBe(w.broadcasts[0]!.tx_hash);
    expect(w.submits[0]!.authorization).toBe("Bearer tok-task:submit");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.taskId).toBe("task-1");
      expect(result.settlement?.txHash).toBe(w.broadcasts[0]!.tx_hash);
    }
  }, 15_000);
});
