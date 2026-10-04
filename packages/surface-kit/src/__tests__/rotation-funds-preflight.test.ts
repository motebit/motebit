/**
 * Rotation never strands funds — the harness at the shared seam.
 *
 * A motebit's Solana address IS its current Ed25519 identity key, and every
 * surface erases or overwrites the retired key once the relay records the
 * rotation. So a rotation departing from a key whose address holds value is
 * a one-click permanent loss unless it is refused BEFORE anything moves.
 *
 * Table: {old address: empty, SOL only, USDC only, another SPL token, balance
 * read failing} × {no acknowledgment, explicit acknowledgment}. Every
 * refusal must happen before a key is minted, a write-ahead saved, the relay
 * contacted, or local state committed — and must name the address, what it
 * holds, and both ways forward.
 *
 * `rotateOrThrow` is what desktop, web and mobile call; the CLI and
 * create-motebit have their own harnesses with the same table
 * (`apps/cli/src/__tests__/rotation-funds-preflight.test.ts`,
 * `packages/create-motebit/src/__tests__/rotate-funds-preflight.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { generateKeypair, bytesToHex, base58btcEncode } from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";

import {
  performKeyRotation,
  rotateOrThrow,
  KeyRotationError,
  type HeldRotation,
  type KeyRotationPorts,
} from "../key-rotation.js";

const MID = "mid-funds";
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER_MINT = "So1aNaOtherTokenMint1111111111111111111111";

interface Holdings {
  solLamports: bigint;
  tokens: { mint: string; amount: bigint; decimals: number }[];
}

type Scenario = {
  name: string;
  holdings: Holdings | Error;
  /** null ⇒ the rotation proceeds; otherwise what the refusal must say. */
  refusal: null | { state: "funds-at-risk" | "funds-unknown"; mentions: RegExp[] };
};

const SCENARIOS: Scenario[] = [
  { name: "empty", holdings: { solLamports: 0n, tokens: [] }, refusal: null },
  {
    name: "empty token accounts only (zero balances)",
    holdings: { solLamports: 0n, tokens: [{ mint: USDC_MAINNET, amount: 0n, decimals: 6 }] },
    refusal: null,
  },
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

interface Trace {
  events: string[];
  readAddresses: string[];
}

/** A device holding `a`, a relay that would accept the rotation, and a balance reader. */
function device(
  a: KeyPair,
  holdings: Holdings | Error,
  opts: { acknowledge?: boolean; held?: HeldRotation | null; relayHolds?: string } = {},
): { ports: KeyRotationPorts; trace: Trace } {
  const trace: Trace = { events: [], readAddresses: [] };
  let held: HeldRotation | null = opts.held ?? null;
  const ports = {
    motebitId: MID,
    deviceId: "d-1",
    syncUrl: "http://relay",
    loadPrivateKeyHex: async () => bytesToHex(a.privateKey),
    writeAhead: {
      load: async () => held,
      save: async (h: HeldRotation) => {
        trace.events.push("write-ahead");
        held = h;
      },
      clear: async () => {
        trace.events.push("clear");
        held = null;
      },
      setAside: async () => {
        trace.events.push("set-aside");
        held = null;
      },
    },
    commit: async () => {
      trace.events.push("commit");
    },
    readWalletHoldings: async (address: string) => {
      trace.readAddresses.push(address);
      if (holdings instanceof Error) throw holdings;
      return holdings;
    },
    ...(opts.acknowledge ? { acknowledgeFundsAtRisk: true } : {}),
    fetchImpl: (async (_input: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        trace.events.push("relay-post");
        return new Response(JSON.stringify({ ok: true, motebit_id: MID, applied: true }), {
          status: 200,
        });
      }
      trace.events.push("relay-read");
      const relayHolds = opts.relayHolds ?? bytesToHex(a.publicKey);
      return new Response(
        JSON.stringify({
          chain: held?.record ? [held.record] : [],
          held_public_key: relayHolds,
          departable: relayHolds === bytesToHex(a.publicKey),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  } as KeyRotationPorts;
  return { ports, trace };
}

describe("rotation funds preflight — surface-kit (desktop / web / mobile)", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: ${s.refusal ? "refuses before any side effect" : "proceeds"}`, async () => {
      const a = await generateKeypair();
      const address = base58btcEncode(a.publicKey);
      const { ports, trace } = device(a, s.holdings);
      const o = await performKeyRotation(ports);

      // The reader is asked about THIS key's address — the one being retired.
      expect(trace.readAddresses).toEqual([address]);

      if (s.refusal == null) {
        expect(o.kind).toBe("rotated");
        expect(trace.events).toContain("relay-post");
        return;
      }
      expect(o).toMatchObject({ kind: "stopped", state: s.refusal.state });
      // Nothing moved: no write-ahead, no relay contact, no commit, no clear.
      expect(trace.events).toEqual([]);
      const message = (o as { message: string }).message;
      expect(message).toContain(address);
      for (const m of s.refusal.mentions) expect(message).toMatch(m);
      // The two ways forward.
      expect(message).toMatch(/move/i);
      expect(message).toMatch(/acknowledg/i);
      // rotateOrThrow (the surfaces' contract) rejects with the same message.
      const again = device(a, s.holdings);
      await expect(rotateOrThrow(again.ports)).rejects.toBeInstanceOf(KeyRotationError);
      expect(again.trace.events).toEqual([]);
    });

    if (s.refusal != null) {
      it(`${s.name}: an explicit acknowledgment rotates (emergency rotation stays possible)`, async () => {
        const a = await generateKeypair();
        const { ports, trace } = device(a, s.holdings, { acknowledge: true });
        const o = await rotateOrThrow(ports);
        expect(o.kind).toBe("rotated");
        expect(trace.events).toContain("relay-post");
      });
    }
  }

  it("the refusal carries the holdings so a surface can state the amounts in its confirm", async () => {
    const a = await generateKeypair();
    const { ports } = device(a, { solLamports: 2_000_000_000n, tokens: [] });
    const err = await rotateOrThrow(ports).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyRotationError);
    const outcome = (err as KeyRotationError).outcome as {
      funds?: { address: string; summary?: string };
    };
    expect(outcome.funds?.address).toBe(base58btcEncode(a.publicKey));
    expect(outcome.funds?.summary).toMatch(/2 SOL/);
  });

  it("finishing a rotation the relay already applied is also refused while the retired address holds value (the old key would be erased on commit)", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const { signKeySuccession } = await import("@motebit/encryption");
    const record = await signKeySuccession(a.privateKey, b.privateKey, b.publicKey, a.publicKey);
    const held: HeldRotation = {
      motebit_id: MID,
      old_public_key: bytesToHex(a.publicKey),
      new_public_key: bytesToHex(b.publicKey),
      record,
      new_private_key_hex: bytesToHex(b.privateKey),
      written_at: 1,
    };
    const { ports, trace } = device(
      a,
      { solLamports: 1n, tokens: [] },
      { held, relayHolds: bytesToHex(b.publicKey) },
    );
    const o = await performKeyRotation(ports);
    expect(o).toMatchObject({ kind: "stopped", state: "funds-at-risk" });
    expect(trace.events).toEqual([]);
  });
});
