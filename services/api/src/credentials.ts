/**
 * Credential issuance, verification, presentation, and revocation endpoints.
 *
 * Extracted from index.ts — pure refactor, zero behavior changes.
 */

import { HTTPException } from "hono/http-exception";
import {
  hexPublicKeyToDidKey,
  publicKeyToDidKey,
  issueReputationCredential,
  verifyVerifiableCredential,
  createPresentation,
} from "@motebit/crypto";
import type { VerifiableCredential } from "@motebit/crypto";
import { asMotebitId } from "@motebit/sdk";
import type { DatabaseDriver } from "@motebit/persistence";
import type { IdentityManager } from "@motebit/core-identity";
import type { Hono } from "hono";
import type { RelayIdentity } from "./federation.js";

export interface CredentialDeps {
  db: DatabaseDriver;
  app: Hono;
  relayIdentity: RelayIdentity;
  identityManager: IdentityManager;
}

/** Returns the relay's persistent keypair for credential signing. */
export function getRelayKeypair(relayIdentity: RelayIdentity): { publicKey: Uint8Array; privateKey: Uint8Array } {
  return {
    publicKey: relayIdentity.publicKey,
    privateKey: relayIdentity.privateKey,
  };
}

/** Register all credential endpoints on the Hono app. */
export function registerCredentialRoutes(deps: CredentialDeps): void {
  const { db, app, relayIdentity, identityManager } = deps;

  // POST /api/v1/credentials/:motebitId/reputation — compute reputation, issue VC
  app.post("/api/v1/credentials/:motebitId/reputation", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));

    // Compute reputation from settlement records and latency stats
    const settlements = db
      .prepare(
        `SELECT status, settled_at FROM relay_settlements
         WHERE motebit_id = ?
         ORDER BY settled_at DESC LIMIT 1000`,
      )
      .all(motebitId) as Array<{
      status: string;
      settled_at: number;
    }>;

    if (settlements.length === 0) {
      return c.json({ error: "No task history for this agent" }, 404);
    }

    const succeeded = settlements.filter((r) => r.status === "completed").length;
    const successRate = succeeded / settlements.length;
    const latencies = db
      .prepare(
        `SELECT latency_ms FROM relay_latency_stats
         WHERE remote_motebit_id = ?
         ORDER BY recorded_at DESC LIMIT 1000`,
      )
      .all(motebitId) as Array<{ latency_ms: number }>;
    const avgLatency =
      latencies.length > 0 ? latencies.reduce((a, b) => a + b.latency_ms, 0) / latencies.length : 0;

    // Look up agent's public key for did:key subject
    const identity = await identityManager.load(motebitId);
    const devices = identity ? await identityManager.listDevices(motebitId) : [];
    const agentPubKeyHex = devices[0]?.public_key;
    const subjectDid = agentPubKeyHex
      ? hexPublicKeyToDidKey(agentPubKeyHex)
      : `did:motebit:${motebitId}`;

    const relayKeys = getRelayKeypair(relayIdentity);
    const vc = await issueReputationCredential(
      {
        success_rate: successRate,
        avg_latency_ms: avgLatency,
        task_count: settlements.length,
        trust_score: successRate, // Simple: trust = success rate for now
        availability: 1.0, // Relay can't measure this yet
        measured_at: Date.now(),
      },
      relayKeys.privateKey,
      relayKeys.publicKey,
      subjectDid,
    );

    return c.json({
      credential: vc,
      relay_did: publicKeyToDidKey(relayKeys.publicKey),
    });
  });

  // POST /api/v1/credentials/verify — verify a VerifiableCredential (public)
  app.post("/api/v1/credentials/verify", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
    const vc = body as VerifiableCredential;
    if (
      !vc ||
      !Array.isArray(vc["@context"]) ||
      !Array.isArray(vc.type) ||
      !vc.issuer ||
      !vc.credentialSubject ||
      !vc.proof
    ) {
      throw new HTTPException(400, {
        message:
          "Invalid credential: missing required fields (@context, type, issuer, credentialSubject, proof)",
      });
    }

    const valid = await verifyVerifiableCredential(vc);
    return c.json({
      valid,
      issuer: vc.issuer,
      subject: vc.credentialSubject.id,
    });
  });

  // POST /api/v1/agents/:motebitId/revoke-credential — revoke a verifiable credential
  app.post("/api/v1/agents/:motebitId/revoke-credential", async (c) => {
    const motebitId = c.req.param("motebitId");
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId && callerMotebitId !== motebitId) {
      throw new HTTPException(403, { message: "Cannot revoke credentials for another agent" });
    }
    const body = await c.req.json<{ credential_id: string; reason?: string }>();
    if (!body.credential_id) {
      throw new HTTPException(400, { message: "credential_id is required" });
    }
    db
      .prepare(
        "INSERT OR REPLACE INTO relay_revoked_credentials (credential_id, motebit_id, reason) VALUES (?, ?, ?)",
      )
      .run(body.credential_id, motebitId, body.reason ?? null);
    return c.json({ ok: true, credential_id: body.credential_id });
  });

  // GET /api/v1/credentials/:credentialId/status — public credential revocation status
  app.get("/api/v1/credentials/:credentialId/status", (c) => {
    const credentialId = c.req.param("credentialId");
    const row = db
      .prepare("SELECT revoked_at, reason FROM relay_revoked_credentials WHERE credential_id = ?")
      .get(credentialId) as { revoked_at: string; reason: string | null } | undefined;
    if (!row) {
      return c.json({ revoked: false });
    }
    return c.json({ revoked: true, revoked_at: row.revoked_at, reason: row.reason ?? "" });
  });

  // GET /api/v1/agents/:motebitId/credentials — list credentials issued to/by agent
  app.get("/api/v1/agents/:motebitId/credentials", (c) => {
    const mid = asMotebitId(c.req.param("motebitId"));
    const typeFilter = c.req.query("type");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);

    let rows: Array<{
      credential_id: string;
      credential_type: string;
      credential_json: string;
      issued_at: number;
    }>;
    if (typeFilter) {
      rows = db
        .prepare(
          "SELECT credential_id, credential_type, credential_json, issued_at FROM relay_credentials WHERE subject_motebit_id = ? AND credential_type = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, typeFilter, limit) as typeof rows;
    } else {
      rows = db
        .prepare(
          "SELECT credential_id, credential_type, credential_json, issued_at FROM relay_credentials WHERE subject_motebit_id = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, limit) as typeof rows;
    }

    const credentials = rows.map((r) => ({
      credential_id: r.credential_id,
      credential_type: r.credential_type,
      credential: JSON.parse(r.credential_json) as VerifiableCredential,
      issued_at: r.issued_at,
    }));

    return c.json({ motebit_id: mid, credentials });
  });

  // POST /api/v1/agents/:motebitId/presentation — bundle credentials into a signed VP
  app.post("/api/v1/agents/:motebitId/presentation", async (c) => {
    const mid = asMotebitId(c.req.param("motebitId"));
    const typeFilter = c.req.query("type");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);

    let rows: Array<{
      credential_json: string;
    }>;
    if (typeFilter) {
      rows = db
        .prepare(
          "SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ? AND credential_type = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, typeFilter, limit) as typeof rows;
    } else {
      rows = db
        .prepare(
          "SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, limit) as typeof rows;
    }

    if (rows.length === 0) {
      throw new HTTPException(404, { message: "No credentials found for this agent" });
    }

    const credentials = rows.map((r) => JSON.parse(r.credential_json) as VerifiableCredential);

    const relayKeys = getRelayKeypair(relayIdentity);
    const vp = await createPresentation(credentials, relayKeys.privateKey, relayKeys.publicKey);

    return c.json({
      presentation: vp,
      credential_count: credentials.length,
      relay_did: publicKeyToDidKey(relayKeys.publicKey),
    });
  });
}
