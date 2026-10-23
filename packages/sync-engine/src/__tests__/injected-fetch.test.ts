/**
 * The relay HTTP adapters take an injected `fetch` (mobile hands in its relay
 * session's, which refuses and aborts once relay OFF disposed it). Every
 * request goes through it — never the global fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { HttpConversationSyncAdapter } from "../conversation-sync.js";
import { HttpPlanSyncAdapter } from "../plan-sync.js";
import { HttpEventStoreAdapter } from "../http-adapter.js";

const BODY = JSON.stringify({
  accepted: 1,
  conversations: [],
  messages: [],
  plans: [],
  steps: [],
  events: [],
  latest_clock: 0,
});

function injected() {
  return vi.fn(async () => new Response(BODY, { status: 200 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relay HTTP adapters: injected fetch", () => {
  it("conversation and plan adapters send every request through it", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const f = injected();
    const conv = new HttpConversationSyncAdapter({
      baseUrl: "https://r",
      motebitId: "m",
      fetch: f,
    });
    await conv.pushConversations("m", []);
    await conv.pullConversations("m", 0);
    await conv.pushMessages("m", []);
    await conv.pullMessages("m", "c", 0);
    const plans = new HttpPlanSyncAdapter({ baseUrl: "https://r", motebitId: "m", fetch: f });
    await plans.pushPlans("m", []);
    await plans.pullPlans("m", 0);
    await plans.pushSteps("m", []);
    await plans.pullSteps("m", 0);
    expect(f).toHaveBeenCalledTimes(8);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("the event adapter sends through it", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const f = injected();
    const http = new HttpEventStoreAdapter({ baseUrl: "https://r", motebitId: "m", fetch: f });
    await http.query({ motebit_id: "m" as never });
    expect(f).toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("without one, the global fetch is resolved per call", async () => {
    const conv = new HttpConversationSyncAdapter({ baseUrl: "https://r", motebitId: "m" });
    const late = injected();
    vi.stubGlobal("fetch", late);
    await conv.pullConversations("m", 0);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
