import { describe, it, expect, vi, beforeEach } from "vitest";

const writeLine = vi.fn();
const activeStatus = vi.fn();
vi.mock("../terminal.js", () => ({ writeLine: (s: string) => writeLine(s) }));
vi.mock("../statusline.js", () => ({ activeStatus: () => activeStatus() }));

const { createCliLogger, formatContext } = await import("../cli-logger.js");

// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("createCliLogger", () => {
  beforeEach(() => {
    writeLine.mockClear();
    activeStatus.mockReset();
    activeStatus.mockReturnValue(null);
  });

  it("folds poll failures into the active status row, counting attempts", () => {
    const note = vi.fn();
    activeStatus.mockReturnValue({ note, step: vi.fn(), stop: vi.fn() });
    const logger = createCliLogger();
    logger.warn("delegation poll failed", { taskId: "task-123", status: 503, body: "" });
    logger.warn("delegation poll failed", { taskId: "task-123", status: 503, body: "" });
    expect(note).toHaveBeenNthCalledWith(1, "relay hiccup, still waiting (attempt 1)");
    expect(note).toHaveBeenNthCalledWith(2, "relay hiccup, still waiting (attempt 2)");
    // Status owns the moment — no scrollback line per retry
    expect(writeLine).not.toHaveBeenCalled();
  });

  it("renders poll failures as one calm dim line when no status is active", () => {
    const logger = createCliLogger();
    logger.warn("delegation poll failed", { taskId: "task-12345678", status: 503, body: "" });
    expect(writeLine).toHaveBeenCalledTimes(1);
    const line = plain(writeLine.mock.calls[0]![0] as string);
    expect(line).toContain("relay hiccup, still waiting (attempt 1)");
    expect(line).toContain("task-123");
    expect(line).not.toMatch(/[{}"]/); // never raw JSON (#456)
  });

  it("attempt counts are per task", () => {
    const note = vi.fn();
    activeStatus.mockReturnValue({ note, step: vi.fn(), stop: vi.fn() });
    const logger = createCliLogger();
    logger.warn("delegation poll failed", { taskId: "task-a" });
    logger.warn("delegation poll failed", { taskId: "task-b" });
    expect(note).toHaveBeenLastCalledWith("relay hiccup, still waiting (attempt 1)");
  });

  it("renders unknown warnings as a calm line with compact context", () => {
    const logger = createCliLogger();
    logger.warn("trust bump failed", { peer: "abc123" });
    const line = plain(writeLine.mock.calls[0]![0] as string);
    expect(line).toContain("trust bump failed");
    expect(line).toContain("peer=abc123");
  });

  it("route_degraded renders as a designed sentence, not a key=value dump (#480)", () => {
    const logger = createCliLogger();
    logger.warn("delegation.route_degraded", {
      from: "p2p",
      to: "relay",
      code: "p2p_ineligible",
      message: "peer lacks p2p eligibility",
    });
    const line = plain(writeLine.mock.calls[0]![0] as string);
    expect(line).toContain("direct payment route unavailable (p2p_ineligible)");
    expect(line).toContain("no onchain payment leaves the wallet");
    expect(line).not.toContain("from=");
    expect(line).not.toContain("to=");
  });

  it("route_degraded with an unexpected shape falls back to the honest context form", () => {
    const logger = createCliLogger();
    logger.warn("delegation.route_degraded", { from: "relay", to: "p2p" });
    const line = plain(writeLine.mock.calls[0]![0] as string);
    // The p2p→relay sentence must not lie about a shape it wasn't written for
    expect(line).not.toContain("no onchain payment");
    expect(line).toContain("from=relay");
  });

  it("a logger line during a live act nests at 4 spaces; at rest it sits at 2 (#480)", () => {
    const logger = createCliLogger();
    activeStatus.mockReturnValue({ note: vi.fn(), step: vi.fn(), stop: vi.fn() });
    logger.warn("delegation.route_degraded", { from: "p2p", to: "relay" });
    activeStatus.mockReturnValue(null);
    logger.warn("trust bump failed", { peer: "abc" });
    const inAct = plain(writeLine.mock.calls[0]![0] as string);
    const atRest = plain(writeLine.mock.calls[1]![0] as string);
    expect(inAct.startsWith("    ·")).toBe(true);
    expect(atRest.startsWith("  ·")).toBe(true);
    expect(atRest.startsWith("    ")).toBe(false);
  });

  it("volatile spend store and key-pin events get designed sentences", () => {
    const logger = createCliLogger();
    logger.warn("money_meter.volatile_spend_store", { detail: "long injected detail" });
    logger.warn("relay_key_pin.mismatch", { pinnedKeyPrefix: "aaa", fetchedKeyPrefix: "bbb" });
    const first = plain(writeLine.mock.calls[0]![0] as string);
    const second = plain(writeLine.mock.calls[1]![0] as string);
    expect(first).toContain("re-arms on restart");
    expect(first).not.toContain("detail=");
    expect(second).toContain("does not match the pinned key");
    expect(second).not.toContain("pinnedKeyPrefix=");
  });
});

describe("formatContext", () => {
  it("drops empty values and bounds long ones", () => {
    expect(formatContext({ a: "x", b: "", c: undefined })).toBe(" (a=x)");
    const long = formatContext({ body: "e".repeat(200) });
    expect(long.length).toBeLessThan(80);
    expect(long).toContain("…");
  });

  it("returns empty string for no context", () => {
    expect(formatContext(undefined)).toBe("");
  });
});
