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
  type ElectionOutcome,
  type RuntimeHostPaths,
  type RuntimeHostServer,
} from "@motebit/runtime-host";
import { defaultRuntimeHostPaths, nodePlatform } from "@motebit/runtime-host/node";
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
export async function electCoordinatorRole(
  fullConfig: FullConfig,
  motebitId: string,
  runtimeRef: { current: MotebitRuntime | null },
): Promise<RuntimeHostServer> {
  let election: ElectionOutcome;
  try {
    election = await electCliRuntimeHost({
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
