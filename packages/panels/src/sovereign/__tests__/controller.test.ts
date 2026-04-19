/**
 * SovereignController unit tests. The controller is the shared state layer
 * for the Sovereign panel across desktop/web/mobile. Tests cover:
 *
 *  - parallel refresh orchestration
 *  - credential dedup (issuer × type × subject × issued_at)
 *  - sweep-config micro/dollar conversion + optimistic state mutation
 *  - error surfacing (fetch failures → state.error, previous state preserved)
 *  - subscribe/dispose semantics
 *  - lazy ledger detail caching
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSovereignController,
  type SovereignFetchAdapter,
  type SovereignFetchInit,
  type CredentialEntry,
  type BalanceResponse,
  type BudgetResponse,
  type SuccessionResponse,
  type GoalRow,
  type LedgerManifest,
} from "../controller.js";

// ── Mock adapter ──────────────────────────────────────────────────────

interface MockHandler {
  method?: string;
  status?: number;
  body?: unknown;
  throws?: Error;
}

function createAdapter(overrides?: {
  syncUrl?: string | null;
  motebitId?: string | null;
  handlers?: Map<string, MockHandler>;
  getSolanaAddress?: () => string | null;
  getSolanaBalanceMicro?: () => Promise<number | null>;
  getLocalCredentials?: () => CredentialEntry[];
}): {
  adapter: SovereignFetchAdapter;
  calls: Array<{ path: string; init?: SovereignFetchInit }>;
} {
  const handlers = overrides?.handlers ?? new Map<string, MockHandler>();
  const calls: Array<{ path: string; init?: SovereignFetchInit }> = [];

  const adapter: SovereignFetchAdapter = {
    syncUrl: "syncUrl" in (overrides ?? {}) ? overrides!.syncUrl! : "https://relay.test",
    motebitId: "motebitId" in (overrides ?? {}) ? overrides!.motebitId! : "mb_test",
    async fetch(path: string, init?: SovereignFetchInit): Promise<Response> {
      calls.push({ path, init });
      const handler = handlers.get(path);
      if (handler?.throws) throw handler.throws;
      const status = handler?.status ?? (handler ? 200 : 404);
      const body = handler?.body !== undefined ? JSON.stringify(handler.body) : JSON.stringify({});
      return new Response(body, { status });
    },
    getSolanaAddress: overrides?.getSolanaAddress ?? (() => null),
    getSolanaBalanceMicro: overrides?.getSolanaBalanceMicro ?? (async () => null),
    getLocalCredentials: overrides?.getLocalCredentials ?? (() => []),
  };

  return { adapter, calls };
}

// ── Fixtures ──────────────────────────────────────────────────────────

const relayCred: CredentialEntry = {
  credential_id: "cred-relay-1",
  credential_type: "ReputationCredential",
  credential: {
    issuer: "did:key:z6Mkissuer1",
    credentialSubject: { id: "did:key:z6Mksubj1" },
    type: ["VerifiableCredential", "ReputationCredential"],
  },
  issued_at: 1_700_000_000_000,
};

const localCred: CredentialEntry = {
  credential_id: "cred-local-1",
  credential_type: "TrustCredential",
  credential: {
    issuer: "did:key:z6Mklocal",
    credentialSubject: { id: "did:key:z6Mksubj1" },
    type: ["VerifiableCredential", "TrustCredential"],
  },
  issued_at: 1_700_000_001_000,
};

const balanceFixture: BalanceResponse = {
  motebit_id: "mb_test",
  balance: 12.5,
  currency: "USD",
  transactions: [],
  sweep_threshold: null,
  settlement_address: null,
};

const budgetFixture: BudgetResponse = {
  motebit_id: "mb_test",
  total_locked: 4.25,
  total_settled: 10.0,
  allocations: [],
};

const successionFixture: SuccessionResponse = {
  motebit_id: "mb_test",
  chain: [],
  current_public_key: "z6Mkcurrent",
};

const goalsFixture: GoalRow[] = [
  {
    goal_id: "goal-1",
    prompt: "summarize this",
    status: "completed",
    created_at: 1_700_000_100_000,
  },
  {
    goal_id: "goal-2",
    prompt: "research that",
    status: "in_progress",
    created_at: 1_700_000_200_000,
  },
];

function allRelayHandlers(): Map<string, MockHandler> {
  return new Map([
    [
      "/api/v1/agents/mb_test/credentials",
      { body: { credentials: [relayCred] } } satisfies MockHandler,
    ],
    [
      "/api/v1/credentials/batch-status",
      {
        body: {
          results: [
            { credential_id: "cred-relay-1", revoked: false },
            { credential_id: "cred-local-1", revoked: true },
          ],
        },
      },
    ],
    ["/api/v1/goals/mb_test", { body: { goals: goalsFixture } }],
    ["/api/v1/agents/mb_test/balance", { body: balanceFixture }],
    ["/agent/mb_test/budget", { body: budgetFixture }],
    ["/api/v1/agents/mb_test/succession", { body: successionFixture }],
  ]);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("SovereignController — initial state", () => {
  it("starts with empty state, credentials tab, not loading", () => {
    const { adapter } = createAdapter();
    const ctrl = createSovereignController(adapter);
    const s = ctrl.getState();
    expect(s.activeTab).toBe("credentials");
    expect(s.credentials).toEqual([]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });
});

describe("SovereignController — refresh()", () => {
  it("fetches all six endpoints in parallel", async () => {
    const { adapter, calls } = createAdapter({
      handlers: allRelayHandlers(),
      getLocalCredentials: () => [localCred],
    });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();

    const paths = calls.map((c) => c.path);
    expect(paths).toContain("/api/v1/agents/mb_test/credentials");
    expect(paths).toContain("/api/v1/credentials/batch-status");
    expect(paths).toContain("/api/v1/goals/mb_test");
    expect(paths).toContain("/api/v1/agents/mb_test/balance");
    expect(paths).toContain("/agent/mb_test/budget");
    expect(paths).toContain("/api/v1/agents/mb_test/succession");
  });

  it("populates state with fetched data", async () => {
    const { adapter } = createAdapter({
      handlers: allRelayHandlers(),
      getLocalCredentials: () => [localCred],
    });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    const s = ctrl.getState();

    expect(s.balance).toEqual(balanceFixture);
    expect(s.budget).toEqual(budgetFixture);
    expect(s.succession).toEqual(successionFixture);
    expect(s.credentials).toHaveLength(2);
    expect(s.revokedIds.has("cred-local-1")).toBe(true);
    expect(s.revokedIds.has("cred-relay-1")).toBe(false);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("filters goals to completed/failed only", async () => {
    const { adapter } = createAdapter({ handlers: allRelayHandlers() });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().goals).toHaveLength(1);
    expect(ctrl.getState().goals[0]?.goal_id).toBe("goal-1");
  });

  it("sets loading=true during refresh, false after", async () => {
    const { adapter } = createAdapter({ handlers: allRelayHandlers() });
    const ctrl = createSovereignController(adapter);
    const seen: boolean[] = [];
    ctrl.subscribe((s) => seen.push(s.loading));
    await ctrl.refresh();
    // First transition to true, last to false.
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it("resolves sovereign balance when address is available", async () => {
    const { adapter } = createAdapter({
      handlers: allRelayHandlers(),
      getSolanaAddress: () => "SoLaNaAddr123",
      getSolanaBalanceMicro: async () => 5_000_000,
    });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().sovereignAddress).toBe("SoLaNaAddr123");
    expect(ctrl.getState().sovereignBalanceUsdc).toBe(5);
  });

  it("leaves sovereign balance null when address is absent", async () => {
    const { adapter } = createAdapter({ handlers: allRelayHandlers() });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().sovereignAddress).toBeNull();
    expect(ctrl.getState().sovereignBalanceUsdc).toBeNull();
  });

  it("tolerates individual endpoint failures without throwing", async () => {
    const handlers = allRelayHandlers();
    handlers.set("/api/v1/agents/mb_test/balance", { status: 500 });
    const { adapter } = createAdapter({ handlers });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    const s = ctrl.getState();
    // Balance null, others populated, no error state.
    expect(s.balance).toBeNull();
    expect(s.budget).toEqual(budgetFixture);
    expect(s.error).toBeNull();
  });

  it("falls back to local credentials when relay fetch fails", async () => {
    const { adapter } = createAdapter({
      handlers: new Map([
        [
          "/api/v1/agents/mb_test/credentials",
          { throws: new Error("network") } satisfies MockHandler,
        ],
      ]),
      getLocalCredentials: () => [localCred],
    });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().credentials).toEqual([localCred]);
  });
});

describe("SovereignController — credential dedup", () => {
  it("removes duplicates by (issuer, type, subject, issued_at)", async () => {
    const duplicate: CredentialEntry = {
      ...relayCred,
      credential_id: "cred-duplicate",
    };
    const { adapter } = createAdapter({
      handlers: new Map([
        [
          "/api/v1/agents/mb_test/credentials",
          { body: { credentials: [relayCred, duplicate] } } satisfies MockHandler,
        ],
        ["/api/v1/credentials/batch-status", { body: { results: [] } } satisfies MockHandler],
      ]),
    });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().credentials).toHaveLength(1);
  });

  it("sorts credentials newest-first", async () => {
    const older: CredentialEntry = {
      ...relayCred,
      credential_id: "cred-older",
      issued_at: 1_600_000_000_000,
    };
    const { adapter } = createAdapter({
      handlers: new Map([
        [
          "/api/v1/agents/mb_test/credentials",
          { body: { credentials: [older, relayCred] } } satisfies MockHandler,
        ],
        ["/api/v1/credentials/batch-status", { body: { results: [] } } satisfies MockHandler],
      ]),
    });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    const creds = ctrl.getState().credentials;
    expect(creds[0]?.credential_id).toBe("cred-relay-1");
    expect(creds[1]?.credential_id).toBe("cred-older");
  });

  it("handles object-form issuer (issuer.id)", async () => {
    const objIssuer: CredentialEntry = {
      credential_id: "cred-obj",
      credential_type: "ReputationCredential",
      credential: {
        issuer: { id: "did:key:z6Mkobj" },
        credentialSubject: { id: "did:key:z6Mksubj" },
      },
      issued_at: 1_700_000_000_000,
    };
    const { adapter } = createAdapter({
      handlers: new Map([
        [
          "/api/v1/agents/mb_test/credentials",
          { body: { credentials: [objIssuer, objIssuer] } } satisfies MockHandler,
        ],
        ["/api/v1/credentials/batch-status", { body: { results: [] } } satisfies MockHandler],
      ]),
    });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    expect(ctrl.getState().credentials).toHaveLength(1);
  });
});

describe("SovereignController — commitSweep()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("converts threshold micro→dollars and writes to state.balance", async () => {
    const { adapter } = createAdapter({
      handlers: new Map([
        ["/api/v1/agents/mb_test/balance", { body: balanceFixture } satisfies MockHandler],
        [
          "/api/v1/agents/mb_test/sweep-config",
          {
            body: { sweep_threshold: 50_000_000, settlement_address: "SoL123" },
          } satisfies MockHandler,
        ],
      ]),
    });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    const result = await ctrl.commitSweep(50_000_000, "SoL123");
    expect(result?.sweep_threshold).toBe(50);
    expect(result?.settlement_address).toBe("SoL123");
    expect(ctrl.getState().balance?.sweep_threshold).toBe(50);
  });

  it("sends threshold and optional address in PATCH body", async () => {
    const { adapter, calls } = createAdapter({
      handlers: new Map([
        ["/api/v1/agents/mb_test/balance", { body: balanceFixture } satisfies MockHandler],
        [
          "/api/v1/agents/mb_test/sweep-config",
          {
            body: { sweep_threshold: 25_000_000, settlement_address: null },
          } satisfies MockHandler,
        ],
      ]),
    });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    await ctrl.commitSweep(25_000_000);
    const patch = calls.find((c) => c.path === "/api/v1/agents/mb_test/sweep-config");
    expect(patch?.init?.method).toBe("PATCH");
    expect(patch?.init?.body).toEqual({ sweep_threshold: 25_000_000 });
  });

  it("handles disable (null threshold)", async () => {
    const { adapter } = createAdapter({
      handlers: new Map([
        [
          "/api/v1/agents/mb_test/balance",
          { body: { ...balanceFixture, sweep_threshold: 50 } } satisfies MockHandler,
        ],
        [
          "/api/v1/agents/mb_test/sweep-config",
          {
            body: { sweep_threshold: null, settlement_address: null },
          } satisfies MockHandler,
        ],
      ]),
    });
    const ctrl = createSovereignController(adapter);
    await ctrl.refresh();
    await ctrl.commitSweep(null);
    expect(ctrl.getState().balance?.sweep_threshold).toBeNull();
  });

  it("writes error to state on failure", async () => {
    const { adapter } = createAdapter({
      handlers: new Map([
        [
          "/api/v1/agents/mb_test/sweep-config",
          { status: 500, body: "server error" } satisfies MockHandler,
        ],
      ]),
    });
    const ctrl = createSovereignController(adapter);
    const result = await ctrl.commitSweep(50_000_000);
    expect(result).toBeNull();
    expect(ctrl.getState().error).toContain("500");
  });

  it("returns null when relay unconfigured", async () => {
    const { adapter } = createAdapter({ syncUrl: null, motebitId: null });
    const ctrl = createSovereignController(adapter);
    const result = await ctrl.commitSweep(50_000_000);
    expect(result).toBeNull();
    expect(ctrl.getState().error).toBe("No relay configured");
  });
});

describe("SovereignController — loadLedgerDetail()", () => {
  it("fetches and caches a ledger manifest", async () => {
    const manifest: LedgerManifest = {
      spec: "execution-ledger-v1",
      motebit_id: "mb_test",
      goal_id: "goal-1",
      content_hash: "abc123",
      signature: "sig",
      timeline: [],
    };
    const { adapter, calls } = createAdapter({
      handlers: new Map([
        ["/agent/mb_test/ledger/goal-1", { body: manifest } satisfies MockHandler],
      ]),
    });
    const ctrl = createSovereignController(adapter);
    const first = await ctrl.loadLedgerDetail("goal-1");
    expect(first).toEqual(manifest);
    expect(ctrl.getState().ledgerDetails.get("goal-1")).toEqual(manifest);

    // Second call serves from cache — no new fetch.
    const before = calls.length;
    const second = await ctrl.loadLedgerDetail("goal-1");
    expect(second).toEqual(manifest);
    expect(calls.length).toBe(before);
  });

  it("returns null on fetch failure", async () => {
    const { adapter } = createAdapter({
      handlers: new Map([["/agent/mb_test/ledger/goal-1", { status: 404 }]]),
    });
    const ctrl = createSovereignController(adapter);
    const result = await ctrl.loadLedgerDetail("goal-1");
    expect(result).toBeNull();
  });
});

describe("SovereignController — subscribe / dispose", () => {
  it("notifies subscribers on state change", async () => {
    const { adapter } = createAdapter({ handlers: allRelayHandlers() });
    const ctrl = createSovereignController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    await ctrl.refresh();
    expect(listener).toHaveBeenCalled();
  });

  it("unsubscribe stops notifications", async () => {
    const { adapter } = createAdapter({ handlers: allRelayHandlers() });
    const ctrl = createSovereignController(adapter);
    const listener = vi.fn();
    const off = ctrl.subscribe(listener);
    off();
    await ctrl.refresh();
    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose stops all notifications and blocks further patches", async () => {
    const { adapter } = createAdapter({ handlers: allRelayHandlers() });
    const ctrl = createSovereignController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    ctrl.dispose();
    await ctrl.refresh();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("SovereignController — setActiveTab()", () => {
  it("updates active tab and notifies", () => {
    const { adapter } = createAdapter();
    const ctrl = createSovereignController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    ctrl.setActiveTab("budget");
    expect(ctrl.getState().activeTab).toBe("budget");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("no-op when tab is already active", () => {
    const { adapter } = createAdapter();
    const ctrl = createSovereignController(adapter);
    const listener = vi.fn();
    ctrl.subscribe(listener);
    ctrl.setActiveTab("credentials"); // initial tab
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("SovereignController — present / verify", () => {
  it("present stores presentation in state", async () => {
    const presentation = { vp: "signed" };
    const { adapter } = createAdapter({
      handlers: new Map([["/api/v1/agents/mb_test/presentation", { body: { presentation } }]]),
    });
    const ctrl = createSovereignController(adapter);
    const result = await ctrl.present();
    expect(result).toEqual(presentation);
    expect(ctrl.getState().presentation).toEqual(presentation);
  });

  it("verify stores result in state", async () => {
    const { adapter } = createAdapter({
      handlers: new Map([
        [
          "/api/v1/credentials/verify",
          { body: { valid: false, reason: "expired" } } satisfies MockHandler,
        ],
      ]),
    });
    const ctrl = createSovereignController(adapter);
    const result = await ctrl.verify({ vp: "bogus" });
    expect(result).toEqual({ valid: false, reason: "expired" });
    expect(ctrl.getState().verifyResult).toEqual({ valid: false, reason: "expired" });
  });

  it("verify surfaces fetch errors as invalid+reason", async () => {
    const { adapter } = createAdapter({
      handlers: new Map([
        ["/api/v1/credentials/verify", { throws: new Error("network down") } satisfies MockHandler],
      ]),
    });
    const ctrl = createSovereignController(adapter);
    const result = await ctrl.verify({});
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("network down");
  });
});
