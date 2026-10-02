/**
 * #962 C2 / P1 — web's `syncConfigured` wiring, read from the runtime
 * `WebApp.bootstrap` constructs (the runtime's own answer, as compaction
 * reads it), and the relay URL persisted whenever sync starts (pairing did
 * not save it, so after a reload compaction forgot the relay).
 *
 * The WebApp harness (render-engine, cursor, keystore, provider stubs) is the
 * one `web-app.test.ts` uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebApp } from "../web-app.js";
import { isSyncUrlConfigured, loadSyncUrl, saveSyncUrl } from "../storage.js";

// Stub ThreeJSAdapter — WebApp creates one internally (requires canvas)
vi.mock("@motebit/render-engine", () => {
  class MockThreeJSAdapter {
    init() {
      return Promise.resolve();
    }
    render() {}
    getSpec() {
      return {};
    }
    resize() {}
    setBackground() {}
    setDarkEnvironment() {}
    setLightEnvironment() {}
    setInteriorColor() {}
    setAudioReactivity() {}
    setTrustMode() {}
    setListeningIndicator() {}
    enableOrbitControls() {}
    getCreatureGroup() {
      // Headless tests have no scene graph — mountCredentialSatellites
      // returns null and the web-app renders without satellites.
      return null;
    }
    dispose() {}
  }
  class MockCredentialSatelliteRenderer {
    setExpression() {}
    tick() {}
    dispose() {}
  }
  // Slab default-embodiment mapping is a pure function in spec.ts.
  // SlabController imports it at module load via @motebit/render-engine;
  // the test mock must export it so `createSlabController(...)` (called
  // from MotebitRuntime's constructor) can construct without throwing.
  // Mirrors real behavior — default is tool_result for tool_call / shell /
  // fetch kinds, mind for stream / plan_step / embedding / memory, and
  // peer_viewport for delegation.
  function defaultEmbodimentMode(kind: string): string {
    switch (kind) {
      case "stream":
      case "plan_step":
      case "embedding":
      case "memory":
        return "mind";
      case "tool_call":
      case "shell":
      case "fetch":
        return "tool_result";
      case "delegation":
        return "peer_viewport";
      default:
        return "tool_result";
    }
  }
  // Mode-contract typed const — `SlabController.checkContractAnomaly`
  // looks this up on every terminal-phase transition. The mock must
  // export it (or the lookup fails with "EMBODIMENT_MODE_CONTRACTS
  // is undefined" once the controller exercises a rest/dissolve/
  // detach). Mirror the canonical const from
  // `packages/render-engine/src/spec.ts`; if the canonical value
  // changes, this mock must move with it (sibling discipline).
  const EMBODIMENT_MODE_CONTRACTS = {
    mind: {
      driver: "self",
      observer: "self",
      source: "interior",
      consent: "always-permitted",
      sensitivity: "all-tiers",
      lifecycleDefaults: ["dissolving", "resting", "detached"],
    },
    tool_result: {
      driver: "motebit",
      observer: "user",
      source: "sandboxed-tool",
      consent: "per-action",
      sensitivity: "tier-bounded-by-tool",
      lifecycleDefaults: ["resting", "dissolving"],
    },
    virtual_browser: {
      driver: "motebit",
      observer: "user",
      source: "isolated-browser",
      consent: "session-scoped",
      sensitivity: "tier-bounded-by-source",
      lifecycleDefaults: ["resting", "detached"],
    },
    shared_gaze: {
      driver: "user",
      observer: "motebit",
      source: "user-source",
      consent: "per-source",
      sensitivity: "tier-bounded-by-source",
      lifecycleDefaults: ["resting", "detached", "dissolving"],
    },
    desktop_drive: {
      driver: "motebit",
      observer: "user",
      source: "real-os",
      consent: "per-action",
      sensitivity: "all-tiers",
      lifecycleDefaults: ["resting", "detached"],
    },
    peer_viewport: {
      driver: "peer",
      observer: "motebit",
      source: "peer-receipt",
      consent: "signed-delegation",
      sensitivity: "tier-bounded-by-source",
      lifecycleDefaults: ["resting", "detached"],
    },
  } as const;
  return {
    ThreeJSAdapter: MockThreeJSAdapter,
    NullRenderAdapter: MockThreeJSAdapter,
    CredentialSatelliteRenderer: MockCredentialSatelliteRenderer,
    credentialsToExpression: () => ({ kind: "satellite", items: [] }),
    // Headless tests have no scene graph — the helper returns null and
    // the web-app renders without satellites (same contract as when
    // getCreatureGroup() returns null).
    mountCredentialSatellites: () => null,
    defaultEmbodimentMode,
    EMBODIMENT_MODE_CONTRACTS,
  };
});

// Stub CursorPresence — needs window/document
vi.mock("../cursor-presence.js", () => ({
  CursorPresence: class {
    start() {}
    stop() {}
    getUpdates() {
      return { attention: 0.5, curiosity: 0.3, social_distance: 0.5 };
    }
  },
}));

// Stub EncryptedKeyStore — needs WebCrypto
vi.mock("../encrypted-keystore.js", () => ({
  EncryptedKeyStore: class {
    private key: string | null = null;
    async storePrivateKey(hex: string) {
      this.key = hex;
    }
    async loadPrivateKey() {
      return this.key;
    }
  },
}));

// Mock provider module — avoid importing real WebLLM
vi.mock("../providers.js", () => ({
  createProvider: vi.fn().mockReturnValue({
    generateStream: vi.fn(),
    generate: vi.fn(),
    setModel: vi.fn(),
    getModel: vi.fn().mockReturnValue("mock-model"),
  }),
  WebLLMProvider: class {},
  PROXY_BASE_URL: "https://api.motebit.com",
}));

const RELAY = "https://relay.zz962web.test";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function booted(): Promise<WebApp> {
  const app = new WebApp();
  await app.init(null as unknown as HTMLCanvasElement);
  await app.bootstrap();
  return app;
}

describe("#962 — WebApp's syncConfigured", () => {
  it("no saved relay: not configured", async () => {
    const app = await booted();
    try {
      expect(await app.getRuntime()!.isSyncConfigured()).toBe(false);
    } finally {
      app.stop();
    }
  });

  it("a saved relay is read at compaction time: configured", async () => {
    const app = await booted();
    try {
      saveSyncUrl(RELAY);
      expect(await app.getRuntime()!.isSyncConfigured()).toBe(true);
    } finally {
      app.stop();
    }
  });

  it("storage that cannot be read counts as configured (fail closed)", async () => {
    const app = await booted();
    try {
      vi.spyOn(localStorage, "getItem").mockImplementation(() => {
        throw new Error("SecurityError: storage blocked");
      });
      expect(await app.getRuntime()!.isSyncConfigured()).toBe(true);
    } finally {
      vi.restoreAllMocks();
      app.stop();
    }
  });

  it("P1: starting sync persists the relay URL before anything is pushed (the pairing path)", async () => {
    const app = await booted();
    try {
      // The relay is unreachable: sync start fails — the relay may still
      // hold pushes from here on, so it must be remembered.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("offline");
        }),
      );
      expect(loadSyncUrl()).toBeNull();
      await app.startSync(RELAY).catch(() => {});
      expect(loadSyncUrl()).toBe(RELAY);
      expect(await app.getRuntime()!.isSyncConfigured()).toBe(true);
    } finally {
      app.stop();
    }
  });
});

describe("#962 P1 — isSyncUrlConfigured (storage)", () => {
  it("answers from the saved URL", () => {
    expect(isSyncUrlConfigured()).toBe(false);
    saveSyncUrl("");
    expect(isSyncUrlConfigured()).toBe(false);
    saveSyncUrl(RELAY);
    expect(isSyncUrlConfigured()).toBe(true);
  });

  it("fails closed when storage throws, where loadSyncUrl answers null", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage blocked");
    });
    expect(loadSyncUrl()).toBeNull();
    expect(isSyncUrlConfigured()).toBe(true);
  });
});
