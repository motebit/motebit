/**
 * Spend containment for first-party molecules — no configuration of a
 * `runMolecule` process yields a signed mainnet-USDC transfer.
 *
 * Every wallet rail a molecule holds carries `MOLECULE_SPENDABLE_MINTS`
 * (devnet USDC only). This file drives every entry that can reach a rail,
 * through the REAL composition root (`runMolecule` → `defaultCreateMoneyRuntime`
 * → `MotebitRuntime`), over a real SQLite database, with a fake RPC adapter
 * that counts every send and reports the MAINNET mint:
 *
 *   - the spend handle, live and dry-run
 *   - `executeGrantedDelegation`
 *   - `delegate_to_agent` through `executeToolGated`
 *   - `invokeCapability`
 *   - runtime `sendUsdc`
 *   - the earnings sweep
 *
 * in both broadcast-hook shapes (`honorsBroadcastHooks` true and absent), and
 * asserts: zero adapter sends, zero signatures reported, the grant-spend store
 * and the paid-intent ledger unchanged, and the surfaced code
 * `rail_spend_refused`. Controls: the devnet mint reaches the adapter; an
 * adapter that reports no mint is refused; the runner refuses to start with a
 * rail that lacks the exact allowlist.
 *
 * The production runner does not hand the SQLite paid-intent store to the
 * runtime (its ledger is in-process); the harness wires it so "the ledger is
 * unchanged" is asserted on the durable table as well as on the runtime.
 *
 * Tamper: scripts/tampers/molecule-spend-containment.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, bytesToHex } from "@motebit/crypto";
import { openMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";
import { InMemoryToolRegistry } from "@motebit/tools";
import {
  SolanaWalletRail,
  sweepWalletRail,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
} from "@motebit/wallet-solana";
import type { SolanaRpcAdapter } from "@motebit/wallet-solana";
import type { BootstrapAndEmitIdentityResult, ServiceHandle } from "@motebit/mcp-server";
import type { MoleculeConfig, MoleculeRunnerAdapters, MoleculeSpendHandle } from "../index.js";
import {
  MOLECULE_SPENDABLE_MINTS,
  assertMoleculeRailContained,
  createMoleculeWalletRail,
  defaultCreateMoneyRuntime,
  describeRailSpendPosture,
  mintTick,
  runMolecule,
  selfIssueGrant,
} from "../index.js";

const RELAY_URL = "https://mock-relay.test";
const SOLANA_RPC = "http://127.0.0.1:1";
const SWEEP_DEST = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgHkv";
const WORKER_ADDRESS = "WorkerAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FAKE_SIG = "4vERYvaLiDsLaNaTransaCtiNSignaTuReHashThatis88charsLng1234567891abcDEFghijk1234";

/** The pinned relay key + its signed discovery metadata (fixture seed fill(7)). */
const SIGNING_PINNED_HEX = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
const SIGNED_RELAY_METADATA = {
  protocol_version: "1.0",
  relay_id: "test-relay",
  public_key: SIGNING_PINNED_HEX,
  endpoint_url: "https://relay.test",
  suite: "motebit-jcs-ed25519-hex-v1",
  signature:
    "caee9335accca4025e16e85777179db08dc77034b8de0ef024763a7d4905aaecd371829876064a228b9ad2c040fdbffaf648c373cec948fecef981b83591570e",
};

function reqUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A relay that quotes one payable worker and refuses the submission outright. */
function stubRelay(): { calls: () => string[]; reset: () => void } {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = reqUrl(input);
      seen.push(url);
      if (url.endsWith("/.well-known/motebit.json")) return jsonResponse(SIGNED_RELAY_METADATA);
      if (url.includes("/api/v1/agents/discover"))
        return jsonResponse({
          agents: [
            {
              motebit_id: "worker-a",
              settlement_address: WORKER_ADDRESS,
              settlement_modes: "p2p",
              pricing: [{ capability: "research", unit_cost: 0.05 }],
            },
          ],
        });
      if (url.includes("/p2p-eligibility"))
        return jsonResponse({
          allowed: url.includes("acknowledge_no_history_risk=true"),
          settlement_address: WORKER_ADDRESS,
        });
      if (url.includes("/listing"))
        return jsonResponse({ pricing: [{ capability: "research", unit_cost: 0.05 }] });
      // A definitive refusal (never retried) — a payment that reached the
      // adapter has already run by here.
      if (url.endsWith("/task"))
        return jsonResponse({ code: "malformed_request", error: "submit refused (test)" }, 400);
      return new Response("not found", { status: 404 });
    }),
  );
  return {
    calls: () => [...seen],
    reset: () => {
      seen.length = 0;
    },
  };
}

type HookShape = true | undefined;

/** A fake RPC adapter that counts every send and every signature it reports. */
function countingAdapter(opts: { usdcMint: string | undefined; honorsBroadcastHooks: HookShape }) {
  const counts = { sendUsdc: 0, sendUsdcBatch: 0, getSolBalance: 0, signaturesReported: 0 };
  type Hooks = { beforeBroadcast?: (tx: unknown) => void | Promise<void> } | undefined;
  const report = async (hooks: Hooks): Promise<void> => {
    if (opts.honorsBroadcastHooks === true && hooks?.beforeBroadcast != null) {
      counts.signaturesReported++;
      await hooks.beforeBroadcast({ signature: FAKE_SIG, lastValidBlockHeight: 1 });
    }
  };
  const adapter = {
    ...(opts.honorsBroadcastHooks === true ? { honorsBroadcastHooks: true } : {}),
    ...(opts.usdcMint !== undefined ? { usdcMint: opts.usdcMint } : {}),
    ownAddress: "FaKeSo1anaAddr1111111111111111111111111111",
    getUsdcBalance: async () => 100_000_000n,
    getUsdcBalanceOf: async () => 0n,
    getSolBalance: async () => {
      counts.getSolBalance++;
      return 10_000_000n;
    },
    sendUsdc: async (_args: unknown, hooks: Hooks) => {
      counts.sendUsdc++;
      await report(hooks);
      return { signature: FAKE_SIG, slot: 1, confirmed: true };
    },
    sendUsdcBatch: async (legs: readonly unknown[], hooks: Hooks) => {
      counts.sendUsdcBatch++;
      await report(hooks);
      return legs.map(() => ({ ok: true, signature: FAKE_SIG, slot: 1, reason: null }));
    },
    getTransaction: async () => ({ status: "not_found" }),
    getSignatureOutcome: async () => ({ status: "rpc_error", reason: "test adapter" }),
    isReachable: async () => true,
  } as unknown as SolanaRpcAdapter;
  const sends = (): number => counts.sendUsdc + counts.sendUsdcBatch;
  return { adapter, counts, sends };
}

/** The runtime surface this file drives (structural; the class lives in @motebit/runtime). */
type MoneyRuntime = {
  executeGrantedDelegation: (params: {
    capability: string;
    prompt: string;
    delegation: { token: unknown; grant: unknown };
    dryRun?: boolean;
  }) => Promise<{ ok: boolean; code?: string }>;
  executeToolGated: (
    name: string,
    args: Record<string, unknown>,
    options: { caller: { principal: "owner" }; delegation?: { token: unknown; grant: unknown } },
  ) => Promise<{ ok: boolean; error?: string }>;
  enableInvokeCapability: (config: {
    syncUrl: string;
    authToken: () => Promise<string>;
    relayPublicKey: string;
    acknowledgeNoHistoryRisk: boolean;
  }) => void;
  invokeCapability: (
    capability: string,
    prompt: string,
  ) => AsyncGenerator<{ type: string; code?: string }>;
  sendUsdc: (to: string, micro: bigint) => Promise<unknown>;
  outstandingPaidResults: () => unknown[];
  stop: () => void;
};

interface Booted {
  runtime: MoneyRuntime;
  spend: MoleculeSpendHandle;
  identity: BootstrapAndEmitIdentityResult;
  config: MoleculeConfig;
  log: string[];
  /** Every row of the grant-spend store and the paid-intent ledger, as text. */
  durableState: () => string;
  relay: ReturnType<typeof stubRelay>;
}

const cleanups: Array<() => void> = [];
const SWEEP_ENV = [
  "MOTEBIT_SWEEP_ADDRESS",
  "MOTEBIT_SOLANA_RPC_URL",
  "MOTEBIT_SOLANA_USDC_MINT",
  "MOTEBIT_SWEEP_MIN_MICRO",
  "MOTEBIT_SWEEP_INTERVAL_MS",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of SWEEP_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  for (const k of SWEEP_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function realIdentity(): Promise<BootstrapAndEmitIdentityResult> {
  const kp = await generateKeypair();
  return {
    motebitId: "mot_money_refused",
    deviceId: "dev_money_refused",
    publicKeyHex: bytesToHex(kp.publicKey),
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    identityContent: "# motebit.md\n",
    identityPath: "/data/motebit.md",
    isFirstLaunch: true,
  };
}

function moneyConfig(dir: string, usdcMint?: string): MoleculeConfig {
  return {
    dataDir: dir,
    dbPath: join(dir, "motebit.db"),
    port: 9999,
    serviceName: "motebit-money-refused-test",
    displayName: "Money Refused Test",
    serviceDescription: "Spend containment",
    capabilities: ["research"],
    syncUrl: RELAY_URL,
    moneyExecution: {
      solanaRpcUrl: SOLANA_RPC,
      relayPublicKeyHex: SIGNING_PINNED_HEX,
      ...(usdcMint !== undefined ? { usdcMint } : {}),
      spendCeiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 1_000_000 },
    },
  };
}

/**
 * Boot the REAL runner over a real SQLite database. `moneyRail` is handed to
 * the real `defaultCreateMoneyRuntime` (its `walletOverride` seam); absent ⇒
 * the runner builds its own rail (a real web3 adapter, never reached).
 */
async function boot(opts: {
  moneyRail?: SolanaWalletRail;
  usdcMint?: string;
  createSweepWallet?: MoleculeRunnerAdapters["createSweepWallet"];
}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "motebit-money-refused-"));
  const relay = stubRelay();
  const identity = await realIdentity();
  const config = moneyConfig(dir, opts.usdcMint);
  const log: string[] = [];
  let db: MotebitDatabase | null = null;
  let runtime: MoneyRuntime | null = null;
  let spend: MoleculeSpendHandle | undefined;
  cleanups.push(() => {
    runtime?.stop();
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const adapters: MoleculeRunnerAdapters = {
    bootstrapIdentity: async () => identity,
    openDatabase: async (path) => {
      db = await openMotebitDatabase(path);
      return db;
    },
    startServer: (async () => ({ stop: async () => {} }) as unknown as ServiceHandle) as never,
    embedText: null,
    log: (msg) => log.push(msg),
    ...(opts.createSweepWallet != null ? { createSweepWallet: opts.createSweepWallet } : {}),
  };
  if (opts.moneyRail != null) {
    const rail = opts.moneyRail;
    adapters.createMoneyRuntime = (i, storage, tools, policy, cfg, grantSpendStore) => {
      const built = defaultCreateMoneyRuntime(
        i,
        { ...storage, paidIntentStore: db!.paidIntentStore } as never,
        tools,
        policy,
        cfg,
        grantSpendStore,
        rail,
      );
      runtime = built as unknown as MoneyRuntime;
      return built;
    };
  }

  await runMolecule(
    config,
    (_identity, spendHandle) => {
      spend = spendHandle;
      return { toolRegistry: new InMemoryToolRegistry() };
    },
    adapters,
  );
  if (spend == null) throw new Error("the runner handed the builder no spend handle");

  const durableState = (): string => {
    const rows = (sql: string): unknown[] => db!.db.prepare(sql).all() as unknown[];
    return JSON.stringify(
      {
        grant_spend_state: rows("SELECT * FROM grant_spend_state ORDER BY grant_id"),
        paid_intent_ledger: rows("SELECT * FROM paid_intent_ledger ORDER BY task_id"),
      },
      (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    );
  };
  relay.reset();
  return {
    runtime: runtime as unknown as MoneyRuntime,
    spend,
    identity,
    config,
    log,
    durableState,
    relay,
  };
}

async function bootWithFakeRail(mint: string | undefined, hooks: HookShape) {
  const fake = countingAdapter({ usdcMint: mint, honorsBroadcastHooks: hooks });
  const rail = new SolanaWalletRail(fake.adapter, { spendableMints: MOLECULE_SPENDABLE_MINTS });
  const booted = await boot({ moneyRail: rail });
  return { ...booted, ...fake, rail };
}

const EMPTY_DURABLE_STATE = JSON.stringify({ grant_spend_state: [], paid_intent_ledger: [] });

/** Nothing was sent, nothing was signed, nothing was written. */
function expectNothingMoved(h: Awaited<ReturnType<typeof bootWithFakeRail>>): void {
  expect(h.sends()).toBe(0);
  expect(h.counts.signaturesReported).toBe(0);
  expect(h.counts.getSolBalance).toBe(0);
  expect(h.durableState()).toBe(EMPTY_DURABLE_STATE);
  expect(h.runtime.outstandingPaidResults()).toEqual([]);
}

describe("the allowlist constant", () => {
  it("MOLECULE_SPENDABLE_MINTS is exactly [devnet USDC], frozen", () => {
    expect(MOLECULE_SPENDABLE_MINTS).toEqual([USDC_MINT_DEVNET]);
    expect(MOLECULE_SPENDABLE_MINTS).toEqual(["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"]);
    expect(MOLECULE_SPENDABLE_MINTS).not.toContain(USDC_MINT_MAINNET);
    expect(Object.isFrozen(MOLECULE_SPENDABLE_MINTS)).toBe(true);
  });
});

const HOOK_SHAPES: Array<{ shape: string; hooks: HookShape }> = [
  { shape: "hooks honoured", hooks: true },
  { shape: "hooks absent", hooks: undefined },
];

// Plain loops (not describe.each): each test's full name is then exact text a
// tamper entry can name.
for (const { shape, hooks } of HOOK_SHAPES)
  describe(`a molecule over a MAINNET-mint rail moves nothing (${shape})`, () => {
    it("spend handle, live: rail_spend_refused before discovery", async () => {
      const h = await bootWithFakeRail(USDC_MINT_MAINNET, hooks);
      const result = await h.spend.spend({ capability: "research", prompt: "live" });
      expect(result).toEqual({ ok: false, code: "rail_spend_refused" });
      expect(h.relay.calls()).toEqual([]); // refused before the relay was asked
      expectNothingMoved(h);
    });

    it("spend handle, dry run: quotes, and still sends and writes nothing", async () => {
      const h = await bootWithFakeRail(USDC_MINT_MAINNET, hooks);
      const result = await h.spend.spend({ capability: "research", prompt: "quote", dryRun: true });
      expect(result).toMatchObject({ ok: true, dryRun: true });
      expectNothingMoved(h);
    });

    it("executeGrantedDelegation: rail_spend_refused before discovery", async () => {
      const h = await bootWithFakeRail(USDC_MINT_MAINNET, hooks);
      const grant = await selfIssueGrant(h.identity, h.config.moneyExecution!);
      const token = await mintTick(grant, h.identity);
      const result = await h.runtime.executeGrantedDelegation({
        capability: "research",
        prompt: "granted",
        delegation: { token, grant },
      });
      expect(result).toEqual({ ok: false, code: "rail_spend_refused" });
      expect(h.relay.calls()).toEqual([]);
      expectNothingMoved(h);
    });

    it("delegate_to_agent through executeToolGated: refused before the meter is charged", async () => {
      const h = await bootWithFakeRail(USDC_MINT_MAINNET, hooks);
      const grant = await selfIssueGrant(h.identity, h.config.moneyExecution!);
      const token = await mintTick(grant, h.identity);
      const result = await h.runtime.executeToolGated(
        "delegate_to_agent",
        { prompt: "tool", required_capabilities: ["research"] },
        { caller: { principal: "owner" }, delegation: { token, grant } },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("rail_spend_refused");
      // This path reaches the payment builder (the relay quoted the hire)...
      expect(h.relay.calls().some((u) => u.includes("/api/v1/agents/discover"))).toBe(true);
      // ...and the builder refuses before the grant's meter commits anything.
      expectNothingMoved(h);
    });

    it("invokeCapability: rail_spend_refused, nothing recorded as unconfirmed", async () => {
      const h = await bootWithFakeRail(USDC_MINT_MAINNET, hooks);
      h.runtime.enableInvokeCapability({
        syncUrl: RELAY_URL,
        authToken: async () => "test-token",
        relayPublicKey: SIGNING_PINNED_HEX,
        acknowledgeNoHistoryRisk: true,
      });
      const chunks: Array<{ type: string; code?: string }> = [];
      for await (const chunk of h.runtime.invokeCapability("research", "tap")) chunks.push(chunk);
      const errors = chunks.filter((c) => c.type === "invoke_error");
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("rail_spend_refused");
      expect(h.relay.calls().some((u) => u.includes("/api/v1/agents/discover"))).toBe(true);
      expectNothingMoved(h);
    });

    it("runtime sendUsdc: throws rail_spend_refused", async () => {
      const h = await bootWithFakeRail(USDC_MINT_MAINNET, hooks);
      await expect(h.runtime.sendUsdc(WORKER_ADDRESS, 1_000n)).rejects.toMatchObject({
        name: "RailSpendRefusedError",
        code: "rail_spend_refused",
      });
      expectNothingMoved(h);
    });

    it("the earnings sweep: never started, and the rail refuses a sweep called directly", async () => {
      process.env.MOTEBIT_SWEEP_ADDRESS = SWEEP_DEST;
      process.env.MOTEBIT_SOLANA_RPC_URL = SOLANA_RPC;
      process.env.MOTEBIT_SWEEP_MIN_MICRO = "1";
      process.env.MOTEBIT_SWEEP_INTERVAL_MS = "5";
      const sweep = countingAdapter({ usdcMint: USDC_MINT_MAINNET, honorsBroadcastHooks: hooks });
      const sweepRail = new SolanaWalletRail(sweep.adapter, {
        spendableMints: MOLECULE_SPENDABLE_MINTS,
      });
      const isAvailable = vi.spyOn(sweepRail, "isAvailable");
      const h = await boot({ createSweepWallet: () => sweepRail });

      expect(h.log.some((l) => l.includes("Sweep NOT started") && l.includes(SWEEP_DEST))).toBe(
        true,
      );
      expect(h.log.some((l) => l.startsWith("Sweep enabled"))).toBe(false);
      // No timer was scheduled: several intervals later nothing has been read.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(isAvailable).toHaveBeenCalledTimes(0);

      // The primitive itself, pointed at the same rail: the transfer is refused.
      await expect(sweepWalletRail(sweepRail, SWEEP_DEST, 1n)).rejects.toMatchObject({
        code: "rail_spend_refused",
      });
      expect(sweep.sends()).toBe(0);
      expect(sweep.counts.signaturesReported).toBe(0);
      expect(sweep.counts.getSolBalance).toBe(0);
    });
  });

describe("controls", () => {
  it("devnet mint: one live spend reaches the adapter", async () => {
    const h = await bootWithFakeRail(USDC_MINT_DEVNET, true);
    const result = await h.spend.spend({ capability: "research", prompt: "live on devnet" });
    // The payment leg ran; the stubbed relay then refused the task outright.
    expect(h.counts.sendUsdcBatch).toBe(1);
    expect(h.counts.signaturesReported).toBe(1);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.code).not.toBe("rail_spend_refused");
    expect(h.durableState()).not.toBe(EMPTY_DURABLE_STATE); // the meter charged the grant
  });

  it("devnet mint: the sweep runs and sends the balance", async () => {
    process.env.MOTEBIT_SWEEP_ADDRESS = SWEEP_DEST;
    process.env.MOTEBIT_SOLANA_RPC_URL = SOLANA_RPC;
    process.env.MOTEBIT_SWEEP_MIN_MICRO = "1";
    const sweep = countingAdapter({ usdcMint: USDC_MINT_DEVNET, honorsBroadcastHooks: true });
    const sweepRail = new SolanaWalletRail(sweep.adapter, {
      spendableMints: MOLECULE_SPENDABLE_MINTS,
    });
    const h = await boot({ createSweepWallet: () => sweepRail });
    await vi.waitFor(() => expect(sweep.counts.sendUsdc).toBe(1));
    expect(h.log.some((l) => l.startsWith("Sweep enabled"))).toBe(true);
    expect(
      h.log.some((l) => l.includes("earnings-sweep rail") && l.includes("spend allowed")),
    ).toBe(true);
  });

  it("an adapter that reports NO mint is refused under the allowlist", async () => {
    const h = await bootWithFakeRail(undefined, true);
    expect(h.rail.spendRefused).toBe(true);
    const result = await h.spend.spend({ capability: "research", prompt: "no mint" });
    expect(result).toEqual({ ok: false, code: "rail_spend_refused" });
    await expect(h.runtime.sendUsdc(WORKER_ADDRESS, 1_000n)).rejects.toMatchObject({
      code: "rail_spend_refused",
    });
    expectNothingMoved(h);
  });
});

describe("the runner's own rails (no override): env and config cannot widen them", () => {
  it("default money rail on the mainnet default mint: logged as refused, and a live spend is refused", async () => {
    const h = await boot({});
    const line = h.log.find((l) => l.startsWith("Spend containment (money-execution rail)"));
    expect(line).toBeDefined();
    expect(line).toContain("spend REFUSED (rail_spend_refused)");
    expect(line).toContain(`mint=${USDC_MINT_MAINNET}`);
    expect(line).toContain(JSON.stringify([USDC_MINT_DEVNET]));
    const result = await h.spend.spend({ capability: "research", prompt: "live" });
    expect(result).toEqual({ ok: false, code: "rail_spend_refused" });
    expect(h.relay.calls()).toEqual([]); // no relay call, no RPC call
    expect(h.durableState()).toBe(EMPTY_DURABLE_STATE);
  });

  it("default money rail on the devnet mint: logged as allowed, with the PARSED mint", async () => {
    const h = await boot({ usdcMint: USDC_MINT_DEVNET });
    const line = h.log.find((l) => l.startsWith("Spend containment (money-execution rail)"));
    expect(line).toContain("spend allowed");
    expect(line).toContain(`mint=${USDC_MINT_DEVNET}`);
  });

  it("default sweep rail on the mainnet default mint: never started, nothing read from the RPC", async () => {
    process.env.MOTEBIT_SWEEP_ADDRESS = SWEEP_DEST;
    process.env.MOTEBIT_SOLANA_RPC_URL = SOLANA_RPC;
    const h = await boot({});
    const line = h.log.find((l) => l.startsWith("Spend containment (earnings-sweep rail)"));
    expect(line).toContain("spend REFUSED (rail_spend_refused)");
    expect(line).toContain(`mint=${USDC_MINT_MAINNET}`);
    expect(h.log.some((l) => l.includes("Sweep NOT started"))).toBe(true);
    expect(h.relay.calls()).toEqual([]);
  });

  it("createMoleculeWalletRail always carries exactly the constant, whatever mint it is given", () => {
    for (const usdcMint of [undefined, USDC_MINT_DEVNET, USDC_MINT_MAINNET]) {
      const rail = createMoleculeWalletRail({
        rpcUrl: SOLANA_RPC,
        identitySeed: new Uint8Array(32).fill(5),
        ...(usdcMint !== undefined ? { usdcMint } : {}),
      });
      expect(rail.spendableMints).toEqual([USDC_MINT_DEVNET]);
      expect(rail.spendRefused).toBe(usdcMint !== USDC_MINT_DEVNET);
    }
  });
});

describe("the runner refuses to start with a rail lacking the exact allowlist", () => {
  const cases: Array<{ name: string; spendableMints: readonly string[] | undefined }> = [
    { name: "no allowlist", spendableMints: undefined },
    { name: "a wider allowlist", spendableMints: [USDC_MINT_DEVNET, USDC_MINT_MAINNET] },
    { name: "a different allowlist", spendableMints: [USDC_MINT_MAINNET] },
    { name: "an empty allowlist", spendableMints: [] },
  ];

  function railWith(spendableMints: readonly string[] | undefined): SolanaWalletRail {
    const { adapter } = countingAdapter({
      usdcMint: USDC_MINT_DEVNET,
      honorsBroadcastHooks: true,
    });
    return new SolanaWalletRail(
      adapter,
      spendableMints !== undefined ? { spendableMints } : undefined,
    );
  }

  for (const { name, spendableMints } of cases) {
    it(`money-execution rail override with ${name}`, async () => {
      await expect(boot({ moneyRail: railWith(spendableMints) })).rejects.toThrow(
        /refusing to start: the money-execution rail's spendable-mint allowlist/,
      );
    });

    it(`earnings-sweep rail override with ${name}`, async () => {
      process.env.MOTEBIT_SWEEP_ADDRESS = SWEEP_DEST;
      process.env.MOTEBIT_SOLANA_RPC_URL = SOLANA_RPC;
      await expect(boot({ createSweepWallet: () => railWith(spendableMints) })).rejects.toThrow(
        /refusing to start: the earnings-sweep rail's spendable-mint allowlist/,
      );
    });
  }

  it("a bare sweep wallet (no allowlist property at all) is refused", async () => {
    process.env.MOTEBIT_SWEEP_ADDRESS = SWEEP_DEST;
    process.env.MOTEBIT_SOLANA_RPC_URL = SOLANA_RPC;
    const send = vi.fn();
    const bare = { isAvailable: async () => true, getBalance: async () => 5n, send };
    await expect(boot({ createSweepWallet: () => bare })).rejects.toThrow(/allowlist is absent/);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("assertMoleculeRailContained accepts only the exact constant, and names the remedy", () => {
    expect(() => assertMoleculeRailContained(railWith([USDC_MINT_DEVNET]), "x")).not.toThrow();
    expect(() => assertMoleculeRailContained(null, "x")).toThrow(/allowlist is absent/);
    expect(() => assertMoleculeRailContained({ spendableMints: "devnet" }, "x")).toThrow(
      /refusing to start/,
    );
    expect(() => assertMoleculeRailContained(railWith(undefined), "x")).toThrow(
      /createMoleculeWalletRail/,
    );
  });

  it("describeRailSpendPosture reports posture and mint, and 'not reported' without one", () => {
    expect(describeRailSpendPosture(railWith([USDC_MINT_DEVNET]))).toContain(
      `spend allowed; mint=${USDC_MINT_DEVNET}`,
    );
    expect(describeRailSpendPosture({})).toContain("mint=not reported");
  });
});
