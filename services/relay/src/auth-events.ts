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
