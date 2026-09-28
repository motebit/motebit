/**
 * Differential probe for #868: the sync pull cursor.
 *
 *   pnpm tsx scripts/differential-vs-main.ts \
 *     --probe services/relay/src/__tests__/sync-seq-868.probe.ts --pkg services/relay
 *
 * A real served relay (127.0.0.1) and the REAL client — `@motebit/sync-engine`
 * loaded from each tree's own source, so the base side runs main's client and
 * main's relay, the head side this branch's.
 *
 * Expected:
 *   - SAME: every old-client pull (no `after_seq`) — the response bytes are
 *     identical, so a shipped client is served exactly as before; pushes too.
 *   - DIFF: the real client, two devices of one identity, a sibling event at
 *     an EQUAL clock — main never pulls it, head does. And a raw
 *     `after_seq` pull: main ignores the parameter (clock shape), head
 *     answers by seq.
 *
 * Observations carry role names, never ids.
 */
import { it, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { InMemoryEventStore } from "@motebit/event-log";
import type { EventStoreAdapter } from "@motebit/event-log";
import type { EventLogEntry } from "@motebit/sdk";
import type { SyncRelay } from "../index.js";
import { createTestRelay, API_TOKEN, AUTH_HEADER, JSON_AUTH } from "./test-helpers.js";

interface SyncEngineModule {
  SyncEngine: new (
    local: EventStoreAdapter,
    motebitId: string,
  ) => {
    connectRemote(r: EventStoreAdapter): void;
    sync(): Promise<{ pushed: number; pulled: number }>;
  };
  HttpEventStoreAdapter: new (cfg: {
    baseUrl: string;
    motebitId: string;
    authToken?: string;
    maxRetries?: number;
  }) => EventStoreAdapter;
}

let relay: SyncRelay;
let server: ReturnType<typeof serve>;
let base: string;
let se: SyncEngineModule;
const obs: Record<string, unknown> = {};

beforeAll(async () => {
  se = (await import(
    /* @vite-ignore */ fileURLToPath(
      new URL("../../../../packages/sync-engine/src/index.ts", import.meta.url),
    )
  )) as SyncEngineModule;
  relay = await createTestRelay();
  server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
  await relay.close();
  await new Promise<void>((r) => server.close(() => r()));
}, 120_000);

const ev = (mid: string, id: string, clock: number, device: string): EventLogEntry => ({
  event_id: `${id}-${mid}`,
  motebit_id: mid as EventLogEntry["motebit_id"],
  device_id: device,
  timestamp: 1_700_000_000_000 + clock,
  event_type: "state_snapshot" as EventLogEntry["event_type"],
  payload: { from: device, clock },
  version_clock: clock,
  tombstoned: false,
});

/** Replace the run's identity with a role name so bytes compare across trees. */
const roles = (text: string, mid: string): string => text.split(mid).join("<MID>");

async function push(mid: string, events: EventLogEntry[]): Promise<string> {
  const r = await fetch(`${base}/sync/${mid}/push`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ events }),
  });
  return `${r.status} ${roles(await r.text(), mid)}`;
}

async function raw(mid: string, query: string): Promise<string> {
  const r = await fetch(`${base}/sync/${mid}/pull${query}`, { headers: AUTH_HEADER });
  return `${r.status} ${roles(await r.text(), mid)}`;
}

function client(mid: string): {
  store: InMemoryEventStore;
  engine: InstanceType<SyncEngineModule["SyncEngine"]>;
} {
  const store = new InMemoryEventStore();
  const engine = new se.SyncEngine(store, mid);
  engine.connectRemote(
    new se.HttpEventStoreAdapter({
      baseUrl: base,
      motebitId: mid,
      authToken: API_TOKEN,
      maxRetries: 0,
    }),
  );
  return { store, engine };
}

const held = async (s: InMemoryEventStore, mid: string): Promise<string[]> =>
  (await s.query({})).map((e) => roles(e.event_id, mid).replace("-<MID>", "")).sort();

it("old-client pulls are byte-identical; the same-clock sibling event reaches the real client only on head", async () => {
  // ── old clients: raw clock pulls, every shape a shipped client sends ──
  const old = crypto.randomUUID();
  obs["push: three events, two clocks colliding"] = await push(old, [
    ev(old, "x", 1, "a"),
    ev(old, "y", 2, "b"),
    ev(old, "z", 2, "a"),
  ]);
  obs["push: replay of a held event"] = await push(old, [ev(old, "x", 1, "a")]);
  obs["old client: pull after_clock=0"] = await raw(old, "?after_clock=0");
  obs["old client: pull after_clock=1"] = await raw(old, "?after_clock=1");
  obs["old client: pull after_clock=2"] = await raw(old, "?after_clock=2");
  obs["old client: pull with no cursor"] = await raw(old, "");
  obs["old client: pull after_clock=garbage"] = await raw(old, "?after_clock=abc");
  const clock = await fetch(`${base}/sync/${old}/clock`, { headers: AUTH_HEADER });
  obs["clock route"] = `${clock.status} ${roles(await clock.text(), old)}`;

  // ── the #816 trace through the REAL client ────────────────────────────
  const mid = crypto.randomUUID();
  const A = client(mid);
  await A.store.append(ev(mid, "evt-11", 1011, "mobile"));
  await A.store.append(ev(mid, "evt-12", 1012, "mobile"));
  await A.engine.sync();
  // The sibling device of the same identity publishes at the SAME clocks.
  await push(mid, [ev(mid, "in-11", 1011, "desktop"), ev(mid, "in-12", 1012, "desktop")]);
  const r1 = await A.engine.sync();
  const r2 = await A.engine.sync();
  obs["real client: #816 trace — events held after two more syncs"] = await held(A.store, mid);
  obs["real client: #816 trace — pulled counts"] = [r1.pulled, r2.pulled];

  // ── two real devices, equal clock, natural appendWithClock ────────────
  const m2 = crypto.randomUUID();
  const P = client(m2);
  const Q = client(m2);
  const mk = (id: string, device: string) => {
    const { version_clock: _c, ...rest } = ev(m2, id, 0, device);
    return rest;
  };
  await P.store.appendWithClock(mk("p-1", "p"));
  await Q.store.appendWithClock(mk("q-1", "q")); // both at clock 1
  await P.engine.sync();
  await Q.engine.sync();
  await P.engine.sync();
  obs["real clients: P holds after P,Q,P sync"] = await held(P.store, m2);
  obs["real clients: Q holds after P,Q,P sync"] = await held(Q.store, m2);

  // ── the new cursor on the wire (intended DIFF) ────────────────────────
  obs["raw: pull after_seq=0 top-level keys"] = Object.keys(
    JSON.parse((await raw(old, "?after_seq=0")).slice(4)) as object,
  );
});
