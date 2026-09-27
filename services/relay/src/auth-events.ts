/**
 * Durable auth-event record — the relay's own answer to "who presented the
 * master token today, and what did we refuse?"
 *
 * Until now these facts existed only as log lines, and Fly's log window is a
 * short rolling buffer: on 2026-09-14, an hour after the worker fleet moved
 * off the relay master token, the relay could not show whether anything still
 * presented it — the buffer ended before the deploys. A relay whose thesis is
 * PROVEN posture (docs/doctrine/operator-transparency.md) must be able to
 * answer that from a record it keeps, not from a hosting provider's tail.
 *
 * What is recorded — and what is not:
 *   - kind (master_token | master_token_ws | agent_token_rejected |
 *     device_token_rejected), method, path, the token's CLAIMED motebit_id
 *     when the token parsed, the expected audience, the rejection reason, and
 *     the request's correlation id.
 *   - NEVER the token bytes, NEVER the client IP. The transparency declaration
 *     promises no app-level IP persistence; this table keeps that promise.
 *
 * Retention: a 30-day rolling window, swept by the task-cleanup loop. Long
 * enough to reconstruct an incident, short enough that the record is an audit
 * aid rather than a surveillance log. Declared in `transparency.ts`
 * (`retention.auth_events`), rendered into PRIVACY.md, and enforced by the
 * sibling-boundary test there.
 */

import type { DatabaseDriver } from "@motebit/persistence";

export type AuthEventKind =
  "master_token" | "master_token_ws" | "agent_token_rejected" | "device_token_rejected";

export interface AuthEvent {
  kind: AuthEventKind;
  method?: string;
  path: string;
  /** The `mid` claim the token carried, when it parsed. Never the token. */
  motebitId?: string | null;
  audience?: string | null;
  reason?: string | null;
  correlationId?: string | null;
}

export interface AuthEventRow extends Required<Omit<AuthEvent, "method">> {
  id: number;
  at: number;
  method: string | null;
}

export interface AuthEventSummary {
  /** Window start, epoch ms. */
  since: number;
  counts_by_kind: Record<AuthEventKind, number>;
  master_token: {
    total: number;
    by_path: Array<{ method: string | null; path: string; count: number; last_at: number }>;
  };
  rejections: Array<{
    kind: AuthEventKind;
    reason: string | null;
    path: string;
    count: number;
    last_at: number;
  }>;
  recent: AuthEventRow[];
}

export const AUTH_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ALL_KINDS: AuthEventKind[] = [
  "master_token",
  "master_token_ws",
  "agent_token_rejected",
  "device_token_rejected",
];

export interface AuthEventSink {
  record: (event: AuthEvent) => void;
  summary: (opts?: { sinceMs?: number; recentLimit?: number; now?: number }) => AuthEventSummary;
  /** Delete rows older than the retention window. Returns rows removed. */
  sweep: (now?: number) => number;
}

/**
 * Create the sink over the relay database. `record` never throws — an
 * auth-event write failing must not fail the request it describes; the
 * failure is logged by the caller's logger, not here, to keep this module
 * free of the logger dependency and trivially testable.
 */
export function createAuthEventSink(
  db: DatabaseDriver,
  onError?: (err: unknown) => void,
): AuthEventSink {
  const insert = db.prepare(
    `INSERT INTO relay_auth_events (at, kind, method, path, motebit_id, audience, reason, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    record(event) {
      try {
        insert.run(
          Date.now(),
          event.kind,
          event.method ?? null,
          event.path,
          event.motebitId ?? null,
          event.audience ?? null,
          event.reason ?? null,
          event.correlationId ?? null,
        );
      } catch (err) {
        onError?.(err);
      }
    },
    summary(opts = {}) {
      const now = opts.now ?? Date.now();
      const since = now - (opts.sinceMs ?? 24 * 60 * 60 * 1000);
      const recentLimit = Math.min(Math.max(opts.recentLimit ?? 50, 1), 500);
      const counts = Object.fromEntries(ALL_KINDS.map((k) => [k, 0])) as Record<
        AuthEventKind,
        number
      >;
      for (const row of db
        .prepare("SELECT kind, COUNT(*) AS n FROM relay_auth_events WHERE at >= ? GROUP BY kind")
        .all(since) as Array<{ kind: AuthEventKind; n: number }>) {
        if (row.kind in counts) counts[row.kind] = row.n;
      }
      const byPath = db
        .prepare(
          `SELECT method, path, COUNT(*) AS count, MAX(at) AS last_at FROM relay_auth_events
           WHERE at >= ? AND kind IN ('master_token','master_token_ws')
           GROUP BY method, path ORDER BY count DESC, last_at DESC LIMIT 100`,
        )
        .all(since) as AuthEventSummary["master_token"]["by_path"];
      const rejections = db
        .prepare(
          `SELECT kind, reason, path, COUNT(*) AS count, MAX(at) AS last_at FROM relay_auth_events
           WHERE at >= ? AND kind IN ('agent_token_rejected','device_token_rejected')
           GROUP BY kind, reason, path ORDER BY count DESC, last_at DESC LIMIT 100`,
        )
        .all(since) as AuthEventSummary["rejections"];
      const recent = db
        .prepare(
          `SELECT id, at, kind, method, path, motebit_id AS motebitId, audience, reason,
                  correlation_id AS correlationId
           FROM relay_auth_events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?`,
        )
        .all(since, recentLimit) as AuthEventRow[];
      return {
        since,
        counts_by_kind: counts,
        master_token: { total: counts.master_token + counts.master_token_ws, by_path: byPath },
        rejections,
        recent,
      };
    },
    sweep(now = Date.now()) {
      return db
        .prepare("DELETE FROM relay_auth_events WHERE at < ?")
        .run(now - AUTH_EVENT_RETENTION_MS).changes;
    },
  };
}

/** The per-request slot a master-token presentation is marked in. */
const MASTER_RECORDED = "authEventMasterTokenRecorded" as never;

/** The per-request slot that says the master token authenticated this request. */
export const OPERATOR_PRESENTED = "authOperatorPresented" as never;

/**
 * Record a refusal an auth layer makes BEFORE any token is verified: no
 * credential at all (`missing_token`), a bearer that does not parse as a
 * signed token (`unparseable_token`), or a legacy plain-UUID device token
 * (`legacy_token`). Rule 6 names the master token and refused signed tokens;
 * these refusals were the one class that left no row, so "every refusal is
 * recorded" was false exactly at the doors #846 closed — a no-credential
 * cancel, export or approval wrote nothing (#846 v3). `motebitId` is null:
 * nothing was claimed (a parsed-but-unverified `mid` is passed only by the
 * caller that has one, and is labelled claimed by this table's contract).
 */
export function recordRefusalBeforeVerify(
  c: { req: { method: string; path: string; header(name: string): string | undefined } },
  record: ((event: AuthEvent) => void) | undefined,
  event: {
    kind: "agent_token_rejected" | "device_token_rejected";
    audience: string | null;
    reason: "missing_token" | "unparseable_token" | "legacy_token";
  },
): void {
  record?.({
    kind: event.kind,
    method: c.req.method,
    path: c.req.path,
    motebitId: null,
    audience: event.audience,
    reason: event.reason,
    correlationId: c.req.header("x-correlation-id") ?? null,
  });
}

/**
 * Record a master-token presentation at most ONCE per request. Several auth
 * layers can wrap one route (the agent-route middleware and the account
 * family's dualAuth; proposals' `/api/v1/proposals` and `/*` registrations
 * both matching the bare path), and each records the presentation it sees —
 * so one request wrote two rows and the posture record over-counted (#827).
 * The first layer to see it records; the rest find the mark.
 */
export function recordMasterTokenOnce(
  c: { get(key: never): unknown; set(key: never, value: never): void },
  record: ((event: AuthEvent) => void) | undefined,
  event: Omit<AuthEvent, "kind">,
): void {
  // Every master-token door passes through here, so this is where the
  // request is marked as the OPERATOR's (identity-binding.ts reads it): an
  // unset caller id alone must never read as "operator" (#846 — the
  // subscription routes had no auth at all, and an unset caller id was
  // indistinguishable from the master token).
  c.set(OPERATOR_PRESENTED, true as never);
  if (record == null || c.get(MASTER_RECORDED) === true) return;
  c.set(MASTER_RECORDED, true as never);
  record({ kind: "master_token", ...event });
}
