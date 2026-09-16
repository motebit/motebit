---
"@motebit/protocol": minor
"@motebit/sdk": minor
"motebit": minor
---

Evidence on return — increment 3 of unattended execution.

Increments 1 and 2 answered "keep working when I leave" and "stop when I withdraw it". This one answers the last clause: **show me evidence when I return.** The distinction it turns on is between what a motebit says it did and what a stranger could check without trusting it.

**A shipped claim was false, and its gate was green because it never looked.** `check-goal-artifact-signing` enumerated three surfaces — web, desktop, mobile — and the daemon was in neither its registry nor its allowlist. So for four months it printed that every registered goal-runner signs, which was true only of the three it registered, while the one surface that fires goals with nobody watching signed nothing, kept a 500-character summary, and discarded the artifact it had just produced. The doctrine memo said phase 3 shipped "across all surfaces"; all surfaces meant the three that were looked at. A scanning gate cannot go red about a file it never opens, so the fix is to widen the scan, never to disclose a narrower number — the gate now names four surfaces and states its aperture in its own header, and the drift-defenses row that recorded a path which does not exist is corrected too.

**The daemon signs, and keeps the whole result.** Migration #47 brings `response_full` and `signed_manifest` to the shared schema, which desktop and mobile had added in their own per-surface registries and the shared one never did. An unsigned result is still recorded, and recorded as unsigned: `signGoalArtifact` returns nothing when no identity is loaded, and that stays nothing, because a placeholder signature is a lie with a checksum.

**Run evidence is the sibling artifact the completion row already named.** `PolicyGate.recordResult`'s contract says plainly what the tool's verdict is not — "attribution + the tool's report, not an independent verification of the external effect — a claimed result should link to evidence from the affected system; that pointer is a sibling artifact, never inferred from this row." This is that artifact. `RunEvidenceEntry` and `RunEvidenceSink` join the protocol, the gate mints a pointer beside the completion row, and migration #47 keeps them.

The pointer is minted **at the fetch, from the tool's own content-addressed bytes**, and never by a model summarizing afterwards. The span is the text the tool returned, which `ToolResult.source_digest`'s own contract guarantees is either a verbatim span of the raw bytes or the output of the named byte-deterministic recipe over them — so it is a substring of `projection(bytes)` by construction, which is exactly the law `verifyEvidenceProvenance` applies. A span nobody retrieved cannot enter the record, because the only writer is the retrieval. Tools that did not content-address anything produce no pointer: absence is honest, and a pointer the producer cannot back is worse than none.

Spans are bounded at the producer. A prefix of a substring is still a substring, so the re-check law is unaffected, and a pointer never quietly becomes a copy of the retrieved document under a retention policy it never entered.

**`motebit runs show <run_id>`** is the return view, and its three sections carry deliberately different weights of proof. The result is what the motebit produced, signed or else its own word. The tool calls are attribution plus each tool's verdict, never proof of an outside effect. The evidence is the only part a third party can re-check. An empty evidence section says "none recorded", and says in as many words that this is not the same as nothing having been read.

Proven rather than asserted: a pointer this producer writes is round-tripped through the real `verifyEvidenceProvenance` over the real bytes — it passes, tampered bytes fail on the digest, a fabricated span fails as absent, and a recipe span fails closed as unresolved until the recipe is injected.

**Not in this increment, and named rather than half-built:** nothing re-verifies evidence automatically on the way in — the pointers are for a person or a stranger to re-check, and motebit injects no projection resolver in production, so a recipe-path span is re-checkable by a party who wires the recipe themselves. Making the daemon re-verify its own evidence before presenting it is a separate increment with a separate honesty question, since a verifier that trusts its own producer proves nothing.
