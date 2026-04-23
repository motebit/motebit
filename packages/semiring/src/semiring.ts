/**
 * Re-export from @motebit/protocol.
 *
 * The semiring algebra is protocol-level (Apache-2.0 permissive floor).
 * This BSL package re-exports it for internal convenience and adds
 * judgment-layer code (agent network wiring, provenance, trust transitions).
 */
export type { Semiring } from "@motebit/protocol";
export {
  TrustSemiring,
  CostSemiring,
  LatencySemiring,
  BottleneckSemiring,
  ReliabilitySemiring,
  BooleanSemiring,
  RegulatoryRiskSemiring,
  productSemiring,
  recordSemiring,
  mappedSemiring,
} from "@motebit/protocol";
