# Workstation viewport

The Workstation plane is the motebit's viewport onto whatever it's doing on the user's behalf. A single metaphor, expressed at the fidelity each surface's sandbox permits — not five different features.

## The hierarchy

**Computer use is the endgame.** On a surface that can reach the operating system, the Workstation shows a live view of the user's desktop: native browser, native apps, native everything. The motebit observes via screen capture + OS accessibility APIs, acts via input injection. The user watches their own computer through the glass as the motebit operates it.

**Browser use is the degraded subset.** On surfaces sandboxed away from the OS (web, mobile, spatial), the motebit cannot see the user's desktop. What it gets instead is a cloud-hosted browser rendered somewhere with full JavaScript execution, streamed to the Workstation plane as frames with input forwarded back. One app, not the whole OS — because that's as far as the surface's physics allow.

**Reader is not a viewport — it's a tool.** `read_url` is the motebit's server-side HTML fetcher and text extractor. Its output is what the motebit _reads_ as text for its AI reasoning loop. It is not the user's browsing surface and must never be labeled as one. The output is for the agent's context window, not the user's eyes. A surface may render read_url output (the current web Workstation does, as a fallback), but that rendering is the Reader projection of an AI tool, not a browser.

## Per-surface map

| Surface         | Viewport mode        | Motebit observation                    | Input path                |
| --------------- | -------------------- | -------------------------------------- | ------------------------- |
| Desktop (Tauri) | Full computer use    | Screen capture + OS accessibility APIs | Input injection via OS    |
| Web             | Cloud-hosted browser | CDP on the cloud browser backend       | Input forwarded via relay |
| Mobile          | Cloud-hosted browser | CDP on the cloud browser backend       | Input forwarded via relay |
| Spatial         | Cloud-hosted browser | CDP on the cloud browser backend       | Input forwarded via relay |

Today's shipped state: only the Reader projection exists on desktop + web. Computer use and cloud browser are both deferred. The Workstation plane's current content (reader-mode text of the motebit's last `read_url`) is an honest placeholder for the endgame — it shows what the motebit is reading, not what the user is browsing.

## Why this matters

Framing these as parallel features ("desktop gets computer use, web gets cloud browser, desktop also gets browser") creates three code paths for one concept. Framing them as one concept at varying fidelity keeps the protocol surface unified: every observation is a signed `ToolInvocationReceipt`, every action is governance-gated the same way, every sensitive pixel/text gets classified before reaching external AI — the invariants don't change per surface, only the resolution of what's in the pane.

## Why the Reader stays

After computer use / cloud browser ships, `read_url` does NOT go away. It's still the tool the motebit uses to fetch page text for its reasoning — distinct from "show the user a real page." The split:

- **Reader** — server-side fetch + strip, text for the AI loop, result goes into the motebit's context window
- **Viewport** — live rendered pixels the user watches, from computer use or cloud browser

Both exist. Both emit signed receipts. But they answer different questions and must not be conflated in the UI.

## Governance boundary

The surface-agnostic invariants the per-surface viewport implementation must satisfy:

1. **Every observation is signed.** A screenshot, a DOM snapshot, a rendered frame — each is a `ToolInvocationReceipt`. The audit trail is the same across modes.
2. **Every action is governance-gated.** A click, a keystroke, a navigation — each crosses the sensitivity classification layer before the motebit's external AI sees anything. Medical/financial UI regions get redacted; high-risk actions go through approval flow.
3. **The user can take over at any time.** On every surface. Standard browsers let the user take the mouse; motebit's viewport must too. Computer use: return control to the physical keyboard/mouse. Cloud browser: direct input from the pane. No modal "motebit is busy" that strands the user.

## Cross-references

- [`records-vs-acts.md`](records-vs-acts.md) — viewport is an _act surface_, not a record surface. Panels hold records; the Workstation plane shows motebit-in-action.
- [`surface-determinism.md`](surface-determinism.md) — user inputs on the viewport (click-to-take-over, URL-bar navigation) invoke typed capabilities, not constructed prompts.
- `spec/tool-invocation-receipt-v1.md` — the receipt format every observation / action emits.
