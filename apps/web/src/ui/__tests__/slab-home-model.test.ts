/**
 * Home-seed model tests — "the seed cannot lie", as properties.
 *
 * The recede tests (wired ⇒ setup tile absent) are anchored by
 * scripts/check-home-seed-basis.ts: one per HOME_CONFIG_KEY, named
 * `recede: <key>` so the gate can assert their existence.
 */
import { describe, it, expect } from "vitest";
import {
  deriveHomeSeed,
  computeSlabHomeAffordances,
  canonicalizeHost,
  HOME_CONFIG_KEYS,
  TILE_BUDGET,
  type HomeSeedInputs,
  type HomeConfigKey,
} from "../slab-home-model.js";
import type { UserInputForwardedPayload } from "@motebit/sdk";

function navEvent(host: string, timestamp: number) {
  return {
    payload: {
      detail: { kind: "navigate", host, scheme: "https" },
    } as unknown as UserInputForwardedPayload,
    timestamp,
  };
}

function inputs(overrides: {
  config?: Partial<Record<HomeConfigKey, boolean>>;
  hosts?: string[];
}): HomeSeedInputs {
  const hosts = overrides.hosts ?? [];
  return {
    identity: { motebitId: "0197f000-0000-7000-8000-0000000000aa" },
    config: { mind: true, relay: true, computer: true, ...overrides.config },
    toolNames: ["web_search", "read_url"],
    navigateEvents: hosts.map((h, i) => navEvent(h, 1_000_000 + i)),
  };
}

// All boolean combinations of the config keys — the seed must be honest
// at every point of the config lattice, not just the corners we thought of.
function allConfigs(): Array<Record<HomeConfigKey, boolean>> {
  const combos: Array<Record<HomeConfigKey, boolean>> = [];
  for (let mask = 0; mask < 1 << HOME_CONFIG_KEYS.length; mask++) {
    const config = {} as Record<HomeConfigKey, boolean>;
    HOME_CONFIG_KEYS.forEach((key, i) => {
      config[key] = (mask & (1 << i)) !== 0;
    });
    combos.push(config);
  }
  return combos;
}

describe("deriveHomeSeed — presence ⇔ evidence (the seed cannot lie)", () => {
  it("every tile's basis is witnessed by the inputs, at every config point and N", () => {
    for (const config of allConfigs()) {
      for (const n of [0, 1, 2, 3, 4, 6]) {
        const inp = inputs({ config, hosts: Array.from({ length: n }, (_, i) => `site${i}.com`) });
        const seed = deriveHomeSeed(inp);
        for (const tile of seed.tiles) {
          switch (tile.basis.kind) {
            case "identity":
              expect(tile.layer).toBe("intrinsic");
              break;
            case "config":
              // A config basis must state the truth of its own witness.
              expect(inp.config[tile.basis.key]).toBe(tile.basis.wired);
              // A wired witness mints launchpads; an unwired one mints setup.
              expect(tile.layer).toBe(tile.basis.wired ? "config_gated" : "setup");
              break;
            case "audit": {
              const basisHost = tile.basis.host;
              expect(
                inp.navigateEvents.some(
                  (e) =>
                    canonicalizeHost((e.payload.detail as { host: string }).host) === basisHost,
                ),
              ).toBe(true);
              break;
            }
          }
        }
      }
    }
  });

  it("recede: mind — wired ⇒ no connect-a-mind setup tile; unwired ⇒ present", () => {
    const wired = deriveHomeSeed(inputs({ config: { mind: true } }));
    expect(wired.tiles.find((t) => t.id === "setup-mind")).toBeUndefined();
    const bare = deriveHomeSeed(inputs({ config: { mind: false } }));
    expect(bare.tiles.find((t) => t.id === "setup-mind")).toBeDefined();
  });

  it("recede: relay — wired ⇒ no connect-a-relay setup tile; unwired ⇒ present and Find/Hire absent", () => {
    const wired = deriveHomeSeed(inputs({ config: { relay: true } }));
    expect(wired.tiles.find((t) => t.id === "setup-relay")).toBeUndefined();
    const off = deriveHomeSeed(inputs({ config: { relay: false } }));
    expect(off.tiles.find((t) => t.id === "setup-relay")).toBeDefined();
    expect(off.tiles.find((t) => t.id === "lp-find")).toBeUndefined();
    expect(off.tiles.find((t) => t.id === "lp-hire")).toBeUndefined();
  });

  it("recede: computer — unwired ⇒ Read-a-page absent (no setup tile: the computer wires itself)", () => {
    const off = deriveHomeSeed(inputs({ config: { computer: false } }));
    expect(off.tiles.find((t) => t.id === "lp-read")).toBeUndefined();
    // No setup affordance for `computer` — it is env-wired, not user-wired.
    expect(off.tiles.find((t) => t.id === "setup-computer")).toBeUndefined();
  });
});

describe("deriveHomeSeed — budget and phase arithmetic", () => {
  it("never exceeds TILE_BUDGET at any config point and any N", () => {
    for (const config of allConfigs()) {
      for (const n of [0, 1, 2, 3, 4, 5, 10]) {
        const seed = deriveHomeSeed(
          inputs({ config, hosts: Array.from({ length: n }, (_, i) => `site${i}.com`) }),
        );
        expect(seed.tiles.length).toBeLessThanOrEqual(TILE_BUDGET);
      }
    }
  });

  it("the intrinsic floor survives every phase — Set a goal is present at N=0 and N=10", () => {
    for (const n of [0, 2, 4, 10]) {
      const seed = deriveHomeSeed(
        inputs({ hosts: Array.from({ length: n }, (_, i) => `site${i}.com`) }),
      );
      expect(seed.tiles.find((t) => t.id === "lp-goal")).toBeDefined();
    }
  });

  it("phase boundary and launchpad recede are the same line: config-gated tiles exist iff phase !== resumption", () => {
    for (const n of [0, 1, 2, 3, 4]) {
      const seed = deriveHomeSeed(
        inputs({ hosts: Array.from({ length: n }, (_, i) => `site${i}.com`) }),
      );
      const expectedPhase = n === 0 ? "invitation" : n <= 2 ? "mixed" : "resumption";
      expect(seed.phase).toBe(expectedPhase);
      const hasConfigGated = seed.tiles.some((t) => t.layer === "config_gated");
      expect(hasConfigGated).toBe(expectedPhase !== "resumption");
    }
  });

  it("setup tiles are never crowded out by resumption", () => {
    const seed = deriveHomeSeed(
      inputs({
        config: { mind: false, relay: false },
        hosts: Array.from({ length: 10 }, (_, i) => `site${i}.com`),
      }),
    );
    expect(seed.tiles.filter((t) => t.layer === "setup")).toHaveLength(2);
    expect(seed.tiles.length).toBeLessThanOrEqual(TILE_BUDGET);
  });
});

describe("deriveHomeSeed — ingress honesty", () => {
  it("go_only when no mind is wired — a bare motebit never offers a chat that pretends to think", () => {
    expect(deriveHomeSeed(inputs({ config: { mind: false } })).ingressMode).toBe("go_only");
    expect(deriveHomeSeed(inputs({ config: { mind: true } })).ingressMode).toBe("ask_or_go");
  });
});

describe("deriveHomeSeed — promptless actions", () => {
  it("no tile action carries free text (surface-determinism, shape-enforced)", () => {
    for (const config of allConfigs()) {
      const seed = deriveHomeSeed(inputs({ config, hosts: ["a.com", "b.com", "c.com"] }));
      for (const tile of seed.tiles) {
        const keys = Object.keys(tile.action);
        // The only payload-bearing variants are navigate{url} and open_setup{key}.
        expect(keys.every((k) => k === "kind" || k === "url" || k === "key")).toBe(true);
      }
    }
  });
});

describe("resumption basis (moved from slab-home.ts — behavior preserved)", () => {
  it("dedups by canonical host, strips www, rejects TLD-less typos", () => {
    expect(canonicalizeHost("WWW.Google.com")).toBe("google.com");
    expect(canonicalizeHost("gmail")).toBeNull();
    expect(canonicalizeHost("localhost")).toBe("localhost");
    const affs = computeSlabHomeAffordances([
      navEvent("www.google.com", 3),
      navEvent("google.com", 2),
      navEvent("gmail", 1),
    ]);
    expect(affs).toHaveLength(1);
    expect(affs[0]!.host).toBe("google.com");
    expect(affs[0]!.lastEngagedAt).toBe(3);
  });
});
