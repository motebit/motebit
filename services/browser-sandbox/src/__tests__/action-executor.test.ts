/**
 * `action-executor` translates `ComputerAction` → Playwright primitive.
 * These tests assert the translation is right for every kind, using a
 * minimal `Page` mock that records calls.
 *
 * Real-Playwright integration coverage lives behind a separate
 * `*.integration.test.ts` so the unit-test loop stays fast (no
 * Chromium download in CI). Translation correctness is the contract;
 * these tests prove every kind round-trips through the right Page
 * method with the right args.
 */

import { describe, it, expect, vi } from "vitest";
import type { ComputerAction } from "@motebit/protocol";

import { executeAction } from "../action-executor.js";
import type { BrowserSession } from "../chromium-pool.js";

interface MouseCall {
  method: "click" | "dblclick" | "move" | "down" | "up" | "wheel";
  x?: number;
  y?: number;
  options?: unknown;
}
interface KeyboardCall {
  method: "type" | "press";
  arg: string;
  options?: unknown;
}

function makeMockSession(): {
  session: BrowserSession;
  mouseCalls: MouseCall[];
  keyboardCalls: KeyboardCall[];
  screenshotCalls: number;
} {
  const mouseCalls: MouseCall[] = [];
  const keyboardCalls: KeyboardCall[] = [];
  let screenshotCalls = 0;

  // Navigate-path overrides — tests can replace these to drive the
  // heuristic / waitForLoadState branches without rebuilding the
  // whole mock session. Defaults pass everything (DOM ready, no
  // bot-block, content visible).
  let gotoImpl: (url: string, opts: unknown) => Promise<void> = async () => {};
  let waitForLoadStateImpl: (state: string, opts?: unknown) => Promise<void> = async () => {};
  let evaluateImpl: () => Promise<unknown> = async () => ({
    textLength: 1024,
    hasImages: true,
    hasCanvases: false,
    blankish: false,
    denied: false,
  });
  let pageUrlImpl: () => string = () => "https://example.com/";

  const mockPage = {
    goto: vi.fn(async (url: string, opts: unknown) => gotoImpl(url, opts)),
    waitForLoadState: vi.fn(async (state: string, opts?: unknown) =>
      waitForLoadStateImpl(state, opts),
    ),
    evaluate: vi.fn(async () => evaluateImpl()),
    url: vi.fn(() => pageUrlImpl()),
    screenshot: vi.fn(async () => {
      screenshotCalls++;
      return Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header magic bytes
    }),
    viewportSize: () => ({ width: 1280, height: 800 }),
    mouse: {
      click: vi.fn(async (x: number, y: number, options?: unknown) => {
        mouseCalls.push({ method: "click", x, y, options });
      }),
      dblclick: vi.fn(async (x: number, y: number, options?: unknown) => {
        mouseCalls.push({ method: "dblclick", x, y, options });
      }),
      move: vi.fn(async (x: number, y: number, options?: unknown) => {
        mouseCalls.push({ method: "move", x, y, options });
      }),
      down: vi.fn(async (options?: unknown) => {
        mouseCalls.push({ method: "down", options });
      }),
      up: vi.fn(async (options?: unknown) => {
        mouseCalls.push({ method: "up", options });
      }),
      wheel: vi.fn(async (dx: number, dy: number) => {
        mouseCalls.push({ method: "wheel", x: dx, y: dy });
      }),
    },
    keyboard: {
      type: vi.fn(async (text: string, options?: unknown) => {
        keyboardCalls.push({ method: "type", arg: text, options });
      }),
      press: vi.fn(async (combo: string, options?: unknown) => {
        keyboardCalls.push({ method: "press", arg: combo, options });
      }),
    },
  };

  const session: BrowserSession = {
    sessionId: "test-session",
    page: mockPage as unknown as BrowserSession["page"],
    context: {} as unknown as BrowserSession["context"],
    openedAt: 1_000_000,
    lastUsedAt: 1_000_000,
    lastCursorX: 0,
    lastCursorY: 0,
    inFlight: 0,
    stopScreencast: null,
  };

  return {
    session,
    mouseCalls,
    keyboardCalls,
    get screenshotCalls() {
      return screenshotCalls;
    },
    setGotoImpl(fn: typeof gotoImpl): void {
      gotoImpl = fn;
    },
    setWaitForLoadStateImpl(fn: typeof waitForLoadStateImpl): void {
      waitForLoadStateImpl = fn;
    },
    setEvaluateImpl(fn: typeof evaluateImpl): void {
      evaluateImpl = fn;
    },
    setPageUrlImpl(fn: typeof pageUrlImpl): void {
      pageUrlImpl = fn;
    },
    mockPage,
  } as unknown as ReturnType<typeof makeMockSession> & {
    setGotoImpl(fn: (url: string, opts: unknown) => Promise<void>): void;
    setWaitForLoadStateImpl(fn: (state: string, opts?: unknown) => Promise<void>): void;
    setEvaluateImpl(fn: () => Promise<unknown>): void;
    setPageUrlImpl(fn: () => string): void;
    mockPage: typeof mockPage;
  };
}

const FIXED_NOW = 1_700_000_000_000;
const deps = { now: () => FIXED_NOW };

describe("executeAction", () => {
  describe("screenshot", () => {
    it("captures PNG bytes and returns base64 + viewport dims", async () => {
      const { session } = makeMockSession();
      const result = await executeAction(session, { kind: "screenshot" }, deps);
      expect(result.kind).toBe("screenshot");
      expect(result.image_format).toBe("png");
      expect(result.width).toBe(1280);
      expect(result.height).toBe(800);
      expect(result.captured_at).toBe(FIXED_NOW);
      expect(typeof result.bytes_base64).toBe("string");
      // PNG magic bytes round-trip through base64
      expect(Buffer.from(result.bytes_base64 as string, "base64")[0]).toBe(0x89);
    });
  });

  describe("cursor_position", () => {
    it("returns the session's tracked cursor coordinates", async () => {
      const { session } = makeMockSession();
      session.lastCursorX = 42;
      session.lastCursorY = 99;
      const result = await executeAction(session, { kind: "cursor_position" }, deps);
      expect(result).toMatchObject({
        kind: "cursor_position",
        x: 42,
        y: 99,
        captured_at: FIXED_NOW,
      });
    });
  });

  describe("click", () => {
    it("calls page.mouse.click with the target and updates session cursor", async () => {
      const { session, mouseCalls } = makeMockSession();
      await executeAction(session, { kind: "click", target: { x: 100, y: 200 } }, deps);
      expect(mouseCalls).toHaveLength(1);
      expect(mouseCalls[0]).toMatchObject({ method: "click", x: 100, y: 200 });
      expect(session.lastCursorX).toBe(100);
      expect(session.lastCursorY).toBe(200);
    });

    it("respects the button override (right-click)", async () => {
      const { session, mouseCalls } = makeMockSession();
      const action: ComputerAction = {
        kind: "click",
        target: { x: 1, y: 1 },
        button: "right",
      };
      await executeAction(session, action, deps);
      expect((mouseCalls[0]?.options as { button: string }).button).toBe("right");
    });
  });

  describe("double_click", () => {
    it("calls page.mouse.dblclick", async () => {
      const { session, mouseCalls } = makeMockSession();
      await executeAction(session, { kind: "double_click", target: { x: 300, y: 400 } }, deps);
      expect(mouseCalls[0]?.method).toBe("dblclick");
      expect(session.lastCursorX).toBe(300);
    });
  });

  describe("mouse_move", () => {
    it("moves the cursor without clicking", async () => {
      const { session, mouseCalls } = makeMockSession();
      await executeAction(session, { kind: "mouse_move", target: { x: 50, y: 60 } }, deps);
      expect(mouseCalls).toHaveLength(1);
      expect(mouseCalls[0]?.method).toBe("move");
    });
  });

  describe("drag", () => {
    it("emits move → down → move(steps) → up", async () => {
      const { session, mouseCalls } = makeMockSession();
      await executeAction(
        session,
        {
          kind: "drag",
          from: { x: 10, y: 10 },
          to: { x: 100, y: 100 },
          duration_ms: 160,
        },
        deps,
      );
      const sequence = mouseCalls.map((c) => c.method);
      expect(sequence).toEqual(["move", "down", "move", "up"]);
      // duration 160ms / 16ms per step = 10 steps
      expect((mouseCalls[2]?.options as { steps: number }).steps).toBe(10);
      expect(session.lastCursorX).toBe(100);
      expect(session.lastCursorY).toBe(100);
    });

    it("clamps step count to >= 1 for very short drags", async () => {
      const { session, mouseCalls } = makeMockSession();
      await executeAction(
        session,
        { kind: "drag", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, duration_ms: 0 },
        deps,
      );
      expect((mouseCalls[2]?.options as { steps: number }).steps).toBe(1);
    });
  });

  describe("type", () => {
    it("forwards text + per-char delay", async () => {
      const { session, keyboardCalls } = makeMockSession();
      await executeAction(session, { kind: "type", text: "Hello", per_char_delay_ms: 50 }, deps);
      expect(keyboardCalls[0]?.method).toBe("type");
      expect(keyboardCalls[0]?.arg).toBe("Hello");
      expect((keyboardCalls[0]?.options as { delay: number }).delay).toBe(50);
    });
  });

  describe("key", () => {
    it("translates cmd+c to Meta+c", async () => {
      const { session, keyboardCalls } = makeMockSession();
      await executeAction(session, { kind: "key", key: "cmd+c" }, deps);
      expect(keyboardCalls[0]?.arg).toBe("Meta+c");
    });

    it("translates a multi-modifier combo verbatim", async () => {
      const { session, keyboardCalls } = makeMockSession();
      await executeAction(session, { kind: "key", key: "ctrl+shift+t" }, deps);
      expect(keyboardCalls[0]?.arg).toBe("Control+Shift+t");
    });

    it("passes through standalone Playwright-shape keys", async () => {
      const { session, keyboardCalls } = makeMockSession();
      await executeAction(session, { kind: "key", key: "Enter" }, deps);
      expect(keyboardCalls[0]?.arg).toBe("Enter");
    });
  });

  describe("scroll", () => {
    it("moves to target then wheels by dx/dy", async () => {
      const { session, mouseCalls } = makeMockSession();
      await executeAction(
        session,
        { kind: "scroll", target: { x: 200, y: 200 }, dx: 0, dy: 100 },
        deps,
      );
      expect(mouseCalls[0]?.method).toBe("move");
      expect(mouseCalls[1]?.method).toBe("wheel");
      expect(mouseCalls[1]?.x).toBe(0);
      expect(mouseCalls[1]?.y).toBe(100);
    });
  });

  describe("navigate", () => {
    it("normalizes scheme-less URLs to https://", async () => {
      const m = makeMockSession();
      let gotoUrl = "";
      m.setGotoImpl(async (url) => {
        gotoUrl = url;
      });
      m.setPageUrlImpl(() => "https://motebit.com/");
      await executeAction(m.session, { kind: "navigate", url: "motebit.com" }, deps);
      expect(gotoUrl).toBe("https://motebit.com");
    });

    it("preserves absolute URLs verbatim", async () => {
      const m = makeMockSession();
      let gotoUrl = "";
      m.setGotoImpl(async (url) => {
        gotoUrl = url;
      });
      m.setPageUrlImpl(() => "http://localhost:3000/");
      await executeAction(m.session, { kind: "navigate", url: "http://localhost:3000" }, deps);
      expect(gotoUrl).toBe("http://localhost:3000");
    });

    it("returns metadata + inline screenshot bytes on success", async () => {
      const m = makeMockSession();
      m.setPageUrlImpl(() => "https://motebit.com/");
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "motebit.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.kind).toBe("navigate");
      expect(result.ok).toBe(true);
      expect(result.url).toBe("https://motebit.com/");
      expect(result.visual_content_detected).toBe(true);
      expect(result.blank_page_detected).toBe(false);
      expect(result.access_denied_detected).toBe(false);
      expect(result.visual_readiness_timeout).toBe(false);
      // Inline-screenshot fields populated (v1.3 hardening).
      expect(typeof result.bytes_base64).toBe("string");
      expect((result.bytes_base64 as string).length).toBeGreaterThan(0);
      expect(result.image_format).toBe("jpeg");
      expect(result.width).toBe(1280);
      expect(result.height).toBe(800);
    });

    it("flags networkidle timeout without failing the action", async () => {
      const m = makeMockSession();
      m.setWaitForLoadStateImpl(async () => {
        throw new Error("Timeout 2000ms exceeded");
      });
      m.setPageUrlImpl(() => "https://example.com/");
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "example.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.visual_readiness_timeout).toBe(true);
    });

    it("detects blank page via the heuristic", async () => {
      const m = makeMockSession();
      m.setEvaluateImpl(async () => ({
        textLength: 5,
        hasImages: false,
        hasCanvases: false,
        blankish: true,
        denied: false,
      }));
      m.setPageUrlImpl(() => "https://blank.example/");
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "blank.example" },
        deps,
      )) as Record<string, unknown>;
      expect(result.blank_page_detected).toBe(true);
      expect(result.visual_content_detected).toBe(false);
    });

    it("detects access-denied / bot-block via the heuristic", async () => {
      const m = makeMockSession();
      m.setEvaluateImpl(async () => ({
        textLength: 200,
        hasImages: false,
        hasCanvases: false,
        blankish: false,
        denied: true,
      }));
      m.setPageUrlImpl(() => "https://tesla.com/");
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "tesla.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.access_denied_detected).toBe(true);
      expect(result.visual_content_detected).toBe(false);
    });

    it("falls back to defaults when the heuristic evaluate throws", async () => {
      const m = makeMockSession();
      m.setEvaluateImpl(async () => {
        throw new Error("evaluate boom");
      });
      m.setPageUrlImpl(() => "https://example.com/");
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "example.com" },
        deps,
      )) as Record<string, unknown>;
      // Heuristic catch path → blankish=true defaults.
      expect(result.blank_page_detected).toBe(true);
      expect(result.access_denied_detected).toBe(false);
    });

    it("omits screenshot fields when capture fails (capture-error fallback)", async () => {
      const m = makeMockSession();
      // Force the screenshot call inside doNavigate to throw — the
      // navigate path catches and continues without bytes.
      m.mockPage.screenshot.mockImplementationOnce(async () => {
        throw new Error("screenshot disabled");
      });
      m.setPageUrlImpl(() => "https://example.com/");
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "example.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.kind).toBe("navigate");
      expect(result.ok).toBe(true);
      expect(result.bytes_base64).toBeUndefined();
      expect(result.image_format).toBeUndefined();
    });

    it("throws not_supported when goto fails", async () => {
      const m = makeMockSession();
      m.setGotoImpl(async () => {
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      });
      await expect(
        executeAction(m.session, { kind: "navigate", url: "doesnotexist.invalid" }, deps),
      ).rejects.toMatchObject({ reason: "not_supported" });
    });
  });
});
