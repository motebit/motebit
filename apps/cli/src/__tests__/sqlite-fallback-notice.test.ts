import { describe, it, expect, vi } from "vitest";

const listeners = vi.hoisted(() => [] as Array<(e: { cause: unknown }) => void>);

vi.mock("@motebit/persistence", () => ({
  onDriverFallback: (listener: (e: { cause: unknown }) => void) => {
    listeners.push(listener);
    return () => {
      listeners.splice(listeners.indexOf(listener), 1);
    };
  },
}));

import {
  installSqliteFallbackNotice,
  formatSqliteFallbackNotice,
  SQLITE_FALLBACK_MARKER,
} from "../sqlite-fallback-notice.js";

describe("sqlite fallback notice", () => {
  it("prints once per process however many databases fall back", () => {
    const writes: string[] = [];
    const off = installSqliteFallbackNotice((t) => writes.push(t));
    const cause = new Error("Cannot find module 'better-sqlite3'");
    for (const l of [...listeners]) l({ cause });
    for (const l of [...listeners]) l({ cause });
    off();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(SQLITE_FALLBACK_MARKER);
    expect(writes[0]).toContain("Cannot find module 'better-sqlite3'");
    expect(listeners).toHaveLength(0);
  });

  it("states the durability difference and keeps the reason to one bounded line", () => {
    const text = formatSqliteFallbackNotice(new Error(`${"x".repeat(400)}\nsecond line`));
    expect(text).toMatch(/crash or kill/);
    expect(text).toMatch(/overwrite each other's changes/);
    expect(text).not.toContain("second line");
    const reasonLine = text.split("\n").find((l) => l.includes("Reason:"))!;
    expect(reasonLine.length).toBeLessThan(180);
  });
});
