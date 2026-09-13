# Task admission — priced work enters through the relay's gate

A worker that charges for its work must not do that work for a caller whose payment nobody saw. Transport authentication answers _who is calling_; it says nothing about _whether this task was paid for_. Before this arc the two were conflated: a first-party atom accepted any relay-registered identity's signed bearer and ran `motebit_task` straight into the provider call, while the relay's settlement gate (`TASK_P2P_PROOF_REQUIRED`, balance holds, carve-outs) protected only the relay path. The relay verified the money; the worker never learned that it had. Every priced atom was, to a stranger with a free identity, an unmetered inference endpoint.

## The primitive

The relay mints, per task, a signed **task dispatch token**: an audience-bound token on the canonical mint seam (`mintAudienceToken`, `@motebit/crypto`) with

- `aud = "task:dispatch"` (a `TokenAudience` registry append, never a new token shape),
- `mid` = the worker the task is dispatched to,
- `sub` = the relay task id (the standard JWT subject claim, added to `SignedTokenPayload` as an optional, audience-specific claim),
- `digest` = hex SHA-256 of the admitted prompt — the token admits _this work_, not any work under this task id,
- a short `exp` (`TASK_DISPATCH_TOKEN_TTL_MS`) and a CSPRNG `jti`.

The relay prices the submission before minting. An unlisted capability against a priced worker prices at the worker's ceiling, never at zero, so `required_capabilities: ["bogus"]` cannot clear the P2P gate for free and walk away with an artifact the worker will honor.

It is minted only after submission has cleared the relay's existing gates, so it is the relay's signed statement that _this task, for this worker, passed the settlement checkpoint_. It confers nothing else: no scope (that is the delegation token's job), no money movement (the ledger's), no trust (the trust graph's). Records-vs-acts: it is a record of an admission decision, presented at the act.

## Where it flows — one presenter per admission

- **Relay → worker (MCP forward).** `forwardTaskViaMcp` attaches `dispatch_token` beside `relay_task_id` on every `motebit_task` call, for every dispatch site (pinned paid worker, scored local worker, capability fallback). Each forward mints a token bound to the worker it goes to.
- **Relay → submitter, only when the relay did not dispatch.** If nothing routed the task (no WebSocket, no reachable MCP endpoint, no federation), `POST /agent/:worker/task` returns `dispatch_token` bound to the intended worker (`target_agent`, else the URL agent) and the submitter presents the task directly. If the relay routed it, the response carries no token: the relay is the presenter and the submitter polls for the receipt. Two presentations of one admission would race at the worker, so the relay never hands out two.
- **Worker.** `McpServerAdapter` with `taskAdmission` set verifies the token against the pinned relay key _before_ the agent loop starts, checks `digest` against the prompt it was given, then binds `relayTaskId` to the token's `sub` (a caller-supplied `relay_task_id` that disagrees is refused, not trusted). One `sub` is admitted at most once — recorded in a durable store (`molecule-runner` persists `admitted-tasks.json` under the data dir) so a restart inside the token's TTL cannot re-admit it. A second instance on a separate volume is not covered; that is the trigger for moving the record into the shared database.

## Who enforces, and the default

`@motebit/molecule-runner` exposes `taskAdmission: "relay" | "open"` (config, else `MOTEBIT_TASK_ADMISSION`). The two molecules that spend on inference, code-review and research, opt in to `"relay"` (`MOTEBIT_TASK_ADMISSION=open` is the operator escape hatch). The relay key is the pinned `relayPublicKeyHex` / `MOTEBIT_RELAY_PUBLIC_KEY` (the money seam already carries one) when configured; an empty value is unset, a malformed value stops the boot. Otherwise the worker uses the same trust-on-first-use-with-succession primitive every delegator surface uses for the P2P treasury key (`getOrPinRelayKey`, `@motebit/runtime`): the first fetch persists a pin under the data dir, a later key change is honored only when the relay's signed succession chain roots at that pin, and an unreachable relay answers with the pin. An unresolved key denies every task; it never opens the door.

**The default is `"open"` today, deliberately, with a loud boot warning when a listing is priced and relay-registered.** The principled default is `"relay"`-when-priced: a priced listing is a promise that the work is bought. It is not yet the default because the first-party graph still has direct, un-tokened hops into priced atoms: code-review reads diffs through read-url with no relay binding, and the Researcher falls back to a free direct call when a sub-hop is not P2P-payable. Flipping the default first would refuse those hops in production before their callers carry the artifact.

**Trigger to flip:** every first-party direct caller of a priced atom forwards the relay's `dispatch_token` (code-review → read-url gains the same relay binding the Researcher has; the Researcher's not-payable fallback either binds through the relay or fails honestly instead of calling free). When that is true, change the default in `resolveTaskAdmission` to `config.syncUrl && priced ? "relay" : "open"`, delete the boot warning, and update this paragraph. The unit tests name the current default so the flip is a visible, tested decision rather than drift.

The relay itself never accepts `task:dispatch` inbound. It is a statement the relay makes, not one it consumes.

## Named gaps, carried with the flip trigger

- **Federation.** A task forwarded to a peer relay is delivered by that relay over WebSocket only (`federation-callbacks.ts`); it never MCP-forwards, and the origin relay's token is signed by a key the executor's workers do not pin. An HTTP-only priced worker behind a peer relay was already unreachable through federation; admission does not change that. The executor relay minting its own token for federated dispatch is part of the flip.
- **Retry under an intent-stable idempotency key.** A retried submission (same caller × target × prompt within the relay's idempotency window) replays the original response, token included. If the first direct presentation was admitted and then failed, the retry is refused as already admitted until the token expires, and after that as expired. Resolving this (the relay re-mints when the task has no receipt, or the delegator polls for the existing result) is also part of the flip; today the returned token is only presented on free paths where admission is off.

## What this does not do

- It does not verify payment at the worker. The worker trusts its relay's admission decision, exactly as it already trusts the relay for discovery and settlement records. A worker that wants to verify the chain itself keeps that option open through the same `sub` (the task id joins the relay ledger and the onchain proof).
- It does not close the proxy's snapshot-balance window or the relay's verify-after-dispatch for P2P proofs. Those are the relay's own gates; this arc makes the worker refuse work that never reached them.
- It does not change transport auth. A worker still needs its bearer or signed-caller verifier; the shared relay master token remains the relay's transport credential on forwards.

## Companion law

[`paid-failure-recourse.md`](paid-failure-recourse.md) says an agent must not advertise what it cannot currently perform. The mirror obligation is here: an agent must not _perform_ what was never bought. Together they make the trust graph a fair recourse — nobody is scored on free work they were tricked into, and nobody pays for a promise the worker could not keep.
