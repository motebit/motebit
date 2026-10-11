/**
 * Differential corpus for the DEFAULT-mode receipt verifiers: every library
 * path a consumer reaches without opting into strict hash binding must return
 * a byte-identical verdict — `valid`, error list, every field — to the base the
 * branch forked from (merge-base 4571d3b42). Shared by
 * `default-verdict-differential.test.ts` (head side) and
 * `apps/cli/scripts/default-verdict-base-oracle.ts` (base side, which records
 * the committed golden), so the two sides cannot drift: the corpus and the path
 * runner live here once, and only the verifier modules are injected.
 *
 * The corpus is deterministic: fixed private keys (Ed25519 signing is
 * deterministic) and a fixed fast-check seed. Every receipt is signed over the
 * canonical bytes of its body AS SPELLED — a `public_key` spelled `"ag…"` is
 * signed in that spelling — so a lenient key decode on one side and a strict
 * one on the other shows up as a verdict divergence, not a signature failure on
 * both. Receipts are signed with the raw canonicalizer (not the guarded signing
 * boundary): the corpus deliberately holds malformed text a producer must never
 * emit but a verifier must still answer for.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { bytesToHex, canonicalJson, ed25519Sign, toBase64Url } from "@motebit/crypto";
import { getPublicKeyBySuite } from "@motebit/crypto/suite-dispatch";

const SUITE = "motebit-jcs-ed25519-b64-v1" as const;
/** The fast-check seed for the random half of the corpus. Never change it to make a cell pass. */
export const FUZZ_SEED = 0x6d6f7465;
export const FUZZ_RUNS = 220;
/** Delegation chains go to the protocol's chain cap (spec: chain ≤ 10). */
const DEPTH_CAP = 10;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, unknown>;

export interface DefaultVerifierLibs {
  crypto: {
    verify(artifact: unknown, options?: object): Promise<unknown>;
    verifyReceipt(receipt: never, options?: object): Promise<unknown>;
    verifyReceiptVerdict(receipt: never): Promise<unknown>;
    verifyExecutionReceipt(receipt: never, publicKey: Uint8Array): Promise<unknown>;
    hexToBytes(hex: string): Uint8Array;
  };
  verifier: {
    verifyArtifact(content: string | object, opts?: object): Promise<unknown>;
    verifyFile(path: string, opts?: object): Promise<unknown>;
  };
}

export interface CorpusCase {
  name: string;
  receipt: unknown;
}

// ── Stable digests of a verdict ──────────────────────────────────────────

function stableStringify(v: unknown): string {
  if (v instanceof Uint8Array) return JSON.stringify(`u8:${Buffer.from(v).toString("hex")}`);
  if (typeof v === "bigint") return JSON.stringify(`bigint:${v.toString()}`);
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Obj;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
export const digestOf = (v: unknown): string =>
  createHash("sha256").update(stableStringify(v), "utf8").digest("hex");

function summarize(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value !== null && typeof value === "object") {
    const o = value as Obj;
    if ("valid" in o) {
      const errs = ((o.errors as Array<{ message: string }> | undefined) ?? [])
        .map((e) => e.message)
        .join(" | ");
      return `valid=${String(o.valid)}${errs ? ` errors=${errs}` : ""}`;
    }
    if ("integrity" in o) return `integrity=${String(o.integrity)}`;
  }
  return stableStringify(value).slice(0, 200);
}

export interface PathOutcome {
  digest: string;
  summary: string;
}

async function settle(fn: () => Promise<unknown>): Promise<PathOutcome> {
  try {
    const value = await fn();
    return { digest: digestOf(value), summary: summarize(value).slice(0, 240) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { digest: digestOf({ threw: message }), summary: `threw: ${message}`.slice(0, 240) };
  }
}

// ── The default-mode paths ───────────────────────────────────────────────

export const DEFAULT_PATHS = [
  "crypto.verify(object)",
  "crypto.verify(json)",
  "crypto.verify(expectedType=receipt)",
  "crypto.verifyReceipt()",
  "crypto.verifyReceipt({})",
  "crypto.verifyReceipt({strictHashBinding:false})",
  "crypto.verifyReceiptVerdict",
  "verifier.verifyArtifact(object)",
  "verifier.verifyArtifact(json)",
  "verifier.verifyFile",
  "runtime/relay verifyExecutionReceipt",
] as const;
export type DefaultPath = (typeof DEFAULT_PATHS)[number];

/** Run every default-mode path on a fresh copy of `receipt`. */
export async function runDefaultPaths(
  libs: DefaultVerifierLibs,
  receipt: unknown,
): Promise<Record<DefaultPath, PathOutcome>> {
  const json = JSON.stringify(receipt);
  const clone = (): never => JSON.parse(json) as never;
  const { crypto: c, verifier: v } = libs;
  const dir = mkdtempSync(join(tmpdir(), "default-verdict-"));
  try {
    const file = join(dir, "receipt.json");
    writeFileSync(file, json, "utf8");
    return {
      "crypto.verify(object)": await settle(() => c.verify(clone())),
      "crypto.verify(json)": await settle(() => c.verify(json)),
      "crypto.verify(expectedType=receipt)": await settle(() =>
        c.verify(clone(), { expectedType: "receipt" }),
      ),
      "crypto.verifyReceipt()": await settle(() => c.verifyReceipt(clone())),
      "crypto.verifyReceipt({})": await settle(() => c.verifyReceipt(clone(), {})),
      "crypto.verifyReceipt({strictHashBinding:false})": await settle(() =>
        c.verifyReceipt(clone(), { strictHashBinding: false }),
      ),
      "crypto.verifyReceiptVerdict": await settle(() => c.verifyReceiptVerdict(clone())),
      "verifier.verifyArtifact(object)": await settle(() => v.verifyArtifact(clone() as object)),
      "verifier.verifyArtifact(json)": await settle(() => v.verifyArtifact(json)),
      "verifier.verifyFile": await settle(() => v.verifyFile(file)),
      "runtime/relay verifyExecutionReceipt": await settle(() => {
        const r = clone() as unknown as Obj;
        return c.verifyExecutionReceipt(r as never, c.hexToBytes(r.public_key as string));
      }),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── The golden's compact form ────────────────────────────────────────────

/** One case in the golden: receipt digest, per-path verdict digests, per-path summary indices. */
export type GoldenCell = [string, string[], number[]];
export interface Golden {
  base: string;
  fuzz_seed: number;
  fuzz_runs: number;
  paths: string[];
  summaries: string[];
  cells: Record<string, GoldenCell>;
}
/** 128 bits of SHA-256 — plenty to detect a verdict change, a third of the bytes. */
export const short = (digest: string): string => digest.slice(0, 32);

/** Serialize the golden one case per line, so a regenerated golden diffs legibly. */
export function serializeGolden(
  base: string,
  outcomes: Array<{ name: string; receipt: unknown; paths: Record<DefaultPath, PathOutcome> }>,
): string {
  const summaries: string[] = [];
  const index = new Map<string, number>();
  const at = (summary: string): number => {
    let i = index.get(summary);
    if (i === undefined) {
      i = summaries.length;
      summaries.push(summary);
      index.set(summary, i);
    }
    return i;
  };
  const lines = outcomes.map(({ name, receipt, paths }) => {
    const cell: GoldenCell = [
      short(digestOf(receipt)),
      DEFAULT_PATHS.map((p) => short(paths[p].digest)),
      DEFAULT_PATHS.map((p) => at(paths[p].summary)),
    ];
    return `    ${JSON.stringify(name)}: ${JSON.stringify(cell)}`;
  });
  return [
    "{",
    `  "base": ${JSON.stringify(base)},`,
    `  "fuzz_seed": ${FUZZ_SEED},`,
    `  "fuzz_runs": ${FUZZ_RUNS},`,
    `  "paths": ${JSON.stringify(DEFAULT_PATHS)},`,
    `  "summaries": [\n${summaries.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ],`,
    '  "cells": {',
    lines.join(",\n"),
    "  }",
    "}",
    "",
  ].join("\n");
}

// ── Keys and key spellings ───────────────────────────────────────────────

interface Key {
  fill: number;
  priv: Uint8Array;
  hex: string;
}

async function keyFromFill(fill: number): Promise<Key> {
  const priv = new Uint8Array(32).fill(fill);
  const pub = await getPublicKeyBySuite(priv, SUITE);
  return { fill, priv, hex: bytesToHex(pub) };
}

/** Rewrite the first even-aligned hex pair matching `pick` via `to`; null if none. */
function respellPair(
  hex: string,
  pick: (pair: string) => boolean,
  to: (pair: string) => string,
): string | null {
  for (let i = 0; i < hex.length; i += 2) {
    const pair = hex.slice(i, i + 2);
    if (pick(pair)) return hex.slice(0, i) + to(pair) + hex.slice(i + 2);
  }
  return null;
}

const ABSENT: unique symbol = Symbol("absent");
type Spelled = Json | typeof ABSENT | null;

/**
 * Key spellings. Each returns the `public_key` value to embed (signed in that
 * spelling with the key's real private half), or null when the key has no pair
 * the spelling can rewrite. Several decode, under a parseInt-per-pair hex
 * decoder, to the real key bytes — those are the H1 cells.
 */
const KEY_SPELLINGS: Array<[string, (k: Key, other: Key) => Spelled]> = [
  ["hex-lower", (k) => k.hex],
  ["hex-upper", (k) => k.hex.toUpperCase()],
  [
    "hex-mixed",
    (k) =>
      k.hex
        .split("")
        .map((ch, i) => (i % 2 ? ch.toUpperCase() : ch))
        .join(""),
  ],
  // parseInt("ag", 16) === 0x0a — a partially-parseable pair decodes like "0a".
  [
    "partial-g",
    (k) =>
      respellPair(
        k.hex,
        (p) => p[0] === "0",
        (p) => `${p[1]}g`,
      ),
  ],
  [
    "partial-space",
    (k) =>
      respellPair(
        k.hex,
        (p) => p[0] === "0",
        (p) => ` ${p[1]}`,
      ),
  ],
  [
    "partial-plus",
    (k) =>
      respellPair(
        k.hex,
        (p) => p[0] === "0",
        (p) => `+${p[1]}`,
      ),
  ],
  // parseInt("-a", 16) === -10, stored as 0xf6.
  [
    "partial-negative",
    (k) =>
      respellPair(
        k.hex,
        (p) => parseInt(p, 16) >= 0xf1,
        (p) => `-${(256 - parseInt(p, 16)).toString(16)}`,
      ),
  ],
  // parseInt("zz", 16) is NaN, stored as 0.
  [
    "nan-as-zero",
    (k) =>
      respellPair(
        k.hex,
        (p) => p === "00",
        () => "zz",
      ),
  ],
  ["short-62", (k) => k.hex.slice(0, 62)],
  ["long-65", (k) => `${k.hex}0`],
  ["long-66", (k) => `${k.hex}00`],
  ["trailing-newline", (k) => `${k.hex}\n`],
  ["spaces-64", () => " ".repeat(64)],
  ["empty-string", () => ""],
  ["absent", () => ABSENT],
  ["null", () => null],
  ["number", () => 7],
  ["boolean", () => true],
  ["object", () => ({})],
  ["array-of-chars", (k) => k.hex.split("")],
  // String(["ab", "z"]) === "ab,z" and parseInt("ab,z", 16) === 0xab: an array
  // of 64 entries decodes, pair by pair, to the real key.
  [
    "array-of-pairs",
    (k) => {
      const out: string[] = [];
      for (let i = 0; i < k.hex.length; i += 2) out.push(k.hex.slice(i, i + 2), "z");
      return out;
    },
  ],
  ["wrong-key", (_k, other) => other.hex],
];

// ── Receipt minting ──────────────────────────────────────────────────────

function baseBody(taskId: string, result = "ok"): Obj {
  return {
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
    result_hash: createHash("sha256").update(result, "utf8").digest("hex"),
  };
}

/** Sign `body` (with `public_key` as spelled and the suite stamped) over its canonical bytes. */
async function signRaw(body: Obj, key: Key, publicKey: Spelled, suite: unknown = SUITE) {
  const full: Obj = { ...body };
  if (publicKey !== ABSENT) full.public_key = publicKey;
  if (suite !== ABSENT) full.suite = suite;
  const sig = await ed25519Sign(new TextEncoder().encode(canonicalJson(full)), key.priv);
  return { ...full, signature: toBase64Url(sig) };
}

// ── The corpus ───────────────────────────────────────────────────────────

/** Build the deterministic corpus. Names are unique and stable. */
export async function buildDefaultVerdictCorpus(): Promise<CorpusCase[]> {
  const pool: Key[] = [];
  for (let fill = 1; fill <= 96; fill++) pool.push(await keyFromFill(fill));
  const other = pool[0]!;
  /** The first pool key (≠ other) the spelling can rewrite, and its spelled value. */
  const spell = (name: string, f: (k: Key, o: Key) => Spelled): { key: Key; value: Spelled } => {
    for (const k of pool.slice(1)) {
      const s = f(k, other);
      if (s !== null || name === "null") return { key: k, value: s };
    }
    throw new Error(`no key in the pool supports spelling ${name}`);
  };
  const spellings = KEY_SPELLINGS.map(([name, f]) => ({ name, ...spell(name, f) }));
  const good = pool[1]!;

  // Children, built once and shared.
  const child = async (id: string, keyName = "hex-lower") => {
    const s = spellings.find((x) => x.name === keyName)!;
    return signRaw(baseBody(id), s.key, s.value);
  };
  const chain = async (depth: number, leaf?: unknown): Promise<unknown> => {
    let node: unknown = leaf ?? (await child(`leaf-${depth}`));
    for (let d = depth - 1; d >= 1; d--) {
      node = await signRaw(
        { ...baseBody(`chain-${d}`), delegation_receipts: [node] },
        good,
        good.hex,
      );
    }
    return node;
  };
  const validChild = await child("child-valid");
  const validChild2 = await child("child-valid-2", "hex-upper");
  const badSigChild = { ...validChild, result: "tampered" };
  const noKeyChild = await child("child-no-key", "absent");
  const lenientKeyChild = await child("child-partial-g", "partial-g");
  const nullInside = await signRaw(
    { ...baseBody("child-holds-null"), delegation_receipts: [null] },
    good,
    good.hex,
  );
  const loneChild = await signRaw(baseBody("child-lone", "x\uD800y"), good, good.hex);

  const DELEGATIONS: Array<[string, () => unknown]> = [
    ["none", () => ABSENT],
    ["empty", () => []],
    ["[null]", () => [null]],
    ["[number]", () => [42]],
    ["[string]", () => ["receipt"]],
    ["[array]", () => [[]]],
    ["[{}]", () => [{}]],
    ["[valid]", () => [validChild]],
    ["[valid,valid]", () => [validChild, validChild2]],
    ["[valid,null]", () => [validChild, null]],
    ["[bad-sig]", () => [badSigChild]],
    ["[no-key]", () => [noKeyChild]],
    ["[lenient-key]", () => [lenientKeyChild]],
    ["[lone-surrogate]", () => [loneChild]],
    ["[holds-null]", () => [nullInside]],
    ["chain-3", () => chain(3).then((c) => [c])],
    ["chain-cap", () => chain(DEPTH_CAP).then((c) => [c])],
    ["chain-cap-bad-leaf", () => chain(DEPTH_CAP, badSigChild).then((c) => [c])],
    ["chain-cap-null-leaf", () => chain(DEPTH_CAP - 1, nullInside).then((c) => [c])],
    ["string", () => "receipts"],
    ["object", () => ({})],
    ["number", () => 5],
    ["null", () => null],
    ["false", () => false],
  ];

  const cases: CorpusCase[] = [];

  // 1. Matrix: every key spelling × every delegation shape.
  for (const s of spellings) {
    for (const [dname, make] of DELEGATIONS) {
      const deleg = await make();
      const body = baseBody(`m:${s.name}:${dname}`);
      if (deleg !== ABSENT) body.delegation_receipts = deleg;
      cases.push({
        name: `key=${s.name} × deleg=${dname}`,
        receipt: await signRaw(body, s.key, s.value),
      });
    }
  }

  // 2. Random: text, missing/extra fields, suites, signatures, result_hash, on
  //    a random key spelling and delegation shape.
  const unit = fc.oneof(
    fc.constantFrom("\uD800", "\uDBFF", "\uDC00", "\uDFFF", "😀", "é", "a", "\u0000", '"', "\\"),
    fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)),
  );
  const descriptor = fc.record({
    key: fc.nat({ max: spellings.length - 1 }),
    deleg: fc.nat({ max: DELEGATIONS.length - 1 }),
    result: fc.oneof(fc.string({ unit, maxLength: 12 }), fc.constant(""), fc.constant(5)),
    resultHash: fc.constantFrom("match", "mismatch", "uppercase", "absent", "number"),
    suite: fc.constantFrom("ok", "ok", "absent", "unknown", "number"),
    signature: fc.constantFrom("ok", "ok", "ok", "tampered", "absent", "number", "empty"),
    drop: fc.subarray(["task_id", "motebit_id", "status", "result", "tools_used", "prompt_hash"], {
      maxLength: 2,
    }),
    extra: fc.option(fc.string({ unit, maxLength: 6 }), { nil: undefined }),
    taskId: fc.string({ unit, maxLength: 8 }),
  });
  const samples = fc.sample(descriptor, { seed: FUZZ_SEED, numRuns: FUZZ_RUNS });
  for (const [i, d] of samples.entries()) {
    const s = spellings[d.key]!;
    const body = baseBody(d.taskId, typeof d.result === "string" ? d.result : "x");
    body.result = d.result;
    const resultBytes = typeof d.result === "string" ? d.result : String(d.result);
    const digest = createHash("sha256").update(resultBytes, "utf8").digest("hex");
    if (d.resultHash === "match") body.result_hash = digest;
    else if (d.resultHash === "mismatch") body.result_hash = "b".repeat(64);
    else if (d.resultHash === "uppercase") body.result_hash = digest.toUpperCase();
    else if (d.resultHash === "absent") delete body.result_hash;
    else body.result_hash = 12;
    for (const f of d.drop) delete body[f];
    if (d.extra !== undefined) body.extra_field = d.extra;
    const deleg = await DELEGATIONS[d.deleg]![1]();
    if (deleg !== ABSENT) body.delegation_receipts = deleg;
    const suite =
      d.suite === "ok" ? SUITE : d.suite === "absent" ? ABSENT : d.suite === "unknown" ? "x-v9" : 1;
    const signed: Obj = await signRaw(body, s.key, s.value, suite);
    if (d.signature === "tampered") {
      const sig = signed.signature as string;
      signed.signature = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    } else if (d.signature === "absent") delete signed.signature;
    else if (d.signature === "number") signed.signature = 0;
    else if (d.signature === "empty") signed.signature = "";
    cases.push({
      name: `fuzz#${i} key=${s.name} deleg=${DELEGATIONS[d.deleg]![0]} sig=${d.signature} suite=${d.suite}`,
      receipt: signed,
    });
  }

  // 3. Non-object inputs to the receipt verifiers.
  for (const [name, value] of [
    ["input=null", null],
    ["input=array", []],
    ["input=string", "receipt"],
  ] as const) {
    cases.push({ name, receipt: value });
  }

  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.name)) throw new Error(`duplicate corpus case name: ${c.name}`);
    seen.add(c.name);
  }
  return cases;
}
