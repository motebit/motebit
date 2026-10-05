/**
 * Listing pricing is runner-owned BY CONSTRUCTION.
 *
 * A priced service hands `runMolecule` its price as `config.pricing` (built by
 * the service's pure `listingPricing(process.env)`); its `getServiceListing`
 * supplies capabilities/SLA/description only. The runner composes the ONE
 * listing function every consumer reads — task admission, relay registration
 * (`deps.getServiceListing()` as a member call, mcp-server service.ts), and the
 * `motebit_service_listing` MCP tool (a DETACHED call, mcp-server index.ts) —
 * so the three cannot disagree, and a listing that carries its own `pricing`
 * is refused at startup (one path from code to the relay).
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryToolRegistry } from "@motebit/tools";
import type { ListingPrice, MoleculeConfig } from "../index.js";
import { runMolecule } from "../index.js";

const RELAY_KEY = "ab".repeat(32);
const PRICE: ListingPrice[] = [
  { capability: "x", unit_cost: 0.2, currency: "USD", per: "task" },
  { capability: "y", unit_cost: 0.2, currency: "USD", per: "task" },
];
const SLA = { max_latency_ms: 1000, availability_guarantee: 0.99 };

type Listing = { pricing?: unknown; capabilities: string[]; description: string } | null;
type ListingFn = () => Promise<Listing>;

function harness() {
  const started: Array<{ deps: Record<string, unknown>; cfg: Record<string, unknown> }> = [];
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
        getToolRegistry: () => ({ list: () => [], execute: async () => ({ ok: true, data: "" }) }),
      }) as never,
    startServer: vi.fn(async (deps: Record<string, unknown>, cfg: Record<string, unknown>) => {
      started.push({ deps, cfg });
      return { shutdown: async () => {}, server: {} as never };
    }),
    existsSync: () => true,
    mkdirSync: () => {},
    embedText: async () => [0],
    log: () => {},
    admissionStores: {
      pinStorage: { getItem: () => null, setItem: () => {} },
      admittedStore: { has: () => false, add: () => {} },
    },
  };
  const cfg = (extra: Partial<MoleculeConfig> = {}): MoleculeConfig => ({
    dataDir: "/tmp/x",
    dbPath: "/tmp/x/t.db",
    port: 1,
    serviceName: "t",
    displayName: "T",
    serviceDescription: "t",
    capabilities: ["x", "y"],
    syncUrl: "http://relay",
    relayPublicKeyHex: RELAY_KEY,
    ...extra,
  });
  const run = (config: MoleculeConfig, getServiceListing?: unknown) =>
    runMolecule(
      config,
      () =>
        ({
          toolRegistry: new InMemoryToolRegistry(),
          ...(getServiceListing != null ? { getServiceListing } : {}),
        }) as never,
      adapters as never,
    );
  /** The three consumers, called the way the real code calls them. */
  const consumers = async () => {
    const { deps, cfg: serverCfg } = started[0]!;
    const registration = (await (deps as { getServiceListing: ListingFn }).getServiceListing())
      ?.pricing;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mirrors mcp-server's detached call
    const detached = deps.getServiceListing as ListingFn;
    const mcpTool = (await detached())?.pricing;
    return { admissionPriced: serverCfg.taskAdmission != null, registration, mcpTool };
  };
  return { run, cfg, consumers, started };
}

describe("listing pricing — one path from config to every consumer", () => {
  it("config pricing reaches admission, relay registration and the MCP tool identically, even for a this-sensitive listing", async () => {
    const h = harness();
    // A listing that answers differently bound vs detached — the shape that let
    // the relay registration path (member call) and the MCP tool (detached)
    // publish different prices before pricing was runner-owned.
    const molecule = {
      getServiceListing(this: unknown): Promise<Listing> {
        return Promise.resolve({
          capabilities: ["x", "y"],
          sla: SLA,
          description: "d",
          ...(this != null
            ? { pricing: [{ capability: "x", unit_cost: 9, currency: "USD", per: "call" }] }
            : {}),
        } as Listing);
      },
    };
    await h.run(h.cfg({ pricing: PRICE }), molecule.getServiceListing);
    const c = await h.consumers();
    expect(c.admissionPriced).toBe(true);
    expect(c.registration).toEqual(PRICE);
    expect(c.mcpTool).toEqual(PRICE);
  });

  it("a getServiceListing that returns its OWN pricing is refused at startup", async () => {
    const h = harness();
    await expect(
      h.run(h.cfg({ pricing: PRICE }), async () => ({
        capabilities: ["x"],
        sla: SLA,
        description: "d",
        pricing: PRICE,
      })),
    ).rejects.toThrow(/runner-owned/);
    // …with or without config pricing: there is no second way in.
    await expect(
      h.run(h.cfg(), async () => ({
        capabilities: ["x"],
        sla: SLA,
        description: "d",
        pricing: [],
      })),
    ).rejects.toThrow(/runner-owned/);
    expect(h.started).toHaveLength(0);
  });

  it("config pricing with no getServiceListing is refused (a price with nothing to list it on)", async () => {
    const h = harness();
    await expect(h.run(h.cfg({ pricing: PRICE }))).rejects.toThrow(/getServiceListing/);
  });

  it("a listing that turns up with pricing AFTER startup is refused at that call, never published", async () => {
    const h = harness();
    let n = 0;
    await h.run(h.cfg({ pricing: PRICE }), async () => ({
      capabilities: ["x"],
      sla: SLA,
      description: "d",
      ...(n++ > 0 ? { pricing: [] } : {}),
    }));
    const fn = h.started[0]!.deps.getServiceListing as ListingFn;
    await expect(fn()).rejects.toThrow(/runner-owned/);
  });

  it("the published pricing is a frozen copy of config: later mutation of either reaches nothing", async () => {
    const h = harness();
    const mine = PRICE.map((p) => ({ ...p }));
    await h.run(h.cfg({ pricing: mine }), async () => ({
      capabilities: ["x"],
      sla: SLA,
      description: "d",
    }));
    mine[0]!.unit_cost = 0;
    const fn = h.started[0]!.deps.getServiceListing as ListingFn;
    const first = (await fn())!.pricing as ListingPrice[];
    first[0]!.per = "mutated";
    expect((await fn())!.pricing).toEqual(PRICE);
  });

  it("unpriced services are unchanged: no config pricing ⇒ pricing [] and admission open; no listing ⇒ none", async () => {
    const h = harness();
    await h.run(h.cfg(), async () => ({ capabilities: ["x"], sla: SLA, description: "d" }));
    const c = await h.consumers();
    expect(c).toEqual({ admissionPriced: false, registration: [], mcpTool: [] });

    const h2 = harness();
    await h2.run(h2.cfg());
    expect(h2.started[0]!.deps.getServiceListing).toBeUndefined();
    expect(h2.started[0]!.cfg.taskAdmission).toBeUndefined();
  });

  it("zero-cost config pricing is listed as-is (non-empty, unit_cost 0) and does not close admission", async () => {
    const h = harness();
    const zero: ListingPrice[] = [{ capability: "x", unit_cost: 0, currency: "USD", per: "task" }];
    await h.run(h.cfg({ pricing: zero }), async () => ({
      capabilities: ["x"],
      sla: SLA,
      description: "d",
    }));
    expect(await h.consumers()).toEqual({
      admissionPriced: false,
      registration: zero,
      mcpTool: zero,
    });
  });
});
