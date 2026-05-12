---
"@motebit/protocol": minor
---

Add optional `submit_button_id?: string` to `ReadPageResult` — typed-truth hint naming the page's primary submit button by `element_id`.

Additive (new optional field). Detected at extraction time by the cloud-browser dispatcher via two signals in order: (1) HTML semantic — first button with `input_type === "submit"` wins; (2) label heuristic fallback — first button label matching a submit-class word (`Search`, `Submit`, `Send`, `Sign in`, `Log in`, `Continue`, `Go`, `Subscribe`, `Next`, `Save`, `Post`), case-insensitive, whole-label-or-prefix match. Absent when the page has no submit-class element.

Converts the AI's form-submission decision from prompt-only teaching (the 14-line `click_element-over-key("Enter")` bullet) to runtime-backed typed-truth: the wire field carries the "right tool for this page" signal that the AI's selection would otherwise have to derive from unstructured prompt rules. Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md` — exemplar of B→A graduation. Gated by `check-typed-truth-perception` (#80, registered as the 10th typed-truth field) so the prompt-teaching and dispatch-emission halves cannot drift apart.
