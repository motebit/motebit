/**
 * #954 on the DEPLOYED artifact: `node dist/server.js` (the run.sh exec
 * line).
 *
 *   - Pointed at a devnet RPC it resolves the devnet network and stamps it on
 *     Solana reconciliation — never the mainnet label the old default put on
 *     every relay.
 *   - Pointed at an RPC whose getGenesisHash HANGS it still listens within
 *     the normal boot window (the Fly health grace): the network is never a
 *     boot gate.
 *
 * The in-process twin (`solana-network-954.test.ts`) covers every cluster,
 * the SOLANA_NETWORK mismatch, the outage-then-recovery and the timeout;
 * this suite proves the composed entry carries the same wiring
 * (composition-preserves-enforcement).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_CAIP2,
} from "@motebit/wallet-solana";
import {
  BOOT_TIMEOUT_MS,
  DIST_TIER,
  bootRealEntry,
  killBootedEntry,
  startFakeSolanaRpc,
  type BootedEntry,
  type FakeSolanaRpc,
} from "./booted-entry-harness.js";

function logLine(log: string, msg: string): Record<string, unknown> | undefined {
  for (const line of log.split("\n")) {
    if (!line.includes(`"msg":"${msg}"`)) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // partial line
    }
  }
  return undefined;
}

async function waitForLog(booted: BootedEntry, msg: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (logLine(booted.log(), msg)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${msg} never logged:\n${booted.log()}`);
}

describe("booted relay on a devnet RPC labels its Solana records devnet (#954)", () => {
  let rpc: FakeSolanaRpc | null = null;
  let booted: BootedEntry | null = null;

  beforeAll(async () => {
    rpc = await startFakeSolanaRpc({ genesisHash: SOLANA_DEVNET_GENESIS_HASH });
    booted = await bootRealEntry(DIST_TIER, {
      SOLANA_RPC_URL: rpc.url,
      MOTEBIT_SOLANA_TREASURY_RECONCILIATION_INTERVAL_MS: "200",
    });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    killBootedEntry(booted);
    await rpc?.close();
  });

  it("solana.network_resolved and every Solana reconciliation cycle carry the devnet id", async () => {
    await waitForLog(booted!, "solana_treasury.reconciliation.cycle");
    const log = booted!.log();
    expect(logLine(log, "solana.network_resolved")?.network).toBe(SOLANA_DEVNET_CAIP2);
    expect(logLine(log, "anchoring.solana_submitter_configured")).toBeDefined();
    expect(logLine(log, "solana_treasury.reconciliation.cycle")?.chain).toBe(SOLANA_DEVNET_CAIP2);
    expect(log).not.toContain(SOLANA_MAINNET_CAIP2);
  });
});

describe("booted relay whose RPC hangs on getGenesisHash still listens (#954 round 2)", () => {
  let rpc: FakeSolanaRpc | null = null;
  let booted: BootedEntry | null = null;

  beforeAll(async () => {
    rpc = await startFakeSolanaRpc({ genesisHang: true });
    booted = await bootRealEntry(DIST_TIER, { SOLANA_RPC_URL: rpc.url });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    killBootedEntry(booted);
    await rpc?.close();
  });

  it("listens BEFORE the hung genesis read times out — the read is never on the boot path", async () => {
    // Order, not wall-clock: the warm-up read times out (5s) and logs
    // `solana.network_unresolved`. A boot that awaited the read would log that
    // line first and `relay.listening` after it (round-3 review: a 58s
    // wall-clock bound stayed green under a 5s boot gate).
    await waitForLog(booted!, "solana.network_unresolved");
    const lines = booted!.log().split("\n");
    const listening = lines.findIndex((l) => l.includes('"msg":"relay.listening"'));
    const unresolved = lines.findIndex((l) => l.includes('"msg":"solana.network_unresolved"'));
    expect(listening).toBeGreaterThanOrEqual(0);
    expect(unresolved).toBeGreaterThanOrEqual(0);
    expect(listening, "relay.listening must precede the genesis timeout").toBeLessThan(unresolved);
    expect(logLine(booted!.log(), "solana.network_unresolved")?.reason).toMatch(/timed out/);

    expect(rpc!.callsOf("getGenesisHash")).toBeGreaterThanOrEqual(1);
    expect(logLine(booted!.log(), "solana.network_resolved")).toBeUndefined();
    expect(rpc!.callsOf("sendTransaction")).toBe(0);
  });
});
