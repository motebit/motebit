/**
 * Jupiter containment — adversarial, offline.
 *
 * The swap functions used to fetch a serialized transaction from Jupiter's
 * HTTP API, deserialize it, sign it with the identity keypair and broadcast
 * it, inspecting nothing. Here a MALICIOUS `/swap` response is staged — a
 * `SystemProgram.transfer` of the wallet's SOL to an attacker — and the test
 * proves it is never fetched, never deserialized, never signed and never
 * broadcast: both swap functions refuse with `JupiterSwapDisabledError`
 * (`code: "jupiter_swap_disabled"`) before any of it, and without touching
 * the keypair (a keypair that throws on any property read is passed in).
 *
 * Tamper: packages/wallet-solana/src/__tests__/jupiter-containment.tampers.mjs
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  swapUsdcToSol,
  swapSolToUsdc,
  JupiterSwapDisabledError,
  JUPITER_SWAP_DISABLED,
} from "../jupiter.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const VICTIM = Keypair.fromSeed(new Uint8Array(32).fill(9));
const ATTACKER = Keypair.fromSeed(new Uint8Array(32).fill(13)).publicKey;

/** The transaction a compromised Jupiter would return: drain SOL to the attacker. */
function maliciousSwapTransaction(): string {
  const message = new TransactionMessage({
    payerKey: VICTIM.publicKey,
    recentBlockhash: new PublicKey(new Uint8Array(32).fill(1)).toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: VICTIM.publicKey,
        toPubkey: ATTACKER,
        lamports: 1_000_000_000,
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

/** Every door the old code went through, spied — and a keypair that must not be read. */
function stageMaliciousJupiter() {
  const swapTransaction = maliciousSwapTransaction();
  const fetchSpy = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/quote")) {
      return { ok: true, status: 200, json: async () => ({ outAmount: "1" }) };
    }
    return { ok: true, status: 200, json: async () => ({ swapTransaction }) };
  });
  vi.stubGlobal("fetch", fetchSpy);
  const deserializeSpy = vi.spyOn(VersionedTransaction, "deserialize");
  const signSpy = vi.spyOn(VersionedTransaction.prototype, "sign");
  const connection = new Connection("http://127.0.0.1:1");
  const sendRawSpy = vi
    .spyOn(connection, "sendRawTransaction")
    .mockResolvedValue("attacker-sig-should-never-exist");
  const getBalanceSpy = vi.spyOn(connection, "getBalance").mockResolvedValue(10_000_000_000);
  const keypairReads: Array<string | symbol> = [];
  const keypair = new Proxy(VICTIM, {
    get(target, prop, receiver) {
      keypairReads.push(prop);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return {
    fetchSpy,
    deserializeSpy,
    signSpy,
    sendRawSpy,
    getBalanceSpy,
    connection,
    keypair,
    keypairReads,
  };
}

describe("Jupiter swaps refuse before fetching or signing (containment)", () => {
  it("swapUsdcToSol: a malicious /swap response is never fetched, deserialized, signed or broadcast", async () => {
    const s = stageMaliciousJupiter();
    const err = await swapUsdcToSol(20_000n, s.keypair, s.connection).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JupiterSwapDisabledError);
    expect((err as JupiterSwapDisabledError).code).toBe(JUPITER_SWAP_DISABLED);
    expect((err as JupiterSwapDisabledError).code).toBe("jupiter_swap_disabled");
    expect((err as Error).message).toBe(
      "swaps are disabled until intent-bound transaction validation exists",
    );
    expect(s.fetchSpy).toHaveBeenCalledTimes(0);
    expect(s.deserializeSpy).toHaveBeenCalledTimes(0);
    expect(s.signSpy).toHaveBeenCalledTimes(0);
    expect(s.sendRawSpy).toHaveBeenCalledTimes(0);
    expect(s.keypairReads).toEqual([]);
  });

  it("swapSolToUsdc: a malicious /swap response is never fetched, deserialized, signed or broadcast", async () => {
    const s = stageMaliciousJupiter();
    const err = await swapSolToUsdc(10_000_000n, s.keypair, s.connection).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JupiterSwapDisabledError);
    expect((err as JupiterSwapDisabledError).code).toBe("jupiter_swap_disabled");
    expect((err as JupiterSwapDisabledError).operation).toBe("swapSolToUsdc");
    expect(s.fetchSpy).toHaveBeenCalledTimes(0);
    expect(s.getBalanceSpy).toHaveBeenCalledTimes(0);
    expect(s.deserializeSpy).toHaveBeenCalledTimes(0);
    expect(s.signSpy).toHaveBeenCalledTimes(0);
    expect(s.sendRawSpy).toHaveBeenCalledTimes(0);
    expect(s.keypairReads).toEqual([]);
  });

  it("the staged response really is a signable drain (the fixture is not a strawman)", () => {
    const s = stageMaliciousJupiter();
    vi.restoreAllMocks();
    const tx = VersionedTransaction.deserialize(Buffer.from(maliciousSwapTransaction(), "base64"));
    tx.sign([VICTIM]);
    expect(tx.signatures[0]!.some((b) => b !== 0)).toBe(true);
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys).toContain(ATTACKER.toBase58());
    expect(s.fetchSpy).toHaveBeenCalledTimes(0);
  });
});
