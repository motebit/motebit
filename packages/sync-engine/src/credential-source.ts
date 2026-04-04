// Re-export canonical types from @motebit/sdk.
// StaticCredentialSource is a sync-engine-local implementation.

import type { CredentialRequest, CredentialSource } from "@motebit/sdk";
export type { CredentialRequest, CredentialSource } from "@motebit/sdk";

/** Static credential source — wraps a fixed token string. */
export class StaticCredentialSource implements CredentialSource {
  constructor(private readonly token: string) {}
  async getCredential(_request: CredentialRequest): Promise<string | null> {
    return this.token;
  }
}
