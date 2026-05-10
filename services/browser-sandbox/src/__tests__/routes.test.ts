/**
 * HTTP-level tests for the browser-sandbox routes.
 *
 * Uses Hono's in-process `app.fetch` so the server doesn't need to
 * bind a real port. The `BrowserPool` is faked to skip real Chromium
 * — the route layer's job is auth + dispatch + error envelope, which
 * is what we exercise here. Real-Playwright tests live separately.
 *
 * Asserts:
 *   - GET /health is unauthenticated
 *   - protected routes return 401 + permission_denied envelope
 *     without bearer
 *   - happy paths return the wire shape `CloudBrowserDispatcher` reads
 *   - error paths return the structured `{ error: { reason } }` envelope
 *     with the right HTTP status
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the screencast module — the route's stream-start handler
// calls `startScreencast(session.page, onFrame)`, which would attach
// CDP against the fake page. The mock fires one synthetic frame so
// tests that read the body can exercise the start path; the
// disposer is a no-op so the cancel path runs cleanly.
vi.mock("../screencast.js", () => ({
  startScreencast: vi.fn(async (_page: unknown, onFrame: (frame: unknown) => void) => {
    // Fire one frame so the start handler enqueues something readable.
    onFrame({ jpeg_base64: "AAAA", timestamp: 1, device_width: 1280, device_height: 800 });
    return async () => undefined;
  }),
}));

import { buildApp } from "../routes.js";
import type { BrowserSandboxConfig } from "../env.js";
import type { BrowserPool, BrowserSession } from "../chromium-pool.js";
import { ServiceError } from "../errors.js";

const TEST_TOKEN = "test-token-1234567890abcdef";

const TEST_CONFIG: BrowserSandboxConfig = {
  apiToken: TEST_TOKEN,
  trustedRelayPublicKeyHex: null,
  port: 0,
  maxConcurrentSessions: 4,
  sessionIdleMs: 60_000,
  viewportWidth: 1280,
  viewportHeight: 800,
};

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

interface FakePoolState {
  sessions: Map<string, BrowserSession>;
  openSessionImpl: () => Promise<BrowserSession>;
}

function makeFakePool(): { pool: BrowserPool; state: FakePoolState } {
  const sessions = new Map<string, BrowserSession>();
  let counter = 0;
  const fakeOpen = async (): Promise<BrowserSession> => {
    const id = `fake-session-${++counter}`;
    const session = {
      sessionId: id,
      page: {
        viewportSize: () => ({ width: 1280, height: 800 }),
        screenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        mouse: {
          click: async () => undefined,
          dblclick: async () => undefined,
          move: async () => undefined,
          down: async () => undefined,
          up: async () => undefined,
          wheel: async () => undefined,
        },
        keyboard: {
          type: async () => undefined,
          press: async () => undefined,
        },
      },
      context: {},
      openedAt: 1_000_000,
      lastUsedAt: 1_000_000,
      lastCursorX: 0,
      lastCursorY: 0,
      inFlight: 0,
      // The screencast route's double-start guard checks for `!== null`;
      // an undefined slot would falsely look "in use" to that check.
      stopScreencast: null,
    } as unknown as BrowserSession;
    sessions.set(id, session);
    return session;
  };

  const state: FakePoolState = { sessions, openSessionImpl: fakeOpen };

  const pool = {
    openSession: () => state.openSessionImpl(),
    getSession: (id: string) => sessions.get(id) ?? null,
    touchSession: () => undefined,
    closeSession: async (id: string) => {
      sessions.delete(id);
    },
    size: () => sessions.size,
    reapIdle: async () => undefined,
    shutdown: async () => undefined,
    start: async () => undefined,
    beginAction: (id: string) => {
      const s = sessions.get(id);
      if (s) (s as { inFlight: number }).inFlight += 1;
    },
    endAction: (id: string) => {
      const s = sessions.get(id);
      if (s && (s as { inFlight: number }).inFlight > 0) {
        (s as { inFlight: number }).inFlight -= 1;
      }
    },
  } as unknown as BrowserPool;

  return { pool, state };
}

describe("browser-sandbox routes", () => {
  let pool: BrowserPool;
  let state: FakePoolState;

  beforeEach(() => {
    ({ pool, state } = makeFakePool());
  });

  describe("GET /health", () => {
    it("returns ok without auth", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; service: string };
      expect(body).toMatchObject({ ok: true, service: "browser-sandbox" });
    });
  });

  describe("CORS", () => {
    // Browser dispatchers cross-origin to this service; without CORS,
    // OPTIONS preflight 401s and the actual POST never fires. See the
    // CORS comment block in routes.ts for the security model.
    it("OPTIONS preflight on /sessions/ensure succeeds without auth (allows POST + Authorization)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/ensure", {
        method: "OPTIONS",
        headers: {
          Origin: "https://motebit.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      // 204 (or 200) — the key contract is that browsers see a
      // success status with permissive CORS headers, NOT the 401 the
      // bearer middleware would otherwise emit.
      expect(res.status).toBeLessThan(300);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const allowMethods = res.headers.get("access-control-allow-methods") ?? "";
      expect(allowMethods).toMatch(/POST/i);
      expect(allowMethods).toMatch(/OPTIONS/i);
      const allowHeaders = res.headers.get("access-control-allow-headers") ?? "";
      expect(allowHeaders.toLowerCase()).toMatch(/authorization/);
      expect(allowHeaders.toLowerCase()).toMatch(/content-type/);
    });

    it("non-OPTIONS responses carry Access-Control-Allow-Origin so browsers accept the result", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/health", {
        method: "GET",
        headers: { Origin: "http://localhost:5173" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  });

  describe("auth", () => {
    it("rejects /sessions/ensure without bearer (401 + permission_denied)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/ensure", { method: "POST" });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("permission_denied");
    });

    it("rejects /sessions/:id/actions without bearer", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/abc/actions", { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects with wrong bearer", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/ensure", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token-but-same-length-ish-length" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /sessions/ensure", () => {
    it("returns session_id + display", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        session_id: string;
        display: { width: number; height: number; scaling_factor: number };
      };
      expect(body.session_id).toBe("fake-session-1");
      expect(body.display).toEqual({ width: 1280, height: 800, scaling_factor: 1 });
    });

    it("maps pool errors to the right wire envelope", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      state.openSessionImpl = async () => {
        throw new ServiceError("policy_denied", "concurrent session cap reached (4)");
      };
      const res = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { reason: string; message: string } };
      expect(body.error.reason).toBe("policy_denied");
      expect(body.error.message).toContain("cap reached");
    });
  });

  describe("POST /sessions/:id/actions", () => {
    it("executes a screenshot action and returns wire shape", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      // Open session first
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };

      const res = await app.request(`/sessions/${session_id}/actions`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: { kind: "screenshot" } }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string; bytes_base64: string };
      expect(body.kind).toBe("screenshot");
      expect(typeof body.bytes_base64).toBe("string");
    });

    it("returns 404 + session_closed for unknown session id", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/nope/actions", {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: { kind: "screenshot" } }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("session_closed");
    });

    it("returns 501 + not_supported for malformed action body", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };

      const res = await app.request(`/sessions/${session_id}/actions`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("not_supported");
    });

    it("decrements inFlight on a happy-path action (begin/end discipline)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      expect(session.inFlight).toBe(0);

      const res = await app.request(`/sessions/${session_id}/actions`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: { kind: "screenshot" } }),
      });
      expect(res.status).toBe(200);
      // After the action returns, inFlight has returned to zero.
      expect(session.inFlight).toBe(0);
    });

    it("decrements inFlight when executeAction throws — finally discipline", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;

      // Force the executor to throw by replacing page.mouse.click. The
      // route's `finally` branch MUST decrement inFlight even though
      // the response goes through the platform_blocked error path.
      (session.page as unknown as { mouse: { click: () => Promise<void> } }).mouse.click =
        async () => {
          throw new Error("simulated chromium crash");
        };

      const res = await app.request(`/sessions/${session_id}/actions`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          action: { kind: "click", target: { x: 1, y: 1 } },
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("platform_blocked");
      // The thrown executor MUST NOT leak an in-flight count — otherwise
      // the reaper would skip this session forever after a crash.
      expect(session.inFlight).toBe(0);
    });
  });

  describe("DELETE /sessions/:id", () => {
    it("returns 204 and removes the session", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };

      expect(state.sessions.has(session_id)).toBe(true);
      const res = await app.request(`/sessions/${session_id}`, {
        method: "DELETE",
        headers: authHeader(),
      });
      expect(res.status).toBe(204);
      expect(state.sessions.has(session_id)).toBe(false);
    });

    it("is idempotent for unknown session id", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/never-existed", {
        method: "DELETE",
        headers: authHeader(),
      });
      expect(res.status).toBe(204);
    });
  });

  describe("POST /sessions/:id/forward-input (Slice 2c)", () => {
    it("forwards a click and returns 204", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      const clickSpy = vi.fn(async () => undefined);
      (session.page as unknown as { mouse: { click: typeof clickSpy } }).mouse.click = clickSpy;

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: { kind: "click", x: 320, y: 200, button: "left" },
        }),
      });
      expect(res.status).toBe(204);
      expect(clickSpy).toHaveBeenCalledWith(320, 200, { button: "left" });
    });

    it("forwards a printable key via keyboard.type (single char, no modifier)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      const typeSpy = vi.fn(async () => undefined);
      const pressSpy = vi.fn(async () => undefined);
      (session.page as unknown as { keyboard: { type: typeof typeSpy } }).keyboard.type = typeSpy;
      (session.page as unknown as { keyboard: { press: typeof pressSpy } }).keyboard.press =
        pressSpy;

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: {
            kind: "key",
            key: "a",
            modifiers: { ctrl: false, meta: false, alt: false, shift: false },
          },
        }),
      });
      expect(res.status).toBe(204);
      expect(typeSpy).toHaveBeenCalledWith("a");
      expect(pressSpy).not.toHaveBeenCalled();
    });

    it("forwards a Cmd+C shortcut via keyboard.press(combo)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      const pressSpy = vi.fn(async () => undefined);
      (session.page as unknown as { keyboard: { press: typeof pressSpy } }).keyboard.press =
        pressSpy;

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: {
            kind: "key",
            key: "c",
            modifiers: { ctrl: false, meta: true, alt: false, shift: false },
          },
        }),
      });
      expect(res.status).toBe(204);
      expect(pressSpy).toHaveBeenCalledWith("Meta+c");
    });

    it("forwards a named key (Enter) via keyboard.press(key)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      const pressSpy = vi.fn(async () => undefined);
      (session.page as unknown as { keyboard: { press: typeof pressSpy } }).keyboard.press =
        pressSpy;

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: {
            kind: "key",
            key: "Enter",
            modifiers: { ctrl: false, meta: false, alt: false, shift: false },
          },
        }),
      });
      expect(res.status).toBe(204);
      expect(pressSpy).toHaveBeenCalledWith("Enter");
    });

    it("forwards a paste via keyboard.type(text)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      const typeSpy = vi.fn(async () => undefined);
      (session.page as unknown as { keyboard: { type: typeof typeSpy } }).keyboard.type = typeSpy;

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: { kind: "paste", text: "https://example.com" },
        }),
      });
      expect(res.status).toBe(204);
      expect(typeSpy).toHaveBeenCalledWith("https://example.com");
    });

    it("returns 404 + session_closed for unknown session id", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/nope/forward-input", {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: { kind: "click", x: 1, y: 1, button: "left" },
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("session_closed");
    });

    it("forwards a wheel event via mouse.move + mouse.wheel (coalesced delta)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      const moveSpy = vi.fn(async () => undefined);
      const wheelSpy = vi.fn(async () => undefined);
      (session.page as unknown as { mouse: { move: typeof moveSpy } }).mouse.move = moveSpy;
      (session.page as unknown as { mouse: { wheel: typeof wheelSpy } }).mouse.wheel = wheelSpy;

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: { kind: "wheel", x: 640, y: 200, dx: 0, dy: 240, event_count: 4 },
        }),
      });
      expect(res.status).toBe(204);
      expect(moveSpy).toHaveBeenCalledWith(640, 200);
      expect(wheelSpy).toHaveBeenCalledWith(0, 240);
    });

    it("forwards a navigate via page.goto (Slice 2d)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      const gotoSpy = vi.fn(async () => undefined);
      (session.page as unknown as { goto: typeof gotoSpy }).goto = gotoSpy;

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: { kind: "navigate", url: "https://example.com" },
        }),
      });
      expect(res.status).toBe(204);
      expect(gotoSpy).toHaveBeenCalledWith("https://example.com", {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
    });

    it("normalizes scheme-less URLs to https before page.goto", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      const gotoSpy = vi.fn(async () => undefined);
      (session.page as unknown as { goto: typeof gotoSpy }).goto = gotoSpy;

      await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: { kind: "navigate", url: "example.com/path" },
        }),
      });
      expect(gotoSpy).toHaveBeenCalledWith(
        "https://example.com/path",
        expect.objectContaining({ waitUntil: "domcontentloaded" }),
      );
    });

    it("forwards back via page.goBack (Slice 2e)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      const goBackSpy = vi.fn(async () => null);
      (session.page as unknown as { goBack: typeof goBackSpy }).goBack = goBackSpy;

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ event: { kind: "back" } }),
      });
      expect(res.status).toBe(204);
      expect(goBackSpy).toHaveBeenCalledWith({
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
    });

    it("forwards forward via page.goForward", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      const goForwardSpy = vi.fn(async () => null);
      (session.page as unknown as { goForward: typeof goForwardSpy }).goForward = goForwardSpy;

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ event: { kind: "forward" } }),
      });
      expect(res.status).toBe(204);
      expect(goForwardSpy).toHaveBeenCalled();
    });

    it("forwards reload via page.reload", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      const reloadSpy = vi.fn(async () => undefined);
      (session.page as unknown as { reload: typeof reloadSpy }).reload = reloadSpy;

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ event: { kind: "reload" } }),
      });
      expect(res.status).toBe(204);
      expect(reloadSpy).toHaveBeenCalledWith({
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
    });

    it("back is a no-op when there's no history (page.goBack returns null)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      // Default fake doesn't expose goBack at all; bind a null-returning stub.
      (session.page as unknown as { goBack: () => Promise<null> }).goBack = async () => null;

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ event: { kind: "back" } }),
      });
      // Null-return path lands as 204 — empty-history is success-with-
      // no-op, matching real-browser UX.
      expect(res.status).toBe(204);
    });

    it("returns 500 + platform_blocked when navigate throws (network drop, malformed URL)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      (session.page as unknown as { goto: () => Promise<void> }).goto = async () => {
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      };

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: { kind: "navigate", url: "https://invalid.example" },
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { reason: string; message: string } };
      expect(body.error.reason).toBe("platform_blocked");
      expect(body.error.message).toContain("navigate failed");
    });

    it("wheel updates the session cursor position (mirrors scroll action)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;

      await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: { kind: "wheel", x: 320, y: 400, dx: 0, dy: 50, event_count: 1 },
        }),
      });
      expect(session.lastCursorX).toBe(320);
      expect(session.lastCursorY).toBe(400);
    });

    it("returns 501 + not_supported for malformed event body", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("not_supported");
    });

    it("rejects without bearer (401)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/anything/forward-input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: { kind: "click", x: 1, y: 1, button: "left" },
        }),
      });
      expect(res.status).toBe(401);
    });

    it("decrements inFlight on a happy-path forward (begin/end discipline)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      expect(session.inFlight).toBe(0);

      const res = await app.request(`/sessions/${session_id}/forward-input`, {
        method: "POST",
        headers: { ...authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          event: { kind: "click", x: 1, y: 1, button: "left" },
        }),
      });
      expect(res.status).toBe(204);
      expect(session.inFlight).toBe(0);
    });
  });

  describe("POST /sessions/:id/read-page (Slice 2h — ax tier)", () => {
    it("returns the structured ReadPageResult shape from page.evaluate", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id)!;
      // Stub page.evaluate to return the structured shape the
      // executor wraps. The executor is responsible for sandwiching
      // `kind` + `session_id` + `extracted_at` around it.
      (session.page as unknown as { evaluate: typeof vi.fn }).evaluate = vi.fn().mockResolvedValue({
        url: "https://example.com",
        title: "Example",
        text: "Some body text.",
        text_truncated: false,
        headings: [{ level: 1, text: "Heading One" }],
        links: [{ text: "More", href: "https://example.com/more" }],
      });

      const res = await app.request(`/sessions/${session_id}/read-page`, {
        method: "POST",
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        kind: string;
        session_id: string;
        url: string;
        title: string;
        text: string;
        text_truncated: boolean;
        headings: Array<{ level: number; text: string }>;
        links: Array<{ text: string; href: string }>;
        extracted_at: number;
      };
      expect(body.kind).toBe("read_page");
      expect(body.session_id).toBe(session_id);
      expect(body.url).toBe("https://example.com");
      expect(body.title).toBe("Example");
      expect(body.text).toBe("Some body text.");
      expect(body.text_truncated).toBe(false);
      expect(body.headings).toEqual([{ level: 1, text: "Heading One" }]);
      expect(body.links).toEqual([{ text: "More", href: "https://example.com/more" }]);
      expect(typeof body.extracted_at).toBe("number");
    });

    it("returns 404 + session_closed for unknown session id", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/nope/read-page", {
        method: "POST",
        headers: authHeader(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("session_closed");
    });

    it("rejects without bearer (401)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/anything/read-page", {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("global error handler", () => {
    it("maps unstructured errors to platform_blocked", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      state.openSessionImpl = async () => {
        throw new Error("Chromium crashed unexpectedly");
      };
      const res = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { reason: string; message: string } };
      expect(body.error.reason).toBe("platform_blocked");
      expect(body.error.message).toContain("Chromium crashed");
    });
  });

  // ---------------------------------------------------------------------
  // v1.3 — GET /sessions/:id/screencast streams CDP frames as NDJSON.
  // The screencast helper is mocked so the test exercises the route's
  // wiring (auth, lifecycle, dispose) without needing a real CDP
  // session. Each test re-opens a session via the fake pool and binds
  // a fresh stream.
  // ---------------------------------------------------------------------

  describe("GET /sessions/:id/screencast", () => {
    it("rejects without bearer (401 + permission_denied)", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/anything/screencast");
      expect(res.status).toBe(401);
    });

    it("returns session_closed envelope when session is unknown", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const res = await app.request("/sessions/no-such-session/screencast", {
        headers: authHeader(),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { reason: string } };
      expect(body.error.reason).toBe("session_closed");
    });

    it("rejects double-start with policy_denied (one screencast per session)", async () => {
      // Session has a stopScreencast already populated → second open
      // sees the slot taken and refuses.
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };
      const session = state.sessions.get(session_id) as unknown as {
        stopScreencast: (() => Promise<void>) | null;
      };
      session.stopScreencast = async () => undefined; // simulate active stream

      const res = await app.request(`/sessions/${session_id}/screencast`, {
        headers: authHeader(),
      });
      // ServiceError's policy_denied maps to 429 (the dispatcher's
      // wire taxonomy treats over-quota / can't-allocate as the same
      // reason class — see errors.ts).
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { reason: string; message: string } };
      expect(body.error.reason).toBe("policy_denied");
      expect(body.error.message).toContain("already has an active screencast");
    });

    // Stream lifecycle — exercise the ReadableStream.start path
    // (binds the screencast disposer to the session) AND the cancel
    // path (clears the disposer on consumer disconnect). The
    // `startScreencast` module is module-mocked at the bottom of the
    // file so the test drives frames + lifecycle synthetically without
    // a real CDP attach.
    it("attaches screencast on stream start and stashes the disposer on the session", async () => {
      const app = buildApp({ config: TEST_CONFIG, pool });
      const ensure = await app.request("/sessions/ensure", {
        method: "POST",
        headers: authHeader(),
      });
      const { session_id } = (await ensure.json()) as { session_id: string };

      const res = await app.request(`/sessions/${session_id}/screencast`, {
        headers: authHeader(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
      expect(res.headers.get("Cache-Control")).toBe("no-cache");

      // Read one frame off the body so the start handler runs.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      const line = decoder.decode(value).split("\n")[0]!;
      const frame = JSON.parse(line) as { jpeg_base64: string };
      expect(frame.jpeg_base64).toBeTruthy();

      // Disposer is stashed on the session.
      const session = state.sessions.get(session_id) as unknown as {
        stopScreencast: (() => Promise<void>) | null;
      };
      expect(session.stopScreencast).not.toBeNull();

      // Cancel via reader — the cancel path runs the disposer and
      // clears the slot.
      await reader.cancel();
      // Allow the cancel callback's microtasks to settle.
      await new Promise((r) => setTimeout(r, 0));
      expect(session.stopScreencast).toBeNull();
    });
  });
});
