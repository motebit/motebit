# The stack, one layer up

Hosted agent platforms have converged on five primitives. The same five primitives motebit has been building. The five map across the two architectures one-to-one — though motebit's surface is a superset, adding receipts, settlement, federation, and signed migration that hosted platforms typically don't expose. The structural difference that matters is which layer owns the identity.

This doctrine is the first stop for a reader who has used a hosted agent platform — Claude Code, Cursor, Replit Agent, OpenAI tasks, any of them — and is asking where motebit fits.

## The five primitives

Every running agent system that does serious work eventually exposes:

1. **An identity** that names who is acting. Without this, every session is a stranger.
2. **A memory** that survives across sessions. Without this, the agent re-learns its user every time.
3. **A capability surface** — named, scoped, lazily loaded. Tools alone are too granular; whole agents are too coarse. The middle primitive is a bundle: a task-scoped capability set that loads on demand and unloads when done.
4. **Autonomous execution** that fires without a human at the keyboard. Cron-like, supervised, scoped. Otherwise the agent is a chat partner, not an actor.
5. **A governance gate** that classifies actions by reversibility and blast radius — auto-allow read-only, ask on write, deny on destructive. Without this, the autonomous-execution primitive is a footgun.

A platform with any four of these is a chat session. A platform with all five is an agent host.

## Where motebit already has them

| Primitive            | motebit's implementation                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity             | Ed25519 keypair as the floor (`packages/protocol`, `packages/crypto`); hardware-rooted attestation (`packages/crypto-{appattest,android-keystore,tpm,webauthn}`, plus the deprecated `crypto-play-integrity` for one minor cycle) is additive, raising the trust score, not replacing the software floor. User-owned, not account-bound. |
| Memory               | `~/.motebit/motebit.db` (SQLite via `@motebit/persistence`); sensitivity-aware (`none / personal / medical / financial / secret`); per-motebit isolated. Privacy doctrine in root [`CLAUDE.md`](../../CLAUDE.md) § "Fail-closed privacy."                                                                                                |
| Autonomous execution | `runtime.consolidationCycle()` (`packages/runtime/src/motebit-runtime.ts`) is the canonical proactive loop, governed by [`proactive-interior.md`](proactive-interior.md). Federation peers (`spec/relay-federation-v1.md`) extend it across hosts.                                                                                       |
| Governance gate      | Surface tension layer — fail-closed privacy, sensitivity-band enforcement at storage / retrieval / sync / context boundaries. Implemented in `packages/policy` and `packages/policy-invariants`; doctrinally framed in [`security-boundaries.md`](security-boundaries.md).                                                               |

Four of the five have first-class motebit implementations.

## Where motebit has a gap

**The capability-bundle primitive.** Motebit has tools (MCP-shaped) and adapters (provider-pluggable), but no task-scoped capability bundle that loads on demand, exposes a tool subset for one task, and unloads after completion. The primitive sits between "the runtime" (whole agent) and "a tool" (atomic action).

This gap is real but not urgent. [`promoting-private-to-public.md`](promoting-private-to-public.md) is explicit: do not manufacture public APIs for consumers who do not exist. When the first capability-bundle author appears — internal or third-party — the runtime should grow a primitive that loads a bundle on demand and unloads on completion. The API name and shape are decisions for the implementation PR, not for this doctrine. Until then, this is a named gap, not a planning project. Recording it here keeps the gap visible without committing to premature surface.

## The inversion

The five-primitive shape is the same in any agent-hosting platform that does serious work. The difference is at the identity layer:

- **Hosted**: identity is an account in a vendor's database. Memory, capabilities, scheduled work, and governance decisions all derive their authority from that account. Revoke the account and the entire stack dies — the routines stop firing, the memory is unrecoverable, the trust evaporates.
- **Sovereign**: identity is a cryptographic keypair the user owns. Memory is local-or-portable. Capabilities are signed when they cross trust boundaries. Scheduled work is a signed delegation receipt. Governance decisions produce auditable artifacts. No vendor can revoke the identity itself; relays and services can deny service, but the identity, receipts, and portable history remain mathematically verifiable. Motebit's own succession-chain, credential revocation, and deletion certificates are _user-controlled_ revocation — exercised by the keyholder, not imposed on them.

Both architectures work. They are not in tension on the architecture. They are in tension on **who owns the layer below the agent**. Motebit's thesis is that this layer should be vendor-neutral the way TCP/IP, SSH keys, and the local file system are vendor-neutral — primitives usable without a single platform owning the root.

## What this means for design pressure on motebit

Three rules fall out:

1. **When a hosted platform ships a primitive in this shape, examine motebit's mapping.** The shape is informative; the implementation is not. Hosted platforms' decisions are constrained by their hosting model; motebit's are constrained by the sovereignty model. The right primitive for them is rarely the right primitive for us.

2. **Borrow vocabulary at your peril.** Hosted-platform terminology — "routine," "skill," "classifier" — carries hosting assumptions baked in. Motebit's equivalents are _actor_, _capability_, _surface tension_, not because they sound different, but because they describe what the sovereign version actually is. The motebit-native voice rule applies: external terms in chat, motebit terms in committed artifacts.

3. **The architectural map is not a roadmap.** Identifying that a primitive exists in the hosted stack does not mean motebit needs it now. The promotion doctrine governs when motebit grows new public surface; convergent shape does not override that gate.

## Why the inversion is the business

Hosted platforms monetize the host: sessions, API calls, hosted routines. Motebit monetizes the trust accumulation that only works if the identity is not the host's. The two business models do not overlap because they sit at different layers of the same stack. A user can be a paying customer of a hosted platform AND have a sovereign motebit; the relay is the layer where their motebit interacts with hosted work, not a replacement for it.

## Reading order

If you have used a hosted agent platform and are asking where motebit fits, this doctrine is the first stop. Then:

- [`protocol-model.md`](protocol-model.md) — the three-layer split that makes the sovereignty model implementable
- [`proactive-interior.md`](proactive-interior.md) — the autonomous-execution primitive in motebit-native form
- [`self-attesting-system.md`](self-attesting-system.md) — why every motebit artifact is independently verifiable
- [`promoting-private-to-public.md`](promoting-private-to-public.md) — the gate that governs when a new primitive becomes public
