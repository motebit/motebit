/**
 * Task admission wiring — `resolveTaskAdmission` decides the posture from
 * config/env and the molecule's OWN listing, resolves the relay key through
 * the pinned-or-TOFU-with-succession primitive, and `runMolecule` threads the
 * result (with durable stores) into `startServiceServer`.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { MoleculeConfig } from "../index.js";
import { fileAdmissionStores, resolveTaskAdmission, taskAdmissionEnvDefaults } from "../index.js";

const RELAY_KEY = "ab".repeat(32);

function listing(unitCost: number) {
  return async () => ({
    capabilities: ["x"],
    pricing: [{ capability: "x", unit_cost: unitCost, currency: "USD", per: "task" }],
    sla: { max_latency_ms: 1000, availability_guarantee: 0.99 },
    description: "t",
  });
}

const noFetch = (() => {
  throw new Error("fetch must not be called");
}) as unknown as typeof fetch;

function memStores() {
  const pins = new Map<string, string>();
  const admitted = new Map<string, number>();
  return {
    pins,
    admitted,
    stores: {
      pinStorage: {
        getItem: (k: string) => pins.get(k) ?? null,
        setItem: (k: string, v: string) => {
          pins.set(k, v);
        },
      },
      admittedStore: {
        has: (id: string) => admitted.has(id),
        add: (id: string, exp: number) => {
          admitted.set(id, exp);
        },
      },
    },
  };
}

const NO_ENV: NodeJS.ProcessEnv = {};

describe("resolveTaskAdmission — posture", () => {
  it("taskAdmission: relay ⇒ admission with the pinned key + the durable store", async () => {
    const logs: string[] = [];
    const { stores } = memStores();
    const out = await resolveTaskAdmission(
      {
        syncUrl: "http://relay",
        relayPublicKeyHex: RELAY_KEY,
        taskAdmission: "relay",
        serviceName: "s",
      },
      { getServiceListing: listing(0.2) },
      noFetch,
      (m) => logs.push(m),
      stores,
      NO_ENV,
    );
    expect(out).toEqual({ relayPublicKey: RELAY_KEY, admittedStore: stores.admittedStore });
    expect(logs.join("\n")).toContain("pinned relay key");
  });

  it("priced + relay-registered but not opted in ⇒ open, and the boot log says so LOUDLY", async () => {
    const logs: string[] = [];
    const out = await resolveTaskAdmission(
      { syncUrl: "http://relay", relayPublicKeyHex: RELAY_KEY, serviceName: "s" },
      { getServiceListing: listing(0.2) },
      noFetch,
      (m) => logs.push(m),
      memStores().stores,
      NO_ENV,
    );
    expect(out).toBeUndefined();
    expect(logs.join("\n")).toContain("OPEN on a PRICED relay-registered listing");
  });

  it("the env var the warning names actually works: MOTEBIT_TASK_ADMISSION=relay + MOTEBIT_RELAY_PUBLIC_KEY", async () => {
    const { stores } = memStores();
    const out = await resolveTaskAdmission(
      { syncUrl: "http://relay", serviceName: "s" },
      { getServiceListing: listing(0.2) },
      noFetch,
      () => {},
      stores,
      { MOTEBIT_TASK_ADMISSION: "relay", MOTEBIT_RELAY_PUBLIC_KEY: ` ${RELAY_KEY} ` },
    );
    expect(out?.relayPublicKey).toBe(RELAY_KEY);
    expect(
      taskAdmissionEnvDefaults({ MOTEBIT_TASK_ADMISSION: "bogus", MOTEBIT_RELAY_PUBLIC_KEY: "" }),
    ).toEqual({});
  });

  it("explicit config beats env", async () => {
    const out = await resolveTaskAdmission(
      {
        syncUrl: "http://relay",
        relayPublicKeyHex: RELAY_KEY,
        taskAdmission: "open",
        serviceName: "s",
      },
      { getServiceListing: listing(0.2) },
      noFetch,
      () => {},
      memStores().stores,
      { MOTEBIT_TASK_ADMISSION: "relay" },
    );
    expect(out).toBeUndefined();
  });

  it("falls back to the money seam's pinned relay key", async () => {
    const out = await resolveTaskAdmission(
      {
        syncUrl: "http://relay",
        serviceName: "s",
        taskAdmission: "relay",
        moneyExecution: {
          solanaRpcUrl: "http://rpc",
          relayPublicKeyHex: RELAY_KEY,
          spendCeiling: { ceiling_micro: 1, per_action_max_micro: 1 } as never,
        },
      },
      { getServiceListing: listing(0.2) },
      noFetch,
      () => {},
      memStores().stores,
      NO_ENV,
    );
    expect(out?.relayPublicKey).toBe(RELAY_KEY);
  });

  it("an EMPTY pinned key is unset (falls through to TOFU), a MALFORMED one stops the boot", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ relay_id: "r", public_key: RELAY_KEY }), { status: 200 }),
    );
    const { stores } = memStores();
    const out = await resolveTaskAdmission(
      { syncUrl: "http://relay", relayPublicKeyHex: "", taskAdmission: "relay", serviceName: "s" },
      { getServiceListing: listing(0.2) },
      fetchMock as unknown as typeof fetch,
      () => {},
      stores,
      NO_ENV,
    );
    expect(typeof out?.relayPublicKey).toBe("function");
    expect(await (out!.relayPublicKey as () => Promise<string | null>)()).toBe(RELAY_KEY);

    await expect(
      resolveTaskAdmission(
        {
          syncUrl: "http://relay",
          relayPublicKeyHex: "not-hex",
          taskAdmission: "relay",
          serviceName: "s",
        },
        { getServiceListing: listing(0.2) },
        noFetch,
        () => {},
        memStores().stores,
        NO_ENV,
      ),
    ).rejects.toThrow(/not a 64-hex/);
  });

  it("unpriced ⇒ open quietly; no listing ⇒ open; unreadable listing ⇒ treated as priced (warning fires)", async () => {
    const quiet: string[] = [];
    expect(
      await resolveTaskAdmission(
        { syncUrl: "http://relay", serviceName: "s" },
        { getServiceListing: listing(0) },
        noFetch,
        (m) => quiet.push(m),
        memStores().stores,
        NO_ENV,
      ),
    ).toBeUndefined();
    expect(quiet.join("\n")).not.toContain("PRICED");
    expect(
      await resolveTaskAdmission(
        { syncUrl: "http://relay", serviceName: "s" },
        { getServiceListing: undefined },
        noFetch,
        () => {},
        memStores().stores,
        NO_ENV,
      ),
    ).toBeUndefined();
    const loud: string[] = [];
    expect(
      await resolveTaskAdmission(
        { syncUrl: "http://relay", serviceName: "s" },
        {
          getServiceListing: async () => {
            throw new Error("boom");
          },
        },
        noFetch,
        (m) => loud.push(m),
        memStores().stores,
        NO_ENV,
      ),
    ).toBeUndefined();
    expect(loud.join("\n")).toContain("treating as priced");
    expect(loud.join("\n")).toContain("OPEN on a PRICED");
  });

  it("relay required with no key and no syncUrl ⇒ a resolver that always denies", async () => {
    const logs: string[] = [];
    const out = await resolveTaskAdmission(
      { taskAdmission: "relay", serviceName: "s" },
      { getServiceListing: listing(0.2) },
      noFetch,
      (m) => logs.push(m),
      memStores().stores,
      NO_ENV,
    );
    expect(await (out!.relayPublicKey as () => Promise<string | null>)()).toBeNull();
    expect(logs.join("\n")).toContain("every task will be refused");
  });
});

describe("resolveTaskAdmission — trust-on-first-use pin with succession", () => {
  it("first resolution persists the pin; later resolutions return the PIN even if the fetch changes or fails", async () => {
    let served = RELAY_KEY;
    let fail = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (fail) throw new Error("ECONNREFUSED");
      if (url.endsWith("/.well-known/motebit.json")) {
        return new Response(JSON.stringify({ relay_id: "r", public_key: served }), { status: 200 });
      }
      // Succession chain lookup on a key change: none published → fail closed.
      return new Response("{}", { status: 404 });
    });
    const { stores, pins } = memStores();
    const out = await resolveTaskAdmission(
      { syncUrl: "http://relay/", taskAdmission: "relay", serviceName: "s" },
      { getServiceListing: listing(0.2) },
      fetchMock as unknown as typeof fetch,
      () => {},
      stores,
      NO_ENV,
    );
    const resolver = out!.relayPublicKey as () => Promise<string | null>;
    expect(await resolver()).toBe(RELAY_KEY);
    expect([...pins.values()]).toContain(RELAY_KEY);

    // Relay unreachable → the persisted pin still answers (never null → deny).
    fail = true;
    expect(await resolver()).toBe(RELAY_KEY);
    fail = false;

    // An unproven key change (MITM / equivocation) → fail closed, pin kept.
    served = "cd".repeat(32);
    expect(await resolver()).toBeNull();
    expect([...pins.values()]).toContain(RELAY_KEY);
  });

  it("a malformed or missing well-known key resolves to null with no pin written", async () => {
    for (const impl of [
      async () => new Response(JSON.stringify({ public_key: "nope" }), { status: 200 }),
      async () => new Response(JSON.stringify({}), { status: 200 }),
      async () => new Response("down", { status: 503 }),
    ]) {
      const { stores, pins } = memStores();
      const out = await resolveTaskAdmission(
        { syncUrl: "http://relay", taskAdmission: "relay", serviceName: "s" },
        { getServiceListing: listing(0.2) },
        impl as unknown as typeof fetch,
        () => {},
        stores,
        NO_ENV,
      );
      expect(await (out!.relayPublicKey as () => Promise<string | null>)()).toBeNull();
      expect(pins.size === 0 || [...pins.values()].every((v) => v !== "nope")).toBe(true);
    }
  });
});

describe("fileAdmissionStores — durable across processes", () => {
  it("persists pins and admitted task ids under dataDir; expired admissions fall away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "motebit-admission-"));
    const a = fileAdmissionStores(dir);
    await a.pinStorage.setItem("relay-key-pin:http://relay", RELAY_KEY);
    await a.admittedStore.add("task-1", Date.now() + 60_000);
    await a.admittedStore.add("task-old", Date.now() - 1);
    // A second "process" over the same directory sees the same truth.
    const b = fileAdmissionStores(dir);
    expect(await b.pinStorage.getItem("relay-key-pin:http://relay")).toBe(RELAY_KEY);
    expect(await b.admittedStore.has("task-1")).toBe(true);
    expect(await b.admittedStore.has("task-old")).toBe(false);
    expect(await b.admittedStore.has("never")).toBe(false);
  });
});

describe("runMolecule threads task admission into startServiceServer", () => {
  it("a molecule that opts in starts its server WITH taskAdmission (pinned key + durable store)", async () => {
    const { runMolecule } = await import("../index.js");
    const startCalls: Array<Record<string, unknown>> = [];
    const { stores } = memStores();
    const adapters = {
      bootstrapIdentity: async () => ({
        motebitId: "mot_test",
        deviceId: "dev",
        publicKeyHex: "00".repeat(32),
        publicKey: new Uint8Array(32),
        privateKey: new Uint8Array(32),
        identityContent: "# m",
        identityPath: "/x",
        isFirstLaunch: true,
      }),
      openDatabase: async () => ({ close: () => {} }) as never,
      createRuntime: () =>
        ({
          init: async () => {},
          stop: () => {},
          policy: {
            filterTools: (t: unknown) => t,
            validate: () => ({ allowed: true }),
            createTurnContext: () => ({}),
          },
          getState: () => ({}),
          memory: {
            exportAll: async () => ({ nodes: [], edges: [] }),
            recallRelevant: async () => [],
            formMemory: async () => ({ node_id: "n" }),
          },
          events: { append: async () => {}, appendWithClock: async () => 0 },
          getToolRegistry: () => ({
            list: () => [],
            execute: async () => ({ ok: true, data: "" }),
          }),
        }) as never,
      startServer: vi.fn(async (_deps: unknown, cfg: Record<string, unknown>) => {
        startCalls.push(cfg);
        return { shutdown: async () => {}, server: {} as never };
      }),
      existsSync: () => true,
      mkdirSync: () => {},
      embedText: async () => [0],
      log: () => {},
      admissionStores: stores,
    };
    const cfg: MoleculeConfig = {
      dataDir: "/tmp/x",
      dbPath: "/tmp/x/t.db",
      port: 1,
      serviceName: "t",
      displayName: "T",
      serviceDescription: "t",
      capabilities: ["x"],
      syncUrl: "http://relay",
      relayPublicKeyHex: RELAY_KEY,
      taskAdmission: "relay",
    };
    await runMolecule(
      cfg,
      () => ({ toolRegistry: new InMemoryToolRegistry(), getServiceListing: listing(0.2) }),
      adapters as never,
    );
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.taskAdmission).toEqual({
      relayPublicKey: RELAY_KEY,
      admittedStore: stores.admittedStore,
    });
  });
});
