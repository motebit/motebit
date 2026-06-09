/**
 * Intake routes — the sovereign funnel's metabolic intake.
 *
 * A freshly-minted motebit announces itself here so the relay has a durable,
 * monotonic record of acquisition. Auth-less by design: the request's
 * signature is the auth (same JCS+Ed25519+base64url discipline as
 * `/api/v1/devices/register-self`). The relay verifies the signature against
 * the public_key in the announcement itself, and that the announcement's
 * `audience` is THIS relay's `relay_id` — so an announcement made to one
 * relay cannot be replayed as intake on another.
 *
 * The intake ledger (`relay_motebit_intake`, migration v32) is append-only
 * and never reaped — deliberately NOT `agent_registry`, which records serving
 * agents and is garbage-collected after 90 days of silence. See the migration
 * comment and `services/relay/src/health-summary.ts`.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import {
  canonicalJson,
  verifyMotebitAnnouncement,
  type SignableMotebitAnnouncement,
} from "@motebit/encryption";
import type { RelayIdentity } from "./federation.js";
import { FixedWindowLimiter } from "./rate-limiter.js";
import { getClientIp } from "./middleware.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "intake-routes" });

export interface IntakeRoutesDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  relayIdentity: RelayIdentity;
}

export function registerIntakeRoutes(deps: IntakeRoutesDeps): void {
  const { app, moteDb, relayIdentity } = deps;
  const db = moteDb.db;

  // Public, unauthenticated tier — the signature is the auth, but a per-IP
  // window blunts mass sybil announcement. 20/min mirrors the public limiter.
  const limiter = new FixedWindowLimiter(20, 60_000);

  // ── POST /api/v1/motebits/announce ──
  // Self-signed motebit announcement → durable intake ledger.
  /**
   * @experimental
   * @since 2026-06-08
   * @stabilizes_by 2026-09-08
   * @replacement none
   * @reason Sovereign-funnel intake endpoint. The announcement wire format may
   *   still change before it graduates to a versioned spec route — notably how
   *   `audience` is discovered/pinned (the client reads `relay_id` from the
   *   well-known descriptor today; trust-on-first-use vs a pinned relay id is
   *   still open) and possible sybil gating beyond the per-IP window. Promotes
   *   to `spec/motebit-announcement-v1.md` once stable.
   */
  app.post("/api/v1/motebits/announce", async (c) => {
    const ip = getClientIp(c);
    const { allowed, resetAt } = limiter.check(ip);
    if (!allowed) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Rate limit exceeded", retry_after: retryAfter }, 429);
    }

    const body = (await c.req.json().catch(() => null)) as SignableMotebitAnnouncement | null;
    if (!body) {
      throw new HTTPException(400, { message: "Body must be JSON" });
    }

    const verified = await verifyMotebitAnnouncement(body, {
      expectedAudience: relayIdentity.relayMotebitId,
    });
    if (!verified.valid) {
      logger.warn("motebit.announce.rejected", {
        motebitId: body.motebit_id,
        reason: verified.reason,
      });
      return c.json(
        { error: verified.reason, code: "MOTEBIT_ANNOUNCEMENT_REJECTED", reason: verified.reason },
        400,
      );
    }

    // Determine first-seen, then record. The ledger is write-once per
    // motebit_id: a re-announce (another device, a retried tab) keeps the
    // original `announced_at` and is a no-op for the count.
    const existing = db
      .prepare("SELECT announced_at FROM relay_motebit_intake WHERE motebit_id = ?")
      .get(body.motebit_id) as { announced_at: number } | undefined;

    let announcedAt: number;
    let firstSeen: boolean;
    if (existing) {
      announcedAt = existing.announced_at;
      firstSeen = false;
    } else {
      announcedAt = Date.now();
      firstSeen = true;
      db.prepare(
        `INSERT INTO relay_motebit_intake
           (motebit_id, public_key, surface, audience, announced_at, suite, signature, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(motebit_id) DO NOTHING`,
      ).run(
        body.motebit_id,
        body.public_key,
        body.surface,
        body.audience,
        announcedAt,
        body.suite,
        body.signature,
        canonicalJson(body),
      );
    }

    logger.info("motebit.announce.ok", {
      motebitId: body.motebit_id,
      surface: body.surface,
      firstSeen,
    });

    return c.json(
      { ok: true, announced_at: announcedAt, first_seen: firstSeen },
      firstSeen ? 201 : 200,
    );
  });
}
