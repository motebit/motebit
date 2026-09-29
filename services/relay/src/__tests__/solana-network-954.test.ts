/**
 * #954 — the relay's Solana network is the cluster its RPC serves, never a
 * default.
 *
 * Boots the in-process relay against a real HTTP fake Solana RPC whose
 * `getGenesisHash` answers mainnet / devnet / testnet / an error, and reads
 * what the relay logs and serves. Every Solana CAIP-2 consumer the relay
 * wires at boot is checked:
 *
 *   - the memo submitter (`anchoring.solana_submitter_configured` — its
 *     `network` is what the settlement / agent-settlement / credential /
 *     identity-log anchor rows record; revocation + transparency anchors
 *     write through the same submitter)
 *   - the Solana treasury reconciliation loop (`chain` on every row)
 *   - the Path-0 operator transfer (logs the cluster it sends on)
 *   - the admin reconciliation overview (`chains[].chain`)
 *
 * The p2p verifier and bond verifier record no chain id; under a declared
 * SOLANA_NETWORK the RPC contradicts they refuse to start with the rest.
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
import { startFakeSolanaRpc, type FakeSolanaRpc } from "./booted-entry-harness.js";

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

async function boot(opts: { genesisHash: string | null; declared?: string }): Promise<SyncRelay> {
  rpc = await startFakeSolanaRpc({ genesisHash: opts.genesisHash });
  process.env.SOLANA_RPC_URL = rpc.url;
  if (opts.declared !== undefined) process.env.SOLANA_NETWORK = opts.declared;
  else delete process.env.SOLANA_NETWORK;
  captureLogs();
  relay = await createSyncRelay({
    allowPrivateEndpoints: true,
    apiToken: API_TOKEN,
    enableDeviceAuth: true,
    x402: {
      payToAddress: "0xee51c5a65c6Fa81c9CC85505884290e90C09D285",
      network: "eip155:8453",
      testnet: true,
    },
    // Read the genesis hash once — the retry backoff is covered in the
    // package's resolveSolanaNetwork tests.
    solanaNetworkRetryDelaysMs: [],
  });
  return relay;
}

async function solanaChains(
  r: SyncRelay,
): Promise<Array<{ chain: string; loop_enabled: boolean }>> {
  const res = await r.app.request("/api/v1/admin/treasury-reconciliation", {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { chains: Array<{ chain: string; loop_enabled: boolean }> };
  return body.chains.filter((c) => c.chain.startsWith("solana:"));
}

beforeEach(() => {
  for (const k of ["SOLANA_RPC_URL", "SOLANA_NETWORK", "SOLANA_USDC_MINT"]) {
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
      const r = await boot({ genesisHash: genesis });

      expect(logOf("solana.network_resolved")?.network).toBe(caip2);
      // Anchoring: all four streams write through this submitter.
      const anchoring = logOf("anchoring.solana_submitter_configured");
      expect(anchoring?.network).toBe(caip2);
      expect(anchoring?.streams).toEqual([
        "settlement",
        "credential",
        "revocation",
        "transparency",
      ]);
      // Reconciliation stamps this chain on every row.
      expect(logOf("solana-treasury-reconciliation.started")?.chain).toBe(caip2);
      // Path-0 transfer logs the cluster it sends on.
      expect(logOf("operator_solana_transfer.configured")?.network).toBe(caip2);
      // The admin overview claims exactly this chain, live.
      expect(await solanaChains(r)).toEqual([
        expect.objectContaining({ chain: caip2, loop_enabled: true }),
      ]);
    });
  }

  it("a devnet RPC never produces a mainnet label anywhere in the boot log", async () => {
    await boot({ genesisHash: SOLANA_DEVNET_GENESIS_HASH });
    expect(logOf("anchoring.solana_submitter_configured")?.network).toBe(SOLANA_DEVNET_CAIP2);
    expect(captured.join("")).not.toContain(SOLANA_MAINNET_CAIP2);
  });

  it("an explicit SOLANA_NETWORK the RPC agrees with starts normally", async () => {
    await boot({ genesisHash: SOLANA_DEVNET_GENESIS_HASH, declared: SOLANA_DEVNET_CAIP2 });
    expect(logOf("solana.network_resolved")?.declared).toBe(SOLANA_DEVNET_CAIP2);
    expect(logOf("anchoring.solana_submitter_configured")?.network).toBe(SOLANA_DEVNET_CAIP2);
  });

  it("an explicit SOLANA_NETWORK the RPC contradicts refuses every Solana subsystem", async () => {
    const r = await boot({
      genesisHash: SOLANA_DEVNET_GENESIS_HASH,
      declared: SOLANA_MAINNET_CAIP2,
    });

    const mismatch = logOf("solana.network_mismatch");
    expect(mismatch?.level).toBe("error");
    expect(mismatch?.declared).toBe(SOLANA_MAINNET_CAIP2);
    expect(mismatch?.network).toBe(SOLANA_DEVNET_CAIP2);

    expect(logOf("anchoring.solana_submitter_configured")).toBeUndefined();
    expect(logOf("anchoring.solana_disabled")?.level).toBe("error");
    expect(logOf("solana-treasury-reconciliation.started")).toBeUndefined();
    expect(logOf("operator_solana_transfer.configured")).toBeUndefined();
    expect(logOf("p2p_verifier.started")).toBeUndefined();
    expect(logOf("bond_verifier.started")).toBeUndefined();
    expect(await solanaChains(r)).toEqual([]);
  });

  it("a failed genesis read never produces a mainnet label: nothing that labels a chain starts", async () => {
    const r = await boot({ genesisHash: null });

    expect(logOf("solana.network_unresolved")?.level).toBe("error");
    expect(logOf("anchoring.solana_disabled")?.level).toBe("error");
    expect(logOf("anchoring.solana_submitter_configured")).toBeUndefined();
    expect(logOf("solana-treasury-reconciliation.started")).toBeUndefined();
    expect(logOf("solana-treasury-reconciliation.disabled")?.level).toBe("error");
    expect(await solanaChains(r)).toEqual([]);
    // Not even a declared mainnet stands in for the read.
    expect(captured.join("")).not.toContain(SOLANA_MAINNET_CAIP2);
  });

  it("a failed genesis read with SOLANA_NETWORK declared still labels nothing", async () => {
    const r = await boot({ genesisHash: null, declared: SOLANA_MAINNET_CAIP2 });
    expect(logOf("solana.network_unresolved")).toBeDefined();
    expect(logOf("anchoring.solana_submitter_configured")).toBeUndefined();
    expect(logOf("solana-treasury-reconciliation.started")).toBeUndefined();
    expect(await solanaChains(r)).toEqual([]);
  });
});
