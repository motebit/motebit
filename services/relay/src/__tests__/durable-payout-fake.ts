/**
 * A fake `SolanaRpcAdapter` for relay route tests of Path 0 durable-nonce
 * payouts (#990). The released-agave harness
 * (`withdrawal-payout-agave-harness.test.ts`) runs the REAL adapter against
 * a faithful fake Connection; this fake is for route-level tests that only
 * need to say "the payout finalized ok / failed / is undecided" and "the
 * kill landed or not".
 *
 * The chain state is plain data the test mutates:
 *   - `lane`: what `prepareNonceLane` answers (a finalized payout or kill
 *     advances it, so the next payout is signed over a fresh value);
 *   - `final`: each signature's FINALIZED status (absent ⇒ `unknown`);
 *   - `sendOutcome`: what the next payout's bounded finality wait sees;
 *   - `killLands`: whether a broadcast kill finalizes at once.
 */

import { vi, type Mock } from "vitest";
import {
  OperatorSolanaTransfer,
  type DurableBroadcastHooks,
  type DurableNonceLane,
  type DurableTransactionRef,
  type FinalizedSignatureStatus,
  type NonceLaneState,
  type SendUsdcArgs,
  type SolanaRpcAdapter,
} from "@motebit/wallet-solana";

export interface FakeDurableChain {
  lane: NonceLaneState;
  final: Map<string, FinalizedSignatureStatus>;
  /** `throw_before`: the send throws before anything is recorded. */
  sendOutcome: "finalized_ok" | "finalized_err" | "unknown" | "throw_before";
  killLands: boolean;
  payouts: DurableTransactionRef[];
  kills: DurableTransactionRef[];
}

export function freshChain(overrides: Partial<FakeDurableChain> = {}): FakeDurableChain {
  return {
    lane: {
      status: "ready",
      account: "NonceAccount111111111111111111111111111111",
      nonceValue: "nonce-1",
    },
    final: new Map(),
    sendOutcome: "finalized_ok",
    killLands: true,
    payouts: [],
    kills: [],
    ...overrides,
  };
}

let seq = 0;
/** A base58-looking signature, unique per call. */
export function fakeSignature(tag: string): string {
  seq++;
  const body = `${tag}${seq}`.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "z");
  return (body + "z".repeat(88)).slice(0, 88);
}

function advanceLane(chain: FakeDurableChain): void {
  if (chain.lane.status === "ready") {
    chain.lane = { ...chain.lane, nonceValue: `${chain.lane.nonceValue}+` };
  }
}

export interface DurableFakeAdapter extends SolanaRpcAdapter {
  sendUsdcDurable: Mock<
    (
      args: SendUsdcArgs,
      lane: DurableNonceLane,
      hooks?: DurableBroadcastHooks,
    ) => ReturnType<NonNullable<SolanaRpcAdapter["sendUsdcDurable"]>>
  >;
  broadcastNonceKill: Mock<
    (
      lane: DurableNonceLane,
      hooks?: DurableBroadcastHooks,
    ) => ReturnType<NonNullable<SolanaRpcAdapter["broadcastNonceKill"]>>
  >;
}

export function makeDurableAdapter(
  chain: FakeDurableChain,
  overrides: Partial<SolanaRpcAdapter> = {},
): DurableFakeAdapter {
  const sendUsdcDurable = vi.fn(
    async (args: SendUsdcArgs, lane: DurableNonceLane, hooks?: DurableBroadcastHooks) => {
      void args;
      if (chain.sendOutcome === "throw_before") {
        throw new Error("insufficient treasury USDC (nothing signed)");
      }
      const tx: DurableTransactionRef = {
        signature: fakeSignature("payout"),
        kind: "payout",
        nonceAccount: lane.account,
        nonceValue: lane.nonceValue,
      };
      if (hooks?.beforeBroadcast) await hooks.beforeBroadcast(tx);
      chain.payouts.push(tx);
      if (chain.sendOutcome === "finalized_ok" || chain.sendOutcome === "finalized_err") {
        chain.final.set(tx.signature, {
          status: "finalized",
          ok: chain.sendOutcome === "finalized_ok",
          slot: 4242,
        });
        advanceLane(chain);
      }
      return {
        tx,
        final: chain.final.get(tx.signature) ?? {
          status: "unknown" as const,
          reason: "absent" as const,
        },
      };
    },
  );
  const broadcastNonceKill = vi.fn(
    async (lane: DurableNonceLane, hooks?: DurableBroadcastHooks) => {
      const tx: DurableTransactionRef = {
        signature: `kill-${lane.nonceValue}`.padEnd(64, "k"),
        kind: "kill",
        nonceAccount: lane.account,
        nonceValue: lane.nonceValue,
      };
      if (hooks?.beforeBroadcast) await hooks.beforeBroadcast(tx);
      chain.kills.push(tx);
      if (chain.killLands) {
        chain.final.set(tx.signature, { status: "finalized", ok: true, slot: 4343 });
        advanceLane(chain);
      }
      return { tx, sent: true };
    },
  );
  return {
    honorsBroadcastHooks: true,
    ownAddress: "RelayTreasuryAddressBase58",
    getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000_000n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc: vi.fn().mockRejectedValue(new Error("Path 0 never sends a blockhash payout")),
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    isReachable: vi.fn().mockResolvedValue(true),
    prepareNonceLane: () => Promise.resolve({ ...chain.lane }),
    sendUsdcDurable,
    broadcastNonceKill,
    getFinalizedStatus: (signature: string) =>
      Promise.resolve(chain.final.get(signature) ?? { status: "unknown", reason: "absent" }),
    ...overrides,
  } as DurableFakeAdapter;
}

export function makeDurableOperator(
  chain: FakeDurableChain = freshChain(),
  overrides: Partial<SolanaRpcAdapter> = {},
): { operator: OperatorSolanaTransfer; adapter: DurableFakeAdapter; chain: FakeDurableChain } {
  const adapter = makeDurableAdapter(chain, overrides);
  return { operator: new OperatorSolanaTransfer(adapter), adapter, chain };
}

/**
 * The durable-nonce methods (#990) over a legacy-shaped `sendUsdc` mock, for
 * differential probes that must run on trees before and after #990: the
 * payout is `signature`, recorded through `beforeBroadcast` before the mock
 * runs; `confirmed: true` ⇒ finalized ok, `confirmed: false` +
 * `earlierBroadcastsDead: true` ⇒ finalized with an error, anything else or
 * a rejection ⇒ not finalized. No kill ever finalizes.
 */
export function durableFromSendUsdc(
  sendUsdc: SolanaRpcAdapter["sendUsdc"],
  signature: string,
): Pick<
  SolanaRpcAdapter,
  "prepareNonceLane" | "sendUsdcDurable" | "broadcastNonceKill" | "getFinalizedStatus"
> {
  const final = new Map<string, FinalizedSignatureStatus>();
  return {
    prepareNonceLane: () =>
      Promise.resolve({
        status: "ready" as const,
        account: "ProbeNonceAccount",
        nonceValue: "probe-nonce",
      }),
    sendUsdcDurable: async (args, lane, hooks) => {
      const tx: DurableTransactionRef = {
        signature,
        kind: "payout",
        nonceAccount: lane.account,
        nonceValue: lane.nonceValue,
      };
      await hooks?.beforeBroadcast?.(tx);
      try {
        const r = await sendUsdc(args);
        if ((r as { confirmed?: unknown }).confirmed === true) {
          final.set(signature, { status: "finalized", ok: true, slot: r.slot });
        } else if (r.confirmed === false && r.earlierBroadcastsDead === true) {
          final.set(signature, { status: "finalized", ok: false, slot: r.slot });
        }
      } catch (err) {
        return { tx, final: { status: "unknown", reason: "rpc_error", detail: String(err) } };
      }
      return { tx, final: final.get(signature) ?? { status: "unknown", reason: "absent" } };
    },
    broadcastNonceKill: async (lane, hooks) => {
      const tx: DurableTransactionRef = {
        signature: `kill-${lane.nonceValue}`,
        kind: "kill",
        nonceAccount: lane.account,
        nonceValue: lane.nonceValue,
      };
      await hooks?.beforeBroadcast?.(tx);
      return { tx, sent: true };
    },
    getFinalizedStatus: (sig) =>
      Promise.resolve(final.get(sig) ?? { status: "unknown", reason: "absent" }),
  };
}
