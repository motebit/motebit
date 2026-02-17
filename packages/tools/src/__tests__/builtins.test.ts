import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryToolRegistry } from "../index";
import {
  createWebSearchHandler,
  createReadUrlHandler,
  createReadFileHandler,
  writeFileDefinition,
  createWriteFileHandler,
  shellExecDefinition,
  createShellExecHandler,
  createRecallMemoriesHandler,
  createListEventsHandler,
  registerBuiltinTools,
} from "../builtins/index";

// ---------- web_search ----------

describe("web_search", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns results from DuckDuckGo API", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        AbstractText: "TypeScript is a typed superset of JavaScript.",
        RelatedTopics: [
          { Text: "Related topic 1" },
          { Text: "Related topic 2" },
        ],
      }),
    }) as unknown as typeof fetch;

    const handler = createWebSearchHandler();
    const result = await handler({ query: "typescript" });

    expect(result.ok).toBe(true);
    expect(result.data).toContain("TypeScript is a typed superset");
    expect(result.data).toContain("Related topic 1");
  });

  it("returns friendly message when no results", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ AbstractText: "", RelatedTopics: [] }),
    }) as unknown as typeof fetch;

    const handler = createWebSearchHandler();
    const result = await handler({ query: "xyznonexistent" });

    expect(result.ok).toBe(true);
    expect(result.data as string).toContain("No results found");
  });

  it("returns error on missing query", async () => {
    const handler = createWebSearchHandler();
    const result = await handler({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameter");
  });

  it("returns error on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof fetch;

    const handler = createWebSearchHandler();
    const result = await handler({ query: "test" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Search failed: 500");
  });

  it("returns error on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as unknown as typeof fetch;

    const handler = createWebSearchHandler();
    const result = await handler({ query: "test" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Network error");
  });
});

// ---------- read_url ----------

describe("read_url", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches and returns JSON content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ key: "value" }),
    }) as unknown as typeof fetch;

    const handler = createReadUrlHandler();
    const result = await handler({ url: "https://api.example.com/data" });

    expect(result.ok).toBe(true);
    expect(result.data).toContain('"key": "value"');
  });

  it("fetches and strips HTML content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => "<html><head><style>body{}</style></head><body><p>Hello World</p><script>alert(1)</script></body></html>",
    }) as unknown as typeof fetch;

    const handler = createReadUrlHandler();
    const result = await handler({ url: "https://example.com" });

    expect(result.ok).toBe(true);
    expect(result.data as string).toContain("Hello World");
    expect(result.data as string).not.toContain("<script>");
    expect(result.data as string).not.toContain("<style>");
  });

  it("returns error on missing url", async () => {
    const handler = createReadUrlHandler();
    const result = await handler({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameter");
  });

  it("returns error on HTTP failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    }) as unknown as typeof fetch;

    const handler = createReadUrlHandler();
    const result = await handler({ url: "https://example.com/missing" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("HTTP 404");
  });
});

// ---------- read_file ----------

describe("read_file", () => {
  it("reads an existing file", async () => {
    const handler = createReadFileHandler();
    // Read this test file itself
    const result = await handler({ path: __filename });

    expect(result.ok).toBe(true);
    expect(result.data as string).toContain("read_file");
  });

  it("returns error on missing path", async () => {
    const handler = createReadFileHandler();
    const result = await handler({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameter");
  });

  it("returns error for nonexistent file", async () => {
    const handler = createReadFileHandler();
    const result = await handler({ path: "/tmp/__motebit_nonexistent_test_file__" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Read error");
  });

  it("enforces allowedPaths sandbox", async () => {
    const handler = createReadFileHandler(["/allowed/dir"]);
    const result = await handler({ path: "/etc/passwd" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Access denied");
  });

  it("allows paths within sandbox", async () => {
    const handler = createReadFileHandler([__dirname]);
    const result = await handler({ path: __filename });
    expect(result.ok).toBe(true);
  });
});

// ---------- write_file ----------

describe("write_file", () => {
  const testDir = "/tmp/__motebit_test_write__";

  afterEach(async () => {
    const fs = await import("node:fs/promises");
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("writes content to a file", async () => {
    const handler = createWriteFileHandler();
    const filePath = `${testDir}/output.txt`;
    const result = await handler({ path: filePath, content: "hello world" });

    expect(result.ok).toBe(true);
    expect(result.data as string).toContain("11 bytes");

    const fs = await import("node:fs/promises");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("hello world");
  });

  it("creates directories recursively", async () => {
    const handler = createWriteFileHandler();
    const filePath = `${testDir}/deep/nested/dir/file.txt`;
    const result = await handler({ path: filePath, content: "nested" });

    expect(result.ok).toBe(true);

    const fs = await import("node:fs/promises");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe("nested");
  });

  it("returns error on missing parameters", async () => {
    const handler = createWriteFileHandler();
    const result = await handler({ path: "/tmp/test" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameters");
  });

  it("enforces allowedPaths sandbox", async () => {
    const handler = createWriteFileHandler(["/allowed/dir"]);
    const result = await handler({ path: "/tmp/test.txt", content: "nope" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Access denied");
  });

  it("has requiresApproval set", () => {
    expect(writeFileDefinition.requiresApproval).toBe(true);
  });
});

// ---------- shell_exec ----------

describe("shell_exec", () => {
  it("executes a simple command", async () => {
    const handler = createShellExecHandler();
    const result = await handler({ command: "echo", args: ["hello"] });

    expect(result.ok).toBe(true);
    expect(result.data as string).toContain("hello");
  });

  it("returns error on missing command", async () => {
    const handler = createShellExecHandler();
    const result = await handler({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameter");
  });

  it("returns error on failing command", async () => {
    const handler = createShellExecHandler();
    const result = await handler({
      command: "/bin/sh",
      args: ["-c", "exit 1"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Exec error");
  });

  it("has requiresApproval set", () => {
    expect(shellExecDefinition.requiresApproval).toBe(true);
  });
});

// ---------- recall_memories ----------

describe("recall_memories", () => {
  it("returns formatted memories", async () => {
    const searchFn = vi.fn().mockResolvedValue([
      { content: "User likes TypeScript", confidence: 0.95 },
      { content: "User prefers dark mode", confidence: 0.8 },
    ]);

    const handler = createRecallMemoriesHandler(searchFn);
    const result = await handler({ query: "user preferences" });

    expect(result.ok).toBe(true);
    expect(result.data as string).toContain("[confidence=0.95]");
    expect(result.data as string).toContain("User likes TypeScript");
    expect(result.data as string).toContain("User prefers dark mode");
    expect(searchFn).toHaveBeenCalledWith("user preferences", 5);
  });

  it("respects custom limit", async () => {
    const searchFn = vi.fn().mockResolvedValue([]);

    const handler = createRecallMemoriesHandler(searchFn);
    await handler({ query: "test", limit: 3 });

    expect(searchFn).toHaveBeenCalledWith("test", 3);
  });

  it("returns message when no memories found", async () => {
    const searchFn = vi.fn().mockResolvedValue([]);

    const handler = createRecallMemoriesHandler(searchFn);
    const result = await handler({ query: "something" });

    expect(result.ok).toBe(true);
    expect(result.data).toContain("No relevant memories");
  });

  it("returns error on missing query", async () => {
    const searchFn = vi.fn();
    const handler = createRecallMemoriesHandler(searchFn);
    const result = await handler({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameter");
  });

  it("handles search function errors", async () => {
    const searchFn = vi.fn().mockRejectedValue(new Error("DB unavailable"));

    const handler = createRecallMemoriesHandler(searchFn);
    const result = await handler({ query: "test" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("DB unavailable");
  });
});

// ---------- list_events ----------

describe("list_events", () => {
  it("returns formatted events", async () => {
    const queryFn = vi.fn().mockResolvedValue([
      {
        event_type: "memory_formed",
        timestamp: 1700000000000,
        payload: { content: "test memory" },
      },
    ]);

    const handler = createListEventsHandler(queryFn);
    const result = await handler({});

    expect(result.ok).toBe(true);
    expect(result.data as string).toContain("memory_formed");
    expect(result.data as string).toContain("test memory");
    expect(queryFn).toHaveBeenCalledWith(10, undefined);
  });

  it("passes limit and event_type", async () => {
    const queryFn = vi.fn().mockResolvedValue([]);

    const handler = createListEventsHandler(queryFn);
    await handler({ limit: 5, event_type: "tool_used" });

    expect(queryFn).toHaveBeenCalledWith(5, "tool_used");
  });

  it("returns message when no events found", async () => {
    const queryFn = vi.fn().mockResolvedValue([]);

    const handler = createListEventsHandler(queryFn);
    const result = await handler({});

    expect(result.ok).toBe(true);
    expect(result.data).toContain("No events found");
  });

  it("handles query function errors", async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error("Connection refused"));

    const handler = createListEventsHandler(queryFn);
    const result = await handler({});

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Connection refused");
  });
});

// ---------- registerBuiltinTools ----------

describe("registerBuiltinTools", () => {
  it("registers core tools (5 without optional callbacks)", () => {
    const registry = new InMemoryToolRegistry();
    registerBuiltinTools(registry);

    expect(registry.size).toBe(5);
    expect(registry.has("web_search")).toBe(true);
    expect(registry.has("read_url")).toBe(true);
    expect(registry.has("read_file")).toBe(true);
    expect(registry.has("write_file")).toBe(true);
    expect(registry.has("shell_exec")).toBe(true);
  });

  it("registers memory tool when memorySearchFn provided", () => {
    const registry = new InMemoryToolRegistry();
    registerBuiltinTools(registry, {
      memorySearchFn: async () => [],
    });

    expect(registry.size).toBe(6);
    expect(registry.has("recall_memories")).toBe(true);
  });

  it("registers event tool when eventQueryFn provided", () => {
    const registry = new InMemoryToolRegistry();
    registerBuiltinTools(registry, {
      eventQueryFn: async () => [],
    });

    expect(registry.size).toBe(6);
    expect(registry.has("list_events")).toBe(true);
  });

  it("registers all 7 tools when all options provided", () => {
    const registry = new InMemoryToolRegistry();
    registerBuiltinTools(registry, {
      memorySearchFn: async () => [],
      eventQueryFn: async () => [],
    });

    expect(registry.size).toBe(7);
    const names = registry.list().map((t) => t.name).sort();
    expect(names).toEqual([
      "list_events",
      "read_file",
      "read_url",
      "recall_memories",
      "shell_exec",
      "web_search",
      "write_file",
    ]);
  });

  it("passes allowedPaths to file tools", async () => {
    const registry = new InMemoryToolRegistry();
    registerBuiltinTools(registry, {
      allowedPaths: ["/allowed/only"],
    });

    const readResult = await registry.execute("read_file", { path: "/etc/passwd" });
    expect(readResult.ok).toBe(false);
    expect(readResult.error).toContain("Access denied");

    const writeResult = await registry.execute("write_file", {
      path: "/etc/shadow",
      content: "nope",
    });
    expect(writeResult.ok).toBe(false);
    expect(writeResult.error).toContain("Access denied");
  });
});
