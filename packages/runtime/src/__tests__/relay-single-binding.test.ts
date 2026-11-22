/**
 * One relay binding for delegation (part 4a; design
 * runtime-relay-binding-design-2026-11-22 rev 6, section 5, tests 1-4, 5f, 6, 7).
 *
 * The defect class: the runtime held the relay it delegates to in several
 * places that rebound differently (the delegation tools' closures and the
 * credential submitter, the task-query coordinates, the granted-spend
 * coordinates, the tap manager, and the hardware-attestation capabilities
 * fetcher a surface built over its bootstrap URL). After a switch or a
 * Disconnect, calls still reached the old relay.
 *
 * Every test drives the real runtime against two fake relays on `.invalid`
 * hosts (`helpers/two-relays.ts`) whose token sources mint tokens that name
 * their binding, so "every tokened request went to B with B's token" is
 * checked per request. Ephemeral keys; mock wallets; no money moves.
 *
 * `bind` / `unbind` / `wireCapabilitiesFetcher` below are the only lines that
 * name the runtime's binding API. This file was first committed against
 * main's `enableInteractiveDelegation` / `enableInvokeCapability` /
 * `disableInteractiveDelegation` (bind = enable, unbind = disable) and a
 * fetcher built the way desktop and mobile built it (over a URL cached at
 * bootstrap), so its tests failed on main by misbehaviour, not by a missing
 * method; only those three helpers moved when the binding replaced them
 * (`bindRelay` / `unbindRelay` / a fetcher that takes the relay per call).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryPaidIntentStore,
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  createRelayCapabilitiesFetcher,
} from "../index";
import type { PlatformAdapters, StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type {
  AIResponse,
  ContextPack,
  P2pPaymentProof,
  SovereignP2pPaymentRequest,
  SovereignWalletRail,
  StorageAdapters,
} from "@motebit/sdk";
import { AgentTrustLevel, RiskLevel } from "@motebit/protocol";
import type { DelegationToken, StandingDelegation } from "@motebit/protocol";
import {
  bytesToHex,
  generateKeypair,
  signDelegation,
  signStandingDelegation,
} from "@motebit/crypto";
import { SIGNING_PINNED_HEX, advanceAfterRealAsync } from "./helpers/signed-relay-metadata.js";
import { runToolHandler } from "./helpers/money-tool-handler.js";
import {
  RELAY_A,
  RELAY_B,
  WORKER,
  installTwoRelays,
  tokenSource,
  type RelayName,
  type TwoRelays,
} from "./helpers/two-relays.js";

const ME = "clerk-001";
const KEYS = await generateKeypair();
const WORKER_KEYS = await generateKeypair();
const HOUR = 3_600_000;
const NOW = Date.now();

// ---------------------------------------------------------------------------
// The binding API (the only lines that name it)
// ---------------------------------------------------------------------------

interface TestBinding {
  relay: RelayName;
  key?: boolean;
  tools?: boolean;
  invokeCapability?: boolean;
  timeoutMs?: number;
}

const urlOf = (r: RelayName): string => (r === "A" ? RELAY_A : RELAY_B);

function bind(runtime: MotebitRuntime, b: TestBinding): void {
  runtime.bindRelay({
    syncUrl: urlOf(b.relay),
    authToken: tokenSource(b.relay),
    ...(b.key === true ? { relayPublicKey: SIGNING_PINNED_HEX } : {}),
    acknowledgeNoHistoryRisk: true,
    ...(b.timeoutMs != null ? { timeoutMs: b.timeoutMs } : {}),
    tools: b.tools !== false,
    invokeCapability: b.invokeCapability === true,
  });
}

function unbind(runtime: MotebitRuntime): void {
  runtime.unbindRelay();
}

/**
 * The capabilities fetcher as desktop and mobile wire it now: it holds no
 * relay; the runtime names one per invocation. (On main it was built over a
 * URL cached at proxy bootstrap — `bootstrapUrl` — that a relay switch never
 * rewrote; the argument is kept so the call sites read as they did.)
 */
function wireCapabilitiesFetcher(runtime: MotebitRuntime, _bootstrapUrl: string): void {
  runtime.setHardwareAttestationFetcher(createRelayCapabilitiesFetcher());
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function provider(): StreamingProvider {
  const response: AIResponse = {
    text: "ok",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "done" as const, response };
    },
  };
}

/** A mock sovereign rail: builds a proof, moves nothing. */
function mockWallet(): SovereignWalletRail {
  let n = 0;
  return {
    address: "AliceAddr11111111111111111111111111111111111",
    async buildP2pPayment(req: SovereignP2pPaymentRequest): Promise<P2pPaymentProof> {
      n++;
      return {
        tx_hash: `tx-${n}`,
        chain: "solana",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        to_address: req.workerAddress,
        amount_micro: req.amountMicro,
        fee_to_address: req.treasuryAddress,
        fee_amount_micro: req.feeAmountMicro,
      };
    },
  } as unknown as SovereignWalletRail;
}

function makeRuntime(opts: { wallet?: boolean; store?: InMemoryPaidIntentStore } = {}): {
  runtime: MotebitRuntime;
  storage: StorageAdapters;
} {
  const storage: StorageAdapters = {
    ...createInMemoryStorage(),
    ...(opts.store != null ? { paidIntentStore: opts.store } : {}),
  };
  const adapters: PlatformAdapters = { storage, renderer: new NullRenderer(), ai: provider() };
  const runtime = new MotebitRuntime(
    {
      motebitId: ME,
      tickRateHz: 0,
      signingKeys: KEYS,
      policy: { requireApprovalAbove: RiskLevel.R1_DRAFT, denyAbove: RiskLevel.R4_MONEY },
      ...(opts.wallet === true ? { solanaWallet: mockWallet() } : {}),
    },
    adapters,
  );
  return { runtime, storage };
}

async function grant(): Promise<{ token: DelegationToken; grant: StandingDelegation }> {
  const g = await signStandingDelegation(
    {
      grant_id: "grant-binding-1",
      delegator_id: ME,
      delegator_public_key: bytesToHex(KEYS.publicKey),
      delegate_id: ME,
      delegate_public_key: bytesToHex(KEYS.publicKey),
      scope: "delegate_to_agent",
      subject: "market:capability=web_search",
      cadence_ms: 24 * HOUR,
      issued_at: NOW,
      not_before: null,
      expires_at: NOW + 90 * 24 * HOUR,
      max_token_ttl_ms: HOUR,
      spend_ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 10_000_000 },
    },
    KEYS.privateKey,
  );
  const token = await signDelegation(
    {
      delegator_id: g.delegator_id,
      delegator_public_key: g.delegator_public_key,
      delegate_id: g.delegate_id,
      delegate_public_key: g.delegate_public_key,
      scope: g.scope,
      issued_at: NOW,
      expires_at: NOW + HOUR,
      grant_id: g.grant_id,
    },
    KEYS.privateKey,
  );
  return { token, grant: g };
}

const TASK_ARGS = { prompt: "search the web", required_capabilities: ["web_search"] };

async function delegate(runtime: MotebitRuntime) {
  return runToolHandler(runtime.getToolRegistry(), "delegate_to_agent", TASK_ARGS);
}

async function tap(runtime: MotebitRuntime): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of runtime.invokeCapability("web_search", "search the web")) out.push(c);
  return out;
}

const isCredentialPost = (r: { method: string; path: string }) =>
  r.method === "POST" && r.path.endsWith("/credentials/submit");
const isCapabilitiesGet = (r: { method: string; path: string }) =>
  r.method === "GET" && r.path.endsWith("/capabilities");

let relays: TwoRelays;
beforeEach(() => {
  relays = installTwoRelays(ME);
});
afterEach(() => {
  relays.restore();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test 1 — a rebind moves every path
// ---------------------------------------------------------------------------

describe("bind A then bind B", () => {
  it("every path sends every tokened request to B and nothing to A", async () => {
    const { runtime } = makeRuntime();
    bind(runtime, { relay: "A", key: true, invokeCapability: true });
    bind(runtime, { relay: "B", key: true, invokeCapability: true });
    const g = await grant();

    const hire = await delegate(runtime);
    expect(hire.ok).toBe(true);
    // The hire's credential is submitted by the credential submitter.
    await vi.waitFor(() => expect(relays.requests.filter(isCredentialPost).length).toBe(1));
    await runtime.getToolRegistry().execute("discover_agents", {});
    await runtime.getToolRegistry().execute("retrieve_task_result", { task_id: "task-x" });
    await runtime.retrieveDelegationResult("task-y");
    const dry = await runtime.executeGrantedDelegation({
      capability: "web_search",
      prompt: "survey",
      delegation: g,
      dryRun: true,
    });
    expect(dry.ok).toBe(true);
    await tap(runtime);

    expect(relays.to("A")).toEqual([]);
    expect(relays.tokened().length).toBeGreaterThan(0);
    for (const r of relays.tokened()) {
      expect(r.relay, `${r.method} ${r.path}`).toBe("B");
      expect(r.auth, `${r.method} ${r.path}`).toMatch(/^Bearer B:/);
    }
    // Each path did reach B (so "nothing to A" is not "nothing at all").
    const pathsOnB = relays.to("B").map((r) => `${r.method} ${r.path}`);
    expect(pathsOnB).toContain(`POST /agent/${ME}/task`);
    expect(pathsOnB).toContain("GET /api/v1/agents/discover");
    expect(pathsOnB).toContain(`GET /agent/${ME}/task/task-x`);
    expect(pathsOnB).toContain(`GET /agent/${ME}/task/task-y`);
    expect(pathsOnB.some((p) => p.endsWith("/credentials/submit"))).toBe(true);
    expect(pathsOnB.some((p) => p.endsWith("/p2p-eligibility"))).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 2 — a key does not survive a rebind to a relay without one
// ---------------------------------------------------------------------------

describe("bind A with a key, then bind B without", () => {
  it("granted spend returns sync_not_enabled and never uses A", async () => {
    const { runtime } = makeRuntime();
    bind(runtime, { relay: "A", key: true });
    bind(runtime, { relay: "B" });
    const g = await grant();

    const dry = await runtime.executeGrantedDelegation({
      capability: "web_search",
      prompt: "survey",
      delegation: g,
      dryRun: true,
    });
    expect(relays.to("A")).toEqual([]);
    expect(dry).toEqual({ ok: false, code: "sync_not_enabled" });
  });
});

// ---------------------------------------------------------------------------
// Test 3 — unbind leaves no path that contacts anything
// ---------------------------------------------------------------------------

describe("unbind", () => {
  it("every path started after it contacts nothing", async () => {
    const { runtime } = makeRuntime();
    bind(runtime, { relay: "A", key: true, invokeCapability: true });
    unbind(runtime);
    const g = await grant();

    const registry = runtime.getToolRegistry();
    for (const name of ["delegate_to_agent", "discover_agents", "retrieve_task_result"]) {
      expect(registry.has(name), name).toBe(false);
    }
    await registry.execute("delegate_to_agent", TASK_ARGS);
    await registry.execute("discover_agents", {});
    await registry.execute("retrieve_task_result", { task_id: "task-x" });
    expect(await runtime.retrieveDelegationResult("task-y")).toEqual({
      status: "not_connected",
      taskId: "task-y",
    });
    const dry = await runtime.executeGrantedDelegation({
      capability: "web_search",
      prompt: "survey",
      delegation: g,
      dryRun: true,
    });
    const chunks = await tap(runtime);
    // A credential issued with no binding is not posted anywhere.
    await runtime.bumpTrustFromReceipt(
      (await import("./helpers/two-relays.js")).workerReceipt("t-1"),
      true,
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(relays.requests).toEqual([]);
    expect(dry).toEqual({ ok: false, code: "sync_not_enabled" });
    expect(chunks.at(-1)).toMatchObject({ type: "invoke_error", code: "sync_not_enabled" });
  });
});

// ---------------------------------------------------------------------------
// Test 4 — a call keeps its snapshot; the next call takes the new binding
// ---------------------------------------------------------------------------

describe("a rebind while calls are in flight", () => {
  it("running calls finish on A with A's tokens; a later credential and call go to B", async () => {
    const { runtime } = makeRuntime();
    bind(runtime, { relay: "A", key: true, invokeCapability: true });
    // Hold both submissions on A, so the rebind lands mid-call.
    const held = relays.hold("A", "POST", (p) => p === `/agent/${ME}/task`, 2);
    const hire = delegate(runtime);
    const tapped = tap(runtime);
    await vi.waitFor(() => expect(held.arrived()).toBe(2));

    bind(runtime, { relay: "B", key: true, invokeCapability: true });
    held.release();
    const [hireResult, tapChunks] = await Promise.all([hire, tapped]);
    expect(hireResult.ok).toBe(true);
    expect(tapChunks.some((c) => c.type === "delegation_complete")).toBe(true);

    // Both calls' receipts issue credentials AFTER the rebind.
    await vi.waitFor(() => expect(relays.requests.filter(isCredentialPost).length).toBe(2));

    // Every request the two calls sent went to A, with A's tokens.
    const onA = relays.to("A");
    expect(onA.filter((r) => r.method === "POST" && r.path === `/agent/${ME}/task`)).toHaveLength(
      2,
    );
    expect(onA.some((r) => r.method === "GET" && r.path.startsWith(`/agent/${ME}/task/`))).toBe(
      true,
    );
    for (const r of onA.filter((x) => x.auth != null)) {
      expect(r.auth, `${r.method} ${r.path}`).toMatch(/^Bearer A:/);
    }
    // The credentials issued after the rebind went to B, with B's token.
    const credentials = relays.requests.filter(isCredentialPost);
    for (const c of credentials) {
      expect(c.relay).toBe("B");
      expect(c.auth).toMatch(/^Bearer B:/);
    }
    // Before the next call, B saw only those credentials.
    expect(relays.to("B").every(isCredentialPost)).toBe(true);

    // The next call goes to B.
    const before = relays.requests.length;
    await runtime.getToolRegistry().execute("discover_agents", {});
    const next = relays.requests.slice(before);
    expect(next.length).toBeGreaterThan(0);
    for (const r of next) {
      expect(r.relay).toBe("B");
      expect(r.auth).toMatch(/^Bearer B:/);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 5f — the capabilities fetch follows the binding
// ---------------------------------------------------------------------------

describe("the capabilities fetch", () => {
  it("after a rebind it goes to the new relay; unbound, a receipt outside a call fetches nothing", async () => {
    const { runtime, storage } = makeRuntime();
    // A worker this runtime already knows, by key — the fetch fires for it.
    await storage.agentTrustStore!.setAgentTrust({
      motebit_id: ME,
      remote_motebit_id: WORKER,
      trust_level: AgentTrustLevel.FirstContact,
      public_key: bytesToHex(WORKER_KEYS.publicKey),
      first_seen_at: NOW - HOUR,
      last_seen_at: NOW - HOUR,
      interaction_count: 1,
      successful_tasks: 1,
      failed_tasks: 0,
    });
    wireCapabilitiesFetcher(runtime, RELAY_A);
    bind(runtime, { relay: "A" });
    expect((await delegate(runtime)).ok).toBe(true);
    await vi.waitFor(() => expect(relays.requests.filter(isCapabilitiesGet)).toHaveLength(1));

    unbind(runtime);
    bind(runtime, { relay: "B" });
    const mark = relays.requests.length;
    expect((await delegate(runtime)).ok).toBe(true);
    await vi.waitFor(() =>
      expect(relays.requests.slice(mark).filter(isCapabilitiesGet)).toHaveLength(1),
    );
    const afterRebind = relays.requests.slice(mark).filter(isCapabilitiesGet);
    expect(afterRebind.map((r) => r.relay)).toEqual(["B"]);
    // The credential that hire issued goes to B as well — the submitter is
    // not pinned to the relay of the first credential it posted.
    await vi.waitFor(() =>
      expect(relays.requests.slice(mark).filter(isCredentialPost).length).toBeGreaterThan(0),
    );
    expect(
      relays.requests
        .slice(mark)
        .filter(isCredentialPost)
        .map((r) => r.relay),
    ).not.toContain("A");

    // Unbound: a receipt bumped outside any call (a plan step's) fetches nothing.
    unbind(runtime);
    const mark2 = relays.requests.length;
    await runtime.bumpTrustFromReceipt(
      (await import("./helpers/two-relays.js")).workerReceipt("plan-step-1"),
      true,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(relays.requests.slice(mark2).filter(isCapabilitiesGet)).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 6 — a paid record names its relay; retrieval honours it
// ---------------------------------------------------------------------------

describe("a paid-result record", () => {
  it("names the relay it is owed from; retrieval elsewhere sends nothing", async () => {
    const store = new InMemoryPaidIntentStore();
    const { runtime } = makeRuntime({ wallet: true, store });
    // The paid task's result read 404s until the test says otherwise.
    let reaped = true;
    relays.taskRead = (_relay, taskId) =>
      reaped
        ? new Response(JSON.stringify({ error: "Task not found" }), { status: 404 })
        : new Response(
            JSON.stringify({
              task: { status: "completed" },
              receipt: { ...(JSONReceipt(taskId) as object) },
            }),
            { status: 200 },
          );
    bind(runtime, { relay: "A", key: true, timeoutMs: 1 });

    vi.useFakeTimers();
    const hire = delegate(runtime);
    await advanceAfterRealAsync(5000);
    const first = await hire;
    vi.useRealTimers();
    expect(first.error).toContain("PAYMENT_ALREADY_SETTLED");
    const owed = runtime.outstandingPaidResults();
    expect(owed).toHaveLength(1);
    const taskId = owed[0]!.taskId;

    // Another relay is bound: the retrieval sends nothing and names A.
    unbind(runtime);
    bind(runtime, { relay: "B", key: true });
    const mark = relays.requests.length;
    const elsewhere = await runtime.retrieveDelegationResult(taskId);
    expect(relays.requests.slice(mark)).toEqual([]);
    expect(elsewhere).toEqual({ status: "bound_elsewhere", taskId, relayUrl: RELAY_A });

    // A again: retrieved from A.
    unbind(runtime);
    bind(runtime, { relay: "A", key: true });
    reaped = false;
    const mark2 = relays.requests.length;
    const back = await runtime.retrieveDelegationResult(taskId);
    expect(back.status).toBe("delivered");
    expect(relays.requests.slice(mark2).map((r) => r.relay)).toEqual(["A"]);

    // A record written before records named their relay: from the bound relay.
    store.record({
      motebit_id: ME,
      task_id: "legacy-task-1",
      worker_motebit_id: WORKER,
      capability: "web_search",
      tx_hash: "tx-legacy",
      paid_micro: 1,
      fee_micro: 0,
      recorded_at: 1,
      state: "unretrieved",
      session_id: "old-session",
    });
    unbind(runtime);
    bind(runtime, { relay: "B", key: true });
    const mark3 = relays.requests.length;
    const legacy = await runtime.retrieveDelegationResult("legacy-task-1");
    expect(legacy.status).toBe("delivered");
    expect(relays.requests.slice(mark3).map((r) => r.relay)).toEqual(["B"]);

    // A payment with no relay task is answered locally.
    const mark4 = relays.requests.length;
    expect(await runtime.retrieveDelegationResult("p2p-payment:sig-1")).toEqual({
      status: "not_admitted",
      taskId: "p2p-payment:sig-1",
    });
    expect(relays.requests.slice(mark4)).toEqual([]);

    // The record names A.
    expect(runtime.outstandingPaidResults().find((e) => e.taskId === taskId)).toBeUndefined();
    expect(owed[0]!.relayUrl).toBe(RELAY_A);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Test 7 — an in-flight paid hire keeps its relay
// ---------------------------------------------------------------------------

describe("an in-flight paid hire across a rebind", () => {
  it("keeps polling A, and its record says A", async () => {
    const store = new InMemoryPaidIntentStore();
    const { runtime } = makeRuntime({ wallet: true, store });
    relays.taskRead = () =>
      new Response(JSON.stringify({ task: { status: "running" }, receipt: null }), {
        status: 200,
      });
    bind(runtime, { relay: "A", key: true, timeoutMs: 4_000 });
    const pollsOnA = () =>
      relays.to("A").filter((r) => r.method === "GET" && /^\/agent\/[^/]+\/task\//.test(r.path))
        .length;
    const hire = delegate(runtime);
    await vi.waitFor(() => expect(pollsOnA()).toBeGreaterThan(0), { timeout: 5_000 });

    bind(runtime, { relay: "B", key: true });
    const polled = pollsOnA();
    const result = await hire;
    expect(result.ok).toBe(false);
    expect(pollsOnA()).toBeGreaterThan(polled);
    expect(relays.to("B")).toEqual([]);

    const owed = runtime.outstandingPaidResults();
    expect(owed).toHaveLength(1);
    expect(owed[0]!.relayUrl).toBe(RELAY_A);
  }, 30_000);
});

function JSONReceipt(taskId: string): unknown {
  return {
    task_id: taskId,
    relay_task_id: taskId,
    motebit_id: WORKER,
    device_id: "bob-device",
    submitted_at: NOW - 1000,
    completed_at: NOW,
    status: "completed",
    result: "the paid answer",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "fake-sig",
  };
}
