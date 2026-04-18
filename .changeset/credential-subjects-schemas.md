---
"@motebit/wire-schemas": minor
---

Publish the credential-subject triple — three W3C VC 2.0
`credentialSubject` body types, in one commit:

- `reputation-credential-subject-v1.json` — observable performance
  signals (success rate, latency, task count, trust score, availability,
  sample size). Issued by relays after enough interactions.
- `trust-credential-subject-v1.json` — peer trust assertions (trust
  level, interaction counts, win/loss tasks, first/last seen). Issued
  by federation peers attesting to direct experience.
- `gradient-credential-subject-v1.json` — interior cognitive-state
  self-attestation (gradient, knowledge density/quality, graph
  connectivity, temporal stability, retrieval quality, interaction/tool
  efficiency, curiosity pressure). The "what am I becoming?" measurement,
  signed by the agent.

Why this matters: motebit's trust accumulation is the moat (per
doctrine), but a third party can only audit accumulated reputation if
the credential bodies are machine-readable. With these schemas, a
verifier extending trust based on an issued VC can validate the body
shape against the published JSON Schema before deciding — without
bundling motebit's runtime, without trusting the issuer's word about
what their credential means.

Schema-layer constraints enforced:

- success_rate, availability ∈ [0, 1] (probabilities, not raw counts)
- avg_latency_ms ≥ 0 (latency is non-negative)
- task_count, sample_size, interaction_count, \*\_tasks integer + ≥ 0
- gradient permits negative values (regression / drift case)

Drift defense #23 waiver count: 7 → 4. **20 schemas shipped.**

Remaining 4 waivers: CredentialAnchor pair (Batch + Proof — chain-
anchored credential transparency), BalanceWaiver (settlement-v1
loose end), CapabilityPrice (structurally-covered permanent waiver).
