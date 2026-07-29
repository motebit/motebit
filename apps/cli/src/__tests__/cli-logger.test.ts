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

  it("renders other warnings as a calm line with compact context", () => {
    const logger = createCliLogger();
    logger.warn("delegation.route_degraded", { from: "p2p", to: "relay" });
    const line = plain(writeLine.mock.calls[0]![0] as string);
    expect(line).toContain("delegation.route_degraded");
    expect(line).toContain("from=p2p");
    expect(line).toContain("to=relay");
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
