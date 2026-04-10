import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  ToolDefinition,
  ToolResult,
  ExecutionReceipt,
  KeyringAdapter,
  CredentialRequest,
  CredentialSource,
  VerificationResult,
  ServerVerifier,
} from "@motebit/sdk";
export type {
  CredentialRequest,
  CredentialSource,
  VerifierConfigUpdates,
  VerificationResult,
  ServerVerifier,
} from "@motebit/sdk";
import { secureErase, createSignedToken, verifyKeySuccession } from "@motebit/encryption";
import type { KeySuccessionRecord } from "@motebit/encryption";
import { InMemoryToolRegistry } from "@motebit/tools";

export {
  discoverByDns,
  discoverByWellKnown,
  discoverMotebit,
  discoverViaRelay,
} from "./discovery.js";
export { GitHubOAuthTokenProvider } from "./github-oauth.js";
export type { GitHubOAuthConfig } from "./github-oauth.js";
// TlsCertificateVerifier is Node-only (uses node:tls). Not re-exported from barrel
// to avoid pulling node:tls into browser bundles. Import from subpath instead:
//   import { TlsCertificateVerifier } from "@motebit/mcp-client/tls-verifier";
export type {
  DnsDiscoveryResult,
  ResolveTxtFn,
  RelayDiscoveryResult,
  RelayDiscoveryOptions,
} from "./discovery.js";

/**
 * Wraps a static token string as a CredentialSource.
 * Drop-in replacement for legacy authToken behavior.
 */
export class StaticCredentialSource implements CredentialSource {
  constructor(private readonly token: string) {}

  getCredential(_request: CredentialRequest): Promise<string> {
    return Promise.resolve(this.token);
  }
}

/** Default keyring key: `mcp_credential:{serverName}`. */
function defaultKeyringKey(serverName: string): string {
  return `mcp_credential:${serverName}`;
}

/**
 * Reads credentials from OS keyring at call time.
 * Secret is never held in memory beyond the getCredential call.
 * Requires a KeyringAdapter (Tauri, Expo SecureStore, etc.) injected at construction.
 */
export class KeyringCredentialSource implements CredentialSource {
  private keyring: KeyringAdapter;
  private resolveKey: (serverName: string) => string;

  constructor(
    keyring: KeyringAdapter,
    resolveKey: (serverName: string) => string = defaultKeyringKey,
  ) {
    this.keyring = keyring;
    this.resolveKey = resolveKey;
  }

  async getCredential(request: CredentialRequest): Promise<string | null> {
    // Extract server name from URL for key resolution
    const serverName = extractServerName(request.serverUrl);
    const key = this.resolveKey(serverName);
    return this.keyring.get(key);
  }
}

/**
 * Adapter interface for external secret vaults (HashiCorp Vault, AWS Secrets Manager,
 * 1Password Connect, etc.). The vault is glucose — this is the enzyme boundary.
 */
export interface VaultClient {
  get(key: string): Promise<string | null>;
}

/** Default vault key: `mcp/{serverName}`. */
function defaultVaultKey(serverName: string): string {
  return `mcp/${serverName}`;
}

/**
 * Reads credentials from an external secret vault at call time.
 * Secret is never cached — resolved per-request from the vault.
 * Build the adapter boundary, not the vault.
 */
export class VaultCredentialSource implements CredentialSource {
  private vault: VaultClient;
  private resolveKey: (serverName: string) => string;

  constructor(vault: VaultClient, resolveKey: (serverName: string) => string = defaultVaultKey) {
    this.vault = vault;
    this.resolveKey = resolveKey;
  }

  async getCredential(request: CredentialRequest): Promise<string | null> {
    const serverName = extractServerName(request.serverUrl);
    const key = this.resolveKey(serverName);
    return this.vault.get(key);
  }
}

// ── OAuth 2.0 credential source ─────────────────────────────────────────

/** Token returned by the OAuth provider after initial grant or refresh. */
export interface OAuthToken {
  /** Bearer access token. */
  accessToken: string;
  /** Refresh token for obtaining new access tokens. Absent if grant doesn't support refresh. */
  refreshToken?: string;
  /** Absolute timestamp (ms since epoch) when the access token expires. */
  expiresAt: number;
}

/**
 * Adapter interface for OAuth 2.0 token acquisition and refresh.
 * The provider is glucose — GitHub OAuth, Stripe Connect, generic OIDC.
 * OAuthCredentialSource is the enzyme boundary.
 */
export interface OAuthTokenProvider {
  /** Obtain an initial token (e.g., from stored refresh token or authorization code). */
  getToken(): Promise<OAuthToken>;
  /** Exchange a refresh token for a fresh access token. */
  refresh(token: string): Promise<OAuthToken>;
}

/** Default refresh-ahead buffer: refresh when token expires within 60 seconds. */
const OAUTH_REFRESH_AHEAD_MS = 60_000;

/**
 * OAuth 2.0 credential source with token lifecycle management.
 *
 * First CredentialSource with internal mutable state:
 * - Caches the current access token
 * - Refreshes ahead of expiry (configurable buffer)
 * - Deduplicates concurrent refresh calls (single in-flight refresh)
 * - Fail-closed: refresh errors propagate to callers
 *
 * The OAuthTokenProvider is injected — specific OAuth servers (GitHub, Stripe,
 * generic OIDC) implement it. The source does not know about authorization
 * endpoints, client IDs, or scopes. It manages the token lifecycle only.
 */
export class OAuthCredentialSource implements CredentialSource {
  private provider: OAuthTokenProvider;
  private refreshAheadMs: number;

  private cachedToken: OAuthToken | null = null;
  private inflightRefresh: Promise<OAuthToken> | null = null;

  constructor(provider: OAuthTokenProvider, refreshAheadMs: number = OAUTH_REFRESH_AHEAD_MS) {
    this.provider = provider;
    this.refreshAheadMs = refreshAheadMs;
  }

  async getCredential(_request: CredentialRequest): Promise<string | null> {
    const token = await this.getFreshToken();
    return token.accessToken;
  }

  private async getFreshToken(): Promise<OAuthToken> {
    // Fast path: cached token is still fresh
    if (this.cachedToken && !this.isExpiringSoon(this.cachedToken)) {
      return this.cachedToken;
    }

    // Refresh path: token is expired or expiring soon
    if (this.cachedToken?.refreshToken) {
      return this.refreshWithDedup(this.cachedToken.refreshToken);
    }

    // Initial acquisition: no cached token or no refresh token
    return this.acquireWithDedup();
  }

  private isExpiringSoon(token: OAuthToken): boolean {
    return Date.now() >= token.expiresAt - this.refreshAheadMs;
  }

  /**
   * Deduplicate concurrent refresh calls. If a refresh is already in-flight,
   * subsequent callers await the same promise instead of firing a second refresh.
   */
  private async refreshWithDedup(refreshToken: string): Promise<OAuthToken> {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }

    this.inflightRefresh = this.provider
      .refresh(refreshToken)
      .then((token) => {
        this.cachedToken = token;
        return token;
      })
      .finally(() => {
        this.inflightRefresh = null;
      });

    return this.inflightRefresh;
  }

  private async acquireWithDedup(): Promise<OAuthToken> {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }

    this.inflightRefresh = this.provider
      .getToken()
      .then((token) => {
        this.cachedToken = token;
        return token;
      })
      .finally(() => {
        this.inflightRefresh = null;
      });

    return this.inflightRefresh;
  }
}

/** Extract a stable server identity from a URL for keyring key derivation.
 *  Includes port when non-standard (not 80/443) to avoid collisions. */
function extractServerName(url: string): string {
  try {
    const parsed = new URL(url);
    // parsed.port is "" when using the protocol's default port
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

/** Compute a manifest hash from tool definitions (shared by verifiers). */
async function computeVerifierHash(
  tools: ToolDefinition[],
): Promise<{ hash: string; toolNames: string[] }> {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const data = sorted
    .map((t) => `${t.name}|${t.description}|${JSON.stringify(t.inputSchema)}`)
    .join("\n");
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  const toolNames = tools.map((t) => t.name);
  return { hash, toolNames };
}

/**
 * Verifies server integrity by pinning the tool manifest hash.
 * On first connect (no pinned hash), accepts and pins. On subsequent connects,
 * rejects if the manifest changed. Callers should persist configUpdates.
 */
export class ManifestPinningVerifier implements ServerVerifier {
  async verify(config: McpServerConfig, tools: ToolDefinition[]): Promise<VerificationResult> {
    const { hash, toolNames } = await computeVerifierHash(tools);

    if (!config.toolManifestHash) {
      // First connect — pin the manifest
      return {
        ok: true,
        configUpdates: { toolManifestHash: hash, pinnedToolNames: toolNames },
      };
    }

    if (config.toolManifestHash === hash) {
      return { ok: true };
    }

    // Manifest changed — compute diff for diagnostics
    const prevSet = new Set(config.pinnedToolNames ?? []);
    const currSet = new Set(toolNames);
    const added = toolNames.filter((n) => !prevSet.has(n));
    const removed = (config.pinnedToolNames ?? []).filter((n) => !currSet.has(n));
    const diffParts: string[] = [];
    if (added.length) diffParts.push(`+${String(added.length)} added`);
    if (removed.length) diffParts.push(`-${String(removed.length)} removed`);

    return {
      ok: false,
      error: `Tool manifest changed (${diffParts.join(", ")}). Expected hash ${config.toolManifestHash.slice(0, 16)}..., got ${hash.slice(0, 16)}...`,
    };
  }
}

/**
 * Advisory manifest verifier: always accepts, but revokes trust when the manifest changes.
 * Use in apps that need to show a user prompt or notification on tool changes
 * rather than hard-rejecting the connection.
 *
 * - First connect (no pinned hash): pins hash and tool names.
 * - Hash matches: passes silently.
 * - Hash mismatch: sets `trusted: false` in configUpdates, updates hash/toolNames.
 */
export class AdvisoryManifestVerifier implements ServerVerifier {
  async verify(config: McpServerConfig, tools: ToolDefinition[]): Promise<VerificationResult> {
    const { hash, toolNames } = await computeVerifierHash(tools);

    if (!config.toolManifestHash) {
      // First connect — pin the manifest
      return {
        ok: true,
        configUpdates: { toolManifestHash: hash, pinnedToolNames: toolNames },
      };
    }

    if (config.toolManifestHash === hash) {
      return { ok: true };
    }

    // Manifest changed — accept but revoke trust
    return {
      ok: true,
      configUpdates: { toolManifestHash: hash, pinnedToolNames: toolNames, trusted: false },
    };
  }
}

/**
 * Chains multiple ServerVerifiers. All must pass for the connection to proceed.
 * Config updates from each verifier are merged (later verifiers override earlier on conflict).
 */
export class CompositeServerVerifier implements ServerVerifier {
  private verifiers: ServerVerifier[];

  constructor(...verifiers: ServerVerifier[]) {
    this.verifiers = verifiers;
  }

  async verify(config: McpServerConfig, tools: ToolDefinition[]): Promise<VerificationResult> {
    let mergedUpdates: VerificationResult["configUpdates"];

    for (const verifier of this.verifiers) {
      const result = await verifier.verify(config, tools);
      if (result.configUpdates) {
        mergedUpdates = { ...mergedUpdates, ...result.configUpdates };
        // Apply updates to config for subsequent verifiers
        Object.assign(config, result.configUpdates);
      }
      if (!result.ok) {
        return { ok: false, error: result.error, configUpdates: mergedUpdates };
      }
    }

    return { ok: true, configUpdates: mergedUpdates };
  }
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** When false (default), all tools from this server require user approval. */
  trusted?: boolean;
  /** SHA-256 hash of the tool manifest, set on first connect. */
  toolManifestHash?: string;
  /** Tool names from the last pinned manifest, used for diffing on change. */
  pinnedToolNames?: string[];
  /** This server is a motebit — verify identity on connect. */
  motebit?: boolean;
  /** Type of the remote motebit — determines default trust and policy behavior. */
  motebitType?: "personal" | "service" | "collaborative";
  /** Pinned public key hex (set on first verified connect). */
  motebitPublicKey?: string;
  /** Caller's motebit ID — used to create signed auth tokens for motebit servers. */
  callerMotebitId?: string;
  /** Caller's device ID — used in signed auth tokens. */
  callerDeviceId?: string;
  /** Caller's Ed25519 private key — used to sign auth tokens. NOT persisted. */
  callerPrivateKey?: Uint8Array;
  /**
   * Static Bearer token for non-motebit MCP servers that require auth.
   * @deprecated Use `credentialSource` instead. Kept for backwards compatibility —
   * internally wrapped as StaticCredentialSource.
   */
  authToken?: string;
  /** Dynamic credential source for non-motebit MCP servers. Takes precedence over authToken. */
  credentialSource?: CredentialSource;
  /** Guardian public key (hex) for verifying guardian recovery succession records. */
  guardianPublicKey?: string;
  /** Server verifier run after connect. Fail-closed: verification failure disconnects. */
  serverVerifier?: ServerVerifier;
  /** SHA-256 fingerprint of the server's TLS certificate, pinned on first connect. */
  tlsCertFingerprint?: string;
}

export interface MotebitIdentityResult {
  verified: boolean;
  motebit_id?: string;
  public_key?: string;
  error?: string;
}

// === Inline boundary wrapping for MCP results ===

const EXTERNAL_DATA_START = "[EXTERNAL_DATA source=";
const EXTERNAL_DATA_END = "[/EXTERNAL_DATA]";

function wrapMcpResult(data: string, serverName: string, toolName: string): string {
  const escaped = data
    .replace(/\[EXTERNAL_DATA\b/g, "[ESCAPED_DATA")
    .replace(/\[\/EXTERNAL_DATA\]/g, "[/ESCAPED_DATA]");
  const safeServer = serverName.replace(/[[\]"\\]/g, "_").slice(0, 50);
  const safeTool = toolName.replace(/[[\]"\\]/g, "_").slice(0, 50);
  return `${EXTERNAL_DATA_START}"mcp:${safeServer}:${safeTool}"]\n${escaped}\n${EXTERNAL_DATA_END}`;
}

/** Strip the `[motebit:...]` identity tag line from formatResult() output. */
function stripIdentityTag(text: string): string {
  return text.replace(/\n?\[motebit:[^\]]*\]\s*$/, "");
}

/** Extract tool name from a JSON-RPC request body, if it's a tools/call method. */
function extractToolNameFromBody(body: unknown): string | undefined {
  if (body == null || typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as { method?: string; params?: { name?: string } };
    if (parsed.method === "tools/call" && typeof parsed.params?.name === "string") {
      return parsed.params.name;
    }
  } catch {
    // Not JSON or not parseable — no tool name available
  }
  return undefined;
}

/** 24-hour grace period for accepting the previous key after rotation. */
const KEY_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

export class McpClientAdapter {
  private client: Client;
  private config: McpServerConfig;
  private connected = false;
  private discoveredTools: ToolDefinition[] = [];
  private _delegationReceipts: ExecutionReceipt[] = [];
  private _verifiedIdentity: MotebitIdentityResult | null = null;
  private _previousPublicKey?: string;
  private _previousKeySupersededAt?: number;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.client = new Client(
      { name: `motebit-${config.name}`, version: "0.1.0" },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    if (this.config.transport === "stdio") {
      if (!this.config.command) {
        throw new Error(`MCP server "${this.config.name}" requires a command for stdio transport`);
      }
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const transport = new StdioClientTransport({
        command: this.config.command,
        args: this.config.args ?? [],
        env: this.config.env,
      });
      await this.client.connect(transport);
    } else {
      if (!this.config.url) {
        throw new Error(`MCP server "${this.config.name}" requires a url for http transport`);
      }
      const { StreamableHTTPClientTransport } =
        await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

      // Build transport options with auth
      const transportOpts: Record<string, unknown> = {};
      if (
        (this.config.motebit || this.config.motebitType) &&
        this.config.callerMotebitId &&
        this.config.callerPrivateKey
      ) {
        // Motebit signed token auth — static header (short-lived, already scoped)
        const token = await this.createCallerToken();
        if (token) {
          transportOpts.requestInit = { headers: { Authorization: `Bearer motebit:${token}` } };
        }
      } else {
        // Resolve credential source: explicit credentialSource > legacy authToken wrapper
        const source =
          this.config.credentialSource ??
          (this.config.authToken ? new StaticCredentialSource(this.config.authToken) : undefined);
        if (source) {
          // Per-tool credential resolution: custom fetch injects auth on every request.
          // Parses JSON-RPC body to extract tool name for scoped credentials.
          const serverUrl = this.config.url;
          const agentId = this.config.callerMotebitId;
          transportOpts.fetch = async (url: string | URL, init?: RequestInit) => {
            const toolName = extractToolNameFromBody(init?.body);
            const credential = await source.getCredential({
              serverUrl,
              toolName,
              agentId,
            });
            const headers = new Headers(init?.headers);
            if (credential) {
              headers.set("Authorization", `Bearer ${credential}`);
            }
            return globalThis.fetch(url, { ...init, headers });
          };
        }
      }

      const hasOpts = Object.keys(transportOpts).length > 0;
      const transport = new StreamableHTTPClientTransport(
        new URL(this.config.url),
        hasOpts ? transportOpts : undefined,
      );
      await this.client.connect(transport);
    }

    this.connected = true;
    await this.discoverTools();

    // Run server verifier if configured (fail-closed)
    if (this.config.serverVerifier) {
      await this.runServerVerifier();
    }

    // Verify motebit identity if configured
    if (this.config.motebit || this.config.motebitType) {
      await this.verifyMotebitIdentity();
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
    this.discoveredTools = [];
    // Erase caller private key bytes if present
    if (this.config.callerPrivateKey) {
      secureErase(this.config.callerPrivateKey);
    }
  }

  /** Run the configured server verifier. Fail-closed: disconnect on failure or error. */
  private async runServerVerifier(): Promise<void> {
    const verifier = this.config.serverVerifier!;
    try {
      const result = await verifier.verify(this.config, this.discoveredTools);
      if (result.configUpdates) {
        Object.assign(this.config, result.configUpdates);
      }
      if (!result.ok) {
        await this.disconnect();
        throw new Error(
          `MCP server "${this.config.name}" failed verification: ${result.error ?? "unknown"}`,
        );
      }
    } catch (err: unknown) {
      if (!this.connected) throw err;
      await this.disconnect();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`MCP server "${this.config.name}" verification error: ${message}`);
    }
  }

  private async discoverTools(): Promise<void> {
    const response = await this.client.listTools();
    this.discoveredTools = response.tools.map((mcpTool) => ({
      name: `${this.config.name}__${mcpTool.name}`,
      description: `[${this.config.name}] ${mcpTool.description ?? mcpTool.name}`,
      inputSchema: (mcpTool.inputSchema ?? {
        type: "object",
        properties: {},
      }) as Record<string, unknown>,
      ...(this.config.trusted ? {} : { requiresApproval: true }),
    }));
  }

  /** Verify the remote motebit's identity via motebit_identity tool call. Fail-closed. */
  private async verifyMotebitIdentity(): Promise<void> {
    try {
      const result = await this.client.callTool({
        name: "motebit_identity",
        arguments: {},
      });
      const textContent = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");

      const parsed = this.parseMotebitIdentityResponse(textContent);
      if (!parsed.motebit_id || !parsed.public_key) {
        // Fail-closed: disconnect on unparseable identity
        await this.disconnect();
        throw new Error(
          `MCP server "${this.config.name}": motebit identity response missing motebit_id or public_key`,
        );
      }

      // Key pinning: verify or pin (with grace period for rotated keys)
      if (this.config.motebitPublicKey) {
        if (this.config.motebitPublicKey !== parsed.public_key) {
          // Check if the previous key matches and we're within the grace period
          const withinGrace =
            this._previousPublicKey === parsed.public_key &&
            this._previousKeySupersededAt !== undefined &&
            Date.now() - this._previousKeySupersededAt < KEY_GRACE_PERIOD_MS;

          if (!withinGrace) {
            await this.disconnect();
            throw new Error(
              `MCP server "${this.config.name}": motebit public key mismatch (expected ${this.config.motebitPublicKey.slice(0, 16)}..., got ${parsed.public_key.slice(0, 16)}...)`,
            );
          }
        }
      } else {
        // Pin on first connect
        this.config.motebitPublicKey = parsed.public_key;
      }

      this._verifiedIdentity = {
        verified: true,
        motebit_id: parsed.motebit_id,
        public_key: parsed.public_key,
      };
    } catch (err: unknown) {
      // If already handled (disconnect + rethrow), propagate
      if (!this.connected) throw err;
      // Fail-closed: disconnect on any error
      await this.disconnect();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `MCP server "${this.config.name}": motebit identity verification failed: ${message}`,
      );
    }
  }

  /** Create a signed token identifying this motebit as the caller. */
  private async createCallerToken(): Promise<string | null> {
    if (
      !this.config.callerMotebitId ||
      !this.config.callerDeviceId ||
      !this.config.callerPrivateKey
    ) {
      return null;
    }
    try {
      return await createSignedToken(
        {
          mid: this.config.callerMotebitId,
          did: this.config.callerDeviceId,
          iat: Date.now(),
          exp: Date.now() + 5 * 60 * 1000, // 5 minute expiry
          jti: crypto.randomUUID(),
          aud: "task:submit",
        },
        this.config.callerPrivateKey,
      );
    } catch {
      return null;
    }
  }

  /** Parse motebit_identity response — handles JSON and identity file YAML formats. */
  private parseMotebitIdentityResponse(text: string): { motebit_id?: string; public_key?: string } {
    // Strip identity tag line from formatResult() output
    const cleaned = stripIdentityTag(text);

    // Try JSON first
    try {
      const json = JSON.parse(cleaned) as Record<string, unknown>;
      if (typeof json.motebit_id === "string" && typeof json.public_key === "string") {
        return { motebit_id: json.motebit_id, public_key: json.public_key };
      }
    } catch {
      // Not JSON — try YAML-style identity file
    }

    // Parse identity file format: look for motebit_id and public_key in YAML-like structure
    const idMatch = /motebit_id:\s*"?([^"\n]+)"?/.exec(cleaned);
    const keyMatch = /public_key:\s*"?([0-9a-fA-F]+)"?/.exec(cleaned);
    if (idMatch?.[1] && keyMatch?.[1]) {
      return { motebit_id: idMatch[1], public_key: keyMatch[1] };
    }

    return {};
  }

  getTools(): ToolDefinition[] {
    return [...this.discoveredTools];
  }

  async executeTool(qualifiedName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const prefix = `${this.config.name}__`;
    if (!qualifiedName.startsWith(prefix)) {
      return {
        ok: false,
        error: `Tool "${qualifiedName}" does not belong to server "${this.config.name}"`,
      };
    }
    const mcpToolName = qualifiedName.slice(prefix.length);

    try {
      const result = await this.client.callTool({
        name: mcpToolName,
        arguments: args,
      });
      const textContent = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");

      // Capture delegation receipts from motebit_task calls
      if (mcpToolName === "motebit_task" && this._verifiedIdentity?.verified && textContent) {
        this.tryCaptureDelegationReceipt(textContent);
      }

      const wrapped = textContent
        ? wrapMcpResult(textContent, this.config.name, mcpToolName)
        : undefined;
      return {
        ok: result.isError !== true,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- MCP SDK content type
        data: wrapped != null ? wrapped : result.content,
        error: result.isError === true ? textContent : undefined,
        _sanitized: true,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /** Try to parse an ExecutionReceipt from a motebit_task result and accumulate it. */
  private tryCaptureDelegationReceipt(text: string): void {
    try {
      const cleaned = stripIdentityTag(text);
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;
      // Verify it has the shape of an ExecutionReceipt
      if (
        typeof parsed.task_id === "string" &&
        typeof parsed.signature === "string" &&
        typeof parsed.motebit_id === "string"
      ) {
        this._delegationReceipts.push(parsed as unknown as ExecutionReceipt);
      }
    } catch {
      // Silent on parse failure — not all motebit_task results are JSON receipts
    }
  }

  /** Drain accumulated delegation receipts (same pattern as MemoryGraph.getAndResetRetrievalStats). */
  getAndResetDelegationReceipts(): ExecutionReceipt[] {
    const receipts = this._delegationReceipts;
    this._delegationReceipts = [];
    return receipts;
  }

  /** Register all discovered tools into a ToolRegistry. */
  registerInto(registry: InMemoryToolRegistry): void {
    for (const tool of this.discoveredTools) {
      if (!registry.has(tool.name)) {
        registry.register(tool, (args) => this.executeTool(tool.name, args));
      }
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get serverName(): string {
    return this.config.name;
  }

  /** Identity verification result, if this is a motebit server. */
  get verifiedIdentity(): MotebitIdentityResult | null {
    return this._verifiedIdentity;
  }

  /** Whether this adapter is configured as a motebit server. */
  get isMotebit(): boolean {
    return this.config.motebit === true || this.config.motebitType !== undefined;
  }

  /** Type of the remote motebit. Defaults to "service" when only motebit:true is set (backward compat). */
  get motebitType(): "personal" | "service" | "collaborative" | undefined {
    return this.config.motebitType ?? (this.config.motebit ? "service" : undefined);
  }

  /** Access to the server config (for reading pinned keys after connect). */
  get serverConfig(): McpServerConfig {
    return this.config;
  }

  /** Previous public key (available during the 24-hour grace period after rotation). */
  get previousPublicKey(): string | undefined {
    return this._previousPublicKey;
  }

  /** Timestamp when the previous key was superseded. */
  get previousKeySupersededAt(): number | undefined {
    return this._previousKeySupersededAt;
  }

  /**
   * Accept a key rotation by verifying the succession record and updating the pinned key.
   * The old key is kept as `previousPublicKey` with a 24-hour grace period.
   * Returns true if the rotation was accepted, false if the succession record is invalid.
   */
  async acceptKeyRotation(successionRecord: KeySuccessionRecord): Promise<boolean> {
    const valid = await verifyKeySuccession(successionRecord, this.config.guardianPublicKey);
    if (!valid) return false;

    // Verify the old key in the succession matches our currently pinned key
    if (
      this.config.motebitPublicKey &&
      this.config.motebitPublicKey !== successionRecord.old_public_key
    ) {
      return false;
    }

    // Store the old key for grace period
    this._previousPublicKey = this.config.motebitPublicKey;
    this._previousKeySupersededAt = Date.now();

    // Update to the new key
    this.config.motebitPublicKey = successionRecord.new_public_key;

    return true;
  }
}

/** Connect to multiple MCP servers and merge their tools into a single registry. */
export async function connectMcpServers(
  configs: McpServerConfig[],
  registry: InMemoryToolRegistry,
): Promise<McpClientAdapter[]> {
  const adapters: McpClientAdapter[] = [];

  for (const config of configs) {
    try {
      const adapter = new McpClientAdapter(config);
      await adapter.connect();
      adapter.registerInto(registry);
      adapters.push(adapter);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console -- connection error logged to stderr
      console.warn(`Failed to connect to MCP server "${config.name}": ${message}`);
    }
  }

  return adapters;
}
