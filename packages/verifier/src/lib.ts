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
 *
 * Error handling: file I/O errors throw (caller decides how to surface).
 * Parse / signature errors are returned as `valid: false` results so the
 * caller can render a structured reason instead of catching exceptions.
 */

import { readFile } from "node:fs/promises";

import { verify, type ArtifactType, type VerifyResult, type VerifyOptions } from "@motebit/crypto";

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
}

/**
 * Verify an artifact read from disk. Auto-detects type via content
 * inspection in `@motebit/crypto`.
 */
export async function verifyFile(path: string, opts?: VerifyFileOptions): Promise<VerifyResult> {
  const content = await readFile(path, "utf-8");
  return verifyArtifact(content, opts);
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
    opts?.expectedType !== undefined || opts?.clockSkewSeconds !== undefined
      ? {
          ...(opts.expectedType !== undefined && { expectedType: opts.expectedType }),
          ...(opts.clockSkewSeconds !== undefined && {
            clockSkewSeconds: opts.clockSkewSeconds,
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
  }
}
