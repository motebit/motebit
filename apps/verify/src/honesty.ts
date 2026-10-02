/**
 * "What this proves / what this does not prove" — the honesty block. Static
 * limits plus two lines that follow the verifier's result: HOW the key binds to
 * the motebit_id (the rung reached), and whether key compromise was checked at
 * all. Calm and precise: a key minted a second ago verifies `sovereign`, so
 * sovereign must read as a math binding, never as trust.
 */

import type { ReceiptDocumentVerification } from "@motebit/state-export-client";

export interface Honesty {
  readonly proves: readonly string[];
  readonly doesNotProve: readonly string[];
}

function bindingLine(v: ReceiptDocumentVerification): string {
  switch (v.binding) {
    case "sovereign":
      return "How the key binds to this motebit_id: the id is a hash of the key (sovereign). That is arithmetic — a key minted a second ago binds the same way.";
    case "anchored":
      return "How the key binds to this motebit_id: through the relay's identity log, whose root is published on-chain (anchored).";
    case "pinned":
      return "How the key binds to this motebit_id: through the identity chain the relay served (pinned).";
    default:
      return "How the key binds to this motebit_id: it does not — the motebit_id here is only a claim.";
  }
}

export function honesty(v: ReceiptDocumentVerification): Honesty {
  if (!v.integrity) {
    return {
      proves: [
        "Nothing. The signature does not match these bytes, so every field is unsigned text.",
      ],
      doesNotProve: ["Who wrote it, or that it was ever signed. Treat the claim as untrusted."],
    };
  }
  const keyChecked = v.revocation === "not_revoked" || v.revocation === "revoked_after_signing";
  return {
    proves: [
      "The signer held the private key for the embedded public key.",
      "The signed bytes are unaltered since signing.",
      bindingLine(v),
    ],
    doesNotProve: [
      "That the result is correct or true — only that this signer said it.",
      "Who operates the agent behind the key.",
      "Reputation or trustworthiness. Sovereign is a binding of id to key, not a rating.",
      keyChecked
        ? "That the key was never stolen — only that no revocation was published on-chain before signing."
        : "That the key is uncompromised — revocation was not checked here.",
    ],
  };
}
