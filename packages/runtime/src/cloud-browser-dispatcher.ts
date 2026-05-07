/**
 * Cloud-browser `ComputerPlatformDispatcher` — the second implementer
 * of the dispatcher contract declared in `computer-use.ts:75`. Where
 * the desktop Tauri bridge maps `computer-use-v1` actions to the
 * user's real OS via `xcap` + `enigo`, this dispatcher maps the same
 * wire format to an isolated cloud browser session served by
 * `services/browser-sandbox` (Playwright-driven Chromium).
 *
 * Doctrine binding (`docs/doctrine/motebit-computer.md`,
 * `EMBODIMENT_MODE_CONTRACTS.virtual_browser`):
 *
 *   - mode = `virtual_browser`
 *   - source = `isolated-browser`
 *   - driver = `motebit`
 *   - consent = session-scoped grant + per-action escalation for
 *     irreversible actions (governance layer; see
 *     `@motebit/policy-invariants` `classifyComputerAction`)
 *   - sensitivity = `tier-bounded-by-source`; every screenshot passes
 *     the existing OCR-aware classifier before reaching external AI
 *     (the dispatcher does NOT classify itself — it returns the
 *     observation verbatim and the session manager's
 *     `classifyObservation` hook handles redaction)
 *
 * v1 contract limitations (kept honest):
 *
 *   - **Single active session per dispatcher instance.** One motebit
 *     holds one cloud browser at a time. The Tauri dispatcher matches
 *     this shape (one OS, one cursor) — when concurrent cloud sessions
 *     become a real consumer need, the contract grows a `session_id`
 *     param on `execute` for both backends.
 *   - **No co-browse.** This dispatcher is motebit-driven only. The
 *     "user drives in motebit's sandbox" pattern is a distinct future
 *     embodiment row, not a runtime mode of this dispatcher.
 *   - **No new wire actions.** Reuses the six computer-use-v1 kinds
 *     (`screenshot`, `cursor_position`, `click`, `double_click`,
 *     `key`, `type`, `scroll`) verbatim. URL navigation works by
 *     typing into the address bar, not a new `navigate` kind.
 *
 * Auth shape: caller supplies `getAuthToken` returning a bearer token
 * the cloud-browser service accepts (the relay's signed audience-bound
 * token model — the service's `aud` will be `browser-sandbox` once
 * the service ships in slice 2). This dispatcher is transport only;
 * it does not mint tokens.
 *
 * @alpha — see `packages/protocol/src/computer-use.ts` release-status
 * block. Promotion to `@beta` is gated on this being a real second
 * producer (i.e. `services/browser-sandbox` exercising the format in
 * anger).
 */

import type { ComputerAction, ComputerFailureReason } from "@motebit/sdk";

import type { ComputerDisplayInfo, ComputerPlatformDispatcher } from "./computer-use.js";
import { ComputerDispatcherError } from "./computer-use.js";

/**
 * Caller-supplied transport configuration. `fetch` is injected for
 * test determinism; in production the global is fine.
 */
export interface CloudBrowserDispatcherOptions {
  /** Base URL of the `services/browser-sandbox` HTTP API, no trailing slash. */
  readonly baseUrl: string;
  /**
   * Returns a bearer token the service accepts. Called once per
   * request — async so the caller can refresh on the relay's lifecycle
   * (matches the relay's signed-token model). Throwing maps to
   * `permission_denied`.
   */
  readonly getAuthToken: () => Promise<string> | string;
  /**
   * Optional fetch implementation for tests. Defaults to
   * `globalThis.fetch`. Same shape as `typeof fetch`.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Service response shape for `POST /sessions/ensure`. The service
 * returns its own opaque `session_id` plus the display geometry of
 * the allocated browser viewport. The `session_id` is internal to the
 * dispatcher↔service link; the runtime's session manager has its own
 * client-side id (which is what flows into signed audit events).
 */
interface EnsureSessionResponse {
  readonly session_id: string;
  readonly display: ComputerDisplayInfo;
}

/**
 * Service error envelope. The service mirrors the desktop Rust shape:
 * structured `reason` from the `ComputerFailureReason` set + a
 * human-readable `message`. Anything else maps to `platform_blocked`.
 */
interface ServiceErrorEnvelope {
  readonly error: {
    readonly reason: string;
    readonly message?: string;
  };
}

const KNOWN_FAILURE_REASONS: ReadonlySet<ComputerFailureReason> = new Set<ComputerFailureReason>([
  "policy_denied",
  "approval_required",
  "approval_expired",
  "permission_denied",
  "session_closed",
  "target_not_found",
  "target_obscured",
  "user_preempted",
  "platform_blocked",
  "not_supported",
]);

/**
 * Map an HTTP status code to the closest `ComputerFailureReason` when
 * the service didn't return a structured error body. Conservative —
 * defaults to `platform_blocked` so unmapped statuses fail closed.
 */
function statusToReason(status: number): ComputerFailureReason {
  if (status === 401 || status === 403) return "permission_denied";
  if (status === 404) return "session_closed";
  if (status === 408 || status === 504) return "user_preempted";
  if (status === 409) return "session_closed";
  if (status === 429) return "policy_denied";
  if (status === 501) return "not_supported";
  return "platform_blocked";
}

function isServiceErrorEnvelope(value: unknown): value is ServiceErrorEnvelope {
  if (value === null || typeof value !== "object") return false;
  const err = (value as Record<string, unknown>).error;
  if (err === null || typeof err !== "object") return false;
  return typeof (err as Record<string, unknown>).reason === "string";
}

/**
 * `ComputerPlatformDispatcher` backed by the cloud-browser HTTP
 * service. One instance handles one motebit's one active cloud
 * session; the service routes by motebit identity (extracted from the
 * bearer token) so the dispatcher does not need to thread session ids
 * through the contract.
 */
export class CloudBrowserDispatcher implements ComputerPlatformDispatcher {
  private readonly baseUrl: string;
  private readonly getAuthToken: () => Promise<string> | string;
  private readonly fetchImpl: typeof globalThis.fetch;
  /**
   * Service-side session id from the most recent `queryDisplay`. Held
   * for `dispose` so the service can tear down the right Chromium
   * context. `null` before `queryDisplay` and after `dispose`.
   */
  private cloudSessionId: string | null = null;

  constructor(opts: CloudBrowserDispatcherOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.getAuthToken = opts.getAuthToken;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async queryDisplay(): Promise<ComputerDisplayInfo> {
    const res = await this.request<EnsureSessionResponse>("POST", "/sessions/ensure");
    this.cloudSessionId = res.session_id;
    return res.display;
  }

  async execute(action: ComputerAction): Promise<unknown> {
    if (this.cloudSessionId === null) {
      throw new ComputerDispatcherError(
        "session_closed",
        "Cloud browser session not opened — call queryDisplay() first.",
      );
    }
    return this.request<unknown>(
      "POST",
      `/sessions/${encodeURIComponent(this.cloudSessionId)}/actions`,
      { action },
    );
  }

  /**
   * Tear down the cloud browser session. The `sessionId` arg from the
   * runtime's session manager is the manager's client-side id, not
   * the cloud session id — for v1 (single active cloud session) we
   * dispose the only one we know about and ignore the param. The
   * service idempotently no-ops if the session was already closed.
   */
  async dispose(_sessionId: string): Promise<void> {
    const cloudId = this.cloudSessionId;
    if (cloudId === null) return;
    try {
      await this.request<void>("DELETE", `/sessions/${encodeURIComponent(cloudId)}`);
    } finally {
      this.cloudSessionId = null;
    }
  }

  // ── Internal: signed HTTP roundtrip ────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let token: string;
    try {
      token = await this.getAuthToken();
    } catch (err) {
      throw new ComputerDispatcherError(
        "permission_denied",
        err instanceof Error ? err.message : String(err),
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ComputerDispatcherError(
        "platform_blocked",
        err instanceof Error ? err.message : String(err),
      );
    }

    if (!response.ok) {
      throw await this.errorFromResponse(response);
    }

    if (response.status === 204) return undefined as T;

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new ComputerDispatcherError(
        "platform_blocked",
        `cloud-browser response not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async errorFromResponse(response: Response): Promise<ComputerDispatcherError> {
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // Fall through to status-code mapping below.
    }
    if (isServiceErrorEnvelope(parsed)) {
      const reason = KNOWN_FAILURE_REASONS.has(parsed.error.reason as ComputerFailureReason)
        ? (parsed.error.reason as ComputerFailureReason)
        : statusToReason(response.status);
      return new ComputerDispatcherError(reason, parsed.error.message ?? response.statusText);
    }
    return new ComputerDispatcherError(statusToReason(response.status), response.statusText);
  }
}
