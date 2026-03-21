import { describe, it, expect } from "vitest";
import {
  getAllowedOrigins,
  corsHeaders,
  isAllowedOrigin,
  getClientIP,
  validateModel,
  validateMessages,
  validateFetchUrl,
  buildProxiedBody,
  stripHtml,
  FREE_MODEL_ALLOWLIST,
  DAILY_LIMIT,
  MAX_MESSAGES,
  MAX_MESSAGE_LENGTH,
} from "../validation.js";

// --- getAllowedOrigins ---

describe("getAllowedOrigins", () => {
  it("includes production origins in both modes", () => {
    const prod = getAllowedOrigins(false);
    expect(prod.has("https://motebit.com")).toBe(true);
    expect(prod.has("https://www.motebit.com")).toBe(true);
  });

  it("excludes dev origins in production mode", () => {
    const prod = getAllowedOrigins(false);
    expect(prod.has("http://localhost:3000")).toBe(false);
  });

  it("includes dev origins in development mode", () => {
    const dev = getAllowedOrigins(true);
    expect(dev.has("http://localhost:3000")).toBe(true);
    expect(dev.has("http://localhost:5173")).toBe(true);
    expect(dev.has("https://motebit.com")).toBe(true);
  });
});

// --- corsHeaders ---

describe("corsHeaders", () => {
  it("returns correct CORS headers for an origin", () => {
    const headers = corsHeaders("https://motebit.com");
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://motebit.com");
    expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(headers["Access-Control-Allow-Headers"]).toContain("x-api-key");
    expect(headers["Access-Control-Max-Age"]).toBe("86400");
  });
});

// --- isAllowedOrigin ---

describe("isAllowedOrigin", () => {
  const origins = getAllowedOrigins(false);

  it("allows production origins", () => {
    expect(isAllowedOrigin("https://motebit.com", origins)).toBe(true);
  });

  it("rejects unknown origins", () => {
    expect(isAllowedOrigin("https://evil.com", origins)).toBe(false);
  });

  it("rejects empty origin", () => {
    expect(isAllowedOrigin("", origins)).toBe(false);
  });
});

// --- getClientIP ---

describe("getClientIP", () => {
  it("extracts IP from x-forwarded-for (first entry)", () => {
    const req = {
      headers: { get: (n: string) => (n === "x-forwarded-for" ? "1.2.3.4, 5.6.7.8" : null) },
    };
    expect(getClientIP(req)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip", () => {
    const req = { headers: { get: (n: string) => (n === "x-real-ip" ? "9.8.7.6" : null) } };
    expect(getClientIP(req)).toBe("9.8.7.6");
  });

  it("returns 'unknown' when no IP headers", () => {
    const req = { headers: { get: () => null } };
    expect(getClientIP(req)).toBe("unknown");
  });
});

// --- validateModel ---

describe("validateModel", () => {
  it("rejects missing model", () => {
    expect(validateModel(undefined, false)).toEqual({
      valid: false,
      error: "invalid_model",
      status: 400,
    });
    expect(validateModel("", false)).toEqual({ valid: false, error: "invalid_model", status: 400 });
  });

  it("allows free tier model on free tier", () => {
    expect(validateModel(FREE_MODEL_ALLOWLIST[0], false).valid).toBe(true);
  });

  it("rejects non-allowlisted model on free tier", () => {
    const result = validateModel("claude-opus-4-20250514", false);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Free tier");
  });

  it("allows any model for BYOK users", () => {
    expect(validateModel("claude-opus-4-20250514", true).valid).toBe(true);
    expect(validateModel("gpt-4", true).valid).toBe(true);
  });
});

// --- validateMessages ---

describe("validateMessages", () => {
  it("rejects non-array messages", () => {
    expect(validateMessages(null).valid).toBe(false);
    expect(validateMessages("hello").valid).toBe(false);
    expect(validateMessages({}).valid).toBe(false);
  });

  it("rejects empty messages array", () => {
    expect(validateMessages([]).valid).toBe(false);
  });

  it("accepts valid messages", () => {
    expect(validateMessages([{ role: "user", content: "hi" }]).valid).toBe(true);
  });

  it("rejects too many messages", () => {
    const msgs = Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => ({
      role: "user",
      content: `msg ${i}`,
    }));
    const result = validateMessages(msgs);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("too_many");
  });

  it("rejects oversized message content", () => {
    const result = validateMessages([
      { role: "user", content: "x".repeat(MAX_MESSAGE_LENGTH + 1) },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("too_long");
  });

  it("allows messages at exact limit", () => {
    const msgs = Array.from({ length: MAX_MESSAGES }, (_, i) => ({
      role: "user",
      content: `msg ${i}`,
    }));
    expect(validateMessages(msgs).valid).toBe(true);
  });
});

// --- validateFetchUrl ---

describe("validateFetchUrl", () => {
  it("rejects missing url", () => {
    expect(validateFetchUrl(undefined).valid).toBe(false);
    expect(validateFetchUrl("").valid).toBe(false);
  });

  it("rejects non-http schemes", () => {
    expect(validateFetchUrl("ftp://example.com").valid).toBe(false);
    expect(validateFetchUrl("file:///etc/passwd").valid).toBe(false);
    expect(validateFetchUrl("javascript:alert(1)").valid).toBe(false);
  });

  it("allows http and https", () => {
    expect(validateFetchUrl("http://example.com").valid).toBe(true);
    expect(validateFetchUrl("https://example.com/path?q=1").valid).toBe(true);
  });
});

// --- buildProxiedBody ---

describe("buildProxiedBody", () => {
  const baseBody = {
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "hi" }],
    system: "You are helpful",
    max_tokens: 8192,
    temperature: 0.7,
    tools: [{ name: "search" }],
  };

  it("clamps max_tokens to 4096 for free tier", () => {
    const result = buildProxiedBody(baseBody, false);
    expect(result.max_tokens).toBe(4096);
  });

  it("preserves max_tokens for BYOK", () => {
    const result = buildProxiedBody(baseBody, true);
    expect(result.max_tokens).toBe(8192);
  });

  it("strips tools for free tier", () => {
    const result = buildProxiedBody(baseBody, false);
    expect(result.tools).toBeUndefined();
  });

  it("passes tools for BYOK", () => {
    const result = buildProxiedBody(baseBody, true);
    expect(result.tools).toEqual([{ name: "search" }]);
  });

  it("defaults max_tokens to 4096 when not provided", () => {
    const result = buildProxiedBody({ model: "test", messages: [] }, true);
    expect(result.max_tokens).toBe(4096);
  });

  it("always enables streaming", () => {
    const result = buildProxiedBody(baseBody, false);
    expect(result.stream).toBe(true);
  });
});

// --- stripHtml ---

describe("stripHtml", () => {
  it("removes script tags and content", () => {
    expect(stripHtml('<p>Hello</p><script>alert("xss")</script><p>World</p>')).toBe("Hello World");
  });

  it("removes style tags and content", () => {
    expect(stripHtml("<style>.foo{color:red}</style><p>Content</p>")).toBe("Content");
  });

  it("removes HTML tags", () => {
    expect(stripHtml("<h1>Title</h1><p>Paragraph</p>")).toBe("Title Paragraph");
  });

  it("collapses whitespace", () => {
    expect(stripHtml("<p>  lots   of   space  </p>")).toBe("lots of space");
  });

  it("handles empty string", () => {
    expect(stripHtml("")).toBe("");
  });

  it("handles plain text (no tags)", () => {
    expect(stripHtml("Just plain text")).toBe("Just plain text");
  });
});

// --- Constants ---

describe("constants", () => {
  it("DAILY_LIMIT is reasonable", () => {
    expect(DAILY_LIMIT).toBeGreaterThan(0);
    expect(DAILY_LIMIT).toBeLessThanOrEqual(100);
  });

  it("FREE_MODEL_ALLOWLIST contains at least one model", () => {
    expect(FREE_MODEL_ALLOWLIST.length).toBeGreaterThan(0);
  });
});
