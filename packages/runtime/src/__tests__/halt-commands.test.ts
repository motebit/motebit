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
    pending?: ApprovalItem[];
    stopper?: () => string;
  } = {},
) {
  const rows = new Map<string, HaltRequest>();
  const resolved: Array<{ id: string; status: string; reason?: string }> = [];
  const listeners = new Set<(h: HaltRequest) => string | Promise<string>>();
  if (opts.stopper) listeners.add(opts.stopper);

  const store =
    opts.halts === false
      ? null
      : {
          request: (h: HaltRequest) => void rows.set(h.halt_id, { ...h }),
          acknowledge: (id: string, ack: string, at = Date.now()) => {
            const r = rows.get(id);
            if (r && r.acknowledged_at == null) {
              r.acknowledged_at = at;
              r.acknowledgement = ack;
            }
          },
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
    approvals: {
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
        acknowledged_at: null,
        acknowledgement: null,
        lifted_at: null,
      };
      store?.request(h);
      return h;
    },
    honorHalts: async () => {
      const out: HaltRequest[] = [];
      for (const h of (store?.listActive() ?? []).filter((r) => r.acknowledged_at == null)) {
        const parts: string[] = [];
        for (const l of listeners) parts.push(await l(h));
        store!.acknowledge(h.halt_id, parts.join("; ") || "nothing was running");
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
    expect(r.summary).toBe("Stopped all unattended execution.");
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

  it("parses `goal <id> reason…` into a goal-scoped halt", async () => {
    const { runtime, rows } = makeRuntime({ stopper: () => "goal will not fire" });
    const r = await cmdHalt(runtime, "goal goal-A too noisy", "local");
    expect(r.data?.scope).toBe("goal-A");
    expect([...rows.values()][0]).toMatchObject({ goal_id: "goal-A", reason: "too noisy" });
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

  it("halt-status distinguishes requested from stopped", async () => {
    const { runtime } = makeRuntime();
    (runtime as unknown as { honorHalts: () => Promise<HaltRequest[]> }).honorHalts =
      async () => [];
    await cmdHalt(runtime, undefined, "local");
    const s = cmdHaltStatus(runtime);
    expect(s.summary).toContain("Stop requested");
    expect(s.summary).toContain("not yet acknowledged");
    expect(s.data?.halted).toBe(true);
  });

  it("halt-status on a running motebit says running", () => {
    const { runtime } = makeRuntime();
    expect(cmdHaltStatus(runtime).summary).toBe("Running — nothing is halted.");
  });
});

describe("cmdApprovals — the consent surface", () => {
  it("lists the real action, masks credential-class values, and carries the hash over the FULL args", () => {
    const { runtime } = makeRuntime({
      pending: [approval({ args_preview: '{"to":"ops@example.com","key":"sk-abc123DEF"}' })],
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
    const { runtime } = makeRuntime({ pending: [approval({ args_preview: "x".repeat(500) })] });
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
