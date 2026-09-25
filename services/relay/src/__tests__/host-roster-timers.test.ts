/**
 * The machine roster's liveness over months, on fake timers, through the
 * relay's REAL housekeeping: the five-minute flush and the 90-day TTL sweep
 * wired into the supervised `task-cleanup` loop in `index.ts`
 * (docs/proposals/machine-roster-relay-v1.md D4).
 *
 * - An open, idle host socket (clients send no periodic frames) keeps its
 *   row fresh through the flush, and is never swept.
 * - A closed host's row is swept once it is 90 days old.
 * - A row whose socket is still open and bound, but no longer announces
 *   unattended work, is not refreshed by the flush — and is still never
 *   swept while that socket is open (the sweep's live-skip).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import type { ConnectedDevice } from "../websocket.js";
import { createTestRelay } from "./test-helpers.js";
import { observeHostConnection, readHostLiveness } from "../host-roster-store.js";

const DAY = 24 * 60 * 60 * 1000;
const K1 = "1".repeat(64);

let relay: SyncRelay;
const motebitId = "mote-timers";

function peer(deviceId: string, capabilities: string[]): ConnectedDevice {
  return {
    ws: { readyState: 1, send: () => {}, close: () => {} },
    deviceId,
    deviceIdDeclared: true,
    deviceIdVerified: true,
    boundUnder: K1,
    capabilities,
  } as unknown as ConnectedDevice;
}

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
  });
  relay = await createTestRelay();
});

afterEach(async () => {
  vi.useRealTimers();
  relay.connections.clear();
  await relay.close();
});

describe("liveness housekeeping over 3 × 31 days", () => {
  it("an open idle host stays fresh via the flush and is never swept; a closed host is swept after 90 days; an open non-host row is kept by the live-skip", async () => {
    const t0 = Date.now();
    const db = relay.moteDb.db;
    const rid = relay.relayIdentity.relayMotebitId;

    // Open, idle host: in `connections`, never sends a frame.
    const idle = peer("idle-host", ["unattended_runtime"]);
    // Was a host, still open and bound, now announces no unattended work.
    const demoted = peer("demoted", ["sync"]);
    relay.connections.set(motebitId, [idle, demoted]);
    observeHostConnection(db, motebitId, idle, rid, t0);
    observeHostConnection(db, motebitId, peer("demoted", ["unattended_runtime"]), rid, t0);
    // Closed host: seen once, not in `connections`.
    observeHostConnection(db, motebitId, peer("closed-host", ["unattended_runtime"]), rid, t0);

    for (let month = 1; month <= 3; month++) {
      vi.setSystemTime(t0 + month * 31 * DAY);
      // One task-cleanup tick (60s) past the five-minute flush threshold.
      await vi.advanceTimersByTimeAsync(61_000);
    }

    const now = Date.now();
    const rows = new Map(readHostLiveness(db, motebitId).map((r) => [r.device_id, r]));
    // The flush kept the idle host fresh, and it is still there.
    expect(rows.get("idle-host")?.last_seen_at).toBeGreaterThanOrEqual(now - 2 * 60_000);
    // The live-skip kept the demoted row, un-refreshed (93 days old).
    expect(rows.get("demoted")?.last_seen_at).toBe(t0);
    // The closed host was swept.
    expect(rows.has("closed-host")).toBe(false);
  });
});
