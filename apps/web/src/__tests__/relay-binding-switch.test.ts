/**
 * Web: Connect A, Disconnect, Connect B (design runtime-relay-binding rev 6,
 * section 5 test 8).
 *
 * The real WebApp and real runtime through `startSync` / `stopSync`; the
 * relays are a stubbed `fetch` on `.invalid` hosts and a fake WebSocket.
 * After Disconnect no new chat delegation or tap may reach A; after Connect B
 * both reach B only. Interleaved: Connect A whose relay-key fetch is held,
 * then Disconnect (or Connect B), then A's fetch is released — nothing may
 * bind to A.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@motebit/render-engine", async () => {
  const actual = await vi.importActual<object>("@motebit/render-engine");
  class Headless {
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
      return null;
    }
    dispose() {}
  }
  return {
    ...actual,
    ThreeJSAdapter: Headless,
    NullRenderAdapter: Headless,
    mountCredentialSatellites: () => null,
  };
});

vi.mock("../cursor-presence.js", () => ({
  CursorPresence: class {
    start() {}
    stop() {}
    getUpdates() {
      return { attention: 0.5, curiosity: 0.3, social_distance: 0.5 };
    }
  },
}));

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

vi.mock("../providers.js", () => ({
  createProvider: vi.fn(),
  WebLLMProvider: class {},
  PROXY_BASE_URL: "https://api.motebit.com",
}));

import { WebApp } from "../web-app.js";

const RELAY_A = "https://relay-a.invalid";
const RELAY_B = "https://relay-b.invalid";

/** A socket that opens and authenticates, and never carries anything else. */
class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { type: string };
    if (msg.type === "auth") {
      setTimeout(() => {
        if (this.readyState !== 1) return;
        this.onmessage?.({ data: JSON.stringify({ type: "auth_result", ok: true }) });
      }, 0);
    }
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

interface Req {
  relay: "A" | "B";
  method: string;
  path: string;
}
let requests: Req[];
/** Held relay-key fetches, by relay. */
let keyHolds: Map<"A" | "B", Array<() => void>>;
let holdKeyFor: Set<"A" | "B">;

beforeEach(() => {
  localStorage.clear();
  // The once-per-device onboarding self-test submits its own probe task to
  // the relay it starts on (it carries its own relay config, not the
  // runtime's delegation binding — outside part 4a). Marked done, so every
  // task request these tests see is a delegation call.
  localStorage.setItem("motebit:self-test-done", "true");
  requests = [];
  keyHolds = new Map();
  holdKeyFor = new Set();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const relay = url.startsWith(RELAY_A) ? "A" : url.startsWith(RELAY_B) ? "B" : null;
    if (relay == null) return new Response("", { status: 503 });
    const path = new URL(url).pathname;
    requests.push({ relay, method: init?.method ?? "GET", path });
    if (path === "/.well-known/motebit.json" && holdKeyFor.has(relay)) {
      holdKeyFor.delete(relay);
      await new Promise<void>((resolve) => {
        const list = keyHolds.get(relay) ?? [];
        list.push(resolve);
        keyHolds.set(relay, list);
      });
    }
    if (path === "/api/v1/agents/discover") {
      return new Response(JSON.stringify({ agents: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 503 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function booted(): Promise<WebApp> {
  const app = new WebApp();
  await app.init(null as unknown as HTMLCanvasElement);
  await app.bootstrap();
  return app;
}

function releaseKey(relay: "A" | "B"): void {
  for (const go of keyHolds.get(relay)?.splice(0) ?? []) go();
}

/** One chat delegation call and one tap, as the user would make them. */
async function delegateAndTap(app: WebApp): Promise<void> {
  const runtime = app.getRuntime()!;
  await runtime.getToolRegistry().execute("discover_agents", {});
  for await (const _c of runtime.invokeCapability("web_search", "search")) {
    // drain
  }
}

/**
 * Delegation requests from `mark` on (discovery and task submission/read) —
 * not sync, registration or serving plumbing, which part 4a does not move.
 */
function delegationRequests(mark: number): Req[] {
  return requests
    .slice(mark)
    .filter((r) => r.path === "/api/v1/agents/discover" || /^\/agent\/[^/]+\/task/.test(r.path));
}

describe("web relay switch (Connect A, Disconnect, Connect B)", () => {
  it("after Disconnect nothing new reaches A; after Connect B chat delegation and taps reach B only", async () => {
    const app = await booted();
    await app.startSync(RELAY_A);
    app.stopSync();

    const afterDisconnect = requests.length;
    await delegateAndTap(app);
    expect(delegationRequests(afterDisconnect).filter((r) => r.relay === "A")).toEqual([]);

    await app.startSync(RELAY_B);
    const afterB = requests.length;
    await delegateAndTap(app);
    const sent = delegationRequests(afterB);
    expect(sent.some((r) => r.path === "/api/v1/agents/discover")).toBe(true);
    expect(sent.some((r) => /^\/agent\/[^/]+\/task$/.test(r.path))).toBe(true);
    expect(sent.every((r) => r.relay === "B")).toBe(true);
    expect(delegationRequests(afterB).filter((r) => r.relay === "A")).toEqual([]);
    app.stopSync();
    app.stop();
  });

  it("Disconnect while Connect A is still fetching A's key: nothing binds to A", async () => {
    const app = await booted();
    holdKeyFor.add("A");
    const connecting = app.startSync(RELAY_A);
    await vi.waitFor(() => expect(keyHolds.get("A")?.length ?? 0).toBe(1));
    app.stopSync();
    releaseKey("A");
    await connecting.catch(() => {});

    const mark = requests.length;
    await delegateAndTap(app);
    expect(delegationRequests(mark).filter((r) => r.relay === "A")).toEqual([]);
    expect(app.getRuntime()!.getDelegationRelay()).toBeNull();
    app.stop();
  });

  it("Connect B while Connect A is still fetching A's key: everything stays on B", async () => {
    const app = await booted();
    holdKeyFor.add("A");
    const connectingA = app.startSync(RELAY_A);
    await vi.waitFor(() => expect(keyHolds.get("A")?.length ?? 0).toBe(1));
    await app.startSync(RELAY_B);
    releaseKey("A");
    await connectingA.catch(() => {});

    const mark = requests.length;
    await delegateAndTap(app);
    const sent = delegationRequests(mark);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((r) => r.relay === "A")).toEqual([]);
    expect(app.getRuntime()!.getDelegationRelay()?.url).toBe(RELAY_B);
    app.stopSync();
    app.stop();
  });
});
