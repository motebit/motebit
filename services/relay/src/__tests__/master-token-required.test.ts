/**
 * The master token is a boot requirement, not a mode.
 *
 * Every master-token gate in `middleware.ts` used to be installed under
 * `if (apiToken != null && apiToken !== "")` — a relay booted without
 * `MOTEBIT_API_TOKEN` served memory/state/audit/goals exports, the admin fee
 * and withdrawal dashboards, and accepted `POST /api/v1/admin/freeze` with no
 * authentication at all. Auth that depends on a config value being present is
 * fail-open by construction. The relay now refuses to construct without the
 * token; the only way to run it open is the loudly-named dev opt-in
 * `allowInsecureNoAuth` (`MOTEBIT_RELAY_INSECURE_NO_AUTH=1`), which production
 * (`NODE_ENV=production`) refuses.
 *
 * The route-table half enumerates `/api/v1/admin/*` from the app's own router
 * (never a hand list — a hand list is the drift `admin-auth-parity` names) and
 * asserts each handler answers 401 without credentials.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { createSyncRelay, type SyncRelay } from "../index.js";
import { buildRelayConfigFromEnv, MINIMAL_VALID_RELAY_ENV } from "../relay-config.js";
import { TEST_RELAY_NETWORK, X402_TEST_CONFIG, createTestRelay } from "./test-helpers.js";
import {
  BOOT_TIMEOUT_MS,
  SOURCE_TIER,
  bootRealEntry,
  killBootedEntry,
} from "./booted-entry-harness.js";

const DEPS = { getShuttingDown: () => false } as const;

describe("createSyncRelay refuses to construct without the master token", () => {
  let relay: SyncRelay | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    vi.restoreAllMocks();
  });

  it("no apiToken → throws a repair message naming the env var and the opt-in", async () => {
    await expect(
      createSyncRelay({ x402: X402_TEST_CONFIG, ...TEST_RELAY_NETWORK }),
    ).rejects.toThrow(/MOTEBIT_API_TOKEN.*MOTEBIT_RELAY_INSECURE_NO_AUTH/s);
  });

  it("empty apiToken → throws", async () => {
    await expect(
      createSyncRelay({ apiToken: "", x402: X402_TEST_CONFIG, ...TEST_RELAY_NETWORK }),
    ).rejects.toThrow(/MOTEBIT_API_TOKEN/);
  });

  it("whitespace-only apiToken → throws", async () => {
    await expect(
      createSyncRelay({ apiToken: "   ", x402: X402_TEST_CONFIG, ...TEST_RELAY_NETWORK }),
    ).rejects.toThrow(/MOTEBIT_API_TOKEN/);
  });

  it("explicit opt-in → boots, and says so loudly at boot", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    relay = await createSyncRelay({
      allowInsecureNoAuth: true,
      x402: X402_TEST_CONFIG,
      ...TEST_RELAY_NETWORK,
    });
    const warn = writes.find((w) => w.includes("relay.insecure_no_auth"));
    expect(warn).toBeDefined();
    expect(JSON.parse(warn!).level).toBe("warn");
  });
});

describe("buildRelayConfigFromEnv (the production boot path) refuses a missing token", () => {
  const base = { ...MINIMAL_VALID_RELAY_ENV };
  delete (base as Record<string, string | undefined>).MOTEBIT_API_TOKEN;

  it("unset → throws", () => {
    expect(() => buildRelayConfigFromEnv(base, DEPS)).toThrow(/MOTEBIT_API_TOKEN/);
  });

  it("empty → throws", () => {
    expect(() => buildRelayConfigFromEnv({ ...base, MOTEBIT_API_TOKEN: "" }, DEPS)).toThrow(
      /MOTEBIT_API_TOKEN/,
    );
  });

  it("MOTEBIT_RELAY_INSECURE_NO_AUTH=1 → builds with the opt-in carried", () => {
    const cfg = buildRelayConfigFromEnv({ ...base, MOTEBIT_RELAY_INSECURE_NO_AUTH: "1" }, DEPS);
    expect(cfg.allowInsecureNoAuth).toBe(true);
    expect(cfg.apiToken).toBeUndefined();
  });

  it("the opt-in is refused under NODE_ENV=production", () => {
    expect(() =>
      buildRelayConfigFromEnv(
        { ...base, MOTEBIT_RELAY_INSECURE_NO_AUTH: "1", NODE_ENV: "production" },
        DEPS,
      ),
    ).toThrow(/production/);
  });

  it("a configured token builds with the opt-in off", () => {
    const cfg = buildRelayConfigFromEnv({ ...base, MOTEBIT_API_TOKEN: "t" }, DEPS);
    expect(cfg.apiToken).toBe("t");
    expect(cfg.allowInsecureNoAuth).toBe(false);
  });
});

describe("the real entry (tsx src/server.ts) refuses to boot without the token", () => {
  it(
    "MOTEBIT_API_TOKEN empty → the process exits before listening, naming the variable",
    async () => {
      await expect(bootRealEntry(SOURCE_TIER, { MOTEBIT_API_TOKEN: "" })).rejects.toThrow(
        /exited before listening[\s\S]*MOTEBIT_API_TOKEN is required/,
      );
    },
    BOOT_TIMEOUT_MS,
  );

  it(
    "MOTEBIT_RELAY_INSECURE_NO_AUTH=1 → boots, announcing the open relay at warn level",
    async () => {
      const booted = await bootRealEntry(SOURCE_TIER, {
        MOTEBIT_API_TOKEN: "",
        MOTEBIT_RELAY_INSECURE_NO_AUTH: "1",
      });
      try {
        expect(booted.log()).toMatch(/"level":"warn","msg":"relay\.insecure_no_auth"/);
      } finally {
        killBootedEntry(booted);
      }
    },
    BOOT_TIMEOUT_MS,
  );
});

describe("every /api/v1/admin/* handler route answers 401 without credentials", () => {
  let relay: SyncRelay;
  let adminRoutes: Array<{ method: string; path: string }>;

  beforeAll(async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const seen = new Set<string>();
    adminRoutes = [];
    for (const r of relay.app.routes) {
      // `app.use` registers middleware under ALL; handlers under their method.
      if (r.method === "ALL" || !r.path.startsWith("/api/v1/admin")) continue;
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      adminRoutes.push({ method: r.method, path: r.path });
    }
  });
  afterAll(async () => {
    await relay.close();
  });

  it("enumerates the admin surface from the router", () => {
    // A floor, not a count: the enumeration is the aperture, and it must see
    // the known admin dashboards (freeze, fees, withdrawals, disputes, …).
    expect(adminRoutes.length).toBeGreaterThanOrEqual(10);
    expect(adminRoutes.map((r) => `${r.method} ${r.path}`)).toContain("POST /api/v1/admin/freeze");
  });

  it("each one rejects an unauthenticated request with 401", async () => {
    const open: string[] = [];
    let n = 0;
    for (const { method, path } of adminRoutes) {
      // A distinct client per probe: the per-IP limiter runs before auth on
      // some admin routes, and a 429 would hide what auth decides.
      n += 1;
      const concrete = path.replace(/:[A-Za-z_]+/g, "probe-id");
      const res = await relay.app.request(concrete, {
        method,
        headers: { "Content-Type": "application/json", "x-real-ip": `10.0.${n >> 8}.${n & 255}` },
        ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
      });
      if (res.status !== 401) open.push(`${method} ${path} → ${res.status}`);
    }
    expect(open).toEqual([]);
  });
});
