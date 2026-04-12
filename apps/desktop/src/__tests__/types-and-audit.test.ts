import { describe, it, expect, beforeEach } from "vitest";
import { formatTimeAgo } from "../types";
import { parseJsonSafe, ipcString, classifyDecision } from "../ui/audit-utils";

describe("formatTimeAgo", () => {
  beforeEach(() => {
    // Not strictly deterministic, but we use timestamps relative to now
  });

  it("returns 'just now' under 60s", () => {
    expect(formatTimeAgo(Date.now() - 10_000)).toBe("just now");
  });

  it("returns minutes for under 1h", () => {
    expect(formatTimeAgo(Date.now() - 5 * 60 * 1000)).toMatch(/m ago$/);
  });

  it("returns hours for under 24h", () => {
    expect(formatTimeAgo(Date.now() - 5 * 3600 * 1000)).toMatch(/h ago$/);
  });

  it("returns days for >=24h", () => {
    expect(formatTimeAgo(Date.now() - 48 * 3600 * 1000)).toMatch(/d ago$/);
  });
});

describe("parseJsonSafe", () => {
  it("returns the value unchanged when not a string", () => {
    expect(parseJsonSafe(42)).toBe(42);
    const obj = { a: 1 };
    expect(parseJsonSafe(obj)).toBe(obj);
  });

  it("parses valid JSON strings", () => {
    expect(parseJsonSafe('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonSafe('"hello"')).toBe("hello");
  });

  it("returns the raw string on parse failure", () => {
    expect(parseJsonSafe("not json{")).toBe("not json{");
  });
});

describe("ipcString", () => {
  it("returns fallback for null/undefined", () => {
    expect(ipcString(null)).toBe("");
    expect(ipcString(undefined, "dflt")).toBe("dflt");
  });

  it("returns strings unchanged", () => {
    expect(ipcString("hello")).toBe("hello");
  });

  it("stringifies numbers and booleans", () => {
    expect(ipcString(42)).toBe("42");
    expect(ipcString(true)).toBe("true");
  });

  it("JSON-stringifies objects", () => {
    expect(ipcString({ a: 1 })).toBe('{"a":1}');
  });
});

describe("classifyDecision", () => {
  it("extracts 'denied' from JSON decision field", () => {
    expect(classifyDecision('{"decision":"denied"}')).toBe("denied");
    expect(classifyDecision('{"decision":"deny"}')).toBe("denied");
  });

  it("extracts 'allowed' from JSON", () => {
    expect(classifyDecision('{"decision":"allowed"}')).toBe("allowed");
    expect(classifyDecision('{"decision":"allow"}')).toBe("allowed");
  });

  it("extracts 'approval' variants", () => {
    expect(classifyDecision('{"decision":"requires_approval"}')).toBe("approval");
    expect(classifyDecision('{"decision":"pending"}')).toBe("approval");
    expect(classifyDecision('{"decision":"approval"}')).toBe("approval");
  });

  it("falls back to action field when decision is empty", () => {
    expect(classifyDecision('{"action":"deny"}')).toBe("denied");
  });

  it("falls back to raw string heuristic", () => {
    expect(classifyDecision("was denied")).toBe("denied");
    expect(classifyDecision("requires approval")).toBe("approval");
    expect(classifyDecision("pending")).toBe("approval");
  });

  it("defaults to 'allowed' when nothing matches", () => {
    expect(classifyDecision("random text")).toBe("allowed");
    expect(classifyDecision(null)).toBe("allowed");
  });
});
