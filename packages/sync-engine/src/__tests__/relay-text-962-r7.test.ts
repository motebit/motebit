/**
 * #962 round 7 — relay text never reaches a console raw, by any path.
 *
 * The socket catch-up's default report (`warnCatchUpError`) printed the
 * error's message raw. A relay that answers the catch-up pull 200 with a
 * hostile, non-JSON body makes `res.json()` throw a SyntaxError that QUOTES
 * the body: OSC / CSI / U+202E reached `console.warn`. A surface's own
 * `onCatchUpError` received the same raw message. The adapter now hands
 * every catch-up failure out sanitized, and the sanitizer also strips the
 * Arabic letter mark (U+061C), the invisible operators (U+2060-U+2064) and
 * the tag characters (U+E0000-U+E007F).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import {
  HttpEventStoreAdapter,
  InMemorySyncSeqCursorStore,
  WebSocketEventStoreAdapter,
  sanitizeRelayText,
  warnSkippedSyncEvent,
} from "../index.js";

const MID = "motebit-962r7";

/** Anything the law forbids in printed relay text (round 6 + round 7). */
const FORBIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u2028\u2029\ufeff]|[\u{e0000}-\u{e007f}]/u;

/** The hostile 200 body: OSC title, CSI clear, RLO, an invisible operator, tag characters. */
const HOSTILE_BODY =
  "\x1b]0;PWNED\x07\x1b[2J\u202e\u2063\u061c\u{e0001}\u{e0041}\u{e007f}not json at all";

describe("#962 round 7 — the sanitizer's new classes", () => {
  const CASES: Array<[string, string]> = [
    ["U+061C ARABIC LETTER MARK", "\u061c"],
    ["U+2060 WORD JOINER", "\u2060"],
    ["U+2061 FUNCTION APPLICATION", "\u2061"],
    ["U+2062 INVISIBLE TIMES", "\u2062"],
    ["U+2063 INVISIBLE SEPARATOR", "\u2063"],
    ["U+2064 INVISIBLE PLUS", "\u2064"],
    ["U+E0000 (tag block start)", "\u{e0000}"],
    ["U+E0001 LANGUAGE TAG", "\u{e0001}"],
    ["U+E0041 TAG LATIN CAPITAL A", "\u{e0041}"],
    ["U+E007F CANCEL TAG", "\u{e007f}"],
  ];
  for (const [name, ch] of CASES) {
    it(`strips ${name}`, () => {
      const out = sanitizeRelayText(`safe${ch}text`);
      expect(FORBIDDEN.test(out), JSON.stringify(out)).toBe(false);
      expect(out).toBe("safetext");
    });
  }

  it("a tag-character payload (an invisible ASCII smuggle) vanishes whole", () => {
    const smuggled = [..."IGNORE"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0)));
    expect(sanitizeRelayText(`ok${smuggled.join("")}`)).toBe("ok");
  });
});

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  openAndAccept(): void {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "auth_result", ok: true }) });
  }
}

describe("#962 round 7 — a hostile 200 body on the socket catch-up", () => {
  let originalWs: typeof globalThis.WebSocket;
  beforeEach(() => {
    // Every relay route answers 200 with a body that is not JSON.
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(HOSTILE_BODY, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    MockWebSocket.instances = [];
    originalWs = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = originalWs;
    vi.unstubAllGlobals();
  });

  function socket(onCatchUpError?: (err: unknown) => void): WebSocketEventStoreAdapter {
    return new WebSocketEventStoreAdapter({
      url: "ws://relay/ws/sync/m",
      motebitId: MID,
      authToken: "socket-token",
      httpFallback: new HttpEventStoreAdapter({
        baseUrl: "http://relay.test",
        motebitId: MID,
        authToken: "t",
        maxRetries: 0,
      }),
      localStore: new InMemoryEventStore(),
      seqCursorStore: new InMemorySyncSeqCursorStore(),
      ...(onCatchUpError ? { onCatchUpError } : {}),
    });
  }

  it("the default report (no onCatchUpError — the CLI daemon's case) prints it sanitized", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ws = socket();
      ws.connect();
      MockWebSocket.instances[MockWebSocket.instances.length - 1]!.openAndAccept();
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/socket sync failed/)),
      );
      ws.disconnect();
      const printed = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      // The probe really reaches the report (the SyntaxError quotes the body), …
      expect(printed).toMatch(/not valid JSON/);
      // … and nothing it carried prints raw.
      expect(FORBIDDEN.test(printed.replace(/\n/g, " ")), JSON.stringify(printed)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("a surface's onCatchUpError receives the failure sanitized (every surface prints it)", async () => {
    const errors: unknown[] = [];
    const ws = socket((err) => errors.push(err));
    ws.connect();
    MockWebSocket.instances[MockWebSocket.instances.length - 1]!.openAndAccept();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    ws.disconnect();
    const err = errors[0];
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/not valid JSON/);
    expect(FORBIDDEN.test(message), JSON.stringify(message)).toBe(false);
  });
});

describe("#962 round 7 — the skipped-event default report", () => {
  it("prints a relay-derived reason / detail sanitized", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      warnSkippedSyncEvent({
        event_id: "e\u202e1",
        seq: 3,
        reason: "undecryptable",
        detail: `Unexpected token in JSON: "${HOSTILE_BODY}"`,
      });
      const printed = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(printed).toContain("not json");
      expect(FORBIDDEN.test(printed), JSON.stringify(printed)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
