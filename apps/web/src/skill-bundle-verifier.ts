/**
 * Browser-side local verification of a `SkillRegistryBundle` returned by
 * the relay. Independent of the relay's claim — we re-derive every hash
 * and re-run the envelope signature check using the noble-based
 * primitives in `@motebit/crypto` (which work in the browser bundle).
 *
 * Why this exists. The CLI install path re-verifies bundles before
 * installing (`packages/skills/src/registry.ts:277`). The browser
 * `motebit.com/skills` detail view is the most-public motebit surface,
 * and until this helper landed it implicitly trusted whatever the relay
 * served — a tampering relay could have swapped bundle bytes and the
 * browser-side reader would never know. Per
 * `services/relay/CLAUDE.md` rule 6 ("relay is a convenience layer, not
 * a trust root") the surface MUST be able to verify the relay's
 * assertions independently. This helper closes that gap on the web
 * surface.
 *
 * Pure async — no DOM, no fetches. Render layer wraps it.
 */

import {
  verifySkillEnvelopeDetailed,
  decodeSkillSignaturePublicKey,
  sha256,
  bytesToHex,
} from "@motebit/encryption";
import type { SkillVerifyDetail } from "@motebit/encryption";
import type { SkillRegistryBundle } from "@motebit/sdk";

export type VerifyOutcome =
  | { kind: "verified" }
  | { kind: "envelope_failed"; reason: SkillVerifyDetail["reason"] }
  | { kind: "body_hash_mismatch"; expected: string; actual: string }
  | { kind: "file_hash_mismatch"; path: string; expected: string; actual: string }
  | { kind: "decode_failed"; what: "body" | "file"; path?: string };

export interface VerifyResult {
  outcome: VerifyOutcome;
  /** True iff every step passed. */
  ok: boolean;
  /** Step-level details so the UI can render a checklist. */
  steps: {
    envelope: { ok: boolean; reason: SkillVerifyDetail["reason"] };
    bodyHash: { ok: boolean; expected: string; actual: string | null };
    files: ReadonlyArray<{ path: string; ok: boolean; expected: string; actual: string | null }>;
  };
}

/**
 * Decode a base64 (URL-safe or standard) string to bytes. Tolerates both
 * the URL-safe alphabet (`-`, `_`) and standard (`+`, `/`); pads as
 * needed so callers don't have to normalize.
 */
function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function verifyBundleLocally(bundle: SkillRegistryBundle): Promise<VerifyResult> {
  const { envelope } = bundle;

  // 1. Envelope signature — re-derived against the embedded public_key.
  const publicKey = decodeSkillSignaturePublicKey(envelope.signature);
  const envDetail = await verifySkillEnvelopeDetailed(envelope, publicKey);
  const envelopeStep = { ok: envDetail.valid, reason: envDetail.reason };

  // 2. body_hash — sha256 of decoded body bytes MUST match envelope.body_hash.
  // Decode failure is itself a verification failure (we couldn't even
  // attempt the hash match), so it surfaces as a distinct outcome.
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = base64ToBytes(bundle.body);
  } catch {
    return {
      outcome: { kind: "decode_failed", what: "body" },
      ok: false,
      steps: {
        envelope: envelopeStep,
        bodyHash: { ok: false, expected: envelope.body_hash, actual: null },
        files: [],
      },
    };
  }
  const bodyHashActual = bytesToHex(await sha256(bodyBytes));
  const bodyHashStep = {
    ok: bodyHashActual === envelope.body_hash.toLowerCase(),
    expected: envelope.body_hash,
    actual: bodyHashActual,
  };

  // 3. files[] — for any auxiliary file the bundle ships bytes for, the
  // sha256 MUST match the entry in envelope.files. The bundle MAY omit
  // files (the relay returns an empty `files` map for skills that have
  // none), in which case there is nothing to cross-check at this layer.
  const fileSteps: Array<{
    path: string;
    ok: boolean;
    expected: string;
    actual: string | null;
  }> = [];
  const bundleFiles = bundle.files ?? {};
  for (const entry of envelope.files) {
    const stored = bundleFiles[entry.path];
    if (stored == null) {
      // Envelope declares a file but the bundle didn't ship it. Treat as
      // an unverifiable claim — display as a failed step rather than
      // silently ignoring.
      fileSteps.push({ path: entry.path, ok: false, expected: entry.hash, actual: null });
      continue;
    }
    let fileBytes: Uint8Array;
    try {
      fileBytes = base64ToBytes(stored);
    } catch {
      return {
        outcome: { kind: "decode_failed", what: "file", path: entry.path },
        ok: false,
        steps: { envelope: envelopeStep, bodyHash: bodyHashStep, files: fileSteps },
      };
    }
    const actual = bytesToHex(await sha256(fileBytes));
    fileSteps.push({
      path: entry.path,
      ok: actual === entry.hash.toLowerCase(),
      expected: entry.hash,
      actual,
    });
  }

  // Aggregate the outcome — any failed step turns the verdict negative.
  const allFilesOk = fileSteps.every((f) => f.ok);
  const ok = envelopeStep.ok && bodyHashStep.ok && allFilesOk;

  let outcome: VerifyOutcome;
  if (!envelopeStep.ok) {
    outcome = { kind: "envelope_failed", reason: envelopeStep.reason };
  } else if (!bodyHashStep.ok) {
    outcome = {
      kind: "body_hash_mismatch",
      expected: envelope.body_hash,
      actual: bodyHashActual,
    };
  } else if (!allFilesOk) {
    const bad = fileSteps.find((f) => !f.ok);
    outcome = {
      kind: "file_hash_mismatch",
      path: bad?.path ?? "<unknown>",
      expected: bad?.expected ?? "",
      actual: bad?.actual ?? "<missing>",
    };
  } else {
    outcome = { kind: "verified" };
  }

  return {
    outcome,
    ok,
    steps: { envelope: envelopeStep, bodyHash: bodyHashStep, files: fileSteps },
  };
}
