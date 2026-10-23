/**
 * @vitest-environment jsdom
 *
 * CLAIMED vs PROVEN — an adversarial matrix over every field the receipt's
 * signer or the relay controls, run through the REAL page (page-harness.ts).
 *
 * The class this suite exists for: a value the signer or relay CHOSE was read
 * as if the page had PROVEN it. Three cold-review rounds found instances of the
 * same class one at a time; this suite enumerates the space instead.
 *
 *   claimed time   completed_at is written by the signer. It can be backdated
 *                  into a retired key's window, set in the future, put exactly
 *                  on a rotation instant, or not be a number at all. The page
 *                  may say the key fits the window AT THE TIME THE RECEIPT
 *                  CLAIMS; it may never treat that time as when the receipt was
 *                  issued, and never compare a revocation memo against it to
 *                  clear the key.
 *   id form        motebit_id is written by the signer and echoed by the relay.
 *                  Only an exactly canonical id may bind: a lowercase UUIDv8 or
 *                  did:key (the id commits to the key) or a lowercase legacy
 *                  UUIDv7/v4 (the relay's record is the root). Any other form —
 *                  zero-width, bidi, homoglyph, whitespace, case, prefixes —
 *                  binds nothing, and the copy says the id is not canonical
 *                  (never that it is a forgery).
 *   chain          the relay chooses which succession links to serve. It can
 *                  withhold a later rotation, duplicate, reorder or drop links.
 *   revocation     a memo naming the key is unauthenticated and its date is the
 *                  poster's claim. ANY memo found for the key is REVOCATION
 *                  REPORTED with its source, whatever its date relative to the
 *                  receipt's claimed time — and whether or not it carries a
 *                  usable date at all; never ✓. A ✓ states its real scope: one
 *                  complete scan of the anchor address the relay declares.
 *   field form     public_key, signature and suite are the signer's text, like
 *                  the id. The verifier decodes the key and signature leniently
 *                  (an appended character, whitespace, a sign, upper case,
 *                  padding, the standard alphabet all decode to the same bytes),
 *                  so a re-spelled key still verifies — while any lookup keyed
 *                  on the TEXT misses the owner's memo. Only the exact canonical
 *                  form earns anything above INTEGRITY ONLY: public_key is
 *                  exactly 64 lowercase hex, signature exactly unpadded base64url
 *                  of 64 bytes (the receipt suite's encoding), suite exactly
 *                  motebit-jcs-ed25519-b64-v1. Anything else reads "not in
 *                  canonical form" (or "suite not recognized"), never a ✓,
 *                  never "forged" — and the page's own memo scan runs on the
 *                  DECODED key, so a re-spelled key still shows its owner's memo.
 *
 * Each case's expected display is written from that contract, not from what
 * the page happened to render.
 */
import { chai, describe, expect, it } from "vitest";
import {
  bytesToHex,
  canonicalJsonForSigning,
  deriveSovereignMotebitId,
  getPublicKeyBySuite,
  hash,
  hexPublicKeyToDidKey,
  signBySuite,
  signExecutionReceipt,
  signKeySuccession,
  toBase64Url,
  verifyReceipt,
  type KeySuccessionRecord,
} from "@motebit/crypto";
import {
  FILLER_200,
  container,
  grade,
  installPageHooks,
  linkHash,
  openPage,
  rung,
  settled,
  type MockCtx,
} from "./page-harness.js";

installPageHooks();
// Print every failed contract clause, not a truncated prefix.
chai.config.truncateThreshold = 0;

const B64 = "motebit-jcs-ed25519-b64-v1";
const INDEPENDENT_RPC = "http://localhost:8899";
const PROXY_SOURCE = "via Motebit's RPC proxy (not independently confirmed)";
const INDEPENDENT_SOURCE = "through an RPC the operator does not run";
const CREATED_AT = 1780000000000;
const AT = 1790000001000;

interface Key {
  readonly priv: Uint8Array;
  readonly pub: Uint8Array;
  readonly hex: string;
}
async function kp(start: number): Promise<Key> {
  const priv = new Uint8Array(32);
  for (let i = 0; i < 32; i++) priv[i] = (start + i) & 0xff;
  const pub = await getPublicKeyBySuite(priv, B64);
  return { priv, pub, hex: bytesToHex(pub) };
}

async function receipt(
  key: Key,
  motebitId: string,
  completedAt: unknown,
  task = "cvp-task",
): Promise<string> {
  const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
  const result = "Paid invoice #42 for $5.00.";
  const body = {
    task_id: task,
    motebit_id: motebitId,
    device_id: "cvp-device",
    submitted_at: AT - 1000,
    completed_at: completedAt,
    status: "completed",
    result,
    tools_used: [],
    memories_formed: 0,
    prompt_hash: await hash(utf8("prompt")),
    result_hash: await hash(utf8(result)),
  };
  // completed_at is deliberately untyped: a signer can put anything there.
  const signed = await signExecutionReceipt(
    body as unknown as Parameters<typeof signExecutionReceipt>[0],
    key.priv,
    key.pub,
  );
  return JSON.stringify(signed, null, 2);
}

/**
 * Mint a receipt whose identity-bearing fields are written exactly as given —
 * the signer chooses the text of public_key, suite and signature, and the
 * signature covers whatever public_key and suite text it chose.
 */
async function mintAs(o: {
  readonly key: Key;
  readonly id: string;
  readonly at?: unknown;
  readonly keyText?: string;
  readonly suite?: string;
  readonly sig?: (canonical: string) => string;
  readonly task?: string;
}): Promise<string> {
  const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
  const result = "Paid invoice #42 for $5.00.";
  const body = {
    task_id: o.task ?? "cvp-form",
    motebit_id: o.id,
    device_id: "cvp-device",
    submitted_at: AT - 1000,
    completed_at: o.at ?? AT,
    status: "completed",
    result,
    tools_used: [],
    memories_formed: 0,
    prompt_hash: await hash(utf8("prompt")),
    result_hash: await hash(utf8(result)),
    public_key: o.keyText ?? o.key.hex,
    suite: o.suite ?? B64,
  };
  const sig = toBase64Url(await signBySuite(B64, utf8(canonicalJsonForSigning(body)), o.key.priv));
  return JSON.stringify({ ...body, signature: o.sig ? o.sig(sig) : sig }, null, 2);
}

function bundle(id: string, current: string, succession: KeySuccessionRecord[] = []): unknown {
  return {
    motebit_id: id,
    created_at: new Date(CREATED_AT).toISOString(),
    current_public_key: current,
    succession,
    anchored: null,
  };
}

const memo = (hex: string, at: number): string => `motebit:revocation:v1:${hex}:${at}`;

/** What the contract says the page must show. */
interface Expected {
  /** The badge, exactly. */
  readonly grade:
    "PINNED" | "KEY COMMITMENT" | "INTEGRITY ONLY" | "REVOCATION REPORTED" | "INVALID";
  /** The revocation rung: ✓ allowed only on a complete independent scan with no memo. */
  readonly revocation: "reported" | "ok" | "not-ok";
  /** Extra text the card must contain. */
  readonly contains?: readonly string[];
  /** Extra patterns the card must NOT contain. */
  readonly forbids?: readonly RegExp[];
}

interface Case {
  readonly name: string;
  readonly receipt: string;
  readonly ctx: MockCtx;
  readonly rpc?: string;
  readonly expected: Expected;
}

/** Copy that treats the signer's claimed time as when the receipt was signed. */
const SIGNING_TIME_AS_FACT =
  /before signing|when it signed|when signed|at the receipt's time|at this receipt's time|at or before this receipt|not revoked when signed|revoked after signing|time-valid/i;

/** The conditional a PINNED card must carry ON THE CARD (the grade block itself). */
const PINNED_CARD_CONDITIONS = [
  "succession chain the relay served",
  "at the time this receipt claims",
  "completed_at is the signer's own claim",
  "does not prove when the receipt was issued",
  "that the relay served the complete history",
  "that the key was uncompromised",
];

const NONCANONICAL = "not in canonical form";
const SUITE_UNKNOWN = "suite not recognized";
/** The ✓'s real scope (N2): one address, the one the relay declares. */
const SCAN_SCOPE = "the anchor address the relay declares";

async function buildCases(): Promise<Case[]> {
  const cases: Case[] = [];
  const victim = await kp(0x01);
  const k1 = await kp(0xb1);
  const k2 = await kp(0xe1);
  const attacker = await kp(0xa1);
  const legacy = await kp(0xd1);
  const V = await deriveSovereignMotebitId(victim.hex);
  const DIDV = hexPublicKeyToDidKey(victim.hex);
  const LEGACY_V7 = "019dc500-0000-7abc-8000-00000000beef";
  const LEGACY_V4 = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

  const rot1 = await signKeySuccession(victim.priv, k1.priv, k1.pub, victim.pub, "rotation");
  await new Promise((r) => setTimeout(r, 5));
  const rot2 = await signKeySuccession(k1.priv, k2.priv, k2.pub, k1.pub, "rotation");
  const T1 = rot1.timestamp;
  const T2 = rot2.timestamp;
  const rotated = bundle(V, k1.hex, [rot1]);
  const neverRotated = bundle(V, victim.hex);

  const add = (c: Case): void => {
    cases.push(c);
  };

  // ── Claimed time ────────────────────────────────────────────────────────
  add({
    name: "time: retired K0 backdated into its own window, full chain served",
    receipt: await receipt(victim, V, T1 - 86_400_000),
    ctx: { bundle: rotated, memos: [] },
    expected: { grade: "PINNED", revocation: "not-ok" },
  });
  add({
    name: "time: retired K0 claiming exactly the rotation instant",
    receipt: await receipt(victim, V, T1),
    ctx: { bundle: rotated, memos: [] },
    expected: { grade: "KEY COMMITMENT", revocation: "not-ok" },
  });
  add({
    name: "time: rotated-to K1 claiming exactly the rotation instant",
    receipt: await receipt(k1, V, T1),
    ctx: { bundle: rotated, memos: [] },
    expected: { grade: "PINNED", revocation: "not-ok" },
  });
  add({
    name: "time: retired K0 claiming a future time",
    receipt: await receipt(victim, V, T1 + 10 * 365 * 86_400_000),
    ctx: { bundle: rotated, memos: [] },
    expected: { grade: "KEY COMMITMENT", revocation: "not-ok" },
  });
  add({
    name: "time: never-rotated genesis key claiming a far-future time",
    receipt: await receipt(victim, V, 7_258_118_400_000),
    ctx: { bundle: neverRotated, memos: [] },
    expected: { grade: "PINNED", revocation: "not-ok" },
  });
  add({
    name: "time: completed_at is a string",
    receipt: await receipt(k1, V, String(T1 + 60_000)),
    ctx: { bundle: rotated, memos: [] },
    expected: { grade: "INTEGRITY ONLY", revocation: "not-ok" },
  });
  add({
    name: "time: completed_at before the identity was created",
    receipt: await receipt(victim, V, CREATED_AT - 1),
    ctx: { bundle: neverRotated, memos: [] },
    expected: { grade: "KEY COMMITMENT", revocation: "not-ok" },
  });
  add({
    name: "time: completed_at negative",
    receipt: await receipt(victim, V, -1),
    ctx: { bundle: neverRotated, memos: [] },
    expected: { grade: "KEY COMMITMENT", revocation: "not-ok" },
  });

  // ── Id form: a chain rooted at the attacker's key, served for a lookalike id ──
  const lookalikes: Array<[string, string]> = [
    ["UUIDv8 + zero-width space", `${V}\u200b`],
    ["UUIDv8 + trailing space", `${V} `],
    ["UUIDv8 + leading space", ` ${V}`],
    ["UUIDv8 + tab", `${V}\t`],
    ["UUIDv8 uppercase", V.toUpperCase()],
    ["UUIDv8 with a Cyrillic homoglyph", V.replace("a", "\u0430")],
    ["UUIDv8 with a bidi override", `${V.slice(0, 9)}\u202e${V.slice(9)}`],
    ["DID:KEY uppercase prefix", `DID:KEY:${DIDV.slice("did:key:".length)}`],
    ["did:key + zero-width joiner", `${DIDV}\u200d`],
    ["legacy UUIDv7 uppercase", LEGACY_V7.toUpperCase()],
    ["legacy UUIDv7 + zero-width space", `${LEGACY_V7}\u200b`],
    ["legacy UUIDv7 with a bidi override", `\u202e${LEGACY_V7}`],
    ["urn:uuid: prefix", `urn:uuid:${LEGACY_V7}`],
    ["braced UUID", `{${LEGACY_V7}}`],
    ["UUID without hyphens", LEGACY_V7.replace(/-/g, "")],
    ["UUIDv1", "019dc500-0000-1abc-8000-00000000beef"],
    ["nil UUID", "00000000-0000-0000-0000-000000000000"],
    ["UUIDv4 with an invalid variant", "3f2a1b4c-5d6e-4f70-ca9b-0c1d2e3f4a5b"],
  ];
  for (const [label, id] of lookalikes) {
    add({
      name: `id: ${label} → no binding via the relay's record`,
      receipt: await receipt(attacker, id, AT),
      ctx: { bundle: bundle(id, attacker.hex), memos: [] },
      expected: {
        grade: "INTEGRITY ONLY",
        revocation: "not-ok",
        contains: [NONCANONICAL],
        forbids: [/forg/i],
      },
    });
  }
  add({
    name: "id: uppercase UUIDv8 signed by the key it commits to (relay down) → no key commitment",
    receipt: await receipt(victim, V.toUpperCase(), AT),
    ctx: { relayDown: true },
    expected: { grade: "INTEGRITY ONLY", revocation: "not-ok", contains: [NONCANONICAL] },
  });
  add({
    name: "id: uppercase UUIDv8 signed by the key it commits to, its own chain served → no binding",
    receipt: await receipt(victim, V.toUpperCase(), AT),
    ctx: { bundle: bundle(V.toUpperCase(), victim.hex), memos: [] },
    expected: { grade: "INTEGRITY ONLY", revocation: "not-ok", contains: [NONCANONICAL] },
  });
  add({
    name: "id: canonical UUIDv8, chain rooted at its own key (control)",
    receipt: await receipt(victim, V, AT),
    ctx: { bundle: neverRotated, memos: [] },
    expected: { grade: "PINNED", revocation: "not-ok" },
  });
  add({
    name: "id: canonical legacy UUIDv7 (control)",
    receipt: await receipt(legacy, LEGACY_V7, AT),
    ctx: { bundle: bundle(LEGACY_V7, legacy.hex), memos: [] },
    expected: { grade: "PINNED", revocation: "not-ok" },
  });
  add({
    name: "id: canonical legacy UUIDv4 (control)",
    receipt: await receipt(legacy, LEGACY_V4, AT),
    ctx: { bundle: bundle(LEGACY_V4, legacy.hex), memos: [] },
    expected: { grade: "PINNED", revocation: "not-ok" },
  });
  add({
    name: "id: canonical did:key, chain rooted at its own key (control)",
    receipt: await receipt(victim, DIDV, AT),
    ctx: { bundle: bundle(DIDV, victim.hex), memos: [] },
    expected: { grade: "PINNED", revocation: "not-ok" },
  });
  add({
    name: "id: canonical did:key, relay down → KEY COMMITMENT that says the id encodes the key",
    receipt: await receipt(victim, DIDV, AT),
    ctx: { relayDown: true },
    expected: {
      grade: "KEY COMMITMENT",
      revocation: "not-ok",
      contains: ["encodes this key"],
      forbids: [/hash of/i],
    },
  });

  // ── Chain completeness: the relay chooses what to serve ─────────────────
  add({
    name: "chain: relay withholds the later rotation; retired K0 signs after it",
    receipt: await receipt(victim, V, T1 + 60_000),
    ctx: { bundle: neverRotated, memos: [] },
    expected: { grade: "PINNED", revocation: "not-ok" },
  });
  add({
    name: "chain: the rotation link served twice",
    receipt: await receipt(k1, V, T1 + 60_000),
    ctx: { bundle: bundle(V, k1.hex, [rot1, rot1]), memos: [] },
    expected: { grade: "INTEGRITY ONLY", revocation: "not-ok" },
  });
  add({
    name: "chain: links served in reverse order cannot revive retired K0",
    receipt: await receipt(victim, V, T2 + 60_000),
    ctx: { bundle: bundle(V, k2.hex, [rot2, rot1]), memos: [] },
    expected: { grade: "KEY COMMITMENT", revocation: "not-ok" },
  });
  add({
    name: "chain: the first link dropped; K2 signs",
    receipt: await receipt(k2, V, T2 + 60_000),
    ctx: { bundle: bundle(V, k2.hex, [rot2]), memos: [] },
    expected: { grade: "INTEGRITY ONLY", revocation: "not-ok" },
  });
  add({
    name: "chain: a record served for another motebit",
    receipt: await receipt(victim, V, AT),
    ctx: { bundle: bundle(LEGACY_V7, victim.hex), memos: [] },
    expected: { grade: "KEY COMMITMENT", revocation: "not-ok" },
  });

  // ── Revocation timing: ANY memo for the key is reported, whatever its date ──
  for (const [where, rpc, source] of [
    ["proxy", undefined, PROXY_SOURCE],
    ["independent RPC", INDEPENDENT_RPC, INDEPENDENT_SOURCE],
  ] as const) {
    const reported = (name: string, r: string, ctx: MockCtx): void =>
      add({
        name: `revocation (${where}): ${name}`,
        receipt: r,
        ctx,
        ...(rpc ? { rpc } : {}),
        expected: {
          grade: "REVOCATION REPORTED",
          revocation: "reported",
          contains: [source, "completed_at is the signer's own claim"],
        },
      });
    const g1 = await receipt(victim, V, AT);
    reported("memo dated before the claimed time", g1, {
      bundle: neverRotated,
      memos: [memo(victim.hex, AT - 1)],
    });
    reported("memo dated exactly at the claimed time", g1, {
      bundle: neverRotated,
      memos: [memo(victim.hex, AT)],
    });
    reported("memo dated after the claimed time", g1, {
      bundle: neverRotated,
      memos: [memo(victim.hex, AT + 1)],
    });
    reported("memo dated a year after the claimed time", g1, {
      bundle: neverRotated,
      memos: [memo(victim.hex, AT + 365 * 86_400_000)],
    });
    reported("fabricated junk memo dated after", g1, {
      bundle: neverRotated,
      memos: [`gm ser ${memo(victim.hex, 9_999_999_999_999)} lol`],
    });
    reported("one memo after and one before", g1, {
      bundle: neverRotated,
      memos: [memo(victim.hex, AT + 5), memo(victim.hex, AT - 5)],
    });
    reported(
      "backdated retired K0, memo posted just after the rotation (X13)",
      await receipt(victim, V, T1 - 86_400_000),
      { bundle: rotated, memos: [memo(victim.hex, T1 + 1)] },
    );
    reported("legacy id, memo dated after the claimed time", await receipt(legacy, LEGACY_V7, AT), {
      bundle: bundle(LEGACY_V7, legacy.hex),
      memos: [memo(legacy.hex, AT + 8999)],
    });
  }

  // ── Field form: the signing key re-spelled (K1, Y1–Y4) ─────────────────
  // Each spelling decodes (leniently) to the same 32 bytes, so the signature
  // verifies — but only exact lowercase hex is the key's canonical form.
  const respell = (hex: string): Array<[string, string]> => [
    ["an appended character", `${hex}x`],
    ["a trailing space", `${hex} `],
    ["a trailing newline", `${hex}\n`],
    ["a trailing tab", `${hex}\t`],
    ["a trailing NUL", `${hex}\u0000`],
    ["a trailing zero-width space", `${hex}\u200b`],
    ["upper case", hex.toUpperCase()],
  ];
  const k0Memo = memo(victim.hex, T1 + 1);
  const yShapes: Array<{
    readonly y: string;
    readonly key: Key;
    readonly id: string;
    readonly at: number;
    readonly bundle: unknown;
    readonly memo: string;
  }> = [
    {
      y: "Y1 genesis key",
      key: victim,
      id: V,
      at: AT,
      bundle: neverRotated,
      memo: memo(victim.hex, AT - 500),
    },
    {
      y: "Y2 rotated-to K1",
      key: k1,
      id: V,
      at: T1 + 60_000,
      bundle: rotated,
      memo: memo(k1.hex, T1 + 1000),
    },
    {
      y: "Y3 retired K0 backdated (X13)",
      key: victim,
      id: V,
      at: T1 - 86_400_000,
      bundle: rotated,
      memo: k0Memo,
    },
    {
      y: "Y4 legacy id",
      key: legacy,
      id: LEGACY_V7,
      at: AT,
      bundle: bundle(LEGACY_V7, legacy.hex),
      memo: memo(legacy.hex, AT - 500),
    },
  ];
  for (const shape of yShapes) {
    for (const [spelling, keyText] of respell(shape.key.hex)) {
      for (const [where, rpc, source] of [
        ["proxy", undefined, PROXY_SOURCE],
        ["independent RPC", INDEPENDENT_RPC, INDEPENDENT_SOURCE],
      ] as const) {
        const r = await mintAs({
          key: shape.key,
          id: shape.id,
          at: shape.at,
          keyText,
          task: "cvp-key",
        });
        add({
          name: `key (${where}): ${shape.y} with ${spelling}, owner's memo posted → the memo is still shown`,
          receipt: r,
          ctx: { bundle: shape.bundle, memos: [shape.memo] },
          ...(rpc ? { rpc } : {}),
          expected: {
            grade: "REVOCATION REPORTED",
            revocation: "reported",
            contains: [source],
            forbids: [/forg/i],
          },
        });
        add({
          name: `key (${where}): ${shape.y} with ${spelling}, no memo → INTEGRITY ONLY, not canonical, no ✓`,
          receipt: r,
          ctx: { bundle: shape.bundle, memos: [] },
          ...(rpc ? { rpc } : {}),
          expected: {
            grade: "INTEGRITY ONLY",
            revocation: "not-ok",
            contains: [NONCANONICAL],
            forbids: [/forg/i, /the chain does not contain this key/],
          },
        });
      }
    }
  }
  // Sign tricks: parseInt reads "+a", " a", "ag" as 0x0a and "-1" as 0xff.
  let trick: Key | undefined;
  for (let s = 0x11; trick === undefined; s++) {
    const k = await kp(s);
    if (/^(?:..)*0[0-9a-f]/.test(k.hex) && /^(?:..)*ff/.test(k.hex)) trick = k;
  }
  const T = trick;
  const TV = await deriveSovereignMotebitId(T.hex);
  const lowPair = /^((?:..)*?)0([0-9a-f])/.exec(T.hex)!;
  const ffPair = /^((?:..)*?)ff/.exec(T.hex)!;
  const swap = (at: number, by: string): string =>
    `${T.hex.slice(0, at)}${by}${T.hex.slice(at + 2)}`;
  const tricks: Array<[string, string]> = [
    ["a plus sign", swap(lowPair[1]!.length, `+${lowPair[2]!}`)],
    ["a leading space inside a byte", swap(lowPair[1]!.length, ` ${lowPair[2]!}`)],
    ["a non-hex second digit", swap(lowPair[1]!.length, `${lowPair[2]!}g`)],
    ["-1 for 0xff", swap(ffPair[1]!.length, "-1")],
  ];
  for (const [label, keyText] of tricks) {
    const r = await mintAs({ key: T, id: TV, keyText, task: "cvp-trick" });
    add({
      name: `key: ${label} (decodes to the same bytes), owner's memo posted → the memo is still shown`,
      receipt: r,
      ctx: { bundle: bundle(TV, T.hex), memos: [memo(T.hex, AT - 500)] },
      rpc: INDEPENDENT_RPC,
      expected: { grade: "REVOCATION REPORTED", revocation: "reported", forbids: [/forg/i] },
    });
    add({
      name: `key: ${label}, no memo → INTEGRITY ONLY, not canonical, no ✓`,
      receipt: r,
      ctx: { bundle: bundle(TV, T.hex), memos: [] },
      rpc: INDEPENDENT_RPC,
      expected: {
        grade: "INTEGRITY ONLY",
        revocation: "not-ok",
        contains: [NONCANONICAL],
        forbids: [/forg/i],
      },
    });
  }
  // Spellings that do not decode to the signing key: not verified, and not called a forgery.
  for (const [label, keyText] of [
    ["two leading zeros", `00${victim.hex}`],
    ["a leading zero (odd length)", `0${victim.hex}`],
    ["a 0x prefix", `0x${victim.hex}`],
    ["the key in base64url", toBase64Url(victim.pub)],
    ["the key as a did:key", DIDV],
  ] as const) {
    add({
      name: `key: ${label} → INVALID, says the key is not in canonical form, never "forged"`,
      receipt: await mintAs({ key: victim, id: V, keyText, task: "cvp-badkey" }),
      ctx: { bundle: neverRotated, memos: [] },
      rpc: INDEPENDENT_RPC,
      expected: {
        grade: "INVALID",
        revocation: "not-ok",
        contains: [NONCANONICAL],
        forbids: [/forg/i],
      },
    });
  }

  // ── Field form: the signature re-encoded ─────────────────────────────────
  // Find a signature that uses the URL-safe characters, so the standard
  // alphabet is a real re-spelling of it.
  let urlSafe = "";
  for (let i = 0; urlSafe === ""; i++) {
    const r = await mintAs({ key: victim, id: V, task: `cvp-sig-${i}` });
    if (/[-_]/.test((JSON.parse(r) as { signature: string }).signature)) urlSafe = `cvp-sig-${i}`;
  }
  const lastBits = (s: string): string => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const i = alphabet.indexOf(s.at(-1)!);
    return `${s.slice(0, -1)}${alphabet[i | 1]!}`;
  };
  const sigVariants: Array<[string, (s: string) => string]> = [
    ["= padding", (s) => `${s}==`],
    ["the standard base64 alphabet", (s) => s.replace(/-/g, "+").replace(/_/g, "/")],
    ["a trailing space", (s) => `${s} `],
    ["a line break inside", (s) => `${s.slice(0, 40)}\n${s.slice(40)}`],
    ["a tab inside", (s) => `${s.slice(0, 40)}\t${s.slice(40)}`],
    ["non-zero trailing bits in the last character", lastBits],
  ];
  for (const [label, f] of sigVariants) {
    const r = await mintAs({ key: victim, id: V, task: urlSafe, sig: f });
    // Whether the lenient decoder accepts a given spelling depends on the
    // runtime's atob; the contract holds either way: never above INTEGRITY
    // ONLY, never "forged", and a memo is shown whenever integrity holds.
    const decodes = (await verifyReceipt(JSON.parse(r) as Parameters<typeof verifyReceipt>[0]))
      .valid;
    add({
      name: `signature: ${label} → ${decodes ? "INTEGRITY ONLY" : "INVALID"}, not canonical, no ✓`,
      receipt: r,
      ctx: { bundle: neverRotated, memos: [] },
      rpc: INDEPENDENT_RPC,
      expected: {
        grade: decodes ? "INTEGRITY ONLY" : "INVALID",
        revocation: "not-ok",
        contains: [NONCANONICAL],
        forbids: [/forg/i],
      },
    });
    if (decodes) {
      add({
        name: `signature: ${label}, memo posted → the memo is still shown`,
        receipt: r,
        ctx: { bundle: neverRotated, memos: [memo(victim.hex, AT - 500)] },
        rpc: INDEPENDENT_RPC,
        expected: { grade: "REVOCATION REPORTED", revocation: "reported" },
      });
    }
  }
  add({
    name: 'signature: the same signature hex-encoded on the b64 suite → INVALID, not canonical, never "forged"',
    receipt: await mintAs({
      key: victim,
      id: V,
      task: urlSafe,
      sig: (s) => {
        const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
        return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      },
    }),
    ctx: { bundle: neverRotated, memos: [] },
    rpc: INDEPENDENT_RPC,
    expected: {
      grade: "INVALID",
      revocation: "not-ok",
      contains: [NONCANONICAL],
      forbids: [/forg/i],
    },
  });
  add({
    name: "signature: canonical (control)",
    receipt: await mintAs({ key: victim, id: V, task: urlSafe }),
    ctx: { bundle: neverRotated, memos: [] },
    rpc: INDEPENDENT_RPC,
    expected: { grade: "PINNED", revocation: "ok" },
  });

  // ── Field form: the suite ────────────────────────────────────────────────
  // The receipt verifier checks every receipt under the b64 suite whatever its
  // `suite` says, so the field is the signer's unchecked text.
  for (const [label, suite] of [
    ["the hex suite (wrong suite for a receipt)", "motebit-jcs-ed25519-hex-v1"],
    ["an unknown suite", "motebit-jcs-ed25519-b64-v9"],
    ["a trailing space", `${B64} `],
    ["upper case", B64.toUpperCase()],
    ["a zero-width space", `${B64}\u200b`],
    ["an empty string", ""],
  ] as const) {
    const r = await mintAs({ key: victim, id: V, suite, task: "cvp-suite" });
    add({
      name: `suite: ${label} → INTEGRITY ONLY, suite not recognized, no ✓`,
      receipt: r,
      ctx: { bundle: neverRotated, memos: [] },
      rpc: INDEPENDENT_RPC,
      expected: {
        grade: "INTEGRITY ONLY",
        revocation: "not-ok",
        contains: [SUITE_UNKNOWN],
        forbids: [/forg/i],
      },
    });
    add({
      name: `suite: ${label}, memo posted → the memo is still shown`,
      receipt: r,
      ctx: { bundle: neverRotated, memos: [memo(victim.hex, AT - 500)] },
      rpc: INDEPENDENT_RPC,
      expected: { grade: "REVOCATION REPORTED", revocation: "reported" },
    });
  }
  add({
    name: "suite: a legacy id with an unknown suite → INTEGRITY ONLY, never PINNED",
    receipt: await mintAs({ key: legacy, id: LEGACY_V7, suite: "x", task: "cvp-suite-legacy" }),
    ctx: { bundle: bundle(LEGACY_V7, legacy.hex), memos: [] },
    rpc: INDEPENDENT_RPC,
    expected: { grade: "INTEGRITY ONLY", revocation: "not-ok", contains: [SUITE_UNKNOWN] },
  });
  add({
    name: "all four fields canonical, relay down → KEY COMMITMENT (control)",
    receipt: await mintAs({ key: victim, id: V, task: "cvp-all" }),
    ctx: { relayDown: true },
    expected: { grade: "KEY COMMITMENT", revocation: "not-ok" },
  });

  // ── N1: a memo naming the key without a usable date is still a memo ──────
  for (const [where, rpc, source] of [
    ["proxy", undefined, PROXY_SOURCE],
    ["independent RPC", INDEPENDENT_RPC, INDEPENDENT_SOURCE],
  ] as const) {
    const g = await receipt(victim, V, AT, "cvp-n1");
    for (const [label, m] of [
      ["an empty timestamp", `motebit:revocation:v1:${victim.hex}:`],
      ["a word for a timestamp", `motebit:revocation:v1:${victim.hex}:revoked`],
      ["no timestamp separator", `motebit:revocation:v1:${victim.hex}`],
      [
        "a 400-digit timestamp (overflows to Infinity)",
        `motebit:revocation:v1:${victim.hex}:${"9".repeat(400)}`,
      ],
      [
        "a timestamp past the last representable date",
        `motebit:revocation:v1:${victim.hex}:99999999999999999`,
      ],
      ["an upper-case key", `motebit:revocation:v1:${victim.hex.toUpperCase()}:5`],
    ] as const) {
      add({
        name: `revocation (${where}): a memo with ${label} → REVOCATION REPORTED, never ignored`,
        receipt: g,
        ctx: { bundle: neverRotated, memos: [m] },
        ...(rpc ? { rpc } : {}),
        expected: { grade: "REVOCATION REPORTED", revocation: "reported", contains: [source] },
      });
    }
  }

  // ── N3: a claimed time outside the displayable range is still shown ──────
  for (const [label, at, shown] of [
    ["1e20", 1e20, "100000000000000000000"],
    ["one past the last displayable date", 8_640_000_000_000_001, "8640000000000001"],
    ["a fraction", AT + 0.5, `${AT + 0.5}`],
  ] as const) {
    add({
      name: `time: completed_at ${label} → shown in the claim as the signer's value`,
      receipt: await receipt(victim, V, at, "cvp-n3"),
      ctx: { bundle: neverRotated, memos: [] },
      expected: {
        grade: "PINNED",
        revocation: "not-ok",
        contains: [shown],
      },
    });
  }
  add({
    name: "revocation: a memo beyond the 200-signature window is not hidden behind ✓",
    receipt: await receipt(victim, V, AT),
    ctx: { bundle: neverRotated, memos: [...FILLER_200, memo(victim.hex, AT + 1)] },
    rpc: INDEPENDENT_RPC,
    expected: { grade: "PINNED", revocation: "not-ok" },
  });
  add({
    name: "revocation: a memo for another key (control)",
    receipt: await receipt(victim, V, AT),
    ctx: { bundle: neverRotated, memos: [memo(attacker.hex, AT - 1)] },
    rpc: INDEPENDENT_RPC,
    expected: { grade: "PINNED", revocation: "ok" },
  });
  add({
    name: "revocation: the RPC fails",
    receipt: await receipt(victim, V, AT),
    ctx: { bundle: neverRotated, rpcFail: true },
    rpc: INDEPENDENT_RPC,
    expected: { grade: "PINNED", revocation: "not-ok" },
  });
  return cases;
}

// Minted at collection time so every case is its own named test.
const cases = await buildCases();

function mark(key: string): "ok" | "skip" | "fail" | null {
  const m = rung(key)?.querySelector(".check-mark");
  if (m === null || m === undefined) return null;
  return m.classList.contains("ok") ? "ok" : m.classList.contains("fail") ? "fail" : "skip";
}

/** Assert one rendered case against its contract. Returns the failures, empty when it holds. */
function check(c: Case): string[] {
  const bad: string[] = [];
  const text = container().textContent ?? "";
  const card = container().querySelector(".grade")?.textContent ?? "";
  const e = c.expected;
  if (grade() !== e.grade) bad.push(`grade ${String(grade())} ≠ ${e.grade}`);
  if (/sovereign/i.test(text)) bad.push("says sovereign");
  const claim = container().querySelector(".claim")?.textContent ?? "";
  const claimedAt = (JSON.parse(c.receipt) as { completed_at?: unknown }).completed_at;
  if (typeof claimedAt === "number" && !claim.includes("completed (signer's claim)")) {
    bad.push("claim field does not mark completed_at as claimed");
  }
  const t = SIGNING_TIME_AS_FACT.exec(text);
  if (t) bad.push(`treats the claimed time as the signing time: "${t[0]}"`);
  // The binding rung is ✓ only on a bound grade; never ✗ (not established is "—").
  const b = mark("binding");
  if (e.grade === "PINNED" ? b !== "ok" : b === "ok") bad.push(`binding rung ${String(b)}`);
  if (b === "fail") bad.push("binding rung is ✗, the state is not established");
  const r = mark("revocation");
  if (e.revocation === "reported") {
    if (r !== "fail") bad.push(`revocation rung ${String(r)}, expected a reported memo`);
    if (!text.includes("REVOCATION REPORTED (unauthenticated)"))
      bad.push("no unauthenticated label");
    if (container().querySelector(".chip-ok") !== null) bad.push("claim chip is ok");
  } else if (e.revocation === "ok") {
    if (r !== "ok") bad.push(`revocation rung ${String(r)}, expected ✓`);
    // N2: the ✓ names its scope, on the rung and in the honesty block.
    const rungText = rung("revocation")?.textContent ?? "";
    if (!rungText.includes(SCAN_SCOPE)) bad.push(`revocation ✓ does not say "${SCAN_SCOPE}"`);
    const notProves = container().querySelector(".not-proves")?.textContent ?? "";
    if (!notProves.includes(SCAN_SCOPE)) bad.push(`honesty block does not say "${SCAN_SCOPE}"`);
    if (/found on-chain/.test(notProves))
      bad.push("honesty block says the memo was not found on-chain");
  } else if (r === "ok") {
    bad.push("revocation rung ✓ without a complete independent scan and no memo");
  }
  if (e.grade === "PINNED") {
    for (const p of PINNED_CARD_CONDITIONS) {
      if (!card.includes(p)) bad.push(`PINNED card lacks "${p}"`);
    }
  }
  if (e.grade === "KEY COMMITMENT" && !card.includes("completed_at is the signer's own claim")) {
    bad.push("KEY COMMITMENT card does not say completed_at is the signer's claim");
  }
  for (const s of e.contains ?? []) if (!text.includes(s)) bad.push(`lacks "${s}"`);
  for (const f of e.forbids ?? []) if (f.test(text)) bad.push(`contains ${String(f)}`);
  return bad;
}

describe("claimed vs proven: every signer- or relay-controlled field", () => {
  it("the matrix is populated", () => {
    expect(cases.length).toBeGreaterThan(50);
  });

  for (const c of cases) {
    it(c.name, async () => {
      await openPage({
        hash: linkHash(c.receipt),
        ctx: c.ctx,
        ...(c.rpc !== undefined ? { rpc: c.rpc } : {}),
      });
      await settled();
      expect(check(c).join("; ")).toBe("");
    });
  }
});
