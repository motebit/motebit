/**
 * The REAL page, under test: index.html's body + main.ts (DOM wiring) + the real
 * verifier (@motebit/state-export-client / @motebit/crypto), with only the
 * network mocked. Shared by page.test.ts and claimed-vs-proven.test.ts.
 *
 * Callers run in a jsdom environment and call `installPageHooks()` once at
 * module level.
 */
import { beforeEach, afterEach, vi } from "vitest";
import INDEX_HTML from "../../index.html?raw";
import DECLARATION from "./fixtures/relay-declaration.json?raw";

export { INDEX_HTML };

export const BODY = /<body>([\s\S]*)<\/body>/
  .exec(INDEX_HTML)![1]!
  .replace(/<script[\s\S]*?<\/script>/g, "");

export interface MockCtx {
  readonly bundle?: unknown;
  readonly memos?: readonly string[];
  readonly rpcFail?: boolean;
  readonly relayDown?: boolean;
}

/** The fixture's receipt as a `#r=` share link (same encoding as fragment.ts). */
export function linkHash(text: string): string {
  const min = JSON.stringify(JSON.parse(text));
  let bin = "";
  for (const b of new TextEncoder().encode(min)) bin += String.fromCharCode(b);
  return `#r=${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** 200 newer anchor memos sitting in front of anything older (newest first). */
export const FILLER_200 = Array.from(
  { length: 200 },
  (_, i) => `motebit:anchor:v1:${i.toString(16).padStart(64, "0")}:${i + 2}`,
);

const json = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let requests: string[] = [];
/** Every request the page made since the last `openPage`, as `METHOD origin+path`. */
export const requestLog = (): readonly string[] => requests;

function mockNetwork(ctx: MockCtx): void {
  requests = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    requests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.hostname === "relay.motebit.com") {
      if (ctx.relayDown) throw new TypeError("network down");
      if (url.pathname === "/.well-known/motebit-transparency.json") return json(DECLARATION);
      if (url.pathname.startsWith("/api/v1/identity/")) {
        return ctx.bundle !== undefined ? json(ctx.bundle) : json({ error: "not found" }, 404);
      }
      return json({}, 404);
    }
    if (init?.method === "POST") {
      // Any Solana JSON-RPC endpoint: honour getSignaturesForAddress `limit`, newest first.
      if (ctx.rpcFail) return json("down", 503);
      const req = JSON.parse(init.body as string) as { params: [string, { limit: number }] };
      const all = (ctx.memos ?? []).map((m, i) => ({
        signature: `tx${i}`,
        slot: 1,
        err: null,
        memo: `[1] ${m}`,
        blockTime: null,
      }));
      return json({ jsonrpc: "2.0", id: 1, result: all.slice(0, req.params[1].limit) });
    }
    throw new TypeError(`unexpected request ${url.href}`);
  });
}

// main.ts registers window listeners (hashchange); drop them between tests so a
// previous page instance never acts on this one.
const windowListeners: Array<[string, EventListenerOrEventListenerObject]> = [];
const realAdd = window.addEventListener.bind(window);

/** Register the per-test listener tracking and cleanup. Call once per test file. */
export function installPageHooks(): void {
  beforeEach(() => {
    vi.spyOn(window, "addEventListener").mockImplementation(((
      type: string,
      l: EventListenerOrEventListenerObject,
      o?: boolean | AddEventListenerOptions,
    ) => {
      windowListeners.push([type, l]);
      realAdd(type, l, o);
    }) as typeof window.addEventListener);
  });
  afterEach(() => {
    for (const [t, l] of windowListeners.splice(0)) window.removeEventListener(t, l);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
}

export async function openPage(
  opts: { hash?: string; ctx?: MockCtx; rpc?: string } = {},
): Promise<void> {
  document.body.innerHTML = BODY;
  history.replaceState(null, "", `/${opts.hash ?? ""}`);
  mockNetwork(opts.ctx ?? {});
  if (opts.rpc !== undefined) vi.stubEnv("VITE_SOLANA_RPC_URL", opts.rpc);
  vi.resetModules();
  await import("../main.js");
}

export const container = (): HTMLElement => document.getElementById("result-container")!;
export const grade = (): string | null =>
  container().querySelector(".grade-badge")?.textContent ?? null;
export const rung = (key: string): Element | null =>
  container().querySelector(`.proof > .ladder > [data-rung="${key}"]`);

/** Wait until the page shows a final verdict card or an explicit not-verified state. */
export async function settled(): Promise<void> {
  await vi.waitFor(
    () => {
      const c = container();
      const done =
        c.querySelector(".result-card") !== null || /Not verified/.test(c.textContent ?? "");
      if (!done) throw new Error("not settled");
    },
    { timeout: 4000, interval: 20 },
  );
  // Let any in-flight run that settled the same tick finish its DOM write.
  await new Promise((r) => setTimeout(r, 30));
}

export function typeIn(text: string): void {
  const input = document.getElementById("receipt-input") as HTMLTextAreaElement;
  input.value = text;
  input.dispatchEvent(new Event("input"));
}

/** Anything a positive verdict card shows. */
export function showsPositiveVerdict(): boolean {
  const c = container();
  return (
    c.querySelector(".chip-ok") !== null ||
    c.querySelector(".tone-bound") !== null ||
    /SOVEREIGN|ANCHORED|PINNED|valid signature/.test(c.textContent ?? "")
  );
}
