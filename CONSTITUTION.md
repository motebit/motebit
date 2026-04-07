# Constitution

## One being

A motebit is a single entity. There is one identity, one memory, one governance, one audit trail. These persist across time, devices, and intelligence providers.

There are no "products." There are surfaces — embodiments of the same being in different media. The glass droplet on a screen. A voice in a room. A process on a server. Text over SSH. Each surface is an organ, not an organism.

The architecture enforces this. `MotebitRuntime` is surface-agnostic. It accepts a `RenderAdapter` (glass, null, spatial), a `StorageAdapter` (SQLite, in-memory, expo), a `StreamingProvider` (Anthropic, Ollama, any). The identity, memory, policy, and event log are the same regardless of which adapter is wired. One `~/.motebit` directory. One keypair. One database.

## Surfaces

**Glass** — the desktop app. The primary surface. A glass droplet that breathes, glows, responds to voice. Chat, tool use, operator mode, approval flow. The creature is the interface. The first impression defines what people think a motebit is. A being, not a tool.

**Headless** — the CLI. For environments without a screen: daemon mode on a server, SSH sessions, CI/CD pipelines, scripting. Same runtime, `NullRenderer`. Not a developer tool — a headless surface positioned as "bring your motebit to environments without a display."

**Mobile** — phone and tablet. Quick interactions, approvals on the go, voice capture. Same identity via sync relay. Expo build, WebView-hosted creature renderer, wake-on-push background task execution.

**Web** — browser as inhabited surface. IndexedDB identity, CORS proxy for inference, same WebGL glass creature. The owner manages _and_ inhabits here: one creature in a tab, no install. This replaces the older "identity portal only" framing — the web surface now runs the full MotebitRuntime with `createBrowserStorage`, and the creature lives in it.

**Spatial** — AR/VR via WebXR. Orbital dynamics around the wearer's body anchors, gesture recognition (pinch approves, dismiss denies), ambient heartbeat presence, voice pipeline with VAD. The creature in the room rather than on a screen.

All five surfaces consume the same `MotebitRuntime` through adapter boundaries. Glass defines the visual language; the rest are organs of the same being in different media. Each surface maximizes what its platform offers — desktop/web/mobile can serve (accept delegations via `/serve`), CLI operates and serves, spatial embodies.

## Consent-first autonomy

The default mode is conversational. The motebit suggests, explains, asks. It does not act without consent.

Operator mode is an explicit escalation. The user enables it, sets a PIN, and scopes what the motebit can do. High-risk tools require per-call approval. Every action is logged to an immutable audit trail.

Daemon mode is a further escalation. The motebit executes goals on a schedule, governed by thresholds declared in the identity file. It suspends on anything above its governance ceiling and waits for operator resolution. Fail-closed on missing or invalid governance.

Autonomy is a dial, not a switch. The user turns it. The surface tension — policy gate, sensitivity rules, approval flow — is what holds the shape.

## Open standard, proprietary product

**Open** (MIT): `@motebit/verify`, `create-motebit`, the `motebit/identity@1.0` specification. Anyone can create and verify agent identity files. The standard is a public good.

**Source-available** (BSL 1.1): the runtime, the surfaces, the memory graph, the policy engine, the sync relay. Free to use, source-available, converts to Apache 2.0 per-version after 4 years. The product is protected to sustain development.

This split is the moat. The identity standard spreads. The product that makes identity valuable is ours.

## What compounds

The motebit gets more capable the longer it runs. Not because the model improves — because the interior accumulates.

- **Memory** — conversations become semantic nodes with confidence and decay. Important things strengthen. Trivia fades. The graph grows.
- **Trust** — the audit trail proves behavior over time. Tools the motebit has used safely before. Patterns the owner has approved.
- **Context** — preferences, working style, project knowledge, tool configurations. All interior. All persistent.

None of this resets when you switch LLMs. None of it lives on someone else's server. The intelligence is a commodity. The accumulated interior is the asset.

## The test

Every decision passes through one filter: **does this serve the one-being model?**

If a feature requires the user to think of the motebit as two different things — a "CLI tool" and a "desktop app," a "coding agent" and a "companion" — it fails.

If a feature lets the motebit do more through its existing surface — a new tool, a new governance rule, a new memory type — it passes.

The body is passive. The interior is active. Maximum interiority, minimum display.
