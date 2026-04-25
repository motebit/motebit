/**
 * Pairing protocol — device-to-device pairing via 6-char alphanumeric codes.
 *
 * Extracted from index.ts for modularity. Zero behavior change.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { IdentityManager } from "@motebit/core-identity";

// --- Pairing Code Generator ---

const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 30 chars, no ambiguous 0/O/1/I/L
const PAIRING_CODE_LENGTH = 6;
const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generatePairingCode(): string {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length])
    .join("");
}

// --- Dependencies ---

export interface PairingDeps {
  db: {
    prepare(sql: string): { run(...args: unknown[]): void; get(...args: unknown[]): unknown };
    exec(sql: string): void;
  };
  app: Hono;
  apiToken: string | undefined;
  identityManager: IdentityManager;
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

// --- Table creation ---

export function createPairingTables(db: { exec(sql: string): void }): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_sessions (
        pairing_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        initiator_device_id TEXT NOT NULL,
        pairing_code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        claiming_device_name TEXT,
        claiming_public_key TEXT,
        claiming_x25519_pubkey TEXT,
        approved_device_id TEXT,
        approved_device_token TEXT,
        key_transfer_payload TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pairing_code ON pairing_sessions (pairing_code);
  `);
}

// --- Route registration ---

export function registerPairingRoutes(deps: PairingDeps): void {
  const {
    db,
    app,
    apiToken,
    identityManager,
    parseTokenPayloadUnsafe,
    verifySignedTokenForDevice,
    isTokenBlacklisted,
    isAgentRevoked,
  } = deps;

  // --- Pairing: helper to verify device auth and extract motebitId ---
  async function verifyPairingAuth(
    authHeader: string | undefined,
  ): Promise<{ motebitId: string; deviceId: string } | null> {
    if (authHeader == null || !authHeader.startsWith("Bearer ")) return null;
    const token = authHeader.slice(7);

    // Master token bypass
    if (apiToken != null && apiToken !== "" && token === apiToken) return null; // master token can't initiate pairing (no motebitId context)

    if (!token.includes(".")) return null; // must be a signed token

    const claims = parseTokenPayloadUnsafe(token);
    if (!claims || !claims.mid || !claims.did) return null;

    const verified = await verifySignedTokenForDevice(
      token,
      claims.mid,
      identityManager,
      "device:auth",
      isTokenBlacklisted,
      isAgentRevoked,
    );
    if (!verified) return null;

    return { motebitId: claims.mid, deviceId: claims.did };
  }

  // --- Pairing: initiate (Device A, authenticated) ---
  /** @internal */
  app.post("/pairing/initiate", async (c) => {
    const device = await verifyPairingAuth(c.req.header("authorization"));
    if (!device) {
      throw new HTTPException(401, { message: "Signed device token required for pairing" });
    }

    const pairingId = crypto.randomUUID();
    const pairingCode = generatePairingCode();
    const now = Date.now();
    const expiresAt = now + PAIRING_TTL_MS;

    db.prepare(
      `
      INSERT INTO pairing_sessions (pairing_id, motebit_id, initiator_device_id, pairing_code, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `,
    ).run(pairingId, device.motebitId, device.deviceId, pairingCode, now, expiresAt);

    return c.json({ pairing_id: pairingId, pairing_code: pairingCode, expires_at: expiresAt }, 201);
  });

  // --- Pairing: claim (Device B, no auth) ---
  /** @internal */
  app.post("/pairing/claim", async (c) => {
    const body = await c.req.json<{
      pairing_code: string;
      device_name: string;
      public_key: string;
      x25519_pubkey?: string;
    }>();
    const { pairing_code, device_name, public_key, x25519_pubkey } = body;

    if (!pairing_code || typeof pairing_code !== "string" || !/^[A-Z2-9]{6}$/.test(pairing_code)) {
      throw new HTTPException(400, { message: "Invalid pairing code format" });
    }
    if (!device_name || typeof device_name !== "string") {
      throw new HTTPException(400, { message: "Missing device_name" });
    }
    if (!public_key || typeof public_key !== "string" || !/^[0-9a-f]{64}$/i.test(public_key)) {
      throw new HTTPException(400, { message: "Invalid public_key — must be 64-char hex string" });
    }
    if (
      x25519_pubkey != null &&
      (typeof x25519_pubkey !== "string" || !/^[0-9a-f]{64}$/i.test(x25519_pubkey))
    ) {
      throw new HTTPException(400, {
        message: "Invalid x25519_pubkey — must be 64-char hex string",
      });
    }

    const session = db
      .prepare(
        `
      SELECT * FROM pairing_sessions WHERE pairing_code = ?
    `,
      )
      .get(pairing_code) as Record<string, unknown> | undefined;

    if (!session) {
      throw new HTTPException(404, { message: "Invalid pairing code" });
    }
    if ((session.expires_at as number) < Date.now()) {
      throw new HTTPException(410, { message: "Pairing code expired" });
    }
    if ((session.status as string) !== "pending") {
      throw new HTTPException(409, { message: "Pairing code already used" });
    }

    db.prepare(
      `
      UPDATE pairing_sessions SET status = 'claimed', claiming_device_name = ?, claiming_public_key = ?, claiming_x25519_pubkey = ? WHERE pairing_id = ?
    `,
    ).run(device_name, public_key, x25519_pubkey ?? null, session.pairing_id as string);

    return c.json({ pairing_id: session.pairing_id, motebit_id: session.motebit_id });
  });

  // --- Pairing: get session (Device A, authenticated) ---
  /** @internal */
  app.get("/pairing/:pairingId", async (c) => {
    const device = await verifyPairingAuth(c.req.header("authorization"));
    if (!device) {
      throw new HTTPException(401, { message: "Signed device token required" });
    }

    const pairingId = c.req.param("pairingId");
    const session = db
      .prepare(
        `
      SELECT * FROM pairing_sessions WHERE pairing_id = ?
    `,
      )
      .get(pairingId) as Record<string, unknown> | undefined;

    if (!session) {
      throw new HTTPException(404, { message: "Pairing session not found" });
    }
    if ((session.motebit_id as string) !== device.motebitId) {
      throw new HTTPException(403, { message: "Not authorized for this pairing session" });
    }

    const result: Record<string, unknown> = {
      pairing_id: session.pairing_id,
      motebit_id: session.motebit_id,
      status: session.status,
      pairing_code: session.pairing_code,
      claiming_device_name: session.claiming_device_name,
      claiming_public_key: session.claiming_public_key,
      created_at: session.created_at,
      expires_at: session.expires_at,
    };
    if (session.claiming_x25519_pubkey != null) {
      result.claiming_x25519_pubkey = session.claiming_x25519_pubkey;
    }
    return c.json(result);
  });

  // --- Pairing: approve (Device A, authenticated) ---
  /** @internal */
  app.post("/pairing/:pairingId/approve", async (c) => {
    const device = await verifyPairingAuth(c.req.header("authorization"));
    if (!device) {
      throw new HTTPException(401, { message: "Signed device token required" });
    }

    const pairingId = c.req.param("pairingId");
    const session = db
      .prepare(
        `
      SELECT * FROM pairing_sessions WHERE pairing_id = ?
    `,
      )
      .get(pairingId) as Record<string, unknown> | undefined;

    if (!session) {
      throw new HTTPException(404, { message: "Pairing session not found" });
    }
    if ((session.motebit_id as string) !== device.motebitId) {
      throw new HTTPException(403, { message: "Not authorized for this pairing session" });
    }
    if ((session.status as string) !== "claimed") {
      throw new HTTPException(409, {
        message: `Cannot approve — status is '${String(session.status)}'`,
      });
    }

    // Accept optional key_transfer payload from Device A (encrypted identity seed)
    let keyTransferJson: string | null = null;
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = await c.req.json<{ key_transfer?: Record<string, string> }>();
        if (body.key_transfer) {
          const kt = body.key_transfer;
          // Validate structure — relay stores it opaque but checks shape
          if (
            typeof kt.x25519_pubkey === "string" &&
            typeof kt.encrypted_seed === "string" &&
            typeof kt.nonce === "string" &&
            typeof kt.tag === "string" &&
            typeof kt.identity_pubkey_check === "string"
          ) {
            keyTransferJson = JSON.stringify(kt);
          }
        }
      } catch {
        // No JSON body or malformed — proceed without key transfer
      }
    }

    // Register the claiming device under the same motebit identity
    const registeredDevice = await identityManager.registerDevice(
      session.motebit_id as string,
      (session.claiming_device_name as string) || "Paired Device",
      session.claiming_public_key as string,
    );

    db.prepare(
      `
      UPDATE pairing_sessions SET status = 'approved', approved_device_id = ?, key_transfer_payload = ? WHERE pairing_id = ?
    `,
    ).run(registeredDevice.device_id, keyTransferJson, pairingId);

    return c.json({
      device_id: registeredDevice.device_id,
      motebit_id: session.motebit_id,
    });
  });

  // --- Pairing: deny (Device A, authenticated) ---
  /** @internal */
  app.post("/pairing/:pairingId/deny", async (c) => {
    const device = await verifyPairingAuth(c.req.header("authorization"));
    if (!device) {
      throw new HTTPException(401, { message: "Signed device token required" });
    }

    const pairingId = c.req.param("pairingId");
    const session = db
      .prepare(
        `
      SELECT * FROM pairing_sessions WHERE pairing_id = ?
    `,
      )
      .get(pairingId) as Record<string, unknown> | undefined;

    if (!session) {
      throw new HTTPException(404, { message: "Pairing session not found" });
    }
    if ((session.motebit_id as string) !== device.motebitId) {
      throw new HTTPException(403, { message: "Not authorized for this pairing session" });
    }

    db.prepare(
      `
      UPDATE pairing_sessions SET status = 'denied' WHERE pairing_id = ?
    `,
    ).run(pairingId);

    return c.json({ status: "denied" });
  });

  // --- Pairing: status (Device B polls, no auth) ---
  /** @internal */
  app.get("/pairing/:pairingId/status", (c) => {
    const pairingId = c.req.param("pairingId");
    const session = db
      .prepare(
        `
      SELECT status, motebit_id, approved_device_id, key_transfer_payload FROM pairing_sessions WHERE pairing_id = ?
    `,
      )
      .get(pairingId) as Record<string, unknown> | undefined;

    if (!session) {
      throw new HTTPException(404, { message: "Pairing session not found" });
    }

    const result: Record<string, unknown> = { status: session.status };
    if ((session.status as string) === "approved") {
      result.motebit_id = session.motebit_id;
      result.device_id = session.approved_device_id;
      // Include key_transfer payload if present (encrypted identity seed from Device A)
      if (session.key_transfer_payload != null) {
        try {
          result.key_transfer = JSON.parse(session.key_transfer_payload as string);
        } catch {
          // Malformed — skip
        }
      }
    }

    return c.json(result);
  });

  // --- Pairing: update device key after identity key transfer (Device B, no auth) ---
  /** @internal */
  app.post("/pairing/:pairingId/update-key", async (c) => {
    const pairingId = c.req.param("pairingId");
    const body = await c.req.json<{ public_key: string }>();

    if (
      !body.public_key ||
      typeof body.public_key !== "string" ||
      !/^[0-9a-f]{64}$/i.test(body.public_key)
    ) {
      throw new HTTPException(400, { message: "Invalid public_key — must be 64-char hex string" });
    }

    const session = db
      .prepare(
        `
      SELECT pairing_id, status, approved_device_id, motebit_id FROM pairing_sessions WHERE pairing_id = ?
    `,
      )
      .get(pairingId) as Record<string, unknown> | undefined;

    if (!session) {
      throw new HTTPException(404, { message: "Pairing session not found" });
    }
    if ((session.status as string) !== "approved") {
      throw new HTTPException(409, { message: "Pairing session not approved" });
    }
    if (session.approved_device_id == null) {
      throw new HTTPException(409, { message: "No approved device" });
    }

    // Update the device's public key in the identity store
    const deviceId = session.approved_device_id as string;
    const device = await identityManager.getDevice(deviceId);
    if (!device) {
      throw new HTTPException(404, { message: "Approved device not found in identity store" });
    }

    await identityManager.updateDevicePublicKey(deviceId, body.public_key);

    return c.json({ ok: true });
  });
}
