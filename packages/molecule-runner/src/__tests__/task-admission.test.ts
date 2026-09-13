/**
 * Task admission wiring — `resolveTaskAdmission` decides the posture from
 * the molecule's OWN listing and resolves the relay key; `runMolecule`
 * threads the result into `startServiceServer`. The contract: a priced,
 * relay-registered molecule never starts without admission configured, and
 * an unpriced one is never burdened with it.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { MoleculeConfig } from "../index.js";
import { resolveTaskAdmission } from "../index.js";

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

describe("resolveTaskAdmission — posture", () => {
  it("taskAdmission: relay ⇒ admission with the pinned key", async () => {
    const logs: string[] = [];
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
    );
    expect(out).toEqual({ relayPublicKey: RELAY_KEY });
    expect(logs.join("\n")).toContain("pinned relay key");
  });

  it("priced + relay-registered but not opted in ⇒ open, and the boot log says so LOUDLY", async () => {
    const logs: string[] = [];
    const out = await resolveTaskAdmission(
      { syncUrl: "http://relay", relayPublicKeyHex: RELAY_KEY, serviceName: "s" },
      { getServiceListing: listing(0.2) },
      noFetch,
      (m) => logs.push(m),
    );
    expect(out).toBeUndefined();
    expect(logs.join("\n")).toContain("OPEN on a PRICED relay-registered listing");
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
    );
    expect(out).toEqual({ relayPublicKey: RELAY_KEY });
  });

  it("unpriced ⇒ open quietly (no warning), even with a relay", async () => {
    const logs: string[] = [];
    const out = await resolveTaskAdmission(
      { syncUrl: "http://relay", relayPublicKeyHex: RELAY_KEY, serviceName: "s" },
      { getServiceListing: listing(0) },
      noFetch,
      (m) => logs.push(m),
    );
    expect(out).toBeUndefined();
    expect(logs.join("\n")).not.toContain("PRICED");
  });

  it("no listing at all ⇒ open (nothing is priced)", async () => {
    const out = await resolveTaskAdmission(
      { syncUrl: "http://relay", serviceName: "s" },
      { getServiceListing: undefined },
      noFetch,
      () => {},
    );
    expect(out).toBeUndefined();
  });

  it("priced but no relay (no syncUrl) ⇒ open by default", async () => {
    const out = await resolveTaskAdmission(
      { serviceName: "s" },
      { getServiceListing: listing(0.2) },
      noFetch,
      () => {},
    );
    expect(out).toBeUndefined();
  });

  it("explicit taskAdmission overrides the default in both directions", async () => {
    const forcedOpen = await resolveTaskAdmission(
      {
        syncUrl: "http://relay",
        relayPublicKeyHex: RELAY_KEY,
        taskAdmission: "open",
        serviceName: "s",
      },
      { getServiceListing: listing(0.2) },
      noFetch,
      () => {},
    );
    expect(forcedOpen).toBeUndefined();

    const forcedRelay = await resolveTaskAdmission(
      { relayPublicKeyHex: RELAY_KEY, taskAdmission: "relay", serviceName: "s" },
      { getServiceListing: listing(0) },
      noFetch,
      () => {},
    );
    expect(forcedRelay).toEqual({ relayPublicKey: RELAY_KEY });
  });

  it("an unreadable listing is treated as priced — the warning fires rather than staying silent", async () => {
    const logs: string[] = [];
    const out = await resolveTaskAdmission(
      { syncUrl: "http://relay", relayPublicKeyHex: RELAY_KEY, serviceName: "s" },
      {
        getServiceListing: async () => {
          throw new Error("boom");
        },
      },
      noFetch,
      (m) => logs.push(m),
    );
    expect(out).toBeUndefined();
    expect(logs.join("\n")).toContain("treating as priced");
    expect(logs.join("\n")).toContain("OPEN on a PRICED");
  });

  it("relay required with no key and no syncUrl ⇒ a resolver that always denies", async () => {
    const logs: string[] = [];
    const out = await resolveTaskAdmission(
      { taskAdmission: "relay", serviceName: "s" },
      { getServiceListing: listing(0.2) },
      noFetch,
      (m) => logs.push(m),
    );
    expect(typeof out?.relayPublicKey).toBe("function");
    expect(await (out!.relayPublicKey as () => Promise<string | null>)()).toBeNull();
    expect(logs.join("\n")).toContain("every task will be refused");
  });
});

describe("resolveTaskAdmission — well-known trust-on-first-use", () => {
  it("resolves the relay key from /.well-known/motebit.json when not pinned", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://relay/.well-known/motebit.json");
      return new Response(JSON.stringify({ relay_id: "r", public_key: RELAY_KEY }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const logs: string[] = [];
    const out = await resolveTaskAdmission(
      { syncUrl: "http://relay/", taskAdmission: "relay", serviceName: "s" },
      { getServiceListing: listing(0.2) },
      fetchMock as unknown as typeof fetch,
      (m) => logs.push(m),
    );
    expect(logs.join("\n")).toContain("trust-on-first-use");
    const resolver = out!.relayPublicKey as () => Promise<string | null>;
    expect(await resolver()).toBe(RELAY_KEY);
  });

  it("a malformed, missing, or non-2xx well-known key resolves to null (deny), never to garbage", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify({ public_key: "nope" }), { status: 200 }),
      async () => new Response(JSON.stringify({}), { status: 200 }),
      async () => new Response("down", { status: 503 }),
      async () => {
        throw new Error("ECONNREFUSED");
      },
    ];
    for (const impl of cases) {
      const out = await resolveTaskAdmission(
        { syncUrl: "http://relay", taskAdmission: "relay", serviceName: "s" },
        { getServiceListing: listing(0.2) },
        impl as unknown as typeof fetch,
        () => {},
      );
      expect(await (out!.relayPublicKey as () => Promise<string | null>)()).toBeNull();
    }
  });
});

describe("runMolecule threads task admission into startServiceServer", () => {
  it("a molecule that opts in starts its server WITH taskAdmission", async () => {
    // Import lazily so the heavy module graph loads only for this case.
    const { runMolecule } = await import("../index.js");
    const startCalls: Array<Record<string, unknown>> = [];
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
    expect(startCalls[0]!.taskAdmission).toEqual({ relayPublicKey: RELAY_KEY });
  });
});
