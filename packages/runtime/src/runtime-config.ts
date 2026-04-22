// Shared configuration and stream types for the runtime.
//
// This module holds the types that both `MotebitRuntime` and sibling modules
// (streaming, invoke-capability, agent-task-handler, activity, proactive-anchor)
// consume. Keeping them in a sibling file — rather than in the barrel index.ts —
// avoids the circular dependency where a source file would import from the
// barrel that itself imports from the source files.

import type { TurnResult, TaskRouterConfig } from "@motebit/ai-core";
import type {
  ToolRegistry,
  ExecutionReceipt,
  KeyringAdapter,
  CredentialSource,
  ServerVerifier,
  StorageAdapters,
} from "@motebit/sdk";
import type { RenderAdapter } from "@motebit/render-engine/spec";
import type { StreamingProvider } from "@motebit/ai-core";
import type { PolicyConfig, MemoryGovernanceConfig } from "@motebit/policy";

/**
 * Default task router config for planning operations.
 * Uses the strongest model for decomposition + reflection — bad plans cascade.
 * Step execution stays on the user's current model (auto-routed per message).
 *
 * Class aliases ("claude-opus") are resolved to current dated versions by the
 * proxy's resolveModelAlias(). When Anthropic ships a new Opus, update the
 * alias table in proxy/validation.ts — every surface gets the upgrade.
 */
export const PLANNING_TASK_ROUTER: TaskRouterConfig = {
  default: { model: "default" },
  overrides: {
    // Historical note: planning + plan_reflection carried hardcoded
    // temperatures (0.3 and 0.5). Claude Opus 4.7+ deprecates the
    // `temperature` parameter and returns HTTP 400 when it's present,
    // so those values poisoned the provider on motebit.com the moment
    // a reflection task ran. Removed 2026-04-18 in favor of letting the
    // model use its own default — the same principle 89f3b978
    // (ai-core) established for AnthropicProvider.generate. If a future
    // task genuinely needs temperature tuning, set it here and verify
    // compatibility with every model tier that task resolves to.
    planning: { model: "strongest" },
    plan_reflection: { model: "strongest" },
  },
};

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** When false (default), all tools from this server require user approval. */
  trusted?: boolean;
  /** Origin of this config entry (e.g. "Claude Desktop", "Claude Code", "VS Code"). */
  source?: string;
  /** Set to true after user confirms spawning a command-based discovered server. */
  spawnApproved?: boolean;
  /** SHA-256 hash of the tool manifest, set on first connect. */
  toolManifestHash?: string;
  /** Tool names from the last pinned manifest, used for diffing on change. */
  pinnedToolNames?: string[];
  /** This server is a motebit — verify identity on connect. */
  motebit?: boolean;
  /** Type of the remote motebit — determines default trust and policy behavior. */
  motebitType?: "personal" | "service" | "collaborative";
  /** Pinned public key hex (set on first verified connect). */
  motebitPublicKey?: string;
  /** Dynamic credential source for non-motebit MCP servers. Takes precedence over authToken. */
  credentialSource?: CredentialSource;
  /** Server verifier run after connect. Fail-closed: verification failure disconnects. */
  serverVerifier?: ServerVerifier;
  /** SHA-256 fingerprint of the server's TLS certificate, pinned on first connect. */
  tlsCertFingerprint?: string;
}

export interface PlatformAdapters {
  storage: StorageAdapters;
  renderer: RenderAdapter;
  ai?: StreamingProvider;
  keyring?: KeyringAdapter;
  tools?: ToolRegistry;
}

// === Runtime Configuration ===

export interface RuntimeConfig {
  motebitId: string;
  /**
   * Device identifier stamped on every artifact this runtime signs —
   * `ExecutionReceipt`, `ToolInvocationReceipt`, sovereign payment
   * receipts. Defaults to `"runtime-default"` when unset. Set this
   * explicitly when a motebit has multiple devices (per
   * `device-self-registration-v1`) so per-call receipts can be
   * audited per-device, not just per-motebit.
   */
  deviceId?: string;
  /**
   * Optional sink for signed `ToolInvocationReceipt`s emitted by the
   * streaming manager. Called once per matched tool-call calling→done
   * pair, after the receipt has been composed and signed via
   * `signToolInvocationReceipt`. The workstation surface subscribes
   * here.
   *
   * Fail-closed: if this is undefined, no signing or sink delivery
   * happens — no background signing cost for consumers that don't
   * want the artifact. If signing keys aren't unlocked, the streaming
   * manager drops the receipt silently rather than emit unsigned.
   */
  onToolInvocation?: (receipt: import("@motebit/crypto").SignableToolInvocationReceipt) => void;
  tickRateHz?: number;
  maxConversationHistory?: number;
  /** Compact events when count exceeds this threshold (0 = disabled, default 1000) */
  compactionThreshold?: number;
  /** MCP servers to connect to on init. Tools are discovered and merged into the registry. */
  mcpServers?: McpServerConfig[];
  /** Policy configuration. Controls operator mode, budgets, allow/deny lists. */
  policy?: Partial<PolicyConfig>;
  /** Memory governance config. Controls what gets saved, secret rejection. */
  memoryGovernance?: Partial<MemoryGovernanceConfig>;
  /** Summarize conversation after this many messages (0 = disabled, default 20). */
  summarizeAfterMessages?: number;
  /** Auto-deny pending tool approvals after this many ms (0 = disabled, default 600000 = 10 min). */
  approvalTimeoutMs?: number;
  /** Task router config for routing housekeeping tasks to cheaper/faster models. */
  taskRouter?: TaskRouterConfig;
  /** Enable episodic memory consolidation during housekeeping. Default false. */
  episodicConsolidation?: boolean;
  /**
   * When true, the AI loop yields a `memory_formation_deferred` chunk
   * at the end of each turn and skips the inline embedding +
   * consolidation pass. The runtime queues formation onto a
   * single-lane Promise chain that runs in the background after the
   * user's response has been delivered. The next turn blocks on
   * `awaitPendingMemoryFormation()` so the graph state is
   * consistent before the next `recallRelevant`.
   *
   * Default `false` — preserves the turn-contains-formation
   * invariant that existing tests + callers assume. Mobile + web may
   * opt-in for perceived-latency wins once surface behavior has been
   * validated. See `memory-formation-queue.ts`.
   */
  deferMemoryFormation?: boolean;
  /**
   * Interval for the proactive idle-tick heartbeat (KAIROS-shape
   * scheduler). Undefined / 0 = disabled. When set, the runtime
   * starts an interval that fires when:
   *   - No turn is currently in flight, AND
   *   - The last user message was at least
   *     `proactiveQuietWindowMs` ago.
   *
   * Each qualifying tick emits an `idle_tick_fired` event to the
   * log. Downstream wiring (generating a proactive action from the
   * tick) is surface-specific and ships separately; this config
   * only turns on the scheduler. See `idle-tick.ts`.
   */
  proactiveTickMs?: number;
  /** How long after the last user message before a tick is allowed
   *  to fire. Default 60_000 (one minute). Ignored when
   *  `proactiveTickMs` is not set. */
  proactiveQuietWindowMs?: number;
  /**
   * What the motebit does on each qualifying idle tick. Ignored when
   * `proactiveTickMs` is not set.
   *
   *   - `"none"` (default) — heartbeat-only. Emits an
   *     `idle_tick_fired` event to the log; no LLM call, no user-
   *     visible action. Foundation for future surface-specific
   *     wiring.
   *   - `"reflect"` — calls `runtime.reflect()` in the background.
   *     The reflection engine reviews recent memories + audit
   *     flags, forms high-signal insight memories, records the
   *     trajectory. No new UI surface — reflections land in the
   *     existing memory graph + event log.
   *
   * Calm-software choice: `"reflect"` acts entirely within the
   * interior (memory graph, event log); no chat bubble, toast, or
   * notification surfaces. User discovers new reflections when they
   * next browse the memory panel or trigger a turn that recalls
   * them.
   */
  proactiveAction?: "none" | "reflect" | "consolidate";
  /**
   * Tool names allowed to fire when presence is `tending` (i.e. during
   * a consolidation cycle). Empty by default — sovereign fail-closed
   * default. The list is intersected with a runtime-internal allowlist
   * of memory-mutation tools to prevent any side-effecting tool from
   * running proactively even if explicitly named here.
   *
   * Surface settings should default this to `[]` and require the user
   * to opt in to specific capabilities. See
   * `docs/doctrine/proactive-interior.md`.
   */
  proactiveCapabilities?: string[];
  /**
   * Auto-anchor policy for consolidation receipts. When configured, the
   * runtime invokes `anchorPendingConsolidationReceipts` after signing a
   * receipt if either trigger fires:
   *
   *   - `batchThreshold` unanchored receipts have accumulated (default 8), OR
   *   - `minAnchorIntervalMs` has elapsed since the last anchor
   *     (default 0 — disabled; only the threshold fires).
   *
   * Omit the field to disable auto-anchor; receipts then accumulate
   * signed-only until a manual `anchorPendingConsolidationReceipts()`
   * call. Pass `{}` for default-thresholds with a local-only (offline)
   * anchor; pass `{ submitter }` to additionally publish the Merkle
   * root onchain. Failures are best-effort — logged, never thrown.
   *
   * Doctrine: [`docs/doctrine/proactive-interior.md`](../../docs/doctrine/proactive-interior.md).
   */
  proactiveAnchor?: {
    submitter?: import("@motebit/sdk").ChainAnchorSubmitter;
    batchThreshold?: number;
    minAnchorIntervalMs?: number;
  };
  /** Ed25519 signing keys for issuing verifiable credentials (gradient, trust). */
  signingKeys?: { privateKey: Uint8Array; publicKey: Uint8Array };
  /**
   * Sovereign Solana wallet rail configuration.
   *
   * When set (and `signingKeys` is also set), the runtime derives a
   * `SolanaWalletRail` from the identity private key as a 32-byte Ed25519
   * seed — the Solana address is the identity public key itself, by
   * mathematical accident of curve choice. See `spec/settlement-v1.md` §6.
   *
   * Omit this field to run without any sovereign wallet rail. The runtime
   * still works exactly as before; it just has no Solana wallet exposed.
   */
  solana?: {
    /** Solana RPC endpoint URL (mainnet-beta, devnet, or custom). */
    rpcUrl: string;
    /** USDC SPL mint (base58). Defaults to mainnet USDC inside wallet-solana. */
    usdcMint?: string;
    /** RPC commitment level. Defaults to "confirmed" inside wallet-solana. */
    commitment?: "processed" | "confirmed" | "finalized";
  };
  /**
   * Pre-built sovereign Solana wallet rail. Overrides `solana` when set.
   * Intended for tests (inject a rail with a mocked RPC adapter) and for
   * surface apps that want to control rail construction directly.
   */
  solanaWallet?: import("@motebit/wallet-solana").SolanaWalletRail;
  /**
   * Sovereign receipt exchange transport. When provided, the runtime
   * can request signed receipts from counterparties via
   * `requestSovereignReceipt` and automatically fulfills incoming
   * requests by signing receipts for itself as the payee.
   *
   * The transport is the protocol's rails-plural boundary: the request/
   * response format is singular, but any number of transports may
   * implement it (relay-mediated A2A, direct HTTP callback, WebRTC,
   * in-memory hub for tests). See
   * `packages/runtime/src/sovereign-receipt-exchange.ts` for the
   * protocol definition and the `InMemoryReceiptExchangeHub` reference
   * implementation used by the end-to-end trust-loop test.
   */
  sovereignReceiptExchange?: import("./sovereign-receipt-exchange.js").SovereignReceiptExchangeAdapter;
  /** Optional structured logger. Falls back to console.warn for best-effort diagnostics. */
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

// === Stream Chunk ===

export type StreamChunk =
  | { type: "text"; text: string }
  | {
      type: "tool_status";
      name: string;
      status: "calling" | "done";
      result?: unknown;
      context?: string;
    }
  | {
      type: "approval_request";
      tool_call_id: string;
      name: string;
      args: Record<string, unknown>;
      risk_level?: number;
      quorum?: { required: number; approvers: string[]; collected: string[] };
    }
  | { type: "injection_warning"; tool_name: string; patterns: string[] }
  | { type: "approval_expired"; tool_name: string }
  | { type: "result"; result: TurnResult }
  | { type: "task_result"; receipt: ExecutionReceipt }
  | { type: "delegation_start"; server: string; tool: string; motebit_id?: string }
  | {
      type: "delegation_complete";
      server: string;
      tool: string;
      receipt?: { task_id: string; status: string; tools_used: string[] };
      /**
       * The full signed ExecutionReceipt when the delegated tool was a
       * motebit_task call and the result parsed as a receipt. Carries
       * nested delegation_receipts, public_key, signature — enough to
       * render a receipt bubble and run verifyReceiptChain in-browser
       * without a server roundtrip. The narrower `receipt` summary above
       * is kept for existing consumers.
       */
      full_receipt?: ExecutionReceipt;
    }
  | {
      type: "artifact";
      action: "add" | "remove";
      artifact_id: string;
      kind: "text" | "code" | "plan" | "memory" | "receipt";
      content?: string;
      title?: string;
    }
  | {
      /**
       * Deterministic-path delegation failure. Emitted by
       * `MotebitRuntime.invokeCapability` when the submit-and-poll helper
       * returns `{ok: false}`. The UI maps `code` to its user-visible copy;
       * the runtime never falls back to the AI loop on this signal. See
       * `docs/doctrine/surface-determinism.md`.
       */
      type: "invoke_error";
      code: import("./invoke-capability.js").DelegationErrorCode;
      message: string;
      retryAfterSeconds?: number;
      status?: number;
    };
