// SPDX-License-Identifier: Apache-2.0
/**
 * Mints the NEGATIVE cases of the approval → tool call → receipt case from the
 * frozen CONTROL triad, through Motebit's canonical signers
 * (`signApprovalDecision`, `signToolInvocationReceipt`, `hashToolPayload`,
 * `getPublicKeyBySuite` in @motebit/crypto). No signature is hand-rolled.
 *
 * Each negative starts from the control bytes, changes exactly ONE thing, and
 * (except N5) is re-signed by the same fixed public demo key that signed the
 * control, so every signature is valid and only the relation fails. N5 alters
 * one signed field after signing, so only the approval signature fails. Files a
 * case does not change are byte-identical copies of the control.
 *
 * Ed25519 is deterministic, so this is reproducible byte for byte:
 *
 *   npx tsx examples/interop/approval-triad/mint-cases.mts          # write cases/
 *   npx tsx examples/interop/approval-triad/mint-cases.mts --check  # compare only
 *
 * scripts/__tests__/interop-approval-triad.test.ts calls `buildCases()` and
 * asserts the committed bytes equal what it returns.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPublicKeyBySuite,
  hashToolPayload,
  signApprovalDecision,
  signToolInvocationReceipt,
} from "../../../packages/crypto/src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CASES_DIR = join(HERE, "cases");
export const FROZEN_DIR = resolve(HERE, "../../python-receipt-verifier/fixtures");

/** Control file name in cases/<case>/ → frozen fixture it copies byte for byte. */
export const CONTROL_SOURCES: Record<string, string> = {
  "approval.json": "triad-approval-decision.json",
  "invocation.json": "triad-tool-invocation-receipt.json",
  "receipt.json": "triad-execution-receipt.json",
  "deny-receipt.json": "triad-deny-receipt.json",
};

const SUITE = "motebit-jcs-ed25519-b64-v1" as const;

// The same fixed PUBLIC demo seeds as fixtures/mint-triad-fixture.mjs.
// Agent 0x01..0x20, approver 0x21..0x40. Demo keys: never use for anything real.
function seed(start: number): Uint8Array {
  const s = new Uint8Array(32);
  for (let i = 0; i < 32; i++) s[i] = i + start;
  return s;
}
const AGENT_PRIV = seed(1);
const APPROVER_PRIV = seed(33);

type Json = Record<string, unknown>;

function unsigned(artifact: Json): Json {
  const { signature: _s, suite: _u, public_key: _k, ...body } = artifact;
  return body;
}

const serialize = (obj: unknown): string => JSON.stringify(obj, null, 2) + "\n";

/** Returns { "<case>/<file>": exact bytes } for every case file. */
export async function buildCases(): Promise<Record<string, string>> {
  const agentPub = await getPublicKeyBySuite(AGENT_PRIV, SUITE);
  const approverPub = await getPublicKeyBySuite(APPROVER_PRIV, SUITE);

  const control: Record<string, string> = {};
  for (const [name, src] of Object.entries(CONTROL_SOURCES)) {
    control[name] = readFileSync(join(FROZEN_DIR, src), "utf8");
  }
  const approval = JSON.parse(control["approval.json"]!) as Json;
  const invocation = JSON.parse(control["invocation.json"]!) as Json;

  const reApprove = async (change: Json): Promise<string> =>
    serialize(
      await signApprovalDecision(
        { ...unsigned(approval), ...change } as Parameters<typeof signApprovalDecision>[0],
        APPROVER_PRIV,
        approverPub,
      ),
    );
  const reInvoke = async (change: Json): Promise<string> =>
    serialize(
      await signToolInvocationReceipt(
        { ...unsigned(invocation), ...change } as Parameters<typeof signToolInvocationReceipt>[0],
        AGENT_PRIV,
        agentPub,
      ),
    );

  // The three joined files of a negative: control bytes unless overridden.
  const triad = (over: Partial<Record<"approval.json" | "invocation.json", string>>) => ({
    "approval.json": over["approval.json"] ?? control["approval.json"]!,
    "invocation.json": over["invocation.json"] ?? control["invocation.json"]!,
    "receipt.json": control["receipt.json"]!,
  });

  // N1: the executed call's args differ from the approved args (one field, re-signed by the agent).
  const otherArgs = await hashToolPayload({
    to: "someone-else@example.net",
    subject: "Q3 contract — signed copy",
  });
  // N5: one signed field of the approval altered AFTER signing (not re-signed).
  const tampered = { ...approval, risk_level: 1 };

  const cases: Record<string, Record<string, string>> = {
    control,
    "n1-args-hash": triad({ "invocation.json": await reInvoke({ args_hash: otherArgs }) }),
    "n2-verdict": triad({ "approval.json": await reApprove({ verdict: "denied" }) }),
    // Resolved 1 s AFTER the invocation started (control: 1 s before).
    "n3-ordering": triad({ "approval.json": await reApprove({ resolved_at: 1777109333000 }) }),
    "n4-run": triad({
      "approval.json": await reApprove({ run_id: "019dc500-0000-7000-c000-000000000a02" }),
    }),
    "n5-tampered-approval": triad({ "approval.json": serialize(tampered) }),
  };

  const out: Record<string, string> = {};
  for (const [c, files] of Object.entries(cases)) {
    for (const [f, bytes] of Object.entries(files)) out[`${c}/${f}`] = bytes;
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const built = await buildCases();
  let drift = 0;
  for (const [rel, bytes] of Object.entries(built)) {
    const path = join(CASES_DIR, rel);
    if (check) {
      let onDisk = "";
      try {
        onDisk = readFileSync(path, "utf8");
      } catch {
        /* missing → drift */
      }
      if (onDisk !== bytes) {
        drift++;
        console.error(`drift: cases/${rel}`);
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      console.log(`wrote cases/${rel}`);
    }
  }
  if (check) {
    console.log(drift === 0 ? "cases/ matches the canonical minter" : `${drift} file(s) drifted`);
    process.exit(drift === 0 ? 0 : 1);
  }
}
