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
import { createSyncRelay, handleCommandResponse } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { generateKeypair, bytesToHex, signAgentCommandEnvelope } from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import { readComposedCommandResult } from "@motebit/runtime";
import { RelayClient, RelayClientError } from "@motebit/relay-client";
import { describeRemoteFailure } from "../subcommands/halt.js";
import {
  assertWireHealthy,
  attachRuntime,
  resetHarness,
  standUpMotebit,
} from "./multi-runtime-harness.js";

/** The relay's one deadline, shortened so a silent machine costs ms. */
const DEADLINE_MS = 200;

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
    // The deadline is the only bound — there is no grace window to
    // shorten — so the silent-machine paths would cost 30s each at the
    // production value. Same motivation as `drainGraceMs`.
    commandTimeoutMs: DEADLINE_MS,
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

  it("a halt is REFUSED on two machines rather than stopping one of them", async () => {
    // The halt store is local and nothing replicates it, so delivering
    // to one machine stops that one and answers with its
    // acknowledgement — a record saying the motebit stopped while the
    // other machine keeps working. Refusing is survivable; that is not.
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

    const { status, body } = await ask("halt");
    expect(status).toBe(404);
    const text = JSON.stringify(body);
    expect(text).toMatch(/2 different machines/i);
    // It says WHY, in terms of what would have gone wrong.
    expect(text).toMatch(/while the other kept working/i);
    // Neither machine was touched: a refusal that half-acted would be
    // worse than either choice.
    expect(laptop.received).toEqual([]);
    expect(vps.received).toEqual([]);
    expect(laptop.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(0);
    expect(vps.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(0);
  });

  it("a halt on ONE machine is delivered, unchanged — every deployment today", async () => {
    // The refusal is scoped to the configuration that does not exist
    // yet. A single-machine motebit must be exactly as it was.
    const daemon = attachRuntime(
      { relay, motebitId, identityPublicKey: pubHex },
      {
        label: "run",
        deviceId: "dev-1",
        capabilities: ["background", "unattended_runtime"],
      },
    );
    const { status } = await ask("halt");
    expect(status).toBe(200);
    expect(daemon.runtime.halts?.listActive(motebitId) ?? []).toHaveLength(1);
  });

  it("two processes on ONE machine are still interchangeable, not refused", async () => {
    // `motebit run` and `motebit serve` share a device id. Counting
    // them as two machines would refuse every remote halt in the
    // ordinary single-host setup.
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
    const { status } = await ask("halt");
    expect(status).toBe(200);
    expect(run.received.length + serve.received.length).toBe(1);
  });

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

/** One machine's line in a composed answer, as far as a test reads it. */
interface MachineLine {
  device_id: string;
  outcome: string;
  result?: { summary?: string; data?: Record<string, unknown> };
}

function machinesOf(body: Record<string, unknown>): MachineLine[] {
  const data = body.data as { machines?: MachineLine[] } | undefined;
  return data?.machines ?? [];
}

const UNATTENDED = ["background", "unattended_runtime"];

/** An answer's origin as the relay's socket handler states it. */
const at = (deviceId: string) => ({ motebitId, deviceId });

describe("halt-status across machines — the question it exists to answer", () => {
  it("asks EVERY machine, and each machine's own answer comes back under its own name", async () => {
    // The halt store is per machine. First-wins answered from whichever
    // machine the relay picked, so "Running — nothing is halted" could
    // be said about a motebit whose other machine was stopped — or the
    // reverse, which is worse.
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    const laptop = attachRuntime(deps, {
      label: "run",
      deviceId: "dev-1",
      capabilities: UNATTENDED,
    });
    const vps = attachRuntime(deps, { label: "run", deviceId: "dev-2", capabilities: UNATTENDED });
    await vps.runtime.requestHalt({ origin: "local", reason: "only the vps" });

    const { status, body } = await ask("halt-status");
    expect(status).toBe(200);
    expect(laptop.received).toHaveLength(1);
    expect(vps.received).toHaveLength(1);

    const machines = machinesOf(body);
    expect(machines.map((m) => m.device_id).sort()).toEqual(["dev-1", "dev-2"]);
    const byId = new Map(machines.map((m) => [m.device_id, m]));
    // Verbatim, per machine. The relay does not add them up.
    expect(byId.get("dev-1")?.outcome).toBe("answered");
    expect(byId.get("dev-1")?.result?.data?.halted).toBe(false);
    expect(byId.get("dev-2")?.outcome).toBe("answered");
    expect(byId.get("dev-2")?.result?.data?.halted).toBe(true);
    // ...and the relay publishes no verdict of its own about the interior.
    expect((body.data as Record<string, unknown>).halted).toBeUndefined();
    expect((body.data as Record<string, unknown>).partial).toBe(false);
    // A person reading only the prose can still tell which is which.
    expect(String(body.detail)).toMatch(/dev-1: Running/);
    expect(String(body.detail)).toMatch(/dev-2: Stop requested/);
  });

  it("delivers ONCE per machine — two processes on a host share a replay guard", async () => {
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    const run = attachRuntime(deps, { label: "run", deviceId: "dev-1", capabilities: UNATTENDED });
    const serve = attachRuntime(deps, {
      label: "serve",
      deviceId: "dev-1",
      capabilities: UNATTENDED,
    });
    const vps = attachRuntime(deps, { label: "run", deviceId: "dev-2", capabilities: UNATTENDED });

    const { status, body } = await ask("halt-status");
    expect(status).toBe(200);
    expect(run.received.length + serve.received.length).toBe(1);
    expect(vps.received).toHaveLength(1);
    // Per connection, the second process refuses its own motebit's
    // question as a replay and that refusal becomes a machine's answer.
    expect(JSON.stringify(body)).not.toMatch(/replay/i);
    expect(machinesOf(body)).toHaveLength(2);
  });

  it("walks past a dead socket to the live process on the SAME machine", async () => {
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    attachRuntime(deps, {
      label: "stale",
      deviceId: "dev-1",
      capabilities: UNATTENDED,
      socketIsDead: true,
    });
    const live = attachRuntime(deps, {
      label: "live",
      deviceId: "dev-1",
      capabilities: UNATTENDED,
    });
    attachRuntime(deps, { label: "run", deviceId: "dev-2", capabilities: UNATTENDED });

    const { status, body } = await ask("halt-status");
    expect(status).toBe(200);
    expect(live.received).toHaveLength(1);
    expect(machinesOf(body).every((m) => m.outcome === "answered")).toBe(true);
  });

  it("an UNREACHED machine is named, and the partial picture is not a 2xx", async () => {
    // Honest prose at HTTP 200 still lets
    // `motebit halt-status --remote && <next>` proceed on half a picture.
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    attachRuntime(deps, { label: "run", deviceId: "dev-1", capabilities: UNATTENDED });
    const gone = attachRuntime(deps, {
      label: "run",
      deviceId: "dev-2",
      capabilities: UNATTENDED,
      socketIsDead: true,
    });

    const { status, body } = await ask("halt-status");
    // 502, not 504: every client already reads 504 as "delivered, the
    // runtime did not answer", and that is false about dev-2.
    expect(status).toBe(502);
    expect(gone.received).toEqual([]);
    const byId = new Map(machinesOf(body).map((m) => [m.device_id, m]));
    expect(byId.get("dev-1")?.outcome).toBe("answered");
    expect(byId.get("dev-1")?.result?.data?.halted).toBe(false);
    expect(byId.get("dev-2")?.outcome).toBe("unreached");
    expect((body.data as Record<string, unknown>).partial).toBe(true);
    // Named, in the prose a person actually reads.
    expect(String(body.detail)).toMatch(/dev-2: not reached/);
  });

  it("a SILENT machine is named as silent — not as unreached, and not as running", async () => {
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    attachRuntime(deps, { label: "run", deviceId: "dev-1", capabilities: UNATTENDED });
    const wedged = attachRuntime(deps, {
      label: "run",
      deviceId: "dev-2",
      capabilities: UNATTENDED,
      neverReplies: true,
    });

    const { status, body } = await ask("halt-status");
    // 502 here too: the 504 sentence would drop the machine that DID
    // answer. 504 is kept for the one case its copy is true of, below.
    expect(status).toBe(502);
    expect(wedged.received).toHaveLength(1);
    const byId = new Map(machinesOf(body).map((m) => [m.device_id, m]));
    expect(byId.get("dev-1")?.outcome).toBe("answered");
    expect(byId.get("dev-2")?.outcome).toBe("silent");
    expect(String(body.detail)).toMatch(/dev-2: no answer in time/);
  });

  it("NOTHING heard is a timeout and stays one — with a body a client can parse", async () => {
    // Composing an empty answer list once resolved `undefined`: a 200
    // with an empty body, which turned the CLI's 504 branch into a JSON
    // parse error.
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    attachRuntime(deps, {
      label: "run",
      deviceId: "dev-1",
      capabilities: UNATTENDED,
      neverReplies: true,
    });
    attachRuntime(deps, {
      label: "run",
      deviceId: "dev-2",
      capabilities: UNATTENDED,
      neverReplies: true,
    });

    const { status, body } = await ask("halt-status");
    expect(status).toBe(504);
    expect(typeof body.summary).toBe("string");
    expect(machinesOf(body).map((m) => m.outcome)).toEqual(["silent", "silent"]);
  });

  it("NOTHING delivered is a 404, exactly as it is for one machine", async () => {
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    attachRuntime(deps, {
      label: "run",
      deviceId: "dev-1",
      capabilities: UNATTENDED,
      socketIsDead: true,
    });
    attachRuntime(deps, {
      label: "run",
      deviceId: "dev-2",
      capabilities: UNATTENDED,
      socketIsDead: true,
    });

    const { status, body } = await ask("halt-status");
    expect(status).toBe(404);
    expect(JSON.stringify(body)).toMatch(/nothing was delivered/i);
    expect(JSON.stringify(body)).toMatch(/dev-1/);
    expect(JSON.stringify(body)).toMatch(/dev-2/);
  });

  it("an answer belongs to the machine it CAME from, not to whichever line was waiting", async () => {
    // Arrival order is not attach order. Filling "the next waiting
    // line" would put the VPS's halt under the laptop's name — telling a
    // sovereign the wrong machine is stopped, which is worse than not
    // knowing.
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    const laptop = attachRuntime(deps, {
      label: "run",
      deviceId: "dev-1",
      capabilities: UNATTENDED,
      neverReplies: true,
    });
    const vps = attachRuntime(deps, { label: "run", deviceId: "dev-2", capabilities: UNATTENDED });
    await vps.runtime.requestHalt({ origin: "local" });

    const pending = ask("halt-status");
    // The machine attached SECOND answers FIRST...
    await expect.poll(() => vps.replied.length).toBe(1);
    // ...and only then the laptop, late.
    const frame = JSON.parse(laptop.received[0] ?? "{}") as { id: string };
    handleCommandResponse(
      frame.id,
      { summary: "the laptop, late", data: { halted: false, active: [] } },
      at("dev-1"),
    );

    const { body } = await pending;
    const byId = new Map(machinesOf(body).map((m) => [m.device_id, m]));
    expect(byId.get("dev-2")?.result?.data?.halted).toBe(true);
    expect(byId.get("dev-1")?.result?.summary).toBe("the laptop, late");
  });

  it("counts MACHINES, not answers — a repeat, or a stranger, settles nothing", async () => {
    // A runtime replying twice once satisfied a quorum and closed the
    // request before the other machine had been heard from.
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    const laptop = attachRuntime(deps, {
      label: "run",
      deviceId: "dev-1",
      capabilities: UNATTENDED,
    });
    const vps = attachRuntime(deps, {
      label: "run",
      deviceId: "dev-2",
      capabilities: UNATTENDED,
      neverReplies: true,
    });

    const pending = ask("halt-status");
    // Until the laptop has answered for real.
    await expect.poll(() => laptop.replied.length).toBe(1);
    const frame = JSON.parse(vps.received[0] ?? "{}") as { id: string };
    const forged = { summary: "forged", data: { halted: false, active: [] } };
    handleCommandResponse(frame.id, forged, at("dev-1")); // the same machine, again
    handleCommandResponse(frame.id, forged, at("dev-9")); // a machine never asked
    // Still open: only now does the second machine answer.
    handleCommandResponse(
      frame.id,
      { summary: "the vps, finally", data: { halted: true, active: [] } },
      at("dev-2"),
    );

    const { status, body } = await pending;
    expect(status).toBe(200);
    const byId = new Map(machinesOf(body).map((m) => [m.device_id, m]));
    expect(byId.size).toBe(2);
    // The first answer a machine gave is the one kept.
    expect(byId.get("dev-1")?.result?.summary).not.toBe("forged");
    expect(byId.get("dev-2")?.result?.summary).toBe("the vps, finally");
  });

  it("a machine that REFUSES has not reported — the picture is partial", async () => {
    // A replayed envelope is refused by every machine's own guard. Each
    // refusal is an answer on the wire and a record of nothing, so
    // counting it as answered would publish "2 of 2" over no halts read.
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    attachRuntime(deps, { label: "run", deviceId: "dev-1", capabilities: UNATTENDED });
    attachRuntime(deps, { label: "run", deviceId: "dev-2", capabilities: UNATTENDED });
    const envelope = await signAgentCommandEnvelope({
      command: "halt-status",
      motebitId,
      identityPrivateKey: keys.privateKey,
    });
    const send = async () => {
      const res = await relay.app.request(`/api/v1/agents/${motebitId}/command`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ command: "halt-status", envelope }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect((await send()).status).toBe(200);
    const again = await send();
    expect(again.status).toBe(502);
    expect(machinesOf(again.body).map((m) => m.outcome)).toEqual(["no_record", "no_record"]);
    // The machine's own reason is carried, not replaced.
    expect(String(again.body.detail)).toMatch(/replay/i);
  });

  it("a device id that was only DECLARED is not a machine's name — no composition", async () => {
    // `?device_id=` is a query string. Any surface holding a sync token
    // for this motebit can type the VPS's id; composing on that would
    // publish its answer as the VPS's own line in a picture called
    // whole. Unproven falls back to first-wins, like undeclared.
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    const laptop = attachRuntime(deps, {
      label: "run",
      deviceId: "dev-1",
      capabilities: UNATTENDED,
    });
    const impostor = attachRuntime(deps, {
      label: "web",
      deviceId: "dev-2",
      capabilities: UNATTENDED,
      deviceIdVerified: false,
    });

    const { status, body } = await ask("halt-status");
    expect(status).toBe(200);
    expect(laptop.received.length + impostor.received.length).toBe(1);
    expect((body.data as Record<string, unknown>).composed).toBeUndefined();
  });

  it("another motebit's socket cannot fill a line, even with the right device id", async () => {
    // Pending requests share one map across motebits. Without this the
    // only thing between them is that a command id is hard to guess.
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    attachRuntime(deps, { label: "run", deviceId: "dev-1", capabilities: UNATTENDED });
    const vps = attachRuntime(deps, {
      label: "run",
      deviceId: "dev-2",
      capabilities: UNATTENDED,
      neverReplies: true,
    });

    const pending = ask("halt-status");
    await expect.poll(() => vps.received.length).toBe(1);
    const frame = JSON.parse(vps.received[0] ?? "{}") as { id: string };
    handleCommandResponse(
      frame.id,
      { summary: "from someone else's motebit", data: { halted: false, active: [] } },
      { motebitId: "another-motebit", deviceId: "dev-2" },
    );

    const { status, body } = await pending;
    expect(status).toBe(502);
    const byId = new Map(machinesOf(body).map((m) => [m.device_id, m]));
    expect(byId.get("dev-2")?.outcome).toBe("silent");
  });

  it("ONE machine is answered exactly as before — the runtime's own reply, uncomposed", async () => {
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    attachRuntime(deps, { label: "run", deviceId: "dev-1", capabilities: UNATTENDED });
    attachRuntime(deps, { label: "serve", deviceId: "dev-1", capabilities: UNATTENDED });

    const { status, body } = await ask("halt-status");
    expect(status).toBe(200);
    expect(body.summary).toBe("Running — nothing is halted.");
    expect((body.data as Record<string, unknown>).composed).toBeUndefined();
  });

  it("what the relay composes is what the surfaces' shared reader reads", async () => {
    // The CLI and the phone both render a partial from its BODY, through
    // one reader. If the relay's shape and the reader's drift apart,
    // both fall back to status-keyed copy that asserts "delivered" about
    // a machine that was never reached.
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    attachRuntime(deps, { label: "run", deviceId: "dev-1", capabilities: UNATTENDED });
    attachRuntime(deps, {
      label: "run",
      deviceId: "dev-2",
      capabilities: UNATTENDED,
      socketIsDead: true,
    });

    const { status, body } = await ask("halt-status");
    expect(status).toBe(502);
    const read = readComposedCommandResult(JSON.stringify(body));
    expect(read).not.toBeNull();
    expect(read?.partial).toBe(true);
    expect(read?.detail).toMatch(/dev-2: not reached/);
    // And a plain timeout body is NOT mistaken for one.
    expect(readComposedCommandResult('{"summary":"Agent did not respond in time."}')).toBeNull();
  });

  it("the terminal prints a partial as the REPORT it is — through the real client, end to end", async () => {
    // Every part real but the socket: `RelayClient` mints the envelope
    // and makes the request, the relay composes, and the CLI's own
    // wording function reads what came back. The 504 copy it replaces
    // says "Delivered, no answer yet" — about a machine never reached.
    const deps = { relay, motebitId, identityPublicKey: pubHex };
    attachRuntime(deps, { label: "run", deviceId: "dev-1", capabilities: UNATTENDED });
    attachRuntime(deps, {
      label: "run",
      deviceId: "dev-2",
      capabilities: UNATTENDED,
      socketIsDead: true,
    });
    const client = new RelayClient({
      baseUrl: "http://relay.test",
      auth: { staticToken: "test-token" },
      fetchImpl: ((url: string, init?: RequestInit) =>
        relay.app.request(new URL(url).pathname, init)) as unknown as typeof fetch,
    });

    const err = await client
      .sendAgentCommand({
        motebitId,
        command: "halt-status",
        identityPrivateKey: keys.privateKey,
      })
      .catch((e: unknown) => e);
    // A partial never resolves: `halt-status --remote && <next>` stops.
    expect(err).toBeInstanceOf(RelayClientError);

    const said = describeRemoteFailure(err as RelayClientError);
    expect(said.failure).toEqual([]);
    const text = said.report.join("\n");
    expect(text).toMatch(/NOT the whole picture/);
    expect(text).toMatch(/dev-1: Running/);
    expect(text).toMatch(/dev-2: not reached/);
    expect(text).not.toMatch(/Delivered/);
  });

  it("a plain timeout still reads as delivered-and-unanswered", async () => {
    // The composed branch must not swallow the sentence it sits above.
    const said = describeRemoteFailure(
      new RelayClientError("http", "/command", "POST /command → 504", {
        status: 504,
        body: '{"summary":"Agent did not respond in time."}',
      }),
    );
    expect(said.report).toEqual([]);
    expect(said.failure.join("\n")).toMatch(/Delivered, no answer yet/);
  });
});
