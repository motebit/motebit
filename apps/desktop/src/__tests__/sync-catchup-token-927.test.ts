/**
 * #927 — desktop's socket catch-up is its ONLY pull door (the sync engine's
 * remote is the socket adapter, whose `query` returns nothing). It used to
 * hold the first `sync` token for the whole session: the socket was rebuilt
 * with a fresh token every 4.5 minutes, the catch-up adapter was not, so
 * from the first refresh after the token expired every catch-up was refused
 * and the refusal swallowed — sibling events stopped arriving, silently.
 *
 * Real controller, real `@motebit/sync-engine` + `@motebit/encryption`, a
 * relay stand-in whose `/sync` routes refuse an expired token with 403 (what
 * the relay answers an expired signed token). Only time is faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryEventStore } from "@motebit/event-log";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { EncryptedEventStoreAdapter, isEncryptedPayload } from "@motebit/sync-engine";
import { deriveSyncEncryptionKey } from "@motebit/encryption";

vi.mock("@motebit/runtime", async () => {
  const actual = await vi.importActual<object>("@motebit/runtime");
  return {
    ...actual,
    cmdSelfTest: vi.fn(async () => ({ summary: "ok", data: { status: "passed" } })),
  };
});

vi.mock("../tauri-sync-adapters.js", () => ({
  TauriConversationSyncStoreAdapter: class {},
  TauriPlanSyncStoreAdapter: class {},
}));

import { SyncController } from "../sync-controller";
import type { SyncControllerDeps, SyncStatusEvent } from "../sync-controller";

const MID = "motebit-zz927";
const PRIV_HEX = "b".repeat(64);
const TTL = 5 * 60_000;
const REFRESH_MS = 4.5 * 60_000;

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
      setTimeout(
        () => this.onmessage?.({ data: JSON.stringify({ type: "auth_result", ok: true }) }),
        0,
      );
    }
  }
  close(): void {
    this.readyState = 3;
  }
}

/** The relay's event log and its `/sync` door, which refuses an expired token. */
class Relay {
  events: Array<{ seq: number; event: EventLogEntry }> = [];
  refused = 0;
  add(e: EventLogEntry): void {
    this.events.push({ seq: this.events.length + 1, event: e });
  }
  fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/sync/")) return new Response("n/a", { status: 503 });
    const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
    const m = /^Bearer tok:(\d+)$/.exec(auth);
    if (!m || Number(m[1]) <= Date.now()) {
      this.refused++;
      return new Response("Device not authorized", { status: 403, statusText: "Forbidden" });
    }
    const op = url.pathname.split("/")[3];
    if (op === "pull") {
      const after = Number(url.searchParams.get("after_seq") ?? "0");
      const page = this.events.filter((r) => r.seq > after);
      const latest = this.events.length;
      return Response.json({
        events: page.map((r) => ({ ...r.event, seq: r.seq })),
        next_seq: page.length ? page[page.length - 1]!.seq : after,
        has_more: false,
        latest_seq: latest,
      });
    }
    if (op === "clock") return Response.json({ latest_clock: 0 });
    return new Response("n/a", { status: 404 });
  };
}

let relay: Relay;
let statuses: SyncStatusEvent[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the runtime surface startSync touches
function makeRuntime(): any {
  return {
    connectSync: vi.fn(),
    startSync: vi.fn(),
    enableInteractiveDelegation: vi.fn(),
    sync: { onStatusChange: vi.fn(() => () => {}), getConflicts: vi.fn(() => []), stop: vi.fn() },
  };
}

function makeDeps(local: InMemoryEventStore): SyncControllerDeps {
  return {
    getRuntime: () => makeRuntime() as never,
    getMotebitId: () => MID,
    getDeviceId: () => "device-zz927",
    getConversationStore: () => null,
    getPlanStore: () => null,
    getLocalEventStore: () => local,
    getDeviceKeypair: async () => ({ publicKey: "a".repeat(64), privateKey: PRIV_HEX }),
    // A signed token lives five minutes from its mint.
    createSyncToken: async () => `tok:${Date.now() + TTL}`,
  };
}

/** A sibling device writes an E2E event under the same identity's sync key. */
async function siblingWrites(id: string, clock: number): Promise<void> {
  const key = await deriveSyncEncryptionKey(
    new Uint8Array(PRIV_HEX.match(/../g)!.map((h) => parseInt(h, 16))),
  );
  const sib = new InMemoryEventStore();
  await new EncryptedEventStoreAdapter({ inner: sib, key }).append({
    event_id: id,
    motebit_id: MID as EventLogEntry["motebit_id"],
    timestamp: Date.now(),
    event_type: EventType.StateUpdated,
    payload: { from: "sibling", id },
    version_clock: clock,
    tombstoned: false,
  });
  const [wire] = await sib.query({ motebit_id: MID as EventLogEntry["motebit_id"] });
  expect(isEncryptedPayload(wire!.payload)).toBe(true);
  relay.add(wire!);
}

beforeEach(() => {
  vi.useFakeTimers();
  relay = new Relay();
  statuses = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", relay.fetch);
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const held = async (local: InMemoryEventStore): Promise<EventLogEntry[]> =>
  local.query({ motebit_id: MID as EventLogEntry["motebit_id"] });

describe("desktop catch-up token (#927)", () => {
  it("token expires, then a sibling event: the next catch-up delivers it, decrypted", async () => {
    const local = new InMemoryEventStore();
    const ctrl = new SyncController(makeDeps(local));
    ctrl.onSyncStatus((e) => statuses.push({ ...e }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    await vi.advanceTimersByTimeAsync(10);

    await siblingWrites("before", 1);
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 10); // refresh 1: token still valid
    await vi.waitFor(async () =>
      expect((await held(local)).map((e) => e.event_id)).toEqual(["before"]),
    );

    // Past the first token's life, a sibling writes; the next refresh's
    // catch-up is the only way it arrives.
    await vi.advanceTimersByTimeAsync(60_000);
    await siblingWrites("after-expiry", 2);
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 10); // refresh 2 at 9 min

    await vi.waitFor(async () =>
      expect((await held(local)).map((e) => e.event_id).sort()).toEqual(["after-expiry", "before"]),
    );
    const got = await held(local);
    expect(got.find((e) => e.event_id === "after-expiry")!.payload).toEqual({
      from: "sibling",
      id: "after-expiry",
    });
    expect(relay.refused).toBe(0);
    expect(statuses.some((s) => s.status === "error")).toBe(false);
    ctrl.stopSync();
  });

  it("a catch-up the relay keeps refusing is SURFACED in the sync status, never swallowed", async () => {
    const local = new InMemoryEventStore();
    const deps = makeDeps(local);
    // A device the relay no longer authorizes: every token is refused.
    deps.createSyncToken = async () => "tok:0";
    const ctrl = new SyncController(deps);
    ctrl.onSyncStatus((e) => statuses.push({ ...e }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctrl.startSync(vi.fn() as any, "https://relay.test");
    await vi.advanceTimersByTimeAsync(10);

    await vi.waitFor(() => expect(statuses.some((s) => s.status === "error")).toBe(true));
    const errored = statuses.filter((s) => s.status === "error");
    expect(errored[errored.length - 1]!.error).toMatch(/Catch-up failed: .*403/);
    // One request, one refresh, then surfaced.
    expect(relay.refused).toBe(2);
    ctrl.stopSync();
  });
});
