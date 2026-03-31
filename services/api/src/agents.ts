/**
 * Agent registration, discovery, capabilities, settlements, ledger, and verification routes.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import type { IdentityManager } from "@motebit/core-identity";
import type { EventStore } from "@motebit/event-log";
import { asMotebitId } from "@motebit/sdk";
import type { ExecutionReceipt } from "@motebit/sdk";
import type { ConnectedDevice } from "./index.js";
import type { RelayIdentity } from "./federation.js";
import { insertRevocationEvent } from "./federation.js";
import type { TaskRouter } from "./task-routing.js";
import {
  hexPublicKeyToDidKey,
  verifyKeySuccession,
  verifyExecutionReceipt,
  hexToBytes,
  verify as ed25519Verify,
  canonicalJson,
} from "@motebit/crypto";
import type { KeySuccessionRecord } from "@motebit/crypto";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "agents" });

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
  parseTokenPayloadUnsafe: (token: string) => import("./auth.js").TokenPayload | null;
  verifySignedTokenForDevice: (
    token: string,
    motebitId: string,
    identityManager: IdentityManager,
    expectedAudience: string,
    blacklistCheck?: (jti: string, motebitId: string) => boolean,
    agentRevokedCheck?: (motebitId: string) => boolean,
  ) => Promise<boolean>;
  isTokenBlacklisted: (jti: string, motebitId: string) => boolean;
  isAgentRevoked: (motebitId: string) => boolean;
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
    });
  });

  // POST /agent/:motebitId/verify-receipt — public receipt verification
  app.post("/agent/:motebitId/verify-receipt", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const receipt = await c.req.json<ExecutionReceipt>();

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
  app.post("/agent/:motebitId/ledger", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
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

    return c.json({ ledger_id: ledgerId, content_hash: contentHash, created_at: now }, 201);
  });

  // GET /agent/:motebitId/ledger/:goalId — retrieve signed execution ledger
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

  // Auth middleware for agent registry routes
  app.use("/api/v1/agents/*", async (c, next) => {
    // Bootstrap is unauthenticated — handled by its own rate limiter
    if (c.req.path === "/api/v1/agents/bootstrap") {
      await next();
      return;
    }

    // Succession chain is publicly readable — any third party can verify key lineage
    if (c.req.path.endsWith("/succession") && c.req.method === "GET") {
      await next();
      return;
    }

    // Discovery is publicly readable — agents need to find each other without pre-existing auth
    if (c.req.path === "/api/v1/agents/discover" && c.req.method === "GET") {
      await next();
      return;
    }

    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing auth token" });
    }
    const token = authHeader.slice(7);

    // Master token bypass
    if (apiToken != null && apiToken !== "" && token === apiToken) {
      await next();
      return;
    }

    // Parse token to get motebitId, then verify
    const claims = parseTokenPayloadUnsafe(token);
    if (!claims?.mid) {
      throw new HTTPException(401, { message: "Invalid token" });
    }

    // Determine expected audience from route path
    const path = c.req.path;
    let agentAudience: string;
    if (path.includes("/listing")) {
      agentAudience = "market:listing";
    } else if (path.includes("/credentials")) {
      agentAudience = "credentials";
    } else if (path.includes("/presentation")) {
      agentAudience = "credentials:present";
    } else {
      // register, heartbeat, deregister, discover, agent info
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

    // Store caller identity for route handlers
    c.set("callerMotebitId" as never, claims.mid as never);
    await next();
  });

  // POST /api/v1/agents/bootstrap — unauthenticated (rate-limited) one-call identity + device registration
  // Allows a CLI motebit to register with the relay without a master token.
  // Idempotent for same motebit_id + same public_key. Rejects attempts to re-register with a different key.
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
        | KeySuccessionRecord
        | undefined;
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
        });
      } catch {
        /* best-effort */
      }
    }

    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000; // 15 minutes

    // Guardian registration requires cryptographic proof: the guardian must sign
    // an attestation proving they govern this agent. Without the guardian's private
    // key, an attacker cannot claim an organization's guardian key.
    let guardianPublicKey: string | undefined;
    const claimedGuardianKey = (body as Record<string, unknown>).guardian_public_key as
      | string
      | undefined;
    const guardianAttestation = (body as Record<string, unknown>).guardian_attestation as
      | string
      | undefined;

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

    moteDb.db
      .prepare(
        `
      INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, metadata, registered_at, last_heartbeat, expires_at, guardian_public_key, federation_visible)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(motebit_id) DO UPDATE SET
        public_key = excluded.public_key,
        endpoint_url = excluded.endpoint_url,
        capabilities = excluded.capabilities,
        metadata = excluded.metadata,
        last_heartbeat = excluded.last_heartbeat,
        expires_at = excluded.expires_at,
        guardian_public_key = COALESCE(excluded.guardian_public_key, agent_registry.guardian_public_key),
        federation_visible = excluded.federation_visible
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
    const expiresAt = now + 15 * 60 * 1000;

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

  // GET /api/v1/agents/discover — find agents (with optional federation forwarding)
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
      return c.json({ agents: localResults });
    }

    // Forward to active peers
    const queryId = crypto.randomUUID();
    federationQueryCache.set(queryId, Date.now());
    const visited = [relayIdentity.relayMotebitId];

    const peers = moteDb.db
      .prepare("SELECT peer_relay_id, endpoint_url FROM relay_peers WHERE state = 'active'")
      .all() as Array<{ peer_relay_id: string; endpoint_url: string }>;

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

    // Trim to limit
    const final = [...merged.values()].slice(0, limit);
    return c.json({ agents: final });
  });

  // GET /api/v1/agents/:motebitId — get specific agent
  app.get("/api/v1/agents/:motebitId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const now = Date.now();

    const row = moteDb.db
      .prepare(
        `
      SELECT * FROM agent_registry WHERE motebit_id = ? AND expires_at > ?
    `,
      )
      .get(motebitId, now) as Record<string, unknown> | undefined;

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
  app.delete("/api/v1/agents/deregister", (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (!callerMotebitId) {
      throw new HTTPException(400, { message: "Cannot determine motebit_id from token" });
    }

    moteDb.db.prepare(`DELETE FROM agent_registry WHERE motebit_id = ?`).run(callerMotebitId);
    return c.json({ ok: true });
  });
}
