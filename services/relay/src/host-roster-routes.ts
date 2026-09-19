/**
 * Machine roster routes — `spec/machine-roster-v1.md` §11.
 *
 *   POST /api/v1/agents/:motebitId/roster   present entries (idempotent union)
 *   GET  /api/v1/agents/:motebitId/roster   the signed set, and beside it, liveness
 *
 * Both are FIRST-PERSON. A roster says where someone's agent runs and
 * when each machine was last seen; it is never published, ranked or
 * aggregated, and another identity's token reads nothing. Security is
 * still in the artifact — an owner's token cannot make this relay hold an
 * entry the owner's key did not sign — so no new token audience: the
 * route answers to the default for `/agents/*`.
 *
 * The response keeps two things visibly apart. `enrollments` and
 * `retirements` are what the SOVEREIGN signed, served back as stored.
 * `liveness` is what THIS RELAY observed, and says so in its own field
 * (`observed_by`). The relay does not reduce the set: a consumer does,
 * with `verifyHostRoster`, against keys the consumer trusts.
 */
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { DatabaseDriver } from "@motebit/persistence";
import type { ConnectedDevice } from "./websocket.js";
import {
  HOSTS_UNATTENDED_WORK,
  MAX_ROSTER_ENTRIES_PER_REQUEST,
  ingestHostRoster,
  isBoundToRosterLine,
  readHostLiveness,
  readHostRoster,
  rosterStatus,
} from "./host-roster-store.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "host-roster" });

export interface HostRosterRouteDeps {
  app: Hono;
  db: DatabaseDriver;
  connections: Map<string, ConnectedDevice[]>;
}

export interface HostLivenessLine {
  device_id: string;
  /**
   * A socket BOUND to this line is open. Not "connected": this relay has
   * no heartbeat with a deadline yet, so a half-open socket reads as
   * open, and the honest word is the one that says only what is known.
   */
  socket_open: boolean;
  last_seen_at: number | null;
  last_announced: string[] | null;
}

export function registerHostRosterRoutes(deps: HostRosterRouteDeps): void {
  const { app, db, connections } = deps;

  const requireFirstPerson = (c: Context, motebitId: string): void => {
    const caller = c.get("callerMotebitId" as never) as string | undefined;
    if (caller != null && caller !== "" && caller !== motebitId) {
      throw new HTTPException(403, {
        message:
          "a machine roster is first-person: a device token may read or present only its own motebit's roster",
      });
    }
  };

  /** @spec motebit/machine-roster@1.0 */
  app.post("/api/v1/agents/:motebitId/roster", async (c) => {
    const motebitId = c.req.param("motebitId");
    requireFirstPerson(c, motebitId);
    const body = (await c.req.json().catch(() => null)) as {
      enrollments?: unknown;
      retirements?: unknown;
    } | null;
    // A field that is PRESENT and not a list is a malformed request, not
    // an absent field. Treating `{ enrollments: {…one object…} }` as "no
    // enrolments" answered 200 with nothing accepted and nothing refused
    // — the partial success the 422 below exists to prevent, by another
    // door: the surface believes its enrolment was taken.
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
        message: `A presentation may carry at most ${MAX_ROSTER_ENTRIES_PER_REQUEST} entries; this one carries ${total}. Nothing was stored.`,
      });
    }

    const result = await ingestHostRoster(db, motebitId, {
      enrollments: enrollments ?? [],
      retirements: retirements ?? [],
    });
    if (result.refused.length > 0) {
      logger.warn("host_roster.refused", {
        motebitId,
        refused: result.refused.map((r) => `${r.kind}[${r.index}]:${r.reason}`),
      });
    }
    // A PARTIAL presentation is not a success. A surface re-presenting
    // its whole cached set checks one thing — did the relay take it — and
    // a 200 over a body it must remember to read is how half a roster
    // gets believed to be all of it. What WAS taken stays taken: one
    // refused neighbour is not a veto.
    return c.json({ motebit_id: motebitId, ...result }, result.refused.length > 0 ? 422 : 200);
  });

  /** @spec motebit/machine-roster@1.0 */
  app.get("/api/v1/agents/:motebitId/roster", async (c) => {
    const motebitId = c.req.param("motebitId");
    requireFirstPerson(c, motebitId);
    const roster = readHostRoster(db, motebitId);
    const seen = readHostLiveness(db, motebitId);

    // One line per ENROLLED machine — whatever its state, so a consumer
    // can say "retired, but connected". Membership decides who is
    // listed; liveness only annotates. Never the other way round.
    const status = await rosterStatus(db, motebitId);

    // Bound or not is ONE predicate, shared with what may be recorded
    // (`observeHostConnection`), so this response and the liveness
    // record cannot disagree about the same socket.
    const open = new Set<string>();
    let unknownConnections = 0;
    for (const peer of connections.get(motebitId) ?? []) {
      if (peer.capabilities?.includes(HOSTS_UNATTENDED_WORK) !== true) continue;
      if (isBoundToRosterLine(db, motebitId, peer, status)) open.add(peer.deviceId);
      // Hosting unattended work, and not a line on the roster: reported
      // BESIDE the set as what it is. It neither joins it nor vetoes it.
      else unknownConnections++;
    }

    const members: HostLivenessLine[] = [...status.enrolled.keys()].sort().map((device_id) => ({
      device_id,
      socket_open: open.has(device_id),
      last_seen_at: seen.get(device_id)?.last_seen_at ?? null,
      last_announced: seen.get(device_id)?.last_announced ?? null,
    }));

    return c.json({
      motebit_id: motebitId,
      enrollments: roster.enrollments,
      retirements: roster.retirements,
      liveness: {
        observed_by: "relay",
        observed_at: Date.now(),
        note: "Observed by this relay, not signed by the motebit. `socket_open` means a connection bound to the line is open; this relay has no heartbeat deadline, so it does not claim `connected`. `last_seen_at` is a single overwritten value per machine, deleted 30 days after its retirement.",
        members,
        unknown_connections: unknownConnections,
      },
    });
  });
}
