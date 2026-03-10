/**
 * GestureRecognizer — hand gesture detection from WebXR XRHand joints.
 *
 * Recognized gestures:
 * - Pinch (thumb tip ↔ index tip < threshold): bump attention
 * - Beckon (fingers curl inward toward palm): creature drifts closer
 * - Dismiss (palm push away): creature retreats to wider orbit
 * - Pause (palm-up stop): halt all audio processing, enter dormant
 *
 * Emits gesture events consumed by SpatialApp presence state machine.
 */

// === Types ===

export type GestureType = "pinch" | "beckon" | "dismiss" | "pause";

export interface GestureEvent {
  type: GestureType;
  hand: "left" | "right";
  confidence: number;
}

export interface GestureCallbacks {
  onGesture?: (event: GestureEvent) => void;
}

// === Constants ===

const PINCH_THRESHOLD = 0.02; // 2cm thumb-to-index distance
const BECKON_CURL_THRESHOLD = 0.6; // Curl ratio (0=straight, 1=fully curled)
const DISMISS_VELOCITY = 0.3; // m/s palm push velocity
const PAUSE_PALM_UP_DOT = 0.7; // Palm normal · world-up threshold

// Debounce: minimum time between repeated gesture events (ms)
const GESTURE_DEBOUNCE_MS = 500;

// XRHand joint indices (W3C WebXR Hand Input spec)
const THUMB_TIP = 4;
const INDEX_TIP = 9;
const MIDDLE_TIP = 14;
const RING_TIP = 19;
const INDEX_MCP = 5;
const MIDDLE_MCP = 10;
const RING_MCP = 15;
const WRIST = 0;

// === GestureRecognizer ===

export class GestureRecognizer {
  private callbacks: GestureCallbacks;
  private lastGestureTime: Map<string, number> = new Map();

  // Palm velocity tracking (dismiss gesture)
  private prevPalmPos: Map<string, [number, number, number]> = new Map();
  private palmVelocity: Map<string, [number, number, number]> = new Map();

  constructor(callbacks?: GestureCallbacks) {
    this.callbacks = callbacks ?? {};
  }

  setCallbacks(callbacks: Partial<GestureCallbacks>): void {
    if (callbacks.onGesture !== undefined) this.callbacks.onGesture = callbacks.onGesture;
  }

  /**
   * Process hand joints for gesture recognition.
   * Call once per frame for each detected hand.
   *
   * @param hand - XRHand object from the WebXR frame
   * @param handedness - "left" or "right"
   * @param referenceSpace - XRReferenceSpace for joint pose resolution
   * @param frame - XRFrame for getting joint poses
   */
  update(
    hand: XRHand,
    handedness: "left" | "right",
    referenceSpace: XRReferenceSpace,
    frame: XRFrame,
  ): void {
    const joints = this.resolveJoints(hand, referenceSpace, frame);
    if (!joints) return;

    const now = performance.now();

    // --- Pinch detection ---
    const pinchDist = distance3(joints.thumbTip, joints.indexTip);
    if (pinchDist < PINCH_THRESHOLD) {
      this.emit(now, {
        type: "pinch",
        hand: handedness,
        confidence: 1 - pinchDist / PINCH_THRESHOLD,
      });
    }

    // --- Beckon detection (curl) ---
    const curl = this.computeCurl(joints);
    if (curl > BECKON_CURL_THRESHOLD) {
      this.emit(now, { type: "beckon", hand: handedness, confidence: curl });
    }

    // --- Palm velocity tracking (dismiss) ---
    const palmPos = joints.wrist;
    const prevPalm = this.prevPalmPos.get(handedness);
    if (prevPalm) {
      const vel: [number, number, number] = [
        (palmPos[0] - prevPalm[0]) * 60, // Approximate 60 FPS
        (palmPos[1] - prevPalm[1]) * 60,
        (palmPos[2] - prevPalm[2]) * 60,
      ];
      this.palmVelocity.set(handedness, vel);

      // Dismiss: palm pushing away (positive Z in typical WebXR forward)
      const pushSpeed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
      const palmNormalDismiss = this.estimatePalmNormal(joints);
      // Push direction should align with palm normal
      if (palmNormalDismiss && pushSpeed > DISMISS_VELOCITY) {
        const velNorm = normalize3(vel);
        if (velNorm) {
          const d = dot3(velNorm, palmNormalDismiss);
          if (d > 0.5) {
            this.emit(now, {
              type: "dismiss",
              hand: handedness,
              confidence: Math.min(1, pushSpeed / (DISMISS_VELOCITY * 2)),
            });
          }
        }
      }
    }
    this.prevPalmPos.set(handedness, [...palmPos]);

    // --- Pause detection (palm-up stop) ---
    const palmNormal = this.estimatePalmNormal(joints);
    if (palmNormal) {
      const upDot = palmNormal[1]; // dot with world up [0,1,0]
      const isUp = upDot > PAUSE_PALM_UP_DOT;
      const vel = this.palmVelocity.get(handedness);
      const isStill = !vel || Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]) < 0.1;

      if (isUp && isStill) {
        this.emit(now, { type: "pause", hand: handedness, confidence: upDot });
      }
    }
  }

  // === Joint resolution ===

  private resolveJoints(
    hand: XRHand,
    referenceSpace: XRReferenceSpace,
    frame: XRFrame,
  ): JointPositions | null {
    // XRFrame.getJointPose may not be available in all implementations
    const getJointPose = frame.getJointPose?.bind(frame);
    if (!getJointPose) return null;

    const getPos = (index: number): [number, number, number] | null => {
      // XRHand is iterable by joint index; use string key mapping
      const jointNames: string[] = [
        "wrist",
        "thumb-metacarpal",
        "thumb-phalanx-proximal",
        "thumb-phalanx-distal",
        "thumb-tip",
        "index-finger-metacarpal",
        "index-finger-phalanx-proximal",
        "index-finger-phalanx-intermediate",
        "index-finger-phalanx-distal",
        "index-finger-tip",
        "middle-finger-metacarpal",
        "middle-finger-phalanx-proximal",
        "middle-finger-phalanx-intermediate",
        "middle-finger-phalanx-distal",
        "middle-finger-tip",
        "ring-finger-metacarpal",
        "ring-finger-phalanx-proximal",
        "ring-finger-phalanx-intermediate",
        "ring-finger-phalanx-distal",
        "ring-finger-tip",
        "pinky-finger-metacarpal",
        "pinky-finger-phalanx-proximal",
        "pinky-finger-phalanx-intermediate",
        "pinky-finger-phalanx-distal",
        "pinky-finger-tip",
      ];
      const name = jointNames[index];
      if (name == null) return null;
      const jointSpace = hand.get(name as XRHandJoint);
      if (!jointSpace) return null;
      const pose = getJointPose(jointSpace, referenceSpace);
      if (!pose) return null;
      const p = pose.transform.position;
      return [p.x, p.y, p.z];
    };

    const thumbTip = getPos(THUMB_TIP);
    const indexTip = getPos(INDEX_TIP);
    const middleTip = getPos(MIDDLE_TIP);
    const ringTip = getPos(RING_TIP);
    const indexMcp = getPos(INDEX_MCP);
    const middleMcp = getPos(MIDDLE_MCP);
    const ringMcp = getPos(RING_MCP);
    const wrist = getPos(WRIST);

    if (
      !thumbTip ||
      !indexTip ||
      !middleTip ||
      !ringTip ||
      !indexMcp ||
      !middleMcp ||
      !ringMcp ||
      !wrist
    ) {
      return null;
    }

    return { thumbTip, indexTip, middleTip, ringTip, indexMcp, middleMcp, ringMcp, wrist };
  }

  // === Curl computation ===

  /**
   * Compute average finger curl (0 = straight, 1 = fully curled).
   * Measured as ratio: tip-to-wrist / mcp-to-wrist for each finger.
   * When fingers are curled, tips are closer to wrist than MCPs are.
   */
  private computeCurl(joints: JointPositions): number {
    const fingers = [
      { tip: joints.indexTip, mcp: joints.indexMcp },
      { tip: joints.middleTip, mcp: joints.middleMcp },
      { tip: joints.ringTip, mcp: joints.ringMcp },
    ];

    let totalCurl = 0;
    for (const f of fingers) {
      const tipDist = distance3(f.tip, joints.wrist);
      const mcpDist = distance3(f.mcp, joints.wrist);
      if (mcpDist > 0.001) {
        // When curled, tipDist < mcpDist → ratio < 1 → curl > 0
        totalCurl += Math.max(0, 1 - tipDist / mcpDist);
      }
    }
    return totalCurl / fingers.length;
  }

  // === Palm normal estimation ===

  private estimatePalmNormal(joints: JointPositions): [number, number, number] | null {
    // Cross product of (indexMcp - wrist) × (ringMcp - wrist) gives palm normal
    const v1: [number, number, number] = [
      joints.indexMcp[0] - joints.wrist[0],
      joints.indexMcp[1] - joints.wrist[1],
      joints.indexMcp[2] - joints.wrist[2],
    ];
    const v2: [number, number, number] = [
      joints.ringMcp[0] - joints.wrist[0],
      joints.ringMcp[1] - joints.wrist[1],
      joints.ringMcp[2] - joints.wrist[2],
    ];
    const cross: [number, number, number] = [
      v1[1] * v2[2] - v1[2] * v2[1],
      v1[2] * v2[0] - v1[0] * v2[2],
      v1[0] * v2[1] - v1[1] * v2[0],
    ];
    return normalize3(cross);
  }

  // === Event emission with debounce ===

  private emit(now: number, event: GestureEvent): void {
    const key = `${event.hand}:${event.type}`;
    const last = this.lastGestureTime.get(key) ?? 0;
    if (now - last < GESTURE_DEBOUNCE_MS) return;

    this.lastGestureTime.set(key, now);
    this.callbacks.onGesture?.(event);
  }

  /** Reset internal state. */
  reset(): void {
    this.lastGestureTime.clear();
    this.prevPalmPos.clear();
    this.palmVelocity.clear();
  }
}

// === Utility ===

interface JointPositions {
  thumbTip: [number, number, number];
  indexTip: [number, number, number];
  middleTip: [number, number, number];
  ringTip: [number, number, number];
  indexMcp: [number, number, number];
  middleMcp: [number, number, number];
  ringMcp: [number, number, number];
  wrist: [number, number, number];
}

function distance3(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0],
    dy = a[1] - b[1],
    dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function dot3(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3(v: [number, number, number]): [number, number, number] | null {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len < 1e-8) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}
