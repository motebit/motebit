/**
 * PushAdapter — wake-on-demand push notifications for mobile agents.
 *
 * Metabolic principle: Expo Push Service (and FCM/APNs behind it) is glucose.
 * This adapter is the enzyme boundary. The relay decides when to push;
 * the adapter handles how.
 *
 * Push payloads carry NO task content — they are wake signals only.
 * The device reconnects via WebSocket to claim pending tasks.
 */

import type { PushPlatform } from "@motebit/protocol";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "push-adapter" });

export interface PushPayload {
  type: "task_wake";
  motebit_id: string;
  pending_count: number;
  ts: number;
}

export interface PushSendResult {
  delivered: boolean;
  error?: string;
}

export interface PushAdapter {
  send(pushToken: string, platform: PushPlatform, payload: PushPayload): Promise<PushSendResult>;
  isAvailable(): boolean;
}

// ---------------------------------------------------------------------------
// Expo Push Service adapter
// ---------------------------------------------------------------------------

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

interface ExpoPushResponse {
  data?: {
    status: "ok" | "error";
    message?: string;
    details?: { error?: string };
  };
}

export class ExpoPushAdapter implements PushAdapter {
  private readonly accessToken: string | undefined;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(config?: { accessToken?: string; fetch?: typeof globalThis.fetch }) {
    this.accessToken = config?.accessToken;
    this._fetch = config?.fetch ?? globalThis.fetch;
  }

  isAvailable(): boolean {
    // Expo push works without auth for low volume; auth required for production
    return true;
  }

  async send(
    pushToken: string,
    _platform: PushPlatform,
    payload: PushPayload,
  ): Promise<PushSendResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const body = {
      to: pushToken,
      data: payload,
      priority: "high",
      channelId: "agent-tasks",
      _contentAvailable: true,
      sound: null,
    };

    try {
      const res = await this._fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { delivered: false, error: `HTTP ${res.status}: ${text}` };
      }

      const json = (await res.json()) as ExpoPushResponse;
      if (json.data?.status === "error") {
        const errorType = json.data.details?.error;
        logger.warn("push.send.error", {
          pushToken: pushToken.slice(0, 20) + "...",
          error: json.data.message,
          errorType,
        });
        return {
          delivered: false,
          error: `${errorType ?? "unknown"}: ${json.data.message ?? ""}`,
        };
      }

      logger.info("push.send.ok", {
        motebitId: payload.motebit_id,
        pendingCount: payload.pending_count,
      });
      return { delivered: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("push.send.failed", { error: msg });
      return { delivered: false, error: msg };
    }
  }
}

// ---------------------------------------------------------------------------
// Push wake helper — called from task dispatch when no WebSocket is active
// ---------------------------------------------------------------------------

/** Rate limiter: at most one push per agent per 30 seconds. */
const pushRateLimit = new Map<string, number>();
const PUSH_RATE_LIMIT_MS = 30_000;

export interface PushWakeDeps {
  pushAdapter: PushAdapter | undefined;
  db: {
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): { changes: number };
    };
  };
}

/**
 * Attempt to wake a mobile agent via push notification.
 * Fire-and-forget — the task stays in queue regardless of outcome.
 * Returns true if at least one push was delivered.
 */
export async function attemptPushWake(motebitId: string, deps: PushWakeDeps): Promise<boolean> {
  if (!deps.pushAdapter?.isAvailable()) return false;

  // Rate limit: skip if we pushed this agent recently
  const lastPush = pushRateLimit.get(motebitId);
  if (lastPush != null && Date.now() - lastPush < PUSH_RATE_LIMIT_MS) return false;

  const tokens = deps.db
    .prepare("SELECT push_token, platform FROM relay_push_tokens WHERE motebit_id = ?")
    .all(motebitId) as Array<{ push_token: string; platform: string }>;

  if (tokens.length === 0) return false;

  pushRateLimit.set(motebitId, Date.now());

  const payload: PushPayload = {
    type: "task_wake",
    motebit_id: motebitId,
    pending_count: 1,
    ts: Date.now(),
  };

  const results = await Promise.allSettled(
    tokens.map((t) => deps.pushAdapter!.send(t.push_token, t.platform as PushPlatform, payload)),
  );

  // Clean up invalid tokens
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (
      r.status === "fulfilled" &&
      !r.value.delivered &&
      (r.value.error?.includes("DeviceNotRegistered") ||
        r.value.error?.includes("InvalidCredentials"))
    ) {
      deps.db
        .prepare("DELETE FROM relay_push_tokens WHERE push_token = ?")
        .run(tokens[i]!.push_token);
      logger.info("push.token.invalidated", {
        motebitId,
        reason: r.value.error,
      });
    }
  }

  return results.some((r) => r.status === "fulfilled" && r.value.delivered);
}
