/**
 * `motebit smoke reconciliation` — branch-coverage tests.
 *
 * The subcommand has five terminal verdicts (loop_disabled / no_cycles_yet /
 * stale / drift / healthy) plus three error paths (no master token, network
 * failure, response shape mismatch). One test per branch keeps the assertions
 * locked to the subcommand's contract — moving a branch line in `smoke.ts`
 * without updating tests fails CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CliConfig } from "../args.js";

vi.mock("../config.js", () => ({
  CONFIG_DIR: "/tmp/motebit-test",
  loadFullConfig: vi.fn().mockReturnValue({
    motebit_id: "test-mote",
    device_id: "test-device",
    sync_url: "https://relay.test",
  }),
  saveFullConfig: vi.fn(),
}));

const { handleSmokeReconciliation } = await import("../subcommands/smoke.js");

const baseConfig = {
  syncToken: "test-master-token",
  syncUrl: "https://relay.test",
} as unknown as CliConfig;

describe("handleSmokeReconciliation", () => {
  // Spies are typed as `any` because the strict-typed return-of-spyOn
  // doesn't unify with the cross-overload `(...args: unknown[]) => unknown`
  // shape vitest infers when the test uses one spy type per call site.
  // Loosening here is local and the assertions stay strict.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let errSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code ?? 0)})`);
    }) as never);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env["MOTEBIT_API_TOKEN"];
    delete process.env["MOTEBIT_SYNC_TOKEN"];
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("requires a master token — fails with explicit error when none is set", async () => {
    const config = { ...baseConfig, syncToken: undefined } as CliConfig;
    await expect(handleSmokeReconciliation(config)).rejects.toThrow("process.exit(1)");
    const errOutput = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(errOutput).toContain("requires a master token");
  });

  it("loop_disabled verdict — returns success when relay reports loop_enabled=false (testnet)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          stats: {
            total_runs: 0,
            inconsistent_runs_24h: 0,
            inconsistent_runs_7d: 0,
            max_negative_drift_micro_7d: "0",
            last_run_at: null,
            current_drift_micro: null,
            current_consistent: null,
          },
          loop_enabled: false,
          chain: "eip155:84532",
          treasury_address: "",
        }),
    });
    await handleSmokeReconciliation(baseConfig);
    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output).toContain("verdict=loop_disabled");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("no_cycles_yet verdict — loop enabled but no cycles have run yet", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          stats: {
            total_runs: 0,
            inconsistent_runs_24h: 0,
            inconsistent_runs_7d: 0,
            max_negative_drift_micro_7d: "0",
            last_run_at: null,
            current_drift_micro: null,
            current_consistent: null,
          },
          loop_enabled: true,
          chain: "eip155:8453",
          treasury_address: "0xee51c5a65c6Fa81c9CC85505884290e90C09D285",
        }),
    });
    await handleSmokeReconciliation(baseConfig);
    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output).toContain("verdict=no_cycles_yet");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("stale verdict — last run older than 30 min triggers non-zero exit", async () => {
    const oneHourAgo = Date.now() - 60 * 60_000;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          stats: {
            total_runs: 5,
            inconsistent_runs_24h: 0,
            inconsistent_runs_7d: 0,
            max_negative_drift_micro_7d: "0",
            last_run_at: oneHourAgo,
            current_drift_micro: "1000000",
            current_consistent: true,
          },
          loop_enabled: true,
          chain: "eip155:8453",
          treasury_address: "0xee51c5a65c6Fa81c9CC85505884290e90C09D285",
        }),
    });
    await expect(handleSmokeReconciliation(baseConfig)).rejects.toThrow("process.exit(1)");
    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output).toContain("verdict=stale");
  });

  it("drift verdict — current_consistent=false triggers non-zero exit", async () => {
    const fiveMinAgo = Date.now() - 5 * 60_000;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          stats: {
            total_runs: 12,
            inconsistent_runs_24h: 1,
            inconsistent_runs_7d: 1,
            max_negative_drift_micro_7d: "-500",
            last_run_at: fiveMinAgo,
            current_drift_micro: "-500",
            current_consistent: false,
          },
          loop_enabled: true,
          chain: "eip155:8453",
          treasury_address: "0xee51c5a65c6Fa81c9CC85505884290e90C09D285",
        }),
    });
    await expect(handleSmokeReconciliation(baseConfig)).rejects.toThrow("process.exit(1)");
    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output).toContain("verdict=drift");
    expect(output).toContain("current_drift_micro=-500");
  });

  it("healthy verdict — fresh cycle, consistent state, exits 0", async () => {
    const fiveMinAgo = Date.now() - 5 * 60_000;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          stats: {
            total_runs: 100,
            inconsistent_runs_24h: 0,
            inconsistent_runs_7d: 0,
            max_negative_drift_micro_7d: "0",
            last_run_at: fiveMinAgo,
            current_drift_micro: "4026726",
            current_consistent: true,
          },
          loop_enabled: true,
          chain: "eip155:8453",
          treasury_address: "0xee51c5a65c6Fa81c9CC85505884290e90C09D285",
        }),
    });
    await handleSmokeReconciliation(baseConfig);
    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output).toContain("verdict=healthy");
    expect(output).toContain("100 run(s) total");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("network failure — relay unreachable, fails with explicit error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(handleSmokeReconciliation(baseConfig)).rejects.toThrow("process.exit(1)");
    const errOutput = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(errOutput).toContain("relay probe failed");
  });

  it("non-2xx HTTP — wrong master token returns 401, surfaces status in error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });
    await expect(handleSmokeReconciliation(baseConfig)).rejects.toThrow("process.exit(1)");
    const errOutput = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(errOutput).toContain("relay probe failed");
    expect(errOutput).toContain("401");
  });

  it("non-2xx HTTP — relay returns 500, surfaces status in error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("internal server error"),
    });
    await expect(handleSmokeReconciliation(baseConfig)).rejects.toThrow("process.exit(1)");
    const errOutput = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(errOutput).toContain("500");
  });

  it("response shape mismatch — older relay without the endpoint, fails with hint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, hello: "world" }),
    });
    await expect(handleSmokeReconciliation(baseConfig)).rejects.toThrow("process.exit(1)");
    const errOutput = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(errOutput).toContain("relay may be older");
  });

  it("accepts MOTEBIT_API_TOKEN env var as master-token fallback", async () => {
    process.env["MOTEBIT_API_TOKEN"] = "env-master-token";
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          stats: {
            total_runs: 0,
            inconsistent_runs_24h: 0,
            inconsistent_runs_7d: 0,
            max_negative_drift_micro_7d: "0",
            last_run_at: null,
            current_drift_micro: null,
            current_consistent: null,
          },
          loop_enabled: false,
          chain: "",
          treasury_address: "",
        }),
    });
    const config = { ...baseConfig, syncToken: undefined } as CliConfig;
    await handleSmokeReconciliation(config);
    expect(fetchMock).toHaveBeenCalledOnce();
    const headersArg = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((headersArg.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer env-master-token",
    );
  });
});
