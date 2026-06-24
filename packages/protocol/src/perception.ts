import type { SensitivityLevel } from "./index.js";

/**
 * Perception input — the typed surface for content the user delivers
 * to a motebit by direct gesture (drag-drop on web/desktop, pinch-throw
 * on spatial, share-sheet on mobile). Same shape the doctrine
 * `motebit-computer.md` §"Supervised agency / minimum gesture set"
 * names ("Drag a file / URL / snippet onto the slab → feed perception")
 * but typed at the protocol layer so every surface produces and the
 * runtime consumes a single shape.
 *
 * Two-level pattern. Categorical kinds are closed (the protocol-layer
 * commitment); within-kind handlers are open (registered in-runtime
 * per surface). Closure here makes the role bounded — adding a new
 * categorical drop kind is a protocol bump (additive, registry append),
 * not an open-ended free-for-all. Same shape as `SuiteId` /
 * `GuestRail` / `ToolMode` (the agility-as-role pattern in
 * `docs/doctrine/agility-as-role.md`).
 *
 * Drop-out provenance — when a motebit-produced artifact leaves the
 * slab toward another destination — uses `ExecutionReceipt` (already
 * in the protocol). This file covers only the in-direction substrate.
 */

/**
 * Categorical drop kinds the protocol commits to. Closed string-literal
 * union; adding a new kind is a protocol-version bump.
 *
 *   - `url` — a hyperlink, route resolves through the runtime's
 *     fetch-shaped tool path. Highest-frequency desktop/web intent
 *     ("show motebit this page"). Source frame optional.
 *   - `text` — a snippet of text, MIME-tagged when known
 *     (`text/plain`, `text/markdown`). Drag-from-selection, paste-as-
 *     drop, or programmatic "here's context."
 *   - `image` — raster bytes with a known MIME (`image/png`,
 *     `image/jpeg`, `image/webp`). The multimodal moment — "what is
 *     this?" Routes through whatever vision-capable provider is
 *     configured.
 *   - `file` — opaque bytes with filename + MIME. Deferred for v1.1
 *     because file-format proliferation is unbounded; ships when a
 *     concrete handler-extension consumer drives the registry shape.
 *   - `artifact` — a motebit-produced signed artifact (the bytes plus
 *     its `ExecutionReceipt`). Drag motebit-to-motebit. Deferred for
 *     v1.1 because multi-motebit UX isn't shipped.
 *
 * Future kind worth naming for review-time consideration but NOT in
 * the v1 union (waits on `EmbodimentMode` protocol promotion):
 *
 *   - `mode-grant` — drag a permission token onto the slab. e.g.
 *     "you may drive my desktop for this session." Add when
 *     `EmbodimentMode` lifts from `@motebit/render-engine` to
 *     `@motebit/protocol`.
 */
export type DropPayloadKind = "url" | "text" | "image" | "file" | "artifact";

/**
 * Where in the scene the drop is intended to land. Three physically-
 * distinct targets in spatial; on 2D surfaces they collapse to "slab"
 * by default since the user can't aim at a non-slab target without
 * spatial separation.
 *
 * **The targets are NOT equivalent drop zones with different visual
 * effects.** Each has meaningfully different persistence and
 * governance scopes — implementing them with a uniform governance
 * posture is the silent-persistent-mutation failure mode this
 * doctrine exists to prevent.
 *
 *   - `slab` — perception input ("the motebit sees this for this
 *     turn"). Turn/session-scoped persistence; the sensitivity
 *     classifier inspects the payload at the next AI call;
 *     `tier-bounded-by-source` per the `EmbodimentSensitivityRouting`
 *     of `shared_gaze` mode. v1 default for every surface that
 *     doesn't yet distinguish targets.
 *
 *   - `creature` — body-bound carry ("this travels with the motebit
 *     across sessions"). Identity-adjacent state mutation: the
 *     payload is destined for the motebit's interior (memory graph,
 *     trust graph, capability bindings, persona preferences) rather
 *     than the workstation's turn context. **Stronger governance
 *     than slab is required:** explicit confirmation / signed user
 *     intent before any persistent state mutation. Closer to
 *     changing the agent's body than feeding task context.
 *     Spatial-first; deferred until the gesture surface (drag toward
 *     floating creature droplet) lands AND the per-target governance
 *     UX ships. Do NOT implement creature-drop with slab-drop's
 *     governance posture.
 *
 *   - `ambient` — environmental context ("background reference for
 *     this session, not turn-perception"). Workspace-scoped
 *     persistence with source-consent + expiration. **Invariant:
 *     ambient references are consultable context, not automatic
 *     prompt context.** The motebit can reach for them when a turn
 *     calls for it, but ambient drops never auto-fill the prompt.
 *     Future implementations will be tempted to dump ambient bytes
 *     into every turn's context pack; that's the failure mode this
 *     invariant exists to prevent. Spatial-first; in glasses,
 *     dropping a reference into the user's physical workspace is the
 *     natural gesture.
 *
 * Field is optional; absent ≡ `slab`. Surfaces may set non-default
 * targets once they implement BOTH the gesture detection (e.g.,
 * Three.js raycast pick on 2D web; 3D hand-path pick on spatial)
 * AND the per-target governance UX that makes elevation safe.
 *
 * **Dimensionality is not the gate; governance is.** A 2D web surface
 * CAN distinguish the three targets via raycast at drop time
 * (creature mesh hit / slab plane hit / no hit ≡ ambient). What
 * actually defers `creature` and `ambient` is the per-target
 * governance UX (creature: confirmation modal + chosen mutation
 * semantic; ambient: workspace-scoped consultable store +
 * retrieval-shaped API). Until those exist, `MotebitRuntime.feedPerception`
 * fails closed on non-slab targets — surfaces that send `creature` or
 * `ambient` payloads receive a clear error naming the missing
 * consumer.
 */
export type DropTarget = "slab" | "creature" | "ambient";

/**
 * Attestation of **intentional delivery** — not content authenticity.
 *
 * The user's gesture proves they meant to deliver the payload to the
 * motebit. It does NOT prove the payload is authentic, unforged, or
 * what it claims to be: a user can drag a forged PDF, a misleading
 * URL, or a tampered file, and the gesture still attests only that
 * delivery was intentional. Authenticity of the content itself
 * requires separate provenance — a source URL the runtime fetched,
 * a cryptographic signature on the bytes, an `ExecutionReceipt`
 * carried with the artifact, or a content hash the user-trusted
 * source previously published. Keep the two distinct in audit logs
 * and any prose-level claim about what a drop "vouches for."
 *
 * `surface` names which motebit surface produced the event so audit
 * logs can reconstruct the gesture's physical context (DOM drop,
 * WebXR pinch-release, share-sheet receive). For high-sensitivity
 * tiers the runtime may cosign the attestation with the user's
 * identity key; that path is deferred until per-tier signing UX
 * lands.
 *
 * Discriminated union of attestation kinds:
 *
 *   - `user-drag` — physical drag gesture delivered a payload to the
 *     surface. Carries optional `contentHashSha256` for binary kinds
 *     (`image`, `file`, `artifact`) where a hash gives the audit
 *     trail something to bind against.
 *
 *   - `user-typed-intent` — user submitted a chat message. The
 *     gesture is the typing-and-send itself; consent flows through
 *     the same channel as the request. Used by the runtime to
 *     auto-grant control handoffs that originate inside the same
 *     turn as the typed message — re-confirming a typed instruction
 *     would violate the doctrine "do not confirm what the user can
 *     already see." Proactive idle work has no typed-intent
 *     attestation, so it always falls back to the explicit prompt
 *     band — fail-closed by default.
 *
 * `contentHashSha256` is optional and only meaningful on `user-drag`
 * (typed text isn't byte-bound). The hash binds delivery to a
 * specific byte sequence; it does not, on its own, attest to content
 * authenticity.
 */
export type UserActionAttestation =
  | {
      readonly kind: "user-drag";
      readonly timestamp: number;
      readonly surface: "web" | "desktop" | "mobile" | "spatial" | "cli";
      readonly contentHashSha256?: string;
    }
  | {
      readonly kind: "user-typed-intent";
      readonly timestamp: number;
      readonly surface: "web" | "desktop" | "mobile" | "spatial" | "cli";
    };

/**
 * Discriminated union over the categorical kinds. Every surface produces
 * one of these; the runtime's `feedPerception` consumes one of these.
 * The `target` field is the spatial endpoint hint (defaults to `slab`).
 *
 * Bytes are carried inline as `Uint8Array` for `image` (and future
 * `file`). On surfaces where the source content is referenced rather
 * than embedded (e.g. a URL pointing at a remote image), the producing
 * surface MAY pass the reference instead and let the runtime fetch
 * with provider context — but the typed payload always names the kind
 * so the runtime can branch.
 */
export type DropPayload =
  | {
      kind: "url";
      url: string;
      sourceFrame?: string;
      target?: DropTarget;
      attestation: UserActionAttestation;
    }
  | {
      kind: "text";
      text: string;
      mimeType?: string;
      target?: DropTarget;
      attestation: UserActionAttestation;
    }
  | {
      kind: "image";
      bytes: Uint8Array;
      mimeType: string;
      target?: DropTarget;
      attestation: UserActionAttestation;
    }
  | {
      kind: "file";
      bytes: Uint8Array;
      filename: string;
      mimeType: string;
      target?: DropTarget;
      attestation: UserActionAttestation;
    }
  | {
      kind: "artifact";
      receiptHash: string;
      payloadJson: string;
      target?: DropTarget;
      attestation: UserActionAttestation;
    };

/**
 * Resolve a `DropPayload`'s effective target with the v1 default
 * applied. Surfaces that don't yet distinguish creature / ambient
 * (everything pre-spatial-Phase-1B) land at `slab`.
 */
export function resolveDropTarget(payload: DropPayload): DropTarget {
  return payload.target ?? "slab";
}

// ── Audit trail: sensitivity-gate firings ───────────────────────────

/**
 * Which AI-call entry the runtime blocked. The runtime gates fire at
 * nine distinct sites today; the audit event names the site so log
 * consumers can group / branch by entry without parsing free text.
 *
 * Sub-axis refinement (not a registered registry — per `registry-
 * pattern-canonical.md` this is a closed union of indirect-entry-
 * point identifiers, not an interop-law typed vocabulary with
 * multi-consumer wire-format presence). The doctrine for the
 * structural-lock pattern with bespoke coverage applies: adding an
 * entry is intentional protocol-level work + test additions, but
 * carries no eight-artifact obligation.
 *
 * Entries split into three categories:
 *
 *  1. **Direct AI-call entries** — the surface-facing method the user
 *     (or surface) invoked: `sendMessage`, `sendMessageStreaming`,
 *     `generateActivation`, `generateCompletion`, `outbound_tool`.
 *
 *  2. **Indirect AI-call entries (continuation sites)** — the runtime
 *     fires the gate again where bytes leave on resume:
 *     `resumeAfterToolApproval` (StreamingManager continues a paused
 *     turn after the user approves a tool call); `executePlanStep`
 *     (PlanExecutionManager fires the gate per-step on initial
 *     execution and on plan resume — sensitivity may have changed
 *     during the pause). Pre-2026-05-16 these reused
 *     `sendMessageStreaming` as the audit label; the doctrinally
 *     accurate split names the actual entry so audit consumers can
 *     attribute blocked egress to the right site without guessing.
 *
 *  3. **Indirect AI-call entries (housekeeping sites)** — the runtime
 *     fires the gate on background AI work that doesn't go through
 *     `runtime.generateCompletion`'s surface-facing path:
 *     `summarizeConversation` (ConversationManager calls
 *     `summarizeConversation` from `@motebit/ai-core` directly,
 *     reading full conversation history); `runReflection`
 *     (runtime.reflect / reflectAndStore call `performReflection` in
 *     `@motebit/reflection`, which composes history + memories +
 *     past reflections + audit summary before calling
 *     `reflect` in `@motebit/ai-core`). Both are bytes-leave moments
 *     with payload shapes distinct enough from `generateCompletion`
 *     that conflating their audit entry hides the actual blocked
 *     site from a forensic consumer.
 */
export type SensitivityGateEntry =
  | "sendMessage"
  | "sendMessageStreaming"
  | "generateActivation"
  | "generateCompletion"
  | "outbound_tool"
  | "resumeAfterToolApproval"
  | "executePlanStep"
  | "summarizeConversation"
  | "runReflection";

/**
 * What elevated effective sensitivity above the explicit session
 * tier. `session` means the user explicitly elevated via
 * `setSessionSensitivity`; `slab_item` means a `tier-bounded-by-source`
 * or `tier-bounded-by-tool` slab item contributed the higher tier
 * (drops, classified tool outputs). Exhaustive: future elevation
 * sources extend this union.
 */
export type SensitivityElevationSource = "session" | "slab_item";

/**
 * Payload for `EventType.SensitivityGateFired`. Emitted by the
 * runtime's `assertSensitivityPermitsAiCall` BEFORE throwing
 * `SovereignTierRequiredError`, so every blocked egress crossing
 * leaves an inspectable trail.
 *
 * **Strictly metadata.** No raw drop content, no tool result bytes,
 * no slab item payloads, no prompt strings. The audit trail names
 * the decision (which gate / which tier / which provider) without
 * carrying the sensitive data that triggered the gate. Logging the
 * payload that caused the block would itself be a leak surface —
 * the same kind of leak the gate exists to prevent.
 *
 * `slab_item_id` is optional and carries the slab item's ID when
 * elevation came from a slab item; the ID is a content-free
 * identifier (UUID-shape) that lets a forensic consumer correlate
 * the audit event against the slab state at fire time without
 * including the item's content.
 *
 * Doctrine: `motebit-computer.md` §"Mode contract — six declarations
 * per mode." The audit-trail pivot converts the shipped fail-closed
 * gate from invisible-but-correct into observable-and-provable.
 */
export interface SensitivityGateFiredPayload {
  /** Which AI-call entry was blocked. */
  readonly entry: SensitivityGateEntry;
  /** Explicit session tier at fire time (set via `setSessionSensitivity`). */
  readonly session_sensitivity: SensitivityLevel;
  /**
   * Effective tier the gate decided on — `max(session,
   * tier-bounded-slab-items)`. Equals `session_sensitivity` when no
   * slab item elevated.
   */
  readonly effective_sensitivity: SensitivityLevel;
  /** Provider mode at fire time. `unset` when surface didn't declare. */
  /**
   * Inline string-literal union of `ProviderMode` (declared in
   * `@motebit/sdk::provider-mode.ts`) plus the `unset` sentinel.
   * Inlined here rather than imported because @motebit/protocol sits
   * below @motebit/sdk in the layer graph; if ProviderMode promotes
   * to protocol later, this union narrows to `ProviderMode | "unset"`.
   */
  readonly provider_mode: "on-device" | "motebit-cloud" | "byok" | "unset";
  /**
   * What contributed the effective tier when it exceeds the explicit
   * session tier. Absent when `effective_sensitivity ===
   * session_sensitivity` (session itself was the source — no
   * elevation beyond the explicit setter to attribute).
   *
   * Field-name choice: `via` not `source`. The closed
   * `EmbodimentSourceCategory` union (`interior`, `sandboxed-tool`,
   * `user-source`, etc.) lives on the mode contract and is matched by
   * `check-mode-contract-readers` via `.source` / `{ source }` regex.
   * Naming the audit field `source` would false-positive that gate
   * (the gate's destructure detection can't distinguish object-literal
   * write from destructure read), staling its `source` ALLOWLIST entry
   * without an actual consumer. `via` reads naturally
   * ("elevated via session" / "elevated via slab_item") and avoids
   * the collision.
   */
  readonly elevated_by?: {
    readonly via: SensitivityElevationSource;
    /**
     * Slab item ID that contributed the elevated tier — present when
     * `via === "slab_item"`. Content-free identifier; useful for
     * forensic correlation with slab state at fire time.
     */
    readonly slab_item_id?: string;
  };
  /**
   * Tool name when `entry === "outbound_tool"`. Names the tool whose
   * outbound dispatch was blocked. Tool-name strings are NOT
   * sensitive (they're public capability names, not user content).
   */
  readonly tool_name?: string;
}

/**
 * Payload for `EventType.SecretRedactedFromEgress`. Emitted by the runtime when
 * `SecretRedactingProvider` masks credential-class secrets a user typed into an
 * UNMARKED cloud session before they reach a non-sovereign provider — the
 * privacy-egress sibling of {@link SensitivityGateFiredPayload}: that one records a
 * BLOCKED crossing (marked-sensitive session), this one records a REDACTED one
 * (unmarked session), so the otherwise-silent transform leaves an inspectable trail.
 *
 * **Strictly metadata.** Carries the COUNT of masked spans and the credential-class
 * LABEL names that fired (`"API_KEY"`, `"JWT"`, …) — these are pattern-class
 * identifiers, NOT the secret content, exactly as `tool_name` above is a public
 * capability name. Logging the redacted bytes would itself be the leak the redaction
 * exists to prevent.
 */
export interface SecretRedactedFromEgressPayload {
  /** How many credential-class spans were masked from the outbound payload this call. */
  readonly redacted_count: number;
  /**
   * Distinct credential-class label names that fired (e.g. `"API_KEY"`, `"JWT"`,
   * `"CONNECTION_STRING"`). Pattern-class identifiers — never the secret content.
   */
  readonly labels: readonly string[];
  /**
   * Provider mode at redaction time. Always a non-sovereign mode — redaction is a
   * no-op on a sovereign (on-device) provider. Same inline `ProviderMode | "unset"`
   * union as {@link SensitivityGateFiredPayload.provider_mode}.
   */
  readonly provider_mode: "on-device" | "motebit-cloud" | "byok" | "unset";
}
