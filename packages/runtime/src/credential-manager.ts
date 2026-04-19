/**
 * Credential Manager — issuance, persistence, and relay submission of
 * W3C Verifiable Credentials (gradient + trust).
 *
 * Extracted from MotebitRuntime. Owns the in-memory credential cache,
 * persistent credential store writes, and fire-and-forget relay submission.
 */

import type { CredentialStoreAdapter, GradientCredentialSubject } from "@motebit/sdk";
import { issueGradientCredential } from "@motebit/encryption";
import type { GradientStoreAdapter } from "./gradient.js";

/** Union of all credential subject types issued by the runtime. */
export type AnyCredentialSubject =
  | GradientCredentialSubject
  | import("@motebit/sdk").ReputationCredentialSubject
  | import("@motebit/sdk").TrustCredentialSubject;

export interface CredentialManagerDeps {
  motebitId: string;
  credentialStore: CredentialStoreAdapter | null;
  gradientStore: GradientStoreAdapter;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
}

export class CredentialManager {
  private _issuedCredentials: import("@motebit/encryption").VerifiableCredential<AnyCredentialSubject>[] =
    [];
  private changeListeners = new Set<() => void>();
  /** Callback to submit credentials to relay for indexing. Set externally (e.g. by enableInteractiveDelegation). */
  credentialSubmitter:
    | ((
        vc: import("@motebit/encryption").VerifiableCredential<unknown>,
        subjectMotebitId: string,
      ) => Promise<void>)
    | null = null;

  constructor(private readonly deps: CredentialManagerDeps) {}

  /**
   * Subscribe to credential-set changes (fires after each `persistCredential`).
   * Returns an unsubscribe function. Used by surfaces that render credentials
   * as scene objects (satellites) so they don't have to poll.
   */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn);
    return () => {
      this.changeListeners.delete(fn);
    };
  }

  /**
   * Issue a W3C Verifiable Credential containing this agent's current gradient.
   * Returns null if no gradient has been computed or no private key is available.
   */
  async issueGradientCredential(
    privateKey: Uint8Array,
    publicKey: Uint8Array,
  ): Promise<import("@motebit/encryption").VerifiableCredential<GradientCredentialSubject> | null> {
    const snapshot = this.deps.gradientStore.latest(this.deps.motebitId);
    if (!snapshot) return null;
    return issueGradientCredential(snapshot, privateKey, publicKey);
  }

  /**
   * Return all verifiable credentials issued by this runtime (gradient + trust).
   * Credentials accumulate in memory; consumers can read and clear as needed.
   */
  getIssuedCredentials(): import("@motebit/encryption").VerifiableCredential<AnyCredentialSubject>[] {
    return [...this._issuedCredentials];
  }

  /**
   * Clear the in-memory credential cache (e.g. after persisting or presenting them).
   */
  clearIssuedCredentials(): void {
    this._issuedCredentials = [];
  }

  /** Push a credential to both in-memory cache and persistent store. */
  persistCredential(
    vc: import("@motebit/encryption").VerifiableCredential<unknown>,
    subjectMotebitId?: string,
  ): void {
    this._issuedCredentials.push(
      vc as import("@motebit/encryption").VerifiableCredential<AnyCredentialSubject>,
    );
    if (this.deps.credentialStore) {
      try {
        const credType =
          vc.type.find((t) => t !== "VerifiableCredential") ?? "VerifiableCredential";
        this.deps.credentialStore.save({
          credential_id: crypto.randomUUID(),
          subject_motebit_id: vc.credentialSubject?.id ?? "",
          issuer_did: vc.issuer,
          credential_type: credType,
          credential_json: JSON.stringify(vc),
          issued_at: Date.now(),
        });
      } catch (err: unknown) {
        this.deps.logger.warn("credential persistence failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Fire-and-forget: submit to relay for routing indexing
    if (this.credentialSubmitter && subjectMotebitId) {
      this.credentialSubmitter(vc, subjectMotebitId).catch((err: unknown) => {
        this.deps.logger.warn("credential relay submission failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    // Notify subscribers (satellite renderers, panels) that the set changed.
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (err: unknown) {
        this.deps.logger.warn("credential change listener threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
