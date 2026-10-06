// --- Tests for `motebit relay up` config assembly ---
//
// The boot path (createSyncRelay → serve() → SIGINT handlers) is
// exercised by services/relay's integration tests. Here we test the
// thin CLI layer on top:
//   - buildRelayConfig: pure CLI-options → SyncRelayConfig mapping
//   - resolveRelayDbPath: precedence flag > env > default subdir
//   - isTestnetNetwork: CAIP-2 testnet matrix
//
// Each test asserts one of the five design answers from the JSDoc
// doctrine at the top of `subcommands/relay.ts`. If a future refactor
// drifts from those answers, one of these tests must change — the
// fail-loud guarantee the block is worth.
//
// `RELAY_DIR` / `RELAY_DB_PATH` in `../config.ts` are module-eval
// constants (derived from `os.homedir()`), so we override `HOME`
// BEFORE importing the module under test. Same dynamic-import
// pattern as `config.test.ts`.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isInsecureDevPosture,
  RelayAuthRefusal,
  type RelayAuthPosture,
  type SyncRelayConfig,
} from "@motebit/relay";
import { SOLANA_MAINNET_CAIP2 } from "@motebit/wallet-solana";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-relay-test-"));
const savedHome = process.env["HOME"];
process.env["HOME"] = tmpHome;

type RelayModule = typeof import("../subcommands/relay.js");
let mod: RelayModule;

beforeAll(async () => {
  mod = await import("../subcommands/relay.js");
});

afterAll(() => {
  if (savedHome !== undefined) process.env["HOME"] = savedHome;
  else delete process.env["HOME"];
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

interface BaseOpts {
  port: number;
  dbPath: string;
  payToAddress: string | undefined;
  network: string;
  facilitatorUrl: string | undefined;
  federationUrl: string | undefined;
  passphrase: string | undefined;
  corsOrigin: string;
  apiToken: string | undefined;
  authPosture: RelayAuthPosture;
}

function baseOptions(overrides: Partial<BaseOpts> = {}): BaseOpts {
  return {
    port: 3000,
    dbPath: "/tmp/motebit-test-relay.db",
    payToAddress: undefined,
    network: "eip155:84532",
    facilitatorUrl: undefined,
    federationUrl: undefined,
    passphrase: undefined,
    corsOrigin: "*",
    apiToken: "relay-up-test-token",
    authPosture: { kind: "token", token: "relay-up-test-token", source: "env" },
    ...overrides,
  };
}

describe("relay up — the master token is never absent by default", () => {
  // `motebit relay up` used to build its relay with no `apiToken` at all, so
  // every master-token route (admin freeze, fee and withdrawal dashboards,
  // memory/state/audit exports, sync) was open on the port it bound.
  it("buildRelayConfig threads the token and the decided posture through", () => {
    const cfg = mod.buildRelayConfig(baseOptions({ apiToken: "t0k" }));
    expect(cfg.apiToken).toBe("t0k");
    expect(isInsecureDevPosture(cfg.authPosture)).toBe(false);
    const auth = mod.resolveRelayApiToken(":memory:", {
      NODE_ENV: "development",
      MOTEBIT_RELAY_INSECURE_NO_AUTH: "1",
    });
    const open = mod.buildRelayConfig(
      baseOptions({ apiToken: auth.apiToken, authPosture: auth.authPosture }),
    );
    expect(open.apiToken).toBeUndefined();
    expect(isInsecureDevPosture(open.authPosture)).toBe(true);
  });

  it("MOTEBIT_API_TOKEN wins", () => {
    const dir = fs.mkdtempSync(path.join(tmpHome, "tok-"));
    const r = mod.resolveRelayApiToken(path.join(dir, "relay.db"), {
      MOTEBIT_API_TOKEN: "env-tok",
    });
    expect(r.apiToken).toBe("env-tok");
    expect(r.source).toBe("env");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("no token: generates one owner-only beside the database, and reuses it", () => {
    const dir = fs.mkdtempSync(path.join(tmpHome, "tok-"));
    const db = path.join(dir, "relay.db");
    const first = mod.resolveRelayApiToken(db, {});
    expect(first.source).toBe("generated");
    expect(first.apiToken).toMatch(/^[0-9a-f]{64}$/);
    expect(first.authPosture.kind).toBe("token");
    const file = mod.relayApiTokenPath(db);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const second = mod.resolveRelayApiToken(db, {});
    expect(second.apiToken).toBe(first.apiToken);
    expect(second.source).toBe("file");
  });

  it("an empty MOTEBIT_API_TOKEN is not a token", () => {
    const dir = fs.mkdtempSync(path.join(tmpHome, "tok-"));
    const r = mod.resolveRelayApiToken(path.join(dir, "relay.db"), { MOTEBIT_API_TOKEN: "" });
    expect(r.source).toBe("generated");
  });

  it("MOTEBIT_RELAY_INSECURE_NO_AUTH=1 under NODE_ENV=development is the only way to run it open", () => {
    const dir = fs.mkdtempSync(path.join(tmpHome, "tok-"));
    const r = mod.resolveRelayApiToken(path.join(dir, "relay.db"), {
      NODE_ENV: "development",
      MOTEBIT_RELAY_INSECURE_NO_AUTH: "1",
    });
    expect(r.apiToken).toBeUndefined();
    expect(r.source).toBe("insecure");
    expect(isInsecureDevPosture(r.authPosture)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // The cold review's wrong answer: `relay up` read the opt-in on its own and
  // skipped the production refusal, so NODE_ENV=production + the flag booted
  // an open relay. The CLI now asks the relay's ONE decision function.
  for (const nodeEnv of ["production", "Production", "production ", "staging", undefined]) {
    it(`the opt-in is refused under NODE_ENV=${JSON.stringify(nodeEnv)}, token or not, writing nothing`, () => {
      const dir = fs.mkdtempSync(path.join(tmpHome, "tok-"));
      for (const token of [undefined, "env-tok"]) {
        const env: Record<string, string | undefined> = { MOTEBIT_RELAY_INSECURE_NO_AUTH: "1" };
        if (nodeEnv !== undefined) env["NODE_ENV"] = nodeEnv;
        if (token !== undefined) env["MOTEBIT_API_TOKEN"] = token;
        expect(() => mod.resolveRelayApiToken(path.join(dir, "relay.db"), env)).toThrow(
          RelayAuthRefusal,
        );
      }
      expect(fs.readdirSync(dir)).toEqual([]);
    });
  }
});

describe("relay up — the CLI slice of the auth-posture boot matrix", () => {
  // services/relay `auth-posture-boot-matrix.test.ts` boots every cell of this
  // decision (with the CLI's token-file fallback) and probes every protected
  // route; this slice pins that `relay up` composes exactly that decision.
  const NODE_ENVS = [
    "production",
    "Production",
    "production ",
    "staging",
    undefined,
    "development",
    "test",
  ];
  const TOKENS = [undefined, "", "   ", "matrix-token"];
  const FLAGS = [undefined, "1", "ture"];
  for (const nodeEnv of NODE_ENVS) {
    it(`NODE_ENV=${JSON.stringify(nodeEnv)}: every token × flag cell matches the boot table`, () => {
      const wrong: string[] = [];
      for (const token of TOKENS) {
        for (const flag of FLAGS) {
          const env: Record<string, string | undefined> = {};
          if (nodeEnv !== undefined) env["NODE_ENV"] = nodeEnv;
          if (token !== undefined) env["MOTEBIT_API_TOKEN"] = token;
          if (flag !== undefined) env["MOTEBIT_RELAY_INSECURE_NO_AUTH"] = flag;
          const dev = ["development", "test"].includes(nodeEnv?.trim().toLowerCase() ?? "");
          const want =
            flag === "ture" || (flag === "1" && !dev)
              ? "refuse"
              : token != null && token.trim() !== ""
                ? "env"
                : flag === "1"
                  ? "insecure"
                  : "ephemeral";
          let got: string;
          try {
            const r = mod.resolveRelayApiToken(":memory:", env);
            const cfg = mod.buildRelayConfig(
              baseOptions({ dbPath: ":memory:", apiToken: r.apiToken, authPosture: r.authPosture }),
            );
            if (cfg.authPosture !== r.authPosture || cfg.apiToken !== r.apiToken)
              got = "config-drift";
            else if (r.source === "insecure" && !isInsecureDevPosture(cfg.authPosture))
              got = "unminted";
            else if (r.source !== "insecure" && (r.apiToken ?? "").trim() === "") got = "no-token";
            else got = r.source;
          } catch (err) {
            got = err instanceof RelayAuthRefusal ? "refuse" : `threw ${String(err)}`;
          }
          if (got !== want)
            wrong.push(
              `token=${JSON.stringify(token)} flag=${JSON.stringify(flag)}: want ${want}, got ${got}`,
            );
        }
      }
      expect(wrong).toEqual([]);
    });
  }
});

describe("buildRelayConfig — design-answer invariants", () => {
  it("answer #2: omitted --pay-to-address maps to empty string (rail silently disabled)", () => {
    // services/relay index.ts:371 — `if (x402Config?.payToAddress)` —
    // falsy skips registration. Empty string is the contract.
    const cfg: SyncRelayConfig = mod.buildRelayConfig(baseOptions({ payToAddress: undefined }));
    expect(cfg.x402.payToAddress).toBe("");
  });

  it("answer #2: --pay-to-address is threaded through unchanged", () => {
    const addr = "0xaBCDef0123456789012345678901234567890abc";
    const cfg = mod.buildRelayConfig(baseOptions({ payToAddress: addr }));
    expect(cfg.x402.payToAddress).toBe(addr);
  });

  it("answer #3: no --federation-url means federation is undefined (isolated)", () => {
    const cfg = mod.buildRelayConfig(baseOptions({ federationUrl: undefined }));
    expect(cfg.federation).toBeUndefined();
  });

  it("answer #3: --federation-url enables federation and announces the URL", () => {
    const url = "https://my-relay.example.com";
    const cfg = mod.buildRelayConfig(baseOptions({ federationUrl: url }));
    expect(cfg.federation).toBeDefined();
    expect(cfg.federation?.endpointUrl).toBe(url);
    expect(cfg.federation?.enabled).toBe(true);
  });

  it("answer #3: empty --federation-url string is treated as disabled", () => {
    const cfg = mod.buildRelayConfig(baseOptions({ federationUrl: "" }));
    expect(cfg.federation).toBeUndefined();
  });

  it("answer #1: --passphrase maps to relayKeyPassphrase (encryption at rest)", () => {
    const cfg = mod.buildRelayConfig(baseOptions({ passphrase: "correct-horse-battery-staple" }));
    expect(cfg.relayKeyPassphrase).toBe("correct-horse-battery-staple");
  });

  it("answer #1: no --passphrase leaves relayKeyPassphrase undefined (plaintext storage)", () => {
    const cfg = mod.buildRelayConfig(baseOptions({ passphrase: undefined }));
    expect(cfg.relayKeyPassphrase).toBeUndefined();
  });

  it("answer #4: dbPath is threaded through unchanged", () => {
    const dbPath = "/opt/relay/my-relay.db";
    const cfg = mod.buildRelayConfig(baseOptions({ dbPath }));
    expect(cfg.dbPath).toBe(dbPath);
  });

  it("testnet flag inferred from network: Base Sepolia → true", () => {
    const cfg = mod.buildRelayConfig(baseOptions({ network: "eip155:84532" }));
    expect(cfg.x402.network).toBe("eip155:84532");
    expect(cfg.x402.testnet).toBe(true);
  });

  it("testnet flag inferred from network: Base mainnet → false", () => {
    const cfg = mod.buildRelayConfig(baseOptions({ network: "eip155:8453" }));
    expect(cfg.x402.testnet).toBe(false);
  });

  it("facilitator-url flows into x402 config when set", () => {
    const cfg = mod.buildRelayConfig(
      baseOptions({ facilitatorUrl: "https://facilitator.example.com" }),
    );
    expect(cfg.x402.facilitatorUrl).toBe("https://facilitator.example.com");
  });

  it("corsOrigin defaults to * and flows through", () => {
    const cfg = mod.buildRelayConfig(baseOptions({ corsOrigin: "https://app.example.com" }));
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
    [SOLANA_MAINNET_CAIP2, false], // Solana mainnet (CAIP-30) — out of scope for the EVM-only testnet check; defaults to false (strict)
  ])("%s → %s", (network, expected) => {
    expect(mod.isTestnetNetwork(network)).toBe(expected);
  });
});

describe("resolveRelayDbPath — answer #4: precedence flag > env > RELAY_DB_PATH (under CONFIG_DIR)", () => {
  const originalEnv = process.env["MOTEBIT_RELAY_DB_PATH"];

  afterEach(() => {
    if (originalEnv !== undefined) process.env["MOTEBIT_RELAY_DB_PATH"] = originalEnv;
    else delete process.env["MOTEBIT_RELAY_DB_PATH"];
  });

  it("explicit override wins over env and default", () => {
    process.env["MOTEBIT_RELAY_DB_PATH"] = "/env/path.db";
    expect(mod.resolveRelayDbPath("/explicit/path.db")).toBe("/explicit/path.db");
  });

  it("env var wins over default when no override", () => {
    process.env["MOTEBIT_RELAY_DB_PATH"] = "/from/env.db";
    expect(mod.resolveRelayDbPath(undefined)).toBe("/from/env.db");
  });

  it("default path is RELAY_DB_PATH (~/.motebit/relay/relay.db, via CONFIG_DIR) and creates the dir", () => {
    delete process.env["MOTEBIT_RELAY_DB_PATH"];
    const resolved = mod.resolveRelayDbPath(undefined);
    expect(resolved).toBe(path.join(tmpHome, ".motebit", "relay", "relay.db"));
    expect(fs.existsSync(path.join(tmpHome, ".motebit", "relay"))).toBe(true);
  });

  it("empty-string override falls through to env", () => {
    process.env["MOTEBIT_RELAY_DB_PATH"] = "/from/env.db";
    expect(mod.resolveRelayDbPath("")).toBe("/from/env.db");
  });
});
