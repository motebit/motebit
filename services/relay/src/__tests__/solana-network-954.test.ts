/**
 * #954 — the relay's Solana network is the cluster its RPC serves, never a
 * default, and never a boot gate.
 *
 * Boots the in-process relay against a real HTTP fake Solana RPC and reads
 * what it logs, serves and records. The consumers of the network:
 *
 *   - the memo submitter — the `network` on settlement / agent-settlement /
 *     credential / identity-log anchor rows; revocation and transparency
 *     anchors write through the same submitter (a write happens only once the
 *     network resolves)
 *   - the Solana treasury reconciliation loop — `chain` on every row
 *   - P2P admission — the payer is read only once the network resolves
 *   - the admin reconciliation overview and `/admin/health`
 *
 * Round 2 (cold review of 6e79dfbdd): resolution is LAZY and SUPERVISED. A
 * transient outage at boot heals without a restart; a hanging genesis read
 * never delays `createSyncRelay`; an unresolved or mismatched network is on
 * `/admin/health`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_CAIP2,
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_TESTNET_CAIP2,
  SOLANA_TESTNET_GENESIS_HASH,
} from "@motebit/wallet-solana";
import { createSyncRelay, type SyncRelay } from "../index.js";
import {
  startFakeSolanaRpc,
  type FakeSolanaRpc,
  type FakeSolanaRpcOptions,
} from "./booted-entry-harness.js";
import { TEST_RELAY_NETWORK } from "./test-helpers.js";

const API_TOKEN = "test-admin-token-954";

interface LogLine {
  level: string;
  msg: string;
  [k: string]: unknown;
}

let rpc: FakeSolanaRpc | null = null;
let relay: SyncRelay | null = null;
let captured: string[] = [];
let restoreWrites: (() => void) | null = null;
const savedEnv: Record<string, string | undefined> = {};

function captureLogs(): void {
  captured = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    captured.push(String(chunk));
    return (out as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    captured.push(String(chunk));
    return (err as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  restoreWrites = () => {
    process.stdout.write = out;
    process.stderr.write = err;
  };
}

function logs(): LogLine[] {
  const lines: LogLine[] = [];
  for (const chunk of captured) {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        lines.push(JSON.parse(line) as LogLine);
      } catch {
        // not a relay log line
      }
    }
  }
  return lines;
}

function logOf(msg: string): LogLine | undefined {
  return logs().find((l) => l.msg === msg);
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

interface BootOpts extends FakeSolanaRpcOptions {
  declared?: string;
  timeoutMs?: number;
  /** Fast loops: network re-read, reconciliation, transparency anchor. */
  fast?: boolean;
}

async function boot(opts: BootOpts): Promise<{ relay: SyncRelay; bootMs: number }> {
  rpc = await startFakeSolanaRpc(opts);
  process.env.SOLANA_RPC_URL = rpc.url;
  if (opts.declared !== undefined) process.env.SOLANA_NETWORK = opts.declared;
  else delete process.env.SOLANA_NETWORK;
  if (opts.fast) process.env.MOTEBIT_SOLANA_TREASURY_RECONCILIATION_INTERVAL_MS = "60";
  else delete process.env.MOTEBIT_SOLANA_TREASURY_RECONCILIATION_INTERVAL_MS;
  captureLogs();
  const started = Date.now();
  relay = await createSyncRelay({
    ...TEST_RELAY_NETWORK,
    allowPrivateEndpoints: true,
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    x402: {
      payToAddress: "0xee51c5a65c6Fa81c9CC85505884290e90C09D285",
      network: "eip155:8453",
      testnet: true,
    },
    ...(opts.fast ? { solanaNetworkCheckIntervalMs: 40, transparencyAnchorIntervalMs: 60 } : {}),
    ...(opts.timeoutMs !== undefined ? { solanaNetworkTimeoutMs: opts.timeoutMs } : {}),
  });
  return { relay, bootMs: Date.now() - started };
}

async function adminGet<T>(r: SyncRelay, path: string): Promise<T> {
  const res = await r.app.request(path, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function solanaChains(
  r: SyncRelay,
): Promise<Array<{ chain: string; loop_enabled: boolean }>> {
  const body = await adminGet<{ chains: Array<{ chain: string; loop_enabled: boolean }> }>(
    r,
    "/api/v1/admin/treasury-reconciliation",
  );
  return body.chains.filter((c) => c.chain.startsWith("solana:"));
}

interface Health {
  solana_network: { status: string; network: string | null; reason: string | null };
  loops: Array<{ name: string; status: string; last_error: string | null }>;
}

function solanaRows(r: SyncRelay): string[] {
  return (
    r.moteDb.db
      .prepare("SELECT chain FROM relay_treasury_reconciliations WHERE chain LIKE 'solana:%'")
      .all() as Array<{ chain: string }>
  ).map((row) => row.chain);
}

beforeEach(() => {
  for (const k of [
    "SOLANA_RPC_URL",
    "SOLANA_NETWORK",
    "SOLANA_USDC_MINT",
    "MOTEBIT_SOLANA_TREASURY_RECONCILIATION_INTERVAL_MS",
  ]) {
    savedEnv[k] = process.env[k];
  }
  delete process.env.SOLANA_USDC_MINT;
});

afterEach(async () => {
  restoreWrites?.();
  restoreWrites = null;
  if (relay) await relay.close();
  relay = null;
  if (rpc) await rpc.close();
  rpc = null;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("#954 — every Solana chain id the relay records is read from its RPC", () => {
  for (const [name, genesis, caip2] of [
    ["mainnet", SOLANA_MAINNET_GENESIS_HASH, SOLANA_MAINNET_CAIP2],
    ["devnet", SOLANA_DEVNET_GENESIS_HASH, SOLANA_DEVNET_CAIP2],
    ["testnet", SOLANA_TESTNET_GENESIS_HASH, SOLANA_TESTNET_CAIP2],
  ] as const) {
    it(`a ${name} RPC labels every consumer ${caip2}`, async () => {
      const { relay: r } = await boot({ genesisHash: genesis, fast: true });

      await waitFor(() => solanaRows(r).length > 0);
      expect(logOf("solana.network_resolved")?.network).toBe(caip2);
      // Reconciliation stamps the RPC's cluster on every row.
      expect(new Set(solanaRows(r))).toEqual(new Set([caip2]));
      // The anchor stream writes only after the network resolved.
      await waitFor(() => rpc!.callsOf("sendTransaction") > 0);
      expect(rpc!.writesBeforeGenesis()).toBe(0);
      // The overview claims exactly this chain, live; health names it.
      expect(await solanaChains(r)).toEqual([
        expect.objectContaining({ chain: caip2, loop_enabled: true }),
      ]);
      const health = await adminGet<Health>(r, "/api/v1/admin/health");
      expect(health.solana_network).toMatchObject({ status: "resolved", network: caip2 });
    });
  }

  it("a devnet RPC never produces a mainnet label anywhere", async () => {
    const { relay: r } = await boot({ genesisHash: SOLANA_DEVNET_GENESIS_HASH, fast: true });
    await waitFor(() => solanaRows(r).length > 0);
    expect(captured.join("")).not.toContain(SOLANA_MAINNET_CAIP2);
  });

  it("an explicit SOLANA_NETWORK the RPC agrees with resolves normally", async () => {
    const { relay: r } = await boot({
      genesisHash: SOLANA_DEVNET_GENESIS_HASH,
      declared: SOLANA_DEVNET_CAIP2,
      fast: true,
    });
    await waitFor(() => solanaRows(r).length > 0);
    expect(logOf("solana.network_resolved")?.declared).toBe(SOLANA_DEVNET_CAIP2);
  });

  it("an explicit SOLANA_NETWORK the RPC contradicts: nothing is written or recorded, and health says why", async () => {
    const { relay: r } = await boot({
      genesisHash: SOLANA_DEVNET_GENESIS_HASH,
      declared: SOLANA_MAINNET_CAIP2,
      fast: true,
    });
    await waitFor(() => logOf("solana.network_mismatch") !== undefined);
    // Several reconciliation + anchor ticks pass.
    await new Promise((res) => setTimeout(res, 400));

    const mismatch = logOf("solana.network_mismatch");
    expect(mismatch?.level).toBe("error");
    expect(mismatch?.declared).toBe(SOLANA_MAINNET_CAIP2);
    expect(mismatch?.network).toBe(SOLANA_DEVNET_CAIP2);
    expect(rpc!.callsOf("sendTransaction"), "no anchor is ever written").toBe(0);
    expect(solanaRows(r), "no reconciliation row is recorded").toEqual([]);
    expect(logOf("solana-treasury-reconciliation.cycle_skipped")?.level).toBe("warn");
    expect(await solanaChains(r)).toEqual([]);
    expect(rpc!.callsOf("getGenesisHash"), "a mismatch is permanent: read once").toBe(1);

    const health = await adminGet<Health>(r, "/api/v1/admin/health");
    expect(health.solana_network).toMatchObject({
      status: "mismatch",
      network: SOLANA_DEVNET_CAIP2,
    });
    const loop = health.loops.find((l) => l.name === "solana-network");
    expect(loop?.status).toBe("erroring");
    expect(loop?.last_error).toMatch(/mismatch/);
  });
});

describe("#954 round 2 — resolution is lazy and supervised, never a boot gate", () => {
  it("4× 503 on getGenesisHash, then OK: anchoring and reconciliation work once the RPC recovers — no restart", async () => {
    const { relay: r } = await boot({
      genesisHash: SOLANA_DEVNET_GENESIS_HASH,
      genesisFailures: 4,
      fast: true,
    });

    // The outage is seen, logged, and on health while it lasts.
    await waitFor(() => logOf("solana.network_unresolved") !== undefined);

    // …and heals by itself.
    await waitFor(() => solanaRows(r).length > 0);
    await waitFor(() => rpc!.callsOf("sendTransaction") > 0);

    expect(rpc!.callsOf("getGenesisHash")).toBeGreaterThanOrEqual(5);
    expect(new Set(solanaRows(r))).toEqual(new Set([SOLANA_DEVNET_CAIP2]));
    expect(rpc!.writesBeforeGenesis(), "no anchor written while the network was unknown").toBe(0);
    const health = await adminGet<Health>(r, "/api/v1/admin/health");
    expect(health.solana_network).toMatchObject({
      status: "resolved",
      network: SOLANA_DEVNET_CAIP2,
    });
    expect(await solanaChains(r)).toEqual([
      expect.objectContaining({ chain: SOLANA_DEVNET_CAIP2, loop_enabled: true }),
    ]);
  });

  it("a genesis read that HANGS never delays boot, and anchoring refuses to write meanwhile", async () => {
    const { relay: r, bootMs } = await boot({ genesisHang: true, fast: true });
    // The default read timeout is 5s; boot must not wait on it at all.
    expect(bootMs).toBeLessThan(3_000);

    await new Promise((res) => setTimeout(res, 400));
    expect(rpc!.callsOf("sendTransaction"), "no anchor while unresolved").toBe(0);
    expect(solanaRows(r)).toEqual([]);
    const health = await adminGet<Health>(r, "/api/v1/admin/health");
    expect(health.solana_network.status).not.toBe("resolved");
    expect(health.solana_network.network).toBeNull();
  });

  it("every genesis read is time-bounded: a hang becomes a visible `unavailable`, never a silent `pending`", async () => {
    const { relay: r } = await boot({ genesisHang: true, fast: true, timeoutMs: 150 });
    await waitFor(async () => {
      const h = await adminGet<Health>(r, "/api/v1/admin/health");
      return h.solana_network.status === "unavailable";
    }, 4_000);
    const health = await adminGet<Health>(r, "/api/v1/admin/health");
    expect(health.solana_network.reason).toMatch(/timed out after 150ms/);
    expect(health.solana_network.network).toBeNull();
    expect(rpc!.callsOf("sendTransaction")).toBe(0);
  });
});
