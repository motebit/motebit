/**
 * `halt-status` asked of EVERY machine, and the answers composed
 * (issue #687).
 *
 * What the RUNTIMES do with these frames is proven against two real
 * ones in `apps/cli/src/__tests__/multi-runtime-relay.test.ts`. This
 * file holds the relay to its own half with peers that answer by hand,
 * so each transport fact — reached, silent, repeated, a stranger — can
 * be produced exactly, including the ones a healthy runtime never
 * produces on its own.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { handleCommandResponse } from "../index.js";
import { generateKeypair, bytesToHex, signAgentCommandEnvelope } from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";
import { readComposedCommandResult } from "@motebit/runtime";
import { JSON_AUTH, createTestRelay } from "./test-helpers.js";

const AGENT_ID = "36080ffe-cmd4-8000-a000-0000000000cc";
const UNATTENDED = ["background", "unattended_runtime"];
const DEADLINE_MS = 150;

let relay: SyncRelay;
let keys: KeyPair;

/** What a machine says when asked, or `null` to stay silent. */
type Answer = { summary: string; detail?: string; data?: Record<string, unknown> } | null;

function machine(
  deviceId: string,
  answer: Answer,
  opts: {
    open?: boolean;
    declared?: boolean;
    verified?: boolean;
    from?: string;
    fromMotebit?: string;
  } = {},
) {
  const frames: Array<{ id: string; command: string }> = [];
  const peer = {
    ws: {
      // `ws@8` swallows a send on a closed socket rather than throwing,
      // so the relay has to ASK. A double with no `readyState` would
      // agree with a relay that did not.
      readyState: opts.open === false ? 3 : 1,
      send: (payload: string) => {
        if (opts.open === false) return;
        const frame = JSON.parse(payload) as { id: string; command: string };
        frames.push(frame);
        if (answer == null) return;
        // Asynchronously, as a socket does.
        queueMicrotask(() =>
          handleCommandResponse(frame.id, answer, {
            motebitId: opts.fromMotebit ?? AGENT_ID,
            deviceId: opts.from ?? deviceId,
          }),
        );
      },
    },
    deviceId,
    deviceIdDeclared: opts.declared ?? true,
    // What a real daemon is: token `did` and declared id from one config value.
    deviceIdVerified: opts.verified ?? opts.declared ?? true,
    capabilities: UNATTENDED,
  };
  return { peer, frames };
}

function connect(...machines: Array<ReturnType<typeof machine>>): void {
  relay.connections.set(
    AGENT_ID,
    machines.map((m) => m.peer) as unknown as Parameters<typeof relay.connections.set>[1],
  );
}

async function haltStatus(): Promise<{ status: number; json: Record<string, unknown> }> {
  const envelope = await signAgentCommandEnvelope({
    command: "halt-status",
    motebitId: AGENT_ID,
    identityPrivateKey: keys.privateKey,
  });
  const res = await relay.app.request(`/api/v1/agents/${AGENT_ID}/command`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ command: "halt-status", envelope }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const running: Answer = { summary: "Running — nothing is halted.", data: { halted: false } };
const stopped: Answer = {
  summary: "Stop requested for unattended execution.",
  detail: "abcd1234  all unattended execution  1 process(es) acknowledged  (remote)",
  data: { halted: true },
};

function outcomes(json: Record<string, unknown>): Record<string, string> {
  const machines = (json.data as { machines: Array<{ device_id: string; outcome: string }> })
    .machines;
  return Object.fromEntries(machines.map((m) => [m.device_id, m.outcome]));
}

beforeEach(async () => {
  relay = await createTestRelay({ commandTimeoutMs: DEADLINE_MS });
  keys = await generateKeypair();
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      motebit_id: AGENT_ID,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: bytesToHex(keys.publicKey),
    }),
  });
});

afterEach(() => {
  void relay.close();
});

describe("halt-status is asked of every machine and composed", () => {
  it("carries each machine's own answer verbatim, and adds up nothing", async () => {
    const laptop = machine("dev-1", running);
    const vps = machine("dev-2", stopped);
    connect(laptop, vps);

    const { status, json } = await haltStatus();
    expect(status).toBe(200);
    expect(laptop.frames).toHaveLength(1);
    expect(vps.frames).toHaveLength(1);
    expect(outcomes(json)).toEqual({ "dev-1": "answered", "dev-2": "answered" });
    const data = json.data as Record<string, unknown>;
    expect(data.partial).toBe(false);
    // No verdict about the interior: the relay does not know what a
    // goal is, so it does not say whether "the motebit" is halted.
    expect(data.halted).toBeUndefined();
    expect(data.acknowledged).toBeUndefined();
    const lines = data.machines as Array<{ device_id: string; result: unknown }>;
    expect(lines.find((m) => m.device_id === "dev-2")?.result).toEqual(stopped);
    // A machine's detail travels under its own name.
    expect(String(json.detail)).toMatch(/dev-2:\nabcd1234/);
  });

  it("delivers once per MACHINE — a second process on the host is not asked", async () => {
    const run = machine("dev-1", running);
    const serve = machine("dev-1", running);
    const vps = machine("dev-2", running);
    connect(run, serve, vps);

    const { status, json } = await haltStatus();
    expect(status).toBe(200);
    expect(run.frames.length + serve.frames.length).toBe(1);
    expect(Object.keys(outcomes(json))).toHaveLength(2);
  });

  it("an UNDECLARED peer means machines cannot be told apart — first-wins, uncomposed", async () => {
    // The relay invents an id per undeclared connection. Grouping by it
    // would read one host's two processes as two machines, send the
    // single-use envelope to both, and publish the second's replay
    // refusal as a machine that did not report.
    const a = machine("conn-a", running, { declared: false });
    const b = machine("conn-b", running, { declared: false });
    connect(a, b);

    const { status, json } = await haltStatus();
    expect(status).toBe(200);
    expect(a.frames.length + b.frames.length).toBe(1);
    expect(json).toEqual(running);
  });

  it("an id that was declared but never PROVEN is not composed on", async () => {
    // A query string is not a machine. Composing on it would let any
    // holder of a sync token answer in the VPS's name, in a whole picture.
    const laptop = machine("dev-1", running);
    const impostor = machine("dev-2", running, { verified: false });
    connect(laptop, impostor);
    const { status, json } = await haltStatus();
    expect(status).toBe(200);
    expect(laptop.frames.length + impostor.frames.length).toBe(1);
    expect(json).toEqual(running);
  });

  it("an answer arriving on ANOTHER motebit's socket fills nothing", async () => {
    connect(machine("dev-1", running), machine("dev-2", running, { fromMotebit: "someone-else" }));
    const { status, json } = await haltStatus();
    expect(status).toBe(502);
    expect(outcomes(json)).toEqual({ "dev-1": "answered", "dev-2": "silent" });
  });

  it("names an unreached machine and refuses the partial a 2xx", async () => {
    connect(machine("dev-1", running), machine("dev-2", running, { open: false }));
    const { status, json } = await haltStatus();
    expect(status).toBe(502);
    expect(outcomes(json)).toEqual({ "dev-1": "answered", "dev-2": "unreached" });
    expect((json.data as Record<string, unknown>).partial).toBe(true);
    expect(String(json.summary)).toMatch(/NOT the whole picture/);
  });

  it("names a silent machine at the deadline, keeping the answer it did get", async () => {
    connect(machine("dev-1", stopped), machine("dev-2", null));
    const { status, json } = await haltStatus();
    expect(status).toBe(502);
    expect(outcomes(json)).toEqual({ "dev-1": "answered", "dev-2": "silent" });
    expect(String(json.detail)).toMatch(/silence is neither a stop nor a run/);
  });

  it("everything delivered and NOTHING heard is the one 504 — its existing copy is true of it", async () => {
    connect(machine("dev-1", null), machine("dev-2", null));
    const { status, json } = await haltStatus();
    expect(status).toBe(504);
    expect(typeof json.summary).toBe("string");
    expect(outcomes(json)).toEqual({ "dev-1": "silent", "dev-2": "silent" });
  });

  it("nothing delivered is a 404 that names the machines", async () => {
    connect(machine("dev-1", running, { open: false }), machine("dev-2", running, { open: false }));
    const { status, json } = await haltStatus();
    expect(status).toBe(404);
    expect(JSON.stringify(json)).toMatch(/dev-1, dev-2/);
    expect(JSON.stringify(json)).toMatch(
      /nothing was delivered, so this is not a report that nothing happened/,
    );
  });

  it("an answer from a machine that was never asked settles nothing", async () => {
    // dev-2's socket answers, but in the name of a stranger.
    connect(machine("dev-1", running), machine("dev-2", running, { from: "dev-9" }));
    const { status, json } = await haltStatus();
    expect(status).toBe(502);
    expect(outcomes(json)).toEqual({ "dev-1": "answered", "dev-2": "silent" });
  });

  it("a machine's FIRST answer is the one kept", async () => {
    const laptop = machine("dev-1", running);
    const vps = machine("dev-2", null);
    connect(laptop, vps);
    const pending = haltStatus();
    await expect.poll(() => vps.frames.length).toBe(1);
    const id = vps.frames[0]!.id;
    await Promise.resolve();
    handleCommandResponse(
      id,
      { summary: "overwritten", data: {} },
      { motebitId: AGENT_ID, deviceId: "dev-1" },
    );
    handleCommandResponse(id, stopped, { motebitId: AGENT_ID, deviceId: "dev-2" });
    const { status, json } = await pending;
    expect(status).toBe(200);
    const lines = (json.data as { machines: Array<{ device_id: string; result: unknown }> })
      .machines;
    expect(lines.find((m) => m.device_id === "dev-1")?.result).toEqual(running);
  });

  it("a reply with no record is not a report — refusals and storeless surfaces", async () => {
    connect(
      machine("dev-1", running),
      machine("dev-2", { summary: "command_request rejected: replay" }),
    );
    const { status, json } = await haltStatus();
    expect(status).toBe(502);
    expect(outcomes(json)).toEqual({ "dev-1": "answered", "dev-2": "no_record" });
    expect(String(json.detail)).toMatch(/dev-2: did not report — command_request rejected: replay/);
  });

  it("a reply that is not even an object is named as unreadable, not dropped", async () => {
    connect(machine("dev-1", running), machine("dev-2", "???" as unknown as Answer));
    const { status, json } = await haltStatus();
    expect(status).toBe(502);
    expect(String(json.detail)).toMatch(/dev-2: did not report — answered in a shape/);
  });

  it("ONE machine gets the runtime's own reply, exactly as before", async () => {
    connect(machine("dev-1", stopped), machine("dev-1", stopped));
    const { status, json } = await haltStatus();
    expect(status).toBe(200);
    expect(json).toEqual(stopped);
  });

  it("the body is the shape the surfaces' shared reader accepts", async () => {
    connect(machine("dev-1", running), machine("dev-2", null));
    const { json } = await haltStatus();
    const read = readComposedCommandResult(JSON.stringify(json));
    expect(read?.partial).toBe(true);
    expect(read?.machines.map((m) => m.outcome)).toEqual(["answered", "silent"]);
  });
});
