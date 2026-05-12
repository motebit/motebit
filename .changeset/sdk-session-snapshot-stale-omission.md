---
"@motebit/sdk": minor
---

Add optional `staleBytesOmissionReason` field to `SessionStateSnapshot` — typed-truth signal for "a prior tool result's `bytes_omitted_reason` is no longer the current gate's verdict."

Additive (optional field). The runtime computes the staleness by tracking the most recent omission reason emitted by `projectForAi` and comparing against the current gate state at snapshot time. When the gate that fired has since flipped (consent denied → session, sensitivity elevated → none, etc.), the snapshot carries the prior reason so the prompt's PERCEPTION_DOCTRINE clause can teach the AI to re-take rather than re-recommend the affordance for the stale reason.

Closes the failure mode where the AI tells the user "type /vision grant" after the user has already granted it — witnessed 2026-05-11 on the Google CAPTCHA flow. Same typed-truth-perception shape as `frame_stale` and `not_in_control`.
