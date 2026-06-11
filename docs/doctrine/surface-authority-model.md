# The surface authority model

Motebit has eleven app surfaces. The recurring mistake — ours and the market's — is to ask "which surface should we build?" as if surfaces competed. They don't. A surface is either a place the agent **acts** (and therefore must hold the pipeline) or a place the agent is **seen and steered** (and therefore must not). The question is never "web or desktop." It is: **which surfaces hold authority, which are frontends onto it, and what is the one authority they all present.**

## Two axes, never one

The phrase "Motebit Computer" names exactly one thing — **the slab** ([`motebit-computer.md`](motebit-computer.md)): the liquescent surface that renders whatever embodiment the motebit currently occupies. The slab is a **render contract** (Ring 1 controller / Ring 3 renderer), not an execution boundary. It shows what the agent sees and does; it does not decide what the agent may do.

The thing that _acts_ is the **sovereign runtime** — the local-first instantiation of the invariant pipeline ([`identity-universal-boundary.md`](identity-universal-boundary.md)):

    identity → authorization → policy → action → receipt → settlement → trust

These are orthogonal axes. The render axis answers _what you perceive_; the execution axis answers _who held authority when the action fired_. Collapsing them — letting "the Computer" mean both the screen and the agent-OS — leaks into the API and the UX every time. **Keep them named apart.** The slab renders; the runtime acts; the relay coordinates between runtimes; everything else is a frontend or an adapter.

## The surface map — three trust classes

Eleven surfaces resolve into three classes by their relationship to the pipeline, not by their form factor:

| Class                         | Surfaces                                                                                                                                            | Holds                                                       | Boundary it owns                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| **Authority-holding runtime** | the local sovereign runtime — hosted today by the CLI daemon and the desktop GUI separately, converging on one per machine (see keystone invariant) | key, policy gate, signed receipts, local tools              | the device / host trust boundary  |
| **Frontend**                  | web, vscode, spatial, inspector, operator                                                                                                           | nothing standalone — invokes a runtime's typed capabilities | presentation + approval-gathering |
| **Consent root**              | mobile, identity                                                                                                                                    | approval, passkey, emergency revoke, wallet                 | the human-in-the-loop keystone    |

The classes are the doctrine; the surface list is just today's instances. A twelfth surface earns its place by declaring which class it joins and what boundary it owns — never by adding a capability a frontend could already invoke.

**The pattern is already proven inside the repo:** `apps/vscode` is a thin client that spawns `motebit lsp` from the CLI over stdio. It holds no authority; it is a frontend on the CLI runtime. That is the shape every frontend should take.

## What each boundary uniquely owns

The test for "does this surface need to exist" is **what can it do that no other class structurally can** — not what it does conveniently.

- **Web — the zero-install front door, ceilinged at the cloud sandbox.** Chat, delegation, dashboard, receipts, approval UX, artifact review, the slab renderer, and real browser-drive via the cloud sandbox (`virtual_browser`, `services/browser-sandbox`) and `shared_gaze`. Web's ceiling is correct and permanent: **no at-rest custody of a sovereign signing key** (the key lives in relay custody or behind a passkey, never raw), no local filesystem authority, no real OS drive, no hardware-rooted device key, no persistent background agent. Web executes only in the sandbox the relay coordinates — never on the user's machine.

- **Desktop — the device trust boundary.** The only place the identity can be **hardware-attested**: Secure Enclave / TPM mint a separate attestor key that signs over the Ed25519 identity (`apps/desktop/src-tauri/src/secure_enclave.rs`, `tpm.rs`) — additive device-binding score, never key custody, per the hierarchical-binding pattern ([`hardware-attestation.md`](hardware-attestation.md), [`identity-binding-verification.md`](identity-binding-verification.md)). Plus real OS drive (`computer_use.rs`), OS-keychain vault, filesystem authority, app automation, screen perception. Web structurally cannot do any of this; that is the irreducible reason desktop exists.

- **CLI — the headless sovereign runtime.** `apps/cli/src/daemon.ts` is already a runtime in its own right: local filesystem authority, local tools, a relay-forwarded remote-command channel, an LSP host. The CLI is the developer / automation / server-side trust boundary **and the actual seat of the always-on runner** the proactive interior anticipates ([`proactive-interior.md`](proactive-interior.md)). The desktop GUI is a _second_ instantiation of the same `@motebit/runtime`; the CLI daemon is the one that already runs headless and remote-triggerable.

- **Mobile — the consent root, by design.** Identity wallet, passkey / biometric approval, push for approval requests, emergency revoke, camera / sensor. It is the keystone that stays in your pocket **while the runtime acts elsewhere.** Mobile is primary for exactly one job (consent) and companion for everything else. It must not become an execution surface — the approval device gaining execution authority collapses the separation that makes approvals meaningful.

## The keystone invariant — one sovereign local runtime, many frontends

> On a single machine there is **one** sovereign runtime holding the key, the policy gate, and the receipt log. GUIs, editors, and headless triggers **attach** to it; they do not each instantiate their own authority.

Today this is half-true and half-drifted: the CLI daemon and the desktop GUI are two instantiations of `@motebit/runtime` that can run on the same machine — two keys, two policy paths. The vscode-on-CLI pattern shows the correct end state: many frontends, one authority. The work is to converge them onto **one** local policy/signing/receipt core, so a side-effect commits under a single authority no matter which frontend reached it. Which process _hosts_ that core is the strongest-root question resolved under §"Product posture" — not automatically the daemon — but the convergence itself is the invariant regardless of host.

**The first symptom of the drift this invariant forbids — now closed.** `MotebitRuntime.invokeLocalTool`, the explicit user-affordance entry point web/desktop tap to run filesystem/shell tools, once reached a side-effecting tool without passing the policy gate — two authorities disagreeing about what's allowed (it even signed a receipt for the ungated side-effect). It now routes through the same `this.policy.validate()` as the AI loop, with the one honest difference that a genuine user tap _is_ the human-in-the-loop approval ([`surface-determinism.md`](surface-determinism.md)): the tap satisfies the approval band for reversible/irreversible local tools, never overrides a hard deny, and never clears `R4_MONEY` (only a verified standing grant does — [`memory-never-confers-authority.md`](memory-never-confers-authority.md)). Locked by `check-local-tool-gated`. Every capability, on every surface, routes through `invokeCapability` and the policy gate; a local frontend is not an exception. The remaining keystone work — unifying the CLI-daemon and desktop runtimes onto one local policy/signing/receipt core — is the cross-process arc deferred under §"Product posture".

## The browser extension — deferred-dangerous

A browser extension is the **worst prompt-injection and session-hijack blast radius for the least unique capability**, and it is therefore not built.

Everything an extension would give — page context, tab control, automation — is already served by `virtual_browser` (cloud sandbox), `shared_gaze` (drag-drop perception, [`motebit-computer.md`](motebit-computer.md)), and `desktop_drive` (local OS). The one thing it _uniquely_ adds — acting inside the user's real logged-in browser sessions — is precisely the capability with no sandbox, sitting in the user's most credential-rich context. And the safer path to that same capability already exists: **`desktop_drive` driving the user's real browser through the OS**, with per-action approval and halt always in reach, with no agent code living inside the credential context.

**Trigger to reconsider:** a concrete job that _requires_ the user's real authenticated session AND _cannot_ be served by `desktop_drive`. Until that job is named, the extension is a liability, not a surface. ([`security-boundaries.md`](security-boundaries.md).)

## Product posture — first-class internally, gated externally

Two questions looked like open forks. They are product posture, and the posture is now set; what remains open is one architectural sub-question, and it does **not** resolve the obvious way.

**Posture (committed).** The sovereign local runtime is first-class _architecture_ and not-yet first-class _marketing_. Internally it is a primitive built seriously — identity, policy gate, local tools, signed receipts, device binding, remote-command ingress, audit log, and approval plumbing all converge on it. Externally, motebit does **not** advertise "text your computer from anywhere and it acts" — that is the register of remote-control malware, not accountable autonomy. Remote-trigger becomes product-visible only when every remote command is a **signed envelope, policy-gated, receipt-emitting, locally visible (halt in reach), revocable from the consent root, and approval-gated by risk tier**. Until that whole set is airtight it is a latent primitive, not a feature. The framing is never "control your computer remotely"; it is "a sovereign runtime accepts remote intent only through signed envelopes, local policy validation, visible control, and verifiable receipts."

**The one open sub-question — which process runs the single coordinator — does not default to the daemon.** The obvious reading ("merge every local surface into the CLI daemon; the daemon is the authority") is _wrong for the desktop case_ — but not for the reason it first appears. It is **not** that the key lives in the desktop process (it doesn't — see below); it is that the desktop is the better coordinator when present:

- **Headless / server** — no GUI, no hardware attestation; the CLI daemon is the coordinator on the software-identity floor.
- **Desktop present** — the desktop process is the natural coordinator: it carries the visible control surface (halt, approvals, OS-drive view) and can mint hardware attestation. The CLI attaches to _it_ (the inversion of the headless case).

The invariant holds either way: **one policy / signing / receipt authority per machine, frontends attach.**

**Election is coordination, not key custody — do not conflate them.** The tempting model ("the hardware-rooted process holds the key; everyone else attaches as a client") is wrong on the facts. The Ed25519 identity key is **already shared** per machine through the OS keyring (`~/.motebit/dev-keyring.json`, written by the desktop Tauri app, read by the CLI). Hardware attestation does **not** custody it: Secure Enclave / TPM mint a _separate ephemeral attestor key_ that signs an attestation _over_ the identity key — additive scoring, never a replacement ([`hardware-attestation.md`](hardware-attestation.md), [`identity-binding-verification.md`](identity-binding-verification.md)). So the unification is not "move the key to the strongest root"; the key is shared, and the work is electing **one coordinator** that serializes policy decisions, signing operations, and receipt/state writes so two processes never run two policy paths over the same key. The desktop process is the natural coordinator _face_ when present (it can attest and it's the GUI), but "host" means "runs the single coordinator," not "owns the key."

This is a required deliverable of the unification arc, not doctrine poetry: an explicit **host-election rule** (which process becomes coordinator, how a second process detects it and attaches, how a contended election resolves to exactly one, and the desktop-installed-but-not-running case) — with the failure to specify it _being_ the two-coordinators-drift failure mode below. Its specific protocol is grounded at build time against the real keyring-sharing, not frozen here. **Decided 2026-06-11:** first-binder-wins on a canonical local endpoint, with the attached process's unique organs (hardware attestation, computer-use, GUI halt) contributed as bridged capabilities — which makes the election outcome operationally neutral and removes the need for live handover in v1. The full rule, failure modes, and increments live in [`daemon-desktop-unification.md`](daemon-desktop-unification.md).

## Failure modes

- **Two local runtimes drifting** on one machine — two keys, two policy paths, two answers to "is this allowed." The local-tool-bypasses-the-gate path is the first instance.
- **Extension built** → session-hijack injection in the credential context.
- **Mobile gains execution authority** → human-in-the-loop collapse.
- **Web holds a raw signing key at rest** → custody where there should be coordination.
- **`desktop_drive` without per-action approval** on the real OS.
- **Remote-trigger as an under-authenticated host-command path** → relay-mediated RCE. The channel is a capability and must be signed-authority-gated like every other.
- **A frontend growing its own authority** — web/vscode/spatial deciding policy locally instead of invoking a runtime capability. The vscode-on-CLI pattern is the antidote; deviating from it is the smell.

## Doctrine check before adding a surface or a capability boundary

1. **Render axis or execution axis?** If it shows what the agent does, it's the slab's job. If it decides what the agent may do, it's the runtime's. Don't merge them.
2. **Which trust class?** Authority-holding runtime, frontend, or consent root. A new surface declares one. A frontend that holds a key is misclassified.
3. **What can this boundary do that no other class structurally can?** If the answer is "nothing — a frontend could invoke it," it's a frontend, not a new authority.
4. **Does it route through `invokeCapability` and the policy gate?** Local frontends are not exceptions. A path that side-effects without the gate is the keystone-drift failure.
5. **If it acts on the user's real environment, where's the per-action approval and the halt?** Highest-agency boundaries (`desktop_drive`, remote-trigger, a future extension) earn the strictest gates.
6. **Does it move authority onto the consent root?** Mobile approves and revokes; it does not execute. Pushing execution onto the approval device is a collapse, not a feature.

## References

- [`identity-universal-boundary.md`](identity-universal-boundary.md) — the one pipeline presented at many membranes; the canonical authority this model distributes across surfaces.
- [`motebit-computer.md`](motebit-computer.md) — the slab and its six embodiment modes; the render axis this model holds separate from execution.
- [`surface-determinism.md`](surface-determinism.md) — affordances invoke typed capabilities, never constructed prompts; why a frontend cannot hold authority.
- [`memory-never-confers-authority.md`](memory-never-confers-authority.md) — only signed artifacts authorize; the policy gate is the chokepoint a local frontend must not bypass.
- [`the-stack-one-layer-up.md`](the-stack-one-layer-up.md) — incumbents converge on the same surfaces; the difference is who owns the identity underneath them.
- [`hardware-attestation.md`](hardware-attestation.md), [`identity-binding-verification.md`](identity-binding-verification.md) — why desktop is the device trust boundary and web structurally is not.
- [`proactive-interior.md`](proactive-interior.md) — the consolidation cycle the headless runner hosts.
- [`security-boundaries.md`](security-boundaries.md) — sybil, injection, token binding; the extension's deferral rationale.
