/**
 * Integration test: GitHub remote MCP server via full boundary stack.
 *
 * Exercises:
 * 1. CredentialSource — StaticCredentialSource with GitHub PAT
 * 2. ManifestPinningVerifier — pins GitHub's tool manifest on first connect
 * 3. TlsCertificateVerifier — pins api.githubcopilot.com TLS certificate
 * 4. CompositeServerVerifier — chains both verifiers
 *
 * Requires GITHUB_PAT environment variable. Skipped when not set.
 */
import { describe, it, expect } from "vitest";
import {
  McpClientAdapter,
  StaticCredentialSource,
  ManifestPinningVerifier,
  CompositeServerVerifier,
} from "../index.js";
import { TlsCertificateVerifier } from "../tls-verifier.js";

const GITHUB_PAT = process.env["GITHUB_PAT"];
const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

describe.skipIf(!GITHUB_PAT)("GitHub remote MCP — full boundary stack", () => {
  it("connects, verifies TLS cert, pins manifest, discovers tools", async () => {
    const adapter = new McpClientAdapter({
      name: "github",
      transport: "http",
      url: GITHUB_MCP_URL,
      credentialSource: new StaticCredentialSource(GITHUB_PAT!),
      serverVerifier: new CompositeServerVerifier(
        new TlsCertificateVerifier(),
        new ManifestPinningVerifier(),
      ),
    });

    await adapter.connect();

    // Connection succeeded — all three boundaries passed
    expect(adapter.isConnected).toBe(true);

    // TLS certificate was pinned
    expect(adapter.serverConfig.tlsCertFingerprint).toBeTypeOf("string");
    expect(adapter.serverConfig.tlsCertFingerprint!.length).toBe(64); // SHA-256 hex

    // Tool manifest was pinned
    expect(adapter.serverConfig.toolManifestHash).toBeTypeOf("string");
    expect(adapter.serverConfig.pinnedToolNames).toBeInstanceOf(Array);
    expect(adapter.serverConfig.pinnedToolNames!.length).toBeGreaterThan(0);

    // GitHub tools discovered
    const tools = adapter.getTools();
    expect(tools.length).toBeGreaterThan(0);

    // At least some expected GitHub tool names present
    const toolNames = tools.map((t) => t.name);
    const hasGitHubTool = toolNames.some(
      (n) => n.includes("get_me") || n.includes("get_file_contents") || n.includes("search"),
    );
    expect(hasGitHubTool).toBe(true);

    await adapter.disconnect();
  }, 30_000);

  it("second connect with pinned values succeeds", async () => {
    // First connect — get pinned values
    const firstAdapter = new McpClientAdapter({
      name: "github",
      transport: "http",
      url: GITHUB_MCP_URL,
      credentialSource: new StaticCredentialSource(GITHUB_PAT!),
      serverVerifier: new CompositeServerVerifier(
        new TlsCertificateVerifier(),
        new ManifestPinningVerifier(),
      ),
    });
    await firstAdapter.connect();
    const pinnedCert = firstAdapter.serverConfig.tlsCertFingerprint;
    const pinnedHash = firstAdapter.serverConfig.toolManifestHash;
    const pinnedNames = firstAdapter.serverConfig.pinnedToolNames;
    await firstAdapter.disconnect();

    // Second connect with pinned values — should pass (same cert, same manifest)
    const secondAdapter = new McpClientAdapter({
      name: "github",
      transport: "http",
      url: GITHUB_MCP_URL,
      credentialSource: new StaticCredentialSource(GITHUB_PAT!),
      tlsCertFingerprint: pinnedCert,
      toolManifestHash: pinnedHash,
      pinnedToolNames: pinnedNames,
      serverVerifier: new CompositeServerVerifier(
        new TlsCertificateVerifier(),
        new ManifestPinningVerifier(),
      ),
    });
    await secondAdapter.connect();
    expect(secondAdapter.isConnected).toBe(true);
    await secondAdapter.disconnect();
  }, 30_000);

  it("rejects with wrong TLS fingerprint", async () => {
    const adapter = new McpClientAdapter({
      name: "github",
      transport: "http",
      url: GITHUB_MCP_URL,
      credentialSource: new StaticCredentialSource(GITHUB_PAT!),
      tlsCertFingerprint: "00".repeat(32), // fake fingerprint
      serverVerifier: new TlsCertificateVerifier(),
    });

    await expect(adapter.connect()).rejects.toThrow("TLS certificate changed");
    expect(adapter.isConnected).toBe(false);
  }, 30_000);
});
