/**
 * Perception types — protocol-layer surface tests.
 *
 * The closed `DropPayloadKind` union, `DropTarget`, `DropPayload`,
 * `UserActionAttestation`, and `resolveDropTarget` ship as
 * developer-contract types third-party motebit implementers bind
 * against. Test the helper here (in the protocol package) so the
 * protocol's own coverage sees it; runtime-level tests in
 * `@motebit/runtime` exercise the perception substrate end-to-end
 * but don't count toward this package's coverage threshold.
 */

import { describe, it, expect } from "vitest";
import { resolveDropTarget, type DropPayload, type UserActionAttestation } from "../perception.js";

const baseAttestation: UserActionAttestation = {
  kind: "user-drag",
  timestamp: 1_700_000_000_000,
  surface: "web",
};

describe("resolveDropTarget — v1 default", () => {
  it("returns slab when target is absent", () => {
    const payload: DropPayload = {
      kind: "url",
      url: "https://example.com",
      attestation: baseAttestation,
    };
    expect(resolveDropTarget(payload)).toBe("slab");
  });

  it("returns slab when target is explicitly slab", () => {
    const payload: DropPayload = {
      kind: "text",
      text: "hello",
      target: "slab",
      attestation: baseAttestation,
    };
    expect(resolveDropTarget(payload)).toBe("slab");
  });

  it("returns creature when target is creature", () => {
    const payload: DropPayload = {
      kind: "url",
      url: "https://example.com",
      target: "creature",
      attestation: baseAttestation,
    };
    expect(resolveDropTarget(payload)).toBe("creature");
  });

  it("returns ambient when target is ambient", () => {
    const payload: DropPayload = {
      kind: "text",
      text: "background context",
      target: "ambient",
      attestation: baseAttestation,
    };
    expect(resolveDropTarget(payload)).toBe("ambient");
  });

  it("works across every DropPayloadKind variant", () => {
    // Type-level smoke test: resolveDropTarget accepts every variant
    // of the discriminated union without narrowing failures.
    const url: DropPayload = {
      kind: "url",
      url: "https://x",
      attestation: baseAttestation,
    };
    const text: DropPayload = {
      kind: "text",
      text: "x",
      attestation: baseAttestation,
    };
    const image: DropPayload = {
      kind: "image",
      bytes: new Uint8Array(0),
      mimeType: "image/png",
      attestation: baseAttestation,
    };
    const file: DropPayload = {
      kind: "file",
      bytes: new Uint8Array(0),
      filename: "x.txt",
      mimeType: "text/plain",
      attestation: baseAttestation,
    };
    const artifact: DropPayload = {
      kind: "artifact",
      receiptHash: "abc",
      payloadJson: "{}",
      attestation: baseAttestation,
    };
    expect(resolveDropTarget(url)).toBe("slab");
    expect(resolveDropTarget(text)).toBe("slab");
    expect(resolveDropTarget(image)).toBe("slab");
    expect(resolveDropTarget(file)).toBe("slab");
    expect(resolveDropTarget(artifact)).toBe("slab");
  });
});
