# Workstation — the shared act-space

The Workstation is where the motebit and the user work the same surface. Motebit observes, inspects, browses, and acts; the user watches, interrupts, redirects, and takes over at any moment. The _what_ of the shared surface depends on each surface's physics — on desktop it is the user's real machine (same cursor, same browser, same logged-in accounts); on web, mobile, and spatial it is a cloud-hosted browser pane both share. One concept, fidelity-graded, honest about what "same" means on each.

This pairs with the [`records-vs-acts`](records-vs-acts.md) doctrine: panels hold records (memories, goals, agents, balances — things the motebit _has_); the Workstation is the act-space (things the motebit and user _do together_).

## The category wedge

Operator, Computer Use, Devin all run the agent in a VM or cloud browser _it_ owns — a sandbox the user is granted a window into. Motebit is the only configuration in which, on desktop, the agent inhabits the _user's_ world: real hardware, real logged-in accounts, real cursor. Co-work, not screen-share; pair-programming, not spectating.

Sandboxed agents are structurally bounded by their sandbox — they cannot see the user's real Amazon, real Gmail, real bank, because those live outside the VM. That gap is why current autonomous-agent products feel like toys even when they work: they can do things, but not _your_ things. Motebit's thesis collapses the gap by moving the agent into the user's own machine.

What makes that not reckless: sovereign identity binds every observation and action to the motebit cryptographically; signed `ToolInvocationReceipt`s accumulate into a portable, verifiable audit trail instead of vanishing at session end; sensitivity classification redacts medical/financial UI regions before the motebit's external AI ever sees them. The trust substrate is what earns the motebit the keys to the user's real machine — recessed under the act-space, not the headline.

## The fidelity hierarchy

**Computer use is the endgame.** On a surface that can reach the operating system, the shared act-space is the user's real desktop. The motebit observes via screen capture + OS accessibility APIs, acts via input injection. The user and the motebit operate the same machine; handoff is instantaneous in either direction.

**Cloud browser is the degraded subset.** On surfaces sandboxed away from the OS (web, mobile, spatial), the motebit cannot reach the user's desktop. The shared act-space becomes a cloud-hosted browser rendered somewhere with full JavaScript execution, streamed to the pane as frames with input forwarded back. One app, not the whole OS — as far as the surface's physics allow. This is "same workspace," not "same machine," and the doctrine is honest about that difference.

**Reader is not a shared surface — it's a tool.** `read_url` is the motebit's server-side HTML fetcher and text extractor. Its output is what the motebit _reads_ as text for its AI reasoning loop. It is not the user's browsing surface and must never be labeled as one. The output is for the agent's context window, not the user's eyes. A surface may render read_url output (the current desktop + web Workstation does, as a pre-endgame placeholder), but that rendering is the Reader projection of an AI tool, not a co-work surface.

## Per-surface map

| Surface         | Shared surface       | Motebit observation                    | Input path                |
| --------------- | -------------------- | -------------------------------------- | ------------------------- |
| Desktop (Tauri) | User's real machine  | Screen capture + OS accessibility APIs | Input injection via OS    |
| Web             | Cloud-hosted browser | CDP on the cloud browser backend       | Input forwarded via relay |
| Mobile          | Cloud-hosted browser | CDP on the cloud browser backend       | Input forwarded via relay |
| Spatial         | Cloud-hosted browser | CDP on the cloud browser backend       | Input forwarded via relay |

Today's shipped state: only the Reader projection exists on desktop + web. Computer use and cloud browser are both deferred. The current pane content (reader-mode text of the motebit's last `read_url`) is an honest placeholder for the endgame — it shows what the motebit is reading, not the shared act-space the doctrine points at.

## Why this matters

Framing these as parallel features ("desktop gets computer use, web gets cloud browser, desktop _also_ gets browser") creates three code paths for one concept. Framing them as one concept at varying fidelity keeps the protocol surface unified: every observation is a signed `ToolInvocationReceipt`, every action is governance-gated the same way, every sensitive pixel/text gets classified before reaching external AI — the invariants don't change per surface, only the resolution of what's in the pane.

## Why the Reader stays

After computer use / cloud browser ships, `read_url` does NOT go away. It's still the tool the motebit uses to fetch page text for its reasoning — distinct from "show the user a real page." The split:

- **Reader** — server-side fetch + strip, text for the AI loop, result goes into the motebit's context window
- **Shared surface** — live rendered pixels both user and motebit operate, from computer use or cloud browser

Both exist. Both emit signed receipts. But they answer different questions and must not be conflated in the UI.

## Governance boundary

The surface-agnostic invariants the per-surface shared-surface implementation must satisfy:

1. **Every observation is signed.** A screenshot, a DOM snapshot, a rendered frame — each is a `ToolInvocationReceipt`. The audit trail is the same across modes. This is what lets co-work on a real machine be recoverable instead of consequential.
2. **Every action is governance-gated.** A click, a keystroke, a navigation — each crosses the sensitivity classification layer before the motebit's external AI sees anything. Medical/financial UI regions get redacted; high-risk actions go through approval flow.
3. **The user can take over at any time.** On every surface. Standard browsers let the user take the mouse; motebit's act-space must too. Computer use: return control to the physical keyboard/mouse. Cloud browser: direct input from the pane. No modal "motebit is busy" that strands the user — shared means shared, both directions.

## Cross-references

- [`records-vs-acts.md`](records-vs-acts.md) — the act-space is the doctrinal counterpart to record panels. Panels hold records; the Workstation shows motebit-and-user-in-action.
- [`surface-determinism.md`](surface-determinism.md) — user inputs on the shared surface (click-to-take-over, URL-bar navigation) invoke typed capabilities, not constructed prompts.
- `spec/tool-invocation-receipt-v1.md` — the receipt format every observation / action emits.
