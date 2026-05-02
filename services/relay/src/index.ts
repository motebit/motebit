/**
 * @motebit/relay — Sync relay
 *
 * Thin event relay for cross-device sync. No AI, no memory, no state.
 * Devices run MotebitRuntime locally; this server is just an event mailbox.
 *
 * Endpoints:
 *   GET  /health                                       — health check (public)
 *   WS   /ws/sync/:motebitId                           — bidirectional event stream (primary)
 *   POST /sync/:motebitId/push                         — push events (HTTP fallback)
 *   GET  /sync/:motebitId/pull                         — pull events (HTTP fallback)
 *   GET  /sync/:motebitId/clock                        — latest version clock
 *   POST /sync/:motebitId/conversations                — push conversations
 *   GET  /sync/:motebitId/conversations?since=<ts>     — pull conversations
 *   POST /sync/:motebitId/messages                     — push conversation messages
 *   GET  /sync/:motebitId/messages?conversation_id=&since= — pull conversation messages
 *   POST /sync/:motebitId/plans                          — push plans
 *   GET  /sync/:motebitId/plans?since=<ts>               — pull plans
 *   POST /sync/:motebitId/plan-steps                     — push plan steps
 *   GET  /sync/:motebitId/plan-steps?since=<ts>          — pull plan steps
 *   POST /identity                                     — create identity for device registration
 *   GET  /identity/:motebitId                          — load identity
 *   GET  /api/v1/state/:motebitId                      — current state vector
 *   GET  /api/v1/memory/:motebitId                     — all memory nodes + edges
 *   DELETE /api/v1/memory/:motebitId/:nodeId           — tombstone a memory node
 *   GET  /api/v1/goals/:motebitId                      — list goals
 *   GET  /api/v1/conversations/:motebitId              — list conversations
 *   GET  /api/v1/conversations/:motebitId/:id/messages — conversation messages
 *   GET  /api/v1/devices/:motebitId                    — registered devices
 *   GET  /api/v1/audit/:motebitId                      — tool audit log
 *   GET  /api/v1/plans/:motebitId                      — list plans with steps
 *   GET  /api/v1/plans/:motebitId/:planId              — single plan with steps
 *   GET  /api/v1/execution/:motebitId/:goalId          — execution ledger manifest
 *   GET  /api/v1/agent-trust/:motebitId                 — agent trust records
 *   GET  /api/v1/gradient/:motebitId?limit=100         — intelligence gradient snapshots
 *   GET  /api/v1/sync/:motebitId/pull                  — pull events (aliased for admin)
 *   POST /api/v1/agents/register                       — register/refresh agent MCP endpoint
 *   POST /api/v1/agents/heartbeat                      — refresh agent TTL
 *   GET  /api/v1/agents/discover?capability=&motebit_id=&limit= — discover agents
 *   GET  /api/v1/agents/:motebitId                     — get specific agent
 *   DELETE /api/v1/agents/deregister                   — remove agent registration
 *   POST /api/v1/agents/:motebitId/listing              — register/update service listing
 *   GET  /api/v1/agents/:motebitId/listing              — get service listing
 *   GET  /api/v1/agents/:motebitId/credentials?type=&limit=  — credentials issued to agent
 *   POST /api/v1/agents/:motebitId/credentials/submit        — peer submits collected credentials for relay indexing
 *   POST /api/v1/agents/:motebitId/presentation?type=  — bundle credentials into signed VP
 *   POST /agent/:motebitId/ledger                       — submit signed execution ledger
 *   GET  /agent/:motebitId/ledger/:goalId               — retrieve signed execution ledger
 *   POST /api/v1/agents/:motebitId/revoke-tokens             — blacklist specific token JTIs (agent auth)
 *   POST /api/v1/agents/:motebitId/revoke-credential        — revoke a verifiable credential (agent auth)
 *   POST /api/v1/agents/:motebitId/revoke                   — mark agent identity as revoked (agent auth)
 *   GET  /api/v1/credentials/:credentialId/status            — credential revocation status (public)
 *   POST /api/v1/credentials/verify                        — verify a VerifiableCredential (public)
 *   GET  /api/v1/market/candidates?capability=&max_budget=&limit= — scored candidate list (max_budget filters, x402 handles payment)
 *   POST /api/v1/agents/bootstrap                       — register identity + device in one unauthenticated call (rate-limited)
 *
 * WebSocket protocol:
 *   Client → Server:  { type: "push", events: EventLogEntry[] }
 *   Client → Server:  { type: "push_conversations", conversations: SyncConversation[] }
 *   Client → Server:  { type: "push_messages", messages: SyncConversationMessage[] }
 *   Server → Client:  { type: "event", event: EventLogEntry }
 *   Server → Client:  { type: "conversation", conversation: SyncConversation }
 *   Server → Client:  { type: "conversation_message", message: SyncConversationMessage }
 *   Server → Client:  { type: "ack", accepted: number }
 *   Server → Client:  { type: "ack_conversations", accepted: number }
 *   Server → Client:  { type: "ack_messages", accepted: number }
 */

import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { EventStore } from "@motebit/event-log";
import { IdentityManager } from "@motebit/core-identity";
import { createMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";
import { createLogger } from "./logger.js";
import { parseBoolEnv, parseFloatEnv, parseIntEnv } from "./env.js";
import { createRelaySchema } from "./schema.js";
import { createRelayConfigTable, loadFreezeState, persistFreeze } from "./freeze.js";
import { parseTokenPayloadUnsafe, verifySignedTokenForDevice } from "./auth.js";
import { registerMiddleware, registerAuthMiddleware } from "./middleware.js";
import { registerWebSocketRoutes } from "./websocket.js";
import type { ConnectedDevice } from "./websocket.js";
import { registerSyncRoutes, redactSensitiveEvents } from "./sync-routes.js";
import { createIdempotencyTable, cleanupIdempotencyKeys } from "./idempotency.js";
import {
  createFederationTables,
  initRelayIdentity,
  createFederationQueryCache,
  registerFederationRoutes,
  startHeartbeatLoop,
  startSettlementRetryLoop,
} from "./federation.js";
import type { RelayIdentity } from "./federation.js";
import { startRevocationHorizonLoop } from "./horizon.js";
import {
  getAgentAnchorBatch,
  getAgentSettlementProof,
  isAgentSettlementPendingBatch,
  startAgentSettlementAnchorLoop,
  startBatchAnchorLoop,
} from "./anchoring.js";
import {
  startCredentialAnchorLoop,
  getCredentialAnchorProof,
  getCredentialAnchorBatch,
  isCredentialPendingBatch,
  listCredentialAnchorBatches,
  getCredentialAnchoringStats,
  type CredentialAnchoringConfig,
} from "./credential-anchoring.js";
import { aggregateFees } from "./fees.js";
import { aggregateHealthSummary } from "./health-summary.js";
import { startDepositDetector } from "./deposit-detector.js";
import {
  startTreasuryReconciliationLoop,
  getTreasuryReconciliationStats,
  listTreasuryReconciliations,
} from "./treasury-reconciliation.js";
import { registerCredentialRoutes } from "./credentials.js";
import { registerProxyTokenRoutes, createSubscriptionTables } from "./subscriptions.js";
import {
  StripeSubscriptionEventAdapter,
  type SubscriptionEventAdapter,
} from "./webhooks/stripe-webhook-adapter.js";
import { registerA2ARoutes } from "./a2a-bridge.js";
import { registerReceiptExchangeRoutes } from "./receipt-exchange.js";
import { getStoredReceiptJson } from "./receipts-store.js";
import {
  registerOnrampRoutes,
  StripeCryptoOnrampAdapter,
  HttpStripeCryptoClient,
  type OnrampAdapter,
} from "./onramp.js";
import { registerOfframpRoutes, BridgeOfframpAdapter, type OfframpAdapter } from "./offramp.js";
import { createTaskRouter } from "./task-routing.js";
import { createDataSyncTables, registerDataSyncRoutes } from "./data-sync.js";
import {
  createAccountTables,
  createWithdrawalTables,
  createProofTable,
  createWalletTable,
  creditAccount,
  storeSettlementProof,
} from "./accounts.js";
import { createPairingTables, registerPairingRoutes } from "./pairing.js";
import { registerStateExportRoutes } from "./state-export.js";
import { registerTrustGraphRoutes } from "./trust-graph.js";
import { registerListingsRoutes } from "./listings.js";
import { registerProposalRoutes } from "./proposals.js";
import { registerKeyRotationRoutes } from "./key-rotation.js";
import { registerBudgetRoutes } from "./budget.js";
import { startSweepLoop } from "./sweep.js";
import { startBatchWithdrawalLoop, getPendingWithdrawalsSummary } from "./batch-withdrawals.js";
import { registerAgentRoutes } from "./agents.js";
import { createFederationCallbacks } from "./federation-callbacks.js";
import { registerTaskRoutes } from "./tasks.js";
import { TaskQueue } from "./task-queue.js";
import { registerCommandRoutes, handleCommandResponse } from "./command-route.js";
import Stripe from "stripe";
import {
  SettlementRailRegistry,
  StripeSettlementRail,
  X402SettlementRail,
  BridgeSettlementRail,
} from "@motebit/settlement-rails";

// === Re-exports for backward compatibility (tests and sibling modules import from index) ===

export { parseTokenPayloadUnsafe, verifySignedTokenForDevice } from "./auth.js";
export type { TokenPayload } from "./auth.js";
export type { ConnectedDevice } from "./websocket.js";

// === Config ===

/** x402 payment configuration — the relay's settlement layer. */
export interface X402Config {
  /** Relay operator's wallet address — receives platform fees. */
  payToAddress: string;
  /** CAIP-2 network identifier (e.g. "eip155:8453" for Base mainnet, "eip155:84532" for Base Sepolia). */
  network: string;
  /** x402 facilitator URL. Default: "https://x402.org/facilitator" (testnet). */
  facilitatorUrl?: string;
  /** Whether this is testnet. Default: true. */
  testnet?: boolean;
}

/** Callback to query shutdown state. Injected by standalone boot, unused in tests. */
export type ShutdownStateGetter = () => boolean;

export interface SyncRelayConfig {
  dbPath?: string;
  apiToken?: string; // Legacy single token (still supported as admin/master token)
  corsOrigin?: string;
  enableDeviceAuth?: boolean; // When true, validates per-device tokens (default: true)
  /** x402 on-chain payment for task submission. Required in production. */
  x402: X402Config;
  /** When true, relay issues AgentReputationCredentials on verified receipts. Default: false (peer-issued). */
  issueCredentials?: boolean;
  /** When true, relay starts in emergency freeze mode — all write operations are suspended. */
  emergencyFreeze?: boolean;
  /** Shutdown state getter — health check returns 503 when true. Injected by standalone boot. */
  getShuttingDown?: ShutdownStateGetter;
  /** Max pending tasks per submitter. Default: 1000. */
  maxTasksPerSubmitter?: number;
  /** Federation configuration. Omit to disable federation. */
  federation?: {
    /** Display name for this relay in the federation. */
    displayName?: string;
    /** Public endpoint URL for this relay (how peers reach us). */
    endpointUrl?: string;
    /** Enable/disable federation entirely. Default: true when endpointUrl is set. */
    enabled?: boolean;
    /** Maximum number of active peers. Default: 50. */
    maxPeers?: number;
    /** Auto-accept incoming peering proposals. Default: false. */
    autoAcceptPeers?: boolean;
    /** Allowlist of relay IDs that can peer. Empty = allow any. */
    allowedPeers?: string[];
    /** Blocklist of relay IDs that cannot peer. Takes precedence over allowlist. */
    blockedPeers?: string[];
    /**
     * Per-request timeout for outbound `POST /federation/v1/horizon/witness`
     * solicitations during a horizon advance (phase 4b-3). Default 10s.
     */
    witnessSolicitationTimeoutMs?: number;
    /**
     * Periodic interval for the revocation-events horizon advance loop.
     * Default 1h. Operational tuning knob (not a doctrinal commitment).
     */
    revocationHorizonIntervalMs?: number;
  };
  /** Platform fee rate for settlement (0–1). Default: 0.05 (5%). Protocol supports any value. */
  platformFeeRate?: number;
  /**
   * Passphrase for encrypting the relay's identity key at rest. When set,
   * the relay's Ed25519 private key is AES-GCM encrypted with a key derived
   * via PBKDF2-600K from this passphrase. Omit for plaintext storage.
   *
   * Passed explicitly rather than read from env at call-site so library
   * embedders, tests, and multi-tenant deployments can inject it.
   * Standalone `createSyncRelayStandalone` reads `MOTEBIT_RELAY_KEY_PASSPHRASE`
   * from the environment and sets this field.
   */
  relayKeyPassphrase?: string;
  /** Stripe Checkout configuration. Omit to disable Stripe deposits. */
  stripe?: {
    secretKey: string;
    webhookSecret: string;
    currency?: string; // default 'usd'
  };
  /**
   * Pluggable on-ramp adapter for the paved funding flow. When set,
   * `POST /api/v1/onramp/session` returns a redirect URL the surface
   * can open to launch the provider's hosted purchase flow (e.g.,
   * Stripe Crypto Onramp). When omitted, the endpoint returns 503.
   *
   * The default behavior when `stripe.secretKey` is configured is to
   * auto-construct a `StripeCryptoOnrampAdapter` using the same
   * secret key. Pass an explicit adapter here to override (e.g., to
   * inject a mock adapter in tests, or to plug in a different provider
   * like MoonPay or Ramp Network).
   */
  onramp?: OnrampAdapter;
  /**
   * Pluggable off-ramp adapter for the crypto→fiat withdrawal flow.
   * When set, `POST /api/v1/offramp/session` creates a Bridge transfer
   * and returns deposit instructions (the motebit sends USDC to Bridge's
   * deposit address, Bridge converts and ACH's to the user's bank).
   * When omitted, the endpoint returns 503.
   *
   * Auto-constructed from `bridge.apiKey` when Bridge is configured.
   */
  offramp?: OfframpAdapter;
  /** Bridge.xyz configuration. Omit to disable Bridge orchestration rail. */
  bridge?: {
    /** Bridge API key. */
    apiKey: string;
    /** Bridge customer ID for the relay operator. */
    customerId: string;
    /** Source payment rail for withdrawals (e.g., "base"). Default: "base". */
    sourcePaymentRail?: string;
    /** Source currency (e.g., "usdc"). Default: "usdc". */
    sourceCurrency?: string;
    /** Bridge API base URL. Default: "https://api.bridge.xyz/v0". */
    baseUrl?: string;
    /** Webhook public key (PEM) for signature verification. Omit to skip verification (dev only). */
    webhookPublicKey?: string;
  };
  /**
   * STAGING/development-only: deterministic vote policy for the §6.2
   * federation orchestrator's peer-side vote-request endpoint. When set,
   * every incoming /federation/v1/disputes/:disputeId/vote-request
   * returns this outcome. Used by `scripts/test-federation-live.mjs`
   * Phase 8 to satisfy the gate-6 vote_policy_configured check across
   * the K4 staging mesh.
   *
   * Production relays MUST leave this undefined — the safe default is
   * 501 `policy_not_configured` per `spec/relay-federation-v1.md`
   * §16.2 mandate-callback semantics. Standalone `createSyncRelayStandalone`
   * reads `MOTEBIT_TEST_VOTE_POLICY` from the environment and emits a
   * startup-log warning when set.
   */
  testVotePolicy?: "upheld" | "overturned" | "split";
}

export interface SyncRelay {
  app: Hono;
  close(): Promise<void>;
  /** Connected WebSocket clients per motebitId. Exposed for testing. */
  connections: Map<string, ConnectedDevice[]>;
  /** Persistent relay identity. Stable across restarts. */
  relayIdentity: {
    relayMotebitId: string;
    publicKeyHex: string;
    did: string;
  };
  /** Database handle. Exposed for testing (plan store, audit sink, etc.). */
  moteDb: MotebitDatabase;
  /** Whether the relay is in emergency freeze mode (all writes suspended). */
  emergencyFreeze: boolean;
  /** Total number of connected WebSocket clients across all identities. */
  getConnectionCount(): number;
  /** Whether the relay is currently draining WebSocket connections. */
  isDraining: boolean;
}

// === Factory ===

export async function createSyncRelay(config: SyncRelayConfig): Promise<SyncRelay> {
  const {
    dbPath = ":memory:",
    apiToken,
    corsOrigin = "*",
    enableDeviceAuth = true,
    x402: x402Config,
    // Note: this fallback-to-env read exists for library-mode embedders
    // (tests, programmatic use) that don't go through the standalone boot
    // path. The standalone boot path in `createSyncRelayStandalone` reads
    // every env var explicitly and passes them as config fields, so this
    // branch is never taken from production.
    issueCredentials = parseBoolEnv("MOTEBIT_RELAY_ISSUE_CREDENTIALS", false),
    federation: federationConfig,
    stripe: stripeConfig,
    bridge: bridgeConfig,
    onramp: onrampOverride,
    offramp: offrampOverride,
    platformFeeRate = parseFloatEnv("MOTEBIT_PLATFORM_FEE_RATE", 0.05),
  } = config;

  const stripeClient = stripeConfig ? new Stripe(stripeConfig.secretKey) : null;
  const subscriptionEventAdapter: SubscriptionEventAdapter | null =
    stripeClient && stripeConfig
      ? new StripeSubscriptionEventAdapter({
          stripeClient,
          webhookSecret: stripeConfig.webhookSecret,
        })
      : null;

  // Strict driver — requires native better-sqlite3 (declared directly in
  // services/relay/package.json so `pnpm deploy --prod` flattens it into the
  // runtime image). The sql.js WASM fallback in `openMotebitDatabase` is
  // reserved for exotic-platform consumers (CLI scaffold on Nix/WSL) — a
  // relay running on sql.js silently loses WAL + debounces writes with
  // full-file rewrites, which is wrong for the only centralized, durability-
  // sensitive node in the architecture. If better-sqlite3 is missing at
  // runtime we want a loud boot-time failure, not a silent downgrade.
  // See drift-defenses #42 and docs/doctrine/settlement-rails.md.
  const moteDb: MotebitDatabase = createMotebitDatabase(dbPath);
  const eventStore = new EventStore(moteDb.eventStore);
  const identityManager = new IdentityManager(moteDb.identityStorage, eventStore);

  // --- Tables from extracted modules (federation must precede relay schema for ALTER TABLE) ---
  createFederationTables(moteDb.db);
  createPairingTables(moteDb.db);
  createDataSyncTables(moteDb.db);
  createAccountTables(moteDb.db);
  createWithdrawalTables(moteDb.db);
  createProofTable(moteDb.db);
  createWalletTable(moteDb.db);
  createIdempotencyTable(moteDb.db);

  // --- Settlement rail registry (after DB + tables so proofs can persist) ---
  const railRegistry = new SettlementRailRegistry();
  const proofCallback =
    (railName: string) =>
    (
      settlementId: string,
      proof: { reference: string; railType: string; network?: string; confirmedAt: number },
    ) =>
      storeSettlementProof(moteDb.db, settlementId, proof, railName);

  if (stripeClient && stripeConfig) {
    railRegistry.register(
      new StripeSettlementRail({
        stripeClient,
        webhookSecret: stripeConfig.webhookSecret,
        currency: stripeConfig.currency,
        onProofAttached: proofCallback("stripe"),
        logger: createLogger({ service: "stripe-rail" }),
      }),
    );
  }
  if (x402Config?.payToAddress) {
    try {
      // Single canonical adapter — chooses CDP vs default facilitator based on
      // env shape, fail-fast on mainnet misconfiguration. See x402-facilitator.ts.
      const { createX402FacilitatorClient } = await import("./x402-facilitator.js");
      const facilitatorClient = (await createX402FacilitatorClient(
        x402Config,
      )) as ConstructorParameters<typeof X402SettlementRail>[0]["facilitatorClient"];
      railRegistry.register(
        new X402SettlementRail({
          facilitatorClient,
          network: x402Config.network,
          payToAddress: x402Config.payToAddress,
          onProofAttached: proofCallback("x402"),
          logger: createLogger({ service: "x402-rail" }),
        }),
      );
    } catch (err) {
      // Mainnet-credential-missing is fail-fast: refuse to boot rather than
      // start in a half-mainnet state. Other errors (transient import failure
      // in test environments without @x402/core) preserve the prior soft-warn.
      const { X402ConfigError } = await import("./x402-facilitator.js");
      if (err instanceof X402ConfigError) throw err;
      console.warn(
        "x402 settlement rail not registered:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (bridgeConfig) {
    const baseUrl = bridgeConfig.baseUrl ?? "https://api.bridge.xyz/v0";
    const bridgeApiKey = bridgeConfig.apiKey;
    const bridgeClient: import("@motebit/settlement-rails").BridgeClient = {
      async createTransfer(params) {
        const res = await fetch(`${baseUrl}/transfers`, {
          method: "POST",
          headers: {
            "Api-Key": bridgeApiKey,
            "Content-Type": "application/json",
            "Idempotency-Key": params.idempotencyKey,
          },
          body: JSON.stringify({
            on_behalf_of: params.onBehalfOf,
            amount: params.amount,
            source: {
              currency: params.sourceCurrency,
              payment_rail: params.sourcePaymentRail,
            },
            destination: {
              currency: params.destinationCurrency,
              payment_rail: params.destinationPaymentRail,
              ...(params.destinationAddress ? { to_address: params.destinationAddress } : {}),
              ...(params.externalAccountId
                ? { external_account_id: params.externalAccountId }
                : {}),
            },
          }),
        });
        if (!res.ok) throw new Error(`Bridge API: ${res.status} ${res.statusText}`);
        const data = (await res.json()) as Record<string, unknown>;
        return {
          id: data.id as string,
          state: data.state as string,
          amount: data.amount as string,
          receipt: data.receipt as
            | { sourceTxHash?: string; destinationTxHash?: string }
            | undefined,
          source: data.source as { paymentRail: string } | undefined,
          destination: data.destination as { paymentRail: string } | undefined,
        };
      },
      async getTransfer(transferId) {
        const res = await fetch(`${baseUrl}/transfers/${transferId}`, {
          headers: { "Api-Key": bridgeApiKey },
        });
        if (!res.ok) throw new Error(`Bridge API: ${res.status} ${res.statusText}`);
        const data = (await res.json()) as Record<string, unknown>;
        return {
          id: data.id as string,
          state: data.state as string,
          amount: data.amount as string,
          receipt: data.receipt as
            | { sourceTxHash?: string; destinationTxHash?: string }
            | undefined,
          source: data.source as { paymentRail: string } | undefined,
          destination: data.destination as { paymentRail: string } | undefined,
        };
      },
      async isReachable() {
        try {
          const res = await fetch(`${baseUrl}/transfers?limit=1`, {
            headers: { "Api-Key": bridgeApiKey },
          });
          return res.ok;
        } catch {
          return false;
        }
      },
    };
    railRegistry.register(
      new BridgeSettlementRail({
        bridgeClient: bridgeClient,
        customerId: bridgeConfig.customerId,
        sourcePaymentRail: bridgeConfig.sourcePaymentRail ?? "base",
        sourceCurrency: bridgeConfig.sourceCurrency ?? "usdc",
        onProofAttached: proofCallback("bridge"),
        logger: createLogger({ service: "bridge-rail" }),
      }),
    );
  }
  createSubscriptionTables(moteDb.db);

  // --- Schema: relay-owned tables, migrations, startup cleanup ---
  const { isTokenBlacklisted, isAgentRevoked } = createRelaySchema(moteDb.db);
  createRelayConfigTable(moteDb.db);

  // Emergency freeze: persistent kill switch. When true, all state-mutating
  // operations (POST/PUT/PATCH/DELETE) return 503. Reads remain available.
  // State persisted to SQLite — survives relay restart.
  const persistedFreeze = loadFreezeState(moteDb.db);
  const freezeState = {
    frozen: persistedFreeze.frozen,
    reason: persistedFreeze.reason,
  };
  // Config override: emergencyFreeze=true forces freeze and persists it
  if (config.emergencyFreeze && !freezeState.frozen) {
    persistFreeze(moteDb.db, freezeState, true, "startup");
  }
  const getEmergencyFreeze = () => freezeState.frozen;
  const getFreezeReason = () => freezeState.reason;

  // Graceful shutdown state — readiness probe reports not_ready while draining.
  let draining = false;
  const DRAIN_GRACE_MS = 5_000;

  // --- Shared state ---
  const connections = new Map<string, ConnectedDevice[]>();

  const TASK_TTL_MS = 10 * 60 * 1000; // 10 minutes
  const MAX_TASK_QUEUE_SIZE = 100_000;
  const MAX_TASKS_PER_SUBMITTER = config.maxTasksPerSubmitter ?? 1_000;
  const taskQueue = new TaskQueue(moteDb.db);

  // --- Relay Identity: persistent Ed25519 keypair ---
  const relayIdentity: RelayIdentity = await initRelayIdentity(
    moteDb.db,
    config.relayKeyPassphrase,
  );

  // --- Task routing & federation query cache ---
  const taskRouter = createTaskRouter({ db: moteDb.db, relayIdentity, federationConfig });
  const { cache: federationQueryCache, pruneInterval: federationQueryPruneInterval } =
    createFederationQueryCache();

  // --- Hono app & WebSocket ---
  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- hono utility functions, not bound methods
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const logger = createLogger({ service: "relay" });

  // --- Settlement rail manifest: log at boot so missing env-var gating is
  // visible. A rail registered at config time but not listed here means the
  // adapter silently disabled itself. Mirrors /health/ready's rails section.
  const railManifest = railRegistry.manifest();
  logger.info("relay.rails.manifest", {
    count: railManifest.length,
    rails: railManifest.map((r) => r.name),
    by_type: railManifest.reduce<Record<string, string[]>>((acc, r) => {
      (acc[r.railType] ??= []).push(r.name);
      return acc;
    }, {}),
  });

  // --- Middleware (rate limiting, CORS, security headers, auth, error handling, health) ---
  const { allLimiters, wsLimiter } = registerMiddleware({
    app,
    apiToken,
    corsOrigin,
    enableDeviceAuth,
    identityManager,
    getEmergencyFreeze,
    getFreezeReason,
    isTokenBlacklisted,
    isAgentRevoked,
    verifySignedTokenForDevice,
    parseTokenPayloadUnsafe,
    getShuttingDown: config.getShuttingDown,
    getConnectionCount: () => getConnectionCount(),
    isDraining: () => draining,
    healthCheckDeps: {
      dbProbe: () => {
        const start = performance.now();
        moteDb.db.prepare("SELECT 1").get();
        return Math.round(performance.now() - start);
      },
      getTaskQueueSize: () => taskQueue.size,
      taskQueueCapacity: MAX_TASK_QUEUE_SIZE,
      isDraining: () => draining,
      getRailManifest: () => railRegistry.manifest(),
    },
  });

  // --- Cleanup interval (task expiry, limiter cleanup, stale allocations) ---
  // Stays in index.ts because it touches the local taskQueue map and allLimiters array.
  const taskCleanupInterval = setInterval(() => {
    const now = Date.now();
    // Expire completed/failed tasks and tasks past their TTL
    taskQueue.cleanup(now);
    // Evict oldest entries if queue exceeds hard cap (defensive against flooding)
    const evicted = taskQueue.evict(MAX_TASK_QUEUE_SIZE);
    if (evicted > 0) {
      logger.warn("task_queue.eviction", { evicted, remaining: taskQueue.size });
    }
    // Janitor: reap long-abandoned agent registrations. `expires_at` is a
    // 90-day lease set on register/heartbeat — not a visibility window.
    // Discoverability is driven by the `freshness` discriminant in
    // task-routing.ts; an agent stays findable while asleep and is only
    // removed here if no heartbeat arrived for 90 days (presumed dead).
    const stmtClean = moteDb.db.prepare("DELETE FROM agent_registry WHERE expires_at < ?");
    stmtClean.run(now);
    // Clean expired rate limit entries
    for (const limiter of allLimiters) {
      limiter.cleanup();
    }
    // Expire pending proposals past their TTL
    try {
      moteDb.db
        .prepare(
          "UPDATE relay_proposals SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at < ?",
        )
        .run(now, now);
    } catch {
      // Best-effort cleanup
    }
    // Clean stale service listings not updated in 7 days
    try {
      const listingCutoff = now - 7 * 24 * 60 * 60 * 1000;
      moteDb.db
        .prepare("DELETE FROM relay_service_listings WHERE updated_at < ?")
        .run(listingCutoff);
    } catch {
      // Best-effort cleanup
    }
    // Clean expired idempotency keys (older than 24 hours)
    try {
      cleanupIdempotencyKeys(moteDb.db);
    } catch {
      // Best-effort cleanup
    }
    // Reclaim deleted pages (works with auto_vacuum = INCREMENTAL)
    try {
      moteDb.db.pragma("incremental_vacuum(100)");
    } catch {
      // Best-effort — no-op if auto_vacuum mode differs
    }
    // Release stale budget allocations locked > 1 hour with no settlement.
    // Return held funds to the delegator's virtual account.
    try {
      const staleAllocations = moteDb.db
        .prepare(
          "SELECT allocation_id, task_id, motebit_id, amount_locked FROM relay_allocations WHERE status = 'locked' AND created_at < ?",
        )
        .all(now - 3_600_000) as Array<{
        allocation_id: string;
        task_id: string;
        motebit_id: string;
        amount_locked: number;
      }>;

      if (staleAllocations.length > 0) {
        moteDb.db.exec("BEGIN");
        try {
          for (const alloc of staleAllocations) {
            const taskEntry = taskQueue.get(alloc.task_id);
            const delegatorId = taskEntry?.submitted_by ?? alloc.motebit_id;
            creditAccount(
              moteDb.db,
              delegatorId,
              alloc.amount_locked,
              "allocation_release",
              alloc.allocation_id,
              `Stale allocation release for task ${alloc.task_id}`,
            );
          }
          moteDb.db
            .prepare(
              "UPDATE relay_allocations SET status = 'released', released_at = ? WHERE status = 'locked' AND created_at < ?",
            )
            .run(now, now - 3_600_000);
          moteDb.db.exec("COMMIT");
        } catch {
          moteDb.db.exec("ROLLBACK");
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }, 60_000);

  // --- WebSocket routes ---
  registerWebSocketRoutes({
    app,
    upgradeWebSocket,
    connections,
    taskQueue,
    eventStore,
    identityManager,
    db: moteDb.db,
    apiToken,
    enableDeviceAuth,
    wsLimiter,
    isTokenBlacklisted,
    isAgentRevoked,
    verifySignedTokenForDevice,
    parseTokenPayloadUnsafe,
    logger,
    onCommandResponse: handleCommandResponse,
    isDraining: () => draining,
  });

  // --- Sync routes (HTTP fallback, device registration, identity CRUD) ---
  registerSyncRoutes({ app, moteDb, eventStore, identityManager, connections });

  // --- Auth middleware for task/budget/admin routes (must run after registerMiddleware) ---
  registerAuthMiddleware({
    app,
    apiToken,
    corsOrigin,
    enableDeviceAuth,
    identityManager,
    getEmergencyFreeze,
    getFreezeReason,
    isTokenBlacklisted,
    isAgentRevoked,
    verifySignedTokenForDevice,
    parseTokenPayloadUnsafe,
  });

  // --- Federation routes ---
  const federationCallbacks = createFederationCallbacks({
    moteDb,
    identityManager,
    relayIdentity,
    connections,
    taskQueue,
    issueCredentials,
    maxTaskQueueSize: MAX_TASK_QUEUE_SIZE,
    maxTasksPerSubmitter: MAX_TASKS_PER_SUBMITTER,
    taskTtlMs: TASK_TTL_MS,
    platformFeeRate,
  });

  registerFederationRoutes({
    db: moteDb.db,
    app,
    relayIdentity,
    federationConfig,
    federationQueryCache,
    queryLocalAgents: (capability, motebitId, limit) =>
      taskRouter.queryLocalAgents(capability, motebitId, limit),
    getCircuitBreakerState: (peerEndpoint) => taskRouter.getCircuitBreakerState(peerEndpoint),
    onTaskForwarded: (v) => federationCallbacks.onTaskForwarded(v),
    onTaskResultReceived: (v) => federationCallbacks.onTaskResultReceived(v),
    onSettlementReceived: (v) => federationCallbacks.onSettlementReceived(v),
    // §6.2 federation orchestrator's peer-side vote callback. When
    // `testVotePolicy` is set (STAGING-only env var
    // `MOTEBIT_TEST_VOTE_POLICY`), wire a deterministic callback so
    // every incoming vote-request returns this outcome — used by the
    // K4 staging mesh's live-test Phase 8 to satisfy gate-6
    // `vote_policy_configured`. Production relays leave this undefined
    // and 501 incoming vote-requests per spec §16.2 mandate-callback
    // semantics.
    voteCallback: config.testVotePolicy
      ? () => ({
          vote: config.testVotePolicy!,
          rationale: `staging test policy: deterministic ${config.testVotePolicy}`,
        })
      : undefined,
  });

  // --- Discovery routes (discovery-v1.md §3, §5) ---
  const { registerDiscoveryRoutes } = await import("./discovery.js");
  registerDiscoveryRoutes({
    db: moteDb.db,
    app,
    relayIdentity,
    federationConfig,
    platformFeeRate,
  });

  // --- Migration routes (migration-v1.md) ---
  const { registerMigrationRoutes, createMigrationTables } = await import("./migration.js");
  createMigrationTables(moteDb.db);
  registerMigrationRoutes({
    db: moteDb.db,
    app,
    relayIdentity,
    federationConfig,
  });

  // --- Dispute routes (dispute-v1.md) ---
  const { registerDisputeRoutes, createDisputeTables, startDeferredOrchestrationWorker } =
    await import("./disputes.js");
  createDisputeTables(moteDb.db);
  registerDisputeRoutes({
    db: moteDb.db,
    app,
    relayIdentity,
  });
  // §6.2 deferred orchestrator worker — picks up `in_progress`
  // orchestration rows whose next_attempt_at <= now, drives retries
  // within the §6.6 72h adjudication window. Runs unconditionally
  // (mirrors sweep / batch-withdrawals) — when there are no in-flight
  // orchestrations, the cycle is a cheap SELECT against the indexed
  // `next_attempt_at` filter.
  const orchestrationWorkerInterval = startDeferredOrchestrationWorker({
    db: moteDb.db,
    relayIdentity,
  });
  logger.info("dispute_orchestration_worker.started");

  // --- Operator transparency routes (docs/doctrine/operator-transparency.md) ---
  // Stage 1.5: signed declaration at /.well-known/motebit-transparency.json,
  // admin view at /api/v1/admin/transparency. Onchain anchoring deferred to
  // Stage 2 (spec/relay-transparency-v1.md).
  const { registerTransparencyRoutes } = await import("./transparency.js");
  await registerTransparencyRoutes({ app, relayIdentity });

  // --- Retention manifest routes (docs/doctrine/retention-policy.md §"Self-attesting transparency") ---
  // Phase 6a: signed manifest at /.well-known/motebit-retention.json,
  // sibling to motebit-transparency.json. Stores enumerate as phase 4b-3
  // and phase 5 land their respective enforcement; today's manifest lists
  // the gaps explicitly.
  const { registerRetentionManifestRoutes } = await import("./retention-manifest.js");
  await registerRetentionManifestRoutes({ app, relayIdentity, db: moteDb.db });

  // --- Skills registry routes (skills-registry-v1.md) ---
  const { registerSkillRegistryRoutes, createSkillRegistryTables, parseFeaturedSubmitters } =
    await import("./skill-registry.js");
  createSkillRegistryTables(moteDb.db);
  registerSkillRegistryRoutes({
    db: moteDb.db,
    app,
    featuredSubmitters: parseFeaturedSubmitters(process.env.FEATURED_SKILL_SUBMITTERS),
  });

  // --- Proxy token + balance routes ---
  registerProxyTokenRoutes(app, moteDb.db, relayIdentity, subscriptionEventAdapter);

  // --- Credential routes ---
  registerCredentialRoutes({
    db: moteDb.db,
    app,
    relayIdentity,
    identityManager,
    issueCredentials,
  });

  // --- Credential anchoring config (populated during startup, used by admin endpoint) ---
  const credentialAnchorConfig: CredentialAnchoringConfig = {};
  let credentialAnchorAddress: string | null = null;

  // --- Credential anchor proof routes (credential-anchor-v1.md §7) ---
  /** @spec motebit/credential-anchor@1.0 */
  app.get("/api/v1/credentials/:credentialId/anchor-proof", async (c) => {
    const credentialId = c.req.param("credentialId");

    if (isCredentialPendingBatch(moteDb.db, credentialId)) {
      return c.json({ status: "pending", message: "Credential not yet batched" }, 202, {
        "Retry-After": "60",
      });
    }

    const proof = await getCredentialAnchorProof(moteDb.db, credentialId);
    if (!proof) {
      return c.json({ error: "Credential not found or not batched" }, 404);
    }

    return c.json(proof);
  });

  /** @spec motebit/credential-anchor@1.0 */

  app.get("/api/v1/credential-anchors/:batchId", (c) => {
    const batchId = c.req.param("batchId");
    const batch = getCredentialAnchorBatch(moteDb.db, batchId);
    if (!batch) {
      return c.json({ error: "Batch not found" }, 404);
    }
    return c.json(batch);
  });

  // --- Per-agent settlement anchor proof routes (audit follow-up #1, ceiling) ---
  // Self-attesting trust pyramid for per-agent settlements:
  //   - Signed SettlementRecord (workers fetch via existing settlement queries)
  //   - Merkle inclusion proof (this endpoint)
  //   - Onchain anchor reference (carried inside the proof)
  // External verifier flow: fetch SettlementRecord + proof + chain tx → verify
  // signature → reconstruct leaf → walk Merkle path → compare root to chain.
  // No relay contact needed beyond the initial proof fetch.
  /** @spec motebit/agent-settlement-anchor@1.0 */
  app.get("/api/v1/settlements/:settlementId/anchor-proof", async (c) => {
    const settlementId = c.req.param("settlementId");

    if (isAgentSettlementPendingBatch(moteDb.db, settlementId)) {
      return c.json({ status: "pending", message: "Settlement not yet batched" }, 202, {
        "Retry-After": "60",
      });
    }

    const proof = await getAgentSettlementProof(moteDb.db, settlementId);
    if (!proof) {
      return c.json({ error: "Settlement not found or not batched" }, 404);
    }

    return c.json(proof);
  });

  /** @spec motebit/agent-settlement-anchor@1.0 */

  app.get("/api/v1/settlement-anchors/:batchId", (c) => {
    const batchId = c.req.param("batchId");
    const batch = getAgentAnchorBatch(moteDb.db, batchId);
    if (!batch) {
      return c.json({ error: "Batch not found" }, 404);
    }
    return c.json(batch);
  });

  // Admin: credential anchoring overview (batches, stats, anchor address)
  /** @internal */
  app.get("/api/v1/admin/credential-anchoring", (c) => {
    const stats = getCredentialAnchoringStats(moteDb.db);
    const batches = listCredentialAnchorBatches(moteDb.db, 50);
    return c.json({
      stats,
      batches,
      anchor_address: credentialAnchorAddress,
      chain_enabled: credentialAnchorConfig.submitter != null,
    });
  });

  // Admin: treasury reconciliation overview (recent records + aggregated stats).
  // The reconciliation loop runs only on mainnet (X402_TESTNET=false); on
  // testnet this endpoint returns zero history with `loop_enabled=false`.
  // Sibling-but-distinct from `/api/v1/admin/credential-anchoring` — the
  // treasury observability primitive is documented in
  // `packages/treasury-reconciliation/CLAUDE.md` Rule 1; the relay-side
  // wiring lives in `services/relay/src/treasury-reconciliation.ts`.
  /** @internal */
  app.get("/api/v1/admin/treasury-reconciliation", (c) => {
    const stats = getTreasuryReconciliationStats(moteDb.db);
    const records = listTreasuryReconciliations(moteDb.db, 50);
    return c.json({
      stats,
      records,
      treasury_address: x402Config.payToAddress,
      chain: x402Config.network,
      loop_enabled: treasuryReconciliationInterval !== undefined,
    });
  });

  // Admin: byte-identical canonical JSON of a stored ExecutionReceipt.
  // Keyed by (motebitId, taskId) — matches the composite PK in
  // relay_receipts. Response body is the exact bytes canonicalJson
  // produced at ingestion, so an auditor can strip `signature`,
  // re-canonicalize the body, and re-verify Ed25519 against
  // `public_key` without relay contact.
  /** @internal */
  app.get("/api/v1/admin/receipts/:motebitId/:taskId", (c) => {
    const json = getStoredReceiptJson(moteDb.db, c.req.param("motebitId"), c.req.param("taskId"));
    if (json == null) {
      return c.json({ error: "not_found" }, 404);
    }
    return new Response(json, {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  });

  // Admin: pending aggregated withdrawal queue summary.
  // Shows operators how many items are queued per rail, total aggregated
  // value, and the age of the oldest pending row — enough to spot a
  // policy misfire or a rail outage without querying the DB directly.
  /** @internal */
  app.get("/api/v1/admin/pending-withdrawals", (c) => {
    return c.json(getPendingWithdrawalsSummary(moteDb.db));
  });

  // Admin: settlement stats by mode (relay vs p2p) + recent p2p settlements
  /** @internal */
  app.get("/api/v1/admin/settlements", async (c) => {
    const { getSettlementStatsByMode, getRecentP2pSettlements } = await import("./p2p-verifier.js");
    const statsByMode = getSettlementStatsByMode(moteDb.db);
    const recentP2p = getRecentP2pSettlements(moteDb.db, 50);
    return c.json({
      stats_by_mode: statsByMode,
      recent_p2p: recentP2p,
      p2p_verifier_enabled: !!solanaRpcUrl,
    });
  });

  // Admin: operator health summary — registered motebits + activity
  // windows, federation peer state + cross-relay settlement volume,
  // task settlements + fees over 7d/30d. Single SQL aggregation pass;
  // returns honest zeros where the data is genuinely zero. The
  // operator console's Health panel reads this verbatim — answers
  // "is the relay being used, and by whom" without needing log-shipping
  // or external analytics infrastructure.
  /** @internal */
  app.get("/api/v1/admin/health", (c) => {
    return c.json(aggregateHealthSummary(moteDb.db));
  });

  // Admin: platform-fee aggregation (5% of relay-mediated settlements).
  // Total + by-rail + by-period buckets over a `window_days` window
  // (default 30, capped at 365). Returned in micro-units; the operator
  // console converts at the boundary.
  /** @internal */
  app.get("/api/v1/admin/fees", (c) => {
    const raw = c.req.query("window_days");
    const parsed = raw != null ? Number.parseInt(raw, 10) : 30;
    const windowDays = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 365) : 30;
    return c.json(aggregateFees(moteDb.db, platformFeeRate, windowDays));
  });

  // --- Pairing routes ---
  registerPairingRoutes({
    db: moteDb.db,
    app,
    apiToken,
    identityManager,
    parseTokenPayloadUnsafe,
    verifySignedTokenForDevice,
    isTokenBlacklisted,
    isAgentRevoked,
  });

  // --- State export routes (read-only agent state queries) ---
  registerStateExportRoutes({ app, moteDb, eventStore, identityManager, redactSensitiveEvents });

  // --- Trust graph routes ---
  registerTrustGraphRoutes({ app, moteDb, taskRouter });

  // --- Listings & market routes ---
  registerListingsRoutes({ app, moteDb, taskRouter });

  // --- Collaborative proposal routes ---
  registerProposalRoutes({ app, moteDb, connections });

  // --- Key rotation, revocation & approval routes ---
  registerKeyRotationRoutes({ app, moteDb, relayIdentity });

  // --- Data sync routes (conversations, messages, plans, plan steps) ---
  registerDataSyncRoutes({ db: moteDb.db, app, connections });

  // --- A2A protocol bridge ---
  // Federation endpoint: explicit config > localhost fallback for dev. No
  // vendor-specific derivation (formerly `https://${FLY_APP_NAME}.fly.dev`) —
  // a hosting-vendor fallback silently leaks one particular operator's
  // implementation into every deployment that forgets to set the env, and
  // `relay` is a protocol role, not a Fly app. Third-party relay operators
  // set MOTEBIT_FEDERATION_ENDPOINT_URL to their own branded URL; Motebit's
  // canonical relay sets it to relay.motebit.com. The only acceptable
  // fallback is localhost for local dev.
  const a2aRelayUrl =
    federationConfig?.endpointUrl ?? `http://localhost:${process.env.PORT ?? 3000}`;
  registerA2ARoutes(app, moteDb.db, {
    relayIdentity,
    relayUrl: a2aRelayUrl,
    relayVersion: "0.5.2",
  });

  // --- Sovereign receipt exchange (relay-mediated convenience tier) ---
  // The relay is a dumb pipe here: it routes SovereignReceiptRequest/
  // Response messages by motebit_id without inspecting or modifying
  // receipt contents. This is the paved fallback for motebits that
  // cannot reach each other directly (NAT-bound, dynamic IPs, offline
  // payee waiting for payer to come back online). Same doctrinal role
  // as multi-device sync: a legitimate meeting point, not an authority.
  // See services/relay/src/receipt-exchange.ts for the protocol.
  const receiptExchangeHub = registerReceiptExchangeRoutes(app);

  // --- Paved fiat → crypto on-ramp (Stripe Crypto Onramp by default) ---
  // Turns "your motebit has an address" into "click Fund, USDC arrives."
  // Priority: explicit adapter in config > auto-construct Stripe adapter
  // if Stripe secret key is present > null (endpoint returns 503).
  // Surfaces call POST /api/v1/onramp/session to get a redirect URL and
  // open it in a new tab; the user completes the purchase on Stripe's
  // hosted page; USDC arrives at the motebit's Solana address.
  // See services/relay/src/onramp.ts for the adapter pattern.
  const onrampAdapter: OnrampAdapter | null =
    onrampOverride ??
    (stripeConfig
      ? new StripeCryptoOnrampAdapter({
          client: new HttpStripeCryptoClient({ secretKey: stripeConfig.secretKey }),
        })
      : null);
  registerOnrampRoutes(app, onrampAdapter, process.env.SOLANA_RPC_URL);

  // --- Paved crypto → fiat off-ramp (Bridge by default) ---
  // Mirror of the on-ramp. User clicks "Withdraw to Bank", relay creates
  // a Bridge transfer, returns deposit instructions (motebit sends USDC to
  // Bridge's deposit address, Bridge converts and ACH's to user's bank).
  const offrampAdapter: OfframpAdapter | null =
    offrampOverride ??
    (bridgeConfig ? new BridgeOfframpAdapter({ apiKey: bridgeConfig.apiKey }) : null);
  registerOfframpRoutes(app, offrampAdapter);

  // --- Budget, accounts & admin routes (after auth middleware) ---
  registerBudgetRoutes({
    app,
    moteDb,
    relayIdentity,
    freezeState,
    stripeClient,
    stripeConfig: stripeConfig ?? null,
    railRegistry,
    bridgeWebhookPublicKey: bridgeConfig?.webhookPublicKey,
  });

  // --- Agent routes (registration, discovery, capabilities, settlements, ledger) ---
  registerAgentRoutes({
    app,
    moteDb,
    identityManager,
    eventStore,
    relayIdentity,
    connections,
    taskRouter,
    apiToken,
    federationConfig,
    federationQueryCache,
    parseTokenPayloadUnsafe,
    verifySignedTokenForDevice,
    isTokenBlacklisted,
    isAgentRevoked,
  });

  // --- Command endpoint (unified remote execution) ---
  registerCommandRoutes({ app, db: moteDb.db, connections, logger });

  // --- Federation background loops ---

  const heartbeatInterval = startHeartbeatLoop(moteDb.db, relayIdentity, 60_000, () =>
    getEmergencyFreeze(),
  );

  // Phase 4b-3 — periodic revocation-events horizon advance. Replaces
  // the old startup-time `cleanupRevocationEvents` sync purge with a
  // signed `append_only_horizon` cert (self-witnessed when no peers,
  // co-witnessed via Path A fan-out otherwise). Default 1h cadence;
  // override via `federationConfig.revocationHorizonIntervalMs`.
  const revocationHorizonInterval = startRevocationHorizonLoop(
    moteDb.db,
    { relayIdentity, witnessSolicitationTimeoutMs: federationConfig?.witnessSolicitationTimeoutMs },
    federationConfig?.revocationHorizonIntervalMs,
    () => getEmergencyFreeze(),
  );

  // Settlement retry loop callback touches taskQueue — stays in index.ts
  const settlementRetryInterval = startSettlementRetryLoop(
    moteDb.db,
    relayIdentity,
    30_000,
    (retry) => {
      const refundId = crypto.randomUUID();
      try {
        const taskEntry = taskQueue.get(retry.task_id);
        moteDb.db.exec("BEGIN");
        try {
          // Atomically claim the allocation: UPDATE ... WHERE status = 'locked' ensures
          // that if settlement already completed (status = 'settled'), this is a no-op.
          // This prevents the double-spend: settlement credits the worker AND refund credits
          // the delegator for the same locked funds.
          const claimResult = moteDb.db
            .prepare(
              "UPDATE relay_allocations SET status = 'released', released_at = ? WHERE task_id = ? AND status = 'locked'",
            )
            .run(Date.now(), retry.task_id);
          if (claimResult.changes === 0) {
            // Allocation was already settled or released — no refund needed
            moteDb.db.exec("ROLLBACK");
            logger.info("settlement.retry.refund_skipped", {
              retryId: retry.retry_id,
              taskId: retry.task_id,
              reason: "allocation not in locked state (already settled or released)",
            });
            return;
          }
          // Allocation claimed — now safe to credit the delegator
          const alloc = moteDb.db
            .prepare(
              "SELECT allocation_id, motebit_id, amount_locked FROM relay_allocations WHERE task_id = ?",
            )
            .get(retry.task_id) as
            | { allocation_id: string; motebit_id: string; amount_locked: number }
            | undefined;
          if (!alloc) {
            moteDb.db.exec("ROLLBACK");
            return;
          }
          const delegatorId = taskEntry?.submitted_by ?? alloc.motebit_id;
          creditAccount(
            moteDb.db,
            delegatorId,
            alloc.amount_locked,
            "allocation_release",
            alloc.allocation_id,
            `Retry exhaustion refund for task ${retry.task_id}`,
          );
          // Persist refund record for audit trail
          moteDb.db
            .prepare(
              "INSERT OR IGNORE INTO relay_refund_log (refund_id, retry_id, task_id, allocation_id, delegator_id, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)",
            )
            .run(
              refundId,
              retry.retry_id,
              retry.task_id,
              alloc.allocation_id,
              delegatorId,
              alloc.amount_locked,
              Date.now(),
            );
          moteDb.db.exec("COMMIT");
          logger.info("settlement.retry.refunded", {
            refundId,
            taskId: retry.task_id,
            allocationId: alloc.allocation_id,
            amount: alloc.amount_locked,
            delegator: delegatorId,
          });
        } catch (txnErr) {
          moteDb.db.exec("ROLLBACK");
          // Log the failed refund attempt for operator visibility
          logger.error("settlement.retry.refund_txn_failed", {
            refundId,
            retryId: retry.retry_id,
            taskId: retry.task_id,
            error: txnErr instanceof Error ? txnErr.message : String(txnErr),
          });
        }
      } catch (err) {
        logger.error("settlement.retry.refund_error", {
          refundId,
          retryId: retry.retry_id,
          taskId: retry.task_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    () => getEmergencyFreeze(),
  );

  // --- Unified chain anchor submitter (Solana Memo by default) ---
  const solanaRpcUrl = process.env.SOLANA_RPC_URL;
  let anchorSubmitter: import("@motebit/sdk").ChainAnchorSubmitter | undefined;
  if (solanaRpcUrl) {
    const { createSolanaMemoSubmitter } = await import("@motebit/wallet-solana");
    const memoSubmitter = createSolanaMemoSubmitter({
      rpcUrl: solanaRpcUrl,
      identitySeed: relayIdentity.privateKey,
    });
    anchorSubmitter = memoSubmitter;
    credentialAnchorAddress = memoSubmitter.address;

    // Wire revocation anchoring — immediate onchain submission for key events
    const { setRevocationAnchorSubmitter } = await import("./federation.js");
    setRevocationAnchorSubmitter(memoSubmitter);

    logger.info("anchoring.solana_submitter_configured", {
      address: memoSubmitter.address,
      network: memoSubmitter.network,
      streams: ["settlement", "credential", "revocation"],
    });
  }

  // --- Settlement anchor batching (relay-federation-v1.md §7.6) ---
  const batchAnchorInterval = startBatchAnchorLoop(
    moteDb.db,
    relayIdentity,
    { submitter: anchorSubmitter },
    () => getEmergencyFreeze(),
  );

  // --- Per-agent settlement anchor batching (the "ceiling" parallel
  // to federation; closes services/relay/CLAUDE.md rule 6 "independently
  // verifiable onchain without relay contact" for per-agent settlements).
  // Same submitter, same trigger semantics as the federation loop above.
  const agentAnchorInterval = startAgentSettlementAnchorLoop(
    moteDb.db,
    relayIdentity,
    { submitter: anchorSubmitter },
    () => getEmergencyFreeze(),
  );

  // --- Credential anchor batching (credential-anchor-v1.md) ---
  credentialAnchorConfig.submitter = anchorSubmitter;
  const credentialAnchorInterval = startCredentialAnchorLoop(
    moteDb.db,
    relayIdentity,
    credentialAnchorConfig,
    () => getEmergencyFreeze(),
  );

  // --- Deposit detector (scans onchain Transfer events for agent wallets) ---
  const depositDetectorChain = x402Config.network;
  const depositDetectorInterval = startDepositDetector({
    db: moteDb.db,
    chain: depositDetectorChain,
  });

  // --- Treasury reconciliation (compares recorded x402 fees to onchain balance) ---
  // Sibling-but-distinct from the deposit detector — see
  // packages/treasury-reconciliation/CLAUDE.md Rule 1 for why these two
  // observability primitives must NOT be unified. This loop is the
  // operator-treasury observability hook for relay-mediated x402 fee
  // accumulation; the deposit detector is for per-agent USDC funding.
  //
  // Loop runs only on mainnet (X402_TESTNET=false). On testnet the
  // treasury balance is meaningless and reconciliation would be
  // trivially consistent at 0 forever — gate skips with a clear log.
  let treasuryReconciliationInterval: ReturnType<typeof setInterval> | undefined;
  {
    const { USDC_CONTRACTS, DEFAULT_RPC_URLS } = await import("./deposit-detector.js");
    const usdcContractAddress = USDC_CONTRACTS[x402Config.network];
    const rpcUrl = DEFAULT_RPC_URLS[x402Config.network];
    if (x402Config.testnet === false && x402Config.payToAddress && usdcContractAddress && rpcUrl) {
      const intervalMs = parseIntEnv("MOTEBIT_TREASURY_RECONCILIATION_INTERVAL_MS", 15 * 60_000);
      const { HttpJsonRpcEvmAdapter } = await import("@motebit/evm-rpc");
      const evmRpc = new HttpJsonRpcEvmAdapter({ rpcUrl });
      treasuryReconciliationInterval = startTreasuryReconciliationLoop({
        db: moteDb.db,
        rpc: evmRpc,
        chain: x402Config.network,
        treasuryAddress: x402Config.payToAddress,
        usdcContractAddress,
        intervalMs,
        isFrozen: () => getEmergencyFreeze(),
      });
    } else {
      logger.info("treasury-reconciliation.disabled", {
        reason:
          x402Config.testnet !== false
            ? "testnet mode (X402_TESTNET != false)"
            : !x402Config.payToAddress
              ? "X402_PAY_TO_ADDRESS not set"
              : !usdcContractAddress
                ? "no USDC contract registered for chain"
                : "no RPC URL registered for chain",
        chain: x402Config.network,
      });
    }
  }

  // --- P2P payment verifier (async onchain verification of direct settlements) ---
  let p2pVerifierInterval: ReturnType<typeof setInterval> | undefined;
  if (solanaRpcUrl) {
    const { startP2pVerifierLoop } = await import("./p2p-verifier.js");
    p2pVerifierInterval = startP2pVerifierLoop(moteDb.db, { rpcUrl: solanaRpcUrl }, () =>
      getEmergencyFreeze(),
    );
    logger.info("p2p_verifier.started", { intervalMs: 60000 });
  }

  // --- Auto-sweep loop (relay balance → sovereign wallet) ---
  const sweepInterval = startSweepLoop(moteDb.db, {}, () => getEmergencyFreeze());
  logger.info("sweep.started", { intervalMs: 300000 });

  // --- Batch withdrawal loop (aggregated-fire policy per rail) ---
  // Runs regardless of whether sweep is enqueueing — a future user-initiated
  // batch opt-in would enqueue into the same queue.
  const batchWithdrawalInterval = startBatchWithdrawalLoop(moteDb.db, railRegistry.list(), {}, () =>
    getEmergencyFreeze(),
  );

  // --- Task routes (submission, polling, receipt settlement) ---
  await registerTaskRoutes({
    app,
    moteDb,
    identityManager,
    eventStore,
    relayIdentity,
    connections,
    taskQueue,
    taskRouter,
    issueCredentials,
    apiToken,
    enableDeviceAuth,
    maxTasksPerSubmitter: MAX_TASKS_PER_SUBMITTER,
    x402Config: x402Config,
    parseTokenPayloadUnsafe,
    verifySignedTokenForDevice,
    isTokenBlacklisted,
    isAgentRevoked,
    platformFeeRate,
    railRegistry,
  });

  // --- Helper: count all connected WebSocket clients ---
  function getConnectionCount(): number {
    let count = 0;
    for (const peers of connections.values()) {
      count += peers.length;
    }
    return count;
  }

  // --- Close / cleanup with ordered WebSocket drain ---
  async function close(): Promise<void> {
    // Phase 1: Signal draining — reject new upgrades and notify connected clients
    draining = true;
    const totalBefore = getConnectionCount();
    logger.info("ws.drain.start", { connections: totalBefore });

    const drainingMsg = JSON.stringify({
      type: "server_draining",
      reconnect_after_ms: DRAIN_GRACE_MS,
    });
    for (const peers of connections.values()) {
      for (const peer of peers) {
        try {
          if (peer.ws.readyState === 1) {
            peer.ws.send(drainingMsg);
          }
        } catch {
          // Best-effort — client may already be disconnected
        }
      }
    }

    // Phase 2: Grace period — wait for clients to disconnect voluntarily
    if (totalBefore > 0) {
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(() => resolve(), DRAIN_GRACE_MS);
        // Check periodically if all clients left early
        const check = setInterval(() => {
          if (getConnectionCount() === 0) {
            clearTimeout(deadline);
            clearInterval(check);
            resolve();
          }
        }, 250);
      });
    }

    const remainingAfterGrace = getConnectionCount();
    logger.info("ws.drain.grace_complete", {
      disconnected: totalBefore - remainingAfterGrace,
      remaining: remainingAfterGrace,
    });

    // Phase 3: Force close — terminate remaining connections with 1001 (Going Away)
    for (const peers of connections.values()) {
      for (const peer of peers) {
        try {
          peer.ws.close(1001, "server shutting down");
        } catch {
          // Best-effort — already closed
        }
      }
    }
    connections.clear();

    logger.info("ws.drain.complete", { force_closed: remainingAfterGrace });

    // Clean up intervals and database
    clearInterval(taskCleanupInterval);
    clearInterval(federationQueryPruneInterval);
    clearInterval(heartbeatInterval);
    clearInterval(revocationHorizonInterval);
    clearInterval(settlementRetryInterval);
    clearInterval(batchAnchorInterval);
    clearInterval(agentAnchorInterval);
    clearInterval(credentialAnchorInterval);
    clearInterval(depositDetectorInterval);
    if (treasuryReconciliationInterval) clearInterval(treasuryReconciliationInterval);
    if (p2pVerifierInterval) clearInterval(p2pVerifierInterval);
    clearInterval(sweepInterval);
    clearInterval(batchWithdrawalInterval);
    clearInterval(orchestrationWorkerInterval);
    receiptExchangeHub.close();
    moteDb.close();
  }

  // Inject WebSocket support into the underlying Node.js server
  const originalApp = app as Hono & { injectWebSocket?: typeof injectWebSocket };
  originalApp.injectWebSocket = injectWebSocket;

  return {
    app,
    close,
    connections,
    relayIdentity: {
      relayMotebitId: relayIdentity.relayMotebitId,
      publicKeyHex: relayIdentity.publicKeyHex,
      did: relayIdentity.did,
    },
    moteDb,
    get emergencyFreeze() {
      return getEmergencyFreeze();
    },
    getConnectionCount,
    get isDraining() {
      return draining;
    },
  };
}

// Standalone boot lives in `./server.ts` — run `node dist/server.js`
// in production. `index.ts` is the library entry and stays
// side-effect-free so embedders (the CLI's `motebit relay up`,
// tests, multi-tenant hosts) can `import { createSyncRelay }`
// without triggering env reads, port binding, or signal handlers.
