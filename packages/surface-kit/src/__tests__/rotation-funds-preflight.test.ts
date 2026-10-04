/**
 * Rotation never strands funds — the harness at the shared seam.
 *
 * A motebit's Solana address IS its current Ed25519 identity key, and every
 * surface erases or overwrites the retired key once the relay records the
 * rotation. So a rotation departing from a key whose address holds value is
 * a one-click permanent loss unless it is refused BEFORE anything moves.
 *
 * Table: {old address: empty, SOL only, USDC only, another SPL token, balance
 * read failing; the relay holding an open obligation to the old address — a
 * pending withdrawal, a processing (or freeze-held) withdrawal, an admitted
 * P2P task not yet verified; the obligations read failing} × {no
 * acknowledgment, explicit acknowledgment}. Every refusal must happen before
 * a key is minted, a write-ahead saved, the rotation submitted, or local
 * state committed — and must name the address, what it holds or is owed, and
 * the ways forward. The only relay contact before a refusal is the
 * authenticated obligations READ.
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

/** What the relay reports it still owes the old address (its obligations route). */
type Obligations = Record<string, unknown>[] | Error;

type Scenario = {
  name: string;
  holdings: Holdings | Error;
  /** Default: none. */
  obligations?: Obligations;
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
  {
    name: "a PENDING relay withdrawal to the old address",
    holdings: { solLamports: 0n, tokens: [] },
    obligations: [
      {
        kind: "withdrawal",
        withdrawal_id: "wd-pending-1",
        status: "pending",
        amount_micro: 12_500_000,
        destination: "OLD",
      },
    ],
    refusal: {
      state: "funds-at-risk",
      mentions: [/withdrawal wd-pending-1/, /pending/, /12\.5 USD/, /cancel/],
    },
  },
  {
    name: "a PROCESSING (or freeze-held) relay withdrawal to the old address",
    holdings: { solLamports: 0n, tokens: [] },
    obligations: [
      {
        kind: "withdrawal",
        withdrawal_id: "wd-processing-1",
        status: "processing",
        amount_micro: 3_000_000,
        destination: "OLD",
      },
    ],
    refusal: {
      state: "funds-at-risk",
      mentions: [/withdrawal wd-processing-1/, /processing/, /3 USD/, /complete/],
    },
  },
  {
    name: "an admitted, not-yet-verified P2P task paying the old address",
    holdings: { solLamports: 0n, tokens: [] },
    obligations: [
      {
        kind: "p2p_task",
        task_id: "task-p2p-1",
        stage: "admitted",
        amount_micro: 1_000_000,
        address: "OLD",
      },
    ],
    refusal: { state: "funds-at-risk", mentions: [/task task-p2p-1/, /settle/] },
  },
  {
    name: "the relay's obligations read failing",
    holdings: { solLamports: 0n, tokens: [] },
    obligations: new Error("relay answered 503"),
    refusal: { state: "funds-unknown", mentions: [/obligations/, /503/] },
  },
];

interface Trace {
  events: string[];
  readAddresses: string[];
  /** The obligations reads: the key asked about and the bearer's audience. */
  obligationReads: { from: string | null; aud: string | null }[];
}

/** The `aud` claim of a motebit bearer (payload is the first dot-segment, base64url JSON). */
function audOf(authorization: string | null): string | null {
  if (authorization == null || !authorization.startsWith("Bearer ")) return null;
  try {
    const payload = authorization.slice(7).split(".")[0]!;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { aud?: string };
    return json.aud ?? null;
  } catch {
    return null;
  }
}

/** A device holding `a`, a relay that would accept the rotation, and a balance reader. */
function device(
  a: KeyPair,
  holdings: Holdings | Error,
  opts: {
    acknowledge?: boolean;
    held?: HeldRotation | null;
    relayHolds?: string;
    obligations?: Obligations;
  } = {},
): { ports: KeyRotationPorts; trace: Trace } {
  const trace: Trace = { events: [], readAddresses: [], obligationReads: [] };
  const oldAddress = base58btcEncode(a.publicKey);
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
    fetchImpl: (async (input: string, init?: RequestInit) => {
      if (input.includes("/rotation-obligations")) {
        const headers = new Headers(init?.headers);
        trace.obligationReads.push({
          from: new URL(input).searchParams.get("from"),
          aud: audOf(headers.get("Authorization")),
        });
        const o = opts.obligations ?? [];
        if (o instanceof Error) return new Response(o.message, { status: 503 });
        return new Response(
          JSON.stringify({
            address: oldAddress,
            obligations: o.map((x) => ({
              ...x,
              ...(x["destination"] === "OLD" ? { destination: oldAddress } : {}),
              ...(x["address"] === "OLD" ? { address: oldAddress } : {}),
            })),
          }),
          { status: 200 },
        );
      }
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
      const { ports, trace } = device(a, s.holdings, { obligations: s.obligations });
      const o = await performKeyRotation(ports);

      // The reader is asked about THIS key's address — the one being retired.
      expect(trace.readAddresses).toEqual([address]);
      // And the relay is asked, under an authenticated read, what it still
      // owes that key's address.
      expect(trace.obligationReads).toEqual([
        { from: bytesToHex(a.publicKey), aud: "account:balance" },
      ]);

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
      const again = device(a, s.holdings, { obligations: s.obligations });
      await expect(rotateOrThrow(again.ports)).rejects.toBeInstanceOf(KeyRotationError);
      expect(again.trace.events).toEqual([]);
    });

    if (s.refusal != null) {
      it(`${s.name}: an explicit acknowledgment rotates (emergency rotation stays possible)`, async () => {
        const a = await generateKeypair();
        const { ports, trace } = device(a, s.holdings, {
          acknowledge: true,
          obligations: s.obligations,
        });
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
  it("an obligations refusal carries each obligation so a surface can name it in its confirm", async () => {
    const a = await generateKeypair();
    const { ports } = device(
      a,
      { solLamports: 0n, tokens: [] },
      {
        obligations: [
          {
            kind: "withdrawal",
            withdrawal_id: "wd-1",
            status: "pending",
            amount_micro: 1_000_000,
            destination: "OLD",
          },
          { kind: "p2p_task", task_id: "t-1", stage: "settled_unverified", address: "OLD" },
        ],
      },
    );
    const err = await rotateOrThrow(ports).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyRotationError);
    const outcome = (err as KeyRotationError).outcome as {
      funds?: { address: string; obligations?: { kind: string }[] };
      message: string;
    };
    expect(outcome.funds?.address).toBe(base58btcEncode(a.publicKey));
    expect(outcome.funds?.obligations?.map((x) => x.kind)).toEqual(["withdrawal", "p2p_task"]);
    expect(outcome.message).toMatch(/withdrawal wd-1/);
    expect(outcome.message).toMatch(/task t-1/);
  });

  it("with no relay configured there is no obligation to read, and none is asked for", async () => {
    const a = await generateKeypair();
    const { ports, trace } = device(a, { solLamports: 0n, tokens: [] });
    const o = await performKeyRotation({ ...ports, syncUrl: null });
    expect(o.kind).toBe("rotated");
    expect(trace.obligationReads).toEqual([]);
  });
});
