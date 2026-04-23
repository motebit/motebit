import { describe, it, expect } from "vitest";
import { isLocalServerUrl, defaultProviderConfig } from "../index";

describe("isLocalServerUrl", () => {
  it("detects localhost variants", () => {
    expect(isLocalServerUrl("http://localhost:11434")).toBe(true);
    expect(isLocalServerUrl("http://127.0.0.1:1234")).toBe(true);
    expect(isLocalServerUrl("http://0.0.0.0:8080")).toBe(true);
    expect(isLocalServerUrl("http://motebit.local")).toBe(true);
  });
  it("detects private LAN ranges", () => {
    expect(isLocalServerUrl("http://192.168.1.10:11434")).toBe(true);
    expect(isLocalServerUrl("http://10.0.0.5:8080")).toBe(true);
    expect(isLocalServerUrl("http://172.16.0.1:8080")).toBe(true);
    expect(isLocalServerUrl("http://172.31.255.1:8080")).toBe(true);
  });
  it("rejects public URLs and bad input", () => {
    expect(isLocalServerUrl("https://api.anthropic.com")).toBe(false);
    expect(isLocalServerUrl("http://172.15.0.1")).toBe(false); // outside 16-31
    expect(isLocalServerUrl("http://172.32.0.1")).toBe(false);
    expect(isLocalServerUrl(undefined)).toBe(false);
    expect(isLocalServerUrl(null)).toBe(false);
    expect(isLocalServerUrl("not a url")).toBe(false);
  });
});

describe("defaultProviderConfig", () => {
  it("returns motebit-cloud by default", () => {
    const c = defaultProviderConfig();
    expect(c.mode).toBe("motebit-cloud");
  });
});
