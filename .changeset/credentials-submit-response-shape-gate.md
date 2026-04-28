---
"@motebit/runtime": patch
"@motebit/relay": patch
---

Land drift gate `check-credentials-submit-response-shape` (invariant #60) and fix the bug it caught in `packages/runtime/src/interactive-delegation.ts`.

**The post-mortem:** commit `63fa2199` reverted a hardware-attestation publish flow on 2026-04-25 because the surface tests mocked `fetch` to return `{ok: true, status: 200}` while the relay's actual reject path returned HTTP 200 with `{accepted: 0, rejected: 1, errors: ["self-issued credential rejected"]}`. The publish helpers checked only `resp.ok` and reported `kind: "submitted"` while the relay's index never accepted any submission. Memory `lesson_hardware_attestation_self_issued_dead_drop` named the mechanical detector at the time but the detector never landed as code.

**What we found three days post-revert:** `packages/runtime/src/interactive-delegation.ts:84-89` — the peer-flow Phase 1 ship that came after the revert wired credential submission through the runtime's `setCredentialSubmitter`. The new submitter (called for legitimately peer-issued credentials, so most posts succeed) checked only `resp.ok`. Same bug shape, different location, three days later. A malformed credential, signature failure, or any future server-side filter would have slipped silently.

**The fix:** parse the body, read `body.rejected ?? 0`, and log `body_rejected` with `{accepted, rejected, errors, targetMotebitId}` when non-zero. HTTP failures still log `http_failed` separately so the two failure modes are distinguishable.

**The gate:** scans `packages/**`, `apps/**`, `services/**` TypeScript (excluding tests, generated, and the relay's own server-side handler). Finds every real `fetch(...)` call against `/credentials/submit` (multi-line fetch with URL on continuation line caught via 500-char lookahead, ruling out comment-only mentions). Any file with a real submitter must reference both `accepted` and `rejected` as identifier tokens — the cheapest evidence the response body is being parsed.

**Doctrinal generalization:** HTTP 200 ≠ business success when the response body carries an `accepted`/`rejected` count. Status codes describe the transport; body shapes describe the outcome. If a second body-rejecting endpoint emerges, the next gate clones this one with a different URL token.

Inventory: 59 → 60 invariants, 50 → 51 hard CI gates. Probe in `check-gates-effective.ts` plants a fixture submitter; gate fires with the missing-token message on both `accepted` and `rejected`.
