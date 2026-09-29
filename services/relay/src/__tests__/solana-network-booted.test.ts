/**
 * #954 on the DEPLOYED artifact: `node dist/server.js` (the run.sh exec
 * line) pointed at a devnet RPC logs a devnet network on anchoring and on
 * Solana treasury reconciliation — never the mainnet label the old default
 * stamped on every relay.
 *
 * The in-process twin (`solana-network-954.test.ts`) covers every cluster,
 * the SOLANA_NETWORK mismatch and the failed-read paths; this suite proves
 * the composed entry carries the same wiring (composition-preserves-
 * enforcement: a guarantee defined in one place must still hold where it is
 * activated).
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

describe("booted relay on a devnet RPC labels its Solana records devnet (#954)", () => {
  let rpc: FakeSolanaRpc | null = null;
  let booted: BootedEntry | null = null;

  beforeAll(async () => {
    rpc = await startFakeSolanaRpc({ genesisHash: SOLANA_DEVNET_GENESIS_HASH });
    booted = await bootRealEntry(DIST_TIER, { SOLANA_RPC_URL: rpc.url });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    killBootedEntry(booted);
    await rpc?.close();
  });

  it("anchoring.solana_submitter_configured and solana-treasury-reconciliation.started carry the devnet id", () => {
    const log = booted!.log();
    expect(logLine(log, "solana.network_resolved")?.network).toBe(SOLANA_DEVNET_CAIP2);
    expect(logLine(log, "anchoring.solana_submitter_configured")?.network).toBe(
      SOLANA_DEVNET_CAIP2,
    );
    expect(logLine(log, "solana-treasury-reconciliation.started")?.chain).toBe(SOLANA_DEVNET_CAIP2);
    expect(log).not.toContain(SOLANA_MAINNET_CAIP2);
  });
});
