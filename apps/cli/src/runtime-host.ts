// Runtime-host election glue for the CLI (daemon-desktop unification,
// increment 2). Every CLI entry point that would instantiate a
// MotebitRuntime runs the election first: the first process binds
// ~/.motebit/runtime.sock and coordinates; later processes attach as
// frontends (REPL) or refuse honestly (daemon, serve). The protocol
// lives in @motebit/runtime-host — this file only wires CLI identity
// and the runtime's seams into it.

import type { MotebitRuntime } from "@motebit/runtime";
import {
  defaultRuntimeHostPaths,
  electRuntimeHost,
  mintAttachToken,
  type ElectionOutcome,
  type RuntimeHostPaths,
} from "@motebit/runtime-host";
import type { FullConfig } from "./config.js";
import { fromHex } from "./identity.js";

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

/**
 * Narrow the wire-supplied chat options to the safe subset. Authority
 * fields are NEVER forwarded: `verifiedGrant` may only be produced by
 * `verifyGrantForTurn` from signed artifacts
 * (docs/doctrine/memory-never-confers-authority.md), and
 * `userActionAttestation` must originate from a real local user action
 * — an attached process asserting either over the socket would be a
 * privilege escalation, authenticated or not.
 */
export function pickChatOptions(
  options: Record<string, unknown> | undefined,
): { delegationScope?: string; suppressHistory?: boolean } | undefined {
  if (options === undefined) return undefined;
  const picked: { delegationScope?: string; suppressHistory?: boolean } = {};
  if (typeof options["delegationScope"] === "string") {
    picked.delegationScope = options["delegationScope"];
  }
  if (typeof options["suppressHistory"] === "boolean") {
    picked.suppressHistory = options["suppressHistory"];
  }
  return picked;
}

/** Same narrowing for invoke options; origin stays the default "user-tap". */
export function pickInvokeOptions(options: Record<string, unknown> | undefined): {
  targetWorkerId?: string;
  acknowledgeNoHistoryRisk?: boolean;
} {
  const picked: { targetWorkerId?: string; acknowledgeNoHistoryRisk?: boolean } = {};
  if (options === undefined) return picked;
  if (typeof options["targetWorkerId"] === "string") {
    picked.targetWorkerId = options["targetWorkerId"];
  }
  if (typeof options["acknowledgeNoHistoryRisk"] === "boolean") {
    picked.acknowledgeNoHistoryRisk = options["acknowledgeNoHistoryRisk"];
  }
  return picked;
}

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
    socketPath: paths.socketPath,
    lockfilePath: paths.lockfilePath,
    motebitId: deps.motebitId,
    resolveDevicePublicKey: (did) =>
      deviceId != null && did === deviceId && devicePublicKey != null && devicePublicKey !== ""
        ? fromHex(devicePublicKey)
        : null,
    onInvoke: (capability, prompt, options, ctx) =>
      requireRuntime(deps.runtimeRef).invokeCapability(capability, prompt, {
        ...pickInvokeOptions(options),
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
        pickChatOptions(options),
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
