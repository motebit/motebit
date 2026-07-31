import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  isNewerVersion,
  readUpdateState,
  renderUpdateNudge,
  refreshUpdateCheckInBackground,
} from "../update-nudge.js";

function tmpStatePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nudge-")), "update-check.json");
}

async function settle(): Promise<void> {
  // The refresh is fire-and-forget; give its microtasks a beat.
  await new Promise((r) => setTimeout(r, 10));
}

describe("isNewerVersion — fails to silence, never to noise", () => {
  it("compares numeric triples", () => {
    expect(isNewerVersion("1.11.2", "1.11.1")).toBe(true);
    expect(isNewerVersion("1.11.1", "1.11.1")).toBe(false);
    expect(isNewerVersion("1.11.1", "1.11.2")).toBe(false);
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerVersion("1.12.0", "1.11.9")).toBe(true);
  });

  it("malformed or prerelease versions are silent", () => {
    expect(isNewerVersion("1.12.0-beta.1", "1.11.1")).toBe(false);
    expect(isNewerVersion("garbage", "1.11.1")).toBe(false);
    expect(isNewerVersion("1.12", "1.11.1")).toBe(false);
    expect(isNewerVersion("1.12.0", "unknown")).toBe(false);
  });
});

describe("renderUpdateNudge", () => {
  it("nudges only when the cache knows a newer version", () => {
    expect(
      renderUpdateNudge({
        currentVersion: "1.11.1",
        state: { last_checked_at: 1, latest: "1.11.2" },
      }),
    ).toBe("motebit 1.11.2 available — npm i -g motebit");
    expect(
      renderUpdateNudge({
        currentVersion: "1.11.2",
        state: { last_checked_at: 1, latest: "1.11.2" },
      }),
    ).toBeNull();
    expect(renderUpdateNudge({ currentVersion: "1.11.1", state: null })).toBeNull();
    expect(
      renderUpdateNudge({ currentVersion: "1.11.1", state: { last_checked_at: 1 } }),
    ).toBeNull();
  });
});

describe("refreshUpdateCheckInBackground", () => {
  it("writes the cache from the registry response", async () => {
    const statePath = tmpStatePath();
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "1.11.2" }),
    } as unknown as Response);

    refreshUpdateCheckInBackground({ statePath, nowMs: 1000, fetchFn });
    await settle();

    expect(readUpdateState(statePath)).toEqual({ last_checked_at: 1000, latest: "1.11.2" });
    expect(String(fetchFn.mock.calls[0]![0])).toContain("registry.npmjs.org/motebit/latest");
  });

  it("a fresh cache skips the network entirely", async () => {
    const statePath = tmpStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ last_checked_at: 1000, latest: "1.11.2" }));
    const fetchFn = vi.fn();

    refreshUpdateCheckInBackground({ statePath, nowMs: 2000, ttlMs: 10_000, fetchFn });
    await settle();

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a stale cache refreshes", async () => {
    const statePath = tmpStatePath();
    fs.writeFileSync(statePath, JSON.stringify({ last_checked_at: 1000, latest: "1.11.1" }));
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "1.11.3" }),
    } as unknown as Response);

    refreshUpdateCheckInBackground({ statePath, nowMs: 999_999_999, fetchFn });
    await settle();

    expect(readUpdateState(statePath)?.latest).toBe("1.11.3");
  });

  it("offline / error paths write nothing and stay silent (retry next launch)", async () => {
    const statePath = tmpStatePath();
    const rejecting = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    refreshUpdateCheckInBackground({ statePath, nowMs: 1000, fetchFn: rejecting });
    await settle();
    expect(readUpdateState(statePath)).toBeNull();

    const badStatus = vi.fn().mockResolvedValue({ ok: false } as unknown as Response);
    refreshUpdateCheckInBackground({ statePath, nowMs: 1000, fetchFn: badStatus });
    await settle();
    expect(readUpdateState(statePath)).toBeNull();

    const badBody = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nope: true }),
    } as unknown as Response);
    refreshUpdateCheckInBackground({ statePath, nowMs: 1000, fetchFn: badBody });
    await settle();
    expect(readUpdateState(statePath)).toBeNull();
  });

  it("a corrupt cache file reads as null and refresh recovers it", async () => {
    const statePath = tmpStatePath();
    fs.writeFileSync(statePath, "not json{");
    expect(readUpdateState(statePath)).toBeNull();
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "1.11.2" }),
    } as unknown as Response);
    refreshUpdateCheckInBackground({ statePath, nowMs: 5000, fetchFn });
    await settle();
    expect(readUpdateState(statePath)?.latest).toBe("1.11.2");
  });
});
