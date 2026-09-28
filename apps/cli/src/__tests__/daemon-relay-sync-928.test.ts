/**
 * #928 round 2 — the wiring `motebit run` and `motebit serve` actually call
 * (`createDaemonRelaySync`), driven against a REAL relay. `handleRun` /
 * `handleServe` cannot be driven in a unit test (passphrase prompt, database,
 * runtime-host socket, relay registration), so the wiring was extracted into
 * the one function both daemons call, and that function is what this tests.
 *
 * Every request body the daemon's adapters send is recorded before it reaches
 * the relay: the relay redacts some plaintext at ingress, so what it STORES
 * cannot prove what went on the wire.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createSyncRelay } from "@motebit/relay";
import type { SyncRelay } from "@motebit/relay";
import { bytesToHex, deriveSovereignMotebitId, generateKeypair } from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import { EventType, PlanStatus, StepStatus } from "@motebit/sdk";
import type { EventLogEntry, SyncPlan, SyncPlanStep } from "@motebit/sdk";
import {
  InMemoryPlanSyncStore,
  PlaintextPushRefusedError,
  isEncryptedPayload,
} from "@motebit/sync-engine";
import { registerWithRelay } from "../relay-registration.js";
import { createDaemonRelaySync } from "../daemon-relay-sync.js";

const MASTER = "test-token";
const SECRET = "ZZ928PLAIN";
const hex = (kp: KeyPair) => bytesToHex(kp.publicKey);

let relay: SyncRelay | undefined;
let realFetch: typeof globalThis.fetch | undefined;
let wire: string[] = [];

afterEach(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
  if (relay) await relay.close();
  relay = undefined;
  wire = [];
});

async function startRelay(): Promise<string> {
  relay = await createSyncRelay({
    apiToken: MASTER,
    x402: {
      payToAddress: "0x0000000000000000000000000000000000000000",
      network: "eip155:84532",
      testnet: true,
    },
    drainGraceMs: 10,
    allowPrivateEndpoints: true,
  });
  realFetch = globalThis.fetch;
  const base = "http://relay.zz928d.test";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (typeof init?.body === "string") wire.push(init.body);
    return relay!.app.request(url.replace(base, ""), init);
  }) as typeof globalThis.fetch;
  return base;
}

async function registeredDevice(): Promise<{ mid: string; deviceId: string; kp: KeyPair }> {
  const kp = await generateKeypair();
  const mid = await deriveSovereignMotebitId(hex(kp));
  const deviceId = `${mid}-host`;
  const handle = await registerWithRelay({
    syncUrl: "http://relay.test",
    identity: { motebitId: mid, deviceId, publicKeyHex: hex(kp), privateKey: kp.privateKey },
    registration: { endpoint_url: "http://127.0.0.1:9999/mcp", capabilities: [] },
    toolNames: [],
    description: "daemon relay sync",
    log: () => {},
    heartbeatMs: 24 * 60 * 60 * 1000,
    fetchImpl: async (input, init) =>
      relay!.app.request(typeof input === "string" ? input : (input as Request).url, init),
  });
  handle.stop();
  expect(handle.registered).toBe(true);
  return { mid, deviceId, kp };
}

function planStore(mid: string): InMemoryPlanSyncStore {
  const store = new InMemoryPlanSyncStore();
  const now = Date.now();
  const plan: SyncPlan = {
    plan_id: "plan-zz928",
    goal_id: "goal-zz928",
    motebit_id: mid as SyncPlan["motebit_id"],
    title: `${SECRET} plan title`,
    status: PlanStatus.Active,
    created_at: now,
    updated_at: now,
    current_step_index: 0,
    total_steps: 1,
    proposal_id: null,
    collaborative: 0,
  } as SyncPlan;
  const step: SyncPlanStep = {
    step_id: "step-zz928",
    plan_id: "plan-zz928",
    motebit_id: mid,
    ordinal: 0,
    description: `${SECRET} step description`,
    prompt: `${SECRET} step prompt`,
    depends_on: "[]",
    optional: false,
    status: StepStatus.Pending,
    required_capabilities: null,
    delegation_task_id: null,
    assigned_motebit_id: null,
    result_summary: null,
    error_message: null,
    tool_calls_made: 0,
    started_at: null,
    completed_at: null,
    retry_count: 0,
    updated_at: now,
  } as SyncPlanStep;
  store.upsertPlan(plan);
  store.upsertStep(step);
  return store;
}

describe("createDaemonRelaySync — what `motebit run` / `serve` wire", () => {
  it("with the identity key: events and plans leave encrypted, authenticated by a minted token", async () => {
    const syncUrl = await startRelay();
    const { mid, deviceId, kp } = await registeredDevice();
    const sync = await createDaemonRelaySync({
      syncUrl,
      motebitId: mid,
      deviceId,
      privateKey: () => kp.privateKey,
    });
    expect(sync.e2e).toBe(true);
    // The transport under the wrapper refuses a payload that skipped it.
    await expect(
      sync.transport.http.append({
        event_id: "raw",
        motebit_id: mid as EventLogEntry["motebit_id"],
        timestamp: Date.now(),
        event_type: EventType.StateUpdated,
        payload: { content: SECRET },
        version_clock: 1,
        tombstoned: false,
      }),
    ).rejects.toBeInstanceOf(PlaintextPushRefusedError);

    await sync.transport.remote.append({
      event_id: "ev-zz928",
      motebit_id: mid as EventLogEntry["motebit_id"],
      timestamp: Date.now(),
      event_type: EventType.MemoryFormed,
      payload: { content: `${SECRET} memory` },
      version_clock: 1,
      tombstoned: false,
    });
    const result = await sync.planSync(planStore(mid)).sync();
    expect(result.plans_pushed).toBe(1);
    expect(result.steps_pushed).toBe(1);

    // The relay accepted the event, as an envelope.
    const res = await relay!.app.request(`/sync/${mid}/pull?after_clock=0`, {
      headers: { Authorization: `Bearer ${MASTER}` },
    });
    const held = ((await res.json()) as { events: EventLogEntry[] }).events;
    expect(held.map((e) => e.event_id)).toEqual(["ev-zz928"]);
    expect(isEncryptedPayload(held[0]!.payload)).toBe(true);

    // Nothing that went on the wire carries the plaintext.
    expect(wire.length).toBeGreaterThanOrEqual(3);
    for (const body of wire) expect(body).not.toContain(SECRET);
  });

  it("serve's catch-up transport is the same keyed transport", async () => {
    const syncUrl = await startRelay();
    const { mid, deviceId, kp } = await registeredDevice();
    const sync = await createDaemonRelaySync({
      syncUrl,
      motebitId: mid,
      deviceId: undefined, // serve with only the master token configured
      privateKey: () => kp.privateKey,
      configuredToken: MASTER,
    });
    void deviceId;
    expect(sync.e2e).toBe(true);
    await sync.transport.remote.append({
      event_id: "ev-serve",
      motebit_id: mid as EventLogEntry["motebit_id"],
      timestamp: Date.now(),
      event_type: EventType.StateUpdated,
      payload: { note: `${SECRET} serve` },
      version_clock: 1,
      tombstoned: false,
    });
    for (const body of wire) expect(body).not.toContain(SECRET);
  });

  it("without the identity key (or an erased one) it is raw by design, and says so", async () => {
    const syncUrl = await startRelay();
    const { mid, deviceId } = await registeredDevice();
    for (const key of [undefined, new Uint8Array(32)]) {
      const sync = await createDaemonRelaySync({
        syncUrl,
        motebitId: mid,
        deviceId,
        privateKey: () => key,
      });
      expect(sync.e2e).toBe(false);
    }
  });
});
