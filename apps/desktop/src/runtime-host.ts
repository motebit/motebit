// Runtime-host election glue for the desktop (daemon-desktop
// unification, increment 3). On launch the desktop elects: first
// process binds ~/.motebit/runtime.sock and coordinates (full desktop +
// serving the socket); when a coordinator is already live (typically
// the CLI daemon), the desktop attaches as a frontend and contributes
// its unique Tauri organs — Secure-Enclave attestation and computer-use
// — as bridged capabilities, which is exactly the neutrality argument
// that licensed first-binder-wins.

import type { MotebitRuntime } from "@motebit/runtime";
import {
  electRuntimeHost,
  mintAttachToken,
  pickSafeChatOptions,
  pickSafeInvokeOptions,
  wireBridgedOrganTools,
  type BridgedCapabilityHandler,
  type ElectionOutcome,
  type RuntimeHostServer,
} from "@motebit/runtime-host";
import { computerDefinition } from "@motebit/tools/web-safe";
import { createTauriRuntimeHostPlatform } from "./runtime-host-platform.js";
import type { InvokeFn } from "./tauri-storage.js";

export interface DesktopElectionDeps {
  invoke: InvokeFn;
  motebitId: string;
  deviceId: string;
  signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array };
  /**
   * The (possibly later-constructed) runtime the coordinator seams
   * dispatch into; a frame arriving before construction completes gets
   * an honest invoke_error, never a hang.
   */
  getRuntime: () => MotebitRuntime | null;
}

function requireRuntime(get: () => MotebitRuntime | null): MotebitRuntime {
  const runtime = get();
  if (runtime === null) {
    throw new Error("coordinator runtime is still starting — retry shortly");
  }
  return runtime;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The desktop's contributed organs. Invocations arrive only from the
 * machine's authenticated coordinator (same user, signed handshake);
 * policy-gating of bridged organs at the coordinator's tool layer is
 * part of the bridged-tool wiring increment.
 */
export function desktopOrganHandlers(deps: {
  invoke: InvokeFn;
  motebitId: string;
  deviceId: string;
  identityPublicKeyHex: string;
}): Record<string, BridgedCapabilityHandler> {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    se_attestation: async function* (_prompt, options) {
      const attestedAt =
        typeof options?.["attested_at"] === "number" ? options["attested_at"] : Date.now();
      yield await deps.invoke("se_mint_attestation", {
        motebitId: deps.motebitId,
        deviceId: deps.deviceId,
        identityPublicKeyHex: deps.identityPublicKeyHex,
        attestedAt,
      });
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    computer_use: async function* (_prompt, options) {
      const action = options?.["action"];
      if (action == null) {
        throw new Error("computer_use bridged invocation requires options.action");
      }
      yield await deps.invoke("computer_execute", { action });
    },
  };
}

/**
 * Surface an attached frontend's bridged organs as policy-gated tools
 * in this coordinator's registry — the consumer step of capability
 * bridging, the sibling of the CLI daemon's wiring. A desktop
 * coordinator's OWN computer tool is locally registered, so a bridged
 * `computer` is skipped while it exists (local organ beats bridge);
 * the wiring still matters for any future organ-contributing frontend.
 * `se_attestation` deliberately has no entry — a deterministic identity
 * affordance, wire-time-refused by `AI_LOOP_EXCLUDED_ORGANS`.
 */
export const BRIDGED_ORGAN_DEFINITIONS = {
  computer_use: { ...computerDefinition, embodimentMode: "desktop_drive" },
} as const;

export function wireBridgedOrgans(server: RuntimeHostServer, runtime: MotebitRuntime): void {
  wireBridgedOrganTools(server, runtime, BRIDGED_ORGAN_DEFINITIONS);
}

/** Run the machine-wide election for the desktop surface. */
export async function electDesktopRuntimeHost(deps: DesktopElectionDeps): Promise<ElectionOutcome> {
  const { platform, home } = await createTauriRuntimeHostPlatform(deps.invoke);
  const devicePublicKeyHex = toHex(deps.signingKeys.publicKey);

  const outcome = await electRuntimeHost({
    platform,
    socketPath: `${home}/.motebit/runtime.sock`,
    lockfilePath: `${home}/.motebit/runtime.lock`,
    motebitId: deps.motebitId,
    resolveDevicePublicKey: (did) => (did === deps.deviceId ? deps.signingKeys.publicKey : null),
    onInvoke: (capability, prompt, options, ctx) =>
      requireRuntime(deps.getRuntime).invokeCapability(capability, prompt, {
        ...pickSafeInvokeOptions(options),
        signal: ctx.signal,
      }),
    onChat: (text, options) =>
      requireRuntime(deps.getRuntime).sendMessageStreaming(
        text,
        undefined,
        pickSafeChatOptions(options),
      ),
    onResolveApproval: (approved, approverId) =>
      requireRuntime(deps.getRuntime).resolveApprovalVote(approved, approverId),
    mintToken: () =>
      mintAttachToken(
        { motebitId: deps.motebitId, deviceId: deps.deviceId },
        deps.signingKeys.privateKey,
      ),
  });

  if (outcome.role === "frontend") {
    // Contribute the desktop's organs — bridging makes the election
    // outcome operationally neutral for capability.
    outcome.client.setBridgedCapabilities(
      desktopOrganHandlers({
        invoke: deps.invoke,
        motebitId: deps.motebitId,
        deviceId: deps.deviceId,
        identityPublicKeyHex: devicePublicKeyHex,
      }),
    );
  }
  return outcome;
}
