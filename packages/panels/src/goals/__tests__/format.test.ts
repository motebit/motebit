import { describe, expect, it } from "vitest";
import { formatCountdownUntil } from "../format.js";

describe("formatCountdownUntil", () => {
  it("returns 'any moment' when target is in the past or present", () => {
    expect(formatCountdownUntil(1000, 2000)).toBe("any moment");
    expect(formatCountdownUntil(1000, 1000)).toBe("any moment");
  });

  it("uses seconds under one minute", () => {
    expect(formatCountdownUntil(1000 + 15_000, 1000)).toBe("in 15s");
    expect(formatCountdownUntil(1000 + 59_000, 1000)).toBe("in 59s");
  });

  it("uses minutes under one hour", () => {
    expect(formatCountdownUntil(1000 + 60_000, 1000)).toBe("in 1m");
    expect(formatCountdownUntil(1000 + 45 * 60_000, 1000)).toBe("in 45m");
  });

  it("uses hours + minutes remainder under one day", () => {
    expect(formatCountdownUntil(1000 + 3_600_000, 1000)).toBe("in 1h");
    expect(formatCountdownUntil(1000 + (3 * 60 + 30) * 60_000, 1000)).toBe("in 3h 30m");
    expect(formatCountdownUntil(1000 + 23 * 3_600_000, 1000)).toBe("in 23h");
  });

  it("uses days + hours remainder beyond one day", () => {
    expect(formatCountdownUntil(1000 + 86_400_000, 1000)).toBe("in 1d");
    expect(formatCountdownUntil(1000 + (2 * 24 + 5) * 3_600_000, 1000)).toBe("in 2d 5h");
    expect(formatCountdownUntil(1000 + 7 * 86_400_000, 1000)).toBe("in 7d");
  });

  it("omits zero remainder in both hour and day bands", () => {
    expect(formatCountdownUntil(1000 + 2 * 3_600_000, 1000)).toBe("in 2h");
    expect(formatCountdownUntil(1000 + 3 * 86_400_000, 1000)).toBe("in 3d");
  });

  it("defaults nowMs to Date.now() when omitted", () => {
    const target = Date.now() + 30_000;
    const result = formatCountdownUntil(target);
    expect(result).toMatch(/^in \d+s$/);
  });
});
