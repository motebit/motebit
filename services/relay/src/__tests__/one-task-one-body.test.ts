/**
 * One task ⇒ one body (`docs/doctrine/task-admission.md`: one admission ⇒
 * one presenter ⇒ one completed execution).
 *
 * An identity can serve from several bodies at once — the CLI daemon, the
 * desktop app, a browser tab, a phone — each a WebSocket device of the same
 * motebit. The relay hands a plain `task_request` to EVERY serving socket of
 * the identity, and its claim is atomic (`websocket.ts`, `task_claim`): one
 * body is granted, the rest are answered `task_claim_rejected`. The body is
 * the second half of that contract — it must WAIT for the grant before it
 * executes, and drop the task on a rejection. A granted claim means the
 * task may have started, so it is never handed to a second body: a claimer
 * that dies or stops renewing leaves the task UNDETERMINED (surfaced on the
 * delegator's poll), resolved only by the claimer's own late result.
 *
 * Each `Body` below is one real WebSocket device of the identity, under its
 * own verified device id, posting its result with its own `task:result`
 * token — the shape every surface has.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import WebSocket from "ws";
import {
  generateKeypair,
  bytesToHex,
  signExecutionReceipt,
  mintAudienceToken,
  hash as sha256,
  // eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
} from "@motebit/encryption";
import { TaskClaimCoordinator } from "@motebit/runtime";
import type { SyncRelay } from "../index.js";
import {
  API_TOKEN,
  JSON_AUTH,
  createAgent,
  createTestRelay,
  jsonAuthWithIdempotency,
} from "./test-helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000): Promise<boolean> {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) return false;
    await sleep(10);
  }
  return true;
}

/** A short claim lease, so the lease cells run in well under a second. */
const LEASE_MS = 400;

async function startRelay(): Promise<{ relay: SyncRelay; port: number }> {
  const relay = await createTestRelay({ taskClaimLeaseMs: LEASE_MS });
  const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  (relay.app as Hono & { injectWebSocket: (s: unknown) => void }).injectWebSocket(server);
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  cleanups.push(async () => {
    await relay.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { relay, port: (server.address() as AddressInfo).port };
}

type Kp = Awaited<ReturnType<typeof generateKeypair>>;

interface Identity {
  relay: SyncRelay;
  port: number;
  motebitId: string;
  kp: Kp;
  /** Device ids registered under the identity, one per body. */
  devices: string[];
}

async function identityWithDevices(n: number): Promise<Identity> {
  const { relay, port } = await startRelay();
  const kp = await generateKeypair();
  const pub = bytesToHex(kp.publicKey);
  const { motebitId, deviceId } = await createAgent(relay, pub);
  const devices = [deviceId];
  for (let i = 1; i < n; i++) {
    const res = await relay.app.request("/device/register", {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ motebit_id: motebitId, device_name: `Body ${i}`, public_key: pub }),
    });
    devices.push(((await res.json()) as { device_id: string }).device_id);
  }
  return { relay, port, motebitId, kp, devices };
}

interface BodyOpts {
  /** How long the task takes to run before the body posts its result. */
  runMs?: number;
  /** Never post a result (the body dies or hangs mid-task). */
  neverAnswer?: boolean;
}

/**
 * One serving body: a WebSocket device of the identity that answers
 * `task_request` frames the way the surfaces do.
 */
class Body {
  executions = 0;
  requests = 0;
  /** Status of every result POST this body made. */
  resultStatuses: number[] = [];
  /** When true, frames this body sends are dropped (a one-way partition). */
  muted = false;
  ws!: WebSocket;
  private release: (() => void) | null = null;
  private held: Promise<void> = Promise.resolve();

  constructor(
    private readonly id: Identity,
    readonly deviceId: string,
    readonly opts: BodyOpts = {},
  ) {}

  async open(): Promise<void> {
    const { relay, port, motebitId, kp } = this.id;
    const before = relay.connections.get(motebitId)?.length ?? 0;
    const token = (
      await mintAudienceToken({ mid: motebitId, did: this.deviceId, aud: "sync" }, kp.privateKey)
    ).token;
    this.ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/sync/${motebitId}?token=${token}&device_id=${this.deviceId}`,
    );
    this.ws.on("error", () => {});
    this.ws.on("message", (raw: Buffer) => {
      let f: Record<string, unknown>;
      try {
        f = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      this.onFrame(f);
    });
    const ws = this.ws;
    cleanups.push(async () => {
      this.claims.dispose();
      ws.terminate();
    });
    await waitFor(() => (relay.connections.get(motebitId)?.length ?? 0) > before);
  }

  /** Hold the body's next result until `finish()` (a long or hung task). */
  hold(): void {
    this.held = new Promise<void>((r) => (this.release = r));
  }
  finish(): void {
    this.release?.();
  }

  send(frame: string): void {
    if (this.muted || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(frame);
  }

  /**
   * What every surface does on a relay frame: route it through the shared
   * claim protocol (`TaskClaimCoordinator`, `@motebit/runtime`) — claim,
   * run only on the grant, drop on a rejection, renew while running.
   */
  private readonly claims = new TaskClaimCoordinator({ send: (f) => this.send(f) });

  private onFrame(f: Record<string, unknown>): void {
    if (this.claims.handleFrame(f)) return;
    if (f.type !== "task_request" || f.task == null) return;
    this.requests++;
    const task = f.task as { task_id: string; prompt: string };
    this.claims.offer(task.task_id, () => this.run(task));
  }

  private async run(task: { task_id: string; prompt: string }): Promise<void> {
    this.executions++;
    await sleep(this.opts.runMs ?? 50);
    await this.held;
    if (this.opts.neverAnswer) return;
    await this.answer(task);
  }

  async answer(
    task: { task_id: string; prompt: string },
    opts: { bearer?: "device" | "master"; tamper?: boolean } = {},
  ): Promise<void> {
    const { relay, motebitId, kp } = this.id;
    const enc = new TextEncoder();
    const result = `done by ${this.deviceId}`;
    const signed = await signExecutionReceipt(
      {
        task_id: task.task_id,
        relay_task_id: task.task_id,
        motebit_id: motebitId as never,
        device_id: this.deviceId as never,
        submitted_at: Date.now() - 1000,
        completed_at: Date.now(),
        status: "completed" as const,
        result,
        tools_used: [],
        memories_formed: 0,
        prompt_hash: await sha256(enc.encode(task.prompt)),
        result_hash: await sha256(enc.encode(result)),
      },
      kp.privateKey,
    );
    // A receipt altered after signing (its signed device_id no longer verifies).
    const receipt = opts.tamper ? { ...signed, result_hash: "00".repeat(32) } : signed;
    const token =
      opts.bearer === "master"
        ? API_TOKEN
        : (
            await mintAudienceToken(
              { mid: motebitId, did: this.deviceId, aud: "task:result" },
              kp.privateKey,
            )
          ).token;
    const res = await relay.app.request(`/agent/${motebitId}/task/${task.task_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(receipt),
    });
    this.resultStatuses.push(res.status);
  }
}

async function submit(id: Identity, prompt = `task ${crypto.randomUUID()}`) {
  const res = await id.relay.app.request(`/agent/${id.motebitId}/task`, {
    method: "POST",
    headers: jsonAuthWithIdempotency(),
    body: JSON.stringify({ prompt }),
  });
  expect(res.status).toBe(201);
  const { task_id } = (await res.json()) as { task_id: string };
  return { task_id, prompt };
}

async function answerOf(id: Identity, taskId: string): Promise<string | null> {
  const res = await id.relay.app.request(`/agent/${id.motebitId}/task/${taskId}`, {
    headers: JSON_AUTH,
  });
  if (res.status !== 200) return null;
  const j = (await res.json()) as { receipt?: { result?: string } | null };
  return j.receipt?.result ?? null;
}

function settlementRows(id: Identity, taskId: string): number {
  return (
    id.relay.moteDb.db
      .prepare(`SELECT COUNT(*) AS n FROM relay_settlements WHERE task_id = ?`)
      .get(taskId) as { n: number }
  ).n;
}

const total = (bodies: Body[]) => bodies.reduce((n, b) => n + b.executions, 0);

describe("one task, one body — every serving body of an identity", () => {
  it.each([2, 3])("%i bodies: the task is presented to all, executed by exactly one", async (n) => {
    const id = await identityWithDevices(n);
    const bodies = id.devices.map((d) => new Body(id, d));
    for (const b of bodies) await b.open();

    const t = await submit(id);
    expect(await waitFor(() => bodies.every((b) => b.requests >= 1))).toBe(true);
    expect(await waitFor(() => total(bodies) >= 1)).toBe(true);
    await sleep(300);

    expect(total(bodies)).toBe(1);
    expect(await answerOf(id, t.task_id)).toMatch(/^done by /);
    expect(settlementRows(id, t.task_id)).toBeLessThanOrEqual(1);
  });

  it("claims racing across three bodies: ten concurrent tasks, each executed exactly once", async () => {
    const id = await identityWithDevices(3);
    const bodies = id.devices.map((d) => new Body(id, d));
    for (const b of bodies) await b.open();

    const tasks = await Promise.all(Array.from({ length: 10 }, () => submit(id)));
    expect(await waitFor(() => total(bodies) >= 10)).toBe(true);
    await sleep(400);

    expect(total(bodies)).toBe(10);
    for (const t of tasks) expect(await answerOf(id, t.task_id)).toMatch(/^done by /);
  });
});

/** The submitter's poll: the task's status and any undetermined reason. */
async function pollOf(
  id: Identity,
  taskId: string,
): Promise<{ status: string; undetermined: { reason: string } | null; result: string | null }> {
  const res = await id.relay.app.request(`/agent/${id.motebitId}/task/${taskId}`, {
    headers: JSON_AUTH,
  });
  expect(res.status).toBe(200);
  const j = (await res.json()) as {
    task: { status: string };
    undetermined?: { reason: string } | null;
    receipt?: { result?: string } | null;
  };
  return {
    status: j.task.status,
    undetermined: j.undetermined ?? null,
    result: j.receipt?.result ?? null,
  };
}

/**
 * THE LAW: at most one execution per task. A body executes the moment its
 * claim is granted, so a granted claim means "may have started". Losing the
 * claimer after the grant makes the task UNDETERMINED — surfaced to the
 * delegator, never Pending again, never handed to another body.
 */
describe("a granted claim is never re-dispatched — a lost claimer leaves the task undetermined", () => {
  it("claimer DISCONNECTS before answering: no other body runs it; the delegator sees undetermined", async () => {
    const id = await identityWithDevices(2);
    const a = new Body(id, id.devices[0]!, { neverAnswer: true });
    await a.open();
    const t = await submit(id);
    expect(await waitFor(() => a.executions === 1)).toBe(true);
    await sleep(50); // the claim lands

    const b = new Body(id, id.devices[1]!);
    await b.open();
    a.ws.terminate();

    // Well past the lease: the claimer is lost.
    await sleep(LEASE_MS * 4);
    expect(b.requests).toBe(0);
    expect(b.executions).toBe(0);
    const poll = await pollOf(id, t.task_id);
    expect(poll.status).not.toBe("pending");
    expect(poll.undetermined?.reason).toBe("claimer_lost");
    expect(poll.result).toBeNull();
    expect(settlementRows(id, t.task_id)).toBe(0);

    // A body that connects later is not handed it either (recovery).
    const c = new Body(id, id.devices[1]!);
    await c.open();
    await sleep(LEASE_MS);
    expect(c.requests + c.executions).toBe(0);
  });

  it("claimer STOPS RENEWING (alive, partitioned): never a second execution; its late result resolves the task", async () => {
    const id = await identityWithDevices(2);
    const a = new Body(id, id.devices[0]!);
    a.hold();
    await a.open();
    const t = await submit(id);
    expect(await waitFor(() => a.executions === 1)).toBe(true);
    await sleep(50);
    a.muted = true; // A's renewals never reach the relay

    const b = new Body(id, id.devices[1]!);
    await b.open();
    await sleep(LEASE_MS * 4);

    // No concurrent execution: B was never granted.
    expect(b.executions).toBe(0);
    expect((await pollOf(id, t.task_id)).undetermined?.reason).toBe("claimer_lost");

    // A finally finishes: the claimer's signed result resolves the uncertainty.
    a.muted = false;
    a.finish();
    expect(await waitFor(() => a.resultStatuses.length === 1)).toBe(true);
    expect(a.resultStatuses).toEqual([200]);
    const poll = await pollOf(id, t.task_id);
    expect(poll.result).toBe(`done by ${a.deviceId}`);
    expect(poll.undetermined).toBeNull();
    expect(a.executions + b.executions).toBe(1);
    expect(settlementRows(id, t.task_id)).toBeLessThanOrEqual(1);
  });

  it("a result from a non-claimer device is refused while the task is claimed or undetermined", async () => {
    const id = await identityWithDevices(2);
    const a = new Body(id, id.devices[0]!, { neverAnswer: true });
    await a.open();
    const t = await submit(id);
    expect(await waitFor(() => a.executions === 1)).toBe(true);
    await sleep(50);

    const b = new Body(id, id.devices[1]!);
    await b.answer(t); // while A holds the claim
    a.ws.terminate();
    await sleep(LEASE_MS * 4);
    await b.answer(t); // while the task is undetermined
    expect(b.resultStatuses).toEqual([409, 409]);
    expect((await pollOf(id, t.task_id)).result).toBeNull();
  });

  // F1 (cold review of 5e5b36a): the CLI daemon and desktop send the master
  // token first when one is configured, so the presentation names no device.
  // The receipt's SIGNED device_id is then who answers: a non-claimer's is
  // refused; the claimer's own is accepted.
  it("a master-token result signed by a non-claimer device is refused; the claimer's is accepted", async () => {
    const id = await identityWithDevices(2);
    const a = new Body(id, id.devices[0]!, { neverAnswer: true });
    await a.open();
    const t = await submit(id);
    expect(await waitFor(() => a.executions === 1)).toBe(true);
    await sleep(50);

    const b = new Body(id, id.devices[1]!);
    await b.answer(t, { bearer: "master" }); // while A holds the claim
    expect(b.resultStatuses).toEqual([409]);
    expect((await pollOf(id, t.task_id)).result).toBeNull();

    await a.answer(t, { bearer: "master" });
    expect(a.resultStatuses).toEqual([200]);
    expect(await answerOf(id, t.task_id)).toBe(`done by ${a.deviceId}`);
  });

  it("a master-token result whose signature does not verify is refused before the claim is compared", async () => {
    const id = await identityWithDevices(2);
    const a = new Body(id, id.devices[0]!, { neverAnswer: true });
    await a.open();
    const t = await submit(id);
    expect(await waitFor(() => a.executions === 1)).toBe(true);
    await sleep(50);

    // The claimer's own device id, but the signature is broken: never taken.
    await a.answer(t, { bearer: "master", tamper: true });
    expect(a.resultStatuses).toEqual([403]);
    expect((await pollOf(id, t.task_id)).result).toBeNull();
  });

  it("a master-token result to a task never claimed over WS keeps today's behaviour", async () => {
    const id = await identityWithDevices(2);
    const t = await submit(id); // no body connected: nothing claims it
    const b = new Body(id, id.devices[1]!);
    await b.answer(t, { bearer: "master" });
    expect(b.resultStatuses).toEqual([200]);
    expect(await answerOf(id, t.task_id)).toBe(`done by ${b.deviceId}`);
  });

  it("a claimer that keeps renewing is never marked undetermined, and no second body runs it", async () => {
    const id = await identityWithDevices(2);
    const a = new Body(id, id.devices[0]!, { runMs: LEASE_MS * 4 });
    const b = new Body(id, id.devices[1]!);
    await a.open();
    const t = await submit(id);
    expect(await waitFor(() => a.executions === 1)).toBe(true);
    await b.open();
    await sleep(LEASE_MS * 2);
    expect((await pollOf(id, t.task_id)).undetermined).toBeNull();

    expect(await waitFor(() => a.resultStatuses.length === 1, LEASE_MS * 10)).toBe(true);
    expect(a.resultStatuses).toEqual([200]);
    expect(b.executions).toBe(0);
    expect(await answerOf(id, t.task_id)).toBe(`done by ${a.deviceId}`);
  });
});
