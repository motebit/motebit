/**
 * Two real runtimes, one real relay, one wire between them.
 *
 * Every relay test until now used a peer whose `send` recorded a
 * payload. That proves the relay chose a peer; it proves nothing about
 * what the peer DOES with the frame — and that is where this arc's
 * defects have lived. A halt rejected as a replay by a machine's second
 * process, a resume answered by the machine with nothing to do, a
 * report that named the wrong machine: none of them can be expressed as
 * an assertion about a recorded payload, so all of them had to be found
 * by a person reading, and every fix was written blind.
 *
 * So the fake socket here is not a stub, it is a WIRE. One end is the
 * relay's real routing; the other is `handleRelayCommandFrame`, the
 * same function both of the CLI's long-lived executors answer frames
 * with — real envelope verification, real replay guard, real command
 * layer, real stores.
 *
 * What it deliberately does not do is stand up a socket upgrade. The
 * relay's own tests cover that the WebSocket handler forwards to
 * `handleCommandResponse`; re-proving it here would buy nothing and
 * make the harness slow enough that nobody runs it.
 */
import { handleCommandResponse } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import type { HaltRequest, HaltAcknowledgement, HaltStoreAdapter } from "@motebit/sdk";
import { handleRelayCommandFrame } from "../relay-command-frame.js";

/**
 * A halt store per PROCESS, in memory.
 *
 * The adapter pattern the repo is built on — in-memory for tests,
 * SQLite in production — so this is the sanctioned double and not a
 * stub of the behaviour under test. What matters is that it is NOT
 * shared between processes: a halt is written where it lands and
 * nothing replicates it, which is the fact the whole multi-machine
 * question turns on.
 */
export function createInMemoryHaltStore(): HaltStoreAdapter {
  const halts: HaltRequest[] = [];
  const acks = new Map<string, HaltAcknowledgement[]>();
  return {
    request: (h) => void halts.push(h),
    acknowledge: (haltId, executorId, acknowledgement, at) => {
      const list = acks.get(haltId) ?? [];
      if (list.some((a) => a.executor_id === executorId)) return;
      list.push({
        halt_id: haltId,
        executor_id: executorId,
        acknowledgement,
        acknowledged_at: at ?? Date.now(),
      });
      acks.set(haltId, list);
    },
    hasAcknowledged: (haltId, executorId) =>
      (acks.get(haltId) ?? []).some((a) => a.executor_id === executorId),
    acknowledgements: (haltId) => [...(acks.get(haltId) ?? [])],
    lift: (haltId, at) => {
      const h = halts.find((x) => x.halt_id === haltId && x.lifted_at == null);
      if (h == null) return false;
      (h as { lifted_at?: number }).lifted_at = at ?? Date.now();
      return true;
    },
    activeFor: (motebitId, goalId) =>
      halts.find(
        (h) =>
          h.motebit_id === motebitId &&
          h.lifted_at == null &&
          (h.goal_id == null || h.goal_id === goalId),
      ) ?? null,
    listActive: (motebitId) =>
      halts.filter((h) => h.motebit_id === motebitId && h.lifted_at == null),
    get: (haltId) => halts.find((h) => h.halt_id === haltId) ?? null,
    listRecent: (motebitId, limit) =>
      halts.filter((h) => h.motebit_id === motebitId).slice(-(limit ?? 10)),
  };
}

/**
 * Register the motebit as an AGENT, which is what the command route
 * verifies an envelope against.
 *
 * Not `/identity` + `/device/register`: those give the relay a device
 * key, and a remote command is authorized by the agent's own identity
 * key. Getting this wrong answers `Unknown agent identity` at ingress,
 * which is the relay being right.
 */
export async function standUpMotebit(
  relay: SyncRelay,
  publicKeyHex: string,
): Promise<{ motebitId: string }> {
  const motebitId = crypto.randomUUID();
  const res = await relay.app.request("/api/v1/agents/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
    }),
  });
  if (!res.ok) {
    throw new Error(`harness: agent registration failed ${res.status}: ${await res.text()}`);
  }
  return { motebitId };
}

/** One long-lived executor: a process, on a machine, holding stores. */
export interface HarnessRuntime {
  /** The machine it runs on. Two processes may share one. */
  readonly deviceId: string;
  /** A name for assertions to read, not anything the protocol knows. */
  readonly label: string;
  readonly runtime: MotebitRuntime;
  /** Frames this process actually received — the delivery record. */
  readonly received: string[];
  /** Replies it sent back. */
  readonly replied: unknown[];
}

export interface HarnessDeps {
  relay: SyncRelay;
  motebitId: string;
  identityPublicKey: string;
}

/**
 * A replay store per MACHINE, not per process.
 *
 * `motebit run` and `motebit serve` on one host share `~/.motebit` and
 * therefore one guard, which is exactly why a single signed envelope
 * must reach a machine once: the second process rejects its own
 * motebit's halt as a replay. A harness that gave each process its own
 * guard could not express that, and would have agreed with the bug.
 */
const machineReplayStores = new Map<string, Set<string>>();

export function resetHarness(): void {
  machineReplayStores.clear();
}

function replayFor(deviceId: string) {
  return (signature: string): { accepted: boolean; message?: string } => {
    let seen = machineReplayStores.get(deviceId);
    if (seen == null) {
      seen = new Set();
      machineReplayStores.set(deviceId, seen);
    }
    if (seen.has(signature)) {
      return { accepted: false, message: "this envelope has already been accepted (replay)" };
    }
    seen.add(signature);
    return { accepted: true };
  };
}

/**
 * Attach a real runtime to the relay as a connected peer.
 *
 * `capabilities` and `deviceIdDeclared` are the two facts the relay
 * routes on, so they are the harness's dials: the same motebit with a
 * daemon and a task worker, on one machine or two, declared or not.
 */
export function attachRuntime(
  deps: HarnessDeps,
  opts: {
    label: string;
    deviceId: string;
    capabilities: string[];
    deviceIdDeclared?: boolean;
    /** Wire the runtime's stores before it answers anything. */
    configure?: (runtime: MotebitRuntime) => void;
    /** Refuse to send, as a dead-but-unreaped socket does. */
    socketIsDead?: boolean;
  },
): HarnessRuntime {
  const storage = createInMemoryStorage();
  // Per process, never shared — see `createInMemoryHaltStore`.
  storage.haltStore = createInMemoryHaltStore();
  const runtime = new MotebitRuntime(
    { motebitId: deps.motebitId, tickRateHz: 0 },
    { storage, renderer: new NullRenderer() },
  );
  // A halt acknowledgement names the EXECUTOR, not the device: two
  // processes on one machine stop different work and answer separately.
  runtime.setHaltExecutorId(`${opts.label}@${opts.deviceId}`);
  opts.configure?.(runtime);

  const received: string[] = [];
  const replied: unknown[] = [];

  const peer = {
    ws: {
      send: (payload: string) => {
        if (opts.socketIsDead === true) throw new Error("socket is gone");
        received.push(payload);
        const frame = JSON.parse(payload) as {
          type: string;
          id: string;
          command: string;
          args?: string;
          envelope?: unknown;
        };
        if (frame.type !== "command_request") return;
        // The real handler, on the real runtime, with this MACHINE's
        // replay guard.
        void handleRelayCommandFrame(frame, {
          runtime,
          motebitId: deps.motebitId,
          identityPublicKey: deps.identityPublicKey,
          checkReplay: replayFor(opts.deviceId),
          reply: (raw) => {
            const msg = JSON.parse(raw) as { id: string; result: unknown };
            replied.push(msg.result);
            // Back up the wire. Delivery is first-wins today, so one
            // answer settles the request and the relay does not need to
            // know which machine sent it. When issue #681 lands the
            // broadcast, an answer carries the device that sent it and
            // this call gains that argument — which is the point at
            // which this harness starts being able to assert who
            // answered and who stayed silent.
            handleCommandResponse(msg.id, msg.result);
          },
        });
      },
    },
    deviceId: opts.deviceId,
    deviceIdDeclared: opts.deviceIdDeclared ?? true,
    capabilities: opts.capabilities,
  };

  const existing = deps.relay.connections.get(deps.motebitId) ?? [];
  deps.relay.connections.set(deps.motebitId, [...existing, peer] as unknown as Parameters<
    typeof deps.relay.connections.set
  >[1]);

  return { deviceId: opts.deviceId, label: opts.label, runtime, received, replied };
}
