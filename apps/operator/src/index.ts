/**
 * @motebit/operator — React + Vite relay-operator console
 *
 * Fleet-scoped views for the operator who runs the relay:
 * - Withdrawals queue (master-token gated)
 * - Federation peers (cross-relay state machine)
 * - Transparency posture (declared vs proven)
 * - Disputes (active disputes + resolution audit)
 * - Fees (5% bundle accumulation; relies on /api/v1/admin/fees)
 * - Credential anchoring (relay-wide batch + on-chain anchor)
 *
 * Auth: static master bearer (`VITE_API_TOKEN`). Same model as
 * `apps/inspector`; the relay's `/api/v1/admin/*` routes use
 * `bearerAuth({ token: apiToken })` (no `aud` audience binding).
 *
 * Sibling surface to `apps/inspector` (single-agent introspection).
 * Inspector ↔ operator split mirrors the records-vs-acts doctrine:
 * inspector renders agent records; operator renders fleet records and
 * exposes operator-only acts (complete withdrawal, suspend peer).
 */

export { OperatorApp } from "./OperatorApp";
