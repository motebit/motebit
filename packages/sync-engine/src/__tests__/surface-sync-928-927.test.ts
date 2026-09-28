/**
 * #928 — no plaintext push from a surface that holds the sync key, and ONE
 * predicate for "is this payload encrypted".
 * #927 — the socket catch-up resolves its credential per request, refreshes
 * once on a refusal, and surfaces a failure instead of swallowing it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import {
  HttpEventStoreAdapter,
  WebSocketEventStoreAdapter,
  EncryptedEventStoreAdapter,
  InMemorySyncSeqCursorStore,
  PlaintextPushRefusedError,
  classifyEventPayload,
  decryptEventPayload,
  isEncryptedPayload,
  pullBySeq,
} from "../index.js";
import type { CredentialSource } from "../index.js";
import { FakeRelay } from "./fake-relay.js";

const MID = "motebit-zz928";
const KEY = new Uint8Array(32).fill(7);

function entry(
  id: string,
  clock: number,
  payload: Record<string, unknown> = { id },
): EventLogEntry {
  return {
    event_id: id,
    motebit_id: MID as EventLogEntry["motebit_id"],
    timestamp: 1_700_000_000_000 + clock,
    event_type: EventType.StateUpdated,
    payload,
    version_clock: clock,
    tombstoned: false,
  };
}

/** Every payload the relay stored, as JSON — what anyone with its database reads. */
function storedPayloads(relay: FakeRelay): string[] {
  return (relay as unknown as { rows: Array<{ event: EventLogEntry }> }).rows.map((r) =>
    JSON.stringify(r.event.payload),
  );
}

describe("#928 one encrypted-payload predicate", () => {
  it("classifies the envelope, plaintext, and the ambiguous middle", () => {
    expect(classifyEventPayload({ _encrypted: true, _data: "x" })).toBe("e2e");
    expect(classifyEventPayload({ a: 1 })).toBe("plaintext");
    expect(classifyEventPayload({ _encrypted: undefined, a: 1 })).toBe("plaintext");
    for (const bad of [
      { _encrypted: 1, _data: "x" },
      { _encrypted: "yes", _data: "x" },
      { _encrypted: false },
      { _encrypted: null },
      { _encrypted: true },
      { _encrypted: true, _data: 5 },
    ]) {
      expect(classifyEventPayload(bad)).toBe("malformed");
      expect(isEncryptedPayload(bad)).toBe(false);
    }
    expect(classifyEventPayload(null)).toBe("malformed");
    expect(classifyEventPayload("x")).toBe("malformed");
  });

  it("every decrypt path refuses a marker that is not the envelope — never decrypts it, never passes it as plaintext", async () => {
    const odd = entry("odd", 1, { _encrypted: 1, _data: "{}", secret: "s" });
    await expect(decryptEventPayload(odd, KEY)).rejects.toThrow(/not an E2E envelope/);
    const inner = new InMemoryEventStore();
    await inner.append(odd);
    const enc = new EncryptedEventStoreAdapter({ inner, key: KEY });
    await expect(enc.query({ motebit_id: MID as EventLogEntry["motebit_id"] })).rejects.toThrow(
      /not an E2E envelope/,
    );
    await expect(enc.decodeEvent(odd)).rejects.toThrow(/not an E2E envelope/);
  });

  it("a raw pull never applies a payload carrying the marker in any form", async () => {
    const relay = new FakeRelay();
    vi.stubGlobal("fetch", relay.fetch);
    try {
      relay.ingest(entry("odd", 1, { _encrypted: 1, _data: "{}" }));
      relay.ingest(entry("plain", 2));
      const local = new InMemoryEventStore();
      const out = await pullBySeq({
        source: new HttpEventStoreAdapter({
          baseUrl: relay.baseUrl,
          motebitId: MID,
          maxRetries: 0,
        }),
        localStore: local,
        cursorStore: new InMemorySyncSeqCursorStore(),
        motebitId: MID,
        fallbackAfterClock: 0,
      });
      expect(out.fresh.map((e) => e.event_id)).toEqual(["plain"]);
      expect(out.encryptedOnRawPath).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("#928 an e2e transport refuses plaintext before it leaves", () => {
  let relay: FakeRelay;
  beforeEach(() => {
    relay = new FakeRelay();
    vi.stubGlobal("fetch", vi.fn(relay.fetch));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("HTTP: a plaintext append is refused and nothing is sent; the encrypted wrapper passes", async () => {
    const http = new HttpEventStoreAdapter({
      baseUrl: relay.baseUrl,
      motebitId: MID,
      payloads: "e2e",
      maxRetries: 0,
    });
    await expect(http.append(entry("p", 1, { secret: "plain-zz928" }))).rejects.toBeInstanceOf(
      PlaintextPushRefusedError,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await new EncryptedEventStoreAdapter({ inner: http, key: KEY }).append(
      entry("c", 2, { secret: "plain-zz928" }),
    );
    const stored = storedPayloads(relay);
    expect(stored).toHaveLength(1);
    expect(stored.join()).not.toContain("plain-zz928");
  });

  it("HTTP raw mode (no key held) still pushes — the default is unchanged", async () => {
    const http = new HttpEventStoreAdapter({
      baseUrl: relay.baseUrl,
      motebitId: MID,
      maxRetries: 0,
    });
    await http.append(entry("p", 1));
    expect(storedPayloads(relay)).toHaveLength(1);
  });

  it("socket: a plaintext append rejects and is never queued", async () => {
    const ws = new WebSocketEventStoreAdapter({
      url: "ws://x/ws/sync/m",
      motebitId: MID,
      payloads: "e2e",
    });
    await expect(ws.append(entry("p", 1, { secret: "s" }))).rejects.toBeInstanceOf(
      PlaintextPushRefusedError,
    );
    expect(ws.takePendingEvents()).toEqual([]);
    await ws.append(entry("c", 2, { _encrypted: true, _data: "{}" }));
    expect(ws.takePendingEvents().map((e) => e.event_id)).toEqual(["c"]);
  });
});

// ---------------------------------------------------------------------------
// #927 — the catch-up credential
// ---------------------------------------------------------------------------

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  openAndAccept(): void {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "auth_result", ok: true }) });
  }
}

/**
 * A relay whose sync routes accept only an unexpired token (`tok:<expiresAt>`)
 * and answer an expired one 403, as `/sync/*` does for an expired signed token.
 */
class AuthedRelay extends FakeRelay {
  now = 0;
  refusals = 0;
  authed = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const header = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
    const m = /^Bearer tok:(\d+)$/.exec(header);
    if (!m || Number(m[1]) <= this.now) {
      this.refusals++;
      return new Response("Device not authorized", { status: 403, statusText: "Forbidden" });
    }
    return this.fetch(input, init);
  };
}

const TTL = 5 * 60_000;

describe("#927 the catch-up resolves its credential per request", () => {
  let relay: AuthedRelay;
  let originalWs: typeof globalThis.WebSocket;
  beforeEach(() => {
    relay = new AuthedRelay();
    vi.stubGlobal("fetch", relay.authed);
    MockWebSocket.instances = [];
    originalWs = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = originalWs;
    vi.unstubAllGlobals();
  });

  /** A socket catch-up over `http` into `local`; resolves when it finished (or failed). */
  async function catchUp(
    http: HttpEventStoreAdapter,
    local: InMemoryEventStore,
  ): Promise<{ pulled: number | null; errors: unknown[] }> {
    const errors: unknown[] = [];
    let pulled: number | null = null;
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const ws = new WebSocketEventStoreAdapter({
      url: "ws://relay/ws/sync/m",
      motebitId: MID,
      authToken: "socket-token",
      httpFallback: new EncryptedEventStoreAdapter({ inner: http, key: KEY }),
      localStore: local,
      seqCursorStore: cursors,
      onCatchUp: (n) => {
        pulled = n;
        done();
      },
      onCatchUpError: (err) => {
        errors.push(err);
        done();
      },
    });
    ws.connect();
    MockWebSocket.instances[MockWebSocket.instances.length - 1]!.openAndAccept();
    await finished;
    ws.disconnect();
    return { pulled, errors };
  }

  let cursors: InMemorySyncSeqCursorStore;
  beforeEach(() => {
    cursors = new InMemorySyncSeqCursorStore();
  });

  /** A sibling device writes an E2E event straight to the relay. */
  async function siblingWrites(id: string, clock: number): Promise<void> {
    const sib = new HttpEventStoreAdapter({
      baseUrl: relay.baseUrl,
      motebitId: MID,
      authToken: `tok:${relay.now + TTL}`,
      payloads: "e2e",
      maxRetries: 0,
    });
    await new EncryptedEventStoreAdapter({ inner: sib, key: KEY }).append(entry(id, clock));
  }

  it("token expires, then a sibling event: the catch-up with a provider delivers it", async () => {
    const provider: CredentialSource = {
      getCredential: vi.fn(async () => `tok:${relay.now + TTL}`),
    };
    const http = new HttpEventStoreAdapter({
      baseUrl: relay.baseUrl,
      motebitId: MID,
      credentialSource: provider,
      payloads: "e2e",
      maxRetries: 0,
    });
    const local = new InMemoryEventStore();

    await siblingWrites("a", 1);
    expect((await catchUp(http, local)).pulled).toBe(1);

    relay.now += 6 * 60_000; // past the first token's life
    await siblingWrites("b", 2);
    const second = await catchUp(http, local);
    expect(second.errors).toEqual([]);
    expect(second.pulled).toBe(1);
    const held = await local.query({ motebit_id: MID as EventLogEntry["motebit_id"] });
    expect(held.map((e) => e.event_id).sort()).toEqual(["a", "b"]);
    expect(held.find((e) => e.event_id === "b")!.payload).toEqual({ id: "b" });
  });

  it("TAMPER: a token captured once goes deaf after it expires — and the refusal is SURFACED", async () => {
    const http = new HttpEventStoreAdapter({
      baseUrl: relay.baseUrl,
      motebitId: MID,
      authToken: `tok:${relay.now + TTL}`,
      payloads: "e2e",
      maxRetries: 0,
    });
    const local = new InMemoryEventStore();
    await siblingWrites("a", 1);
    expect((await catchUp(http, local)).pulled).toBe(1);

    relay.now += 6 * 60_000;
    await siblingWrites("b", 2);
    const second = await catchUp(http, local);
    expect(second.pulled).toBeNull();
    expect(second.errors).toHaveLength(1);
    expect(String(second.errors[0])).toMatch(/403/);
    const held = await local.query({ motebit_id: MID as EventLogEntry["motebit_id"] });
    expect(held.map((e) => e.event_id)).toEqual(["a"]);
  });

  it("a refusal is met by asking the provider ONCE more; a persistent refusal is surfaced, not swallowed", async () => {
    // First answer stale, then fresh: one refresh cures it.
    let calls = 0;
    const flaky: CredentialSource = {
      getCredential: vi.fn(async () => (++calls === 1 ? "tok:0" : `tok:${relay.now + TTL}`)),
    };
    relay.now = 1;
    await siblingWrites("a", 1);
    const cured = await catchUp(
      new HttpEventStoreAdapter({
        baseUrl: relay.baseUrl,
        motebitId: MID,
        credentialSource: flaky,
        maxRetries: 0,
      }),
      new InMemoryEventStore(),
    );
    expect(cured.pulled).toBe(1);
    expect(flaky.getCredential).toHaveBeenCalledTimes(2);

    // Always refused: exactly one retry, then the error reaches onCatchUpError.
    const dead: CredentialSource = { getCredential: vi.fn(async () => "tok:0") };
    relay.refusals = 0;
    cursors = new InMemorySyncSeqCursorStore();
    const refused = await catchUp(
      new HttpEventStoreAdapter({
        baseUrl: relay.baseUrl,
        motebitId: MID,
        credentialSource: dead,
        maxRetries: 0,
      }),
      new InMemoryEventStore(),
    );
    expect(refused.errors).toHaveLength(1);
    expect(relay.refusals).toBe(2);
    expect(dead.getCredential).toHaveBeenCalledTimes(2);
  });

  it("with no onCatchUpError the failure is still reported (a warning), never silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const http = new HttpEventStoreAdapter({
        baseUrl: relay.baseUrl,
        motebitId: MID,
        authToken: "tok:0",
        maxRetries: 0,
      });
      const ws = new WebSocketEventStoreAdapter({
        url: "ws://relay/ws/sync/m",
        motebitId: MID,
        authToken: "socket-token",
        httpFallback: http,
        localStore: new InMemoryEventStore(),
        seqCursorStore: cursors,
      });
      ws.connect();
      MockWebSocket.instances[MockWebSocket.instances.length - 1]!.openAndAccept();
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/catch-up pull failed.*403/)),
      );
      ws.disconnect();
    } finally {
      warn.mockRestore();
    }
  });
});
