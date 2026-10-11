/**
 * Compatibility of receipts carrying an unpaired UTF-16 surrogate.
 *
 * main's signer signed such a result (an LLM output cut mid-emoji) over the
 * JCS bytes JavaScript produces (the surrogate escaped as `\udXXX`), and main's
 * `verifyExecutionReceipt` / default `verifyReceipt` accept it. Those are the
 * signature checks the runtime and the relay run on every delegation,
 * settlement and trust update, so they MUST keep accepting it. The §11.4
 * rejection (UTF-8 is undefined for an unpaired surrogate, so `result_hash`
 * binds nothing) applies only under strict hash binding — the receipt CLIs'
 * default.
 *
 * The producer side: `signExecutionReceipt` never emits one — a lone surrogate
 * in `result` is replaced with U+FFFD before signing, which leaves a
 * `result_hash` computed with TextEncoder (or Node's utf8) unchanged.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  EXECUTION_RECEIPT_SUITE,
  bytesToHex,
  canonicalJson,
  ed25519Sign,
  generateKeypair,
  hash,
  hexToBytes,
  signExecutionReceipt,
  toBase64Url,
  UnpairedSurrogateError,
  verifyExecutionReceipt,
  verifyExecutionReceiptDetailed,
  verifyReceipt,
} from "../index.js";
import type { ExecutionReceipt } from "../index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEGACY_FIXTURE = resolve(
  HERE,
  "../../../../examples/python-receipt-verifier/fixtures/strict-negative/result-lone-surrogate.json",
);

const utf8Hash = async (s: string): Promise<string> => hash(new TextEncoder().encode(s));

/** main's `signExecutionReceipt`, verbatim: no sanitising of the body. */
async function signLegacy(
  body: Record<string, unknown>,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<ExecutionReceipt> {
  const signed = { ...body, public_key: bytesToHex(publicKey), suite: EXECUTION_RECEIPT_SUITE };
  const sig = await ed25519Sign(new TextEncoder().encode(canonicalJson(signed)), privateKey);
  return { ...signed, signature: toBase64Url(sig) } as unknown as ExecutionReceipt;
}

async function legacyReceipt(result: string, extra: Record<string, unknown> = {}) {
  const kp = await generateKeypair();
  const r = await signLegacy(
    {
      task_id: "task-legacy",
      motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
      device_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
      submitted_at: 1_713_456_000_000,
      completed_at: 1_713_456_001_000,
      status: "completed",
      result,
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "a".repeat(64),
      // What every producer computes: TextEncoder substitutes U+FFFD.
      result_hash: await utf8Hash(result),
      ...extra,
    },
    kp.privateKey,
    kp.publicKey,
  );
  return { r, kp };
}

describe("legacy (main-signed) lone-surrogate receipt — signature paths keep main's behaviour", () => {
  for (const s of ["partial answer \ud83d", "\udc00 lone low", "reversed \udc00\ud800"]) {
    it(`${JSON.stringify(s)}: verifyExecutionReceipt / Detailed / default verifyReceipt accept`, async () => {
      const { r, kp } = await legacyReceipt(s);
      expect(await verifyExecutionReceipt(r, kp.publicKey)).toBe(true);
      const detail = await verifyExecutionReceiptDetailed(r, kp.publicKey);
      expect(detail.valid).toBe(true);
      expect(detail.reason).toBe("ok");
      expect((await verifyReceipt(r)).valid).toBe(true);
    });

    it(`${JSON.stringify(s)}: strict hash binding rejects with the §11.4 reason`, async () => {
      const { r } = await legacyReceipt(s);
      const v = await verifyReceipt(r, { strictHashBinding: true });
      expect(v.valid).toBe(false);
      const messages = (v.errors ?? []).map((e) => e.message);
      expect(messages).toContain(
        "§11.4 violation: receipt contains a string with an unpaired UTF-16 surrogate — it has no UTF-8 encoding",
      );
      // One reason, not a second misleading "hash mismatch".
      expect(messages.some((m) => m.includes("result_hash does not equal"))).toBe(false);
    });
  }

  it("a legacy lone-surrogate child: default accepts the tree, strict names the depth", async () => {
    const { r: child } = await legacyReceipt("\ud83d");
    const kp = await generateKeypair();
    // Signed as main signed it: today's signExecutionReceipt refuses to embed
    // such a child (see "signExecutionReceipt refuses" below).
    const outer = await signLegacy(
      {
        task_id: "task-outer",
        motebit_id: "m",
        device_id: "d",
        submitted_at: 1,
        completed_at: 2,
        status: "completed",
        result: "o",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: "a".repeat(64),
        result_hash: await utf8Hash("o"),
        delegation_receipts: [child],
      },
      kp.privateKey,
      kp.publicKey,
    );
    expect((await verifyReceipt(outer)).valid).toBe(true);
    const strict = await verifyReceipt(outer, { strictHashBinding: true });
    expect(strict.valid).toBe(false);
    expect(strict.delegations?.[0]?.errors?.[0]?.message).toMatch(/§11\.4 violation/);
  });

  it("the committed legacy vector: signature-only accepts, strict rejects", async () => {
    const r = JSON.parse(readFileSync(LEGACY_FIXTURE, "utf8")) as ExecutionReceipt;
    expect(await verifyExecutionReceipt(r, hexToBytes(r.public_key!))).toBe(true);
    expect((await verifyReceipt(r)).valid).toBe(true);
    expect((await verifyReceipt(r, { strictHashBinding: true })).valid).toBe(false);
  });
});

describe("signExecutionReceipt never emits an unpaired surrogate", () => {
  const body = (extra: Record<string, unknown>) => ({
    task_id: "t",
    motebit_id: "m",
    device_id: "d",
    submitted_at: 1,
    completed_at: 2,
    status: "completed" as const,
    result: "ok",
    tools_used: [] as string[],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    ...extra,
  });

  it("refuses (UnpairedSurrogateError, path named) — never repairs — at any field, key or depth", async () => {
    const kp = await generateKeypair();
    const { r: child } = await legacyReceipt("\ud83d");
    for (const [extra, path] of [
      [{ result: "cut mid-emoji \ud83d" }, '$["result"]'],
      [{ task_id: "\udc00t" }, '$["task_id"]'],
      [{ tools_used: ["ok", "x\ud800"] }, '$["tools_used"][1]'],
      [{ ["k\ud800"]: "v" }, '$["k\\ud800"] (object key)'],
      [{ delegation_receipts: [child] }, '$["delegation_receipts"][0]["result"]'],
    ] as const) {
      const err = await signExecutionReceipt(body(extra), kp.privateKey, kp.publicKey).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(UnpairedSurrogateError);
      expect((err as UnpairedSurrogateError).name).toBe("UnpairedSurrogateError");
      expect((err as UnpairedSurrogateError).path).toBe(path);
    }
  });

  it("well-formed input signs byte-identically to main's recipe", async () => {
    const kp = await generateKeypair();
    const body = {
      task_id: "t",
      motebit_id: "m",
      device_id: "d",
      submitted_at: 1,
      completed_at: 2,
      status: "completed" as const,
      result: "ok 😀",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "a".repeat(64),
      result_hash: await utf8Hash("ok 😀"),
    };
    const now = await signExecutionReceipt(body, kp.privateKey, kp.publicKey);
    const legacy = await signLegacy(body, kp.privateKey, kp.publicKey);
    expect(canonicalJson(now)).toBe(canonicalJson(legacy));
  });
});

describe("a malformed delegation entry: strict names it, the default keeps the merge-base verdict", () => {
  for (const bad of [null, "x", 7, []]) {
    it(`delegation_receipts: [${JSON.stringify(bad)}]`, async () => {
      const kp = await generateKeypair();
      const outer = (await signExecutionReceipt(
        {
          task_id: "task-outer",
          motebit_id: "m",
          device_id: "d",
          submitted_at: 1,
          completed_at: 2,
          status: "completed",
          result: "o",
          tools_used: [],
          memories_formed: 0,
          prompt_hash: "a".repeat(64),
          result_hash: await utf8Hash("o"),
          delegation_receipts: [bad as never],
        },
        kp.privateKey,
        kp.publicKey,
      )) as ExecutionReceipt;
      // Strict: a §11.5 shape failure, never a TypeError.
      const strict = await verifyReceipt(outer, { strictHashBinding: true });
      expect(strict.valid).toBe(false);
      expect(strict.delegations?.[0]?.errors?.[0]?.message).toMatch(
        /§11\.5 violation: delegation_receipts entry is not an object/,
      );
      // Default: byte-identical to the merge-base (locked across the whole
      // corpus by apps/cli/src/__tests__/default-verdict-differential.test.ts)
      // — a null entry throws as it always has; any other non-object entry is
      // a keyless child.
      if (bad === null) {
        await expect(verifyReceipt(outer)).rejects.toThrow(TypeError);
      } else {
        const v = await verifyReceipt(outer);
        expect(v.valid).toBe(false);
        expect(v.delegations?.[0]?.errors?.[0]?.message).toMatch(/§11\.3 violation/);
      }
    });
  }
});
