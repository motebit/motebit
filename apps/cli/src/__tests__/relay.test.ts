// --- Tests for `motebit relay up` config assembly ---
//
// The boot path (createSyncRelay → serve() → SIGINT handlers) is
// exercised by services/api's integration tests. Here we test the
// thin CLI layer on top:
//   - buildRelayConfig: pure CLI-options → SyncRelayConfig mapping
//   - resolveRelayDbPath: precedence flag > env > default subdir
//   - isTestnetNetwork: CAIP-2 testnet matrix
//
// Each test asserts one of the five design answers from the JSDoc
// doctrine at the top of `subcommands/relay.ts`. If a future refactor
// drifts from those answers, one of these tests must change — the
// fail-loud guarantee the block is worth.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildRelayConfig,
  isTestnetNetwork,
  resolveRelayDbPath,
  type RelayCliOptions,
} from "../subcommands/relay.js";

function baseOptions(overrides: Partial<RelayCliOptions> = {}): RelayCliOptions {
  return {
    port: 3000,
    dbPath: "/tmp/motebit-test-relay.db",
    payToAddress: undefined,
    network: "eip155:84532",
    facilitatorUrl: undefined,
    federationUrl: undefined,
    passphrase: undefined,
    corsOrigin: "*",
    ...overrides,
  };
}

describe("buildRelayConfig — design-answer invariants", () => {
  it("answer #2: omitted --pay-to-address maps to empty string (rail silently disabled)", () => {
    // services/api index.ts:371 — `if (x402Config?.payToAddress)` —
    // falsy skips registration. Empty string is the contract.
    const cfg = buildRelayConfig(baseOptions({ payToAddress: undefined }));
    expect(cfg.x402.payToAddress).toBe("");
  });

  it("answer #2: --pay-to-address is threaded through unchanged", () => {
    const addr = "0xaBCDef0123456789012345678901234567890abc";
    const cfg = buildRelayConfig(baseOptions({ payToAddress: addr }));
    expect(cfg.x402.payToAddress).toBe(addr);
  });

  it("answer #3: no --federation-url means federation is undefined (isolated)", () => {
    const cfg = buildRelayConfig(baseOptions({ federationUrl: undefined }));
    expect(cfg.federation).toBeUndefined();
  });

  it("answer #3: --federation-url enables federation and announces the URL", () => {
    const url = "https://my-relay.example.com";
    const cfg = buildRelayConfig(baseOptions({ federationUrl: url }));
    expect(cfg.federation).toBeDefined();
    expect(cfg.federation?.endpointUrl).toBe(url);
    expect(cfg.federation?.enabled).toBe(true);
  });

  it("answer #3: empty --federation-url string is treated as disabled", () => {
    const cfg = buildRelayConfig(baseOptions({ federationUrl: "" }));
    expect(cfg.federation).toBeUndefined();
  });

  it("answer #1: --passphrase maps to relayKeyPassphrase (encryption at rest)", () => {
    const cfg = buildRelayConfig(baseOptions({ passphrase: "correct-horse-battery-staple" }));
    expect(cfg.relayKeyPassphrase).toBe("correct-horse-battery-staple");
  });

  it("answer #1: no --passphrase leaves relayKeyPassphrase undefined (plaintext storage)", () => {
    const cfg = buildRelayConfig(baseOptions({ passphrase: undefined }));
    expect(cfg.relayKeyPassphrase).toBeUndefined();
  });

  it("answer #4: dbPath is threaded through unchanged", () => {
    const dbPath = "/opt/relay/my-relay.db";
    const cfg = buildRelayConfig(baseOptions({ dbPath }));
    expect(cfg.dbPath).toBe(dbPath);
  });

  it("testnet flag inferred from network: Base Sepolia → true", () => {
    const cfg = buildRelayConfig(baseOptions({ network: "eip155:84532" }));
    expect(cfg.x402.network).toBe("eip155:84532");
    expect(cfg.x402.testnet).toBe(true);
  });

  it("testnet flag inferred from network: Base mainnet → false", () => {
    const cfg = buildRelayConfig(baseOptions({ network: "eip155:8453" }));
    expect(cfg.x402.testnet).toBe(false);
  });

  it("facilitator-url flows into x402 config when set", () => {
    const cfg = buildRelayConfig(
      baseOptions({ facilitatorUrl: "https://facilitator.example.com" }),
    );
    expect(cfg.x402.facilitatorUrl).toBe("https://facilitator.example.com");
  });

  it("corsOrigin defaults to * and flows through", () => {
    const cfg = buildRelayConfig(baseOptions({ corsOrigin: "https://app.example.com" }));
    expect(cfg.corsOrigin).toBe("https://app.example.com");
  });
});

describe("isTestnetNetwork", () => {
  it.each([
    ["eip155:84532", true], // Base Sepolia
    ["eip155:421614", true], // Arbitrum Sepolia
    ["eip155:8453", false], // Base mainnet
    ["eip155:42161", false], // Arbitrum mainnet
    ["eip155:1", false], // Ethereum mainnet
    ["solana:mainnet", false], // solana — treated as mainnet (unknown = strict)
  ])("%s → %s", (network, expected) => {
    expect(isTestnetNetwork(network)).toBe(expected);
  });
});

describe("resolveRelayDbPath — answer #4: precedence flag > env > ~/.motebit/relay/relay.db", () => {
  const originalHome = process.env["HOME"];
  const originalEnv = process.env["MOTEBIT_RELAY_DB_PATH"];
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-relay-dbpath-test-"));

  afterEach(() => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (originalEnv !== undefined) process.env["MOTEBIT_RELAY_DB_PATH"] = originalEnv;
    else delete process.env["MOTEBIT_RELAY_DB_PATH"];
  });

  it("explicit override wins over env and default", () => {
    process.env["HOME"] = tmpHome;
    process.env["MOTEBIT_RELAY_DB_PATH"] = "/env/path.db";
    expect(resolveRelayDbPath("/explicit/path.db")).toBe("/explicit/path.db");
  });

  it("env var wins over default when no override", () => {
    process.env["HOME"] = tmpHome;
    process.env["MOTEBIT_RELAY_DB_PATH"] = "/from/env.db";
    expect(resolveRelayDbPath(undefined)).toBe("/from/env.db");
  });

  it("default path lives under ~/.motebit/relay/ and creates the dir", () => {
    process.env["HOME"] = tmpHome;
    delete process.env["MOTEBIT_RELAY_DB_PATH"];
    const resolved = resolveRelayDbPath(undefined);
    expect(resolved).toBe(path.join(tmpHome, ".motebit", "relay", "relay.db"));
    expect(fs.existsSync(path.join(tmpHome, ".motebit", "relay"))).toBe(true);
  });

  it("empty-string override falls through to env", () => {
    process.env["HOME"] = tmpHome;
    process.env["MOTEBIT_RELAY_DB_PATH"] = "/from/env.db";
    expect(resolveRelayDbPath("")).toBe("/from/env.db");
  });
});
