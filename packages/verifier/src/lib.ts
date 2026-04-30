/**
 * Library core — thin wrapper over `@motebit/crypto`'s unified `verify()`
 * dispatcher with file-reading + human-rendering helpers. No state, no
 * side effects beyond filesystem reads you requested.
 *
 * Supported artifact kinds (auto-detected by `@motebit/crypto`):
 *   - `identity`    — `motebit.md` identity file with YAML frontmatter
 *   - `receipt`     — signed `ExecutionReceipt` JSON
 *   - `credential`  — W3C-style `VerifiableCredential` JSON
 *   - `presentation`— `VerifiablePresentation` JSON
 *   - `skill`       — directory containing `SKILL.md` + `skill-envelope.json`
 *                     plus any auxiliary `files[]` declared in the envelope
 *
 * Error handling: file I/O errors throw (caller decides how to surface).
 * Parse / signature errors are returned as `valid: false` results so the
 * caller can render a structured reason instead of catching exceptions.
 */

import { readFile, stat } from "node:fs/promises";
import { join, basename } from "node:path";

import {
  verify,
  hash as sha256Hex,
  type ArtifactType,
  type HardwareAttestationVerifiers,
  type SkillFileVerifyResult,
  type SkillVerifyResult,
  type VerifyResult,
  type VerifyOptions,
} from "@motebit/crypto";
import type { SkillEnvelope } from "@motebit/protocol";

export interface VerifyFileOptions {
  /**
   * Pin the expected artifact type. When set, detection must match or
   * the result is `valid: false` with an explanatory error. Useful in
   * CI where you want to reject a credential passed into a
   * receipt-verification step.
   */
  readonly expectedType?: ArtifactType;
  /**
   * Clock skew allowance (seconds) for credential / presentation
   * time-bounded fields (`issuanceDate`, `expirationDate`, etc.).
   * Forwarded to `@motebit/crypto`. Defaults to the crypto package's
   * default.
   */
  readonly clockSkewSeconds?: number;
  /**
   * Optional platform-specific hardware-attestation verifiers. Forwarded
   * through to `@motebit/crypto::verify` so credentials carrying a
   * `hardware_attestation` claim for `device_check` / `tpm` /
   * `play_integrity` / `webauthn` can be verified end-to-end. Leaving
   * this unset keeps the permissive-floor path fail-closed —
   * hardware-attested credentials still verify their Ed25519 proof, but the
   * `hardware_attestation` channel reports `adapter not yet shipped`
   * (the expected permissive-floor-only behavior). The BSL companion CLI
   * `@motebit/verify` wires all four leaves automatically.
   */
  readonly hardwareAttestation?: HardwareAttestationVerifiers;
}

/**
 * Verify an artifact read from disk. Auto-detects type via content
 * inspection in `@motebit/crypto`.
 *
 * Path-shape dispatch:
 *   - Directory → routed to `verifySkillDirectory` (a skill ships as
 *     `<dir>/SKILL.md` + `<dir>/skill-envelope.json` plus any auxiliary
 *     files declared in `envelope.files[]`). The full envelope-sig +
 *     body-hash + per-file-hash cross-check runs on disk.
 *   - File → read as bytes and routed through `verifyArtifact`, which
 *     calls `@motebit/crypto`'s detector.
 */
export async function verifyFile(path: string, opts?: VerifyFileOptions): Promise<VerifyResult> {
  // I/O failures bubble up per the existing contract — the caller
  // (CLI, library consumer) decides whether to surface or transform.
  const stats = await stat(path);
  if (stats.isDirectory()) {
    return verifySkillDirectory(path, opts);
  }
  const content = await readFile(path, "utf-8");
  return verifyArtifact(content, opts);
}

/**
 * Body-bytes extraction from a SKILL.md file. Splits on the YAML
 * frontmatter delimiters and returns the LF-normalized body bytes — the
 * exact input that `signSkillEnvelope` hashed at sign time, per
 * `spec/skills-v1.md` §5.1.
 *
 * Light-weight by design: no YAML parse, no schema validation. The
 * verifier needs body bytes for hashing, not a structured manifest. A
 * malformed frontmatter (no closing `---`) returns `null` so the caller
 * surfaces it as `body_hash` step `actual: null` rather than throwing.
 */
function extractSkillBody(rawText: string): Uint8Array | null {
  // Strip the UTF-8 BOM (U+FEFF) if present, then normalize line
  // endings. Regex unicode-escape keeps the source ASCII-only.
  const text = rawText
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const closing = text.indexOf("\n---\n", 4);
  if (closing === -1) return null;
  const bodyStart = closing + "\n---\n".length;
  return new TextEncoder().encode(text.slice(bodyStart));
}

/**
 * Verify a skill directory end-to-end: envelope signature + body hash
 * + every declared file hash. Reads `<dir>/skill-envelope.json` and
 * `<dir>/SKILL.md`, plus each file in `envelope.files[]` from the
 * directory tree, then composes the unified `SkillVerifyResult`.
 *
 * Faithful to `services/relay/CLAUDE.md` rule 6 ("relay is a
 * convenience layer, not a trust root") at the ecosystem layer: an
 * agentskills.io user with a skill they downloaded from anywhere can
 * run `motebit-verify <path-to-skill-dir>` and answer "is this signed
 * AND do the bytes match the signature?" without trusting any motebit
 * service.
 *
 * I/O failures (missing envelope, missing SKILL.md, unreadable
 * directory) return `valid: false` with named errors rather than
 * throwing, so the CLI's structured-output path can surface them
 * uniformly with signature/hash failures.
 */
export async function verifySkillDirectory(
  dir: string,
  opts?: VerifyFileOptions,
): Promise<SkillVerifyResult> {
  const envelopePath = join(dir, "skill-envelope.json");
  const skillMdPath = join(dir, "SKILL.md");

  let envelopeJson: string;
  try {
    envelopeJson = await readFile(envelopePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return invalidSkillResult(`failed to read ${basename(envelopePath)}: ${msg}`);
  }
  let envelope: SkillEnvelope;
  try {
    envelope = JSON.parse(envelopeJson) as SkillEnvelope;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return invalidSkillResult(`failed to parse ${basename(envelopePath)}: ${msg}`);
  }

  // Honor an explicit `--expect skill` override at this layer too —
  // mirrors the opts.expectedType plumb-through the JSON path uses.
  if (opts?.expectedType !== undefined && opts.expectedType !== "skill") {
    return invalidSkillResult(
      `Expected type "${opts.expectedType}" but found a skill directory`,
      envelope,
    );
  }

  // Step 1 — envelope signature (delegated to crypto's primitive via
  // the unified verify dispatcher; result already includes the
  // body_hash/files-pending error which we'll discard once the on-disk
  // checks land below).
  const sigResult = (await verify(envelope)) as SkillVerifyResult;

  // Step 2 — body_hash cross-check.
  let skillMd: string | null = null;
  try {
    skillMd = await readFile(skillMdPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return composeSkillResult(
      envelope,
      sigResult.steps.envelope,
      null,
      [],
      [{ message: `failed to read ${basename(skillMdPath)}: ${msg}`, path: "body_hash" }],
    );
  }
  const bodyBytes = extractSkillBody(skillMd);
  if (bodyBytes === null) {
    return composeSkillResult(
      envelope,
      sigResult.steps.envelope,
      null,
      [],
      [
        {
          message: `${basename(skillMdPath)} is not a valid SKILL.md (missing frontmatter delimiters)`,
          path: "body_hash",
        },
      ],
    );
  }
  const bodyHashActual = await sha256Hex(bodyBytes);
  const bodyHashStep = {
    valid: bodyHashActual === envelope.body_hash.toLowerCase(),
    expected: envelope.body_hash,
    actual: bodyHashActual,
  };

  // Step 3 — per-file cross-check.
  const fileSteps: SkillFileVerifyResult[] = [];
  for (const entry of envelope.files) {
    const filePath = join(dir, entry.path);
    let fileBytes: Uint8Array;
    try {
      const buf = await readFile(filePath);
      fileBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      fileSteps.push({
        path: entry.path,
        valid: false,
        expected: entry.hash,
        actual: null,
        reason: "missing",
      });
      continue;
    }
    const actual = await sha256Hex(fileBytes);
    fileSteps.push({
      path: entry.path,
      valid: actual === entry.hash.toLowerCase(),
      expected: entry.hash,
      actual,
      reason: actual === entry.hash.toLowerCase() ? "ok" : "hash_mismatch",
    });
  }

  return composeSkillResult(envelope, sigResult.steps.envelope, bodyHashStep, fileSteps, []);
}

function invalidSkillResult(message: string, envelope?: SkillEnvelope): SkillVerifyResult {
  return {
    type: "skill",
    valid: false,
    envelope: envelope ?? null,
    ...(envelope ? { skill: `${envelope.skill.name}@${envelope.skill.version}` } : {}),
    ...(envelope ? { signer: envelope.signature.public_key } : {}),
    steps: {
      envelope: { valid: false, reason: "wrong_suite" },
      body_hash: null,
      files: [],
    },
    errors: [{ message }],
  };
}

function composeSkillResult(
  envelope: SkillEnvelope,
  envelopeStep: SkillVerifyResult["steps"]["envelope"],
  bodyHashStep: SkillVerifyResult["steps"]["body_hash"],
  fileSteps: ReadonlyArray<SkillFileVerifyResult>,
  extraErrors: ReadonlyArray<{ message: string; path?: string }>,
): SkillVerifyResult {
  const filesAllOk = fileSteps.every((f) => f.valid);
  const valid =
    envelopeStep.valid &&
    bodyHashStep !== null &&
    bodyHashStep.valid &&
    filesAllOk &&
    extraErrors.length === 0;
  const errors: Array<{ message: string; path?: string }> = [...extraErrors];
  if (!envelopeStep.valid) {
    errors.push({
      message: `envelope signature verification failed (${envelopeStep.reason})`,
      path: "signature",
    });
  }
  if (bodyHashStep !== null && !bodyHashStep.valid) {
    errors.push({
      message: `body_hash mismatch — expected ${bodyHashStep.expected}, got ${bodyHashStep.actual}`,
      path: "body_hash",
    });
  }
  for (const f of fileSteps) {
    if (!f.valid) {
      errors.push({
        message:
          f.reason === "missing"
            ? `file declared in envelope.files[] but not found on disk: ${f.path}`
            : `file hash mismatch for ${f.path} — expected ${f.expected}, got ${f.actual ?? "<missing>"}`,
        path: `files[${f.path}]`,
      });
    }
  }
  return {
    type: "skill",
    valid,
    envelope,
    skill: `${envelope.skill.name}@${envelope.skill.version}`,
    signer: envelope.signature.public_key,
    steps: { envelope: envelopeStep, body_hash: bodyHashStep, files: fileSteps },
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/**
 * Verify an already-loaded artifact. Accepts a JSON string, an
 * already-parsed object, or a `motebit.md` identity string.
 */
export function verifyArtifact(
  content: string | object,
  opts?: VerifyFileOptions,
): Promise<VerifyResult> {
  const cryptoOpts: VerifyOptions | undefined =
    opts?.expectedType !== undefined ||
    opts?.clockSkewSeconds !== undefined ||
    opts?.hardwareAttestation !== undefined
      ? {
          ...(opts.expectedType !== undefined && { expectedType: opts.expectedType }),
          ...(opts.clockSkewSeconds !== undefined && {
            clockSkewSeconds: opts.clockSkewSeconds,
          }),
          ...(opts.hardwareAttestation !== undefined && {
            hardwareAttestation: opts.hardwareAttestation,
          }),
        }
      : undefined;
  return verify(content, cryptoOpts);
}

/**
 * Render a `VerifyResult` as the CLI's default human-readable block.
 * `--json` bypasses this and prints the raw result directly.
 *
 * Layout:
 *   ```
 *   VALID (receipt)
 *     signer: did:motebit:...
 *     id:     rcpt_01JZN...
 *   ```
 * or
 *   ```
 *   INVALID (credential)
 *     - credentialSubject.id missing
 *     - signature mismatch
 *   ```
 */
export function formatHuman(result: VerifyResult): string {
  const header = `${result.valid ? "VALID" : "INVALID"} (${result.type})`;
  const lines: string[] = [header];

  if (result.valid) {
    const summary = summarizeValid(result);
    for (const [k, v] of summary) {
      lines.push(`  ${k.padEnd(8)} ${v}`);
    }
  } else {
    const errs = "errors" in result && result.errors ? result.errors : [];
    if (errs.length === 0) {
      lines.push("  (no detail provided)");
    } else {
      for (const e of errs) {
        lines.push(`  - ${e.message}`);
      }
    }
  }

  return lines.join("\n");
}

function summarizeValid(result: VerifyResult): ReadonlyArray<readonly [string, string]> {
  switch (result.type) {
    case "identity": {
      if (!result.identity) return [];
      const out: Array<readonly [string, string]> = [];
      if (result.did) out.push(["did:", result.did]);
      if (result.identity.service_name) {
        out.push(["name:", result.identity.service_name]);
      }
      out.push(["id:", result.identity.motebit_id]);
      return out;
    }
    case "receipt": {
      if (!result.receipt) return [];
      const out: Array<readonly [string, string]> = [];
      out.push(["task:", result.receipt.task_id]);
      out.push(["motebit:", result.receipt.motebit_id]);
      if (result.signer) out.push(["signer:", result.signer]);
      return out;
    }
    case "credential": {
      if (!result.credential) return [];
      const out: Array<readonly [string, string]> = [];
      if (result.issuer) out.push(["issuer:", result.issuer]);
      if (result.subject) out.push(["subject:", result.subject]);
      if (result.expired !== undefined) {
        out.push(["expired:", result.expired ? "yes" : "no"]);
      }
      // Hardware-attestation channel — shown only when the credential's
      // subject declared a claim. Absent field = no line (no hardware
      // claim was made, which is different from "fails"). Verifier CLI
      // output is the user's only hook into this until a GUI surface
      // grows one, so the line is terse but unambiguous.
      if (result.hardware_attestation) {
        const ha = result.hardware_attestation;
        const status = ha.valid ? "✓" : "✗";
        const platform = ha.platform ?? "unknown";
        out.push(["hardware:", `${platform} ${status}`]);
      }
      return out;
    }
    case "presentation": {
      if (!result.presentation) return [];
      const out: Array<readonly [string, string]> = [];
      if (result.holder) out.push(["holder:", result.holder]);
      if (result.credentials) {
        out.push(["creds:", String(result.credentials.length)]);
      }
      return out;
    }
    case "skill": {
      if (!result.envelope) return [];
      const out: Array<readonly [string, string]> = [];
      if (result.skill) out.push(["skill:", result.skill]);
      if (result.signer) out.push(["signer:", result.signer]);
      const env = result.steps.envelope.valid ? "✓" : "✗";
      out.push(["envelope:", `${env} ${result.steps.envelope.reason}`]);
      if (result.steps.body_hash !== null) {
        const body = result.steps.body_hash.valid ? "✓" : "✗";
        out.push([
          "body:",
          `${body} sha256 ${result.steps.body_hash.valid ? "matches" : "differs"}`,
        ]);
      }
      if (result.steps.files.length > 0) {
        const passed = result.steps.files.filter((f) => f.valid).length;
        out.push(["files:", `${passed}/${result.steps.files.length} verified`]);
      }
      return out;
    }
  }
}
