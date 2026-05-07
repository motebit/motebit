/**
 * Tests for `CloudBrowserDispatcher` — the second
 * `ComputerPlatformDispatcher` implementer.
 *
 * Mocks `fetch` and asserts the dispatcher round-trips computer-use-v1
 * actions against the cloud-browser HTTP API the way the runtime's
 * session manager will drive it. Covers:
 *
 *   - session lifecycle (queryDisplay creates session, dispose tears
 *     it down, dispose is idempotent)
 *   - execute fails closed when no session is open
 *   - HTTP error → `ComputerFailureReason` mapping (status-code
 *     fallback + structured envelope override)
 *   - auth header threading (every request carries the bearer token)
 *   - network error / non-JSON / wrong shape all map honestly
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ComputerAction } from "@motebit/sdk";
import {
  CloudBrowserDispatcher,
  type CloudBrowserDispatcherOptions,
} from "../cloud-browser-dispatcher.js";
import { ComputerDispatcherError } from "../computer-use.js";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface MockFetchOptions {
  /** Status to return (default 200). */
  status?: number;
  /** JSON body to return. Set to `undefined` for 204 No Content. */
  body?: unknown;
  /** Throw a network error instead of returning a response. */
  networkError?: Error;
  /** Return a body that fails JSON.parse. */
  nonJsonBody?: string;
}

function makeFetch(
  responses: MockFetchOptions[],
  calls: FetchCall[] = [],
): { fetchImpl: typeof globalThis.fetch; calls: FetchCall[] } {
  let i = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const opts = responses[i++] ?? {};
    if (opts.networkError) throw opts.networkError;
    const status = opts.status ?? 200;
    const json = async (): Promise<unknown> => {
      if (opts.nonJsonBody !== undefined) throw new Error("not JSON");
      return opts.body;
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      json,
    } as unknown as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

function makeDispatcher(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<CloudBrowserDispatcherOptions> = {},
): CloudBrowserDispatcher {
  return new CloudBrowserDispatcher({
    baseUrl: "https://browser.example.com",
    getAuthToken: () => "tok-abc",
    fetch: fetchImpl,
    ...overrides,
  });
}

const SCREENSHOT_ACTION: ComputerAction = { kind: "screenshot" } as ComputerAction;

describe("CloudBrowserDispatcher", () => {
  let calls: FetchCall[];

  beforeEach(() => {
    calls = [];
  });

  describe("queryDisplay", () => {
    it("opens a cloud session and returns display info", async () => {
      const { fetchImpl } = makeFetch(
        [
          {
            body: {
              session_id: "cs-server-42",
              display: { width: 1280, height: 800, scaling_factor: 1 },
            },
          },
        ],
        calls,
      );
      const d = makeDispatcher(fetchImpl);
      const display = await d.queryDisplay();
      expect(display).toEqual({ width: 1280, height: 800, scaling_factor: 1 });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("POST");
      expect(calls[0]?.url).toBe("https://browser.example.com/sessions/ensure");
      expect(calls[0]?.headers.Authorization).toBe("Bearer tok-abc");
    });

    it("trims trailing slashes on baseUrl", async () => {
      const { fetchImpl } = makeFetch(
        [{ body: { session_id: "x", display: { width: 1, height: 1, scaling_factor: 1 } } }],
        calls,
      );
      const d = makeDispatcher(fetchImpl, { baseUrl: "https://browser.example.com//" });
      await d.queryDisplay();
      expect(calls[0]?.url).toBe("https://browser.example.com/sessions/ensure");
    });
  });

  describe("execute", () => {
    it("fails closed with session_closed when called before queryDisplay", async () => {
      const { fetchImpl } = makeFetch([], calls);
      const d = makeDispatcher(fetchImpl);
      await expect(d.execute(SCREENSHOT_ACTION)).rejects.toMatchObject({
        name: "ComputerDispatcherError",
        reason: "session_closed",
      });
      expect(calls).toHaveLength(0);
    });

    it("posts the action to /sessions/:id/actions after a session is open", async () => {
      const { fetchImpl } = makeFetch(
        [
          { body: { session_id: "cs-1", display: { width: 100, height: 100, scaling_factor: 1 } } },
          { body: { kind: "screenshot", artifact_id: "shot-1" } },
        ],
        calls,
      );
      const d = makeDispatcher(fetchImpl);
      await d.queryDisplay();
      const result = (await d.execute(SCREENSHOT_ACTION)) as { kind: string; artifact_id: string };
      expect(result.artifact_id).toBe("shot-1");
      expect(calls[1]?.method).toBe("POST");
      expect(calls[1]?.url).toBe("https://browser.example.com/sessions/cs-1/actions");
      expect(calls[1]?.body).toBe(JSON.stringify({ action: SCREENSHOT_ACTION }));
    });
  });

  describe("dispose", () => {
    it("DELETEs the cloud session and clears stash", async () => {
      const { fetchImpl } = makeFetch(
        [
          {
            body: {
              session_id: "cs-server-42",
              display: { width: 1, height: 1, scaling_factor: 1 },
            },
          },
          { status: 204 },
        ],
        calls,
      );
      const d = makeDispatcher(fetchImpl);
      await d.queryDisplay();
      await d.dispose("manager-side-id-ignored");
      expect(calls[1]?.method).toBe("DELETE");
      expect(calls[1]?.url).toBe("https://browser.example.com/sessions/cs-server-42");
      // Idempotent: a second dispose makes no HTTP call (state cleared).
      await d.dispose("manager-side-id-ignored");
      expect(calls).toHaveLength(2);
    });

    it("clears state even if the DELETE fails", async () => {
      const { fetchImpl } = makeFetch(
        [
          { body: { session_id: "cs-1", display: { width: 1, height: 1, scaling_factor: 1 } } },
          { status: 500, body: { error: { reason: "platform_blocked", message: "boom" } } },
        ],
        calls,
      );
      const d = makeDispatcher(fetchImpl);
      await d.queryDisplay();
      await expect(d.dispose("ignored")).rejects.toBeInstanceOf(ComputerDispatcherError);
      // Second dispose is a no-op — state was cleared in `finally`.
      await d.dispose("ignored");
      expect(calls).toHaveLength(2);
    });
  });

  describe("HTTP error mapping", () => {
    it("maps 401 to permission_denied via status-code fallback", async () => {
      const { fetchImpl } = makeFetch([{ status: 401, nonJsonBody: "unauthorized" }], calls);
      const d = makeDispatcher(fetchImpl);
      await expect(d.queryDisplay()).rejects.toMatchObject({
        name: "ComputerDispatcherError",
        reason: "permission_denied",
      });
    });

    it("maps 404 to session_closed", async () => {
      const { fetchImpl } = makeFetch(
        [
          { body: { session_id: "cs", display: { width: 1, height: 1, scaling_factor: 1 } } },
          { status: 404, nonJsonBody: "" },
        ],
        calls,
      );
      const d = makeDispatcher(fetchImpl);
      await d.queryDisplay();
      await expect(d.execute(SCREENSHOT_ACTION)).rejects.toMatchObject({
        reason: "session_closed",
      });
    });

    it("maps 429 to policy_denied", async () => {
      const { fetchImpl } = makeFetch([{ status: 429, nonJsonBody: "" }], calls);
      const d = makeDispatcher(fetchImpl);
      await expect(d.queryDisplay()).rejects.toMatchObject({ reason: "policy_denied" });
    });

    it("maps 501 to not_supported", async () => {
      const { fetchImpl } = makeFetch([{ status: 501, nonJsonBody: "" }], calls);
      const d = makeDispatcher(fetchImpl);
      await expect(d.queryDisplay()).rejects.toMatchObject({ reason: "not_supported" });
    });

    it("maps unknown 5xx to platform_blocked", async () => {
      const { fetchImpl } = makeFetch([{ status: 503, nonJsonBody: "" }], calls);
      const d = makeDispatcher(fetchImpl);
      await expect(d.queryDisplay()).rejects.toMatchObject({ reason: "platform_blocked" });
    });

    it("respects structured error envelope when present", async () => {
      const { fetchImpl } = makeFetch(
        [{ status: 400, body: { error: { reason: "target_obscured", message: "occluded" } } }],
        calls,
      );
      const d = makeDispatcher(fetchImpl);
      await expect(d.queryDisplay()).rejects.toMatchObject({
        reason: "target_obscured",
        message: "occluded",
      });
    });

    it("falls back to status mapping when envelope.reason is unknown", async () => {
      const { fetchImpl } = makeFetch(
        [{ status: 401, body: { error: { reason: "made_up", message: "" } } }],
        calls,
      );
      const d = makeDispatcher(fetchImpl);
      await expect(d.queryDisplay()).rejects.toMatchObject({ reason: "permission_denied" });
    });

    it("maps network failures to platform_blocked", async () => {
      const { fetchImpl } = makeFetch([{ networkError: new Error("ECONNREFUSED") }], calls);
      const d = makeDispatcher(fetchImpl);
      await expect(d.queryDisplay()).rejects.toMatchObject({
        reason: "platform_blocked",
        message: "ECONNREFUSED",
      });
    });

    it("maps token-fetch failures to permission_denied", async () => {
      const { fetchImpl } = makeFetch([], calls);
      const d = makeDispatcher(fetchImpl, {
        getAuthToken: () => {
          throw new Error("token expired");
        },
      });
      await expect(d.queryDisplay()).rejects.toMatchObject({
        reason: "permission_denied",
        message: "token expired",
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe("auth header threading", () => {
    it("re-evaluates getAuthToken on every request", async () => {
      const tokens = ["tok-1", "tok-2", "tok-3"];
      let i = 0;
      const { fetchImpl } = makeFetch(
        [
          { body: { session_id: "cs", display: { width: 1, height: 1, scaling_factor: 1 } } },
          { body: {} },
          { status: 204 },
        ],
        calls,
      );
      const d = makeDispatcher(fetchImpl, { getAuthToken: () => tokens[i++] ?? "" });
      await d.queryDisplay();
      await d.execute(SCREENSHOT_ACTION);
      await d.dispose("ignored");
      expect(calls.map((c) => c.headers.Authorization)).toEqual([
        "Bearer tok-1",
        "Bearer tok-2",
        "Bearer tok-3",
      ]);
    });
  });
});
