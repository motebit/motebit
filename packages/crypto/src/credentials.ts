/**
 * Verifiable Credentials (W3C VC Data Model 2.0) with eddsa-jcs-2022 cryptosuite.
 *
 * Signing and verification of W3C Verifiable Credentials and Presentations
 * using the protocol's canonical Ed25519 + JCS pipeline.
 *
 * Moved from BSL @motebit/encryption to the permissive floor in @motebit/crypto (Apache-2.0).
 */

import {
  canonicalJson,
  ed25519Sign,
  ed25519Verify,
  base58btcEncode,
  base58btcDecode,
  publicKeyToDidKey,
  didKeyToPublicKey,
  sha256,
} from "./signing.js";

// === Types ===

export interface DataIntegrityProof {
  type: "DataIntegrityProof";
  cryptosuite: "eddsa-jcs-2022";
  created: string;
  verificationMethod: string;
  proofPurpose: "assertionMethod" | "authentication";
  proofValue: string;
}

export interface VerifiableCredential<T = Record<string, unknown>> {
  "@context": string[];
  type: string[];
  issuer: string;
  credentialSubject: T & { id: string };
  validFrom: string;
  validUntil?: string;
  credentialStatus?: { id: string; type: string };
  proof: DataIntegrityProof;
}

export interface VerifiablePresentation {
  "@context": string[];
  type: string[];
  holder: string;
  verifiableCredential: VerifiableCredential[];
  proof: DataIntegrityProof;
}

// === Credential Subject Types ===
// Inlined here to avoid importing from @motebit/protocol (verify has zero monorepo deps).

export interface GradientCredentialSubject {
  id: string;
  gradient: number;
  knowledge_density: number;
  knowledge_quality: number;
  graph_connectivity: number;
  temporal_stability: number;
  retrieval_quality: number;
  interaction_efficiency: number;
  tool_efficiency: number;
  curiosity_pressure: number;
  measured_at: number;
}

export interface ReputationCredentialSubject {
  id: string;
  success_rate: number;
  avg_latency_ms: number;
  task_count: number;
  trust_score: number;
  availability: number;
  sample_size: number;
  measured_at: number;
}

export interface TrustCredentialSubject {
  id: string;
  trust_level: string;
  interaction_count: number;
  successful_tasks: number;
  failed_tasks: number;
  first_seen_at: number;
  last_seen_at: number;
}

// === Internal helpers ===

function buildVerificationMethod(publicKey: Uint8Array): string {
  const did = publicKeyToDidKey(publicKey);
  const fragment = did.slice("did:key:".length);
  return `${did}#${fragment}`;
}

// === eddsa-jcs-2022 Signing ===

/**
 * Sign a document using eddsa-jcs-2022 (Data Integrity EdDSA Cryptosuites).
 *
 * 1. Separate proof options from document
 * 2. proofHash = SHA-256(canonicalJson(proofOptions))
 * 3. docHash = SHA-256(canonicalJson(documentWithoutProof))
 * 4. signature = Ed25519.sign(proofHash || docHash, privateKey)
 * 5. proofValue = "z" + base58btcEncode(signature)
 */
async function signDataIntegrity(
  document: Record<string, unknown>,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  proofPurpose: "assertionMethod" | "authentication",
): Promise<DataIntegrityProof> {
  const verificationMethod = buildVerificationMethod(publicKey);
  const created = new Date().toISOString();

  const proofOptions = {
    type: "DataIntegrityProof" as const,
    cryptosuite: "eddsa-jcs-2022" as const,
    created,
    verificationMethod,
    proofPurpose,
  };

  const encoder = new TextEncoder();
  const proofHash = await sha256(encoder.encode(canonicalJson(proofOptions)));
  const { proof: _proof, ...docWithoutProof } = document;
  const docHash = await sha256(encoder.encode(canonicalJson(docWithoutProof)));

  const combined = new Uint8Array(proofHash.length + docHash.length);
  combined.set(proofHash);
  combined.set(docHash, proofHash.length);

  const signature = await ed25519Sign(combined, privateKey);
  const proofValue = "z" + base58btcEncode(signature);

  return { ...proofOptions, proofValue };
}

/**
 * Verify a Data Integrity proof using eddsa-jcs-2022.
 */
async function verifyDataIntegritySigning(
  document: Record<string, unknown>,
  proof: DataIntegrityProof,
): Promise<boolean> {
  if (proof.type !== "DataIntegrityProof" || proof.cryptosuite !== "eddsa-jcs-2022") {
    return false;
  }

  const did = proof.verificationMethod.split("#")[0]!;
  let publicKey: Uint8Array;
  try {
    publicKey = didKeyToPublicKey(did);
  } catch {
    return false;
  }

  const { proofValue, ...proofOptions } = proof;

  const encoder = new TextEncoder();
  const proofHash = await sha256(encoder.encode(canonicalJson(proofOptions)));
  const { proof: _proof, ...docWithoutProof } = document;
  const docHash = await sha256(encoder.encode(canonicalJson(docWithoutProof)));

  const combined = new Uint8Array(proofHash.length + docHash.length);
  combined.set(proofHash);
  combined.set(docHash, proofHash.length);

  if (!proofValue.startsWith("z")) return false;
  let signature: Uint8Array;
  try {
    signature = base58btcDecode(proofValue.slice(1));
  } catch {
    return false;
  }

  return ed25519Verify(signature, combined, publicKey);
}

// === Verifiable Credential Sign/Verify ===

export async function signVerifiableCredential<T = Record<string, unknown>>(
  unsignedVC: Omit<VerifiableCredential<T>, "proof">,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<VerifiableCredential<T>> {
  const proof = await signDataIntegrity(
    unsignedVC as unknown as Record<string, unknown>,
    privateKey,
    publicKey,
    "assertionMethod",
  );
  return { ...unsignedVC, proof };
}

export async function verifyVerifiableCredential<T = Record<string, unknown>>(
  vc: VerifiableCredential<T>,
): Promise<boolean> {
  if (vc.validUntil) {
    const expiresAt = new Date(vc.validUntil).getTime();
    if (Date.now() > expiresAt) return false;
  }
  return verifyDataIntegritySigning(vc as unknown as Record<string, unknown>, vc.proof);
}

// === Verifiable Presentation Sign/Verify ===

export async function signVerifiablePresentation(
  unsignedVP: Omit<VerifiablePresentation, "proof">,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<VerifiablePresentation> {
  const proof = await signDataIntegrity(
    unsignedVP as unknown as Record<string, unknown>,
    privateKey,
    publicKey,
    "authentication",
  );
  return { ...unsignedVP, proof } as VerifiablePresentation;
}

export async function verifyVerifiablePresentation(
  vp: VerifiablePresentation,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  const vpValid = await verifyDataIntegritySigning(
    vp as unknown as Record<string, unknown>,
    vp.proof,
  );
  if (!vpValid) {
    errors.push("Presentation proof is invalid");
  }

  for (let i = 0; i < vp.verifiableCredential.length; i++) {
    const vc = vp.verifiableCredential[i]!;
    const vcValid = await verifyVerifiableCredential(vc);
    if (!vcValid) {
      errors.push(`Credential ${i} proof is invalid`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// === Convenience Issuance Functions ===

const VC_TYPE_GRADIENT = "AgentGradientCredential";
const VC_TYPE_REPUTATION = "AgentReputationCredential";
const VC_TYPE_TRUST = "AgentTrustCredential";

const ONE_HOUR_MS = 60 * 60 * 1000;

export async function issueGradientCredential(
  snapshot: {
    gradient: number;
    knowledge_density: number;
    knowledge_quality: number;
    graph_connectivity: number;
    temporal_stability: number;
    retrieval_quality: number;
    interaction_efficiency: number;
    tool_efficiency: number;
    curiosity_pressure: number;
    timestamp: number;
  },
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  subjectDid?: string,
  validForMs = ONE_HOUR_MS,
  statusEndpoint?: string,
): Promise<VerifiableCredential<GradientCredentialSubject>> {
  const issuerDid = publicKeyToDidKey(publicKey);
  const subject: GradientCredentialSubject = {
    id: subjectDid ?? issuerDid,
    gradient: snapshot.gradient,
    knowledge_density: snapshot.knowledge_density,
    knowledge_quality: snapshot.knowledge_quality,
    graph_connectivity: snapshot.graph_connectivity,
    temporal_stability: snapshot.temporal_stability,
    retrieval_quality: snapshot.retrieval_quality,
    interaction_efficiency: snapshot.interaction_efficiency,
    tool_efficiency: snapshot.tool_efficiency,
    curiosity_pressure: snapshot.curiosity_pressure,
    measured_at: snapshot.timestamp,
  };

  const now = new Date();
  const unsignedVC: Omit<VerifiableCredential<GradientCredentialSubject>, "proof"> = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", VC_TYPE_GRADIENT],
    issuer: issuerDid,
    credentialSubject: subject,
    validFrom: now.toISOString(),
    validUntil: new Date(now.getTime() + validForMs).toISOString(),
    ...(statusEndpoint
      ? { credentialStatus: { id: statusEndpoint, type: "RevocationList2024" } }
      : {}),
  };

  return signVerifiableCredential(unsignedVC, privateKey, publicKey);
}

export async function issueReputationCredential(
  snapshot: {
    success_rate: number;
    avg_latency_ms: number;
    task_count: number;
    trust_score: number;
    availability: number;
    measured_at: number;
  },
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  subjectDid: string,
  validForMs = ONE_HOUR_MS,
  statusEndpoint?: string,
): Promise<VerifiableCredential<ReputationCredentialSubject>> {
  const issuerDid = publicKeyToDidKey(publicKey);
  const subject: ReputationCredentialSubject = {
    id: subjectDid,
    success_rate: snapshot.success_rate,
    avg_latency_ms: snapshot.avg_latency_ms,
    task_count: snapshot.task_count,
    trust_score: snapshot.trust_score,
    availability: snapshot.availability,
    sample_size: snapshot.task_count,
    measured_at: snapshot.measured_at,
  };

  const now = new Date();
  const unsignedVC: Omit<VerifiableCredential<ReputationCredentialSubject>, "proof"> = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", VC_TYPE_REPUTATION],
    issuer: issuerDid,
    credentialSubject: subject,
    validFrom: now.toISOString(),
    validUntil: new Date(now.getTime() + validForMs).toISOString(),
    ...(statusEndpoint
      ? { credentialStatus: { id: statusEndpoint, type: "RevocationList2024" } }
      : {}),
  };

  return signVerifiableCredential(unsignedVC, privateKey, publicKey);
}

export async function issueTrustCredential(
  trustRecord: {
    trust_level: string;
    interaction_count: number;
    successful_tasks?: number;
    failed_tasks?: number;
    first_seen_at: number;
    last_seen_at: number;
  },
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  subjectDid: string,
  validForMs = ONE_HOUR_MS,
  statusEndpoint?: string,
): Promise<VerifiableCredential<TrustCredentialSubject>> {
  const issuerDid = publicKeyToDidKey(publicKey);
  const subject: TrustCredentialSubject = {
    id: subjectDid,
    trust_level: trustRecord.trust_level,
    interaction_count: trustRecord.interaction_count,
    successful_tasks: trustRecord.successful_tasks ?? 0,
    failed_tasks: trustRecord.failed_tasks ?? 0,
    first_seen_at: trustRecord.first_seen_at,
    last_seen_at: trustRecord.last_seen_at,
  };

  const now = new Date();
  const unsignedVC: Omit<VerifiableCredential<TrustCredentialSubject>, "proof"> = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", VC_TYPE_TRUST],
    issuer: issuerDid,
    credentialSubject: subject,
    validFrom: now.toISOString(),
    validUntil: new Date(now.getTime() + validForMs).toISOString(),
    ...(statusEndpoint
      ? { credentialStatus: { id: statusEndpoint, type: "RevocationList2024" } }
      : {}),
  };

  return signVerifiableCredential(unsignedVC, privateKey, publicKey);
}

export async function createPresentation(
  credentials: VerifiableCredential[],
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<VerifiablePresentation> {
  const holderDid = publicKeyToDidKey(publicKey);
  const unsignedVP: Omit<VerifiablePresentation, "proof"> = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiablePresentation"],
    holder: holderDid,
    verifiableCredential: credentials,
  };

  return signVerifiablePresentation(unsignedVP, privateKey, publicKey);
}
