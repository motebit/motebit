/**
 * Migration module — agent migration between relays.
 *
 * Implements motebit/migration@1.0:
 *   POST /api/v1/agents/:motebitId/migrate         — initiate migration, issue MigrationToken (§4)
 *   GET  /api/v1/agents/:motebitId/migration/attestation — departure attestation (§5)
 *   GET  /api/v1/agents/:motebitId/migration/export — credential bundle export (§6)
 *   POST /api/v1/agents/accept-migration            — validate MigrationPresentation at destination (§8)
 */
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sign, verify, canonicalJson, bytesToHex, hexToBytes } from "@motebit/encryption";
import { verifyBalanceWaiver } from "@motebit/crypto";
import type {
  MigrationToken,
  DepartureAttestation,
  CredentialBundle,
  MigrationState,
  BalanceWaiver,
} from "@motebit/protocol";
import type { DatabaseDriver } from "@motebit/persistence";
import type { RelayIdentity, FederationConfig } from "./federation.js";
import { createLogger } from "./logger.js";
import { getCredentialAnchorProof } from "./credential-anchoring.js";
import { sqliteAccountStoreFor } from "./account-store-sqlite.js";
import {
  MigrationTokenSchema,
  DepartureAttestationSchema,
  CredentialBundleSchema,
  BalanceWaiverSchema,
} from "@motebit/wire-schemas";

const logger = createLogger({ service: "relay", module: "migration" });

// === Constants (§4.4, §5.4 Convention) ===

/** Default migration token expiry: 72 hours. */
const DEFAULT_TOKEN_EXPIRY_MS = 72 * 60 * 60 * 1000;

// === Database ===

export function createMigrationTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_migrations (
      token_id          TEXT PRIMARY KEY,
      motebit_id        TEXT NOT NULL,
      state             TEXT NOT NULL DEFAULT 'initiated',
      destination_relay TEXT,
      reason            TEXT,
      issued_at         INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL,
      token_signature   TEXT NOT NULL,
      departed_at       INTEGER,
      cancelled_at      INTEGER,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_migrations_motebit
      ON relay_migrations(motebit_id) WHERE state NOT IN ('departed', 'cancelled');
  `);
  // Add balance_waiver_json on existing deployments. Auditor-verifiable
  // record of the §7.2 departure authorization: stores the canonical JSON
  // of the BalanceWaiver as received. An auditor re-canonicalizes, looks
  // up the agent's public key, and re-runs `verifyBalanceWaiver` to
  // confirm the departure was properly authorized — no relay trust.
  try {
    db.exec("ALTER TABLE relay_migrations ADD COLUMN balance_waiver_json TEXT");
  } catch {
    // Column already exists — expected on subsequent boots
  }

  // Track accepted migration presentations at destination (replay prevention §10)
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_accepted_migrations (
      token_id    TEXT PRIMARY KEY,
      motebit_id  TEXT NOT NULL,
      source_relay_id TEXT NOT NULL,
      accepted_at INTEGER NOT NULL
    );
  `);
}

// === Helpers ===

function generateTokenId(): string {
  // UUID v7 approximation: timestamp-based with random suffix
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `mig-${ts}-${rand}`;
}

function getActiveMigration(
  db: DatabaseDriver,
  motebitId: string,
): { token_id: string; state: MigrationState; expires_at: number } | undefined {
  return db
    .prepare(
      "SELECT token_id, state, expires_at FROM relay_migrations WHERE motebit_id = ? AND state NOT IN ('departed', 'cancelled') AND expires_at > ? LIMIT 1",
    )
    .get(motebitId, Date.now()) as
    | { token_id: string; state: MigrationState; expires_at: number }
    | undefined;
}

function updateMigrationState(db: DatabaseDriver, tokenId: string, state: MigrationState): void {
  const extras: Record<string, unknown> = {};
  if (state === "departed") extras.departed_at = Date.now();
  if (state === "cancelled") extras.cancelled_at = Date.now();

  if (Object.keys(extras).length > 0) {
    const setClauses = [`state = ?`, ...Object.keys(extras).map((k) => `${k} = ?`)];
    db.prepare(`UPDATE relay_migrations SET ${setClauses.join(", ")} WHERE token_id = ?`).run(
      state,
      ...Object.values(extras),
      tokenId,
    );
  } else {
    db.prepare("UPDATE relay_migrations SET state = ? WHERE token_id = ?").run(state, tokenId);
  }
}

// === Migration Deps ===

export interface MigrationDeps {
  db: DatabaseDriver;
  app: Hono;
  relayIdentity: RelayIdentity;
  federationConfig?: FederationConfig;
}

// === Route Registration ===

export function registerMigrationRoutes(deps: MigrationDeps): void {
  const { db, app, relayIdentity, federationConfig } = deps;

  // ── POST /api/v1/agents/:motebitId/migrate (§4) ──
  // Initiate migration. Issues a MigrationToken.
  app.post("/api/v1/agents/:motebitId/migrate", async (c) => {
    const motebitId = c.req.param("motebitId");
    const body = await c.req.json<{
      destination_relay?: string;
      reason?: string;
      signature: string;
    }>();

    // Verify agent exists and is not revoked
    const agent = db
      .prepare("SELECT motebit_id, public_key, revoked FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { motebit_id: string; public_key: string; revoked: number } | undefined;

    if (!agent) throw new HTTPException(404, { message: "Agent not found" });
    if (agent.revoked) throw new HTTPException(403, { message: "Agent is revoked" });

    // Check no active migration in progress (§4.4: one active token per agent)
    const existing = getActiveMigration(db, motebitId);
    if (existing) {
      // Replace previous token (§4.4 convention)
      updateMigrationState(db, existing.token_id, "cancelled");
    }

    // Issue MigrationToken (§4.2)
    const tokenId = generateTokenId();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + DEFAULT_TOKEN_EXPIRY_MS;

    const tokenPayload: Omit<MigrationToken, "signature"> = {
      token_id: tokenId,
      motebit_id: motebitId,
      source_relay_id: relayIdentity.relayMotebitId,
      source_relay_url: federationConfig?.endpointUrl ?? "",
      issued_at: issuedAt,
      expires_at: expiresAt,
      // Cryptosuite discriminator stamped into the signed body —
      // matches the migration suite assignment in @motebit/protocol.
      suite: "motebit-jcs-ed25519-b64-v1",
    };

    const canonical = canonicalJson(tokenPayload);
    const sig = await sign(new TextEncoder().encode(canonical), relayIdentity.privateKey);
    const signatureHex = bytesToHex(sig);

    const token: MigrationToken = { ...tokenPayload, signature: signatureHex };

    // Store in DB
    db.prepare(
      "INSERT INTO relay_migrations (token_id, motebit_id, state, destination_relay, reason, issued_at, expires_at, token_signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      tokenId,
      motebitId,
      "initiated",
      body.destination_relay ?? null,
      body.reason ?? null,
      issuedAt,
      expiresAt,
      signatureHex,
    );

    logger.info("migration.token_issued", { motebitId, tokenId, expiresAt });

    return c.json({ ok: true, migration_token: token });
  });

  // ── GET /api/v1/agents/:motebitId/migration/attestation (§5) ──
  // Generate signed DepartureAttestation from existing trust records.
  app.get("/api/v1/agents/:motebitId/migration/attestation", async (c) => {
    const motebitId = c.req.param("motebitId");

    // Verify active migration token
    const migration = getActiveMigration(db, motebitId);
    if (!migration) {
      throw new HTTPException(404, { message: "No active migration token" });
    }

    // Advance state
    updateMigrationState(db, migration.token_id, "attesting");

    // Gather agent data
    const agent = db
      .prepare(
        "SELECT public_key, registered_at, last_heartbeat FROM agent_registry WHERE motebit_id = ?",
      )
      .get(motebitId) as
      | { public_key: string; registered_at: number; last_heartbeat: number }
      | undefined;

    // Trust data — successful/failed tasks
    let taskStats: { successful: number; failed: number } | undefined;
    try {
      taskStats = db
        .prepare(
          "SELECT COUNT(CASE WHEN status = 'completed' THEN 1 END) as successful, COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed FROM task_results WHERE worker_id = ?",
        )
        .get(motebitId) as { successful: number; failed: number } | undefined;
    } catch {
      /* table may not exist */
    }

    // Credential count
    let credCount: { cnt: number } | undefined;
    try {
      credCount = db
        .prepare("SELECT COUNT(*) as cnt FROM relay_credentials WHERE subject_motebit_id = ?")
        .get(motebitId) as { cnt: number } | undefined;
    } catch {
      /* table may not exist */
    }

    // Balance
    let balance: { balance: number } | undefined;
    try {
      balance = db
        .prepare("SELECT balance FROM virtual_accounts WHERE motebit_id = ?")
        .get(motebitId) as { balance: number } | undefined;
    } catch {
      /* table may not exist */
    }

    // Trust level
    let trustRecord: { trust_level: string } | undefined;
    try {
      trustRecord = db
        .prepare("SELECT trust_level FROM agent_trust WHERE motebit_id = ?")
        .get(motebitId) as { trust_level: string } | undefined;
    } catch {
      /* table may not exist */
    }

    const attestationId = `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const attestedAt = Date.now();

    const attestationPayload: Omit<DepartureAttestation, "signature"> = {
      attestation_id: attestationId,
      motebit_id: motebitId,
      source_relay_id: relayIdentity.relayMotebitId,
      source_relay_url: federationConfig?.endpointUrl ?? "",
      first_seen: agent?.registered_at ?? attestedAt,
      last_active: agent?.last_heartbeat ?? attestedAt,
      trust_level: trustRecord?.trust_level ?? "unknown",
      successful_tasks: taskStats?.successful ?? 0,
      failed_tasks: taskStats?.failed ?? 0,
      credentials_issued: credCount?.cnt ?? 0,
      balance_at_departure: balance?.balance ?? 0,
      attested_at: attestedAt,
      suite: "motebit-jcs-ed25519-b64-v1",
    };

    const canonical = canonicalJson(attestationPayload);
    const sig = await sign(new TextEncoder().encode(canonical), relayIdentity.privateKey);
    const signatureHex = bytesToHex(sig);

    const attestation: DepartureAttestation = { ...attestationPayload, signature: signatureHex };

    logger.info("migration.attestation_issued", { motebitId, attestationId });
    return c.json({ ok: true, departure_attestation: attestation });
  });

  // ── GET /api/v1/agents/:motebitId/migration/export (§6) ──
  // Bundle all credentials + anchor proofs + key succession into CredentialBundle.
  app.get("/api/v1/agents/:motebitId/migration/export", async (c) => {
    const motebitId = c.req.param("motebitId");

    // Verify active migration token
    const migration = getActiveMigration(db, motebitId);
    if (!migration) {
      throw new HTTPException(404, { message: "No active migration token" });
    }

    // Advance state
    updateMigrationState(db, migration.token_id, "exporting");

    // Fetch all credentials for this agent
    const credentials = db
      .prepare(
        "SELECT credential_id, credential_json FROM relay_credentials WHERE subject_motebit_id = ? ORDER BY issued_at ASC",
      )
      .all(motebitId) as Array<{ credential_id: string; credential_json: string }>;

    const parsedCredentials = credentials.map(
      (row) => JSON.parse(row.credential_json) as Record<string, unknown>,
    );

    // Fetch anchor proofs for each credential that has one
    const anchorProofs: Record<string, unknown>[] = [];
    for (const cred of credentials) {
      try {
        const proof = await getCredentialAnchorProof(db, cred.credential_id);
        if (proof) {
          anchorProofs.push(proof as unknown as Record<string, unknown>);
        }
      } catch {
        // No anchor proof yet — that's fine
      }
    }

    // Key succession records
    const keySuccessions = db
      .prepare(
        "SELECT old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature, recovery, guardian_signature FROM relay_key_successions WHERE motebit_id = ? ORDER BY timestamp ASC",
      )
      .all(motebitId) as Record<string, unknown>[];

    // Build bundle (unsigned — agent signs on their end per §6.2).
    // Suite advertised; agent stamps the same value when signing.
    const bundle: Omit<CredentialBundle, "bundle_hash" | "signature"> = {
      motebit_id: motebitId,
      exported_at: Date.now(),
      credentials: parsedCredentials,
      anchor_proofs: anchorProofs,
      key_succession: keySuccessions,
      suite: "motebit-jcs-ed25519-b64-v1",
    };

    logger.info("migration.export_generated", {
      motebitId,
      credentialCount: parsedCredentials.length,
      anchorProofCount: anchorProofs.length,
      keySuccessionCount: keySuccessions.length,
    });

    return c.json({
      ok: true,
      credential_bundle: bundle,
    });
  });

  // ── POST /api/v1/agents/accept-migration (§8) ──
  // Validate MigrationPresentation at destination, onboard agent.
  app.post("/api/v1/agents/accept-migration", async (c) => {
    const body = await c.req.json<{
      migration_token: MigrationToken;
      departure_attestation: DepartureAttestation;
      credential_bundle: CredentialBundle;
      identity_file?: string;
      motebit_id: string;
      public_key: string;
    }>();

    // Validate the three nested wire artifacts (MigrationToken,
    // DepartureAttestation, CredentialBundle) against their schemas
    // before any downstream use. Fail-closed on shape drift.
    const parsedToken = MigrationTokenSchema.safeParse(body.migration_token);
    if (!parsedToken.success) {
      return c.json({ error: parsedToken.error.flatten() }, 400);
    }
    const parsedAttestation = DepartureAttestationSchema.safeParse(body.departure_attestation);
    if (!parsedAttestation.success) {
      return c.json({ error: parsedAttestation.error.flatten() }, 400);
    }
    const parsedBundle = CredentialBundleSchema.safeParse(body.credential_bundle);
    if (!parsedBundle.success) {
      return c.json({ error: parsedBundle.error.flatten() }, 400);
    }

    const { migration_token, departure_attestation, credential_bundle } = body;

    // Step 1: Validate migration token (§8.2 step 2)
    // - Check token hasn't expired
    if (migration_token.expires_at < Date.now()) {
      throw new HTTPException(400, { message: "Migration token has expired" });
    }
    // - Check motebit_id matches
    if (migration_token.motebit_id !== body.motebit_id) {
      throw new HTTPException(400, { message: "Token motebit_id does not match" });
    }

    // Step 2: Verify token signature against source relay
    // Fetch source relay's public key via well-known endpoint
    let sourceRelayPublicKey: string | null = null;
    try {
      const wellKnownResp = await fetch(
        `${migration_token.source_relay_url}/.well-known/motebit.json`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (wellKnownResp.ok) {
        const metadata = (await wellKnownResp.json()) as { public_key: string; relay_id: string };
        if (metadata.relay_id === migration_token.source_relay_id) {
          sourceRelayPublicKey = metadata.public_key;
        }
      }
    } catch {
      // Source relay unreachable — continue with other validation
    }

    if (sourceRelayPublicKey) {
      const { signature: tokenSig, ...tokenPayload } = migration_token;
      const tokenCanonical = canonicalJson(tokenPayload);
      const tokenValid = await verify(
        hexToBytes(tokenSig),
        new TextEncoder().encode(tokenCanonical),
        hexToBytes(sourceRelayPublicKey),
      );
      if (!tokenValid) {
        throw new HTTPException(400, { message: "Migration token signature invalid" });
      }

      // Step 3: Verify departure attestation signature (§8.2 step 3)
      const { signature: attSig, ...attPayload } = departure_attestation;
      const attCanonical = canonicalJson(attPayload);
      const attValid = await verify(
        hexToBytes(attSig),
        new TextEncoder().encode(attCanonical),
        hexToBytes(sourceRelayPublicKey),
      );
      if (!attValid) {
        throw new HTTPException(400, { message: "Departure attestation signature invalid" });
      }
    }

    // Step 4: Check for replay (§10)
    const existing = db
      .prepare("SELECT token_id FROM relay_accepted_migrations WHERE token_id = ?")
      .get(migration_token.token_id) as { token_id: string } | undefined;
    if (existing) {
      throw new HTTPException(409, { message: "Migration token already accepted" });
    }

    // Step 5: Onboard the agent — register in agent_registry
    const now = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO agent_registry
       (motebit_id, public_key, endpoint_url, capabilities, registered_at, last_heartbeat, expires_at, federation_visible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      body.motebit_id,
      body.public_key,
      "",
      JSON.stringify(credential_bundle.credentials.length > 0 ? [] : []),
      now,
      now,
      now + 365 * 24 * 60 * 60 * 1000,
      1,
    );

    // Record acceptance for replay prevention
    db.prepare(
      "INSERT INTO relay_accepted_migrations (token_id, motebit_id, source_relay_id, accepted_at) VALUES (?, ?, ?, ?)",
    ).run(migration_token.token_id, body.motebit_id, migration_token.source_relay_id, now);

    // Seed trust from departure attestation (§8.3)
    const attestedTrust = departure_attestation.trust_level;
    try {
      db.prepare(
        "INSERT OR REPLACE INTO agent_trust (motebit_id, trust_level, updated_at) VALUES (?, ?, ?)",
      ).run(body.motebit_id, attestedTrust, now);
    } catch {
      // agent_trust table may not exist in minimal setups
    }

    logger.info("migration.accepted", {
      motebitId: body.motebit_id,
      sourceRelay: migration_token.source_relay_id,
      tokenId: migration_token.token_id,
      attestedTrust,
      credentialCount: credential_bundle.credentials.length,
    });

    return c.json({
      ok: true,
      motebit_id: body.motebit_id,
      source_relay: migration_token.source_relay_id,
      trust_level: attestedTrust,
    });
  });

  // ── POST /api/v1/agents/:motebitId/migrate/cancel ──
  // Cancel an in-progress migration (§3.2: agents MAY cancel before departed).
  app.post("/api/v1/agents/:motebitId/migrate/cancel", (c) => {
    const motebitId = c.req.param("motebitId");
    const migration = getActiveMigration(db, motebitId);
    if (!migration) {
      throw new HTTPException(404, { message: "No active migration" });
    }
    updateMigrationState(db, migration.token_id, "cancelled");
    logger.info("migration.cancelled", { motebitId, tokenId: migration.token_id });
    return c.json({ ok: true, motebit_id: motebitId });
  });

  // ── POST /api/v1/agents/:motebitId/migrate/depart ──
  // Confirm departure — terminal state (§3.2). Accepts an optional
  // `balance_waiver` body per §7.2 + §7.3: the depart route will only
  // advance to `departed` when the virtual-account balance is zero OR
  // the agent presents a signed BalanceWaiver for at least the current
  // balance.
  app.post("/api/v1/agents/:motebitId/migrate/depart", async (c) => {
    const motebitId = c.req.param("motebitId");
    const migration = getActiveMigration(db, motebitId);
    if (!migration) {
      throw new HTTPException(404, { message: "No active migration" });
    }

    // Check no active tasks (§4.3)
    try {
      const activeTasks = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM task_results WHERE (worker_id = ? OR submitted_by = ?) AND status IN ('pending', 'running')",
        )
        .get(motebitId, motebitId) as { cnt: number } | undefined;

      if (activeTasks && activeTasks.cnt > 0) {
        throw new HTTPException(409, {
          message: `Cannot depart: ${activeTasks.cnt} active task(s) must complete first`,
        });
      }
    } catch (err) {
      // task_results table may not exist yet — no active tasks in that case
      if (err instanceof HTTPException) throw err;
    }

    // Optional balance waiver in the request body. Empty / no-JSON body
    // is the zero-balance path; a present-but-malformed body is a 400.
    // The waiver parses through BalanceWaiverSchema so a shape-drifted
    // body fails-closed at the boundary rather than slipping through to
    // `verifyBalanceWaiver` as untyped input.
    let balanceWaiver: BalanceWaiver | undefined;
    const rawBody: unknown = await c.req.json().catch(() => null);
    const candidate = (rawBody as { balance_waiver?: unknown } | null)?.balance_waiver;
    if (candidate !== undefined) {
      const parsed = BalanceWaiverSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new HTTPException(400, {
          message: `Invalid balance_waiver: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        });
      }
      balanceWaiver = parsed.data;
    }

    // Check balance settled (§7.3) — zero balance or valid BalanceWaiver.
    let currentBalance = 0;
    try {
      const row = db
        .prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?")
        .get(motebitId) as { balance: number } | undefined;
      currentBalance = row?.balance ?? 0;
    } catch {
      // relay_accounts not yet created — treat as zero balance
      currentBalance = 0;
    }

    let persistedWaiverJson: string | null = null;
    if (currentBalance > 0) {
      if (!balanceWaiver) {
        throw new HTTPException(409, {
          message:
            "Cannot depart: balance must be withdrawn or waived first (POST { balance_waiver } per spec/migration-v1.md §7.2)",
        });
      }
      if (balanceWaiver.motebit_id !== motebitId) {
        throw new HTTPException(400, {
          message: "Balance waiver motebit_id does not match path parameter",
        });
      }
      if (balanceWaiver.waived_amount < currentBalance) {
        throw new HTTPException(409, {
          message: `Balance waiver covers ${balanceWaiver.waived_amount} but current balance is ${currentBalance} — re-sign and retry`,
        });
      }

      // Resolve agent public key: agent_registry first (service agents),
      // then the device records (personal agents). Mirrors the pattern in
      // agents.ts verify-receipt.
      let pubKeyHex: string | undefined;
      const regRow = db
        .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
        .get(motebitId) as { public_key: string } | undefined;
      if (regRow?.public_key) {
        pubKeyHex = regRow.public_key;
      } else {
        const device = db
          .prepare(
            "SELECT public_key FROM relay_devices WHERE motebit_id = ? AND public_key IS NOT NULL LIMIT 1",
          )
          .get(motebitId) as { public_key: string } | undefined;
        pubKeyHex = device?.public_key;
      }
      if (!pubKeyHex) {
        throw new HTTPException(400, {
          message: "No public key on file for this agent — cannot verify balance waiver",
        });
      }

      const waiverValid = await verifyBalanceWaiver(balanceWaiver, hexToBytes(pubKeyHex));
      if (!waiverValid) {
        throw new HTTPException(400, { message: "Balance waiver signature invalid" });
      }

      // Debit the account to zero under the "waiver" transaction type.
      // The waiver amount may exceed the current balance (the agent
      // committed to forfeiting "at least" `waived_amount`) — we debit
      // only what's on the books. Audit trail cites the migration token.
      const store = sqliteAccountStoreFor(db);
      const debitResult = store.debit(
        motebitId,
        currentBalance,
        "waiver",
        migration.token_id,
        `migration waiver: ${migration.token_id}`,
      );
      if (debitResult === null) {
        // Insufficient funds between our read and debit — concurrent
        // debit raced us. Surface a 409 and let the CLI re-check.
        throw new HTTPException(409, {
          message: "Balance changed during depart; re-check balance and retry",
        });
      }

      persistedWaiverJson = canonicalJson(balanceWaiver);
    }

    // State transition, waiver persistence, and agent-revoke in one
    // place. If any of these fail the request 5xxs and the caller can
    // safely retry — the active-migration query will still find the
    // token and the waiver replay is handled by the `motebit_id + state`
    // guard (only 'initiated' / 'exporting' / 'settling' states match
    // getActiveMigration; 'departed' is terminal).
    if (persistedWaiverJson !== null) {
      db.prepare("UPDATE relay_migrations SET balance_waiver_json = ? WHERE token_id = ?").run(
        persistedWaiverJson,
        migration.token_id,
      );
    }
    updateMigrationState(db, migration.token_id, "departed");

    // Mark agent as inactive on this relay
    db.prepare("UPDATE agent_registry SET revoked = 1 WHERE motebit_id = ?").run(motebitId);

    logger.info("migration.departed", {
      motebitId,
      tokenId: migration.token_id,
      waived: persistedWaiverJson !== null,
    });
    return c.json({ ok: true, motebit_id: motebitId, state: "departed" });
  });
}
