---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

settlement-invoice@1.0 kernel — the bill that extends the receipt chain to the money.

Adds `CostAttestationV1` + `InvoiceV1` (and their structured verdicts) to `@motebit/protocol`, and `executionReceiptDigest` / `costAttestationDigest` / `signCostAttestation` / `verifyCostAttestation` / `signInvoice` / `verifyInvoice` to `@motebit/crypto`. motebit owns the format; the issuer runs the rails — no charge/balance/ledger primitive. Offline-verifiable, structured per-axis verdicts (including the stale-cost-overstatement customer-protection axis). Spec: `spec/settlement-invoice-v1.md`. Forced by agency.computer stage-2 billing.
