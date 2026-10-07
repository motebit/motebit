/**
 * Adversarial ExecutionReceipt corpus shared by the `motebit verify receipt`
 * tests and the CLI differential test (motebit vs motebit-verify). Every entry
 * names the verdict both CLIs must reach under the strict default and under
 * `--lenient`.
 */
import { createHash } from "node:crypto";

import { generateKeypair, signExecutionReceipt } from "@motebit/encryption";

export const sha256Hex = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

export async function mint(
  taskId: string,
  result: string,
  resultHash: string,
  delegations?: unknown[],
): Promise<Record<string, unknown>> {
  const kp = await generateKeypair();
  return (await signExecutionReceipt(
    {
      task_id: taskId,
      motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
      device_id: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
      submitted_at: 1_713_456_000_000,
      completed_at: 1_713_456_001_000,
      status: "completed",
      result,
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "a".repeat(64),
      result_hash: resultHash,
      ...(delegations ? { delegation_receipts: delegations as never } : {}),
    },
    kp.privateKey,
    kp.publicKey,
  )) as unknown as Record<string, unknown>;
}

export type KeyDefect = "missing" | "malformed-short" | "malformed-nonhex";

export function withKeyDefect(r: Record<string, unknown>, how: KeyDefect): Record<string, unknown> {
  const copy = { ...r };
  if (how === "missing") delete copy.public_key;
  else if (how === "malformed-short") copy.public_key = "not-a-key";
  else copy.public_key = "z".repeat(64);
  return copy;
}

/**
 * outer(0) → child(1) → grandchild(2). The node at `depth` carries result "z"
 * with result_hash = sha256("y") and (when `how` is set) a defective key.
 */
export async function nestedChain(
  depth: 1 | 2 | null,
  how: KeyDefect | null,
): Promise<Record<string, unknown>> {
  const res = (level: number, ok: string) => (depth === level ? "z" : ok);
  const hash = (level: number, ok: string) => sha256Hex(depth === level ? "y" : ok);
  let grandchild = await mint("task-depth-2", res(2, "g"), hash(2, "g"));
  if (depth === 2 && how) grandchild = withKeyDefect(grandchild, how);
  let child = await mint("task-depth-1", res(1, "c"), hash(1, "c"), [grandchild]);
  if (depth === 1 && how) child = withKeyDefect(child, how);
  return mint("task-outer", "o", sha256Hex("o"), [child]);
}

export interface CorpusEntry {
  name: string;
  receipt: unknown;
  /** Expected verdict under the strict default. */
  strictOk: boolean;
  /** Expected verdict under `--lenient` (signature-only at every depth). */
  lenientOk: boolean;
}

export async function adversarialCorpus(): Promise<CorpusEntry[]> {
  const out: CorpusEntry[] = [];
  for (const how of ["missing", "malformed-short", "malformed-nonhex"] as const) {
    for (const depth of [1, 2] as const) {
      out.push({
        name: `child-key-${how}-depth${depth}`,
        receipt: await nestedChain(depth, how),
        strictOk: false,
        lenientOk: false,
      });
    }
  }
  for (const depth of [1, 2] as const) {
    out.push({
      name: `child-hash-mismatch-depth${depth}`,
      receipt: await nestedChain(depth, null),
      strictOk: false,
      lenientOk: true,
    });
  }
  out.push({
    name: "bound-chain",
    receipt: await nestedChain(null, null),
    strictOk: true,
    lenientOk: true,
  });
  out.push({
    name: "outer-hash-mismatch",
    receipt: await mint("task-outer", "z", sha256Hex("y")),
    strictOk: false,
    lenientOk: true,
  });
  const tampered = await mint("task-outer", "o", sha256Hex("o"));
  out.push({
    name: "outer-result-tampered",
    receipt: { ...tampered, result: "O", result_hash: sha256Hex("O") },
    strictOk: false,
    lenientOk: false,
  });
  // Lone UTF-16 surrogate: UTF-8(result) is undefined (spec/execution-ledger-v1.md
  // §11.4), so the receipt is rejected in BOTH modes — no U+FFFD substitution.
  out.push({
    name: "result-lone-surrogate",
    receipt: await mint("task-outer", "ok \ud800", sha256Hex("ok �")),
    strictOk: false,
    lenientOk: false,
  });
  const nestedSurrogate = await mint("task-depth-1", "\udc00", sha256Hex("�"));
  out.push({
    name: "child-lone-surrogate-depth1",
    receipt: await mint("task-outer", "o", sha256Hex("o"), [nestedSurrogate]),
    strictOk: false,
    lenientOk: false,
  });
  return out;
}
