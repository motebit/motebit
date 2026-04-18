/**
 * `motebit verify <kind> <path>` for wire-format artifacts.
 *
 * Closes the loop on the protocol-as-published-artifact thesis. The
 * @motebit/wire-schemas package publishes JSON Schemas for every wire
 * format; this subcommand runs those schemas against a real file +
 * verifies the Ed25519 signature on signed types. A non-motebit
 * developer building a Python or Go worker can write `motebit verify
 * receipt out.json` and learn in milliseconds whether they are
 * protocol-compliant — schema-valid, suite-recognized, signature-
 * verifies, time-window-active.
 *
 * Three kinds today:
 *   - receipt  → @motebit/wire-schemas ExecutionReceiptSchema + verifyExecutionReceipt
 *   - token    → @motebit/wire-schemas DelegationTokenSchema   + verifyDelegation
 *   - listing  → @motebit/wire-schemas AgentServiceListingSchema (schema-only; not signed)
 *
 * Adding a new wire format means: register its kind here, point it at
 * the matching schema + verifier, and the CLI gains the verification
 * automatically. Same one-place-to-add pattern as build-schemas.ts.
 *
 * Identity files (motebit.md) keep their own `motebit verify <path>`
 * code path — that's a different artifact (markdown + signature footer,
 * not JSON wire format), handled by `./verify.ts`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Apps consume product vocabulary (@motebit/encryption), not protocol primitives
// (@motebit/crypto) directly — see check-app-primitives. The encryption barrel
// re-exports every receipt/delegation verifier from crypto, so the import path
// changes but the runtime behavior is identical.
import { hexToBytes, verifyDelegation, verifyExecutionReceipt } from "@motebit/encryption";
import {
  AgentServiceListingSchema,
  DelegationTokenSchema,
  ExecutionReceiptSchema,
} from "@motebit/wire-schemas";

import { dim, error as errorColor, success as successColor, bold, cyan } from "../colors.js";

export type VerifyKind = "receipt" | "token" | "listing";

const KIND_KEYWORDS: ReadonlySet<string> = new Set(["receipt", "token", "listing"]);

export function isVerifyKind(s: string): s is VerifyKind {
  return KIND_KEYWORDS.has(s);
}

/** One verification check the report can pass or fail individually. */
export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  kind: VerifyKind;
  filePath: string;
  checks: VerifyCheck[];
  /** True iff every check passed. */
  ok: boolean;
}

/**
 * Pure verification — no IO except reading the file at `filePath`. The
 * caller decides how to render (text or JSON) and what to do with the
 * exit code.
 */
export async function verifyWire(
  kind: VerifyKind,
  filePath: string,
  now: number = Date.now(),
): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const absPath = resolve(filePath);

  // (1) Read + JSON-parse
  let raw: unknown;
  try {
    const text = readFileSync(absPath, "utf-8");
    raw = JSON.parse(text);
    checks.push({ name: "json", ok: true, detail: `parsed ${text.length} bytes` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "json", ok: false, detail: msg });
    return finalize(kind, absPath, checks);
  }

  // (2) Schema-validate via the live wire-schemas zod source.
  if (kind === "receipt") {
    const parsed = ExecutionReceiptSchema.safeParse(raw);
    if (!parsed.success) {
      checks.push({ name: "schema", ok: false, detail: formatZodErrors(parsed.error.issues) });
      return finalize(kind, absPath, checks);
    }
    checks.push({ name: "schema", ok: true, detail: "ExecutionReceipt v1" });
    // (3) Suite known
    checks.push({
      name: "suite",
      ok: true,
      detail: `recognized: ${parsed.data.suite}`,
    });
    // (4) Signature
    if (parsed.data.public_key == null || parsed.data.public_key === "") {
      checks.push({
        name: "signature",
        ok: false,
        detail: "no embedded public_key — cannot verify offline",
      });
    } else {
      try {
        const valid = await verifyExecutionReceipt(parsed.data, hexToBytes(parsed.data.public_key));
        checks.push({
          name: "signature",
          ok: valid,
          detail: valid
            ? `Ed25519 over JCS body — verified with embedded public_key`
            : `Ed25519 verification returned false (signature does not match canonical body)`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({ name: "signature", ok: false, detail: `verifier threw: ${msg}` });
      }
    }
    return finalize(kind, absPath, checks);
  }

  if (kind === "token") {
    const parsed = DelegationTokenSchema.safeParse(raw);
    if (!parsed.success) {
      checks.push({ name: "schema", ok: false, detail: formatZodErrors(parsed.error.issues) });
      return finalize(kind, absPath, checks);
    }
    checks.push({ name: "schema", ok: true, detail: "DelegationToken v1" });
    // Suite check is implicit via the literal in the zod schema, but
    // surface it for symmetry with receipts.
    checks.push({ name: "suite", ok: true, detail: `recognized: ${parsed.data.suite}` });
    // Window check separately so a structural-OK + expired token has a
    // specific failure reason.
    const inWindow = now >= parsed.data.issued_at && now <= parsed.data.expires_at;
    checks.push({
      name: "window",
      ok: inWindow,
      detail: inWindow
        ? `now within [issued_at, expires_at]`
        : now < parsed.data.issued_at
          ? `not yet valid (issued_at = ${parsed.data.issued_at}, now = ${now})`
          : `expired (expires_at = ${parsed.data.expires_at}, now = ${now})`,
    });
    // Signature — verifyDelegation handles its own suite + canonicalization.
    // We pass `checkExpiry: false` because we report the window check
    // separately above, so the user sees both signals independently.
    try {
      const valid = await verifyDelegation(parsed.data, { checkExpiry: false });
      checks.push({
        name: "signature",
        ok: valid,
        detail: valid
          ? `Ed25519 over JCS body — verified with delegator_public_key`
          : `Ed25519 verification returned false`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({ name: "signature", ok: false, detail: `verifier threw: ${msg}` });
    }
    return finalize(kind, absPath, checks);
  }

  // listing
  const parsed = AgentServiceListingSchema.safeParse(raw);
  if (!parsed.success) {
    checks.push({ name: "schema", ok: false, detail: formatZodErrors(parsed.error.issues) });
    return finalize(kind, absPath, checks);
  }
  checks.push({ name: "schema", ok: true, detail: "AgentServiceListing v1" });
  checks.push({
    name: "signature",
    ok: true,
    detail: "n/a — listings are not self-signed (relay-authenticated PUT)",
  });
  return finalize(kind, absPath, checks);
}

function finalize(kind: VerifyKind, filePath: string, checks: VerifyCheck[]): VerifyReport {
  return { kind, filePath, checks, ok: checks.every((c) => c.ok) };
}

function formatZodErrors(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
): string {
  return issues
    .map((i) => `${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Plain-text report. Default output. */
export function formatReportText(report: VerifyReport): string {
  const lines: string[] = [];
  const headerStatus = report.ok ? successColor("✓ OK") : errorColor("✗ FAIL");
  lines.push(`${headerStatus}  ${bold(report.kind)}  ${dim(report.filePath)}`);
  for (const check of report.checks) {
    const icon = check.ok ? successColor("  ✓") : errorColor("  ✗");
    lines.push(`${icon} ${check.name.padEnd(10)} ${dim(check.detail)}`);
  }
  if (!report.ok) {
    lines.push("");
    lines.push(
      `Failures: ${report.checks
        .filter((c) => !c.ok)
        .map((c) => cyan(c.name))
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** JSON report — for `--json` and programmatic consumers. */
export function formatReportJson(report: VerifyReport): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// Subcommand entry
// ---------------------------------------------------------------------------

export interface HandleVerifyWireOpts {
  json: boolean;
}

export async function handleVerifyWire(
  kindArg: string | undefined,
  pathArg: string | undefined,
  opts: HandleVerifyWireOpts,
): Promise<void> {
  if (kindArg == null || !isVerifyKind(kindArg)) {
    console.error(`Usage: motebit verify <receipt|token|listing|identity> <path> [--json]`);
    process.exit(2);
  }
  if (pathArg == null || pathArg === "") {
    console.error(`Usage: motebit verify ${kindArg} <path> [--json]`);
    process.exit(2);
  }
  const report = await verifyWire(kindArg, pathArg);
  const out = opts.json ? formatReportJson(report) : formatReportText(report);
  process.stdout.write(out + "\n");
  if (!report.ok) process.exit(1);
}
