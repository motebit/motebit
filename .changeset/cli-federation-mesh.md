---
"motebit": minor
---

`motebit federation mesh <url1> <url2> ...` — pair-wise peer N relays.

Generalizes the K4 staging mesh stopgap (`scripts/staging-federation-mesh.mjs`, deleted) to any N≥2. Each pair uses the same `/peer/propose` self-mode + `/peer/confirm` flow as `motebit federation peer <url>`, refactored into a private `runPeerHandshake` helper consumed by both. Per-pair failure isolation: a single failed handshake is reported in the summary, not a fatal abort — operators bringing up federation meshes need to see the full pair-grid status, not stop at the first transient hiccup.

```text
$ motebit federation mesh https://r1 https://r2 https://r3
Mesh-peering 3 relay(s) — 3 pair handshake(s):

  ✓ r1 ↔ r2
  ✓ r1 ↔ r3
  ✓ r2 ↔ r3

3/3 pair(s) active.
Mesh established. Verify with `motebit federation peers` on each relay.
```

`spec/dispute-v1.md` §6.2 + §6.5 require ≥3-peer quorum for adjudication, so N=4 is the single-operator floor (each leader sees 3 others). N=3 fails the floor — each leader would see only 2 others, and §6.5 forbids self-adjudication when defendant.

`docs/operator/federation-live-test.md` updated to invoke the CLI command instead of the deleted script.
