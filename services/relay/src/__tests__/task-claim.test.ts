/**
 * The relay's task claim (`task-claim.ts`): atomic grant, lease renewal by
 * the holder only, lapse ⇒ Pending + re-presented to every serving socket,
 * a claim without `lease` never lapses, and the claim names who may answer.
 */
import { describe, it, expect } from "vitest";
import { AgentTaskStatus, asMotebitId } from "@motebit/sdk";
import type { AgentTask } from "@motebit/sdk";
import { TaskClaims, claimRefusesAnswer } from "../task-claim.js";
import type { TaskQueueEntry } from "../tasks.js";
import type { ConnectedDevice } from "../websocket.js";

const MID = "mote-1";

function entry(taskId: string, caps?: string[]): TaskQueueEntry {
  return {
    task: {
      task_id: taskId,
      motebit_id: asMotebitId(MID),
      prompt: "p",
      submitted_at: 0,
      status: AgentTaskStatus.Pending,
      ...(caps ? { required_capabilities: caps } : {}),
    } as unknown as AgentTask,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

function socket(deviceId: string, frames: string[]): ConnectedDevice {
  return {
    ws: { readyState: 1, send: (d: string) => frames.push(d), close: () => {} },
    deviceId,
    deviceIdVerified: true,
  } as unknown as ConnectedDevice;
}

function setup(leaseMs = 100) {
  const taskQueue = new Map<string, TaskQueueEntry>();
  const connections = new Map<string, ConnectedDevice[]>();
  const logs: string[] = [];
  const claims = new TaskClaims({
    taskQueue,
    connections,
    logger: { info: (e) => logs.push(e) },
    leaseMs,
  });
  return { taskQueue, connections, claims, logs };
}

const peer = (deviceId: string, verified = true, capabilities?: string[]) => ({
  deviceId,
  deviceIdVerified: verified,
  capabilities,
});

describe("TaskClaims", () => {
  it("grants one claim; every later claim is refused", () => {
    const { taskQueue, claims } = setup();
    taskQueue.set("t", entry("t"));
    expect(claims.claim("t", MID, peer("a"), { lease: true, now: 0 })).toEqual({
      granted: true,
      lease_ms: 100,
    });
    expect(claims.claim("t", MID, peer("b"), { lease: true, now: 1 })).toEqual({
      granted: false,
      reason: "already_claimed",
    });
    expect(taskQueue.get("t")!.task.status).toBe(AgentTaskStatus.Claimed);
    expect(taskQueue.get("t")!.claim_lease).toEqual({
      device_id: "a",
      device_verified: true,
      expires_at: 100,
    });
  });

  it("refuses another motebit's task and a device lacking required capabilities", () => {
    const { taskQueue, claims } = setup();
    taskQueue.set("t", entry("t", ["web_search"]));
    expect(claims.claim("t", "other", peer("a"), { lease: true, now: 0 }).granted).toBe(false);
    expect(claims.claim("t", MID, peer("a", true, ["x"]), { lease: true, now: 0 })).toEqual({
      granted: false,
      reason: "Device lacks required capabilities",
    });
    expect(taskQueue.get("t")!.task.status).toBe(AgentTaskStatus.Pending);
    expect(
      claims.claim("t", MID, peer("b", true, ["web_search"]), { lease: true, now: 0 }).granted,
    ).toBe(true);
  });

  it("a lapsed lease returns the task to Pending and re-presents it to every socket", () => {
    const { taskQueue, connections, claims } = setup();
    taskQueue.set("t", entry("t"));
    const frames: string[] = [];
    connections.set(MID, [socket("a", frames), socket("b", frames)]);
    claims.claim("t", MID, peer("a"), { lease: true, now: 0 });
    expect(claims.sweep(99)).toEqual([]);
    expect(claims.sweep(100)).toEqual(["t"]);
    expect(taskQueue.get("t")!.task.status).toBe(AgentTaskStatus.Pending);
    expect(taskQueue.get("t")!.claim_lease).toBeUndefined();
    expect(frames.map((f) => (JSON.parse(f) as { type: string }).type)).toEqual([
      "task_request",
      "task_request",
    ]);
    // Re-claimable, and swept only once.
    expect(claims.sweep(1000)).toEqual([]);
    expect(claims.claim("t", MID, peer("b"), { lease: true, now: 1000 }).granted).toBe(true);
  });

  it("only the holder's renewals extend the lease", () => {
    const { taskQueue, claims } = setup();
    taskQueue.set("t", entry("t"));
    claims.claim("t", MID, peer("a"), { lease: true, now: 0 });
    expect(claims.renew("t", MID, "b", 50)).toBe(false);
    expect(claims.renew("t", "other", "a", 50)).toBe(false);
    expect(claims.renew("t", MID, "a", 90)).toBe(true);
    expect(claims.sweep(150)).toEqual([]);
    expect(claims.sweep(190)).toEqual(["t"]);
    expect(claims.renew("t", MID, "a", 200)).toBe(false);
  });

  it("a claim made without a lease never lapses (main's behaviour)", () => {
    const { taskQueue, claims } = setup();
    taskQueue.set("t", entry("t"));
    expect(claims.claim("t", MID, peer("a"), { lease: false, now: 0 })).toEqual({ granted: true });
    expect(claims.sweep(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(taskQueue.get("t")!.task.status).toBe(AgentTaskStatus.Claimed);
  });

  it("an answered task is never lapsed", () => {
    const { taskQueue, claims } = setup();
    taskQueue.set("t", entry("t"));
    claims.claim("t", MID, peer("a"), { lease: true, now: 0 });
    taskQueue.get("t")!.receipt = {} as never;
    expect(claims.sweep(1000)).toEqual([]);
  });

  it("a restarted relay re-adopts the leases its queue holds", () => {
    const first = setup();
    first.taskQueue.set("t", entry("t"));
    first.claims.claim("t", MID, peer("a"), { lease: true, now: 0 });
    const again = new TaskClaims({
      taskQueue: first.taskQueue,
      connections: first.connections,
      logger: { info: () => {} },
      leaseMs: 100,
    });
    expect(again.sweep(100)).toEqual(["t"]);
  });

  it("the verified claimer is the only device that may answer", () => {
    const { taskQueue, claims } = setup();
    taskQueue.set("t", entry("t"));
    expect(claimRefusesAnswer(taskQueue.get("t")!, "b")).toBe(false); // unclaimed
    claims.claim("t", MID, peer("a"), { lease: true, now: 0 });
    const e = taskQueue.get("t")!;
    expect(claimRefusesAnswer(e, "a")).toBe(false);
    expect(claimRefusesAnswer(e, "b")).toBe(true);
    expect(claimRefusesAnswer(e, undefined)).toBe(false); // master token
    taskQueue.set("u", entry("u"));
    claims.claim("u", MID, peer("anon", false), { lease: true, now: 0 });
    expect(claimRefusesAnswer(taskQueue.get("u")!, "b")).toBe(false); // unverified claimer
  });
});
