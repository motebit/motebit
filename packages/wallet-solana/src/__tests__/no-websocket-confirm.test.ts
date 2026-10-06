/**
 * Static gate: no websocket-subscription confirmation anywhere in `src/`.
 *
 * web3.js `confirmTransaction` / `sendAndConfirmTransaction` (and the raw
 * `onSignature` / `signatureSubscribe` subscriptions) wait on a websocket that
 * an RPC may not implement (JSON-RPC -32601). The confirm then throws after
 * the transaction LANDED, and a caller that reads the throw as "not sent" sends
 * it again — production resubmitted the same anchor memo on every cycle. Every
 * confirmation goes through `confirm-signature.ts` (HTTP polling). Repair: call
 * `confirmSignatureByPolling` / `checkSignatureOnce` instead.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const FORBIDDEN =
  /\b(confirmTransaction|sendAndConfirmTransaction|sendAndConfirmRawTransaction|onSignature|onSignatureWithOptions|signatureSubscribe)\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__") out.push(...sourceFiles(path));
    } else if (name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("no websocket confirmation in wallet-solana src", () => {
  it("every confirmation goes through confirm-signature.ts (HTTP polling)", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf-8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, "");
          if (/^\s*\*/.test(code)) return;
          if (FORBIDDEN.test(code)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(
      offenders,
      `websocket confirm found — route it through confirmSignatureByPolling (confirm-signature.ts); examined ${files.length} files`,
    ).toEqual([]);
  });
});
