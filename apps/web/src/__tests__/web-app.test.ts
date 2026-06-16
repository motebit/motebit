/**
 * WebApp integration tests — bootstrap, provider management, streaming chat,
 * conversation lifecycle, MCP management, identity, goals.
 *
 * Uses fake-indexeddb + localStorage polyfill (from setup.ts) to test
 * the full app lifecycle without a browser or canvas.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebApp, COLOR_PRESETS } from "../web-app.js";
import type { StreamChunk } from "@motebit/runtime";

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

beforeEach(() => {
  localStorage.clear();
  // No IDB cleanup. Web persists everything to a single `"motebit"` database
  // (opened by createBrowserStorage → openMotebitDB) plus a `"motebit-keystore"`
  // database for encrypted credentials. Both are robust to test reuse:
  //   - `"motebit"` schema upgrades are idempotent and bootstrap re-derives
  //     state from the test's localStorage / motebit_id, so persistent IDB
  //     content from earlier tests doesn't interfere.
  //   - `"motebit-keystore"` is never actually opened here because
  //     `EncryptedKeyStore` is mocked above (line 48).
  // Earlier versions of this hook called `deleteDatabase` on ten fictitious
  // names (`motebit-events`, `motebit-memory`, …) that never existed —
  // those were no-ops. Calling it on the real `"motebit"` would block on
  // open connections from the previous test. Removing the cleanup entirely
  // is the honest answer: the tests don't need it, and pretending to clean
  // up was misleading.
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebApp lifecycle", () => {
  it("init succeeds without real canvas", async () => {
    const app = new WebApp();
    // ThreeJSAdapter is mocked — init accepts anything
    await app.init(null as unknown as HTMLCanvasElement);
    app.stop();
  });

  it("bootstrap creates cryptographic identity", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    // Identity should be populated
    expect(app.motebitId).toBeTruthy();
    expect(app.motebitId.length).toBeGreaterThan(10);
    expect(app.deviceId).toBeTruthy();
    expect(app.publicKeyHex).toBeTruthy();
    expect(app.publicKeyHex.length).toBe(64); // Ed25519 public key = 32 bytes = 64 hex chars

    // Identity persisted in localStorage
    expect(localStorage.getItem("motebit:motebit_id")).toBe(app.motebitId);
    expect(localStorage.getItem("motebit:device_id")).toBe(app.deviceId);
    expect(localStorage.getItem("motebit:device_public_key")).toBe(app.publicKeyHex);

    app.stop();
  });

  it("bootstrap is idempotent — same identity on second call", async () => {
    const app1 = new WebApp();
    await app1.init(null as unknown as HTMLCanvasElement);
    await app1.bootstrap();
    const id1 = app1.motebitId;
    app1.stop();

    const app2 = new WebApp();
    await app2.init(null as unknown as HTMLCanvasElement);
    await app2.bootstrap();
    const id2 = app2.motebitId;
    app2.stop();

    expect(id1).toBe(id2);
  });

  it("runtime is available after bootstrap", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    expect(app.getRuntime()).not.toBeNull();
    expect(app.isProviderConnected).toBe(false); // No provider connected yet

    app.stop();
  });

  it("stop cleans up intervals and runtime", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    app.stop();

    // Runtime is stopped — getRuntime() still returns the instance but it's stopped
    expect(app.getRuntime()).not.toBeNull();
  });
});

describe("Provider management", () => {
  it("reports no provider connected initially", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    expect(app.isProviderConnected).toBe(false);
    app.stop();
  });

  it("connects a provider via config", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    // connectProvider calls createProvider internally then setProvider on runtime.
    // In test env, AnthropicProvider may not construct fully (missing fetch polyfill for proxy URL).
    // Verify the codepath works by spying on the runtime's setProvider.
    const runtime = app.getRuntime()!;
    const spy = vi.spyOn(runtime, "setProvider");
    app.connectProvider({
      mode: "byok",
      vendor: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "sk-test",
    });
    expect(spy).toHaveBeenCalledOnce();
    // Provider was passed to runtime — the AnthropicProvider instance may not fully
    // wire loopDeps in test env, but the codepath is exercised.

    app.stop();
  });

  it("connects a provider directly", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    const mockProvider = {
      generateStream: vi.fn(),
      generate: vi.fn(),
      setModel: vi.fn(),
      getModel: vi.fn().mockReturnValue("test-model"),
    };
    app.setProviderDirect(mockProvider as never);
    expect(app.isProviderConnected).toBe(true);

    app.stop();
  });
});

describe("BYOK auto-routing — integration", () => {
  // Closes the audit-named integration gap on the auto-routing PR 2
  // arc (`docs/doctrine/auto-routing-as-protocol-primitive.md` § "PR
  // 2 — BYOK consumer"). Drift gate `check-routing-decision-coverage`
  // verifies the consumer site IMPORTS the dispatcher + references
  // every decision kind; unit tests cover the dispatcher's pure
  // logic. Neither catches the integration shape: "BYOK config with
  // autoRoute=true → sendMessageStreaming → provider.setModel was
  // called with the dispatcher's pick." A future regression that
  // silently disconnected the intercept from the provider would
  // pass both layers but break the live behavior. These tests pin
  // the integration.

  it("mutates provider.setModel per turn when BYOK autoRoute is on", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    // Capture the mocked StreamingProvider's setModel spy. The
    // module mock above returns a fresh-each-call object but vi.fn
    // is reset each test by `vi.restoreAllMocks` in afterEach.
    const providers = await import("../providers.js");
    const setModelSpy = vi.fn();
    vi.mocked(providers.createProvider).mockReturnValue({
      generateStream: vi.fn(),
      generate: vi.fn(),
      setModel: setModelSpy,
      getModel: vi.fn().mockReturnValue("anthropic-default"),
    } as never);

    // Connect Anthropic BYOK with autoRoute. The dispatcher's
    // Anthropic catalog includes claude-sonnet-4-6 (the canonical
    // policy's "chat" preference); a chat-shaped message should
    // route to it.
    app.connectProvider({
      mode: "byok",
      vendor: "anthropic",
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
      autoRoute: true,
    });

    // The runtime mock setup doesn't fully wire streaming so we
    // can't await the full generator without setProvider plumbing
    // through to ai-core. The intercept runs BEFORE the runtime
    // forward, so we only need to invoke the wrapper and let it
    // throw on the runtime side — the setModel assertion fires
    // first regardless of downstream errors.
    const chatMessage =
      "I'd like to understand your perspective on this approach. " +
      "What do you think makes the most sense given the constraints?";
    try {
      for await (const _chunk of app.sendMessageStreaming(chatMessage)) {
        // Drain — the runtime mock may yield nothing or throw.
      }
    } catch {
      // Expected — the runtime mock doesn't fully wire the stream.
      // The intercept-before-forward shape means setModel still
      // fires before the throw, which is the invariant the test
      // pins.
    }

    // The doctrine-stated payoff: dispatcher.dispatch ran, decision
    // was `route` (catalog has claude-sonnet-4-6 for the chat
    // preference), provider.setModel got the pick.
    expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-6");

    app.stop();
  });

  it("routes code-shape messages to gpt-5.4's fallback (claude-opus-4-7) on Anthropic catalog", async () => {
    // REFERENCE_ROUTING_POLICY.code = "gpt-5.4"; Anthropic catalog
    // doesn't have it → dispatcher returns `fallback` with backup =
    // claude-opus-4-7 (first catalog entry, tier-strong-to-fast).
    // The intercept's `fallback` arm calls setModel(backup).
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    const providers = await import("../providers.js");
    const setModelSpy = vi.fn();
    vi.mocked(providers.createProvider).mockReturnValue({
      generateStream: vi.fn(),
      generate: vi.fn(),
      setModel: setModelSpy,
      getModel: vi.fn().mockReturnValue("anthropic-default"),
    } as never);

    app.connectProvider({
      mode: "byok",
      vendor: "anthropic",
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
      autoRoute: true,
    });

    try {
      for await (const _chunk of app.sendMessageStreaming("```js\nlet x = 1\n```")) {
        // Drain.
      }
    } catch {
      /* Expected — runtime mock doesn't fully wire. */
    }

    expect(setModelSpy).toHaveBeenCalledWith("claude-opus-4-7");

    app.stop();
  });

  it("does NOT call setModel when BYOK autoRoute is off (backward-compat default)", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    const providers = await import("../providers.js");
    const setModelSpy = vi.fn();
    vi.mocked(providers.createProvider).mockReturnValue({
      generateStream: vi.fn(),
      generate: vi.fn(),
      setModel: setModelSpy,
      getModel: vi.fn().mockReturnValue("anthropic-default"),
    } as never);

    app.connectProvider({
      mode: "byok",
      vendor: "anthropic",
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
      // autoRoute omitted (default false) — backward-compat path.
    });

    try {
      for await (const _chunk of app.sendMessageStreaming("hello")) {
        /* Drain. */
      }
    } catch {
      /* Expected. */
    }

    // The user's configured model stands — no per-turn mutation.
    expect(setModelSpy).not.toHaveBeenCalled();

    app.stop();
  });
});

describe("Streaming chat", () => {
  it("throws when runtime not initialized", async () => {
    const app = new WebApp();
    await expect(async () => {
      for await (const _chunk of app.sendMessageStreaming("test")) {
        // Should not reach here
      }
    }).rejects.toThrow("Runtime not initialized");
  });

  it("throws when no provider connected", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    await expect(async () => {
      for await (const _chunk of app.sendMessageStreaming("test")) {
        // Should not reach here
      }
    }).rejects.toThrow("No provider connected");

    app.stop();
  });

  it("streams response chunks from provider", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    // Wire a mock streaming provider that yields text chunks + done
    const mockProvider = {
      generateStream: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "Hello " };
        yield { type: "text", text: "world" };
        yield {
          type: "done",
          response: {
            text: "Hello world",
            confidence: 0.9,
            memory_candidates: [],
            state_updates: {},
          },
        };
      }),
      generate: vi.fn(),
      setModel: vi.fn(),
      getModel: vi.fn().mockReturnValue("test-model"),
    };
    app.setProviderDirect(mockProvider as never);

    const chunks: StreamChunk[] = [];
    for await (const chunk of app.sendMessageStreaming("greet me")) {
      chunks.push(chunk);
    }

    // Should have received text chunks + turn_end
    expect(chunks.length).toBeGreaterThan(0);
    expect(app.isProcessing).toBe(false);

    app.stop();
  });

  it("prevents concurrent message processing", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    const mockProvider = {
      generateStream: vi.fn().mockImplementation(async function* () {
        yield { type: "text", text: "done" };
        yield {
          type: "done",
          response: {
            text: "done",
            confidence: 0.9,
            memory_candidates: [],
            state_updates: {},
          },
        };
      }),
      generate: vi.fn(),
      setModel: vi.fn(),
      getModel: vi.fn().mockReturnValue("test-model"),
    };
    app.setProviderDirect(mockProvider as never);

    // Directly set the processing flag to simulate an in-flight message
    (app as unknown as { _isProcessing: boolean })._isProcessing = true;

    // Second message should fail with "Already processing"
    await expect(async () => {
      for await (const _chunk of app.sendMessageStreaming("second")) {
        // noop
      }
    }).rejects.toThrow("Already processing");

    // Reset flag
    (app as unknown as { _isProcessing: boolean })._isProcessing = false;

    app.stop();
  });
});

describe("Conversation management", () => {
  it("starts with empty conversation history", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    expect(app.getConversationHistory()).toEqual([]);
    expect(app.activeConversationId).toBeNull();

    app.stop();
  });

  it("lists conversations", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    const convs = app.listConversations();
    expect(Array.isArray(convs)).toBe(true);

    app.stop();
  });

  it("resets conversation", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    app.resetConversation();
    expect(app.getConversationHistory()).toEqual([]);

    app.stop();
  });
});

describe("Appearance", () => {
  it("sets interior color by preset name", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);

    app.setInteriorColor("violet");
    expect(app.getInteriorColor()).toEqual(COLOR_PRESETS["violet"]);
  });

  it("ignores unknown preset names", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);

    app.setInteriorColor("nonexistent");
    expect(app.getInteriorColor()).toBeNull();
  });

  it("sets custom interior color directly", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);

    const custom = {
      tint: [0.5, 0.6, 0.7] as [number, number, number],
      glow: [0.1, 0.2, 0.3] as [number, number, number],
    };
    app.setInteriorColorDirect(custom);
    expect(app.getInteriorColor()).toEqual(custom);
  });

  it("has all expected color presets", () => {
    expect(Object.keys(COLOR_PRESETS)).toEqual(
      expect.arrayContaining(["moonlight", "amber", "rose", "violet", "cyan", "ember", "sage"]),
    );
    expect(Object.keys(COLOR_PRESETS)).toHaveLength(7);
  });
});

describe("MCP management", () => {
  it("rejects stdio transport in browser", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    await expect(
      app.addMcpServer({ name: "test", transport: "stdio", command: "echo" }),
    ).rejects.toThrow("Web only supports HTTP MCP servers");

    app.stop();
  });

  it("rejects HTTP server without URL", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    await expect(app.addMcpServer({ name: "test", transport: "http" })).rejects.toThrow(
      "HTTP MCP server requires a url",
    );

    app.stop();
  });

  it("starts with no MCP servers", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    expect(app.getMcpServers()).toEqual([]);

    app.stop();
  });
});

describe("Sync status", () => {
  it("starts offline", async () => {
    const app = new WebApp();
    expect(app.syncStatus).toBe("offline");
  });

  it("notifies listeners on status change", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    const statuses: string[] = [];
    const unsub = app.onSyncStatusChange((s) => statuses.push(s));

    // stopSync triggers "disconnected"
    app.stopSync();
    expect(statuses).toContain("disconnected");

    unsub();
    app.stop();
  });

  it("throws when starting sync without runtime", async () => {
    const app = new WebApp();
    await expect(app.startSync("https://relay.example.com")).rejects.toThrow(
      "Runtime not initialized",
    );
  });
});

describe("Goals", () => {
  it("throws when executing goal without runtime", async () => {
    const app = new WebApp();
    await expect(async () => {
      for await (const _chunk of app.executeGoal("g1", "test")) {
        // noop
      }
    }).rejects.toThrow("Runtime not initialized");
  });

  it("throws when executing goal without provider", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    await expect(async () => {
      for await (const _chunk of app.executeGoal("g1", "test")) {
        // noop
      }
    }).rejects.toThrow("No provider connected");

    app.stop();
  });
});

describe("Render frame", () => {
  it("renders idle cues before bootstrap", () => {
    const app = new WebApp();
    // Should not throw — renders idle cues without runtime
    app.renderFrame(0.016, 1.0);
  });

  it("renders via runtime after bootstrap", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    // Should not throw — delegates to runtime
    app.renderFrame(0.016, 1.0);

    app.stop();
  });
});

describe("Housekeeping", () => {
  it("runs without error after bootstrap", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();

    // Housekeeping is best-effort — should not throw
    await app.housekeeping();

    app.stop();
  });
});

// Phase 3 of the persistent user_data_dir arc — the user-control
// affordance over motebit's accumulated browsing trust. These tests
// pin the WebApp public methods the `/cookies` slash command consumes.
// Encryption-at-rest is exercised in encrypted-cookie-store.test.ts;
// this file pins the integration with the in-memory cache.
describe("Persisted cookies (Phase 3 — /cookies status + revoke)", () => {
  it("getPersistedCookies returns [] pre-bootstrap (no motebitId yet)", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    // No bootstrap call — motebitId is empty.
    const cookies = await app.getPersistedCookies();
    expect(cookies).toEqual([]);
    app.stop();
  });

  it("getPersistedCookies returns [] cold-start after bootstrap", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();
    const cookies = await app.getPersistedCookies();
    expect(cookies).toEqual([]);
    app.stop();
  });

  it("clearPersistedCookies on cold-start is a no-op returning []", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();
    const cleared = await app.clearPersistedCookies();
    expect(cleared).toEqual([]);
    // Still empty after clear.
    expect(await app.getPersistedCookies()).toEqual([]);
    app.stop();
  });

  it("clearPersistedCookies wipes the encrypted store + in-memory cache", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();
    const motebitId = app.motebitId;

    // Seed the encrypted store directly — simulates a prior cloud
    // session having persisted cookies via onCookiesPersisted.
    const { saveCookies } = await import("../encrypted-cookie-store.js");
    await saveCookies(motebitId, [
      {
        name: "session_id",
        value: "abc123",
        domain: ".google.com",
        path: "/",
      },
      {
        name: "captcha_cleared",
        value: "true",
        domain: ".google.com",
        path: "/",
      },
      {
        name: "gh_session",
        value: "xyz789",
        domain: ".github.com",
        path: "/",
      },
    ]);

    // Need a fresh WebApp so the lazy-load gate fires against the
    // newly-seeded store (the current app's gate may have already
    // resolved to [] from this test's earlier setup).
    app.stop();
    const app2 = new WebApp();
    await app2.init(null as unknown as HTMLCanvasElement);
    await app2.bootstrap();

    // Status: holding 3 cookies across 2 domains.
    const status = await app2.getPersistedCookies();
    expect(status).toHaveLength(3);

    // Revoke: returns snapshot of what was cleared, leaves store empty.
    const cleared = await app2.clearPersistedCookies();
    expect(cleared).toHaveLength(3);
    expect(await app2.getPersistedCookies()).toEqual([]);

    // Subsequent reads from disk also return [] (the at-rest store
    // was actually cleared, not just the in-memory cache).
    app2.stop();
    const app3 = new WebApp();
    await app3.init(null as unknown as HTMLCanvasElement);
    await app3.bootstrap();
    expect(await app3.getPersistedCookies()).toEqual([]);
    app3.stop();
  });

  // Phase 2 trust-visibility post-fix invariant: every write to the
  // persisted-cookies cache MUST trigger a chrome refresh so the
  // cobrowse pip stays coherent with state. Before this invariant
  // landed, `/cookies revoke` cleared the cache but left the pip
  // visible until the next chrome refresh fired from a different
  // path (navigate, sensitivity change). Runtime-invariants-over-
  // prompt-rules doctrine: the setter bundles state + refresh so
  // the bug is structurally impossible.
  it("clearPersistedCookies triggers refreshSlabChrome (Phase 2 visibility invariant)", async () => {
    const app = new WebApp();
    await app.init(null as unknown as HTMLCanvasElement);
    await app.bootstrap();
    const spy = vi.spyOn(app, "refreshSlabChrome");
    await app.clearPersistedCookies();
    // Note: clearPersistedCookies internally calls
    // ensureCookieStoreLoaded → setPersistedCookies(loadedCookies),
    // then setPersistedCookies([]). Both setter calls trigger
    // refresh, so the spy is called at least twice on the first
    // revoke. The invariant is "at least one refresh fired per
    // cache write," not exactly-N.
    expect(spy).toHaveBeenCalled();
    app.stop();
  });
});

describe("WebApp.announceMotebit — sovereign-binding skip is terminal, not cached", () => {
  // The exact shape of the 2026-06-15 legacy production account (version
  // nibble 7) — never the sovereign commitment to any key.
  const LEGACY_V7_ID = "019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb";

  it("an unbound id skips (no fetch, isAnnounced stays false); a later BOUND id announces", async () => {
    const app = new WebApp();
    await app.bootstrap(); // mints a sovereign-bound id + a loadable signing key
    const boundId = app.motebitId;
    expect(localStorage.getItem("motebit-announced")).toBeNull();

    // Force the legacy/unbound case: keep the real key, swap in a non-committing
    // id. verifySovereignBinding(v7, realKey) is false → the preflight skips.
    (app as unknown as { _motebitId: string })._motebitId = LEGACY_V7_ID;
    const skipFetch = vi.fn();
    vi.stubGlobal("fetch", skipFetch);

    const skipped = await app.announceMotebit();
    expect(skipped.status).toBe("skipped");
    // Terminal + benign: no descriptor GET, no announce POST...
    expect(skipFetch).not.toHaveBeenCalled();
    // ...and markAnnounced was NOT called, so the state is not cached as done.
    expect(localStorage.getItem("motebit-announced")).toBeNull();

    // Restore the genuinely sovereign-bound identity → a later attempt is no
    // longer skipped; it announces and only THEN marks announced.
    (app as unknown as { _motebitId: string })._motebitId = boundId;
    const okFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/.well-known/motebit.json")) {
        return new Response(JSON.stringify({ relay_id: "relay-x" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ ok: true, announced_at: 1_700_000_000_000, first_seen: true }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", okFetch);

    const announced = await app.announceMotebit();
    expect(announced.status).toBe("announced");
    expect(okFetch).toHaveBeenCalled();
    expect(localStorage.getItem("motebit-announced")).toBe("1");
  });
});
