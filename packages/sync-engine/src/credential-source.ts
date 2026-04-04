// ---------------------------------------------------------------------------
// CredentialSource — inlined from @motebit/mcp-client to avoid cross-layer dep
// ---------------------------------------------------------------------------

/** Request context for credential resolution. */
export interface CredentialRequest {
  serverUrl: string;
  toolName?: string;
  scope?: string;
  agentId?: string;
}

/** Pluggable credential provider — resolve tokens dynamically per-request. */
export interface CredentialSource {
  getCredential(request: CredentialRequest): Promise<string | null>;
}

/** Static credential source — wraps a fixed token string. */
export class StaticCredentialSource implements CredentialSource {
  constructor(private readonly token: string) {}
  async getCredential(_request: CredentialRequest): Promise<string | null> {
    return this.token;
  }
}
