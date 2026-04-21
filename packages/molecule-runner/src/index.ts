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
import type { PolicyConfig, StorageAdapters } from "@motebit/runtime";
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
   * Override local embed function. Default: `embedText` from @motebit/memory-graph.
   * Pass `null` to disable memory embedding entirely (no queryMemories/storeMemory
   * synthetic tools).
   */
  embedText?: ((text: string) => Promise<number[]>) | null;
  /** Override server start. Default: `startServiceServer` from @motebit/mcp-server. */
  startServer?: typeof startServiceServer;
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

  // 3. Build molecule-specific pieces
  const molecule = await build(identity);

  // 4. Storage + runtime
  const storage = assembleStorageAdapters(db);
  const policyOverrides = molecule.policyOverrides ?? DEFAULT_POLICY_OVERRIDES;
  const createRuntime = adapters.createRuntime ?? defaultCreateRuntime;

  const runtime = createRuntime(identity, storage, molecule.toolRegistry, policyOverrides);
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
