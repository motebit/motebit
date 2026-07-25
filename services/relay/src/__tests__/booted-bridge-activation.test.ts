/**
 * BOOTED TWO-ARTIFACT BRIDGE activation conformance — the arc's named ceiling
 * (docs/doctrine/composition-preserves-enforcement.md).
 *
 * Every prior rung of the pipeline-link ladder proves a guarantee against ONE
 * deployed artifact: the per-link booted suites and the whole-pipeline single
 * flow all boot the relay (`node dist/server.js`) and sever inside it. But the
 * money path's AUTHORITY decision and its MONEY RECORDING live in DIFFERENT
 * deployed artifacts — the R4 gate is in the molecule RUNTIME
 * (`defaultCreateMoneyRuntime` → `MotebitRuntime.executeGrantedDelegation`),
 * the settlement ledger is in the RELAY. "An unauthorized grant must move no
 * money" is a guarantee that only holds if it is ENFORCED ACROSS that boundary.
 * A single-artifact suite cannot prove it: the runtime could fail open and the
 * relay would dutifully record the money it was told about.
 *
 * So this suite BRIDGES the two. It boots the real relay artifact AND drives
 * the real production runtime builder (`defaultCreateMoneyRuntime` — the exact
 * function deployed molecules use, #357's composition root), with only two
 * things faked, both OUTSIDE the guarantee: the Solana RPC (a fake adapter via
 * the `walletOverride` seam, #381 — so the real sovereign rail runs its real
 * `buildP2pPayment` with no live chain) and the WORKER's compute (a fake MCP
 * endpoint that returns a signed receipt so the hire completes inside the
 * runtime's 120s receipt poll). Everything between — grant verification, the R4
 * scope gate, the atomic P2P broadcast, the relay's proof validation, receipt
 * ingestion, settlement recording, trust accrual — is the real deployed code.
 *
 *  - accept-half: an AUTHORIZED in-scope self-grant hires the worker; the real
 *    payment leg fires (injected rail), the booted relay records a P2P
 *    settlement row AND accrues trust for the worker — money crossed the bridge
 *    under authority and the ledger-of-record artifact captured it.
 *  - reject-half: an OUT-OF-SCOPE grant is refused at the runtime's R4 gate
 *    (`missing_scope`) BEFORE any broadcast — the injected rail never fires and
 *    the relay records nothing. The authority artifact fails closed and no
 *    money reaches the ledger artifact.
 *
 * TWO-ARTIFACT SEVERING (manual, recorded here): neutralize the R4 scope gate
 * in the RUNTIME — `if (!decision.allowed) return { ok:false, code:"missing_scope" }`
 * at packages/runtime/src/motebit-runtime.ts (~L4917) → `if (false && ...)` +
 * rebuild @motebit/runtime → the reject-half's out-of-scope grant falls through
 * to the broadcast and the booted relay records a settlement it should never
 * have seen (reject-half's `sent()===0` / no-settlement assertions flip red).
 * The gate is the ONLY thing between an unauthorized grant and a real
 * cross-artifact money movement.
 *
 * Why this suite is EXEMPT from check-activation-effective: that meta-gate
 * probes by mutating relay source and rebuilding the relay dist. This suite's
 * distinguishing severing lives in the RUNTIME artifact (motebit-runtime.ts),
 * which the relay-dist rebuild does not touch — so the meta-gate structurally
 * cannot probe it. The same R4-gate severing is exercised in-process by
 * molecule-runner's money-runtime-activation (#381); the relay-side effects
 * this suite observes (settlement recording, trust accrual) ARE continuously
 * probed by booted-settlement / booted-trust / booted-pipeline. This suite is
 * the cross-artifact bonus proof, not the sole net for any guarantee.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  signStandingDelegation,
  hash as sha256,
} from "@motebit/crypto";
import { createInMemoryStorage } from "@motebit/runtime";
import { InMemoryToolRegistry } from "@motebit/tools";
import { SolanaWalletRail, type SolanaRpcAdapter } from "@motebit/wallet-solana";
import type { BootstrapAndEmitIdentityResult } from "@motebit/mcp-server";
import { RiskLevel } from "@motebit/sdk";
import {
  defaultCreateMoneyRuntime,
  selfIssueGrant,
  mintTick,
  type MoleculeConfig,
} from "@motebit/molecule-runner";
import {
  BOOT_TIMEOUT_MS,
  DIST_TIER,
  bootRealEntry,
  killBootedEntry,
  type BootedEntry,
} from "./booted-entry-harness.js";

const MASTER_TOKEN = "booted-bridge-master-token";
const WORKER_ADDR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const CAPABILITY = "research";
const UNIT_COST_USD = 0.5;
const FAKE_WORKER_PORT = 18941; // below the ephemeral range
const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${MASTER_TOKEN}` };

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A fresh, format-plausible 88-char base58 signature — the atomic tx_hash the
 * real buildP2pPayment threads onto the proof (the relay validates the shape).
 * Unique per rail so re-runs never collide on the submission idempotency key. */
function fakeSolanaTxHash(): string {
  let s = "";
  for (let i = 0; i < 88; i++) s += BASE58[Math.floor(Math.random() * BASE58.length)];
  return s;
}

interface Provisioned {
  motebitId: string;
  deviceId: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
}

async function provisionDevice(baseUrl: string): Promise<Provisioned> {
  const keypair = await generateKeypair();
  const idRes = await fetch(`${baseUrl}/identity`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  if (!idRes.ok) throw new Error(`/identity failed: ${idRes.status}`);
  const identity = (await idRes.json()) as { motebit_id: string };
  const devRes = await fetch(`${baseUrl}/device/register`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      motebit_id: identity.motebit_id,
      device_name: "booted-bridge-probe",
      public_key: bytesToHex(keypair.publicKey),
    }),
  });
  if (!devRes.ok) throw new Error(`/device/register failed: ${devRes.status}`);
  const device = (await devRes.json()) as { device_id: string };
  return {
    motebitId: identity.motebit_id,
    deviceId: device.device_id,
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    publicKeyHex: bytesToHex(keypair.publicKey),
  };
}

async function registerWorker(baseUrl: string, worker: Provisioned): Promise<void> {
  const reg = await fetch(`${baseUrl}/api/v1/agents/register`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      motebit_id: worker.motebitId,
      endpoint_url: `http://127.0.0.1:${FAKE_WORKER_PORT}/mcp`,
      capabilities: [CAPABILITY],
      settlement_address: WORKER_ADDR,
      settlement_modes: "relay,p2p",
    }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  const listing = await fetch(`${baseUrl}/api/v1/agents/${worker.motebitId}/listing`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      capabilities: [CAPABILITY],
      pricing: [{ capability: CAPABILITY, unit_cost: UNIT_COST_USD, currency: "USD", per: "task" }],
      sla: { max_latency_ms: 5000, availability_guarantee: 0.99 },
      description: "booted-bridge worker",
      pay_to_address: WORKER_ADDR,
    }),
  });
  if (!listing.ok) throw new Error(`listing failed: ${listing.status} ${await listing.text()}`);
}

/** The runtime's identity IS a provisioned device, so its makeAuthTokenMinter
 * tokens verify on the booted relay. */
function identityFrom(p: Provisioned): BootstrapAndEmitIdentityResult {
  return {
    motebitId: p.motebitId,
    deviceId: p.deviceId,
    publicKeyHex: p.publicKeyHex,
    publicKey: p.publicKey,
    privateKey: p.privateKey,
    identityContent: "# motebit.md\n",
    identityPath: "/data/motebit.md",
    isFirstLaunch: true,
  };
}

function moneyConfig(syncUrl: string, relayPublicKeyHex: string): MoleculeConfig {
  return {
    dataDir: "/tmp/motebit-bridge-test",
    dbPath: "/tmp/motebit-bridge-test/test.db",
    port: 9998,
    serviceName: "motebit-bridge-test",
    displayName: "Bridge Test",
    serviceDescription: "Two-artifact bridge activation conformance",
    capabilities: [CAPABILITY],
    syncUrl,
    moneyExecution: {
      solanaRpcUrl: "https://unused-fake-rpc.test",
      relayPublicKeyHex,
      spendCeiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 1_000_000 },
    },
  };
}

/** Fake sovereign rail: real SolanaWalletRail over a fake adapter whose atomic
 * batch returns ONE shared 88-char signature for every leg (buildP2pPayment
 * requires a single shared sig), so the real proof builder yields a
 * relay-acceptable proof with no live chain. `sent()` counts broadcasts. */
function fakeRail(): { rail: SolanaWalletRail; sent: () => number } {
  let calls = 0;
  const sig = fakeSolanaTxHash();
  const adapter = {
    ownAddress: "FaKeSo1anaAddr1111111111111111111111111111",
    getUsdcBalance: async () => 100_000_000n,
    getSolBalance: async () => 10_000_000n,
    sendUsdc: async () => ({ ok: true, signature: sig, slot: 1, confirmed: true }),
    sendUsdcBatch: async (legs: readonly unknown[]) => {
      calls++;
      return legs.map(() => ({ ok: true, signature: sig, slot: 1, confirmed: true }));
    },
    getTransaction: async () => ({ status: "not_found" }),
    isReachable: async () => true,
  } as unknown as SolanaRpcAdapter;
  return { rail: new SolanaWalletRail(adapter), sent: () => calls };
}

/** A ≥170-char result so the completion clears the quality gate (else the task
 * is reclassified failure and no trust accrues). */
const WORKER_RESULT =
  "The requested research is complete. Findings are summarized across the relevant sources with " +
  "citations, methodology notes, and a confidence assessment sufficient to clear the receipt " +
  "quality threshold for a successful task completion in the deployed relay artifact.";

/** Fake worker MCP endpoint: answers the relay's forwardTaskViaMcp round-trip
 * and returns a worker-signed receipt bound to the forwarded relay_task_id, so
 * the hire completes synchronously inside the runtime's receipt poll. */
function fakeWorkerServer(worker: Provisioned): Server {
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end("{}"); // /health wake
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      void (async () => {
        let msg: { id?: number; method?: string; params?: Record<string, unknown> } = {};
        try {
          msg = JSON.parse(raw) as typeof msg;
        } catch {
          /* fall through to empty result */
        }
        res.setHeader("Content-Type", "application/json");
        const reply = (result: unknown): void => {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? 0, result }));
        };

        if (msg.method === "tools/call") {
          const args = (msg.params?.arguments ?? {}) as { prompt?: string; relay_task_id?: string };
          const taskId = args.relay_task_id ?? "";
          const prompt = args.prompt ?? "";
          const enc = new TextEncoder();
          const now = Date.now();
          const receiptBody = {
            task_id: taskId,
            relay_task_id: taskId,
            motebit_id: worker.motebitId,
            public_key: worker.publicKeyHex,
            device_id: worker.deviceId,
            submitted_at: now - 1000,
            completed_at: now,
            status: "completed" as const,
            result: WORKER_RESULT,
            tools_used: [] as string[],
            memories_formed: 0,
            prompt_hash: await sha256(enc.encode(prompt)),
            result_hash: await sha256(enc.encode(WORKER_RESULT)),
          };
          const signed = await signExecutionReceipt(
            receiptBody as unknown as Parameters<typeof signExecutionReceipt>[0],
            worker.privateKey,
            worker.publicKey,
          );
          reply({ content: [{ type: "text", text: JSON.stringify(signed) }] });
          return;
        }
        // initialize / notifications/initialized / anything else: bare result.
        reply({});
      })();
    });
  });
  server.listen(FAKE_WORKER_PORT, "127.0.0.1");
  return server;
}

interface SettlementRow {
  settlement_mode: string;
  amount_settled: number;
  platform_fee: number;
}
async function readSettlements(baseUrl: string, motebitId: string): Promise<SettlementRow[]> {
  const res = await fetch(`${baseUrl}/agent/${motebitId}/settlements`, {
    headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
  });
  if (!res.ok) throw new Error(`settlements read failed: ${res.status}`);
  const { settlements } = (await res.json()) as { settlements: SettlementRow[] };
  return settlements;
}

interface TrustRow {
  remote_motebit_id: string;
  interaction_count: number;
  successful_tasks: number;
}
async function readTrust(baseUrl: string, motebitId: string): Promise<TrustRow[]> {
  const res = await fetch(`${baseUrl}/api/v1/agent-trust/${motebitId}`, {
    headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
  });
  if (!res.ok) throw new Error(`trust read failed: ${res.status}`);
  const body = (await res.json()) as { records?: TrustRow[] };
  return body.records ?? [];
}

type BridgeRuntime = {
  executeGrantedDelegation: (params: {
    capability: string;
    prompt: string;
    delegation: { token: unknown; grant: unknown; revocations?: unknown[] };
    dryRun: boolean;
    targetWorkerId?: string;
  }) => Promise<{ ok: boolean; code?: string }>;
  stop?: () => void;
};

function buildRuntime(
  identity: BootstrapAndEmitIdentityResult,
  cfg: MoleculeConfig,
  rail: SolanaWalletRail,
): BridgeRuntime {
  return defaultCreateMoneyRuntime(
    identity,
    createInMemoryStorage(),
    new InMemoryToolRegistry(),
    { requireApprovalAbove: RiskLevel.R3_EXECUTE, denyAbove: RiskLevel.R3_EXECUTE },
    cfg,
    undefined as never,
    rail,
  ) as unknown as BridgeRuntime;
}

describe("booted two-artifact bridge — runtime R4 authority gates money reaching the relay ledger", () => {
  let booted: BootedEntry | null = null;
  let workerServer: Server | null = null;
  let worker: Provisioned;
  let delegator: Provisioned;
  let relayPublicKeyHex: string;

  beforeAll(async () => {
    booted = await bootRealEntry(DIST_TIER, { MOTEBIT_API_TOKEN: MASTER_TOKEN });
    const idRes = await fetch(`${booted.baseUrl}/federation/v1/identity`);
    ({ public_key: relayPublicKeyHex } = (await idRes.json()) as { public_key: string });
    worker = await provisionDevice(booted.baseUrl);
    delegator = await provisionDevice(booted.baseUrl);
    await registerWorker(booted.baseUrl, worker);
    workerServer = fakeWorkerServer(worker);
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    if (workerServer) await new Promise<void>((r) => workerServer!.close(() => r()));
    killBootedEntry(booted);
  });

  it("accept-half: an AUTHORIZED hire moves money across the bridge — the booted relay records the settlement + trust", async () => {
    const identity = identityFrom(delegator);
    const cfg = moneyConfig(booted!.baseUrl, relayPublicKeyHex);
    const { rail, sent } = fakeRail();
    const runtime = buildRuntime(identity, cfg, rail);

    const grant = await selfIssueGrant(identity, cfg.moneyExecution!);
    const token = await mintTick(grant, identity);
    const exec = await runtime.executeGrantedDelegation({
      capability: CAPABILITY,
      prompt: "bridge probe — authorized",
      delegation: { token, grant },
      dryRun: false,
      targetWorkerId: worker.motebitId,
    });
    runtime.stop?.();

    // The hire completed through the fake worker receipt.
    expect(exec.ok).toBe(true);
    // The real payment leg fired (injected rail broadcast the atomic tx).
    expect(sent()).toBeGreaterThanOrEqual(1);
    // The ledger-of-record artifact captured the P2P settlement on the
    // delegator's ledger (the mover of the money): the runtime submits to
    // /agent/{delegator}/task, so the relay keys the settlement + trust records
    // to the delegator — the first-person [delegator, worker] direction.
    const p2p = (await readSettlements(booted!.baseUrl, delegator.motebitId)).filter(
      (r) => r.settlement_mode === "p2p",
    );
    expect(p2p).toHaveLength(1);
    expect(p2p[0]!.amount_settled).toBe(500_000);
    expect(p2p[0]!.platform_fee).toBeGreaterThan(0);
    // ...and accrued a first-person trust edge to the worker off that settlement.
    const trust = await readTrust(booted!.baseUrl, delegator.motebitId);
    const edge = trust.find((r) => r.remote_motebit_id === worker.motebitId);
    expect(edge?.interaction_count).toBeGreaterThanOrEqual(1);
    expect(edge?.successful_tasks).toBeGreaterThanOrEqual(1);
  });

  it("reject-half: an OUT-OF-SCOPE grant fails closed at the runtime R4 gate — no broadcast, the relay records nothing", async () => {
    const identity = identityFrom(delegator);
    const cfg = moneyConfig(booted!.baseUrl, relayPublicKeyHex);
    const { rail, sent } = fakeRail();
    const runtime = buildRuntime(identity, cfg, rail);

    const now = Date.now();
    const grant = await signStandingDelegation(
      {
        grant_id: `clerk-self-grant:${identity.motebitId}`,
        delegator_id: identity.motebitId,
        delegator_public_key: identity.publicKeyHex,
        delegate_id: identity.motebitId,
        delegate_public_key: identity.publicKeyHex,
        scope: "pay_invoice", // wrong SIGNED scope for a `research` hire
        subject: "market:self-funded-delegation",
        cadence_ms: 0,
        issued_at: now,
        not_before: null,
        expires_at: now + 90 * 24 * 60 * 60 * 1000,
        max_token_ttl_ms: 60 * 60 * 1000,
        spend_ceiling: cfg.moneyExecution!.spendCeiling,
      },
      identity.privateKey,
    );
    const token = await mintTick(grant, identity);

    // The delegator's ledger is where a real broadcast WOULD land (accept-half
    // proved that), so it is the right place to prove nothing lands here.
    const before = (await readSettlements(booted!.baseUrl, delegator.motebitId)).length;
    const exec = await runtime.executeGrantedDelegation({
      capability: CAPABILITY,
      prompt: "bridge probe — out of scope",
      delegation: { token, grant },
      dryRun: false,
      targetWorkerId: worker.motebitId,
    });
    runtime.stop?.();

    // The RUNTIME artifact fails closed BEFORE the broadcast.
    expect(exec).toEqual({ ok: false, code: "missing_scope" });
    // The injected rail never fired — no money left the delegator.
    expect(sent()).toBe(0);
    // And the RELAY artifact recorded nothing new (money never crossed). Under
    // the R4-gate severing this count grows by one — the two-artifact defect.
    const after = (await readSettlements(booted!.baseUrl, delegator.motebitId)).length;
    expect(after).toBe(before);
  });
});
