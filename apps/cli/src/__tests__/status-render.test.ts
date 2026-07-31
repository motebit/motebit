import { describe, it, expect } from "vitest";
import { renderStatusRow, formatElapsed, spinnerFrame } from "../status-render.js";

/** Strip ANSI so assertions read the text a human sees, not the escapes —
 * same convention as approval-render.test.ts. */
// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderStatusRow", () => {
  const t0 = 1_000_000;

  it("renders verb, subject, and elapsed", () => {
    const row = plain(
      renderStatusRow({ verb: "delegating", subject: "read_url", startedAt: t0 }, t0 + 12_000, 0),
    );
    expect(row).toBe("  ·  delegating read_url · 12s");
  });

  it("renders the current step narration", () => {
    const row = plain(
      renderStatusRow(
        {
          verb: "delegating",
          subject: "read_url",
          step: "payment confirmed onchain",
          startedAt: t0,
        },
        t0 + 30_000,
        1,
      ),
    );
    expect(row).toBe("  ·· delegating read_url — payment confirmed onchain · 30s");
  });

  it("a trouble note takes the step's place while set", () => {
    const row = plain(
      renderStatusRow(
        {
          verb: "delegating",
          subject: "read_url",
          step: "worker executing",
          note: "relay hiccup, still waiting (attempt 3)",
          startedAt: t0,
        },
        t0 + 41_000,
        2,
      ),
    );
    expect(row).toContain("relay hiccup, still waiting (attempt 3)");
    expect(row).not.toContain("worker executing");
  });

  it("renders without a subject", () => {
    const row = plain(renderStatusRow({ verb: "thinking", startedAt: t0 }, t0 + 1_000, 0));
    expect(row).toBe("  ·  thinking · 1s");
  });

  it("never contains raw JSON braces — calm text only", () => {
    const row = plain(
      renderStatusRow(
        {
          verb: "delegating",
          subject: "read_url",
          note: "relay hiccup (attempt 2)",
          startedAt: t0,
        },
        t0 + 5_000,
        0,
      ),
    );
    expect(row).not.toMatch(/[{}"]/);
  });
});

describe("formatElapsed", () => {
  it("seconds below a minute, m s above", () => {
    expect(formatElapsed(0, 5_000)).toBe("5s");
    expect(formatElapsed(0, 59_999)).toBe("59s");
    expect(formatElapsed(0, 92_000)).toBe("1m 32s");
  });

  it("sub-second reads as an instant, not a suspicious 0s (#480)", () => {
    expect(formatElapsed(0, 400)).toBe("<1s");
    expect(formatElapsed(0, 999)).toBe("<1s");
    expect(formatElapsed(0, 1_000)).toBe("1s");
  });

  it("never goes negative on clock skew", () => {
    expect(formatElapsed(10_000, 5_000)).toBe("<1s");
  });
});

describe("spinnerFrame", () => {
  it("breathes: grows then shrinks, cycles", () => {
    expect([0, 1, 2, 3, 4].map(spinnerFrame)).toEqual(["·", "··", "···", "··", "·"]);
  });
});
