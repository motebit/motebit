/**
 * Effective-configuration tests — the strong enforcement layer of the
 * security-default harness.
 *
 * These drive the REAL production config builder (`buildRelayConfigFromEnv`,
 * the exact function `server.ts` calls) under crafted env maps and assert the
 * EFFECTIVE value the deployed process would compute — the layer that was
 * missing when #346 shipped the discover-signature sunset inert (the sunset
 * test asserted the constant; nothing asserted the built config). Every
 * registered `SECURITY_BOUNDARY_DEFAULTS` boundary is covered by construction:
 * add a boundary to the registry and it is automatically asserted here.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  buildRelayConfigFromEnv,
  SECURITY_BOUNDARY_DEFAULTS,
  MINIMAL_VALID_RELAY_ENV,
  probeSecurityBoundaries,
} from "../relay-config.js";
import type { EnvSource } from "../env.js";
import { DEFAULT_REQUIRE_DISCOVER_SIGNATURE } from "../federation.js";
import { createTestRelay } from "./test-helpers.js";
import type { SyncRelay } from "../index.js";

const DEPS = { getShuttingDown: () => false } as const;

/**
 * A baseline env in which every federation-scoped boundary is REACHABLE
 * (federation enabled) but no security env var is set — so the effective
 * config must fall to the strict default for every boundary. This is the
 * exact shape a production relay boots with when an operator has not
 * explicitly opted out of any boundary.
 */
function federationEnabledEnvWithNoSecurityOverrides(): EnvSource {
  return {
    ...MINIMAL_VALID_RELAY_ENV,
    MOTEBIT_FEDERATION_ENDPOINT_URL: "https://relay.example",
  };
}

describe("buildRelayConfigFromEnv — effective security-boundary defaults", () => {
  it("every registered boundary falls to its strict value when its env var is unset (the #346 regression)", () => {
    const cfg = buildRelayConfigFromEnv(federationEnabledEnvWithNoSecurityOverrides(), DEPS);
    for (const b of SECURITY_BOUNDARY_DEFAULTS) {
      const effective = b.effectiveValue(cfg);
      expect(
        effective,
        `${b.boundary} (${b.envVar}) must be present in the built config`,
      ).toBeTypeOf("boolean");
      expect(
        effective,
        `${b.boundary} (${b.envVar}) must be ${b.strictWhenUnset} when unset — a shadowing literal or dropped wiring here is a production fail-open`,
      ).toBe(b.strictWhenUnset);
    }
  });

  it("the discover-signature default tracks the canonical sunset constant, not a literal", () => {
    const cfg = buildRelayConfigFromEnv(federationEnabledEnvWithNoSecurityOverrides(), DEPS);
    // If the sunset constant is ever flipped back, this effective value moves
    // with it — proving single-source-of-truth (a test on the constant is a
    // test on production).
    expect(cfg.federation?.requireDiscoverSignature).toBe(DEFAULT_REQUIRE_DISCOVER_SIGNATURE);
    expect(cfg.federation?.requireDiscoverSignature).toBe(true);
  });

  it("an explicit opt-out env var overrides the strict default (config-restorable)", () => {
    const env = {
      ...federationEnabledEnvWithNoSecurityOverrides(),
      MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE: "false",
      MOTEBIT_ENABLE_DEVICE_AUTH: "false",
      MOTEBIT_FEDERATION_AUTO_ACCEPT: "true",
    };
    const cfg = buildRelayConfigFromEnv(env, DEPS);
    expect(cfg.federation?.requireDiscoverSignature).toBe(false);
    expect(cfg.enableDeviceAuth).toBe(false);
    expect(cfg.federation?.autoAcceptPeers).toBe(true);
  });

  it("throws when the required x402 pay-to address is absent (pure config validation)", () => {
    expect(() => buildRelayConfigFromEnv({}, DEPS)).toThrow(/X402_PAY_TO_ADDRESS is required/);
  });

  it("federation-scoped boundaries read undefined when federation is disabled (not-applicable, not fail-open)", () => {
    const cfg = buildRelayConfigFromEnv(MINIMAL_VALID_RELAY_ENV, DEPS);
    expect(cfg.federation).toBeUndefined();
    // The registry accessor returns undefined — the effective-config test above
    // uses a federation-enabled env precisely so these are reachable-and-strict.
    const discoverSig = SECURITY_BOUNDARY_DEFAULTS.find(
      (b) => b.envVar === "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
    );
    expect(discoverSig?.effectiveValue(cfg)).toBeUndefined();
  });

  it("passes the runtime deps through untouched (shutdown getter, test vote policy)", () => {
    const getShuttingDown = (): boolean => true;
    const cfg = buildRelayConfigFromEnv(MINIMAL_VALID_RELAY_ENV, {
      getShuttingDown,
      testVotePolicy: "upheld",
    });
    expect(cfg.getShuttingDown).toBe(getShuttingDown);
    expect(cfg.testVotePolicy).toBe("upheld");
  });
});

describe("probeSecurityBoundaries — deployed-behavior layer", () => {
  it("asserts strict when the running relay returns the strict status", async () => {
    const fetchImpl = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    const results = await probeSecurityBoundaries("https://relay.example", {
      federationEnabled: true,
      fetchImpl,
    });
    const discover = results.find(
      (r) => r.envVar === "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
    );
    expect(discover?.strict).toBe(true);
    expect(discover?.skipped).toBe(false);
  });

  it("catches a fail-open relay (strict endpoint returning 200)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ agents: [] }), { status: 200 })) as unknown as typeof fetch;
    const results = await probeSecurityBoundaries("https://relay.example", {
      federationEnabled: true,
      fetchImpl,
    });
    const discover = results.find(
      (r) => r.envVar === "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
    );
    expect(discover?.strict).toBe(false); // 200 ≠ expected 403 → not strict → the #346 live symptom
  });

  it("skips federation-scoped probes when federation is disabled (unreachable, not failed)", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const results = await probeSecurityBoundaries("https://relay.example", {
      federationEnabled: false,
      fetchImpl,
    });
    const discover = results.find(
      (r) => r.envVar === "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
    );
    expect(discover?.skipped).toBe(true);
  });
});

describe("probeSecurityBoundaries against a REAL booted relay (the capstone: helper × artifact agree)", () => {
  let relay: SyncRelay | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it("a federation-enabled relay built with the strict default rejects the probe → strict", async () => {
    // Boot an actual relay (the same createSyncRelay the production builder
    // feeds) with federation enabled and the discover-signature default at its
    // strict value — then run the SAME probe helper used against prod, routed
    // to the booted app. This closes the deployed-behavior layer against a
    // real artifact, not a mock: the harness's three layers (static gate,
    // effective-config unit, deployed probe) all agree on one registry.
    relay = await createTestRelay({
      enableDeviceAuth: false,
      federation: { endpointUrl: "http://relay.test:3000", displayName: "Probe" },
    });
    const app = relay.app;
    const routed = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      return app.request(path, init);
    }) as unknown as typeof fetch;

    const results = await probeSecurityBoundaries("http://relay.test", {
      federationEnabled: true,
      fetchImpl: routed,
    });
    const discover = results.find(
      (r) => r.envVar === "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
    );
    expect(
      discover,
      "discover-signature probe must run against a federation-enabled relay",
    ).toBeDefined();
    expect(discover!.skipped).toBe(false);
    expect(discover!.strict, discover!.detail).toBe(true);
  });

  it("the SAME relay under an explicit tolerant opt-out fails the probe → not strict (proves the probe discriminates)", async () => {
    relay = await createTestRelay({
      enableDeviceAuth: false,
      federation: {
        endpointUrl: "http://relay.test:3000",
        displayName: "Probe",
        requireDiscoverSignature: false,
      },
    });
    const app = relay.app;
    const routed = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      return app.request(path, init);
    }) as unknown as typeof fetch;

    const results = await probeSecurityBoundaries("http://relay.test", {
      federationEnabled: true,
      fetchImpl: routed,
    });
    const discover = results.find(
      (r) => r.envVar === "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
    );
    // Tolerant relay accepts the unsigned probe (not 403) → the probe correctly
    // reports not-strict. This is the exact live symptom #346 had in prod.
    expect(discover!.strict).toBe(false);
  });
});
