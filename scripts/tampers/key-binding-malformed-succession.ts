/**
 * Tamper checks for "the key-binding path never throws on a malformed identity
 * file" — each removal, applied alone, must turn the named test red.
 *
 *   1. The primitive's shape guard in `verifyKeyBindingAtTime` removed: a
 *      `succession` that is a string / object / array of non-records throws
 *      (`chain.some is not a function`) or binds the genesis key on an
 *      unreadable history.
 *   2. The consumer's per-rung containment in `verifyReceiptDocument` removed:
 *      an identity whose fields throw when read escapes as an exception,
 *      breaking the documented "never throws on bad input" contract.
 *
 *   npx tsx scripts/tampers/key-binding-malformed-succession.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function vitestCommand(
  pkg: string,
  test: string,
  title: string,
): Pick<TamperEntry, "command" | "redMarker"> {
  return {
    command: ["pnpm", "--filter", pkg, "exec", "vitest", "run", test, "-t", escapeRegExp(title)],
    redMarker: "Test Files  1 failed",
  };
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const TAMPERS: TamperEntry[] = [
  {
    name: "crypto: verifyKeyBindingAtTime shape guard removed",
    edits: [
      {
        file: "packages/crypto/src/index.ts",
        from: "  if (\n    (rawChain != null &&",
        to: "  if (\n    (false as boolean) &&\n    (rawChain != null &&",
      },
    ],
    ...vitestCommand(
      "@motebit/crypto",
      "src/__tests__/key-binding-malformed-succession.test.ts",
      "key binding — a malformed succession never throws and never binds succession is a string: verifyKeyBindingAtTime resolves unbound",
    ),
  },
  {
    name: "state-export-client: verifyReceiptDocument per-rung containment removed",
    edits: [
      {
        file: "packages/state-export-client/src/receipt-document.ts",
        from: "        try {\n          return await check();\n        } catch {\n          return null;\n        }\n",
        to: "        return await check();\n",
      },
    ],
    ...vitestCommand(
      "@motebit/state-export-client",
      "src/__tests__/receipt-document-malformed-succession.test.ts",
      "verifyReceiptDocument — a malformed succession never throws and never binds an identity object whose fields throw when read",
    ),
  },
];

void runTampers(TAMPERS, { root: ROOT });
