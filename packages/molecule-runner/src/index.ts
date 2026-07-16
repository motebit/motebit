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

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { RiskLevel } from "@motebit/sdk";
import type { ExecutionReceipt } from "@motebit/sdk";
import { bootstrapAndEmitIdentity, startServiceServer, wireServerDeps } from "@motebit/mcp-server";
import {
  deriveSolanaAddress,
  createSolanaWalletRail,
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
import { MotebitRuntime, NullRenderer } from "@motebit/runtime";
import type { PolicyConfig, StorageAdapters, GrantedDelegationResult } from "@motebit/runtime";
import { signStandingDelegation, signDelegation, createSignedToken } from "@motebit/crypto";
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
    const now = Date.now();
    return createSignedToken(
      {
        mid: identity.motebitId,
        did,
        iat: now,
        exp: now + 5 * 60 * 1000,
        jti: crypto.randomUUID(),
        aud: audience,
      },
      pk,
    );
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
): RunnerRuntime {
  const money = config.moneyExecution;
  if (money == null) throw new Error("defaultCreateMoneyRuntime called without moneyExecution");
  const wallet = createSolanaWalletRail({
    rpcUrl: money.solanaRpcUrl,
    identitySeed: identity.privateKey,
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
    const wallet =
      adapters.createSweepWallet?.(sweepRpcUrl, identity.privateKey) ??
      createSolanaWalletRail({ rpcUrl: sweepRpcUrl, identitySeed: identity.privateKey });
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
