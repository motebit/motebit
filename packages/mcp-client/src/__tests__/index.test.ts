import { describe, it, expect } from "vitest";
import { McpClientAdapter } from "../index.js";
import type { McpServerConfig } from "../index.js";

describe("McpClientAdapter", () => {
  it("constructs with stdio config", () => {
    const config: McpServerConfig = {
      name: "test-server",
      transport: "stdio",
      command: "echo",
      args: ["hello"],
    };
    const adapter = new McpClientAdapter(config);
    expect(adapter.serverName).toBe("test-server");
    expect(adapter.isConnected).toBe(false);
    expect(adapter.getTools()).toEqual([]);
  });

  it("throws for http transport (not yet supported)", async () => {
    const config: McpServerConfig = {
      name: "http-server",
      transport: "http",
      url: "https://example.com",
    };
    const adapter = new McpClientAdapter(config);
    await expect(adapter.connect()).rejects.toThrow("HTTP transport");
  });

  it("throws for stdio without command", async () => {
    const config: McpServerConfig = {
      name: "no-cmd",
      transport: "stdio",
    };
    const adapter = new McpClientAdapter(config);
    await expect(adapter.connect()).rejects.toThrow("requires a command");
  });

  it("executeTool rejects tools from wrong server", async () => {
    const config: McpServerConfig = {
      name: "myserver",
      transport: "stdio",
      command: "echo",
    };
    const adapter = new McpClientAdapter(config);
    const result = await adapter.executeTool("otherserver__tool", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not belong");
  });
});
