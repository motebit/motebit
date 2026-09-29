/**
 * #957: the read-url hop binds its caller tokens to the atom it submitted
 * the task for (`delegateTargetId`, the id the relay admits the hop under),
 * never to whatever the endpoint's /health claims. Tamper:
 * `packages/mcp-server/tamper/caller-token-957.mjs`.
 */
import { describe, it, expect } from "vitest";
import { subDelegateClientConfig } from "../index.js";

const base = {
  mcpUrl: "https://read-url.example/mcp",
  callerMotebitId: "web-search-id",
  callerDeviceId: "web-search-service",
  callerPrivateKey: new Uint8Array(32),
};

describe("sub-delegation MCP client config (#957)", () => {
  it("binds caller tokens to the relay-admitted target", () => {
    const cfg = subDelegateClientConfig({ ...base, targetMotebitId: "read-url-atom-id" });
    expect(cfg.motebitId).toBe("read-url-atom-id");
    expect(cfg.motebit).toBe(true);
    expect(cfg.callerMotebitId).toBe("web-search-id");
  });

  it("without a relay-named target, leaves the id to the client's first-contact discovery", () => {
    expect(subDelegateClientConfig(base).motebitId).toBeUndefined();
  });
});
