# Task admission — priced work enters through the relay's gate

A worker that charges for its work must not do that work for a caller whose payment nobody saw. Transport authentication answers _who is calling_; it says nothing about _whether this task was paid for_. Before this arc the two were conflated: a first-party atom accepted any relay-registered identity's signed bearer and ran `motebit_task` straight into the provider call, while the relay's settlement gate (`TASK_P2P_PROOF_REQUIRED`, balance holds, carve-outs) protected only the relay path. The relay verified the money; the worker never learned that it had. Every priced atom was, to a stranger with a free identity, an unmetered inference endpoint.

## The primitive

The relay mints, per task, a signed **task dispatch token**: an audience-bound token on the canonical mint seam (`mintAudienceToken`, `@motebit/crypto`) with

- `aud = "task:dispatch"` (a `TokenAudience` registry append, never a new token shape),
- `mid` = the worker the task is dispatched to,
- `sub` = the relay task id (the standard JWT subject claim, added to `SignedTokenPayload` as an optional, audience-specific claim),
- a short `exp` (`TASK_DISPATCH_TOKEN_TTL_MS`) and a CSPRNG `jti`.

It is minted only after submission has cleared the relay's existing gates, so it is the relay's signed statement that _this task, for this worker, passed the settlement checkpoint_. It confers nothing else: no scope (that is the delegation token's job), no money movement (the ledger's), no trust (the trust graph's). Records-vs-acts: it is a record of an admission decision, presented at the act.

## Where it flows

- **Relay → worker (MCP forward).** `forwardTaskViaMcp` attaches `dispatch_token` beside `relay_task_id` on every `motebit_task` call, for every dispatch site (pinned paid worker, scored local worker, capability fallback). A forward to a different worker than the submission target mints its own token: the binding is to `mid`.
- **Relay → submitter.** `POST /agent/:worker/task` returns `dispatch_token` next to `task_id`. A delegator that submits through the relay and then calls the worker directly (the Researcher's sub-hop pattern) hands the same artifact over. The relay's own forward and the delegator's direct call are now indistinguishable to the worker: both carry proof of admission.
- **Worker.** `McpServerAdapter` with `taskAdmission` set verifies the token against the pinned relay key _before_ the agent loop starts, then binds `relayTaskId` to the token's `sub` (a caller-supplied `relay_task_id` that disagrees is refused, not trusted). One `sub` is admitted at most once per process: replaying the token, or re-minting for the same task, is refused.

## Who enforces, and the default

`@motebit/molecule-runner` exposes `taskAdmission: "relay" | "open"`. The two molecules that spend on inference, code-review and research, opt in to `"relay"` (env escape hatch `MOTEBIT_TASK_ADMISSION=open` for an operator who must reopen one). The relay key is the pinned `relayPublicKeyHex` (`MOTEBIT_RELAY_PUBLIC_KEY`; the money seam already carries one) when configured, else fetched once from the relay's `/.well-known/motebit.json`, trust-on-first-use, logged. An unresolved key denies every task; it never opens the door.

**The default is `"open"` today, deliberately, with a loud boot warning when a listing is priced and relay-registered.** The principled default is `"relay"`-when-priced: a priced listing is a promise that the work is bought. It is not yet the default because the first-party graph still has direct, un-tokened hops into priced atoms: code-review reads diffs through read-url with no relay binding, and the Researcher falls back to a free direct call when a sub-hop is not P2P-payable. Flipping the default first would refuse those hops in production before their callers carry the artifact.

**Trigger to flip:** every first-party direct caller of a priced atom forwards the relay's `dispatch_token` (code-review → read-url gains the same relay binding the Researcher has; the Researcher's not-payable fallback either binds through the relay or fails honestly instead of calling free). When that is true, change the default in `resolveTaskAdmission` to `config.syncUrl && priced ? "relay" : "open"`, delete the boot warning, and update this paragraph. The unit tests name the current default so the flip is a visible, tested decision rather than drift.

The relay itself never accepts `task:dispatch` inbound. It is a statement the relay makes, not one it consumes.

## What this does not do

- It does not verify payment at the worker. The worker trusts its relay's admission decision, exactly as it already trusts the relay for discovery and settlement records. A worker that wants to verify the chain itself keeps that option open through the same `sub` (the task id joins the relay ledger and the onchain proof).
- It does not close the proxy's snapshot-balance window or the relay's verify-after-dispatch for P2P proofs. Those are the relay's own gates; this arc makes the worker refuse work that never reached them.
- It does not change transport auth. A worker still needs its bearer or signed-caller verifier; the shared relay master token remains the relay's transport credential on forwards.

## Companion law

[`paid-failure-recourse.md`](paid-failure-recourse.md) says an agent must not advertise what it cannot currently perform. The mirror obligation is here: an agent must not _perform_ what was never bought. Together they make the trust graph a fair recourse — nobody is scored on free work they were tricked into, and nobody pays for a promise the worker could not keep.
