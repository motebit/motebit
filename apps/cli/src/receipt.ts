// ---------------------------------------------------------------------------
// Receipt rendering — signed ExecutionReceipt as a CLI-native artifact.
// ---------------------------------------------------------------------------
//
// CLI port of `apps/web/src/ui/receipt-artifact.ts`. Same capability (render a
// signed receipt + offline-verify the chain + walk nested delegations);
// medium-native form (tree glyphs in the scrollback, not a floating DOM
// bubble). Ring 1: same capability, different medium.
//
// Archive semantics: an in-memory `Map<task_id, ExecutionReceipt>` captures
// every receipt emerged by a `delegation_complete` chunk during the session.
// `/receipt <task-id>` re-renders on demand; this is the "history of my own
// agent" surface on the CLI. Archive does not persist across runs — the user
// already has `motebit ledger` and the relay for durable history.
//
// Offline verify: we route through `@motebit/encryption`'s `verifyReceiptChain`
// (which itself delegates to `@motebit/crypto`'s suite-dispatch). No relay
// contact. Embedded `public_key` fields are harvested into the known-keys map
// so third-party re-verification works without trusting us.
//
// Colors: all color calls go through `./colors.js`, which already respects
// `NO_COLOR` and `!process.stdout.isTTY`. Glyphs are ASCII-safe fallbacks
// (`[ok]` / `[x]`) for terminals that can't render unicode reliably, chosen
// per stream at call time.

import type { ExecutionReceipt } from "@motebit/sdk";
import { verifyReceiptChain, hexToBytes } from "@motebit/encryption";

import { bold, cyan, dim, error as errorColor, success, warn } from "./colors.js";

// ---------------------------------------------------------------------------
// Archive — in-memory map of task_id → receipt for the running REPL
// ---------------------------------------------------------------------------

const ARCHIVE = new Map<string, ExecutionReceipt>();

/**
 * Stash a receipt in the session archive. Idempotent on `task_id`.
 * Called from the stream consumer on `delegation_complete`.
 */
export function archiveReceipt(receipt: ExecutionReceipt): void {
  if (!receipt.task_id) return;
  ARCHIVE.set(receipt.task_id, receipt);
}

/** Retrieve an archived receipt by task_id. */
export function getArchivedReceipt(taskId: string): ExecutionReceipt | undefined {
  return ARCHIVE.get(taskId);
}

/** List archived task_ids in insertion order. */
export function listArchivedReceipts(): ExecutionReceipt[] {
  return Array.from(ARCHIVE.values());
}

/** Clear the session archive. Used by tests. */
export function clearReceiptArchive(): void {
  ARCHIVE.clear();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const CAPABILITY_PRICES_USD: Record<string, number> = {
  review_pr: 0.01,
  research: 0.25,
  read_url: 0.003,
  web_search: 0.005,
  summarize: 0.002,
  connection_search: 0.03,
};

function formatUsd(amount: number): string {
  if (amount >= 0.01) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(3)}`;
}

function priceFor(receipt: ExecutionReceipt): string {
  for (const cap of receipt.tools_used ?? []) {
    const p = CAPABILITY_PRICES_USD[cap];
    if (p != null) return formatUsd(p);
  }
  return "—";
}

function shortHash(hex: string | undefined, n = 12): string {
  if (!hex) return "—";
  const clean = hex.replace(/^0x/, "");
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

/**
 * Choose a status glyph. Prefers unicode when the output is a TTY that
 * advertises UTF-8; falls back to ASCII otherwise. `NO_COLOR` does not
 * imply lack of unicode, but a pipe-to-file often does.
 */
function statusGlyph(kind: "ok" | "fail" | "pending"): string {
  const unicode =
    process.stdout.isTTY !== false &&
    (process.env["LANG"]?.toLowerCase().includes("utf") ||
      process.env["LC_ALL"]?.toLowerCase().includes("utf") ||
      process.env["LC_CTYPE"]?.toLowerCase().includes("utf") ||
      !process.env["LANG"]);
  if (kind === "ok") return unicode ? "✓" : "[ok]";
  if (kind === "fail") return unicode ? "✗" : "[x]";
  return unicode ? "…" : "[...]";
}

/**
 * Build the known-keys map from every `public_key` field in the tree. This
 * mirrors `collectKnownKeys` from the web artifact — the receipts are
 * self-attesting so verification needs no external registry.
 */
function collectKnownKeys(receipt: ExecutionReceipt): Map<string, Uint8Array> {
  const keys = new Map<string, Uint8Array>();
  const visit = (r: ExecutionReceipt): void => {
    if (typeof r.public_key === "string" && r.public_key.length > 0) {
      try {
        keys.set(r.motebit_id, hexToBytes(r.public_key));
      } catch {
        // Malformed hex — verify will fail-closed on this receipt.
      }
    }
    for (const child of r.delegation_receipts ?? []) visit(child);
  };
  visit(receipt);
  return keys;
}

/**
 * Format a single receipt's header line with tree indentation. Called
 * recursively to walk `delegation_receipts`.
 */
function renderReceiptLine(receipt: ExecutionReceipt, depth: number, last: boolean): string[] {
  const lines: string[] = [];
  const prefix = depth === 0 ? "" : "  ".repeat(depth - 1) + (last ? "└─ " : "├─ ");
  const name = receipt.tools_used?.[0] ?? receipt.motebit_id.slice(0, 10);
  const price = priceFor(receipt);
  const status = receipt.status ?? "—";
  const statusColor = status === "completed" ? success : status === "failed" ? errorColor : warn;
  lines.push(
    `${dim(prefix)}${bold(name)}  ${dim("·")} ${statusColor(status)}  ${dim("·")} ${dim(price)}`,
  );

  // Detail lines under each node, further indented.
  const detailPrefix = depth === 0 ? "  " : "  ".repeat(depth) + "   ";
  lines.push(`${dim(detailPrefix + "task     ")}${cyan(shortHash(receipt.task_id))}`);
  lines.push(`${dim(detailPrefix + "signer   ")}${cyan(shortHash(receipt.motebit_id))}`);
  if (receipt.suite) {
    lines.push(`${dim(detailPrefix + "suite    ")}${dim(receipt.suite)}`);
  }
  lines.push(`${dim(detailPrefix + "sig      ")}${dim(shortHash(receipt.signature, 16))}`);
  if (receipt.public_key) {
    lines.push(`${dim(detailPrefix + "pubkey   ")}${dim(shortHash(receipt.public_key, 16))}`);
  }
  if (receipt.invocation_origin) {
    lines.push(`${dim(detailPrefix + "origin   ")}${dim(receipt.invocation_origin)}`);
  }
  const durationMs =
    typeof receipt.completed_at === "number" && typeof receipt.submitted_at === "number"
      ? receipt.completed_at - receipt.submitted_at
      : null;
  if (durationMs != null && durationMs >= 0) {
    lines.push(`${dim(detailPrefix + "duration ")}${dim(`${durationMs}ms`)}`);
  }

  // Recurse into delegation_receipts
  const children = receipt.delegation_receipts ?? [];
  for (let i = 0; i < children.length; i++) {
    lines.push(...renderReceiptLine(children[i]!, depth + 1, i === children.length - 1));
  }
  return lines;
}

/**
 * Render a receipt to stdout. Verifies the chain offline and shows a single
 * status glyph for the whole tree. Called on `delegation_complete` and by
 * `/receipt <task-id>`.
 *
 * Returns the verified flag so callers can compose their own messaging, but
 * does its own output — rendering and verification are paired by design.
 */
export async function renderReceipt(
  receipt: ExecutionReceipt,
  out: (line: string) => void = (s) => console.log(s),
): Promise<{ verified: boolean; error?: string }> {
  const lines = renderReceiptLine(receipt, 0, true);
  const header = `${dim("─ receipt ")}${dim("·")} ${cyan(shortHash(receipt.task_id))}`;
  out("");
  out(header);
  for (const line of lines) out(line);

  // Offline verify — the "oh" beat that makes the receipt evidence, not
  // a claim. Zero relay contact; embedded `public_key` fields flow into
  // the known-keys map for recursive chain verification.
  let verifiedFlag = false;
  let errorMsg: string | undefined;
  try {
    const knownKeys = collectKnownKeys(receipt);
    const tree = await verifyReceiptChain(receipt, knownKeys);
    verifiedFlag = tree.verified && allDelegationsVerified(tree);
    if (!verifiedFlag) {
      errorMsg = tree.error ?? firstUnverifiedError(tree) ?? "chain verification failed";
    }
  } catch (err) {
    verifiedFlag = false;
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  if (verifiedFlag) {
    out(`${dim("  ")}${success(statusGlyph("ok"))} ${dim("verified locally · chain intact")}`);
  } else {
    out(
      `${dim("  ")}${errorColor(statusGlyph("fail"))} ${errorColor(
        "verification failed",
      )}${errorMsg ? dim(" · " + errorMsg) : ""}`,
    );
  }
  out("");

  const ret: { verified: boolean; error?: string } = { verified: verifiedFlag };
  if (errorMsg !== undefined) ret.error = errorMsg;
  return ret;
}

// ---------------------------------------------------------------------------
// Verify-tree walkers
// ---------------------------------------------------------------------------

interface VerifyTreeLike {
  verified: boolean;
  error?: string;
  delegations: VerifyTreeLike[];
}

function allDelegationsVerified(tree: VerifyTreeLike): boolean {
  if (!tree.verified) return false;
  for (const child of tree.delegations ?? []) {
    if (!allDelegationsVerified(child)) return false;
  }
  return true;
}

function firstUnverifiedError(tree: VerifyTreeLike): string | undefined {
  if (!tree.verified && tree.error) return tree.error;
  for (const child of tree.delegations ?? []) {
    const found = firstUnverifiedError(child);
    if (found) return found;
  }
  return undefined;
}
