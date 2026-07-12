/**
 * Agent registration, discovery, capabilities, settlements, ledger, and verification routes.
 */

import type { Hono, Context } from "hono";
import type { TokenAudience } from "@motebit/protocol";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase, DatabaseDriver } from "@motebit/persistence";
import type { IdentityManager } from "@motebit/core-identity";
import type { EventStore } from "@motebit/event-log";
import { asMotebitId } from "@motebit/sdk";
import type { AgentTrustRecord, ExecutionReceipt, HardwareAttestationClaim } from "@motebit/sdk";
import { scoreAttestation } from "@motebit/market";
import type { ConnectedDevice } from "./index.js";
import type { RelayIdentity } from "./federation.js";
import { insertRevocationEvent } from "./federation.js";
import type { TaskRouter } from "./task-routing.js";
import { evaluateSettlementEligibility } from "./task-routing.js";
import {
  hexPublicKeyToDidKey,
  verifyKeySuccession,
  verifyExecutionReceipt,
  hexToBytes,
  verify as ed25519Verify,
  canonicalJson,
  sign as ed25519Sign,
  bytesToHex,
} from "@motebit/encryption";
import type { KeySuccessionRecord } from "@motebit/encryption";
import { ExecutionReceiptSchema } from "@motebit/wire-schemas";
import { checkIdempotency, completeIdempotency } from "./idempotency.js";
import { getAccountBalanceDetailed } from "./accounts.js";
import { listStoredReceipts, getStoredReceiptJson } from "./receipts-store.js";
import {
  isAgentRevocationReason,
  type AgentRevocationReason,
  isBondCommitment,
} from "@motebit/protocol";
import { recordBondCommitment, getBestLiveBond } from "./bond-store.js";
import {
  buildSignedRevocationRecord,
  insertRevocationRecord,
  listRevocationRecords,
  buildSignedRevocationFeed,
} from "./agent-revocation.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "agents" });

/** Solvency proof TTL: 5 minutes. */
const SOLVENCY_TTL_MS = 5 * 60 * 1000;

/**
 * Layer the authenticated caller's trust ledger onto a discover result list.
 * Each agent gains `trust_level` and `interaction_count` from the caller's
 * `agent_trust` row for that worker, when one exists.
 *
 * Trust is the caller's private accumulated state — only meaningful when we
 * know who's asking. Anonymous/unauthenticated discover passes through unchanged.
 */
export function enrichWithCallerTrust<T extends Record<string, unknown> & { motebit_id: string }>(
  agents: T[],
  callerMotebitId: string | undefined,
  db: DatabaseDriver,
): T[] {
  if (callerMotebitId == null || callerMotebitId === "" || agents.length === 0) {
    return agents;
  }
  const placeholders = agents.map(() => "?").join(",");
  const trustRows = db
    .prepare(
      `SELECT remote_motebit_id, trust_level, interaction_count
       FROM agent_trust
       WHERE motebit_id = ? AND remote_motebit_id IN (${placeholders})`,
    )
    .all(callerMotebitId, ...agents.map((a) => a.motebit_id)) as Array<{
    remote_motebit_id: string;
    trust_level: string;
    interaction_count: number;
  }>;
  const trustByAgent = new Map(trustRows.map((t) => [t.remote_motebit_id, t]));
  return agents.map((a) => {
    const t = trustByAgent.get(a.motebit_id);
    if (!t) return a;
    return { ...a, trust_level: t.trust_level, interaction_count: t.interaction_count };
  });
}

/**
 * Layer the most-recent verified `hardware_attestation` claim onto each
 * agent in a discover result list. The claim is read from the relay's
 * `relay_credentials` index (the same pool `aggregateHardwareAttestation`
 * routes against in `task-routing.ts`) — most-recent peer-issued
 * `AgentTrustCredential` per subject, revocation-filtered, self-issued
 * already filtered at `/credentials/submit`.
 *
 * Why surface the latest claim, not the routing aggregate. Routing wants
 * a weighted score across many peers; the Agents-panel badge wants a
 * single "what platform attested this peer most recently" — those are
 * different presentations of the same source. The badge tooltip can
 * read the per-row claim directly without surfaces having to import
 * `@motebit/market`.
 *
 * Federation merge passes through unchanged — peer relays may already
 * have populated `hardware_attestation` on their merged-in agents from
 * THEIR `relay_credentials`. We only attach when we have a local claim
 * AND the agent has none yet, so peer-provided HA on cross-relay
 * agents is preserved (that peer's HA store is more authoritative for
 * agents we've never directly transacted with).
 */
export function enrichWithHardwareAttestation<
  T extends Record<string, unknown> & { motebit_id: string },
>(agents: T[], db: DatabaseDriver): T[] {
  if (agents.length === 0) return agents;
  const placeholders = agents.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT credential_id, subject_motebit_id, credential_json, issued_at
       FROM relay_credentials
       WHERE credential_type = 'AgentTrustCredential'
         AND subject_motebit_id IN (${placeholders})
       ORDER BY issued_at DESC`,
    )
    .all(...agents.map((a) => a.motebit_id)) as Array<{
    credential_id: string;
    subject_motebit_id: string;
    credential_json: string;
    issued_at: number;
  }>;
  if (rows.length === 0) return agents;

  const revokedStmt = db.prepare("SELECT 1 FROM relay_revoked_credentials WHERE credential_id = ?");
  type Projection = NonNullable<AgentTrustRecord["hardware_attestation"]>;
  const projectedByAgent = new Map<string, Projection>();
  for (const row of rows) {
    if (projectedByAgent.has(row.subject_motebit_id)) continue; // already have a more-recent row
    if (revokedStmt.get(row.credential_id) != null) continue;
    let parsed: { credentialSubject?: { hardware_attestation?: HardwareAttestationClaim } };
    try {
      parsed = JSON.parse(row.credential_json) as typeof parsed;
    } catch {
      continue;
    }
    const claim = parsed.credentialSubject?.hardware_attestation;
    if (claim == null) continue;
    projectedByAgent.set(row.subject_motebit_id, {
      platform: claim.platform,
      key_exported: claim.key_exported,
      score: scoreAttestation(claim),
    });
  }
  if (projectedByAgent.size === 0) return agents;

  return agents.map((a) => {
    if (a.hardware_attestation != null) return a; // peer-provided HA wins for federated agents
    const projection = projectedByAgent.get(a.motebit_id);
    if (projection == null) return a;
    return { ...a, hardware_attestation: projection };
  });
}

/**
 * Layer the most-recent observed-latency snapshot onto each agent in a
 * discover result list. Stats come from the relay's `relay_latency_stats`
 * table — the same pool `task-routing.ts` queries for routing weights.
 * Per agent, we take the most-recent N samples (N=100 to match the
 * runtime/local-store contract) across all (motebit_id, remote_motebit_id)
 * pairs where this agent was the worker, compute avg + p95 + count, and
 * attach.
 *
 * Sibling to `enrichWithHardwareAttestation`. Both close
 * `docs/doctrine/self-attesting-system.md`: every routing-input the
 * relay computes against MUST be visible to the user. Latency factors
 * into `task-routing.ts` ranking; the Agents-panel readout closes the
 * gap.
 *
 * Federation merge passes through unchanged — peer relays may already
 * have populated `latency_stats` on their merged-in agents from THEIR
 * `relay_latency_stats` view. We only attach when this relay has local
 * samples AND the agent has none yet, so peer-provided latency on
 * cross-relay agents is preserved (that peer's view of latency is
 * more authoritative for agents we've never directly routed to).
 */
export function enrichWithLatencyStats<T extends Record<string, unknown> & { motebit_id: string }>(
  agents: T[],
  db: DatabaseDriver,
): T[] {
  if (agents.length === 0) return agents;
  const placeholders = agents.map(() => "?").join(",");
  // Most-recent 100 samples per worker, across all submitters. The
  // routing path uses the same window via `task-routing.ts:221`; matching
  // the bound here keeps the displayed avg/p95 byte-aligned with what
  // the router actually weighed.
  const rows = db
    .prepare(
      `SELECT remote_motebit_id, latency_ms
       FROM (
         SELECT remote_motebit_id, latency_ms,
                ROW_NUMBER() OVER (PARTITION BY remote_motebit_id ORDER BY recorded_at DESC) AS rn
         FROM relay_latency_stats
         WHERE remote_motebit_id IN (${placeholders})
       )
       WHERE rn <= 100`,
    )
    .all(...agents.map((a) => a.motebit_id)) as Array<{
    remote_motebit_id: string;
    latency_ms: number;
  }>;
  if (rows.length === 0) return agents;

  type Projection = NonNullable<AgentTrustRecord["latency_stats"]>;
  const samplesByAgent = new Map<string, number[]>();
  for (const row of rows) {
    const list = samplesByAgent.get(row.remote_motebit_id);
    if (list == null) samplesByAgent.set(row.remote_motebit_id, [row.latency_ms]);
    else list.push(row.latency_ms);
  }
  const projectedByAgent = new Map<string, Projection>();
  for (const [agentId, samples] of samplesByAgent) {
    if (samples.length === 0) continue;
    const sum = samples.reduce((acc, v) => acc + v, 0);
    const avg_ms = sum / samples.length;
    const sorted = [...samples].sort((a, b) => a - b);
    const p95Index = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const p95_ms = sorted[p95Index]!;
    projectedByAgent.set(agentId, { avg_ms, p95_ms, sample_count: samples.length });
  }
  if (projectedByAgent.size === 0) return agents;

  return agents.map((a) => {
    if (a.latency_stats != null) return a; // peer-provided latency wins for federated agents
    const projection = projectedByAgent.get(a.motebit_id);
    if (projection == null) return a;
    return { ...a, latency_stats: projection };
  });
}

export interface AgentsDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  identityManager: IdentityManager;
  eventStore: EventStore;
  relayIdentity: RelayIdentity;
  connections: Map<string, ConnectedDevice[]>;
  taskRouter: TaskRouter;
  apiToken?: string;
  federationConfig?: { displayName?: string; endpointUrl?: string };
  federationQueryCache: Map<string, number>;
  /** Auth helpers from relay auth layer */
  parseTokenPayloadUnsafe: (
    token: string,
  ) => { mid: string; did: string; iat: number; exp: number; jti?: string } | null;
  verifySignedTokenForDevice: (
    token: string,
    motebitId: string,
    identityManager: IdentityManager,
    expectedAudience: TokenAudience,
    blacklistCheck?: (jti: string, motebitId: string) => boolean,
    agentRevokedCheck?: (motebitId: string) => boolean,
  ) => Promise<boolean>;
  isTokenBlacklisted: (jti: string, motebitId: string) => boolean;
  isAgentRevoked: (motebitId: string) => boolean;
}

/** Subset of AgentsDeps the auth middleware needs. */
export interface AgentAuthMiddlewareDeps {
  app: Hono;
  apiToken?: string;
  identityManager: IdentityManager;
  parseTokenPayloadUnsafe: AgentsDeps["parseTokenPayloadUnsafe"];
  verifySignedTokenForDevice: AgentsDeps["verifySignedTokenForDevice"];
  isTokenBlacklisted: AgentsDeps["isTokenBlacklisted"];
  isAgentRevoked: AgentsDeps["isAgentRevoked"];
}

/**
 * Explicitly PUBLIC (or self-authenticating) `/api/v1/agents/*` routes —
 * the ONLY paths the auth middleware waves through. Every other
 * agent-subpath route MUST authenticate. Kept as a named, exported set
 * so the drift gate (check-agent-route-auth) can assert that every
 * registered agent route is either covered by this middleware or listed
 * here — no silent third state. A route landing here is a deliberate,
 * reviewed decision, never an accident of registration order (the
 * 2026-07-07 listing-write vuln).
 */
export const PUBLIC_AGENT_ROUTES: ReadonlyArray<{
  match: (path: string, method: string) => boolean;
  reason: string;
}> = [
  {
    match: (p) => p === "/api/v1/agents/bootstrap",
    reason: "bootstrap: fresh-identity registration, own rate limiter",
  },
  {
    match: (p, m) => p.endsWith("/succession") && m === "GET",
    reason: "succession: public key-lineage verification (CLAUDE.md rule 6)",
  },
  {
    match: (p, m) => p === "/api/v1/agents/discover" && m === "GET",
    reason: "discover: agents must find each other without pre-existing auth",
  },
  {
    match: (p, m) => p === "/api/v1/agents/revocations" && m === "GET",
    reason: "revocations: operator's signed, verifiable moderation history",
  },
  {
    match: (p) => p.endsWith("/credentials/submit"),
    reason:
      "credentials/submit: permissive-by-signature — the self-verifying " +
      "envelope IS the auth (spec/credential-v1.md); no bearer token by design",
  },
  {
    match: (p, m) => /\/devices\/[^/]+\/hardware-attestation$/.test(p) && m === "POST",
    reason:
      "hardware-attestation: self-authenticating — the request is signed " +
      "under the device's identity key and verified in-handler (sibling of " +
      "credentials/submit + register-self); no bearer token by design",
  },
  {
    match: (p, m) => p.endsWith("/debit") && m === "POST",
    reason:
      "debit: internal service-to-service auth via the x-relay-secret " +
      "header (subscriptions.ts), verified in-handler — not a user bearer " +
      "token. Correct permanent carve-out.",
  },
  {
    match: (p, m) => p.endsWith("/solvency-proof") && m === "GET",
    reason:
      "solvency-proof: public verification primitive by design — a " +
      "counterparty checks an agent can cover an amount BEFORE transacting, " +
      "which requires no pre-existing auth (sibling of succession).",
  },
  {
    match: (p, m) => p.endsWith("/settlements") && m === "GET",
    reason:
      "settlements (GET): owner-private financial history, but enforced by " +
      "its OWN dedicated dualAuth(account:balance) in middleware.ts (same " +
      "class as /balance) + the handler's first-person own-id check. This " +
      "agent-middleware carve-out DEFERS to that dualAuth — removing it would " +
      "double-wrap the route (admin:query here vs account:balance there) and " +
      "conflict. Not public: account:balance-authed, caller===:motebitId.",
  },
];

/**
 * Install the `/api/v1/agents/*` auth middleware. Registered EARLY (index.ts,
 * right after registerAuthMiddleware) so it wraps EVERY agent-subpath route
 * regardless of which file registers it — coverage is guaranteed by
 * ordering-independence, not by hoping each route file registers late enough
 * (the registration-order class that produced the 2026-07-07 unauthenticated
 * listing-write vuln). Public routes are the explicit PUBLIC_AGENT_ROUTES set.
 */
export function registerAgentAuthMiddleware(deps: AgentAuthMiddlewareDeps): void {
  const {
    app,
    apiToken,
    identityManager,
    parseTokenPayloadUnsafe,
    verifySignedTokenForDevice,
    isTokenBlacklisted,
    isAgentRevoked,
  } = deps;

  app.use("/api/v1/agents/*", async (c, next) => {
    const path = c.req.path;
    const method = c.req.method;

    // Explicit public / self-authenticating carve-outs.
    if (PUBLIC_AGENT_ROUTES.some((r) => r.match(path, method))) {
      await next();
      return;
    }

    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing auth token" });
    }
    const token = authHeader.slice(7);

    // Master token bypass (operator).
    if (apiToken != null && apiToken !== "" && token === apiToken) {
      await next();
      return;
    }

    const claims = parseTokenPayloadUnsafe(token);
    if (!claims?.mid) {
      throw new HTTPException(401, { message: "Invalid token" });
    }

    // Expected audience by route family.
    let agentAudience: TokenAudience;
    if (path.includes("/p2p-eligibility")) {
      agentAudience = "market:listing";
    } else if (path.includes("/listing")) {
      agentAudience = "market:listing";
    } else if (path.includes("/credentials")) {
      agentAudience = "credentials";
    } else if (path.includes("/presentation")) {
      agentAudience = "credentials:present";
    } else if (path.includes("/proxy-token")) {
      agentAudience = "proxy:token";
    } else if (path.includes("/receipts")) {
      agentAudience = "receipts:read";
    } else {
      agentAudience = "admin:query";
    }

    const valid = await verifySignedTokenForDevice(
      token,
      claims.mid,
      identityManager,
      agentAudience,
      isTokenBlacklisted,
      isAgentRevoked,
    );
    if (!valid) {
      throw new HTTPException(401, { message: "Token verification failed" });
    }

    c.set("callerMotebitId" as never, claims.mid as never);
    await next();
  });
}

export function registerAgentRoutes(deps: AgentsDeps): void {
  const {
    app,
    moteDb,
    identityManager,
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
  } = deps;

  // GET /agent/:motebitId/settlements — settlement history for this agent
  /** @internal */
  app.get("/agent/:motebitId/settlements", (c) => {
    const mid = asMotebitId(c.req.param("motebitId"));
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);

    const settlements = moteDb.db
      .prepare(
        `SELECT * FROM relay_settlements
         WHERE motebit_id = ?
         ORDER BY settled_at DESC
         LIMIT ?`,
      )
      .all(mid, limit) as Array<Record<string, unknown>>;

    const totals = moteDb.db
      .prepare(
        `SELECT
           COALESCE(SUM(amount_settled), 0) AS total_settled,
           COALESCE(SUM(platform_fee), 0) AS total_platform_fees,
           COUNT(*) AS settlement_count
         FROM relay_settlements
         WHERE motebit_id = ?`,
      )
      .get(mid) as { total_settled: number; total_platform_fees: number; settlement_count: number };

    return c.json({
      motebit_id: mid,
      summary: totals,
      settlements,
    });
  });

  // GET /agent/:motebitId/capabilities — public (no auth)
  /** @spec motebit/discovery@1.0 */
  app.get("/agent/:motebitId/capabilities", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const identity = await identityManager.load(motebitId);
    if (!identity) {
      throw new HTTPException(404, { message: "Identity not found" });
    }

    const devices = await identityManager.listDevices(motebitId);
    const onlinePeers = connections.get(motebitId);
    const onlineCount = onlinePeers ? onlinePeers.length : 0;

    // Find the first device with a public key for capabilities
    const deviceWithKey = devices.find((d) => d.public_key);
    const publicKey = deviceWithKey ? deviceWithKey.public_key : "";

    let did: string | undefined;
    try {
      if (publicKey) did = hexPublicKeyToDidKey(publicKey);
    } catch {
      // Non-fatal — public key may be invalid hex
    }

    // Per-device hardware-attestation credentials. Identity-metadata
    // publication path (NOT a credential index entry — /credentials/submit
    // still rejects self-issued per spec/credential-v1.md §23). Peers use
    // this to pull the subject's self-issued AgentTrustCredential, verify
    // the embedded hardware_attestation claim against the platform-specific
    // adapter, and then issue their own peer credential about the subject
    // for routing aggregation.
    const hardwareAttestations = devices
      // hardware-attestation: intentional-threshold — response-projection filter, not routing admission. Devices without an HA credential have nothing to publish in the `hardware_attestations` array; the agent itself is always returned.
      .filter((d) => d.hardware_attestation_credential != null)
      .map((d) => ({
        device_id: d.device_id,
        public_key: d.public_key,
        hardware_attestation_credential: d.hardware_attestation_credential,
      }));

    return c.json({
      motebit_id: motebitId,
      public_key: publicKey,
      did,
      tools: [],
      governance: {
        trust_mode: "guarded",
        max_risk_auto: 1,
        require_approval_above: 2,
        deny_above: 4,
      },
      online_devices: onlineCount,
      hardware_attestations: hardwareAttestations,
    });
  });

  // GET /api/v1/agents/:motebitId/solvency-proof — relay-signed balance attestation (public)
  /** @spec motebit/settlement@1.0 */
  app.get("/api/v1/agents/:motebitId/solvency-proof", async (c) => {
    const motebitId = c.req.param("motebitId");

    // Validate amount parameter (required, integer micro-units)
    const rawAmount = c.req.query("amount");
    if (!rawAmount) {
      throw new HTTPException(400, { message: "amount query parameter is required (micro-units)" });
    }
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount)) {
      throw new HTTPException(400, {
        message: "amount must be a non-negative integer (micro-units)",
      });
    }

    // Get available balance (respects dispute window hold)
    const detailed = getAccountBalanceDetailed(moteDb.db, motebitId);
    const balanceAvailable = detailed.available_for_withdrawal;
    const attestedAt = Date.now();

    // Build proof payload (all fields except signature). `suite` is included
    // in the signed body per settlement-v1 §11.3 + check-suite-declared #10.
    const payload = {
      motebit_id: motebitId,
      balance_available: balanceAvailable,
      amount_requested: amount,
      sufficient: balanceAvailable >= amount,
      relay_id: relayIdentity.relayMotebitId,
      attested_at: attestedAt,
      expires_at: attestedAt + SOLVENCY_TTL_MS, // 5-minute TTL
      suite: "motebit-jcs-ed25519-hex-v1" as const,
    };

    // Sign with relay's Ed25519 key
    const canonical = canonicalJson(payload);
    const message = new TextEncoder().encode(canonical);
    const sig = await ed25519Sign(message, relayIdentity.privateKey);
    const signatureHex = bytesToHex(sig);

    return c.json({ ...payload, signature: signatureHex });
  });

  // POST /agent/:motebitId/verify-receipt — public receipt verification
  /** @internal */
  app.post("/agent/:motebitId/verify-receipt", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsed = ExecutionReceiptSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const receipt = parsed.data as unknown as ExecutionReceipt;

    if (receipt.motebit_id !== motebitId) {
      return c.json({ valid: false, reason: "motebit_id mismatch" });
    }

    // Resolve public key: agent_registry (service agents) > device records (personal agents)
    let pubKeyHex: string | undefined;
    const regRow = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId as string) as { public_key: string } | undefined;
    if (regRow?.public_key) {
      pubKeyHex = regRow.public_key;
    } else {
      const devices = await identityManager.listDevices(motebitId);
      const device =
        (receipt.device_id != null
          ? devices.find((d) => d.device_id === receipt.device_id)
          : undefined) ?? devices.find((d) => d.public_key);
      if (device?.public_key) pubKeyHex = device.public_key;
    }

    if (!pubKeyHex) {
      return c.json({ valid: false, reason: "No public key on file for this agent" });
    }

    const pubKeyBytes = hexToBytes(pubKeyHex);
    const valid = await verifyExecutionReceipt(receipt, pubKeyBytes);
    return c.json({ valid });
  });

  // === Execution Ledger: submit and retrieve signed manifests ===

  // POST /agent/:motebitId/ledger — submit a signed execution ledger
  /** @internal */
  app.post("/agent/:motebitId/ledger", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));

    // Idempotency key required for ledger submission (receipt settlement)
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (!idempotencyKey) {
      throw new HTTPException(400, {
        message: "Idempotency-Key header is required for ledger submission",
      });
    }

    const idempCheck = checkIdempotency(moteDb.db, idempotencyKey, motebitId);
    if (idempCheck.action === "replay") {
      return c.json(
        JSON.parse(idempCheck.body) as Record<string, unknown>,
        idempCheck.status as 201,
      );
    }
    if (idempCheck.action === "conflict") {
      throw new HTTPException(409, {
        message: "A request with this idempotency key is already being processed",
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }

    // Validate required fields from the execution ledger spec
    if (body.spec !== "motebit/execution-ledger@1.0") {
      throw new HTTPException(400, {
        message: "Invalid spec: must be motebit/execution-ledger@1.0",
      });
    }
    if (body.motebit_id !== motebitId) {
      throw new HTTPException(400, { message: "motebit_id in body does not match URL" });
    }
    if (typeof body.goal_id !== "string" || body.goal_id === "") {
      throw new HTTPException(400, { message: "Missing or invalid goal_id" });
    }
    if (typeof body.content_hash !== "string" || body.content_hash === "") {
      throw new HTTPException(400, { message: "Missing or invalid content_hash" });
    }

    const ledgerId = crypto.randomUUID();
    const now = Date.now();
    const goalId = body.goal_id;
    const planId = typeof body.plan_id === "string" ? body.plan_id : null;
    const contentHash = body.content_hash;

    moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO relay_execution_ledgers
         (ledger_id, motebit_id, goal_id, plan_id, manifest_json, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ledgerId, motebitId, goalId, planId, JSON.stringify(body), contentHash, now);

    const responseBody = { ledger_id: ledgerId, content_hash: contentHash, created_at: now };
    completeIdempotency(moteDb.db, idempotencyKey, motebitId, 201, JSON.stringify(responseBody));
    return c.json(responseBody, 201);
  });

  // GET /agent/:motebitId/ledger/:goalId — retrieve signed execution ledger
  /** @internal */
  app.get("/agent/:motebitId/ledger/:goalId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const goalId = c.req.param("goalId");

    const row = moteDb.db
      .prepare(
        `SELECT manifest_json FROM relay_execution_ledgers WHERE motebit_id = ? AND goal_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(motebitId, goalId) as { manifest_json: string } | undefined;

    if (!row) {
      throw new HTTPException(404, { message: "No execution ledger found for this goal" });
    }

    return c.json(JSON.parse(row.manifest_json) as Record<string, unknown>);
  });

  // === Agent Discovery Registry ===

  // Agent-route auth is installed EARLY by registerAgentAuthMiddleware
  // (called before any agent-subpath route file registers). See its
  // definition below and its call site in index.ts.

  // GET /api/v1/agents/:motebitId/receipts — a motebit's OWN execution-receipt
  // history (top-level tasks, newest first). Gated by the /api/v1/agents/* auth
  // middleware on the `receipts:read` audience; the handler additionally enforces
  // that the caller controls THIS motebit (a device token for another motebit, or
  // none, cannot enumerate this history). The operator master token bypasses
  // (callerMotebitId unset). Each row carries the byte-verbatim canonical
  // `receipt_json` (rule 11) so the caller re-verifies every signature offline.
  /** @internal */
  app.get("/api/v1/agents/:motebitId/receipts", (c) => {
    const motebitId = c.req.param("motebitId");
    const caller = c.get("callerMotebitId" as never) as string | undefined;
    if (caller !== undefined && caller !== motebitId) {
      throw new HTTPException(403, { message: "Cannot read another motebit's receipts" });
    }
    const limit = parseInt(c.req.query("limit") ?? "50", 10) || 50;
    return c.json({ receipts: listStoredReceipts(moteDb.db, motebitId, limit) });
  });

  // GET /api/v1/agents/:motebitId/receipts/:taskId — one receipt, returned as the
  // byte-verbatim canonical JSON (rule 11) so the caller verifies the signature
  // offline. Same owner-scoped auth as the list.
  /** @internal */
  app.get("/api/v1/agents/:motebitId/receipts/:taskId", (c) => {
    const motebitId = c.req.param("motebitId");
    const caller = c.get("callerMotebitId" as never) as string | undefined;
    if (caller !== undefined && caller !== motebitId) {
      throw new HTTPException(403, { message: "Cannot read another motebit's receipts" });
    }
    const json = getStoredReceiptJson(moteDb.db, motebitId, c.req.param("taskId"));
    if (json === null) {
      throw new HTTPException(404, { message: "No such receipt" });
    }
    return c.body(json, 200, { "content-type": "application/json" });
  });

  // POST /api/v1/agents/bootstrap — unauthenticated (rate-limited) one-call identity + device registration
  // Allows a CLI motebit to register with the relay without a master token.
  // Idempotent for same motebit_id + same public_key. Rejects attempts to re-register with a different key.
  /** @internal */
  app.post("/api/v1/agents/bootstrap", async (c) => {
    const body = await c.req.json<{
      motebit_id: string;
      device_id?: string;
      public_key: string;
    }>();

    if (!body.motebit_id || typeof body.motebit_id !== "string" || body.motebit_id.trim() === "") {
      throw new HTTPException(400, { message: "Missing or empty 'motebit_id' field" });
    }
    if (!body.public_key || typeof body.public_key !== "string") {
      throw new HTTPException(400, { message: "Missing 'public_key' field" });
    }
    if (!/^[0-9a-f]{64}$/i.test(body.public_key)) {
      throw new HTTPException(400, {
        message: "Invalid 'public_key' — must be 64-char hex string (32 bytes Ed25519 public key)",
      });
    }

    const motebitId = body.motebit_id.trim();

    // Check if identity already exists
    const existing = await identityManager.load(motebitId);
    if (existing) {
      // Identity exists — check for public key conflict (hijack prevention)
      const devices = await identityManager.listDevices(motebitId);
      const existingKey = devices.find((d) => d.public_key)?.public_key;
      if (existingKey && existingKey.toLowerCase() !== body.public_key.toLowerCase()) {
        throw new HTTPException(409, {
          message:
            "Identity already registered with a different public key — re-registration rejected",
        });
      }
      // Same key (or no key yet) — idempotent: register/refresh device and return
      const device = await identityManager.registerDevice(
        motebitId,
        body.device_id ?? "bootstrap-device",
        body.public_key,
        body.device_id,
      );
      return c.json(
        {
          motebit_id: motebitId,
          device_id: device.device_id,
          registered: false, // identity already existed
        },
        200,
      );
    }

    // New identity — save directly with the caller-provided motebit_id (self-sovereign: no server-assigned UUID)
    await moteDb.identityStorage.save({
      motebit_id: motebitId,
      owner_id: motebitId, // Self-sovereign: the agent is its own owner
      created_at: Date.now(),
      version_clock: 0,
    });
    const device = await identityManager.registerDevice(
      motebitId,
      body.device_id ?? "bootstrap-device",
      body.public_key,
      body.device_id,
    );

    return c.json(
      {
        motebit_id: motebitId,
        device_id: device.device_id,
        registered: true,
      },
      201,
    );
  });

  // Auth middleware for proposal routes
  app.use("/api/v1/proposals/*", async (c, next) => {
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing auth token" });
    }
    const token = authHeader.slice(7);

    if (apiToken != null && apiToken !== "" && token === apiToken) {
      await next();
      return;
    }

    const claims = parseTokenPayloadUnsafe(token);
    if (!claims?.mid) {
      throw new HTTPException(401, { message: "Invalid token" });
    }
    const valid = await verifySignedTokenForDevice(
      token,
      claims.mid,
      identityManager,
      "proposal",
      isTokenBlacklisted,
      isAgentRevoked,
    );
    if (!valid) {
      throw new HTTPException(401, { message: "Token verification failed" });
    }

    c.set("callerMotebitId" as never, claims.mid as never);
    await next();
  });

  app.use("/api/v1/proposals", async (c, next) => {
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing auth token" });
    }
    const token = authHeader.slice(7);

    if (apiToken != null && apiToken !== "" && token === apiToken) {
      await next();
      return;
    }

    const claims = parseTokenPayloadUnsafe(token);
    if (!claims?.mid) {
      throw new HTTPException(401, { message: "Invalid token" });
    }
    const valid = await verifySignedTokenForDevice(
      token,
      claims.mid,
      identityManager,
      "proposal",
      isTokenBlacklisted,
      isAgentRevoked,
    );
    if (!valid) {
      throw new HTTPException(401, { message: "Token verification failed" });
    }

    c.set("callerMotebitId" as never, claims.mid as never);
    await next();
  });

  // POST /api/v1/agents/register — register/refresh an agent's MCP endpoint
  /** @spec motebit/discovery@1.0 */
  app.post("/api/v1/agents/register", async (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;

    // For master token, require motebit_id in body
    const body = await c.req.json<{
      motebit_id?: string;
      endpoint_url: string;
      capabilities: string[];
      metadata?: { name?: string; description?: string };
      public_key?: string;
    }>();
    const motebitId = callerMotebitId ?? body.motebit_id;
    if (!motebitId || typeof motebitId !== "string") {
      throw new HTTPException(400, { message: "Missing motebit_id" });
    }

    if (!body.endpoint_url || typeof body.endpoint_url !== "string") {
      throw new HTTPException(400, { message: "Missing or invalid 'endpoint_url'" });
    }
    if (!Array.isArray(body.capabilities)) {
      throw new HTTPException(400, {
        message: "Missing or invalid 'capabilities' (must be array)",
      });
    }

    // Resolve public key: request body > device records > empty
    let publicKey = "";
    if (
      body.public_key &&
      typeof body.public_key === "string" &&
      /^[0-9a-f]{64}$/i.test(body.public_key)
    ) {
      publicKey = body.public_key;
    } else {
      const devices = await identityManager.listDevices(motebitId);
      const deviceWithKey = devices.find((d) => d.public_key);
      publicKey = deviceWithKey ? deviceWithKey.public_key : "";
    }

    // --- Succession chain validation on re-registration ---
    // If the agent already has a stored public key and the new key differs,
    // require a valid succession record proving key lineage.
    const existingAgent = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { public_key: string } | undefined;

    if (
      existingAgent &&
      existingAgent.public_key &&
      publicKey &&
      existingAgent.public_key !== publicKey
    ) {
      const succession = (body as Record<string, unknown>).succession as
        KeySuccessionRecord | undefined;
      if (!succession) {
        throw new HTTPException(400, {
          message: "Public key differs from stored key — succession record required",
        });
      }

      // Verify the succession record signatures
      let guardianPubKeyForVerify: string | undefined;
      if (succession.recovery) {
        const agentGuardian = moteDb.db
          .prepare("SELECT guardian_public_key FROM agent_registry WHERE motebit_id = ?")
          .get(motebitId) as { guardian_public_key: string | null } | undefined;
        guardianPubKeyForVerify = agentGuardian?.guardian_public_key ?? undefined;
        if (!guardianPubKeyForVerify) {
          throw new HTTPException(400, {
            message: "Agent has no guardian registered — cannot use guardian recovery",
          });
        }
      }
      const successionValid = await verifyKeySuccession(succession, guardianPubKeyForVerify);
      if (!successionValid) {
        throw new HTTPException(400, { message: "Invalid key succession signatures" });
      }

      // Verify the old key in the succession record matches the stored key
      if (succession.old_public_key !== existingAgent.public_key) {
        throw new HTTPException(400, {
          message: "Succession old_public_key does not match stored public key",
        });
      }

      // Verify the new key in the succession record matches the registering key
      if (succession.new_public_key !== publicKey) {
        throw new HTTPException(400, {
          message: "Succession new_public_key does not match registering public key",
        });
      }

      // Store the succession record for chain auditability
      moteDb.db
        .prepare(
          `INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature, recovery, guardian_signature)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          motebitId,
          succession.old_public_key,
          succession.new_public_key,
          succession.timestamp,
          succession.reason ?? null,
          succession.old_key_signature ?? null,
          succession.new_key_signature,
          succession.recovery ? 1 : 0,
          succession.guardian_signature ?? null,
        );

      logger.info("agent.key.succession_on_register", {
        motebitId,
        oldKey: existingAgent.public_key.slice(0, 16) + "...",
        newKey: publicKey.slice(0, 16) + "...",
      });

      // Emit key rotation event for federation propagation
      try {
        await insertRevocationEvent(moteDb.db, relayIdentity, "key_rotated", motebitId, {
          newPublicKey: publicKey,
          revokedPublicKey: existingAgent.public_key,
          // The old key ceased to be authoritative at the (guardian-attested)
          // rotation moment, not when the relay processed this registration —
          // anchor the revocation memo at the succession timestamp so the
          // verifier's poison window matches the chain.
          effectiveAt: succession.timestamp,
        });
      } catch {
        /* best-effort */
      }
    }

    const now = Date.now();
    // `expires_at` is now the janitor lease, not a visibility gate. An agent
    // stays discoverable in `/api/v1/agents/discover` based on its liveness
    // (`last_heartbeat` + a computed freshness band), not a hard TTL drop-out.
    // We only remove rows the relay believes are abandoned — 90 days of no
    // heartbeat. Explicit deregistration or key-succession-with-stale-key
    // still remove immediately. See docs/doctrine/… (endgame-marketplace).
    const expiresAt = now + 90 * 24 * 60 * 60 * 1000; // 90 days

    // Guardian registration requires cryptographic proof: the guardian must sign
    // an attestation proving they govern this agent. Without the guardian's private
    // key, an attacker cannot claim an organization's guardian key.
    let guardianPublicKey: string | undefined;
    const claimedGuardianKey = (body as Record<string, unknown>).guardian_public_key as
      string | undefined;
    const guardianAttestation = (body as Record<string, unknown>).guardian_attestation as
      string | undefined;

    if (claimedGuardianKey) {
      if (!guardianAttestation) {
        throw new HTTPException(400, {
          message:
            'guardian_public_key requires guardian_attestation — a signature by the guardian key over the canonical JSON of {action:"guardian_attestation",guardian_public_key,motebit_id}',
        });
      }
      // Verify the attestation: guardian must have signed {action, guardian_public_key, motebit_id}
      const attestPayload = canonicalJson({
        action: "guardian_attestation",
        guardian_public_key: claimedGuardianKey,
        motebit_id: motebitId,
      });
      const attestMessage = new TextEncoder().encode(attestPayload);
      try {
        const guardianPubBytes = hexToBytes(claimedGuardianKey);
        const attestSigBytes = hexToBytes(guardianAttestation);
        const attestValid = await ed25519Verify(attestSigBytes, attestMessage, guardianPubBytes);
        if (!attestValid) {
          throw new HTTPException(400, { message: "Guardian attestation signature invalid" });
        }
      } catch (err) {
        if (err instanceof HTTPException) throw err;
        throw new HTTPException(400, { message: "Guardian attestation verification failed" });
      }
      // Guardian key ≠ identity key (§3.3)
      if (claimedGuardianKey === publicKey) {
        throw new HTTPException(400, { message: "Guardian key must not equal identity key" });
      }
      guardianPublicKey = claimedGuardianKey;
    }

    const federationVisible = (body as Record<string, unknown>).federation_visible;
    const fedVisibleVal = federationVisible === false ? 0 : 1;
    // Validate + normalize settlement fields
    const VALID_SETTLEMENT_MODES = new Set(["relay", "p2p"]);
    const rawSettlementAddress = (body as Record<string, unknown>).settlement_address as
      string | undefined;
    const rawSettlementModes = (body as Record<string, unknown>).settlement_modes as
      string | undefined;

    // Reject empty string (truthy but useless)
    const settlementAddress =
      rawSettlementAddress && rawSettlementAddress.trim().length > 0
        ? rawSettlementAddress.trim()
        : undefined;

    // Solana address format: 32-44 chars base58
    if (settlementAddress && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(settlementAddress)) {
      throw new HTTPException(400, {
        message: "Invalid settlement_address: must be a valid Solana address (32-44 chars base58)",
      });
    }

    // Normalize settlement_modes: trim, validate each, deduplicate
    let settlementModes: string | undefined;
    if (rawSettlementModes) {
      const modes = rawSettlementModes
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0);
      const invalid = modes.filter((m) => !VALID_SETTLEMENT_MODES.has(m));
      if (invalid.length > 0) {
        throw new HTTPException(400, {
          message: `Invalid settlement_modes: ${invalid.join(", ")}. Valid: relay, p2p`,
        });
      }
      settlementModes = [...new Set(modes)].join(",") || undefined;
    }

    // Validate sweep_threshold: integer micro-units, must be positive
    const rawSweepThreshold = (body as Record<string, unknown>).sweep_threshold as
      number | undefined;
    let sweepThreshold: number | null = null;
    if (rawSweepThreshold !== undefined && rawSweepThreshold !== null) {
      if (!Number.isInteger(rawSweepThreshold) || rawSweepThreshold < 0) {
        throw new HTTPException(400, {
          message: "Invalid sweep_threshold: must be a non-negative integer (micro-units)",
        });
      }
      sweepThreshold = rawSweepThreshold;
    }

    moteDb.db
      .prepare(
        `
      INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, metadata, registered_at, last_heartbeat, expires_at, guardian_public_key, federation_visible, settlement_address, settlement_modes, sweep_threshold)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(motebit_id) DO UPDATE SET
        public_key = excluded.public_key,
        endpoint_url = excluded.endpoint_url,
        capabilities = excluded.capabilities,
        metadata = excluded.metadata,
        last_heartbeat = excluded.last_heartbeat,
        expires_at = excluded.expires_at,
        guardian_public_key = COALESCE(excluded.guardian_public_key, agent_registry.guardian_public_key),
        federation_visible = excluded.federation_visible,
        settlement_address = COALESCE(excluded.settlement_address, agent_registry.settlement_address),
        settlement_modes = COALESCE(excluded.settlement_modes, agent_registry.settlement_modes),
        sweep_threshold = COALESCE(excluded.sweep_threshold, agent_registry.sweep_threshold)
    `,
      )
      .run(
        motebitId,
        publicKey,
        body.endpoint_url,
        JSON.stringify(body.capabilities),
        body.metadata ? JSON.stringify(body.metadata) : null,
        now,
        now,
        expiresAt,
        guardianPublicKey ?? null,
        fedVisibleVal,
        settlementAddress ?? null,
        settlementModes ?? "relay",
        sweepThreshold,
      );

    // Auto-create a default service listing if one doesn't exist.
    // Registration populates agent_registry (for discovery); routing reads from
    // relay_service_listings. Without this, registered agents are discoverable
    // but never routed to — the scored routing loop finds zero candidates.
    if (body.capabilities.length > 0) {
      const existingListing = moteDb.db
        .prepare("SELECT listing_id FROM relay_service_listings WHERE motebit_id = ?")
        .get(motebitId) as { listing_id: string } | undefined;
      if (!existingListing) {
        const listingId = `ls-${crypto.randomUUID()}`;
        moteDb.db
          .prepare(
            `INSERT INTO relay_service_listings
             (listing_id, motebit_id, capabilities, pricing, sla_max_latency_ms, sla_availability, description, updated_at)
             VALUES (?, ?, ?, '[]', 30000, 0.95, ?, ?)`,
          )
          .run(
            listingId,
            motebitId,
            JSON.stringify(body.capabilities),
            body.metadata?.name ?? body.capabilities.join(", "),
            now,
          );
      }
    }

    return c.json({ registered: true, motebit_id: motebitId, expires_at: expiresAt });
  });

  // POST /api/v1/agents/heartbeat — refresh TTL
  /** @spec motebit/discovery@1.0 */
  app.post("/api/v1/agents/heartbeat", async (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    // Fall back to body.motebit_id for master-token callers (services use API token, not signed tokens)
    let motebitId = callerMotebitId;
    if (!motebitId) {
      try {
        const body = await c.req.json<{ motebit_id?: string }>();
        motebitId = body.motebit_id;
      } catch {
        // No body — that's fine if callerMotebitId was set
      }
    }
    if (!motebitId) {
      throw new HTTPException(400, { message: "Cannot determine motebit_id from token or body" });
    }

    const now = Date.now();
    // Janitor lease, not visibility gate — see the register route for the
    // full rationale. 90d = "presumed abandoned if no heartbeat."
    const expiresAt = now + 90 * 24 * 60 * 60 * 1000;

    const result = moteDb.db
      .prepare(
        `
      UPDATE agent_registry SET last_heartbeat = ?, expires_at = ? WHERE motebit_id = ?
    `,
      )
      .run(now, expiresAt, motebitId);

    if (result.changes === 0) {
      throw new HTTPException(404, { message: "Agent not registered" });
    }

    return c.json({ ok: true });
  });

  // PATCH /api/v1/agents/:motebitId/sweep-config — update auto-sweep config
  //
  // Lets a motebit configure when its relay virtual account balance auto-sweeps
  // to its sovereign Solana wallet. Without this, the UI readout ("auto-sweep
  // above $X → your sovereign wallet") is decorative — threshold can only be
  // set at register time.
  //
  // PATCH semantics: explicit null clears the field; undefined preserves it.
  // Authn: the caller's signed token must identify the same motebit_id as the
  // path param, OR the caller holds the master token (admin override).
  //
  // Validation mirrors the register endpoint so the two paths can't drift:
  // sweep_threshold is a non-negative integer in micro-units; settlement_address
  // is 32-44 base58 chars (Solana format).
  /** @internal */
  app.patch("/api/v1/agents/:motebitId/sweep-config", async (c) => {
    const motebitId = c.req.param("motebitId");
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;

    // Authn: agent edits own config, or master token edits any
    if (callerMotebitId && callerMotebitId !== motebitId) {
      throw new HTTPException(403, {
        message: "Caller can only edit its own sweep config",
      });
    }

    const body = await c.req.json<{
      sweep_threshold?: number | null;
      settlement_address?: string | null;
    }>();

    // Check the motebit exists. PATCH on a non-existent agent is 404, not
    // insert-or-update — we don't want PATCH to side-effect a register.
    const existing = moteDb.db
      .prepare("SELECT motebit_id FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { motebit_id: string } | undefined;
    if (!existing) {
      throw new HTTPException(404, { message: "Agent not registered" });
    }

    // Validate sweep_threshold: null clears; non-negative integer micro-units
    // otherwise. Match register validation exactly.
    const hasThreshold = Object.prototype.hasOwnProperty.call(body, "sweep_threshold");
    if (hasThreshold && body.sweep_threshold !== null) {
      if (
        typeof body.sweep_threshold !== "number" ||
        !Number.isInteger(body.sweep_threshold) ||
        body.sweep_threshold < 0
      ) {
        throw new HTTPException(400, {
          message: "Invalid sweep_threshold: must be a non-negative integer (micro-units)",
        });
      }
    }

    // Validate settlement_address: null clears; 32-44 base58 chars otherwise.
    const hasAddress = Object.prototype.hasOwnProperty.call(body, "settlement_address");
    if (hasAddress && body.settlement_address !== null) {
      if (
        typeof body.settlement_address !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.settlement_address)
      ) {
        throw new HTTPException(400, {
          message:
            "Invalid settlement_address: must be a valid Solana address (32-44 chars base58)",
        });
      }
    }

    // Build SET clause with only provided fields. Undefined = preserve.
    const sets: string[] = [];
    const vals: Array<number | string | null> = [];
    if (hasThreshold) {
      sets.push("sweep_threshold = ?");
      vals.push(body.sweep_threshold ?? null);
    }
    if (hasAddress) {
      sets.push("settlement_address = ?");
      vals.push(body.settlement_address ?? null);
    }

    // Empty PATCH is a no-op — return current state, don't error. Matches the
    // idempotency spirit of PATCH with an empty body.
    if (sets.length > 0) {
      vals.push(motebitId);
      moteDb.db
        .prepare(`UPDATE agent_registry SET ${sets.join(", ")} WHERE motebit_id = ?`)
        .run(...vals);
    }

    const updated = moteDb.db
      .prepare(
        "SELECT sweep_threshold, settlement_address FROM agent_registry WHERE motebit_id = ?",
      )
      .get(motebitId) as {
      sweep_threshold: number | null;
      settlement_address: string | null;
    };

    return c.json({
      motebit_id: motebitId,
      sweep_threshold: updated.sweep_threshold,
      settlement_address: updated.settlement_address,
    });
  });

  // GET /api/v1/agents/discover — find agents (with optional federation forwarding)
  /** @spec motebit/discovery@1.0 */
  app.get("/api/v1/agents/discover", async (c) => {
    const capability = c.req.query("capability");
    const motebitId = c.req.query("motebit_id");
    const limitParam = Number(c.req.query("limit") ?? "20");
    const limit = Math.min(Math.max(1, limitParam), 100);

    // Local results (existing behavior, unchanged)
    const localAgents = taskRouter.queryLocalAgents(
      capability ?? undefined,
      motebitId ?? undefined,
      limit,
    );

    // Add source_relay metadata to local results
    const localResults = localAgents.map((a) => ({
      ...a,
      source_relay: relayIdentity.relayMotebitId,
      relay_name: federationConfig?.displayName ?? null,
      hop_distance: 0,
    }));

    // Check for active peers — if none, return local only (backward compatible)
    const activePeerCount = (
      moteDb.db.prepare("SELECT COUNT(*) as cnt FROM relay_peers WHERE state = 'active'").get() as {
        cnt: number;
      }
    ).cnt;

    if (activePeerCount === 0) {
      const enriched = enrichWithCallerTrust(
        localResults,
        c.get("callerMotebitId" as never) as string | undefined,
        moteDb.db,
      );
      const withHa = enrichWithHardwareAttestation(enriched, moteDb.db);
      const withLatency = enrichWithLatencyStats(withHa, moteDb.db);
      return c.json({ agents: withLatency });
    }

    // Forward to active peers
    const queryId = crypto.randomUUID();
    federationQueryCache.set(queryId, Date.now());
    const visited = [relayIdentity.relayMotebitId];

    const peers = moteDb.db
      .prepare(
        "SELECT peer_relay_id, endpoint_url, public_key FROM relay_peers WHERE state = 'active'",
      )
      .all() as Array<{ peer_relay_id: string; endpoint_url: string; public_key: string }>;

    const forwardPromises = peers.map(async (peer) => {
      try {
        const resp = await fetch(`${peer.endpoint_url}/federation/v1/discover`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-ID": queryId },
          body: JSON.stringify({
            query: { capability, motebit_id: motebitId, limit },
            hop_count: 0,
            max_hops: 3,
            visited,
            query_id: queryId,
            origin_relay: relayIdentity.relayMotebitId,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return [];
        const data = (await resp.json()) as { agents: Array<Record<string, unknown>> };
        return data.agents ?? [];
      } catch {
        return [];
      }
    });

    const peerResults = (await Promise.allSettled(forwardPromises))
      .filter(
        (r): r is PromiseFulfilledResult<Array<Record<string, unknown>>> =>
          r.status === "fulfilled",
      )
      .flatMap((r) => r.value);

    // Merge: dedup by motebit_id, prefer lowest hop_distance
    const merged = new Map<string, Record<string, unknown>>();
    for (const agent of [...localResults, ...peerResults]) {
      const id = agent.motebit_id as string;
      const existing = merged.get(id);
      if (!existing || (agent.hop_distance as number) < (existing.hop_distance as number)) {
        merged.set(id, agent);
      }
    }

    // Trim to limit, then layer in trust info for the authenticated caller.
    // Trust is the caller's own ledger — only meaningful when we know who's asking.
    // Federation merge produces Record<string, unknown>; narrow to the
    // marketplace shape (every entry has a motebit_id by construction).
    const trimmed = [...merged.values()].slice(0, limit) as Array<
      Record<string, unknown> & { motebit_id: string }
    >;
    const final = enrichWithCallerTrust(
      trimmed,
      c.get("callerMotebitId" as never) as string | undefined,
      moteDb.db,
    );
    const withHa = enrichWithHardwareAttestation(final, moteDb.db);
    const withLatency = enrichWithLatencyStats(withHa, moteDb.db);

    // Attach the hosting peer's relay public key to each DIRECT-peer candidate
    // (source_relay matches one of our active relay_peers). A federated-P2P
    // delegator client derives the executor (B) fee-leg treasury from this key
    // — `deriveSolanaAddress(source_relay_public_key)` — exactly as this relay
    // resolves it when validating the 3-leg proof at the forward site
    // (tasks.ts federatedP2pIntent), so the two cannot disagree. Multi-hop
    // candidates (source_relay is not a direct peer) get nothing: federated P2P
    // is validated only against direct peers, so the client must not attempt it.
    const peerKeyById = new Map(peers.map((p) => [p.peer_relay_id, p.public_key]));
    const withPeerKey = withLatency.map((agent) => {
      const sourceRelay = agent.source_relay as string | undefined;
      const peerKey = sourceRelay != null ? peerKeyById.get(sourceRelay) : undefined;
      return peerKey != null ? { ...agent, source_relay_public_key: peerKey } : agent;
    });
    return c.json({ agents: withPeerKey });
  });

  // === Operator hygiene — agent revocation (de-list), sovereign-verifiable ===
  //
  // A permissionless registry accumulates junk (spam, abandoned test agents,
  // abusive capabilities) and the only automatic remedy is the 90-day
  // no-heartbeat TTL — too slow for live abuse. These routes give the
  // operator a de-list tool, but de-listing power on a permissionless relay
  // is exactly the trust-root the relay is forbidden from being (CLAUDE.md
  // rule 6). So the power is made accountable: every revoke/reinstate is a
  // signed, reasoned `AgentRevocationRecord` appended to the public
  // `GET /api/v1/agents/revocations` feed.
  //
  //   - De-list, not de-identify: this sets `agent_registry.revoked`, which
  //     Discover filters (task-routing's revokedFilter). The agent's identity,
  //     key, succession chain, and receipts stay served by the identity
  //     endpoint — it remains hireable directly by id.
  //   - Post-hoc hygiene, not editorial curation: discovery stays
  //     permissionless; this only REMOVES junk/abuse, it never picks winners.
  //   - Operator-only: the master token is required. Every `/api/v1/agents/*`
  //     route except the public reads goes through the auth middleware, which
  //     sets `callerMotebitId` for a verified AGENT token and leaves it unset
  //     on the master-token bypass. A present `callerMotebitId` here therefore
  //     means a non-operator caller — rejected. An agent removes ITSELF via
  //     DELETE /deregister; it never revokes a peer.
  //
  // Registered here, BEFORE the `/:motebitId` param routes below, so the
  // static `/revocations` path and the `/revoke` /`/unrevoke` suffixes win
  // over the `:motebitId` capture under the order-sensitive router fallback.

  // GET /api/v1/agents/revocations — public, signed moderation feed.
  // Anyone may fetch the operator's complete revocation history and verify
  // each record (and the feed digest) against the pinned relay key.
  /** @spec motebit/agent-revocation@1.0 */
  app.get("/api/v1/agents/revocations", async (c) => {
    const records = listRevocationRecords(moteDb.db);
    const feed = await buildSignedRevocationFeed(relayIdentity, records);
    return c.json(feed);
  });

  /** Shared revoke/reinstate handler. `revoked` distinguishes the two routes. */
  async function applyRevocation(c: Context, revoked: boolean): Promise<Response> {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId) {
      // A verified agent token reached here — only the operator (master
      // token) may revoke or reinstate an arbitrary agent.
      throw new HTTPException(403, {
        message: "Agent revocation is operator-only (master token required)",
      });
    }

    const motebitId = c.req.param("motebitId");
    if (!motebitId) {
      throw new HTTPException(400, { message: "Missing motebit_id path parameter" });
    }
    const body = await c.req.json<{ reason?: string; note?: string }>().catch(() => ({}) as never);

    // A reinstate is always reason `reinstated`; a revoke requires a
    // categorized reason from the closed registry (fails closed — an
    // unrecognized reason must never land in the signed, verified feed).
    let reason: AgentRevocationReason;
    if (revoked) {
      if (!isAgentRevocationReason(body.reason) || body.reason === "reinstated") {
        throw new HTTPException(400, {
          message:
            "Missing or invalid 'reason' — must be one of: operator_test_cleanup, spam, abuse, malware, policy_violation, dmca",
        });
      }
      reason = body.reason;
    } else {
      reason = "reinstated";
    }

    const note =
      typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim() : undefined;

    const existing = moteDb.db
      .prepare("SELECT motebit_id FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { motebit_id: string } | undefined;
    if (!existing) {
      throw new HTTPException(404, { message: "Agent not registered" });
    }

    // Flip the discoverability flag (what Discover filters) and append the
    // signed record in the same path. Append-only: never an update/delete.
    moteDb.db
      .prepare("UPDATE agent_registry SET revoked = ? WHERE motebit_id = ?")
      .run(revoked ? 1 : 0, motebitId);

    const record = await buildSignedRevocationRecord(relayIdentity, {
      motebitId,
      revoked,
      reason,
      actor: "operator",
      note,
    });
    insertRevocationRecord(moteDb.db, record);

    logger.info(revoked ? "agent.revoked" : "agent.reinstated", {
      motebit_id: motebitId,
      reason,
    });

    return c.json(record);
  }

  // POST /api/v1/agents/:motebitId/revoke-listing — operator de-lists an agent.
  // Distinct from the IDENTITY revocation at `:motebitId/revoke` (key-rotation.ts,
  // motebit/identity@1.0): that marks a key compromised and anchors an on-chain
  // revocation memo. De-listing is discovery hygiene — it removes the agent from
  // Discover and asserts nothing about its key. Different act, different route.
  /** @internal */
  app.post("/api/v1/agents/:motebitId/revoke-listing", (c) => applyRevocation(c, true));

  // POST /api/v1/agents/:motebitId/restore-listing — operator reinstates an agent.
  /** @internal */
  app.post("/api/v1/agents/:motebitId/restore-listing", (c) => applyRevocation(c, false));

  // GET /api/v1/agents/:motebitId/p2p-eligibility — pre-flight settlement check.
  // @internal: an ADVISORY mirror of the submission-time eligibility gate so a
  // delegator client avoids broadcasting to a worker that would be rejected; the
  // gate (evaluateSettlementEligibility) is the law, this is a convenience read.
  /** @internal */
  app.get("/api/v1/agents/:motebitId/p2p-eligibility", async (c) => {
    // The delegator client calls this BEFORE broadcasting the irreversible
    // onchain payment, so it never pays a worker the relay would reject at
    // submission (cold-start without the ack, an active dispute) — closing the
    // broadcast-then-403 fund-loss window. Returns the SAME decision the
    // submission gate (`evaluateSettlementEligibility`) enforces, so the two
    // cannot disagree; `acknowledge_no_history_risk` mirrors the submission body
    // field. Caller-bound (single-operator path): when the caller can't be
    // identified (master/service token with no `mid`), returns `allowed: true`
    // (advisory — the submission gate still enforces; a privileged caller is not
    // a cold-start sybil risk).
    const workerId = asMotebitId(c.req.param("motebitId"));
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    const ack = c.req.query("acknowledge_no_history_risk") === "true";
    if (callerMotebitId == null || callerMotebitId === workerId) {
      return c.json({ allowed: true, reason: "caller not identified — advisory only" });
    }
    const eligibility = await evaluateSettlementEligibility(
      moteDb.db,
      callerMotebitId,
      workerId,
      ack,
    );
    return c.json({ allowed: eligibility.allowed, reason: eligibility.reason });
  });

  // POST /api/v1/agents/:motebitId/bond — submit a signed commitment bond.
  //
  // Mirrors /credentials/submit: a self-verifying signed artifact submitted for
  // relay indexing. Security is in the ARTIFACT, not the transport —
  // `recordBondCommitment` runs `verifyBondCommitment` (suite + the §2 anti-sybil
  // address binding + the self-signature) AND the relay's separate key→motebit_id
  // binding (the bonded key must be the agent's registered key). So even a fully
  // permissive endpoint is safe: a third party cannot forge a bond (no private
  // key) nor bind one to an agent whose registered key differs; the worst it can
  // do is re-submit an agent's own already-public bond (idempotent).
  //
  // Phase-1 anti-sybil SIGNAL, never recourse (CLAUDE.md rule 19; spec/bond-v1.md).
  // The relay records a public proof-of-funds and RPC-reads its backing — it NEVER
  // holds, transmits, or seizes the capital. No new TokenAudience: same
  // artifact-verified class as credentials/submit.
  /** @spec motebit/bond@1.0 */
  app.post("/api/v1/agents/:motebitId/bond", async (c) => {
    const motebitId = c.req.param("motebitId");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
    if (!isBondCommitment(body)) {
      throw new HTTPException(400, { message: "Body is not a well-formed BondCommitment" });
    }
    if (body.motebit_id !== motebitId) {
      throw new HTTPException(400, {
        message: "Path motebit_id does not match bond.motebit_id",
      });
    }

    const result = await recordBondCommitment(moteDb.db, body);
    if (!result.ok) {
      // Fail-closed structured rejection. The body parsed as a BondCommitment but
      // is cryptographically invalid, names a key the relay does not know for this
      // identity, or the agent is unregistered — 422 Unprocessable.
      throw new HTTPException(422, { message: `Bond rejected: ${result.reason}` });
    }

    logger.info("agent.bond.recorded", { motebit_id: motebitId, bond_id: body.bond_id });
    return c.json({ ok: true, bond_id: body.bond_id, status: "recorded" });
  });

  // GET /api/v1/agents/:motebitId/bond — the agent's current live bond status.
  // @internal: advisory/transparency read. Surfaces an explicit AS-OF timestamp
  // (`backing_as_of` = the last backing read) per spec/bond-v1.md §6 — backing is
  // eventually-consistent and MUST NOT be presented as real-time. Neutral field
  // names only: a bond is a soft anti-sybil signal, never secured funds (§7).
  /** @spec motebit/bond@1.0 */
  app.get("/api/v1/agents/:motebitId/bond", (c) => {
    const motebitId = c.req.param("motebitId");
    const bond = getBestLiveBond(moteDb.db, motebitId, Date.now());
    if (!bond) return c.json({ bonded: false });
    return c.json({
      bonded: true,
      bond_id: bond.bond_id,
      bond_amount_micro: bond.bond_amount_micro,
      asset: bond.asset,
      chain: bond.chain,
      expires_at: bond.expires_at,
      backing_state: bond.backing_state,
      backed_amount_micro: bond.backed_amount_micro,
      // §6 as-of timestamp; null = never checked (treat as not-currently-backed).
      backing_as_of: bond.last_checked_at,
    });
  });

  // GET /api/v1/agents/:motebitId — get specific agent
  /** @spec motebit/identity@1.0 */
  app.get("/api/v1/agents/:motebitId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));

    // No `expires_at > now` filter: public-key lookups for receipt
    // verification must survive a sleeping agent. The janitor TTL (90d
    // no-heartbeat) removes truly abandoned rows; `revoked = 0` is the
    // correct "don't show this agent" filter.
    const row = moteDb.db
      .prepare(
        `
      SELECT * FROM agent_registry WHERE motebit_id = ?
    `,
      )
      .get(motebitId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new HTTPException(404, { message: "Agent not found" });
    }

    return c.json({
      motebit_id: row.motebit_id,
      public_key: row.public_key,
      endpoint_url: row.endpoint_url,
      capabilities: JSON.parse(row.capabilities as string) as string[],
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- DB row field is untyped
      metadata: row.metadata
        ? (JSON.parse(row.metadata as string) as Record<string, unknown>)
        : null,
    });
  });

  // DELETE /api/v1/agents/deregister — remove registration
  /** @spec motebit/discovery@1.0 */
  app.delete("/api/v1/agents/deregister", (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (!callerMotebitId) {
      throw new HTTPException(400, { message: "Cannot determine motebit_id from token" });
    }

    moteDb.db.prepare(`DELETE FROM agent_registry WHERE motebit_id = ?`).run(callerMotebitId);
    return c.json({ ok: true });
  });

  // --- Push token management (mobile wake-on-demand) ---

  /** @internal */
  app.post("/api/v1/agents/push-token", async (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (!callerMotebitId) {
      throw new HTTPException(401, { message: "Authentication required" });
    }
    const body = await c.req.json<{
      device_id: string;
      push_token: string;
      platform: string;
    }>();
    if (!body.device_id || !body.push_token || !body.platform) {
      throw new HTTPException(400, { message: "device_id, push_token, and platform are required" });
    }
    if (!["fcm", "apns", "expo"].includes(body.platform)) {
      throw new HTTPException(400, { message: "platform must be fcm, apns, or expo" });
    }
    moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO relay_push_tokens (motebit_id, device_id, push_token, platform, registered_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(callerMotebitId, body.device_id, body.push_token, body.platform, Date.now());
    return c.json({ ok: true });
  });

  /** @internal */
  app.delete("/api/v1/agents/push-token", async (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (!callerMotebitId) {
      throw new HTTPException(401, { message: "Authentication required" });
    }
    const body = await c.req.json<{ device_id: string }>();
    if (!body.device_id) {
      throw new HTTPException(400, { message: "device_id is required" });
    }
    moteDb.db
      .prepare("DELETE FROM relay_push_tokens WHERE motebit_id = ? AND device_id = ?")
      .run(callerMotebitId, body.device_id);
    return c.json({ ok: true });
  });
}
