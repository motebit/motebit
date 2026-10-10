/**
 * Corpus for the payment-receipt well-formed-text harness
 * (`../payment-receipt-wellformed-harness.test.ts`, design note
 * `docs/design/payment-receipt-wellformed-stop-condition.md`).
 *
 * Deterministic by construction — fixed Ed25519 seeds, fixed timestamps,
 * deterministic signatures — so the same corpus can be replayed against an
 * origin/main build (`wellformed-main-oracle.mjs`) and its verdicts committed
 * as the "library default is unchanged" golden.
 */
import { createHash } from "node:crypto";

import * as ed from "@noble/ed25519";
import {
  EXECUTION_RECEIPT_SUITE,
  bytesToHex,
  canonicalJson,
  ed25519Sign,
  toBase64Url,
} from "@motebit/crypto";

// ── Input corpus ─────────────────────────────────────────────────────────

export interface TextInput {
  id: string;
  text: string;
  /** Independent oracle: ES2024 `String.prototype.isWellFormed`. */
  wellFormed: boolean;
}

const RAW_INPUTS: ReadonlyArray<readonly [string, string]> = [
  ["lone-high-mid", "a\uD800b"],
  ["lone-low-mid", "a\uDC00b"],
  ["lone-high-end", "cut mid-emoji \uD83D"],
  ["lone-low-start", "\uDE00 tail"],
  ["reversed-pair", "\uDE00\uD83D"],
  ["high-then-pair", "\uD83D😀"],
  ["only-lone-high", "\uD800"],
  ["only-lone-low", "\uDFFF"],
  ["mixed", "ok \u{1F600} \uD800 x \uDFFF \u{1F44D}\u{1F3FD}"],
  ["astral-well-formed", "\u{1F600}\u{1D11E}\u{1F44D}\u{1F3FD}"],
  ["nul", "a\u0000b"],
  ["bom", "﻿abc"],
  ["noncharacters", "￾￿"],
  ["replacement-char", "�"],
  ["line-separators", "a b c"],
  ["escaped-literal", "\\ud800"],
];

export const INPUTS: readonly TextInput[] = RAW_INPUTS.map(([id, text]) => ({
  id,
  text,
  wellFormed: (text as string & { isWellFormed(): boolean }).isWellFormed(),
}));

/** Deep well-formedness of a JSON value (string values AND object keys). */
export function deepWellFormed(value: unknown): boolean {
  if (typeof value === "string")
    return (value as string & { isWellFormed(): boolean }).isWellFormed();
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(deepWellFormed);
  for (const [k, v] of Object.entries(value)) {
    if (!deepWellFormed(k) || !deepWellFormed(v)) return false;
  }
  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** hex(SHA-256(UTF-8(s))) — Node's encoder, which (like TextEncoder) writes U+FFFD for a lone surrogate. */
export const sha256Utf8 = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

/** Recursively key-sorted JSON (lone surrogates escaped by JSON.stringify, so the output is ASCII-stable). */
export function stableStringify(v: unknown): string {
  if (v instanceof Uint8Array) return JSON.stringify(`u8:${Buffer.from(v).toString("hex")}`);
  if (typeof v === "bigint") return JSON.stringify(`bigint:${v.toString()}`);
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export const digestOf = (v: unknown): string =>
  createHash("sha256").update(stableStringify(v), "utf8").digest("hex");

export interface FixedKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export async function fixedKey(byte: number): Promise<FixedKey> {
  const privateKey = new Uint8Array(32).fill(byte);
  return { privateKey, publicKey: await ed.getPublicKeyAsync(privateKey) };
}

export const MOTEBIT_ID = "019cd9d4-3275-7b24-8265-61ebee41d9d0";
export const PAYER_ID = "019cd9d4-3275-7b24-8265-61ebee41d9d2";
export const T0 = 1_713_456_000_000;

/** Unsigned body of a well-formed, self-consistent receipt (no public_key / suite). */
export function baseBody(): Record<string, unknown> {
  return {
    task_id: "task-wf",
    motebit_id: MOTEBIT_ID,
    device_id: "device-wf",
    submitted_at: T0,
    completed_at: T0 + 1000,
    status: "completed",
    result: "ok",
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: sha256Utf8("ok"),
  };
}

/**
 * Sign exactly as every producer signed on main before the repair: no
 * sanitising — `canonicalJson` (JSON.stringify) escapes a lone surrogate to
 * `\udXXX`, so the signature is over ASCII bytes and verifies. `public_key`
 * and `suite` are stamped unless the body already carries them (a cell that
 * puts its text in those fields).
 */
export async function signLegacy(
  body: Record<string, unknown>,
  key: FixedKey,
): Promise<Record<string, unknown>> {
  const full: Record<string, unknown> = {
    public_key: bytesToHex(key.publicKey),
    suite: EXECUTION_RECEIPT_SUITE,
    ...body,
  };
  const sig = await ed25519Sign(new TextEncoder().encode(canonicalJson(full)), key.privateKey);
  return { ...full, signature: toBase64Url(sig) };
}

// ── Signed text fields (payment-receipt family = ExecutionReceipt shape) ──

/**
 * `free` — unconstrained text: a well-formed value yields an otherwise-valid
 * receipt, so its verdict isolates the well-formedness question.
 * `format` — text with a format/enum constraint (hash hex, key hex, suite,
 * status, origin) or a key the wire schema does not admit: the value is
 * invalid regardless of surrogates; the question there is only WHICH reason
 * a strict verifier names, and whether verdicts stay identical to main.
 */
export type FieldClass = "free" | "format";

export interface LegacyField {
  id: string;
  cls: FieldClass;
  /** Build the legacy-signed receipt carrying `text` in this field. */
  build(text: string, outer: FixedKey, child: FixedKey): Promise<Record<string, unknown>>;
}

const put =
  (mutate: (b: Record<string, unknown>, text: string) => void) =>
  async (text: string, outer: FixedKey): Promise<Record<string, unknown>> => {
    const b = baseBody();
    mutate(b, text);
    return signLegacy(b, outer);
  };

const SOURCE_DIGEST = { algorithm: "sha-256", value: "b".repeat(64) };

async function withChild(
  mutateChild: (b: Record<string, unknown>, text: string) => void,
  text: string,
  outer: FixedKey,
  child: FixedKey,
): Promise<Record<string, unknown>> {
  const cb = baseBody();
  cb.task_id = "task-wf-child";
  mutateChild(cb, text);
  const signedChild = await signLegacy(cb, child);
  const ob = baseBody();
  ob.delegation_receipts = [signedChild];
  return signLegacy(ob, outer);
}

export const LEGACY_FIELDS: readonly LegacyField[] = [
  { id: "task_id", cls: "free", build: put((b, t) => (b.task_id = t)) },
  { id: "motebit_id", cls: "free", build: put((b, t) => (b.motebit_id = t)) },
  { id: "device_id", cls: "free", build: put((b, t) => (b.device_id = t)) },
  {
    id: "result",
    cls: "free",
    // result_hash computed the way legacy producers did: a UTF-8 encoder over
    // the raw string (U+FFFD for each lone surrogate).
    build: put((b, t) => {
      b.result = t;
      b.result_hash = sha256Utf8(t);
    }),
  },
  { id: "tools_used[0]", cls: "free", build: put((b, t) => (b.tools_used = [t])) },
  { id: "relay_task_id", cls: "free", build: put((b, t) => (b.relay_task_id = t)) },
  { id: "delegated_scope", cls: "free", build: put((b, t) => (b.delegated_scope = t)) },
  {
    id: "source_projection",
    cls: "free",
    build: put((b, t) => {
      b.source_digest = { ...SOURCE_DIGEST };
      b.source_projection = t;
    }),
  },
  {
    id: "delegation_receipts[0].result",
    cls: "free",
    build: (t, o, c) =>
      withChild(
        (b, text) => {
          b.result = text;
          b.result_hash = sha256Utf8(text);
        },
        t,
        o,
        c,
      ),
  },
  {
    id: "delegation_receipts[0].task_id",
    cls: "free",
    build: (t, o, c) => withChild((b, text) => (b.task_id = text), t, o, c),
  },
  { id: "status", cls: "format", build: put((b, t) => (b.status = t)) },
  { id: "suite", cls: "format", build: put((b, t) => (b.suite = t)) },
  { id: "invocation_origin", cls: "format", build: put((b, t) => (b.invocation_origin = t)) },
  { id: "public_key", cls: "format", build: put((b, t) => (b.public_key = t)) },
  { id: "prompt_hash", cls: "format", build: put((b, t) => (b.prompt_hash = t)) },
  { id: "result_hash", cls: "format", build: put((b, t) => (b.result_hash = t)) },
  { id: "service_result_hash", cls: "format", build: put((b, t) => (b.service_result_hash = t)) },
  {
    id: "source_digest.value",
    cls: "format",
    build: put((b, t) => (b.source_digest = { algorithm: "sha-256", value: t })),
  },
  { id: "<object key>", cls: "format", build: put((b, t) => (b[`x_${t}`] = "v")) },
];

export interface LegacyCell {
  cell: string;
  field: LegacyField;
  input: TextInput;
  receipt: Record<string, unknown>;
}

export async function buildLegacyCorpus(): Promise<LegacyCell[]> {
  const outer = await fixedKey(0x07);
  const child = await fixedKey(0x08);
  const out: LegacyCell[] = [];
  for (const field of LEGACY_FIELDS) {
    for (const input of INPUTS) {
      out.push({
        cell: `${field.id} × ${input.id}`,
        field,
        input,
        receipt: await field.build(input.text, outer, child),
      });
    }
  }
  return out;
}
