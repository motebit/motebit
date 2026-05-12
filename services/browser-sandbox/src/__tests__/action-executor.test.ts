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

interface MockSession {
  session: BrowserSession;
  mouseCalls: MouseCall[];
  keyboardCalls: KeyboardCall[];
  locatorCalls: string[];
  locatorActions: Array<{ selector: string; action: string; options?: unknown }>;
  screenshotCalls: number;
  setGotoImpl(fn: (url: string, opts: unknown) => Promise<void>): void;
  setWaitForLoadStateImpl(fn: (state: string, opts?: unknown) => Promise<void>): void;
  setEvaluateImpl(fn: () => Promise<unknown>): void;
  setPageUrlImpl(fn: () => string): void;
  setLocatorCountImpl(fn: (selector: string) => number): void;
  mockPage: {
    goto: ReturnType<typeof vi.fn>;
    waitForLoadState: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
    url: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    viewportSize(): { width: number; height: number };
    mouse: BrowserSession["page"]["mouse"];
    keyboard: BrowserSession["page"]["keyboard"];
    locator: ReturnType<typeof vi.fn>;
  };
}

function makeMockSession(): MockSession {
  const mouseCalls: MouseCall[] = [];
  const keyboardCalls: KeyboardCall[] = [];
  const locatorCalls: string[] = [];
  const locatorActions: Array<{ selector: string; action: string; options?: unknown }> = [];
  let locatorCountImpl: (selector: string) => number = () => 1;
  let screenshotCalls = 0;

  // Navigate-path overrides — tests can replace these to drive the
  // heuristic / waitForLoadState branches without rebuilding the
  // whole mock session. Defaults pass everything (DOM ready, no
  // bot-block, content visible).
  //
  // The mock simulates real Playwright `page.url()` semantics: a
  // cold session starts at `about:blank`, and a successful goto
  // updates the current URL to its destination. Without this, the
  // navigate-noop short-circuit would fire on every test (whose
  // default fixture used to return the post-navigate URL on every
  // call, including pre-goto). Tests that need to force a specific
  // URL regardless of goto behavior (slow_load paths, no-op tests
  // where pre-goto URL must match) override via `setPageUrlImpl`.
  let currentUrl = "about:blank";
  let gotoImpl: (url: string, opts: unknown) => Promise<void> = async (url) => {
    // Real Playwright canonicalizes via the URL parser before
    // committing — `https://motebit.com` lands as
    // `https://motebit.com/`. Mirror that so result.url
    // assertions match production. Falls back to the raw URL on
    // parse failure (lets tests pass non-URL strings if they
    // need to).
    try {
      currentUrl = new URL(url).href;
    } catch {
      currentUrl = url;
    }
  };
  let waitForLoadStateImpl: (state: string, opts?: unknown) => Promise<void> = async () => {};
  let evaluateImpl: () => Promise<unknown> = async () => ({
    textLength: 1024,
    hasImages: true,
    hasCanvases: false,
    blankish: false,
    denied: false,
    botDetection: false,
  });
  let pageUrlImpl: () => string = () => currentUrl;

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
    // element-1 — minimal Playwright Locator mock. Tests stub the
    // count() return value via setLocatorCountImpl to exercise
    // present-vs-absent branches; click()/focus() record their
    // calls so tests can assert dispatch happened.
    locator: vi.fn((selector: string) => {
      locatorCalls.push(selector);
      return {
        count: vi.fn(async () => locatorCountImpl(selector)),
        first: vi.fn(() => ({
          click: vi.fn(async (options?: unknown) => {
            locatorActions.push({ selector, action: "click", options });
          }),
          focus: vi.fn(async (options?: unknown) => {
            locatorActions.push({ selector, action: "focus", options });
          }),
          scrollIntoViewIfNeeded: vi.fn(async () => {
            locatorActions.push({ selector, action: "scrollIntoViewIfNeeded" });
          }),
        })),
      };
    }),
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
    locatorCalls,
    locatorActions,
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
    setLocatorCountImpl(fn: (selector: string) => number): void {
      locatorCountImpl = fn;
    },
    mockPage,
  } as unknown as MockSession;
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

    // Typed-truth navigation_triggered on coordinate click — closes
    // the parallel confabulation gap. A coordinate click on a submit
    // button must report whether the page actually moved; "ok: true"
    // alone is not enough.
    it("navigation_triggered: false when click doesn't move the page", async () => {
      const mock = makeMockSession();
      const result = (await executeAction(
        mock.session,
        { kind: "click", target: { x: 100, y: 200 } },
        deps,
      )) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.navigation_triggered).toBe(false);
    });

    it("navigation_triggered: true when click triggers a navigation (link / form submit)", async () => {
      const mock = makeMockSession();
      let urlReadCount = 0;
      mock.setPageUrlImpl(() => {
        urlReadCount++;
        return urlReadCount === 1 ? "https://example.com/" : "https://example.com/landing";
      });
      const result = (await executeAction(
        mock.session,
        { kind: "click", target: { x: 100, y: 200 } },
        deps,
      )) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.navigation_triggered).toBe(true);
    });
  });

  describe("double_click", () => {
    it("calls page.mouse.dblclick", async () => {
      const { session, mouseCalls } = makeMockSession();
      await executeAction(session, { kind: "double_click", target: { x: 300, y: 400 } }, deps);
      expect(mouseCalls[0]?.method).toBe("dblclick");
      expect(session.lastCursorX).toBe(300);
    });

    // Sibling of doClick — same navigation_triggered shape.
    it("navigation_triggered: false when double_click doesn't move the page", async () => {
      const mock = makeMockSession();
      const result = (await executeAction(
        mock.session,
        { kind: "double_click", target: { x: 100, y: 200 } },
        deps,
      )) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.navigation_triggered).toBe(false);
    });

    it("navigation_triggered: true when double_click triggers a navigation", async () => {
      const mock = makeMockSession();
      let urlReadCount = 0;
      mock.setPageUrlImpl(() => {
        urlReadCount++;
        return urlReadCount === 1 ? "https://example.com/" : "https://example.com/result";
      });
      const result = (await executeAction(
        mock.session,
        { kind: "double_click", target: { x: 100, y: 200 } },
        deps,
      )) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.navigation_triggered).toBe(true);
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
      const mock = makeMockSession();
      // Default evaluate impl returns the navigate-shape — for type
      // tests, override to the truth-snapshot shape.
      mock.setEvaluateImpl(async () => ({
        focused: true,
        active_element: "input",
        value: "Hello",
        text_appeared: true,
      }));
      await executeAction(
        mock.session,
        { kind: "type", text: "Hello", per_char_delay_ms: 50 },
        deps,
      );
      expect(mock.keyboardCalls[0]?.method).toBe("type");
      expect(mock.keyboardCalls[0]?.arg).toBe("Hello");
      expect((mock.keyboardCalls[0]?.options as { delay: number }).delay).toBe(50);
    });

    // Truth-feedback slice: the type result must carry semantic-
    // intent feedback, not just "the keystroke API succeeded."
    // Witnessed 2026-05-08: AI typed and reported success while the
    // search box stayed empty. Closes the action-truth gap by
    // returning whether the typed text actually landed in the
    // focused element.

    it("returns text_appeared: true when the typed text lands in a focused input", async () => {
      const mock = makeMockSession();
      mock.setEvaluateImpl(async () => ({
        focused: true,
        active_element: "input",
        value: "motebit",
        text_appeared: true,
      }));
      const result = (await executeAction(
        mock.session,
        { kind: "type", text: "motebit" },
        deps,
      )) as Record<string, unknown>;
      expect(result.kind).toBe("type");
      expect(result.ok).toBe(true);
      expect(result.focused).toBe(true);
      expect(result.active_element).toBe("input");
      expect(result.value).toBe("motebit");
      expect(result.text_appeared).toBe(true);
    });

    it("returns focused: false when keystrokes go to body (no field focused)", async () => {
      const mock = makeMockSession();
      mock.setEvaluateImpl(async () => ({
        focused: false,
        active_element: "body",
        value: "",
        text_appeared: false,
      }));
      const result = (await executeAction(
        mock.session,
        { kind: "type", text: "motebit" },
        deps,
      )) as Record<string, unknown>;
      expect(result.focused).toBe(false);
      expect(result.text_appeared).toBe(false);
      expect(result.active_element).toBe("body");
    });

    it("returns focused: false when active element is non-typeable (button/link/div)", async () => {
      const mock = makeMockSession();
      mock.setEvaluateImpl(async () => ({
        focused: false,
        active_element: "button",
        value: "",
        text_appeared: false,
      }));
      const result = (await executeAction(
        mock.session,
        { kind: "type", text: "motebit" },
        deps,
      )) as Record<string, unknown>;
      expect(result.focused).toBe(false);
      expect(result.active_element).toBe("button");
      expect(result.text_appeared).toBe(false);
    });

    it("text_appeared is false when typed text does not appear in the value (race / page replaced focus)", async () => {
      const mock = makeMockSession();
      // Focused element is an input but the typed text didn't end
      // up in its value — race between keystroke and the page
      // shifting focus, or content-script intercepted keystrokes.
      mock.setEvaluateImpl(async () => ({
        focused: true,
        active_element: "input",
        value: "something else",
        text_appeared: false,
      }));
      const result = (await executeAction(
        mock.session,
        { kind: "type", text: "motebit" },
        deps,
      )) as Record<string, unknown>;
      expect(result.focused).toBe(true);
      expect(result.text_appeared).toBe(false);
    });

    // Typed-truth recovery_hint — when text_appeared is false, the
    // dispatcher attaches a hint pointing the AI at read_page →
    // type_into (atomic focus + type, no focus race), not coordinate
    // click + retype. Closes the witnessed 2026-05-12 bug where the
    // AI's coordinate remediation failed the same way and it
    // confabulated success. Doctrine: runtime-invariants-over-prompt-
    // rules.md § typed-truth-perception triple.
    describe("recovery_hint typed-truth field", () => {
      it("attaches recovery_hint when text_appeared is false (body focus)", async () => {
        const mock = makeMockSession();
        mock.setEvaluateImpl(async () => ({
          focused: false,
          active_element: "body",
          value: "",
          text_appeared: false,
        }));
        const result = (await executeAction(
          mock.session,
          { kind: "type", text: "motebit" },
          deps,
        )) as Record<string, unknown>;
        expect(result.recovery_hint).toBe("read_page_then_type_into");
      });

      it("attaches recovery_hint when text_appeared is false (non-typeable focused)", async () => {
        const mock = makeMockSession();
        mock.setEvaluateImpl(async () => ({
          focused: false,
          active_element: "button",
          value: "",
          text_appeared: false,
        }));
        const result = (await executeAction(
          mock.session,
          { kind: "type", text: "motebit" },
          deps,
        )) as Record<string, unknown>;
        expect(result.recovery_hint).toBe("read_page_then_type_into");
      });

      it("attaches recovery_hint when text_appeared is false (focus race; value diverged)", async () => {
        const mock = makeMockSession();
        mock.setEvaluateImpl(async () => ({
          focused: true,
          active_element: "input",
          value: "something else",
          text_appeared: false,
        }));
        const result = (await executeAction(
          mock.session,
          { kind: "type", text: "motebit" },
          deps,
        )) as Record<string, unknown>;
        expect(result.recovery_hint).toBe("read_page_then_type_into");
      });

      it("omits recovery_hint when text_appeared is true (no recovery needed)", async () => {
        const mock = makeMockSession();
        mock.setEvaluateImpl(async () => ({
          focused: true,
          active_element: "input",
          value: "motebit",
          text_appeared: true,
        }));
        const result = (await executeAction(
          mock.session,
          { kind: "type", text: "motebit" },
          deps,
        )) as Record<string, unknown>;
        expect(result.text_appeared).toBe(true);
        // Absent field — type assertion via Object.keys so the assertion
        // surface is the absence itself, not undefined-comparison drift.
        expect(Object.prototype.hasOwnProperty.call(result, "recovery_hint")).toBe(false);
      });
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

    // Typed-truth navigation_triggered: when Enter (or any key) is
    // pressed and the page navigates as a result (form submit, link
    // navigation), the result carries `navigation_triggered: true`.
    // When the key fires but the page doesn't move, false.
    describe("navigation_triggered typed-truth field", () => {
      it("navigation_triggered: false when Enter does NOT trigger navigation (witnessed bug)", async () => {
        const mock = makeMockSession();
        // Default mock: page.url() returns "about:blank" both before
        // and after the key press — no navigation fired. Mirrors the
        // 2026-05-12 witnessed bug where the AI pressed Enter on the
        // Google search input, Google's promo overlay intercepted,
        // and the page stayed on the homepage.
        const result = (await executeAction(
          mock.session,
          { kind: "key", key: "Enter" },
          deps,
        )) as Record<string, unknown>;
        expect(result.ok).toBe(true);
        expect(result.navigation_triggered).toBe(false);
      });

      it("navigation_triggered: true when Enter triggers a form submission", async () => {
        const mock = makeMockSession();
        // Simulate Playwright's url() returning different values
        // before and after the keypress — form submission navigated
        // the page.
        let urlReadCount = 0;
        mock.setPageUrlImpl(() => {
          urlReadCount++;
          return urlReadCount === 1
            ? "https://example.com/form"
            : "https://example.com/submit-result";
        });
        const result = (await executeAction(
          mock.session,
          { kind: "key", key: "Enter" },
          deps,
        )) as Record<string, unknown>;
        expect(result.ok).toBe(true);
        expect(result.navigation_triggered).toBe(true);
      });
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
      await executeAction(m.session, { kind: "navigate", url: "motebit.com" }, deps);
      expect(gotoUrl).toBe("https://motebit.com");
    });

    it("preserves absolute URLs verbatim", async () => {
      const m = makeMockSession();
      let gotoUrl = "";
      m.setGotoImpl(async (url) => {
        gotoUrl = url;
      });
      await executeAction(m.session, { kind: "navigate", url: "http://localhost:3000" }, deps);
      expect(gotoUrl).toBe("http://localhost:3000");
    });

    it("returns metadata + inline screenshot bytes on success", async () => {
      const m = makeMockSession();
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
        botDetection: false,
      }));
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "tesla.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.access_denied_detected).toBe(true);
      expect(result.visual_content_detected).toBe(false);
      expect(result.bot_detection_detected).toBe(false);
    });

    it("detects bot_detection_wall (reCAPTCHA / hCaptcha / Cloudflare Turnstile) — typed sibling of access_denied", async () => {
      // Pin from 2026-05-12. Witnessed: Google's reCAPTCHA challenge
      // page (google.com/sorry/index) was NOT being flagged by the
      // existing access_denied detector — its content uses "I'm not
      // a robot", "unusual traffic", "verify you are human" patterns
      // the prior regex didn't catch. Without a typed signal, the
      // AI was reading the page text and inferring CAPTCHA, then
      // falling back via the prompt-only CAPTCHA-fallback rule.
      // After this slice, the field is typed and the prompt teaches
      // the intent-aware recovery (search → web_search; site-
      // interaction → user handoff). Doctrine: docs/doctrine/
      // runtime-invariants-over-prompt-rules.md.
      const m = makeMockSession();
      m.setEvaluateImpl(async () => ({
        textLength: 200,
        hasImages: true,
        hasCanvases: false,
        blankish: false,
        denied: false,
        botDetection: true,
      }));
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "google.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.bot_detection_detected).toBe(true);
      // Sibling of denied: distinct field, distinct recovery; both
      // suppress visual_content_detected since the page isn't real
      // content.
      expect(result.access_denied_detected).toBe(false);
      expect(result.visual_content_detected).toBe(false);
    });

    it("bot_detection_detected defaults to false on a healthy page", async () => {
      const m = makeMockSession();
      // Default evaluateImpl in makeMockSession returns botDetection:
      // false (added to the default fixture). Verify the field
      // surfaces correctly on a normal navigate.
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "motebit.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.bot_detection_detected).toBe(false);
      expect(result.visual_content_detected).toBe(true);
    });

    it("falls back to defaults when the heuristic evaluate throws", async () => {
      const m = makeMockSession();
      m.setEvaluateImpl(async () => {
        throw new Error("evaluate boom");
      });
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

    it("throws not_supported when goto fails with a non-timeout error", async () => {
      // Non-timeout errors (DNS failures, connection refused) still
      // propagate — the navigation didn't commit, the slab has nothing
      // to show, and the user needs to know it didn't work.
      const m = makeMockSession();
      m.setGotoImpl(async () => {
        throw new Error("net::ERR_NAME_NOT_RESOLVED");
      });
      await expect(
        executeAction(m.session, { kind: "navigate", url: "doesnotexist.invalid" }, deps),
      ).rejects.toMatchObject({ reason: "not_supported" });
    });

    it("treats a goto timeout as slow_load (page still loaded), not as failure", async () => {
      // Repro for Daniel's production /computer bug: nba.com hit goto's
      // 15s readiness ceiling, the AI got "navigate failed: timeout" and
      // told the user "didn't load" — while the slab kept streaming
      // frames showing nba.com fully rendered. Same pattern fired on
      // google.com when the cloud Chromium was warm-but-busy.
      //
      // The fix swallows TimeoutError specifically (other errors still
      // throw), continues into the heuristic + screenshot path, and
      // marks `slow_load: true` so the AI can hedge ("loading took
      // longer than expected") instead of asserting failure.
      const m = makeMockSession();
      m.setGotoImpl(async () => {
        throw new Error("Timeout 15000ms exceeded.");
      });
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "nba.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.kind).toBe("navigate");
      expect(result.ok).toBe(true);
      expect(result.slow_load).toBe(true);
      // The default mock heuristic returns content-detected, so a slow
      // load that ultimately rendered should describe as content-present.
      expect(result.visual_content_detected).toBe(true);
    });

    it("treats a Playwright TimeoutError class instance as slow_load", async () => {
      // Playwright surfaces timeouts via a named TimeoutError class.
      // Mock with a generic Error whose `name` matches — same regex
      // gate.
      const m = makeMockSession();
      m.setGotoImpl(async () => {
        const err = new Error("Navigation timeout of 15000 ms exceeded");
        err.name = "TimeoutError";
        throw err;
      });
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "example.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.slow_load).toBe(true);
    });

    it("does NOT mark slow_load when goto completes within the budget", async () => {
      const m = makeMockSession();
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "example.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result.slow_load).toBe(false);
    });

    // ── navigate-noop-at-dispatch ────────────────────────────────
    //
    // Belt-and-suspenders structural floor under the prompt rule
    // in PERCEPTION_DOCTRINE that teaches the AI to skip
    // request_control + navigate when the [Now] block already
    // reports the browser is at the requested URL. If the AI
    // ignores the rule, the dispatch returns `already_there: true`
    // without firing goto or capturing a screenshot — the page
    // didn't change, so we don't waste a roundtrip pretending it
    // did. Daniel's three-screenshot repro: typing "open nba.com"
    // twice triggered a redundant control-request + render the
    // second time. With this guard, the second navigate short-
    // circuits at the dispatch.

    it("short-circuits to already_there: true when the page is already at the requested URL", async () => {
      const m = makeMockSession();
      m.setPageUrlImpl(() => "https://nba.com/");
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "nba.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.kind).toBe("navigate");
      expect(result.ok).toBe(true);
      expect(result.already_there).toBe(true);
      expect(result.url).toBe("https://nba.com/");
      expect(result.slow_load).toBe(false);
      // No goto and no screenshot — that's the whole point of the
      // short-circuit. The page didn't change, the user's slab
      // still shows it, and we saved a roundtrip.
      expect(m.mockPage.goto).not.toHaveBeenCalled();
      expect(m.mockPage.screenshot).not.toHaveBeenCalled();
      // No bytes either — `already_there` paths return metadata
      // only. Caller-side AI doctrine reads `already_there` and
      // describes the page as unchanged, not "freshly loaded."
      expect(result.bytes_base64).toBeUndefined();
    });

    it("treats trailing-slash, default-port, and scheme-case differences as already_there", async () => {
      const m = makeMockSession();
      m.setPageUrlImpl(() => "https://motebit.com/about");
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "HTTPS://motebit.com:443/about/" },
        deps,
      )) as Record<string, unknown>;
      expect(result.already_there).toBe(true);
      expect(m.mockPage.goto).not.toHaveBeenCalled();
    });

    it("does NOT short-circuit when query strings differ — same path, same host", async () => {
      const m = makeMockSession();
      m.setPageUrlImpl(() => "https://google.com/search?q=motebit");
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "https://google.com/search?q=other" },
        deps,
      )) as Record<string, unknown>;
      expect(result.already_there).toBeUndefined();
      // Real navigation fired — query change is real navigation.
      expect(m.mockPage.goto).toHaveBeenCalledOnce();
    });

    it("does NOT short-circuit when the session is fresh at about:blank", async () => {
      const m = makeMockSession();
      m.setPageUrlImpl(() => "about:blank");
      const result = (await executeAction(
        m.session,
        { kind: "navigate", url: "motebit.com" },
        deps,
      )) as Record<string, unknown>;
      expect(result.already_there).toBeUndefined();
      expect(m.mockPage.goto).toHaveBeenCalledOnce();
    });
  });

  // ── element-1: structurally-addressed actions ─────────────────────

  describe("click_element", () => {
    it("returns ok with truth when element resolves", async () => {
      const m = makeMockSession();
      m.setLocatorCountImpl(() => 1);
      m.setEvaluateImpl(async () => ({
        clicked_tag: "button",
        focused_typeable: false,
      }));
      m.setPageUrlImpl(() => "https://example.com/");
      const result = (await executeAction(
        m.session,
        { kind: "click_element", element_id: "motebit-3" },
        deps,
      )) as Record<string, unknown>;
      expect(result.kind).toBe("click_element");
      expect(result.ok).toBe(true);
      expect(result.clicked_tag).toBe("button");
      expect(result.focused_typeable).toBe(false);
      expect(result.navigation_triggered).toBe(false);
      // Verify the locator was queried with the stamped attribute
      // selector — server-resolution, not AI-supplied selectors.
      expect(m.locatorCalls).toContain('[data-motebit-id="motebit-3"]');
      // Verify the click flowed through scroll → click.
      const clickActions = m.locatorActions.filter((a) => a.action === "click");
      expect(clickActions.length).toBe(1);
    });

    it("returns navigation_triggered: true when URL changes during click", async () => {
      const m = makeMockSession();
      let urlCallCount = 0;
      m.setPageUrlImpl(() => {
        urlCallCount++;
        return urlCallCount === 1 ? "https://example.com/" : "https://example.com/landing";
      });
      m.setEvaluateImpl(async () => ({ clicked_tag: "a", focused_typeable: false }));
      const result = (await executeAction(
        m.session,
        { kind: "click_element", element_id: "motebit-1" },
        deps,
      )) as Record<string, unknown>;
      expect(result.navigation_triggered).toBe(true);
    });

    it("returns element_not_found when locator resolves to zero elements", async () => {
      const m = makeMockSession();
      m.setLocatorCountImpl(() => 0);
      const result = (await executeAction(
        m.session,
        { kind: "click_element", element_id: "motebit-99" },
        deps,
      )) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("element_not_found");
      expect(typeof result.message).toBe("string");
    });

    it("rejects malformed element_id (defense against injected selectors)", async () => {
      const m = makeMockSession();
      await expect(
        executeAction(
          m.session,
          { kind: "click_element", element_id: 'foo"]; alert(1); //' },
          deps,
        ),
      ).rejects.toMatchObject({ reason: "not_supported" });
    });
  });

  describe("focus_element", () => {
    it("returns ok with truth when element resolves and focuses", async () => {
      const m = makeMockSession();
      m.setEvaluateImpl(async () => ({ tag: "input", focused: true }));
      const result = (await executeAction(
        m.session,
        { kind: "focus_element", element_id: "motebit-0" },
        deps,
      )) as Record<string, unknown>;
      expect(result.kind).toBe("focus_element");
      expect(result.ok).toBe(true);
      expect(result.tag).toBe("input");
      expect(result.focused).toBe(true);
      const focusActions = m.locatorActions.filter((a) => a.action === "focus");
      expect(focusActions.length).toBe(1);
    });

    it("returns element_not_found for missing element", async () => {
      const m = makeMockSession();
      m.setLocatorCountImpl(() => 0);
      const result = (await executeAction(
        m.session,
        { kind: "focus_element", element_id: "motebit-x" },
        deps,
      )) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("element_not_found");
    });
  });

  describe("type_into", () => {
    it("clears + types and returns text_appeared on success", async () => {
      const m = makeMockSession();
      m.setEvaluateImpl(async () => ({
        focused: true,
        active_element: "input",
        value: "motebit",
        text_appeared: true,
      }));
      const result = (await executeAction(
        m.session,
        { kind: "type_into", element_id: "motebit-0", text: "motebit" },
        deps,
      )) as Record<string, unknown>;
      expect(result.kind).toBe("type_into");
      expect(result.ok).toBe(true);
      expect(result.text_appeared).toBe(true);
      expect(result.value).toBe("motebit");
      // Verify the focus → clear → type sequence:
      const focusActions = m.locatorActions.filter((a) => a.action === "focus");
      expect(focusActions.length).toBe(1);
      // Clear-first sends ControlOrMeta+a then Delete.
      const presses = m.keyboardCalls.filter((c) => c.method === "press");
      expect(presses.map((p) => p.arg)).toEqual(["ControlOrMeta+a", "Delete"]);
      // Then types the requested text.
      const types = m.keyboardCalls.filter((c) => c.method === "type");
      expect(types[0]?.arg).toBe("motebit");
    });

    it("skips clear when clear_first: false (append intent)", async () => {
      const m = makeMockSession();
      m.setEvaluateImpl(async () => ({
        focused: true,
        active_element: "input",
        value: "old motebit",
        text_appeared: true,
      }));
      await executeAction(
        m.session,
        { kind: "type_into", element_id: "motebit-0", text: "motebit", clear_first: false },
        deps,
      );
      const presses = m.keyboardCalls.filter((c) => c.method === "press");
      expect(presses).toHaveLength(0);
    });

    it("returns element_not_found for missing element", async () => {
      const m = makeMockSession();
      m.setLocatorCountImpl(() => 0);
      const result = (await executeAction(
        m.session,
        { kind: "type_into", element_id: "motebit-x", text: "hello" },
        deps,
      )) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("element_not_found");
    });

    it("text_appeared: false when value doesn't contain typed text after type", async () => {
      // Page intercepted keystrokes mid-type, focus shifted, etc.
      const m = makeMockSession();
      m.setEvaluateImpl(async () => ({
        focused: true,
        active_element: "input",
        value: "something else",
        text_appeared: false,
      }));
      const result = (await executeAction(
        m.session,
        { kind: "type_into", element_id: "motebit-0", text: "motebit" },
        deps,
      )) as Record<string, unknown>;
      expect(result.text_appeared).toBe(false);
    });
  });

  // ── Frame-stale retry: typed truth on the Playwright navigation race ─
  describe("frame_stale — one-shot retry + typed reason on second failure", () => {
    // Doctrine pin: motebit-computer.md §"Typed truth on results."
    //
    // Before this wrapper, a same-origin redirect during a key/click
    // (Google's `?zx=…` anti-cache, OAuth round-trip, AJAX URL
    // rewrite) threw a Playwright `Execution context was destroyed`
    // (or `frame was detached` / `Target closed`) that fell through
    // the route handler's general catch into `platform_blocked` (HTTP
    // 500). The AI received an opaque server-fault and verbally
    // interpreted it as "keystrokes aren't landing — the browser
    // session may not have focus" — prose interpretation of a typed
    // event.
    //
    // The wrapper catches the four Playwright frame-stale patterns,
    // retries once after a brief settle delay (deps.frameStaleRetry
    // DelayMs, defaulting to 100ms; tests pass 0 for determinism),
    // and surfaces ServiceError("frame_stale") only if even the
    // retry caught a stale frame. The dispatcher's reason taxonomy
    // stays closed; the AI sees `frame_stale` and the PERCEPTION_
    // DOCTRINE clause teaches it to re-read the page state.

    const retryDeps = { now: () => FIXED_NOW, frameStaleRetryDelayMs: 0 };

    function makeStaleThenOkKeyboard(
      m: MockSession,
      staleMessage: string,
    ): { firstAttempt: () => boolean; secondAttempt: () => boolean } {
      let calls = 0;
      let firstCalled = false;
      let secondCalled = false;
      m.mockPage.keyboard.press = vi.fn(async (combo: string) => {
        calls += 1;
        if (calls === 1) {
          firstCalled = true;
          throw new Error(staleMessage);
        }
        secondCalled = true;
        // Record the second-attempt call so we know the retry
        // landed and dispatched the same action.
        void combo;
      }) as unknown as MockSession["mockPage"]["keyboard"]["press"];
      return {
        firstAttempt: () => firstCalled,
        secondAttempt: () => secondCalled,
      };
    }

    it("retries once on 'Execution context was destroyed' and returns ok", async () => {
      const m = makeMockSession();
      const probe = makeStaleThenOkKeyboard(
        m,
        "Execution context was destroyed, most likely because of a navigation",
      );
      const result = (await executeAction(
        m.session,
        { kind: "key", key: "Enter" },
        retryDeps,
      )) as Record<string, unknown>;
      expect(probe.firstAttempt()).toBe(true);
      expect(probe.secondAttempt()).toBe(true);
      expect(result.kind).toBe("key");
      expect(result.ok).toBe(true);
    });

    it("retries once on 'frame was detached' and returns ok", async () => {
      const m = makeMockSession();
      const probe = makeStaleThenOkKeyboard(m, "frame was detached");
      const result = (await executeAction(
        m.session,
        { kind: "key", key: "Enter" },
        retryDeps,
      )) as Record<string, unknown>;
      expect(probe.secondAttempt()).toBe(true);
      expect(result.ok).toBe(true);
    });

    it("retries once on 'Target closed' and returns ok", async () => {
      const m = makeMockSession();
      const probe = makeStaleThenOkKeyboard(m, "Target closed");
      const result = (await executeAction(
        m.session,
        { kind: "key", key: "Enter" },
        retryDeps,
      )) as Record<string, unknown>;
      expect(probe.secondAttempt()).toBe(true);
      expect(result.ok).toBe(true);
    });

    it("surfaces typed ServiceError('frame_stale') when the retry also catches a stale frame — NOT platform_blocked", async () => {
      const m = makeMockSession();
      m.mockPage.keyboard.press = vi.fn(async () => {
        throw new Error("Execution context was destroyed, most likely because of a navigation");
      }) as unknown as MockSession["mockPage"]["keyboard"]["press"];

      await expect(
        executeAction(m.session, { kind: "key", key: "Enter" }, retryDeps),
      ).rejects.toMatchObject({
        name: "ServiceError",
        reason: "frame_stale",
      });
    });

    it("does NOT retry non-frame-stale errors — preserves the existing failure mode for unrelated bugs", async () => {
      const m = makeMockSession();
      let calls = 0;
      m.mockPage.keyboard.press = vi.fn(async () => {
        calls += 1;
        throw new Error("Some other Playwright error unrelated to frame state");
      }) as unknown as MockSession["mockPage"]["keyboard"]["press"];

      await expect(
        executeAction(m.session, { kind: "key", key: "Enter" }, retryDeps),
      ).rejects.toThrow("Some other Playwright error unrelated to frame state");
      // Critically: the unrelated error was NOT retried — it
      // surfaces verbatim on the first call. Retry is scoped to the
      // frame-stale family by construction.
      expect(calls).toBe(1);
    });

    it("frame_stale reason from sandbox maps back to ComputerFailureReason 'frame_stale' (status 409)", async () => {
      // Cross-package wire-shape pin: the sandbox's REASON_STATUS
      // map (services/browser-sandbox/src/errors.ts) and the
      // dispatcher's statusToReason (packages/runtime/src/
      // cloud-browser-dispatcher.ts) MUST stay symmetric so a
      // remote sandbox-side frame_stale fires the same reason on
      // the dispatcher-side. Imported here rather than asserted
      // indirectly because the parity guarantee is the load-
      // bearing claim.
      const { ServiceError } = await import("../errors.js");
      const e = new ServiceError("frame_stale", "test");
      expect(e.status()).toBe(409);
      expect(e.toEnvelope()).toEqual({
        error: { reason: "frame_stale", message: "test" },
      });
    });
  });
});
