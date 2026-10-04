/**
 * The relay's task claim (`task-claim.ts`): atomic grant, lease renewal by
 * the holder only, lapse ⇒ undetermined (never Pending again), a claim
 * without `lease` never lapses on its own (the TTL pass marks it), the claim
 * names who may answer, and the relay's own forward and the submitter's
 * presentation are grants too.
 */
import { describe, it, expect } from "vitest";
import { AgentTaskStatus, asMotebitId } from "@motebit/sdk";
import type { AgentTask } from "@motebit/sdk";
import {
  TaskClaims,
  claimRefusesAnswer,
  expiredOf,
  grantToSubmitter,
  undeterminedOf,
} from "../task-claim.js";
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
      presenter: "ws",
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

  it("a lapsed lease leaves the task Claimed and UNDETERMINED — never Pending, never re-presented", () => {
    const { taskQueue, connections, claims } = setup();
    taskQueue.set("t", entry("t"));
    const frames: string[] = [];
    connections.set(MID, [socket("a", frames), socket("b", frames)]);
    claims.claim("t", MID, peer("a"), { lease: true, now: 0 });
    expect(claims.sweep(99)).toEqual([]);
    expect(claims.sweep(100)).toEqual(["t"]);
    const e = taskQueue.get("t")!;
    expect(e.task.status).toBe(AgentTaskStatus.Claimed);
    expect(e.task.claimed_by).toBe("a");
    expect(e.claim_lease).toMatchObject({ device_id: "a", undetermined_at: 100 });
    expect(frames).toEqual([]);
    // Never re-claimable by another body, and marked only once.
    expect(claims.sweep(1000)).toEqual([]);
    expect(claims.claim("t", MID, peer("b"), { lease: true, now: 1000 })).toEqual({
      granted: false,
      reason: "already_claimed",
    });
  });

  it("the claimer's renewal after it was lost clears the undetermined mark", () => {
    const { taskQueue, claims } = setup();
    taskQueue.set("t", entry("t"));
    claims.claim("t", MID, peer("a"), { lease: true, now: 0 });
    claims.sweep(100);
    expect(claims.renew("t", MID, "b", 120)).toBe(false);
    expect(taskQueue.get("t")!.claim_lease?.undetermined_at).toBe(100);
    expect(claims.renew("t", MID, "a", 120)).toBe(true);
    expect(taskQueue.get("t")!.claim_lease?.undetermined_at).toBeUndefined();
    expect(claims.sweep(219)).toEqual([]);
    expect(claims.sweep(220)).toEqual(["t"]);
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

  it("the claimer is the only device that may answer, verified or not", () => {
    const { taskQueue, claims } = setup();
    taskQueue.set("t", entry("t"));
    expect(claimRefusesAnswer(taskQueue.get("t")!, "b")).toBe(false); // unclaimed
    claims.claim("t", MID, peer("a"), { lease: true, now: 0 });
    const e = taskQueue.get("t")!;
    expect(claimRefusesAnswer(e, "a")).toBe(false);
    expect(claimRefusesAnswer(e, "b")).toBe(true);
    expect(claimRefusesAnswer(e, undefined)).toBe(false); // master token
    claims.sweep(1000); // undetermined: still only the claimer
    expect(claimRefusesAnswer(e, "a")).toBe(false);
    expect(claimRefusesAnswer(e, "b")).toBe(true);
    // An unverified claimer: its declared id, or the device its token proved.
    taskQueue.set("u", entry("u"));
    claims.claim(
      "u",
      MID,
      { ...peer("declared", false), authenticatedDid: "proved" },
      {
        lease: true,
        now: 0,
      },
    );
    const u = taskQueue.get("u")!;
    expect(claimRefusesAnswer(u, "b")).toBe(true);
    expect(claimRefusesAnswer(u, "declared")).toBe(false);
    expect(claimRefusesAnswer(u, "proved")).toBe(false);
  });
});

/**
 * Every grant, not only a body's claim (round 3 — one-execution-matrix.probe.ts):
 * the relay's MCP forward and the submitter's chosen presentation are grants
 * too; a lost grantee is undetermined and persists; a never-granted task
 * expires visibly.
 */
describe("TaskClaims — the forward's grant, the TTL pass", () => {
  it("the MCP forward takes the grant first; a body's claim after it is refused, and a body's claim before it means no forward", () => {
    const { taskQueue, claims } = setup();
    taskQueue.set("t", entry("t"));
    expect(claims.grantForward("t", "w")).toBe(true);
    expect(taskQueue.get("t")!.task.status).toBe(AgentTaskStatus.Claimed);
    expect(claims.claim("t", MID, peer("a"), { lease: true, now: 0 })).toEqual({
      granted: false,
      reason: "already_claimed",
    });
    taskQueue.set("u", entry("u"));
    claims.claim("u", MID, peer("a"), { lease: true, now: 0 });
    expect(claims.grantForward("u", "w")).toBe(false);
  });

  it("a forward that never sent tools/call is released to Pending (for re-presentation); one that did is undetermined", () => {
    const { taskQueue, claims } = setup();
    taskQueue.set("t", entry("t"));
    claims.grantForward("t", "w");
    const released = claims.forwardEnded("t", false, 5);
    expect(released?.task.status).toBe(AgentTaskStatus.Pending);
    expect(taskQueue.get("t")!.claim_lease).toBeUndefined();

    taskQueue.set("u", entry("u"));
    claims.grantForward("u", "w");
    expect(claims.forwardEnded("u", true, 7)).toBeNull();
    const e = taskQueue.get("u")!;
    expect(e.task.status).toBe(AgentTaskStatus.Claimed);
    expect(undeterminedOf(e)).toMatchObject({ reason: "forward_unanswered", since: 7 });
    // A forward's grant names no device: no device token is refused by it.
    expect(claimRefusesAnswer(e, "any-device")).toBe(false);
  });

  it("the TTL pass: never granted ⇒ expired visibly (unclaimable); granted without a live lease ⇒ undetermined; a renewing claim is left alone", () => {
    const { taskQueue, claims } = setup(1_000);
    taskQueue.set("p", { ...entry("p"), expiresAt: 10 });
    taskQueue.set("c", { ...entry("c"), expiresAt: 10 });
    claims.claim("c", MID, peer("a"), { lease: false, now: 0 });
    taskQueue.set("r", { ...entry("r"), expiresAt: 10 });
    claims.claim("r", MID, peer("a"), { lease: true, now: 0 });
    claims.renew("r", MID, "a", 500); // lease now runs to 1500
    const s = { ...entry("s"), expiresAt: 10 };
    grantToSubmitter(s, "d");
    taskQueue.set("s", s);

    expect(claims.expire(20).sort()).toEqual(["c", "p", "s"]);
    expect(expiredOf(taskQueue.get("p")!)).toMatchObject({ reason: "never_claimed", since: 20 });
    expect(claims.claim("p", MID, peer("b"), { lease: true, now: 21 })).toEqual({
      granted: false,
      reason: "expired",
    });
    expect(undeterminedOf(taskQueue.get("c")!)?.reason).toBe("unanswered_at_expiry");
    expect(undeterminedOf(taskQueue.get("s")!)?.reason).toBe("unanswered_at_expiry");
    expect(undeterminedOf(taskQueue.get("r")!)).toBeNull();
    expect(claims.holdsUnresolvedGrant("r")).toBe(true);
    expect(claims.holdsUnresolvedGrant("p")).toBe(false);
    // Idempotent.
    expect(claims.expire(30)).toEqual([]);
  });
});
