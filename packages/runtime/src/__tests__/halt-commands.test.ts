/**
 * The halt + approval commands — the vocabulary a remote consent
 * surface speaks.
 *
 * Two properties matter more here than in a read-only command: the
 * output crosses the relay (so credential-class values must be masked),
 * and the halt response IS an acknowledgement (so it must never claim
 * one that did not happen).
 */
import { describe, it, expect } from "vitest";
import { cmdHalt, cmdResume, cmdHaltStatus, cmdApprovals } from "../commands/index.js";
import type { MotebitRuntime } from "../index";
import type { ApprovalItem, HaltRequest } from "@motebit/sdk";

function makeRuntime(
  opts: {
    halts?: boolean;
    /** `false` models a surface that wired no decidable approval queue. */
    approvals?: boolean;
    pending?: ApprovalItem[];
    stopper?: () => string;
  } = {},
) {
  const rows = new Map<string, HaltRequest>();
  const acks = new Map<
    string,
    Array<{
      halt_id: string;
      executor_id: string;
      acknowledged_at: number;
      acknowledgement: string;
    }>
  >();
  const EXECUTOR = "test-executor";
  const resolved: Array<{ id: string; status: string; reason?: string }> = [];
  const listeners = new Set<(h: HaltRequest) => string | Promise<string>>();
  if (opts.stopper) listeners.add(opts.stopper);

  const store =
    opts.halts === false
      ? null
      : {
          request: (h: HaltRequest) => void rows.set(h.halt_id, { ...h }),
          acknowledge: (id: string, executorId: string, ack: string, at = Date.now()) => {
            const list = acks.get(id) ?? [];
            if (!list.some((a) => a.executor_id === executorId)) {
              list.push({
                halt_id: id,
                executor_id: executorId,
                acknowledged_at: at,
                acknowledgement: ack,
              });
              acks.set(id, list);
            }
          },
          hasAcknowledged: (id: string, executorId: string) =>
            (acks.get(id) ?? []).some((a) => a.executor_id === executorId),
          acknowledgements: (id: string) => acks.get(id) ?? [],
          lift: (id: string) => {
            const r = rows.get(id);
            if (!r || r.lifted_at != null) return false;
            r.lifted_at = Date.now();
            return true;
          },
          listActive: () => [...rows.values()].filter((r) => r.lifted_at == null),
          activeFor: (_m: string, goalId?: string) => {
            const active = [...rows.values()].filter((r) => r.lifted_at == null);
            return (
              active.find((h) => h.goal_id === null) ??
              (goalId != null ? (active.find((h) => h.goal_id === goalId) ?? null) : null)
            );
          },
          get: (id: string) => rows.get(id) ?? null,
          listRecent: () => [...rows.values()],
        };

  const runtime = {
    motebitId: "mote-1",
    halts: store,
    haltExecutorId: EXECUTOR,
    resolveGoalId: (prefix: string) => prefix,
    approvals:
      opts.approvals === false
        ? { collectApproval: () => ({ met: false, collected: [] }), setQuorum: () => undefined }
        : {
            collectApproval: () => ({ met: false, collected: [] }),
            setQuorum: () => undefined,
            listPending: () => opts.pending ?? [],
            get: (id: string) => (opts.pending ?? []).find((a) => a.approval_id === id) ?? null,
            resolve: (id: string, status: "approved" | "denied", reason?: string) =>
              void resolved.push({ id, status, ...(reason !== undefined ? { reason } : {}) }),
          },
    hasPendingApproval: false,
    pendingApprovalInfo: null,
    // The real membrane masks credential-class values; the stub proves
    // the command routes through it rather than around it.
    redactForRemoteDisclosure: (t: string) => t.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]"),
    requestHalt: async (o: { goalId?: string; origin: "local" | "remote"; reason?: string }) => {
      const h: HaltRequest = {
        halt_id: `h${rows.size + 1}`,
        motebit_id: "mote-1",
        goal_id: o.goalId ?? null,
        requested_at: Date.now(),
        origin: o.origin,
        reason: o.reason ?? null,
        lifted_at: null,
      };
      store?.request(h);
      return h;
    },
    honorHalts: async () => {
      const out: HaltRequest[] = [];
      for (const h of (store?.listActive() ?? []).filter(
        (r) => !(acks.get(r.halt_id) ?? []).some((a) => a.executor_id === EXECUTOR),
      )) {
        const parts: string[] = [];
        for (const l of listeners) parts.push(await l(h));
        store!.acknowledge(h.halt_id, EXECUTOR, parts.join("; ") || "nothing was running");
        out.push(store!.get(h.halt_id)!);
      }
      return out;
    },
    liftHalt: async (id: string) => store?.lift(id) ?? false,
  } as unknown as MotebitRuntime;
  return { runtime, resolved, rows };
}

function approval(over: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    approval_id: "ap-11111111",
    motebit_id: "mote-1",
    goal_id: "goal-1",
    tool_name: "send_email",
    args_preview: '{"to":"ops@example.com","body":"hi"}',
    args_hash: "deadbeef",
    risk_level: 2,
    status: "pending",
    created_at: Date.now(),
    expires_at: Date.now() + 3_600_000,
    resolved_at: null,
    denied_reason: null,
    ...over,
  };
}

describe("cmdHalt", () => {
  it("reports the acknowledgement when this process is the one that stopped", async () => {
    const { runtime } = makeRuntime({ stopper: () => "aborted run 1a2b3c4d" });
    const r = await cmdHalt(runtime, "going out", "remote");
    // The summary names the ASK and this runtime's acknowledgement; the
    // detail carries what was actually stopped. It deliberately does
    // not say "has stopped all unattended execution", because this
    // process speaks only for itself and a relay may have delivered the
    // halt to whichever runtime it reached first.
    expect(r.summary).toBe(
      "Stop requested for all unattended execution. This runtime has acknowledged.",
    );
    expect(r.data?.acknowledged_by).toEqual([
      { executor_id: "test-executor", acknowledgement: "aborted run 1a2b3c4d" },
    ]);
    expect(r.detail).toContain("aborted run 1a2b3c4d");
    expect(r.data?.acknowledged).toBe(true);
  });

  it("says 'not yet acknowledged' rather than claiming a stop it cannot vouch for", async () => {
    const { runtime, rows } = makeRuntime();
    // A runtime whose honorHalts does nothing — e.g. the work lives in
    // another process that has not ticked yet.
    (runtime as unknown as { honorHalts: () => Promise<HaltRequest[]> }).honorHalts =
      async () => [];
    const r = await cmdHalt(runtime, undefined, "local");
    expect(r.summary).toContain("Stop requested");
    expect(r.summary).toContain("Not yet acknowledged");
    expect(r.data?.acknowledged).toBe(false);
    // …and it IS in force regardless.
    expect([...rows.values()][0]!.lifted_at).toBeNull();
  });

  it("takes the scope from the structured form", async () => {
    const { runtime, rows } = makeRuntime({ stopper: () => "goal will not fire" });
    const r = await cmdHalt(
      runtime,
      JSON.stringify({ goal_id: "goal-A", reason: "too noisy" }),
      "local",
    );
    expect(r.data?.scope).toBe("goal-A");
    expect([...rows.values()][0]).toMatchObject({ goal_id: "goal-A", reason: "too noisy" });
  });

  it("free text is a REASON and never a scope — a stop that reports stopping a goal must have stopped one", async () => {
    const { runtime, rows } = makeRuntime({ stopper: () => "stopped" });
    // The old `goal <id> <reason>` grammar read this as halting a goal
    // named "cleanup": nothing was halted, and the response said a goal
    // had been stopped.
    const r = await cmdHalt(runtime, "goal cleanup done", "local");
    expect(r.data?.scope).toBe("all");
    expect([...rows.values()][0]).toMatchObject({ goal_id: null, reason: "goal cleanup done" });
  });

  it("a reason that PARSES as JSON but names no goal is still a reason — never silently discarded", async () => {
    const { runtime, rows } = makeRuntime({ stopper: () => "stopped" });
    await cmdHalt(runtime, '{"deploy":"done"}', "local");
    expect([...rows.values()][0]).toMatchObject({
      goal_id: null,
      reason: '{"deploy":"done"}',
    });
  });

  it("a reason that merely starts with a brace is still a reason", async () => {
    const { runtime, rows } = makeRuntime({ stopper: () => "stopped" });
    await cmdHalt(runtime, "{not json after all", "local");
    expect([...rows.values()][0]).toMatchObject({ goal_id: null, reason: "{not json after all" });
  });

  it("reports the acknowledgement even when another actor honored the halt first", async () => {
    const { runtime } = makeRuntime({ stopper: () => "aborted run 9z" });
    // Simulate the scheduler's phase 0 having acknowledged it already:
    // `honorHalts` then returns nothing for THIS call.
    const realHonor = (runtime as unknown as { honorHalts: () => Promise<unknown[]> }).honorHalts;
    let first = true;
    (runtime as unknown as { honorHalts: () => Promise<unknown[]> }).honorHalts = async () => {
      const out = await realHonor.call(runtime);
      if (first) {
        first = false;
        return out;
      }
      return [];
    };
    await realHonor.call(runtime); // nothing pending yet
    const r = await cmdHalt(runtime, "x", "local");
    expect(r.data?.acknowledged).toBe(true);
    expect(r.detail).toContain("aborted run 9z");
  });

  it("a scope the store refuses is reported as nothing halted, not as a raw throw", async () => {
    const { runtime } = makeRuntime({ stopper: () => "stopped" });
    (runtime as unknown as { requestHalt: () => Promise<never> }).requestHalt = () =>
      Promise.reject(
        new Error('refusing to record a halt scoped to goal "ghost", which does not exist'),
      );
    const r = await cmdHalt(runtime, JSON.stringify({ goal_id: "ghost" }), "remote");
    expect(r.summary).toContain("Nothing was halted");
    expect(r.summary).toContain("does not exist");
  });

  it("a surface with no halt store refuses honestly instead of succeeding", async () => {
    const { runtime } = makeRuntime({ halts: false });
    const r = await cmdHalt(runtime, undefined, "remote");
    expect(r.summary).toContain("cannot be halted");
  });
});

describe("cmdResume / cmdHaltStatus", () => {
  it("resume lifts by id prefix, and by `all`", async () => {
    const { runtime } = makeRuntime({ stopper: () => "stopped" });
    await cmdHalt(runtime, undefined, "local");
    const r = await cmdResume(runtime, "h1");
    expect(r.data?.lifted).toBe(true);
    expect((await cmdResume(runtime, "all")).summary).toBe("Nothing is halted.");
  });

  it("the summary reports what THIS runtime stopped, never what was asked", async () => {
    // Both `motebit run` and `motebit serve` announce the
    // unattended-runtime capability and share a device id, so the relay
    // may deliver a motebit-wide halt to either. Landing on the worker,
    // whose stopper only declines further dispatched tasks, the old
    // summary answered "This runtime has stopped all unattended
    // execution" while the goal daemon had not acknowledged and kept
    // firing — the ask rendered as the stop.
    const { runtime } = makeRuntime({
      stopper: () => "no further dispatched tasks will be accepted",
    });
    const r = await cmdHalt(runtime, "going out", "remote");
    expect(r.summary).not.toContain("has stopped all unattended execution");
    expect(r.summary).toContain("This runtime has acknowledged");
    expect(r.detail).toContain("no further dispatched tasks will be accepted");
    expect(r.detail).toContain("has not acknowledged is still running");
  });

  it("an ambiguous resume prefix is refused, not resolved arbitrarily", async () => {
    // Repeated halts each write a row, so several active halts sharing
    // a short prefix is ordinary. Lifting whichever came first while
    // reporting success gives back permission nobody named.
    const { runtime, rows } = makeRuntime();
    await cmdHalt(runtime, "first", "local");
    await cmdHalt(runtime, "second", "local");
    const ids = [...rows.keys()];
    expect(ids.length).toBe(2);
    // Both stub ids start with "h", so "h" is ambiguous.
    const r = await cmdResume(runtime, "h");
    expect(r.summary).toContain("matches 2 halts in force");
    // Nothing was lifted.
    expect([...rows.values()].every((h) => h.lifted_at == null)).toBe(true);
  });

  it("halt-status distinguishes requested from stopped", async () => {
    const { runtime } = makeRuntime();
    (runtime as unknown as { honorHalts: () => Promise<HaltRequest[]> }).honorHalts =
      async () => [];
    await cmdHalt(runtime, undefined, "local");
    const s = cmdHaltStatus(runtime);
    expect(s.summary).toContain("Stop requested");
    expect(s.summary).toContain("no acknowledgement yet");
    expect(s.data?.halted).toBe(true);
  });

  it("halt-status never reports a bare 'Stopped', however many processes answered", async () => {
    // The defect this asserts against appeared in three readers, each
    // reading one process's acknowledgement as the whole motebit's. No
    // process can enumerate the others, so the summary reports what it
    // saw and names the residue it cannot see.
    const { runtime } = makeRuntime({ stopper: () => "aborted the run" });
    await cmdHalt(runtime, undefined, "local");
    const s = cmdHaltStatus(runtime);
    expect(s.summary).not.toMatch(/^Stopped\b/);
    // "acknowledged", not "stopped": a process answering says it looked,
    // not that it had work to stop. The worker answers a goal-scoped
    // halt with "nothing here runs under that goal", and counting that
    // under "stopped" read as the goal having stopped.
    expect(s.summary).toContain("1 process(es) have acknowledged");
    expect(s.summary).not.toContain("have stopped");
    expect(s.summary).toContain("has not acknowledged is still running");
    const active = (s.data as { active: Array<Record<string, unknown>> }).active;
    expect(active[0]!["acknowledged_at"]).toBeUndefined();
    expect(active[0]!["acknowledged_by"]).toHaveLength(1);
  });

  it("halt-status on a running motebit says running", () => {
    const { runtime } = makeRuntime();
    expect(cmdHaltStatus(runtime).summary).toBe("Running — nothing is halted.");
  });
});

describe("cmdApprovals — the consent surface", () => {
  it("an ambiguous approval prefix is refused — nothing is decided", () => {
    // `listPending` is oldest-first, so resolving to the first match
    // meant `/approve 1` approved whichever queued call happened to be
    // oldest among those starting with "1" — possibly a money action
    // nobody named — and confirmed it by tool name as though it were
    // the one asked for. `resume` already refuses an ambiguous halt
    // prefix; deciding an approval is the more consequential verb.
    const { runtime, resolved } = makeRuntime({
      pending: [
        approval({ approval_id: "1aaa0000", tool_name: "send_payment" }),
        approval({ approval_id: "1bbb0000", tool_name: "web_search" }),
      ],
    });
    const r = cmdApprovals(runtime, "approve 1");
    expect(r.summary).toContain("matches 2 pending approvals");
    expect(r.summary).toContain("Nothing was decided");
    expect(resolved).toEqual([]);
  });

  it("an exact id still decides, even when it prefixes another", () => {
    const { runtime, resolved } = makeRuntime({
      pending: [
        approval({ approval_id: "1aaa", tool_name: "web_search" }),
        approval({ approval_id: "1aaa0000", tool_name: "send_payment" }),
      ],
    });
    cmdApprovals(runtime, "approve 1aaa");
    expect(resolved).toEqual([{ id: "1aaa", status: "approved" }]);
  });

  it("a surface with no readable queue says so rather than reporting an empty one", () => {
    // The relay's compatibility fallback can deliver `approvals list` to
    // a surface that is not the daemon. Answering "No pending
    // approvals" there tells the phone the opposite of the truth while
    // the daemon holds a real pending call — and the person cannot tell
    // that from a genuinely empty queue.
    const { runtime } = makeRuntime({ approvals: false });
    const r = cmdApprovals(runtime, "list");
    expect(r.summary).toContain("cannot list approvals");
    expect(r.summary).not.toContain("No pending approvals");
    expect(r.detail).toContain("not the same as an empty queue");
  });

  it("lists the real action, masks credential-class values, and carries the hash over the FULL args", () => {
    const { runtime } = makeRuntime({
      pending: [
        approval({
          args_preview: '{"to":"ops@example.com","key":"sk-abc123DEF"}',
          args_json: '{"to":"ops@example.com","key":"sk-abc123DEF"}',
        }),
      ],
    });
    const r = cmdApprovals(runtime);
    expect(r.summary).toBe("1 approval(s) waiting on you.");
    const rows = r.data?.approvals as Array<Record<string, unknown>>;
    expect(rows[0]!.args_preview).toContain("ops@example.com"); // the decision
    expect(rows[0]!.args_preview).not.toContain("sk-abc123DEF"); // not the secret
    expect(rows[0]!.args_hash).toBe("deadbeef");
    expect(rows[0]!.args_truncated).toBe(false);
  });

  it("flags a truncated preview so a short render is not mistaken for the whole call", () => {
    const { runtime } = makeRuntime({
      pending: [approval({ args_preview: "x".repeat(500), args_json: "x".repeat(1200) })],
    });
    const rows = (cmdApprovals(runtime).data?.approvals ?? []) as Array<Record<string, unknown>>;
    expect(rows[0]!.args_truncated).toBe(true);
  });

  it("approve and deny write the verdict; neither executes anything here", () => {
    const { runtime, resolved } = makeRuntime({ pending: [approval()] });
    const ok = cmdApprovals(runtime, "approve ap-11111111");
    expect(ok.summary).toContain("Approved");
    expect(ok.detail).toContain("halt in force outranks this");
    expect(resolved).toEqual([{ id: "ap-11111111", status: "approved" }]);

    cmdApprovals(runtime, "deny ap-111 too risky");
    expect(resolved[1]).toEqual({ id: "ap-11111111", status: "denied", reason: "too risky" });
  });

  it("trailing text on an APPROVE is not written as a denial reason", () => {
    const { runtime, resolved } = makeRuntime({ pending: [approval()] });
    cmdApprovals(runtime, "approve ap-11111111 looks fine");
    // `denied_reason` on an approved row would surface as the denial
    // reason in the ApprovalApproved audit event.
    expect(resolved[0]).toEqual({ id: "ap-11111111", status: "approved" });
  });

  it("truncation is measured against the stored full args, not guessed from a length threshold", () => {
    const { runtime } = makeRuntime({
      pending: [
        // A 200-char preview (the width most producers store) over longer
        // args: a >= 500 threshold called this complete.
        approval({ args_preview: "y".repeat(200), args_json: "y".repeat(900) }),
        approval({ approval_id: "ap-2", args_preview: "short", args_json: "short" }),
        approval({ approval_id: "ap-3", args_preview: "unknown" }), // pre-#43: no full args
      ],
    });
    const rows = (cmdApprovals(runtime).data?.approvals ?? []) as Array<Record<string, unknown>>;
    expect(rows[0]!.args_truncated).toBe(true);
    expect(rows[1]!.args_truncated).toBe(false);
    expect(rows[2]!.args_truncated).toBeNull();
  });

  it("the live-turn fallback never returns raw arguments beside the redacted text", () => {
    const { runtime } = makeRuntime({ pending: [] });
    (runtime as unknown as { hasPendingApproval: boolean }).hasPendingApproval = true;
    (
      runtime as unknown as {
        pendingApprovalInfo: { toolName: string; args: Record<string, unknown> };
      }
    ).pendingApprovalInfo = { toolName: "call_api", args: { key: "sk-abc123DEF", to: "ops@x" } };
    const r = cmdApprovals(runtime);
    // `data` is serialized whole and returned through the relay.
    expect(JSON.stringify(r.data)).not.toContain("sk-abc123DEF");
    expect(JSON.stringify(r.data)).toContain("ops@x");
    expect(r.data?.args).toBeUndefined();
  });

  it("refuses to decide an approval past its expiry", () => {
    const { runtime, resolved } = makeRuntime({
      pending: [approval({ expires_at: Date.now() - 1000 })],
    });
    expect(cmdApprovals(runtime, "approve ap-11111111").summary).toContain("expired");
    expect(resolved).toEqual([]);
  });

  it("names an unknown id rather than deciding the wrong one", () => {
    const { runtime, resolved } = makeRuntime({ pending: [approval()] });
    expect(cmdApprovals(runtime, "approve zzz").summary).toContain("No pending approval");
    expect(resolved).toEqual([]);
  });

  it("an empty queue falls back to the live in-turn approval", () => {
    const { runtime } = makeRuntime({ pending: [] });
    expect(cmdApprovals(runtime).summary).toBe("No pending approvals.");
  });
});
