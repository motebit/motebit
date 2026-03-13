import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  trustToDistance,
  idToHue,
  REMOTE_MIN_DISTANCE,
  REMOTE_MAX_DISTANCE,
  ThreeJSAdapter,
  type RemoteCreatureActivity,
} from "@motebit/render-engine";
import { SpatialApp } from "../spatial-app";

// ---------------------------------------------------------------------------
// Pure logic: trustToDistance
// ---------------------------------------------------------------------------

describe("trustToDistance", () => {
  it("trust 0.0 → REMOTE_MAX_DISTANCE", () => {
    expect(trustToDistance(0.0)).toBeCloseTo(REMOTE_MAX_DISTANCE, 10);
  });

  it("trust 1.0 → REMOTE_MIN_DISTANCE", () => {
    expect(trustToDistance(1.0)).toBeCloseTo(REMOTE_MIN_DISTANCE, 10);
  });

  it("trust 0.5 → midpoint", () => {
    const mid = (REMOTE_MAX_DISTANCE + REMOTE_MIN_DISTANCE) / 2;
    expect(trustToDistance(0.5)).toBeCloseTo(mid, 5);
  });

  it("result never below REMOTE_MIN_DISTANCE", () => {
    // Values clamped: over-trust still gives min distance
    expect(trustToDistance(1.0)).toBeGreaterThanOrEqual(REMOTE_MIN_DISTANCE);
    expect(trustToDistance(2.0)).toBeGreaterThanOrEqual(REMOTE_MIN_DISTANCE);
  });

  it("result never above REMOTE_MAX_DISTANCE", () => {
    expect(trustToDistance(0.0)).toBeLessThanOrEqual(REMOTE_MAX_DISTANCE);
    expect(trustToDistance(-1.0)).toBeLessThanOrEqual(REMOTE_MAX_DISTANCE);
  });

  it("monotonically decreasing — higher trust = closer", () => {
    expect(trustToDistance(0.25)).toBeGreaterThan(trustToDistance(0.75));
    expect(trustToDistance(0.0)).toBeGreaterThan(trustToDistance(0.5));
  });
});

// ---------------------------------------------------------------------------
// Pure logic: idToHue
// ---------------------------------------------------------------------------

describe("idToHue", () => {
  it("returns a value in [0, 360)", () => {
    const ids = ["abc", "00000000-0000-0000-0000-000000000000", "agent-alpha", "", "zzz"];
    for (const id of ids) {
      const hue = idToHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("is deterministic — same input always gives same output", () => {
    const id = "motebit-test-id-12345";
    expect(idToHue(id)).toBe(idToHue(id));
    expect(idToHue(id)).toBe(idToHue(id)); // call three times
  });

  it("different IDs produce different hues (distribution test)", () => {
    const uuids = [
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "b2c3d4e5-f6a7-8901-bcde-f01234567891",
      "c3d4e5f6-a7b8-9012-cdef-012345678902",
      "d4e5f6a7-b8c9-0123-defa-123456789013",
      "e5f6a7b8-c9d0-1234-efab-234567890124",
      "f6a7b8c9-d0e1-2345-fabc-345678901235",
      "07b8c9d0-e1f2-3456-abcd-456789012346",
      "18c9d0e1-f2a3-4567-bcde-567890123457",
      "29d0e1f2-a3b4-5678-cdef-678901234568",
      "3ae1f2a3-b4c5-6789-defa-789012345679",
    ];

    const hues = uuids.map(idToHue);
    const uniqueHues = new Set(hues);
    // All 10 should be distinct
    expect(uniqueHues.size).toBe(10);
  });

  it("handles empty string without throwing", () => {
    expect(() => idToHue("")).not.toThrow();
  });

  it("handles very long IDs", () => {
    const long = "x".repeat(1000);
    expect(() => idToHue(long)).not.toThrow();
    const hue = idToHue(long);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });
});

// ---------------------------------------------------------------------------
// ThreeJSAdapter (headless) — multi-creature state management
// ---------------------------------------------------------------------------

describe("ThreeJSAdapter multi-creature (headless)", () => {
  let adapter: ThreeJSAdapter;

  beforeEach(async () => {
    adapter = new ThreeJSAdapter();
    await adapter.init(null); // headless — no WebGL
  });

  it("addRemoteCreature tracks the creature by ID", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.8 });
    expect(adapter.getRemoteCreatures().has("agent-1")).toBe(true);
  });

  it("addRemoteCreature is idempotent — duplicate ID is ignored", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.8 });
    adapter.addRemoteCreature("agent-1", { trustScore: 0.5 }); // second call ignored
    expect(adapter.getRemoteCreatures().size).toBe(1);
  });

  it("addRemoteCreature stores the trust score", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.7 });
    const state = adapter.getRemoteCreatures().get("agent-1");
    expect(state).toBeDefined();
    expect(state!.trustScore).toBe(0.7);
  });

  it("addRemoteCreature derives hue from ID when not provided", () => {
    const id = "agent-hue-test";
    adapter.addRemoteCreature(id, { trustScore: 0.5 });
    const state = adapter.getRemoteCreatures().get(id);
    expect(state).toBeDefined();
    expect(state!.hue).toBe(idToHue(id));
  });

  it("addRemoteCreature uses explicit hue when provided", () => {
    adapter.addRemoteCreature("agent-explicit-hue", { trustScore: 0.5, hue: 180 });
    const state = adapter.getRemoteCreatures().get("agent-explicit-hue");
    expect(state!.hue).toBe(180);
  });

  it("addRemoteCreature sets initial activity to idle", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.5 });
    const state = adapter.getRemoteCreatures().get("agent-1");
    expect(state!.activity).toBe("idle");
  });

  it("removeRemoteCreature removes the creature from tracking", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.8 });
    adapter.removeRemoteCreature("agent-1");
    expect(adapter.getRemoteCreatures().has("agent-1")).toBe(false);
  });

  it("removeRemoteCreature is safe for unknown ID", () => {
    expect(() => adapter.removeRemoteCreature("nonexistent")).not.toThrow();
  });

  it("updateRemoteCreature changes trust score", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.2 });
    adapter.updateRemoteCreature("agent-1", { trustScore: 0.9 });
    const state = adapter.getRemoteCreatures().get("agent-1");
    expect(state!.trustScore).toBe(0.9);
  });

  it("updateRemoteCreature is safe for unknown ID", () => {
    expect(() => adapter.updateRemoteCreature("nonexistent", { trustScore: 0.5 })).not.toThrow();
  });

  it("setRemoteCreatureActivity changes the activity", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.5 });

    const activities: RemoteCreatureActivity[] = ["processing", "delegating", "completed", "idle"];
    for (const activity of activities) {
      adapter.setRemoteCreatureActivity("agent-1", activity);
      const state = adapter.getRemoteCreatures().get("agent-1");
      expect(state!.activity).toBe(activity);
    }
  });

  it("setRemoteCreatureActivity is safe for unknown ID", () => {
    expect(() => adapter.setRemoteCreatureActivity("nonexistent", "processing")).not.toThrow();
  });

  it("addDelegationLine tracks the line", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.5 });
    const lineId = adapter.addDelegationLine("self", "agent-1");
    expect(adapter.getDelegationLines().has(lineId)).toBe(true);
  });

  it("addDelegationLine stores from/to IDs", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.5 });
    adapter.addRemoteCreature("agent-2", { trustScore: 0.7 });
    const lineId = adapter.addDelegationLine("agent-1", "agent-2");
    const state = adapter.getDelegationLines().get(lineId);
    expect(state).toBeDefined();
    expect(state!.fromId).toBe("agent-1");
    expect(state!.toId).toBe("agent-2");
  });

  it("addDelegationLine returns unique IDs for multiple lines", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.5 });
    adapter.addRemoteCreature("agent-2", { trustScore: 0.7 });
    const id1 = adapter.addDelegationLine("self", "agent-1");
    const id2 = adapter.addDelegationLine("self", "agent-2");
    expect(id1).not.toBe(id2);
  });

  it("removeDelegationLine removes the line from tracking", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.5 });
    const lineId = adapter.addDelegationLine("self", "agent-1");
    adapter.removeDelegationLine(lineId);
    expect(adapter.getDelegationLines().has(lineId)).toBe(false);
  });

  it("removeDelegationLine is safe for unknown ID", () => {
    expect(() => adapter.removeDelegationLine("nonexistent-line")).not.toThrow();
  });

  it("removeRemoteCreature also removes delegation lines that reference it", () => {
    adapter.addRemoteCreature("agent-1", { trustScore: 0.5 });
    const lineId = adapter.addDelegationLine("self", "agent-1");
    adapter.removeRemoteCreature("agent-1");
    expect(adapter.getDelegationLines().has(lineId)).toBe(false);
  });

  it("multiple creatures — add 5, remove 2, verify remaining", () => {
    for (let i = 0; i < 5; i++) {
      adapter.addRemoteCreature(`agent-${i}`, { trustScore: i * 0.2 });
    }
    expect(adapter.getRemoteCreatures().size).toBe(5);

    adapter.removeRemoteCreature("agent-1");
    adapter.removeRemoteCreature("agent-3");

    expect(adapter.getRemoteCreatures().size).toBe(3);
    expect(adapter.getRemoteCreatures().has("agent-0")).toBe(true);
    expect(adapter.getRemoteCreatures().has("agent-2")).toBe(true);
    expect(adapter.getRemoteCreatures().has("agent-4")).toBe(true);
    expect(adapter.getRemoteCreatures().has("agent-1")).toBe(false);
    expect(adapter.getRemoteCreatures().has("agent-3")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SpatialApp integration — discovery + delegation visualization
// ---------------------------------------------------------------------------

describe("SpatialApp constellation integration", () => {
  let app: SpatialApp;

  // Mock fetch for discovery
  const mockFetch = vi.fn();

  beforeEach(() => {
    app = new SpatialApp();
    // Spy on adapter methods to verify integration
    vi.spyOn(app.adapter, "addRemoteCreature");
    vi.spyOn(app.adapter, "removeRemoteCreature");
    vi.spyOn(app.adapter, "updateRemoteCreature");
    vi.spyOn(app.adapter, "setRemoteCreatureActivity");
    vi.spyOn(app.adapter, "addDelegationLine");
    vi.spyOn(app.adapter, "removeDelegationLine");
    vi.spyOn(app.adapter, "pulseDelegationLine");
    // Replace global fetch
    vi.stubGlobal("fetch", mockFetch);
  });

  it("SpatialApp exposes the adapter for multi-creature calls", () => {
    expect(app.adapter).toBeDefined();
    expect(typeof app.adapter.addRemoteCreature).toBe("function");
    expect(typeof app.adapter.removeRemoteCreature).toBe("function");
    expect(typeof app.adapter.updateRemoteCreature).toBe("function");
    expect(typeof app.adapter.setRemoteCreatureActivity).toBe("function");
    expect(typeof app.adapter.addDelegationLine).toBe("function");
    expect(typeof app.adapter.removeDelegationLine).toBe("function");
  });

  it("addRemoteCreature is callable via adapter on SpatialApp", () => {
    app.adapter.addRemoteCreature("remote-agent-1", { trustScore: 0.6 });
    expect(app.adapter.addRemoteCreature).toHaveBeenCalledWith("remote-agent-1", {
      trustScore: 0.6,
    });
    expect(app.adapter.getRemoteCreatures().has("remote-agent-1")).toBe(true);
  });

  it("delegation visualization — line add + activity change + cleanup", () => {
    // Simulate delegation start:
    // 1. Creature appears
    app.adapter.addRemoteCreature("delegate-agent", { trustScore: 0.5 });

    // 2. Delegation line added + activity set to 'delegating'
    app.adapter.addDelegationLine("self", "delegate-agent");
    app.adapter.setRemoteCreatureActivity("delegate-agent", "delegating");

    expect(app.adapter.addDelegationLine).toHaveBeenCalledWith("self", "delegate-agent");
    expect(app.adapter.setRemoteCreatureActivity).toHaveBeenCalledWith(
      "delegate-agent",
      "delegating",
    );

    // 3. Receipt received → pulse + completed
    const lineId = [...app.adapter.getDelegationLines().keys()][0]!;
    app.adapter.pulseDelegationLine(lineId);
    app.adapter.setRemoteCreatureActivity("delegate-agent", "completed");

    expect(app.adapter.pulseDelegationLine).toHaveBeenCalledWith(lineId);
    expect(app.adapter.setRemoteCreatureActivity).toHaveBeenCalledWith(
      "delegate-agent",
      "completed",
    );

    // 4. Cleanup — line removed + activity back to idle
    app.adapter.removeDelegationLine(lineId);
    app.adapter.setRemoteCreatureActivity("delegate-agent", "idle");

    expect(app.adapter.removeDelegationLine).toHaveBeenCalledWith(lineId);
    expect(app.adapter.getDelegationLines().has(lineId)).toBe(false);

    const finalState = app.adapter.getRemoteCreatures().get("delegate-agent");
    expect(finalState!.activity).toBe("idle");
  });

  it("trust update propagates to updateRemoteCreature", () => {
    app.adapter.addRemoteCreature("trusted-agent", { trustScore: 0.3 });

    // Simulate receipt verification bumping trust
    app.adapter.updateRemoteCreature("trusted-agent", { trustScore: 0.8 });

    expect(app.adapter.updateRemoteCreature).toHaveBeenCalledWith("trusted-agent", {
      trustScore: 0.8,
    });

    const state = app.adapter.getRemoteCreatures().get("trusted-agent");
    expect(state!.trustScore).toBe(0.8);
  });

  it("dispose cleans up correctly", () => {
    const disposeSpy = vi.spyOn(app.adapter, "dispose");
    app.dispose();
    expect(disposeSpy).toHaveBeenCalled();
  });
});
