/**
 * @vitest-environment jsdom
 *
 * The relay operator token is removed from desktop (design 2026-11-20,
 * tests 4 and 6). The key store's operator slot holds a hand-placed token in
 * every test here (operator-slot-guard.ts) and the config is the one
 * `loadDesktopConfig` LOADS over that key store, never a hand-built one:
 *
 *   4. `relayBearer` (balance / credentials / checkout / settlement calls),
 *      the `/sync` slash command, and the Sovereign panel's verified fetch
 *      (the goals state export) never carry the token; `relayBearer` mints a
 *      device token for exactly the route's audience.
 *   6. The relay refuses the goals state export (401: on a relay with an API
 *      token that route is operator-only, `services/relay/src/middleware.ts`).
 *      The ledger keeps rendering local goals, shows no relay rows, and does
 *      not present the ledger as verified. What the renderer shows about the
 *      missing relay part is recorded here as it is: nothing (no UI is added
 *      by this change).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { DesktopContext } from "../types";
import { carriesOperatorToken, guardOperatorSlot } from "./operator-slot-guard";

const tauriCore = vi.hoisted(() => ({
  invoke: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (tauriCore.invoke == null) throw new Error("tauri stand-in not installed");
    return tauriCore.invoke(cmd, args);
  },
}));

const RELAY = "https://relay.invalid";
const MOTEBIT = "m-operator-token-test";

function mountDom(): void {
  document.body.innerHTML = `
    <div id="chat-log"></div>
    <div id="chat-input-row"><input id="chat-input" /></div>
    <div id="toast-container"></div>
    <button id="sovereign-btn"></button>
    <div id="sovereign-backdrop"></div>
    <div id="sovereign-panel">
      <button id="sovereign-close-btn"></button>
      <button class="sov-tab" data-tab="ledger"></button>
      <div class="sov-pane" id="sov-pane-ledger"></div>
      <div id="cred-list"></div><div id="cred-empty"></div>
      <button id="cred-present-btn"></button>
      <div id="cred-vp-output"></div><pre id="cred-vp-json"></pre>
      <button id="cred-vp-copy-btn"></button>
      <textarea id="cred-verify-input"></textarea>
      <button id="cred-verify-btn"></button><div id="cred-verify-result"></div>
      <div id="ledger-list"></div><div id="ledger-empty"></div>
      <div id="budget-summary-sov"></div><div id="budget-alloc-list-sov"></div>
      <div id="budget-empty-sov"></div>
      <div id="succession-content"></div><div id="succession-empty"></div>
      <button id="succession-rotate-btn"></button>
      <button id="sov-export-identity"></button>
    </div>
  `;
}

let configModule: typeof import("../ui/config");
let bearerModule: typeof import("../ui/relay-bearer");
let chat: typeof import("../ui/chat");
let sovereign: typeof import("../ui/sovereign");

// A cold import of the chat module graph is slow under coverage (see
// chat-payment-notice.test.ts).
beforeAll(async () => {
  mountDom();
  configModule = await import("../ui/config");
  bearerModule = await import("../ui/relay-bearer");
  chat = await import("../ui/chat");
  sovereign = await import("../ui/sovereign");
}, 60_000);

/**
 * The config desktop loads, over a key store whose operator slot is full
 * (`guard`), or empty (`null`: the user every relay sees today).
 */
async function loadGuardedConfig(guard: ReturnType<typeof guardOperatorSlot> | null) {
  const base = async (cmd: string): Promise<unknown> =>
    cmd === "read_config" ? JSON.stringify({ sync_url: RELAY }) : null;
  tauriCore.invoke = guard != null ? guard.wrap(base) : base;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  w.__TAURI_INTERNALS__ = {};
  try {
    return await configModule.loadDesktopConfig();
  } finally {
    delete w.__TAURI_INTERNALS__;
  }
}

function makeCtx(
  config: Awaited<ReturnType<typeof loadGuardedConfig>>,
  app: Record<string, unknown> = {},
): DesktopContext {
  return {
    getConfig: () => config,
    showToast: vi.fn(),
    app: {
      isProcessing: false,
      motebitId: MOTEBIT,
      getDeviceKeypair: vi.fn(async () => ({
        publicKey: "a".repeat(64),
        privateKey: "b".repeat(64),
      })),
      createSyncToken: vi.fn(async (_pk: string, aud?: string) => `minted:${aud ?? "sync"}`),
      getRuntime: () => null,
      getLocalCredentials: () => [],
      getLocalIdentity: async () => null,
      getLocalLedger: async () => [],
      addArtifact: vi.fn(),
      removeArtifact: vi.fn(),
      ...app,
    },
  } as unknown as DesktopContext;
}

interface Seen {
  url: string;
  auth: string | null;
}

/** Record every request: its URL and its Authorization, from `init` or a `Request`. */
function stubFetch(answer: (url: string) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const fromInit = init?.headers != null ? new Headers(init.headers).get("authorization") : null;
    const auth = fromInit ?? (input instanceof Request ? input.headers.get("authorization") : null);
    seen.push({ url, auth });
    return answer(url);
  });
  return seen;
}

const refused = (): Response => new Response("unauthorized", { status: 401 });

describe("desktop panels — the operator token is never sent (design 2026-11-20)", () => {
  it("loadDesktopConfig never reads the operator slot and returns no token", async () => {
    const guard = guardOperatorSlot();
    const config = await loadGuardedConfig(guard);
    expect(config.syncUrl).toBe(RELAY);
    expect(carriesOperatorToken(JSON.stringify(config))).toBe(false);
    guard.expectUnread();
  });

  it("relayBearer mints for the route's audience and never returns the token", async () => {
    const guard = guardOperatorSlot();
    const ctx = makeCtx(await loadGuardedConfig(guard));
    expect(await bearerModule.relayBearer(ctx, "account:balance")).toBe("minted:account:balance");
    expect(await bearerModule.relayBearer(ctx, "market:listing")).toBe("minted:market:listing");
    // A route that takes no device token gets no bearer at all.
    expect(await bearerModule.relayBearer(ctx, undefined)).toBeNull();
    guard.expectUnread();
  });

  it("/sync passes no token: the app mints its own sync token", async () => {
    const guard = guardOperatorSlot();
    const config = await loadGuardedConfig(guard);
    const syncConversations = vi.fn(async () => ({
      conversations_pushed: 0,
      conversations_pulled: 0,
      messages_pushed: 0,
      messages_pulled: 0,
    }));
    const ctx = makeCtx(config, { syncConversations });
    document.getElementById("chat-log")!.innerHTML = "";
    const callbacks = new Proxy({}, { get: () => vi.fn() }) as unknown as Parameters<
      typeof chat.initChat
    >[1];
    const api = chat.initChat(ctx, callbacks);
    (document.getElementById("chat-input") as HTMLInputElement).value = "/sync";
    await api.handleSend();
    await vi.waitFor(() => expect(syncConversations).toHaveBeenCalledTimes(1));
    expect(syncConversations).toHaveBeenCalledWith(config.invoke, RELAY);
    expect(
      (syncConversations.mock.calls as unknown[][])[0]!.some((a) =>
        carriesOperatorToken(typeof a === "string" ? a : ""),
      ),
    ).toBe(false);
    api.destroy();
    guard.expectUnread();
  });

  it("the Sovereign panel's verified goals fetch carries no Authorization, and no panel request carries the token", async () => {
    const guard = guardOperatorSlot();
    const ctx = makeCtx(await loadGuardedConfig(guard));
    const seen = stubFetch(refused);
    const panel = sovereign.initSovereign(ctx);
    panel.open();
    const goals = `${RELAY}/api/v1/goals/${MOTEBIT}`;
    await vi.waitFor(() => expect(seen.some((s) => s.url === goals)).toBe(true));
    expect(seen.find((s) => s.url === goals)?.auth ?? null).toBeNull();
    expect(seen.filter((s) => carriesOperatorToken(s.auth))).toEqual([]);
    panel.close();
    vi.unstubAllGlobals();
    guard.expectUnread();
  });
});

describe("desktop goals ledger when the relay refuses the state export (401) (test 6)", () => {
  it("renders local goals, no relay rows, and never presents the ledger as verified", async () => {
    // A user with no token in the slot: the behaviour this change gives
    // everyone, and every user's behaviour on main.
    const local = {
      goal_id: "g-local",
      prompt: "zz-local goal prompt",
      status: "completed",
      created_at: Date.now() - 60_000,
    };
    const ctx = makeCtx(await loadGuardedConfig(null), { getLocalLedger: async () => [local] });
    const seen = stubFetch(refused);
    const panel = sovereign.initSovereign(ctx);
    panel.open();
    const goals = `${RELAY}/api/v1/goals/${MOTEBIT}`;
    await vi.waitFor(() => expect(seen.some((s) => s.url === goals)).toBe(true));
    const list = document.getElementById("ledger-list")!;
    await vi.waitFor(() => expect(list.textContent).toContain(local.prompt));

    // Local goals keep rendering; nothing from the relay.
    const rows = Array.from(list.querySelectorAll(".ledger-item"));
    expect(rows.map((r) => r.querySelector(".ledger-item-prompt")?.textContent)).toEqual([
      local.prompt,
    ]);
    // Not verified: the fetch threw, the controller's catch skipped the
    // status update, and `unverified` renders no badge at all.
    expect(list.querySelector(".ledger-verification")).toBeNull();
    expect(list.textContent).not.toMatch(/verified/i);
    // Recorded as found: nothing in the panel tells the user the relay part
    // of the ledger is unavailable. No UI is added for it by this change.
    expect(document.getElementById("sovereign-panel")!.textContent).not.toMatch(
      /relay (ledger )?unavailable|could not (load|reach)|unauthori[sz]ed|401/i,
    );
    // The relay refused the goals route; nothing was sent that could pass it.
    expect(seen.find((s) => s.url === goals)?.auth ?? null).toBeNull();
    panel.close();
    vi.unstubAllGlobals();
  });
});
