/**
 * Verifiable Credentials (W3C VC Data Model 2.0) with eddsa-jcs-2022 cryptosuite.
 *
 * Protocol signing primitives now live in @motebit/crypto (Apache-2.0 permissive floor).
 * This file re-exports for backward compatibility.
 */

export {
  signVerifiableCredential,
  verifyVerifiableCredential,
  signVerifiablePresentation,
  verifyVerifiablePresentation,
  issueGradientCredential,
  issueReputationCredential,
  issueTrustCredential,
  createPresentation,
  type DataIntegrityProof,
  type VerifiableCredential,
  type VerifiablePresentation,
} from "@motebit/crypto";
