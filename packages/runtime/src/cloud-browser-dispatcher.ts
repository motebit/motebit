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

import type {
  ComputerAction,
  ComputerFailureReason,
  ReadPageResult,
  ScreencastFrame,
  UserInputEvent,
} from "@motebit/sdk";

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
  "not_in_control",
  "frame_stale",
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
  // 409 Conflict: the page navigated underneath the action — the
  // executor's frame reference is stale. Pairs with browser-sandbox's
  // REASON_STATUS map (frame_stale: 409). Doctrine: motebit-
  // computer.md §"Typed truth on results."
  if (status === 409) return "frame_stale";
  // Co-browse Slice 1: 423 Locked maps back to not_in_control. Pairs
  // with browser-sandbox's REASON_STATUS map; the wire shape stays
  // symmetric so a remote-side gate fires the same reason on the
  // dispatcher side.
  if (status === 423) return "not_in_control";
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
   * Slice 2h — ax-tier `read_page`. POSTs to `/sessions/:id/read-page`
   * and returns the wire-format `ReadPageResult` (page title + body
   * text + heading hierarchy + visible links). No pixels.
   *
   * Sibling of `execute()` for the structured-read path. The
   * `read_page` tool's handler invokes this; the AI receives the
   * full result through `projectForAi` unchanged (no `bytes_base64`
   * field to strip).
   */
  async readPage(): Promise<ReadPageResult> {
    if (this.cloudSessionId === null) {
      throw new ComputerDispatcherError(
        "session_closed",
        "Cloud browser session not opened — call queryDisplay() first.",
      );
    }
    return this.request<ReadPageResult>(
      "POST",
      `/sessions/${encodeURIComponent(this.cloudSessionId)}/read-page`,
    );
  }

  /**
   * Co-browse Slice 2c — forward a user-driven input event to the
   * cloud-browser service. POST /sessions/:id/forward-input. The
   * session manager handles redaction at the audit-emission layer;
   * here the wire carries raw text/keys/coordinates because Chromium
   * needs them.
   *
   * Discrete events only (Slice 2c scope): click, key, paste. Wheel,
   * drag, continuous pointermove are out — those need batching/
   * coalescing and a future slice's WebSocket-shaped substrate.
   */
  async forwardInput(event: UserInputEvent): Promise<void> {
    if (this.cloudSessionId === null) {
      throw new ComputerDispatcherError(
        "session_closed",
        "Cloud browser session not opened — call queryDisplay() first.",
      );
    }
    await this.request<void>(
      "POST",
      `/sessions/${encodeURIComponent(this.cloudSessionId)}/forward-input`,
      { event },
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

  /**
   * v1.3 — open a live JPEG screencast on the active cloud session.
   * Calls the service's `GET /sessions/:id/screencast` endpoint,
   * reads NDJSON frames, and fires `onFrame` per frame. Returns a
   * disposer that aborts the stream + tells the service to stop
   * the CDP screencast (the abort triggers the route's
   * `ReadableStream.cancel`, which runs the server-side disposer).
   *
   * One screencast per cloud session — the service rejects double-
   * starts with `policy_denied`, which surfaces here as a
   * `ComputerDispatcherError`. Callers (apps) typically open the
   * screencast once, after `queryDisplay` returns, and dispose on
   * `closeSession`.
   *
   * Errors (`onError`) fire on transport faults (network drop,
   * non-2xx response, malformed NDJSON line). The frame-decoding
   * loop stops on the first error so the consumer doesn't see a
   * mix of real frames and garbage. The disposer is still safe to
   * call after an error — it aborts the (already-finished) read
   * loop and then sends the abort signal.
   */
  async openScreencast(callbacks: {
    onFrame: (frame: ScreencastFrame) => void;
    onError?: (err: Error) => void;
  }): Promise<() => Promise<void>> {
    if (this.cloudSessionId === null) {
      throw new ComputerDispatcherError(
        "session_closed",
        "Cloud browser session not opened — call queryDisplay() first.",
      );
    }
    const cloudId = this.cloudSessionId;

    let token: string;
    try {
      token = await this.getAuthToken();
    } catch (err) {
      throw new ComputerDispatcherError(
        "permission_denied",
        err instanceof Error ? err.message : String(err),
      );
    }

    const controller = new AbortController();
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/sessions/${encodeURIComponent(cloudId)}/screencast`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/x-ndjson",
          },
          signal: controller.signal,
        },
      );
    } catch (err) {
      throw new ComputerDispatcherError(
        "platform_blocked",
        err instanceof Error ? err.message : String(err),
      );
    }

    if (!response.ok) {
      throw await this.errorFromResponse(response);
    }
    if (!response.body) {
      throw new ComputerDispatcherError(
        "platform_blocked",
        "screencast response missing body stream",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stopped = false;

    // Read loop — fire-and-forget. The disposer aborts the controller
    // which cancels the read; the loop exits via the abort error.
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.length > 0) {
              try {
                const frame = JSON.parse(line) as ScreencastFrame;
                if (!stopped) callbacks.onFrame(frame);
              } catch (err) {
                if (!stopped) {
                  callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
                }
                return;
              }
            }
            nl = buffer.indexOf("\n");
          }
        }
      } catch (err) {
        // Aborts surface as DOMException AbortError — that's the
        // disposer doing its job, not a real error to surface.
        if (stopped) return;
        if (err instanceof Error && err.name === "AbortError") return;
        callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    // Async signature satisfies the openScreencast contract (`Promise<()
    // => Promise<void>>`), but the body's only side effect is an
    // immediate AbortController.abort — no await needed. Wrap in
    // Promise.resolve() so lint doesn't fire on async-without-await
    // while preserving the documented signature.
    return () => {
      if (stopped) return Promise.resolve();
      stopped = true;
      try {
        controller.abort();
      } catch {
        // Already aborted or controller in a bad state.
      }
      return Promise.resolve();
    };
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
