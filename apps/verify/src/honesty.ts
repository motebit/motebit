/**
 * "What this proves / what this does not prove" — the honesty block. Static
 * limits plus two lines that follow the display verdict (`assess.ts`): HOW the
 * key binds to the motebit_id (the rung the evidence supports), and whether key
 * compromise was established at all. Calm and precise: a key minted a second
 * ago commits to its own id, so a key commitment must read as arithmetic, never
 * as trust or as current authorization.
 */

import type { DisplayVerdict } from "./assess.js";

export interface Honesty {
  readonly proves: readonly string[];
  readonly doesNotProve: readonly string[];
}

function bindingLine(v: DisplayVerdict): string {
  switch (v.binding) {
    case "key-commitment":
      return v.idForm === "did:key"
        ? "How the key relates to this motebit_id: the id encodes the key (a did:key), so the identity commitment matches the motebit's original key. That is arithmetic — a key minted a second ago commits the same way."
        : "How the key relates to this motebit_id: the id is derived from the key, so the identity commitment matches the motebit's original key. That is arithmetic — a key minted a second ago commits the same way.";
    case "anchored":
      return "How the key binds to this motebit_id: through the relay's identity log, whose root was found on-chain through an independent RPC (anchored), at the time this receipt claims.";
    case "pinned":
      return v.chainRoot === "id-commitment"
        ? "How the key binds to this motebit_id: through the identity chain the relay served (pinned), which roots at the key the id commits to, at the time this receipt claims."
        : "How the key binds to this motebit_id: through the identity chain the relay served (pinned), at the time this receipt claims.";
    default:
      return "How the key binds to this motebit_id: it does not — the motebit_id here is only a claim.";
  }
}

export function honesty(v: DisplayVerdict): Honesty {
  if (!v.integrity) {
    return {
      proves: [
        "Nothing. The signature does not match these bytes, so every field is unsigned text.",
      ],
      doesNotProve: ["Who wrote it, or that it was ever signed. Treat the claim as untrusted."],
    };
  }
  // Only a complete independent scan with NO memo at any date counts as checked.
  const keyChecked = v.revocation === "not_revoked";
  const notProven = [
    "That the result is correct or true — only that this signer said it.",
    "Who operates the agent behind the key.",
    "Reputation or trustworthiness. A binding of id to key is not a rating.",
  ];
  if (v.binding === "key-commitment") {
    notProven.push(
      v.chainCheck !== undefined
        ? "That this key was still the motebit's key when the receipt was issued — completed_at is the signer's own claim, and the identity chain the relay served does not bind the key even at that claimed time."
        : "That this key was still the motebit's key when the receipt was issued — completed_at is the signer's own claim, and rotation and revocation were not established.",
    );
  }
  if (v.binding === "pinned" || v.binding === "anchored") {
    notProven.push(
      "When the receipt was issued — completed_at is the signer's own claim; a key retired later can still sign a receipt dated inside its old window.",
    );
    notProven.push(
      "That the relay served the whole chain — a later rotation it did not serve would not show here.",
    );
  }
  notProven.push(
    v.binding === "revoked"
      ? "That the key was revoked — the revocation memo is unauthenticated; who posted it was not checked."
      : keyChecked
        ? "That the key was never stolen — only that no revocation memo naming it, at any date, is at the anchor address the relay declares (a complete scan of that one address through an independent RPC); memos anywhere else were not looked for."
        : "That the key is uncompromised — revocation was not established here.",
  );
  return {
    proves: [
      "The signer held the private key for the embedded public key.",
      "The signed bytes are unaltered since signing.",
      bindingLine(v),
    ],
    doesNotProve: notProven,
  };
}
