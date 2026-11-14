---
"@motebit/relay": minor
---

`standing-delegation@1.3` relay half (money-authority increment 2). New public route `GET /api/v1/delegations/revocations/head?delegator_motebit_id=&challenge=` serves a `DelegationRevocationSetAttestation` signed with the relay's identity key: every stored revocation for the delegator, strictly ascending by seq (the table's AUTOINCREMENT id), under the relay-wide `seq_high_water`, read in one transaction with the entries. `POST /api/v1/delegations/revocations` now returns `inclusion_receipt` (a signed `DelegationRevocationInclusionReceipt`) for `recorded` and `already_recorded` alike; a repeat names the stored row's original seq and `received_at`. Migration v61 adds an index on `(delegator_id, id)`. The unsigned GET feed is unchanged and stays propagation-only. Additive: older clients ignore the new route and field.
