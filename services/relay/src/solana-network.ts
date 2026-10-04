/**
 * The relay's Solana network — read from the RPC it talks to, never assumed,
 * and never a boot gate (#954).
 *
 * Every Solana CAIP-2 id the relay records or claims (the `network` column on
 * settlement / agent-settlement / credential / identity-log anchor rows, the
 * `chain` column on Solana treasury-reconciliation rows, the admin
 * reconciliation overview) must name the cluster `SOLANA_RPC_URL` actually
 * serves. The old wiring labelled everything mainnet by default.
 *
 * ONE lazy {@link SolanaNetworkResolver} per relay, shared by every consumer:
 *
 *   - Boot never awaits it. Every Solana subsystem is constructed as before;
 *     a non-blocking warm-up read starts at boot.
 *   - The memo submitter resolves before each write until resolved (refusing
 *     the write while unresolved), the reconciliation loop resolves per cycle
 *     (recording nothing while unresolved), P2P admission resolves per
 *     submission (refusing 503 while unresolved or mismatched).
 *   - Every read is time-bounded; a failed read is retried by the next
 *     consumer and by the supervised `solana-network` loop, so a transient
 *     outage heals without a restart.
 *   - A declared `SOLANA_NETWORK` the RPC contradicts is a PERMANENT mismatch
 *     for the process: nothing that records or relies on a chain id ever
 *     proceeds. The state is on `GET /api/v1/admin/health` (`solana_network`,
 *     and the `solana-network` loop erroring) — never invisible.
 */
import {
  SolanaNetworkResolver,
  createSolanaGenesisHashReader,
  type SolanaGenesisHashReader,
  type SolanaNetworkState,
} from "@motebit/wallet-solana";
import { createLogger } from "./logger.js";
import { superviseInterval, type LoopSupervisor } from "./loop-supervisor.js";

const logger = createLogger({ service: "relay", module: "solana-network" });

/** Default cadence of the supervised re-read while unresolved. */
export const SOLANA_NETWORK_CHECK_INTERVAL_MS = 30_000;

export interface CreateRelaySolanaNetworkOptions {
  rpcUrl: string;
  /** The operator's `SOLANA_NETWORK`, if set (an empty string counts as unset). */
  declared?: string;
  /** Bound on each genesis read. Default: the package's 5s. */
  timeoutMs?: number;
  /** Genesis reader seam. Default: `getGenesisHash` on `rpcUrl`. */
  readGenesisHash?: SolanaGenesisHashReader;
  /**
   * The relay's shutdown. A read still pending when it aborts (the warm-up
   * `close()` stopped waiting for) settles silently: a relay that has shut
   * down logs no network transition. The read itself is not cancellable.
   */
  shutdownSignal?: AbortSignal;
}

/** Build the relay's shared resolver. Reads nothing; logs every state change. */
export function createRelaySolanaNetwork(
  options: CreateRelaySolanaNetworkOptions,
): SolanaNetworkResolver {
  const declared =
    options.declared !== undefined && options.declared.trim() !== ""
      ? options.declared.trim()
      : undefined;
  return new SolanaNetworkResolver(
    options.readGenesisHash ?? createSolanaGenesisHashReader(options.rpcUrl),
    {
      ...(declared !== undefined ? { expected: declared } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      onChange: (state) => {
        if (options.shutdownSignal?.aborted === true) return;
        logTransition(state, declared);
      },
    },
  );
}

function logTransition(state: SolanaNetworkState, declared: string | undefined): void {
  switch (state.status) {
    case "resolved":
      logger.info("solana.network_resolved", {
        network: state.network,
        genesisHash: state.genesisHash,
        declared: declared ?? null,
      });
      return;
    case "mismatch":
      logger.error("solana.network_mismatch", {
        declared: state.expected,
        network: state.network,
        genesisHash: state.genesisHash,
        consequence:
          "permanent for this process: no Solana anchor is written, no Solana reconciliation row is recorded, and P2P admission refuses — SOLANA_NETWORK names a cluster SOLANA_RPC_URL does not serve; fix one of them and restart",
      });
      return;
    case "unavailable":
      logger.warn("solana.network_unresolved", {
        reason: state.reason,
        failures: state.failures,
        consequence:
          "anchors refuse to write and Solana reconciliation records nothing until the RPC answers getGenesisHash; retried automatically — no network is ever assumed",
      });
      return;
    case "pending":
      return;
  }
}

/** The `solana_network` block of `GET /api/v1/admin/health`. */
export function solanaNetworkHealth(resolver: SolanaNetworkResolver | undefined): {
  configured: boolean;
  status: SolanaNetworkState["status"] | "not_configured";
  network: string | null;
  declared: string | null;
  reason: string | null;
} {
  if (!resolver) {
    return {
      configured: false,
      status: "not_configured",
      network: null,
      declared: null,
      reason: null,
    };
  }
  const s = resolver.state;
  return {
    configured: true,
    status: s.status,
    network: s.status === "resolved" || s.status === "mismatch" ? s.network : null,
    declared: resolver.expected ?? null,
    reason:
      s.status === "unavailable"
        ? `${s.reason} (${s.failures} failed read${s.failures === 1 ? "" : "s"})`
        : s.status === "mismatch"
          ? `SOLANA_NETWORK ${s.expected} but the RPC serves ${s.network}`
          : null,
  };
}

/**
 * The supervised re-read (rule 18). Each tick resolves (a cached no-op once
 * resolved) and THROWS while unresolved or mismatched, so the state shows as
 * `solana-network` erroring on `/api/v1/admin/health` and flips
 * `anyUnhealthy()` — a Solana network the relay cannot name is never silent.
 */
export function startSolanaNetworkLoop(
  resolver: SolanaNetworkResolver,
  supervisor: LoopSupervisor | undefined,
  intervalMs: number = SOLANA_NETWORK_CHECK_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  return superviseInterval(supervisor, "solana-network", intervalMs, async () => {
    const r = await resolver.resolve();
    if (r.status === "resolved") return;
    throw new Error(
      r.status === "mismatch"
        ? `Solana network mismatch: SOLANA_NETWORK ${r.expected} but the RPC serves ${r.network}`
        : `Solana network unresolved: ${r.reason}`,
    );
  });
}
