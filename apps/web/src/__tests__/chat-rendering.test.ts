import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { SensitivityLevel, type AccrualBasis } from "@motebit/sdk";

// Mock @motebit/voice — chat.ts imports StreamingTTSQueue and WebSpeechTTSProvider.
vi.mock("@motebit/voice", () => ({
  StreamingTTSQueue: class {
    constructor(
      _speak: (text: string) => Promise<void>,
      _onStart: () => void,
      _onEnd: () => void,
    ) {}
    push() {}
    flush() {}
    cancel() {}
    get draining() {
      return false;
    }
  },
  WebSpeechTTSProvider: class {
    async speak() {}
    cancel() {}
    get speaking() {
      return false;
    }
  },
}));

// chat.ts grabs DOM elements at module level — stub them before import.
function stubElement(tag = "div"): Record<string, unknown> {
  return {
    tagName: tag.toUpperCase(),
    classList: { add: vi.fn(), remove: vi.fn() },
    addEventListener: vi.fn(),
    appendChild: vi.fn(),
    scrollTop: 0,
    scrollHeight: 0,
    disabled: false,
    value: "",
    innerHTML: "",
    focus: vi.fn(),
  };
}

beforeAll(() => {
  // Provide minimal stubs for getElementById calls in chat.ts
  vi.stubGlobal(
    "document",
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "getElementById") return () => stubElement();
          if (prop === "createElement") {
            return (tag: string) => ({
              ...stubElement(tag),
              style: {},
              offsetWidth: 0,
              remove: vi.fn(),
            });
          }
          return undefined;
        },
      },
    ),
  );
});

// Dynamic import so the stubs are in place first
let renderMarkdown: (raw: string) => string;
let formatErrorMessage: (msg: string) => string;
let buildAccrualAttributionEl: (basis: AccrualBasis) => { className: string; textContent: string };
let StreamingRenderer: typeof import("../ui/chat").StreamingRenderer;

beforeAll(async () => {
  const mod = await import("../ui/chat");
  renderMarkdown = mod.renderMarkdown;
  formatErrorMessage = mod.formatErrorMessage;
  buildAccrualAttributionEl = mod.buildAccrualAttributionEl as typeof buildAccrualAttributionEl;
  StreamingRenderer = mod.StreamingRenderer;
});

// ─── buildAccrualAttributionEl — the calm leverage-moment render (Inc 3) ───

describe("buildAccrualAttributionEl", () => {
  it("renders a calm recalled-memory attribution at the open tier", () => {
    const el = buildAccrualAttributionEl({
      kind: "recalled_memory",
      sourceRef: "n1",
      sensitivity: SensitivityLevel.None,
    });
    expect(el.className).toBe("accrual-attribution");
    expect(el.textContent).toContain("Recalled from what you've told me");
    expect(el.textContent).toContain("↻"); // the calm recall anchor
  });

  it("redacts at the guarded tier and never leaks the source ref onto the surface", () => {
    const el = buildAccrualAttributionEl({
      kind: "recalled_memory",
      sourceRef: "secret_node_id_0xdeadbeef",
      sensitivity: SensitivityLevel.Medical,
    });
    expect(el.textContent).toContain("Acted on a private memory");
    expect(el.textContent).not.toContain("secret_node_id");
  });
});

// ─── formatErrorMessage — the cloud-inference failure wall ─────────────

describe("formatErrorMessage", () => {
  // The bounced-user bug: a motebit-cloud user hitting the proxy's own 402
  // (`insufficient_balance`) must NOT be told to add credits at an Anthropic
  // console account they don't have.
  it("cloud balance wall (insufficient_balance) → fund/BYOK, NOT console.anthropic.com", () => {
    const out = formatErrorMessage('Anthropic API error 402: {"error":"insufficient_balance"}');
    expect(out).toContain("Motebit Cloud has no balance");
    expect(out).toContain("fund your droplet");
    expect(out).not.toContain("console.anthropic.com");
  });

  it("BYOK provider billing 402 still points at console.anthropic.com", () => {
    const out = formatErrorMessage('Anthropic API error 402: {"error":{"type":"billing_error"}}');
    expect(out).toContain("console.anthropic.com");
    expect(out).not.toContain("Motebit Cloud has no balance");
  });

  it("cloud-balance case wins even though the string also contains 402", () => {
    // The thrown string contains both "402" and "insufficient_balance"; the
    // cloud case is matched first so the wrong console copy never shows.
    const out = formatErrorMessage('Anthropic API error 402: {"error":"insufficient_balance"}');
    expect(out).not.toContain("No API credits");
  });

  it("unrelated errors fall through to the generic message", () => {
    expect(formatErrorMessage("boom")).toContain("Something went wrong");
  });
});

// ─── stripInternalTags (exercised through renderMarkdown) ─────────────

describe("stripInternalTags (via renderMarkdown)", () => {
  it("passes clean text through unchanged", () => {
    expect(renderMarkdown("hello world")).toBe("hello world");
  });

  it("strips <state .../> tags", () => {
    const result = renderMarkdown('before <state attention="0.8" /> after');
    expect(result).toBe("before  after");
  });

  it("strips <thinking>...</thinking> tags", () => {
    const result = renderMarkdown("visible <thinking>internal reasoning</thinking> text");
    expect(result).toBe("visible  text");
  });

  it("strips <memory ...>...</memory> tags", () => {
    const result = renderMarkdown('ok <memory confidence="0.9">fact</memory> done');
    expect(result).toBe("ok  done");
  });

  it("strips multiple different tags in one string", () => {
    const input = 'start <state x="1" /> middle <thinking>thought</thinking> end';
    const result = renderMarkdown(input);
    expect(result).toBe("start  middle  end");
  });

  it("strips incomplete streaming fragment at end of string", () => {
    // Unclosed tag at end — the regex `<(?:state|thinking|memory)[^>]*$` catches this.
    // renderMarkdown also trims whitespace, so the trailing space is removed.
    const result = renderMarkdown("hello <state att");
    expect(result).toBe("hello");
  });

  it("strips incomplete <thinking at end", () => {
    const result = renderMarkdown("visible <thinking");
    expect(result).toBe("visible");
  });

  it("strips multiline thinking blocks", () => {
    // After stripping, we get "a\n\n\nb" — double newline becomes spacing div
    const result = renderMarkdown("a\n<thinking>\nline1\nline2\n</thinking>\nb");
    expect(result).toContain("a");
    expect(result).toContain("b");
    expect(result).not.toContain("thinking");
    expect(result).not.toContain("line1");
  });
});

// ─── renderMarkdown ───────────────────────────────────────────────────

describe("renderMarkdown", () => {
  it("renders inline code", () => {
    const result = renderMarkdown("use `code` here");
    expect(result).toContain("<code");
    expect(result).toContain("code</code>");
    // Should not contain raw backticks
    expect(result).not.toContain("`");
  });

  it("renders bold text", () => {
    const result = renderMarkdown("this is **bold** text");
    expect(result).toContain("<strong>bold</strong>");
  });

  it("renders italic text", () => {
    const result = renderMarkdown("this is *italic* text");
    expect(result).toContain("<em>italic</em>");
  });

  it("renders code blocks", () => {
    const result = renderMarkdown("```js\nconst x = 1;\n```");
    expect(result).toContain("<pre><code>");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("</code></pre>");
  });

  it("renders h1/h2 headers as styled divs", () => {
    const result = renderMarkdown("## heading");
    expect(result).toContain("heading");
    expect(result).toContain("font-weight:600");
    expect(result).toContain("font-size:1.05em");
  });

  it("renders h3+ headers as styled divs (no size bump)", () => {
    const result = renderMarkdown("### subheading");
    expect(result).toContain("subheading");
    expect(result).toContain("font-weight:600");
    // h3+ should NOT have font-size:1.05em
    expect(result).not.toContain("font-size:1.05em");
  });

  it("renders unordered list items", () => {
    const result = renderMarkdown("- item one\n- item two");
    expect(result).toContain("item one");
    expect(result).toContain("item two");
    // Uses bullet character
    expect(result).toContain("\u2022");
  });

  it("renders ordered list items", () => {
    const result = renderMarkdown("1. first\n2. second");
    expect(result).toContain("1. first");
    expect(result).toContain("2. second");
    expect(result).toContain("padding-left:12px");
  });

  it("converts double newlines to spacing div", () => {
    const result = renderMarkdown("para one\n\npara two");
    expect(result).toContain("height:8px");
  });

  it("converts single newlines to <br>", () => {
    const result = renderMarkdown("line one\nline two");
    expect(result).toContain("<br>");
  });

  // ─── XSS prevention ────────────────────────────────────────────

  it("escapes <script> tags (XSS prevention)", () => {
    const result = renderMarkdown("<script>alert(1)</script>");
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("escapes HTML entities: & < >", () => {
    const result = renderMarkdown("a & b < c > d");
    expect(result).toContain("&amp;");
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
  });

  it("escapes HTML in code blocks too", () => {
    const result = renderMarkdown("```\n<div>xss</div>\n```");
    expect(result).not.toContain("<div>");
    expect(result).toContain("&lt;div&gt;");
  });

  // ─── Combined cases ────────────────────────────────────────────

  it("renders bold inside a list item", () => {
    const result = renderMarkdown("- **bold item**");
    expect(result).toContain("<strong>bold item</strong>");
    expect(result).toContain("\u2022");
  });

  it("renders code inside a paragraph", () => {
    const result = renderMarkdown("run `npm install` first");
    expect(result).toContain("<code");
    expect(result).toContain("npm install");
  });

  it("trims leading/trailing whitespace", () => {
    const result = renderMarkdown("  hello  ");
    expect(result).toBe("hello");
  });

  it("handles empty string", () => {
    const result = renderMarkdown("");
    expect(result).toBe("");
  });

  it("handles only internal tags (stripped to empty)", () => {
    const result = renderMarkdown("<thinking>just thoughts</thinking>");
    expect(result).toBe("");
  });
});

// ─── StreamingRenderer — the coalesced streaming paint (Cause C fix) ───
// A controllable requestAnimationFrame: pushes queue a callback we fire by
// hand, so we can assert exactly how many paints N pushes produce.
describe("StreamingRenderer", () => {
  let rafQueue: Array<() => void>;
  let rafId: number;

  function fakeEl(): { innerHTML: string } {
    return { innerHTML: "" };
  }

  beforeEach(() => {
    rafQueue = [];
    rafId = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafQueue.push(cb);
      return ++rafId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      // Single in-flight frame in these tests; drop the queue on cancel.
      if (id === rafId) rafQueue = [];
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function drainFrame(): void {
    const q = rafQueue;
    rafQueue = [];
    for (const cb of q) cb();
  }

  it("coalesces many pushes within one frame into a single paint (latest wins)", () => {
    const r = new StreamingRenderer();
    const el = fakeEl() as unknown as HTMLElement;
    r.push(el, "a");
    r.push(el, "ab");
    r.push(el, "abc");
    // Nothing painted until the frame fires — the O(n²) per-token path is gone.
    expect(el.innerHTML).toBe("");
    expect(rafQueue.length).toBe(1); // one scheduled frame, not three
    drainFrame();
    expect(el.innerHTML).toBe(renderMarkdown("abc")); // latest source only
  });

  it("runs the onPaint side-effect exactly once per coalesced frame", () => {
    const r = new StreamingRenderer();
    const el = fakeEl() as unknown as HTMLElement;
    const onPaint = vi.fn();
    r.push(el, "x", onPaint);
    r.push(el, "xy", onPaint);
    drainFrame();
    expect(onPaint).toHaveBeenCalledTimes(1);
  });

  it("flush() paints the pending source immediately and cancels the frame", () => {
    const r = new StreamingRenderer();
    const el = fakeEl() as unknown as HTMLElement;
    r.push(el, "final tokens");
    r.flush();
    expect(el.innerHTML).toBe(renderMarkdown("final tokens"));
    // The scheduled frame was cancelled — draining must not double-paint.
    expect(rafQueue.length).toBe(0);
  });

  it("flush() with nothing pending is a no-op", () => {
    const r = new StreamingRenderer();
    const el = fakeEl() as unknown as HTMLElement;
    r.flush();
    expect(el.innerHTML).toBe("");
  });

  it("schedules a fresh frame for pushes that arrive after a paint", () => {
    const r = new StreamingRenderer();
    const el = fakeEl() as unknown as HTMLElement;
    r.push(el, "one");
    drainFrame();
    expect(el.innerHTML).toBe(renderMarkdown("one"));
    r.push(el, "one two");
    expect(rafQueue.length).toBe(1); // new frame scheduled, not stuck
    drainFrame();
    expect(el.innerHTML).toBe(renderMarkdown("one two"));
  });
});
