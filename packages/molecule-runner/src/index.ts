/**
 * `@motebit/molecule-runner` — shared bootstrap kernel for motebit
 * molecule/atom services.
 *
 * Every downstream service (code-review, read-url, research, summarize,
 * web-search) was running the same ~50-line skeleton by hand:
 *
 *   bootstrapAndEmitIdentity → openMotebitDatabase → assemble
 *   StorageAdapters → new MotebitRuntime(..., NullRenderer) → wireServerDeps
 *   → startServiceServer
 *
 * Five sibling copies of the same wire is the exact shape of the drift
 * the `feedback_protocol_primitive_blindness` doctrine names. The boot
 * pattern IS a protocol primitive; it belongs in a package, not inline
 * in each service.
 *
 * This package sits at Layer 6 (alongside `create-motebit`) because it
 * composes @motebit/runtime (L5) with @motebit/mcp-server (L3),
 * @motebit/persistence (L4), @motebit/tools (L1), and
 * @motebit/memory-graph (L2). A Layer-5 package cannot depend on
 * runtime (same-layer production deps are forbidden). A helper inside
 * @motebit/runtime would bloat that package with filesystem +
 * MCP-server plumbing that the orchestrator core shouldn't own.
 *
 * The application-kernel tier is the right home: same layer as
 * `create-motebit`, which also composes lower-layer packages for a
 * single application-facing entry point.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { RiskLevel } from "@motebit/sdk";
import type { ExecutionReceipt } from "@motebit/sdk";
import { bootstrapAndEmitIdentity, startServiceServer, wireServerDeps } from "@motebit/mcp-server";
import type { AdmittedTaskStore, TaskAdmissionConfig } from "@motebit/mcp-server";
import {
  deriveSolanaAddress,
  createSolanaWalletRail,
  SolanaWalletRail,
  sweepWalletRail,
  type SweepableWallet,
} from "@motebit/wallet-solana";
import type {
  BootstrapAndEmitIdentityOptions,
  BootstrapAndEmitIdentityResult,
  ServiceHandle,
  ServiceRuntime,
  ServiceServerConfig,
  WireServerDepsOptions,
} from "@motebit/mcp-server";
import { openMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";
import { MotebitRuntime, NullRenderer, getOrPinRelayKey } from "@motebit/runtime";
import type { RelayKeyPinStorage } from "@motebit/runtime";
import type { PolicyConfig, StorageAdapters, GrantedDelegationResult } from "@motebit/runtime";
import { signStandingDelegation, signDelegation, mintAudienceToken } from "@motebit/crypto";
import type {
  StandingDelegation,
  DelegationToken,
  SpendCeilingV1,
  TokenAudience,
} from "@motebit/sdk";
import { embedText as defaultEmbedText } from "@motebit/memory-graph";
import type { ToolRegistry } from "@motebit/tools";

// Re-export the receipt builder so molecule authors don't reach into
// `@motebit/mcp-server` for this one helper — runner is the single
// service-facing import.
export { createProviderReadiness, classifyProviderFailure } from "./readiness.js";
export type { ProviderReadiness, ReadinessVerdict } from "./readiness.js";
export { buildServiceReceipt } from "@motebit/mcp-server";
export type { BuildServiceReceiptInput } from "@motebit/mcp-server";
export type { ServiceHandle } from "@motebit/mcp-server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What the caller plugs in after identity is bootstrapped. Every field
 * except `toolRegistry` is optional; the runner fills in sensible
 * defaults for each.
 */
export interface MoleculeBuild {
  /**
   * The tool registry with all molecule-specific tools already
   * registered. Services build this after identity is known because
   * some tool handlers close over the service's private key (e.g. for
   * signing delegation tokens to sub-atoms).
   */
  toolRegistry: ToolRegistry;

  /**
   * Optional `handleAgentTask` generator for the `motebit_task`
   * synthetic tool. Same shape as `WireServerDepsOptions["handleAgentTask"]`.
   * Omit for pure tool-server services that don't handle relay-forwarded
   * task prompts.
   */
  handleAgentTask?: WireServerDepsOptions["handleAgentTask"];

  /**
   * Policy overrides merged into the runtime's PolicyConfig. The most
   * common pair every service sets is
   *
   *   { requireApprovalAbove: R3_EXECUTE, denyAbove: R3_EXECUTE }
   *
   * so the service's own tools + relay-forwarded motebit_task (both R3)
   * run without a human-in-the-loop while R4 money operations stay
   * denied. The default here is exactly that — but callers can pass
   * `{}` for minimal policy (read-only services) or override fields.
   */
  policyOverrides?: Partial<PolicyConfig>;

  /**
   * Optional service listing published to the relay. When omitted the
   * relay uses the registration-time default (capabilities + boilerplate
   * SLA; no pricing).
   */
  getServiceListing?: ServiceServerDepsSliceListing;

  /**
   * Optional readiness probe. When it answers `ready: false`, the service
   * withholds its relay heartbeat so discovery freshness decays instead of
   * advertising work the agent cannot currently perform (#610). Build one with
   * `createProviderReadiness`. Omitted ⇒ today's behavior (always advertise).
   */
  checkReadiness?: () => Promise<{ ready: boolean; reason?: string }>;

  /**
   * Custom REST routes handled before MCP auth. Used by web-search for
   * its `/search` public endpoint.
   */
  customRoutes?: ServiceServerConfig["customRoutes"];

  /**
   * Called inside the shutdown path after `runtime.stop()` and
   * `db.close()`. Use for service-specific cleanup (e.g. disconnecting
   * an inbound MCP-client adapter).
   */
  onStop?: () => void | Promise<void>;

  /**
   * Optional override of the private-key buffer zeroization behavior.
   * Defaults to zeroing the bytes on shutdown. Pass `false` to disable
   * (useful in tests where the same key object is asserted on after
   * shutdown).
   */
  zeroPrivateKeyOnShutdown?: boolean;
}

type ServiceServerDepsSliceListing = () => Promise<{
  capabilities: string[];
  pricing: Array<{ capability: string; unit_cost: number; currency: string; per: string }>;
  sla: { max_latency_ms: number; availability_guarantee: number };
  description: string;
} | null>;

/**
 * Per-molecule configuration. Mirrors the env-derived config every
 * service used to hand-roll in its own `loadConfig()` helper.
 */
export interface MoleculeConfig {
  /** Persistent data directory (identity files + motebit.md). */
  dataDir: string;
  /** SQLite database path (will be created if absent). */
  dbPath: string;
  /** MCP HTTP transport port. */
  port: number;

  /** Identity bootstrap parameters — passed through to `bootstrapAndEmitIdentity`. */
  serviceName: string;
  displayName: string;
  serviceDescription: string;
  capabilities: string[];

  /** Optional bearer token guarding the MCP HTTP endpoint. */
  authToken?: string;
  /** Sync relay URL — enables registration, heartbeat, and remote key resolution. */
  syncUrl?: string;
  /** API token for relay calls. */
  apiToken?: string;
  /** Externally-reachable URL the relay advertises for routing. */
  publicUrl?: string;
  /**
   * The relay operator's PINNED Ed25519 public key (hex) used to verify
   * relay-signed task dispatch tokens. Falls back to `moneyExecution.
   * relayPublicKeyHex`, then to a one-time fetch of the relay's
   * `/.well-known/motebit.json` (trust-on-first-use, logged loudly). Pin it
   * in production.
   */
  relayPublicKeyHex?: string;
  /**
   * Task admission posture (`docs/doctrine/task-admission.md`).
   *   - `"relay"` — `motebit_task` runs only with a relay-signed
   *     `dispatch_token` for this worker and task.
   *   - `"open"`  — any authenticated caller may submit work (pre-admission
   *     behavior).
   * Default: `"open"`, with a LOUD boot warning when the molecule is PRICED
   * (any listing entry with `unit_cost > 0`) and relay-registered — that is
   * the shape where a free identity can run priced work for nothing. The
   * flip to `"relay"`-by-default-when-priced is deferred until every
   * first-party direct caller of a priced atom forwards the relay's token
   * (trigger recorded in the doctrine doc); services that spend on inference
   * opt in explicitly today.
   */
  taskAdmission?: "relay" | "open";

  /**
   * Money-execution seam — opt-in. When present, the molecule becomes a
   * SPENDING molecule (the Clerk archetype): the runner constructs the runtime
   * with a sovereign Solana rail over the molecule's OWN wallet, the persistent
   * grant-spend store, an R4-permitting policy, and the metered delegation
   * path; self-issues a signed standing grant (a self-imposed spend ceiling —
   * `delegator == delegate`, matching the shipped `grant.ts` path); and exposes
   * a `spend` handle to the builder. Absent ⇒ no money seam (back-compatible).
   * The `dryRun` posture is per-CALL (`spend({ dryRun })`), not here — the
   * primitive isolates a dry run to a throwaway store, so the live Sqlite
   * accumulator is never touched by a dry run regardless of this config.
   */
  moneyExecution?: {
    /** Solana RPC for the sovereign wallet rail (the molecule's own funds). */
    solanaRpcUrl: string;
    /** The relay operator's PINNED Ed25519 public key (hex) — P2P treasury root. */
    relayPublicKeyHex: string;
    /**
     * The USDC SPL mint the sovereign rail transacts in. MUST match the network
     * behind `solanaRpcUrl` and the relay's configured settlement mint — the
     * wallet rail reads its own balance against THIS mint before broadcasting,
     * so a devnet molecule left on the mainnet-USDC default reads an empty ATA
     * and fails every live hop with `insufficient_balance`. Omit only for
     * mainnet (the rail defaults to mainnet USDC). Set to the devnet USDC mint
     * on devnet/staging.
     */
    usdcMint?: string;
    /** The self-imposed signed spend ceiling this molecule commits to. */
    spendCeiling: SpendCeilingV1;
    /** Grant lifetime from issue, ms (default 90 days). */
    grantTtlMs?: number;
  };
}

/**
 * The spend handle a money molecule (the Clerk) receives as the builder's
 * second argument. Thin passthrough to the runtime's metered granted-spend
 * primitive — the service never imports `@motebit/runtime` internals or signs
 * anything itself.
 */
export interface MoleculeSpendHandle {
  /** The self-issued signed grant this molecule spends under (its signed ceiling). */
  heldGrant: StandingDelegation;
  /**
   * Execute a paid sub-delegation under the held grant. Mints a FRESH per-tick
   * token per call (unique `issued_at`, else the meter nonce replays), then
   * drives `MotebitRuntime.executeGrantedDelegation` — which re-composes the
   * full R4 AND fail-closed. `dryRun` exercises verify + scope + meter without
   * broadcasting or touching the live ceiling.
   */
  spend(params: {
    capability: string;
    prompt: string;
    dryRun?: boolean;
    /**
     * Pin the sub-worker by `motebit_id` (a delegating molecule that already
     * knows its atom, e.g. the Researcher's `MOTEBIT_WEB_SEARCH_TARGET_ID`)
     * instead of letting discovery pick by capability. Narrows discovery only;
     * an ineligible pinned worker fails closed (`worker_not_payable`).
     */
    targetWorkerId?: string;
  }): Promise<GrantedDelegationResult>;
}

/**
 * Hooks for advanced customization and tests. Adapter slots let a test
 * stub the database/runtime/identity bootstrap without spinning up real
 * filesystem or network state.
 */
/**
 * A runtime-shaped object — duck-typed to match `MotebitRuntime`'s
 * surface as consumed by `wireServerDeps`. Tests stub this to avoid
 * constructing the full 2000-line runtime for what is, at this layer,
 * an orchestration test.
 */
export interface RunnerRuntime {
  init(): Promise<void>;
  stop(): void;
  // All other fields are read by wireServerDeps — which duck-types
  // them via its own `ServiceRuntime` interface. We keep this loose on
  // purpose; `MotebitRuntime` satisfies both.
  [key: string]: unknown;
}

export interface MoleculeRunnerAdapters {
  /** Override identity bootstrap. Default: `bootstrapAndEmitIdentity` from @motebit/mcp-server. */
  bootstrapIdentity?: (
    options: BootstrapAndEmitIdentityOptions,
  ) => Promise<BootstrapAndEmitIdentityResult>;
  /** Override database open. Default: `openMotebitDatabase` from @motebit/persistence. */
  openDatabase?: (dbPath: string) => Promise<MotebitDatabase>;
  /**
   * Override runtime construction. Default: `new MotebitRuntime(config,
   * { storage, renderer: new NullRenderer(), tools })`. Tests stub this
   * to avoid the real runtime's state-snapshot + memory-graph +
   * SyncEngine instantiation — that machinery is tested inside
   * @motebit/runtime, not here.
   */
  createRuntime?: (
    identity: BootstrapAndEmitIdentityResult,
    storage: StorageAdapters,
    toolRegistry: ToolRegistry,
    policyOverrides: Partial<PolicyConfig>,
  ) => RunnerRuntime;
  /**
   * Override money-runtime construction (used only when `config.moneyExecution`
   * is set). Default: `defaultCreateMoneyRuntime` — a runtime with a sovereign
   * Solana rail, the persistent grant-spend store, an R4-permitting policy, and
   * the metered delegation path enabled. Tests inject a stub exposing
   * `executeGrantedDelegation` + `init`/`stop` to exercise the spend seam
   * without a wallet or relay.
   */
  createMoneyRuntime?: (
    identity: BootstrapAndEmitIdentityResult,
    storage: StorageAdapters,
    toolRegistry: ToolRegistry,
    policyOverrides: Partial<PolicyConfig>,
    config: MoleculeConfig,
    grantSpendStore: unknown,
  ) => RunnerRuntime;
  /**
   * Override local embed function. Default: `embedText` from @motebit/memory-graph.
   * Pass `null` to disable memory embedding entirely (no queryMemories/storeMemory
   * synthetic tools).
   */
  embedText?: ((text: string) => Promise<number[]>) | null;
  /** Override server start. Default: `startServiceServer` from @motebit/mcp-server. */
  startServer?: typeof startServiceServer;
  /** HTTP fetch used for the relay well-known key lookup. Default: global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Durable stores for task admission. Default: JSON files under `dataDir`
   * (`relay-key-pins.json`, `admitted-tasks.json`) — the same persistent
   * volume that holds the identity. Tests inject in-memory stores.
   */
  admissionStores?: { pinStorage: RelayKeyPinStorage; admittedStore: AdmittedTaskStore };
  /**
   * Override construction of the sovereign wallet used for sweeping earnings.
   * Default: `createSolanaWalletRail({ rpcUrl, identitySeed })`. Tests inject a
   * fake to exercise the sweep wiring without a network.
   */
  createSweepWallet?: (rpcUrl: string, identitySeed: Uint8Array) => SweepableWallet;
  /** Override the log sink for the runner's own boot messages. Default: console.log. */
  log?: (msg: string) => void;
  /**
   * Override the logger passed to `startServiceServer`. Default: its own
   * visible `[motebit/mcp-server]`-prefixed console.warn — preserves the
   * fail-loudly contract every service inherited from the extraction.
   */
  serverLog?: (msg: string) => void;
  /** Override fs.existsSync for dbDir creation. Used by tests to avoid real FS. */
  existsSync?: (path: string) => boolean;
  /** Override fs.mkdirSync for dbDir creation. */
  mkdirSync?: (path: string, options: { recursive: boolean }) => void;
}

/**
 * The callback services pass to `runMolecule`. Called after identity
 * bootstrap so tool handlers can close over the service's private key,
 * motebit id, and device id.
 */
export type MoleculeBuilder = (
  identity: BootstrapAndEmitIdentityResult,
  /**
   * The spend handle — present ONLY when `config.moneyExecution` is set (a
   * money molecule). Undefined for ordinary molecules. Back-compatible: a
   * one-argument builder ignores it.
   */
  spend?: MoleculeSpendHandle,
) => MoleculeBuild | Promise<MoleculeBuild>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Minimal StorageAdapters slice that every molecule needs. The runtime
 * tolerates missing optional stores (e.g. `serviceListingStore`), so we
 * populate everything the DB exposes — this matches what every service
 * was doing by hand.
 */
function assembleStorageAdapters(db: MotebitDatabase): StorageAdapters {
  // db is typed `MotebitDatabase` from @motebit/persistence; its fields
  // are all adapter instances. The `as unknown as` around gradientStore
  // mirrors the shape services were using (the gradient store exposes a
  // superset of the runtime's expected interface).
  const dbAny = db as unknown as {
    eventStore: StorageAdapters["eventStore"];
    memoryStorage: StorageAdapters["memoryStorage"];
    identityStorage: StorageAdapters["identityStorage"];
    auditLog: StorageAdapters["auditLog"];
    stateSnapshot: StorageAdapters["stateSnapshot"];
    toolAuditSink: StorageAdapters["toolAuditSink"];
    conversationStore: StorageAdapters["conversationStore"];
    planStore?: StorageAdapters["planStore"];
    gradientStore?: unknown;
    agentTrustStore?: StorageAdapters["agentTrustStore"];
    serviceListingStore?: StorageAdapters["serviceListingStore"];
    budgetAllocationStore?: StorageAdapters["budgetAllocationStore"];
    settlementStore?: StorageAdapters["settlementStore"];
    latencyStatsStore?: StorageAdapters["latencyStatsStore"];
    credentialStore?: StorageAdapters["credentialStore"];
    approvalStore?: StorageAdapters["approvalStore"];
  };

  return {
    eventStore: dbAny.eventStore,
    memoryStorage: dbAny.memoryStorage,
    identityStorage: dbAny.identityStorage,
    auditLog: dbAny.auditLog,
    stateSnapshot: dbAny.stateSnapshot,
    toolAuditSink: dbAny.toolAuditSink,
    conversationStore: dbAny.conversationStore,
    planStore: dbAny.planStore,
    gradientStore: dbAny.gradientStore as StorageAdapters["gradientStore"],
    agentTrustStore: dbAny.agentTrustStore,
    serviceListingStore: dbAny.serviceListingStore,
    budgetAllocationStore: dbAny.budgetAllocationStore,
    settlementStore: dbAny.settlementStore,
    latencyStatsStore: dbAny.latencyStatsStore,
    credentialStore: dbAny.credentialStore,
    approvalStore: dbAny.approvalStore,
  };
}

/**
 * The default policy every service-motebit was setting: auto-allow up
 * to R3_EXECUTE so its own tools plus the relay-forwarded motebit_task
 * call (R3) both run without a human-in-the-loop. R4 money operations
 * remain denied.
 *
 * The bands path requires BOTH thresholds set — earlier code only set
 * `requireApprovalAbove` with a typoed `maxRiskAuto` that PolicyConfig
 * does not define, falling through to the legacy path with maxRiskLevel
 * undefined → default R1_DRAFT → every R3+ tool denied. This default
 * locks in the fix.
 */
const DEFAULT_POLICY_OVERRIDES: Partial<PolicyConfig> = {
  requireApprovalAbove: RiskLevel.R3_EXECUTE,
  denyAbove: RiskLevel.R3_EXECUTE,
};

// ---------------------------------------------------------------------------
// Money-execution seam (the Clerk archetype)
// ---------------------------------------------------------------------------

/**
 * The LOCAL tool a paid sub-delegation exercises — the self-grant's scope must
 * cover it, and the runtime's scope fence checks THIS name (not the remote
 * capability, which is metered by amount). Matches interactive-delegation.ts.
 */
const DELEGATE_TOOL = "delegate_to_agent";
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const TICK_TTL_MS = 60 * 60 * 1000; // 1h, ≤ grant.max_token_ttl_ms

/**
 * Self-issue the molecule's signed standing grant — a signed, self-imposed
 * spend ceiling (`delegator == delegate == this molecule`, matching the shipped
 * `apps/cli/src/subcommands/grant.ts` self-grant shape). This is the crypto-
 * honest form of autonomy: because ticks are delegator-signed
 * (`verifyTokenAgainstGrant`), only a self-grant lets the holder mint its own
 * ticks. The owner's control is the wallet balance + this ceiling.
 */
export async function selfIssueGrant(
  identity: BootstrapAndEmitIdentityResult,
  money: NonNullable<MoleculeConfig["moneyExecution"]>,
): Promise<StandingDelegation> {
  const now = Date.now();
  return signStandingDelegation(
    {
      grant_id: `clerk-self-grant:${identity.motebitId}`,
      delegator_id: identity.motebitId,
      delegator_public_key: identity.publicKeyHex,
      delegate_id: identity.motebitId,
      delegate_public_key: identity.publicKeyHex,
      scope: DELEGATE_TOOL,
      subject: "market:self-funded-delegation",
      cadence_ms: 0, // no minimum firing interval for interactive spend
      issued_at: now,
      not_before: null,
      expires_at: now + (money.grantTtlMs ?? NINETY_DAYS_MS),
      max_token_ttl_ms: TICK_TTL_MS,
      spend_ceiling: money.spendCeiling,
    },
    identity.privateKey,
  );
}

/** Mint a FRESH per-tick token under the self-grant (unique issued_at). */
export async function mintTick(
  grant: StandingDelegation,
  identity: BootstrapAndEmitIdentityResult,
): Promise<DelegationToken> {
  const now = Date.now();
  return signDelegation(
    {
      delegator_id: grant.delegator_id,
      delegator_public_key: grant.delegator_public_key,
      delegate_id: grant.delegate_id,
      delegate_public_key: grant.delegate_public_key,
      scope: grant.scope,
      issued_at: now,
      expires_at: now + TICK_TTL_MS,
      grant_id: grant.grant_id,
    },
    identity.privateKey,
  );
}

/**
 * An audience-scoped relay token minter bound to this molecule's identity —
 * the same short-lived device-signed token shape the CLI uses
 * (`apps/cli/src/index.ts`). Extracted so it is unit-testable without a relay.
 */
export function makeAuthTokenMinter(
  identity: BootstrapAndEmitIdentityResult,
): (audience?: TokenAudience) => Promise<string> {
  const did = identity.deviceId;
  const pk = identity.privateKey;
  return async (audience: TokenAudience = "task:submit"): Promise<string> => {
    return (await mintAudienceToken({ mid: identity.motebitId, did, aud: audience }, pk)).token;
  };
}

/**
 * Default money-runtime factory: a `MotebitRuntime` with the molecule's own
 * sovereign Solana rail, the persistent grant-spend store (so the lifetime
 * ceiling survives restart), an R4-permitting policy (so the metered R4 spend
 * is admitted — the grant + meter bound it), and the metered delegation path
 * enabled with an audience-scoped token minter + the pinned relay key.
 */
export function defaultCreateMoneyRuntime(
  identity: BootstrapAndEmitIdentityResult,
  storage: StorageAdapters,
  tools: ToolRegistry,
  policyOverrides: Partial<PolicyConfig>,
  config: MoleculeConfig,
  grantSpendStore: unknown,
  /**
   * Test-only injection of the sovereign wallet rail — the sibling of the
   * `createSweepWallet` adapter override, applied to the money-execution rail.
   * Production callers (`runMolecule`) never pass it, so the deployed path is
   * byte-identical: it constructs the real `createSolanaWalletRail` against
   * `money.solanaRpcUrl`. A cross-artifact activation test injects a rail over
   * a fake `SolanaRpcAdapter` so the REAL composition root (this builder, the
   * R4 authority gate, the metered submission path) can be driven against a
   * booted relay without a live Solana RPC. `adapter-pattern-everywhere`:
   * all I/O abstracted, a fake for tests. See
   * docs/doctrine/composition-preserves-enforcement.md (the runtime→relay bridge).
   */
  walletOverride?: SolanaWalletRail,
): RunnerRuntime {
  const money = config.moneyExecution;
  if (money == null) throw new Error("defaultCreateMoneyRuntime called without moneyExecution");
  const wallet =
    walletOverride ??
    createSolanaWalletRail({
      rpcUrl: money.solanaRpcUrl,
      identitySeed: identity.privateKey,
      // Match the rail's mint to the network — else a devnet molecule reads the
      // (empty) mainnet-USDC ATA and every live hop fails `insufficient_balance`.
      // Undefined passes through to the rail's mainnet-USDC default.
      usdcMint: money.usdcMint,
    });
  const runtime = new MotebitRuntime(
    {
      motebitId: identity.motebitId,
      // R4-permitting: the grant + blast-radius meter enforce the bound, not
      // an approval prompt (there is no human in a molecule). denyAbove never
      // overridden below R4 or the self-grant could never clear step 8c.
      policy: { ...policyOverrides, denyAbove: RiskLevel.R4_MONEY },
      solanaWallet: wallet,
      grantSpendStore: grantSpendStore as never,
      // The molecule's identity keys double as the delegator signing keys so
      // the runtime can mint routing-decision transcripts for its ranked paid
      // hires (docs/doctrine/routing-decision-transcript.md Inc 3 — without
      // these the producer is silently dormant and every deployed molecule
      // WARNs "no transcripts" in conformance).
      signingKeys: { privateKey: identity.privateKey, publicKey: identity.publicKey },
    },
    { storage, renderer: new NullRenderer(), tools },
  );
  runtime.enableInteractiveDelegation({
    syncUrl: config.syncUrl ?? "",
    authToken: makeAuthTokenMinter(identity),
    relayPublicKey: money.relayPublicKeyHex,
    acknowledgeNoHistoryRisk: true,
  });
  return runtime as unknown as RunnerRuntime;
}

// ---------------------------------------------------------------------------
// Task admission — decide posture + resolve the relay key
// ---------------------------------------------------------------------------

/** Env-derived defaults for task admission; explicit config always wins. */
export function taskAdmissionEnvDefaults(env: NodeJS.ProcessEnv = process.env): {
  taskAdmission?: "relay" | "open";
  relayPublicKeyHex?: string;
} {
  const out: { taskAdmission?: "relay" | "open"; relayPublicKeyHex?: string } = {};
  const mode = env["MOTEBIT_TASK_ADMISSION"]?.trim();
  if (mode === "relay" || mode === "open") out.taskAdmission = mode;
  const key = env["MOTEBIT_RELAY_PUBLIC_KEY"]?.trim();
  if (key) out.relayPublicKeyHex = key;
  return out;
}

/**
 * A tiny durable JSON map under `dataDir` — the admission state a worker
 * must not lose across a restart (its relay-key pin and the task ids it has
 * already admitted). Atomic write via rename; read on every access so a
 * second process on the same volume sees the same truth.
 */
function jsonFileMap(path: string): {
  get(key: string): string | null;
  set(key: string, value: string): void;
  entries(): Record<string, string>;
  replace(all: Record<string, string>): void;
} {
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const write = (all: Record<string, string>): void => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    get: (k) => read()[k] ?? null,
    set: (k, v) => {
      const all = read();
      all[k] = v;
      write(all);
    },
    entries: read,
    replace: write,
  };
}

/** @internal exported for tests */
export function fileAdmissionStores(dataDir: string): {
  pinStorage: RelayKeyPinStorage;
  admittedStore: AdmittedTaskStore;
} {
  const pins = jsonFileMap(resolvePath(dataDir, "relay-key-pins.json"));
  const admitted = jsonFileMap(resolvePath(dataDir, "admitted-tasks.json"));
  return {
    pinStorage: { getItem: (k) => pins.get(k), setItem: (k, v) => pins.set(k, v) },
    admittedStore: {
      has: (id) => {
        const exp = Number(admitted.get(id));
        return Number.isFinite(exp) && exp > Date.now();
      },
      add: (id, expiresAt) => {
        const now = Date.now();
        const all = admitted.entries();
        for (const [k, v] of Object.entries(all)) if (Number(v) <= now) delete all[k];
        all[id] = String(expiresAt);
        admitted.replace(all);
      },
    },
  };
}

const HEX_64 = /^[0-9a-fA-F]{64}$/;

/** @internal exported for tests */
export async function resolveTaskAdmission(
  config: Pick<
    MoleculeConfig,
    "syncUrl" | "relayPublicKeyHex" | "moneyExecution" | "taskAdmission" | "serviceName"
  >,
  molecule: Pick<MoleculeBuild, "getServiceListing">,
  fetchImpl: typeof fetch,
  log: (msg: string) => void,
  stores: { pinStorage: RelayKeyPinStorage; admittedStore: AdmittedTaskStore },
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskAdmissionConfig | undefined> {
  const envDefaults = taskAdmissionEnvDefaults(env);
  let priced = false;
  if (molecule.getServiceListing) {
    try {
      const listing = await molecule.getServiceListing();
      // A null listing is a service that publishes nothing — nothing priced.
      priced = listing?.pricing.some((p) => p.unit_cost > 0) ?? false;
    } catch (err) {
      // A listing that cannot be read is treated as priced: the failure mode
      // must be "refuse work until the relay admits it", never "work free".
      priced = true;
      log(
        `task admission: listing unreadable (${err instanceof Error ? err.message : String(err)}) — treating as priced`,
      );
    }
  }
  const configured = config.taskAdmission ?? envDefaults.taskAdmission;
  const mode = configured ?? "open";
  if (mode === "open") {
    if (configured == null && priced && config.syncUrl) {
      // The exact shape the admission primitive exists for, left open. Say
      // so on every boot — a priced listing is a promise that the work is
      // bought, and without admission any relay-registered identity can
      // run it for free. (Default flip deferred: docs/doctrine/task-admission.md.)
      log(
        'task admission: OPEN on a PRICED relay-registered listing — any relay-registered identity can run this work without paying. Set taskAdmission: "relay" (MOTEBIT_TASK_ADMISSION=relay) to require the relay\'s dispatch token.',
      );
    } else {
      log(`task admission: open (${configured != null ? "configured" : "unpriced or no relay"})`);
    }
    return undefined;
  }

  // Empty strings are "unset", never a pinned key; a NON-empty malformed pin is
  // a configuration error that must stop the boot, not a silent deny-all that
  // logs "pinned relay key".
  const pinnedRaw =
    config.relayPublicKeyHex?.trim() ||
    config.moneyExecution?.relayPublicKeyHex?.trim() ||
    envDefaults.relayPublicKeyHex ||
    undefined;
  if (pinnedRaw != null) {
    if (!HEX_64.test(pinnedRaw)) {
      throw new Error(
        `task admission: relayPublicKeyHex / MOTEBIT_RELAY_PUBLIC_KEY is not a 64-hex Ed25519 public key (got ${pinnedRaw.length} chars) — fix the pin; refusing to start a priced service that could never admit work`,
      );
    }
    log("task admission: relay dispatch required (pinned relay key)");
    return { relayPublicKey: pinnedRaw, admittedStore: stores.admittedStore };
  }
  const syncUrl = config.syncUrl?.replace(/\/+$/, "");
  if (!syncUrl) {
    // Nothing to verify against and nothing to fetch from: deny all rather
    // than open. The operator asked for admission without giving the worker
    // a relay — a configuration error the first task surfaces, not a reason
    // to work for free.
    log(
      "task admission: relay dispatch required but NO relay key and NO syncUrl — every task will be refused",
    );
    return { relayPublicKey: () => Promise.resolve(null), admittedStore: stores.admittedStore };
  }
  log(
    `task admission: relay dispatch required — relay key NOT pinned in config; using the persisted trust-on-first-use pin for ${syncUrl} (rotation verified against the relay's signed succession chain). Set relayPublicKeyHex / MOTEBIT_RELAY_PUBLIC_KEY to pin explicitly.`,
  );
  return {
    // The same TOFU-with-succession primitive every delegator surface uses
    // for the P2P fee-leg treasury key (`@motebit/runtime` relay-key-pin):
    // first fetch persists the pin; a later key change is honored only when
    // the relay's signed succession chain roots at our pin; otherwise fail
    // closed. Never a bare re-fetch on every task.
    relayPublicKey: async () => {
      const key = await getOrPinRelayKey(syncUrl, {
        fetchImpl,
        storage: stores.pinStorage,
        logger: { warn: (m, ctx) => log(`task admission: ${m} ${ctx ? JSON.stringify(ctx) : ""}`) },
      });
      return key != null && HEX_64.test(key) ? key : null;
    },
    admittedStore: stores.admittedStore,
  };
}

// ---------------------------------------------------------------------------
// runMolecule — the entrypoint services call
// ---------------------------------------------------------------------------

/**
 * Boot a molecule and block until shutdown. The returned `ServiceHandle`
 * has a `shutdown()` the caller can invoke; otherwise the server's
 * built-in SIGINT/SIGTERM handlers (installed by `startServiceServer`)
 * handle graceful termination.
 *
 * Pipeline:
 *   1. Bootstrap identity → emit motebit.md
 *   2. Open SQLite database (creating the parent directory if absent)
 *   3. Assemble StorageAdapters from the DB
 *   4. Invoke `build(identity)` to get the service-specific tool
 *      registry, handleAgentTask, policy, and listing
 *   5. Construct MotebitRuntime with NullRenderer + the assembled storage
 *   6. `wireServerDeps` → `startServiceServer`
 *
 * The private key bytes are zeroed on shutdown by default.
 */
export async function runMolecule(
  config: MoleculeConfig,
  build: MoleculeBuilder,
  adapters: MoleculeRunnerAdapters = {},
): Promise<ServiceHandle> {
  const log = adapters.log ?? defaultLog;
  const bootstrap = adapters.bootstrapIdentity ?? bootstrapAndEmitIdentity;
  const openDb = adapters.openDatabase ?? openMotebitDatabase;
  const startServer = adapters.startServer ?? startServiceServer;
  const existsSyncFn = adapters.existsSync ?? existsSync;
  const mkdirSyncFn = adapters.mkdirSync ?? mkdirSync;

  // 1. Identity bootstrap + motebit.md emission
  const identity = await bootstrap({
    dataDir: config.dataDir,
    serviceName: config.serviceName,
    displayName: config.displayName,
    serviceDescription: config.serviceDescription,
    capabilities: config.capabilities,
  });
  log(
    `Identity ${identity.isFirstLaunch ? "generated" : "loaded"}: ${identity.motebitId} ` +
      `(data dir: ${config.dataDir})`,
  );

  // 2. Database — ensure parent dir, open
  const absDbPath = resolvePath(config.dbPath);
  const dbDir = dirname(absDbPath);
  if (!existsSyncFn(dbDir)) mkdirSyncFn(dbDir, { recursive: true });
  const db = await openDb(absDbPath);
  // Driver identity in boot logs — a silent sql.js fallback (native
  // better-sqlite3 binding dropped by `pnpm deploy --prod`) is otherwise
  // invisible until WAL-less durability bites. check-deploy-parity rule 4
  // makes the drop structural; this line makes it observable in fly logs.
  // Optional chain: test adapters inject stub databases without a driver.
  const driverName = (db as { db?: { driverName?: string } }).db?.driverName ?? "unknown";
  log(`Database open: ${absDbPath} (driver: ${driverName})`);

  // 3. Build molecule-specific pieces. A money molecule (moneyExecution set)
  //    receives a spend handle whose runtime ref is filled AFTER construction —
  //    the builder closes over it; its task handlers deref it at task time
  //    (long after the runtime exists), closing the chicken-and-egg.
  const runtimeRef: { current: RunnerRuntime | null } = { current: null };
  let spend: MoleculeSpendHandle | undefined;
  if (config.moneyExecution) {
    const heldGrant = await selfIssueGrant(identity, config.moneyExecution);
    spend = {
      heldGrant,
      spend: async ({ capability, prompt, dryRun, targetWorkerId }) => {
        const rt = runtimeRef.current;
        const exec = rt?.executeGrantedDelegation;
        if (typeof exec !== "function") return { ok: false, code: "sync_not_enabled" };
        const token = await mintTick(heldGrant, identity);
        return (exec as (p: unknown) => Promise<GrantedDelegationResult>).call(rt, {
          capability,
          prompt,
          delegation: { token, grant: heldGrant },
          ...(dryRun != null ? { dryRun } : {}),
          ...(targetWorkerId != null ? { targetWorkerId } : {}),
        });
      },
    };
    log(`Money seam: self-grant ${heldGrant.grant_id} (signed ceiling; dry-run is per-call)`);
  }
  const molecule = await build(identity, spend);

  // 4. Storage + runtime
  const storage = assembleStorageAdapters(db);
  // MERGE the molecule's overrides ONTO the R3 baseline — never replace it.
  // `?? DEFAULT` was a footgun: a molecule passing a partial or EMPTY object
  // (`policyOverrides: {}`, which several services copy-pasted) is defined, so
  // `??` kept it and dropped `denyAbove: R3_EXECUTE` → default R1_DRAFT → the
  // relay-forwarded `motebit_task` (always R3) DENIED, and the service silently
  // never executes a paid task (the 2026-07-15 Auditor conformance failure:
  // "requires R3_EXECUTE but max allowed is R1_DRAFT"). The baseline is a
  // floor every task-receiving molecule needs; a molecule can still RAISE
  // denyAbove (e.g. the Clerk's R4 money path) by setting it explicitly.
  const policyOverrides: Partial<PolicyConfig> = {
    ...DEFAULT_POLICY_OVERRIDES,
    ...molecule.policyOverrides,
  };
  let runtime: RunnerRuntime;
  if (config.moneyExecution) {
    const makeMoney = adapters.createMoneyRuntime ?? defaultCreateMoneyRuntime;
    runtime = makeMoney(
      identity,
      storage,
      molecule.toolRegistry,
      policyOverrides,
      config,
      db.grantSpendStore,
    );
  } else {
    const createRuntime = adapters.createRuntime ?? defaultCreateRuntime;
    runtime = createRuntime(identity, storage, molecule.toolRegistry, policyOverrides);
  }
  runtimeRef.current = runtime;
  await runtime.init();
  log(`Runtime initialized (${config.serviceName})`);

  // 5. Wire server deps
  const embedFn =
    adapters.embedText === null ? undefined : (adapters.embedText ?? defaultEmbedText);
  const wireOpts: WireServerDepsOptions = {
    motebitId: identity.motebitId,
    publicKeyHex: identity.publicKeyHex,
    identityFileContent: identity.identityContent,
    syncUrl: config.syncUrl,
    apiToken: config.apiToken,
  };
  if (embedFn) wireOpts.embedText = embedFn;
  if (molecule.handleAgentTask) wireOpts.handleAgentTask = molecule.handleAgentTask;

  const deps = wireServerDeps(runtime as unknown as ServiceRuntime, wireOpts);
  if (molecule.getServiceListing) {
    deps.getServiceListing = molecule.getServiceListing;
  }
  if (molecule.checkReadiness) {
    deps.checkReadiness = molecule.checkReadiness;
  }

  // 6. Start server
  const serverCfg: ServiceServerConfig = {
    name: `${config.serviceName}-${identity.motebitId.slice(0, 8)}`,
    // The human display name flows to registration metadata.display_name —
    // the self-asserted claim Discover cards render (trust-graph §3).
    ...(config.displayName != null ? { displayName: config.displayName } : {}),
    port: config.port,
    motebitType: "service",
    onStart: (port, toolCount) => {
      log(`MCP server running on http://localhost:${port} (SSE). ${toolCount} tools exposed.`);
    },
    onStop: () => {
      log("Shutting down...");
      runtime.stop();
      db.close();
      if (molecule.onStop) {
        void Promise.resolve(molecule.onStop()).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log(`molecule onStop error: ${msg}`);
        });
      }
      if (molecule.zeroPrivateKeyOnShutdown !== false) {
        identity.privateKey.fill(0);
      }
    },
  };
  // Task admission — priced work enters through the relay's gate. Decided
  // from the molecule's OWN listing so pricing and admission cannot drift
  // apart: a service that charges is a service that requires the relay's
  // signed admission before it spends. Doctrine: task-admission.md.
  const admission = await resolveTaskAdmission(
    config,
    molecule,
    adapters.fetch ?? fetch,
    log,
    adapters.admissionStores ?? fileAdmissionStores(config.dataDir),
  );
  if (admission != null) serverCfg.taskAdmission = admission;
  if (config.authToken != null) serverCfg.authToken = config.authToken;
  if (config.syncUrl != null) serverCfg.syncUrl = config.syncUrl;
  if (config.apiToken != null) serverCfg.apiToken = config.apiToken;
  if (config.publicUrl != null) serverCfg.publicEndpointUrl = config.publicUrl;
  if (molecule.customRoutes) serverCfg.customRoutes = molecule.customRoutes;
  if (adapters.serverLog) serverCfg.log = adapters.serverLog;

  // P2P settlement enablement (opt-in, back-compatible). Default — env unset —
  // registers exactly as before (relay-mode only, no settlement fields). When
  // the operator sets MOTEBIT_SETTLEMENT_MODES (e.g. "relay,p2p"), advertise
  // those modes AND a settlement address DERIVED from this service's own
  // identity key (never hardcoded — survives key handling; the relay validates
  // a P2P proof's worker leg against exactly this address). Only enable "p2p"
  // once the service can SPEND received funds (sweep), or earnings accrue here
  // with no way out. See docs/doctrine/off-ramp-as-user-action.md.
  const settlementModes = process.env.MOTEBIT_SETTLEMENT_MODES?.trim();
  if (settlementModes != null && settlementModes.length > 0) {
    serverCfg.settlementModes = settlementModes;
    serverCfg.settlementAddress = deriveSolanaAddress(identity.publicKey);
    log(`Settlement: modes="${settlementModes}" address=${serverCfg.settlementAddress}`);
  }

  // SPEND — sweep accrued earnings out of the service's identity wallet to an
  // operator-controlled destination. Opt-in via MOTEBIT_SWEEP_ADDRESS (only
  // meaningful for a P2P-enabled service that RECEIVES funds). Initial sweep on
  // boot + a periodic timer; the timer is unref'd (never keeps the process
  // alive) and cleared on shutdown. The service pays its own SOL gas
  // (wallet-solana CLAUDE.md rule 4) — fund it with a little SOL or sweeps fail.
  const sweepAddress = process.env.MOTEBIT_SWEEP_ADDRESS?.trim();
  const sweepRpcUrl = process.env.MOTEBIT_SOLANA_RPC_URL?.trim();
  if (
    sweepAddress != null &&
    sweepAddress.length > 0 &&
    sweepRpcUrl != null &&
    sweepRpcUrl.length > 0
  ) {
    const minMicro = BigInt(process.env.MOTEBIT_SWEEP_MIN_MICRO ?? "10000"); // $0.01 floor
    const intervalMs = Number(process.env.MOTEBIT_SWEEP_INTERVAL_MS ?? `${30 * 60 * 1000}`); // 30 min
    // Same mint-must-match-network rule as the money rail above: on devnet the
    // sweep rail must read the devnet-USDC ATA, not the mainnet default. Empty
    // or unset → undefined → the rail's mainnet-USDC default. Read here (a
    // covered boot line) so the fallback construction below stays branch-free.
    const sweepUsdcMint = process.env.MOTEBIT_SOLANA_USDC_MINT?.trim() || undefined;
    const wallet =
      adapters.createSweepWallet?.(sweepRpcUrl, identity.privateKey) ??
      createSolanaWalletRail({
        rpcUrl: sweepRpcUrl,
        identitySeed: identity.privateKey,
        usdcMint: sweepUsdcMint,
      });
    const doSweep = async (): Promise<void> => {
      try {
        const r = await sweepWalletRail(wallet, sweepAddress, minMicro);
        log(
          r.swept
            ? `Swept ${r.balanceMicro} micro-USDC → ${sweepAddress} (${r.signature})`
            : `Sweep skipped (${r.reason}; balance ${r.balanceMicro})`,
        );
      } catch (err: unknown) {
        log(`Sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void doSweep();
    const sweepTimer = setInterval(() => void doSweep(), intervalMs);
    if (typeof sweepTimer.unref === "function") sweepTimer.unref();
    const prevOnStop = serverCfg.onStop;
    serverCfg.onStop = () => {
      clearInterval(sweepTimer);
      prevOnStop?.();
    };
    log(`Sweep enabled → ${sweepAddress} (every ${intervalMs}ms, min ${minMicro} micro)`);
  }

  return startServer(deps, serverCfg);
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Default boot logger — timestamped console.log. Matches the inline
 * logger every service was defining at the top of its index.ts.
 * Services are CLI processes; console output IS the log sink here,
 * same reason mcp-server's default logger ships to console.warn.
 */
export function defaultLog(msg: string): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console -- intentional: services log to stdout
  console.log(`[${ts}] ${msg}`);
}

/**
 * Default runtime factory — constructs a real `MotebitRuntime` with a
 * `NullRenderer` (headless service). Tests override via
 * `adapters.createRuntime`. Exported so test code can exercise the
 * production path without re-instantiating the runner pipeline.
 */
export function defaultCreateRuntime(
  identity: BootstrapAndEmitIdentityResult,
  storage: StorageAdapters,
  tools: ToolRegistry,
  policyOverrides: Partial<PolicyConfig>,
): RunnerRuntime {
  return new MotebitRuntime(
    { motebitId: identity.motebitId, policy: { ...policyOverrides } },
    { storage, renderer: new NullRenderer(), tools },
  ) as unknown as RunnerRuntime;
}

/**
 * Re-export `ExecutionReceipt` so services assembling delegation chains
 * don't have to add a second `@motebit/sdk` import line alongside their
 * runner import.
 */
export type { ExecutionReceipt };
