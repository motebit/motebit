/**
 * Rotation never strands funds — the CLI's `performRotation` (what
 * `motebit rotate` runs) against a REAL in-process relay.
 *
 * Same table as surface-kit's harness: {empty, SOL only, USDC only, another
 * SPL token, balance read failing} × {no acknowledgment, `--abandon-funds`}.
 * A refusal must land before a key is minted, a write-ahead is written, the
 * relay is contacted, or the config (which erases the retired key on a
 * recorded rotation) is touched.
 */
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { generate } from "@motebit/identity-file";
import {
  deriveSovereignMotebitId,
  generateKeypair,
  bytesToHex,
  base58btcEncode,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";

import type { FullConfig } from "../config.js";
import { encryptPrivateKey } from "../identity.js";
import {
  clearPendingRotation,
  setAsidePendingRotation,
  loadAnyPendingRotation,
  loadPendingRotation,
  pendingRotationPath,
  savePendingRotation,
} from "../pending-rotation.js";
import { registerWithRelay } from "../relay-registration.js";
import { performRotation, type RotationDeps } from "../rotation.js";

const PASS = "correct horse";
const SYNC_URL = "http://relay.test";
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_MINT = "So1aNaOtherTokenMint1111111111111111111111";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

interface Holdings {
  solLamports: bigint;
  tokens: { mint: string; amount: bigint; decimals: number }[];
}

const SCENARIOS: {
  name: string;
  holdings: Holdings | Error;
  refusal: null | { state: "funds-at-risk" | "funds-unknown"; mentions: RegExp[] };
}[] = [
  { name: "empty", holdings: { solLamports: 0n, tokens: [] }, refusal: null },
  {
    name: "SOL only",
    holdings: { solLamports: 1_500_000_000n, tokens: [] },
    refusal: { state: "funds-at-risk", mentions: [/1\.5 SOL/] },
  },
  {
    name: "USDC only",
    holdings: {
      solLamports: 0n,
      tokens: [{ mint: USDC_MAINNET, amount: 12_500_000n, decimals: 6 }],
    },
    refusal: { state: "funds-at-risk", mentions: [/12\.5 USDC/] },
  },
  {
    name: "another SPL token",
    holdings: { solLamports: 0n, tokens: [{ mint: OTHER_MINT, amount: 1000n, decimals: 0 }] },
    refusal: { state: "funds-at-risk", mentions: [/1000/, new RegExp(OTHER_MINT)] },
  },
  {
    name: "balance RPC unreachable / erroring",
    holdings: new Error("fetch failed: ECONNREFUSED"),
    refusal: { state: "funds-unknown", mentions: [/could not be read/, /ECONNREFUSED/] },
  },
];

let relay: SyncRelay;
let dir: string;
let config: FullConfig;
let relayCalls: number;
let configWrites: number;

const viaRelay: typeof fetch = async (input, init) => {
  relayCalls++;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return relay.app.request(url, init);
};

beforeEach(async () => {
  relay = await createSyncRelay({
    apiToken: "test-token",
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
  });
  dir = mkdtempSync(join(tmpdir(), "motebit-rotation-funds-"));
});
afterEach(async () => {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

async function registered(): Promise<{ mid: string; a: KeyPair; identityPath: string }> {
  const a = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(a));
  const identityPath = join(dir, "motebit.md");
  writeFileSync(
    identityPath,
    await generate({ motebitId: mid, ownerId: "owner", publicKeyHex: hex(a) }, a.privateKey),
  );
  const deviceId = `${mid}-laptop`;
  config = {
    motebit_id: mid,
    device_id: deviceId,
    device_public_key: hex(a),
    cli_encrypted_key: (await encryptPrivateKey(bytesToHex(a.privateKey), PASS))!,
  } as FullConfig;
  const handle = await registerWithRelay({
    syncUrl: SYNC_URL,
    identity: { motebitId: mid, deviceId, publicKeyHex: hex(a), privateKey: a.privateKey },
    registration: { endpoint_url: "http://127.0.0.1:9999/mcp", capabilities: [] },
    toolNames: [],
    description: "rotation funds preflight",
    log: () => {},
    heartbeatMs: 24 * 60 * 60 * 1000,
    fetchImpl: viaRelay,
  });
  handle.stop();
  expect(handle.registered).toBe(true);
  relayCalls = 0;
  configWrites = 0;
  return { mid, a, identityPath };
}

function deps(
  identityPath: string,
  holdings: Holdings | Error,
  readAddresses: string[],
  over: Record<string, unknown> = {},
): RotationDeps {
  return {
    identityPath,
    loadConfig: () => ({ ...config }),
    saveConfig: (c) => {
      configWrites++;
      config = c;
    },
    pending: {
      load: (mid, key) => loadPendingRotation(mid, key, dir),
      loadAny: () => loadAnyPendingRotation(dir),
      save: (p) => savePendingRotation(p, dir),
      clear: () => clearPendingRotation(dir),
      setAside: () => setAsidePendingRotation(dir),
      path: pendingRotationPath(dir),
    },
    passphrase: PASS,
    syncUrl: SYNC_URL,
    fetchImpl: viaRelay,
    readWalletHoldings: async (address: string) => {
      readAddresses.push(address);
      if (holdings instanceof Error) throw holdings;
      return holdings;
    },
    ...over,
  } as RotationDeps;
}

const relayKey = (mid: string): string | undefined =>
  (
    relay.moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(mid) as { public_key: string } | undefined
  )?.public_key;

describe("rotation funds preflight — CLI performRotation", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: ${s.refusal ? "refuses before any side effect" : "proceeds"}`, async () => {
      const { mid, a, identityPath } = await registered();
      const fileBefore = readFileSync(identityPath, "utf-8");
      const configBefore = JSON.stringify(config);
      const readAddresses: string[] = [];
      const o = await performRotation(deps(identityPath, s.holdings, readAddresses));
      expect(readAddresses).toEqual([base58btcEncode(a.publicKey)]);

      if (s.refusal == null) {
        expect(o.kind).toBe("rotated");
        expect(relayKey(mid)).not.toBe(hex(a));
        return;
      }
      expect(o).toMatchObject({ kind: "stopped", state: s.refusal.state });
      // Nothing moved anywhere: the relay was never contacted, no write-ahead
      // exists, the config (and with it the retired key) and the identity
      // file are untouched, and the relay still holds the old key.
      expect(relayCalls).toBe(0);
      expect(readdirSync(dir).filter((f) => f.startsWith("pending-rotation"))).toEqual([]);
      expect(configWrites).toBe(0);
      expect(JSON.stringify(config)).toBe(configBefore);
      expect(readFileSync(identityPath, "utf-8")).toBe(fileBefore);
      expect(relayKey(mid)).toBe(hex(a));

      const message = (o as { message: string }).message;
      expect(message).toContain(base58btcEncode(a.publicKey));
      for (const m of s.refusal.mentions) expect(message).toMatch(m);
      expect(message).toMatch(/move/i);
      expect(message).toContain("--abandon-funds");
    });

    if (s.refusal != null) {
      it(`${s.name}: --abandon-funds rotates (emergency rotation stays possible)`, async () => {
        const { mid, a, identityPath } = await registered();
        const o = await performRotation(deps(identityPath, s.holdings, [], { abandonFunds: true }));
        expect(o.kind).toBe("rotated");
        expect(relayKey(mid)).not.toBe(hex(a));
      });
    }
  }
});
