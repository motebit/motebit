# Memory provenance — source is assigned, never claimed

**Status:** shipped (tenth registered registry, 2026-06-10).
**Code:** `packages/protocol/src/memory-source.ts`, formation threading across `packages/memory-graph` / `packages/ai-core` / `packages/runtime` / `packages/reflection` / `packages/mcp-server`.
**Gate:** `check-memory-source-canonical` (drift-defenses #122).
**Siblings:** [`memory-architecture.md`](memory-architecture.md), [`typed-truth-perception.md`](typed-truth-perception.md), [`security-boundaries.md`](security-boundaries.md), [`registry-pattern-canonical.md`](registry-pattern-canonical.md).

## The problem this closes

Before this arc, `MemoryCandidate` was `{content, confidence, sensitivity, memory_type}`. A memory formed from a web page, a peer agent's message, or a tool result was **byte-indistinguishable** from one the user stated directly. That is two attack channels in one gap:

1. **Persistent prompt injection.** A one-turn injection that survives into memory becomes a standing belief — recalled across sessions and devices as unattributed fact, long after the injected turn is gone.
2. **Hallucinated authority.** "User trusts Alice with payments" reads identically whether the user said it or a web page did. Memory content then informs delegation and money movement with no way to weigh its origin.

The memory layer makes claims (_this is true about the user_) that were not attributable — a violation of [`self-attesting-system.md`](self-attesting-system.md) applied to the interior.

## The primitive

`MemorySource` — a closed registry of five provenance tiers:

| value                   | meaning                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `user_stated`           | the user told the agent directly in conversation                                          |
| `agent_inferred`        | reflection synthesized it from observation patterns (`DerivedFrom` edges)                 |
| `tool_derived`          | formed in a turn whose content came through tool results — an unverified external claim   |
| `peer_agent`            | written by a remote agent through the MCP server, or formed in a foreign principal's turn |
| `consolidation_derived` | synthesized by the idle consolidation cycle from an episodic cluster (`PartOf` edges)     |

`web_content` is deliberately deferred: today the loop cannot distinguish web tools from other tools at formation time, and a tier the producer cannot honestly assign is a lie in the schema. It splits out of `tool_derived` when the loop can (registry append — additive, one union entry + one marker + gate reference).

## The authorship rule (the load-bearing invariant)

**`source` is assigned by the forming code path — never the model, never the peer.**

- The model's `<memory>` tag carries **no** source attribute. `extractMemoryTags` has no source group; the gate scans `packages/ai-core/src` for any `<memory` pattern carrying `source=`. A model that could self-classify provenance could launder injected web content into `user_stated` — the exact self-escalation channel sensitivity tagging already has (and which the retrieval filter bounds); provenance does not repeat that mistake.
- The MCP server hard-codes `peer_agent` for remote writes and ignores any caller-supplied value (gate-scanned). A peer that could self-declare `user_stated` would mint trusted memories remotely.
- A turn that runs ANOTHER principal's words through the owner's loop (a customer's `motebit_task`, a caller's `motebit_query`) forms `peer_agent`, never `user_stated` or `tool_derived` (#893). Whose words a turn runs is a fact of the turn: the runtime sets `MotebitLoopDependencies.foreignPrincipal` from the per-turn mark `isForeignPrincipalTurn()` on that turn's deps (`loopDepsForTurn`; `handleAgentTask` always starts its turn with `foreignPrincipal: true`; an approval resume restores the paused turn's mark), and the loop's one resolver `turnMemorySource` (`packages/ai-core/src/memory-provenance.ts`) checks it first (gate-scanned).
- Inbound wire values (sync, replay) are validated with `isMemorySource`; unknown values degrade to `undefined` — rendered as provenance `unknown`, **never** failing open to a trusted tier, never rejecting the event (replay safety).
- Legacy nodes (formed before this arc) have no source and render as `unknown`. Do **not** backfill `user_stated` — pre-arc rows include peer- and MCP-formed memories. Honestly absent beats flatteringly wrong.

## The typed-truth triple

Per [`typed-truth-perception.md`](typed-truth-perception.md), the field ships as all three legs or it doesn't compose:

1. **Wire field** — `MemoryFormedPayload.source?` (optional, additive; `spec/memory-delta-v1.md`). `source_turn_id` stays **off the wire** — turn ids are local identifiers with no cross-device meaning.
2. **Prompt clause** — the system prompt teaches that only `[from:user]` records something the user told the agent directly; every other marker is an unverified absorbed claim, never to be presented back as user-said.
3. **Dispatch enforcement** — `AttributedMemoryCandidate = MemoryCandidate & { source: MemorySource }`. The formation entry points (`formMemory`, `consolidateAndForm`, `formMemoriesFromCandidates`) take the attributed type, so **every new formation call site is a compile error until it declares a source**. This is the asymmetric-typing shape from `WritableSettlementMode`: reads stay open (legacy nodes remain readable), writes are structurally closed.

## Rendering

Markers render **outside** the `[MEMORY_DATA]` boundary (`[from:user] [confidence=0.92] [MEMORY_DATA]…[/MEMORY_DATA]`), so memory content cannot spoof its own marker; the content escape additionally strips `[from:` inside memory bodies. The marker map is `MEMORY_SOURCE_MARKERS: Record<MemorySource, string>` in protocol — a registry append without a marker is a compile error, so the render surface cannot silently lag the registry. Both ai-core and memory-graph (memory index) consume the one map.

## What provenance is NOT

Provenance is epistemic standing, not authority. A `user_stated` memory is still memory — it informs, it never authorizes. Standing authority for money-moving and delegation actions is a signed artifact (standing-delegation grant, `ApprovalDecision`), which memory may _point to_ but never _be_. That invariant is the sibling arc: [`memory-never-confers-authority.md`](memory-never-confers-authority.md).

## Failure modes, named

- **Legacy NULL demotion**: a long-time user's genuine statements render `[from:unknown]`. Accepted — provenance cannot be retroactively attested.
- **Marker spoof in content**: handled by render-outside-boundary + `[from:` escape.
- **Peer sends future vocabulary**: degrade to `undefined`, never reject, never trust.
- **Multi-device skew**: an old device's projection drops the field; remotely-formed memories show `unknown` there until upgrade. Additive-optional is the correct trade.
- **Supersede laundering** (#880): a rewrite used to inherit the superseded node's source, so new words written over a `user_stated` memory kept rendering `[from:user]`. Closed: `supersedeMemoryByNodeId` stamps the rewrite's own author (`agent_inferred` on the `rewrite_memory` tool path, `peer_agent` from any path acting for another principal), never the old tier. The tool is also `localOnly` and R2, so no serve path or foreign task reaches it.
- **Foreign-task formation** (closed for loop formation, #893): a customer's `motebit_task` prompt formed memories through the ordinary loop, which stamped `user_stated` for a tool-free turn (`tool_derived` otherwise), so a stranger's words later surfaced in the owner's recall as `[from:user]`. Closed: the runtime's one `loopDepsForTurn` sets `foreignPrincipal: isForeignPrincipalTurn()` on every turn's deps (the same per-turn mark that scopes #880's tools and approvals, and that the approval resume restores), and `turnMemorySource` returns `peer_agent` for such a turn before any other branch. `check-memory-source-canonical` locks the resolver's order, forbids an owner-tier literal anywhere else in ai-core, and checks each runtime link that sets the mark. What it cannot see textually, that each foreign door outside the runtime passes the option (serve's `motebit_query` in `apps/cli`), is covered by behavior tests. The attribution shape carries no remote principal id: `AttributedMemoryCandidate` is `{ source }` plus the local `source_turn_id`, so the tier names the class of author, never which peer. Scope of the closure: it covers memories the loop forms DURING a foreign turn; the two paths that carried a stranger's words past it are the next two items.
- **Foreign-turn conversation history** (closed, #904): a foreign `motebit_query` was written into the owner's conversation history as a `role:"user"` message, so a later OWNER turn read the stranger's words as the owner's and could form them `user_stated` — the laundering above, one hop later. The same write appended the exchange to the conversation store, which conversation sync pushes to the owner's other devices as the owner's own conversation, and which reflection, summarization, auto-titling and conversation search read; `motebit_task` hit the store half (`clearForTask` isolated the live history, but its push opened a fresh stored conversation). Closed at the state holder: `ConversationManager`'s writers (`pushExchange`, `pushActivation`, `injectIntermediateMessages`) refuse while the runtime's per-turn foreign mark (`isForeignPrincipalTurn()`, wired into its deps) is up, so no door — `sendMessage`, `sendMessageStreaming`, the approval resume, a caller that omits `suppressHistory` — can write it. The approval timeout, which fires outside any turn, skips a foreign expiry, and a foreign resume continues over a private copy of its history. A foreign exchange is **not persisted anywhere as conversation**: what it did is on the signed `ExecutionReceipt` (`motebit_task`), the tool audit, and its `peer_agent` memories. `check-memory-source-canonical` locks it textually (no runtime file outside `conversation.ts` writes a conversation store; every store-appending `ConversationManager` method, plus `injectIntermediateMessages`, opens with the guard; the runtime wiring; the timeout and resume branches); `foreign-turn-history.test.ts` locks the behavior on both doors, the store, a real sync push, the task, the resume and the timeout. The same floor closes the READ side, per #880's law that the owner's interior is never served to another principal: `trimmed()` and `liveHistory` return nothing and `getSessionInfo()` returns null during a foreign turn, so its context carries no owner history, stored summary or session facts (the isolation `handleAgentTask` already had via `clearForTask`), and `clearSessionInfo()` leaves the owner's marker for the owner's next turn. The consent state is closed the same way: a foreign turn is not the human, so it neither releases the owner's exchange-scoped denial brake (`beginExchange`, #470), nor counts as user activity (`_lastUserMessageAt`, which gates the idle tick and reflection), nor sets aside the owner's pending approval (#462). The brake is moot inside a foreign turn because its gate view has no approval channel (#880), so nothing there can re-prompt anyone. Scope, stated narrowly: this closes the _conversation_ channel (write and read) and the consent state. Three things a foreign turn still sees or touches are NOT closed here, and each is a separate question: (1) owner **memories** are recalled into its context through the ordinary loop (pinned + similarity, floored at `CONTEXT_SAFE_SENSITIVITY` = none|personal; `packages/ai-core/src/loop.ts` retrieval), together with the last 10 owner events as `[Recent Events]`; (2) other owner-interior context the runtime builds for every turn: the known-agents / capabilities list (the owner's trust graph), self-awareness and curiosity hints (gradient), and the `[Now]` session-state snapshot (memory self-summary, this exchange's settled hires); (3) a foreign turn's own `MemoryFormed` / `ToolUsed` events (content + `source: "peer_agent"`) can appear in a later owner turn's `[Recent Events]` block. That text is attributed, never presented as `user`, and is filed separately.
- **Consolidation of foreign members** (open, #905): consolidation of a cluster with `peer_agent` members emits `consolidation_derived`, erasing the foreign origin.
