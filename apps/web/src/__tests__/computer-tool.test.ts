/**
 * Tests for `registerWebComputerTool` — the web-side wiring that
 * registers the `computer` tool with a `CloudBrowserDispatcher`
 * pointing at `services/browser-sandbox`.
 *
 * The wiring is symmetric to `apps/desktop/src/computer-tool.ts`
 * (Tauri dispatcher); the contract differences are:
 *
 *   - Returns `null` when `baseUrl` is empty — explicit-not-configured.
 *   - Uses `CloudBrowserDispatcher` by default; tests override with a
 *     captured mock to avoid hitting the network.
 *
 * Real Playwright integration is exercised inside `services/browser-
 * sandbox`. Here we just prove the wiring contract:
 *
 *   - Registry receives the `computer` tool when configured.
 *   - Registry stays empty when `baseUrl` is empty.
 *   - Tool handler routes through the session manager + the supplied
 *     dispatcher mock.
 *   - Dispose closes the default session and stops the manager.
 */

import { describe, it, expect } from "vitest";
import { InMemoryToolRegistry } from "@motebit/tools/web-safe";
import type { ComputerPlatformDispatcher } from "@motebit/runtime";

import { registerWebComputerTool } from "../computer-tool.js";

interface MockDispatcherCalls {
  queryDisplay: number;
  execute: Array<{ kind: string }>;
  dispose: number;
}

/**
 * Slice 2a — most tests exercising motebit-driven dispatcher calls
 * need to grant motebit control first (the new default is `user`,
 * which the gate denies). This helper runs the request → grant cycle
 * the production UX would do via slab gestures, so test setup stays
 * one line.
 */
function grantMotebit(reg: NonNullable<ReturnType<typeof registerWebComputerTool>>): void {
  reg.coBrowseControl.requestControl("motebit");
  reg.coBrowseControl.grantControl("user");
}

/**
 * Slice 2f — wait until the co-browse control machine reaches the
 * named state. Used in `request_control` flow tests because the
 * eager `ensureDefaultSession()` adds async work between the tool
 * call and the state transition; a single `await Promise.resolve()`
 * no longer covers it.
 *
 * Bounded with a timeout (default 1s) so a stuck state doesn't hang
 * the whole test suite — tests that need the timeout-branch should
 * exercise it via `requestControlTimeoutMs`, not by relying on this
 * helper to fail.
 */
function waitForState(
  machine: NonNullable<ReturnType<typeof registerWebComputerTool>>["coBrowseControl"],
  kind: "user" | "motebit" | "handoff_pending" | "paused",
  timeoutMs = 1000,
): Promise<void> {
  if (machine.getState().kind === kind) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`waitForState timed out waiting for kind=${kind}`));
    }, timeoutMs);
    const unsubscribe = machine.subscribe((state) => {
      if (state.kind !== kind) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

function makeMockDispatcher(): {
  dispatcher: ComputerPlatformDispatcher;
  calls: MockDispatcherCalls;
} {
  const calls: MockDispatcherCalls = { queryDisplay: 0, execute: [], dispose: 0 };
  const dispatcher: ComputerPlatformDispatcher = {
    async queryDisplay() {
      calls.queryDisplay++;
      return { width: 1280, height: 800, scaling_factor: 1 };
    },
    async execute(action) {
      calls.execute.push({ kind: action.kind });
      return { kind: action.kind, ok: true };
    },
    async dispose() {
      calls.dispose++;
    },
  };
  return { dispatcher, calls };
}

describe("registerWebComputerTool", () => {
  it("returns null when baseUrl is empty (tool absent from registry)", () => {
    const registry = new InMemoryToolRegistry();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
    });
    expect(reg).toBeNull();
    expect(registry.list().find((t) => t.name === "computer")).toBeUndefined();
  });

  it("registers the `computer` tool when configured", () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    expect(reg).not.toBeNull();
    expect(registry.has("computer")).toBe(true);
  });

  it("routes the AI-visible action through the session manager + dispatcher", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher, calls } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    grantMotebit(reg!);

    const result = await registry.execute("computer", { action: { kind: "screenshot" } });
    expect(result.ok).toBe(true);
    // queryDisplay fires on the first execute (lazy session open),
    // then the action is dispatched.
    expect(calls.queryDisplay).toBe(1);
    expect(calls.execute).toEqual([{ kind: "screenshot" }]);

    // Subsequent action reuses the open session — no second queryDisplay.
    await registry.execute("computer", { action: { kind: "cursor_position" } });
    expect(calls.queryDisplay).toBe(1);
    expect(calls.execute).toEqual([{ kind: "screenshot" }, { kind: "cursor_position" }]);

    await reg!.dispose();
    expect(calls.dispose).toBe(1);
  });

  it("exposes keepalive that delegates to the dispatcher when supported", async () => {
    // Pin from 2026-05-12. Closes the "I cleared the Google CAPTCHA,
    // idled past BROWSER_SANDBOX_IDLE_MS, returned to a fresh CAPTCHA"
    // failure mode. The web surface fires registration.keepalive() on
    // a 60s interval while the live_browser slab is mounted; the
    // registration delegates to dispatcher.keepalive() which POSTs to
    // /sessions/:id/keepalive on the sandbox; the sandbox touches
    // lastUsedAt so the idle reaper doesn't fire. The keepalive is
    // duck-typed: dispatchers without it (test mocks, future
    // dispatchers, etc.) get a silent no-op.
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    let keepaliveCalls = 0;
    // Add keepalive to the mock dispatcher (CloudBrowserDispatcher
    // has it; the protocol-shaped mock does not by default).
    (dispatcher as unknown as { keepalive?: () => Promise<void> }).keepalive = async () => {
      keepaliveCalls += 1;
    };
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    expect(reg).not.toBeNull();
    expect(typeof reg!.keepalive).toBe("function");
    await reg!.keepalive();
    expect(keepaliveCalls).toBe(1);
    await reg!.keepalive();
    expect(keepaliveCalls).toBe(2);
  });

  it("keepalive is a no-op when the dispatcher doesn't implement it (duck-typed)", async () => {
    // Pin: backwards-compatibility with dispatchers that don't have
    // keepalive. The web surface should be able to call keepalive
    // unconditionally without crashing on dispatchers that omit the
    // method.
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    // Default mock dispatcher has NO keepalive method.
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    expect(reg).not.toBeNull();
    // Must not throw.
    await expect(reg!.keepalive()).resolves.toBeUndefined();
  });

  it("rejects with structured failure when no `action` argument supplied", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });

    const result = await registry.execute("computer", {});
    expect(result.ok).toBe(false);
    expect(typeof (result as { error: unknown }).error).toBe("string");
  });

  // -------------------------------------------------------------------
  // chrome-1a-fix / prompt-1 — onNavigateResult fires the URL after a
  // successful motebit-driven `computer({kind: "navigate"})` so the
  // surface can feed it into runtime.setBrowserSessionProvider →
  // [Now] Browser: open at <url>.
  // -------------------------------------------------------------------

  it("fires onNavigateResult with the resolved URL after motebit-driven navigate succeeds", async () => {
    const registry = new InMemoryToolRegistry();
    const calls: MockDispatcherCalls = { queryDisplay: 0, execute: [], dispose: 0 };
    const dispatcher: ComputerPlatformDispatcher = {
      async queryDisplay() {
        calls.queryDisplay++;
        return { width: 1280, height: 800, scaling_factor: 1 };
      },
      async execute(action) {
        calls.execute.push({ kind: action.kind });
        // Browser-sandbox returns `data.url = session.page.url()`
        // after Playwright commit; reproduce that shape here.
        if (action.kind === "navigate") {
          return {
            kind: "navigate",
            ok: true,
            url: "https://example.com/landing",
            visual_content_detected: true,
            blank_page_detected: false,
            access_denied_detected: false,
            visual_readiness_timeout: false,
          };
        }
        return { kind: action.kind, ok: true };
      },
      async dispose() {
        calls.dispose++;
      },
    };

    const navigated: string[] = [];
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      onNavigateResult: (url) => navigated.push(url),
    });
    grantMotebit(reg!);

    await registry.execute("computer", {
      action: { kind: "navigate", url: "https://example.com" },
    });
    expect(navigated).toEqual(["https://example.com/landing"]);
  });

  it("does NOT fire onNavigateResult on non-navigate actions", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const navigated: string[] = [];
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      onNavigateResult: (url) => navigated.push(url),
    });
    grantMotebit(reg!);

    await registry.execute("computer", { action: { kind: "screenshot" } });
    await registry.execute("computer", { action: { kind: "cursor_position" } });
    expect(navigated).toEqual([]);
  });

  it("does NOT fire onNavigateResult when navigate fails (gate denial / dispatcher error)", async () => {
    const registry = new InMemoryToolRegistry();
    const dispatcher: ComputerPlatformDispatcher = {
      async queryDisplay() {
        return { width: 1280, height: 800, scaling_factor: 1 };
      },
      async execute() {
        throw new Error("dispatcher error");
      },
      async dispose() {},
    };
    const navigated: string[] = [];
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      onNavigateResult: (url) => navigated.push(url),
    });
    grantMotebit(reg!);

    const result = await registry.execute("computer", {
      action: { kind: "navigate", url: "https://example.com" },
    });
    expect(result.ok).toBe(false);
    expect(navigated).toEqual([]);
  });

  it("dispose is idempotent (subsequent calls are no-ops)", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher, calls } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    grantMotebit(reg!);
    // Open the default session
    await registry.execute("computer", { action: { kind: "screenshot" } });
    await reg!.dispose();
    await reg!.dispose();
    expect(calls.dispose).toBe(1);
  });

  // -------------------------------------------------------------------
  // live_browser slab item lifecycle stability across navigations.
  //
  // The architectural claim: across N navigates within one
  // registration, the cloud session is opened ONCE and reused for
  // every action. The web app's `onSessionLive` mounts the
  // live_browser slab item at session-open and `onSessionEnding`
  // dissolves it at session-close — both are wired one-to-one with
  // session lifecycle. So if openSession fires once and closeSession
  // fires once (at dispose), the slab item mounts once and dissolves
  // once. The dissolve+remount-mid-session failure mode (which would
  // break controlBandSlot host continuity, the screencast img's
  // texture state, and the user's "one continuous browser surface"
  // mental model) cannot happen as long as this invariant holds.
  //
  // We pin the underlying invariant — `dispatcher.queryDisplay` (the
  // single observable inside the openSession path) fires exactly
  // once across many navigates — and the surface invariant
  // (`onSessionEnding` fires zero times during navigation, exactly
  // once at dispose). Future drift that introduces a per-navigate
  // session reopen would trip both halves of this test.
  //
  // Pairs with: navigate-noop-at-dispatch (the no-op short-circuit
  // means a same-URL navigate isn't even a roundtrip) and the
  // implicit-grant slice (which removed the request_control prompt
  // from typed-intent turns). Together: typed → grant → dispatch
  // (no-op or real) → same slab item, no flicker.
  // -------------------------------------------------------------------

  it("opens the cloud session once across N navigates and dissolves only at dispose", async () => {
    const registry = new InMemoryToolRegistry();
    const calls: MockDispatcherCalls = { queryDisplay: 0, execute: [], dispose: 0 };
    const dispatcher: ComputerPlatformDispatcher = {
      async queryDisplay() {
        calls.queryDisplay++;
        return { width: 1280, height: 800, scaling_factor: 1 };
      },
      async execute(action) {
        calls.execute.push({ kind: action.kind });
        if (action.kind === "navigate") {
          return {
            kind: "navigate",
            ok: true,
            url: (action as { url: string }).url,
            visual_content_detected: true,
            blank_page_detected: false,
            access_denied_detected: false,
            visual_readiness_timeout: false,
          };
        }
        return { kind: action.kind, ok: true };
      },
      async dispose() {
        calls.dispose++;
      },
    };

    const sessionEndingCalls: string[] = [];
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      onSessionEnding: (sessionId) => sessionEndingCalls.push(sessionId),
    });
    grantMotebit(reg!);

    // Three navigates to different URLs — the same shape the web
    // app would produce when the user typed three separate "open X"
    // intents. Each navigate goes through the session manager's
    // executeAction, which routes via the cached defaultSession.
    await registry.execute("computer", { action: { kind: "navigate", url: "https://nba.com" } });
    await registry.execute("computer", {
      action: { kind: "navigate", url: "https://news.ycombinator.com" },
    });
    await registry.execute("computer", { action: { kind: "navigate", url: "https://google.com" } });

    // queryDisplay is the single observable inside openSession — the
    // session manager's `openSession` calls it once on the dispatcher
    // to seed display dimensions. If the registration ever
    // re-opened the session per-navigate, this would be 3, and the
    // live_browser slab item would have unmounted+remounted 3 times.
    expect(calls.queryDisplay).toBe(1);
    expect(calls.execute).toHaveLength(3);
    // No dissolve mid-session — onSessionEnding is paired with
    // closeAndEmit, which only fires on dispose / transport-fault.
    expect(sessionEndingCalls).toEqual([]);

    // Dispose closes the session AND fires onSessionEnding exactly
    // once with the session id — the surface's signal to dissolve
    // the slab item. Pairs with onSessionLive at the open side
    // (also one-to-one with session lifecycle).
    await reg!.dispose();
    expect(calls.dispose).toBe(1);
    expect(sessionEndingCalls).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // v1.5 — close emits a signed `ComputerSessionSummarized` event when
  // the registration has the runtime's signing path wired.
  // -------------------------------------------------------------------

  it("emits ComputerSessionSummarized at dispose when signing is wired (v1.5)", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
    const eventsAdapter = {
      append: async (entry: { event_type: string; payload: Record<string, unknown> }) => {
        events.push({ event_type: entry.event_type, payload: entry.payload });
      },
    } as unknown as Parameters<typeof registerWebComputerTool>[1]["events"];

    const signSessionReceipt = async (body: {
      session_id: string;
      action_count: number;
      embodiment_mode: string;
    }) => ({
      ...body,
      receipt_id: "csr_test",
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: "fake_sig_b64url",
      public_key: "f".repeat(64),
    });

    const hashSessionActions = async () => "h".repeat(64);

    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      events: eventsAdapter,
      signSessionReceipt: signSessionReceipt as never,
      hashSessionActions,
    });
    grantMotebit(reg!);

    await registry.execute("computer", { action: { kind: "screenshot" } });
    await registry.execute("computer", { action: { kind: "screenshot" } });
    await reg!.dispose();

    const types = events.map((e) => e.event_type);
    expect(types).toContain("computer_session_opened");
    expect(types).toContain("computer_session_closed");
    expect(types).toContain("computer_session_summarized");

    const summarized = events.find((e) => e.event_type === "computer_session_summarized");
    expect(summarized).toBeDefined();
    expect(summarized!.payload.embodiment_mode).toBe("virtual_browser");
    expect(summarized!.payload.action_count).toBe(2);
    expect(summarized!.payload.signature).toBe("fake_sig_b64url");
  });

  it("skips ComputerSessionSummarized when signSessionReceipt returns null (no signing key)", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const events: Array<{ event_type: string }> = [];
    const eventsAdapter = {
      append: async (entry: { event_type: string }) => {
        events.push({ event_type: entry.event_type });
      },
    } as unknown as Parameters<typeof registerWebComputerTool>[1]["events"];

    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      events: eventsAdapter,
      // Null return mimics a runtime with no signing keys.
      signSessionReceipt: async () => null,
    });
    grantMotebit(reg!);

    await registry.execute("computer", { action: { kind: "screenshot" } });
    await reg!.dispose();

    const types = events.map((e) => e.event_type);
    expect(types).toContain("computer_session_closed");
    expect(types).not.toContain("computer_session_summarized");
  });

  it("does NOT emit ComputerSessionSummarized when signSessionReceipt is unwired", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const events: Array<{ event_type: string }> = [];
    const eventsAdapter = {
      append: async (entry: { event_type: string }) => {
        events.push({ event_type: entry.event_type });
      },
    } as unknown as Parameters<typeof registerWebComputerTool>[1]["events"];

    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      events: eventsAdapter,
      // signSessionReceipt deliberately omitted.
    });
    grantMotebit(reg!);

    await registry.execute("computer", { action: { kind: "screenshot" } });
    await reg!.dispose();

    const types = events.map((e) => e.event_type);
    expect(types).toContain("computer_session_closed");
    expect(types).not.toContain("computer_session_summarized");
  });

  it("fires onSessionReceiptSigned after the audit emit so apps can emerge an artifact (v1.5 detach)", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const events: string[] = [];
    const eventsAdapter = {
      append: async (entry: { event_type: string }) => {
        events.push(entry.event_type);
      },
    } as unknown as Parameters<typeof registerWebComputerTool>[1]["events"];

    const signSessionReceipt = async (body: { session_id: string }) => ({
      ...body,
      receipt_id: "csr_test",
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: "fake_sig",
      public_key: "f".repeat(64),
    });

    const emerged: Array<{ session_id: string }> = [];
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      events: eventsAdapter,
      signSessionReceipt: signSessionReceipt as never,
      onSessionReceiptSigned: (receipt) => {
        emerged.push({ session_id: receipt.session_id });
      },
    });
    grantMotebit(reg!);

    await registry.execute("computer", { action: { kind: "screenshot" } });
    await reg!.dispose();

    expect(emerged).toHaveLength(1);
    expect(emerged[0]?.session_id).toBeTruthy();
    // Audit emit happened FIRST (calm-software ordering — record on the
    // log before UX surface emerges).
    const summarizedIdx = events.indexOf("computer_session_summarized");
    expect(summarizedIdx).toBeGreaterThanOrEqual(0);
  });

  it("a throwing onSessionReceiptSigned callback does not break the close path", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher, calls } = makeMockDispatcher();

    const signSessionReceipt = async (body: { session_id: string }) => ({
      ...body,
      receipt_id: "csr_test",
      suite: "motebit-jcs-ed25519-b64-v1" as const,
      signature: "fake_sig",
      public_key: "f".repeat(64),
    });

    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      signSessionReceipt: signSessionReceipt as never,
      onSessionReceiptSigned: () => {
        throw new Error("emerge boom");
      },
    });
    grantMotebit(reg!);

    await registry.execute("computer", { action: { kind: "screenshot" } });
    await expect(reg!.dispose()).resolves.toBeUndefined();
    // Dispatcher still tore down — close path completed despite the
    // emerge callback throwing. UX failure ≠ audit failure ≠ close
    // failure; fail-soft chain works.
    expect(calls.dispose).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Co-browse Slice 2a — the apps wire that activates Slice 1's gate.
  // The registration constructs a CoBrowseControlMachine, exposes it
  // on the handle, gates executeAction through it, wires
  // onTransition into the audit log, and reverts to user on
  // transport-failure / close. Together with Slice 1, motebit-driven
  // dispatch is denied with not_in_control whenever the machine
  // reports state.kind !== "motebit".
  // ─────────────────────────────────────────────────────────────────

  it("exposes coBrowseControl on the registration handle (initial state: user)", () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    expect(reg).not.toBeNull();
    expect(reg!.coBrowseControl).toBeDefined();
    expect(reg!.coBrowseControl.getState()).toEqual({ kind: "user" });
  });

  it("Slice 1 gate fires through the registration: motebit action denied with not_in_control while user holds", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher, calls } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    // Default state is user — motebit action must be denied before
    // dispatcher.execute runs.
    const result = await registry.execute("computer", {
      action: { kind: "screenshot" },
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect((result as { error: string }).error).toContain("not_in_control");
    }
    expect(calls.execute).toEqual([]);
    expect(reg!.coBrowseControl.getState()).toEqual({ kind: "user" });
  });

  it("dispatcher executes once motebit holds control (request → grant → motebit action runs)", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher, calls } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    reg!.coBrowseControl.requestControl("motebit");
    reg!.coBrowseControl.grantControl("user");
    expect(reg!.coBrowseControl.getState()).toEqual({ kind: "motebit" });
    const result = await registry.execute("computer", {
      action: { kind: "screenshot" },
    });
    expect(result.ok).toBe(true);
    expect(calls.execute).toEqual([{ kind: "screenshot" }]);
  });

  it("control transitions land on the audit log as co_browse_control_changed events", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
    const eventsAdapter = {
      append: async (entry: { event_type: string; payload: Record<string, unknown> }) => {
        events.push({ event_type: entry.event_type, payload: entry.payload });
      },
    } as unknown as Parameters<typeof registerWebComputerTool>[1]["events"];
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      events: eventsAdapter,
    });
    // Cycle through transitions; assert each lands.
    reg!.coBrowseControl.requestControl("motebit");
    reg!.coBrowseControl.grantControl("user");
    reg!.coBrowseControl.reclaimControl();
    // Let the fire-and-forget audit appends settle.
    await new Promise((r) => setTimeout(r, 0));
    const controlEvents = events.filter((e) => e.event_type === "co_browse_control_changed");
    expect(controlEvents).toHaveLength(3);
    expect(controlEvents[0]?.payload.transition_kind).toBe("request_control");
    expect(controlEvents[1]?.payload.transition_kind).toBe("grant_control");
    expect(controlEvents[2]?.payload.transition_kind).toBe("reclaim_control");
  });

  // -------------------------------------------------------------------
  // Co-browse Slice 2c-prerequisite — `request_control` tool registers
  // alongside `computer` on the cloud-browser path. Drives the slab
  // band's doorbell from the AI loop.
  // -------------------------------------------------------------------

  it("registers `request_control` alongside `computer`", () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    expect(registry.has("computer")).toBe(true);
    expect(registry.has("request_control")).toBe(true);
  });

  it("request_control returns already_in_control when motebit holds", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    grantMotebit(reg!);

    const result = await registry.execute("request_control", {});
    expect(result.ok).toBe(true);
    expect((result as { data: unknown }).data).toEqual({ kind: "already_in_control" });
  });

  it("request_control returns session_paused when state is paused", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    reg!.coBrowseControl.pause("user");

    const result = await registry.execute("request_control", {});
    expect((result as { data: unknown }).data).toEqual({ kind: "session_paused" });
  });

  it("request_control resolves granted when user grants the request", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });

    // Fire the AI's request_control. It will block on the user's
    // verdict; resolve it asynchronously by simulating the slab
    // band's Grant button click. Slice 2f added an eager
    // ensureDefaultSession() call before requestControl, so the
    // state transition no longer happens on the next microtask —
    // we await the actual transition via the machine's subscribe.
    const pending = registry.execute("request_control", {});
    await waitForState(reg!.coBrowseControl, "handoff_pending");
    reg!.coBrowseControl.grantControl("user");

    const result = await pending;
    expect((result as { data: unknown }).data).toEqual({ kind: "granted" });
    // After grant, motebit holds control — `computer` will dispatch.
    expect(reg!.coBrowseControl.getState()).toEqual({ kind: "motebit" });
  });

  it("request_control resolves denied when user denies the request", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });

    const pending = registry.execute("request_control", {});
    await waitForState(reg!.coBrowseControl, "handoff_pending");
    reg!.coBrowseControl.denyControl("user");

    const result = await pending;
    expect((result as { data: unknown }).data).toEqual({ kind: "denied" });
    // After deny, control is back to user; the request was lost.
    expect(reg!.coBrowseControl.getState()).toEqual({ kind: "user" });
  });

  it("request_control returns request_pending when invoked while a request is already in flight", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });

    // First call enters handoff_pending and waits for user.
    const first = registry.execute("request_control", {});
    await waitForState(reg!.coBrowseControl, "handoff_pending");

    // Second call sees handoff_pending and returns immediately.
    const second = await registry.execute("request_control", {});
    expect((second as { data: unknown }).data).toEqual({ kind: "request_pending" });

    // Resolve the first call so the test doesn't leak a pending promise.
    reg!.coBrowseControl.grantControl("user");
    await first;
  });

  // ---------------------------------------------------------------
  // Implicit-grant fast path. When the AI's reach for `computer`
  // happens inside a user-typed turn, `request_control` skips the
  // slab-band prompt and grants directly. Re-confirming what the
  // user can already see they did violates the calm-software
  // doctrine; consent flows through the same gesture as the
  // request. Three tests cover the contract:
  //   1. fresh typed-intent → granted (no prompt)
  //   2. null typed-intent → falls through to the existing prompt
  //      flow (proactive idle work, fail-closed by default)
  //   3. paused/pending states still short-circuit BEFORE the
  //      typed-intent check — implicit grant must not bypass the
  //      session-paused / request-pending guards.
  // ---------------------------------------------------------------

  it("request_control auto-grants when typed-intent is fresh (no slab-band prompt)", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const typedIntent = {
      kind: "user-typed-intent" as const,
      timestamp: Date.now(),
      surface: "web" as const,
    };
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      getCurrentTypedIntent: () => typedIntent,
    });

    const result = await registry.execute("request_control", {});
    expect((result as { data: unknown }).data).toEqual({ kind: "granted" });
    // Both transitions committed synchronously; final state is motebit.
    expect(reg!.coBrowseControl.getState()).toEqual({ kind: "motebit" });
  });

  it("request_control falls through to prompt when typed-intent is null (proactive idle work)", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      // Proactive path returns null — fail-closed default. The
      // flow MUST open the explicit prompt band; we resolve it
      // via a denial here to keep the test fast and prove the
      // prompt path is the one that ran (granted would also pass
      // the auto-grant test, so we use deny to discriminate).
      getCurrentTypedIntent: () => null,
    });

    const pending = registry.execute("request_control", {});
    await waitForState(reg!.coBrowseControl, "handoff_pending");
    reg!.coBrowseControl.denyControl("user");

    const result = await pending;
    expect((result as { data: unknown }).data).toEqual({ kind: "denied" });
    expect(reg!.coBrowseControl.getState()).toEqual({ kind: "user" });
  });

  it("request_control respects session_paused before checking typed-intent", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const typedIntent = {
      kind: "user-typed-intent" as const,
      timestamp: Date.now(),
      surface: "web" as const,
    };
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      // Implicit grant is set, but the session is paused — the
      // pause guard must short-circuit the auto-grant. Pausing is
      // a user-floor primitive (`/halt`); even a fresh typed
      // intent does not authorize the AI to silently route around
      // it. The user must resume first.
      getCurrentTypedIntent: () => typedIntent,
    });
    reg!.coBrowseControl.pause("user");
    expect(reg!.coBrowseControl.getState().kind).toBe("paused");

    const result = await registry.execute("request_control", {});
    expect((result as { data: unknown }).data).toEqual({ kind: "session_paused" });
    expect(reg!.coBrowseControl.getState().kind).toBe("paused");
  });

  it("request_control times out and reverts to user when no verdict arrives", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
      // Tight bound so the test exercises the timeout branch
      // deterministically without slowing the suite.
      requestControlTimeoutMs: 30,
    });

    const result = await registry.execute("request_control", {});
    expect((result as { data: unknown }).data).toEqual({ kind: "timeout" });
    // Fail-closed revert: machine is back at user so the next
    // request_control starts fresh and the slab band's doorbell
    // clears.
    expect(reg!.coBrowseControl.getState()).toEqual({ kind: "user" });
  });

  it("computer's not_in_control failure names request_control as the remediation", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    // Default state is user — the gate denies dispatch.
    expect(reg!.coBrowseControl.getState().kind).toBe("user");

    const result = await registry.execute("computer", { action: { kind: "screenshot" } });
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain("not_in_control");
    // The hint that closes the loop — the AI sees the affordance
    // name and knows the next move.
    expect(error).toContain("request_control");
  });

  // -------------------------------------------------------------------
  // Slice 2f — slab control-chrome cleanup. Three contracts:
  //   1. request_control's ToolDefinition declares slabProjection: "none"
  //      so the runtime suppresses the duplicate tool_call slab item.
  //   2. requestControlFlow eagerly opens the cloud session BEFORE
  //      requestControl("motebit") so the live_browser exists when the
  //      doorbell rings (no degraded fallback in the success path).
  //   3. The chrome-applier (via openLiveBrowserSlabItem's onLiveBrowserMount
  //      payload callback) gets a handle reference for downstream
  //      band/address-bar mounting.
  // -------------------------------------------------------------------

  it("request_control declares slabProjection: 'none' (state chrome, not body content)", () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    const def = registry.list().find((t) => t.name === "request_control");
    expect(def).toBeDefined();
    expect(def?.slabProjection).toBe("none");
  });

  it("request_control eagerly opens the cloud session before transitioning to handoff_pending", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher, calls } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });

    expect(calls.queryDisplay).toBe(0);

    const pending = registry.execute("request_control", {});
    await waitForState(reg!.coBrowseControl, "handoff_pending");

    // queryDisplay fired during the eager ensureDefaultSession — the
    // live_browser surface exists by the time the doorbell rings.
    expect(calls.queryDisplay).toBe(1);

    // Resolve so the pending promise doesn't leak.
    reg!.coBrowseControl.grantControl("user");
    await pending;
  });

  // -------------------------------------------------------------------
  // Slice 2h — `read_page`, the first ax-tier tool. Fills the
  // documented middle slot of the hybrid-engine cost hierarchy
  // (api → ax → pixels). Returns DOM-derived structured text from
  // the open browser session; no pixels.
  // -------------------------------------------------------------------

  it("registers `read_page` alongside `computer` and `request_control`", () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    expect(registry.has("computer")).toBe(true);
    expect(registry.has("request_control")).toBe(true);
    expect(registry.has("read_page")).toBe(true);
  });

  it("`read_page` declares mode: 'ax' (first tool in the middle tier)", () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    const def = registry.list().find((t) => t.name === "read_page");
    expect(def).toBeDefined();
    expect(def?.mode).toBe("ax");
    // Should also be marked outbound (page text crosses to AI) and
    // stamped with the virtual_browser embodiment.
    expect(def?.outbound).toBe(true);
    expect(def?.embodimentMode).toBe("virtual_browser");
  });

  it("`read_page` returns the dispatcher's structured result", async () => {
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    // Extend the mock dispatcher with a readPage method returning
    // a canonical ReadPageResult shape.
    (dispatcher as unknown as { readPage: () => Promise<unknown> }).readPage = async () => ({
      kind: "read_page",
      session_id: "fake-session-1",
      url: "https://example.com",
      title: "Example",
      text: "Body text.",
      text_truncated: false,
      headings: [{ level: 1, text: "Heading" }],
      links: [],
      extracted_at: 1,
    });

    registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });

    const result = await registry.execute("read_page", {});
    expect(result.ok).toBe(true);
    const data = (result as { data: { kind: string; text: string } }).data;
    expect(data.kind).toBe("read_page");
    expect(data.text).toBe("Body text.");
  });

  it("dispose reverts control to user (covers the page-unload-equivalent wire shape)", async () => {
    // jsdom doesn't fire beforeunload reliably; the next-best
    // coverage is a direct dispose() call, which exercises the same
    // teardown wire (closeAndEmit → coBrowseControl.disconnect()).
    const registry = new InMemoryToolRegistry();
    const { dispatcher } = makeMockDispatcher();
    const reg = registerWebComputerTool(registry, {
      baseUrl: "https://browser.example.com",
      getAuthToken: () => "tok",
      motebitId: "did:motebit:test",
      dispatcher,
    });
    reg!.coBrowseControl.requestControl("motebit");
    reg!.coBrowseControl.grantControl("user");
    expect(reg!.coBrowseControl.getState()).toEqual({ kind: "motebit" });
    // Open default session so dispose has something to close.
    reg!.coBrowseControl.reclaimControl(); // back to user so executeAction lands the open
    reg!.coBrowseControl.requestControl("motebit");
    reg!.coBrowseControl.grantControl("user");
    await registry.execute("computer", { action: { kind: "screenshot" } });
    expect(reg!.coBrowseControl.getState()).toEqual({ kind: "motebit" });
    await reg!.dispose();
    // After dispose, control is back to user (fail-closed revert).
    expect(reg!.coBrowseControl.getState()).toEqual({ kind: "user" });
  });
});
