/**
 * Agent-command envelope convention — the first consumer binding of
 * `signed-request-envelope@1.0` (spec §2's free-form `aud` with the
 * `{host}/{route}` convention): remote `command_request` ingress.
 *
 * A remote command targeting an agent is signed by the agent's OWN
 * identity (v1: only the identity that owns an agent may command it),
 * audience-bound to the target so an envelope signed for agent A
 * replays as garbage at agent B, and digest-bound to the exact
 * `{command, args}` payload. The relay verifies at ingress as defense
 * in depth and forwards the envelope verbatim; every consuming surface
 * re-verifies fail-closed against its own registered identity key —
 * the relay is a convenience layer, never the trust root
 * (`docs/doctrine/daemon-desktop-unification.md` increment 4).
 */
import type { SignedRequestEnvelope } from "@motebit/protocol";
import { signRequestEnvelope, verifyRequestEnvelope } from "./artifacts.js";
import { hexToBytes } from "./signing.js";

/** Audience for commands targeting one agent — exact-match per §4 step 3. */
export function agentCommandAudience(targetMotebitId: string): string {
  return `agent-command/${targetMotebitId}`;
}

/**
 * Canonical detached payload for a command envelope. Absent `args`
 * normalizes to `null` so signer and verifier hash identical bytes.
 */
export function agentCommandPayload(
  command: string,
  args?: string,
): { command: string; args: string | null } {
  return { command, args: args ?? null };
}

/** Sign a remote command for the given agent (v1: signer == target identity). */
export async function signAgentCommandEnvelope(opts: {
  command: string;
  args?: string;
  motebitId: string;
  identityPrivateKey: Uint8Array;
  now?: () => number;
  nonce?: string;
}): Promise<SignedRequestEnvelope> {
  return signRequestEnvelope(
    agentCommandPayload(opts.command, opts.args),
    {
      motebit_id: opts.motebitId,
      ts: (opts.now ?? Date.now)(),
      aud: agentCommandAudience(opts.motebitId),
      ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}),
    },
    opts.identityPrivateKey,
  );
}

export type AgentCommandVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Verify an inbound `command_request` fail-closed. Returns a verdict,
 * never throws on bad input: missing envelope, foreign identity, bad
 * signature, stale timestamp, audience mismatch, and payload tamper
 * all reject with an honest reason the consumer can surface.
 */
export async function verifyAgentCommandEnvelope(opts: {
  /** The `envelope` field of the inbound message — untrusted. */
  envelope: unknown;
  command: string;
  args?: string;
  /** This agent's identity — both expected signer and audience target. */
  motebitId: string;
  /** The agent's registered identity public key (hex or bytes). */
  identityPublicKey: Uint8Array | string;
  /** Test seam for the §4 freshness check. */
  now?: number;
}): Promise<AgentCommandVerdict> {
  const candidate = opts.envelope as Partial<SignedRequestEnvelope> | null | undefined;
  if (
    candidate == null ||
    typeof candidate !== "object" ||
    typeof candidate.signature !== "string" ||
    typeof candidate.motebit_id !== "string"
  ) {
    return {
      ok: false,
      reason:
        "command_request rejected: missing signed-request-envelope@1.0 (unsigned remote commands are not accepted)",
    };
  }
  if (candidate.motebit_id !== opts.motebitId) {
    return {
      ok: false,
      reason: "command_request rejected: envelope identity is not this agent's identity",
    };
  }
  const key =
    typeof opts.identityPublicKey === "string"
      ? hexToBytes(opts.identityPublicKey)
      : opts.identityPublicKey;
  const valid = await verifyRequestEnvelope(candidate as SignedRequestEnvelope, key, {
    payload: agentCommandPayload(opts.command, opts.args),
    expectedAud: agentCommandAudience(opts.motebitId),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return valid
    ? { ok: true }
    : {
        ok: false,
        reason:
          "command_request rejected: envelope verification failed (signature, audience, freshness, or payload digest)",
      };
}
