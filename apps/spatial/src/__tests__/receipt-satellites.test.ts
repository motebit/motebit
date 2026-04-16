/**
 * Receipt satellite rendering — mirrors credential-satellites.test.ts.
 * Covers the pure transform, renderer lifecycle, and coordinator state
 * machine (buffer-before-attach, trim, pending state).
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import type { ExecutionReceipt } from "@motebit/sdk";
import {
  ReceiptSatelliteCoordinator,
  ReceiptSatelliteRenderer,
  collectKnownKeys,
  hueForVerifyState,
  receiptsToExpression,
} from "../receipt-satellites";

function parent(): THREE.Group {
  const g = new THREE.Group();
  g.name = "creature-group";
  return g;
}

/**
 * Synthetic receipt for testing. The chain won't pass cryptographic
 * verification (no real signature), which is fine — the tests here
 * exercise the buffer / render / state-machine surface, not crypto.
 */
function makeReceipt(taskId: string, overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: `motebit:${taskId}`,
    public_key: "",
    device_id: "test-device",
    submitted_at: 0,
    completed_at: 0,
    status: "completed",
    result: "",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "",
    result_hash: "",
    signature: "",
    suite: "motebit-jcs-ed25519-b64-v1",
    ...overrides,
  };
}

describe("hueForVerifyState", () => {
  it("assigns distinct hues to each verification state", () => {
    const pending = hueForVerifyState("pending");
    const verified = hueForVerifyState("verified");
    const taskFailed = hueForVerifyState("task-failed");
    const failed = hueForVerifyState("failed");
    const all = [pending, verified, taskFailed, failed];
    expect(new Set(all).size).toBe(4);
  });

  it("keeps every hue inside [0, 360)", () => {
    for (const s of ["pending", "verified", "task-failed", "failed"] as const) {
      const h = hueForVerifyState(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});

describe("receiptsToExpression", () => {
  it("produces a satellite-kind expression with one item per receipt", () => {
    const expr = receiptsToExpression([
      { id: "a", state: "pending", insertedAt: 1 },
      { id: "b", state: "verified", insertedAt: 2 },
    ]);
    expect(expr.kind).toBe("satellite");
    expect(expr.items.length).toBe(2);
    expect(expr.items[0]!.id).toBe("a");
    expect(expr.items[1]!.id).toBe("b");
  });

  it("carries state through to hue", () => {
    const expr = receiptsToExpression([{ id: "a", state: "failed", insertedAt: 1 }]);
    expect(expr.items[0]!.hue).toBe(hueForVerifyState("failed"));
  });
});

describe("collectKnownKeys", () => {
  it("extracts hex public_keys from the receipt tree keyed by motebit_id", () => {
    const receipt = makeReceipt("root", {
      motebit_id: "root",
      public_key: "0011",
      delegation_receipts: [makeReceipt("child", { motebit_id: "child", public_key: "aabb" })],
    });
    const keys = collectKnownKeys(receipt);
    expect(keys.size).toBe(2);
    expect(keys.get("root")).toEqual(new Uint8Array([0x00, 0x11]));
    expect(keys.get("child")).toEqual(new Uint8Array([0xaa, 0xbb]));
  });

  it("skips malformed hex without throwing", () => {
    const receipt = makeReceipt("root", { public_key: "not-hex" });
    const keys = collectKnownKeys(receipt);
    expect(keys.size).toBe(0);
  });
});

describe("ReceiptSatelliteRenderer", () => {
  it("mounts a child group under the parent", () => {
    const p = parent();
    const r = new ReceiptSatelliteRenderer(p);
    const child = p.children.find((c) => c.name === "receipt-satellites");
    expect(child).toBeDefined();
    r.dispose();
    expect(p.children.find((c) => c.name === "receipt-satellites")).toBeUndefined();
  });

  it("adds one mesh per receipt summary", () => {
    const p = parent();
    const r = new ReceiptSatelliteRenderer(p);
    r.setExpression(
      receiptsToExpression([
        { id: "a", state: "pending", insertedAt: 1 },
        { id: "b", state: "verified", insertedAt: 2 },
        { id: "c", state: "failed", insertedAt: 3 },
      ]),
    );
    const group = p.children.find((c) => c.name === "receipt-satellites") as THREE.Group;
    expect(group.children.length).toBe(3);
    r.dispose();
  });

  it("reuses meshes on re-set (no teardown churn)", () => {
    const p = parent();
    const r = new ReceiptSatelliteRenderer(p);
    const summary = [{ id: "a", state: "pending" as const, insertedAt: 1 }];
    r.setExpression(receiptsToExpression(summary));
    const group = p.children.find((c) => c.name === "receipt-satellites") as THREE.Group;
    const before = group.children[0];
    r.setExpression(receiptsToExpression(summary));
    const after = group.children[0];
    expect(after).toBe(before);
    r.dispose();
  });

  it("removes satellites that disappear from the expression", () => {
    const p = parent();
    const r = new ReceiptSatelliteRenderer(p);
    r.setExpression(
      receiptsToExpression([
        { id: "a", state: "pending", insertedAt: 1 },
        { id: "b", state: "pending", insertedAt: 2 },
      ]),
    );
    r.setExpression(receiptsToExpression([{ id: "a", state: "pending", insertedAt: 1 }]));
    const group = p.children.find((c) => c.name === "receipt-satellites") as THREE.Group;
    expect(group.children.length).toBe(1);
    expect(group.children[0]!.name).toBe("receipt:a");
    r.dispose();
  });

  it("tick() moves satellites along their orbit", () => {
    const p = parent();
    const r = new ReceiptSatelliteRenderer(p);
    r.setExpression(receiptsToExpression([{ id: "a", state: "pending", insertedAt: 1 }]));
    const group = p.children.find((c) => c.name === "receipt-satellites") as THREE.Group;
    const mesh = group.children[0]!;
    const before = mesh.position.clone();
    r.tick(12_000); // half an orbit at 24s period
    expect(mesh.position.distanceTo(before)).toBeGreaterThan(0);
    r.dispose();
  });

  it("ignores non-satellite expressions", () => {
    const p = parent();
    const r = new ReceiptSatelliteRenderer(p);
    r.setExpression({ kind: "environment", density: 0.5, tone: "neutral" });
    const group = p.children.find((c) => c.name === "receipt-satellites") as THREE.Group;
    expect(group.children.length).toBe(0);
    r.dispose();
  });
});

describe("ReceiptSatelliteCoordinator", () => {
  it("buffers receipts added before attach and flushes on attach", () => {
    const c = new ReceiptSatelliteCoordinator();
    c.addReceipt(makeReceipt("a"));
    c.addReceipt(makeReceipt("b"));
    expect(c.size()).toBe(2);

    const p = parent();
    c.attach(p);
    const group = p.children.find((ch) => ch.name === "receipt-satellites") as THREE.Group;
    expect(group.children.length).toBe(2);

    c.dispose();
  });

  it("addReceipt sets pending state immediately", () => {
    const c = new ReceiptSatelliteCoordinator();
    c.addReceipt(makeReceipt("a"));
    expect(c.getState("a")).toBe("pending");
    c.dispose();
  });

  it("trims oldest receipts past the cap", () => {
    const c = new ReceiptSatelliteCoordinator();
    for (let i = 0; i < 15; i++) c.addReceipt(makeReceipt(`r${i}`));
    expect(c.size()).toBe(12);
    // Oldest three (r0, r1, r2) dropped.
    expect(c.getState("r0")).toBeUndefined();
    expect(c.getState("r2")).toBeUndefined();
    expect(c.getState("r3")).toBe("pending");
    expect(c.getState("r14")).toBe("pending");
    c.dispose();
  });

  it("attach is idempotent", () => {
    const c = new ReceiptSatelliteCoordinator();
    const p = parent();
    c.attach(p);
    c.attach(p);
    const groups = p.children.filter((ch) => ch.name === "receipt-satellites");
    expect(groups.length).toBe(1);
    c.dispose();
  });

  it("dispose clears state and detaches the renderer", () => {
    const c = new ReceiptSatelliteCoordinator();
    const p = parent();
    c.attach(p);
    c.addReceipt(makeReceipt("a"));
    c.dispose();
    expect(c.size()).toBe(0);
    expect(p.children.find((ch) => ch.name === "receipt-satellites")).toBeUndefined();
  });
});
