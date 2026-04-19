/**
 * Credential satellites for the web surface — the 3D shadow of every
 * credential the motebit holds. Mounts as Three.js meshes orbiting the
 * creature, complementing (not replacing) the 2D list in the Sovereign
 * panel.
 *
 * The renderer + types + transform all live in `@motebit/render-engine`.
 * This module is the web-specific wiring: lazy mount after the creature
 * group exists, tick each frame from the render loop, refresh on
 * `onCredentialsChanged`.
 *
 * Artifacts are verbs ("a receipt just arrived"). Satellites are nouns
 * ("I have three credentials"). Different render surfaces, different jobs.
 */

import {
  CredentialSatelliteRenderer,
  credentialsToExpression,
  type CredentialSummary,
} from "@motebit/render-engine";
import type { MotebitRuntime } from "@motebit/runtime";
import type { ThreeJSAdapter } from "@motebit/render-engine";

export interface CredentialSatelliteController {
  /** Call every animation frame with the current timestamp in ms. */
  tick(nowMs: number): void;
  /** Dispose the renderer and unsubscribe from credential changes. */
  dispose(): void;
}

/**
 * Mount the credential satellite renderer under the creature group and
 * wire it to runtime credential changes. Returns null (no controller) if
 * the adapter has not yet produced a creature group — caller should retry
 * after renderer.init() completes.
 */
export function mountCredentialSatellites(
  adapter: ThreeJSAdapter,
  runtime: MotebitRuntime,
): CredentialSatelliteController | null {
  const group = adapter.getCreatureGroup();
  if (!group) return null;

  const renderer = new CredentialSatelliteRenderer(group);
  const refresh = (): void => {
    const summaries: CredentialSummary[] = runtime.getIssuedCredentials().map((vc) => ({
      credential_type: vc.type.find((t) => t !== "VerifiableCredential") ?? "Credential",
      issued_at: typeof vc.validFrom === "string" ? new Date(vc.validFrom).getTime() : Date.now(),
      credential: {
        issuanceDate: typeof vc.validFrom === "string" ? vc.validFrom : undefined,
        issuer: typeof vc.issuer === "string" ? vc.issuer : vc.issuer,
      },
    }));
    renderer.setExpression(credentialsToExpression(summaries));
  };

  // Initial snapshot + subscribe for live updates.
  refresh();
  const unsubscribe = runtime.onCredentialsChanged(refresh);

  return {
    tick: (nowMs) => renderer.tick(nowMs),
    dispose: () => {
      unsubscribe();
      renderer.dispose();
    },
  };
}
