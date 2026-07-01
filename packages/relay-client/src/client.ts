/**
 * RelayClient — the one typed transport for the relay's HTTP surface.
 *
 * Before this package, at least six independent `relayFetch`-style helpers
 * (runtime commands, cli, mobile, sync-engine's adapter, plus per-purpose
 * runtime singletons) re-implemented URL join + Bearer header + error
 * handling, and every request/response body was an inline anonymous type
 * free to drift from the relay. This client is the client half of the
 * contract whose server half is `services/relay`; the shared truth is
 * `@motebit/wire-schemas` (Layer 1), consumed here for validation wherever
 * a schema exists.
 *
 * Contract tiers, stated per method:
 *   - "validated" — the response is parsed against the committed wire
 *     schema; a mismatch throws `kind: "schema"` (fail-closed, never a
 *     silently wrong shape).
 *   - "declared" — the endpoint has no wire schema yet; the response is
 *     typed by a hand-written interface and trusted. Each declared method
 *     is a TODO pointing at the schema-authoring increment, not a hidden
 *     `any`.
 *
 * Auth is the relay's dual-bearer model, resolved per request in strict
 * precedence order: injected `CredentialSource` (the `@motebit/sdk`
 * contract) → device-key minting (audience-bound `createSignedToken`,
 * the cross-endpoint-replay defense — each method names its
 * `TokenAudience` from the closed registry) → static bearer token.
 * Endpoints that require auth throw `kind: "auth"` before the network
 * when nothing resolves; public endpoints send no header.
 *
 * All I/O seams are injected (`fetchImpl`, `now`) per the adapter
 * principle — the client never binds to a global it can't be tested
 * or re-platformed without.
 */

import type { CredentialSource } from "@motebit/sdk";
import type { AgentResolutionResult, AgentTask, ExecutionReceipt } from "@motebit/protocol";
import {
  type TokenAudience,
  ACCOUNT_BALANCE_AUDIENCE,
  TASK_QUERY_AUDIENCE,
  TASK_SUBMIT_AUDIENCE,
} from "@motebit/protocol";
import { createSignedToken } from "@motebit/crypto";
import { AgentResolutionResultSchema } from "@motebit/wire-schemas";
import { RelayClientError } from "./errors.js";

/** Device signing identity for audience-bound token minting. */
export interface DeviceKeyAuth {
  motebitId: string;
  deviceId: string;
  /** Ed25519 private key bytes — stays inside the client, never logged. */
  privateKey: Uint8Array;
}

export interface RelayClientAuth {
  /** Highest precedence — the sdk credential adapter (keyring, vault, …). */
  credentialSource?: CredentialSource;
  /** Mints a short-lived audience-bound signed token per request. */
  deviceKey?: DeviceKeyAuth;
  /** Lowest precedence — a static bearer (e.g. operator master token). */
  staticToken?: string;
}

export interface RelayClientConfig {
  /** Relay origin, e.g. `https://relay.motebit.com`. Trailing slash ok. */
  baseUrl: string;
  auth?: RelayClientAuth;
  /** Injected fetch — defaults to the ambient global. */
  fetchImpl?: typeof fetch;
  /** Injected clock (ms epoch) for token iat/exp — defaults to Date.now. */
  now?: () => number;
  /** Retries for idempotent GETs on transient failures. Default 2. */
  maxRetries?: number;
  /** Base backoff in ms, doubled per attempt. Default 250. */
  retryBackoffMs?: number;
}

/** Signed-token lifetime — matches the relay-side 5-minute convention. */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Transient statuses worth retrying on idempotent requests. */
function isRetryable(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * Declared (unvalidated) shape of `GET /api/v1/agents/:id/balance`.
 * Amounts are decimal USD (the relay converts from micro-units at its
 * boundary via `fromMicro`). TODO(relay-client Inc 2): replace with the
 * wire-schemas contract once the account family is schema-bound.
 */
export interface AccountBalance {
  motebit_id: string;
  balance: number;
  currency: string;
  pending_withdrawals: number;
  pending_allocations: number;
  dispute_window_hold: number;
  available_for_withdrawal: number;
  sweep_threshold: number | null;
  settlement_address: string | null;
  transactions: unknown[];
}

/** Declared shape of `POST /agent/:id/task` (submit). */
export interface SubmitTaskRequest {
  prompt: string;
  submitted_by?: string;
  wall_clock_ms?: number;
  required_capabilities?: string[];
  step_id?: string;
}

/** Declared response of a task submission. */
export interface SubmitTaskResponse {
  task_id: string;
  [key: string]: unknown;
}

/** Declared response of `GET /agent/:id/task/:taskId` (poll). */
export interface TaskPollResponse {
  task: AgentTask;
  receipt: ExecutionReceipt | null;
}

export class RelayClient {
  private readonly baseUrl: string;
  private readonly auth: RelayClientAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;

  constructor(config: RelayClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.auth = config.auth ?? {};
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBackoffMs = config.retryBackoffMs ?? 250;
  }

  // ── Public surface ───────────────────────────────────────────────────

  /**
   * `GET /api/v1/discover/:motebitId` — federation-wide agent resolution.
   * Contract tier: VALIDATED (`AgentResolutionResultSchema`). Public
   * endpoint — sends auth only if a credential resolves.
   */
  async discover(motebitId: string): Promise<AgentResolutionResult> {
    const path = `/api/v1/discover/${encodeURIComponent(motebitId)}`;
    const body = await this.requestJson("GET", path, {
      retry: true,
    });
    const parsed = AgentResolutionResultSchema.safeParse(body);
    if (!parsed.success) {
      throw new RelayClientError(
        "schema",
        path,
        `discover response failed AgentResolutionResultSchema: ${parsed.error.message}`,
      );
    }
    return parsed.data as AgentResolutionResult;
  }

  /**
   * `GET /api/v1/agents/:motebitId/balance`. Contract tier: DECLARED.
   * Audience: `account:balance`.
   */
  async getBalance(motebitId: string): Promise<AccountBalance> {
    const path = `/api/v1/agents/${encodeURIComponent(motebitId)}/balance`;
    const body = await this.requestJson("GET", path, {
      audience: ACCOUNT_BALANCE_AUDIENCE,
      retry: true,
    });
    return body as AccountBalance;
  }

  /**
   * `POST /agent/:targetMotebitId/task` — submit a delegation task.
   * Contract tier: DECLARED. Audience: `task:submit`. The relay requires
   * an `Idempotency-Key` header (budget allocation is downstream) — the
   * caller supplies it so a retry by the CALLER replays, never double-spends.
   */
  async submitTask(
    targetMotebitId: string,
    request: SubmitTaskRequest,
    options: { idempotencyKey: string },
  ): Promise<SubmitTaskResponse> {
    const path = `/agent/${encodeURIComponent(targetMotebitId)}/task`;
    const body = await this.requestJson("POST", path, {
      audience: TASK_SUBMIT_AUDIENCE,
      retry: false,
      jsonBody: request,
      headers: { "Idempotency-Key": options.idempotencyKey },
    });
    return body as SubmitTaskResponse;
  }

  /**
   * `GET /agent/:targetMotebitId/task/:taskId` — poll a submitted task.
   * Contract tier: DECLARED. Audience: `task:query` (the submitter's own
   * token; the relay authorizes submitter-or-target).
   */
  async getTask(targetMotebitId: string, taskId: string): Promise<TaskPollResponse> {
    const path = `/agent/${encodeURIComponent(targetMotebitId)}/task/${encodeURIComponent(taskId)}`;
    const body = await this.requestJson("GET", path, {
      audience: TASK_QUERY_AUDIENCE,
      retry: true,
    });
    return body as TaskPollResponse;
  }

  // ── Transport kernel ─────────────────────────────────────────────────

  private async requestJson(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: {
      /** Audience for the auth token. Omitted ⇒ public endpoint, no header. */
      audience?: TokenAudience;
      retry: boolean;
      jsonBody?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<unknown> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.jsonBody !== undefined) headers["Content-Type"] = "application/json";

    if (opts.audience !== undefined) {
      const token = await this.resolveToken(opts.audience);
      if (token == null) {
        throw new RelayClientError(
          "auth",
          path,
          `no credential available for ${path} (audience ${opts.audience}) — provide credentialSource, deviceKey, or staticToken`,
        );
      }
      headers["Authorization"] = `Bearer ${token}`;
    }

    const init: RequestInit = {
      method,
      headers,
      ...(opts.jsonBody !== undefined ? { body: JSON.stringify(opts.jsonBody) } : {}),
    };

    const res = await this.fetchWithRetry(path, init, opts.retry);
    if (!res.ok) {
      let bodyText: string | undefined;
      try {
        bodyText = await res.text();
      } catch {
        bodyText = undefined;
      }
      throw new RelayClientError("http", path, `${method} ${path} → ${res.status}`, {
        status: res.status,
        body: bodyText,
      });
    }
    try {
      return (await res.json()) as unknown;
    } catch (err: unknown) {
      throw new RelayClientError("parse", path, `${method} ${path} returned non-JSON body`, {
        cause: err,
      });
    }
  }

  private async fetchWithRetry(path: string, init: RequestInit, retry: boolean): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const attempts = retry ? this.maxRetries + 1 : 1;
    let lastNetworkError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, init);
        if (res.ok || !retry || !isRetryable(res.status) || attempt === attempts - 1) {
          return res;
        }
      } catch (err: unknown) {
        lastNetworkError = err;
        if (attempt === attempts - 1) break;
      }
      await this.backoff(attempt);
    }
    throw new RelayClientError(
      "network",
      path,
      `request to ${path} failed after ${attempts} attempt(s)`,
      {
        cause: lastNetworkError,
      },
    );
  }

  private backoff(attempt: number): Promise<void> {
    const delay = this.retryBackoffMs * 2 ** attempt;
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  private async resolveToken(audience: TokenAudience): Promise<string | null> {
    if (this.auth.credentialSource) {
      const token = await this.auth.credentialSource.getCredential({
        serverUrl: this.baseUrl,
        scope: audience,
      });
      if (token != null && token !== "") return token;
    }
    if (this.auth.deviceKey) {
      // iat/exp are MILLISECOND epochs — the motebit signed-token convention
      // (deliberately not JWT's seconds): every existing minter uses
      // `Date.now() + ms` and `verifySignedToken` compares exp to Date.now().
      const iat = this.now();
      return createSignedToken(
        {
          mid: this.auth.deviceKey.motebitId,
          did: this.auth.deviceKey.deviceId,
          iat,
          exp: iat + TOKEN_TTL_MS,
          jti: globalThis.crypto.randomUUID(),
          aud: audience,
        },
        this.auth.deviceKey.privateKey,
      );
    }
    if (this.auth.staticToken != null && this.auth.staticToken !== "") {
      return this.auth.staticToken;
    }
    return null;
  }
}
