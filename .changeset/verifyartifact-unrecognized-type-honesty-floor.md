---
"@motebit/crypto": minor
"@motebit/verifier": minor
"@motebit/verify": minor
---

`verify` / `verifyArtifact` report unrecognized artifacts as a distinct `type: "unknown"` instead of `valid:false` on a fabricated type — the honesty floor that keeps "I don't recognize this" from reading as "this is forged."

Before, an artifact `detectArtifactType` didn't recognize returned `{ type: options.expectedType ?? "identity", valid: false }` — so an unrecognized blob (a flat `ApprovalDecision` consumed via `verifyArtifact`, or any foreign JSON) was indistinguishable from a _tampered identity file_. That conflates "unknown type / wrong verifier" with "forged known artifact" — the one ambiguity a proof tool can't have.

- `@motebit/crypto`: new `UnknownVerifyResult` (`type:"unknown"`, `valid:false`, `reason:"unrecognized_artifact_type"`); `verify()`'s no-detection branch returns it. `detectArtifactType` never yields `"unknown"` (it returns `null`), so the dispatch switch stays exhaustive over exactly the detectable types.
- `@motebit/verifier`: `formatHuman` renders `UNRECOGNIZED (unknown)`, not `INVALID`.
- `@motebit/verify`: an unrecognized artifact exits **2** (usage/unrecognized) — distinct from 1 (invalid signature) — per the CLI exit-code contract.

**Behavior change** (minor; `valid` is unchanged — still `false`): unrecognized input now reports `type:"unknown"` rather than the old `"identity"` (or `expectedType`) fallback. A consumer that branched on the fallback type for unrecognized input should switch on `type === "unknown"`.

Completes the honesty pass begun with `ToolInvocationReceipt` auto-detect: recognized artifacts get a real verdict, unrecognized artifacts get an honest "I don't know this," and neither reads as forged.
