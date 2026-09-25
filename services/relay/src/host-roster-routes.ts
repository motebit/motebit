/**
 * Machine roster routes — `spec/machine-roster-v1.md` §11,
 * `docs/proposals/machine-roster-relay-v1.md` D5/D6.
 *
 *   POST /api/v1/agents/:motebitId/roster   present entries (idempotent union)
 *   GET  /api/v1/agents/:motebitId/roster   the signed set, and beside it, liveness
 *
 * Both are FIRST-PERSON, built as "caller PRESENT and EQUAL": the agent
 * auth middleware must have set `callerMotebitId` and it must equal the
 * path id. The operator master token sets no caller and so is refused
 * (403) — a roster is never served to the operator console. The token
 * audience is named explicitly: `device:auth` (agents.ts), because the
 * route needs the key a DEVICE row holds — the caller's own cap bucket.
 * Service-mode motebits verify through the agent-registry fallback, have
 * no device row, and cannot use these routes.
 *
 * The relay never reduces. `enrollments` and `retirements` are what the
 * sovereign signed, served back as stored; `liveness` is what THIS relay
 * observed, keyed by device and by the key each socket verified under, and
 * says so (`observed_by`). The consumer joins the two under a key chain it
 * verified. No field here is a count or quantifier over machines.
 */
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { DatabaseDriver } from "@motebit/persistence";
import type { ConnectedDevice } from "./websocket.js";
import type { VerifiedKeySource } from "./auth.js";
import {
  HOST_LIVENESS_RETENTION_DAYS,
  HOST_LIVENESS_RETENTION_MS,
  MAX_ROSTER_ENTRIES_PER_REQUEST,
  boundKeyOf,
  hostsUnattendedWork,
  ingestHostRoster,
  livenessRecordingSince,
  readHostLiveness,
  readHostRoster,
} from "./host-roster-store.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "host-roster" });

export interface HostRosterRouteDeps {
  app: Hono;
  db: DatabaseDriver;
  connections: Map<string, ConnectedDevice[]>;
  /** This relay's own motebit id — what `observed_by` names. */
  relayMotebitId: string;
}

export interface HostLivenessRow {
  device_id: string;
  /** The key the observed socket(s) verified under — never re-read. */
  bound_under: string;
  /** Relay-observed; null only for a live host socket not yet persisted. */
  last_seen_at: number | null;
  /**
   * Open sockets bound as this (device_id, bound_under) right now. "Open",
   * not "connected": no heartbeat deadline yet (#691). More than one is
   * `motebit doctor`'s hint for a copied device_id — never a verdict.
   */
  sockets_open: number;
}

export interface HostLiveUnenrolled {
  device_id: string;
  bound_under: string;
  sockets_open: number;
}

/**
 * The caller, first-person: present AND equal to the path id, verified
 * under a DEVICE row's key. Returns that key (the caller's own bucket).
 */
function requireFirstPersonDevice(c: Context, motebitId: string): string {
  const caller = c.get("callerMotebitId" as never) as string | undefined;
  if (caller == null || caller === "" || caller !== motebitId) {
    throw new HTTPException(403, {
      message:
        "a machine roster is first-person: only a device token of this motebit may read or present it",
    });
  }
  const key = c.get("callerVerifiedKey" as never) as string | undefined;
  const source = c.get("callerVerifiedKeySource" as never) as VerifiedKeySource | undefined;
  if (key == null || key === "" || source !== "device") {
    throw new HTTPException(403, {
      message:
        "a machine roster needs a device credential: this token did not verify under a registered device's key",
    });
  }
  return key;
}

export function registerHostRosterRoutes(deps: HostRosterRouteDeps): void {
  const { app, db, connections, relayMotebitId } = deps;

  /** @spec motebit/machine-roster@1.0 */
  app.post("/api/v1/agents/:motebitId/roster", async (c) => {
    const motebitId = c.req.param("motebitId");
    const callerKey = requireFirstPersonDevice(c, motebitId);
    const body = (await c.req.json().catch(() => null)) as {
      enrollments?: unknown;
      retirements?: unknown;
    } | null;
    // A field that is PRESENT and not a list is a malformed request, not
    // an absent field — read as absent it answered 200 with nothing taken.
    const listOrAbsent = (v: unknown, name: string): unknown[] | null => {
      if (v === undefined) return null;
      if (!Array.isArray(v)) {
        throw new HTTPException(400, {
          message: `\`${name}\` must be an array. Nothing was stored.`,
        });
      }
      return v as unknown[];
    };
    const enrollments = listOrAbsent(body?.enrollments, "enrollments");
    const retirements = listOrAbsent(body?.retirements, "retirements");
    if (enrollments == null && retirements == null) {
      throw new HTTPException(400, {
        message: "Body must carry `enrollments` and/or `retirements` arrays",
      });
    }
    const total = (enrollments?.length ?? 0) + (retirements?.length ?? 0);
    if (total > MAX_ROSTER_ENTRIES_PER_REQUEST) {
      throw new HTTPException(413, {
        message: `A presentation may carry at most ${MAX_ROSTER_ENTRIES_PER_REQUEST} entries; this one carries ${total}. Send it in chunks. Nothing was stored.`,
      });
    }

    const result = await ingestHostRoster(db, motebitId, callerKey, {
      enrollments: enrollments ?? [],
      retirements: retirements ?? [],
    });
    if (result.refused.length > 0) {
      logger.warn("host_roster.refused", {
        motebitId,
        refused: result.refused.map((r) => `${r.kind}[${r.index}]:${r.reason}`),
      });
    }
    // A PARTIAL presentation is not a success: a surface re-presenting its
    // whole cached set checks one thing — was it taken. What WAS taken
    // stays taken: one refused neighbour is not a veto.
    return c.json({ motebit_id: motebitId, ...result }, result.refused.length > 0 ? 422 : 200);
  });

  /** @spec motebit/machine-roster@1.0 */
  app.get("/api/v1/agents/:motebitId/roster", (c) => {
    const motebitId = c.req.param("motebitId");
    requireFirstPersonDevice(c, motebitId);
    const now = Date.now();
    const roster = readHostRoster(db, motebitId);

    // Live BOUND sockets, grouped by (device_id, bound_under). The key is
    // the one captured when each socket's token verified — never a device
    // row read now. Unbound sockets (master token, declared-only ids,
    // device auth off) are not attributable and are not reported.
    const pairKey = (d: string, k: string): string => JSON.stringify([d, k]);
    const live = new Map<
      string,
      { device_id: string; bound_under: string; sockets: number; host: boolean }
    >();
    for (const peer of connections.get(motebitId) ?? []) {
      const boundUnder = boundKeyOf(peer);
      if (boundUnder == null) continue;
      const k = pairKey(peer.deviceId, boundUnder);
      const entry = live.get(k) ?? {
        device_id: peer.deviceId,
        bound_under: boundUnder,
        sockets: 0,
        host: false,
      };
      entry.sockets++;
      entry.host ||= hostsUnattendedWork(peer);
      live.set(k, entry);
    }

    // rows = persisted rows ∪ live bound HOST sockets.
    const rows = new Map<string, HostLivenessRow>();
    for (const r of readHostLiveness(db, motebitId)) {
      rows.set(pairKey(r.device_id, r.bound_under), {
        device_id: r.device_id,
        bound_under: r.bound_under,
        last_seen_at: r.last_seen_at,
        sockets_open: live.get(pairKey(r.device_id, r.bound_under))?.sockets ?? 0,
      });
    }
    for (const [k, l] of live) {
      if (!l.host || rows.has(k)) continue;
      rows.set(k, {
        device_id: l.device_id,
        bound_under: l.bound_under,
        last_seen_at: null,
        sockets_open: l.sockets,
      });
    }
    // live_unenrolled = live bound sockets with no row (not hosts: nothing
    // persisted, nothing claimed about membership).
    const liveUnenrolled: HostLiveUnenrolled[] = [];
    for (const [k, l] of live) {
      if (rows.has(k)) continue;
      liveUnenrolled.push({
        device_id: l.device_id,
        bound_under: l.bound_under,
        sockets_open: l.sockets,
      });
    }
    const byPair = (
      a: { device_id: string; bound_under: string },
      b: { device_id: string; bound_under: string },
    ): number =>
      a.device_id < b.device_id
        ? -1
        : a.device_id > b.device_id
          ? 1
          : a.bound_under < b.bound_under
            ? -1
            : a.bound_under > b.bound_under
              ? 1
              : 0;

    // Liveness older than the window has been swept, so a consumer may say
    // "not observed since" only back to this point.
    const since = livenessRecordingSince(db);
    const windowStart = now - HOST_LIVENESS_RETENTION_MS;
    const observingSince = since == null ? windowStart : Math.max(since, windowStart);

    return c.json({
      motebit_id: motebitId,
      enrollments: roster.enrollments,
      retirements: roster.retirements,
      liveness: {
        observed_by: relayMotebitId,
        retention_days: HOST_LIVENESS_RETENTION_DAYS,
        observing_since: observingSince,
        rows: [...rows.values()].sort(byPair),
        live_unenrolled: liveUnenrolled.sort(byPair),
      },
    });
  });
}
