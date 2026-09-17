/**
 * The arc's own sentences, asserted against two real runtimes.
 *
 * Every one of these is a defect a review round found by READING,
 * because nothing in the repo could express it as a failing test: the
 * relay's tests used peers whose `send` recorded a payload, which
 * proves the relay chose a peer and nothing about what the peer did.
 * Here both ends are real — real envelope verification, real replay
 * guard, real command layer, a halt store per process.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { generateKeypair, bytesToHex, signAgentCommandEnvelope } from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import {
  assertWireHealthy,
  attachRuntime,
  resetHarness,
  standUpMotebit,
} from "./multi-runtime-harness.js";

const AUTH = { "Content-Type": "application/json", Authorization: "Bearer test-token" };

let relay: SyncRelay;
let keys: KeyPair;
let motebitId: string;
let pubHex: string;

/** A phone asking, the way the consent root actually asks. */
async function ask(command: string, args?: string) {
  const envelope = await signAgentCommandEnvelope({
    command,
    ...(args != null ? { args } : {}),
    motebitId,
    identityPrivateKey: keys.privateKey,
  });
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/command`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ command, ...(args != null ? { args } : {}), envelope }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  resetHarness();
  relay = await createSyncRelay({
    apiToken: "test-token",
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    // The harness registers on 127.0.0.1 — the local-development
    // allowance. Production keeps the default: globally-routable only.
    allowPrivateEndpoints: true,
  });
  keys = await generateKeypair();
  pubHex = bytesToHex(keys.publicKey);
  ({ motebitId } = await standUpMotebit(relay, pubHex));
});

afterEach(async () => {
  await relay.close();
  // The wire, not the subject. A silently broken loop makes every
  // assertion above prove less than it appears to.
  assertWireHealthy();
});

describe("two runtimes, one relay — what a frame actually does", () => {
  it("a halt from the phone reaches the daemon and STOPS it", async () => {
    // The arc's central sentence, and it had never been asserted
    // end-to-end: an envelope minted by the consent root, routed by the
    // relay, verified by the runtime, written to that runtime's halt
    // store, and acknowledged by the executor that stopped.
    const daemon = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime", "run_ledger"],
      },
    );

    const { status, body } = await ask("halt");
    expect(status).toBe(200);
    expect(JSON.stringify(body)).toMatch(/stop requested/i);

    // Not the relay's word — the runtime's own store.
    const active = daemon.runtime.halts?.listActive(motebitId) ?? [];
    expect(active).toHaveLength(1);
    expect(active[0]?.origin).toBe("remote");
  });

  it("the SAME envelope replayed is refused by the runtime, not the relay", async () => {
    // Fail-closed at the authority, not at the transport. A relay that
    // forwarded a captured halt twice must not be able to act twice.
    attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    const envelope = await signAgentCommandEnvelope({
      command: "halt",
      motebitId,
      identityPrivateKey: keys.privateKey,
    });
    const send = async (): Promise<string> => {
      const res = await relay.app.request(`/api/v1/agents/${motebitId}/command`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ command: "halt", envelope }),
      });
      return JSON.stringify(await res.json());
    };

    expect(await send()).toMatch(/stop requested/i);
    expect(await send()).toMatch(/replay/i);
  });

  it("two processes on ONE machine share a replay guard — so one frame, or the second refuses", async () => {
    // `motebit run` and `motebit serve` share `~/.motebit` and therefore
    // one guard. This is the fact that made a broadcast to every
    // CONNECTION wrong, and it is the reason delivery is per machine.
    const run = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    const serve = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "serve",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );

    const { body } = await ask("halt");
    // Exactly one process received the frame under first-wins...
    expect(run.received.length + serve.received.length).toBe(1);
    // ...and it was not answered as a replay.
    expect(JSON.stringify(body)).not.toMatch(/replay/i);
    // Only the process that received it has the halt: nothing
    // replicates, which is the whole of issue #681 in one assertion.
    const stopped = [run, serve].filter(
      (r) => (r.runtime.halts?.listActive(motebitId) ?? []).length > 0,
    );
    expect(stopped).toHaveLength(1);
  });

  it("delivering ONE envelope to both processes makes the second refuse it as a replay", async () => {
    // The fact the harness exists to hold, and the reason delivery is
    // per machine rather than per connection.
    //
    // First-wins never exercises it — only one process is ever
    // delivered to, so every assertion above holds identically with a
    // per-process guard. This states it directly, the way a broadcast
    // will: one signed envelope, both processes, one shared guard.
    // Without it, issue #681 would be built against a harness that
    // agrees with the bug it is meant to prevent.
    const run = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    const serve = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "serve",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );

    const envelope = await signAgentCommandEnvelope({
      command: "halt",
      motebitId,
      identityPrivateKey: keys.privateKey,
    });
    const frame = JSON.stringify({
      type: "command_request",
      id: crypto.randomUUID(),
      command: "halt",
      envelope,
    });
    run.deliver(frame);
    serve.deliver(frame);
    await new Promise((r) => setTimeout(r, 30));

    expect(JSON.stringify(run.replied)).not.toMatch(/replay/i);
    expect(JSON.stringify(serve.replied)).toMatch(/replay/i);
    // And a machine's OWN halt is not what got refused: the first
    // process stopped.
    expect(run.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(1);
  });

  it("two processes on DIFFERENT machines each accept the same envelope", async () => {
    // The guard is per machine, not global — otherwise a broadcast
    // could never stop the second host at all, and the fix for #681
    // would be impossible rather than merely untested.
    const laptop = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    const vps = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-2",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    const envelope = await signAgentCommandEnvelope({
      command: "halt",
      motebitId,
      identityPrivateKey: keys.privateKey,
    });
    const frame = JSON.stringify({
      type: "command_request",
      id: crypto.randomUUID(),
      command: "halt",
      envelope,
    });
    laptop.deliver(frame);
    vps.deliver(frame);
    await new Promise((r) => setTimeout(r, 30));

    expect(JSON.stringify(laptop.replied)).not.toMatch(/replay/i);
    expect(JSON.stringify(vps.replied)).not.toMatch(/replay/i);
    expect(laptop.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(1);
    expect(vps.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(1);
  });

  it("a dead socket beside a live one on the same machine does not lose the halt", async () => {
    // A stale-but-unreaped connection is the ordinary case moments
    // after a process dies. First-wins walks past it.
    const stale = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "stale",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
        socketIsDead: true,
      },
    );
    const live = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "live",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );

    const { status } = await ask("halt");
    expect(status).toBe(200);
    expect(stale.received).toEqual([]);
    expect(live.received).toHaveLength(1);
    expect(live.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(1);
  });

  it("a halt reaches EVERY machine, not the first that answers", async () => {
    // The halt store is local and nothing replicates it, so first-wins
    // stops one machine and leaves the other working — under the
    // stopped one's acknowledgement, which reads as "stopped" for a
    // motebit that is still running. The act is idempotent and
    // machine-local, so the delivery that matches what was asked for is
    // to all of them.
    const laptop = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    const vps = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-2",
        capabilities: ["background", "unattended_runtime"],
      },
    );

    await ask("halt");
    expect(laptop.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(1);
    expect(vps.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(1);
  });

  it("a machine that never answers is named as silent, not quietly dropped", async () => {
    // An unanswered halt is the one outcome a reader must not take for
    // a stop. Dropping it from the report would hand back the answering
    // machine's "Stop requested" as though it spoke for the motebit.
    const laptop = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-2",
        capabilities: ["background", "unattended_runtime"],
        neverReplies: true,
      },
    );

    const { body } = await ask("halt");
    const text = JSON.stringify(body);
    expect(text).toMatch(/did not answer in time/i);
    expect(text).toMatch(/silence is not a stop/i);
    // And the machine that did answer is still reported.
    expect(text).toMatch(/stop requested/i);
    expect(laptop.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(1);
  }, 15_000);

  it("a resume reports the machine that ACTED, not the one with nothing to do", async () => {
    // `cmdResume` answers "Nothing is halted." synchronously when
    // nothing is active, while the machine that holds the halt awaits
    // its store — so the machine with least to do reliably wins a race,
    // and a successful resume rendered as a no-op.
    const halted = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    const idle = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-2",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    // Halt reaches both; lift it on one so the two have different news.
    await ask("halt");
    const onlyOn = halted.runtime.halts?.listActive(motebitId) ?? [];
    expect(onlyOn).toHaveLength(1);
    idle.runtime.halts?.lift((idle.runtime.halts.listActive(motebitId)[0] ?? onlyOn[0]!).halt_id);

    const { body } = await ask("resume");
    const text = JSON.stringify(body);
    // Both machines' answers are present; neither stands in for the
    // motebit's.
    expect(text).toMatch(/Sent to 2 runtimes/i);
    expect(text).toMatch(/nothing is halted/i);
  }, 15_000);

  it("`runs` goes to the ledger-holder, never to a task worker that can be stopped", async () => {
    // `motebit serve` announces `unattended_runtime` truthfully and
    // keeps no run rows. Asked anyway, it answered "No runs recorded
    // yet" about a motebit that had worked all night.
    const worker = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "serve",
        deviceId: "dev-2",
        capabilities: ["http_mcp", "unattended_runtime"],
      },
    );
    const daemon = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime", "run_ledger"],
        configure: (rt) =>
          rt.setRunLedgerReader({
            listRecent: () => [],
            get: () => ({ kind: "missing" as const }),
          }),
      },
    );

    await ask("runs");
    expect(daemon.received).toHaveLength(1);
    expect(worker.received).toEqual([]);
  });

  it("an envelope signed by another key is refused at the RUNTIME", async () => {
    // The relay verifies at ingress, but the runtime is the authority
    // and re-verifies fail-closed. Asserted from the runtime's side:
    // nothing was stopped.
    const daemon = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    const impostor = await generateKeypair();
    const envelope = await signAgentCommandEnvelope({
      command: "halt",
      motebitId,
      identityPrivateKey: impostor.privateKey,
    });
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/command`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ command: "halt", envelope }),
    });
    expect(res.status).not.toBe(200);
    expect(daemon.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(0);
  });

  it("a runtime with no identity key refuses rather than trusting the relay", async () => {
    // `motebit serve` carried this guard and the daemon's copy did not.
    // It is structural in the shared handler now, so assert it holds
    // from the outside.
    const daemon = attachRuntime(
      { relay, motebitId, identityPublicKey: "" },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    const { body } = await ask("halt");
    expect(JSON.stringify(body)).toMatch(/no registered identity public key/i);
    expect(daemon.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(0);
  });
});
