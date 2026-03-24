import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryToolRegistry, SearchProviderError, FallbackSearchProvider } from "../index";
import { BraveSearchProvider } from "../providers/brave-search";
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
  createUndoWriteHandler,
  registerBuiltinTools,
  isPathAllowed,
  isDirectoryAllowed,
  DESTRUCTIVE_PATTERNS,
} from "../builtins/index";

// ---------- web_search ----------

describe("web_search", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns results from DuckDuckGo HTML search", async () => {
    // Mock DuckDuckGo HTML lite response with result blocks
    const mockHtml = `
      <div class="result results_links results_links_deep web-result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2F">TypeScript: JavaScript With Syntax</a>
        <a class="result__snippet">TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.</a>
      </div>
      <div class="result results_links results_links_deep web-result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FTypeScript">TypeScript - Wikipedia</a>
        <a class="result__snippet">TypeScript is a programming language developed by Microsoft.</a>
      </div>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => mockHtml,
    }) as unknown as typeof fetch;

    const handler = createWebSearchHandler();
    const result = await handler({ query: "typescript" });

    expect(result.ok).toBe(true);
    expect(result.data).toContain("TypeScript");
    expect(result.data).toContain("typescriptlang.org");
  });

  it("returns friendly message when no results", async () => {
    // Empty HTML with no result blocks
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<html><body>No results</body></html>",
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
      text: async () => "",
    }) as unknown as typeof fetch;

    const handler = createWebSearchHandler();
    const result = await handler({ query: "test" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
    expect(result.error).toContain("duckduckgo");
  });

  it("returns error on network error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("Network error")) as unknown as typeof fetch;

    const handler = createWebSearchHandler();
    const result = await handler({ query: "test" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Network error");
  });

  it("uses a custom SearchProvider when provided", async () => {
    const mockProvider = {
      search: vi
        .fn()
        .mockResolvedValue([
          { title: "Brave Result", url: "https://brave.com", snippet: "Found via Brave" },
        ]),
    };

    const handler = createWebSearchHandler(mockProvider);
    const result = await handler({ query: "test query" });

    expect(result.ok).toBe(true);
    expect(result.data).toContain("Brave Result");
    expect(result.data).toContain("https://brave.com");
    expect(result.data).toContain("Found via Brave");
    expect(mockProvider.search).toHaveBeenCalledWith("test query", 5);
  });

  it("formats results as numbered list", async () => {
    const mockProvider = {
      search: vi.fn().mockResolvedValue([
        { title: "First", url: "https://first.com", snippet: "First result" },
        { title: "Second", url: "https://second.com", snippet: "Second result" },
      ]),
    };

    const handler = createWebSearchHandler(mockProvider);
    const result = await handler({ query: "multi" });

    expect(result.ok).toBe(true);
    expect(result.data).toContain('Results for "multi"');
    expect(result.data).toContain("1. First");
    expect(result.data).toContain("2. Second");
  });

  it("surfaces HTTP 422 from search provider as error (not 'no results')", async () => {
    const mockProvider = {
      search: vi
        .fn()
        .mockRejectedValue(
          new SearchProviderError("Brave Search API error: 422 — invalid query", 422, "brave"),
        ),
    };

    const handler = createWebSearchHandler(mockProvider);
    const result = await handler({ query: "test" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("422");
    expect(result.error).toContain("brave");
    expect(result.error).not.toContain("No results found");
  });

  it("surfaces HTTP 429 rate limit from search provider as error", async () => {
    const mockProvider = {
      search: vi
        .fn()
        .mockRejectedValue(
          new SearchProviderError("Brave Search API error: 429 — rate limited", 429, "brave"),
        ),
    };

    const handler = createWebSearchHandler(mockProvider);
    const result = await handler({ query: "test" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("429");
    expect(result.error).toContain("brave");
    expect(result.error).toContain("Search provider error");
  });
});

// ---------- BraveSearchProvider ----------

describe("BraveSearchProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws SearchProviderError with status on HTTP 422", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => '{"error":"invalid query parameter"}',
    }) as unknown as typeof fetch;

    const provider = new BraveSearchProvider("test-key");
    await expect(provider.search("bad query")).rejects.toThrow(SearchProviderError);

    try {
      await provider.search("bad query");
    } catch (err) {
      expect(err).toBeInstanceOf(SearchProviderError);
      const spe = err as SearchProviderError;
      expect(spe.status).toBe(422);
      expect(spe.provider).toBe("brave");
      expect(spe.message).toContain("422");
      expect(spe.message).toContain("invalid query parameter");
    }
  });

  it("throws SearchProviderError with status on HTTP 429", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limit exceeded",
    }) as unknown as typeof fetch;

    const provider = new BraveSearchProvider("test-key");

    try {
      await provider.search("test");
    } catch (err) {
      expect(err).toBeInstanceOf(SearchProviderError);
      const spe = err as SearchProviderError;
      expect(spe.status).toBe(429);
      expect(spe.provider).toBe("brave");
      expect(spe.message).toContain("429");
      expect(spe.message).toContain("rate limit exceeded");
    }
  });

  it("includes response body (truncated) in error message", async () => {
    const longBody = "x".repeat(500);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => longBody,
    }) as unknown as typeof fetch;

    const provider = new BraveSearchProvider("test-key");
    await expect(provider.search("test")).rejects.toThrow(SearchProviderError);

    try {
      await provider.search("test");
    } catch (err) {
      const spe = err as SearchProviderError;
      // Body should be truncated to 200 chars
      expect(spe.message.length).toBeLessThan(300);
    }
  });
});

// ---------- FallbackSearchProvider ----------

describe("FallbackSearchProvider", () => {
  it("re-throws first error when all providers fail", async () => {
    const braveErr = new SearchProviderError("Brave: 429", 429, "brave");
    const ddgErr = new SearchProviderError("DDG: 503", 503, "duckduckgo");

    const provider = new FallbackSearchProvider([
      { search: vi.fn().mockRejectedValue(braveErr) },
      { search: vi.fn().mockRejectedValue(ddgErr) },
    ]);

    await expect(provider.search("test")).rejects.toThrow(braveErr);
  });

  it("returns empty array only when providers return empty (no errors)", async () => {
    const provider = new FallbackSearchProvider([
      { search: vi.fn().mockResolvedValue([]) },
      { search: vi.fn().mockResolvedValue([]) },
    ]);

    const results = await provider.search("test");
    expect(results).toEqual([]);
  });

  it("falls through to next provider when first throws but second succeeds", async () => {
    const braveErr = new SearchProviderError("Brave: 429", 429, "brave");
    const results = [{ title: "DDG Result", url: "https://ddg.com", snippet: "ok" }];

    const provider = new FallbackSearchProvider([
      { search: vi.fn().mockRejectedValue(braveErr) },
      { search: vi.fn().mockResolvedValue(results) },
    ]);

    const out = await provider.search("test");
    expect(out).toEqual(results);
  });

  it("falls through on empty results but throws if remaining providers also error", async () => {
    const ddgErr = new SearchProviderError("DDG: 503", 503, "duckduckgo");

    const provider = new FallbackSearchProvider([
      { search: vi.fn().mockResolvedValue([]) },
      { search: vi.fn().mockRejectedValue(ddgErr) },
    ]);

    // First provider returned empty, second threw — the error should propagate
    await expect(provider.search("test")).rejects.toThrow(ddgErr);
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
      text: async () =>
        "<html><head><style>body{}</style></head><body><p>Hello World</p><script>alert(1)</script></body></html>",
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

  it("creates backup before overwriting existing file", async () => {
    const fs = await import("node:fs/promises");
    const backupDir = `${testDir}/backups`;
    const handler = createWriteFileHandler({ backupDir, allowedPaths: [testDir] });
    const filePath = `${testDir}/overwrite.txt`;

    // Write initial content
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(filePath, "original", "utf-8");

    // Overwrite — should create backup
    const result = await handler({ path: filePath, content: "updated" });
    expect(result.ok).toBe(true);

    // Verify backup exists
    const backupFiles = await fs.readdir(backupDir);
    const backups = backupFiles.filter((f) => !f.endsWith(".meta.json"));
    expect(backups.length).toBe(1);

    // Verify backup content
    const backupContent = await fs.readFile(`${backupDir}/${backups[0]}`, "utf-8");
    expect(backupContent).toBe("original");

    // Verify meta file
    const metaFiles = backupFiles.filter((f) => f.endsWith(".meta.json"));
    expect(metaFiles.length).toBe(1);
    const meta = JSON.parse(await fs.readFile(`${backupDir}/${metaFiles[0]}`, "utf-8"));
    expect(meta.originalPath).toContain("overwrite.txt");
    expect(meta.size).toBe(8);
  });

  it("skips backup for new files", async () => {
    const fs = await import("node:fs/promises");
    const backupDir = `${testDir}/backups`;
    const handler = createWriteFileHandler({ backupDir });
    const filePath = `${testDir}/new.txt`;

    const result = await handler({ path: filePath, content: "fresh" });
    expect(result.ok).toBe(true);

    // No backup created for new file
    try {
      const files = await fs.readdir(backupDir);
      expect(files.length).toBe(0);
    } catch {
      // backupDir doesn't exist — correct, no backup was needed
    }
  });

  it("accepts WriteFileConfig object", async () => {
    const fs = await import("node:fs/promises");
    await fs.mkdir(testDir, { recursive: true });
    const handler = createWriteFileHandler({ allowedPaths: [testDir] });
    const filePath = `${testDir}/config-test.txt`;
    const result = await handler({ path: filePath, content: "works" });
    expect(result.ok).toBe(true);
  });
});

// ---------- undo_write ----------

describe("undo_write", () => {
  const testDir = "/tmp/__motebit_test_undo__";

  afterEach(async () => {
    const fs = await import("node:fs/promises");
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("restores file from backup", async () => {
    const fs = await import("node:fs/promises");
    const backupDir = `${testDir}/backups`;
    const filePath = `${testDir}/restore-me.txt`;

    // Create original + overwrite (which creates backup)
    const writer = createWriteFileHandler({ backupDir });
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(filePath, "original-content", "utf-8");
    await writer({ path: filePath, content: "overwritten" });

    // Verify it was overwritten
    expect(await fs.readFile(filePath, "utf-8")).toBe("overwritten");

    // Undo
    const undoer = createUndoWriteHandler({ backupDir });
    const result = await undoer({ path: filePath });
    expect(result.ok).toBe(true);
    expect(result.data as string).toContain("Restored");

    // Verify content restored
    expect(await fs.readFile(filePath, "utf-8")).toBe("original-content");
  });

  it("returns error when no backup exists", async () => {
    const undoer = createUndoWriteHandler({ backupDir: `${testDir}/empty-backups` });
    const result = await undoer({ path: "/tmp/no-backup.txt" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No backup found");
  });

  it("returns error on missing path parameter", async () => {
    const undoer = createUndoWriteHandler();
    const result = await undoer({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameter");
  });

  it("enforces allowedPaths on restore target", async () => {
    const undoer = createUndoWriteHandler({ allowedPaths: ["/allowed/only"] });
    const result = await undoer({ path: "/etc/passwd" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Access denied");
  });
});

// ---------- path_sandbox ----------

describe("path_sandbox", () => {
  it("allows paths within sandbox", () => {
    const result = isPathAllowed(__filename, [__dirname]);
    expect(result.allowed).toBe(true);
  });

  it("denies paths outside sandbox", () => {
    const result = isPathAllowed("/etc/passwd", ["/tmp"]);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("outside allowed paths");
  });

  it("handles segment-boundary matching", () => {
    // /tmp/project-evil should NOT match /tmp/project
    const result = isPathAllowed("/tmp/project-evil/file.txt", ["/tmp/project"]);
    expect(result.allowed).toBe(false);
  });

  it("allows exact path match", () => {
    const result = isPathAllowed(__dirname, [__dirname]);
    expect(result.allowed).toBe(true);
  });

  it("returns allowed for empty allowedPaths", () => {
    const result = isPathAllowed("/any/path", []);
    expect(result.allowed).toBe(true);
  });

  it("handles ENOENT with parent fallback for new files", () => {
    const result = isPathAllowed(`${__dirname}/nonexistent-new-file.txt`, [__dirname]);
    expect(result.allowed).toBe(true);
  });

  it("denies when parent also doesn't exist", () => {
    const result = isPathAllowed("/nonexistent/parent/dir/file.txt", ["/tmp"]);
    expect(result.allowed).toBe(false);
  });

  it("isDirectoryAllowed allows existing directory", () => {
    const result = isDirectoryAllowed(__dirname, [__dirname]);
    expect(result.allowed).toBe(true);
  });

  it("isDirectoryAllowed denies non-existent directory", () => {
    const result = isDirectoryAllowed("/nonexistent/dir", ["/tmp"]);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  it("isDirectoryAllowed denies file (not directory)", () => {
    const result = isDirectoryAllowed(__filename, [__dirname]);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("Not a directory");
  });

  it("isDirectoryAllowed denies outside sandbox", () => {
    const result = isDirectoryAllowed("/tmp", ["/var"]);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("outside allowed paths");
  });

  it("isDirectoryAllowed allows with empty allowedPaths", () => {
    const result = isDirectoryAllowed("/tmp", []);
    expect(result.allowed).toBe(true);
  });
});

// ---------- DESTRUCTIVE_PATTERNS ----------

describe("DESTRUCTIVE_PATTERNS", () => {
  it("rm detects -r flag", () => {
    expect(DESTRUCTIVE_PATTERNS.rm!(["-r", "dir/"])).toBe(true);
  });

  it("rm detects -rf flag", () => {
    expect(DESTRUCTIVE_PATTERNS.rm!(["-rf", "/"])).toBe(true);
  });

  it("rm detects --recursive", () => {
    expect(DESTRUCTIVE_PATTERNS.rm!(["--recursive"])).toBe(true);
  });

  it("rm allows non-recursive delete", () => {
    expect(DESTRUCTIVE_PATTERNS.rm!(["file.txt"])).toBe(false);
  });

  it("git detects reset --hard", () => {
    expect(DESTRUCTIVE_PATTERNS.git!(["reset", "--hard"])).toBe(true);
  });

  it("git detects push --force", () => {
    expect(DESTRUCTIVE_PATTERNS.git!(["push", "--force"])).toBe(true);
  });

  it("git detects push --force-with-lease", () => {
    expect(DESTRUCTIVE_PATTERNS.git!(["push", "--force-with-lease"])).toBe(true);
  });

  it("git detects clean -f", () => {
    expect(DESTRUCTIVE_PATTERNS.git!(["clean", "-f"])).toBe(true);
  });

  it("git detects branch -D", () => {
    expect(DESTRUCTIVE_PATTERNS.git!(["branch", "-D", "feature"])).toBe(true);
  });

  it("git allows safe commands", () => {
    expect(DESTRUCTIVE_PATTERNS.git!(["status"])).toBe(false);
    expect(DESTRUCTIVE_PATTERNS.git!(["log"])).toBe(false);
    expect(DESTRUCTIVE_PATTERNS.git!(["push"])).toBe(false);
  });

  it("chmod detects 777", () => {
    expect(DESTRUCTIVE_PATTERNS.chmod!(["777", "file"])).toBe(true);
  });

  it("chmod allows normal perms", () => {
    expect(DESTRUCTIVE_PATTERNS.chmod!(["644", "file"])).toBe(false);
  });

  it("chown detects recursive", () => {
    expect(DESTRUCTIVE_PATTERNS.chown!(["-R", "root:root", "/"])).toBe(true);
  });

  it("chown allows non-recursive", () => {
    expect(DESTRUCTIVE_PATTERNS.chown!(["user:group", "file"])).toBe(false);
  });
});

// ---------- shell_exec ----------

describe("shell_exec", () => {
  it("executes an allowlisted command", async () => {
    const handler = createShellExecHandler({ commandAllowList: ["echo"] });
    const result = await handler({ command: "echo", args: ["hello"] });

    expect(result.ok).toBe(true);
    expect(result.data as string).toContain("hello");
  });

  it("returns error on missing command", async () => {
    const handler = createShellExecHandler({ commandAllowList: ["echo"] });
    const result = await handler({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Missing required parameter");
  });

  it("denies when no allowlist is configured (fail-closed)", async () => {
    const handler = createShellExecHandler();
    const result = await handler({ command: "echo", args: ["hello"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no commands are allowlisted");
  });

  it("denies commands not on the allowlist", async () => {
    const handler = createShellExecHandler({ commandAllowList: ["node", "npm"] });
    const result = await handler({ command: "python", args: ["script.py"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not in the allowed commands list");
  });

  it("blocklist takes precedence over allowlist", async () => {
    const handler = createShellExecHandler({
      commandAllowList: ["rm", "ls"],
      commandBlockList: ["rm"],
    });
    const result = await handler({ command: "rm", args: ["file.txt"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("blocked");
  });

  it("detects destructive rm -rf", async () => {
    const handler = createShellExecHandler({ commandAllowList: ["rm"] });
    const result = await handler({ command: "rm", args: ["-rf", "/tmp/test"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Destructive command");
  });

  it("detects destructive rm --recursive", async () => {
    const handler = createShellExecHandler({ commandAllowList: ["rm"] });
    const result = await handler({ command: "rm", args: ["--recursive", "dir/"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Destructive command");
  });

  it("detects destructive git reset --hard", async () => {
    const handler = createShellExecHandler({ commandAllowList: ["git"] });
    const result = await handler({ command: "git", args: ["reset", "--hard"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Destructive command");
  });

  it("detects destructive git push --force", async () => {
    const handler = createShellExecHandler({ commandAllowList: ["git"] });
    const result = await handler({ command: "git", args: ["push", "--force"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Destructive command");
  });

  it("blocks dd always", async () => {
    const handler = createShellExecHandler({ commandAllowList: ["dd"] });
    const result = await handler({ command: "dd", args: ["if=/dev/zero", "of=/dev/sda"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Destructive command");
  });

  it("allows non-destructive git commands", async () => {
    const handler = createShellExecHandler({ commandAllowList: ["git"] });
    const result = await handler({ command: "git", args: ["status"] });
    // Will fail with exec error (no git repo) but should NOT be blocked by destructive check
    expect(result.error ?? "").not.toContain("Destructive command");
  });

  it("allows blockDestructive: false to override", async () => {
    const handler = createShellExecHandler({
      commandAllowList: ["rm"],
      blockDestructive: false,
    });
    const result = await handler({
      command: "rm",
      args: ["-rf", "/tmp/__motebit_test_nonexistent__"],
    });
    // Should NOT be blocked by destructive detection (may still fail from rm error)
    expect(result.error ?? "").not.toContain("Destructive command");
  });

  it("normalizes absolute command paths against allowlist", async () => {
    const handler = createShellExecHandler({ commandAllowList: ["echo"] });
    const result = await handler({ command: "/bin/echo", args: ["works"] });
    expect(result.ok).toBe(true);
    expect(result.data as string).toContain("works");
  });

  it("denies cwd outside allowed paths", async () => {
    const handler = createShellExecHandler({
      commandAllowList: ["echo"],
      allowedPaths: ["/tmp"],
    });
    const result = await handler({ command: "echo", args: ["test"], cwd: "/etc" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside allowed paths");
  });

  it("defaults cwd to first allowed path when omitted", async () => {
    const handler = createShellExecHandler({
      commandAllowList: ["pwd"],
      allowedPaths: ["/tmp"],
    });
    const result = await handler({ command: "pwd" });
    expect(result.ok).toBe(true);
    // pwd should output /tmp (or its canonical form)
    expect(result.data as string).toContain("tmp");
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
  it("registers core tools (6 without optional callbacks)", () => {
    const registry = new InMemoryToolRegistry();
    registerBuiltinTools(registry);

    expect(registry.size).toBe(6);
    expect(registry.has("web_search")).toBe(true);
    expect(registry.has("read_url")).toBe(true);
    expect(registry.has("read_file")).toBe(true);
    expect(registry.has("write_file")).toBe(true);
    expect(registry.has("shell_exec")).toBe(true);
    expect(registry.has("undo_write")).toBe(true);
  });

  it("registers memory tool when memorySearchFn provided", () => {
    const registry = new InMemoryToolRegistry();
    registerBuiltinTools(registry, {
      memorySearchFn: async () => [],
    });

    expect(registry.size).toBe(7);
    expect(registry.has("recall_memories")).toBe(true);
  });

  it("registers event tool when eventQueryFn provided", () => {
    const registry = new InMemoryToolRegistry();
    registerBuiltinTools(registry, {
      eventQueryFn: async () => [],
    });

    expect(registry.size).toBe(7);
    expect(registry.has("list_events")).toBe(true);
  });

  it("registers all 8 tools when all options provided", () => {
    const registry = new InMemoryToolRegistry();
    registerBuiltinTools(registry, {
      memorySearchFn: async () => [],
      eventQueryFn: async () => [],
    });

    expect(registry.size).toBe(8);
    const names = registry
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "list_events",
      "read_file",
      "read_url",
      "recall_memories",
      "shell_exec",
      "undo_write",
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
