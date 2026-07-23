/**
 * ACTIVATION conformance for #357, at the seam where #357 actually lived.
 *
 * docs/doctrine/composition-preserves-enforcement.md Inc 2. The Inc 1 severing
 * test (packages/runtime, execute-granted-delegation.test.ts) proved the
 * RUNTIME goes dormant without signing keys — but it constructs MotebitRuntime
 * directly, one level BELOW the composition root that caused #357:
 * `defaultCreateMoneyRuntime` never passed `signingKeys`, so every deployed
 * molecule's producer was dormant while every runtime-level test stayed green.
 * A test that does not invoke the real builder would stay green if the builder
 * dropped the keys again.
 *
 * So THIS test drives the REAL production builder: `defaultCreateMoneyRuntime`
 * with a real keypair identity, the real self-grant path (`selfIssueGrant` +
 * `mintTick` — the exact artifacts a deployed Clerk mints), and a real ranked
 * paid hire through `executeGrantedDelegation`. The positive assertion binds
 * the minted transcript to the BUILDER's key wiring: `delegator_public_key`
 * must equal the identity hex the builder received. If the builder ever stops
 * threading `signingKeys` (the #357 regression), the producer is dormant and
 * this test goes red — proven by perturbation (removing the builder's
 * signingKeys line makes this fail; see the PR record).
 *
 * Layering note (honest scope): the payment leg runs the REAL sovereign rail
 * the builder constructs, which fails against the stubbed RPC — that is fine
 * and deliberate, because the transcript mints at worker SELECTION, before
 * broadcast (reveals-never-authorizes: minting failure never fails the hire,
 * and hire failure never un-mints the record). The result-seam egress
 * (`execResult.routingTranscript`) is pinned at the runtime layer by the Inc 1
 * happy-path test; this file pins the composition root. Together they cover
 * the chain that #357 + #358 broke.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  verifyRoutingTranscript,
  signDelegationRevocation,
  signStandingDelegation,
} from "@motebit/crypto";
import { createInMemoryStorage } from "@motebit/runtime";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { BootstrapAndEmitIdentityResult } from "@motebit/mcp-server";
import type { MoleculeConfig } from "../index.js";
import { defaultCreateMoneyRuntime, selfIssueGrant, mintTick } from "../index.js";
import { RiskLevel } from "@motebit/sdk";

/** Structural view of the fields this test asserts (the full type lives in
 * `@motebit/protocol`, not a declared dep of this package). */
type MintedTranscript = {
  delegator_motebit_id: string;
  delegator_public_key: string;
  seed: string;
  capability: string;
  winner_motebit_id: string;
  candidates: ReadonlyArray<unknown>;
};

const RELAY_URL = "https://mock-relay.test";
const SOLANA_RPC = "https://mock-solana-rpc.test";

async function realIdentity(): Promise<BootstrapAndEmitIdentityResult> {
  const kp = await generateKeypair();
  return {
    motebitId: "mot_activation_357",
    deviceId: "dev_activation",
    publicKeyHex: bytesToHex(kp.publicKey),
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    identityContent: "# motebit.md\n",
    identityPath: "/data/motebit.md",
    isFirstLaunch: true,
  };
}

function moneyConfig(): MoleculeConfig {
  return {
    dataDir: "/tmp/motebit-activation-test",
    dbPath: "/tmp/motebit-activation-test/test.db",
    port: 9999,
    serviceName: "motebit-activation-test",
    displayName: "Activation Test",
    serviceDescription: "Composition-root activation conformance",
    capabilities: ["research"],
    syncUrl: RELAY_URL,
    moneyExecution: {
      solanaRpcUrl: SOLANA_RPC,
      relayPublicKeyHex: "07".repeat(32),
      spendCeiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 1_000_000 },
    },
  };
}

/** Typed URL extraction from a fetch-mock call arg (no default stringify). */
function reqUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Two rankable local workers so the selector runs a REAL ranked pass. */
function stubRelayAndRpcFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(SOLANA_RPC)) {
        // The REAL sovereign rail the builder constructed reaches here on the
        // payment leg. Refusing it proves the transcript minted BEFORE
        // broadcast — the reveals-never-authorizes ordering.
        return new Response("rpc unavailable (test)", { status: 503 });
      }
      if (url.includes("/api/v1/agents/discover"))
        return jsonResponse({
          agents: [
            {
              motebit_id: "worker-a",
              settlement_address: "WorkerAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              settlement_modes: "p2p",
              pricing: [{ capability: "research", unit_cost: 0.05 }],
            },
            {
              motebit_id: "worker-b",
              settlement_address: "WorkerBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              settlement_modes: "p2p",
              pricing: [{ capability: "research", unit_cost: 0.05 }],
            },
          ],
        });
      if (url.includes("/p2p-eligibility"))
        return jsonResponse({ allowed: url.includes("acknowledge_no_history_risk=true") });
      if (url.includes("/listing"))
        return jsonResponse({ pricing: [{ capability: "research", unit_cost: 0.05 }] });
      if (url.endsWith("/task")) return jsonResponse({ task_id: "t1" }, 201);
      return new Response("not found", { status: 404 });
    }),
  );
}

type ActivationRuntime = {
  executeGrantedDelegation: (params: {
    capability: string;
    prompt: string;
    delegation: { token: unknown; grant: unknown; revocations?: unknown[] };
    dryRun: boolean;
  }) => Promise<{ ok: boolean; code?: string }>;
  getRecentRoutingTranscripts: () => ReadonlyArray<MintedTranscript>;
  stop?: () => void;
};

describe("defaultCreateMoneyRuntime — transcript producer ACTIVE at the composition root (#357)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a ranked paid hire through the REAL builder mints a transcript signed by the BUILDER-wired identity keys", async () => {
    const identity = await realIdentity();
    const cfg = moneyConfig();

    // The REAL production builder — the exact function deployed molecules use.
    // No signingKeys are passed by this test; if they reach the runtime, the
    // builder threaded them (the #357 wiring under test). policyOverrides
    // mirror what `runMolecule` ALWAYS feeds (DEFAULT_POLICY_OVERRIDES — both
    // bands at R3; the builder itself raises denyAbove to R4): passing {} here
    // would exercise a config production never runs (legacy two-state → R4
    // denied `missing_scope` before selection — this test found that the hard
    // way).
    const runtime = defaultCreateMoneyRuntime(
      identity,
      createInMemoryStorage(),
      new InMemoryToolRegistry(),
      { requireApprovalAbove: RiskLevel.R3_EXECUTE, denyAbove: RiskLevel.R3_EXECUTE },
      cfg,
      undefined as never, // grantSpendStore ⇒ in-memory fallback
    ) as unknown as ActivationRuntime;

    // The REAL production grant path — what a deployed Clerk self-issues.
    const grant = await selfIssueGrant(identity, cfg.moneyExecution!);
    const token = await mintTick(grant, identity);

    stubRelayAndRpcFetch();
    const exec = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "activation probe",
      delegation: { token, grant },
      dryRun: false,
    });
    runtime.stop?.();

    // The payment leg ran the real rail against the refused RPC — the hire
    // itself is EXPECTED to fail. The guarantee under test survives that:
    expect(exec).toBeTypeOf("object");

    // ACTIVATION: the producer minted during selection. Absent builder key
    // wiring (#357 reintroduced) this array is empty and the test goes red.
    const transcripts = runtime.getRecentRoutingTranscripts();
    expect(transcripts).toHaveLength(1);
    const t = transcripts[0]!;

    // Bind the artifact to the COMPOSITION ROOT: signed by exactly the
    // identity keys the builder received — not merely "some transcript".
    expect(t.delegator_motebit_id).toBe(identity.motebitId);
    expect(t.delegator_public_key).toBe(identity.publicKeyHex);
    // Seed provenance: the signed tick this test minted through the real path.
    expect(t.seed).toBe((token as { signature: string }).signature);
    expect(t.capability).toBe("research");
    expect(["worker-a", "worker-b"]).toContain(t.winner_motebit_id);
    expect(t.candidates).toHaveLength(2);

    // Rung 1 — the builder-wired keys produced a VERIFIABLE signature.
    expect(
      await verifyRoutingTranscript(t as unknown as Parameters<typeof verifyRoutingTranscript>[0]),
    ).toEqual({ valid: true });
  });
});

/**
 * The policy→action link's composition-root NEGATIVES
 * (docs/doctrine/composition-preserves-enforcement.md — pipeline-link
 * ladder). The fail-closed proofs for money-without-authority all lived one
 * layer below (`execute-granted-delegation.test.ts` constructs
 * MotebitRuntime directly), so a drift in the REAL builder's policy wiring
 * would leave every one of them green. These drive the same refusals through
 * `defaultCreateMoneyRuntime` — the exact function deployed molecules use.
 *
 * Rung honesty: this is the composition-root rung, in-process. The deployed
 * consumer (services/clerk via runMolecule's spend handle) has no
 * booted-artifact rung yet; that rung is the link's remaining step.
 *
 * Discriminating power (severing run, recorded in the PR): the revocation
 * list reaches `verifyGrantForTurn` only through the caller-threaded
 * `params.delegation.revocations ?? []` — a threading with a fail-open
 * default that NO static needle covers (`check-money-authority` pins the
 * verify call, the null-check, and the scope fence, but not revocation
 * threading). Severing it (`?? []` → `[]`) turns the revoked-grant test red
 * while `check-money-authority` stays green — the needle-invisible class.
 */
describe("defaultCreateMoneyRuntime — money-without-authority fails CLOSED at the composition root", () => {
  it("a REVOKED self-grant is refused (requires_verified_grant), no selection, no broadcast", async () => {
    const identity = await realIdentity();
    const cfg = moneyConfig();
    const runtime = defaultCreateMoneyRuntime(
      identity,
      createInMemoryStorage(),
      new InMemoryToolRegistry(),
      { requireApprovalAbove: RiskLevel.R3_EXECUTE, denyAbove: RiskLevel.R3_EXECUTE },
      cfg,
      undefined as never,
    ) as unknown as ActivationRuntime;

    const grant = await selfIssueGrant(identity, cfg.moneyExecution!);
    const token = await mintTick(grant, identity);
    const g = grant as unknown as {
      grant_id: string;
      delegator_id: string;
      delegator_public_key: string;
    };
    const revocation = await signDelegationRevocation(
      {
        grant_id: g.grant_id,
        delegator_id: g.delegator_id,
        delegator_public_key: g.delegator_public_key,
        revoked_at: Date.now(),
      },
      identity.privateKey,
    );

    stubRelayAndRpcFetch();
    const exec = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "activation probe (revoked)",
      delegation: { token, grant, revocations: [revocation] },
      dryRun: false,
    });
    runtime.stop?.();

    expect(exec).toEqual({ ok: false, code: "requires_verified_grant" });
    // Refusal happened BEFORE selection: no transcript minted, and the real
    // rail was never reached (no RPC call on the stubbed fetch).
    expect(runtime.getRecentRoutingTranscripts()).toHaveLength(0);
    const fetchMock = globalThis.fetch as unknown as {
      mock: { calls: [string | URL | Request][] };
    };
    const rpcCalls = fetchMock.mock.calls.filter(([input]) => reqUrl(input).startsWith(SOLANA_RPC));
    expect(rpcCalls).toHaveLength(0);
  });

  it("an OUT-OF-SCOPE grant is refused (missing_scope), no selection, no broadcast", async () => {
    const identity = await realIdentity();
    const cfg = moneyConfig();
    const runtime = defaultCreateMoneyRuntime(
      identity,
      createInMemoryStorage(),
      new InMemoryToolRegistry(),
      { requireApprovalAbove: RiskLevel.R3_EXECUTE, denyAbove: RiskLevel.R3_EXECUTE },
      cfg,
      undefined as never,
    ) as unknown as ActivationRuntime;

    // Same REAL signing path as selfIssueGrant, wrong SIGNED scope — the
    // grant authorizes a different tool than the spend handle invokes.
    const now = Date.now();
    const grant = await signStandingDelegation(
      {
        grant_id: `clerk-self-grant:${identity.motebitId}`,
        delegator_id: identity.motebitId,
        delegator_public_key: identity.publicKeyHex,
        delegate_id: identity.motebitId,
        delegate_public_key: identity.publicKeyHex,
        scope: "pay_invoice",
        subject: "market:self-funded-delegation",
        cadence_ms: 0,
        issued_at: now,
        not_before: null,
        expires_at: now + 90 * 24 * 60 * 60 * 1000,
        max_token_ttl_ms: 60 * 60 * 1000, // ≥ the tick's real TICK_TTL_MS (1h)
        spend_ceiling: cfg.moneyExecution!.spendCeiling,
      },
      identity.privateKey,
    );
    const token = await mintTick(grant, identity);

    stubRelayAndRpcFetch();
    const exec = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "activation probe (out of scope)",
      delegation: { token, grant },
      dryRun: false,
    });
    runtime.stop?.();

    expect(exec).toEqual({ ok: false, code: "missing_scope" });
    expect(runtime.getRecentRoutingTranscripts()).toHaveLength(0);
    const fetchMock = globalThis.fetch as unknown as {
      mock: { calls: [string | URL | Request][] };
    };
    const rpcCalls = fetchMock.mock.calls.filter(([input]) => reqUrl(input).startsWith(SOLANA_RPC));
    expect(rpcCalls).toHaveLength(0);
  });

  it("a TAMPERED grant (ceiling raised after signing) is refused (requires_verified_grant)", async () => {
    const identity = await realIdentity();
    const cfg = moneyConfig();
    const runtime = defaultCreateMoneyRuntime(
      identity,
      createInMemoryStorage(),
      new InMemoryToolRegistry(),
      { requireApprovalAbove: RiskLevel.R3_EXECUTE, denyAbove: RiskLevel.R3_EXECUTE },
      cfg,
      undefined as never,
    ) as unknown as ActivationRuntime;

    const grant = await selfIssueGrant(identity, cfg.moneyExecution!);
    const token = await mintTick(grant, identity);
    const tampered = {
      ...(grant as unknown as Record<string, unknown>),
      spend_ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 1_000_000_000 },
    };

    stubRelayAndRpcFetch();
    const exec = await runtime.executeGrantedDelegation({
      capability: "research",
      prompt: "activation probe (tampered)",
      delegation: { token, grant: tampered },
      dryRun: false,
    });
    runtime.stop?.();

    expect(exec).toEqual({ ok: false, code: "requires_verified_grant" });
    expect(runtime.getRecentRoutingTranscripts()).toHaveLength(0);
  });
});
