/**
 * `@motebit/crypto-openpgp` — the one OpenPGP signature shape a governed repo
 * change's offline verifier accepts (spec/repo-change-v1.md §9): a git
 * commit's `gpgsig` header, one v4 RSA/SHA-256 signature, checked against
 * operator signing keys the caller pins (e.g. GitHub's `web-flow.gpg`).
 * Node built-ins only; no network; the pinned keys are injected at the call
 * site, never fetched.
 */
export { parsePinnedSigningKeys, verifyCommitSignature } from "./openpgp.js";
export type { CommitSignatureCheck, PinnedSigningKey } from "./openpgp.js";
