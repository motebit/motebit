/**
 * Co-browse Slice 2c — redaction helpers + `forwardUserInput`
 * orchestrator tests.
 *
 * Two contracts under test:
 *
 *   1. **Redaction by construction.** Raw text/keys/pixel coordinates
 *      MUST NOT survive the wire-event → audit-detail mapping. Keys
 *      collapse to character_class + key_role; paste collapses to
 *      length + line_count + looks_like_url; pointer events
 *      normalize to [0, 1] coordinates.
 *
 *   2. **Gate enforcement.** `forwardUserInput` rejects with
 *      `not_in_user_state` unless `coBrowseControl.getState().kind ===
 *      "user"`. Sessions without a co-browse machine reject with
 *      `not_supported` (forwarding has no policy plane on
 *      desktop_drive). Closed sessions reject with `session_closed`.
 *      Transport faults reject with `transport_error`.
 */

import { describe, it, expect } from "vitest";
import type { ComputerAction, UserInputEvent, UserInputForwardedDetail } from "@motebit/sdk";

import {
  classifyCharacter,
  classifyKeyRole,
  pasteAuditDetail,
  buildUserInputAuditDetail,
} from "../co-browse-input.js";
import { createComputerSessionManager } from "../computer-use.js";
import type { ComputerPlatformDispatcher } from "../computer-use.js";
import { createCoBrowseControlMachine } from "../co-browse-control.js";

// ── classifyCharacter ──────────────────────────────────────────────────

describe("classifyCharacter — redaction by construction", () => {
  it("classifies single printable Latin letters as 'letter'", () => {
    expect(classifyCharacter("a")).toBe("letter");
    expect(classifyCharacter("Z")).toBe("letter");
  });

  it("classifies single digits as 'digit'", () => {
    expect(classifyCharacter("0")).toBe("digit");
    expect(classifyCharacter("9")).toBe("digit");
  });

  it("classifies whitespace characters as 'whitespace'", () => {
    expect(classifyCharacter(" ")).toBe("whitespace");
  });

  it("classifies punctuation as 'punct'", () => {
    expect(classifyCharacter(".")).toBe("punct");
    expect(classifyCharacter(",")).toBe("punct");
    expect(classifyCharacter("?")).toBe("punct");
  });

  it("classifies modifier-key names as 'modifier'", () => {
    expect(classifyCharacter("Shift")).toBe("modifier");
    expect(classifyCharacter("Control")).toBe("modifier");
    expect(classifyCharacter("Meta")).toBe("modifier");
    expect(classifyCharacter("Alt")).toBe("modifier");
  });

  it("classifies named control-key names as 'control'", () => {
    expect(classifyCharacter("Enter")).toBe("control");
    expect(classifyCharacter("Tab")).toBe("control");
    expect(classifyCharacter("Backspace")).toBe("control");
    expect(classifyCharacter("ArrowUp")).toBe("control");
  });

  it("classifies non-Latin letters as 'letter' (unicode-aware)", () => {
    expect(classifyCharacter("é")).toBe("letter");
    expect(classifyCharacter("中")).toBe("letter");
    expect(classifyCharacter("ا")).toBe("letter");
  });

  it("does NOT leak multi-char unrecognized keys (IME composition strings collapse to 'unknown')", () => {
    // An IME composition "abc" or a Chinese composition "你好" arriving
    // in `key` would be a privacy leak if classified by first char.
    expect(classifyCharacter("abc")).toBe("unknown");
    expect(classifyCharacter("password")).toBe("unknown");
    expect(classifyCharacter("你好")).toBe("unknown");
  });

  it("returns 'unknown' for empty / non-string inputs (defensive)", () => {
    expect(classifyCharacter("")).toBe("unknown");
    // @ts-expect-error — runtime defense
    expect(classifyCharacter(undefined)).toBe("unknown");
    // @ts-expect-error — runtime defense
    expect(classifyCharacter(null)).toBe("unknown");
  });
});

// ── classifyKeyRole ─────────────────────────────────────────────────────

describe("classifyKeyRole — semantic role over character", () => {
  const NO_MOD = { ctrl: false, meta: false, alt: false, shift: false };

  it("named control keys map to their roles", () => {
    expect(classifyKeyRole("Enter", NO_MOD)).toBe("enter");
    expect(classifyKeyRole("Tab", NO_MOD)).toBe("tab");
    expect(classifyKeyRole("Escape", NO_MOD)).toBe("escape");
    expect(classifyKeyRole("Backspace", NO_MOD)).toBe("backspace");
    expect(classifyKeyRole("ArrowUp", NO_MOD)).toBe("arrow");
    expect(classifyKeyRole("ArrowDown", NO_MOD)).toBe("arrow");
    expect(classifyKeyRole("ArrowLeft", NO_MOD)).toBe("arrow");
    expect(classifyKeyRole("ArrowRight", NO_MOD)).toBe("arrow");
  });

  it("any non-shift modifier turns the press into 'shortcut'", () => {
    expect(classifyKeyRole("a", { ...NO_MOD, ctrl: true })).toBe("shortcut");
    expect(classifyKeyRole("c", { ...NO_MOD, meta: true })).toBe("shortcut");
    expect(classifyKeyRole("F", { ...NO_MOD, alt: true })).toBe("shortcut");
    // Even Enter+Ctrl is a shortcut, not "enter".
    expect(classifyKeyRole("Enter", { ...NO_MOD, ctrl: true })).toBe("shortcut");
  });

  it("Shift alone keeps printable input as 'printable' (capital letters, symbols)", () => {
    // Capital A is shift+a but it's still printable input, not a shortcut.
    expect(classifyKeyRole("A", { ...NO_MOD, shift: true })).toBe("printable");
    expect(classifyKeyRole("$", { ...NO_MOD, shift: true })).toBe("printable");
  });

  it("single-character keys without non-shift modifiers are 'printable'", () => {
    expect(classifyKeyRole("a", NO_MOD)).toBe("printable");
    expect(classifyKeyRole("5", NO_MOD)).toBe("printable");
    expect(classifyKeyRole(".", NO_MOD)).toBe("printable");
  });

  it("unknown multi-char keys collapse to 'unknown'", () => {
    expect(classifyKeyRole("WeirdNamedKey", NO_MOD)).toBe("unknown");
    expect(classifyKeyRole("", NO_MOD)).toBe("unknown");
  });
});

// ── pasteAuditDetail ─────────────────────────────────────────────────────

describe("pasteAuditDetail — content never logged", () => {
  it("captures length and line count without the content itself", () => {
    const detail = pasteAuditDetail("hello world");
    expect(detail.length).toBe(11);
    expect(detail.line_count).toBe(1);
    expect(detail.looks_like_url).toBe(false);
    // Content is gone — nothing in the returned shape carries it.
    expect(JSON.stringify(detail)).not.toContain("hello world");
  });

  it("counts newlines for multi-line pastes", () => {
    expect(pasteAuditDetail("line1\nline2\nline3").line_count).toBe(3);
  });

  it("flags http/https URLs via looks_like_url heuristic", () => {
    expect(pasteAuditDetail("https://example.com").looks_like_url).toBe(true);
    expect(pasteAuditDetail("http://example.com/path?q=1").looks_like_url).toBe(true);
  });

  it("does NOT flag bare hostnames or non-URL text", () => {
    expect(pasteAuditDetail("example.com").looks_like_url).toBe(false);
    expect(pasteAuditDetail("just some text").looks_like_url).toBe(false);
    expect(pasteAuditDetail("password123").looks_like_url).toBe(false);
  });

  it("never logs sensitive-looking content fields", () => {
    const detail = pasteAuditDetail("CorrectHorseBatteryStaple$2026!");
    const keys = Object.keys(detail);
    // Only the three documented redacted fields exist.
    expect(keys.sort()).toEqual(["length", "line_count", "looks_like_url"].sort());
  });
});

// ── buildUserInputAuditDetail ───────────────────────────────────────────

describe("buildUserInputAuditDetail — wire → redacted detail", () => {
  it("normalizes click coordinates to [0, 1] against the display dimensions", () => {
    const detail = buildUserInputAuditDetail(
      { kind: "click", x: 640, y: 400, button: "left" },
      1280,
      800,
    );
    expect(detail).toEqual({
      kind: "click",
      x_norm: 0.5,
      y_norm: 0.5,
      button: "left",
    });
  });

  it("guards against zero/negative display dimensions (defensive divide)", () => {
    const detail = buildUserInputAuditDetail(
      { kind: "click", x: 100, y: 100, button: "right" },
      0,
      0,
    );
    // Falls back to width/height = 1, so x_norm/y_norm are large
    // but finite — never NaN/Infinity.
    expect(Number.isFinite((detail as { x_norm: number }).x_norm)).toBe(true);
  });

  it("redacts a printable key into character_class + key_role", () => {
    const detail = buildUserInputAuditDetail(
      {
        kind: "key",
        key: "a",
        modifiers: { ctrl: false, meta: false, alt: false, shift: false },
      },
      1280,
      800,
    );
    const keyDetail = detail as Extract<UserInputForwardedDetail, { kind: "key" }>;
    expect(keyDetail.kind).toBe("key");
    expect(keyDetail.character_class).toBe("letter");
    expect(keyDetail.key_role).toBe("printable");
    // Raw key MUST NOT appear in the audit shape.
    expect(JSON.stringify(detail)).not.toContain('"key":"a"');
  });

  it("paste detail collapses content to length/line_count/looks_like_url", () => {
    const detail = buildUserInputAuditDetail(
      { kind: "paste", text: "secret-password-123" },
      1280,
      800,
    );
    expect(detail).toEqual({
      kind: "paste",
      length: 19,
      line_count: 1,
      looks_like_url: false,
    });
    expect(JSON.stringify(detail)).not.toContain("secret-password-123");
  });
});

// ── forwardUserInput orchestrator ───────────────────────────────────────

function makeMockDispatcher(): {
  dispatcher: ComputerPlatformDispatcher;
  forwardCalls: UserInputEvent[];
  failNext?: boolean;
  setFail: (v: boolean) => void;
} {
  const forwardCalls: UserInputEvent[] = [];
  let failNext = false;
  const dispatcher: ComputerPlatformDispatcher = {
    async queryDisplay() {
      return { width: 1280, height: 800, scaling_factor: 1 };
    },
    async execute(_action: ComputerAction) {
      return { ok: true };
    },
    async forwardInput(event) {
      if (failNext) {
        failNext = false;
        throw new Error("transport boom");
      }
      forwardCalls.push(event);
    },
  };
  return {
    dispatcher,
    forwardCalls,
    setFail(v) {
      failNext = v;
    },
  };
}

async function makeManagerWithSession(opts: { withCoBrowse: boolean }) {
  const { dispatcher, forwardCalls, setFail } = makeMockDispatcher();
  const coBrowseControl = opts.withCoBrowse
    ? createCoBrowseControlMachine({ sessionId: "cs_test", motebitId: "mb_test" })
    : undefined;
  const manager = createComputerSessionManager({
    dispatcher,
    coBrowseControl,
  });
  const { handle } = await manager.openSession("mb_test");
  return { manager, sessionId: handle.session_id, coBrowseControl, forwardCalls, setFail };
}

describe("forwardUserInput — gate enforcement", () => {
  it("forwards when controlState.kind === 'user' (default new session)", async () => {
    const { manager, sessionId, forwardCalls } = await makeManagerWithSession({
      withCoBrowse: true,
    });
    const result = await manager.forwardUserInput(sessionId, {
      kind: "click",
      x: 100,
      y: 100,
      button: "left",
    });
    expect(result.outcome).toBe("forwarded");
    expect(forwardCalls).toHaveLength(1);
  });

  it("rejects with not_in_user_state when motebit holds control", async () => {
    const { manager, sessionId, coBrowseControl, forwardCalls } = await makeManagerWithSession({
      withCoBrowse: true,
    });
    coBrowseControl!.requestControl("motebit");
    coBrowseControl!.grantControl("user");

    const result = await manager.forwardUserInput(sessionId, {
      kind: "click",
      x: 100,
      y: 100,
      button: "left",
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.rejection_reason).toBe("not_in_user_state");
    }
    expect(forwardCalls).toHaveLength(0);
  });

  it("rejects with not_in_user_state when state is handoff_pending or paused", async () => {
    const { manager, sessionId, coBrowseControl } = await makeManagerWithSession({
      withCoBrowse: true,
    });
    coBrowseControl!.requestControl("motebit");
    let result = await manager.forwardUserInput(sessionId, {
      kind: "key",
      key: "a",
      modifiers: { ctrl: false, meta: false, alt: false, shift: false },
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.rejection_reason).toBe("not_in_user_state");
    }

    coBrowseControl!.denyControl("user");
    coBrowseControl!.pause("user");
    result = await manager.forwardUserInput(sessionId, {
      kind: "click",
      x: 1,
      y: 1,
      button: "left",
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.rejection_reason).toBe("not_in_user_state");
    }
  });

  it("rejects with not_supported when no coBrowseControl is wired", async () => {
    const { manager, sessionId } = await makeManagerWithSession({ withCoBrowse: false });
    const result = await manager.forwardUserInput(sessionId, {
      kind: "click",
      x: 1,
      y: 1,
      button: "left",
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.rejection_reason).toBe("not_supported");
    }
  });

  it("rejects with session_closed for an unknown session", async () => {
    const { manager } = await makeManagerWithSession({ withCoBrowse: true });
    const result = await manager.forwardUserInput("not_a_session", {
      kind: "click",
      x: 1,
      y: 1,
      button: "left",
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.rejection_reason).toBe("session_closed");
    }
  });

  it("rejects with transport_error when the dispatcher throws", async () => {
    const { manager, sessionId, setFail } = await makeManagerWithSession({ withCoBrowse: true });
    setFail(true);
    const result = await manager.forwardUserInput(sessionId, {
      kind: "click",
      x: 1,
      y: 1,
      button: "left",
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.rejection_reason).toBe("transport_error");
    }
  });

  it("rejects with not_supported when the dispatcher omits forwardInput", async () => {
    const dispatcher: ComputerPlatformDispatcher = {
      async queryDisplay() {
        return { width: 1280, height: 800, scaling_factor: 1 };
      },
      async execute() {
        return { ok: true };
      },
      // forwardInput omitted — desktop_drive shape
    };
    const coBrowseControl = createCoBrowseControlMachine({
      sessionId: "cs_test",
      motebitId: "mb_test",
    });
    const manager = createComputerSessionManager({ dispatcher, coBrowseControl });
    const { handle } = await manager.openSession("mb_test");
    const result = await manager.forwardUserInput(handle.session_id, {
      kind: "click",
      x: 1,
      y: 1,
      button: "left",
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.rejection_reason).toBe("not_supported");
    }
  });
});

describe("forwardUserInput — audit shape", () => {
  it("emits audit on EVERY call (success and rejection)", async () => {
    const { manager, sessionId } = await makeManagerWithSession({ withCoBrowse: true });
    const r1 = await manager.forwardUserInput(sessionId, {
      kind: "click",
      x: 100,
      y: 100,
      button: "left",
    });
    expect(r1.audit.outcome).toBe("forwarded");

    // Force rejection.
    const r2 = await manager.forwardUserInput("bogus", {
      kind: "click",
      x: 100,
      y: 100,
      button: "left",
    });
    expect(r2.audit.outcome).toBe("rejected");
    expect(r2.audit.rejection_reason).toBe("session_closed");
  });

  it("audit carries control_state_at_forwarding so verifiers don't cross-reference", async () => {
    const { manager, sessionId, coBrowseControl } = await makeManagerWithSession({
      withCoBrowse: true,
    });
    coBrowseControl!.requestControl("motebit");
    coBrowseControl!.grantControl("user");

    const result = await manager.forwardUserInput(sessionId, {
      kind: "click",
      x: 100,
      y: 100,
      button: "left",
    });
    expect(result.audit.control_state_at_forwarding).toEqual({ kind: "motebit" });
    expect(result.audit.outcome).toBe("rejected");
  });

  it("audit detail is the redacted shape — never the wire shape", async () => {
    const { manager, sessionId } = await makeManagerWithSession({ withCoBrowse: true });
    const result = await manager.forwardUserInput(sessionId, {
      kind: "paste",
      text: "secret-password-123",
    });
    const json = JSON.stringify(result.audit);
    expect(json).not.toContain("secret-password-123");
    expect(result.audit.detail.kind).toBe("paste");
  });
});

describe("forwardUserInput — surface determinism (raw never lands in audit)", () => {
  it("a complex payload shows redaction at every layer", async () => {
    const { manager, sessionId } = await makeManagerWithSession({ withCoBrowse: true });

    const result = await manager.forwardUserInput(sessionId, {
      kind: "key",
      key: "a",
      modifiers: { ctrl: true, meta: false, alt: false, shift: false },
    });
    const json = JSON.stringify(result.audit);
    // No raw 'key: "a"' entry, no shortcut text, just redacted shape.
    expect(json).not.toMatch(/"key":\s*"a"/);
    const detail = result.audit.detail as Extract<UserInputForwardedDetail, { kind: "key" }>;
    expect(detail.character_class).toBe("letter");
    expect(detail.key_role).toBe("shortcut");
    expect(detail.modifiers).toEqual({ ctrl: true, meta: false, alt: false, shift: false });
  });

  // Sanity: the redaction is structural, not vi.spy-based — it can't
  // be turned off by mistake at runtime.
  it("modifying the wire event after the call cannot taint the audit", async () => {
    const { manager, sessionId } = await makeManagerWithSession({ withCoBrowse: true });
    const event: UserInputEvent = { kind: "paste", text: "before" };
    const result = await manager.forwardUserInput(sessionId, event);
    // Mutate AFTER forward.
    (event as { text: string }).text = "after-mutation-leak";
    const json = JSON.stringify(result.audit);
    expect(json).not.toContain("before");
    expect(json).not.toContain("after-mutation-leak");
  });

  // Pure assert: nothing in the redaction layer accidentally pulls in
  // raw text via spread, JSON.parse(JSON.stringify), or similar.
  it("the audit detail object's enumerable keys exhaustively cover the redacted shape", () => {
    const detail = buildUserInputAuditDetail({ kind: "paste", text: "x" }, 1280, 800);
    expect(Object.keys(detail).sort()).toEqual(
      ["kind", "length", "line_count", "looks_like_url"].sort(),
    );
  });
});

// Compile-time surface check: the audit-detail type union
// exhaustively does NOT include raw-text or raw-key fields. If the
// redaction surface widens, this stops compiling — that's the
// intended drift defense, no runtime assertion needed.
describe("UserInputForwardedPayload — type surface", () => {
  it("audit-detail type exhausts to the redacted shapes only", () => {
    const exhaust = (d: UserInputForwardedDetail): string => {
      switch (d.kind) {
        case "click":
          return `${d.x_norm}|${d.y_norm}|${d.button}`;
        case "key":
          return `${d.character_class}|${d.key_role}`;
        case "paste":
          return `${d.length}|${d.line_count}|${d.looks_like_url}`;
      }
    };
    expect(typeof exhaust({ kind: "click", x_norm: 0, y_norm: 0, button: "left" })).toBe("string");
  });
});
