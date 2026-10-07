/**
 * Every relay env var that moves money, sets a fee/credit/budget/cap/interval
 * on the money path, or is a safety switch, crossed with one malformed corpus.
 *
 * The law (S2): a malformed money or kill-switch setting refuses to boot and
 * never authorizes. A value the relay would have to guess at (`0x10`, `1e300`,
 * `ture`) is an operator error the process names and dies on — never a
 * default, never a number `Number()` happened to accept.
 *
 * Each cell drives the REAL production path: `buildRelayConfigFromEnv` (what
 * `server.ts` calls with `process.env`) and, for the variables `createSyncRelay`
 * also reads from `process.env` in library mode, `createSyncRelay` itself.
 * Expectations are written per kind below, never derived from the parser.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRelayConfigFromEnv, MINIMAL_VALID_RELAY_ENV } from "../relay-config.js";
import { createSyncRelay, type SyncRelayConfig } from "../index.js";
import { grantFreeCreditIfEligible } from "../free-credit.js";
import type { EnvSource } from "../env.js";
import { API_TOKEN, AUTH_HEADER, X402_TEST_CONFIG, TEST_RELAY_NETWORK } from "./test-helpers.js";

type Kind = "bool" | "int" | "money" | "rate";

/** A refusal the boot must raise for a well-formed-but-incomplete env (not this variable's fault). */
interface RefusesNaming {
  refusesNaming: string;
}
type Expected = unknown;

interface VarSpec {
  name: string;
  kind: Kind;
  /** Base env this variable is exercised on (defaults to the minimal valid relay env). */
  base?: EnvSource;
  read: (cfg: SyncRelayConfig) => unknown;
  /** Effective value when unset. */
  unset: Expected;
  /** Well-formed spellings beyond the shared corpus, with the exact parsed value. */
  wellFormed: Array<[string, Expected]>;
  /** Read again by `createSyncRelay` from `process.env` in library mode. */
  libraryMode?: boolean;
}

const FED: EnvSource = {
  ...MINIMAL_VALID_RELAY_ENV,
  MOTEBIT_FEDERATION_ENDPOINT_URL: "https://relay.example.test",
};

/** The inventory. A new money / safety env var is one row here. */
const VARS: VarSpec[] = [
  // ── safety switches and security booleans ─────────────────────────────────
  {
    name: "MOTEBIT_EMERGENCY_FREEZE",
    kind: "bool",
    read: (c) => c.emergencyFreeze,
    unset: false,
    wellFormed: [
      ["true", true],
      ["1", true],
      ["false", false],
      ["0", false],
      ["FALSE", false],
    ],
  },
  {
    name: "MOTEBIT_ENABLE_DEVICE_AUTH",
    kind: "bool",
    read: (c) => c.enableDeviceAuth,
    unset: true,
    wellFormed: [
      ["false", false],
      ["0", false],
      ["true", true],
    ],
  },
  {
    name: "MOTEBIT_ALLOW_PRIVATE_ENDPOINTS",
    kind: "bool",
    read: (c) => c.allowPrivateEndpoints,
    unset: false,
    wellFormed: [
      ["true", true],
      ["0", false],
    ],
    libraryMode: true,
  },
  {
    name: "MOTEBIT_RELAY_ISSUE_CREDENTIALS",
    kind: "bool",
    read: (c) => c.issueCredentials,
    unset: false,
    wellFormed: [
      ["1", true],
      ["false", false],
    ],
    libraryMode: true,
  },
  {
    name: "X402_TESTNET",
    kind: "bool",
    read: (c) => c.x402.testnet,
    unset: true,
    wellFormed: [
      ["false", false],
      ["0", false],
      ["true", true],
    ],
  },
  {
    name: "MOTEBIT_FEDERATION_ENABLED",
    kind: "bool",
    base: FED,
    read: (c) => c.federation?.enabled,
    unset: true,
    wellFormed: [
      ["false", false],
      ["1", true],
    ],
  },
  {
    name: "MOTEBIT_FEDERATION_AUTO_ACCEPT",
    kind: "bool",
    base: FED,
    read: (c) => c.federation?.autoAcceptPeers,
    unset: false,
    wellFormed: [
      ["true", true],
      ["0", false],
    ],
  },
  {
    name: "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
    kind: "bool",
    base: FED,
    read: (c) => c.federation?.requireDiscoverSignature,
    unset: true,
    wellFormed: [
      ["false", false],
      ["1", true],
    ],
  },
  {
    // The open-relay opt-in: ON yields the insecure dev posture (NODE_ENV=test,
    // no token); OFF leaves the relay without a token, so it refuses on the
    // TOKEN — a well-formed OFF is never this variable's refusal.
    name: "MOTEBIT_RELAY_INSECURE_NO_AUTH",
    kind: "bool",
    base: { X402_PAY_TO_ADDRESS: MINIMAL_VALID_RELAY_ENV.X402_PAY_TO_ADDRESS, NODE_ENV: "test" },
    read: (c) => c.authPosture?.kind,
    unset: { refusesNaming: "MOTEBIT_API_TOKEN" } satisfies RefusesNaming,
    wellFormed: [
      ["1", "insecure-dev"],
      ["true", "insecure-dev"],
      ["0", { refusesNaming: "MOTEBIT_API_TOKEN" }],
    ],
  },
  // ── fee rate ──────────────────────────────────────────────────────────────
  {
    name: "MOTEBIT_PLATFORM_FEE_RATE",
    kind: "rate",
    read: (c) => c.platformFeeRate,
    unset: 0.05,
    wellFormed: [
      ["0.05", 0.05],
      ["0", 0],
      ["0.1", 0.1],
      ["0.123456", 0.123456],
      [" 0.05 ", 0.05],
    ],
    libraryMode: true,
  },
  // ── free credit (money in USD, cap as integer count) ──────────────────────
  {
    name: "MOTEBIT_FREE_CREDIT_USD",
    kind: "money",
    read: (c) => c.freeCredit?.amountMicro,
    unset: 0,
    wellFormed: [
      ["0", 0],
      ["0.10", 100_000],
      ["0.000001", 1],
      ["2", 2_000_000],
    ],
    libraryMode: true,
  },
  {
    name: "MOTEBIT_FREE_CREDIT_DAILY_BUDGET_USD",
    kind: "money",
    read: (c) => c.freeCredit?.dailyBudgetMicro,
    unset: 25_000_000,
    wellFormed: [
      ["25", 25_000_000],
      ["0", 0],
      ["0.25", 250_000],
      ["1000.000001", 1_000_000_001],
    ],
    libraryMode: true,
  },
  {
    name: "MOTEBIT_FREE_CREDIT_IP_DAILY_CAP",
    kind: "int",
    read: (c) => c.freeCredit?.ipDailyCap,
    unset: 10,
    wellFormed: [
      ["10", 10],
      ["0", 0],
      ["1000", 1000],
    ],
    libraryMode: true,
  },
  // ── integer limits / money-path loop cadences ─────────────────────────────
  {
    name: "MOTEBIT_FEDERATION_MAX_PEERS",
    kind: "int",
    base: FED,
    read: (c) => c.federation?.maxPeers,
    unset: undefined,
    wellFormed: [
      ["50", 50],
      ["0", 0],
      ["10000", 10000],
    ],
  },
  {
    name: "MOTEBIT_TREASURY_RECONCILIATION_INTERVAL_MS",
    kind: "int",
    read: (c) => c.treasuryReconciliationIntervalMs,
    unset: 15 * 60_000,
    wellFormed: [
      ["1", 1],
      ["200", 200],
      ["900000", 900_000],
      ["86400000", 86_400_000],
    ],
    libraryMode: true,
  },
  {
    name: "MOTEBIT_X402_RECONCILIATION_INTERVAL_MS",
    kind: "int",
    read: (c) => c.x402ReconciliationIntervalMs,
    unset: 60_000,
    wellFormed: [["60000", 60_000]],
    libraryMode: true,
  },
  {
    name: "MOTEBIT_SOLANA_TREASURY_RECONCILIATION_INTERVAL_MS",
    kind: "int",
    read: (c) => c.solanaTreasuryReconciliationIntervalMs,
    unset: 15 * 60_000,
    wellFormed: [["120000", 120_000]],
    libraryMode: true,
  },
];

/** The shared malformed corpus — every variable sees every entry. */
const CORPUS = [
  "",
  " ",
  "0x10",
  "1e300",
  "1e6",
  "-5",
  "+5",
  "1.5",
  "1.0000001",
  "12abc",
  "1_000",
  "NaN",
  "Infinity",
  "9007199254740993",
  "ture",
  "y",
  "enabled",
  "TRUE ",
] as const;

/**
 * Which corpus entries are WELL-FORMED for a kind, and what they parse to.
 * Booleans: empty / whitespace is "unset" (the documented default); `TRUE ` is
 * `true` after trim + lowercase. Money: `1.5` is $1.50. Everything else in the
 * corpus is malformed for every kind.
 */
function corpusExpectation(
  spec: VarSpec,
  raw: string,
): { ok: true; value: Expected } | { ok: false } {
  if (spec.kind === "bool") {
    if (raw.trim() === "") return { ok: true, value: spec.unset };
    if (raw === "TRUE ")
      return { ok: true, value: spec.wellFormed.find(([r]) => r === "true" || r === "1")![1] };
  }
  if (spec.kind === "money" && raw === "1.5") return { ok: true, value: 1_500_000 };
  return { ok: false };
}

function boot(spec: VarSpec, raw: string | undefined): () => SyncRelayConfig {
  const env: EnvSource = { ...(spec.base ?? MINIMAL_VALID_RELAY_ENV) };
  if (raw !== undefined) env[spec.name] = raw;
  return () => buildRelayConfigFromEnv(env, { getShuttingDown: () => false });
}

function captureRefusal(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function assertBoots(spec: VarSpec, raw: string | undefined, expected: Expected): void {
  const label = `${spec.name}=${JSON.stringify(raw)}`;
  if (
    expected !== null &&
    typeof expected === "object" &&
    "refusesNaming" in (expected as object)
  ) {
    const err = captureRefusal(boot(spec, raw));
    expect(
      err,
      `${label} must refuse (on ${(expected as RefusesNaming).refusesNaming})`,
    ).not.toBeNull();
    expect(err!.message, label).toContain((expected as RefusesNaming).refusesNaming);
    return;
  }
  const err = captureRefusal(boot(spec, raw));
  expect(err?.message ?? null, `${label} must boot`).toBeNull();
  expect(spec.read(boot(spec, raw)()), `${label} parsed value`).toEqual(expected);
}

function assertRefuses(spec: VarSpec, raw: string, fn: () => unknown): void {
  const label = `${spec.name}=${JSON.stringify(raw)}`;
  const err = captureRefusal(fn);
  expect(err, `${label} must refuse to boot, it booted`).not.toBeNull();
  expect(err!.name, `${label} refusal is a named boot error`).toMatch(
    /^Relay(EnvConfigError|AuthRefusal)$/,
  );
  expect(err!.message, `${label} refusal names the variable`).toContain(spec.name);
}

describe("relay money / safety env — malformed refuses to boot, well-formed boots exactly", () => {
  for (const spec of VARS) {
    describe(`${spec.name} (${spec.kind})`, () => {
      it("unset → documented default", () => {
        assertBoots(spec, undefined, spec.unset);
      });
      for (const [raw, value] of spec.wellFormed) {
        it(`well-formed ${JSON.stringify(raw)} → ${JSON.stringify(value)}`, () => {
          assertBoots(spec, raw, value);
        });
      }
      for (const raw of CORPUS) {
        const exp = corpusExpectation(spec, raw);
        if (exp.ok) {
          it(`corpus ${JSON.stringify(raw)} is well-formed → ${JSON.stringify(exp.value)}`, () => {
            assertBoots(spec, raw, exp.value);
          });
        } else {
          it(`corpus ${JSON.stringify(raw)} refuses to boot (buildRelayConfigFromEnv)`, () => {
            assertRefuses(spec, raw, boot(spec, raw));
          });
        }
      }
    });
  }
});

describe("relay money / safety env — createSyncRelay library mode reads process.env strictly too", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const representative: Record<Kind, string[]> = {
    bool: ["ture", "y"],
    int: ["0x10", "12abc", "1e6"],
    money: ["0x10", "1e300", "1.0000001"],
    rate: ["0x10", "1e300", "1"],
  };
  for (const spec of VARS.filter((s) => s.libraryMode)) {
    for (const raw of representative[spec.kind]) {
      it(`${spec.name}=${JSON.stringify(raw)} refuses createSyncRelay`, async () => {
        vi.stubEnv(spec.name, raw);
        const cfg: SyncRelayConfig = {
          apiToken: API_TOKEN,
          x402: X402_TEST_CONFIG,
          x402ChainReader: null,
          ...TEST_RELAY_NETWORK,
          drainGraceMs: 10,
        };
        let relay: Awaited<ReturnType<typeof createSyncRelay>> | null = null;
        let err: Error | null = null;
        try {
          relay = await createSyncRelay(cfg);
        } catch (e) {
          err = e instanceof Error ? e : new Error(String(e));
        } finally {
          await relay?.close();
        }
        expect(err, `${spec.name}=${JSON.stringify(raw)} booted a library relay`).not.toBeNull();
        expect(err!.name).toBe("RelayEnvConfigError");
        expect(err!.message).toContain(spec.name);
      });
    }
  }
});

describe("relay money / safety env — execution", () => {
  const cfgFrom = (extra: EnvSource): SyncRelayConfig =>
    buildRelayConfigFromEnv(
      { ...MINIMAL_VALID_RELAY_ENV, ...extra },
      { getShuttingDown: () => false },
    );

  it("a free-credit grant can never exceed the configured daily budget", async () => {
    const cfg = cfgFrom({
      MOTEBIT_FREE_CREDIT_USD: "0.10",
      MOTEBIT_FREE_CREDIT_DAILY_BUDGET_USD: "0.25",
      MOTEBIT_FREE_CREDIT_IP_DAILY_CAP: "100",
    });
    const relay = await createSyncRelay({
      ...cfg,
      x402: X402_TEST_CONFIG,
      x402ChainReader: null,
      ...TEST_RELAY_NETWORK,
      drainGraceMs: 10,
    });
    try {
      const nowMs = Date.parse("2026-10-06T12:00:00Z");
      const granted: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = grantFreeCreditIfEligible(relay.moteDb.db, `m-budget-${i}`, "203.0.113.7", {
          config: cfg.freeCredit,
          nowMs,
        });
        if (r.granted) granted.push(r.amountMicro);
      }
      const total = granted.reduce((a, b) => a + b, 0);
      expect(granted, "two $0.10 grants fit in a $0.25 budget; the third is refused").toEqual([
        100_000, 100_000,
      ]);
      expect(total).toBeLessThanOrEqual(250_000);
    } finally {
      await relay.close();
    }
    // The reproduced over-budget cell: a 1e300 budget refuses to boot.
    const err = captureRefusal(() =>
      cfgFrom({ MOTEBIT_FREE_CREDIT_USD: "5", MOTEBIT_FREE_CREDIT_DAILY_BUDGET_USD: "1e300" }),
    );
    expect(err?.message ?? "booted").toContain("MOTEBIT_FREE_CREDIT_DAILY_BUDGET_USD");
  });

  it("MOTEBIT_EMERGENCY_FREEZE=true boots frozen and blocks a money route", async () => {
    const cfg = cfgFrom({ MOTEBIT_EMERGENCY_FREEZE: "true", MOTEBIT_API_TOKEN: API_TOKEN });
    const relay = await createSyncRelay({
      ...cfg,
      x402: X402_TEST_CONFIG,
      x402ChainReader: null,
      ...TEST_RELAY_NETWORK,
      drainGraceMs: 10,
    });
    try {
      expect(relay.emergencyFreeze).toBe(true);
      const res = await relay.app.request("/api/v1/agents/m-frozen/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({
          amount: 1,
          destination: "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UFZFZ",
        }),
      });
      const body = await res.text();
      expect(res.status, body).toBe(503);
      expect(body).toContain("emergency freeze");
    } finally {
      await relay.close();
    }
  });
});
