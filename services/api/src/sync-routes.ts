/**
 * Sync routes — HTTP fallback sync, device registration, identity CRUD.
 *
 * Extracted from index.ts. WebSocket sync remains in index.ts because it
 * couples tightly with the upgrade handler and connection lifecycle.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { EventLogEntry } from "@motebit/sdk";
import { EventType, asMotebitId } from "@motebit/sdk";
import type { MotebitDatabase } from "@motebit/persistence";
import type { EventStore } from "@motebit/event-log";
import type { IdentityManager } from "@motebit/core-identity";
import { verifyDeviceRegistration, type SignableDeviceRegistration } from "@motebit/encryption";
import { createLogger } from "./logger.js";
import type { ConnectedDevice } from "./index.js";

const logger = createLogger({ service: "sync-routes" });

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface SyncRoutesDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  eventStore: EventStore;
  identityManager: IdentityManager;
  connections: Map<string, ConnectedDevice[]>;
}

// ---------------------------------------------------------------------------
// Sensitivity redaction (exported for state-export.ts)
// ---------------------------------------------------------------------------

const SYNC_SAFE_SENSITIVITY = new Set(["none", "personal"]);

export function redactSensitiveEvents(events: EventLogEntry[]): EventLogEntry[] {
  return events.map((e) => {
    if (e.event_type !== EventType.MemoryFormed) return e;
    const payload = e.payload as Record<string, unknown> | undefined;
    if (!payload) return e;
    const sensitivity = (payload.sensitivity as string) ?? "none";
    if (SYNC_SAFE_SENSITIVITY.has(sensitivity)) return e;
    // Redact: strip content, preserve node_id and metadata
    return {
      ...e,
      payload: {
        ...payload,
        content: "[REDACTED]",
        redacted: true,
        redacted_sensitivity: sensitivity,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSyncRoutes(deps: SyncRoutesDeps): void {
  const { app, eventStore, identityManager, connections } = deps;

  // --- Sync: push events (HTTP fallback) ---
  app.post("/sync/:motebitId/push", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const body = await c.req.json<{ events: EventLogEntry[] }>();
    if (!Array.isArray(body.events)) {
      throw new HTTPException(400, {
        message: "Missing or invalid 'events' field (must be array)",
      });
    }
    let accepted = 0;
    let duplicates = 0;
    for (const event of body.events) {
      // Receipt idempotency: if this event carries a receipt, check for replay
      const receipt = event.payload?.receipt as Record<string, unknown> | undefined;
      if (receipt && typeof receipt.signature === "string" && receipt.signature !== "") {
        const existing = await eventStore.query({ motebit_id: event.motebit_id });
        const isDuplicate = existing.some((e) => {
          const r = e.payload?.receipt as Record<string, unknown> | undefined;
          return r && r.signature === receipt.signature;
        });
        if (isDuplicate) {
          duplicates++;
          continue;
        }
      }
      await eventStore.append(event);
      accepted++;
    }

    // Fan out to WebSocket clients, skipping the sender device.
    // Redact sensitive memory content before fan-out.
    const senderDeviceId = c.req.header("x-device-id");
    const peers = connections.get(motebitId);
    if (peers) {
      const safeEvents = redactSensitiveEvents(body.events);
      for (const event of safeEvents) {
        const payload = JSON.stringify({ type: "event", event });
        for (const peer of peers) {
          if (peer.deviceId !== senderDeviceId) {
            peer.ws.send(payload);
          }
        }
      }
    }

    if (duplicates > 0 && accepted === 0) {
      return c.json({ motebit_id: motebitId, accepted: 0, duplicate: true });
    }
    return c.json({ motebit_id: motebitId, accepted, duplicates });
  });

  // --- Sync: pull events (HTTP fallback) ---
  app.get("/sync/:motebitId/pull", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const afterClock = Number(c.req.query("after_clock") ?? "0");
    const events = await eventStore.query({
      motebit_id: motebitId,
      after_version_clock: afterClock,
    });
    return c.json({
      motebit_id: motebitId,
      events: redactSensitiveEvents(events),
      after_clock: afterClock,
    });
  });

  // --- Sync: latest clock ---
  app.get("/sync/:motebitId/clock", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const clock = await eventStore.getLatestClock(motebitId);
    return c.json({ motebit_id: motebitId, latest_clock: clock });
  });

  // --- Device: register ---
  app.post("/device/register", async (c) => {
    const body = await c.req.json<{
      motebit_id: string;
      device_name?: string;
      public_key?: string;
    }>();
    if (!body.motebit_id) {
      throw new HTTPException(400, { message: "Missing 'motebit_id' field" });
    }
    if (
      body.public_key !== undefined &&
      (typeof body.public_key !== "string" || !/^[0-9a-f]{64}$/i.test(body.public_key))
    ) {
      throw new HTTPException(400, {
        message: "Invalid 'public_key' — must be 64-char hex string (32 bytes Ed25519 public key)",
      });
    }
    const identity = await identityManager.load(body.motebit_id);
    if (!identity) {
      throw new HTTPException(404, { message: "Identity not found" });
    }
    const device = await identityManager.registerDevice(
      body.motebit_id,
      body.device_name,
      body.public_key,
    );
    return c.json(device, 201);
  });

  // --- Identity: create ---
  app.post("/identity", async (c) => {
    const body = await c.req.json<{ owner_id: string }>();
    if (!body.owner_id || typeof body.owner_id !== "string" || body.owner_id.trim() === "") {
      throw new HTTPException(400, { message: "Missing or empty 'owner_id' field" });
    }
    const identity = await identityManager.create(body.owner_id);
    return c.json(identity, 201);
  });

  // --- Identity: load ---
  app.get("/identity/:motebitId", async (c) => {
    const id = asMotebitId(c.req.param("motebitId"));
    const identity = await identityManager.load(id);
    if (!identity) {
      return c.json({ error: "identity not found" }, 404);
    }
    return c.json(identity);
  });

  // --- Device: self-attesting registration ---
  //
  // Auth-less by design — the request's signature is the auth. The relay
  // verifies the signature against the public_key in the request itself,
  // proving the registrant controls the corresponding private key. No
  // master token, no operator action, no out-of-band trust anchor.
  //
  // Wire format and verification recipe: spec/device-self-registration-v1.md.
  // Trust posture: a self-registered device starts at trust zero. Trust
  // accrues through receipts and credentials (docs/doctrine/protocol-model.md).
  app.post("/api/v1/devices/register-self", async (c) => {
    const body = (await c.req.json().catch(() => null)) as SignableDeviceRegistration | null;
    if (!body) {
      throw new HTTPException(400, { message: "Body must be JSON" });
    }

    const verified = await verifyDeviceRegistration(body);
    if (!verified.valid) {
      logger.warn("device.self_register.rejected", {
        motebitId: body.motebit_id,
        reason: verified.reason,
      });
      return c.json(
        { error: verified.reason, code: "DEVICE_REGISTRATION_REJECTED", reason: verified.reason },
        400,
      );
    }

    // Key-conflict check: the (motebit_id, public_key) binding is immutable
    // until a deliberate key-rotation request (spec/auth-token-v1.md §9).
    // Silently accepting a different key would let any party with the
    // canonicalization recipe overwrite an established binding.
    const existingDevice = await identityManager.loadDeviceById(body.device_id, body.motebit_id);
    if (existingDevice && existingDevice.public_key !== body.public_key) {
      logger.warn("device.self_register.key_conflict", {
        motebitId: body.motebit_id,
        deviceId: body.device_id,
      });
      return c.json(
        {
          error: "device exists with a different public key",
          code: "DEVICE_KEY_CONFLICT",
          remediation: "use /api/v1/agents/:motebit_id/rotate-key",
        },
        409,
      );
    }

    // Idempotent identity + device upsert. createWithId returns the
    // existing identity if the motebit_id is already known; the response
    // `created` flag tells the client which path ran.
    const ownerId = body.owner_id ?? `self:${body.motebit_id}`;
    const beforeIdentity = await identityManager.load(body.motebit_id);
    await identityManager.createWithId(body.motebit_id, ownerId);
    const created = beforeIdentity == null;

    if (existingDevice) {
      // Public key matches — refresh registered_at by re-saving (idempotent).
      await identityManager.registerDevice(
        body.motebit_id,
        body.device_name,
        body.public_key,
        body.device_id,
      );
    } else {
      await identityManager.registerDevice(
        body.motebit_id,
        body.device_name,
        body.public_key,
        body.device_id,
      );
    }

    const registeredAt = Date.now();
    logger.info("device.self_register.ok", {
      motebitId: body.motebit_id,
      deviceId: body.device_id,
      created,
    });

    return c.json(
      {
        motebit_id: body.motebit_id,
        device_id: body.device_id,
        registered_at: registeredAt,
        created,
      },
      created ? 201 : 200,
    );
  });
}
