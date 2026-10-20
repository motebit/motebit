import { describe, it, expect, vi, afterEach } from "vitest";

// Toggle whether `require("better-sqlite3")` resolves, the way a missing
// optional dependency (no prebuild, no compiler) looks at runtime.
const nativeMissing = vi.hoisted(() => ({ value: false }));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const real = actual.createRequire(url);
      return Object.assign((id: string) => {
        if (id === "better-sqlite3" && nativeMissing.value) {
          throw new Error("Cannot find module 'better-sqlite3'");
        }
        return real(id) as unknown;
      }, real);
    },
  };
});

import { openMotebitDatabase, onDriverFallback, type DriverFallbackEvent } from "../index.js";

describe("openMotebitDatabase driver fallback notification", () => {
  const unsubscribes: Array<() => void> = [];
  afterEach(() => {
    nativeMissing.value = false;
    for (const off of unsubscribes.splice(0)) off();
  });

  it("opens on sql.js and notifies listeners with the native error when better-sqlite3 is missing", async () => {
    nativeMissing.value = true;
    const events: DriverFallbackEvent[] = [];
    unsubscribes.push(onDriverFallback((e) => events.push(e)));

    const db = await openMotebitDatabase(":memory:");
    expect(db.db.driverName).toBe("sql.js");
    db.close();

    expect(events).toHaveLength(1);
    expect((events[0]!.cause as Error).message).toContain("better-sqlite3");
  });

  it("does not notify when the native driver loads", async () => {
    const listener = vi.fn();
    unsubscribes.push(onDriverFallback(listener));

    const db = await openMotebitDatabase(":memory:");
    expect(db.db.driverName).toBe("better-sqlite3");
    db.close();

    expect(listener).not.toHaveBeenCalled();
  });

  it("a throwing listener never fails the open, and unsubscribe stops delivery", async () => {
    nativeMissing.value = true;
    unsubscribes.push(
      onDriverFallback(() => {
        throw new Error("listener bug");
      }),
    );
    const later = vi.fn();
    const off = onDriverFallback(later);
    off();

    const db = await openMotebitDatabase(":memory:");
    expect(db.db.driverName).toBe("sql.js");
    db.close();
    expect(later).not.toHaveBeenCalled();
  });
});
