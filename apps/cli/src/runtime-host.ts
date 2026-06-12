// Runtime-host election glue for the CLI (daemon-desktop unification,
// increment 2). Every CLI entry point that would instantiate a
// MotebitRuntime runs the election first: the first process binds
// ~/.motebit/runtime.sock and coordinates; later processes attach as
// frontends (REPL) or refuse honestly (daemon, serve). The protocol
// lives in @motebit/runtime-host — this file only wires CLI identity
// and the runtime's seams into it.

import type { MotebitRuntime } from "@motebit/runtime";
import {
  electRuntimeHost,
  mintAttachToken,
  pickSafeChatOptions,
  pickSafeInvokeOptions,
  wireBridgedOrganTools,
  type ElectionOutcome,
  type RuntimeHostPaths,
  type RuntimeHostServer,
} from "@motebit/runtime-host";
import { defaultRuntimeHostPaths, nodePlatform } from "@motebit/runtime-host/node";
import { computerDefinition } from "@motebit/tools/web-safe";
import type { FullConfig } from "./config.js";
import { fromHex, loadActiveSigningKey } from "./identity.js";

export interface CliElectionDeps {
  fullConfig: FullConfig;
  motebitId: string;
  /**
   * Lazily provides the device signing key. Only called when a live
   * coordinator answers the socket (the election probes first), so
   * entry points that haven't unlocked the key don't pay the cost on
   * the nothing-is-listening path.
   */
  loadPrivateKey: () => Promise<Uint8Array>;
  /**
   * The (possibly later-constructed) runtime the coordinator's seams
   * dispatch into. A frame arriving before construction completes gets
   * an honest invoke_error, never a hang.
   */
  runtimeRef: { current: MotebitRuntime | null };
  /** Test seam — production callers use the canonical ~/.motebit endpoint. */
  paths?: RuntimeHostPaths;
}

function requireRuntime(ref: { current: MotebitRuntime | null }): MotebitRuntime {
  if (ref.current === null) {
    throw new Error("coordinator runtime is still starting — retry shortly");
  }
  return ref.current;
}

// The authority-field strip is a protocol-level guard every coordinator
// host applies — it lives in the package (`safe-options.ts`); these
// re-exports keep this module the CLI's single runtime-host seam.
export { pickSafeChatOptions as pickChatOptions, pickSafeInvokeOptions as pickInvokeOptions };

/**
 * Run the machine-wide election for a CLI entry point. Device-key
 * resolution is the shared `~/.motebit/config.json` truth: same-machine
 * frontends share this device's keypair, so the only attachable device
 * is our own; anything else refuses fail-closed.
 */
export async function electCliRuntimeHost(deps: CliElectionDeps): Promise<ElectionOutcome> {
  const paths = deps.paths ?? defaultRuntimeHostPaths();
  const deviceId = deps.fullConfig.device_id;
  const devicePublicKey = deps.fullConfig.device_public_key;

  return electRuntimeHost({
    platform: nodePlatform(),
    socketPath: paths.socketPath,
    lockfilePath: paths.lockfilePath,
    motebitId: deps.motebitId,
    resolveDevicePublicKey: (did) =>
      deviceId != null && did === deviceId && devicePublicKey != null && devicePublicKey !== ""
        ? fromHex(devicePublicKey)
        : null,
    onInvoke: (capability, prompt, options, ctx) =>
      requireRuntime(deps.runtimeRef).invokeCapability(capability, prompt, {
        ...pickSafeInvokeOptions(options),
        signal: ctx.signal,
      }),
    // sendMessageStreaming has no abort seam; a frontend disconnect
    // lets the turn run to completion on the coordinator (its memory
    // and receipts stay consistent), which is the correct authority
    // semantics — the renderer left, the act didn't.
    onChat: (text, options) =>
      requireRuntime(deps.runtimeRef).sendMessageStreaming(
        text,
        undefined,
        pickSafeChatOptions(options),
      ),
    onResolveApproval: (approved, approverId) =>
      requireRuntime(deps.runtimeRef).resolveApprovalVote(approved, approverId),
    // Attach-mode parity: records and the narrow typed-act set, resolved
    // by the runtime's closed registries (unknown kinds refuse honestly).
    onQuery: (kind, params) => requireRuntime(deps.runtimeRef).resolveAttachedRead(kind, params),
    onAct: (kind, params) => requireRuntime(deps.runtimeRef).resolveAttachedAct(kind, params),
    mintToken: async () => {
      if (deviceId == null || deviceId === "") {
        throw new Error(
          "no device_id in ~/.motebit/config.json — run `motebit` once to mint an identity",
        );
      }
      return mintAttachToken({ motebitId: deps.motebitId, deviceId }, await deps.loadPrivateKey());
    },
  });
}

/**
 * Run the election for a coordinator-role entry point — `motebit run`,
 * `motebit serve`, and one-shot subcommands that construct a transient
 * runtime over the shared `~/.motebit` storage (a transient runtime is
 * still a full signing/receipt authority while it lives). Returns the
 * bound server; exits the process honestly when another coordinator is
 * already live — one runtime authority per machine
 * (docs/doctrine/daemon-desktop-unification.md).
 */
/**
 * Surface an attached frontend's bridged organs as policy-gated tools
 * in this coordinator's registry — the consumer step of capability
 * bridging. Definitions are injected here at the registration site:
 * the only contributor of `computer_use` is a desktop frontend driving
 * the user's real OS, so the canonical `computer` definition carries
 * the `desktop_drive` embodiment stamp (same stamp the desktop's own
 * local registration applies — the model, prompt, and policy gate
 * treat the bridged tool exactly like the local one). `se_attestation`
 * deliberately has no entry: it is a deterministic identity affordance,
 * and `AI_LOOP_EXCLUDED_ORGANS` makes exposing it a wire-time error.
 * Call after the runtime exists; the sync tracks attach/disconnect.
 */
export function wireBridgedOrgans(server: RuntimeHostServer, runtime: MotebitRuntime): void {
  wireBridgedOrganTools(server, runtime, {
    computer_use: { ...computerDefinition, embodimentMode: "desktop_drive" },
  });
}

export async function electCoordinatorRole(
  fullConfig: FullConfig,
  motebitId: string,
  runtimeRef: { current: MotebitRuntime | null },
): Promise<RuntimeHostServer> {
  const election = await electAttachOrCoordinate(fullConfig, motebitId, runtimeRef);
  if (election.role === "frontend") {
    const pid = election.client.coordinatorPid;
    election.client.close();
    console.error(`Another motebit process is already coordinating this machine (pid ${pid}).`);
    console.error(
      "One runtime per machine: stop that process first, or run `motebit` (no arguments) to attach a rendering REPL to it.",
    );
    process.exit(1);
  }
  return election.server;
}

/**
 * Run the election and hand back the outcome — for entry points that
 * can serve BOTH roles (`motebit serve` coordinates when first, or
 * attaches as an MCP frontend over the coordinator's interior). Exits
 * the process honestly only on an election failure.
 */
export async function electAttachOrCoordinate(
  fullConfig: FullConfig,
  motebitId: string,
  runtimeRef: { current: MotebitRuntime | null },
): Promise<ElectionOutcome> {
  try {
    return await electCliRuntimeHost({
      fullConfig,
      motebitId,
      loadPrivateKey: async () =>
        (
          await loadActiveSigningKey(fullConfig, {
            promptLabel: "Passphrase (to verify the running coordinator): ",
          })
        ).privateKey,
      runtimeRef,
    });
  } catch (err: unknown) {
    console.error(
      `Runtime-host election failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "A coordinator may already be running with an incompatible build or a locked signing key. Stop it and retry.",
    );
    process.exit(1);
  }
}
