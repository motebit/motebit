// Verification-wiring tests for the sovereign controller: the relay
// goals/ledger fetch (`/api/v1/goals/...`, a state-export-signed family)
// must route through the adapter's optional `verifiedFetch` when present,
// recording the verification status in state so the surface can show the
// user their own ledger was verified — not merely trusted. Doctrine:
// docs/doctrine/self-attesting-system.md.
import { describe, it, expect, vi } from "vitest";
import {
  createSovereignController,
  type SovereignFetchAdapter,
  type GoalRow,
  type VerifiedFetchResult,
} from "../index";

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

const COMPLETED_GOAL = { goal_id: "g1", status: "completed", created_at: 1 } as unknown as GoalRow;

// Base adapter: every non-goals fetch returns an empty-but-ok body so the
// controller's parallel refresh fetches all resolve (none reject). The
// goals path returns one completed goal when the surface uses raw `fetch`.
function baseAdapter(overrides: Partial<SovereignFetchAdapter> = {}): SovereignFetchAdapter {
  return {
    syncUrl: "https://relay.test",
    motebitId: "mote-1",
    fetch: async (path: string) =>
      jsonResponse(path.includes("/goals/") ? { goals: [COMPLETED_GOAL] } : {}),
    getSolanaAddress: () => null,
    getSolanaBalanceMicro: async () => null,
    getLocalCredentials: () => [],
    ...overrides,
  };
}

describe("sovereign controller — state-export verification wiring", () => {
  it("routes goals through verifiedFetch and records 'verified' status", async () => {
    const verifiedFetch = vi.fn(async (_path: string): Promise<VerifiedFetchResult> => ({
      ok: true,
      json: { goals: [COMPLETED_GOAL] },
      verification: "verified",
    }));
    const ctrl = createSovereignController(baseAdapter({ verifiedFetch }));

    await ctrl.refresh();

    expect(verifiedFetch).toHaveBeenCalledWith("/api/v1/goals/mote-1");
    expect(ctrl.getState().ledgerVerification).toBe("verified");
    expect(ctrl.getState().goals.map((g) => g.goal_id)).toContain("g1");
    ctrl.dispose();
  });

  it("records 'failed' and withholds the relay body when verification fails", async () => {
    const ctrl = createSovereignController(
      baseAdapter({
        // valid:false → verifier returns null body; status 'failed'.
        verifiedFetch: async () => ({ ok: true, json: null, verification: "failed" }),
      }),
    );

    await ctrl.refresh();

    expect(ctrl.getState().ledgerVerification).toBe("failed");
    // Unverified bytes must never render — no relay goal leaks in.
    expect(ctrl.getState().goals.map((g) => g.goal_id)).not.toContain("g1");
    ctrl.dispose();
  });

  it("falls back to raw fetch and reports 'unverified' when the adapter omits verifiedFetch", async () => {
    const ctrl = createSovereignController(baseAdapter()); // no verifiedFetch

    await ctrl.refresh();

    expect(ctrl.getState().ledgerVerification).toBe("unverified");
    // Raw fetch still populates the ledger (honest: shown but unverified).
    expect(ctrl.getState().goals.map((g) => g.goal_id)).toContain("g1");
    ctrl.dispose();
  });
});
