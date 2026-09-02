/**
 * Clerk config loading — the fail-safe money defaults.
 *
 * `services/clerk` is the money-EXECUTION pole of the archetype slate: it spends
 * under a self-issued grant. Until now it carried no `vitest.config.ts` at all,
 * so it had no coverage floor of any kind (#546), and without a config vitest
 * measured only the files its tests happened to import — `helpers.ts` was never
 * in the denominator, which is how "100% branches" was reported for a service
 * whose real branch coverage was 34%.
 *
 * The invariant these tests actually protect is `DRY_RUN`. It defaults to TRUE,
 * so the entire metered spine (grant verify → gate → meter → ceiling → refusal)
 * runs at hard zero unless an operator deliberately turns it off. A regression
 * that flipped that default would move real money on a service that is supposed
 * to be inert by default, and nothing would have failed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../helpers.js";

const TOUCHED = [
  "MOTEBIT_PORT",
  "MOTEBIT_DB_PATH",
  "MOTEBIT_DATA_DIR",
  "MOTEBIT_SOLANA_RPC_URL",
  "MOTEBIT_RELAY_PUBLIC_KEY",
  "MOTEBIT_CLERK_CAPABILITY",
  "MOTEBIT_CLERK_CEILING_MICRO",
  "DRY_RUN",
  "MOTEBIT_UNIT_COST",
  "MOTEBIT_AUTH_TOKEN",
  "MOTEBIT_SYNC_URL",
  "MOTEBIT_API_TOKEN",
  "MOTEBIT_PUBLIC_URL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("clerk loadConfig — dry-run is the fail-safe default", () => {
  it("defaults DRY_RUN to true when the variable is absent", () => {
    expect(loadConfig().dryRun).toBe(true);
  });

  it.each(["0", "false", "no", "FALSE", "No", "  false  "])(
    "treats %j as an explicit opt-OUT of dry run",
    (raw) => {
      process.env["DRY_RUN"] = raw;
      expect(loadConfig().dryRun).toBe(false);
    },
  );

  it.each(["1", "true", "yes", "", "maybe", "off"])(
    "keeps dry run ON for %j — only the three explicit disables count",
    (raw) => {
      // The fail-safe direction: an unrecognized value must NOT be read as
      // "spend real money". `off` is the interesting one — it reads like a
      // disable but is not in the recognized set, so it stays safe.
      process.env["DRY_RUN"] = raw;
      expect(loadConfig().dryRun).toBe(true);
    },
  );
});

describe("clerk loadConfig — defaults and overrides", () => {
  it("supplies safe defaults with no environment at all", () => {
    const c = loadConfig();
    expect(c.port).toBe(3700);
    expect(c.dbPath).toBe("./data/clerk.db");
    expect(c.dataDir).toBe("./data");
    expect(c.defaultCapability).toBe("research");
    expect(c.ceilingMicro).toBe(1_000_000); // $1 lifetime
    expect(c.unitCost).toBe(0.01);
  });

  it("leaves every optional binding null rather than inventing one", () => {
    // Absent means absent: a fabricated relay URL or public key would be a
    // silent trust root.
    const c = loadConfig();
    expect(c.solanaRpcUrl).toBeNull();
    expect(c.relayPublicKey).toBeNull();
    expect(c.authToken).toBeNull();
    expect(c.syncUrl).toBeNull();
    expect(c.apiToken).toBeNull();
    expect(c.publicUrl).toBeNull();
  });

  it("reads every override from the environment", () => {
    process.env["MOTEBIT_PORT"] = "4100";
    process.env["MOTEBIT_DB_PATH"] = "/tmp/c.db";
    process.env["MOTEBIT_DATA_DIR"] = "/tmp/data";
    process.env["MOTEBIT_SOLANA_RPC_URL"] = "https://rpc.example";
    process.env["MOTEBIT_RELAY_PUBLIC_KEY"] = "ab".repeat(32);
    process.env["MOTEBIT_CLERK_CAPABILITY"] = "summarize";
    process.env["MOTEBIT_CLERK_CEILING_MICRO"] = "250000";
    process.env["MOTEBIT_UNIT_COST"] = "0.25";
    process.env["MOTEBIT_AUTH_TOKEN"] = "tok";
    process.env["MOTEBIT_SYNC_URL"] = "https://relay.example";
    process.env["MOTEBIT_API_TOKEN"] = "api";
    process.env["MOTEBIT_PUBLIC_URL"] = "https://clerk.example";

    const c = loadConfig();
    expect(c.port).toBe(4100);
    expect(c.dbPath).toBe("/tmp/c.db");
    expect(c.dataDir).toBe("/tmp/data");
    expect(c.solanaRpcUrl).toBe("https://rpc.example");
    expect(c.relayPublicKey).toBe("ab".repeat(32));
    expect(c.defaultCapability).toBe("summarize");
    expect(c.ceilingMicro).toBe(250_000);
    expect(c.unitCost).toBe(0.25);
    expect(c.authToken).toBe("tok");
    expect(c.syncUrl).toBe("https://relay.example");
    expect(c.apiToken).toBe("api");
    expect(c.publicUrl).toBe("https://clerk.example");
  });
});
