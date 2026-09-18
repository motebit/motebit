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
    // The deadline is the only bound now — there is no grace window to
    // shorten — so the silent-machine paths would cost 30s each at the
    // production value. Same motivation as `drainGraceMs`.
    commandTimeoutMs: 3_000,
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
    // Sequenced, not raced: "the SECOND one refuses" is a statement
    // about order, and envelope verification is async.
    await run.deliver(frame);
    await serve.deliver(frame);

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
    await laptop.deliver(frame);
    await vps.deliver(frame);

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

  it("a machine still STOPPING is not reported as silent", async () => {
    // The relay waits for the machine that is still WORKING.
    //
    // `cmdHalt` awaits every registered stopper, while a machine with
    // nothing to stop returns immediately — so the first answer is
    // systematically from the machine with least to do. Settling on it
    // reports the machine actually aborting work as silent, mid-stop:
    // the fast-answerer bias this change removes, inverted into a false
    // negative on the verb where it costs most. Any re-introduced grace
    // shorter than this stopper fails here.
    attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "idle",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "busy",
        deviceId: "dev-2",
        capabilities: ["background", "unattended_runtime"],
        configure: (rt) =>
          rt.onHalt(async () => {
            // Comfortably under the deadline, comfortably over anything
            // a re-introduced grace window would plausibly be.
            await new Promise((r) => setTimeout(r, 900));
            return "aborted the long job";
          }),
      },
    );

    const { body } = await ask("halt");
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/silence is not a stop/i);
    expect(text).toMatch(/aborted the long job/i);
  }, 20_000);

  it("ONE machine that never answers is a timeout, not an empty 200", async () => {
    // The common deployment — a single unattended runtime. Composing
    // every expired broadcast resolved this with `answers[0]` of an
    // empty array: `undefined`, serialized as HTTP 200 with an empty
    // body. The CLI's 504 branch ("Delivered, no answer yet — it may
    // well have stopped") became a JSON parse error, and the phone said
    // "The runtime did not recognise \"halt\" — update it": a confident
    // wrong diagnosis on the verb this arc exists to protect.
    attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
        neverReplies: true,
      },
    );
    const envelope = await signAgentCommandEnvelope({
      command: "halt",
      motebitId,
      identityPrivateKey: keys.privateKey,
    });
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/command`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ command: "halt", envelope }),
    });
    // Not 200, and not an empty body.
    expect(res.status).toBeGreaterThanOrEqual(500);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  }, 20_000);

  it("a broadcast nobody answers is a timeout too — prose at 200 tells a script it worked", async () => {
    // An honest per-machine report at HTTP 200 still leaves
    // `motebit halt --remote && …` exiting 0 when nothing was heard.
    attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
        neverReplies: true,
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
    const envelope = await signAgentCommandEnvelope({
      command: "halt",
      motebitId,
      identityPrivateKey: keys.privateKey,
    });
    const res = await relay.app.request(`/api/v1/agents/${motebitId}/command`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ command: "halt", envelope }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
  }, 20_000);

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

    const { status, body } = await ask("halt");
    // A PARTIAL is not a success. Honest prose at HTTP 200 still leaves
    // `motebit halt --remote && <next step>` proceeding while a machine
    // is possibly still running, and puts the burden on every consumer
    // to remember to compare `answered` against `sent_to`.
    expect(status).toBe(504);
    const text = JSON.stringify(body);
    expect(text).toMatch(/no answer in time/i);
    expect(text).toMatch(/silence is not a stop/i);
    // And the machine that did answer is still reported.
    expect(text).toMatch(/stop requested/i);
    expect(laptop.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(1);
    // And it NAMES the machine, because "1 runtime did not answer"
    // leaves a reader knowing something is still running and not where.
    expect(text).toContain("dev-2");
    // There is no grace window any more: the relay waits for every
    // machine it reached, and composes at the request's own deadline.
    // This test therefore spends that deadline — the cost of never
    // calling a machine silent while it is still stopping.
  }, 20_000);

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
    expect(text).toMatch(/Sent to 2 machines/i);
    expect(text).toMatch(/nothing is halted/i);
    // The relay does NOT re-derive a verdict: `resume` reports `lifted`,
    // never `acknowledged`, so AND-ing that field across machines made
    // every successful multi-machine resume look failed.
    expect((body as { data?: { acknowledged?: unknown } }).data?.acknowledged).toBeUndefined();
  }, 20_000);

  it("an unreachable machine is reported, not vanished — and does not let one answer stand in", async () => {
    // Counting only successful sends made an unreachable machine
    // disappear from `targets`, so the composed path was skipped and
    // the caller got the live machine's raw `acknowledged: true` with
    // no sign a second machine existed. That is one machine's
    // acknowledgement standing in for the motebit's — this change's
    // whole subject, coming back through the accounting.
    const live = attachRuntime(
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
        socketIsDead: true,
      },
    );

    const { status, body } = await ask("halt");
    const text = JSON.stringify(body);
    // The summary counts machines REACHED, so it cannot contradict the
    // "not reached" line two rows below it.
    // Unreached is partial too, and carries the same non-2xx.
    expect(status).toBe(504);
    expect(text).toMatch(/Reached 1 of 2 machines/i);
    expect(text).toMatch(/not reached/i);
    expect(text).toContain("dev-2");
    const data = (body as { data?: { sent_to?: number; reached?: number } }).data;
    expect(data?.sent_to).toBe(2);
    expect(data?.reached).toBe(1);
    expect(live.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(1);
  }, 25_000);

  it("two undeclared connections are folded into one delivery, and the fold is reported", async () => {
    // They are bucketed together because they might equally be one
    // host's two processes sharing a replay store, and delivering twice
    // into that store is the worse error. But they might be two hosts —
    // so the fold is reported and `acknowledged` is not claimed.
    const a = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "generated-1",
        capabilities: ["background", "unattended_runtime"],
        deviceIdDeclared: false,
      },
    );
    const b = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "generated-2",
        capabilities: ["background", "unattended_runtime"],
        deviceIdDeclared: false,
      },
    );

    const { body } = await ask("halt");
    expect(a.received.length + b.received.length).toBe(1);
    const text = JSON.stringify(body);
    expect(text).toMatch(/folded into the one above/i);
    // No synthesized verdict — the per-machine answers carry the
    // runtime's own `data`, and absent is the fail-closed reading.
    expect((body as { data?: { acknowledged?: unknown } }).data?.acknowledged).toBeUndefined();
    const answers = (body as { data?: { answers?: unknown[] } }).data?.answers ?? [];
    expect(answers.length).toBeGreaterThan(0);
  }, 20_000);

  it("says the halt ids are machine-local, because each machine wrote its own", async () => {
    // Broadcasting a halt makes each machine write its own row with its
    // own id, so the composed detail carries two `resume <id>` lines
    // that each reach only one machine. Saying so beats letting a
    // reader discover it by half-resuming their motebit.
    attachRuntime(
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
      },
    );

    const { body } = await ask("halt");
    const text = JSON.stringify(body);
    expect(text).toMatch(/machine-local/i);
    expect(text).toMatch(/resume all/i);
  }, 25_000);

  it("a goal-scoped halt is honoured by the machine that OWNS the goal, and the others say so", async () => {
    // Goals live on exactly one machine. AND-ing a verdict across
    // machines therefore reported a goal that WAS stopped as not
    // acknowledged, because the machine without the goal truthfully
    // answered that it had nothing to halt. The relay has no idea which
    // machine owns a goal — which is the reason it must not adjudicate.
    const owner = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
        goals: ["goal-abc"],
        configure: (rt) => rt.setGoalIdResolver?.(() => "goal-abc"),
      },
    );
    const stranger = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-2",
        capabilities: ["background", "unattended_runtime"],
      },
    );

    // The structured form — a `goal <id>` grammar was removed because
    // `--reason "goal cleanup done"` parsed as a halt of a goal called
    // "cleanup", which halts nothing.
    const { body } = await ask("halt", JSON.stringify({ goal_id: "goal-abc" }));
    const text = JSON.stringify(body);
    expect(text).toContain("dev-1");
    expect(text).toContain("dev-2");

    // The OWNER carries a goal-scoped halt row — the half the test is
    // named for. Asserting only that both ids appear, and that
    // `acknowledged` is undefined, was satisfied by any composed reply
    // at all: it would have passed with goal scoping removed entirely.
    const ownerHalts = owner.runtime.halts?.listActive(motebitId) ?? [];
    expect(ownerHalts).toHaveLength(1);
    expect(ownerHalts[0]?.goal_id).toBe("goal-abc");

    // And the machine that does not own it says so rather than
    // recording a halt for a goal it has never heard of.
    const strangerHalts = stranger.runtime.halts?.listActive(motebitId) ?? [];
    expect(strangerHalts).toHaveLength(0);
  }, 20_000);

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
