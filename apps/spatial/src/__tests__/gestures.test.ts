import { describe, it, expect, vi, beforeEach } from "vitest";
import { GestureRecognizer, type GestureEvent } from "../gestures";

// ---------------------------------------------------------------------------
// Mock XR infrastructure
// ---------------------------------------------------------------------------

/**
 * Joint positions needed by GestureRecognizer.resolveJoints().
 * Maps W3C XRHandJoint names to 3D positions.
 */
interface MockJointPositions {
  wrist: [number, number, number];
  "thumb-tip": [number, number, number];
  "index-finger-tip": [number, number, number];
  "middle-finger-tip": [number, number, number];
  "ring-finger-tip": [number, number, number];
  "index-finger-metacarpal": [number, number, number];
  "middle-finger-metacarpal": [number, number, number];
  "ring-finger-metacarpal": [number, number, number];
}

/**
 * A relaxed open hand — no gesture triggered.
 * Palm faces forward (+Z): cross(indexMcp-wrist, ringMcp-wrist) = [0, 0, +Z].
 * Fingers point upward (+Y). Tips farther from wrist than MCPs (no beckon).
 */
function openHandPositions(): MockJointPositions {
  return {
    wrist: [0, 0, 0],
    "thumb-tip": [0.06, 0.04, 0.01],
    "index-finger-tip": [0.04, 0.12, 0],
    "middle-finger-tip": [0, 0.13, 0],
    "ring-finger-tip": [-0.03, 0.12, 0],
    "index-finger-metacarpal": [0.04, 0.06, 0],
    "middle-finger-metacarpal": [0, 0.06, 0],
    "ring-finger-metacarpal": [-0.03, 0.06, 0],
  };
}

/**
 * Build mock XRHand, XRFrame, and XRReferenceSpace from joint positions.
 */
function createMockXRData(positions: MockJointPositions) {
  // Create unique joint space objects keyed by name
  const jointSpaces = new Map<string, { _name: string }>();
  for (const name of Object.keys(positions)) {
    jointSpaces.set(name, { _name: name });
  }

  const hand = {
    get: (name: string) => jointSpaces.get(name) ?? null,
  } as unknown as XRHand;

  const referenceSpace = {} as XRReferenceSpace;

  const frame = {
    getJointPose: (jointSpace: { _name?: string }) => {
      if (jointSpace?._name == null || jointSpace._name === "") return null;
      const pos = positions[jointSpace._name as keyof MockJointPositions];
      if (pos == null) return null;
      return {
        transform: {
          position: { x: pos[0], y: pos[1], z: pos[2] },
        },
      };
    },
  } as unknown as XRFrame;

  return { hand, referenceSpace, frame };
}

// ---------------------------------------------------------------------------
// Construction & setup
// ---------------------------------------------------------------------------

describe("GestureRecognizer construction", () => {
  it("constructs with no arguments", () => {
    const gr = new GestureRecognizer();
    expect(gr).toBeDefined();
  });

  it("constructs with callbacks", () => {
    const onGesture = vi.fn();
    const gr = new GestureRecognizer({ onGesture });
    expect(gr).toBeDefined();
  });

  it("setCallbacks updates the gesture handler", () => {
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (time += 1000));

    const gr = new GestureRecognizer();
    const fn = vi.fn();
    gr.setCallbacks({ onGesture: fn });

    // Trigger a pinch to verify callback is wired
    const positions = openHandPositions();
    positions["thumb-tip"] = [0.04, 0.12, 0]; // Same as index tip → pinch
    positions["index-finger-tip"] = [0.04, 0.12, 0];

    const { hand, referenceSpace, frame } = createMockXRData(positions);
    gr.update(hand, "right", referenceSpace, frame);
    expect(fn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe("GestureRecognizer reset", () => {
  it("clears debounce timers and velocity tracking", () => {
    let time = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => time);

    const events: GestureEvent[] = [];
    const gr = new GestureRecognizer({
      onGesture: (e) => events.push(e),
    });

    // Trigger a pinch
    const positions = openHandPositions();
    positions["thumb-tip"] = [0.04, 0.12, 0];
    positions["index-finger-tip"] = [0.04, 0.12, 0];
    const { hand, referenceSpace, frame } = createMockXRData(positions);

    gr.update(hand, "right", referenceSpace, frame);
    expect(events.filter((e) => e.type === "pinch")).toHaveLength(1);

    // 100ms later — debounced (1100 - 1000 = 100 < 500)
    time = 1100;
    gr.update(hand, "right", referenceSpace, frame);
    expect(events.filter((e) => e.type === "pinch")).toHaveLength(1);

    // Reset clears debounce
    gr.reset();

    // Same time but debounce state cleared — fires again
    gr.update(hand, "right", referenceSpace, frame);
    expect(events.filter((e) => e.type === "pinch")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Pinch detection
// ---------------------------------------------------------------------------

describe("GestureRecognizer pinch", () => {
  let events: GestureEvent[];
  let gr: GestureRecognizer;

  beforeEach(() => {
    events = [];
    // Mock performance.now to control debounce
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (time += 1000));
    gr = new GestureRecognizer({ onGesture: (e) => events.push(e) });
  });

  it("detects pinch when thumb and index tips are < 0.02m apart", () => {
    const positions = openHandPositions();
    // Place thumb tip very close to index tip (0.005m apart in Y)
    positions["thumb-tip"] = [0.04, 0.115, 0];
    positions["index-finger-tip"] = [0.04, 0.12, 0];

    const { hand, referenceSpace, frame } = createMockXRData(positions);
    gr.update(hand, "right", referenceSpace, frame);

    const pinches = events.filter((e) => e.type === "pinch");
    expect(pinches).toHaveLength(1);
    expect(pinches[0]!.hand).toBe("right");
    expect(pinches[0]!.confidence).toBeGreaterThan(0);
    expect(pinches[0]!.confidence).toBeLessThanOrEqual(1);
  });

  it("does not detect pinch when distance >= 0.02m", () => {
    const positions = openHandPositions();
    // Thumb and index far apart (default open hand)
    const { hand, referenceSpace, frame } = createMockXRData(positions);
    gr.update(hand, "right", referenceSpace, frame);

    const pinches = events.filter((e) => e.type === "pinch");
    expect(pinches).toHaveLength(0);
  });

  it("confidence increases as distance decreases", () => {
    // First pinch: 0.015m apart
    const pos1 = openHandPositions();
    pos1["thumb-tip"] = [0.04, 0.105, 0];
    pos1["index-finger-tip"] = [0.04, 0.12, 0];
    const xr1 = createMockXRData(pos1);
    gr.update(xr1.hand, "right", xr1.referenceSpace, xr1.frame);

    const conf1 = events.filter((e) => e.type === "pinch")[0]!.confidence;

    // Second pinch: 0.005m apart (closer)
    const pos2 = openHandPositions();
    pos2["thumb-tip"] = [0.04, 0.115, 0];
    pos2["index-finger-tip"] = [0.04, 0.12, 0];
    const xr2 = createMockXRData(pos2);
    gr.update(xr2.hand, "right", xr2.referenceSpace, xr2.frame);

    const allPinches = events.filter((e) => e.type === "pinch");
    expect(allPinches[1]!.confidence).toBeGreaterThan(conf1);
  });
});

// ---------------------------------------------------------------------------
// Beckon detection (finger curl)
// ---------------------------------------------------------------------------

describe("GestureRecognizer beckon", () => {
  let events: GestureEvent[];
  let gr: GestureRecognizer;

  beforeEach(() => {
    events = [];
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (time += 1000));
    gr = new GestureRecognizer({ onGesture: (e) => events.push(e) });
  });

  it("detects beckon when fingers are curled (tips close to wrist)", () => {
    const positions = openHandPositions();
    // MCPs at normal distance from wrist, tips curled close to wrist
    // curl = 1 - tipDist/mcpDist
    // With tipDist ≈ 0.014, mcpDist ≈ 0.072 → curl ≈ 0.81

    // Curled tips very close to wrist
    positions["index-finger-tip"] = [0.01, 0.01, 0]; // dist ≈ 0.014
    positions["middle-finger-tip"] = [0, 0.01, 0]; // dist = 0.01
    positions["ring-finger-tip"] = [-0.01, 0.01, 0]; // dist ≈ 0.014

    const { hand, referenceSpace, frame } = createMockXRData(positions);
    gr.update(hand, "left", referenceSpace, frame);

    const beckons = events.filter((e) => e.type === "beckon");
    expect(beckons).toHaveLength(1);
    expect(beckons[0]!.hand).toBe("left");
    expect(beckons[0]!.confidence).toBeGreaterThan(0.6);
  });

  it("does not detect beckon when fingers are straight", () => {
    const positions = openHandPositions();
    // Default: tips far from wrist, MCPs closer → curl < 0.6
    const { hand, referenceSpace, frame } = createMockXRData(positions);
    gr.update(hand, "right", referenceSpace, frame);

    const beckons = events.filter((e) => e.type === "beckon");
    expect(beckons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dismiss detection (palm push velocity)
// ---------------------------------------------------------------------------

describe("GestureRecognizer dismiss", () => {
  let events: GestureEvent[];
  let gr: GestureRecognizer;

  beforeEach(() => {
    events = [];
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (time += 1000));
    gr = new GestureRecognizer({ onGesture: (e) => events.push(e) });
  });

  it("does not detect dismiss on first frame (no velocity)", () => {
    const positions = openHandPositions();
    const { hand, referenceSpace, frame } = createMockXRData(positions);
    gr.update(hand, "right", referenceSpace, frame);

    const dismisses = events.filter((e) => e.type === "dismiss");
    expect(dismisses).toHaveLength(0);
  });

  it("detects dismiss when palm pushes fast in palm-normal direction", () => {
    // Set up palm normal to point in +Z direction:
    // v1 = indexMcp - wrist, v2 = ringMcp - wrist
    // cross(v1, v2) should be +Z
    // v1 = [0.1, 0, 0], v2 = [0, 0.1, 0] → cross = [0, 0, 0.01] → +Z

    // Frame 1: wrist at origin
    const pos1 = openHandPositions();
    pos1.wrist = [0, 0, 0];
    pos1["index-finger-metacarpal"] = [0.1, 0, 0];
    pos1["ring-finger-metacarpal"] = [0, 0.1, 0];
    // Keep other joints consistent
    pos1["middle-finger-metacarpal"] = [0.05, 0.05, 0];

    const xr1 = createMockXRData(pos1);
    gr.update(xr1.hand, "right", xr1.referenceSpace, xr1.frame);

    // Frame 2: wrist moved 0.01m in +Z (velocity = 0.6 m/s at 60 FPS)
    const pos2 = openHandPositions();
    pos2.wrist = [0, 0, 0.01];
    pos2["index-finger-metacarpal"] = [0.1, 0, 0.01];
    pos2["ring-finger-metacarpal"] = [0, 0.1, 0.01];
    pos2["middle-finger-metacarpal"] = [0.05, 0.05, 0.01];

    const xr2 = createMockXRData(pos2);
    gr.update(xr2.hand, "right", xr2.referenceSpace, xr2.frame);

    const dismisses = events.filter((e) => e.type === "dismiss");
    expect(dismisses).toHaveLength(1);
    expect(dismisses[0]!.hand).toBe("right");
  });

  it("does not detect dismiss when palm moves slowly", () => {
    const pos1 = openHandPositions();
    pos1.wrist = [0, 0, 0];
    pos1["index-finger-metacarpal"] = [0.1, 0, 0];
    pos1["ring-finger-metacarpal"] = [0, 0.1, 0];
    pos1["middle-finger-metacarpal"] = [0.05, 0.05, 0];

    const xr1 = createMockXRData(pos1);
    gr.update(xr1.hand, "right", xr1.referenceSpace, xr1.frame);

    // Tiny movement: 0.001m → velocity = 0.06 m/s (< 0.3 threshold)
    const pos2 = openHandPositions();
    pos2.wrist = [0, 0, 0.001];
    pos2["index-finger-metacarpal"] = [0.1, 0, 0.001];
    pos2["ring-finger-metacarpal"] = [0, 0.1, 0.001];
    pos2["middle-finger-metacarpal"] = [0.05, 0.05, 0.001];

    const xr2 = createMockXRData(pos2);
    gr.update(xr2.hand, "right", xr2.referenceSpace, xr2.frame);

    const dismisses = events.filter((e) => e.type === "dismiss");
    expect(dismisses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pause detection (palm-up + still)
// ---------------------------------------------------------------------------

describe("GestureRecognizer pause", () => {
  let events: GestureEvent[];
  let gr: GestureRecognizer;

  beforeEach(() => {
    events = [];
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (time += 1000));
    gr = new GestureRecognizer({ onGesture: (e) => events.push(e) });
  });

  it("detects pause when palm faces up and hand is still", () => {
    // Palm normal pointing up (+Y):
    // v1 = indexMcp - wrist = [0, 0, 0.1]
    // v2 = ringMcp - wrist = [0.1, 0, 0]
    // cross = [0*0 - 0.1*0, 0.1*0.1 - 0*0, 0*0 - 0*0.1] = [0, 0.01, 0] → +Y
    const positions = openHandPositions();
    positions.wrist = [0, 0.5, 0];
    positions["index-finger-metacarpal"] = [0, 0.5, 0.1];
    positions["ring-finger-metacarpal"] = [0.1, 0.5, 0];
    positions["middle-finger-metacarpal"] = [0.05, 0.5, 0.05];
    // Tips don't affect pause detection but must exist
    positions["thumb-tip"] = [0.03, 0.53, -0.02];
    positions["index-finger-tip"] = [0, 0.5, 0.15];
    positions["middle-finger-tip"] = [0.05, 0.5, 0.15];
    positions["ring-finger-tip"] = [0.1, 0.5, 0.1];

    // Need two frames so velocity tracking considers the hand "still"
    const xr1 = createMockXRData(positions);
    gr.update(xr1.hand, "left", xr1.referenceSpace, xr1.frame);

    // Second frame — same position (still)
    const xr2 = createMockXRData(positions);
    gr.update(xr2.hand, "left", xr2.referenceSpace, xr2.frame);

    const pauses = events.filter((e) => e.type === "pause");
    expect(pauses.length).toBeGreaterThanOrEqual(1);
    expect(pauses[0]!.hand).toBe("left");
    expect(pauses[0]!.confidence).toBeGreaterThan(0.7);
  });

  it("does not detect pause when palm faces forward (not up)", () => {
    // Palm normal pointing in +Z (not up):
    // v1 = [0.1, 0, 0], v2 = [0, 0.1, 0] → cross = [0, 0, 0.01] → +Z
    const positions = openHandPositions();
    positions.wrist = [0, 0.5, 0];
    positions["index-finger-metacarpal"] = [0.1, 0.5, 0];
    positions["ring-finger-metacarpal"] = [0, 0.6, 0];
    positions["middle-finger-metacarpal"] = [0.05, 0.55, 0];

    // Two frames to establish velocity (still)
    const xr1 = createMockXRData(positions);
    gr.update(xr1.hand, "right", xr1.referenceSpace, xr1.frame);

    const xr2 = createMockXRData(positions);
    gr.update(xr2.hand, "right", xr2.referenceSpace, xr2.frame);

    const pauses = events.filter((e) => e.type === "pause");
    expect(pauses).toHaveLength(0);
  });

  it("does not detect pause when palm faces up but hand is moving", () => {
    // Frame 0: palm faces forward (not up), establishes prevPalmPos
    const pos0 = openHandPositions();
    pos0.wrist = [0, 0.5, 0];
    const xr0 = createMockXRData(pos0);
    gr.update(xr0.hand, "right", xr0.referenceSpace, xr0.frame);

    // Frame 1: palm faces forward, small move — establishes velocity baseline
    const pos1 = openHandPositions();
    pos1.wrist = [0, 0.5, 0];
    const xr1 = createMockXRData(pos1);
    gr.update(xr1.hand, "right", xr1.referenceSpace, xr1.frame);

    // Clear events from setup frames
    events.length = 0;

    // Frame 2: palm up + fast movement (0.01m → vel = 0.6 m/s → not still)
    const pos2 = openHandPositions();
    pos2.wrist = [0, 0.51, 0];
    pos2["index-finger-metacarpal"] = [0, 0.51, 0.1];
    pos2["ring-finger-metacarpal"] = [0.1, 0.51, 0];
    pos2["middle-finger-metacarpal"] = [0.05, 0.51, 0.05];
    pos2["thumb-tip"] = [0.03, 0.54, 0.01];
    pos2["index-finger-tip"] = [0, 0.51, 0.15];
    pos2["middle-finger-tip"] = [0.05, 0.51, 0.15];
    pos2["ring-finger-tip"] = [0.1, 0.51, 0.1];

    const xr2 = createMockXRData(pos2);
    gr.update(xr2.hand, "right", xr2.referenceSpace, xr2.frame);

    const pauses = events.filter((e) => e.type === "pause");
    expect(pauses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

describe("GestureRecognizer debounce", () => {
  it("suppresses repeated gestures within 500ms", () => {
    const events: GestureEvent[] = [];
    let time = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => time);

    const gr = new GestureRecognizer({ onGesture: (e) => events.push(e) });

    const positions = openHandPositions();
    positions["thumb-tip"] = [0.04, 0.12, 0];
    positions["index-finger-tip"] = [0.04, 0.12, 0];
    const { hand, referenceSpace, frame } = createMockXRData(positions);

    // First call fires (time=1000, last=0 → delta=1000 > 500)
    gr.update(hand, "right", referenceSpace, frame);
    expect(events.filter((e) => e.type === "pinch")).toHaveLength(1);

    // 200ms later — debounced (time=1200, last=1000 → delta=200 < 500)
    time = 1200;
    gr.update(hand, "right", referenceSpace, frame);
    expect(events.filter((e) => e.type === "pinch")).toHaveLength(1);

    // 600ms after first — fires again (time=1600, last=1000 → delta=600 > 500)
    time = 1600;
    gr.update(hand, "right", referenceSpace, frame);
    expect(events.filter((e) => e.type === "pinch")).toHaveLength(2);
  });

  it("debounces per hand independently", () => {
    const events: GestureEvent[] = [];
    let time = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => time);

    const gr = new GestureRecognizer({ onGesture: (e) => events.push(e) });

    const positions = openHandPositions();
    positions["thumb-tip"] = [0.04, 0.12, 0];
    positions["index-finger-tip"] = [0.04, 0.12, 0];
    const { hand, referenceSpace, frame } = createMockXRData(positions);

    // Right hand fires
    gr.update(hand, "right", referenceSpace, frame);
    const rightPinches = events.filter((e) => e.type === "pinch" && e.hand === "right");
    expect(rightPinches).toHaveLength(1);

    // Left hand also fires (different debounce key)
    time = 1100;
    gr.update(hand, "left", referenceSpace, frame);
    const leftPinches = events.filter((e) => e.type === "pinch" && e.hand === "left");
    expect(leftPinches).toHaveLength(1);

    // Right hand is still debounced (time=1200, last=1000 → delta=200 < 500)
    time = 1200;
    gr.update(hand, "right", referenceSpace, frame);
    expect(events.filter((e) => e.type === "pinch" && e.hand === "right")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Missing joints / no getJointPose
// ---------------------------------------------------------------------------

describe("GestureRecognizer missing joints", () => {
  it("no-ops when getJointPose is undefined", () => {
    const events: GestureEvent[] = [];
    const gr = new GestureRecognizer({ onGesture: (e) => events.push(e) });

    const hand = {
      get: () => ({ _name: "wrist" }),
    } as unknown as XRHand;

    const frame = {} as unknown as XRFrame; // No getJointPose
    const referenceSpace = {} as XRReferenceSpace;

    // Should not throw
    gr.update(hand, "right", referenceSpace, frame);
    expect(events).toHaveLength(0);
  });

  it("no-ops when a required joint is missing", () => {
    const events: GestureEvent[] = [];
    const gr = new GestureRecognizer({ onGesture: (e) => events.push(e) });

    const positions = openHandPositions();
    const { hand: fullHand, referenceSpace, frame } = createMockXRData(positions);

    // Override hand.get to return null for one required joint
    const brokenHand = {
      get: (name: string) => {
        if (name === "thumb-tip") return null;
        return fullHand.get(name as XRHandJoint);
      },
    } as unknown as XRHand;

    gr.update(brokenHand, "right", referenceSpace, frame);
    expect(events).toHaveLength(0);
  });

  it("no-ops when getJointPose returns null for a joint", () => {
    const events: GestureEvent[] = [];
    const gr = new GestureRecognizer({ onGesture: (e) => events.push(e) });

    const positions = openHandPositions();
    const jointSpaces = new Map<string, { _name: string }>();
    for (const name of Object.keys(positions)) {
      jointSpaces.set(name, { _name: name });
    }

    const hand = {
      get: (name: string) => jointSpaces.get(name) ?? null,
    } as unknown as XRHand;

    const frame = {
      getJointPose: (jointSpace: { _name?: string }) => {
        // Return null for middle-finger-tip
        if (jointSpace._name === "middle-finger-tip") return null;
        const pos = positions[jointSpace._name as keyof MockJointPositions];
        if (pos == null) return null;
        return {
          transform: {
            position: { x: pos[0], y: pos[1], z: pos[2] },
          },
        };
      },
    } as unknown as XRFrame;

    const referenceSpace = {} as XRReferenceSpace;

    gr.update(hand, "right", referenceSpace, frame);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// No callbacks — no crash
// ---------------------------------------------------------------------------

describe("GestureRecognizer without callbacks", () => {
  it("does not crash when no onGesture callback is set", () => {
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (time += 1000));

    const gr = new GestureRecognizer(); // No callbacks

    const positions = openHandPositions();
    positions["thumb-tip"] = [0.04, 0.12, 0];
    positions["index-finger-tip"] = [0.04, 0.12, 0];
    const { hand, referenceSpace, frame } = createMockXRData(positions);

    // Should not throw
    expect(() => gr.update(hand, "right", referenceSpace, frame)).not.toThrow();
  });
});
