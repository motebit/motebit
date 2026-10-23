/**
 * Tamper checks for "a guardian named only by the presented identity file is
 * never a trust root" — each removal of the rule, applied alone, must turn the
 * named test red.
 *
 * Every entry re-opens one door: the binding primitive's file-guardian
 * fallback, the migration and anchored wrappers forwarding the file's guardian,
 * and the receipt-document consumer copying the file's guardian into the
 * trusted slot (the "copy it into the new parameter" anti-pattern).
 *
 *   npx tsx scripts/tampers/guardian-not-trust-root.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEntry } from "../lib/tamper-runner.js";

/**
 * Run as a command with a red marker, not as a vitest entry: the repo's vitest
 * config pins the JSON reporter's outputFile (the precedent is
 * services/relay/tamper/accept-migration-arrivals-disabled.mjs). `-t` narrows
 * the run to the one test that must go red.
 */
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
const CRYPTO_SRC = "packages/crypto/src/index.ts";
const RECEIPT_DOC = "packages/state-export-client/src/receipt-document.ts";

const CRYPTO_TEST = "src/__tests__/guardian-not-trust-root.test.ts";
const RECEIPT_TEST = "src/__tests__/receipt-document-guardian.test.ts";
const PAGE_TEST = "src/__tests__/receipt-computer-guardian-grades.test.ts";

const ATTACK = "forged file-named guardian (attacker knows only the victim's genesis PUBLIC key)";
const RECEIPT_ATTACK = "verifyReceiptDocument — forged file-named guardian (no victim secret)";

/** Re-introduce the original fallback: file guardian when the caller passes none. */
const FALLBACK = [
  {
    file: CRYPTO_SRC,
    from: "    if (hasRecoveryLink && trustedGuardian === undefined) {",
    to: "    if (hasRecoveryLink && (false as boolean)) {",
  },
  {
    file: CRYPTO_SRC,
    from: "      hasRecoveryLink ? trustedGuardian : undefined,",
    to: "      trustedGuardian ?? identity.guardian?.public_key,",
  },
];

const TAMPERS: TamperEntry[] = [
  {
    name: "crypto: verifyKeyBindingAtTime falls back to the file's guardian",
    edits: FALLBACK,
    ...vitestCommand(
      "@motebit/crypto",
      CRYPTO_TEST,
      `${ATTACK} verifyKeyBindingAtTime (plain 3-arg call) does NOT bind and is NOT sovereign`,
    ),
  },
  {
    name: "crypto fallback, seen through verifyReceiptDocument",
    edits: FALLBACK,
    rebuild: ["@motebit/crypto"],
    ...vitestCommand(
      "@motebit/state-export-client",
      RECEIPT_TEST,
      `${RECEIPT_ATTACK} a sovereign victim id: the forged file does NOT reach sovereign (plain { identity } call)`,
    ),
  },
  {
    name: "crypto fallback, seen through receipt.computer's grading pipeline (raw verifier value)",
    edits: FALLBACK,
    rebuild: ["@motebit/crypto", "@motebit/state-export-client"],
    ...vitestCommand(
      "@motebit/verify-web",
      PAGE_TEST,
      "receipt.computer grades — guardian recovery (no page grade changes) forged guardian + recovery for a victim id: page integrity-only (unchanged); verifier sovereign → integrity-only",
    ),
  },
  {
    name: "crypto: verifyMigratingKeyBinding forwards the file's guardian as trusted",
    edits: [
      {
        file: CRYPTO_SRC,
        from: "      Date.now(),\n      trustedGuardianPublicKeyHex,\n    );",
        to: "      Date.now(),\n      trustedGuardianPublicKeyHex ?? identityFile.guardian?.public_key,\n    );",
      },
    ],
    ...vitestCommand(
      "@motebit/crypto",
      CRYPTO_TEST,
      `${ATTACK} verifyMigratingKeyBinding (the relay's exact 3-arg call shape) refuses the attack file`,
    ),
  },
  {
    name: "crypto: verifyIdentityBindingAnchored forwards the file's guardian as trusted",
    edits: [
      {
        file: CRYPTO_SRC,
        from: "    atTimestampMs,\n    trustedGuardianPublicKeyHex,\n  );",
        to: "    atTimestampMs,\n    trustedGuardianPublicKeyHex ?? identity.guardian?.public_key,\n  );",
      },
    ],
    ...vitestCommand(
      "@motebit/crypto",
      CRYPTO_TEST,
      `${ATTACK} verifyIdentityBindingAnchored (no guardian param) refuses the attack file, even with a valid inclusion proof`,
    ),
  },
  {
    name: "state-export-client: verifyReceiptDocument copies the file's guardian into the trusted slot",
    edits: [
      {
        file: RECEIPT_DOC,
        from: "      const trustedGuardian = options.trustedGuardianPublicKey;",
        to: "      const trustedGuardian =\n        options.trustedGuardianPublicKey ?? options.identity.guardian?.public_key;",
      },
    ],
    ...vitestCommand(
      "@motebit/state-export-client",
      RECEIPT_TEST,
      `${RECEIPT_ATTACK} a sovereign victim id: the forged file does NOT reach sovereign (plain { identity } call)`,
    ),
  },
  {
    name: "crypto: a null/empty/malformed trusted guardian counts as supplied (mislabelled caller_trusted)",
    edits: [
      {
        file: CRYPTO_SRC,
        from: "      : undefined;\n\n  let guardianAuthority",
        to: "      : trustedGuardianPublicKeyHex;\n\n  let guardianAuthority",
      },
    ],
    ...vitestCommand(
      "@motebit/crypto",
      CRYPTO_TEST,
      "legitimate chains through the same primitives null, empty or malformed trusted guardian is NOT supplied: not_established, never caller_trusted",
    ),
  },
];

void runTampers(TAMPERS, { root: ROOT });
