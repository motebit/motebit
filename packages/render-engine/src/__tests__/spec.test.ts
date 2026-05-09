/**
 * Tests for the public spec helpers — pure mapping functions the
 * runtime/bridge use to project slab items onto the right
 * embodiment when the caller didn't pass one explicitly.
 *
 * `defaultEmbodimentMode` is the canonical kind → mode resolver;
 * the protocol publishes it so every consumer (controller, bridge,
 * renderer, tests) agrees on what an un-annotated kind means.
 */

import { describe, it, expect } from "vitest";

import { defaultEmbodimentMode } from "../spec.js";

describe("defaultEmbodimentMode — kind → mode mapping", () => {
  it("mind-mode kinds resolve to 'mind' (internal reorganization made visible)", () => {
    expect(defaultEmbodimentMode("stream")).toBe("mind");
    expect(defaultEmbodimentMode("plan_step")).toBe("mind");
    expect(defaultEmbodimentMode("embedding")).toBe("mind");
    expect(defaultEmbodimentMode("memory")).toBe("mind");
  });

  it("tool_result kinds resolve to 'tool_result' (motebit's eye on local artifacts)", () => {
    expect(defaultEmbodimentMode("tool_call")).toBe("tool_result");
    expect(defaultEmbodimentMode("shell")).toBe("tool_result");
    expect(defaultEmbodimentMode("fetch")).toBe("tool_result");
  });

  it("delegation kind resolves to 'peer_viewport' (federated peer surface)", () => {
    expect(defaultEmbodimentMode("delegation")).toBe("peer_viewport");
  });

  it("live_browser kind resolves to 'virtual_browser' (cloud Chromium surface)", () => {
    expect(defaultEmbodimentMode("live_browser")).toBe("virtual_browser");
  });
});
