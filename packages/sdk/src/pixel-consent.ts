// === Pixel Consent (Visual-Perception Boundary) ===
//
// Pixels — screenshots, navigate-frame captures, future image embedding
// payloads — cross a different sovereignty boundary than text. Text from
// a tool result is the kind of content the AI is built to reason about;
// pixels are raw bytes whose content the user may not have consented to
// share with the active provider (banking screens, medical records,
// anything caught incidentally on the slab).
//
// The architecture composes three gates around pixel passthrough:
//
//   1. Provider sovereignty — `on-device` providers always receive
//      pixels. The bytes never leave the device, so there is no
//      external party to consent to.
//   2. Session sensitivity — medical / financial / secret sessions
//      with an external provider always strip pixels. Same fail-closed
//      shape as `assertSensitivityPermitsAiCall` for outbound text.
//   3. Pixel consent — for external providers at unelevated sensitivity,
//      the user must explicitly grant pixel passthrough. This file
//      defines that grant's shape.
//
// Doctrine — composes existing primitives rather than introducing a new
// tool:
//
//   - `motebit-computer.md` §"Mode contract" — pixel-tier perception
//     is a function of (provider, sensitivity, consent), not a separate
//     tool. One pixel-tier tool (`computer({kind:"screenshot"})`),
//     multiple gates threaded through `projectForAi`.
//   - `surface-determinism.md` (Principle 90) — consent is granted via
//     a typed affordance (slash command, slab band) NEVER through an
//     AI prompt asking "may I see?". The AI's only role is to surface
//     `bytes_omitted: { reason: "consent_required" }` and let the
//     surface route the user to the affordance.
//   - `proactive-interior.md` — fail-closed by default. New sessions
//     start at `denied`; pixel pass-through is opt-in.

/**
 * Per-session pixel-passthrough consent state.
 *
 * - `denied` (default): pixels never reach an external AI provider.
 *   `projectForAi` swaps `bytes_base64` for a `bytes_omitted` directive
 *   pointing the AI at the `/vision grant` affordance.
 * - `session`: the user granted pixel passthrough for the lifetime of
 *   this session. External providers receive bytes when sensitivity
 *   permits. Reverts to `denied` on session end (no persistence).
 *
 * Future extensions (deferred until per-domain demand lands): a
 * `{ kind: "domain"; domains: string[] }` variant for "always allow on
 * example.com" — same shape as browser camera/mic permissions. Adding
 * a variant is additive; existing consumers route on the string-literal
 * cases they care about.
 *
 * Sovereign providers (`on-device` mode) bypass this gate entirely —
 * the bytes never cross a network boundary.
 */
export type PixelConsentState = "denied" | "session";

/** Default pixel consent for a fresh session — fail-closed. */
export const DEFAULT_PIXEL_CONSENT: PixelConsentState = "denied";

/**
 * Structured reason a `bytes_omitted` directive carries when pixels were
 * stripped. Lets the AI's perception doctrine route to the right
 * remediation: a `consent_required` strip points at `/vision grant`;
 * a `sensitivity_blocked` strip points at `/sensitivity none`; a
 * `no_capability` strip points at "switch provider." The AI doesn't
 * have to parse human text — it routes on the typed reason.
 */
export type PixelOmittedReason = "consent_required" | "sensitivity_blocked" | "no_capability";
