import { describe, it, expect, beforeAll, vi } from "vitest";

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

beforeAll(async () => {
  const mod = await import("../ui/chat");
  renderMarkdown = mod.renderMarkdown;
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
