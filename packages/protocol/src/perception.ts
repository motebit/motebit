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
 *   - `slab` — perception input ("the motebit sees this for this
 *     turn"). v1 default for every surface that doesn't yet
 *     distinguish targets.
 *   - `creature` — body-bound carry ("this travels with the motebit
 *     across sessions"). Different semantics from a slab item;
 *     identity-touch, not workstation. Spatial-first; deferred until
 *     the gesture surface (drag toward floating creature droplet)
 *     lands.
 *   - `ambient` — environmental context ("background reference for
 *     this session, not turn-perception"). Spatial-first; in glasses,
 *     dropping a reference into the user's physical workspace is the
 *     natural gesture.
 *
 * Field is optional; absent ≡ `slab`. Surfaces only set non-default
 * targets once they implement the gesture vocabulary that makes the
 * target unambiguous (3D pick on the user's hand path).
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
 * `contentHashSha256` is optional and present for binary kinds
 * (`image`, `file`, `artifact`) where a hash gives the audit trail
 * something to bind against. The hash binds delivery to a specific
 * byte sequence; it does not, on its own, attest to content
 * authenticity.
 */
export interface UserActionAttestation {
  readonly kind: "user-drag";
  readonly timestamp: number;
  readonly surface: "web" | "desktop" | "mobile" | "spatial" | "cli";
  readonly contentHashSha256?: string;
}

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
