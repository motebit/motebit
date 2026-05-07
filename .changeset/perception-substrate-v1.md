---
"@motebit/protocol": minor
"@motebit/sdk": minor
---

Drag-drop perception substrate — protocol-layer types for the gesture the slab doctrine has named since landing.

```ts
export type DropPayloadKind = "url" | "text" | "image" | "file" | "artifact";

export type DropTarget = "slab" | "creature" | "ambient";

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

export interface UserActionAttestation {
  readonly kind: "user-drag";
  readonly timestamp: number;
  readonly surface: "web" | "desktop" | "mobile" | "spatial" | "cli";
  readonly contentHashSha256?: string;
}

export function resolveDropTarget(payload: DropPayload): DropTarget;
```

Two-level pattern, same shape as `SuiteId` / `GuestRail` / `ToolMode` (the agility-as-role pattern in `docs/doctrine/agility-as-role.md`). Categorical drop kinds are closed at the protocol layer — adding a kind is a protocol bump (additive, registry append). Per-kind handlers are runtime-extensible via `MotebitRuntime.registerDropHandler(kind, handler)`; v1 default handlers stage slab items for `url`, `text`, `image` in **`shared_gaze` mode** — the user is the driver, motebit is the observer, source is `user-source`, consent fires per-source. (`mind` would be a category error: `mind` is interior cognition, not user-fed external material.) The doctrine's three drop targets (`slab` / `creature` / `ambient`) carry as an optional hint defaulting to `slab`; spatial Phase 1B unlocks the other two without a wire-format change.

`UserActionAttestation` is **attestation of intentional delivery, not content authenticity.** The user's gesture proves they meant to deliver the payload — it does NOT prove the payload is authentic, unforged, or what it claims to be. A user can drag a forged PDF; the gesture still attests only that delivery was intentional. Authenticity comes from separate provenance — a source URL the runtime fetched, a cryptographic signature on the bytes, an `ExecutionReceipt`, or a content hash a trusted source previously published. Audit prose must keep the two distinct.

Drop-out provenance — when a motebit-produced artifact leaves the slab toward another destination — uses `ExecutionReceipt` (already in the protocol). This release covers the in-direction substrate.

Drift gate `check-drop-handlers` (#77) enforces both arms: every `DropPayloadKind` has a registered handler or an explicit allowlist entry, AND every per-surface drop handler routes through `runtime.feedPerception` (never constructs a prompt and calls `sendMessage` — the prompt-backdoor failure mode named in `motebit-computer.md` §"Failure modes specific to supervised agency").

Doctrine: `motebit-computer.md` §"Perception input — drop kinds and handlers" + `liquescentia-as-substrate.md` §"Cohesive permeability" (the membrane physics every drop crosses under conditions).
