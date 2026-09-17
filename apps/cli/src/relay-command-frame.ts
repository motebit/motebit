/**
 * The one handler for a `command_request` frame the relay forwarded.
 *
 * Both long-lived executors on a machine answer these — `motebit run`
 * and `motebit serve` — and until now each carried its own copy of the
 * sequence: verify the envelope, check the replay guard, execute, reply.
 * Two copies of a security sequence is two places to get it wrong, and
 * `check-relay-frame-origin` found exactly that shape when it had to be
 * taught that one file holds two handlers.
 *
 * It is also what makes the sequence testable. A fake socket that only
 * records payloads proves nothing about what a runtime does with a
 * frame; a harness that calls THIS drives the real verification, the
 * real replay guard and the real command layer, which is where the
 * defects of this arc have actually lived.
 *
 * Fail-closed at every step. The relay's word is transport, never
 * authorization: only a `signed-request-envelope@1.0` from this agent's
 * own identity executes.
 */
// Both from `@motebit/runtime`, never from `@motebit/crypto` directly:
// an app consumes the product vocabulary, and the protocol floor is for
// independent implementers. `check-app-primitives` enforces it, and the
// daemon's inlined copy of this had it right.
import {
  verifyAgentCommandEnvelope,
  executeRemoteCommand,
  type MotebitRuntime,
} from "@motebit/runtime";

/** A `command_request` as it arrives on the wire. */
export interface RelayCommandFrame {
  id: string;
  command: string;
  args?: string;
  envelope?: unknown;
}

export interface RelayCommandFrameDeps {
  runtime: MotebitRuntime;
  motebitId: string;
  /**
   * This agent's registered identity public key — the authorization
   * root, and `undefined` when there isn't one yet.
   *
   * Optional on purpose, and refused here rather than at the call site.
   * `motebit serve` carried that guard and the daemon's copy did not;
   * with no key there is nothing to verify an envelope against, and the
   * only safe answer is to reject rather than to trust the relay's
   * forwarding alone. Making it structural means a third caller cannot
   * forget the check the second one remembered.
   */
  identityPublicKey: string | undefined;
  /**
   * The replay guard for THIS MACHINE. `motebit run` and `motebit serve`
   * share one, which is why a single envelope must reach a machine once:
   * the second process would reject its own motebit's halt as a replay.
   */
  checkReplay(signature: string): { accepted: boolean; message?: string };
  /** Send the `command_response` frame back up the socket. */
  reply(payload: string): void;
}

/**
 * Answer one frame. Never throws — a thrown error becomes a reply,
 * because a caller that hears nothing cannot tell a crash from a
 * refusal, and a socket that has gone away in the meantime is not a
 * reason to take the process down with it.
 */
export async function handleRelayCommandFrame(
  frame: RelayCommandFrame,
  deps: RelayCommandFrameDeps,
): Promise<void> {
  const respond = (result: unknown): void => {
    deps.reply(JSON.stringify({ type: "command_response", id: frame.id, result }));
  };
  try {
    const key = deps.identityPublicKey;
    if (key == null || key === "") {
      respond({
        summary: "command_request rejected: no registered identity public key to verify against",
      });
      return;
    }
    const verdict = await verifyAgentCommandEnvelope({
      envelope: frame.envelope,
      command: frame.command,
      args: frame.args,
      motebitId: deps.motebitId,
      identityPublicKey: key,
    });
    if (!verdict.ok) {
      respond({ summary: verdict.reason });
      return;
    }

    // An envelope is single-use. Without this, a relay or anything on
    // the path could replay a captured halt — or a resume — at a moment
    // of its choosing.
    const sig = (frame.envelope as { signature?: string } | undefined)?.signature;
    const replay = typeof sig === "string" ? deps.checkReplay(sig) : ({ accepted: true } as const);
    if (!replay.accepted) {
      respond({ summary: `command_request rejected: ${replay.message ?? "replay"}` });
      return;
    }

    // `origin: "remote"` is recorded, never trusted — the envelope
    // verified above is the authorization. It exists so a halt's durable
    // record says the sovereign stopped their motebit from somewhere
    // else, and so the return view knows a wire is being crossed.
    respond(await executeRemoteCommand(deps.runtime, frame.command, frame.args));
  } catch (err: unknown) {
    // The last reply is guarded too, so the docstring above stays true.
    // Both call sites `void` this, and the CLI registers no
    // `unhandledRejection` handler — so a throw from `reply` here would
    // take the process down while answering a frame, which is a very
    // expensive way to fail to send an error message.
    try {
      respond({ summary: `Error: ${err instanceof Error ? err.message : String(err)}` });
    } catch {
      // Nothing left to say it to.
    }
  }
}
