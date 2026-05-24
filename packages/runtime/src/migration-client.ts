/**
 * Agent-side migration client — performs a sovereign relay migration
 * end-to-end (spec/migration-v1.md). This is the half of migration that did
 * not exist: the relay could issue tokens, attest history, and accept
 * presentations, but nothing on the agent side orchestrated the move. Without
 * this, "you own your identity, you can leave" was not actually executable.
 *
 * The flow (against the relay as it is today):
 *   1. POST  {source}/api/v1/agents/{id}/migrate            → MigrationToken
 *   2. GET   {source}/api/v1/agents/{id}/migration/attestation → DepartureAttestation
 *   3. GET   {source}/api/v1/agents/{id}/migration/export     → CredentialBundle
 *   4. POST  {dest}/api/v1/agents/accept-migration            → onboarded
 *
 * Pure orchestration: `fetch` and auth are injected, so it is testable
 * in-process and works cross-host in production. Fail-closed and explicit —
 * every step that fails returns a typed reason, never a thrown surprise; a
 * partial run (token obtained, destination down) leaves the agent holding its
 * artifacts, so the move is retryable against another destination.
 *
 * Spec-completeness (agent signs MigrationRequest + CredentialBundle +
 * MigrationPresentation, and the relay verifies them — §4.1, §6, §8) is the
 * deferred follow-on; the producers pair with the verifiers in @motebit/crypto.
 */
import type { MigrationToken, DepartureAttestation, CredentialBundle } from "@motebit/sdk";
import { signCredentialBundle } from "@motebit/crypto";

export interface MigrationClientDeps {
  /** The relay the agent is leaving (its current sync URL). */
  readonly sourceRelayUrl: string;
  /** The relay the agent is moving to. */
  readonly destRelayUrl: string;
  /** The migrating motebit's id. */
  readonly motebitId: string;
  /** The migrating motebit's public key, hex — onboarded at the destination. */
  readonly publicKeyHex: string;
  /** The migrating motebit's identity private key — used to sign the exported
   *  credential bundle (§6: the agent, not the relay, signs what it presents). */
  readonly signingPrivateKey: Uint8Array;
  /** Bearer token authenticating the agent to the SOURCE relay (its sync auth).
   *  A string or a per-call minter (web mints a fresh signed token per request). */
  readonly sourceAuth: string | (() => Promise<string>);
  /** Bearer token for the DESTINATION's accept endpoint, when it requires one. */
  readonly destAuth?: string | (() => Promise<string>);
  /** Optional human-readable migration reason (recorded by the source relay). */
  readonly reason?: string;
  /** Injected fetch — defaults to the global. Tests pass a router into the
   *  in-process relay apps; production uses the real cross-host fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export type MigrationStep = "request" | "attestation" | "export" | "accept";

export type MigrationResult =
  | { readonly ok: true; readonly acceptedMotebitId: string }
  | {
      readonly ok: false;
      readonly step: MigrationStep;
      readonly status?: number;
      readonly reason: string;
    };

async function resolveAuth(
  auth: string | (() => Promise<string>) | undefined,
): Promise<string | null> {
  if (auth === undefined) return null;
  return typeof auth === "function" ? await auth() : auth;
}

/**
 * Perform a full agent-side migration from `sourceRelayUrl` to `destRelayUrl`.
 * Returns `{ ok: true, acceptedMotebitId }` when the destination onboards the
 * agent, else `{ ok: false, step, status?, reason }` identifying where it
 * stopped.
 */
export async function performMigration(deps: MigrationClientDeps): Promise<MigrationResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;

  const authedHeaders = async (
    auth: string | (() => Promise<string>) | undefined,
  ): Promise<Record<string, string>> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = await resolveAuth(auth);
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return headers;
  };

  const fail = (
    step: MigrationStep,
    status: number | undefined,
    reason: string,
  ): MigrationResult => ({
    ok: false,
    step,
    ...(status !== undefined ? { status } : {}),
    reason,
  });

  // ── 1. Initiate migration → MigrationToken (§4) ──────────────────────────
  let token: MigrationToken;
  try {
    const res = await doFetch(`${deps.sourceRelayUrl}/api/v1/agents/${deps.motebitId}/migrate`, {
      method: "POST",
      headers: await authedHeaders(deps.sourceAuth),
      body: JSON.stringify({
        destination_relay: deps.destRelayUrl,
        ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
      }),
    });
    if (!res.ok) return fail("request", res.status, await safeText(res));
    const data = (await res.json()) as { migration_token?: MigrationToken };
    if (!data.migration_token) return fail("request", res.status, "no migration_token in response");
    token = data.migration_token;
  } catch (e) {
    return fail("request", undefined, errMessage(e));
  }

  // ── 2. Departure attestation (§5) ────────────────────────────────────────
  let attestation: DepartureAttestation;
  try {
    const res = await doFetch(
      `${deps.sourceRelayUrl}/api/v1/agents/${deps.motebitId}/migration/attestation`,
      { method: "GET", headers: await authedHeaders(deps.sourceAuth) },
    );
    if (!res.ok) return fail("attestation", res.status, await safeText(res));
    const data = (await res.json()) as { departure_attestation?: DepartureAttestation };
    if (!data.departure_attestation)
      return fail("attestation", res.status, "no departure_attestation in response");
    attestation = data.departure_attestation;
  } catch (e) {
    return fail("attestation", undefined, errMessage(e));
  }

  // ── 3. Credential bundle export → agent signs it (§6) ────────────────────
  // The relay exports the bundle UNSIGNED; the agent signs it so it controls
  // what it presents to the destination.
  let bundle: CredentialBundle;
  try {
    const res = await doFetch(
      `${deps.sourceRelayUrl}/api/v1/agents/${deps.motebitId}/migration/export`,
      { method: "GET", headers: await authedHeaders(deps.sourceAuth) },
    );
    if (!res.ok) return fail("export", res.status, await safeText(res));
    const data = (await res.json()) as {
      credential_bundle?: Omit<CredentialBundle, "bundle_hash" | "signature">;
    };
    if (!data.credential_bundle)
      return fail("export", res.status, "no credential_bundle in response");
    bundle = await signCredentialBundle(data.credential_bundle, deps.signingPrivateKey);
  } catch (e) {
    return fail("export", undefined, errMessage(e));
  }

  // ── 4. Present to the destination → onboard (§8) ─────────────────────────
  try {
    const res = await doFetch(`${deps.destRelayUrl}/api/v1/agents/accept-migration`, {
      method: "POST",
      headers: await authedHeaders(deps.destAuth ?? deps.sourceAuth),
      body: JSON.stringify({
        migration_token: token,
        departure_attestation: attestation,
        credential_bundle: bundle,
        motebit_id: deps.motebitId,
        public_key: deps.publicKeyHex,
      }),
    });
    if (!res.ok) return fail("accept", res.status, await safeText(res));
    const data = (await res.json()) as { motebit_id?: string };
    return { ok: true, acceptedMotebitId: data.motebit_id ?? deps.motebitId };
  } catch (e) {
    return fail("accept", undefined, errMessage(e));
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function safeText(res: Response): Promise<string> {
  try {
    const body = await res.text();
    return body || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
