/**
 * #874 review, at the composition root that shipped the regression.
 *
 * A money molecule (the Clerk) enables interactive delegation, so its
 * runtime registers `retrieve_task_result` — the owner-only read of its
 * paid-task ledger and of the work those payments bought. Served over MCP,
 * any verified caller could list the Clerk's outstanding paid tasks and tx
 * hashes, read results bought for OTHER customers, and — by retrieving —
 * resolve the ledger entry that was blocking a double payment.
 *
 * This drives the REAL builder (`defaultCreateMoneyRuntime`) and the REAL
 * serve wiring (`wireServerDeps`), so it goes red if either the tool loses
 * its `localOnly` declaration or the serve chokepoint stops honoring it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/crypto";
import { createInMemoryStorage } from "@motebit/runtime";
import { InMemoryToolRegistry } from "@motebit/tools";
import { wireServerDeps } from "@motebit/mcp-server";
import type { ServiceRuntime } from "@motebit/mcp-server";
import { RiskLevel } from "@motebit/sdk";
import { defaultCreateMoneyRuntime } from "../index.js";

const TASK = "11111111-2222-3333-4444-555555555555";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("money molecule MCP surface — owner-only tools are never served (#874)", () => {
  it("retrieve_task_result and the other delegation tools are absent, and a call is refused", async () => {
    const kp = await generateKeypair();
    const identity = {
      motebitId: "mot_clerk",
      deviceId: "dev",
      publicKeyHex: bytesToHex(kp.publicKey),
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
      identityContent: "# x\n",
      identityPath: "/data/motebit.md",
      isFirstLaunch: true,
    };
    const cfg = {
      dataDir: "/tmp/x",
      dbPath: "/tmp/x/t.db",
      port: 9999,
      serviceName: "clerk",
      displayName: "c",
      serviceDescription: "c",
      capabilities: ["research"],
      syncUrl: "https://relay.test",
      moneyExecution: {
        solanaRpcUrl: "https://rpc.test",
        relayPublicKeyHex: "07".repeat(32),
        spendCeiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 1_000_000 },
      },
    } as never;
    const runtime = defaultCreateMoneyRuntime(
      identity as never,
      createInMemoryStorage(),
      new InMemoryToolRegistry(),
      { requireApprovalAbove: RiskLevel.R3_EXECUTE, denyAbove: RiskLevel.R3_EXECUTE },
      cfg,
      undefined as never,
    ) as unknown as ServiceRuntime;
    // The builder DID register the tool — this test is about serving, not absence.
    const registered = runtime
      .getToolRegistry()
      .list()
      .map((t) => t.name);
    expect(registered).toContain("retrieve_task_result");

    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            task: { status: "completed" },
            receipt: { task_id: TASK, motebit_id: "w", status: "completed", result: "PRIVATE" },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const deps = wireServerDeps(runtime, {
      motebitId: identity.motebitId,
      publicKeyHex: identity.publicKeyHex,
    });
    const served = deps.filterTools(await deps.listTools()).map((t) => t.name);
    for (const name of ["retrieve_task_result", "delegate_to_agent", "discover_agents"]) {
      expect(served, name).not.toContain(name);
    }

    const refused = await deps.executeTool("retrieve_task_result", { task_id: TASK });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain("PRIVATE");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
