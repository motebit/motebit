/**
 * Mobile: one delegation relay binding per attempt (design
 * runtime-relay-binding rev 6 §3.4 and section 5 test 10).
 *
 * The real `MobileSyncController` over a REAL runtime; the sync transport,
 * device registration and AsyncStorage are mocked the way
 * `sync-controller.test.ts` mocks them, and the relays are a stubbed `fetch`
 * on `.invalid` hosts.
 *
 *   - One attempt runs two sync cycles while a `delegate_to_agent` approval
 *     is pending: the approval still runs.
 *   - The same with the second cycle's relay-key fetch returning a key the
 *     first did not (first fetch failed, then succeeded): it still runs, and
 *     the binding generation is unchanged — the attempt binds once.
 *   - Attempt A is disposed with a paid hire in flight: the record names A,
 *     and a retrieval on attempt B (bound to B) answers `bound_elsewhere`
 *     naming A, sending nothing.
 *
 * The first two cases pass on main too (main ignored a second enable, so it
 * never churned anything): they guard the bind-once rule. The third needs
 * the record's relay, which main did not have. No money moves (mock rail).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  registerResult: { ok: true, created: false, registered_at: 1 } as unknown,
}));

vi.mock("@motebit/sync-engine", async () => {
  const actual = await vi.importActual<object>("@motebit/sync-engine");
  class Base {
    connectRemote = vi.fn();
    start = vi.fn();
    stop = vi.fn();
    sync = vi.fn(() =>
      Promise.resolve({ pushed: 0, pulled: 0, conversations_pushed: 0, conversations_pulled: 0 }),
    );
    getLastError = vi.fn(() => null);
  }
  class WebSocketEventStoreAdapter {
    connect = vi.fn();
    disconnect = vi.fn();
    onEvent = vi.fn(() => vi.fn());
    onCustomMessage = vi.fn(() => vi.fn());
    sendRaw = vi.fn();
  }
  const inert = () =>
    vi.fn().mockImplementation(function () {
      return {};
    });
  return {
    ...actual,
    SyncEngine: Base,
    ConversationSyncEngine: Base,
    PlanSyncEngine: Base,
    HttpEventStoreAdapter: inert(),
    WebSocketEventStoreAdapter,
    EncryptedEventStoreAdapter: inert(),
    HttpConversationSyncAdapter: inert(),
    EncryptedConversationSyncAdapter: inert(),
    HttpPlanSyncAdapter: inert(),
    EncryptedPlanSyncAdapter: inert(),
    decryptEventPayload: vi.fn((e: unknown) => Promise.resolve(e)),
  };
});

vi.mock("@motebit/core-identity", async () => ({
  ...(await vi.importActual<object>("@motebit/core-identity")),
  registerDeviceWithRelay: vi.fn(() => Promise.resolve(hoisted.registerResult)),
}));

vi.mock("@motebit/encryption", async () => ({
  // The runtime under test is real, so it keeps the real encryption exports.
  ...(await vi.importActual<object>("@motebit/encryption")),
  deriveSyncEncryptionKey: vi.fn(() => Promise.resolve(new Uint8Array(32))),
  secureErase: vi.fn(),
}));

const asyncStoreData = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(asyncStoreData.get(key) ?? null)),
    setItem: vi.fn((key: string, value: string) => {
      asyncStoreData.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      asyncStoreData.delete(key);
      return Promise.resolve();
    }),
  },
}));

import { MobileSyncController } from "../sync-controller";
import type { SyncControllerDeps } from "../sync-controller";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import type { StreamChunk } from "@motebit/runtime";
import type {
  AIResponse,
  ContextPack,
  P2pPaymentProof,
  SovereignP2pPaymentRequest,
  SovereignWalletRail,
} from "@motebit/sdk";
import { RiskLevel } from "@motebit/sdk";

const ME = "mote-1";
const RELAY_A = "https://relay-a.invalid";
const RELAY_B = "https://relay-b.invalid";
const RELAY_KEY = "07".repeat(32);
const WORKER = "bob-worker";
const WORKER_ADDR = "BobWorkerAddr1111111111111111111111111111111";

interface Req {
  relay: "A" | "B";
  method: string;
  path: string;
}
let requests: Req[];
/** Relay-key fetches answered 503 before the key is served, per relay. */
let keyFailuresLeft: Map<"A" | "B", number>;
/** How the task read answers. */
let taskStatus: "running" | "completed";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function receipt(taskId: string) {
  return {
    task_id: taskId,
    motebit_id: WORKER,
    device_id: "bob-device",
    submitted_at: Date.now() - 1000,
    completed_at: Date.now(),
    status: "completed",
    result: "the worker's answer",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "fake-sig",
  };
}

function proposingDelegation(): {
  model: string;
  setModel: () => void;
  generate: (ctx: ContextPack) => Promise<AIResponse>;
  estimateConfidence: () => Promise<number>;
  extractMemoryCandidates: () => Promise<never[]>;
  generateStream: (ctx: ContextPack) => AsyncGenerator<unknown>;
} {
  const gen = (ctx: ContextPack): AIResponse => {
    const history = JSON.stringify(ctx.conversation_history ?? []);
    if (!history.includes("tool_result") && !history.includes('"role":"tool"')) {
      return {
        text: "",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [
          {
            id: "c1",
            name: "delegate_to_agent",
            args: { prompt: "research X", required_capabilities: ["web_search"] },
          },
        ],
      };
    }
    return { text: "done", confidence: 0.8, memory_candidates: [], state_updates: {} };
  };
  return {
    model: "mock-model",
    setModel: () => {},
    generate: async (ctx) => gen(ctx),
    estimateConfidence: async () => 0.8,
    extractMemoryCandidates: async () => [],
    async *generateStream(ctx: ContextPack) {
      yield { type: "done" as const, response: gen(ctx) };
    },
  };
}

function makeRuntime(wallet?: SovereignWalletRail): MotebitRuntime {
  return new MotebitRuntime(
    {
      motebitId: ME,
      tickRateHz: 0,
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R4_MONEY,
        requireApprovalAbove: RiskLevel.R1_DRAFT,
        denyAbove: RiskLevel.R4_MONEY,
      },
      ...(wallet != null ? { solanaWallet: wallet } : {}),
    },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: proposingDelegation() as never,
    },
  );
}

function controllerFor(runtime: MotebitRuntime): MobileSyncController {
  const deps: SyncControllerDeps = {
    getRuntime: () => runtime,
    getMotebitId: () => ME,
    getDeviceId: () => "dev-1",
    getPublicKey: () => "aa".repeat(32),
    getStorage: () =>
      ({
        eventStore: { append: vi.fn(), read: vi.fn(() => []) },
        conversationSyncStore: {},
        planStore: {
          getPlan: vi.fn(),
          getStep: vi.fn(),
          getStepsForPlan: vi.fn(() => []),
          savePlan: vi.fn(),
          saveStep: vi.fn(),
          listAllPlans: vi.fn(() => []),
          listActivePlans: vi.fn(() => []),
          listStepsSince: vi.fn(() => []),
        },
        goalStore: {},
      }) as never,
    getLocalEventStore: () => null,
    getKeyring: () =>
      ({
        get: vi.fn(() => Promise.resolve(null)),
        set: vi.fn(() => Promise.resolve()),
      }) as never,
    getPrivKeyBytes: () => Promise.resolve(new Uint8Array(32)),
    createSyncToken: (aud?: string) => Promise.resolve(`tok:${aud ?? "sync"}`),
    registerPushToken: vi.fn(() => Promise.resolve()),
    removePushToken: vi.fn(() => Promise.resolve()),
    startPushLifecycle: vi.fn(),
    stopPushLifecycle: vi.fn(),
  };
  return new MobileSyncController(deps);
}

/** Run one sync cycle of the controller's live attempt. */
async function cycle(ctrl: MobileSyncController): Promise<void> {
  const c = ctrl as unknown as { attempt: unknown; syncCycle(a: unknown): Promise<void> };
  await c.syncCycle(c.attempt);
}

const generationOf = (runtime: MotebitRuntime): number =>
  (runtime as unknown as { _relayGeneration: number })._relayGeneration;

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

function doneResult(chunks: StreamChunk[]): string {
  const done = chunks.find(
    (c) => c.type === "tool_status" && c.status === "done" && c.name === "delegate_to_agent",
  ) as { result?: unknown } | undefined;
  const result = done?.result;
  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  asyncStoreData.clear();
  // The once-per-device onboarding self-test is not under test here.
  asyncStoreData.set("motebit:self-test-done", "true");
  requests = [];
  keyFailuresLeft = new Map();
  taskStatus = "completed";
  let taskSeq = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const relay = url.startsWith(RELAY_A) ? "A" : url.startsWith(RELAY_B) ? "B" : null;
    if (relay == null) throw new Error(`unexpected network call: ${url}`);
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    requests.push({ relay, method, path });
    if (path === "/.well-known/motebit.json") {
      const left = keyFailuresLeft.get(relay) ?? 0;
      if (left > 0) {
        keyFailuresLeft.set(relay, left - 1);
        return json(503, {});
      }
      return json(200, { public_key: RELAY_KEY, relay_id: `relay-${relay}` });
    }
    if (path === "/api/v1/agents/discover") {
      return json(200, {
        agents: [
          {
            motebit_id: WORKER,
            capabilities: ["web_search"],
            settlement_address: WORKER_ADDR,
            settlement_modes: "relay,p2p",
            pricing: [{ capability: "web_search", unit_cost: 0.05 }],
          },
        ],
      });
    }
    if (path.endsWith("/p2p-eligibility")) {
      return json(200, {
        allowed: true,
        expected_amount_micro: 50_000,
        expected_fee_micro: 2_632,
        settlement_address: WORKER_ADDR,
      });
    }
    if (path.endsWith("/listing")) {
      return json(200, { pricing: [{ capability: "web_search", unit_cost: 0.05 }] });
    }
    if (method === "POST" && path === `/agent/${ME}/task`) {
      return json(201, { task_id: `task-${relay}-${++taskSeq}`, status: "pending" });
    }
    const read = /^\/agent\/[^/]+\/task\/([^/]+)$/.exec(path);
    if (method === "GET" && read != null) {
      return taskStatus === "running"
        ? json(200, { task: { status: "running" }, receipt: null })
        : json(200, { task: { status: "completed" }, receipt: receipt(read[1]!) });
    }
    return json(404, {});
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("mobile: one delegation relay binding per attempt", () => {
  it("two sync cycles with an approval pending: the approval still runs", async () => {
    const runtime = makeRuntime();
    const ctrl = controllerFor(runtime);
    await ctrl.startSync(RELAY_A);
    await cycle(ctrl);
    expect(runtime.getDelegationRelay()?.url).toBe(RELAY_A);
    const bound = generationOf(runtime);

    const asked = await drain(runtime.sendMessageStreaming("delegate it"));
    expect(asked.some((c) => c.type === "approval_request")).toBe(true);
    await cycle(ctrl);
    expect(generationOf(runtime)).toBe(bound);

    const chunks = await drain(runtime.resumeAfterApproval(true));
    expect(doneResult(chunks)).not.toContain("relay_changed");
    expect(requests.some((r) => r.relay === "A" && r.method === "POST")).toBe(true);
    ctrl.stopSync();
  }, 20_000);

  it("the second cycle's pin resolves to a key the first did not: still runs, generation unchanged", async () => {
    const runtime = makeRuntime();
    const ctrl = controllerFor(runtime);
    keyFailuresLeft.set("A", 1); // the first fetch fails, the next succeeds
    await ctrl.startSync(RELAY_A);
    await cycle(ctrl);
    expect(runtime.getDelegationRelay()).toEqual({ url: RELAY_A, pinned: false });
    const bound = generationOf(runtime);

    const asked = await drain(runtime.sendMessageStreaming("delegate it"));
    expect(asked.some((c) => c.type === "approval_request")).toBe(true);
    await cycle(ctrl);
    // The pin now resolves (it was stored this cycle), but the attempt does
    // not rebind: the generation — and the pending approval — hold.
    expect(asyncStoreData.get(`motebit:relay_pin:${RELAY_A}`)).toBe(RELAY_KEY);
    expect(generationOf(runtime)).toBe(bound);
    expect(runtime.getDelegationRelay()).toEqual({ url: RELAY_A, pinned: false });

    const chunks = await drain(runtime.resumeAfterApproval(true));
    expect(doneResult(chunks)).not.toContain("relay_changed");
    ctrl.stopSync();
  }, 20_000);

  it("attempt A disposed with a paid hire in flight: the record names A; on attempt B retrieval is bound_elsewhere", async () => {
    let paid = 0;
    const wallet = {
      address: "AliceAddr11111111111111111111111111111111111",
      async buildP2pPayment(req: SovereignP2pPaymentRequest): Promise<P2pPaymentProof> {
        paid++;
        return {
          tx_hash: `tx-${paid}`,
          chain: "solana",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          to_address: req.workerAddress,
          amount_micro: req.amountMicro,
          fee_to_address: req.treasuryAddress,
          fee_amount_micro: req.feeAmountMicro,
        };
      },
    } as unknown as SovereignWalletRail;
    const runtime = makeRuntime(wallet);
    const ctrl = controllerFor(runtime);
    taskStatus = "running"; // the worker never answers while attempt A lives
    await ctrl.startSync(RELAY_A);
    await cycle(ctrl);
    expect(runtime.getDelegationRelay()).toEqual({ url: RELAY_A, pinned: true });

    const asked = await drain(runtime.sendMessageStreaming("delegate it"));
    expect(asked.some((c) => c.type === "approval_request")).toBe(true);
    // Approved: the paid hire runs (and keeps polling A) in the background.
    void drain(runtime.resumeAfterApproval(true)).catch(() => {});
    await vi.waitFor(
      () => expect(requests.some((r) => r.relay === "A" && /\/task\//.test(r.path))).toBe(true),
      { timeout: 10_000 },
    );
    expect(paid).toBe(1);
    const inFlight = runtime.paidTask("task-A-1");
    expect(inFlight?.relayUrl).toBe(RELAY_A);

    // Attempt A is disposed (relay switched); attempt B binds B.
    ctrl.stopSync();
    expect(runtime.getDelegationRelay()).toBeNull();
    await ctrl.startSync(RELAY_B);
    await cycle(ctrl);
    expect(runtime.getDelegationRelay()?.url).toBe(RELAY_B);

    const mark = requests.length;
    const r = await runtime.retrieveDelegationResult("task-A-1");
    expect(r).toEqual({ status: "bound_elsewhere", taskId: "task-A-1", relayUrl: RELAY_A });
    expect(requests.slice(mark)).toEqual([]);
    ctrl.stopSync();
  }, 30_000);
});
